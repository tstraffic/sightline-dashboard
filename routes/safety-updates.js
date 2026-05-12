// /safety-updates — office CRUD for Safety Updates (bulletins workers see
// in the portal). Workers consume via /w/safety/updates.
//
// Files (optional attachments) live under data/uploads/safety-updates/,
// outside /public, served via an auth-gated download route. Matches the
// SWMS pattern.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sendPushToAllActiveCrew } = require('../services/pushNotification');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'safety-updates');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, stamp + path.extname(file.originalname));
  }
});
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB — bulletin attachments are usually small
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx?|xlsx?|jpg|jpeg|png|webp)$/i.test(file.originalname);
    cb(null, ok);
  }
});

const CATEGORY_VALUES = ['general', 'alert', 'reminder', 'toolbox', 'policy_change'];
const CATEGORY_LABELS = {
  general: 'General',
  alert: 'Incident Alert',
  reminder: 'Reminder',
  toolbox: 'Toolbox Recap',
  policy_change: 'Policy Change',
};
const STATUS_VALUES = ['draft', 'published', 'archived'];
const STATUS_LABELS = { draft: 'Draft', published: 'Published', archived: 'Archived' };

function appUrl(req) {
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Fire the fan-out push + activity log when a Safety Update transitions to published.
function announcePublished(req, update) {
  const baseUrl = appUrl(req);
  sendPushToAllActiveCrew({
    title: 'Safety: ' + update.title,
    body: CATEGORY_LABELS[update.category] + ' — tap to read.',
    url: '/w/safety/updates/' + update.id,
    type: 'safety_update',
  }).catch(e => console.error('[safety-updates] push error:', e.message));
  try {
    logActivity({
      user: req.session.user,
      action: 'publish',
      entityType: 'safety_update',
      entityId: update.id,
      entityLabel: update.title,
      details: update.category,
      ip: req.ip,
    });
  } catch (e) {}
}

// GET /safety-updates — list with status tabs
router.get('/', (req, res) => {
  const db = getDb();
  const status = STATUS_VALUES.includes(req.query.status) ? req.query.status : 'published';
  const rows = db.prepare(`
    SELECT u.*, pu.full_name AS published_by_name, cu.full_name AS created_by_name
    FROM safety_updates u
    LEFT JOIN users pu ON pu.id = u.published_by_id
    LEFT JOIN users cu ON cu.id = u.created_by_id
    WHERE u.status = ?
    ORDER BY u.pinned DESC, u.published_at DESC, u.created_at DESC
  `).all(status);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='draft'     THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status='archived'  THEN 1 ELSE 0 END) AS archived
    FROM safety_updates
  `).get();
  res.render('safety-updates/index', {
    title: 'Safety Updates', currentPage: 'safety-updates',
    rows, counts, status,
    categoryLabels: CATEGORY_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /safety-updates/new
router.get('/new', (req, res) => {
  res.render('safety-updates/form', {
    title: 'New Safety Update', currentPage: 'safety-updates',
    update: null, isEdit: false,
    categoryLabels: CATEGORY_LABELS, statusLabels: STATUS_LABELS, categoryValues: CATEGORY_VALUES,
  });
});

// POST /safety-updates — create. `action=publish` button publishes immediately.
router.post('/', upload.single('attachment'), (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return res.redirect('/safety-updates/new');
    }
    const category = CATEGORY_VALUES.includes(b.category) ? b.category : 'general';
    const attachmentPath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/') : '';
    const attachmentName = req.file ? req.file.originalname : '';
    const wantsPublish = b.action === 'publish';
    const status = wantsPublish ? 'published' : 'draft';
    const now = new Date().toISOString();
    const userId = req.session.user ? req.session.user.id : null;
    const pinned = b.pinned === 'on' || b.pinned === '1' ? 1 : 0;
    const r = db.prepare(`
      INSERT INTO safety_updates
        (title, body, category, attachment_path, attachment_original_name, audience_roles, audience_job_id,
         status, published_at, published_by_id, pinned, expires_at, created_by_id)
      VALUES (?, ?, ?, ?, ?, '', NULL, ?, ?, ?, ?, NULL, ?)
    `).run(
      title,
      String(b.body || '').trim(),
      category,
      attachmentPath, attachmentName,
      status,
      wantsPublish ? now : null,
      wantsPublish ? userId : null,
      pinned,
      userId
    );
    const updateRow = { id: r.lastInsertRowid, title, category };
    try {
      logActivity({
        user: req.session.user, action: 'create', entityType: 'safety_update',
        entityId: r.lastInsertRowid, entityLabel: title, details: status, ip: req.ip,
      });
    } catch (e) {}
    if (wantsPublish) announcePublished(req, updateRow);
    req.flash('success', wantsPublish ? 'Safety update published.' : 'Draft saved.');
    return res.redirect('/safety-updates/' + r.lastInsertRowid);
  } catch (err) {
    console.error('[safety-updates POST]', err);
    req.flash('error', 'Could not create update: ' + (err && err.message || 'unknown'));
    return res.redirect('/safety-updates/new');
  }
});

// GET /safety-updates/:id — show + read stats
router.get('/:id', (req, res) => {
  const db = getDb();
  const update = db.prepare(`
    SELECT u.*, pu.full_name AS published_by_name, cu.full_name AS created_by_name
    FROM safety_updates u
    LEFT JOIN users pu ON pu.id = u.published_by_id
    LEFT JOIN users cu ON cu.id = u.created_by_id
    WHERE u.id = ?
  `).get(req.params.id);
  if (!update) { req.flash('error', 'Safety update not found.'); return res.redirect('/safety-updates'); }
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) AS total_crew,
      (SELECT COUNT(*) FROM safety_update_reads WHERE safety_update_id = ?) AS read_count
  `).get(update.id);
  const readers = db.prepare(`
    SELECT cm.full_name, cm.employee_id, r.read_at
    FROM safety_update_reads r
    JOIN crew_members cm ON cm.id = r.crew_member_id
    WHERE r.safety_update_id = ?
    ORDER BY r.read_at DESC
    LIMIT 200
  `).all(update.id);
  res.render('safety-updates/show', {
    title: update.title, currentPage: 'safety-updates',
    update, stats, readers,
    categoryLabels: CATEGORY_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /safety-updates/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const update = db.prepare('SELECT * FROM safety_updates WHERE id = ?').get(req.params.id);
  if (!update) { req.flash('error', 'Safety update not found.'); return res.redirect('/safety-updates'); }
  res.render('safety-updates/form', {
    title: 'Edit Safety Update', currentPage: 'safety-updates',
    update, isEdit: true,
    categoryLabels: CATEGORY_LABELS, statusLabels: STATUS_LABELS, categoryValues: CATEGORY_VALUES,
  });
});

// POST /safety-updates/:id — update body/title/category/attachment. Doesn't
// re-fire push on its own — use /publish for that transition.
router.post('/:id', upload.single('attachment'), (req, res) => {
  try {
    const db = getDb();
    const update = db.prepare('SELECT * FROM safety_updates WHERE id = ?').get(req.params.id);
    if (!update) { req.flash('error', 'Not found.'); return res.redirect('/safety-updates'); }
    const b = req.body;
    const title = String(b.title || '').trim() || update.title;
    const category = CATEGORY_VALUES.includes(b.category) ? b.category : update.category;
    const pinned = b.pinned === 'on' || b.pinned === '1' ? 1 : 0;
    let attachmentPath = update.attachment_path;
    let attachmentName = update.attachment_original_name;
    if (req.file) {
      attachmentPath = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      attachmentName = req.file.originalname;
    }
    db.prepare(`
      UPDATE safety_updates
      SET title = ?, body = ?, category = ?, pinned = ?,
          attachment_path = ?, attachment_original_name = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(title, String(b.body || '').trim(), category, pinned, attachmentPath, attachmentName, update.id);
    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'safety_update',
        entityId: update.id, entityLabel: title, ip: req.ip,
      });
    } catch (e) {}
    req.flash('success', 'Safety update saved.');
    return res.redirect('/safety-updates/' + update.id);
  } catch (err) {
    console.error('[safety-updates PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown'));
    return res.redirect('/safety-updates/' + req.params.id + '/edit');
  }
});

// POST /safety-updates/:id/publish — transition draft -> published + push.
// Idempotent: re-publishing an already-published row doesn't re-fire push.
router.post('/:id/publish', (req, res) => {
  const db = getDb();
  const update = db.prepare('SELECT * FROM safety_updates WHERE id = ?').get(req.params.id);
  if (!update) { req.flash('error', 'Not found.'); return res.redirect('/safety-updates'); }
  if (update.status === 'published') {
    req.flash('error', 'Already published.');
    return res.redirect('/safety-updates/' + update.id);
  }
  const userId = req.session.user ? req.session.user.id : null;
  db.prepare(`
    UPDATE safety_updates
    SET status = 'published', published_at = CURRENT_TIMESTAMP, published_by_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId, update.id);
  announcePublished(req, update);
  req.flash('success', 'Safety update published.');
  return res.redirect('/safety-updates/' + update.id);
});

// POST /safety-updates/:id/archive — soft archive (off the worker feed).
router.post('/:id/archive', (req, res) => {
  const db = getDb();
  const update = db.prepare('SELECT * FROM safety_updates WHERE id = ?').get(req.params.id);
  if (!update) return res.redirect('/safety-updates');
  db.prepare("UPDATE safety_updates SET status='archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(update.id);
  try { logActivity({ user: req.session.user, action: 'archive', entityType: 'safety_update', entityId: update.id, entityLabel: update.title, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Safety update archived.');
  return res.redirect('/safety-updates');
});

// POST /safety-updates/:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const update = db.prepare('SELECT * FROM safety_updates WHERE id = ?').get(req.params.id);
  if (!update) return res.redirect('/safety-updates');
  db.prepare('DELETE FROM safety_updates WHERE id = ?').run(update.id);
  try { logActivity({ user: req.session.user, action: 'delete', entityType: 'safety_update', entityId: update.id, entityLabel: update.title, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Safety update deleted.');
  return res.redirect('/safety-updates');
});

// GET /safety-updates/:id/file — admin download
router.get('/:id/file', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT attachment_path, attachment_original_name FROM safety_updates WHERE id = ?').get(req.params.id);
  if (!row || !row.attachment_path) { req.flash('error', 'No file attached.'); return res.redirect('/safety-updates/' + req.params.id); }
  const abs = path.join(__dirname, '..', row.attachment_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing on disk.'); return res.redirect('/safety-updates/' + req.params.id); }
  return res.download(abs, row.attachment_original_name || path.basename(abs));
});

module.exports = router;
