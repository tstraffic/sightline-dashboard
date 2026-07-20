// Manager-only surfaces inside the worker portal. Gives Taj/Saadat/Suhail and
// any other flagged manager a today-overview, shift board, leave approvals and
// kudos moderation — all from the same app workers use.

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { requireManager } = require('../../middleware/managerAuth');
const { logActivity } = require('../../middleware/audit');
const { hideKudos } = require('../../services/kudos');
const { getWeather, geocodeAddress } = require('../../services/homeContext');

function localIso(d) {
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ==========================================================
// GET /w/manage — Manager overview
// ==========================================================
router.get('/manage', requireManager, (req, res) => {
  const db = getDb();
  const today = localIso(new Date());

  // Today's shifts
  const shifts = db.prepare(`
    SELECT ca.id, ca.crew_member_id, ca.allocation_date, ca.start_time, ca.end_time, ca.shift_type, ca.status,
           cm.full_name as crew_name, cm.employee_id as crew_emp_id,
           j.id as job_id, j.job_number, j.client, j.suburb
    FROM crew_allocations ca
    JOIN crew_members cm ON cm.id = ca.crew_member_id
    JOIN jobs j ON j.id = ca.job_id
    WHERE ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.start_time ASC, cm.full_name ASC
  `).all(today);

  // Clock-in state per crew member today
  const clockRows = db.prepare(`
    SELECT crew_member_id, event_type, MAX(event_time) as at FROM clock_events
    WHERE DATE(event_time) = ? GROUP BY crew_member_id
  `).all(today);
  const clockMap = new Map(clockRows.map(r => [r.crew_member_id, r]));

  let clockedIn = 0, startingSoon = 0, late = 0;
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  shifts.forEach(s => {
    const [sh, sm] = (s.start_time || '06:00').split(':').map(Number);
    const startMin = (sh || 0) * 60 + (sm || 0);
    const c = clockMap.get(s.crew_member_id);
    if (c && c.event_type === 'clock_in') { s.clockState = 'in'; clockedIn++; }
    else if (c && c.event_type === 'clock_out') s.clockState = 'out';
    else if (nowMin >= startMin - 30 && nowMin < startMin) { s.clockState = 'pending'; startingSoon++; }
    else if (nowMin >= startMin && (!c || c.event_type !== 'clock_in')) { s.clockState = 'late'; late++; }
    else s.clockState = 'scheduled';
  });

  // Pending leave count
  const pendingLeave = db.prepare("SELECT COUNT(*) as c FROM employee_leave WHERE status = 'pending'").get().c;

  // Open incidents (if table exists)
  let openIncidents = 0;
  try { openIncidents = db.prepare("SELECT COUNT(*) as c FROM incidents WHERE status IN ('open','investigating')").get().c; } catch (e) {}

  // Kudos reports
  let pendingReports = 0;
  try { pendingReports = db.prepare("SELECT COUNT(*) as c FROM kudos_reports WHERE status = 'pending'").get().c; } catch (e) {}

  // Active crew count today (distinct workers allocated)
  const activeCrew = new Set(shifts.map(s => s.crew_member_id)).size;

  res.render('worker/manage', {
    title: 'Manage', currentPage: 'manage',
    shifts, kpis: { activeCrew, clockedIn, startingSoon, late, pendingLeave, openIncidents, pendingReports },
  });
});

// ==========================================================
// GET /w/manage/shifts — Full shift board for today
// ==========================================================
router.get('/manage/shifts', requireManager, async (req, res) => {
  const db = getDb();
  const dateParam = (req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.date : localIso(new Date());

  const shifts = db.prepare(`
    SELECT ca.id, ca.crew_member_id, ca.allocation_date, ca.start_time, ca.end_time, ca.shift_type, ca.status, ca.role_on_site,
           cm.full_name as crew_name, cm.employee_id as crew_emp_id, cm.phone as crew_phone,
           j.id as job_id, j.job_number, j.client, j.site_address, j.suburb,
           u.full_name as supervisor_name
    FROM crew_allocations ca
    JOIN crew_members cm ON cm.id = ca.crew_member_id
    JOIN jobs j ON j.id = ca.job_id
    LEFT JOIN users u ON u.id = j.ops_supervisor_id
    WHERE ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY j.client ASC, ca.start_time ASC, cm.full_name ASC
  `).all(dateParam);

  const clockRows = db.prepare(`
    SELECT crew_member_id, event_type, event_time FROM clock_events
    WHERE DATE(event_time) = ?
    ORDER BY event_time DESC
  `).all(dateParam);
  const latestByCrew = {};
  for (const r of clockRows) { if (!latestByCrew[r.crew_member_id]) latestByCrew[r.crew_member_id] = r; }

  // Group by job
  const byJob = new Map();
  for (const s of shifts) {
    const c = latestByCrew[s.crew_member_id];
    s.clockLabel = c ? (c.event_type === 'clock_in' ? 'On site since ' + new Date(c.event_time).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' }) : 'Clocked off ' + new Date(c.event_time).toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', minute: '2-digit' })) : 'Not clocked on';
    s.clockState = c ? c.event_type : 'none';
    if (!byJob.has(s.job_id)) byJob.set(s.job_id, { job_number: s.job_number, client: s.client, suburb: s.suburb, site_address: s.site_address, supervisor: s.supervisor_name, members: [] });
    byJob.get(s.job_id).members.push(s);
  }

  // Fetch weather for each site in parallel. Cached in-process for 1h so repeat loads
  // of the manager board on the same day cost nothing extra.
  const jobList = Array.from(byJob.values());
  await Promise.all(jobList.map(async (j) => {
    try {
      const q = [j.suburb, j.site_address].filter(Boolean).join(', ');
      if (!q) return;
      const geo = await geocodeAddress(q);
      if (!geo) return;
      const w = await getWeather(geo.lat, geo.lng);
      if (w) j.weather = w;
    } catch (e) { /* weather is best-effort */ }
  }));

  res.render('worker/manage-shifts', {
    title: 'All shifts', currentPage: 'manage',
    date: dateParam, jobs: jobList,
  });
});

// ==========================================================
// GET /w/manage/leave — Pending leave requests
// ==========================================================
router.get('/manage/leave', requireManager, (req, res) => {
  const db = getDb();
  const pending = db.prepare(`
    SELECT l.*, cm.full_name as crew_name, cm.employee_id as crew_emp_id
    FROM employee_leave l
    JOIN crew_members cm ON cm.id = l.crew_member_id
    WHERE l.status = 'pending'
    ORDER BY l.start_date ASC
  `).all();
  res.render('worker/manage-leave', {
    title: 'Leave approvals', currentPage: 'manage',
    pending,
  });
});

router.post('/manage/leave/:id/:action', requireManager, (req, res) => {
  const db = getDb();
  const action = req.params.action;
  if (!['approve', 'reject'].includes(action)) return res.redirect('/w/manage/leave');
  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // linked user id for the manager — used as approved_by_id if present
  const mgr = db.prepare(`
    SELECT e.linked_user_id FROM employees e WHERE e.linked_crew_member_id = ?
  `).get(req.session.worker.id);
  const approverId = mgr && mgr.linked_user_id ? mgr.linked_user_id : null;

  const row = db.prepare('SELECT * FROM employee_leave WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Leave not found.'); return req.session.save(() => res.redirect('/w/manage/leave')); }

  db.prepare(`UPDATE employee_leave SET status = ?, approved_by_id = ?, approved_at = datetime('now') WHERE id = ?`)
    .run(newStatus, approverId, req.params.id);

  logActivity({
    user: { id: approverId, full_name: `Manager (portal): ${req.session.worker.full_name}` },
    action: action === 'approve' ? 'approve' : 'reject',
    entityType: 'employee_leave', entityId: row.id, entityLabel: `${row.start_date} leave`,
    details: `Leave ${newStatus} from worker portal`,
    ip: req.ip,
  });

  req.flash('success', action === 'approve' ? 'Leave approved.' : 'Leave rejected.');
  req.session.save(() => res.redirect('/w/manage/leave'));
});

// ==========================================================
// GET /w/manage/kudos — Kudos moderation queue
// ==========================================================
router.get('/manage/kudos', requireManager, (req, res) => {
  const db = getDb();
  const reports = db.prepare(`
    SELECT r.*, cm.full_name as reporter_name,
           k.message as kudos_message, k.hidden_at,
           s.full_name as sender_name
    FROM kudos_reports r
    JOIN crew_members cm ON cm.id = r.reporter_crew_id
    LEFT JOIN kudos k ON k.id = r.kudos_id
    LEFT JOIN crew_members s ON s.id = k.sender_crew_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all();
  // No flash re-read — workerLocals already consumed it into res.locals;
  // reading again returns [] and shadows the layout's banner.
  res.render('worker/manage-kudos', {
    title: 'Kudos moderation', currentPage: 'manage',
    reports,
  });
});

router.post('/manage/kudos/:id/hide', requireManager, (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM kudos_reports WHERE id = ?').get(req.params.id);
  if (!report) { req.flash('error', 'Report not found.'); return req.session.save(() => res.redirect('/w/manage/kudos')); }
  const mgr = db.prepare('SELECT linked_user_id FROM employees WHERE linked_crew_member_id = ?').get(req.session.worker.id);
  const userId = mgr && mgr.linked_user_id ? mgr.linked_user_id : null;
  if (report.kudos_id) hideKudos({ kudosId: report.kudos_id, userId, reason: 'Manager hid from portal' });
  if (report.comment_id) db.prepare("UPDATE kudos_comments SET hidden_at = datetime('now') WHERE id = ?").run(report.comment_id);
  db.prepare("UPDATE kudos_reports SET status = 'actioned' WHERE id = ?").run(req.params.id);
  req.flash('success', 'Hidden and report closed.');
  req.session.save(() => res.redirect('/w/manage/kudos'));
});

router.post('/manage/kudos/:id/dismiss', requireManager, (req, res) => {
  const db = getDb();
  db.prepare("UPDATE kudos_reports SET status = 'dismissed' WHERE id = ?").run(req.params.id);
  req.flash('success', 'Report dismissed.');
  req.session.save(() => res.redirect('/w/manage/kudos'));
});

module.exports = router;
