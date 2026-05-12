// /w/safety — worker-side Safety module (Phase 1).
//
// Two sub-tabs in this phase:
//   - /w/safety/swms     SWMS library (view + tap-to-acknowledge per version)
//   - /w/safety/updates  Safety updates feed (view + auto mark-read)
//
// All file downloads (SWMS PDFs, update attachments) go through the
// worker-side routes here rather than re-using the admin auth-gated routes
// — never expose admin downloads to crew sessions.
'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../db/database');

const CATEGORY_LABELS = {
  general: 'General',
  alert: 'Alert',
  reminder: 'Reminder',
  toolbox: 'Toolbox',
  policy_change: 'Policy',
};

// GET /w/safety — land on SWMS first (the compliance-critical half).
router.get('/safety', (req, res) => res.redirect('/w/safety/swms'));

// GET /w/safety/swms — list active SWMS with per-row needs-ack badge.
router.get('/safety/swms', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;
  const rows = db.prepare(`
    SELECT s.id, s.title, s.description, s.kind, s.expiry_date,
           s.version_token, s.version_published_at, s.file_path,
           j.job_number, j.project_name,
           a.id AS ack_id, a.signed_at, a.version_token AS acked_token
    FROM swms s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN swms_acknowledgements a
      ON a.swms_id = s.id AND a.crew_member_id = ? AND a.version_token = s.version_token
    WHERE s.status = 'active'
    ORDER BY (a.id IS NULL) DESC, s.kind, s.title
  `).all(workerId);
  const needsAck = rows.filter(r => !r.ack_id);
  const upToDate = rows.filter(r => !!r.ack_id);
  res.render('worker/safety/swms-list', {
    title: 'SWMS — Safety', currentPage: 'safety',
    subtab: 'swms', needsAck, upToDate,
  });
});

// GET /w/safety/swms/:id — single SWMS detail. Surfaces the worker's
// most-recent ack (any version) so we can show an amber "updated since you
// last acknowledged it" banner.
router.get('/safety/swms/:id', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;
  const swms = db.prepare(`
    SELECT s.*, j.job_number, j.client FROM swms s
    LEFT JOIN jobs j ON j.id = s.job_id
    WHERE s.id = ? AND s.status = 'active'
  `).get(req.params.id);
  if (!swms) {
    req.flash('error', 'SWMS not found or not active.');
    return res.redirect('/w/safety/swms');
  }
  const currentAck = db.prepare(`
    SELECT * FROM swms_acknowledgements
    WHERE swms_id = ? AND crew_member_id = ? AND version_token = ?
  `).get(swms.id, workerId, swms.version_token || '');
  const lastAnyAck = db.prepare(`
    SELECT * FROM swms_acknowledgements
    WHERE swms_id = ? AND crew_member_id = ?
    ORDER BY signed_at DESC LIMIT 1
  `).get(swms.id, workerId);
  res.render('worker/safety/swms-detail', {
    title: swms.title, currentPage: 'safety',
    subtab: 'swms', swms, currentAck, lastAnyAck,
  });
});

// POST /w/safety/swms/:id/acknowledge — idempotent ack with version snapshot.
router.post('/safety/swms/:id/acknowledge', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const swms = db.prepare("SELECT id, version_token, title, status FROM swms WHERE id = ?").get(req.params.id);
  if (!swms || swms.status !== 'active') {
    req.flash('error', 'SWMS not available.');
    return res.redirect('/w/safety/swms');
  }
  const fullName = worker.full_name || ('Employee #' + worker.id);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO swms_acknowledgements
        (swms_id, crew_member_id, version_token, full_name, signed_via, signed_ip, user_agent)
      VALUES (?, ?, ?, ?, 'tap', ?, ?)
    `).run(
      swms.id, worker.id, swms.version_token || '', fullName,
      String(req.ip || ''),
      String((req.get('user-agent') || '')).slice(0, 250)
    );
    req.flash('success', 'Acknowledged. Thanks ' + (worker.full_name || '').split(' ')[0] + '.');
  } catch (e) {
    console.error('[w/safety] ack error', e.message);
    req.flash('error', 'Could not record acknowledgement.');
  }
  return res.redirect('/w/safety/swms/' + swms.id);
});

// GET /w/safety/swms/:id/file — auth-gated download (worker session).
router.get('/safety/swms/:id/file', (req, res) => {
  const db = getDb();
  const swms = db.prepare("SELECT file_path, file_original_name, status FROM swms WHERE id = ?").get(req.params.id);
  if (!swms || swms.status !== 'active' || !swms.file_path) {
    req.flash('error', 'File unavailable.');
    return res.redirect('/w/safety/swms/' + req.params.id);
  }
  const abs = path.join(__dirname, '..', '..', swms.file_path);
  if (!fs.existsSync(abs)) {
    req.flash('error', 'File missing on disk.');
    return res.redirect('/w/safety/swms/' + req.params.id);
  }
  return res.download(abs, swms.file_original_name || path.basename(abs));
});

// GET /w/safety/updates — feed of published bulletins with unread flag.
router.get('/safety/updates', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;
  const rows = db.prepare(`
    SELECT u.id, u.title, u.body, u.category, u.published_at, u.pinned,
           u.attachment_path, u.attachment_original_name,
           r.id AS read_id, r.read_at
    FROM safety_updates u
    LEFT JOIN safety_update_reads r
      ON r.safety_update_id = u.id AND r.crew_member_id = ?
    WHERE u.status = 'published'
      AND (u.expires_at IS NULL OR u.expires_at > datetime('now'))
    ORDER BY u.pinned DESC, u.published_at DESC
    LIMIT 100
  `).all(workerId);
  res.render('worker/safety/updates-list', {
    title: 'Safety Updates', currentPage: 'safety',
    subtab: 'updates', rows, categoryLabels: CATEGORY_LABELS,
  });
});

// GET /w/safety/updates/:id — bulletin detail. The view auto-fires the
// mark-read POST on load so the badge clears without an extra tap.
router.get('/safety/updates/:id', (req, res) => {
  const db = getDb();
  const update = db.prepare(`
    SELECT u.*, pu.full_name AS published_by_name FROM safety_updates u
    LEFT JOIN users pu ON pu.id = u.published_by_id
    WHERE u.id = ? AND u.status = 'published'
  `).get(req.params.id);
  if (!update) {
    req.flash('error', 'Safety update not found.');
    return res.redirect('/w/safety/updates');
  }
  res.render('worker/safety/update-detail', {
    title: update.title, currentPage: 'safety',
    subtab: 'updates', update, categoryLabels: CATEGORY_LABELS,
  });
});

// POST /w/safety/updates/:id/read — idempotent insert via UNIQUE constraint.
// Returns JSON because the worker view fires this as a background fetch.
router.post('/safety/updates/:id/read', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO safety_update_reads
        (safety_update_id, crew_member_id, read_via, read_ip)
      VALUES (?, ?, 'web', ?)
    `).run(parseInt(req.params.id, 10), worker.id, String(req.ip || ''));
    return res.json({ ok: true });
  } catch (e) {
    console.error('[w/safety] read error', e.message);
    return res.status(500).json({ ok: false, error: 'mark-read failed' });
  }
});

// GET /w/safety/updates/:id/file — auth-gated attachment download.
router.get('/safety/updates/:id/file', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT attachment_path, attachment_original_name, status FROM safety_updates WHERE id = ?').get(req.params.id);
  if (!row || row.status !== 'published' || !row.attachment_path) {
    req.flash('error', 'Attachment unavailable.');
    return res.redirect('/w/safety/updates/' + req.params.id);
  }
  const abs = path.join(__dirname, '..', '..', row.attachment_path);
  if (!fs.existsSync(abs)) {
    req.flash('error', 'File missing on disk.');
    return res.redirect('/w/safety/updates/' + req.params.id);
  }
  return res.download(abs, row.attachment_original_name || path.basename(abs));
});

module.exports = router;
