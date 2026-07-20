// Operations Tasks Board. Lets office staff allocate tasks to any
// crew member, either bound to a specific booking ("this shift only")
// or general ("standing task they carry across shifts"). The same
// shift_tasks table powers the per-booking card on bookings/show.ejs;
// this view is a global counterpart filterable by status / assignee.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const bookingNotify = require('../services/bookingNotify');
const { sydneyToday, sydneyIso, parseAsSydney } = require('../lib/sydney');
const { createTeamTask } = require('../services/returnTasks');

// Query params can arrive as arrays (e.g. two `status` fields in one form —
// the old filter strip did exactly that and crashed `.trim()`). Take the
// first value and whitelist it.
function pick(raw, allowed, fallback) {
  const v = Array.isArray(raw) ? raw[0] : raw;
  const s = (v == null ? '' : String(v)).trim();
  return allowed.includes(s) ? s : fallback;
}
// Preserve the full filter set across redirects so a status toggle or delete
// doesn't dump the user's scope/assignee selection.
function boardQuery(b) {
  const qs = new URLSearchParams();
  if (b.return_status) qs.set('status', String(b.return_status));
  if (b.return_scope) qs.set('scope', String(b.return_scope));
  if (b.return_assignee) qs.set('assignee', String(b.return_assignee));
  const s = qs.toString();
  return '/shift-tasks' + (s ? '?' + s : '');
}

// Build the deep-link + shift label for a task-assigned push. Shift-bound
// tasks open the shift's Tasks tab; general tasks land on the worker home.
function taskNotifyMeta(db, bookingId, title) {
  if (!bookingId) return { title, url: '/w/home', shift_label: '' };
  const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id = ?').get(bookingId) || {};
  const date = bk.start_datetime ? new Date(String(bk.start_datetime).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  return { title, url: '/w/booking-shift/' + bookingId + '?tab=tasks', shift_label: [date, bk.title || bk.booking_number].filter(Boolean).join(' ') };
}

// GET /shift-tasks — board view
router.get('/', (req, res) => {
  const db = getDb();
  const status = pick(req.query.status, ['pending', 'done', 'cancelled', 'all'], 'pending');
  const scope = pick(req.query.scope, ['all', 'shift', 'general'], 'all');
  const assigneeRaw = Array.isArray(req.query.assignee) ? req.query.assignee[0] : req.query.assignee;
  const assignee = assigneeRaw ? Number(assigneeRaw) || null : null;

  const where = ['1=1'];
  const params = [];
  if (status !== 'all') { where.push('st.status = ?'); params.push(status); }
  if (scope === 'shift')   { where.push('st.booking_id IS NOT NULL'); }
  if (scope === 'general') { where.push('st.booking_id IS NULL AND st.allocation_id IS NULL'); }
  if (assignee)            { where.push('st.crew_member_id = ?'); params.push(assignee); }

  // Grouped tasks (whole-crew team tasks + equipment returns) collapse to
  // ONE board row — the representative row carries group_size so the
  // assignee cell can say "Whole team · N". Status/delete forms post the
  // representative id; those routes fan by group_key.
  const rows = db.prepare(`
    SELECT st.*,
      cm.full_name AS assignee_name, cm.portal_role AS assignee_portal_role,
      b.booking_number, b.title AS booking_title, b.start_datetime,
      u.full_name AS created_by_name,
      cb.full_name AS created_by_crew_name,
      COUNT(*) AS group_size
    FROM shift_tasks st
    JOIN crew_members cm ON st.crew_member_id = cm.id
    LEFT JOIN bookings b ON st.booking_id = b.id
    LEFT JOIN users u ON st.created_by_user_id = u.id
    LEFT JOIN crew_members cb ON st.created_by_crew_id = cb.id
    WHERE ${where.join(' AND ')}
    GROUP BY COALESCE(st.group_key, 'id:' || st.id)
    ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
             st.due_at ASC, st.created_at DESC
    LIMIT 200
  `).all(...params);

  const counts = {
    pending: db.prepare("SELECT COUNT(DISTINCT COALESCE(group_key, 'id:' || id)) AS c FROM shift_tasks WHERE status='pending'").get().c,
    done:    db.prepare("SELECT COUNT(DISTINCT COALESCE(group_key, 'id:' || id)) AS c FROM shift_tasks WHERE status='done'").get().c,
    general: db.prepare("SELECT COUNT(*) AS c FROM shift_tasks WHERE booking_id IS NULL AND allocation_id IS NULL").get().c,
  };

  // Form data — active crew + a tight booking window so the picker is
  // small enough to navigate without searching. Includes (a) bookings
  // currently in progress (start ≤ now ≤ end) and (b) anything kicking
  // off in the next 3 days. Older / further-out bookings are excluded;
  // dispatch is the planning surface for those.
  const crew = db.prepare("SELECT id, full_name, portal_role FROM crew_members WHERE active = 1 ORDER BY portal_role DESC, full_name ASC").all();
  let bookings = [];
  try {
    bookings = db.prepare(`
      SELECT id, booking_number, title, suburb, start_datetime, end_datetime,
        DATE(start_datetime) AS shift_date
      FROM bookings
      WHERE deleted_at IS NULL
        AND status NOT IN ('cancelled','late_cancellation','complete','finalised')
        AND (
          (datetime(start_datetime) <= datetime('now') AND datetime(end_datetime) >= datetime('now'))
          OR (date(start_datetime) BETWEEN date('now') AND date('now','+3 days'))
        )
      ORDER BY start_datetime ASC
    `).all();
  } catch (e) { /* legacy DB */ }

  // Bucket bookings into Today / Tomorrow / In N days / Ongoing — the EJS
  // renders these as <optgroup>s and as visual day-pills above the select.
  // All in SYDNEY terms: the server runs in UTC, so raw Date/toISOString
  // labelled the wrong day during Sydney mornings, and naive wall-clock
  // start/end strings must be parsed with their Sydney offset attached.
  const todayIso = sydneyToday();
  const tomorrow = sydneyIso(new Date(Date.now() + 86400000));
  const nowMs = Date.now();
  const bookingGroups = {
    ongoing: [], today: [], tomorrow: [], later: [],
  };
  for (const b of bookings) {
    const start = parseAsSydney(b.start_datetime);
    const end = parseAsSydney(b.end_datetime);
    const startMs = start ? start.getTime() : NaN;
    const endMs = end ? end.getTime() : NaN;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && endMs >= nowMs) bookingGroups.ongoing.push(b);
    else if (b.shift_date === todayIso)     bookingGroups.today.push(b);
    else if (b.shift_date === tomorrow)     bookingGroups.tomorrow.push(b);
    else                                     bookingGroups.later.push(b);
  }

  res.render('shift-tasks/index', {
    title: 'Tasks Board',
    rows, counts, status, scope, assignee, crew, bookings, bookingGroups,
  });
});

// POST /shift-tasks — create
router.post('/', (req, res) => {
  const db = getDb();
  const { crew_member_id, scope, booking_id, title, description, priority, due_at } = req.body;
  if (!crew_member_id || !title || !title.trim()) {
    req.flash('error', 'Title and assignee are required.');
    return req.session.save(() => res.redirect('/shift-tasks'));
  }
  // Whole-team task: needs a shift roster to fan to — a "team" general
  // task would mean the whole company, which is the office tasks system's
  // job. Branched BEFORE any booking_crew/parseInt handling ('team' isn't
  // a crew id).
  if (crew_member_id === 'team') {
    if (scope === 'general' || !booking_id) {
      req.flash('error', 'Team tasks need a shift — pick a booking, or assign a general task to one person.');
      return req.session.save(() => res.redirect('/shift-tasks'));
    }
    const group = createTeamTask(db, parseInt(booking_id, 10), {
      title: title.trim(),
      description: (description || '').trim(),
      priority: ['low','normal','high'].includes(priority) ? priority : 'normal',
      dueAt: due_at || null,
      createdByUserId: req.session.user.id,
    });
    if (!group) {
      req.flash('error', 'No crew on that booking yet — add workers first.');
      return req.session.save(() => res.redirect('/shift-tasks'));
    }
    logActivity({ user: req.session.user, action: 'create', entityType: 'shift_task', details: 'Created team task: ' + title.trim() + ' (' + group.crewIds.length + ' crew)', req });
    bookingNotify.notifyTaskAssigned(group.crewIds, taskNotifyMeta(db, booking_id, title.trim()));
    req.flash('success', 'Team task created — whole crew (' + group.crewIds.length + '), first to finish ticks it off for everyone.');
    return req.session.save(() => res.redirect('/shift-tasks'));
  }
  let bookingScope = null, allocScope = null;
  if (scope !== 'general') {
    if (!booking_id) {
      req.flash('error', 'Pick a shift, or mark the task as general.');
      return req.session.save(() => res.redirect('/shift-tasks'));
    }
    // Assignee must be on this booking — block cross-booking task drops.
    const ok = db.prepare("SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(booking_id, crew_member_id);
    if (!ok) {
      req.flash('error', "Worker isn't assigned to that booking.");
      return req.session.save(() => res.redirect('/shift-tasks'));
    }
    bookingScope = booking_id;
    const alloc = db.prepare("SELECT id FROM crew_allocations WHERE booking_id=? AND crew_member_id=? LIMIT 1").get(booking_id, crew_member_id);
    if (alloc) allocScope = alloc.id;
  }
  db.prepare(`
    INSERT INTO shift_tasks (allocation_id, booking_id, crew_member_id, title, description, priority, due_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    allocScope, bookingScope, crew_member_id, title.trim(), (description || '').trim(),
    ['low','normal','high'].includes(priority) ? priority : 'normal',
    due_at || null, req.session.user.id
  );
  logActivity({ user: req.session.user, action: 'create', entityType: 'shift_task', details: 'Created task: ' + title.trim(), req });
  // Ping the worker it was assigned to.
  bookingNotify.notifyTaskAssigned([crew_member_id], taskNotifyMeta(db, bookingScope, title.trim()));
  req.flash('success', scope === 'general' ? 'General task created.' : 'Shift task created.');
  req.session.save(() => res.redirect('/shift-tasks'));
});

// POST /shift-tasks/:id/status — toggle / set status. Grouped tasks
// (equipment returns + whole-crew Team tasks) move as one — this route
// previously updated only the single row, leaving a return-task group
// half done here while the bookings-card route fanned it; group_key
// unifies both.
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const status = ['pending','done','cancelled'].includes(req.body.status) ? req.body.status : 'pending';
  const completedAt = status === 'done' ? "datetime('now')" : 'NULL';
  const t = db.prepare('SELECT group_key, booking_equipment_id FROM shift_tasks WHERE id = ?').get(req.params.id);
  if (t && (t.group_key || t.booking_equipment_id)) {
    const key = t.group_key ? 'group_key' : 'booking_equipment_id';
    db.prepare(`
      UPDATE shift_tasks
      SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now')
      WHERE ${key} = ?
    `).run(status, t.group_key || t.booking_equipment_id);
  } else {
    db.prepare(`
      UPDATE shift_tasks
      SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, req.params.id);
  }
  res.redirect(boardQuery(req.body));
});

// POST /shift-tasks/:id/update — inline edit from the board: title,
// assignee, priority, due. Reassignment on a shift-bound task keeps the
// same booking_crew guard as create; the allocation link follows the new
// assignee. Notifies the new worker when the task changes hands.
router.post('/:id/update', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM shift_tasks WHERE id = ?').get(req.params.id);
  if (!task) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect(boardQuery(req.body))); }
  const b = req.body;
  const title = (b.title || '').trim() || task.title;
  const priority = ['low', 'normal', 'high'].includes(b.priority) ? b.priority : task.priority;
  const dueAt = b.due_at === undefined ? task.due_at : (b.due_at || null);
  // Grouped tasks (team / equipment return): title/priority/due edits fan
  // to every row; reassignment makes no sense for a whole-crew task.
  if (task.group_key) {
    if (b.crew_member_id && String(b.crew_member_id) !== 'team' && parseInt(b.crew_member_id, 10) !== task.crew_member_id) {
      req.flash('error', 'Team tasks belong to the whole crew — delete it and create a personal task instead.');
      return req.session.save(() => res.redirect(boardQuery(b)));
    }
    db.prepare(`
      UPDATE shift_tasks SET title=?, priority=?, due_at=?, updated_at=datetime('now')
      WHERE group_key=?
    `).run(title, priority, dueAt, task.group_key);
    logActivity({ user: req.session.user, action: 'update', entityType: 'shift_task', entityId: task.id, details: 'Edited team task: ' + title, req });
    req.flash('success', 'Task updated for the whole crew.');
    return req.session.save(() => res.redirect(boardQuery(b)));
  }
  let crewId = parseInt(b.crew_member_id, 10) || task.crew_member_id;
  let allocId = task.allocation_id;
  if (crewId !== task.crew_member_id) {
    if (task.booking_id) {
      const ok = db.prepare('SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?').get(task.booking_id, crewId);
      if (!ok) { req.flash('error', "Worker isn't assigned to that task's booking."); return req.session.save(() => res.redirect(boardQuery(b))); }
      const alloc = db.prepare('SELECT id FROM crew_allocations WHERE booking_id=? AND crew_member_id=? LIMIT 1').get(task.booking_id, crewId);
      allocId = alloc ? alloc.id : null;
    } else {
      allocId = null;
    }
  }
  db.prepare(`
    UPDATE shift_tasks SET title=?, crew_member_id=?, allocation_id=?, priority=?, due_at=?, updated_at=datetime('now')
    WHERE id=?
  `).run(title, crewId, allocId, priority, dueAt, req.params.id);
  if (crewId !== task.crew_member_id) {
    try { bookingNotify.notifyTaskAssigned([crewId], taskNotifyMeta(db, task.booking_id, title)); } catch (e) {}
  }
  logActivity({ user: req.session.user, action: 'update', entityType: 'shift_task', entityId: task.id, details: 'Edited task: ' + title, req });
  req.flash('success', 'Task updated.');
  req.session.save(() => res.redirect(boardQuery(b)));
});

// POST /shift-tasks/:id/delete — grouped tasks delete as one; return
// tasks also clear the gear's opt-in (parity with the bookings-card
// route) so the next allocation change doesn't resurrect the group.
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const t = db.prepare('SELECT group_key, booking_equipment_id FROM shift_tasks WHERE id = ?').get(req.params.id);
  if (t && t.booking_equipment_id) {
    try { db.prepare('UPDATE booking_equipment SET return_task = 0 WHERE id = ?').run(t.booking_equipment_id); } catch (e) {}
  }
  if (t && t.group_key) {
    db.prepare('DELETE FROM shift_tasks WHERE group_key = ?').run(t.group_key);
  } else if (t && t.booking_equipment_id) {
    db.prepare('DELETE FROM shift_tasks WHERE booking_equipment_id = ?').run(t.booking_equipment_id);
  } else {
    db.prepare('DELETE FROM shift_tasks WHERE id = ?').run(req.params.id);
  }
  req.flash('success', 'Task removed.');
  req.session.save(() => res.redirect(boardQuery(req.body)));
});

module.exports = router;
