// /sop-register — SOP register (templates + job-linked docs).
//
// Mirrors the SWMS register exactly. Two ways a row gets created:
//   - "Import template" → upload a reusable SOP file (kind = 'template').
//   - "Assign new SOP" → placeholder linked to a job + assignee, no
//     file yet (kind = 'job', status = 'draft'). Owner uploads later.
//
// Files live under data/uploads/sop-register/ — outside /public so we can
// serve them through an auth-checked download route. Separate from the
// induction sop_documents table by design.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sendPushToAllActiveCrew } = require('../services/pushNotification');

// Opaque version token. Rotates whenever a SOP file is replaced or the row
// transitions draft -> active. Workers store this token on their ack rows;
// when it changes they must re-acknowledge. Title typos / notes edits do NOT
// rotate the token (handled at the route level, not by the schema).
function newVersionToken() {
  return 'v' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function notifyCrewSopUpdate(sopRow) {
  sendPushToAllActiveCrew({
    title: 'SOP updated: ' + sopRow.title,
    body: 'A new version requires your acknowledgement.',
    url: '/w/safety/sop-register/' + sopRow.id,
    type: 'sop_update',
    category: 'sop_update',
  }).catch(e => console.error('[sop-register] push fan-out error:', e.message));
}

const SOP_DIR = path.join(__dirname, '..', 'data', 'uploads', 'sop-register');
if (!fs.existsSync(SOP_DIR)) fs.mkdirSync(SOP_DIR, { recursive: true });

const sopStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SOP_DIR),
  filename: (req, file, cb) => {
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, stamp + path.extname(file.originalname));
  }
});
const sopUpload = multer({
  storage: sopStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — SOP PDFs can be hefty
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx?|xlsx?|jpg|jpeg|png)$/i.test(file.originalname);
    cb(null, ok);
  }
});

const KIND_LABELS = { template: 'Template', job: 'Job-linked' };
const STATUS_LABELS = { draft: 'Draft', active: 'Active', archived: 'Archived' };
const STATUS_VALUES = ['draft', 'active', 'archived'];
const KIND_VALUES = ['template', 'job'];
// Renewal cadence mirrors SWMS: job-linked SOPs renew every 6 months,
// templates update every 3 months. Used to auto-default the expiry_date
// when the admin doesn't enter one.
const CYCLE_MONTHS = { template: 3, job: 6 };

function defaultExpiryFor(kind, baseDate = new Date()) {
  const months = CYCLE_MONTHS[kind] || 6;
  const d = new Date(baseDate.getTime());
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function loadFormChoices(db) {
  return {
    jobs: db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all(),
    users: db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all(),
  };
}

// GET /sop-register — register list. Two tab views:
//   • active (default): Templates + Job-linked sections, archived rows hidden
//   • archived: single combined table of everything archived
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id } = req.query;
  const view = req.query.view === 'archived' ? 'archived' : 'active';

  let where = '1=1';
  const params = [];
  if (view === 'archived') {
    where += " AND s.status = 'archived'";
  } else {
    where += " AND s.status <> 'archived'";
    // Status filter (Draft/Active) still applies within the active tab.
    if (status && STATUS_VALUES.includes(status) && status !== 'archived') {
      where += ' AND s.status = ?'; params.push(status);
    }
  }
  if (job_id) { where += ' AND s.job_id = ?'; params.push(parseInt(job_id, 10) || 0); }

  const sql = `
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM sop_register s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE ${where}
    ORDER BY s.created_at DESC
  `;
  const all = db.prepare(sql).all(...params);
  const templates = view === 'active' ? all.filter(r => r.kind === 'template') : [];
  const jobLinked = view === 'active' ? all.filter(r => r.kind === 'job') : [];
  const archived = view === 'archived' ? all : [];

  // Expired / expiring counts exclude archived rows — once an SOP is archived
  // it's no longer in use, so it can't be overdue.
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'template' THEN 1 ELSE 0 END) AS templates,
      SUM(CASE WHEN kind = 'job'      THEN 1 ELSE 0 END) AS job_linked,
      SUM(CASE WHEN status = 'draft'    THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
      SUM(CASE WHEN status <> 'archived' AND expiry_date IS NOT NULL AND expiry_date < date('now')      THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN status <> 'archived' AND expiry_date IS NOT NULL AND expiry_date BETWEEN date('now') AND date('now','+30 days') THEN 1 ELSE 0 END) AS expiring_soon
    FROM sop_register
  `).get();

  res.render('sop-register/index', {
    title: 'SOP Register', currentPage: 'sop-register',
    templates, jobLinked, archived, view, counts,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    filters: { status: status || 'all', job_id: job_id || '' },
  });
});

// GET /sop-register/new — create form
router.get('/new', (req, res) => {
  const db = getDb();
  const choices = loadFormChoices(db);
  res.render('sop-register/form', {
    title: 'New SOP', currentPage: 'sop-register',
    sop: null, isEdit: false,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: req.query.job_id || '',
    prefillKind: req.query.kind === 'template' ? 'template' : 'job',
    ...choices,
  });
});

// POST /sop-register — create (with optional file)
router.post('/', sopUpload.single('sop_file'), (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return req.session.save(() => res.redirect('/sop-register/new'));
    }
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : 'job';
    // Status defaults: file uploaded → active; no file → draft. Templates
    // can also be drafts (e.g. seeded placeholder for an upcoming SOP).
    const filePath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/') : '';
    const fileName = req.file ? req.file.originalname : '';
    let status = STATUS_VALUES.includes(b.status) ? b.status : (filePath ? 'active' : 'draft');

    // Expiry: respect the admin's input if any, otherwise default to today + cycle.
    const expiryDate = (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) ? b.expiry_date : defaultExpiryFor(kind);
    // Mint a version token on every create so the very first worker ack is
    // anchored to a stable value (rather than empty string).
    const versionToken = newVersionToken();
    const versionPublishedAt = status === 'active' ? new Date().toISOString() : null;
    const r = db.prepare(`
      INSERT INTO sop_register (title, description, kind, status, job_id, owner_id, file_path, file_original_name, notes, expiry_date, created_by_id, version_token, version_published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title,
      String(b.description || '').trim(),
      kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      req.session.user ? req.session.user.id : null,
      versionToken,
      versionPublishedAt
    );
    try { logActivity({ user: req.session.user, action: 'create', entityType: 'sop_register', entityId: r.lastInsertRowid, entityLabel: title, details: kind, ip: req.ip }); } catch (e) {}
    // Fan-out to workers when an active SOP is created (typically via the
    // "Import template" + file-upload path).
    if (status === 'active') {
      notifyCrewSopUpdate({ id: r.lastInsertRowid, title });
    }
    req.flash('success', kind === 'template' ? 'SOP template imported.' : 'SOP created.');
    return req.session.save(() => res.redirect('/sop-register/' + r.lastInsertRowid));
  } catch (err) {
    console.error('[sop-register POST]', err);
    req.flash('error', 'Could not create SOP: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/sop-register/new'));
  }
});

// GET /sop-register/:id — detail. Surfaces a small ack summary so the show view
// can link straight to the acknowledgements tab without an extra query in EJS.
router.get('/:id', (req, res) => {
  const db = getDb();
  const sop = db.prepare(`
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM sop_register s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!sop) { req.flash('error', 'SOP not found.'); return req.session.save(() => res.redirect('/sop-register')); }
  const ackSummary = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) AS total_crew,
      (SELECT COUNT(DISTINCT crew_member_id) FROM sop_register_acknowledgements
        WHERE sop_id = ? AND version_token = ?) AS acked_current
  `).get(sop.id, sop.version_token || '');
  res.render('sop-register/show', {
    title: sop.title, currentPage: 'sop-register',
    sop, ackSummary,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /sop-register/:id/acknowledgements — admin view, per-worker ack status
// against the current version_token. Outstanding rows surface first.
router.get('/:id/acknowledgements', (req, res) => {
  const db = getDb();
  const sop = db.prepare(`
    SELECT s.*, j.job_number, j.client FROM sop_register s
    LEFT JOIN jobs j ON j.id = s.job_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!sop) { req.flash('error', 'SOP not found.'); return req.session.save(() => res.redirect('/sop-register')); }
  const rows = db.prepare(`
    SELECT cm.id AS crew_id, cm.full_name, cm.employee_id,
           a.signed_at, a.version_token AS acked_token, a.signed_via
    FROM crew_members cm
    LEFT JOIN sop_register_acknowledgements a
      ON a.crew_member_id = cm.id AND a.sop_id = ? AND a.version_token = ?
    WHERE cm.active = 1
    ORDER BY (a.id IS NULL) DESC, cm.full_name
  `).all(sop.id, sop.version_token || '');
  const acked = rows.filter(r => !!r.signed_at).length;
  res.render('sop-register/acknowledgements', {
    title: sop.title + ' — Acknowledgements', currentPage: 'sop-register',
    sop, rows, acked, total: rows.length,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /sop-register/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const sop = db.prepare("SELECT * FROM sop_register WHERE id = ?").get(req.params.id);
  if (!sop) { req.flash('error', 'SOP not found.'); return req.session.save(() => res.redirect('/sop-register')); }
  const choices = loadFormChoices(db);
  res.render('sop-register/form', {
    title: 'Edit SOP', currentPage: 'sop-register',
    sop, isEdit: true,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: '', prefillKind: sop.kind,
    ...choices,
  });
});

// POST /sop-register/:id — update (file optional; replaces if a new one is uploaded)
router.post('/:id', sopUpload.single('sop_file'), (req, res) => {
  try {
    const db = getDb();
    const sop = db.prepare("SELECT * FROM sop_register WHERE id = ?").get(req.params.id);
    if (!sop) { req.flash('error', 'SOP not found.'); return req.session.save(() => res.redirect('/sop-register')); }
    const b = req.body;
    const title = String(b.title || '').trim() || sop.title;
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : sop.kind;
    let filePath = sop.file_path;
    let fileName = sop.file_original_name;
    if (req.file) {
      filePath = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      fileName = req.file.originalname;
    }
    const status = STATUS_VALUES.includes(b.status) ? b.status : sop.status;
    // Expiry: editable on update. Empty string means "renew from today" — useful
    // shortcut for admins ticking through expired rows. Reset last_reminded_at
    // when expiry moves so the next reminder fires fresh.
    let expiryDate = sop.expiry_date;
    if (b.expiry_date === '') {
      expiryDate = defaultExpiryFor(kind);
    } else if (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) {
      expiryDate = b.expiry_date;
    }
    const expiryChanged = String(expiryDate || '') !== String(sop.expiry_date || '');
    // Bump version_token only on file replacement or status promotion to
    // active. Title/notes/expiry edits keep the existing token so workers
    // don't have to re-acknowledge for cosmetic changes.
    const becameActive = (status === 'active' && sop.status !== 'active');
    const fileReplaced = !!req.file;
    let versionToken = sop.version_token;
    let versionPublishedAt = sop.version_published_at;
    if (fileReplaced || becameActive) {
      versionToken = newVersionToken();
      versionPublishedAt = new Date().toISOString();
    }
    db.prepare(`
      UPDATE sop_register SET title = ?, description = ?, kind = ?, status = ?, job_id = ?, owner_id = ?,
        file_path = ?, file_original_name = ?, notes = ?, expiry_date = ?,
        version_token = ?, version_published_at = ?,
        last_reminded_at = CASE WHEN ? = 1 THEN NULL ELSE last_reminded_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, String(b.description || '').trim(), kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      versionToken, versionPublishedAt,
      expiryChanged ? 1 : 0,
      sop.id
    );
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'sop_register', entityId: sop.id, entityLabel: title, details: '', ip: req.ip }); } catch (e) {}
    if (versionToken !== sop.version_token) {
      notifyCrewSopUpdate({ id: sop.id, title });
    }
    req.flash('success', 'SOP updated.');
    return req.session.save(() => res.redirect('/sop-register/' + sop.id));
  } catch (err) {
    console.error('[sop-register PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/sop-register/' + req.params.id + '/edit'));
  }
});

// GET /sop-register/:id/file — auth-gated download (file lives outside /public)
router.get('/:id/file', (req, res) => {
  const db = getDb();
  const sop = db.prepare("SELECT file_path, file_original_name FROM sop_register WHERE id = ?").get(req.params.id);
  if (!sop || !sop.file_path) { req.flash('error', 'No file attached.'); return req.session.save(() => res.redirect('/sop-register/' + req.params.id)); }
  const abs = path.join(__dirname, '..', sop.file_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing on disk.'); return req.session.save(() => res.redirect('/sop-register/' + req.params.id)); }
  return res.download(abs, sop.file_original_name || path.basename(abs));
});

// POST /sop-register/:id/archive — flip status to archived (or back to active if already archived).
// Keeps the row on record but excludes it from the active register at a glance.
router.post('/:id/archive', (req, res) => {
  try {
    const db = getDb();
    const sop = db.prepare("SELECT * FROM sop_register WHERE id = ?").get(req.params.id);
    if (!sop) { req.flash('error', 'SOP not found.'); return req.session.save(() => res.redirect('/sop-register')); }
    const nextStatus = sop.status === 'archived' ? 'active' : 'archived';
    db.prepare("UPDATE sop_register SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextStatus, sop.id);
    try { logActivity({ user: req.session.user, action: nextStatus === 'archived' ? 'archive' : 'restore', entityType: 'sop_register', entityId: sop.id, entityLabel: sop.title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', nextStatus === 'archived' ? 'SOP archived.' : 'SOP restored.');
    const back = req.get('referer') || '/sop-register';
    return req.session.save(() => res.redirect(back));
  } catch (err) {
    console.error('[sop-register archive]', err);
    req.flash('error', 'Archive failed.');
    return req.session.save(() => res.redirect('/sop-register'));
  }
});

// POST /sop-register/:id/delete
router.post('/:id/delete', (req, res) => {
  try {
    const db = getDb();
    const sop = db.prepare("SELECT * FROM sop_register WHERE id = ?").get(req.params.id);
    if (!sop) { req.flash('error', 'SOP not found.'); return req.session.save(() => res.redirect('/sop-register')); }
    db.prepare("DELETE FROM sop_register WHERE id = ?").run(sop.id);
    try { logActivity({ user: req.session.user, action: 'delete', entityType: 'sop_register', entityId: sop.id, entityLabel: sop.title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'SOP deleted.');
    return req.session.save(() => res.redirect('/sop-register'));
  } catch (err) {
    console.error('[sop-register DELETE]', err);
    req.flash('error', 'Delete failed.');
    return req.session.save(() => res.redirect('/sop-register'));
  }
});

module.exports = router;
