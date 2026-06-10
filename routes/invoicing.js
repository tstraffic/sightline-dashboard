// Traffio → QuickBooks invoicing (Phase 2: assemble + review + approve).
// Draft invoices are built from signed works dockets, edited by finance, then
// approved. The QuickBooks push + docket-PDF attach is Phase 3.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { assembleDraftInvoices, recomputeInvoiceTotals, generateInvoiceNumber, applyRateCardToInvoice } = require('../middleware/invoicing');
const { getInternalRef } = require('../middleware/integrations');
const { round2 } = require('../lib/payroll');

const PERM = 'invoicing';
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** Parse CSV text (quoted fields, embedded commas/quotes) into header-keyed objects. */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', inQ = false;
  const pushField = () => { row.push(cur); cur = ''; };
  const pushRow = () => { if (row.length > 1 || (row.length === 1 && row[0] !== '')) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') pushField();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; pushField(); pushRow(); }
    else cur += ch;
  }
  if (cur !== '' || row.length) { pushField(); pushRow(); }
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h).trim());
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] !== undefined ? r[i] : ''])));
}

// GET /finance/invoicing — list
router.get('/', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const status = (req.query.status || 'draft').trim();
  const where = status === 'all' ? '1=1' : 'i.status = ?';
  const params = status === 'all' ? [] : [status];
  const invoices = db.prepare(`
    SELECT i.*, c.company_name AS client_company
    FROM invoices i LEFT JOIN clients c ON c.id = i.client_id
    WHERE ${where}
    ORDER BY CASE i.status WHEN 'draft' THEN 0 WHEN 'approved' THEN 1 WHEN 'pushed' THEN 2 ELSE 3 END, i.created_at DESC
    LIMIT 300
  `).all(...params);
  const counts = {
    draft: db.prepare("SELECT COUNT(*) c FROM invoices WHERE status='draft'").get().c,
    approved: db.prepare("SELECT COUNT(*) c FROM invoices WHERE status='approved'").get().c,
    pushed: db.prepare("SELECT COUNT(*) c FROM invoices WHERE status='pushed'").get().c,
    void: db.prepare("SELECT COUNT(*) c FROM invoices WHERE status='void'").get().c,
  };
  res.render('invoicing/index', { title: 'Invoicing', invoices, counts, status, money });
});

// GET /finance/invoicing/import — the upload form now lives inline on the
// assemble page; keep the URL alive for old links/bookmarks.
router.get('/import', requirePermission(PERM), (req, res) => {
  res.redirect('/finance/invoicing/new');
});

// POST /finance/invoicing/import — parse + upsert into traffio_dockets /
// traffio_docket_persons. Idempotent: re-uploading updates rows in place.
// Dockets already consumed by an invoice are never touched (no re-billing).
router.post('/import', requirePermission(PERM), csvUpload.single('csv_file'), (req, res) => {
  if (!req.file || !req.file.buffer) {
    req.flash('error', 'Choose the CSV file exported from Traffio first.');
    return res.redirect('/finance/invoicing/import');
  }
  const markSigned = req.body.mark_signed === '1';

  let rows;
  try { rows = parseCsv(req.file.buffer.toString('utf8')); }
  catch (e) { req.flash('error', 'Could not parse that file as CSV: ' + e.message); return res.redirect('/finance/invoicing/import'); }

  // Sanity check it's the right report
  if (!rows.length || !('booking_id' in rows[0]) || !('person_id' in rows[0]) || !('hours_worked' in rows[0])) {
    req.flash('error', 'That file doesn\'t look like a Traffio "Person Dockets" export (expected booking_id / person_id / hours_worked columns).');
    return res.redirect('/finance/invoicing/import');
  }

  const db = getDb();
  const stats = { dockets: 0, persons: 0, skippedRows: 0, skippedInvoiced: 0, clients: new Set() };
  let minDate = null, maxDate = null;

  // Group person-rows into shifts (one docket per Traffio booking_id)
  const byBooking = new Map();
  for (const r of rows) {
    if (!r.booking_id || !r.person_id) { stats.skippedRows++; continue; }
    if (r.is_deleted === '1') { stats.skippedRows++; continue; }
    if (!byBooking.has(r.booking_id)) byBooking.set(r.booking_id, []);
    byBooking.get(r.booking_id).push(r);
  }

  const findExistingDocket = db.prepare('SELECT works_docket_id, invoiced FROM traffio_dockets WHERE booking_id = ? OR works_docket_id = ?');
  const upsertDocket = db.prepare(`
    INSERT INTO traffio_dockets (works_docket_id, works_docket_number, booking_id, job_number, project_id,
      traffio_client_id, client_name, local_client_id, address, booking_start_time, approx_booking_end_time,
      signed_off, is_deleted, raw_json, last_modified, synced_at)
    VALUES (@wid,@num,@bid,@job,@proj,@cid,@cname,@lcid,@addr,@start,@end,@signed,0,@raw,@lm,CURRENT_TIMESTAMP)
    ON CONFLICT(works_docket_id) DO UPDATE SET
      works_docket_number=excluded.works_docket_number, job_number=excluded.job_number,
      project_id=excluded.project_id, traffio_client_id=excluded.traffio_client_id,
      client_name=excluded.client_name,
      local_client_id=COALESCE(traffio_dockets.local_client_id, excluded.local_client_id),
      address=excluded.address, booking_start_time=excluded.booking_start_time,
      approx_booking_end_time=excluded.approx_booking_end_time,
      signed_off=MAX(traffio_dockets.signed_off, excluded.signed_off),
      raw_json=excluded.raw_json, last_modified=excluded.last_modified, synced_at=CURRENT_TIMESTAMP
  `);
  const upsertPerson = db.prepare(`
    INSERT INTO traffio_docket_persons (works_docket_id, person_id, first_name, last_name, resource_name,
      time_on, time_off, total_hours, break_time, travel_time, lafha, is_deleted, raw_json)
    VALUES (@wid,@pid,@fn,@ln,@res,@on,@off,@hrs,@brk,@trv,@laf,0,@raw)
    ON CONFLICT(works_docket_id, person_id) DO UPDATE SET
      first_name=excluded.first_name, last_name=excluded.last_name, resource_name=excluded.resource_name,
      time_on=excluded.time_on, time_off=excluded.time_off, total_hours=excluded.total_hours,
      break_time=excluded.break_time, travel_time=excluded.travel_time, lafha=excluded.lafha,
      is_deleted=0, raw_json=excluded.raw_json
  `);
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  const tx = db.transaction(() => {
    for (const [bookingId, persons] of byBooking) {
      const first = persons[0];

      // Resolve the docket row: reuse an existing one for this booking (API
      // sync may have created it under its real works_docket_id) else mint a
      // CSV-scoped key so a later API sync can't collide with it.
      const existing = findExistingDocket.get(String(bookingId), `CSVB-${bookingId}`);
      if (existing && existing.invoiced) { stats.skippedInvoiced++; continue; }
      const wid = existing ? existing.works_docket_id : `CSVB-${bookingId}`;

      // local client: external_ref mapping first, else exact company-name match
      let localClientId = null;
      if (first.client_id) {
        const cr = getInternalRef('traffio', 'client', String(first.client_id));
        if (cr) localClientId = cr.internal_id;
      }
      if (!localClientId && first.client_name) {
        try { const c = db.prepare('SELECT id FROM clients WHERE company_name = ?').get(first.client_name); if (c) localClientId = c.id; } catch (e) {}
      }

      const signedInCsv = persons.some(p => p.signed_off === '1');
      upsertDocket.run({
        wid,
        num: first.docket_numbers || null,
        bid: String(bookingId),
        job: first.job_number || null,
        proj: first.project_id || null,
        cid: first.client_id || null,
        cname: first.client_name || null,
        lcid: localClientId,
        addr: first.booking_address || null,
        start: first.booking_start_time || first.time_on || null,
        end: first.approx_booking_end_time || first.time_off || null,
        signed: (markSigned || signedInCsv) ? 1 : 0,
        raw: JSON.stringify({ source: 'csv_import', booking_id: bookingId, docket_numbers: first.docket_numbers || '' }),
        lm: first.max_last_modified || null,
      });
      stats.dockets++;
      if (first.client_name) stats.clients.add(first.client_name);
      const d = (first.booking_start_time || '').slice(0, 10);
      if (d) { if (!minDate || d < minDate) minDate = d; if (!maxDate || d > maxDate) maxDate = d; }

      for (const p of persons) {
        upsertPerson.run({
          wid,
          pid: String(p.person_id),
          fn: p.first_name || null, ln: p.last_name || null,
          res: p.resource_name || null,
          on: p.time_on || null, off: p.time_off || null,
          hrs: num(p.hours_worked), brk: num(p.break_time), trv: num(p.travel_time),
          laf: p.lafha || null,
          raw: JSON.stringify({ source: 'csv_import' }),
        });
        stats.persons++;
      }
    }
  });
  try { tx(); } catch (e) {
    req.flash('error', 'Import failed: ' + e.message);
    return res.redirect('/finance/invoicing/import');
  }

  logActivity({
    user: req.session.user, action: 'create', entityType: 'invoice', entityId: 0,
    entityLabel: 'traffio-csv-import',
    details: `Imported ${stats.dockets} docket(s) / ${stats.persons} person line(s) across ${stats.clients.size} client(s) from CSV${markSigned ? ' (marked signed)' : ''}`,
    ip: req.ip,
  });
  const skippedNote = (stats.skippedInvoiced ? ` ${stats.skippedInvoiced} already-invoiced docket(s) untouched.` : '')
    + (stats.skippedRows ? ` ${stats.skippedRows} row(s) skipped (deleted/incomplete).` : '');
  req.flash('success', `Imported ${stats.dockets} dockets (${stats.persons} crew lines) across ${stats.clients.size} clients.${skippedNote}${markSigned ? '' : ' Note: only dockets signed off in the CSV are assemble-able.'}`);
  const qs = (minDate && maxDate) ? `?period_start=${minDate}&period_end=${maxDate}` : '';
  res.redirect('/finance/invoicing/new' + qs);
});

// GET /finance/invoicing/new — choose period/client, preview unbilled dockets
router.get('/new', requirePermission(PERM), (req, res) => {
  const db = getDb();
  // Default to the current month
  const now = new Date();
  const periodStart = req.query.period_start || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const periodEnd = req.query.period_end || now.toISOString().slice(0, 10);

  const clients = db.prepare(`
    SELECT traffio_client_id, client_name, COUNT(*) AS docket_count
    FROM traffio_dockets
    WHERE signed_off = 1 AND is_deleted = 0 AND invoiced = 0
      AND date(booking_start_time) BETWEEN ? AND ?
    GROUP BY traffio_client_id, client_name
    ORDER BY client_name
  `).all(periodStart, periodEnd);
  const totalDockets = clients.reduce((s, c) => s + c.docket_count, 0);

  // Every un-invoiced docket in the period — signed AND unsigned — with crew
  // counts and hours, so finance can see exactly what's there before
  // assembling. Unsigned rows render muted (they're not assemble-able yet).
  const dockets = db.prepare(`
    SELECT d.works_docket_id, d.works_docket_number, d.job_number, d.client_name,
      d.address, d.booking_start_time, d.signed_off,
      COUNT(p.id) AS crew_count,
      COALESCE(SUM(p.total_hours), 0) AS total_hours
    FROM traffio_dockets d
    LEFT JOIN traffio_docket_persons p ON p.works_docket_id = d.works_docket_id AND p.is_deleted = 0
    WHERE d.is_deleted = 0 AND d.invoiced = 0
      AND date(d.booking_start_time) BETWEEN ? AND ?
    GROUP BY d.works_docket_id
    ORDER BY d.client_name, d.booking_start_time
    LIMIT 500
  `).all(periodStart, periodEnd);
  const unsignedCount = dockets.filter(d => !d.signed_off).length;

  res.render('invoicing/new', { title: 'New Invoices', clients, totalDockets, periodStart, periodEnd, dockets, unsignedCount });
});

// POST /finance/invoicing/assemble
router.post('/assemble', requirePermission(PERM), (req, res) => {
  const periodStart = (req.body.period_start || '').trim();
  const periodEnd = (req.body.period_end || '').trim();
  const traffioClientId = (req.body.traffio_client_id || '').trim() || null;
  if (!periodStart || !periodEnd) {
    req.flash('error', 'Pick a period.');
    return res.redirect('/finance/invoicing/new');
  }
  try {
    const result = assembleDraftInvoices({ periodStart, periodEnd, traffioClientId }, req.session.user.id);
    logActivity({
      user: req.session.user, action: 'create', entityType: 'invoice',
      details: `Assembled ${result.invoiceIds.length} draft invoice(s) from ${result.dockets} docket(s)`, ip: req.ip,
    });
    if (!result.invoiceIds.length) req.flash('error', 'No signed, un-invoiced dockets found for that period.');
    else req.flash('success', `Created ${result.invoiceIds.length} draft invoice(s) from ${result.dockets} docket(s).`);
  } catch (err) {
    req.flash('error', `Assembly failed: ${err.message}`);
  }
  res.redirect('/finance/invoicing');
});

function loadInvoice(db, id) {
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!invoice) return null;
  invoice.lines = db.prepare('SELECT * FROM invoice_line_items WHERE invoice_id = ? ORDER BY sort_order, id').all(id);
  return invoice;
}

// GET /finance/invoicing/:id — detail + edit
router.get('/:id', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const invoice = loadInvoice(db, req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  res.render('invoicing/show', { title: invoice.invoice_number || 'Draft invoice', invoice, money });
});

// POST /finance/invoicing/:id/lines — save edits (draft only)
router.post('/:id/lines', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  if (invoice.status !== 'draft') { req.flash('error', 'Only draft invoices can be edited.'); return res.redirect('/finance/invoicing/' + invoice.id); }

  const arr = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);
  const ids = arr(req.body.line_id);
  const descs = arr(req.body.description);
  const qtys = arr(req.body.qty);
  const prices = arr(req.body.unit_price);
  const taxes = arr(req.body.tax_code);
  const removes = new Set(arr(req.body.remove).map(String));

  const tx = db.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      const lid = ids[i];
      if (removes.has(String(lid))) { db.prepare('DELETE FROM invoice_line_items WHERE id = ? AND invoice_id = ?').run(lid, invoice.id); continue; }
      const qty = round2(parseFloat(qtys[i]) || 0);
      const price = round2(parseFloat(prices[i]) || 0);
      const tax = taxes[i] === 'FRE' ? 'FRE' : 'GST';
      db.prepare(`UPDATE invoice_line_items SET description=?, qty=?, unit_price=?, line_total=?, tax_code=?, rate_flagged=0 WHERE id=? AND invoice_id=?`)
        .run((descs[i] || '').trim(), qty, price, round2(qty * price), tax, lid, invoice.id);
    }
    // Optional new manual line
    if ((req.body.new_description || '').trim()) {
      const qty = round2(parseFloat(req.body.new_qty) || 0);
      const price = round2(parseFloat(req.body.new_unit_price) || 0);
      const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM invoice_line_items WHERE invoice_id=?').get(invoice.id).m;
      db.prepare(`INSERT INTO invoice_line_items (invoice_id, sort_order, description, qty, unit, unit_price, line_total, tax_code, source_type)
                  VALUES (?, ?, ?, ?, 'ea', ?, ?, 'GST', 'manual')`)
        .run(invoice.id, maxSort + 1, req.body.new_description.trim(), qty, price, round2(qty * price));
    }
    recomputeInvoiceTotals(db, invoice.id);
  });
  tx();
  req.flash('success', 'Invoice updated.');
  res.redirect('/finance/invoicing/' + invoice.id);
});

// POST /finance/invoicing/:id/approve — draft → approved (assigns number)
// GET /finance/invoicing/:id/docket-pdf — view the invoice's docket evidence
// PDF (generated on demand from the staged docket hours; regenerate=1 forces
// a fresh render after docket data changes).
router.get('/:id/docket-pdf', requirePermission(PERM), async (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  try {
    let pdfPath = invoice.docket_pdf_path;
    const fs = require('fs');
    if (!pdfPath || !fs.existsSync(pdfPath) || req.query.regenerate === '1') {
      const gen = await require('../services/docketPdf').generateInvoiceDocketPdf(invoice.id);
      pdfPath = gen.path;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.docket_pdf_name || 'dockets.pdf'}"`);
    fs.createReadStream(pdfPath).pipe(res);
  } catch (err) {
    req.flash('error', 'Could not generate the docket PDF: ' + err.message);
    res.redirect('/finance/invoicing/' + invoice.id);
  }
});

// POST /finance/invoicing/:id/apply-rates — price the draft's flagged lines
// from the client's rate card (for drafts assembled before the card existed).
router.post('/:id/apply-rates', requirePermission(PERM), (req, res) => {
  try {
    const result = applyRateCardToInvoice(Number(req.params.id));
    logActivity({
      user: req.session.user, action: 'update', entityType: 'invoice', entityId: Number(req.params.id),
      details: `Applied rate card "${result.cardName}": ${result.updated} line(s) priced, ${result.remaining} still need a rate`,
      ip: req.ip,
    });
    req.flash(result.remaining ? 'error' : 'success',
      `Priced ${result.updated} line${result.updated === 1 ? '' : 's'} from "${result.cardName}".`
      + (result.remaining ? ` ${result.remaining} line${result.remaining === 1 ? '' : 's'} still need a rate the card doesn't carry — set those on the card or price them manually.` : ''));
  } catch (err) {
    req.flash('error', err.message || 'Could not apply the rate card.');
  }
  res.redirect('/finance/invoicing/' + req.params.id);
});

router.post('/:id/approve', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  if (invoice.status !== 'draft') { req.flash('error', 'Already processed.'); return res.redirect('/finance/invoicing/' + invoice.id); }

  const number = invoice.invoice_number || generateInvoiceNumber(db);
  db.prepare(`UPDATE invoices SET status='approved', invoice_number=?, approved_by_id=?, approved_at=datetime('now'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(number, req.session.user.id, invoice.id);
  logActivity({ user: req.session.user, action: 'approve', entityType: 'invoice', entityId: invoice.id, entityLabel: number, details: `Approved invoice ${number}`, ip: req.ip });
  req.flash('success', `Invoice ${number} approved — ready to push to QuickBooks.`);
  res.redirect('/finance/invoicing/' + invoice.id);
});

// POST /finance/invoicing/:id/push — push an approved invoice into QuickBooks
// Online (idempotent in the middleware), attaching the signed docket PDF when
// one has been stored. On failure the invoice stays approved with the QBO
// fault recorded in error_message for the review screen.
router.post('/:id/push', requirePermission(PERM), async (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  if (invoice.status !== 'approved') {
    req.flash('error', invoice.status === 'pushed' ? 'Already pushed to QuickBooks.' : 'Approve the invoice before pushing.');
    return res.redirect('/finance/invoicing/' + invoice.id);
  }

  try {
    const { pushInvoiceToQbo, attachDocketPdf } = require('../middleware/quickbooks');
    const result = await pushInvoiceToQbo(invoice.id);

    // No docket PDF stored yet → generate one from the staged docket hours so
    // the QBO invoice always carries its evidence. Non-fatal: a render failure
    // must not block the push that already landed.
    let pdfPath = invoice.docket_pdf_path;
    let pdfName = invoice.docket_pdf_name;
    if (!pdfPath) {
      try {
        const gen = await require('../services/docketPdf').generateInvoiceDocketPdf(invoice.id);
        pdfPath = gen.path; pdfName = gen.name;
      } catch (genErr) {
        console.error('[invoicing] docket PDF generation failed:', genErr.message);
      }
    }

    let attachNote = '';
    if (pdfPath) {
      try {
        await attachDocketPdf(result.qboInvoiceId, pdfPath, pdfName || undefined);
        attachNote = ' Docket PDF attached.';
      } catch (attachErr) {
        // The invoice landed; a failed attachment shouldn't roll that back.
        attachNote = ` (Docket PDF attach failed: ${attachErr.message})`;
      }
    }

    db.prepare("UPDATE invoices SET status='pushed', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(invoice.id);
    logActivity({
      user: req.session.user, action: 'create', entityType: 'invoice', entityId: invoice.id,
      entityLabel: invoice.invoice_number || `#${invoice.id}`,
      details: `Pushed to QuickBooks as ${result.docNumber || result.qboInvoiceId}${attachNote}`, ip: req.ip,
    });
    req.flash('success', `Pushed to QuickBooks — QBO invoice ${result.docNumber || result.qboInvoiceId}.${attachNote}`);
  } catch (err) {
    db.prepare('UPDATE invoices SET error_message=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(err.message || err).slice(0, 1000), invoice.id);
    req.flash('error', `QuickBooks push failed: ${err.message}`);
  }
  res.redirect('/finance/invoicing/' + invoice.id);
});

// POST /finance/invoicing/:id/void — release its dockets
router.post('/:id/void', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  db.transaction(() => {
    db.prepare('UPDATE traffio_dockets SET invoiced=0, invoice_id=NULL WHERE invoice_id=?').run(invoice.id);
    db.prepare("UPDATE invoices SET status='void', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(invoice.id);
  })();
  logActivity({ user: req.session.user, action: 'update', entityType: 'invoice', entityId: invoice.id, entityLabel: invoice.invoice_number || `#${invoice.id}`, details: 'Voided invoice; dockets released', ip: req.ip });
  req.flash('success', 'Invoice voided — its dockets are available to invoice again.');
  res.redirect('/finance/invoicing');
});

// POST /finance/invoicing/:id/delete — draft only
router.post('/:id/delete', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(req.params.id);
  if (!invoice) { req.flash('error', 'Invoice not found.'); return res.redirect('/finance/invoicing'); }
  if (invoice.status !== 'draft') { req.flash('error', 'Only draft invoices can be deleted (void instead).'); return res.redirect('/finance/invoicing/' + invoice.id); }
  db.transaction(() => {
    db.prepare('UPDATE traffio_dockets SET invoiced=0, invoice_id=NULL WHERE invoice_id=?').run(invoice.id);
    db.prepare('DELETE FROM invoices WHERE id=?').run(invoice.id); // cascades line items
  })();
  logActivity({ user: req.session.user, action: 'delete', entityType: 'invoice', entityId: invoice.id, details: 'Deleted draft invoice; dockets released', ip: req.ip });
  req.flash('success', 'Draft deleted — its dockets are available again.');
  res.redirect('/finance/invoicing');
});

module.exports = router;
