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

// ── Soft launch gate ──
// Workshops is new and we don't want every admin opening it before it's
// been piloted. Anyone with the safety_workshops permission can REACH
// this router (gated upstream in server.js), but they need the shared
// password below to actually use it. Cleared by setting an unlock flag
// on the admin session, scoped to that browser session.
//
// To change the password without a code push, set WORKSHOPS_PASSWORD on
// Railway. To remove the lock entirely, set WORKSHOPS_UNLOCKED=true and
// the middleware short-circuits.
const WORKSHOPS_PASSWORD = (process.env.WORKSHOPS_PASSWORD || 'safety').trim();
const WORKSHOPS_GATE_DISABLED = process.env.WORKSHOPS_UNLOCKED === 'true';

// Render the unlock screen. Lives above the gate middleware so visiting
// it doesn't redirect-loop.
router.get('/unlock', (req, res) => {
  if (WORKSHOPS_GATE_DISABLED || (req.session && req.session.workshopsUnlocked)) {
    return res.redirect('/safety-workshops');
  }
  res.render('safety-workshops/unlock', {
    title: 'Workshops',
    currentPage: 'safety-workshops',
  });
});

// Validate the password. On success, set the per-session flag and bounce
// back to the workshops list. On failure, flash + redirect to the unlock
// screen — no specific error wording so we don't leak "the password
// exists, you got it wrong" vs "the password was removed" etc.
router.post('/unlock', (req, res) => {
  const pw = String((req.body && req.body.password) || '').trim();
  if (pw && pw === WORKSHOPS_PASSWORD) {
    req.session.workshopsUnlocked = true;
    try {
      logActivity({
        user: req.session.user,
        action: 'unlock',
        entityType: 'workshops_module',
        entityId: 0,
        entityLabel: 'Workshops module unlocked',
        ip: req.ip,
      });
    } catch (e) {}
    return res.redirect('/safety-workshops');
  }
  req.flash('error', 'Wrong password.');
  return res.redirect('/safety-workshops/unlock');
});

// Gate everything below this line. Anything registered AFTER this
// router.use call inherits the check; the two /unlock routes above
// stay reachable.
router.use((req, res, next) => {
  if (WORKSHOPS_GATE_DISABLED) return next();
  if (req.session && req.session.workshopsUnlocked) return next();
  return res.redirect('/safety-workshops/unlock');
});

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

// ── Helpers for group mode ──
// Active crew, same shape the toolbox picker uses (excludes soft-deleted-only).
function listSelectableCrew(db) {
  return db.prepare(`
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

// Published toolbox talks (most-recent first) for the source picker.
function listPublishedToolboxes(db) {
  return db.prepare(`
    SELECT id, title, held_at
    FROM toolbox_talks
    WHERE status = 'published'
    ORDER BY held_at DESC, created_at DESC
    LIMIT 50
  `).all();
}

// Names of workers who marked themselves Attending OR signed off as
// Attended on a toolbox. These are the people the office would actually
// expect to be in the room, so they're the default attendee set for a
// group session.
function listToolboxAttendees(db, toolboxId) {
  return db.prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id, a.status
    FROM toolbox_attendance a
    JOIN crew_members cm ON cm.id = a.crew_member_id
    WHERE a.toolbox_id = ?
      AND a.status IN ('attending','attended')
    ORDER BY cm.full_name
  `).all(toolboxId);
}

// Fisher-Yates shuffle, returns a new array.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Split `names` into `n` groups, fairly distributed (sizes differ by at
// most 1). Pre-shuffled names produces random teams; passing names as-is
// keeps order. Returns array of arrays.
function partition(names, n) {
  const out = Array.from({ length: n }, () => []);
  names.forEach((name, i) => out[i % n].push(name));
  return out;
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
// GET /safety-workshops/:slug/sessions/new — configure a new session
// =====================================================================
// Pre-flight form that lets the facilitator pick the mode
// (individual / group) and, for group mode, choose attendees from a
// toolbox talk or hand-pick them, then preview the auto-generated teams.
router.get('/:slug/sessions/new', (req, res) => {
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
    req.flash('error', 'Workshop ' + wk.slug + ' has no content module registered.');
    return res.redirect('/safety-workshops');
  }
  res.render('safety-workshops/session-new', {
    title: 'Start session · ' + wk.title,
    currentPage: 'safety-workshops',
    workshop: wk,
    cases: module.CASES.map((c) => ({ letter: c.letter, title: c.title })),
    crew: listSelectableCrew(db),
    toolboxes: listPublishedToolboxes(db),
  });
});

// JSON endpoint used by the config form when the facilitator picks a
// toolbox talk — returns the list of crew who marked Attending /
// Attended so they can be pre-selected as the attendee set.
router.get('/toolbox-attendees/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  const db = getDb();
  const tb = db.prepare('SELECT id, title FROM toolbox_talks WHERE id = ?').get(id);
  if (!tb) return res.status(404).json({ error: 'not_found' });
  res.json({
    toolbox: { id: tb.id, title: tb.title },
    attendees: listToolboxAttendees(db, id),
  });
});

// =====================================================================
// POST /safety-workshops/:slug/sessions — create a new session
// =====================================================================
// Body:
//   mode        — 'individual' (default) or 'group'
//   groups_json — required if mode='group'. Array of
//                 { name, members: [string], case_letter }.
//                 Server validates case_letter is in the workshop's
//                 CASES list and that group count matches case count.
router.post('/:slug/sessions', (req, res) => {
  const db = getDb();
  const wk = db
    .prepare('SELECT * FROM workshop_definitions WHERE slug = ?')
    .get(req.params.slug);
  if (!wk) {
    req.flash('error', 'Workshop not found.');
    return res.redirect('/safety-workshops');
  }
  const module = WORKSHOPS[wk.slug];
  const validCases = module ? module.CASES.map((c) => c.letter) : [];

  const mode = (req.body && req.body.mode === 'group') ? 'group' : 'individual';
  let groups = null;
  if (mode === 'group') {
    try {
      groups = JSON.parse(String((req.body && req.body.groups_json) || '[]'));
    } catch (e) {
      req.flash('error', 'Group data was malformed — try generating the teams again.');
      return res.redirect('/safety-workshops/' + wk.slug + '/sessions/new');
    }
    if (!Array.isArray(groups) || groups.length === 0) {
      req.flash('error', 'Pick attendees and generate at least one group first.');
      return res.redirect('/safety-workshops/' + wk.slug + '/sessions/new');
    }
    // Each group must have a valid case + a name + at least one member.
    for (const g of groups) {
      if (!g || typeof g.name !== 'string' || !g.name.trim()) {
        req.flash('error', 'Every group needs a name.');
        return res.redirect('/safety-workshops/' + wk.slug + '/sessions/new');
      }
      if (!validCases.includes(String(g.case_letter || '').toUpperCase())) {
        req.flash('error', 'A group was assigned an unknown case (' + g.case_letter + ').');
        return res.redirect('/safety-workshops/' + wk.slug + '/sessions/new');
      }
      if (!Array.isArray(g.members) || g.members.length === 0) {
        req.flash('error', 'Group "' + g.name + '" has no members.');
        return res.redirect('/safety-workshops/' + wk.slug + '/sessions/new');
      }
    }
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

  const create = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO workshop_sessions (workshop_id, facilitator_id, session_code, mode)
         VALUES (?, ?, ?, ?)`
      )
      .run(wk.id, facId || null, code, mode);
    if (mode === 'group' && groups) {
      const ins = db.prepare(
        `INSERT INTO workshop_assignments
           (session_id, player_name, case_letter, members_csv, user_id)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const g of groups) {
        ins.run(
          info.lastInsertRowid,
          g.name.trim(),
          String(g.case_letter).toUpperCase(),
          g.members.join(', '),
          facId || null
        );
      }
    }
    return info.lastInsertRowid;
  });

  let sessionId;
  try {
    sessionId = create();
  } catch (e) {
    console.error('[safety-workshops create]', e);
    req.flash('error', 'Could not create session: ' + e.message);
    return res.redirect('/safety-workshops/' + wk.slug + '/sessions/new');
  }
  try {
    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'workshop_session',
      entityId: sessionId,
      entityLabel: wk.title + ' · ' + code + (mode === 'group' ? ' (group)' : ''),
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
      `SELECT player_name, case_letter, claimed_at, members_csv, claimed_by_name
       FROM workshop_assignments
       WHERE session_id = ?
       ORDER BY claimed_at ASC`
    )
    .all(session.id);
  // In group mode we collapse multiple attempts per group down to the
  // single best score so the leaderboard has one row per team. Individual
  // mode keeps every attempt as its own row (existing behaviour).
  const attempts = (session.mode === 'group')
    ? db.prepare(
        `SELECT player_name, case_letter, MAX(score) AS score,
                MAX(max_score) AS max_score,
                MAX(completed_at) AS completed_at
         FROM workshop_attempts
         WHERE session_id = ? AND completed_at IS NOT NULL
         GROUP BY player_name, case_letter
         ORDER BY score DESC, completed_at ASC`
      ).all(session.id)
    : db.prepare(
        `SELECT player_name, case_letter, score, max_score, completed_at
         FROM workshop_attempts
         WHERE session_id = ? AND completed_at IS NOT NULL
         ORDER BY score DESC, completed_at ASC`
      ).all(session.id);
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
      'SELECT id, status, mode FROM workshop_sessions WHERE session_code = ?'
    )
    .get(req.params.code);
  if (!session) return res.status(404).json({ error: 'session_not_found' });
  const assignments = db
    .prepare(
      `SELECT player_name, case_letter, claimed_at, members_csv, claimed_by_name
       FROM workshop_assignments WHERE session_id = ? ORDER BY claimed_at`
    )
    .all(session.id);
  const attempts = (session.mode === 'group')
    ? db.prepare(
        `SELECT player_name, case_letter, MAX(score) AS score,
                MAX(max_score) AS max_score,
                MAX(completed_at) AS completed_at
         FROM workshop_attempts
         WHERE session_id = ? AND completed_at IS NOT NULL
         GROUP BY player_name, case_letter
         ORDER BY score DESC, completed_at ASC`
      ).all(session.id)
    : db.prepare(
        `SELECT player_name, case_letter, score, max_score, completed_at
         FROM workshop_attempts
         WHERE session_id = ? AND completed_at IS NOT NULL
         ORDER BY score DESC, completed_at ASC`
      ).all(session.id);
  res.json({ status: session.status, mode: session.mode, assignments, attempts });
});

// =====================================================================
// POST /safety-workshops/sessions/:code/add-participant — manual add
// =====================================================================
// Facilitator-side fallback for adding someone to a session the public
// QR flow didn't capture — workers without phones, late arrivals, or
// someone whose phone won't scan. Body:
//   name         — display name (required, 2–60 chars)
//   case_letter  — A/B/C/… (required, must be valid for this workshop)
//   score        — optional integer. If provided, also writes a
//                  workshop_attempts row so the new participant lands on
//                  the leaderboard immediately. Max defaults to the
//                  largest max_score already recorded this session, or
//                  100 if no attempts have been submitted yet.
//   max_score    — optional override for the max if the admin wants to
//                  override the inherited default.
router.post('/sessions/:code/add-participant', (req, res) => {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT s.*, w.slug AS workshop_slug, w.title AS workshop_title
       FROM workshop_sessions s
       JOIN workshop_definitions w ON w.id = s.workshop_id
       WHERE s.session_code = ?`
    )
    .get(req.params.code);
  if (!session) {
    req.flash('error', 'Session not found.');
    return res.redirect('/safety-workshops');
  }
  if (session.status !== 'open') {
    req.flash('error', "Can't add — session is closed. Reopen it first.");
    return res.redirect('/safety-workshops/sessions/' + session.session_code);
  }
  const module = WORKSHOPS[session.workshop_slug];
  if (!module) {
    req.flash('error', 'Workshop content module missing.');
    return res.redirect('/safety-workshops/sessions/' + session.session_code);
  }
  const validCases = module.CASES.map((c) => c.letter);

  const name = String((req.body && req.body.name) || '').trim();
  const caseLetter = String((req.body && req.body.case_letter) || '').toUpperCase().trim();
  const rawScore = (req.body && req.body.score != null) ? String(req.body.score).trim() : '';
  const rawMax   = (req.body && req.body.max_score != null) ? String(req.body.max_score).trim() : '';
  // When the admin ticks "Override existing entry" on the form the
  // existing assignment/attempt is replaced rather than blocking the
  // submit. Use case: a worker accidentally refreshed mid-quiz and lost
  // their answers, but the case assignment is still claimed so the
  // public flow won't take a fresh entry under the same name.
  const override = !!(req.body && (req.body.override === '1' || req.body.override === 'on' || req.body.override === true));

  if (name.length < 2 || name.length > 60) {
    req.flash('error', 'Name is required (2–60 characters).');
    return res.redirect('/safety-workshops/sessions/' + session.session_code);
  }
  if (!validCases.includes(caseLetter)) {
    req.flash('error', 'Pick a valid case.');
    return res.redirect('/safety-workshops/sessions/' + session.session_code);
  }
  // Same case-insensitive name dedupe as the public start endpoint.
  const existing = db
    .prepare(
      `SELECT id, case_letter FROM workshop_assignments
       WHERE session_id = ? AND LOWER(player_name) = LOWER(?)`
    )
    .get(session.id, name);
  if (existing && !override) {
    req.flash('error', name + ' is already on the board (Case ' + existing.case_letter + '). Tick "Override existing entry" to replace.');
    return res.redirect('/safety-workshops/sessions/' + session.session_code);
  }

  // Inherit max_score from an existing attempt so the leaderboard's
  // /160 (or whatever) stays consistent across all rows. Admin can
  // override via the max_score form field.
  let maxScore = parseInt(rawMax, 10);
  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    const fromAttempt = db
      .prepare('SELECT MAX(max_score) AS m FROM workshop_attempts WHERE session_id = ?')
      .get(session.id);
    maxScore = (fromAttempt && fromAttempt.m) || 100;
  }
  let score = null;
  if (rawScore !== '') {
    score = parseInt(rawScore, 10);
    if (!Number.isFinite(score) || score < 0 || score > maxScore) {
      req.flash('error', 'Score must be between 0 and ' + maxScore + '.');
      return res.redirect('/safety-workshops/sessions/' + session.session_code);
    }
  }

  const userId = req.session.user ? req.session.user.id : null;
  const tx = db.transaction(() => {
    if (existing) {
      // Override path — re-point the assignment to the new case (if
      // the admin picked a different one) and replace any prior attempt
      // for this name. Clears the player's old answers_json since the
      // override is authoritative.
      db.prepare(
        `UPDATE workshop_assignments
         SET case_letter = ?, user_id = COALESCE(?, user_id)
         WHERE id = ?`
      ).run(caseLetter, userId, existing.id);
      db.prepare(
        `DELETE FROM workshop_attempts WHERE session_id = ? AND LOWER(player_name) = LOWER(?)`
      ).run(session.id, name);
    } else {
      db.prepare(
        `INSERT INTO workshop_assignments (session_id, player_name, case_letter, user_id)
         VALUES (?, ?, ?, ?)`
      ).run(session.id, name, caseLetter, userId);
    }
    if (score != null) {
      db.prepare(
        `INSERT INTO workshop_attempts
           (session_id, workshop_id, case_letter, player_name, score, max_score,
            answers_json, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).run(session.id, session.workshop_id, caseLetter, name, score, maxScore);
    }
  });
  try {
    tx();
  } catch (e) {
    console.error('[safety-workshops add-participant]', e);
    req.flash('error', 'Could not add: ' + e.message);
    return res.redirect('/safety-workshops/sessions/' + session.session_code);
  }
  try {
    logActivity({
      user: req.session.user,
      action: existing ? 'override_participant' : 'add_participant',
      entityType: 'workshop_session',
      entityId: session.id,
      entityLabel: session.session_code,
      details: name + ' → Case ' + caseLetter + (score != null ? ' (' + score + '/' + maxScore + ')' : '') + (existing ? ' [override]' : ''),
      ip: req.ip,
    });
  } catch (e) {}
  req.flash('success',
    (existing ? 'Overrode ' : 'Added ') + name +
    ' → Case ' + caseLetter +
    (score != null ? ' with score ' + score + '/' + maxScore + '.' : '.')
  );
  return res.redirect('/safety-workshops/sessions/' + session.session_code);
});

// =====================================================================
// POST /safety-workshops/sessions/:code/close — close session
// =====================================================================
// Locks submissions but preserves all scores + assignments. Use this
// when the workshop is done and you want the leaderboard to stay
// visible without anyone else joining.
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
// POST /safety-workshops/sessions/:code/restart — wipe scores, replay
// =====================================================================
// "Play another round" — clear all attempts + case assignments for
// this session, force status back to 'open'. Same session_code so the
// QR projected on the meeting-room screen still works; participants
// just refresh their phones to re-enter their name.
router.post('/sessions/:code/restart', (req, res) => {
  const db = getDb();
  const session = db
    .prepare('SELECT * FROM workshop_sessions WHERE session_code = ?')
    .get(req.params.code);
  if (!session) {
    req.flash('error', 'Session not found.');
    return res.redirect('/safety-workshops');
  }
  // In group mode we keep the team rows (they're the whole point of the
  // session — same crowd plays another round) but clear the claim so any
  // device can pick again. In individual mode every assignment row was
  // created on a player's claim, so wiping them is correct.
  const restart = db.transaction(() => {
    db.prepare('DELETE FROM workshop_attempts WHERE session_id = ?').run(session.id);
    if (session.mode === 'group') {
      db.prepare(
        `UPDATE workshop_assignments
         SET claimed_by_name = NULL
         WHERE session_id = ?`
      ).run(session.id);
    } else {
      db.prepare('DELETE FROM workshop_assignments WHERE session_id = ?').run(session.id);
    }
    db.prepare(
      `UPDATE workshop_sessions
       SET status = 'open', closed_at = NULL
       WHERE id = ?`
    ).run(session.id);
  });
  restart();
  try {
    logActivity({
      user: req.session.user,
      action: 'restart',
      entityType: 'workshop_session',
      entityId: session.id,
      entityLabel: session.session_code,
      ip: req.ip,
    });
  } catch (e) {}
  req.flash(
    'success',
    'Session ' + session.session_code + ' restarted — scores cleared. Tell the room to refresh their phones.'
  );
  return res.redirect('/safety-workshops/sessions/' + session.session_code);
});

// =====================================================================
// POST /safety-workshops/sessions/:code/delete — destroy session
// =====================================================================
// Removes the session row entirely. workshop_attempts and
// workshop_assignments cascade via ON DELETE CASCADE in migration 220
// (with foreign_keys = ON set per connection in db/database.js).
// Mainly for cleaning up test sessions from the history view.
router.post('/sessions/:code/delete', (req, res) => {
  const db = getDb();
  const session = db
    .prepare(
      `SELECT s.*, w.slug
       FROM workshop_sessions s
       JOIN workshop_definitions w ON w.id = s.workshop_id
       WHERE s.session_code = ?`
    )
    .get(req.params.code);
  if (!session) {
    req.flash('error', 'Session not found.');
    return res.redirect('/safety-workshops');
  }
  db.prepare('DELETE FROM workshop_sessions WHERE id = ?').run(session.id);
  try {
    logActivity({
      user: req.session.user,
      action: 'delete',
      entityType: 'workshop_session',
      entityId: session.id,
      entityLabel: session.session_code,
      ip: req.ip,
    });
  } catch (e) {}
  req.flash('success', 'Session ' + session.session_code + ' deleted.');
  return res.redirect('/safety-workshops/' + session.slug);
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
