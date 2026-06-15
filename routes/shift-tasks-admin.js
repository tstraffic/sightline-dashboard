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
  const status = (req.query.status || 'pending').trim();   // pending | done | cancelled | all
  const scope = (req.query.scope || 'all').trim();          // all | shift | general
  const assignee = req.query.assignee ? Number(req.query.assignee) : null;

  const where = ['1=1'];
  const params = [];
  if (status !== 'all') { where.push('st.status = ?'); params.push(status); }
  if (scope === 'shift')   { where.push('st.booking_id IS NOT NULL'); }
  if (scope === 'general') { where.push('st.booking_id IS NULL AND st.allocation_id IS NULL'); }
  if (assignee)            { where.push('st.crew_member_id = ?'); params.push(assignee); }

  const rows = db.prepare(`
    SELECT st.*,
      cm.full_name AS assignee_name, cm.portal_role AS assignee_portal_role,
      b.booking_number, b.title AS booking_title, b.start_datetime,
      u.full_name AS created_by_name,
      cb.full_name AS created_by_crew_name
    FROM shift_tasks st
    JOIN crew_members cm ON st.crew_member_id = cm.id
    LEFT JOIN bookings b ON st.booking_id = b.id
    LEFT JOIN users u ON st.created_by_user_id = u.id
    LEFT JOIN crew_members cb ON st.created_by_crew_id = cb.id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
             CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
             st.due_at ASC, st.created_at DESC
    LIMIT 200
  `).all(...params);

  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM shift_tasks WHERE status='pending'").get().c,
    done:    db.prepare("SELECT COUNT(*) AS c FROM shift_tasks WHERE status='done'").get().c,
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
  const todayIso = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const nowMs = Date.now();
  const bookingGroups = {
    ongoing: [], today: [], tomorrow: [], later: [],
  };
  for (const b of bookings) {
    const startMs = new Date(b.start_datetime).getTime();
    const endMs   = new Date(b.end_datetime).getTime();
    if (startMs <= nowMs && endMs >= nowMs) bookingGroups.ongoing.push(b);
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
    return res.redirect('/shift-tasks');
  }
  let bookingScope = null, allocScope = null;
  if (scope !== 'general') {
    if (!booking_id) {
      req.flash('error', 'Pick a shift, or mark the task as general.');
      return res.redirect('/shift-tasks');
    }
    // Assignee must be on this booking — block cross-booking task drops.
    const ok = db.prepare("SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(booking_id, crew_member_id);
    if (!ok) {
      req.flash('error', "Worker isn't assigned to that booking.");
      return res.redirect('/shift-tasks');
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
  res.redirect('/shift-tasks');
});

// POST /shift-tasks/:id/status — toggle / set status
router.post('/:id/status', (req, res) => {
  const status = ['pending','done','cancelled'].includes(req.body.status) ? req.body.status : 'pending';
  const completedAt = status === 'done' ? "datetime('now')" : 'NULL';
  getDb().prepare(`
    UPDATE shift_tasks
    SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, req.params.id);
  res.redirect('/shift-tasks?status=' + (req.body.return_status || 'pending'));
});

// POST /shift-tasks/:id/delete
router.post('/:id/delete', (req, res) => {
  getDb().prepare('DELETE FROM shift_tasks WHERE id = ?').run(req.params.id);
  req.flash('success', 'Task removed.');
  res.redirect('/shift-tasks?status=' + (req.body.return_status || 'pending'));
});

module.exports = router;
