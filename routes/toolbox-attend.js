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

  // If this toolbox was scoped to specific invitees, restrict the picker
  // to that list. Empty invitees -> open to every active crew member.
  const inviteeRows = db.prepare(
    'SELECT crew_member_id FROM toolbox_invitees WHERE toolbox_id = ?'
  ).all(toolboxId);
  const inviteeIds = inviteeRows.map(r => r.crew_member_id);

  // Active crew, EXCLUDING any whose linked employees row was soft-
  // deleted. We don't want the dropdown re-surfacing deleted profiles.
  let crew;
  if (inviteeIds.length) {
    const placeholders = inviteeIds.map(() => '?').join(',');
    crew = db.prepare(`
      SELECT cm.id, cm.full_name, cm.employee_id
      FROM crew_members cm
      WHERE cm.active = 1
        AND cm.id IN (${placeholders})
        AND (
          NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
          OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
        )
      ORDER BY cm.full_name
    `).all(...inviteeIds);
  } else {
    crew = db.prepare(`
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

// POST /toolbox-attend/:token/submit — record attendance RSVP.
// Body: crew_member_id (required), status ('attending' | 'absent'),
//       absence_reason (required when status='absent').
//
// This link captures the RSVP only — sign-off ("I attended") happens
// later via the worker portal after the meeting, which is what flips the
// row to 'attended' with a signature. Clicking "I will attend" here
// historically set status='attended' directly, which short-circuited
// sign-off and made workers display as Attended on day 1; that's now
// correctly 'attending'.
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
  const status = ['attending', 'absent'].includes(req.body.status) ? req.body.status : null;
  const absenceReason = (req.body.absence_reason || '').toString().trim().slice(0, 1000);

  if (!crewId || !status) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: "Please pick your name and select whether you'll attend before submitting.",
    });
  }
  if (status === 'absent' && !absenceReason) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Please tell us why you cannot attend.',
    });
  }

  const db = getDb();
  const crew = db.prepare(`
    SELECT cm.id, cm.full_name
    FROM crew_members cm
    WHERE cm.id = ? AND cm.active = 1
      AND (
        NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
        OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
      )
  `).get(crewId);
  if (!crew) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Worker not found. Please refresh and try again.',
    });
  }
  // If the toolbox has an explicit invitee list, the worker must be on it.
  const inviteeRows = db.prepare(
    'SELECT 1 FROM toolbox_invitees WHERE toolbox_id = ?'
  ).all(session.toolbox_id);
  if (inviteeRows.length > 0) {
    const isInvited = db.prepare(
      'SELECT 1 FROM toolbox_invitees WHERE toolbox_id = ? AND crew_member_id = ?'
    ).get(session.toolbox_id, crew.id);
    if (!isInvited) {
      return res.status(403).render('toolbox-attend/error', {
        layout: false, message: 'You were not invited to this toolbox meeting. Please check with your supervisor.',
      });
    }
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

// POST /toolbox-attend/:token/sign-off — record an actual sign-off via
// the public QR link. Workers at the meeting scan the QR projected by
// the facilitator, pick their name, sign with their finger, and submit.
// Distinct from /submit (RSVP) — this writes status='attended' with
// signed_off_at + signature_data, which flips the post-attendance
// Materials gate to unlocked for that worker.
router.post('/:token/sign-off', (req, res) => {
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
  const sigRaw = (req.body.signature_data || '').toString();
  if (!crewId) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Please pick your name before signing off.',
    });
  }
  if (!sigRaw.startsWith('data:image/') || sigRaw.length > 260000) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Please draw your signature before submitting.',
    });
  }

  const db = getDb();
  const crew = db.prepare(`
    SELECT cm.id, cm.full_name
    FROM crew_members cm
    WHERE cm.id = ? AND cm.active = 1
      AND (
        NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
        OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
      )
  `).get(crewId);
  if (!crew) {
    return res.status(400).render('toolbox-attend/error', {
      layout: false, message: 'Worker not found. Please refresh and try again.',
    });
  }
  // Invitee scope check — same as the RSVP submit.
  const inviteeRows = db.prepare(
    'SELECT 1 FROM toolbox_invitees WHERE toolbox_id = ?'
  ).all(session.toolbox_id);
  if (inviteeRows.length > 0) {
    const isInvited = db.prepare(
      'SELECT 1 FROM toolbox_invitees WHERE toolbox_id = ? AND crew_member_id = ?'
    ).get(session.toolbox_id, crew.id);
    if (!isInvited) {
      return res.status(403).render('toolbox-attend/error', {
        layout: false, message: 'You were not invited to this toolbox meeting. Please check with your supervisor.',
      });
    }
  }

  // Late arrival (FRM-005 section 6 "Late attendee / time") — worker
  // ticks "I arrived late" and we stamp the current local time so the
  // attendance record matches reality.
  const isLate = req.body.late_arrival === '1' ? 1 : 0;
  db.prepare(`
    INSERT INTO toolbox_attendance
      (toolbox_id, crew_member_id, status, signature_data, signed_off_at, recorded_by_id, recorded_at,
       late_arrival, late_arrival_time)
    VALUES (?, ?, 'attended', ?, datetime('now'), NULL, datetime('now'),
            ?, CASE WHEN ? THEN strftime('%H:%M', 'now', 'localtime') ELSE NULL END)
    ON CONFLICT(toolbox_id, crew_member_id) DO UPDATE SET
      status = 'attended',
      signature_data = excluded.signature_data,
      signed_off_at = datetime('now'),
      recorded_at = datetime('now'),
      absence_reason = NULL,
      late_arrival = excluded.late_arrival,
      late_arrival_time = excluded.late_arrival_time
  `).run(session.toolbox_id, crew.id, sigRaw, isLate, isLate);

  res.redirect('/toolbox-attend/' + encodeURIComponent(req.params.token) +
               '?submitted=1&signoff=1' +
               '&name=' + encodeURIComponent(crew.full_name) +
               '&status=attended');
});

module.exports = router;
