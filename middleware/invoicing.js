// Invoice assembly — turn signed Traffio works dockets into draft invoices.
//
// Groups signed, not-yet-invoiced dockets per Traffio client over a period into
// one draft invoice, with lines shaped the way T&S actually bills (mirrors the
// hand-built QuickBooks invoices):
//
//   Per docket, aggregated across crew:
//     Traffic Controller (Day)      — day-window hours, first 8h/person
//     Traffic Controller (Day OT)   — day-window hours beyond 8h/person
//     Traffic Controller (Night)    — night-window hours, first 8h/person
//     Traffic Controller (Night OT) — night-window hours beyond 8h/person
//     Travel Allowance              — one per person on the docket
//     Meal Allowance                — one per person working ≥ trigger hours (default 9.5)
//     Additional Ute                — docket clock span (no break deduction)
//
// The 8h overtime clock resets per rate window: a 7h-day + 1.5h-night shift
// bills no OT, while a straight 9h night shift bills 8h night + 1h night OT.
// (Confirmed against real dockets 4467 / 4482 / 4486 / 4488.)
//
// Day/night windows come from lib/payroll.splitDayNightSegments so billing
// day/night matches PAY day/night. Rates resolve from the client's rate card
// (rate_cards → rate_card_items → rate_card_item_variants, allowances from
// rate_card_allowances); lines with no resolvable rate stay $0 + rate_flagged
// for finance to set in the review screen. Marking the consumed dockets
// invoiced happens in the same transaction to prevent double-billing.
// Approval generates the invoice number; the QBO push is Phase 3.

const { getDb } = require('../db/database');
const { splitDayNightSegments, round2 } = require('../lib/payroll');

const GST_RATE = 0.10;
const OT_THRESHOLD_HOURS = 8;      // per person, per day/night window
const MEAL_TRIGGER_HOURS = 9.5;    // fallback when no rate-card allowance defines one

/** Time portion ("HH:mm[:ss]") of a Traffio "YYYY-MM-DD HH:mm:ss" stamp. */
function timeOf(dt) {
  const s = String(dt || '');
  const parts = s.split(/[ T]/);
  return parts.length > 1 ? parts[1] : s;
}

/** "HH:mm" → "HHmm" display form (e.g. "06:45:00" → "0645"). */
function hhmm(dt) {
  const t = timeOf(dt);
  const m = String(t).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  return m[1].padStart(2, '0') + m[2];
}

/** Clock-span hours between two Traffio stamps (overnight-safe, no break deduction). */
function clockSpanHours(on, off) {
  const parse = (s) => {
    const m = String(s || '').match(/(\d{1,2}):(\d{2})/);
    return m ? parseInt(m[1], 10) + parseInt(m[2], 10) / 60 : null;
  };
  const a = parse(timeOf(on));
  const b = parse(timeOf(off));
  if (a == null || b == null) return 0;
  let span = b - a;
  if (span < 0) span += 24;
  return round2(span);
}

/** Recompute and persist a draft invoice's subtotal / GST / total from its lines. */
function recomputeInvoiceTotals(db, invoiceId) {
  const lines = db.prepare('SELECT line_total, tax_code FROM invoice_line_items WHERE invoice_id = ?').all(invoiceId);
  let subtotal = 0, gstable = 0;
  for (const l of lines) {
    const amt = round2(l.line_total || 0);
    subtotal = round2(subtotal + amt);
    if (l.tax_code !== 'FRE') gstable = round2(gstable + amt);
  }
  const gst = round2(gstable * GST_RATE);
  const total = round2(subtotal + gst);
  db.prepare(`UPDATE invoices SET subtotal_ex_gst=?, gst=?, total_inc_gst=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(subtotal, gst, total, invoiceId);
  return { subtotal, gst, total };
}

/** Generate the next INV-YYYY-NNNN number (called at approval). */
function generateInvoiceNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `INV-${year}-`;
  const last = db.prepare(
    `SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1`
  ).get(prefix + '%');
  let next = 1;
  if (last && last.invoice_number) {
    const n = parseInt(last.invoice_number.slice(prefix.length), 10);
    if (isFinite(n)) next = n + 1;
  }
  return prefix + String(next).padStart(4, '0');
}

// ---- Rate resolution -------------------------------------------------------

/**
 * Pick the rate card that applies to this client on this date: an active
 * client-specific card whose effective window covers the date, else the
 * active default card. Returns null when neither exists.
 */
function findRateCard(db, localClientId, onDate) {
  const date = String(onDate || '').slice(0, 10) || null;
  if (localClientId) {
    const card = db.prepare(`
      SELECT * FROM rate_cards
      WHERE is_active = 1 AND client_id = ?
        AND (effective_from IS NULL OR effective_from <= COALESCE(?, date('now')))
        AND (effective_to IS NULL OR effective_to >= COALESCE(?, date('now')))
      ORDER BY effective_from DESC LIMIT 1
    `).get(localClientId, date, date);
    if (card) return card;
  }
  return db.prepare(`
    SELECT * FROM rate_cards WHERE is_active = 1 AND is_default = 1
    ORDER BY effective_from DESC LIMIT 1
  `).get() || null;
}

/**
 * Resolve the four labour rates (day / day OT / night / night OT) from a rate
 * card's TC-labour item variants. Any rate that can't be resolved is null →
 * that line goes out flagged at $0. Variant fallback chains are conservative:
 * an OT bracket never silently falls back to the ordinary rate.
 */
function resolveLabourRates(db, rateCard) {
  const empty = { day: null, day_ot: null, night: null, night_ot: null };
  if (!rateCard) return empty;
  const item = db.prepare(`
    SELECT * FROM rate_card_items
    WHERE rate_card_id = ? AND category = 'tc_labour' AND is_active = 1
    ORDER BY CASE WHEN name LIKE '%traffic controller%' COLLATE NOCASE THEN 0 ELSE 1 END, sort_order
    LIMIT 1
  `).get(rateCard.id);
  if (!item) return empty;

  const variants = db.prepare('SELECT shift_type, hour_bracket, rate FROM rate_card_item_variants WHERE rate_card_item_id = ?')
    .all(item.id);
  const get = (shift, bracket) => {
    const v = variants.find(x => x.shift_type === shift && x.hour_bracket === bracket);
    return v && v.rate != null ? Number(v.rate) : null;
  };
  const first = (...pairs) => {
    for (const [s, b] of pairs) { const r = get(s, b); if (r != null) return r; }
    return null;
  };
  return {
    day: first(['weekday', '0_to_8'], ['standard', '0_to_8'], ['weekday', 'standard'], ['standard', 'standard']),
    day_ot: first(['weekday', '8_to_10'], ['standard', '8_to_10'], ['weekday', '10_plus'], ['standard', '10_plus']),
    night: first(['weeknight', '0_to_8'], ['weeknight', 'standard']),
    night_ot: first(['weeknight', '8_to_10'], ['weeknight', '10_plus']),
  };
}

/** Resolve the per-hour ute rate from the rate card's equipment items (null if absent). */
function resolveUteRate(db, rateCard) {
  if (!rateCard) return null;
  const item = db.prepare(`
    SELECT rcv.rate FROM rate_card_items rci
    JOIN rate_card_item_variants rcv ON rcv.rate_card_item_id = rci.id
    WHERE rci.rate_card_id = ? AND rci.category = 'equipment_vehicles' AND rci.is_active = 1
      AND rci.unit = 'per_hour' AND rci.name LIKE '%ute%' COLLATE NOCASE
    ORDER BY CASE WHEN rcv.shift_type = 'standard' THEN 0 ELSE 1 END
    LIMIT 1
  `).get(rateCard.id);
  return item && item.rate != null ? Number(item.rate) : null;
}

/** Auto-apply allowances on the rate card (travel / meal / etc.). */
function loadAllowances(db, rateCard) {
  if (!rateCard) return [];
  return db.prepare(`
    SELECT * FROM rate_card_allowances
    WHERE rate_card_id = ? AND is_active = 1 AND auto_apply = 1
    ORDER BY sort_order
  `).all(rateCard.id);
}

// ---- Per-docket line building ----------------------------------------------

/**
 * Split one person's worked hours into the four billing buckets. The OT clock
 * runs per window: first 8h of day-window time at day rate (rest day OT), and
 * independently first 8h of night-window time at night rate (rest night OT).
 */
function bucketPersonHours(person) {
  const worked = Number(person.total_hours) || 0;
  const segs = splitDayNightSegments(timeOf(person.time_on), worked);
  let day = 0, night = 0;
  for (const s of segs) { if (s.night) night = round2(night + s.hours); else day = round2(day + s.hours); }
  return {
    day: round2(Math.min(day, OT_THRESHOLD_HOURS)),
    day_ot: round2(Math.max(0, day - OT_THRESHOLD_HOURS)),
    night: round2(Math.min(night, OT_THRESHOLD_HOURS)),
    night_ot: round2(Math.max(0, night - OT_THRESHOLD_HOURS)),
  };
}

/**
 * "2TC: 0645-1445, 1TC: 0645-1430 (30 mins break)" — group identical
 * (on, off, break) spans so the line description reads like the docket.
 */
function shiftBreakdown(persons) {
  const groups = new Map();
  for (const p of persons) {
    const brk = Number(p.break_time) || 0;
    const key = `${hhmm(p.time_on)}-${hhmm(p.time_off)}|${brk}`;
    groups.set(key, (groups.get(key) || 0) + 1);
  }
  return [...groups.entries()].map(([key, n]) => {
    const [span, brk] = key.split('|');
    const brkNote = Number(brk) > 0 ? ` (${Math.round(Number(brk) * 60)} mins break)` : '';
    return `${n}TC: ${span}${brkNote}`;
  }).join(', ');
}

/** "PO 79389 · Hill Rd, Olympic Park · Ticket #4467" header for line descriptions. */
function docketHeader(d) {
  let raw = {};
  try { raw = JSON.parse(d.raw_json || '{}'); } catch (e) { raw = {}; }
  const po = raw.contract_code || raw.po_number || raw.purchase_order || '';
  const parts = [];
  if (po) parts.push(`PO ${po}`);
  else if (d.billing_reference) parts.push(`Ref ${d.billing_reference}`);
  if (d.address) parts.push(String(d.address).split(',')[0]);
  if (d.job_number) parts.push(`Ticket #${d.job_number}`);
  return parts.join(' · ');
}

const LABOUR_LINES = [
  { key: 'day', label: 'Traffic Controller (Day)', segment: 'day' },
  { key: 'day_ot', label: 'Traffic Controller (Day OT)', segment: 'day_ot' },
  { key: 'night', label: 'Traffic Controller (Night)', segment: 'night' },
  { key: 'night_ot', label: 'Traffic Controller (Night OT)', segment: 'night_ot' },
];

// ---- Assembly ---------------------------------------------------------------

/**
 * Assemble draft invoices from signed, un-invoiced dockets in [periodStart, periodEnd].
 * One invoice per Traffio client (optionally restricted to one client). Returns
 * { invoiceIds, clients, dockets } counts.
 */
function assembleDraftInvoices({ periodStart, periodEnd, traffioClientId }, userId) {
  const db = getDb();

  const where = [
    "signed_off = 1", "is_deleted = 0", "invoiced = 0",
    "date(booking_start_time) BETWEEN ? AND ?",
  ];
  const params = [periodStart, periodEnd];
  if (traffioClientId) { where.push('traffio_client_id = ?'); params.push(String(traffioClientId)); }

  const dockets = db.prepare(
    `SELECT * FROM traffio_dockets WHERE ${where.join(' AND ')} ORDER BY traffio_client_id, booking_start_time`
  ).all(...params);

  // Group by Traffio client
  const groups = new Map();
  for (const d of dockets) {
    const key = d.traffio_client_id || `noclient`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }

  const personsFor = db.prepare('SELECT * FROM traffio_docket_persons WHERE works_docket_id = ? AND is_deleted = 0');
  const insLine = db.prepare(`
    INSERT INTO invoice_line_items (invoice_id, sort_order, description, qty, unit, unit_price, line_total,
      tax_code, source_type, shift_segment, source_works_docket_id, source_person_id, rate_flagged)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'GST', ?, ?, ?, ?, ?)
  `);

  const invoiceIds = [];

  const buildOne = db.transaction((group) => {
    const first = group[0];
    const inv = db.prepare(`
      INSERT INTO invoices (client_id, traffio_client_id, client_name_snapshot, status, source,
        period_start, period_end, docket_ref, created_by_id)
      VALUES (?, ?, ?, 'draft', 'traffio', ?, ?, ?, ?)
    `).run(
      first.local_client_id || null,
      first.traffio_client_id || null,
      first.client_name || null,
      periodStart, periodEnd,
      group.map(d => d.works_docket_number).filter(Boolean).join(', ').slice(0, 500),
      userId || null
    );
    const invoiceId = inv.lastInsertRowid;

    // Rates resolve once per invoice (same client; period start anchors the card).
    const rateCard = findRateCard(db, first.local_client_id, first.booking_start_time || periodStart);
    const labourRates = resolveLabourRates(db, rateCard);
    const uteRate = resolveUteRate(db, rateCard);
    const allowances = loadAllowances(db, rateCard);

    let sort = 0;
    const addLine = (desc, qty, unit, rate, sourceType, segment, docketId) => {
      const flagged = rate == null ? 1 : 0;
      const price = rate == null ? 0 : round2(rate);
      insLine.run(invoiceId, sort++, desc, qty, unit, price, round2(qty * price),
        sourceType, segment, docketId, null, flagged);
    };

    for (const d of group) {
      const persons = personsFor.all(d.works_docket_id);
      const header = docketHeader(d);
      const withHeader = (label, extra) => [label, header, extra].filter(Boolean).join(' · ');

      // Labour: aggregate each person's bucketed hours, remember who
      // contributed to each bucket for the span breakdown.
      const totals = { day: 0, day_ot: 0, night: 0, night_ot: 0 };
      const contributors = { day: [], day_ot: [], night: [], night_ot: [] };
      for (const p of persons) {
        const b = bucketPersonHours(p);
        for (const k of Object.keys(totals)) {
          if (b[k] > 0) { totals[k] = round2(totals[k] + b[k]); contributors[k].push(p); }
        }
      }
      for (const line of LABOUR_LINES) {
        const qty = totals[line.key];
        if (qty <= 0) continue;
        addLine(withHeader(line.label, shiftBreakdown(contributors[line.key])),
          qty, 'hr', labourRates[line.key], 'labour', line.segment, d.works_docket_id);
      }

      // Allowances. Rate-card-driven when defined; otherwise the two standard
      // ones (travel per person, meal past the long-shift trigger) go out
      // flagged at $0 so finance prices them rather than forgetting them.
      if (persons.length) {
        const emitted = { travel: false, meal: false };
        for (const a of allowances) {
          const trigger = a.min_hours_trigger != null ? Number(a.min_hours_trigger) : null;
          const eligible = trigger == null ? persons : persons.filter(p => (Number(p.total_hours) || 0) >= trigger);
          let qty = 0;
          if (a.scope === 'per_person_per_shift' || a.scope === 'per_person_per_day') qty = eligible.length;
          else if (a.scope === 'per_shift' || a.scope === 'per_day') qty = eligible.length ? 1 : 0;
          else continue; // 'flat' scope is quote-level, not per-docket
          if (qty <= 0) continue;
          addLine(withHeader(a.name), qty, 'ea', a.amount != null ? Number(a.amount) : null,
            'allowance', '', d.works_docket_id);
          if (/travel/i.test(a.name)) emitted.travel = true;
          if (/meal/i.test(a.name)) emitted.meal = true;
        }
        if (!emitted.travel) {
          addLine(withHeader('Travel Allowance'), persons.length, 'ea', null, 'allowance', '', d.works_docket_id);
        }
        if (!emitted.meal) {
          const mealQty = persons.filter(p => (Number(p.total_hours) || 0) >= MEAL_TRIGGER_HOURS).length;
          if (mealQty > 0) addLine(withHeader('Meal Allowance'), mealQty, 'ea', null, 'allowance', '', d.works_docket_id);
        }
      }

      // Additional Ute — billed for the docket's clock span (no break
      // deduction): the longest person span, else the booking window. One
      // ute by default; finance adjusts the qty when a docket ran more.
      const spans = persons.map(p => clockSpanHours(p.time_on, p.time_off)).filter(h => h > 0);
      const uteHours = spans.length
        ? round2(Math.max(...spans))
        : clockSpanHours(d.booking_start_time, d.approx_booking_end_time);
      if (uteHours > 0) {
        addLine(withHeader('Additional Ute'), uteHours, 'hr', uteRate, 'charge', '', d.works_docket_id);
      }

      // Consume the docket in the same transaction (prevents double-billing)
      db.prepare('UPDATE traffio_dockets SET invoiced = 1, invoice_id = ? WHERE id = ?').run(invoiceId, d.id);
    }

    recomputeInvoiceTotals(db, invoiceId);
    return invoiceId;
  });

  for (const group of groups.values()) {
    invoiceIds.push(buildOne(group));
  }

  return { invoiceIds, clients: groups.size, dockets: dockets.length };
}

// ---- Rate-card application to existing drafts --------------------------------

/**
 * Re-price a draft invoice's rate_flagged lines from the client's rate card
 * (drafts assembled before the card existed stay $0-flagged — this fixes them
 * without re-assembling). Manually priced lines are never touched. Returns
 * { updated, remaining, cardName } — remaining = lines still flagged because
 * the card doesn't carry that rate.
 */
function applyRateCardToInvoice(invoiceId) {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw new Error('Invoice not found.');
  if (invoice.status !== 'draft') throw new Error('Only draft invoices can be re-priced.');

  const rateCard = findRateCard(db, invoice.client_id, invoice.period_start);
  if (!rateCard) {
    throw new Error(invoice.client_id
      ? 'No active rate card found for this client (and no default card). Create one under Rate Cards first.'
      : 'Invoice has no linked client and there is no default rate card.');
  }
  const labourRates = resolveLabourRates(db, rateCard);
  const uteRate = resolveUteRate(db, rateCard);
  const allowances = loadAllowances(db, rateCard);
  const allowanceByName = (desc) => {
    const name = String(desc || '').split(' · ')[0].trim().toLowerCase();
    const a = allowances.find(x => String(x.name).trim().toLowerCase() === name);
    return a && a.amount != null ? Number(a.amount) : null;
  };

  const lines = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? AND rate_flagged = 1').all(invoiceId);
  const upd = db.prepare('UPDATE invoice_line_items SET unit_price = ?, line_total = ?, rate_flagged = 0 WHERE id = ?');
  let updated = 0;

  const tx = db.transaction(() => {
    for (const l of lines) {
      let rate = null;
      if (l.source_type === 'labour' && l.shift_segment) rate = labourRates[l.shift_segment];
      else if (l.source_type === 'allowance') rate = allowanceByName(l.description);
      else if (l.source_type === 'charge' && /^additional ute/i.test(String(l.description))) rate = uteRate;
      if (rate == null) continue;
      const price = round2(rate);
      upd.run(price, round2((Number(l.qty) || 0) * price), l.id);
      updated++;
    }
    recomputeInvoiceTotals(db, invoiceId);
  });
  tx();

  return { updated, remaining: lines.length - updated, cardName: rateCard.name };
}

// ---- Billing-rates panel (rate-card editor) -----------------------------------
// The rate-card editor only manages standard/standard pricing; invoicing needs
// the day/night × ordinary/OT variant matrix plus travel/meal allowances and a
// per-hour ute. These two helpers give the editor a single compact form that
// reads and writes exactly the rows the resolvers above consume.

/** Current billing rates for the editor panel (nulls where not set). */
function getBillingRates(db, rateCardId) {
  const card = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(rateCardId);
  if (!card) return null;
  const labour = resolveLabourRates(db, card);
  const meal = db.prepare(`
    SELECT amount, min_hours_trigger FROM rate_card_allowances
    WHERE rate_card_id = ? AND is_active = 1 AND name LIKE '%meal%' COLLATE NOCASE LIMIT 1
  `).get(rateCardId);
  const travel = db.prepare(`
    SELECT amount FROM rate_card_allowances
    WHERE rate_card_id = ? AND is_active = 1 AND name LIKE '%travel%' COLLATE NOCASE LIMIT 1
  `).get(rateCardId);
  return {
    day: labour.day, day_ot: labour.day_ot, night: labour.night, night_ot: labour.night_ot,
    ute: resolveUteRate(db, card),
    travel: travel ? travel.amount : null,
    meal: meal ? meal.amount : null,
    meal_trigger: meal && meal.min_hours_trigger != null ? meal.min_hours_trigger : MEAL_TRIGGER_HOURS,
  };
}

/**
 * Upsert the billing rows from the editor panel: a "Traffic Controller"
 * tc_labour item with the 4 shift×bracket variants, an "Additional Ute"
 * per-hour equipment item, and Travel/Meal per-person allowances. Blank
 * inputs leave that rate unset (lines stay flagged for manual pricing).
 */
function saveBillingRates(db, rateCardId, v) {
  const num = (x) => { const n = parseFloat(x); return isFinite(n) ? n : null; };
  const rates = {
    day: num(v.day), day_ot: num(v.day_ot), night: num(v.night), night_ot: num(v.night_ot),
    ute: num(v.ute), travel: num(v.travel), meal: num(v.meal),
    meal_trigger: num(v.meal_trigger) != null ? num(v.meal_trigger) : MEAL_TRIGGER_HOURS,
  };

  const tx = db.transaction(() => {
    // TC labour item + variant matrix
    let item = db.prepare(`
      SELECT id FROM rate_card_items WHERE rate_card_id = ? AND category = 'tc_labour' AND is_active = 1
      ORDER BY CASE WHEN name LIKE '%traffic controller%' COLLATE NOCASE THEN 0 ELSE 1 END, sort_order LIMIT 1
    `).get(rateCardId);
    if (!item) {
      const r = db.prepare(`
        INSERT INTO rate_card_items (rate_card_id, category, name, unit, has_hours_input, cost_method)
        VALUES (?, 'tc_labour', 'Traffic Controller', 'per_hour', 1, 'fixed')
      `).run(rateCardId);
      item = { id: r.lastInsertRowid };
    }
    const upVar = db.prepare(`
      INSERT INTO rate_card_item_variants (rate_card_item_id, shift_type, hour_bracket, rate)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(rate_card_item_id, shift_type, hour_bracket) DO UPDATE SET rate = excluded.rate
    `);
    if (rates.day != null) upVar.run(item.id, 'weekday', '0_to_8', rates.day);
    if (rates.day_ot != null) upVar.run(item.id, 'weekday', '8_to_10', rates.day_ot);
    if (rates.night != null) upVar.run(item.id, 'weeknight', '0_to_8', rates.night);
    if (rates.night_ot != null) upVar.run(item.id, 'weeknight', '8_to_10', rates.night_ot);

    // Additional Ute (per hour)
    if (rates.ute != null) {
      let ute = db.prepare(`
        SELECT id FROM rate_card_items WHERE rate_card_id = ? AND category = 'equipment_vehicles'
          AND unit = 'per_hour' AND name LIKE '%ute%' COLLATE NOCASE AND is_active = 1 LIMIT 1
      `).get(rateCardId);
      if (!ute) {
        const r = db.prepare(`
          INSERT INTO rate_card_items (rate_card_id, category, name, unit, cost_method)
          VALUES (?, 'equipment_vehicles', 'Additional Ute', 'per_hour', 'fixed')
        `).run(rateCardId);
        ute = { id: r.lastInsertRowid };
      }
      upVar.run(ute.id, 'standard', 'standard', rates.ute);
    }

    // Travel / Meal allowances (per person per shift; meal gated on trigger hours)
    const upAllowance = (likePattern, name, amount, trigger) => {
      const existing = db.prepare(`
        SELECT id FROM rate_card_allowances WHERE rate_card_id = ? AND name LIKE ? COLLATE NOCASE LIMIT 1
      `).get(rateCardId, likePattern);
      if (existing) {
        db.prepare('UPDATE rate_card_allowances SET amount = ?, min_hours_trigger = ?, is_active = 1, auto_apply = 1 WHERE id = ?')
          .run(amount, trigger, existing.id);
      } else {
        db.prepare(`
          INSERT INTO rate_card_allowances (rate_card_id, name, scope, amount, min_hours_trigger, auto_apply)
          VALUES (?, ?, 'per_person_per_shift', ?, ?, 1)
        `).run(rateCardId, name, amount, trigger);
      }
    };
    if (rates.travel != null) upAllowance('%travel%', 'Travel Allowance', rates.travel, null);
    if (rates.meal != null) upAllowance('%meal%', 'Meal Allowance', rates.meal, rates.meal_trigger);
  });
  tx();
  return rates;
}

module.exports = {
  assembleDraftInvoices, recomputeInvoiceTotals, generateInvoiceNumber,
  applyRateCardToInvoice, getBillingRates, saveBillingRates,
};
