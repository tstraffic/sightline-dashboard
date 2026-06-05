// Invoice assembly — turn signed Traffio works dockets into draft invoices.
//
// Groups signed, not-yet-invoiced dockets per Traffio client over a period into
// one draft invoice, with a labour line per person per day/night segment (reusing
// lib/payroll.splitDayNightSegments so billing day/night matches PAY day/night)
// plus a travel line where present. Rates are left flagged for finance to set in
// the review screen until client rate-card pricing is wired in. Marking the
// consumed dockets invoiced happens in the same transaction to prevent
// double-billing. Approval generates the invoice number; the QBO push is Phase 3.

const { getDb } = require('../db/database');
const { splitDayNightSegments, round2 } = require('../lib/payroll');

const GST_RATE = 0.10;

/** Time portion ("HH:mm[:ss]") of a Traffio "YYYY-MM-DD HH:mm:ss" stamp. */
function timeOf(dt) {
  const s = String(dt || '');
  const parts = s.split(/[ T]/);
  return parts.length > 1 ? parts[1] : s;
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

    let sort = 0;
    for (const d of group) {
      const persons = personsFor.all(d.works_docket_id);
      for (const p of persons) {
        const role = p.resource_name || p.item_classification_name || 'Labour';
        const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || 'Crew';
        const segs = splitDayNightSegments(timeOf(p.time_on), p.total_hours);
        // Fallback: if the split yields nothing (no hours), still record a 0h line for visibility
        const segList = segs.length ? segs : [{ hours: round2(p.total_hours || 0), night: false }];
        for (const seg of segList) {
          const desc = `${role} · ${name} · ${seg.night ? 'Night' : 'Day'} ${seg.hours}h · Docket ${d.works_docket_number || d.works_docket_id}`;
          insLine.run(invoiceId, sort++, desc, seg.hours, 'hr', 0, 0,
            'labour', seg.night ? 'night' : 'day', d.works_docket_id, p.person_id, 1);
        }
        const travel = Number(p.travel_time) || 0;
        if (travel > 0) {
          insLine.run(invoiceId, sort++, `Travel · ${name} · ${travel}h · Docket ${d.works_docket_number || d.works_docket_id}`,
            travel, 'hr', 0, 0, 'allowance', '', d.works_docket_id, p.person_id, 1);
        }
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

module.exports = { assembleDraftInvoices, recomputeInvoiceTotals, generateInvoiceNumber };
