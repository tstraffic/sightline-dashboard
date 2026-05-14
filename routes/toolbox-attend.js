// Public, token-protected Toolbox Meeting attendance page.
// Mounted at /toolbox-attend — no auth required, the token in the URL is
// the gate. Same precedent as /sop-sign/:token.
//
// Each toolbox_talks row has a single attendance session in
// toolbox_attendance_sessions (auto-created when the admin publishes).
// Workers visit the link, pick their name, mark Attended or Absent (with
// reason), submit. Upsert into toolbox_attendance is keyed by the
// UNIQUE(toolbox_id, crew_member_id) constraint.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function loadSession(token) {
  return getDb().prepare(`
    SELECT s.*, t.title, t.held_at, t.presenter, t.key_points, t.status as toolbox_status
    FROM toolbox_attendance_sessions s
    JOIN toolbox_talks t ON t.id = s.toolbox_id
    WHERE s.token = ?
  `).get(token);
}

function attendeeList(toolboxId) {
  const db = getDb();
  const crew = db.prepare(`
    SELECT id, full_name, employee_id
    FROM crew_members
    WHERE active = 1
    ORDER BY full_name
  `).all();
  const recorded = db.prepare(`
    SELECT crew_member_id, status, absence_reason
    FROM toolbox_attendance
    WHERE toolbox_id = ?
  `).all(toolboxId);
  const byId = new Map(recorded.map(r => [r.crew_member_id, r]));
  return crew.map(m => {
    const r = byId.get(m.id);
    return {
      ...m,
      currentStatus: r ? r.status : null,
      currentReason: r ? r.absence_reason : null,
    };
  });
}

// GET /toolbox-attend/:token — pick name + mark attended/absent
router.get('/:token', (req, res) => {
  const session = loadSession(req.params.token);
  if (!session) {
    return res.status(404).render('toolbox-attend/error', {
      layout: false, message: 'This attendance link is invalid.',
    });
  }
  if (session.closed_at) {
    return res.status(410).render('toolbox-attend/error', {
      layout: false, message: 'This attendance session has been closed by the office. Please ask for a new link.',
    });
  }
  const attendees = attendeeList(session.toolbox_id);
  res.render('toolbox-attend/sign', {
    layout: false,
    session,
    attendees,
    submitted: req.query.submitted === '1',
    submittedAs: req.query.name || '',
    submittedStatus: req.query.status || '',
  });
});

// POST /toolbox-attend/:token/submit — record attendance.
// Body: crew_member_id (required), status ('attended' | 'absent'),
//       absence_reason (required when status='absent').
router.post('/:token/submit', (req, res) => {
  const session = loadSession(req.params.token);
  if (!session) {
    return res.status(404).render('toolbox-attend/error', {
      layout: false, message: 'This attendance link is invalid.',
    });
  }
  if (session.closed_at) {
    return res.status(410).render('toolbox-attend/error', {
      layout: false, message: 'This attendance session has been closed by the office.',
    });
  }

  const crewId = parseInt(req.body.crew_member_id, 10);
  const status = ['attended', 'absent'].includes(req.body.status) ? req.body.status : null;
  const absenceReason = (req.body.absence_reason || '').toString().trim().slice(0, 1000);

  if (!crewId || !status) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Please pick your name and select Attended or Absent before submitting.',
    });
  }
  if (status === 'absent' && !absenceReason) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Please tell us why you cannot attend.',
    });
  }

  const db = getDb();
  const crew = db.prepare('SELECT id, full_name FROM crew_members WHERE id = ? AND active = 1').get(crewId);
  if (!crew) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Worker not found. Please refresh and try again.',
    });
  }

  // Upsert. The UNIQUE(toolbox_id, crew_member_id) constraint means one
  // row per worker per toolbox; if it already exists, update fields.
  db.prepare(`
    INSERT INTO toolbox_attendance (toolbox_id, crew_member_id, status, absence_reason, recorded_by_id, recorded_at)
    VALUES (?, ?, ?, ?, NULL, datetime('now'))
    ON CONFLICT(toolbox_id, crew_member_id) DO UPDATE SET
      status = excluded.status,
      absence_reason = excluded.absence_reason,
      recorded_at = excluded.recorded_at
  `).run(session.toolbox_id, crew.id, status, status === 'absent' ? absenceReason : null);

  res.redirect('/toolbox-attend/' + encodeURIComponent(req.params.token) +
               '?submitted=1' +
               '&name=' + encodeURIComponent(crew.full_name) +
               '&status=' + status);
});

module.exports = router;
