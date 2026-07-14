const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');
const {
  getUrgencyKpis,
  getOpsData,
  getFinanceData,
  getChartData,
  getMyWork,
  getMyTasks,
  getTasksIAssigned,
  getComplianceUrgent,
  getMyPlans,
  getRecentActivity,
} = require('./helpers/dashboard-queries');
const { todaysBirthdays } = require('../lib/birthdays');

router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const today = new Date().toISOString().split('T')[0];

  // Always-needed data
  const urgency = getUrgencyKpis(db, today, req.session.user);
  const ops = getOpsData(db, today);
  const charts = getChartData(db);
  const myWork = getMyWork(db, user, today);
  const myTasks = getMyTasks(db, user, today);
  const tasksIAssigned = getTasksIAssigned(db, user, today);
  const complianceUrgent = getComplianceUrgent(db, today);
  const myPlans = getMyPlans(db, user.id, today);
  const recentActivity = getRecentActivity(db);

  // Plans Module dashboard data (spec §6/§7/§8): upcoming submissions / job
  // dates, CTMP QA status chips, and surfaced ROL condition alerts. Wrapped
  // so a query issue can never take down the dashboard.
  let plansAttention = { upcoming: [], ctmps: [], rolAlerts: [] };
  try {
    const next14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    plansAttention.upcoming = db.prepare(`
      SELECT tp.id, tp.plan_number, tp.plan_types, tp.status, tp.job_date, tp.submitted_date,
             tp.client_required_date, tp.rol_summary_from, j.job_number,
             COALESCE(NULLIF(tp.job_date,''), NULLIF(tp.rol_summary_from,''), NULLIF(tp.client_required_date,'')) AS key_date
      FROM traffic_plans tp LEFT JOIN jobs j ON tp.job_id = j.id
      WHERE tp.status NOT IN ('rejected','expired')
        AND COALESCE(NULLIF(tp.job_date,''), NULLIF(tp.rol_summary_from,''), NULLIF(tp.client_required_date,'')) IS NOT NULL
        AND COALESCE(NULLIF(tp.job_date,''), NULLIF(tp.rol_summary_from,''), NULLIF(tp.client_required_date,'')) <= ?
      ORDER BY key_date ASC LIMIT 8
    `).all(next14);
    plansAttention.ctmps = db.prepare(`
      SELECT c.id, c.ctmp_number, c.title, c.current_revision_label, c.qa_status, c.plan_id, j.job_number
      FROM ctmps c LEFT JOIN jobs j ON c.job_id = j.id
      WHERE c.qa_status != 'approved'
      ORDER BY c.updated_at DESC LIMIT 8
    `).all();
    plansAttention.rolAlerts = db.prepare(`
      SELECT rc.text, tp.id AS plan_id, tp.plan_number, j.job_number
      FROM rol_conditions rc
      JOIN traffic_plans tp ON rc.plan_id = tp.id
      LEFT JOIN jobs j ON tp.job_id = j.id
      WHERE rc.is_alert = 1 AND tp.status NOT IN ('rejected','expired')
      ORDER BY rc.id DESC LIMIT 8
    `).all();
  } catch (e) { console.error('[dashboard] plans widget failed:', e.message); }

  // Finance data (role-gated)
  const finance = canViewAccounts(user) ? getFinanceData(db) : { totalContractValue: 0, totalSpend: 0, accountsOverdue: 0, accountsDisputed: 0 };

  // Jobs needing attention
  const last7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const needsAttention = db.prepare(`
    SELECT j.*, u.full_name as pm_name FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status = 'active'
    AND (j.health IN ('red','amber') OR j.last_update_date IS NULL OR j.last_update_date < ?)
    ORDER BY CASE j.health WHEN 'red' THEN 1 WHEN 'amber' THEN 2 ELSE 3 END
    LIMIT 15
  `).all(last7);

  // Build action items from urgency data
  const actionItems = [];
  if (urgency.overdueTasks > 0) actionItems.push({ icon: 'task', color: 'red', text: `${urgency.overdueTasks} overdue task${urgency.overdueTasks !== 1 ? 's' : ''}`, link: '/tasks' });
  if (urgency.overdueCompliance > 0) actionItems.push({ icon: 'shield', color: 'red', text: `${urgency.overdueCompliance} overdue compliance item${urgency.overdueCompliance !== 1 ? 's' : ''}`, link: '/compliance' });
  if (urgency.openIncidents > 0) actionItems.push({ icon: 'alert', color: 'red', text: `${urgency.openIncidents} open incident${urgency.openIncidents !== 1 ? 's' : ''}`, link: '/incidents' });
  if (urgency.missingUpdates > 0) actionItems.push({ icon: 'update', color: 'orange', text: `${urgency.missingUpdates} job${urgency.missingUpdates !== 1 ? 's' : ''} missing weekly update`, link: '/jobs?status=active' });
  if (urgency.unconfirmedAllocations > 0) actionItems.push({ icon: 'crew', color: 'orange', text: `${urgency.unconfirmedAllocations} unconfirmed allocation${urgency.unconfirmedAllocations !== 1 ? 's' : ''} today`, link: '/allocations' });
  if (urgency.ticketsExpiring > 0) actionItems.push({ icon: 'ticket', color: 'orange', text: `${urgency.ticketsExpiring} crew ticket${urgency.ticketsExpiring !== 1 ? 's' : ''} expiring soon`, link: '/hr/roster' });
  if (urgency.pendingTimesheets > 0) actionItems.push({ icon: 'clock', color: 'orange', text: `${urgency.pendingTimesheets} pending timesheet${urgency.pendingTimesheets !== 1 ? 's' : ''}`, link: '/timesheets?approved=0' });
  if (urgency.crewGaps > 0) actionItems.push({ icon: 'crew', color: 'red', text: `${urgency.crewGaps} crew gap${urgency.crewGaps !== 1 ? 's' : ''} today`, link: '/allocations' });

  // Bookings about to start (today / tomorrow) that don't have any site
  // documents attached yet. Workers landing on a shift expect at least a TGS;
  // this nudges allocators to upload one before the crew rolls up. We treat
  // either a booking_documents row OR a job_documents row on the same job as
  // "covered" so re-using a job-level pack doesn't trigger a false alarm.
  let bookingsMissingDocs = 0;
  let missingDocsList = [];
  try {
    // Fetch the actual rows so the dashboard widget below can list them
    // ("J-1234 — Acme Construction · Tue 13 May 07:00") instead of just the
    // count. Cap at 5 — anything more is paginated through /bookings.
    missingDocsList = db.prepare(`
      SELECT b.id, b.booking_number, b.title, b.start_datetime, b.suburb,
        j.job_number, j.client AS job_client
      FROM bookings b
      LEFT JOIN jobs j ON b.job_id = j.id
      WHERE b.status IN ('confirmed','green_to_go','unconfirmed')
        AND b.deleted_at IS NULL
        AND date(b.start_datetime) BETWEEN date('now') AND date('now','+1 day')
        AND NOT EXISTS (SELECT 1 FROM booking_documents bd WHERE bd.booking_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM job_documents jd WHERE jd.job_id = b.job_id AND jd.archived_at IS NULL)
      ORDER BY b.start_datetime ASC
      LIMIT 25
    `).all();
    bookingsMissingDocs = missingDocsList.length;
  } catch (e) { /* booking_documents or job_documents table may be missing on legacy DBs */ }
  if (bookingsMissingDocs > 0) {
    actionItems.push({
      icon: 'doc',
      color: 'orange',
      text: `${bookingsMissingDocs} booking${bookingsMissingDocs !== 1 ? 's' : ''} starting soon with no site docs`,
      link: '/bookings?missing_docs=1',
    });
  }

  // Checklist Register summary for the dashboard widget. Whole computation
  // lives in services/checklistRegister.js — this is just the cheap pull.
  let checklistSummary = null;
  try {
    checklistSummary = require('../services/checklistRegister').dashboardSummary(db);
  } catch (e) {
    console.error('[dashboard] checklist register summary failed:', e.message);
  }

  // Fleet compliance summary — small attention card linking to /fleet/compliance.
  // Skipped silently if the fleet tables don't exist yet (e.g. legacy DB
  // before migration 235) or the user can't access the fleet module.
  let fleetCompliance = null;
  try {
    const { canAccess } = require('../middleware/auth');
    if (canAccess(user, 'fleet')) {
      const { badgesFor } = require('../lib/fleetStatus');
      const rows = db.prepare("SELECT * FROM vehicle_summary WHERE status != 'Retired'").all();
      const flagged = rows.filter(v => {
        const b = badgesFor(v, today);
        return ['registration','service','inspection','fireExt'].some(k => b[k].tone === 'bad' || b[k].tone === 'warn');
      });
      if (flagged.length > 0) {
        fleetCompliance = {
          count: flagged.length,
          sample: flagged.slice(0, 5).map(v => ({
            id: v.id,
            asset_id: v.asset_id,
            rego: v.rego,
            status: v.status,
            badges: badgesFor(v, today),
          })),
        };
      }
    }
  } catch (e) { /* fleet tables not migrated yet on a legacy DB */ }

  // Today's birthdays — surfaced as a banner above the KPI tiles when at
  // least one active crew member's DOB is today (Sydney). Failures are
  // non-fatal so legacy DBs without the join still load the dashboard.
  let birthdaysToday = [];
  try { birthdaysToday = todaysBirthdays(db); }
  catch (e) { console.error('[dashboard] birthdays lookup failed:', e.message); }

  // Onboarding checklist
  let onboarding = null;
  try {
    const prefs = JSON.parse(db.prepare('SELECT preferences FROM users WHERE id = ?').get(user.id)?.preferences || '{}');
    if (!prefs.onboarding_dismissed) {
      const isAdmin = user.role === 'admin';
      const checks = [];
      checks.push({ key: 'profile', label: 'Update your profile', link: '/profile', done: !!user.email });
      if (isAdmin) {
        const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const jobCount = db.prepare("SELECT COUNT(*) as c FROM jobs").get().c;
        const crewCount = db.prepare("SELECT COUNT(*) as c FROM crew_members").get().c;
        checks.push({ key: 'users', label: 'Add a team member', link: '/admin/users', done: userCount > 1 });
        checks.push({ key: 'job', label: 'Create first job', link: '/jobs/new', done: jobCount > 0 });
        checks.push({ key: 'crew', label: 'Add crew member', link: '/crew/new', done: crewCount > 0 });
        checks.push({ key: 'settings', label: 'Configure dropdowns', link: '/settings', done: false });
      }
      checks.push({ key: 'notifications', label: 'Enable push notifications', link: '/profile', done: false });
      const allDone = checks.every(c => c.done);
      if (!allDone) onboarding = checks;
    }
  } catch (e) { /* preferences column may not exist yet */ }

  res.render('dashboard', {
    title: 'Today',
    user,
    onboarding,
    kpi: {
      activeJobs: ops.activeJobs,
      startingSoon: ops.startingSoon,
      crewHoursThisWeek: ops.crewHoursThisWeek,
      equipmentDeployed: ops.equipmentDeployed,
      rolPending: ops.rolPending,
      tmpPending: ops.tmpPending,
      ...urgency,
      ...finance,
    },
    myJobs: myWork.myJobs,
    needsAttention,
    recentUpdates: myWork.recentUpdates,
    overdueTasksList: myWork.overdueTasksList,
    complianceUrgent,
    actionItems,
    checklistSummary,
    missingDocsList,
    jobStatusDist: charts.jobStatusDist,
    jobHealthDist: charts.jobHealthDist,
    crewHoursByDay: charts.crewHoursByDay,
    canViewAccounts: canViewAccounts(user),
    todaysAllocations: ops.todaysAllocations,
    totalActiveCrew: ops.totalActiveCrew,
    allocatedToday: ops.allocatedToday,
    availableCrew: ops.availableCrew,
    recentActivity,
    myTasks,
    myPlans,
    plansAttention,
    tasksIAssigned,
    userRole: user.role,
    birthdaysToday,
    fleetCompliance,
  });
});

module.exports = router;
