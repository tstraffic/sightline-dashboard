// Variation register (brief §5.8) — scope change captured before the work
// is absorbed. Approve/reject is gated to admin/management/finance;
// every status change re-syncs job_budgets.variations_approved so the
// project's contract total tracks approved variations exactly.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateVariationRef } = require('../lib/refNumbers');
const { syncVariationTotals } = require('../lib/wip');
const { sydneyToday } = require('../lib/sydney');

const STATUSES = ['draft', 'submitted', 'approved', 'rejected'];

function canDecide(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return ['admin', 'management', 'finance', 'accounts'].includes(role);
}

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { job_id, status, search } = req.query;
    let where = [];
    const params = [];
    if (job_id) { where.push('v.job_id = ?'); params.push(job_id); }
    if (status && STATUSES.includes(status)) { where.push('v.approval_status = ?'); params.push(status); }
    if (search) {
      where.push('(v.variation_ref LIKE ? OR v.description LIKE ? OR j.job_number LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    const variations = db.prepare(`
      SELECT v.*, j.job_number, j.project_name, j.job_name, j.client AS client_name
      FROM variations v JOIN jobs j ON v.job_id = j.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE v.approval_status WHEN 'submitted' THEN 0 WHEN 'draft' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, v.variation_ref
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN approval_status = 'submitted' THEN 1 ELSE 0 END) AS awaiting,
        COALESCE(SUM(CASE WHEN approval_status = 'submitted' THEN additional_fee ELSE 0 END), 0) AS awaiting_value,
        SUM(CASE WHEN approval_status = 'approved' THEN 1 ELSE 0 END) AS approved,
        COALESCE(SUM(CASE WHEN approval_status = 'approved' THEN additional_fee ELSE 0 END), 0) AS approved_value
      FROM variations
    `).get();

    res.render('variations/index', {
      title: 'Variations',
      currentPage: 'variations',
      variations,
      stats,
      statuses: STATUSES,
      canDecide: canDecide(req.session.user),
      filters: { job_id, status, search },
    });
  } catch (err) { next(err); }
});

// New (from a project)
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    const jobId = req.query.job_id;
    if (!jobId) {
      req.flash('error', 'Variations are raised against a project — open the project (or pick one on its Budget tab) first.');
      return req.session.save(() => res.redirect('/variations'));
    }
    const job = db.prepare('SELECT id, job_number, project_name, job_name FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/variations'));
    }
    res.render('variations/form', {
      title: 'New Variation — ' + job.job_number,
      currentPage: 'variations',
      variation: null,
      job,
      canDecide: canDecide(req.session.user),
    });
  } catch (err) { next(err); }
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(b.job_id);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/variations'));
    }
    if (!(b.description || '').trim()) {
      req.flash('error', 'Describe the scope change.');
      return req.session.save(() => res.redirect('/variations/new?job_id=' + job.id));
    }
    const ref = generateVariationRef(job.job_number);
    const result = db.prepare(`
      INSERT INTO variations (variation_ref, job_id, description, reason, requested_by, date_identified,
        additional_fee, additional_hours, delivery_impact, sharepoint_acceptance_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, job.id, b.description.trim(), b.reason || '', b.requested_by || '',
      b.date_identified || sydneyToday(), parseFloat(b.additional_fee) || 0,
      parseFloat(b.additional_hours) || 0, b.delivery_impact || '',
      b.sharepoint_acceptance_url || '', req.session.user ? req.session.user.id : null
    );
    logActivity({
      user: req.session.user, action: 'create', entityType: 'variation',
      entityId: result.lastInsertRowid, entityLabel: ref,
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', `Variation ${ref} raised — submit it for a decision before absorbing the work.`);
    req.session.save(() => res.redirect(b.return_to || '/variations?job_id=' + job.id));
  } catch (err) {
    req.flash('error', 'Failed to raise variation: ' + err.message);
    req.session.save(() => res.redirect(b.job_id ? '/variations/new?job_id=' + b.job_id : '/variations'));
  }
});

// Edit form (fee locked once approved)
router.get('/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const variation = db.prepare('SELECT v.*, j.job_number, j.project_name, j.job_name FROM variations v JOIN jobs j ON v.job_id = j.id WHERE v.id = ?').get(req.params.id);
    if (!variation) {
      req.flash('error', 'Variation not found.');
      return req.session.save(() => res.redirect('/variations'));
    }
    res.render('variations/form', {
      title: 'Edit ' + variation.variation_ref,
      currentPage: 'variations',
      variation,
      job: { id: variation.job_id, job_number: variation.job_number, project_name: variation.project_name, job_name: variation.job_name },
      canDecide: canDecide(req.session.user),
    });
  } catch (err) { next(err); }
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const variation = db.prepare('SELECT v.*, j.job_number FROM variations v JOIN jobs j ON v.job_id = j.id WHERE v.id = ?').get(req.params.id);
    if (!variation) {
      req.flash('error', 'Variation not found.');
      return req.session.save(() => res.redirect('/variations'));
    }
    // An approved variation's fee is part of the contract total — editing it
    // requires a decider (and re-syncs the projection).
    const feeChanged = b.additional_fee !== undefined && parseFloat(b.additional_fee) !== variation.additional_fee;
    if (variation.approval_status === 'approved' && feeChanged && !canDecide(req.session.user)) {
      req.flash('error', 'This variation is approved — only admin/management/finance can change its fee.');
      return req.session.save(() => res.redirect('/variations/' + variation.id + '/edit'));
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE variations SET description=?, reason=?, requested_by=?, date_identified=?,
          additional_fee=?, additional_hours=?, delivery_impact=?, invoice_status=?,
          sharepoint_acceptance_url=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        b.description || variation.description, b.reason || '', b.requested_by || '',
        b.date_identified || variation.date_identified,
        b.additional_fee !== undefined ? (parseFloat(b.additional_fee) || 0) : variation.additional_fee,
        b.additional_hours !== undefined ? (parseFloat(b.additional_hours) || 0) : variation.additional_hours,
        b.delivery_impact || '', b.invoice_status || variation.invoice_status || '',
        b.sharepoint_acceptance_url || '', variation.id
      );
      syncVariationTotals(db, variation.job_id);
    })();
    logActivity({
      user: req.session.user, action: 'update', entityType: 'variation',
      entityId: variation.id, entityLabel: variation.variation_ref,
      jobId: variation.job_id, jobNumber: variation.job_number, ip: req.ip,
    });
    req.flash('success', `${variation.variation_ref} updated.`);
    req.session.save(() => res.redirect(b.return_to || '/variations?job_id=' + variation.job_id));
  } catch (err) {
    req.flash('error', 'Failed to update variation: ' + err.message);
    req.session.save(() => res.redirect('/variations/' + req.params.id + '/edit'));
  }
});

// Submit for decision
router.post('/:id/submit', (req, res) => {
  const db = getDb();
  const variation = db.prepare('SELECT v.*, j.job_number FROM variations v JOIN jobs j ON v.job_id = j.id WHERE v.id = ?').get(req.params.id);
  if (!variation) {
    req.flash('error', 'Variation not found.');
    return req.session.save(() => res.redirect('/variations'));
  }
  const back = req.body.return_to || '/variations?job_id=' + variation.job_id;
  if (variation.approval_status !== 'draft') {
    req.flash('error', `${variation.variation_ref} is already ${variation.approval_status}.`);
    return req.session.save(() => res.redirect(back));
  }
  if (!(variation.additional_fee > 0) && !(variation.additional_hours > 0)) {
    req.flash('error', 'Record the additional fee or hours before submitting.');
    return req.session.save(() => res.redirect(back));
  }
  db.prepare("UPDATE variations SET approval_status='submitted', submitted_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(sydneyToday(), variation.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'variation',
    entityId: variation.id, entityLabel: variation.variation_ref,
    jobId: variation.job_id, jobNumber: variation.job_number, details: 'Submitted for decision', ip: req.ip,
  });
  req.flash('success', `${variation.variation_ref} submitted for a decision.`);
  req.session.save(() => res.redirect(back));
});

// Approve / reject — gated deciders; approval demands a reference or acceptance link.
router.post('/:id/approve', (req, res) => decide(req, res, 'approved'));
router.post('/:id/reject', (req, res) => decide(req, res, 'rejected'));

function decide(req, res, outcome) {
  const db = getDb();
  const variation = db.prepare('SELECT v.*, j.job_number FROM variations v JOIN jobs j ON v.job_id = j.id WHERE v.id = ?').get(req.params.id);
  if (!variation) {
    req.flash('error', 'Variation not found.');
    return req.session.save(() => res.redirect('/variations'));
  }
  const back = req.body.return_to || '/variations?job_id=' + variation.job_id;
  if (!canDecide(req.session.user)) {
    req.flash('error', 'Only admin/management/finance can decide variations.');
    return req.session.save(() => res.redirect(back));
  }
  if (!['submitted', 'approved', 'rejected'].includes(variation.approval_status)) {
    req.flash('error', `${variation.variation_ref} must be submitted before a decision (currently ${variation.approval_status}).`);
    return req.session.save(() => res.redirect(back));
  }
  if (outcome === 'approved' && !(req.body.approval_reference || '').trim() && !(variation.sharepoint_acceptance_url || '').trim()) {
    req.flash('error', 'Record the client\'s approval reference (or attach the acceptance link) before approving.');
    return req.session.save(() => res.redirect(back));
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE variations SET approval_status=?,
        approval_reference = CASE WHEN ? != '' THEN ? ELSE approval_reference END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(outcome, req.body.approval_reference || '', req.body.approval_reference || '', variation.id);
    syncVariationTotals(db, variation.job_id);
  })();
  logActivity({
    user: req.session.user, action: outcome === 'approved' ? 'approve' : 'reject',
    entityType: 'variation', entityId: variation.id, entityLabel: variation.variation_ref,
    jobId: variation.job_id, jobNumber: variation.job_number,
    details: `$${(variation.additional_fee || 0).toLocaleString('en-AU')}${req.body.approval_reference ? ' · ref ' + req.body.approval_reference : ''}`, ip: req.ip,
  });
  req.flash('success', `${variation.variation_ref} ${outcome} — project contract total updated.`);
  req.session.save(() => res.redirect(back));
}

// Delete (draft only)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const variation = db.prepare('SELECT v.*, j.job_number FROM variations v JOIN jobs j ON v.job_id = j.id WHERE v.id = ?').get(req.params.id);
  if (!variation) {
    req.flash('error', 'Variation not found.');
    return req.session.save(() => res.redirect('/variations'));
  }
  if (variation.approval_status !== 'draft') {
    req.flash('error', 'Only draft variations can be deleted — decided variations stay on the record.');
    return req.session.save(() => res.redirect('/variations/' + variation.id + '/edit'));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM variations WHERE id = ?').run(variation.id);
    syncVariationTotals(db, variation.job_id);
  })();
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'variation',
    entityId: variation.id, entityLabel: variation.variation_ref,
    jobId: variation.job_id, jobNumber: variation.job_number, ip: req.ip,
  });
  req.flash('success', `${variation.variation_ref} deleted.`);
  req.session.save(() => res.redirect('/variations'));
});

module.exports = router;
