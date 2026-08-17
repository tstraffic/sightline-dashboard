// Client inputs register (brief §5.10) — required information from the
// client and EVIDENCE of client-caused dependency: what was asked for,
// when it was needed, when it arrived, and whether it was adequate.
// Overdue items are the §10.1 delivery-risk flag.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sydneyToday } = require('../lib/sydney');

const STATUSES = ['requested', 'received', 'inadequate', 'accepted'];

function isAdmin(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return ['admin', 'management'].includes(role);
}

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { job_id, status, view, search } = req.query;
    const today = sydneyToday();
    let where = [];
    const params = [];
    if (job_id) { where.push('ci.job_id = ?'); params.push(job_id); }
    if (status && STATUSES.includes(status)) { where.push('ci.status = ?'); params.push(status); }
    if (view === 'overdue') {
      where.push("ci.status IN ('requested','inadequate') AND ci.needed_by IS NOT NULL AND ci.needed_by < ?");
      params.push(today);
    }
    if (search) {
      where.push('(ci.item LIKE ? OR ci.client_owner LIKE ? OR j.job_number LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    const inputs = db.prepare(`
      SELECT ci.*, j.job_number, j.project_name, j.job_name,
        c.full_name AS contact_name
      FROM client_inputs ci
      JOIN jobs j ON ci.job_id = j.id
      LEFT JOIN client_contacts c ON ci.contact_id = c.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE ci.status WHEN 'inadequate' THEN 0 WHEN 'requested' THEN 1 WHEN 'received' THEN 2 ELSE 3 END,
        ci.needed_by IS NULL, ci.needed_by
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status IN ('requested','inadequate') THEN 1 ELSE 0 END) AS outstanding,
        SUM(CASE WHEN status IN ('requested','inadequate') AND needed_by IS NOT NULL AND needed_by < ? THEN 1 ELSE 0 END) AS overdue,
        SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) AS awaiting_adequacy
      FROM client_inputs
    `).get(today);

    // Active projects for the inline add form's select.
    const jobs = db.prepare(`
      SELECT id, job_number, project_name, job_name FROM jobs
      WHERE job_number LIKE 'ST-%' AND status NOT IN ('closed','cancelled')
      ORDER BY job_number DESC
    `).all();

    res.render('client-inputs/index', {
      title: 'Client Inputs',
      currentPage: 'client-inputs',
      inputs,
      stats,
      jobs,
      statuses: STATUSES,
      today,
      isAdmin: isAdmin(req.session.user),
      filters: { job_id, status, view, search },
    });
  } catch (err) { next(err); }
});

// Create
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const back = b.return_to || '/client-inputs' + (b.job_id ? '?job_id=' + b.job_id : '');
  try {
    const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(b.job_id);
    if (!job) {
      req.flash('error', 'Pick the project the input belongs to.');
      return req.session.save(() => res.redirect('/client-inputs'));
    }
    if (!(b.item || '').trim()) {
      req.flash('error', 'Describe the required input.');
      return req.session.save(() => res.redirect(back));
    }
    const result = db.prepare(`
      INSERT INTO client_inputs (job_id, item, requested_date, client_owner, needed_by, sharepoint_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id, b.item.trim(), b.requested_date || sydneyToday(), b.client_owner || '',
      b.needed_by || null, b.sharepoint_url || '', req.session.user ? req.session.user.id : null
    );
    logActivity({
      user: req.session.user, action: 'create', entityType: 'client_input',
      entityId: result.lastInsertRowid, entityLabel: b.item.trim().substring(0, 60),
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', 'Client input recorded — chase it before it becomes the critical path.');
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to record input: ' + err.message);
    req.session.save(() => res.redirect(back));
  }
});

// Update fields
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const input = db.prepare('SELECT ci.*, j.job_number FROM client_inputs ci JOIN jobs j ON ci.job_id = j.id WHERE ci.id = ?').get(req.params.id);
  const back = b.return_to || '/client-inputs' + (input ? '?job_id=' + input.job_id : '');
  if (!input) {
    req.flash('error', 'Client input not found.');
    return req.session.save(() => res.redirect('/client-inputs'));
  }
  try {
    db.prepare(`
      UPDATE client_inputs SET item=?, requested_date=?, client_owner=?, needed_by=?,
        sharepoint_url=?, revision_note=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      (b.item || input.item).trim(), b.requested_date || input.requested_date,
      b.client_owner !== undefined ? b.client_owner : input.client_owner,
      b.needed_by || null, b.sharepoint_url !== undefined ? b.sharepoint_url : input.sharepoint_url,
      b.revision_note !== undefined ? b.revision_note : input.revision_note, input.id
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'client_input',
      entityId: input.id, entityLabel: input.item.substring(0, 60),
      jobId: input.job_id, jobNumber: input.job_number, ip: req.ip,
    });
    req.flash('success', 'Client input updated.');
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to update input: ' + err.message);
    req.session.save(() => res.redirect(back));
  }
});

// Status transitions: requested → received → accepted, with inadequate as
// the rejection loop (requires a note; re-receipt goes back to received).
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const input = db.prepare('SELECT ci.*, j.job_number FROM client_inputs ci JOIN jobs j ON ci.job_id = j.id WHERE ci.id = ?').get(req.params.id);
  const back = req.body.return_to || '/client-inputs' + (input ? '?job_id=' + input.job_id : '');
  if (!input) {
    req.flash('error', 'Client input not found.');
    return req.session.save(() => res.redirect('/client-inputs'));
  }
  const target = req.body.status;
  if (!STATUSES.includes(target)) {
    req.flash('error', 'Unknown status.');
    return req.session.save(() => res.redirect(back));
  }
  if (target === 'accepted' && input.status === 'requested') {
    req.flash('error', 'Mark the input received before accepting it.');
    return req.session.save(() => res.redirect(back));
  }
  if (target === 'inadequate' && !(req.body.revision_note || '').trim()) {
    req.flash('error', 'Say what was inadequate — the note is the evidence trail.');
    return req.session.save(() => res.redirect(back));
  }
  db.prepare(`
    UPDATE client_inputs SET status=?,
      received_date = CASE WHEN ? IN ('received','accepted') AND received_date IS NULL THEN ? ELSE received_date END,
      revision_note = CASE WHEN ? != '' THEN ? ELSE revision_note END,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(target, target, sydneyToday(), req.body.revision_note || '', req.body.revision_note || '', input.id);
  logActivity({
    user: req.session.user, action: target === 'accepted' ? 'complete' : 'update',
    entityType: 'client_input', entityId: input.id, entityLabel: input.item.substring(0, 60),
    jobId: input.job_id, jobNumber: input.job_number,
    details: `→ ${target}${req.body.revision_note ? ' · ' + req.body.revision_note : ''}`, ip: req.ip,
  });
  req.flash('success', `Input marked ${target}.`);
  req.session.save(() => res.redirect(back));
});

// Delete — open requests can be withdrawn by anyone; rows with receipt
// history are evidence and need admin/management.
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const input = db.prepare('SELECT ci.*, j.job_number FROM client_inputs ci JOIN jobs j ON ci.job_id = j.id WHERE ci.id = ?').get(req.params.id);
  const back = req.body.return_to || '/client-inputs' + (input ? '?job_id=' + input.job_id : '');
  if (!input) {
    req.flash('error', 'Client input not found.');
    return req.session.save(() => res.redirect('/client-inputs'));
  }
  if (input.status !== 'requested' && !isAdmin(req.session.user)) {
    req.flash('error', 'This input has receipt history — only admin/management can delete it.');
    return req.session.save(() => res.redirect(back));
  }
  db.prepare('DELETE FROM client_inputs WHERE id = ?').run(input.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'client_input',
    entityId: input.id, entityLabel: input.item.substring(0, 60),
    jobId: input.job_id, jobNumber: input.job_number, ip: req.ip,
  });
  req.flash('success', 'Client input deleted.');
  req.session.save(() => res.redirect(back));
});

module.exports = router;
