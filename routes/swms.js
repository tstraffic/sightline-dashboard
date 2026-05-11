// /swms — SWMS register (templates + job-linked docs).
//
// Two ways a row gets created:
//   - "Import template" → upload a reusable SWMS file (kind = 'template').
//   - "Assign new SWMS" → placeholder linked to a job + assignee, no
//     file yet (kind = 'job', status = 'draft'). Owner uploads later.
//
// Files live under data/uploads/swms/ — outside /public so we can serve
// them through an auth-checked download route.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

const SWMS_DIR = path.join(__dirname, '..', 'data', 'uploads', 'swms');
if (!fs.existsSync(SWMS_DIR)) fs.mkdirSync(SWMS_DIR, { recursive: true });

const swmsStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SWMS_DIR),
  filename: (req, file, cb) => {
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, stamp + path.extname(file.originalname));
  }
});
const swmsUpload = multer({
  storage: swmsStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — SWMS PDFs can be hefty
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx?|xlsx?|jpg|jpeg|png)$/i.test(file.originalname);
    cb(null, ok);
  }
});

const KIND_LABELS = { template: 'Template', job: 'Job-linked' };
const STATUS_LABELS = { draft: 'Draft', active: 'Active', archived: 'Archived' };
const STATUS_VALUES = ['draft', 'active', 'archived'];
const KIND_VALUES = ['template', 'job'];
// Renewal cadence from the safety policy: job-linked SWMS renew every
// 6 months, templates update every 3 months. Used to auto-default the
// expiry_date when the admin doesn't enter one.
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

// GET /swms — register list (split into Templates + Job-linked sections by default)
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id } = req.query;
  // The register no longer filters by kind from query — both sections always
  // render together so "templates vs job-linked" is visually obvious. The
  // status / job_id filters still apply to both.
  let where = '1=1';
  const params = [];
  if (status && STATUS_VALUES.includes(status)) { where += ' AND s.status = ?'; params.push(status); }
  if (job_id) { where += ' AND s.job_id = ?'; params.push(parseInt(job_id, 10) || 0); }

  const sql = `
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM swms s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE ${where}
    ORDER BY s.created_at DESC
  `;
  const all = db.prepare(sql).all(...params);
  const templates = all.filter(r => r.kind === 'template');
  const jobLinked = all.filter(r => r.kind === 'job');

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'template' THEN 1 ELSE 0 END) AS templates,
      SUM(CASE WHEN kind = 'job'      THEN 1 ELSE 0 END) AS job_linked,
      SUM(CASE WHEN status = 'draft'  THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < date('now')      THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date BETWEEN date('now') AND date('now','+30 days') THEN 1 ELSE 0 END) AS expiring_soon
    FROM swms
  `).get();

  res.render('swms/index', {
    title: 'SWMS Register', currentPage: 'swms',
    templates, jobLinked, counts,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    filters: { status: status || 'all', job_id: job_id || '' },
  });
});

// GET /swms/new — create form
router.get('/new', (req, res) => {
  const db = getDb();
  const choices = loadFormChoices(db);
  res.render('swms/form', {
    title: 'New SWMS', currentPage: 'swms',
    swms: null, isEdit: false,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: req.query.job_id || '',
    prefillKind: req.query.kind === 'template' ? 'template' : 'job',
    ...choices,
  });
});

// POST /swms — create (with optional file)
router.post('/', swmsUpload.single('swms_file'), (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return res.redirect('/swms/new');
    }
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : 'job';
    // Status defaults: file uploaded → active; no file → draft. Templates
    // can also be drafts (e.g. seeded placeholder for an upcoming SWMS).
    const filePath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/') : '';
    const fileName = req.file ? req.file.originalname : '';
    let status = STATUS_VALUES.includes(b.status) ? b.status : (filePath ? 'active' : 'draft');

    // Expiry: respect the admin's input if any, otherwise default to today + cycle.
    const expiryDate = (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) ? b.expiry_date : defaultExpiryFor(kind);
    const r = db.prepare(`
      INSERT INTO swms (title, description, kind, status, job_id, owner_id, file_path, file_original_name, notes, expiry_date, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title,
      String(b.description || '').trim(),
      kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      req.session.user ? req.session.user.id : null
    );
    try { logActivity({ user: req.session.user, action: 'create', entityType: 'swms', entityId: r.lastInsertRowid, entityLabel: title, details: kind, ip: req.ip }); } catch (e) {}
    req.flash('success', kind === 'template' ? 'SWMS template imported.' : 'SWMS created.');
    return res.redirect('/swms/' + r.lastInsertRowid);
  } catch (err) {
    console.error('[swms POST]', err);
    req.flash('error', 'Could not create SWMS: ' + (err && err.message || 'unknown error'));
    return res.redirect('/swms/new');
  }
});

// GET /swms/:id — detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const swms = db.prepare(`
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM swms s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!swms) { req.flash('error', 'SWMS not found.'); return res.redirect('/swms'); }
  res.render('swms/show', {
    title: swms.title, currentPage: 'swms',
    swms,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /swms/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const swms = db.prepare("SELECT * FROM swms WHERE id = ?").get(req.params.id);
  if (!swms) { req.flash('error', 'SWMS not found.'); return res.redirect('/swms'); }
  const choices = loadFormChoices(db);
  res.render('swms/form', {
    title: 'Edit SWMS', currentPage: 'swms',
    swms, isEdit: true,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: '', prefillKind: swms.kind,
    ...choices,
  });
});

// POST /swms/:id — update (file optional; replaces if a new one is uploaded)
router.post('/:id', swmsUpload.single('swms_file'), (req, res) => {
  try {
    const db = getDb();
    const swms = db.prepare("SELECT * FROM swms WHERE id = ?").get(req.params.id);
    if (!swms) { req.flash('error', 'SWMS not found.'); return res.redirect('/swms'); }
    const b = req.body;
    const title = String(b.title || '').trim() || swms.title;
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : swms.kind;
    let filePath = swms.file_path;
    let fileName = swms.file_original_name;
    if (req.file) {
      filePath = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      fileName = req.file.originalname;
    }
    const status = STATUS_VALUES.includes(b.status) ? b.status : swms.status;
    // Expiry: editable on update. Empty string means "renew from today" — useful
    // shortcut for admins ticking through expired rows. Reset last_reminded_at
    // when expiry moves so the next reminder fires fresh.
    let expiryDate = swms.expiry_date;
    if (b.expiry_date === '') {
      expiryDate = defaultExpiryFor(kind);
    } else if (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) {
      expiryDate = b.expiry_date;
    }
    const expiryChanged = String(expiryDate || '') !== String(swms.expiry_date || '');
    db.prepare(`
      UPDATE swms SET title = ?, description = ?, kind = ?, status = ?, job_id = ?, owner_id = ?,
        file_path = ?, file_original_name = ?, notes = ?, expiry_date = ?,
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
      expiryChanged ? 1 : 0,
      swms.id
    );
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'swms', entityId: swms.id, entityLabel: title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'SWMS updated.');
    return res.redirect('/swms/' + swms.id);
  } catch (err) {
    console.error('[swms PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/swms/' + req.params.id + '/edit');
  }
});

// GET /swms/:id/file — auth-gated download (file lives outside /public)
router.get('/:id/file', (req, res) => {
  const db = getDb();
  const swms = db.prepare("SELECT file_path, file_original_name FROM swms WHERE id = ?").get(req.params.id);
  if (!swms || !swms.file_path) { req.flash('error', 'No file attached.'); return res.redirect('/swms/' + req.params.id); }
  const abs = path.join(__dirname, '..', swms.file_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing on disk.'); return res.redirect('/swms/' + req.params.id); }
  return res.download(abs, swms.file_original_name || path.basename(abs));
});

// POST /swms/:id/archive — flip status to archived (or back to active if already archived).
// Keeps the row on record but excludes it from the active register at a glance.
router.post('/:id/archive', (req, res) => {
  try {
    const db = getDb();
    const swms = db.prepare("SELECT * FROM swms WHERE id = ?").get(req.params.id);
    if (!swms) { req.flash('error', 'SWMS not found.'); return res.redirect('/swms'); }
    const nextStatus = swms.status === 'archived' ? 'active' : 'archived';
    db.prepare("UPDATE swms SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(nextStatus, swms.id);
    try { logActivity({ user: req.session.user, action: nextStatus === 'archived' ? 'archive' : 'restore', entityType: 'swms', entityId: swms.id, entityLabel: swms.title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', nextStatus === 'archived' ? 'SWMS archived.' : 'SWMS restored.');
    const back = req.get('referer') || '/swms';
    return res.redirect(back);
  } catch (err) {
    console.error('[swms archive]', err);
    req.flash('error', 'Archive failed.');
    return res.redirect('/swms');
  }
});

// POST /swms/:id/delete
router.post('/:id/delete', (req, res) => {
  try {
    const db = getDb();
    const swms = db.prepare("SELECT * FROM swms WHERE id = ?").get(req.params.id);
    if (!swms) { req.flash('error', 'SWMS not found.'); return res.redirect('/swms'); }
    db.prepare("DELETE FROM swms WHERE id = ?").run(swms.id);
    try { logActivity({ user: req.session.user, action: 'delete', entityType: 'swms', entityId: swms.id, entityLabel: swms.title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'SWMS deleted.');
    return res.redirect('/swms');
  } catch (err) {
    console.error('[swms DELETE]', err);
    req.flash('error', 'Delete failed.');
    return res.redirect('/swms');
  }
});

module.exports = router;
