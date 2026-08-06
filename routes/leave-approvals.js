// Admin Leave Approvals — the office's queue for deciding worker leave.
// Lives in the Operations sidebar.
//
// The one thing to understand here: employee_leave stores ONE ROW PER
// CALENDAR DAY (the worker submitter fans a submission out into a row per
// date with start_date = end_date). Every row of a submission carries the
// same request_group_id (migration 343), so this module works in REQUESTS,
// not days — one card, one date range, one decision. Without that grouping
// a Mon-Fri booking-off arrives as five separate approve/reject decisions.
//
// employee_leave.notes is the DECISION NOTE (why ops rejected). The
// worker's own words live in `reason`.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { sydneyToday } = require('../lib/sydney');

const STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const LEAVE_TYPES = ['annual', 'sick', 'personal', 'unpaid', 'other'];
const BOOKING_DEAD = "('cancelled','complete','late_cancellation','finalised')";

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Tell the worker what happened. Best-effort on both channels: a push
// failure must never roll back or 500 an approval that already committed.
function notifyWorker(crewMemberId, status, startDate, endDate, dayCount, note) {
  if (!crewMemberId || (status !== 'approved' && status !== 'rejected')) return;
  let sendPushToCrew;
  try { ({ sendPushToCrew } = require('../services/pushNotification')); } catch (e) { return; }
  const span = startDate === endDate
    ? startDate
    : `${startDate} → ${endDate} (${dayCount} day${dayCount === 1 ? '' : 's'})`;
  const approved = status === 'approved';
  sendPushToCrew(crewMemberId, {
    title: approved ? 'Leave approved' : 'Leave not approved',
    body: approved
      ? `Your leave for ${span} has been approved.`
      : `Your leave for ${span} was declined.${note ? ' Reason: ' + note : ' Speak to your supervisor.'}`,
    url: '/w/hr/leave',
    type: approved ? 'leave_approved' : 'leave_rejected',
    category: 'leave_decision',
  }).catch(err => console.error('[leave decision push] crew', crewMemberId, ':', err.message));
}

// GET /leave-approvals
router.get('/', requirePermission('leave_approvals'), (req, res) => {
  const db = getDb();

  const status = STATUSES.includes(req.query.status) || req.query.status === 'all'
    ? req.query.status : 'pending';
  const leaveType = LEAVE_TYPES.includes(req.query.leave_type) ? req.query.leave_type : '';
  const crewId = req.query.crew_member_id ? Number(req.query.crew_member_id) : null;
  const search = (req.query.q || '').trim();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  const view = req.query.view === 'calendar' ? 'calendar' : 'list';

  const where = ['1=1'];
  const params = [];
  if (status !== 'all') { where.push('l.status = ?'); params.push(status); }
  if (leaveType) { where.push('l.leave_type = ?'); params.push(leaveType); }
  if (crewId) { where.push('l.crew_member_id = ?'); params.push(crewId); }
  // Overlap, not containment — a request spanning the window should match.
  if (from) { where.push('l.end_date >= ?'); params.push(from); }
  if (to) { where.push('l.start_date <= ?'); params.push(to); }
  if (search) {
    where.push('(cm.full_name LIKE ? OR cm.employee_id LIKE ? OR l.reason LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  // One row per REQUEST. Grouped by status as well as group id so a
  // part-cancelled submission shows its parts honestly rather than
  // collapsing into whichever status won the aggregate.
  // LEFT JOIN crew_members: a row whose crew member was deleted must still
  // surface here — it counts toward the sidebar badge, so hiding it left an
  // unclearable badge with no visible row.
  const requests = db.prepare(`
    SELECT
      l.request_group_id                AS group_id,
      l.status                          AS status,
      l.crew_member_id                  AS crew_member_id,
      l.leave_type                      AS leave_type,
      l.shift_period                    AS shift_period,
      MIN(l.start_date)                 AS start_date,
      MAX(l.end_date)                   AS end_date,
      COUNT(*)                          AS day_count,
      SUM(IFNULL(l.total_days, 1))      AS days,
      GROUP_CONCAT(l.id)                AS row_ids,
      MIN(l.created_at)                 AS created_at,
      MAX(l.approved_at)                AS approved_at,
      MAX(l.reason)                     AS reason,
      MAX(l.notes)                      AS decision_note,
      MAX(cm.full_name)                 AS crew_name,
      MAX(cm.employee_id)               AS crew_emp_id,
      MAX(cm.phone)                     AS crew_phone,
      MAX(cm.portal_role)               AS portal_role,
      MAX(u.full_name)                  AS approver_name
    FROM employee_leave l
    LEFT JOIN crew_members cm ON cm.id = l.crew_member_id
    LEFT JOIN users u ON u.id = l.approved_by_id
    WHERE ${where.join(' AND ')}
    GROUP BY l.request_group_id, l.status
    ORDER BY
      CASE l.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
      MIN(l.start_date) ASC,
      MIN(l.created_at) DESC
    LIMIT 400
  `).all(...params);

  // ── Decision context ────────────────────────────────────────────────
  // Two set-based queries over the whole pending window, matched in JS —
  // never one query per request.
  const pending = requests.filter(r => r.status === 'pending');
  if (pending.length) {
    const winStart = pending.reduce((a, r) => (r.start_date < a ? r.start_date : a), pending[0].start_date);
    const winEnd = pending.reduce((a, r) => (r.end_date > a ? r.end_date : a), pending[0].end_date);

    // Already rostered on a live booking inside the requested dates?
    let shifts = [];
    try {
      shifts = db.prepare(`
        SELECT bc.crew_member_id AS crew_id, DATE(b.start_datetime) AS d
        FROM booking_crew bc
        JOIN bookings b ON b.id = bc.booking_id
        WHERE b.deleted_at IS NULL
          AND b.status NOT IN ${BOOKING_DEAD}
          AND DATE(b.start_datetime) BETWEEN ? AND ?
      `).all(winStart, winEnd);
    } catch (e) { shifts = []; }

    // How many OTHER people are already approved off across those dates?
    let othersOff = [];
    try {
      othersOff = db.prepare(`
        SELECT crew_member_id AS crew_id, start_date AS d
        FROM employee_leave
        WHERE status = 'approved' AND start_date BETWEEN ? AND ?
      `).all(winStart, winEnd);
    } catch (e) { othersOff = []; }

    for (const r of pending) {
      r.clash_days = shifts.filter(s =>
        s.crew_id === r.crew_member_id && s.d >= r.start_date && s.d <= r.end_date).length;
      r.others_off = new Set(othersOff
        .filter(o => o.crew_id !== r.crew_member_id && o.d >= r.start_date && o.d <= r.end_date)
        .map(o => o.crew_id)).size;
    }
  }

  // ── Urgency buckets (pending only) ──────────────────────────────────
  const todayIso = sydneyToday();
  const in7 = addDays(todayIso, 7);
  const monthEnd = (() => {
    const [y, m] = todayIso.split('-').map(Number);
    const last = new Date(Date.UTC(y, m, 0));           // day 0 of next month
    return last.toISOString().slice(0, 10);
  })();

  const buckets = { actionNow: [], thisMonth: [], later: [], decided: [] };
  for (const r of requests) {
    if (r.status !== 'pending') { buckets.decided.push(r); continue; }
    if (r.start_date <= in7) buckets.actionNow.push(r);
    else if (r.start_date <= monthEnd) buckets.thisMonth.push(r);
    else buckets.later.push(r);
  }

  // ── Counts ──────────────────────────────────────────────────────────
  // Every count is its own DISTINCT-request query. The old code derived
  // actionNow from the already-status-filtered row set, so the tile read 0
  // on every tab except Pending.
  const countBy = (sql, ...a) => db.prepare(sql).get(...a).c;
  const counts = {
    pending: countBy("SELECT COUNT(DISTINCT request_group_id) AS c FROM employee_leave WHERE status = 'pending'"),
    approved: countBy("SELECT COUNT(DISTINCT request_group_id) AS c FROM employee_leave WHERE status = 'approved'"),
    rejected: countBy("SELECT COUNT(DISTINCT request_group_id) AS c FROM employee_leave WHERE status = 'rejected'"),
    cancelled: countBy("SELECT COUNT(DISTINCT request_group_id) AS c FROM employee_leave WHERE status = 'cancelled'"),
    actionNow: countBy("SELECT COUNT(DISTINCT request_group_id) AS c FROM employee_leave WHERE status = 'pending' AND start_date <= ?", in7),
  };
  counts.all = counts.pending + counts.approved + counts.rejected + counts.cancelled;

  const crew = db.prepare(`
    SELECT DISTINCT cm.id, cm.full_name
    FROM crew_members cm
    JOIN employee_leave l ON l.crew_member_id = cm.id
    WHERE cm.full_name IS NOT NULL
    ORDER BY cm.full_name ASC
  `).all();

  // ── Calendar month ──────────────────────────────────────────────────
  let calendar = null;
  if (view === 'calendar') {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayIso.slice(0, 7);
    const [cy, cm] = month.split('-').map(Number);
    const first = new Date(Date.UTC(cy, cm - 1, 1));
    const last = new Date(Date.UTC(cy, cm, 0));
    const monthStart = first.toISOString().slice(0, 10);
    const monthEndIso = last.toISOString().slice(0, 10);

    const dayRows = db.prepare(`
      SELECT l.start_date AS d, l.status, l.shift_period, l.leave_type,
             cm.full_name AS crew_name
      FROM employee_leave l
      LEFT JOIN crew_members cm ON cm.id = l.crew_member_id
      WHERE l.status IN ('approved','pending')
        AND l.start_date BETWEEN ? AND ?
      ORDER BY l.status ASC, cm.full_name ASC
    `).all(monthStart, monthEndIso);

    const byDate = {};
    for (const r of dayRows) (byDate[r.d] = byDate[r.d] || []).push(r);

    // Monday-start grid, padded to whole weeks.
    const startPad = (first.getUTCDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < startPad; i++) cells.push(null);
    for (let d = 1; d <= last.getUTCDate(); d++) {
      const iso = new Date(Date.UTC(cy, cm - 1, d)).toISOString().slice(0, 10);
      cells.push({ iso, day: d, isToday: iso === todayIso, people: byDate[iso] || [] });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

    calendar = {
      month,
      label: first.toLocaleDateString('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' }),
      prev: new Date(Date.UTC(cy, cm - 2, 1)).toISOString().slice(0, 7),
      next: new Date(Date.UTC(cy, cm, 1)).toISOString().slice(0, 7),
      weeks,
    };
  }

  res.render('leave-approvals/index', {
    title: 'Leave Approvals',
    buckets, counts, crew, calendar,
    filters: { status, leave_type: leaveType, crew_member_id: crewId || '', q: search, from, to, view },
    todayIso,
  });
});

// Where to send the user back to after a decision — keeps their filters.
function backTo(req) {
  const ref = req.get('referrer') || '';
  return ref.includes('/leave-approvals') ? ref : '/leave-approvals';
}

// POST /leave-approvals/bulk — decide several requests at once.
// Declared before /:groupId/:action so "bulk" is never read as a group id.
router.post('/bulk', requirePermission('leave_approvals'), (req, res) => {
  const db = getDb();
  const action = req.body.action;
  // partials/bulk-actions posts a comma string; a plain form posts ids[].
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = typeof ids === 'string' ? ids.split(',') : (ids ? [ids] : []);
  const groupIds = ids.map(s => String(s).trim()).filter(Boolean);

  if (!['approve', 'reject'].includes(action) || groupIds.length === 0) {
    req.flash('error', 'Pick at least one request and an action.');
    return req.session.save(() => res.redirect(backTo(req)));
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const note = (req.body.decision_note || '').trim() || null;

  const targets = db.prepare(`
    SELECT request_group_id AS gid, crew_member_id, MIN(start_date) AS start_date,
           MAX(end_date) AS end_date, COUNT(*) AS day_count
    FROM employee_leave
    WHERE status = 'pending' AND request_group_id IN (${groupIds.map(() => '?').join(',')})
    GROUP BY request_group_id
  `).all(...groupIds);

  const upd = db.prepare(`
    UPDATE employee_leave
    SET status = ?, approved_by_id = ?, approved_at = datetime('now'), notes = COALESCE(?, notes)
    WHERE request_group_id = ? AND status = 'pending'
  `);
  let n = 0;
  db.transaction(() => {
    for (const t of targets) { upd.run(newStatus, req.session.user.id, note, t.gid); n++; }
  })();

  logActivity({
    user: req.session.user, action,
    entityType: 'employee_leave',
    details: `Bulk ${newStatus} ${n} leave request${n === 1 ? '' : 's'}`,
    ip: req.ip,
  });
  for (const t of targets) notifyWorker(t.crew_member_id, newStatus, t.start_date, t.end_date, t.day_count, note);

  req.flash('success', `${n} leave request${n === 1 ? '' : 's'} ${newStatus}.`);
  req.session.save(() => res.redirect(backTo(req)));
});

// POST /leave-approvals/:groupId/:action — decide one whole request.
router.post('/:groupId/:action', requirePermission('leave_approvals'), (req, res) => {
  const db = getDb();
  const action = req.params.action;
  if (!['approve', 'reject', 'cancel'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return req.session.save(() => res.redirect(backTo(req)));
  }
  const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';
  const note = (req.body.decision_note || '').trim() || null;

  const g = db.prepare(`
    SELECT crew_member_id, MIN(start_date) AS start_date, MAX(end_date) AS end_date,
           COUNT(*) AS day_count, MAX(status) AS a_status
    FROM employee_leave WHERE request_group_id = ?
  `).get(req.params.groupId);
  if (!g || !g.start_date) {
    req.flash('error', 'Leave request not found.');
    return req.session.save(() => res.redirect(backTo(req)));
  }

  // Approve/reject only ever move a PENDING request — without the guard two
  // coordinators hitting different buttons both "succeed" and last write
  // wins, and a rejected request could be silently re-approved.
  // Cancel is the deliberate retraction path (worker recalled, mistake on
  // submission) so it stays unguarded, exactly as before.
  const guard = action === 'cancel' ? '' : " AND status = 'pending'";
  const r = db.prepare(`
    UPDATE employee_leave
    SET status = ?, approved_by_id = ?, approved_at = datetime('now'), notes = COALESCE(?, notes)
    WHERE request_group_id = ?${guard}
  `).run(newStatus, req.session.user.id, note, req.params.groupId);

  if (r.changes === 0) {
    req.flash('error', 'Nothing to do — that request was already decided by someone else.');
    return req.session.save(() => res.redirect(backTo(req)));
  }

  const verbMap = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };
  logActivity({
    user: req.session.user,
    action,
    entityType: 'employee_leave', entityId: null,
    entityLabel: `${g.start_date} → ${g.end_date} leave`,
    details: `Leave ${verbMap[action]} from admin dashboard (${r.changes} day${r.changes === 1 ? '' : 's'}, group ${req.params.groupId})`,
    ip: req.ip,
  });
  notifyWorker(g.crew_member_id, newStatus, g.start_date, g.end_date, g.day_count, note);

  const flashMap = {
    approve: `Leave approved — ${r.changes} day${r.changes === 1 ? '' : 's'}.`,
    reject: 'Leave rejected — the worker has been notified.',
    cancel: 'Leave cancelled — the worker can re-submit if they need to.',
  };
  req.flash('success', flashMap[action]);
  req.session.save(() => res.redirect(backTo(req)));
});

module.exports = router;
