// routes/departments.js — department home pages (/departments/:key) with the
// per-department meeting notebook. Departments themselves live in
// lib/departments.js; access = user can open ANY of the department's modules
// (same OR-gate as the matching sidebar section), enforced once in
// router.param below. Meetings are shared department artifacts: anyone who
// passes the gate can edit sections/todos; only hard-delete is restricted to
// the creator or an admin.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { getDepartment, userCanAccessDept, visibleQuickLinks } = require('../lib/departments');
const { logActivity } = require('../middleware/audit');
const { sydneyToday } = require('../lib/sydney');

// Section-save whitelist — the four notebook text columns. The optional
// `source` field is only honoured for recap (future AI drafts write through
// this same endpoint with source='ai'; a human edit always resets to manual).
const SECTION_COLS = { recap: 'recap', discussion: 'discussion', job_updates: 'job_updates', plans_proposals: 'plans_proposals' };

// Friendly day header — same rendering as /notes, but anchored to the Sydney
// calendar day (notes' version pivots at UTC midnight — don't copy that).
function dayLabel(iso, today) {
  const d = new Date(iso + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function isAdmin(user) {
  const r = String((user && user.role) || '').toLowerCase();
  return r === 'admin' || r === 'management';
}

router.param('key', (req, res, next, key) => {
  const dept = getDepartment(key);
  if (!dept) {
    return res.status(404).render('error', { title: 'Not Found', message: 'Unknown department.', user: req.session.user });
  }
  if (!userCanAccessDept(req.session.user, dept)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have permission to access this department.', user: req.session.user });
  }
  req.dept = dept;
  next();
});

// Loads a meeting and 404s unless it belongs to req.dept — every meeting
// subroute goes through this so swapping :key can't reach another
// department's notebook.
function loadMeeting(req, res) {
  const m = getDb().prepare('SELECT * FROM dept_meetings WHERE id = ?').get(req.params.id);
  if (!m || m.dept_key !== req.dept.key) {
    res.status(404).render('error', { title: 'Not Found', message: 'Meeting not found.', user: req.session.user });
    return null;
  }
  return m;
}

function meetingUrl(req, id) {
  return '/departments/' + req.dept.key + '/meetings/' + id;
}

// ── Hub ─────────────────────────────────────────────────────────────────────
router.get('/:key', (req, res) => {
  const db = getDb();
  const dept = req.dept;
  const today = sydneyToday();

  // A broken tile query must never take the hub (and its meetings) down.
  let stats = [];
  try { stats = dept.stats(db, today) || []; }
  catch (e) { console.error(`[departments] ${dept.key} stats failed:`, e.message); }

  let upcoming = [], past = [];
  try {
    const withTodos = `
      SELECT m.*, (SELECT COUNT(*) FROM dept_meeting_todos t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todos
      FROM dept_meetings m WHERE m.dept_key = ?`;
    upcoming = db.prepare(`${withTodos} AND m.meeting_date >= ? ORDER BY m.meeting_date ASC, m.meeting_time ASC, m.id ASC`).all(dept.key, today);
    const pastLimit = req.query.past === 'all' ? 1000 : 15;
    past = db.prepare(`${withTodos} AND m.meeting_date < ? ORDER BY m.meeting_date DESC, m.meeting_time DESC, m.id DESC LIMIT ?`).all(dept.key, today, pastLimit);
  } catch (e) { console.error('[departments] meetings query failed:', e.message); }

  let openTodos = [];
  try {
    openTodos = db.prepare(`
      SELECT t.*, m.title AS meeting_title, m.meeting_date
      FROM dept_meeting_todos t JOIN dept_meetings m ON m.id = t.meeting_id
      WHERE t.dept_key = ? AND t.done = 0
      ORDER BY CASE t.priority WHEN 'high' THEN 0 ELSE 1 END, t.created_at ASC
    `).all(dept.key);
  } catch (e) { console.error('[departments] todos query failed:', e.message); }

  res.render('departments/home', {
    title: dept.label + ' Home',
    user: req.session.user,
    dept, stats,
    quickLinks: visibleQuickLinks(req.session.user, dept),
    upcoming, past, openTodos, today,
    pastExpanded: req.query.past === 'all',
    dayLabel: (iso) => dayLabel(iso, today),
    currentPage: 'dept-' + dept.key,
  });
});

// ── Create meeting ──────────────────────────────────────────────────────────
router.post('/:key/meetings', (req, res) => {
  const db = getDb();
  const title = String(req.body.title || '').trim();
  const date = String(req.body.meeting_date || '').trim();
  const time = String(req.body.meeting_time || '').trim();
  const attendees = String(req.body.attendees || '').trim();

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    req.flash('error', 'A meeting needs a title and a valid date.');
    return req.session.save(() => res.redirect('/departments/' + req.dept.key + '#add-meeting'));
  }

  const result = db.prepare(`
    INSERT INTO dept_meetings (dept_key, title, meeting_date, meeting_time, attendees, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.dept.key, title, date, time, attendees, req.session.user.id);

  logActivity({ user: req.session.user, action: 'create', entityType: 'dept_meeting', entityId: result.lastInsertRowid, entityLabel: `${req.dept.label}: ${title}` });
  req.flash('success', 'Meeting created.');
  req.session.save(() => res.redirect(meetingUrl(req, result.lastInsertRowid)));
});

// ── Meeting page ────────────────────────────────────────────────────────────
router.get('/:key/meetings/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();

  const todos = db.prepare('SELECT * FROM dept_meeting_todos WHERE meeting_id = ? ORDER BY done ASC, position ASC, id ASC').all(meeting.id);
  // Previous meeting for the Refresher section — computed, never stored, so
  // back-dating a meeting between two others keeps the chain correct.
  const prevMeeting = db.prepare(`
    SELECT id, title, meeting_date FROM dept_meetings
    WHERE dept_key = ? AND status = 'scheduled' AND id != ?
      AND (meeting_date < ? OR (meeting_date = ? AND id < ?))
    ORDER BY meeting_date DESC, meeting_time DESC, id DESC LIMIT 1
  `).get(req.dept.key, meeting.id, meeting.meeting_date, meeting.meeting_date, meeting.id);

  res.render('departments/meeting', {
    title: meeting.title,
    user: req.session.user,
    dept: req.dept, meeting, todos, prevMeeting,
    canDelete: meeting.created_by_id === req.session.user.id || isAdmin(req.session.user),
    currentPage: 'dept-' + req.dept.key,
  });
});

// ── Edit meeting details ────────────────────────────────────────────────────
router.post('/:key/meetings/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const title = String(req.body.title || '').trim();
  const date = String(req.body.meeting_date || '').trim();
  const time = String(req.body.meeting_time || '').trim();

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    req.flash('error', 'A meeting needs a title and a valid date.');
    return req.session.save(() => res.redirect(meetingUrl(req, meeting.id) + '#edit'));
  }

  getDb().prepare(`
    UPDATE dept_meetings SET title = ?, meeting_date = ?, meeting_time = ?, attendees = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(title, date, time, String(req.body.attendees || '').trim(), meeting.id);

  req.flash('success', 'Meeting details updated.');
  req.session.save(() => res.redirect(meetingUrl(req, meeting.id)));
});

// ── Save one notebook section ───────────────────────────────────────────────
router.post('/:key/meetings/:id/sections', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const col = SECTION_COLS[req.body.section];
  if (!col) {
    req.flash('error', 'Unknown section.');
    return req.session.save(() => res.redirect(meetingUrl(req, meeting.id)));
  }
  const content = String(req.body.content || '');
  const db = getDb();
  if (col === 'recap') {
    // Human edits always mark the recap manual; a future AI writer posts
    // source='ai' through this same endpoint.
    const source = req.body.source === 'ai' ? 'ai' : 'manual';
    db.prepare('UPDATE dept_meetings SET recap = ?, recap_source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, source, meeting.id);
  } else {
    db.prepare(`UPDATE dept_meetings SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(content, meeting.id);
  }
  req.flash('success', 'Saved.');
  req.session.save(() => res.redirect(meetingUrl(req, meeting.id) + '#section-' + req.body.section));
});

// ── To-dos ──────────────────────────────────────────────────────────────────
router.post('/:key/meetings/:id/todos', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const text = String(req.body.text || '').trim();
  const priority = req.body.priority === 'high' ? 'high' : 'low';
  if (!text) {
    req.flash('error', 'To-do text is required.');
    return req.session.save(() => res.redirect(meetingUrl(req, meeting.id) + '#section-todos'));
  }
  const db = getDb();
  db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM dept_meeting_todos WHERE meeting_id = ? AND priority = ?').get(meeting.id, priority).p;
    db.prepare(`
      INSERT INTO dept_meeting_todos (meeting_id, dept_key, text, priority, position, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(meeting.id, meeting.dept_key, text, priority, pos, req.session.user.id);
  })();
  req.session.save(() => res.redirect(meetingUrl(req, meeting.id) + '#section-todos'));
});

function toggleTodo(db, todoId, userId) {
  db.prepare(`
    UPDATE dept_meeting_todos SET
      done = CASE done WHEN 1 THEN 0 ELSE 1 END,
      done_at = CASE done WHEN 1 THEN NULL ELSE CURRENT_TIMESTAMP END,
      done_by_id = CASE done WHEN 1 THEN NULL ELSE ? END
    WHERE id = ?
  `).run(userId, todoId);
}

router.post('/:key/meetings/:id/todos/:todoId/toggle', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  const todo = db.prepare('SELECT id FROM dept_meeting_todos WHERE id = ? AND meeting_id = ?').get(req.params.todoId, meeting.id);
  if (todo) toggleTodo(db, todo.id, req.session.user.id);
  req.session.save(() => res.redirect(meetingUrl(req, meeting.id) + '#section-todos'));
});

router.post('/:key/meetings/:id/todos/:todoId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  getDb().prepare('DELETE FROM dept_meeting_todos WHERE id = ? AND meeting_id = ?').run(req.params.todoId, meeting.id);
  req.session.save(() => res.redirect(meetingUrl(req, meeting.id) + '#section-todos'));
});

// Hub-side tick — lets someone close a to-do without opening the meeting.
router.post('/:key/todos/:todoId/toggle', (req, res) => {
  const db = getDb();
  const todo = db.prepare('SELECT id FROM dept_meeting_todos WHERE id = ? AND dept_key = ?').get(req.params.todoId, req.dept.key);
  if (todo) toggleTodo(db, todo.id, req.session.user.id);
  req.session.save(() => res.redirect('/departments/' + req.dept.key));
});

// ── Cancel / restore + delete ───────────────────────────────────────────────
router.post('/:key/meetings/:id/cancel', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const next = meeting.status === 'cancelled' ? 'scheduled' : 'cancelled';
  getDb().prepare('UPDATE dept_meetings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, meeting.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'dept_meeting', entityId: meeting.id, entityLabel: `${req.dept.label}: ${meeting.title}`, details: next === 'cancelled' ? 'Meeting cancelled' : 'Meeting restored' });
  req.flash('success', next === 'cancelled' ? 'Meeting cancelled.' : 'Meeting restored.');
  req.session.save(() => res.redirect(meetingUrl(req, meeting.id)));
});

router.post('/:key/meetings/:id/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  if (meeting.created_by_id !== req.session.user.id && !isAdmin(req.session.user)) {
    req.flash('error', 'Only the meeting creator or an admin can delete a meeting.');
    return req.session.save(() => res.redirect(meetingUrl(req, meeting.id)));
  }
  getDb().prepare('DELETE FROM dept_meetings WHERE id = ?').run(meeting.id); // todos cascade
  logActivity({ user: req.session.user, action: 'delete', entityType: 'dept_meeting', entityId: meeting.id, entityLabel: `${req.dept.label}: ${meeting.title}` });
  req.flash('success', 'Meeting deleted.');
  req.session.save(() => res.redirect('/departments/' + req.dept.key));
});

module.exports = router;
