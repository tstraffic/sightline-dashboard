// /w/safety — worker-side Safety module.
//
// Sub-tabs:
//   - /w/safety/swms       SWMS library (view + tap-to-acknowledge per version)
//   - /w/safety/updates    Safety updates feed (view + auto mark-read)
//   - /w/safety/toolboxes  Toolbox talks archive (view + mark caught up)
//   - /w/safety/comments   Submit hazard flags / suggestions / etc. + view own
//
// All file downloads (SWMS PDFs, update attachments, toolbox slides, comment
// photos) go through worker-side routes here rather than re-using the admin
// auth-gated routes — never expose admin downloads to crew sessions.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../db/database');
const { sendPushToUser } = require('../../services/pushNotification');
const { submitterToken } = require('../../lib/anonymousToken');

const CATEGORY_LABELS = {
  general: 'General',
  alert: 'Alert',
  reminder: 'Reminder',
  toolbox: 'Toolbox',
  policy_change: 'Policy',
};

const COMMENT_CATEGORY_VALUES = ['hazard', 'swms_issue', 'suggestion', 'equipment', 'general'];
const COMMENT_CATEGORY_LABELS = {
  hazard: 'Hazard',
  swms_issue: 'SWMS issue',
  suggestion: 'Suggestion',
  equipment: 'Equipment',
  general: 'General',
};
const COMMENT_STATUS_LABELS = {
  submitted: 'Submitted',
  acknowledged: 'Acknowledged',
  under_review: 'Under review',
  closed: 'Closed',
};

// Comment photo uploads — stored alongside other safety attachments,
// outside /public so the worker auth check controls access.
const COMMENT_UPLOAD_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'safety-comments');
if (!fs.existsSync(COMMENT_UPLOAD_DIR)) fs.mkdirSync(COMMENT_UPLOAD_DIR, { recursive: true });
const commentStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, COMMENT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, stamp + path.extname(file.originalname));
  }
});
const commentUpload = multer({
  storage: commentStorage,
  // 10MB per file × max 5 photos per the spec.
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpg|jpeg|png|webp|heic)$/i.test(file.originalname);
    cb(null, ok);
  }
}).array('photos', 5);

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

// =============================================
// Toolbox Talks
// =============================================

// GET /w/safety/toolboxes — archive of published toolboxes. Each row shows
// the worker's own attendance status (Attended / Caught up / Missed).
router.get('/safety/toolboxes', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;
  const rows = db.prepare(`
    SELECT t.id, t.title, t.held_at, t.presenter, t.key_points,
           a.status AS my_status, a.recorded_at AS my_recorded_at
    FROM toolbox_talks t
    LEFT JOIN toolbox_attendance a ON a.toolbox_id = t.id AND a.crew_member_id = ?
    WHERE t.status = 'published'
    ORDER BY t.held_at DESC, t.created_at DESC
    LIMIT 200
  `).all(workerId);
  res.render('worker/safety/toolboxes-list', {
    title: 'Toolbox Talks', currentPage: 'safety',
    subtab: 'toolboxes', rows,
  });
});

// GET /w/safety/toolboxes/:id — toolbox detail + worker attendance status.
router.get('/safety/toolboxes/:id', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;
  const toolbox = db.prepare(`
    SELECT * FROM toolbox_talks WHERE id = ? AND status = 'published'
  `).get(req.params.id);
  if (!toolbox) {
    req.flash('error', 'Toolbox not found.');
    return res.redirect('/w/safety/toolboxes');
  }
  const myAttendance = db.prepare(`
    SELECT * FROM toolbox_attendance WHERE toolbox_id = ? AND crew_member_id = ?
  `).get(toolbox.id, workerId);
  const photos = db.prepare(`SELECT id FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'photo' ORDER BY id ASC`).all(toolbox.id);
  res.render('worker/safety/toolbox-detail', {
    title: toolbox.title, currentPage: 'safety',
    subtab: 'toolboxes', toolbox, myAttendance, photos,
  });
});

// POST /w/safety/toolboxes/:id/caught-up — worker self-claim. Idempotent via
// UNIQUE(toolbox_id, crew_member_id); won't overwrite an existing 'attended'
// record since INSERT OR IGNORE matches on the unique constraint.
router.post('/safety/toolboxes/:id/caught-up', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const toolbox = db.prepare("SELECT id, title, status FROM toolbox_talks WHERE id = ?").get(req.params.id);
  if (!toolbox || toolbox.status !== 'published') {
    req.flash('error', 'Toolbox not available.');
    return res.redirect('/w/safety/toolboxes');
  }
  try {
    db.prepare(`
      INSERT OR IGNORE INTO toolbox_attendance
        (toolbox_id, crew_member_id, status, recorded_by_id)
      VALUES (?, ?, 'caught_up', NULL)
    `).run(toolbox.id, worker.id);
    req.flash('success', 'Marked as caught up. Thanks for reviewing.');
  } catch (e) {
    console.error('[w/safety] toolbox caught-up error', e.message);
    req.flash('error', 'Could not record.');
  }
  return res.redirect('/w/safety/toolboxes/' + toolbox.id);
});

// GET /w/safety/toolboxes/:id/slides — worker-auth slides download.
router.get('/safety/toolboxes/:id/slides', (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT slides_path, slides_original_name, status FROM toolbox_talks WHERE id = ?").get(req.params.id);
  if (!row || row.status !== 'published' || !row.slides_path) {
    req.flash('error', 'Slides unavailable.');
    return res.redirect('/w/safety/toolboxes/' + req.params.id);
  }
  const abs = path.join(__dirname, '..', '..', row.slides_path);
  if (!fs.existsSync(abs)) {
    req.flash('error', 'File missing on disk.');
    return res.redirect('/w/safety/toolboxes/' + req.params.id);
  }
  return res.download(abs, row.slides_original_name || path.basename(abs));
});

// GET /w/safety/toolboxes/:id/photos/:photoId — inline serve for the gallery.
// Sign-on sheets are intentionally NOT exposed to workers.
router.get('/safety/toolboxes/:id/photos/:photoId', (req, res) => {
  const db = getDb();
  const ph = db.prepare(`
    SELECT a.file_path FROM toolbox_attachments a
    JOIN toolbox_talks t ON t.id = a.toolbox_id
    WHERE a.id = ? AND a.toolbox_id = ? AND a.kind = 'photo' AND t.status = 'published'
  `).get(req.params.photoId, req.params.id);
  if (!ph || !ph.file_path) return res.status(404).send('not found');
  const abs = path.join(__dirname, '..', '..', ph.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('missing');
  return res.sendFile(abs);
});

// =============================================
// Comments / Flags (worker -> office)
// =============================================

// GET /w/safety/comments — list this worker's own submissions, queried by
// submitter_token so anonymous rows still show up (crew_member_id is NULL
// for those).
router.get('/safety/comments', (req, res) => {
  const db = getDb();
  const token = submitterToken(req.session.worker.id);
  const rows = db.prepare(`
    SELECT c.id, c.category, c.body, c.status, c.is_anonymous,
           c.office_response, c.response_at, c.created_at,
           j.job_number
    FROM safety_comments c
    LEFT JOIN jobs j ON j.id = c.job_id
    WHERE c.submitter_token = ?
    ORDER BY c.created_at DESC
    LIMIT 100
  `).all(token);
  res.render('worker/safety/comments-list', {
    title: 'My safety comments', currentPage: 'safety',
    subtab: 'comments', rows,
    categoryLabels: COMMENT_CATEGORY_LABELS, statusLabels: COMMENT_STATUS_LABELS,
  });
});

// GET /w/safety/comments/new — submit form
router.get('/safety/comments/new', (req, res) => {
  const db = getDb();
  // Worker can optionally tie a comment to one of their current jobs.
  let jobs = [];
  try {
    jobs = db.prepare(`
      SELECT DISTINCT j.id, j.job_number, j.client
      FROM crew_allocations ca
      JOIN jobs j ON j.id = ca.job_id
      WHERE ca.crew_member_id = ?
        AND ca.allocation_date >= date('now', '-14 days')
        AND ca.allocation_date <= date('now', '+14 days')
        AND ca.status != 'cancelled'
      ORDER BY j.job_number DESC
    `).all(req.session.worker.id);
  } catch (e) {}
  res.render('worker/safety/comment-new', {
    title: 'New safety comment', currentPage: 'safety',
    subtab: 'comments', jobs,
    categoryValues: COMMENT_CATEGORY_VALUES,
    categoryLabels: COMMENT_CATEGORY_LABELS,
  });
});

// POST /w/safety/comments — submit. Anonymous toggle is off by default;
// when ticked we drop crew_member_id and rely on the deterministic token
// for the worker's own list + push routing.
router.post('/safety/comments', (req, res) => {
  commentUpload(req, res, (multerErr) => {
    if (multerErr) {
      req.flash('error', multerErr.message || 'Upload failed.');
      return res.redirect('/w/safety/comments/new');
    }
    const db = getDb();
    const worker = req.session.worker;
    const b = req.body;
    const body = String(b.body || '').trim();
    if (!body) {
      req.flash('error', 'Please write something before submitting.');
      return res.redirect('/w/safety/comments/new');
    }
    const category = COMMENT_CATEGORY_VALUES.includes(b.category) ? b.category : 'general';
    const jobId = b.job_id ? (parseInt(b.job_id, 10) || null) : null;
    const isAnonymous = (b.anonymous === '1' || b.anonymous === 'on') ? 1 : 0;
    const token = submitterToken(worker.id);

    try {
      const r = db.prepare(`
        INSERT INTO safety_comments
          (crew_member_id, submitter_token, is_anonymous, category, body, job_id,
           submitted_ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        isAnonymous ? null : worker.id,
        token,
        isAnonymous,
        category,
        body,
        jobId,
        String(req.ip || ''),
        String((req.get('user-agent') || '')).slice(0, 250)
      );
      const newId = r.lastInsertRowid;

      const files = req.files || [];
      if (files.length) {
        const ins = db.prepare(`
          INSERT INTO safety_comment_attachments (comment_id, file_path, file_original_name)
          VALUES (?, ?, ?)
        `);
        for (const f of files) {
          const rel = path.relative(path.join(__dirname, '..', '..'), f.path).replace(/\\/g, '/');
          ins.run(newId, rel, f.originalname);
        }
      }

      // Notify the safety team. Fire-and-forget per user. Office UI never
      // gets to see crew_member_id for anonymous rows; the push title is
      // identical for both cases for the same reason.
      try {
        const adminUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(role) IN ('admin','safety')").all();
        const pushPayload = {
          title: 'New safety comment',
          body: COMMENT_CATEGORY_LABELS[category] + (isAnonymous ? ' (anonymous)' : '') + ' — tap to review.',
          url: '/safety-comments/' + newId,
          type: 'safety_comment_submitted',
        };
        for (const u of adminUsers) {
          sendPushToUser(u.id, pushPayload).catch(e => console.error('[w/safety] notify admin push error:', e.message));
        }
      } catch (e) { console.error('[w/safety] notify admins error:', e.message); }

      req.flash('success', 'Submitted. The safety team will review and respond.');
      return res.redirect('/w/safety/comments/' + newId);
    } catch (err) {
      console.error('[w/safety] comment submit error:', err.message);
      req.flash('error', 'Could not submit comment.');
      return res.redirect('/w/safety/comments/new');
    }
  });
});

// GET /w/safety/comments/:id — own comment detail. Looked up by id AND
// submitter_token so workers can only see their own (incl. their anon ones).
router.get('/safety/comments/:id', (req, res) => {
  const db = getDb();
  const token = submitterToken(req.session.worker.id);
  const comment = db.prepare(`
    SELECT c.*, j.job_number, ru.full_name AS response_by_name
    FROM safety_comments c
    LEFT JOIN jobs j ON j.id = c.job_id
    LEFT JOIN users ru ON ru.id = c.response_by_id
    WHERE c.id = ? AND c.submitter_token = ?
  `).get(req.params.id, token);
  if (!comment) {
    req.flash('error', 'Comment not found.');
    return res.redirect('/w/safety/comments');
  }
  // internal_notes is office-only — strip it before render so a stray template
  // expression can't leak it. The view doesn't reference it either, but
  // defense-in-depth.
  delete comment.internal_notes;
  const photos = db.prepare('SELECT id FROM safety_comment_attachments WHERE comment_id = ? ORDER BY id ASC').all(comment.id);
  res.render('worker/safety/comment-detail', {
    title: 'Comment #' + comment.id, currentPage: 'safety',
    subtab: 'comments', comment, photos,
    categoryLabels: COMMENT_CATEGORY_LABELS, statusLabels: COMMENT_STATUS_LABELS,
  });
});

// GET /w/safety/comments/:id/photos/:photoId — worker-auth photo serve.
// Restricted by submitter_token so workers can't enumerate other people's
// photos by guessing IDs.
router.get('/safety/comments/:id/photos/:photoId', (req, res) => {
  const db = getDb();
  const token = submitterToken(req.session.worker.id);
  const row = db.prepare(`
    SELECT a.file_path FROM safety_comment_attachments a
    JOIN safety_comments c ON c.id = a.comment_id
    WHERE a.id = ? AND a.comment_id = ? AND c.submitter_token = ?
  `).get(req.params.photoId, req.params.id, token);
  if (!row || !row.file_path) return res.status(404).send('not found');
  const abs = path.join(__dirname, '..', '..', row.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('missing');
  return res.sendFile(abs);
});

module.exports = router;
