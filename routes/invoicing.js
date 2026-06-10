// Traffio → QuickBooks invoicing (Phase 2: assemble + review + approve).
// Draft invoices are built from signed works dockets, edited by finance, then
// approved. The QuickBooks push + docket-PDF attach is Phase 3.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { assembleDraftInvoices, recomputeInvoiceTotals, generateInvoiceNumber } = require('../middleware/invoicing');
const { round2 } = require('../lib/payroll');

const PERM = 'invoicing';
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

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

  res.render('invoicing/new', { title: 'New Invoices', clients, totalDockets, periodStart, periodEnd });
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

    let attachNote = '';
    if (invoice.docket_pdf_path) {
      try {
        await attachDocketPdf(result.qboInvoiceId, invoice.docket_pdf_path, invoice.docket_pdf_name || undefined);
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
