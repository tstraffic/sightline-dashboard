// Approvals register (brief §5.7) — ROLs, council permits, TfNSW
// submissions and other authority approvals. Views: pending, awaiting
// information, due, expiring. Status transitions stamp their dates.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateApprovalRef } = require('../lib/refNumbers');
const { getConfig } = require('../middleware/settings');
const { sydneyToday } = require('../lib/sydney');

const STATUSES = ['not_submitted', 'submitted', 'info_requested', 'approved', 'rejected', 'expired'];

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Register (with §5.7 views)
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { view, job_id, status, search } = req.query;
    const today = sydneyToday();
    const warnDays = parseInt(getConfig('approval_warning_days', 7), 10) || 7;
    const expiryDays = parseInt(getConfig('approval_expiry_warning_days', 30), 10) || 30;
    const dueSoon = addDaysIso(today, warnDays);
    const expirySoon = addDaysIso(today, expiryDays);

    let where = [];
    const params = [];
    if (job_id) { where.push('a.job_id = ?'); params.push(job_id); }
    if (status && STATUSES.includes(status)) { where.push('a.status = ?'); params.push(status); }
    if (req.query.approval_type) { where.push('a.approval_type = ?'); params.push(req.query.approval_type); }
    if (view === 'pending') where.push("a.status IN ('not_submitted','submitted','info_requested')");
    if (view === 'awaiting_info') where.push("a.status = 'info_requested'");
    if (view === 'due') { where.push("a.status IN ('submitted','info_requested') AND a.requested_date IS NOT NULL AND a.requested_date <= ?"); params.push(dueSoon); }
    if (view === 'expiring') { where.push("a.status = 'approved' AND a.expiry_date IS NOT NULL AND a.expiry_date <= ?"); params.push(expirySoon); }
    if (search) {
      where.push('(a.approval_ref LIKE ? OR a.approval_type LIKE ? OR a.authority LIKE ? OR a.reference_number LIKE ? OR j.job_number LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }

    const approvals = db.prepare(`
      SELECT a.*, j.job_number, j.project_name, j.job_name, u.full_name AS responsible_name, sp.package_ref
      FROM approvals a
      JOIN jobs j ON a.job_id = j.id
      LEFT JOIN users u ON a.responsible_id = u.id
      LEFT JOIN service_packages sp ON a.service_package_id = sp.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN a.status IN ('approved','rejected','expired') THEN 1 ELSE 0 END,
        a.requested_date IS NULL, a.requested_date, a.approval_ref
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('not_submitted','submitted','info_requested') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'info_requested' THEN 1 ELSE 0 END) AS awaiting_info,
        SUM(CASE WHEN status IN ('submitted','info_requested') AND requested_date IS NOT NULL AND requested_date <= ? THEN 1 ELSE 0 END) AS due,
        SUM(CASE WHEN status = 'approved' AND expiry_date IS NOT NULL AND expiry_date <= ? THEN 1 ELSE 0 END) AS expiring
      FROM approvals
    `).get(dueSoon, expirySoon);

    res.render('approvals/index', {
      title: 'Approvals',
      currentPage: 'approvals',
      approvals,
      stats,
      statuses: STATUSES,
      filters: { view, job_id, status, search, approval_type: req.query.approval_type || '' },
    });
  } catch (err) { next(err); }
});

// New (from a project)
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    const jobId = req.query.job_id;
    if (!jobId) {
      req.flash('error', 'Approvals are created against a project — open the project and add one from its Approvals tab.');
      return req.session.save(() => res.redirect('/approvals'));
    }
    const job = db.prepare('SELECT id, job_number, project_name, job_name, project_manager_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/approvals'));
    }
    res.render('approvals/form', {
      title: 'New Approval — ' + job.job_number,
      currentPage: 'approvals',
      approval: null,
      job,
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      packages: db.prepare('SELECT id, package_ref FROM service_packages WHERE job_id = ? ORDER BY package_ref').all(job.id),
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
      return req.session.save(() => res.redirect('/approvals'));
    }
    if (!(b.approval_type || '').trim()) {
      req.flash('error', 'An approval type is required (e.g. ROL, Council permit).');
      return req.session.save(() => res.redirect('/approvals/new?job_id=' + job.id));
    }
    const ref = generateApprovalRef(job.job_number);
    const result = db.prepare(`
      INSERT INTO approvals (approval_ref, job_id, service_package_id, approval_type, authority,
        responsible_id, submission_date, requested_date, reference_number, expiry_date, conditions,
        sharepoint_url, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, job.id, b.service_package_id || null, b.approval_type.trim(), b.authority || '',
      b.responsible_id || (req.session.user ? req.session.user.id : null),
      b.submission_date || null, b.requested_date || null, b.reference_number || '',
      b.expiry_date || null, b.conditions || '', b.sharepoint_url || '',
      b.submission_date ? 'submitted' : 'not_submitted',
      req.session.user ? req.session.user.id : null
    );
    logActivity({
      user: req.session.user, action: 'create', entityType: 'approval',
      entityId: result.lastInsertRowid, entityLabel: ref,
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', `Approval ${ref} recorded.`);
    req.session.save(() => res.redirect(b.return_to || '/approvals?job_id=' + job.id));
  } catch (err) {
    req.flash('error', 'Failed to create approval: ' + err.message);
    req.session.save(() => res.redirect(b.job_id ? '/approvals/new?job_id=' + b.job_id : '/approvals'));
  }
});

// Create the approval records a project's ROL / TMP / TGS flags imply.
// Explicit button on the project's Approvals tab — only mints the types
// that are flagged and don't already have a record, so it's safe to
// press twice.
const FLAG_TO_TYPE = [
  { flag: 'rol_required', type: 'rol', authority: '' },
  { flag: 'tmp_required', type: 'tmp_approval', authority: '' },
  { flag: 'tgs_required', type: 'traffic_guidance', authority: '' },
];
router.post('/seed-from-flags', (req, res) => {
  const db = getDb();
  const jobId = req.body.job_id;
  const back = req.body.return_to || '/jobs/' + jobId + '#approvals';
  try {
    const job = db.prepare('SELECT id, job_number, rol_required, tmp_required, tgs_required, project_manager_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/approvals'));
    }
    const existing = new Set(db.prepare('SELECT approval_type FROM approvals WHERE job_id = ?').all(job.id).map(r => r.approval_type));
    const created = [];
    db.transaction(() => {
      for (const { flag, type } of FLAG_TO_TYPE) {
        if (!job[flag] || existing.has(type)) continue;
        const ref = generateApprovalRef(job.job_number);
        const result = db.prepare(`
          INSERT INTO approvals (approval_ref, job_id, approval_type, responsible_id, status, created_by)
          VALUES (?, ?, ?, ?, 'not_submitted', ?)
        `).run(ref, job.id, type, job.project_manager_id || (req.session.user ? req.session.user.id : null),
          req.session.user ? req.session.user.id : null);
        logActivity({
          user: req.session.user, action: 'create', entityType: 'approval',
          entityId: result.lastInsertRowid, entityLabel: ref,
          jobId: job.id, jobNumber: job.job_number, details: 'Created from project approval flags', ip: req.ip,
        });
        created.push(ref);
      }
    })();
    if (!created.length) {
      req.flash('error', 'Nothing to add — the flagged approvals already have records.');
    } else {
      req.flash('success', `Created ${created.length} approval record${created.length === 1 ? '' : 's'}: ${created.join(', ')}. Add the authority and submission dates when you lodge them.`);
    }
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to create approvals: ' + err.message);
    req.session.save(() => res.redirect(back));
  }
});

// Edit form
router.get('/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const approval = db.prepare('SELECT a.*, j.job_number, j.project_name, j.job_name FROM approvals a JOIN jobs j ON a.job_id = j.id WHERE a.id = ?').get(req.params.id);
    if (!approval) {
      req.flash('error', 'Approval not found.');
      return req.session.save(() => res.redirect('/approvals'));
    }
    res.render('approvals/form', {
      title: 'Edit ' + approval.approval_ref,
      currentPage: 'approvals',
      approval,
      job: { id: approval.job_id, job_number: approval.job_number, project_name: approval.project_name, job_name: approval.job_name },
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      packages: db.prepare('SELECT id, package_ref FROM service_packages WHERE job_id = ? ORDER BY package_ref').all(approval.job_id),
    });
  } catch (err) { next(err); }
});

// Update fields
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const approval = db.prepare('SELECT a.*, j.job_number FROM approvals a JOIN jobs j ON a.job_id = j.id WHERE a.id = ?').get(req.params.id);
    if (!approval) {
      req.flash('error', 'Approval not found.');
      return req.session.save(() => res.redirect('/approvals'));
    }
    db.prepare(`
      UPDATE approvals SET approval_type=?, authority=?, service_package_id=?, responsible_id=?,
        submission_date=?, requested_date=?, reference_number=?, expiry_date=?, conditions=?,
        info_request_notes=?, sharepoint_url=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.approval_type || approval.approval_type, b.authority || '', b.service_package_id || null,
      b.responsible_id || null, b.submission_date || null, b.requested_date || null,
      b.reference_number || '', b.expiry_date || null, b.conditions || '',
      b.info_request_notes !== undefined ? b.info_request_notes : approval.info_request_notes,
      b.sharepoint_url || '', approval.id
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'approval',
      entityId: approval.id, entityLabel: approval.approval_ref,
      jobId: approval.job_id, jobNumber: approval.job_number, ip: req.ip,
    });
    req.flash('success', `${approval.approval_ref} updated.`);
    req.session.save(() => res.redirect(b.return_to || '/approvals?job_id=' + approval.job_id));
  } catch (err) {
    req.flash('error', 'Failed to update approval: ' + err.message);
    req.session.save(() => res.redirect('/approvals/' + req.params.id + '/edit'));
  }
});

// Status transitions — each stamps its dates and validates the input.
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const b = req.body;
  const approval = db.prepare('SELECT a.*, j.job_number FROM approvals a JOIN jobs j ON a.job_id = j.id WHERE a.id = ?').get(req.params.id);
  if (!approval) {
    req.flash('error', 'Approval not found.');
    return req.session.save(() => res.redirect('/approvals'));
  }
  const back = b.return_to || '/approvals?job_id=' + approval.job_id;
  const newStatus = b.status;
  if (!STATUSES.includes(newStatus)) {
    req.flash('error', 'Unknown approval status.');
    return req.session.save(() => res.redirect(back));
  }
  if (newStatus === 'info_requested' && !(b.info_request_notes || '').trim()) {
    req.flash('error', 'Record what information the authority has requested.');
    return req.session.save(() => res.redirect(back));
  }
  const today = sydneyToday();
  db.prepare(`
    UPDATE approvals SET status=?,
      submission_date = CASE WHEN ? = 'submitted' AND submission_date IS NULL THEN ? ELSE submission_date END,
      approval_date   = CASE WHEN ? = 'approved' THEN COALESCE(NULLIF(?, ''), ?) WHEN ? IN ('not_submitted','submitted','info_requested') THEN NULL ELSE approval_date END,
      reference_number = CASE WHEN ? != '' THEN ? ELSE reference_number END,
      expiry_date     = CASE WHEN ? != '' THEN ? ELSE expiry_date END,
      conditions      = CASE WHEN ? != '' THEN ? ELSE conditions END,
      info_request_notes = CASE WHEN ? = 'info_requested' THEN ? ELSE info_request_notes END,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    newStatus,
    newStatus, today,
    newStatus, b.approval_date || '', today, newStatus,
    b.reference_number || '', b.reference_number || '',
    b.expiry_date || '', b.expiry_date || '',
    b.conditions || '', b.conditions || '',
    newStatus, b.info_request_notes || '',
    approval.id
  );
  logActivity({
    user: req.session.user,
    action: newStatus === 'approved' ? 'approve' : (newStatus === 'rejected' ? 'reject' : 'update'),
    entityType: 'approval', entityId: approval.id, entityLabel: approval.approval_ref,
    jobId: approval.job_id, jobNumber: approval.job_number,
    beforeValue: approval.status, afterValue: newStatus, ip: req.ip,
  });
  req.flash('success', `${approval.approval_ref} → ${newStatus.replace(/_/g, ' ')}.`);
  req.session.save(() => res.redirect(back));
});

// Delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const approval = db.prepare('SELECT a.*, j.job_number FROM approvals a JOIN jobs j ON a.job_id = j.id WHERE a.id = ?').get(req.params.id);
  if (!approval) {
    req.flash('error', 'Approval not found.');
    return req.session.save(() => res.redirect('/approvals'));
  }
  db.prepare('DELETE FROM approvals WHERE id = ?').run(approval.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'approval',
    entityId: approval.id, entityLabel: approval.approval_ref,
    jobId: approval.job_id, jobNumber: approval.job_number, ip: req.ip,
  });
  req.flash('success', `${approval.approval_ref} deleted.`);
  req.session.save(() => res.redirect('/approvals'));
});

module.exports = router;
