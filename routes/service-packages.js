// Service Package Register (brief §5.2) — each discipline/scope component
// within a project (ST-260041-DEV-01). Status is app-enforced:
// not_started | in_progress | on_hold | completed.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { createNotification } = require('../middleware/create-notification');
const { generateServicePackageRef } = require('../lib/refNumbers');
const { sydneyToday } = require('../lib/sydney');

const PKG_STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed'];

// Marking a package as actually invoiced is a books operation (brief §10.1)
// — mirror the compliance module's gate.
function canMarkInvoiced(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return ['admin', 'finance', 'accounts'].includes(role);
}

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { stream, status, owner, job_id, search, invoice_state } = req.query;
    let where = [];
    const params = [];
    if (stream) { where.push('sp.service_stream = ?'); params.push(stream); }
    if (status) { where.push('sp.status = ?'); params.push(status); }
    if (owner) { where.push('sp.owner_id = ?'); params.push(owner); }
    if (job_id) { where.push('sp.job_id = ?'); params.push(job_id); }
    if (invoice_state === 'pending') { where.push('COALESCE(sp.ready_for_invoice, 0) = 0 AND COALESCE(sp.invoiced, 0) = 0'); }
    if (invoice_state === 'ready') { where.push('COALESCE(sp.ready_for_invoice, 0) = 1 AND COALESCE(sp.invoiced, 0) = 0'); }
    if (invoice_state === 'invoiced') { where.push('COALESCE(sp.invoiced, 0) = 1'); }
    if (search) {
      where.push('(sp.package_ref LIKE ? OR sp.scope LIKE ? OR j.job_number LIKE ? OR j.project_name LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    const packages = db.prepare(`
      SELECT sp.*, j.job_number, j.project_name, j.job_name, j.client AS client_name, j.client_id,
        u.full_name AS owner_name
      FROM service_packages sp
      JOIN jobs j ON sp.job_id = j.id
      LEFT JOIN users u ON sp.owner_id = u.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY sp.internal_due_date IS NULL, sp.internal_due_date, sp.package_ref
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status NOT IN ('completed') AND internal_due_date IS NOT NULL AND internal_due_date < ? THEN 1 ELSE 0 END) AS overdue,
        COALESCE(SUM(fee_allocation), 0) AS total_fees,
        SUM(CASE WHEN COALESCE(ready_for_invoice, 0) = 1 AND COALESCE(invoiced, 0) = 0 THEN 1 ELSE 0 END) AS ready_to_invoice,
        COALESCE(SUM(CASE WHEN COALESCE(ready_for_invoice, 0) = 1 AND COALESCE(invoiced, 0) = 0 THEN fee_allocation ELSE 0 END), 0) AS ready_value
      FROM service_packages
    `).get(sydneyToday());

    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

    res.render('service-packages/index', {
      title: 'Service Packages',
      currentPage: 'service-packages',
      packages,
      stats,
      users,
      statuses: PKG_STATUSES,
      canMarkInvoiced: canMarkInvoiced(req.session.user),
      filters: { stream, status, owner, job_id, search, invoice_state },
    });
  } catch (err) { next(err); }
});

// Add a package to a project (from the job's Packages tab).
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(b.job_id);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/projects'));
    }
    if (!b.service_stream) {
      req.flash('error', 'A service stream is required.');
      return req.session.save(() => res.redirect(b.return_to || '/jobs/' + job.id));
    }
    const ref = generateServicePackageRef(job.job_number, b.service_stream);
    const result = db.prepare(`
      INSERT INTO service_packages (package_ref, job_id, service_stream, scope, owner_id,
        fee_allocation, budget_hours, status, internal_due_date, client_due_date, dependencies)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, job.id, b.service_stream, b.scope || '', b.owner_id || null,
      parseFloat(b.fee_allocation) || 0, parseFloat(b.budget_hours) || 0,
      PKG_STATUSES.includes(b.status) ? b.status : 'not_started',
      b.internal_due_date || null, b.client_due_date || null, b.dependencies || ''
    );
    logActivity({
      user: req.session.user, action: 'create', entityType: 'service_package',
      entityId: result.lastInsertRowid, entityLabel: ref,
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', `Service package ${ref} added.`);
    req.session.save(() => res.redirect(b.return_to || '/jobs/' + job.id));
  } catch (err) {
    req.flash('error', 'Failed to add package: ' + err.message);
    req.session.save(() => res.redirect(b.return_to || '/service-packages'));
  }
});

// Update (inline edit from register or job tab).
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const pkg = db.prepare('SELECT sp.*, j.job_number FROM service_packages sp JOIN jobs j ON sp.job_id = j.id WHERE sp.id = ?').get(req.params.id);
    if (!pkg) {
      req.flash('error', 'Package not found.');
      return req.session.save(() => res.redirect('/service-packages'));
    }
    const newStatus = PKG_STATUSES.includes(b.status) ? b.status : pkg.status;
    db.prepare(`
      UPDATE service_packages SET scope=?, owner_id=?, fee_allocation=?, budget_hours=?,
        status=?, internal_due_date=?, client_due_date=?, dependencies=?,
        completion_date = CASE WHEN ? = 'completed' AND completion_date IS NULL THEN ? WHEN ? != 'completed' THEN NULL ELSE completion_date END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.scope !== undefined ? b.scope : pkg.scope,
      b.owner_id || null,
      b.fee_allocation !== undefined ? (parseFloat(b.fee_allocation) || 0) : pkg.fee_allocation,
      b.budget_hours !== undefined ? (parseFloat(b.budget_hours) || 0) : pkg.budget_hours,
      newStatus,
      b.internal_due_date || null, b.client_due_date || null,
      b.dependencies !== undefined ? b.dependencies : pkg.dependencies,
      newStatus, sydneyToday(), newStatus,
      req.params.id
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'service_package',
      entityId: pkg.id, entityLabel: pkg.package_ref,
      jobId: pkg.job_id, jobNumber: pkg.job_number,
      beforeValue: pkg.status, afterValue: newStatus, ip: req.ip,
    });
    req.flash('success', `${pkg.package_ref} updated.`);
    req.session.save(() => res.redirect(b.return_to || '/service-packages'));
  } catch (err) {
    req.flash('error', 'Failed to update package: ' + err.message);
    req.session.save(() => res.redirect(b.return_to || '/service-packages'));
  }
});

// ---- Invoice readiness (brief §10.1, compliance idiom) ----

// Anyone with project access can queue work for invoicing (un-gated by
// design — the gate is on marking it actually invoiced).
router.post('/:id/ready-for-invoice', (req, res) => {
  const db = getDb();
  const pkg = db.prepare('SELECT sp.*, j.job_number FROM service_packages sp JOIN jobs j ON sp.job_id = j.id WHERE sp.id = ?').get(req.params.id);
  const back = req.body.return_to || '/service-packages';
  if (!pkg) {
    req.flash('error', 'Package not found.');
    return req.session.save(() => res.redirect('/service-packages'));
  }
  if (pkg.invoiced) {
    req.flash('error', `${pkg.package_ref} is already invoiced.`);
    return req.session.save(() => res.redirect(back));
  }
  db.prepare('UPDATE service_packages SET ready_for_invoice = 1, ready_for_invoice_at = CURRENT_TIMESTAMP, ready_for_invoice_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.session.user.id, pkg.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'service_package',
    entityId: pkg.id, entityLabel: pkg.package_ref,
    jobId: pkg.job_id, jobNumber: pkg.job_number, details: 'Marked ready to invoice', ip: req.ip,
  });
  // Surface to the finance queue — never a raw notifications INSERT.
  try {
    const financeUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(role) IN ('admin','finance','accounts')").all();
    financeUsers.forEach(u => {
      if (u.id === req.session.user.id) return;
      createNotification({
        userId: u.id, type: 'invoice_ready',
        title: `Ready to invoice: ${pkg.package_ref}`,
        message: `${req.session.user.full_name || 'Someone'} queued ${pkg.package_ref} ($${(pkg.fee_allocation || 0).toLocaleString('en-AU')}) on ${pkg.job_number} for invoicing.`,
        link: '/budgets', jobId: pkg.job_id, deduplicate: true,
      });
    });
  } catch (e) { console.error('[Packages] invoice_ready notify error:', e.message); }
  req.flash('success', `${pkg.package_ref} queued for invoicing — finance can see it on Budgets & Costs.`);
  req.session.save(() => res.redirect(back));
});

// Take it back out of the queue (not once actually invoiced).
router.post('/:id/unmark-invoice', (req, res) => {
  const db = getDb();
  const pkg = db.prepare('SELECT sp.*, j.job_number FROM service_packages sp JOIN jobs j ON sp.job_id = j.id WHERE sp.id = ?').get(req.params.id);
  const back = req.body.return_to || '/service-packages';
  if (!pkg) {
    req.flash('error', 'Package not found.');
    return req.session.save(() => res.redirect('/service-packages'));
  }
  if (pkg.invoiced) {
    req.flash('error', `${pkg.package_ref} is already invoiced — only admin/finance can change invoiced records.`);
    return req.session.save(() => res.redirect(back));
  }
  db.prepare('UPDATE service_packages SET ready_for_invoice = 0, ready_for_invoice_at = NULL, ready_for_invoice_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(pkg.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'service_package',
    entityId: pkg.id, entityLabel: pkg.package_ref,
    jobId: pkg.job_id, jobNumber: pkg.job_number, details: 'Removed from invoice queue', ip: req.ip,
  });
  req.flash('success', `${pkg.package_ref} removed from the invoice queue.`);
  req.session.save(() => res.redirect(back));
});

// Record that the Xero invoice went out — books operation, role-gated.
router.post('/:id/mark-invoiced', (req, res) => {
  const db = getDb();
  const pkg = db.prepare('SELECT sp.*, j.job_number FROM service_packages sp JOIN jobs j ON sp.job_id = j.id WHERE sp.id = ?').get(req.params.id);
  const back = req.body.return_to || '/service-packages';
  if (!pkg) {
    req.flash('error', 'Package not found.');
    return req.session.save(() => res.redirect('/service-packages'));
  }
  if (!canMarkInvoiced(req.session.user)) {
    req.flash('error', 'Only admin/finance/accounts can mark work invoiced.');
    return req.session.save(() => res.redirect(back));
  }
  const invoiceNumber = (req.body.invoice_number || '').trim();
  if (!invoiceNumber) {
    req.flash('error', 'Record the Xero invoice number when marking invoiced.');
    return req.session.save(() => res.redirect(back));
  }
  db.prepare(`
    UPDATE service_packages SET invoiced = 1, invoiced_at = CURRENT_TIMESTAMP, invoiced_by_id = ?,
      invoice_number = ?, ready_for_invoice = 1,
      ready_for_invoice_at = COALESCE(ready_for_invoice_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.session.user.id, invoiceNumber, pkg.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'service_package',
    entityId: pkg.id, entityLabel: pkg.package_ref,
    jobId: pkg.job_id, jobNumber: pkg.job_number, details: `Invoiced · ${invoiceNumber}`, ip: req.ip,
  });
  req.flash('success', `${pkg.package_ref} marked invoiced (${invoiceNumber}).`);
  req.session.save(() => res.redirect(back));
});

// Delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  try {
    const pkg = db.prepare('SELECT sp.*, j.job_number FROM service_packages sp JOIN jobs j ON sp.job_id = j.id WHERE sp.id = ?').get(req.params.id);
    if (!pkg) {
      req.flash('error', 'Package not found.');
      return req.session.save(() => res.redirect('/service-packages'));
    }
    db.prepare('DELETE FROM service_packages WHERE id = ?').run(pkg.id);
    logActivity({
      user: req.session.user, action: 'delete', entityType: 'service_package',
      entityId: pkg.id, entityLabel: pkg.package_ref,
      jobId: pkg.job_id, jobNumber: pkg.job_number, ip: req.ip,
    });
    req.flash('success', `${pkg.package_ref} deleted.`);
    req.session.save(() => res.redirect(req.body.return_to || '/service-packages'));
  } catch (err) {
    req.flash('error', 'Failed to delete package: ' + err.message);
    req.session.save(() => res.redirect('/service-packages'));
  }
});

module.exports = router;
