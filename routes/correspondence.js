// Correspondence / RFI register (brief §5.11) — MATERIAL correspondence
// only: RFIs, instructions, authority comments, design changes. Internal
// {job}-COR-NNN refs plus the counterparty's external_ref; open items with
// an action required and a response due date feed the due-date sweeps.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateCorrespondenceRef } = require('../lib/refNumbers');
const { sydneyToday } = require('../lib/sydney');

const STATUSES = ['open', 'responded', 'closed'];
const TYPES = ['rfi', 'instruction', 'authority_comment', 'design_change', 'other'];
const TYPE_LABELS = {
  rfi: 'RFI', instruction: 'Instruction', authority_comment: 'Authority Comment',
  design_change: 'Design Change', other: 'Other',
};

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { job_id, corr_type, status, view, search } = req.query;
    const today = sydneyToday();
    let where = [];
    const params = [];
    if (job_id) { where.push('co.job_id = ?'); params.push(job_id); }
    if (corr_type && TYPES.includes(corr_type)) { where.push('co.corr_type = ?'); params.push(corr_type); }
    if (status && STATUSES.includes(status)) { where.push('co.status = ?'); params.push(status); }
    if (view === 'due') {
      where.push("co.status = 'open' AND co.response_due IS NOT NULL AND co.response_due <= ?");
      params.push(today);
    }
    if (search) {
      where.push('(co.corr_ref LIKE ? OR co.external_ref LIKE ? OR co.subject LIKE ? OR j.job_number LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    const items = db.prepare(`
      SELECT co.*, j.job_number, j.project_name, j.job_name, u.full_name AS responsible_name
      FROM correspondence co
      JOIN jobs j ON co.job_id = j.id
      LEFT JOIN users u ON co.responsible_id = u.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE co.status WHEN 'open' THEN 0 WHEN 'responded' THEN 1 ELSE 2 END,
        co.response_due IS NULL, co.response_due, co.corr_ref DESC
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status = 'open' AND action_required != '' THEN 1 ELSE 0 END) AS action_required,
        SUM(CASE WHEN status = 'open' AND response_due IS NOT NULL AND response_due <= ? THEN 1 ELSE 0 END) AS due
      FROM correspondence
    `).get(today);

    res.render('correspondence/index', {
      title: 'Correspondence',
      currentPage: 'correspondence',
      items,
      stats,
      statuses: STATUSES,
      types: TYPES,
      typeLabels: TYPE_LABELS,
      today,
      filters: { job_id, corr_type, status, view, search },
    });
  } catch (err) { next(err); }
});

// New (from a project)
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    const jobId = req.query.job_id;
    if (!jobId) {
      req.flash('error', 'Correspondence is logged against a project — open the project first.');
      return req.session.save(() => res.redirect('/correspondence'));
    }
    const job = db.prepare('SELECT id, job_number, project_name, job_name FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/correspondence'));
    }
    const users = db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all();
    res.render('correspondence/form', {
      title: 'Log Correspondence — ' + job.job_number,
      currentPage: 'correspondence',
      item: null,
      job,
      users,
      types: TYPES,
      typeLabels: TYPE_LABELS,
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
      return req.session.save(() => res.redirect('/correspondence'));
    }
    if (!(b.subject || '').trim()) {
      req.flash('error', 'Give the correspondence a subject.');
      return req.session.save(() => res.redirect('/correspondence/new?job_id=' + job.id));
    }
    const ref = generateCorrespondenceRef(job.job_number);
    const result = db.prepare(`
      INSERT INTO correspondence (corr_ref, external_ref, job_id, corr_date, direction, sender, recipient,
        subject, corr_type, action_required, responsible_id, response_due, link_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, b.external_ref || '', job.id, b.corr_date || sydneyToday(),
      b.direction === 'outbound' ? 'outbound' : 'inbound', b.sender || '', b.recipient || '',
      b.subject.trim(), TYPES.includes(b.corr_type) ? b.corr_type : 'other',
      b.action_required || '', b.responsible_id || null, b.response_due || null,
      b.link_url || '', req.session.user ? req.session.user.id : null
    );
    logActivity({
      user: req.session.user, action: 'create', entityType: 'correspondence',
      entityId: result.lastInsertRowid, entityLabel: ref,
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', `${ref} logged.`);
    req.session.save(() => res.redirect(b.return_to || '/correspondence?job_id=' + job.id));
  } catch (err) {
    req.flash('error', 'Failed to log correspondence: ' + err.message);
    req.session.save(() => res.redirect(b.job_id ? '/correspondence/new?job_id=' + b.job_id : '/correspondence'));
  }
});

// Edit
router.get('/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT co.*, j.job_number, j.project_name, j.job_name FROM correspondence co JOIN jobs j ON co.job_id = j.id WHERE co.id = ?').get(req.params.id);
    if (!item) {
      req.flash('error', 'Correspondence not found.');
      return req.session.save(() => res.redirect('/correspondence'));
    }
    const users = db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all();
    res.render('correspondence/form', {
      title: 'Edit ' + item.corr_ref,
      currentPage: 'correspondence',
      item,
      job: { id: item.job_id, job_number: item.job_number, project_name: item.project_name, job_name: item.job_name },
      users,
      types: TYPES,
      typeLabels: TYPE_LABELS,
    });
  } catch (err) { next(err); }
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const item = db.prepare('SELECT co.*, j.job_number FROM correspondence co JOIN jobs j ON co.job_id = j.id WHERE co.id = ?').get(req.params.id);
  if (!item) {
    req.flash('error', 'Correspondence not found.');
    return req.session.save(() => res.redirect('/correspondence'));
  }
  try {
    db.prepare(`
      UPDATE correspondence SET external_ref=?, corr_date=?, direction=?, sender=?, recipient=?,
        subject=?, corr_type=?, action_required=?, responsible_id=?, response_due=?, link_url=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.external_ref || '', b.corr_date || item.corr_date,
      b.direction === 'outbound' ? 'outbound' : 'inbound', b.sender || '', b.recipient || '',
      (b.subject || item.subject).trim(), TYPES.includes(b.corr_type) ? b.corr_type : item.corr_type,
      b.action_required || '', b.responsible_id || null, b.response_due || null,
      b.link_url || '', item.id
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'correspondence',
      entityId: item.id, entityLabel: item.corr_ref,
      jobId: item.job_id, jobNumber: item.job_number, ip: req.ip,
    });
    req.flash('success', `${item.corr_ref} updated.`);
    req.session.save(() => res.redirect(b.return_to || '/correspondence?job_id=' + item.job_id));
  } catch (err) {
    req.flash('error', 'Failed to update: ' + err.message);
    req.session.save(() => res.redirect('/correspondence/' + item.id + '/edit'));
  }
});

// Status: open → responded → closed (reopen allowed — validated set only)
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT co.*, j.job_number FROM correspondence co JOIN jobs j ON co.job_id = j.id WHERE co.id = ?').get(req.params.id);
  const back = req.body.return_to || '/correspondence' + (item ? '?job_id=' + item.job_id : '');
  if (!item) {
    req.flash('error', 'Correspondence not found.');
    return req.session.save(() => res.redirect('/correspondence'));
  }
  const target = req.body.status;
  if (!STATUSES.includes(target)) {
    req.flash('error', 'Unknown status.');
    return req.session.save(() => res.redirect(back));
  }
  db.prepare('UPDATE correspondence SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(target, item.id);
  logActivity({
    user: req.session.user, action: target === 'closed' ? 'complete' : 'update',
    entityType: 'correspondence', entityId: item.id, entityLabel: item.corr_ref,
    jobId: item.job_id, jobNumber: item.job_number, details: `→ ${target}`, ip: req.ip,
  });
  req.flash('success', `${item.corr_ref} marked ${target}.`);
  req.session.save(() => res.redirect(back));
});

// Delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT co.*, j.job_number FROM correspondence co JOIN jobs j ON co.job_id = j.id WHERE co.id = ?').get(req.params.id);
  if (!item) {
    req.flash('error', 'Correspondence not found.');
    return req.session.save(() => res.redirect('/correspondence'));
  }
  db.prepare('DELETE FROM correspondence WHERE id = ?').run(item.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'correspondence',
    entityId: item.id, entityLabel: item.corr_ref,
    jobId: item.job_id, jobNumber: item.job_number, ip: req.ip,
  });
  req.flash('success', `${item.corr_ref} deleted.`);
  req.session.save(() => res.redirect('/correspondence?job_id=' + item.job_id));
});

module.exports = router;
