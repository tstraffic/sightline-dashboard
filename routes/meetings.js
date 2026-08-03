// routes/meetings.js — Company Meetings: the weekly all-of-company minutes.
// Minutes are a list of discussion items, each optionally tagged to a
// department, each with optional to-dos. Department hubs render their tagged
// slice straight from these tables (routes/departments.js) — same rows, so a
// tick on a hub is a tick here. Mounted behind requirePermission('meetings')
// (admin/management); the hub slice is how everyone else consumes it.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sydneyToday } = require('../lib/sydney');
const { DEPARTMENTS, DEPARTMENT_ORDER } = require('../lib/departments');

// Friendly day header — same rendering as the dept hubs, anchored to the
// Sydney calendar day (routes/departments.js dayLabel; notes' UTC version is
// the wrong one to copy).
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

// Dept tag vocabulary = the live department registry, so a new department is
// taggable the moment it exists. '' / unknown => NULL (a general item).
function deptOptions() {
  return DEPARTMENT_ORDER.map((k) => ({ key: k, label: DEPARTMENTS[k].label }));
}
function normaliseDeptKey(raw) {
  const key = String(raw || '').trim();
  return DEPARTMENT_ORDER.includes(key) ? key : null;
}

// Loads a meeting and 404s when missing — every subroute goes through this.
function loadMeeting(req, res) {
  const m = getDb().prepare('SELECT * FROM company_meetings WHERE id = ?').get(req.params.id);
  if (!m) {
    res.status(404).render('error', { title: 'Not Found', message: 'Meeting not found.', user: req.session.user });
    return null;
  }
  return m;
}

function meetingUrl(id) {
  return '/meetings/' + id;
}

// Same 3-CASE toggle as the dept notebook's — duplicated per house style
// rather than parameterising the table name.
function toggleTodo(db, todoId, userId) {
  db.prepare(`
    UPDATE company_meeting_todos SET
      done = CASE done WHEN 1 THEN 0 ELSE 1 END,
      done_at = CASE done WHEN 1 THEN NULL ELSE CURRENT_TIMESTAMP END,
      done_by_id = CASE done WHEN 1 THEN NULL ELSE ? END
    WHERE id = ?
  `).run(userId, todoId);
}

// ── Register ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const today = sydneyToday();

  let upcoming = [], past = [];
  try {
    const withTodos = `
      SELECT m.*, (SELECT COUNT(*) FROM company_meeting_todos t WHERE t.meeting_id = m.id AND t.done = 0) AS open_todos
      FROM company_meetings m`;
    upcoming = db.prepare(`${withTodos} WHERE m.meeting_date >= ? ORDER BY m.meeting_date ASC, m.meeting_time ASC, m.id ASC`).all(today);
    const pastLimit = req.query.past === 'all' ? 1000 : 15;
    past = db.prepare(`${withTodos} WHERE m.meeting_date < ? ORDER BY m.meeting_date DESC, m.meeting_time DESC, m.id DESC LIMIT ?`).all(today, pastLimit);
  } catch (e) { console.error('[meetings] register query failed:', e.message); }

  let openTodos = [];
  try {
    openTodos = db.prepare(`
      SELECT t.*, m.title AS meeting_title, m.meeting_date
      FROM company_meeting_todos t JOIN company_meetings m ON m.id = t.meeting_id
      WHERE t.done = 0
      ORDER BY CASE t.priority WHEN 'high' THEN 0 ELSE 1 END, t.created_at ASC
    `).all();
  } catch (e) { console.error('[meetings] todos query failed:', e.message); }

  res.render('meetings/index', {
    title: 'Meetings',
    user: req.session.user,
    upcoming, past, openTodos, today,
    depts: deptOptions(),
    pastExpanded: req.query.past === 'all',
    dayLabel: (iso) => dayLabel(iso, today),
    currentPage: 'meetings',
  });
});

// ── Create meeting ──────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const db = getDb();
  const title = String(req.body.title || '').trim();
  const date = String(req.body.meeting_date || '').trim();
  const time = String(req.body.meeting_time || '').trim();
  const attendees = String(req.body.attendees || '').trim();

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    req.flash('error', 'A meeting needs a title and a valid date.');
    return req.session.save(() => res.redirect('/meetings#add-meeting'));
  }

  const result = db.prepare(`
    INSERT INTO company_meetings (title, meeting_date, meeting_time, attendees, created_by_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, date, time, attendees, req.session.user.id);

  try {
    logActivity({ user: req.session.user, action: 'create', entityType: 'company_meeting', entityId: result.lastInsertRowid, entityLabel: title, ip: req.ip });
  } catch (e) { /* never block the write */ }
  req.flash('success', 'Meeting created.');
  req.session.save(() => res.redirect(meetingUrl(result.lastInsertRowid)));
});

// ── Meeting page ────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();

  const items = db.prepare('SELECT * FROM company_meeting_items WHERE meeting_id = ? ORDER BY position ASC, id ASC').all(meeting.id);
  const todos = db.prepare('SELECT * FROM company_meeting_todos WHERE meeting_id = ? ORDER BY done ASC, position ASC, id ASC').all(meeting.id);

  // Group todos under their item; item_id NULL (meeting-level adds, or
  // orphans left behind by an item delete) go to the General bucket.
  const todosByItem = new Map();
  const generalTodos = [];
  for (const t of todos) {
    if (t.item_id != null && items.some((i) => i.id === t.item_id)) {
      if (!todosByItem.has(t.item_id)) todosByItem.set(t.item_id, []);
      todosByItem.get(t.item_id).push(t);
    } else {
      generalTodos.push(t);
    }
  }

  res.render('meetings/show', {
    title: meeting.title,
    user: req.session.user,
    meeting, items, todosByItem, generalTodos,
    depts: deptOptions(),
    canDelete: meeting.created_by_id === req.session.user.id || isAdmin(req.session.user),
    currentPage: 'meetings',
  });
});

// ── Edit meeting details ────────────────────────────────────────────────────
router.post('/:id', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const title = String(req.body.title || '').trim();
  const date = String(req.body.meeting_date || '').trim();
  const time = String(req.body.meeting_time || '').trim();

  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || (time && !/^\d{2}:\d{2}$/.test(time))) {
    req.flash('error', 'A meeting needs a title and a valid date.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#edit'));
  }

  getDb().prepare(`
    UPDATE company_meetings SET title = ?, meeting_date = ?, meeting_time = ?, attendees = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(title, date, time, String(req.body.attendees || '').trim(), meeting.id);

  req.flash('success', 'Meeting details updated.');
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// ── Discussion items ────────────────────────────────────────────────────────
router.post('/:id/items', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const body = String(req.body.body || '').trim();
  const deptKey = normaliseDeptKey(req.body.dept_key);
  if (!body) {
    req.flash('error', 'A discussion item needs some text.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#add-item'));
  }
  const db = getDb();
  db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM company_meeting_items WHERE meeting_id = ?').get(meeting.id).p;
    db.prepare(`
      INSERT INTO company_meeting_items (meeting_id, dept_key, body, position, created_by_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(meeting.id, deptKey, body, pos, req.session.user.id);
  })();
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#add-item'));
});

// Item must belong to the meeting in the URL before any mutation.
function loadItem(req, meetingId) {
  return getDb().prepare('SELECT * FROM company_meeting_items WHERE id = ? AND meeting_id = ?').get(req.params.itemId, meetingId);
}

router.post('/:id/items/:itemId', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const item = loadItem(req, meeting.id);
  if (!item) {
    req.flash('error', 'Item not found.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  const body = String(req.body.body || '').trim();
  const deptKey = normaliseDeptKey(req.body.dept_key);
  if (!body) {
    req.flash('error', 'A discussion item needs some text.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#item-' + item.id));
  }
  const db = getDb();
  // Re-tagging an item moves its to-dos' hub slice with it — dept_key on the
  // todo is a denormalised copy of the item's, kept in lockstep here.
  db.transaction(() => {
    db.prepare('UPDATE company_meeting_items SET body = ?, dept_key = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(body, deptKey, item.id);
    db.prepare('UPDATE company_meeting_todos SET dept_key = ? WHERE item_id = ?').run(deptKey, item.id);
  })();
  req.flash('success', 'Saved.');
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + '#item-' + item.id));
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const item = loadItem(req, meeting.id);
  if (item) {
    // Todos survive via ON DELETE SET NULL, keeping their dept tag — an open
    // action item is never destroyed by tidying the minutes.
    getDb().prepare('DELETE FROM company_meeting_items WHERE id = ?').run(item.id);
  }
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// ── To-dos ──────────────────────────────────────────────────────────────────
router.post('/:id/todos', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const text = String(req.body.text || '').trim();
  const priority = req.body.priority === 'high' ? 'high' : 'low';
  if (!text) {
    req.flash('error', 'To-do text is required.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  const db = getDb();
  // Optional item link — must belong to this meeting; the todo inherits the
  // item's dept tag (that inheritance is what routes it to a hub).
  let item = null;
  if (req.body.item_id) {
    item = db.prepare('SELECT * FROM company_meeting_items WHERE id = ? AND meeting_id = ?').get(req.body.item_id, meeting.id);
  }
  db.transaction(() => {
    const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM company_meeting_todos WHERE meeting_id = ? AND priority = ?').get(meeting.id, priority).p;
    db.prepare(`
      INSERT INTO company_meeting_todos (meeting_id, item_id, dept_key, text, priority, position, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(meeting.id, item ? item.id : null, item ? item.dept_key : null, text, priority, pos, req.session.user.id);
  })();
  const anchor = item ? '#item-' + item.id : '#general-todos';
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + anchor));
});

router.post('/:id/todos/:todoId/toggle', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const db = getDb();
  const todo = db.prepare('SELECT id, item_id FROM company_meeting_todos WHERE id = ? AND meeting_id = ?').get(req.params.todoId, meeting.id);
  if (todo) toggleTodo(db, todo.id, req.session.user.id);
  const anchor = todo && todo.item_id ? '#item-' + todo.item_id : '#general-todos';
  req.session.save(() => res.redirect(meetingUrl(meeting.id) + anchor));
});

router.post('/:id/todos/:todoId/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  getDb().prepare('DELETE FROM company_meeting_todos WHERE id = ? AND meeting_id = ?').run(req.params.todoId, meeting.id);
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

// Register-side tick — close a to-do from the /meetings list page.
router.post('/todos/:todoId/toggle', (req, res) => {
  const db = getDb();
  const todo = db.prepare('SELECT id FROM company_meeting_todos WHERE id = ?').get(req.params.todoId);
  if (todo) toggleTodo(db, todo.id, req.session.user.id);
  req.session.save(() => res.redirect('/meetings'));
});

// ── Cancel / restore + delete ───────────────────────────────────────────────
router.post('/:id/cancel', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  const next = meeting.status === 'cancelled' ? 'scheduled' : 'cancelled';
  getDb().prepare('UPDATE company_meetings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, meeting.id);
  try {
    logActivity({ user: req.session.user, action: 'update', entityType: 'company_meeting', entityId: meeting.id, entityLabel: meeting.title, details: next === 'cancelled' ? 'Meeting cancelled' : 'Meeting restored', ip: req.ip });
  } catch (e) { /* ignore */ }
  req.flash('success', next === 'cancelled' ? 'Meeting cancelled.' : 'Meeting restored.');
  req.session.save(() => res.redirect(meetingUrl(meeting.id)));
});

router.post('/:id/delete', (req, res) => {
  const meeting = loadMeeting(req, res);
  if (!meeting) return;
  if (meeting.created_by_id !== req.session.user.id && !isAdmin(req.session.user)) {
    req.flash('error', 'Only the meeting creator or an admin can delete a meeting.');
    return req.session.save(() => res.redirect(meetingUrl(meeting.id)));
  }
  getDb().prepare('DELETE FROM company_meetings WHERE id = ?').run(meeting.id); // items + todos cascade
  try {
    logActivity({ user: req.session.user, action: 'delete', entityType: 'company_meeting', entityId: meeting.id, entityLabel: meeting.title, ip: req.ip });
  } catch (e) { /* ignore */ }
  req.flash('success', 'Meeting deleted.');
  req.session.save(() => res.redirect('/meetings'));
});

module.exports = router;
