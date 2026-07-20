// /tenders — first-class parent records grouping jobs + compliance plans.
// A tender represents a bid for work; once won, the linked jobs/plans
// roll up under it for traceability.
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const STATUS_VALUES = ['open', 'submitted', 'won', 'lost', 'withdrawn'];
const STATUS_LABELS = {
  open:       'Open',
  submitted:  'Submitted',
  won:        'Won',
  lost:       'Lost',
  withdrawn:  'Withdrawn',
};

// Generate the next tender number: TND-YYYY-### where ### is per-year sequence.
function nextTenderNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `TND-${year}-`;
  const last = db.prepare(`
    SELECT tender_number FROM tenders
    WHERE tender_number LIKE ? ORDER BY id DESC LIMIT 1
  `).get(prefix + '%');
  let n = 1;
  if (last && last.tender_number) {
    const m = last.tender_number.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return prefix + String(n).padStart(3, '0');
}

function loadFormChoices(db) {
  return {
    clients: db.prepare("SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name").all(),
    users: db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all(),
  };
}

// GET /tenders — list with filter by status
router.get('/', requirePermission('tenders'), (req, res) => {
  const db = getDb();
  const { status, client_id } = req.query;
  let sql = `
    SELECT t.*, c.company_name AS client_name, u.full_name AS owner_name,
      (SELECT COUNT(*) FROM jobs WHERE tender_id = t.id) AS job_count,
      (SELECT COUNT(*) FROM compliance WHERE tender_id = t.id AND parent_id IS NULL) AS plan_count
    FROM tenders t
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.owner_id
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== 'all' && STATUS_VALUES.includes(status)) { sql += ' AND t.status = ?'; params.push(status); }
  if (client_id) { sql += ' AND t.client_id = ?'; params.push(client_id); }
  sql += ' ORDER BY t.created_at DESC';

  const tenders = db.prepare(sql).all(...params);
  const counts = db.prepare(`
    SELECT status, COUNT(*) AS c FROM tenders GROUP BY status
  `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});

  res.render('tenders/index', {
    title: 'Tenders', currentPage: 'tenders',
    tenders, counts, statusValues: STATUS_VALUES, statusLabels: STATUS_LABELS,
    filters: { status: status || 'all', client_id: client_id || '' },
    clients: db.prepare("SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name").all(),
  });
});

// GET /tenders/new — create form
router.get('/new', requirePermission('tenders'), (req, res) => {
  const db = getDb();
  const choices = loadFormChoices(db);
  res.render('tenders/form', {
    title: 'New Tender', currentPage: 'tenders',
    tender: null, isEdit: false,
    statusValues: STATUS_VALUES, statusLabels: STATUS_LABELS,
    ...choices,
  });
});

// POST /tenders — create
router.post('/', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return req.session.save(() => res.redirect('/tenders/new'));
    }
    const status = STATUS_VALUES.includes(b.status) ? b.status : 'open';
    const tenderNumber = nextTenderNumber(db);
    const r = db.prepare(`
      INSERT INTO tenders (tender_number, title, client_id, status, estimated_value, submission_due, principal_contractor, site_address, notes, created_by_id, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tenderNumber, title,
      b.client_id || null, status,
      parseFloat(b.estimated_value) || 0,
      b.submission_due || null,
      String(b.principal_contractor || '').trim(),
      String(b.site_address || '').trim(),
      String(b.notes || '').trim(),
      req.session.user ? req.session.user.id : null,
      b.owner_id || null,
    );
    try { logActivity({ user: req.session.user, action: 'create', entityType: 'tender', entityId: r.lastInsertRowid, entityLabel: tenderNumber, details: title, ip: req.ip }); } catch (e) {}
    req.flash('success', `Tender ${tenderNumber} created.`);
    return req.session.save(() => res.redirect('/tenders/' + r.lastInsertRowid));
  } catch (err) {
    console.error('[tenders POST]', err);
    req.flash('error', 'Could not create tender: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/tenders/new'));
  }
});

// GET /tenders/:id — detail
router.get('/:id', requirePermission('tenders'), (req, res) => {
  const db = getDb();
  const tender = db.prepare(`
    SELECT t.*, c.company_name AS client_name, u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM tenders t
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN users u ON u.id = t.owner_id
    LEFT JOIN users cu ON cu.id = t.created_by_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!tender) { req.flash('error', 'Tender not found.'); return req.session.save(() => res.redirect('/tenders')); }

  const linkedJobs = db.prepare(`
    SELECT id, job_number, job_name, project_name, client, status, contract_value
    FROM jobs WHERE tender_id = ? ORDER BY job_number
  `).all(tender.id);

  const linkedPlans = db.prepare(`
    SELECT c.id, c.title, c.status, c.plan_number, c.item_type, c.item_types,
      (SELECT COUNT(*) FROM compliance s WHERE s.parent_id = c.id) AS sub_count,
      j.job_number, j.id AS job_id
    FROM compliance c
    LEFT JOIN jobs j ON j.id = c.job_id
    WHERE c.tender_id = ? AND c.parent_id IS NULL
    ORDER BY c.id DESC
  `).all(tender.id);

  // Linked tasks (tender_id is added in migration 162; fall back to []
  // on stale schemas so the page still renders pre-migration).
  let linkedTasks = [];
  try {
    linkedTasks = db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.division,
        u.full_name AS owner_name, j.job_number, j.id AS job_id
      FROM tasks t
      LEFT JOIN users u ON u.id = t.owner_id
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.tender_id = ? AND t.deleted_at IS NULL
      ORDER BY t.due_date ASC, t.id DESC
    `).all(tender.id);
  } catch (e) {}

  // Available pickers — recent jobs/plans without a tender, plus those already linked
  const availableJobs = db.prepare(`
    SELECT id, job_number, job_name, project_name, client, status FROM jobs
    WHERE (tender_id IS NULL OR tender_id = ?) AND status NOT IN ('closed', 'completed')
    ORDER BY job_number DESC LIMIT 100
  `).all(tender.id);
  const availablePlans = db.prepare(`
    SELECT c.id, c.title, c.plan_number, c.item_type, j.job_number FROM compliance c
    LEFT JOIN jobs j ON j.id = c.job_id
    WHERE (c.tender_id IS NULL OR c.tender_id = ?) AND c.parent_id IS NULL
    ORDER BY c.id DESC LIMIT 100
  `).all(tender.id);

  res.render('tenders/show', {
    title: tender.tender_number, currentPage: 'tenders',
    tender, linkedJobs, linkedPlans, linkedTasks, availableJobs, availablePlans,
    statusValues: STATUS_VALUES, statusLabels: STATUS_LABELS,
  });
});

// GET /tenders/:id/edit
router.get('/:id/edit', requirePermission('tenders'), (req, res) => {
  const db = getDb();
  const tender = db.prepare("SELECT * FROM tenders WHERE id = ?").get(req.params.id);
  if (!tender) { req.flash('error', 'Tender not found.'); return req.session.save(() => res.redirect('/tenders')); }
  const choices = loadFormChoices(db);
  res.render('tenders/form', {
    title: 'Edit ' + tender.tender_number, currentPage: 'tenders',
    tender, isEdit: true,
    statusValues: STATUS_VALUES, statusLabels: STATUS_LABELS,
    ...choices,
  });
});

// POST /tenders/:id — update
router.post('/:id', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const tender = db.prepare("SELECT * FROM tenders WHERE id = ?").get(req.params.id);
    if (!tender) { req.flash('error', 'Tender not found.'); return req.session.save(() => res.redirect('/tenders')); }
    const b = req.body;
    const title = String(b.title || '').trim() || tender.title;
    const status = STATUS_VALUES.includes(b.status) ? b.status : tender.status;
    db.prepare(`
      UPDATE tenders SET title = ?, client_id = ?, status = ?, estimated_value = ?, submission_due = ?,
        submitted_at = ?, decision_at = ?, decision_notes = ?,
        principal_contractor = ?, site_address = ?, notes = ?, owner_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, b.client_id || null, status,
      parseFloat(b.estimated_value) || 0,
      b.submission_due || null,
      b.submitted_at || null,
      b.decision_at || null,
      String(b.decision_notes || '').trim(),
      String(b.principal_contractor || '').trim(),
      String(b.site_address || '').trim(),
      String(b.notes || '').trim(),
      b.owner_id || null,
      tender.id
    );
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'tender', entityId: tender.id, entityLabel: tender.tender_number, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'Tender updated.');
    return req.session.save(() => res.redirect('/tenders/' + tender.id));
  } catch (err) {
    console.error('[tenders PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/tenders/' + req.params.id + '/edit'));
  }
});

// POST /tenders/:id/delete — sets tender_id = NULL on jobs/compliance, then deletes
router.post('/:id/delete', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const tender = db.prepare("SELECT * FROM tenders WHERE id = ?").get(req.params.id);
    if (!tender) { req.flash('error', 'Tender not found.'); return req.session.save(() => res.redirect('/tenders')); }
    db.prepare("UPDATE jobs SET tender_id = NULL WHERE tender_id = ?").run(tender.id);
    db.prepare("UPDATE compliance SET tender_id = NULL WHERE tender_id = ?").run(tender.id);
    db.prepare("DELETE FROM tenders WHERE id = ?").run(tender.id);
    try { logActivity({ user: req.session.user, action: 'delete', entityType: 'tender', entityId: tender.id, entityLabel: tender.tender_number, details: 'Deleted tender; linked records detached', ip: req.ip }); } catch (e) {}
    req.flash('success', `Deleted ${tender.tender_number}. Linked jobs/plans detached.`);
    return req.session.save(() => res.redirect('/tenders'));
  } catch (err) {
    console.error('[tenders DELETE]', err);
    req.flash('error', 'Delete failed: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/tenders'));
  }
});

// POST /tenders/:id/link-job — link an existing job
router.post('/:id/link-job', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const tender = db.prepare("SELECT id, tender_number FROM tenders WHERE id = ?").get(req.params.id);
    if (!tender) { req.flash('error', 'Tender not found.'); return req.session.save(() => res.redirect('/tenders')); }
    const jobId = parseInt(req.body.job_id, 10);
    if (!jobId) { req.flash('error', 'Pick a job.'); return req.session.save(() => res.redirect('/tenders/' + tender.id)); }
    db.prepare("UPDATE jobs SET tender_id = ? WHERE id = ?").run(tender.id, jobId);
    req.flash('success', 'Job linked to tender.');
    return req.session.save(() => res.redirect('/tenders/' + tender.id));
  } catch (err) {
    console.error('[tenders link-job]', err);
    req.flash('error', 'Link failed: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/tenders/' + req.params.id));
  }
});

// POST /tenders/:id/unlink-job
router.post('/:id/unlink-job', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const jobId = parseInt(req.body.job_id, 10);
    if (jobId) db.prepare("UPDATE jobs SET tender_id = NULL WHERE id = ? AND tender_id = ?").run(jobId, req.params.id);
    req.flash('success', 'Job unlinked.');
    return req.session.save(() => res.redirect('/tenders/' + req.params.id));
  } catch (err) {
    console.error('[tenders unlink-job]', err);
    req.flash('error', 'Unlink failed.');
    return req.session.save(() => res.redirect('/tenders/' + req.params.id));
  }
});

// POST /tenders/:id/link-plan
router.post('/:id/link-plan', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const tender = db.prepare("SELECT id FROM tenders WHERE id = ?").get(req.params.id);
    if (!tender) { req.flash('error', 'Tender not found.'); return req.session.save(() => res.redirect('/tenders')); }
    const planId = parseInt(req.body.plan_id, 10);
    if (!planId) { req.flash('error', 'Pick a plan.'); return req.session.save(() => res.redirect('/tenders/' + tender.id)); }
    // Cascade to all sub-plans of this parent so they all reflect the tender link
    db.prepare("UPDATE compliance SET tender_id = ? WHERE id = ? OR parent_id = ?").run(tender.id, planId, planId);
    req.flash('success', 'Plan linked to tender.');
    return req.session.save(() => res.redirect('/tenders/' + tender.id));
  } catch (err) {
    console.error('[tenders link-plan]', err);
    req.flash('error', 'Link failed: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/tenders/' + req.params.id));
  }
});

// POST /tenders/:id/unlink-plan
router.post('/:id/unlink-plan', requirePermission('tenders'), (req, res) => {
  try {
    const db = getDb();
    const planId = parseInt(req.body.plan_id, 10);
    if (planId) db.prepare("UPDATE compliance SET tender_id = NULL WHERE (id = ? OR parent_id = ?) AND tender_id = ?").run(planId, planId, req.params.id);
    req.flash('success', 'Plan unlinked.');
    return req.session.save(() => res.redirect('/tenders/' + req.params.id));
  } catch (err) {
    console.error('[tenders unlink-plan]', err);
    req.flash('error', 'Unlink failed.');
    return req.session.save(() => res.redirect('/tenders/' + req.params.id));
  }
});

module.exports = router;
