// Admin Leave Approvals — single dashboard for approving worker leave
// requests. Lives in the Operations sidebar. Mirrors the worker manager
// flow at /w/manage/leave but with a richer organising layout (status
// chips, time buckets, search, employee filter) so an ops co-ordinator
// reviewing dozens of requests at once isn't drowning in a flat list.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

// GET /leave-approvals
router.get('/', requirePermission('leave_approvals'), (req, res) => {
  const db = getDb();
  const status = (req.query.status || 'pending').trim();   // pending | approved | rejected | all
  const crewId = req.query.crew_member_id ? Number(req.query.crew_member_id) : null;
  const search = (req.query.q || '').trim();

  const where = ['1=1'];
  const params = [];
  if (status !== 'all') { where.push('l.status = ?'); params.push(status); }
  if (crewId) { where.push('l.crew_member_id = ?'); params.push(crewId); }
  if (search) {
    where.push('(cm.full_name LIKE ? OR cm.employee_id LIKE ? OR l.reason LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s);
  }

  const rows = db.prepare(`
    SELECT l.*, cm.full_name AS crew_name, cm.employee_id AS crew_emp_id,
      cm.phone AS crew_phone, cm.portal_role,
      u.full_name AS approver_name
    FROM employee_leave l
    JOIN crew_members cm ON cm.id = l.crew_member_id
    LEFT JOIN users u ON u.id = l.approved_by_id
    WHERE ${where.join(' AND ')}
    ORDER BY
      CASE l.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
      l.start_date ASC,
      l.created_at DESC
    LIMIT 300
  `).all(...params);

  // Bucket pending requests by urgency so ops sees the time-sensitive
  // ones first. Anything that started already or is starting in the
  // next 7 days = "Action now"; the rest of this month = "This month";
  // further out = "Later".
  const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const in7 = new Date(Date.now() + 7 * 86400000).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const monthEnd = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1, 0);
    return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  })();

  const buckets = { actionNow: [], thisMonth: [], later: [], decided: [] };
  for (const r of rows) {
    if (r.status !== 'pending') { buckets.decided.push(r); continue; }
    if (r.start_date <= in7) buckets.actionNow.push(r);
    else if (r.start_date <= monthEnd) buckets.thisMonth.push(r);
    else buckets.later.push(r);
  }

  // Counts for the status chips at the top.
  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM employee_leave WHERE status = 'pending'").get().c,
    approved: db.prepare("SELECT COUNT(*) AS c FROM employee_leave WHERE status = 'approved'").get().c,
    rejected: db.prepare("SELECT COUNT(*) AS c FROM employee_leave WHERE status = 'rejected'").get().c,
    actionNow: rows.filter(r => r.status === 'pending' && r.start_date <= in7).length,
  };

  // Crew dropdown for the assignee filter.
  const crew = db.prepare(`
    SELECT DISTINCT cm.id, cm.full_name
    FROM crew_members cm
    JOIN employee_leave l ON l.crew_member_id = cm.id
    ORDER BY cm.full_name ASC
  `).all();

  res.render('leave-approvals/index', {
    title: 'Leave Approvals',
    rows, buckets, counts, status, crewId, search, crew,
    todayIso,
  });
});

// POST /leave-approvals/:id/:action
router.post('/:id/:action', requirePermission('leave_approvals'), (req, res) => {
  const db = getDb();
  const action = req.params.action;
  if (!['approve', 'reject', 'cancel'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return req.session.save(() => res.redirect('/leave-approvals'));
  }
  const newStatus = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'cancelled';

  const row = db.prepare('SELECT * FROM employee_leave WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Leave not found.'); return req.session.save(() => res.redirect('/leave-approvals')); }

  // Cancel is a "second-decision" override — the leave was already
  // approved (or pending) but ops needs to retract it (worker recalled,
  // shift came up, mistake on submission, etc.). Allowed from any
  // current state; we just stamp the new status + actor.
  db.prepare(`
    UPDATE employee_leave
    SET status = ?, approved_by_id = ?, approved_at = datetime('now')
    WHERE id = ?
  `).run(newStatus, req.session.user.id, req.params.id);

  const verbMap = { approve: 'approved', reject: 'rejected', cancel: 'cancelled' };
  logActivity({
    user: req.session.user,
    action,
    entityType: 'employee_leave', entityId: row.id,
    entityLabel: `${row.start_date} → ${row.end_date} leave`,
    details: `Leave ${verbMap[action]} from admin dashboard (was ${row.status})`,
    ip: req.ip,
  });

  const flashMap = {
    approve: 'Leave approved.',
    reject: 'Leave rejected.',
    cancel: 'Leave cancelled — the worker can re-submit if they need to.',
  };
  req.flash('success', flashMap[action]);
  const ref = req.get('referrer') || '/leave-approvals';
  req.session.save(() => res.redirect(ref.includes('/leave-approvals') ? ref : '/leave-approvals'));
});

// POST /leave-approvals/bulk — approve / reject all checked rows in one go.
router.post('/bulk', requirePermission('leave_approvals'), (req, res) => {
  const db = getDb();
  const action = req.body.action;
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.map(Number).filter(Boolean);
  if (!['approve','reject'].includes(action) || ids.length === 0) {
    req.flash('error', 'Pick at least one request and an action.');
    return req.session.save(() => res.redirect('/leave-approvals'));
  }
  const newStatus = action === 'approve' ? 'approved' : 'rejected';
  const upd = db.prepare(`UPDATE employee_leave SET status = ?, approved_by_id = ?, approved_at = datetime('now') WHERE id = ? AND status = 'pending'`);
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = upd.run(newStatus, req.session.user.id, id);
      if (r.changes > 0) n++;
    }
  });
  tx();
  logActivity({
    user: req.session.user, action: action === 'approve' ? 'approve' : 'reject',
    entityType: 'employee_leave', details: `Bulk ${newStatus} ${n} leave request${n === 1 ? '' : 's'}`,
    ip: req.ip,
  });
  req.flash('success', `${n} leave request${n === 1 ? '' : 's'} ${newStatus}.`);
  req.session.save(() => res.redirect('/leave-approvals'));
});

module.exports = router;
