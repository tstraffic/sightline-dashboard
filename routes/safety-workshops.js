// /safety-workshops — facilitator-side admin routes for Safety > Workshops.
//
// Workshops are facilitator-led office-crew exercises. The flow:
//   1. Office staff member opens /safety-workshops, picks a workshop,
//      clicks "Start a new session" → server creates a workshop_sessions
//      row with a fresh session_code and redirects to the live dashboard.
//   2. The live dashboard (/safety-workshops/sessions/:code) shows the QR
//      code participants scan, a live participant list, and a leaderboard
//      that auto-refreshes.
//   3. Participants hit /wq/:code (handled by routes/workshop-participant.js)
//      — public-no-auth, capability is the code.
//   4. When the room is done, facilitator clicks "Close session" → moves
//      to status='closed', archives the leaderboard.
//
// v1 ships with one workshop (swms-01). Adding a second is: drop another
// service module under services/workshops/, INSERT a workshop_definitions
// row, and the routes pick it up generically.
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const swms01 = require('../services/workshops/swms-01');

// Workshop content registry — map slug → module. Add new workshops here.
const WORKSHOPS = {
  'swms-01': swms01,
};

// Unambiguous 6-char session-code alphabet. Skips 0/O/I/1/L to keep the
// QR code legible and easy to type by hand if the camera fails.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateSessionCode() {
  let c = '';
  for (let i = 0; i < 6; i++) {
    c += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return c;
}

// Read the public base URL so the QR points at the right host.
// APP_BASE_URL is set on Railway; locally falls back to a sensible default.
function publicBaseUrl(req) {
  return (
    process.env.APP_BASE_URL ||
    process.env.RAILWAY_PUBLIC_DOMAIN ||
    (req.protocol + '://' + req.get('host'))
  ).replace(/\/$/, '');
}

// =====================================================================
// GET /safety-workshops — list of workshops + recent sessions
// =====================================================================
router.get('/', (req, res) => {
  const db = getDb();
  const workshops = db
    .prepare(
      `SELECT id, slug, title, description, status, created_at
       FROM workshop_definitions
       WHERE status = 'active'
       ORDER BY title`
    )
    .all();
  // Attach per-workshop stats: open session count + lifetime attempts.
  const stats = db
    .prepare(
      `SELECT workshop_id,
              COUNT(*) AS attempts,
              MAX(completed_at) AS last_attempt
       FROM workshop_attempts
       GROUP BY workshop_id`
    )
    .all();
  const statMap = Object.fromEntries(stats.map((s) => [s.workshop_id, s]));
  const openSessions = db
    .prepare(
      `SELECT workshop_id, COUNT(*) AS n
       FROM workshop_sessions
       WHERE status = 'open'
       GROUP BY workshop_id`
    )
    .all();
  const openMap = Object.fromEntries(openSessions.map((s) => [s.workshop_id, s.n]));
  const rows = workshops.map((w) => ({
    ...w,
    attempts: statMap[w.id]?.attempts || 0,
    last_attempt: statMap[w.id]?.last_attempt || null,
    open_sessions: openMap[w.id] || 0,
    available: !!WORKSHOPS[w.slug], // is the content module registered?
  }));
  res.render('safety-workshops/index', {
    title: 'Workshops',
    currentPage: 'safety-workshops',
    rows,
  });
});

// =====================================================================
// GET /safety-workshops/:slug — workshop overview
// =====================================================================
router.get('/:slug', (req, res) => {
  const db = getDb();
  const wk = db
    .prepare('SELECT * FROM workshop_definitions WHERE slug = ?')
    .get(req.params.slug);
  if (!wk) {
    req.flash('error', 'Workshop not found.');
    return res.redirect('/safety-workshops');
  }
  const module = WORKSHOPS[wk.slug];
  if (!module) {
    // Definition exists but no content module wired up. Show a stub so the
    // admin sees what's wrong rather than a 500.
    req.flash('error', 'Workshop ' + wk.slug + ' has no content module registered.');
    return res.redirect('/safety-workshops');
  }
  const sessions = db
    .prepare(
      `SELECT s.*, u.full_name AS facilitator_name,
              (SELECT COUNT(*) FROM workshop_attempts a WHERE a.session_id = s.id) AS attempts
       FROM workshop_sessions s
       LEFT JOIN users u ON u.id = s.facilitator_id
       WHERE s.workshop_id = ?
       ORDER BY s.created_at DESC
       LIMIT 25`
    )
    .all(wk.id);
  res.render('safety-workshops/show', {
    title: wk.title,
    currentPage: 'safety-workshops',
    workshop: wk,
    cases: module.CASES.map((c) => ({ letter: c.letter, title: c.title, where: c.where })),
    sessions,
  });
});

// =====================================================================
// POST /safety-workshops/:slug/sessions — create a new session
// =====================================================================
router.post('/:slug/sessions', (req, res) => {
  const db = getDb();
  const wk = db
    .prepare('SELECT * FROM workshop_definitions WHERE slug = ?')
    .get(req.params.slug);
  if (!wk) {
    req.flash('error', 'Workshop not found.');
    return res.redirect('/safety-workshops');
  }
  // Generate a unique session code. Retry on the (vanishingly rare)
  // collision; bail after 10 tries.
  let code = null;
  for (let i = 0; i < 10; i++) {
    const candidate = generateSessionCode();
    const exists = db
      .prepare('SELECT 1 FROM workshop_sessions WHERE session_code = ?')
      .get(candidate);
    if (!exists) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    req.flash('error', 'Could not allocate a session code, try again.');
    return res.redirect('/safety-workshops/' + wk.slug);
  }
  const facId = req.session.user && req.session.user.id;
  const info = db
    .prepare(
      `INSERT INTO workshop_sessions (workshop_id, facilitator_id, session_code)
       VALUES (?, ?, ?)`
    )
    .run(wk.id, facId || null, code);
  try {
    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'workshop_session',
      entityId: info.lastInsertRowid,
      entityLabel: wk.title + ' · ' + code,
      ip: req.ip,
    });
  } catch (e) {}
  return res.redirect('/safety-workshops/sessions/' + code);
});

// =====================================================================
// GET /safety-workshops/sessions/:code — live facilitator dashboard
// =====================================================================
router.get('/sessions/:code', (req, res) => {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT s.*, w.slug AS workshop_slug, w.title AS workshop_title,
              u.full_name AS facilitator_name
       FROM workshop_sessions s
       JOIN workshop_definitions w ON w.id = s.workshop_id
       LEFT JOIN users u ON u.id = s.facilitator_id
       WHERE s.session_code = ?`
    )
    .get(req.params.code);
  if (!session) {
    req.flash('error', 'Session not found.');
    return res.redirect('/safety-workshops');
  }
  const module = WORKSHOPS[session.workshop_slug];
  const assignments = db
    .prepare(
      `SELECT player_name, case_letter, claimed_at
       FROM workshop_assignments
       WHERE session_id = ?
       ORDER BY claimed_at ASC`
    )
    .all(session.id);
  const attempts = db
    .prepare(
      `SELECT player_name, case_letter, score, max_score, completed_at
       FROM workshop_attempts
       WHERE session_id = ? AND completed_at IS NOT NULL
       ORDER BY score DESC, completed_at ASC`
    )
    .all(session.id);
  const participantUrl = publicBaseUrl(req) + '/wq/' + session.session_code;
  res.render('safety-workshops/session', {
    title: session.workshop_title + ' · ' + session.session_code,
    currentPage: 'safety-workshops',
    session,
    participantUrl,
    cases: module
      ? module.CASES.map((c) => ({ letter: c.letter, title: c.title }))
      : [],
    assignments,
    attempts,
  });
});

// =====================================================================
// GET /safety-workshops/sessions/:code/live — JSON for auto-refresh
// =====================================================================
// Polled by the live dashboard every few seconds so the facilitator sees
// participants joining and finishing without a full page reload.
router.get('/sessions/:code/live', (req, res) => {
  const db = getDb();
  const session = db
    .prepare(
      'SELECT id, status FROM workshop_sessions WHERE session_code = ?'
    )
    .get(req.params.code);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const assignments = db
    .prepare(
      `SELECT player_name, case_letter, claimed_at
       FROM workshop_assignments WHERE session_id = ? ORDER BY claimed_at`
    )
    .all(session.id);
  const attempts = db
    .prepare(
      `SELECT player_name, case_letter, score, max_score, completed_at
       FROM workshop_attempts
       WHERE session_id = ? AND completed_at IS NOT NULL
       ORDER BY score DESC, completed_at ASC`
    )
    .all(session.id);
  res.json({ status: session.status, assignments, attempts });
});

// =====================================================================
// POST /safety-workshops/sessions/:code/close — close session
// =====================================================================
router.post('/sessions/:code/close', (req, res) => {
  const db = getDb();
  const session = db
    .prepare('SELECT * FROM workshop_sessions WHERE session_code = ?')
    .get(req.params.code);
  if (!session) {
    req.flash('error', 'Session not found.');
    return res.redirect('/safety-workshops');
  }
  db.prepare(
    `UPDATE workshop_sessions
     SET status = 'closed', closed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'open'`
  ).run(session.id);
  try {
    logActivity({
      user: req.session.user,
      action: 'close',
      entityType: 'workshop_session',
      entityId: session.id,
      entityLabel: session.session_code,
      ip: req.ip,
    });
  } catch (e) {}
  req.flash('success', 'Session ' + session.session_code + ' closed.');
  return res.redirect('/safety-workshops/sessions/' + session.session_code);
});

// =====================================================================
// GET /safety-workshops/attempts — history of all attempts
// =====================================================================
router.get('/attempts/all', (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.player_name, a.case_letter, a.score, a.max_score,
              a.started_at, a.completed_at,
              w.slug AS workshop_slug, w.title AS workshop_title,
              s.session_code
       FROM workshop_attempts a
       JOIN workshop_definitions w ON w.id = a.workshop_id
       LEFT JOIN workshop_sessions s ON s.id = a.session_id
       ORDER BY a.completed_at DESC, a.started_at DESC
       LIMIT 200`
    )
    .all();
  res.render('safety-workshops/attempts', {
    title: 'Workshop attempts',
    currentPage: 'safety-workshops',
    rows,
  });
});

module.exports = router;
