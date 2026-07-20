const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const upload = require('../middleware/upload');
const { autoLogDiary } = require('../lib/diary');
const { logActivity } = require('../middleware/audit');

// CTMPs are their own entity (spec §6) — separated but linked to a parent
// traffic_plan. Each CTMP tracks its own version history + per-version QA
// status, surfaced as a dashboard chip ("Rev B - pending QA").

// Auto-increment the revision label: Draft → Rev A → Rev B → ...
function nextCtmpRevision(db, ctmp) {
  const last = db.prepare('SELECT revision_label FROM ctmp_revisions WHERE ctmp_id = ? ORDER BY id DESC LIMIT 1').get(ctmp.id);
  const base = last ? last.revision_label : (ctmp.current_revision_label || 'Draft');
  const m = (base || '').match(/Rev\s+([A-Za-z])/);
  if (m) return 'Rev ' + String.fromCharCode(m[1].toUpperCase().charCodeAt(0) + 1);
  return 'Rev A';
}

function loadParent(db, planId) {
  if (!planId) return null;
  return db.prepare(`SELECT tp.id, tp.plan_number, tp.job_id, j.job_number, j.project_name, j.client
    FROM traffic_plans tp LEFT JOIN jobs j ON tp.job_id = j.id WHERE tp.id = ?`).get(planId);
}

// New CTMP form (linked to a plan via ?plan_id=)
router.get('/new', (req, res) => {
  const db = getDb();
  const parent = loadParent(db, req.query.plan_id);
  if (!parent) { req.flash('error', 'A parent plan is required to create a CTMP.'); return req.session.save(() => res.redirect('/plans')); }
  res.render('ctmps/form', { title: 'New CTMP', ctmp: null, parent, user: req.session.user });
});

// Create CTMP
router.post('/', upload.single('ctmp_file'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const parent = loadParent(db, b.plan_id);
  if (!parent) { req.flash('error', 'Parent plan not found.'); return req.session.save(() => res.redirect('/plans')); }

  // CTMP number: derive from parent plan + sequence
  const count = db.prepare('SELECT COUNT(*) AS c FROM ctmps WHERE plan_id = ?').get(parent.id).c;
  const ctmpNumber = `CTMP-${parent.plan_number}-${String(count + 1).padStart(2, '0')}`;
  const filePath = req.file ? 'uploads/' + req.file.filename : '';
  const fileName = req.file ? req.file.originalname : '';

  try {
    const result = db.prepare(`INSERT INTO ctmps (plan_id, job_id, ctmp_number, title, status, qa_status, current_revision_label, designer, file_path, file_original_name, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'Draft', ?, ?, ?, ?, ?)`)
      .run(parent.id, parent.job_id, ctmpNumber, b.title || ctmpNumber, b.status || 'draft', b.qa_status || 'pending',
        b.designer || '', filePath, fileName, b.notes || '', req.session.user.id);

    logActivity({ user: req.session.user, action: 'create', entityType: 'ctmp', entityId: result.lastInsertRowid, entityLabel: ctmpNumber, jobId: parent.job_id, details: `Created CTMP linked to ${parent.plan_number}`, ip: req.ip });
    autoLogDiary(db, { jobId: parent.job_id, summary: `[${req.session.user.full_name}] CTMP ${ctmpNumber} created (linked to ${parent.plan_number}).`, userId: req.session.user.id });
    req.flash('success', `CTMP ${ctmpNumber} created.`);
    req.session.save(() => res.redirect(`/ctmps/${result.lastInsertRowid}`));
  } catch (err) {
    req.flash('error', 'Failed to create CTMP: ' + err.message);
    req.session.save(() => res.redirect(`/ctmps/new?plan_id=${parent.id}`));
  }
});

// CTMP detail page
router.get('/:id', (req, res) => {
  const db = getDb();
  const ctmp = db.prepare(`SELECT c.*, u.full_name AS created_by_name, tp.plan_number, tp.job_id AS plan_job_id, j.job_number
    FROM ctmps c
    LEFT JOIN users u ON c.created_by = u.id
    LEFT JOIN traffic_plans tp ON c.plan_id = tp.id
    LEFT JOIN jobs j ON c.job_id = j.id
    WHERE c.id = ?`).get(req.params.id);
  if (!ctmp) { req.flash('error', 'CTMP not found.'); return req.session.save(() => res.redirect('/plans')); }
  const revisions = db.prepare('SELECT cr.*, u.full_name AS created_by_name FROM ctmp_revisions cr LEFT JOIN users u ON cr.created_by = u.id WHERE cr.ctmp_id = ? ORDER BY cr.id DESC').all(ctmp.id);
  const activity = db.prepare("SELECT * FROM activity_log WHERE entity_type = 'ctmp' AND entity_id = ? ORDER BY created_at DESC LIMIT 50").all(ctmp.id);
  res.render('ctmps/show', { title: ctmp.title || ctmp.ctmp_number, ctmp, revisions, activity, user: req.session.user });
});

// Edit CTMP form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const ctmp = db.prepare('SELECT * FROM ctmps WHERE id = ?').get(req.params.id);
  if (!ctmp) { req.flash('error', 'CTMP not found.'); return req.session.save(() => res.redirect('/plans')); }
  const parent = loadParent(db, ctmp.plan_id);
  res.render('ctmps/form', { title: 'Edit CTMP', ctmp, parent, user: req.session.user });
});

// Update CTMP
router.post('/:id', upload.single('ctmp_file'), (req, res) => {
  const db = getDb();
  const ctmp = db.prepare('SELECT * FROM ctmps WHERE id = ?').get(req.params.id);
  if (!ctmp) { req.flash('error', 'CTMP not found.'); return req.session.save(() => res.redirect('/plans')); }
  const b = req.body;
  let filePath = ctmp.file_path || '';
  let fileName = ctmp.file_original_name || '';
  if (req.file) { filePath = 'uploads/' + req.file.filename; fileName = req.file.originalname; }
  try {
    db.prepare(`UPDATE ctmps SET title=?, status=?, qa_status=?, designer=?, file_path=?, file_original_name=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(b.title || ctmp.ctmp_number, b.status || 'draft', b.qa_status || 'pending', b.designer || '', filePath, fileName, b.notes || '', ctmp.id);
    logActivity({ user: req.session.user, action: 'update', entityType: 'ctmp', entityId: ctmp.id, entityLabel: ctmp.ctmp_number, jobId: ctmp.job_id, details: 'Updated CTMP', beforeValue: ctmp.qa_status || '', afterValue: b.qa_status || '', ip: req.ip });
    req.flash('success', 'CTMP updated.');
  } catch (err) { req.flash('error', 'Failed to update CTMP: ' + err.message); }
  req.session.save(() => res.redirect(`/ctmps/${ctmp.id}`));
});

// Add a revision (auto Draft → Rev A → Rev B …)
router.post('/:id/revisions', upload.single('revision_file'), (req, res) => {
  const db = getDb();
  const ctmp = db.prepare('SELECT * FROM ctmps WHERE id = ?').get(req.params.id);
  if (!ctmp) { req.flash('error', 'CTMP not found.'); return req.session.save(() => res.redirect('/plans')); }
  const b = req.body;
  const label = nextCtmpRevision(db, ctmp);
  const filePath = req.file ? 'uploads/' + req.file.filename : '';
  const fileName = req.file ? req.file.originalname : '';
  const qaStatus = b.qa_status || 'pending';
  try {
    db.prepare('INSERT INTO ctmp_revisions (ctmp_id, revision_label, file_path, file_original_name, notes, qa_status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(ctmp.id, label, filePath, fileName, b.notes || '', qaStatus, req.session.user.id);
    db.prepare('UPDATE ctmps SET current_revision_label=?, qa_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(label, qaStatus, ctmp.id);
    logActivity({ user: req.session.user, action: 'update', entityType: 'ctmp', entityId: ctmp.id, entityLabel: ctmp.ctmp_number, jobId: ctmp.job_id, details: `Revised to ${label} (QA: ${qaStatus})`, ip: req.ip });
    autoLogDiary(db, { jobId: ctmp.job_id, summary: `[${req.session.user.full_name}] CTMP ${ctmp.ctmp_number} revised to ${label}. ${b.notes || ''}`, userId: req.session.user.id });
    req.flash('success', `Revision ${label} added.`);
  } catch (err) { req.flash('error', 'Failed to add revision: ' + err.message); }
  req.session.save(() => res.redirect(`/ctmps/${ctmp.id}`));
});

// Update QA status only
router.post('/:id/qa', (req, res) => {
  const db = getDb();
  const ctmp = db.prepare('SELECT * FROM ctmps WHERE id = ?').get(req.params.id);
  if (!ctmp) { req.flash('error', 'CTMP not found.'); return req.session.save(() => res.redirect('/plans')); }
  const qa = req.body.qa_status || 'pending';
  try {
    db.prepare('UPDATE ctmps SET qa_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(qa, ctmp.id);
    logActivity({ user: req.session.user, action: 'update', entityType: 'ctmp', entityId: ctmp.id, entityLabel: ctmp.ctmp_number, jobId: ctmp.job_id, details: `QA status → ${qa}`, beforeValue: ctmp.qa_status || '', afterValue: qa, ip: req.ip });
    req.flash('success', `QA status set to ${qa}.`);
  } catch (err) { req.flash('error', 'Failed to update QA: ' + err.message); }
  req.session.save(() => res.redirect(`/ctmps/${ctmp.id}`));
});

// Delete CTMP
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const ctmp = db.prepare('SELECT * FROM ctmps WHERE id = ?').get(req.params.id);
  if (!ctmp) { req.flash('error', 'CTMP not found.'); return req.session.save(() => res.redirect('/plans')); }
  const planId = ctmp.plan_id;
  try {
    db.prepare('DELETE FROM ctmps WHERE id = ?').run(ctmp.id);
    autoLogDiary(db, { jobId: ctmp.job_id, summary: `[${req.session.user.full_name}] CTMP ${ctmp.ctmp_number} deleted.`, userId: req.session.user.id });
    req.flash('success', `CTMP ${ctmp.ctmp_number} deleted.`);
  } catch (err) { req.flash('error', 'Failed to delete CTMP: ' + err.message); }
  req.session.save(() => res.redirect(planId ? `/plans/${planId}` : '/plans'));
});

module.exports = router;
