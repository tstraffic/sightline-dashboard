// Service Package Register (brief §5.2) — each discipline/scope component
// within a project (ST-260041-DEV-01). Status is app-enforced:
// not_started | in_progress | on_hold | completed.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateServicePackageRef } = require('../lib/refNumbers');
const { sydneyToday } = require('../lib/sydney');

const PKG_STATUSES = ['not_started', 'in_progress', 'on_hold', 'completed'];

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { stream, status, owner, job_id, search } = req.query;
    let where = [];
    const params = [];
    if (stream) { where.push('sp.service_stream = ?'); params.push(stream); }
    if (status) { where.push('sp.status = ?'); params.push(status); }
    if (owner) { where.push('sp.owner_id = ?'); params.push(owner); }
    if (job_id) { where.push('sp.job_id = ?'); params.push(job_id); }
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
        COALESCE(SUM(fee_allocation), 0) AS total_fees
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
      filters: { stream, status, owner, job_id, search },
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
