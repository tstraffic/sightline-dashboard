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

// ---- Engine v2: client billing profiles + banded crew billing -----------------
// Per the invoice-engine build brief: every pricing rule is client-scoped with
// a DEFAULT fallback (client_billing_profile.client_id NULL). billing_mode
// branches the per-docket line builder:
//   tc_hours        — the original per-TC day/night model (DEFAULT; verified
//                     against the hand-built Hill Rd QBO invoice)
//   per_hour_banded — crew-grouped NT/OT/DT banding (ACI006 / Abergeldie)
//   flat_day_rate   — one DAY_RATE line per docket

const LEGACY_PROFILE = {
  billing_mode: 'tc_hours', nt_threshold_hours: 8, ot_threshold_hours: null,
  weekend_mode: 'same_as_weekday', public_holiday_mode: 'same_as_weekday',
  minimum_shift_hours: null, rounding_increment_minutes: null,
  crew_grouping_enabled: 0, bill_vehicles: 1, bill_equipment: 0,
  require_signoff_to_bill: 1, break_billing: 'unpaid',
};

/** The billing profile for a client: client row → DEFAULT row → legacy built-in. */
function getBillingProfile(db, clientId) {
  let row = null;
  try {
    if (clientId) row = db.prepare('SELECT * FROM client_billing_profile WHERE client_id = ?').get(clientId);
    if (!row) row = db.prepare('SELECT * FROM client_billing_profile WHERE client_id IS NULL').get();
  } catch (e) { /* table missing on stale deploy */ }
  return row || LEGACY_PROFILE;
}

const BAND_LABELS = { NT: 'Normal', OT: 'OT', DT: 'DT', WE: 'Weekend', PH: 'Public Holiday', FLAT: 'Flat' };

/**
 * Variant lookup chain for an activity band. Conservative on purpose: an OT/DT
 * bracket never silently falls back to the ordinary rate, and night bands only
 * resolve from weeknight variants.
 */
function bandVariantChain(band, night) {
  if (night) {
    if (band === 'NT') return [['weeknight', '0_to_8'], ['weeknight', 'standard']];
    if (band === 'OT') return [['weeknight', '8_to_10']];
    if (band === 'DT') return [['weeknight', '10_plus']];
  }
  switch (band) {
    case 'NT': return [['weekday', '0_to_8'], ['standard', '0_to_8'], ['weekday', 'standard'], ['standard', 'standard']];
    case 'OT': return [['weekday', '8_to_10'], ['standard', '8_to_10']];
    case 'DT': return [['weekday', '10_plus'], ['standard', '10_plus']];
    case 'WE': return [['weekend', 'standard'], ['weekend', '0_to_8']];
    case 'PH': return [['public_holiday', 'standard'], ['public_holiday', '0_to_8']];
    default: return [['standard', 'standard']];
  }
}

/**
 * Rate resolver for coded activities (CREW_3, TC_SINGLE, TMA_DRIVER, …) on a
 * rate card: rate_card_items.code → variants by band chain. Caches per code.
 */
function makeActivityRateResolver(db, rateCard) {
  const cache = new Map();
  const variantsFor = (code) => {
    if (!rateCard || !code) return null;
    const key = String(code).toUpperCase();
    if (!cache.has(key)) {
      const item = db.prepare(`
        SELECT id FROM rate_card_items
        WHERE rate_card_id = ? AND is_active = 1 AND UPPER(COALESCE(code,'')) = ?
        LIMIT 1
      `).get(rateCard.id, key);
      cache.set(key, item
        ? db.prepare('SELECT shift_type, hour_bracket, rate FROM rate_card_item_variants WHERE rate_card_item_id = ?').all(item.id)
        : null);
    }
    return cache.get(key);
  };
  return {
    hasActivity: (code) => !!variantsFor(code),
    get: (code, band, night) => {
      const vars = variantsFor(code);
      if (!vars) return null;
      for (const [s, b] of bandVariantChain(band, night)) {
        const v = vars.find(x => x.shift_type === s && x.hour_bracket === b);
        if (v && v.rate != null) return Number(v.rate);
      }
      return null;
    },
  };
}

function isWeekendDate(dt) {
  const s = String(dt || '').slice(0, 10);
  if (!s) return false;
  const d = new Date(s + 'T00:00:00');
  return !isNaN(d) && (d.getDay() === 0 || d.getDay() === 6);
}

/** Night shift = starts at/after 18:00 or before 04:00 (matches payroll's full-night rule). */
function isNightStart(dt) {
  const m = String(timeOf(dt)).match(/^(\d{1,2}):/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  return h >= 18 || h < 4;
}

/** Round hours to the nearest billing increment (e.g. 15 min). */
function roundToIncrement(hours, minutes) {
  const inc = Number(minutes) / 60;
  if (!inc || inc <= 0) return hours;
  return Math.round(hours / inc) * inc;
}

/**
 * per_hour_banded — group same-span people into CREW_N blocks (when enabled
 * and the card carries a CREW_N rate), band each block NT→OT→DT by the
 * profile thresholds (weekend flat_rate replaces banding), apply minimum
 * shift hours + rounding, and emit an unpaid-break qty-0 sub-line like the
 * hand-built invoices. TC_SINGLE falls back to the legacy tc_labour rates
 * when the card has no TC_SINGLE coded item (NT→day, OT→day OT; DT flags).
 */
function buildBandedDocketLines(ctx, d, persons) {
  const { addLine, profile, activityRate, labourRates } = ctx;
  const header = docketHeader(d);
  const withHeader = (label, extra) => [label, header, extra].filter(Boolean).join(' · ');
  const ntTh = Number(profile.nt_threshold_hours) || 8;
  const otTh = profile.ot_threshold_hours != null ? Number(profile.ot_threshold_hours) : null;
  const weekend = isWeekendDate(d.booking_start_time);

  // Blocks: same time_on/time_off people group; crew rate must exist to group.
  const bySpan = new Map();
  for (const p of persons) {
    const key = `${timeOf(p.time_on)}|${timeOf(p.time_off)}`;
    if (!bySpan.has(key)) bySpan.set(key, []);
    bySpan.get(key).push(p);
  }
  const blocks = [];
  for (const members of bySpan.values()) {
    const n = members.length;
    const crewCode = `CREW_${n}`;
    if (profile.crew_grouping_enabled && n >= 2 && activityRate.hasActivity(crewCode)) {
      blocks.push({ code: crewCode, label: `${n} Person Crew`, members, hours: Number(members[0].total_hours) || 0 });
    } else {
      for (const p of members) blocks.push({ code: 'TC_SINGLE', label: 'Traffic Controller', members: [p], hours: Number(p.total_hours) || 0 });
    }
  }

  const tcFallback = (band, night) => {
    if (band === 'NT') return night ? labourRates.night : labourRates.day;
    if (band === 'OT') return night ? labourRates.night_ot : labourRates.day_ot;
    return null;
  };

  for (const blk of blocks) {
    const night = isNightStart(blk.members[0].time_on);
    let h = blk.hours;
    if (profile.minimum_shift_hours != null) h = Math.max(h, Number(profile.minimum_shift_hours));
    if (profile.rounding_increment_minutes) h = roundToIncrement(h, profile.rounding_increment_minutes);
    h = round2(h);
    if (h <= 0) continue;
    const breakdown = shiftBreakdown(blk.members);

    let bands;
    if (weekend && profile.weekend_mode === 'flat_rate') {
      bands = [{ band: 'WE', hours: h }];
    } else {
      // multiplier / sat_sun_split weekend modes are not configured for any
      // client yet — weekend dockets band normally and the WE-less card
      // leaves rates resolvable; revisit when a client needs those modes.
      const nt = Math.min(h, ntTh);
      const ot = otTh != null ? Math.min(Math.max(h - ntTh, 0), Math.max(otTh - ntTh, 0)) : Math.max(h - ntTh, 0);
      const dt = otTh != null ? Math.max(h - otTh, 0) : 0;
      bands = [
        { band: 'NT', hours: round2(nt) },
        { band: 'OT', hours: round2(ot) },
        { band: 'DT', hours: round2(dt) },
      ].filter(b => b.hours > 0);
    }

    for (const b of bands) {
      let rate = activityRate.get(blk.code, b.band, night);
      if (rate == null && blk.code === 'TC_SINGLE') rate = tcFallback(b.band, night);
      addLine(
        withHeader(`${blk.label} (${BAND_LABELS[b.band]}${night && b.band !== 'WE' ? ' Night' : ''})`, breakdown),
        b.hours, 'hr', rate, 'labour', `${blk.code}:${b.band}:${night ? 'N' : 'D'}`, d.works_docket_id);
    }

    // Unpaid break as an explicit qty-0 sub-line (mirrors the hand-built
    // invoices, which show the break deduction without billing it).
    const breakMin = Math.round(Math.max(0, ...blk.members.map(p => Number(p.break_time) || 0)) * 60);
    if (profile.break_billing === 'unpaid' && breakMin > 0) {
      addLine(withHeader(`Less unpaid break (${breakMin} mins) — not billed`), 0, 'hr', 0, 'adjustment', '', d.works_docket_id);
    }
  }
}

/** flat_day_rate — one DAY_RATE line per docket regardless of hours. */
function buildFlatDayDocketLines(ctx, d, persons) {
  const { addLine, activityRate } = ctx;
  const header = docketHeader(d);
  const withHeader = (label, extra) => [label, header, extra].filter(Boolean).join(' · ');
  addLine(withHeader('Day Rate', shiftBreakdown(persons)), 1, 'ea',
    activityRate.get('DAY_RATE', 'FLAT', false), 'labour', 'DAY_RATE:FLAT:D', d.works_docket_id);
}

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

    // Rates + rules resolve once per invoice (same client; period start anchors the card).
    const rateCard = findRateCard(db, first.local_client_id, first.booking_start_time || periodStart);
    const labourRates = resolveLabourRates(db, rateCard);
    const uteRate = resolveUteRate(db, rateCard);
    const allowances = loadAllowances(db, rateCard);
    const profile = getBillingProfile(db, first.local_client_id);
    const activityRate = makeActivityRateResolver(db, rateCard);

    let sort = 0;
    const addLine = (desc, qty, unit, rate, sourceType, segment, docketId) => {
      const flagged = rate == null ? 1 : 0;
      const price = rate == null ? 0 : round2(rate);
      insLine.run(invoiceId, sort++, desc, qty, unit, price, round2(qty * price),
        sourceType, segment, docketId, null, flagged);
    };
    const ctx = { addLine, profile, activityRate, labourRates };

    for (const d of group) {
      const persons = personsFor.all(d.works_docket_id);
      const header = docketHeader(d);
      const withHeader = (label, extra) => [label, header, extra].filter(Boolean).join(' · ');

      // Labour — branch on the client's billing mode. tc_hours is the
      // original verified model and stays the DEFAULT.
      if (profile.billing_mode === 'per_hour_banded') {
        buildBandedDocketLines(ctx, d, persons);
      } else if (profile.billing_mode === 'flat_day_rate' || profile.billing_mode === 'per_crew_day') {
        buildFlatDayDocketLines(ctx, d, persons);
      } else {
        // tc_hours: aggregate each person's bucketed hours, remember who
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
      // tc_hours always bills it (original behaviour); the new modes honour
      // the profile's bill_vehicles switch (vehicle-report ingestion will
      // replace this span-derived line per resource_billing_map).
      const billUte = profile.billing_mode === 'tc_hours' || profile.bill_vehicles;
      const spans = persons.map(p => clockSpanHours(p.time_on, p.time_off)).filter(h => h > 0);
      const uteHours = spans.length
        ? round2(Math.max(...spans))
        : clockSpanHours(d.booking_start_time, d.approx_booking_end_time);
      if (billUte && uteHours > 0) {
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
  const activityRate = makeActivityRateResolver(db, rateCard);
  let updated = 0;

  const tx = db.transaction(() => {
    for (const l of lines) {
      let rate = null;
      if (l.source_type === 'labour' && String(l.shift_segment || '').includes(':')) {
        // Banded line — segment is "ACTIVITY:BAND:N|D" (engine v2)
        const [code, band, dn] = String(l.shift_segment).split(':');
        rate = activityRate.get(code, band, dn === 'N');
        if (rate == null && code === 'TC_SINGLE') {
          if (band === 'NT') rate = dn === 'N' ? labourRates.night : labourRates.day;
          else if (band === 'OT') rate = dn === 'N' ? labourRates.night_ot : labourRates.day_ot;
        }
      }
      else if (l.source_type === 'labour' && l.shift_segment) rate = labourRates[l.shift_segment];
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
  getBillingProfile, makeActivityRateResolver,
};
