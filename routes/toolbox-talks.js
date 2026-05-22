// /toolbox-talks — office CRUD for Toolbox Talks.
//
// Workers consume via /w/safety/toolboxes. Files (slides, sign-on sheets,
// photo gallery) live under data/uploads/toolbox/ outside /public, served
// through auth-gated download routes here + on the worker side.
'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sendPushToAllActiveCrew } = require('../services/pushNotification');

// Lazy-creates the public attendance session for a toolbox. Idempotent
// for repeat publishes / detail-page renders. Returns the row.
function getOrCreateAttendanceSession(toolboxId, userId) {
  const db = getDb();
  let row = db.prepare('SELECT * FROM toolbox_attendance_sessions WHERE toolbox_id = ? ORDER BY id DESC LIMIT 1')
    .get(toolboxId);
  if (row && !row.closed_at) return row;
  const token = crypto.randomBytes(18).toString('base64url');
  const r = db.prepare(`
    INSERT INTO toolbox_attendance_sessions (token, toolbox_id, created_by_id)
    VALUES (?, ?, ?)
  `).run(token, toolboxId, userId || null);
  return db.prepare('SELECT * FROM toolbox_attendance_sessions WHERE id = ?').get(r.lastInsertRowid);
}

// Active crew_members for worker pickers, excluding only those whose
// ONLY HR profiles are soft-deleted. A worker with a deleted HR row +
// a current active HR row stays in the list (some workers got deleted
// and re-added — Suhail Ahmed is one of them — and the picker was
// hiding them by mistake).
function selectableCrewMembers() {
  return getDb().prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id
    FROM crew_members cm
    WHERE cm.active = 1
      AND (
        NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
        OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
      )
    ORDER BY cm.full_name
  `).all();
}

// Replace the invitee list for a toolbox. crewIds is an array of
// numeric crew_member.id; pass an empty array to clear (= open to
// everyone again).
function setToolboxInvitees(toolboxId, crewIds) {
  const db = getDb();
  const ids = (Array.isArray(crewIds) ? crewIds : []).map(n => parseInt(n, 10)).filter(n => n > 0);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM toolbox_invitees WHERE toolbox_id = ?').run(toolboxId);
    if (!ids.length) return;
    const ins = db.prepare('INSERT OR IGNORE INTO toolbox_invitees (toolbox_id, crew_member_id) VALUES (?, ?)');
    for (const id of ids) ins.run(toolboxId, id);
  });
  tx();
}
function getToolboxInviteeIds(toolboxId) {
  return getDb().prepare('SELECT crew_member_id FROM toolbox_invitees WHERE toolbox_id = ?')
    .all(toolboxId).map(r => r.crew_member_id);
}

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'toolbox');
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
  // 15MB per file — toolbox decks and sign-on scans can be chunky.
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // The HTML <input accept="..."> on prep / documents allows Office +
    // text files in addition to PDFs and images. The regex needs to
    // match. Office files were silently dropped before, leaving admins
    // unable to save when they uploaded an .xlsx or .pptx.
    const ok = /\.(pdf|docx?|xlsx?|pptx?|txt|jpg|jpeg|png|webp|heic|gif|bmp|tiff?)$/i.test(file.originalname);
    cb(null, ok);
  }
});
// Accept the create/edit form's file fields in one go.
//   documents      — post-attendance materials, gated on sign-off
//                    (kind='doc' rows).
//   prep_documents — pre-meeting materials workers should read before
//                    attending. Visible to every invited worker
//                    regardless of attendance state (kind='prep' rows).
const formUploads = upload.fields([
  // slides + signon are legacy fields, kept on existing rows but no
  // longer surfaced in the create/edit form. Multer still accepts the
  // fields so any direct API caller doesn't break.
  { name: 'slides', maxCount: 1 },
  { name: 'signon', maxCount: 1 },
  { name: 'photos', maxCount: 12 },
  { name: 'documents', maxCount: 12 },
  { name: 'prep_documents', maxCount: 12 },
]);

const STATUS_VALUES = ['draft', 'published', 'archived'];
const STATUS_LABELS = { draft: 'Draft', published: 'Published', archived: 'Archived' };

function rel(p) {
  return p.replace(/\\/g, '/');
}
function relFromRepo(absPath) {
  return rel(path.relative(path.join(__dirname, '..'), absPath));
}

function announcePublished(req, toolbox) {
  sendPushToAllActiveCrew({
    title: 'Toolbox: ' + toolbox.title,
    body: 'New toolbox talk posted — tap to review.',
    url: '/w/safety/toolboxes/' + toolbox.id,
    type: 'toolbox_talk',
    category: 'toolbox',
  }).catch(e => console.error('[toolbox-talks] push error:', e.message));
  try {
    logActivity({
      user: req.session.user,
      action: 'publish',
      entityType: 'toolbox_talk',
      entityId: toolbox.id,
      entityLabel: toolbox.title,
      ip: req.ip,
    });
  } catch (e) {}
}

// GET /toolbox-talks — list with status tabs + counts
router.get('/', (req, res) => {
  const db = getDb();
  const status = STATUS_VALUES.includes(req.query.status) ? req.query.status : 'published';
  const rows = db.prepare(`
    SELECT t.*, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM toolbox_attendance a WHERE a.toolbox_id = t.id AND a.status = 'attended') AS attended_count,
      (SELECT COUNT(*) FROM toolbox_attendance a WHERE a.toolbox_id = t.id AND a.status = 'caught_up') AS caught_count,
      /* Invited count: when the toolbox is scoped, this is the size of
         the invitee list. Falls back to all active workers when open. */
      (SELECT COUNT(*) FROM toolbox_invitees i WHERE i.toolbox_id = t.id) AS invitee_count
    FROM toolbox_talks t
    LEFT JOIN users u ON u.id = t.created_by_id
    WHERE t.status = ?
    ORDER BY t.held_at DESC, t.created_at DESC
  `).all(status);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='draft'     THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status='archived'  THEN 1 ELSE 0 END) AS archived
    FROM toolbox_talks
  `).get();
  res.render('toolbox-talks/index', {
    title: 'Toolbox Talks', currentPage: 'toolbox-talks',
    rows, counts, status, statusLabels: STATUS_LABELS,
  });
});

// GET /toolbox-talks/new — create form
router.get('/new', (req, res) => {
  res.render('toolbox-talks/form', {
    title: 'New Toolbox Talk', currentPage: 'toolbox-talks',
    toolbox: null, photos: [], documents: [], prepDocuments: [], isEdit: false,
    selectableCrew: selectableCrewMembers(),
    inviteeIds: [],
  });
});

// POST /toolbox-talks — create. Accepts slides + sign-on + multi-photo upload.
router.post('/', formUploads, (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return res.redirect('/toolbox-talks/new');
    }
    const heldAt = (b.held_at && /^\d{4}-\d{2}-\d{2}$/.test(b.held_at)) ? b.held_at : new Date().toISOString().slice(0, 10);
    const wantsPublish = b.action === 'publish';
    const status = wantsPublish ? 'published' : 'draft';
    const userId = req.session.user ? req.session.user.id : null;
    const now = new Date().toISOString();

    const slidesFile = req.files && req.files.slides && req.files.slides[0];
    const signonFile = req.files && req.files.signon && req.files.signon[0];
    const slidesPath = slidesFile ? relFromRepo(slidesFile.path) : '';
    const slidesName = slidesFile ? slidesFile.originalname : '';
    const signonPath = signonFile ? relFromRepo(signonFile.path) : '';
    const signonName = signonFile ? signonFile.originalname : '';

    const r = db.prepare(`
      INSERT INTO toolbox_talks
        (title, held_at, presenter, key_points,
         slides_path, slides_original_name, signon_path, signon_original_name,
         status, published_at, published_by_id, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title, heldAt,
      String(b.presenter || '').trim(),
      String(b.key_points || '').trim(),
      slidesPath, slidesName, signonPath, signonName,
      status,
      wantsPublish ? now : null,
      wantsPublish ? userId : null,
      userId
    );

    // Invitees — empty array means "open to everyone".
    const inviteeIds = Array.isArray(b.invitee_ids) ? b.invitee_ids : (b.invitee_ids ? [b.invitee_ids] : []);
    setToolboxInvitees(r.lastInsertRowid, inviteeIds);

    // Persist photo attachments separately so each one is downloadable.
    const photoFiles = (req.files && req.files.photos) || [];
    if (photoFiles.length) {
      const ins = db.prepare(`
        INSERT INTO toolbox_attachments (toolbox_id, file_path, file_original_name, kind, uploaded_by_id)
        VALUES (?, ?, ?, 'photo', ?)
      `);
      for (const f of photoFiles) {
        ins.run(r.lastInsertRowid, relFromRepo(f.path), f.originalname, userId);
      }
    }
    // Documents — the post-attendance materials. Same table, kind='doc'.
    const docFiles = (req.files && req.files.documents) || [];
    if (docFiles.length) {
      const ins = db.prepare(`
        INSERT INTO toolbox_attachments (toolbox_id, file_path, file_original_name, kind, uploaded_by_id)
        VALUES (?, ?, ?, 'doc', ?)
      `);
      for (const f of docFiles) {
        ins.run(r.lastInsertRowid, relFromRepo(f.path), f.originalname, userId);
      }
    }
    // Prep documents — pre-meeting reading. kind='prep'. Visible to
    // every invited worker regardless of attendance state.
    const prepFiles = (req.files && req.files.prep_documents) || [];
    if (prepFiles.length) {
      const ins = db.prepare(`
        INSERT INTO toolbox_attachments (toolbox_id, file_path, file_original_name, kind, uploaded_by_id)
        VALUES (?, ?, ?, 'prep', ?)
      `);
      for (const f of prepFiles) {
        ins.run(r.lastInsertRowid, relFromRepo(f.path), f.originalname, userId);
      }
    }

    try {
      logActivity({
        user: req.session.user, action: 'create', entityType: 'toolbox_talk',
        entityId: r.lastInsertRowid, entityLabel: title, details: status, ip: req.ip,
      });
    } catch (e) {}
    if (wantsPublish) {
      announcePublished(req, { id: r.lastInsertRowid, title });
      try { getOrCreateAttendanceSession(r.lastInsertRowid, userId); } catch (e) { console.error('[toolbox session]', e.message); }
    }
    req.flash('success', wantsPublish ? 'Toolbox talk published — share the attendance link with the crew.' : 'Draft saved.');
    return res.redirect('/toolbox-talks/' + r.lastInsertRowid);
  } catch (err) {
    console.error('[toolbox-talks POST]', err);
    req.flash('error', 'Could not create toolbox: ' + (err && err.message || 'unknown'));
    return res.redirect('/toolbox-talks/new');
  }
});

// GET /toolbox-talks/:id — show with attendance summary
router.get('/:id', (req, res) => {
  const db = getDb();
  const toolbox = db.prepare(`
    SELECT t.*, u.full_name AS created_by_name, pu.full_name AS published_by_name
    FROM toolbox_talks t
    LEFT JOIN users u ON u.id = t.created_by_id
    LEFT JOIN users pu ON pu.id = t.published_by_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!toolbox) { req.flash('error', 'Toolbox not found.'); return res.redirect('/toolbox-talks'); }
  const photos = db.prepare(`SELECT * FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'photo' ORDER BY id ASC`).all(toolbox.id);
  const documents = db.prepare(`SELECT * FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'doc' ORDER BY id ASC`).all(toolbox.id);
  const prepDocuments = db.prepare(`SELECT * FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'prep' ORDER BY id ASC`).all(toolbox.id);
  const summary = db.prepare(`
    SELECT
      /* Total = invitee count when scoped, otherwise active crew (excluding
         soft-deleted employees). Means the coverage % is meaningful even
         when a toolbox is open to just a few people. */
      CASE
        WHEN (SELECT COUNT(*) FROM toolbox_invitees WHERE toolbox_id = ?) > 0
          THEN (SELECT COUNT(*) FROM toolbox_invitees WHERE toolbox_id = ?)
        ELSE (
          SELECT COUNT(*) FROM crew_members cm
          WHERE cm.active = 1
            AND (
              NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
              OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
            )
        )
      END AS total_crew,
      (SELECT COUNT(*) FROM toolbox_attendance WHERE toolbox_id = ? AND status = 'attended') AS attended,
      (SELECT COUNT(*) FROM toolbox_attendance WHERE toolbox_id = ? AND status = 'caught_up') AS caught_up,
      (SELECT COUNT(*) FROM toolbox_attendance WHERE toolbox_id = ? AND status = 'absent') AS absent
  `).get(toolbox.id, toolbox.id, toolbox.id, toolbox.id, toolbox.id);
  // List of workers who marked themselves absent + their reason, so the
  // office can see at a glance who's missing and why.
  const absences = db.prepare(`
    SELECT a.absence_reason, a.recorded_at, cm.full_name, cm.employee_id
    FROM toolbox_attendance a
    JOIN crew_members cm ON cm.id = a.crew_member_id
    WHERE a.toolbox_id = ? AND a.status = 'absent'
    ORDER BY a.recorded_at DESC
  `).all(toolbox.id);

  // Generate / fetch the public attendance link only once the toolbox
  // is published (drafts shouldn't be sharable yet).
  let attendanceSession = null;
  let attendanceUrl = null;
  if (toolbox.status === 'published') {
    try {
      attendanceSession = getOrCreateAttendanceSession(toolbox.id, req.session.user && req.session.user.id);
      const base = (process.env.APP_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
      attendanceUrl = base + '/toolbox-attend/' + attendanceSession.token;
    } catch (e) { console.error('[toolbox session load]', e.message); }
  }

  // Invitees — list (with names) so the detail page can show who was
  // scoped. Empty array means open to everyone.
  const invitees = db.prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id
    FROM toolbox_invitees i
    JOIN crew_members cm ON cm.id = i.crew_member_id
    WHERE i.toolbox_id = ?
    ORDER BY cm.full_name
  `).all(toolbox.id);

  res.render('toolbox-talks/show', {
    title: toolbox.title, currentPage: 'toolbox-talks',
    toolbox, photos, documents, prepDocuments, summary, absences, attendanceSession, attendanceUrl,
    invitees,
    statusLabels: STATUS_LABELS,
  });
});

// GET /toolbox-talks/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const toolbox = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!toolbox) { req.flash('error', 'Toolbox not found.'); return res.redirect('/toolbox-talks'); }
  const photos = db.prepare(`SELECT * FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'photo' ORDER BY id ASC`).all(toolbox.id);
  const documents = db.prepare(`SELECT * FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'doc' ORDER BY id ASC`).all(toolbox.id);
  const prepDocuments = db.prepare(`SELECT * FROM toolbox_attachments WHERE toolbox_id = ? AND kind = 'prep' ORDER BY id ASC`).all(toolbox.id);
  res.render('toolbox-talks/form', {
    title: 'Edit Toolbox Talk', currentPage: 'toolbox-talks',
    toolbox, photos, documents, prepDocuments, isEdit: true,
    selectableCrew: selectableCrewMembers(),
    inviteeIds: getToolboxInviteeIds(toolbox.id),
  });
});

// POST /toolbox-talks/:id — update. Replaces slides / sign-on if a new file
// is uploaded; appends new photos to the existing gallery (doesn't replace).
router.post('/:id', formUploads, (req, res) => {
  try {
    const db = getDb();
    const toolbox = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
    if (!toolbox) { req.flash('error', 'Not found.'); return res.redirect('/toolbox-talks'); }
    const b = req.body;
    const title = String(b.title || '').trim() || toolbox.title;
    const heldAt = (b.held_at && /^\d{4}-\d{2}-\d{2}$/.test(b.held_at)) ? b.held_at : toolbox.held_at;

    let slidesPath = toolbox.slides_path;
    let slidesName = toolbox.slides_original_name;
    let signonPath = toolbox.signon_path;
    let signonName = toolbox.signon_original_name;
    const slidesFile = req.files && req.files.slides && req.files.slides[0];
    const signonFile = req.files && req.files.signon && req.files.signon[0];
    if (slidesFile) { slidesPath = relFromRepo(slidesFile.path); slidesName = slidesFile.originalname; }
    if (signonFile) { signonPath = relFromRepo(signonFile.path); signonName = signonFile.originalname; }

    db.prepare(`
      UPDATE toolbox_talks
      SET title = ?, held_at = ?, presenter = ?, key_points = ?,
          slides_path = ?, slides_original_name = ?,
          signon_path = ?, signon_original_name = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, heldAt,
      String(b.presenter || '').trim(),
      String(b.key_points || '').trim(),
      slidesPath, slidesName, signonPath, signonName,
      toolbox.id
    );

    // Invitees — admin can re-scope an existing toolbox at any time.
    // Empty means "open to everyone" again.
    if (Object.prototype.hasOwnProperty.call(b, 'invitee_ids') || b.invitees_submitted === '1') {
      const inviteeIds = Array.isArray(b.invitee_ids) ? b.invitee_ids : (b.invitee_ids ? [b.invitee_ids] : []);
      setToolboxInvitees(toolbox.id, inviteeIds);
    }

    const photoFiles = (req.files && req.files.photos) || [];
    if (photoFiles.length) {
      const ins = db.prepare(`
        INSERT INTO toolbox_attachments (toolbox_id, file_path, file_original_name, kind, uploaded_by_id)
        VALUES (?, ?, ?, 'photo', ?)
      `);
      const uid = req.session.user ? req.session.user.id : null;
      for (const f of photoFiles) {
        ins.run(toolbox.id, relFromRepo(f.path), f.originalname, uid);
      }
    }
    // Append new docs to whatever's already attached. Editing the
    // toolbox doesn't replace documents — use the Remove button on
    // each row to drop one.
    const docFiles = (req.files && req.files.documents) || [];
    if (docFiles.length) {
      const ins = db.prepare(`
        INSERT INTO toolbox_attachments (toolbox_id, file_path, file_original_name, kind, uploaded_by_id)
        VALUES (?, ?, ?, 'doc', ?)
      `);
      const uid = req.session.user ? req.session.user.id : null;
      for (const f of docFiles) {
        ins.run(toolbox.id, relFromRepo(f.path), f.originalname, uid);
      }
    }
    const prepFiles = (req.files && req.files.prep_documents) || [];
    if (prepFiles.length) {
      const ins = db.prepare(`
        INSERT INTO toolbox_attachments (toolbox_id, file_path, file_original_name, kind, uploaded_by_id)
        VALUES (?, ?, ?, 'prep', ?)
      `);
      const uid = req.session.user ? req.session.user.id : null;
      for (const f of prepFiles) {
        ins.run(toolbox.id, relFromRepo(f.path), f.originalname, uid);
      }
    }

    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'toolbox_talk',
        entityId: toolbox.id, entityLabel: title, ip: req.ip,
      });
    } catch (e) {}
    req.flash('success', 'Toolbox saved.');
    return res.redirect('/toolbox-talks/' + toolbox.id);
  } catch (err) {
    console.error('[toolbox-talks PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown'));
    return res.redirect('/toolbox-talks/' + req.params.id + '/edit');
  }
});

// POST /toolbox-talks/:id/publish — transition draft -> published + push.
router.post('/:id/publish', (req, res) => {
  const db = getDb();
  const toolbox = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!toolbox) { req.flash('error', 'Not found.'); return res.redirect('/toolbox-talks'); }
  if (toolbox.status === 'published') {
    req.flash('error', 'Already published.');
    return res.redirect('/toolbox-talks/' + toolbox.id);
  }
  const userId = req.session.user ? req.session.user.id : null;
  db.prepare(`
    UPDATE toolbox_talks
    SET status='published', published_at=CURRENT_TIMESTAMP, published_by_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId, toolbox.id);
  announcePublished(req, toolbox);
  try { getOrCreateAttendanceSession(toolbox.id, userId); } catch (e) { console.error('[toolbox session]', e.message); }
  req.flash('success', 'Toolbox talk published — share the attendance link with the crew.');
  return res.redirect('/toolbox-talks/' + toolbox.id);
});

// POST /toolbox-talks/:id/attendance-session/regenerate — invalidate
// previous link, mint a new one. Used if the office sent the wrong
// link or someone shared it externally.
router.post('/:id/attendance-session/regenerate', (req, res) => {
  const db = getDb();
  const tb = db.prepare('SELECT id FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!tb) { req.flash('error', 'Toolbox not found.'); return res.redirect('/toolbox-talks'); }
  db.prepare("UPDATE toolbox_attendance_sessions SET closed_at = datetime('now') WHERE toolbox_id = ? AND closed_at IS NULL").run(tb.id);
  getOrCreateAttendanceSession(tb.id, req.session.user && req.session.user.id);
  req.flash('success', 'Generated a fresh attendance link.');
  return res.redirect('/toolbox-talks/' + tb.id);
});

// POST /toolbox-talks/:id/archive
router.post('/:id/archive', (req, res) => {
  const db = getDb();
  const tb = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!tb) return res.redirect('/toolbox-talks');
  db.prepare("UPDATE toolbox_talks SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id = ?").run(tb.id);
  try { logActivity({ user: req.session.user, action: 'archive', entityType: 'toolbox_talk', entityId: tb.id, entityLabel: tb.title, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Toolbox archived.');
  return res.redirect('/toolbox-talks');
});

// POST /toolbox-talks/:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const tb = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!tb) return res.redirect('/toolbox-talks');
  db.prepare('DELETE FROM toolbox_talks WHERE id = ?').run(tb.id);
  try { logActivity({ user: req.session.user, action: 'delete', entityType: 'toolbox_talk', entityId: tb.id, entityLabel: tb.title, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Toolbox deleted.');
  return res.redirect('/toolbox-talks');
});

// GET /toolbox-talks/:id/attendance — manage attendees
router.get('/:id/attendance', (req, res) => {
  const db = getDb();
  const toolbox = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!toolbox) { req.flash('error', 'Not found.'); return res.redirect('/toolbox-talks'); }
  // If the toolbox has an invitee list, only show those workers — same
  // scope as the public attendance picker so the admin tab matches what
  // the worker sees. Otherwise (open-to-all toolbox) show every active
  // crew, excluding only workers whose ONLY HR profile is soft-deleted.
  const rows = db.prepare(`
    SELECT cm.id AS crew_id, cm.full_name, cm.employee_id,
           a.status AS attendance_status, a.recorded_at, a.recorded_by_id,
           a.signed_off_at, a.absence_reason
    FROM crew_members cm
    LEFT JOIN toolbox_attendance a ON a.toolbox_id = ? AND a.crew_member_id = cm.id
    WHERE cm.active = 1
      AND (
        NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
        OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
      )
      AND (
        NOT EXISTS (SELECT 1 FROM toolbox_invitees i WHERE i.toolbox_id = ?)
        OR EXISTS (SELECT 1 FROM toolbox_invitees i WHERE i.toolbox_id = ? AND i.crew_member_id = cm.id)
      )
    ORDER BY cm.full_name
  `).all(toolbox.id, toolbox.id, toolbox.id);
  // Workers allocated on the toolbox's held_at date — "select all from this
  // day" shortcut on the form. Sourced from crew_allocations OR booking_crew.
  let allocatedIds = [];
  try {
    allocatedIds = db.prepare(`
      SELECT DISTINCT crew_member_id FROM crew_allocations
      WHERE allocation_date = ? AND status != 'cancelled'
    `).all(toolbox.held_at).map(r => r.crew_member_id);
  } catch (e) {}
  // Crew NOT currently rendered (= eligible to manually add to the
  // invite list). When the toolbox is open-to-all, this is empty
  // because everyone's already on the page.
  const renderedIds = new Set(rows.map(r => r.crew_id));
  const selectableCrew = selectableCrewMembers().filter(cm => !renderedIds.has(cm.id));
  const isOpenToAll = db.prepare('SELECT COUNT(*) AS c FROM toolbox_invitees WHERE toolbox_id = ?').get(toolbox.id).c === 0;
  // QR code points workers at the public attendance link so they can
  // sign off via the phone at the meeting. Only present for published
  // toolboxes — drafts/archives don't have a public session token.
  let attendanceUrl = null;
  if (toolbox.status === 'published') {
    try {
      const s = getOrCreateAttendanceSession(toolbox.id, req.session.user && req.session.user.id);
      const base = (process.env.APP_BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
      attendanceUrl = base + '/toolbox-attend/' + s.token;
    } catch (e) { console.error('[toolbox attendance qr]', e.message); }
  }
  res.render('toolbox-talks/attendance', {
    title: toolbox.title + ' — Attendance', currentPage: 'toolbox-talks',
    toolbox, rows, allocatedIds, selectableCrew, isOpenToAll, attendanceUrl,
  });
});

// POST /toolbox-talks/:id/invitees/add — manually add a single worker
// to a toolbox's invite list.
//
// Two behaviours depending on the current state of toolbox_invitees:
//   1. Already scoped (non-empty invitees): just INSERT OR IGNORE the
//      crew_id so they appear on the attendance page.
//   2. Open to everyone (empty invitees): the worker is already
//      implicitly invited, so adding is a no-op as far as DB state
//      goes — but we return `was_already_invited: true` so the UI can
//      explain why nothing changed and offer the "Remove others to
//      scope" path.
//
// Returns JSON for the attendance page's AJAX add-row flow.
router.post('/:id/invitees/add', (req, res) => {
  try {
    const db = getDb();
    const toolboxId = parseInt(req.params.id, 10);
    const crewId = parseInt(req.body.crew_member_id, 10);
    if (!toolboxId || !crewId) return res.status(400).json({ ok: false, error: 'Bad ids' });
    const tb = db.prepare('SELECT id, title FROM toolbox_talks WHERE id = ?').get(toolboxId);
    if (!tb) return res.status(404).json({ ok: false, error: 'Toolbox not found' });
    const crew = db.prepare(`
      SELECT cm.id, cm.full_name, cm.employee_id
      FROM crew_members cm
      WHERE cm.id = ? AND cm.active = 1
        AND (
          NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
          OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
        )
    `).get(crewId);
    if (!crew) return res.status(404).json({ ok: false, error: 'Worker not found or inactive' });

    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM toolbox_invitees WHERE toolbox_id = ?').get(toolboxId).c;
    let wasAlreadyInvited = false;
    if (currentCount === 0) {
      // Open-to-all: the worker is already implicitly on the invite
      // list. No DB mutation needed.
      wasAlreadyInvited = true;
    } else {
      const existing = db.prepare('SELECT 1 FROM toolbox_invitees WHERE toolbox_id = ? AND crew_member_id = ?').get(toolboxId, crewId);
      if (existing) {
        wasAlreadyInvited = true;
      } else {
        db.prepare('INSERT INTO toolbox_invitees (toolbox_id, crew_member_id) VALUES (?, ?)')
          .run(toolboxId, crewId);
      }
    }

    try {
      logActivity({
        user: req.session.user, action: 'invitee_added', entityType: 'toolbox_talk',
        entityId: tb.id, entityLabel: tb.title, details: 'crew_id=' + crewId, ip: req.ip,
      });
    } catch (e) {}
    return res.json({
      ok: true,
      was_already_invited: wasAlreadyInvited,
      crew: { id: crew.id, full_name: crew.full_name, employee_id: crew.employee_id || null },
    });
  } catch (err) {
    console.error('[toolbox-talks invitee add]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /toolbox-talks/:id/invitees/:crewId/remove — drop a single
// worker from this toolbox's invite list.
//
// If the toolbox is currently "open to everyone" (empty invitees table),
// we snapshot the current active-crew list into toolbox_invitees first,
// excluding the worker being removed — that scopes the toolbox so the
// removal actually has an effect. Subsequent removes just delete one
// invitee row each.
//
// Returns JSON { ok: true } so the attendance page can update its row
// in place via fetch.
router.post('/:id/invitees/:crewId/remove', (req, res) => {
  try {
    const db = getDb();
    const toolboxId = parseInt(req.params.id, 10);
    const crewId = parseInt(req.params.crewId, 10);
    if (!toolboxId || !crewId) return res.status(400).json({ ok: false, error: 'Bad ids' });
    const tb = db.prepare('SELECT id, title FROM toolbox_talks WHERE id = ?').get(toolboxId);
    if (!tb) return res.status(404).json({ ok: false, error: 'Toolbox not found' });

    const currentCount = db.prepare('SELECT COUNT(*) AS c FROM toolbox_invitees WHERE toolbox_id = ?').get(toolboxId).c;
    db.transaction(() => {
      if (currentCount === 0) {
        // Open-to-everyone toolbox: scope it by inserting every active
        // crew except the one being removed.
        const ins = db.prepare('INSERT OR IGNORE INTO toolbox_invitees (toolbox_id, crew_member_id) VALUES (?, ?)');
        for (const cm of selectableCrewMembers()) {
          if (cm.id !== crewId) ins.run(toolboxId, cm.id);
        }
      } else {
        db.prepare('DELETE FROM toolbox_invitees WHERE toolbox_id = ? AND crew_member_id = ?')
          .run(toolboxId, crewId);
      }
    })();

    try {
      logActivity({
        user: req.session.user, action: 'invitee_removed', entityType: 'toolbox_talk',
        entityId: tb.id, entityLabel: tb.title, details: 'crew_id=' + crewId, ip: req.ip,
      });
    } catch (e) {}
    return res.json({ ok: true });
  } catch (err) {
    console.error('[toolbox-talks invitee remove]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /toolbox-talks/:id/attendance — apply a per-row status mapping
// submitted by an admin/HR user from the attendance page.
//
// Body shape:
//   manageable_crew_ids[] = [<id>, <id>, ...]    // every row rendered
//   status[<crewId>]      = ''|'attending'|'attended'|'absent'|'caught_up'
//                            ('' or 'pending' clears the row entirely)
//   absence_reason[<crewId>] = '<free text>'    // required for 'absent'
//
// Semantics per status value:
//   ''/'pending'  — DELETE the row (back to no record)
//   'attending'   — admin-set RSVP-yes; clears any prior sign-off so the
//                   worker can re-sign later
//   'attended'    — admin marks the worker off. signed_off_at = NOW so it
//                   counts as a real "attended" state in the new model.
//                   If the worker had previously signed off with their own
//                   signature, that signature_data is preserved (we don't
//                   clobber the worker's audit trail when the admin just
//                   confirms what's already there).
//   'absent'      — admin records "not attending" with required reason
//   'caught_up'   — admin attributes self-claim on behalf of the worker
//
// Scope: only crew_member_ids present in `manageable_crew_ids[]` are
// touched, so a stale form submission can't accidentally wipe rows for
// workers who've since been added/removed from the invite list.
router.post('/:id/attendance', (req, res) => {
  const db = getDb();
  const toolbox = db.prepare('SELECT * FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!toolbox) { req.flash('error', 'Not found.'); return res.redirect('/toolbox-talks'); }
  const userId = req.session.user ? req.session.user.id : null;
  const manageable = []
    .concat(req.body.manageable_crew_ids || [])
    .map(n => parseInt(n, 10))
    .filter(n => n > 0);
  const statusBody = (req.body.status && typeof req.body.status === 'object') ? req.body.status : {};
  const reasonBody = (req.body.absence_reason && typeof req.body.absence_reason === 'object') ? req.body.absence_reason : {};
  const VALID = new Set(['', 'pending', 'attending', 'attended', 'absent', 'caught_up']);

  // Validate reasons up-front so we don't half-apply.
  const missingReason = [];
  for (const cid of manageable) {
    const s = (statusBody[cid] || '').toString();
    if (s === 'absent') {
      const r = (reasonBody[cid] || '').toString().trim();
      if (!r) missingReason.push(cid);
    }
    if (!VALID.has(s)) {
      req.flash('error', 'Invalid status submitted.');
      return res.redirect('/toolbox-talks/' + toolbox.id + '/attendance');
    }
  }
  if (missingReason.length) {
    req.flash('error', "Add a reason for each worker marked 'Not attending' before saving.");
    return res.redirect('/toolbox-talks/' + toolbox.id + '/attendance');
  }

  const counts = { attended: 0, attending: 0, absent: 0, caught_up: 0, pending: 0 };

  const upsertAttending = db.prepare(`
    INSERT INTO toolbox_attendance
      (toolbox_id, crew_member_id, status, recorded_by_id, recorded_at, signed_off_at, signature_data, absence_reason)
    VALUES (?, ?, 'attending', ?, CURRENT_TIMESTAMP, NULL, NULL, NULL)
    ON CONFLICT(toolbox_id, crew_member_id) DO UPDATE SET
      status = 'attending',
      recorded_by_id = excluded.recorded_by_id,
      recorded_at = CURRENT_TIMESTAMP,
      signed_off_at = NULL,
      signature_data = NULL,
      absence_reason = NULL
  `);
  // Attended: set signed_off_at = NOW so it counts as a real "attended"
  // state. Preserve any existing worker signature_data — admin confirming
  // a worker who already signed shouldn't wipe their signature. If the
  // row is new, signature_data stays NULL (admin attribution only).
  const upsertAttended = db.prepare(`
    INSERT INTO toolbox_attendance
      (toolbox_id, crew_member_id, status, recorded_by_id, recorded_at, signed_off_at, signature_data, absence_reason)
    VALUES (?, ?, 'attended', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)
    ON CONFLICT(toolbox_id, crew_member_id) DO UPDATE SET
      status = 'attended',
      recorded_by_id = excluded.recorded_by_id,
      recorded_at = CURRENT_TIMESTAMP,
      signed_off_at = COALESCE(toolbox_attendance.signed_off_at, CURRENT_TIMESTAMP),
      absence_reason = NULL
  `);
  const upsertAbsent = db.prepare(`
    INSERT INTO toolbox_attendance
      (toolbox_id, crew_member_id, status, recorded_by_id, recorded_at, signed_off_at, signature_data, absence_reason)
    VALUES (?, ?, 'absent', ?, CURRENT_TIMESTAMP, NULL, NULL, ?)
    ON CONFLICT(toolbox_id, crew_member_id) DO UPDATE SET
      status = 'absent',
      recorded_by_id = excluded.recorded_by_id,
      recorded_at = CURRENT_TIMESTAMP,
      signed_off_at = NULL,
      signature_data = NULL,
      absence_reason = excluded.absence_reason
  `);
  const upsertCaughtUp = db.prepare(`
    INSERT INTO toolbox_attendance
      (toolbox_id, crew_member_id, status, recorded_by_id, recorded_at, signed_off_at, signature_data, absence_reason)
    VALUES (?, ?, 'caught_up', ?, CURRENT_TIMESTAMP, NULL, NULL, NULL)
    ON CONFLICT(toolbox_id, crew_member_id) DO UPDATE SET
      status = 'caught_up',
      recorded_by_id = excluded.recorded_by_id,
      recorded_at = CURRENT_TIMESTAMP,
      signed_off_at = NULL,
      signature_data = NULL,
      absence_reason = NULL
  `);
  const del = db.prepare(`DELETE FROM toolbox_attendance WHERE toolbox_id = ? AND crew_member_id = ?`);

  const tx = db.transaction(() => {
    for (const cid of manageable) {
      const s = (statusBody[cid] || '').toString();
      if (s === '' || s === 'pending') {
        del.run(toolbox.id, cid);
        counts.pending++;
      } else if (s === 'attending') {
        upsertAttending.run(toolbox.id, cid, userId);
        counts.attending++;
      } else if (s === 'attended') {
        upsertAttended.run(toolbox.id, cid, userId);
        counts.attended++;
      } else if (s === 'absent') {
        const reason = (reasonBody[cid] || '').toString().trim().slice(0, 500);
        upsertAbsent.run(toolbox.id, cid, userId, reason);
        counts.absent++;
      } else if (s === 'caught_up') {
        upsertCaughtUp.run(toolbox.id, cid, userId);
        counts.caught_up++;
      }
    }
  });
  tx();

  try {
    logActivity({
      user: req.session.user, action: 'attendance_updated', entityType: 'toolbox_talk',
      entityId: toolbox.id, entityLabel: toolbox.title,
      details: `attended=${counts.attended} attending=${counts.attending} absent=${counts.absent} caught_up=${counts.caught_up} pending=${counts.pending}`,
      ip: req.ip,
    });
  } catch (e) {}
  req.flash('success',
    'Attendance saved — ' +
    counts.attended + ' attended · ' +
    counts.attending + ' attending · ' +
    counts.absent + ' not attending · ' +
    counts.caught_up + ' caught up · ' +
    counts.pending + ' pending.'
  );
  return res.redirect('/toolbox-talks/' + toolbox.id + '/attendance');
});

// GET /toolbox-talks/:id/slides — auth-gated slides download
router.get('/:id/slides', (req, res) => {
  const db = getDb();
  const tb = db.prepare('SELECT slides_path, slides_original_name FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!tb || !tb.slides_path) { req.flash('error', 'No slides attached.'); return res.redirect('/toolbox-talks/' + req.params.id); }
  const abs = path.join(__dirname, '..', tb.slides_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing.'); return res.redirect('/toolbox-talks/' + req.params.id); }
  return res.download(abs, tb.slides_original_name || path.basename(abs));
});

// GET /toolbox-talks/:id/signon — auth-gated sign-on sheet download
router.get('/:id/signon', (req, res) => {
  const db = getDb();
  const tb = db.prepare('SELECT signon_path, signon_original_name FROM toolbox_talks WHERE id = ?').get(req.params.id);
  if (!tb || !tb.signon_path) { req.flash('error', 'No sign-on sheet attached.'); return res.redirect('/toolbox-talks/' + req.params.id); }
  const abs = path.join(__dirname, '..', tb.signon_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing.'); return res.redirect('/toolbox-talks/' + req.params.id); }
  return res.download(abs, tb.signon_original_name || path.basename(abs));
});

// GET /toolbox-talks/:id/photos/:photoId — auth-gated single photo serve.
// Streams inline rather than as a download so the office show page can
// display the gallery via <img>.
router.get('/:id/photos/:photoId', (req, res) => {
  const db = getDb();
  const ph = db.prepare(`SELECT file_path, file_original_name FROM toolbox_attachments WHERE id = ? AND toolbox_id = ?`).get(req.params.photoId, req.params.id);
  if (!ph || !ph.file_path) return res.status(404).send('not found');
  const abs = path.join(__dirname, '..', ph.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('missing');
  return res.sendFile(abs);
});

// POST /toolbox-talks/:id/photos/:photoId/delete
router.post('/:id/photos/:photoId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM toolbox_attachments WHERE id = ? AND toolbox_id = ?').run(req.params.photoId, req.params.id);
  req.flash('success', 'Photo removed.');
  return res.redirect('/toolbox-talks/' + req.params.id + '/edit');
});

// GET /toolbox-talks/:id/documents/:docId — auth-gated download of a
// post-attendance material. Admin-only path; the worker-side equivalent
// is under /w/safety/toolboxes/:id/documents/:docId and gates on
// sign-off.
router.get('/:id/documents/:docId', (req, res) => {
  const db = getDb();
  const doc = db.prepare(
    `SELECT file_path, file_original_name FROM toolbox_attachments
     WHERE id = ? AND toolbox_id = ? AND kind = 'doc'`
  ).get(req.params.docId, req.params.id);
  if (!doc || !doc.file_path) return res.status(404).send('not found');
  const abs = path.join(__dirname, '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('missing');
  return res.download(abs, doc.file_original_name || path.basename(abs));
});

// POST /toolbox-talks/:id/documents/:docId/delete
router.post('/:id/documents/:docId/delete', (req, res) => {
  const db = getDb();
  db.prepare(
    `DELETE FROM toolbox_attachments WHERE id = ? AND toolbox_id = ? AND kind = 'doc'`
  ).run(req.params.docId, req.params.id);
  req.flash('success', 'Document removed.');
  return res.redirect('/toolbox-talks/' + req.params.id + '/edit');
});

// GET /toolbox-talks/:id/prep/:prepId — admin download of a prep doc.
router.get('/:id/prep/:prepId', (req, res) => {
  const db = getDb();
  const doc = db.prepare(
    `SELECT file_path, file_original_name FROM toolbox_attachments
     WHERE id = ? AND toolbox_id = ? AND kind = 'prep'`
  ).get(req.params.prepId, req.params.id);
  if (!doc || !doc.file_path) return res.status(404).send('not found');
  const abs = path.join(__dirname, '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('missing');
  return res.download(abs, doc.file_original_name || path.basename(abs));
});

// POST /toolbox-talks/:id/prep/:prepId/delete
router.post('/:id/prep/:prepId/delete', (req, res) => {
  const db = getDb();
  db.prepare(
    `DELETE FROM toolbox_attachments WHERE id = ? AND toolbox_id = ? AND kind = 'prep'`
  ).run(req.params.prepId, req.params.id);
  req.flash('success', 'Prep document removed.');
  return res.redirect('/toolbox-talks/' + req.params.id + '/edit');
});

module.exports = router;
