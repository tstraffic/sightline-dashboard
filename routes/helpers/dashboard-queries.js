// Dashboard query helpers — extracted for clarity and role-based filtering
const { HEALTH_CALC_SQL } = require('../../middleware/jobHealth');
const { isAdminRole } = require('../../lib/taskVisibility');

// Date arithmetic on a Sydney YYYY-MM-DD string. The server runs UTC, so any
// `new Date(Date.now() ± n days).toISOString()` here would flip to the wrong
// calendar day for up to 11 hours around Sydney midnight — every window must
// derive from the caller's sydneyToday() string instead.
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

// Crew with a shift today according to the tables the app actually writes.
// The live scheduling flow (bookings + booking_crew) superseded
// crew_allocations, which only the legacy create path still populates — a
// count on crew_allocations alone reads 0 forever (the "CREW TODAY 0/233"
// bug). Count both, deduped, so legacy rows still show.
const CREW_TODAY_SQL = `
  SELECT COUNT(*) AS c FROM (
    SELECT bc.crew_member_id AS id
    FROM booking_crew bc
    JOIN bookings b ON b.id = bc.booking_id
    WHERE date(b.start_datetime) = date(?)
      AND b.deleted_at IS NULL
      AND b.status NOT IN ('cancelled','late_cancellation')
      AND bc.status != 'declined'
    UNION
    SELECT crew_member_id AS id FROM crew_allocations WHERE allocation_date = ?
  )`;

function getUrgencyKpis(db, today, user) {
  const next30 = addDays(today, 30);
  const last7 = addDays(today, -7);
  const userRole = user ? (user.role || '').toLowerCase() : '';
  const userId = user ? user.id : 0;
  const isPlanningRole = userRole === 'planning';
  const hideAdmin = !isAdminRole(user);

  // Planning only sees planning division + own + compliance-linked tasks
  const taskFilter = isPlanningRole
    ? `AND (division = 'planning' OR owner_id = ${userId} OR compliance_id IS NOT NULL)`
    : '';
  // Everyone but admin/management has admin-division tasks hidden
  const adminGuard = hideAdmin ? " AND division != 'admin'" : '';

  return {
    overdueTasks: db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE due_date < ? AND status != 'complete' AND deleted_at IS NULL ${taskFilter}${adminGuard}`).get(today).c,
    openIncidents: db.prepare("SELECT COUNT(*) as c FROM incidents WHERE investigation_status NOT IN ('closed', 'resolved')").get().c,
    unconfirmedAllocations: db.prepare("SELECT COUNT(*) as c FROM crew_allocations WHERE allocation_date = ? AND status = 'allocated'").get(today).c,
    // Canonical overdue definition — submitted-inclusive, matching the
    // /compliance page summary. A submitted-but-unapproved plan past its due
    // date still needs chasing; excluding 'submitted' here made this tile
    // read 2 while the table below it showed 10.
    overdueCompliance: db.prepare("SELECT COUNT(*) as c FROM compliance WHERE due_date < ? AND status NOT IN ('approved','expired')").get(today).c,
    ticketsExpiring: db.prepare(`
      SELECT COUNT(*) as c FROM crew_members WHERE active = 1 AND (
        (tc_ticket_expiry IS NOT NULL AND tc_ticket_expiry BETWEEN ? AND ?)
        OR (ti_ticket_expiry IS NOT NULL AND ti_ticket_expiry BETWEEN ? AND ?)
        OR (white_card_expiry IS NOT NULL AND white_card_expiry BETWEEN ? AND ?)
        OR (first_aid_expiry IS NOT NULL AND first_aid_expiry BETWEEN ? AND ?)
        OR (medical_expiry IS NOT NULL AND medical_expiry BETWEEN ? AND ?)
      )
    `).get(today, next30, today, next30, today, next30, today, next30, today, next30).c,
    missingUpdates: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'active' AND (last_update_date IS NULL OR last_update_date < ?)").get(last7).c,
    overdueCorrectiveActions: db.prepare("SELECT COUNT(*) as c FROM corrective_actions WHERE due_date < ? AND status != 'completed'").get(today).c,
    notifiableIncidents: db.prepare("SELECT COUNT(*) as c FROM incidents WHERE notifiable_incident = 1 AND investigation_status NOT IN ('closed', 'resolved')").get().c,
    pendingTimesheets: db.prepare("SELECT COUNT(*) as c FROM timesheets WHERE approved = 0").get().c,
    crewGaps: db.prepare(`
      SELECT COUNT(*) as c FROM crew_allocations ca
      JOIN jobs j ON ca.job_id = j.id
      WHERE ca.allocation_date = ? AND ca.status = 'allocated' AND j.status = 'active'
      AND ca.crew_member_id NOT IN (SELECT id FROM crew_members WHERE active = 1)
    `).get(today).c,
  };
}

function getOpsData(db, today) {
  const next14 = addDays(today, 14);

  const activeJobs = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE status = 'active'").get().c;
  const startingSoon = db.prepare("SELECT COUNT(*) as c FROM jobs WHERE start_date BETWEEN ? AND ? AND status IN ('won','active')").get(today, next14).c;
  const crewHoursThisWeek = db.prepare("SELECT COALESCE(SUM(total_hours), 0) as t FROM timesheets WHERE work_date >= date(?, '-7 days')").get(today).t;
  const equipmentDeployed = db.prepare("SELECT COUNT(*) as c FROM equipment_assignments WHERE actual_return_date IS NULL").get().c;
  const totalActiveCrew = db.prepare("SELECT COUNT(*) as c FROM crew_members WHERE active = 1").get().c;
  const allocatedToday = db.prepare(CREW_TODAY_SQL).get(today, today).c;
  const rolPending = db.prepare("SELECT COUNT(*) as c FROM traffic_plans WHERE rol_required = 1 AND (rol_approved IS NULL OR rol_approved = 0) AND status NOT IN ('rejected','expired')").get().c;
  const tmpPending = db.prepare("SELECT COUNT(*) as c FROM traffic_plans WHERE plan_type = 'TMP' AND status NOT IN ('approved','rejected','expired')").get().c;

  const todaysAllocations = db.prepare(`
    SELECT ca.*, cm.full_name as crew_name, cm.role as crew_role, j.job_number, j.client, j.site_address
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.allocation_date = ?
    ORDER BY ca.start_time ASC
  `).all(today);

  return {
    activeJobs, startingSoon, crewHoursThisWeek, equipmentDeployed,
    totalActiveCrew, allocatedToday, availableCrew: totalActiveCrew - allocatedToday,
    todaysAllocations, rolPending, tmpPending,
  };
}

function getFinanceData(db) {
  return {
    totalContractValue: db.prepare("SELECT COALESCE(SUM(contract_value), 0) as t FROM job_budgets").get().t,
    totalSpend: db.prepare("SELECT COALESCE(SUM(amount), 0) as t FROM cost_entries").get().t,
    accountsOverdue: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE accounts_status = 'overdue'").get().c,
    accountsDisputed: db.prepare("SELECT COUNT(*) as c FROM jobs WHERE accounts_status = 'disputed'").get().c,
  };
}

function getChartData(db) {
  return {
    jobStatusDist: db.prepare("SELECT status, COUNT(*) as count FROM jobs GROUP BY status").all(),
    jobHealthDist: db.prepare(`SELECT ${HEALTH_CALC_SQL} as health, COUNT(*) as count FROM jobs j WHERE status = 'active' GROUP BY 1`).all(),
    crewHoursByDay: db.prepare(`
      SELECT work_date, COALESCE(SUM(total_hours), 0) as hours
      FROM timesheets WHERE work_date >= date('now', '-7 days')
      GROUP BY work_date ORDER BY work_date ASC
    `).all(),
  };
}

function getMyWork(db, user, today) {
  const userId = user && user.id ? user.id : user; // tolerate legacy callers that pass just an id
  const last7 = addDays(today, -7);
  const adminGuard = isAdminRole(user) ? '' : " AND t.division != 'admin'";

  const myJobs = db.prepare(`
    SELECT j.*, u.full_name as pm_name FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status IN ('active','on_hold','won')
    AND (j.project_manager_id = ? OR j.ops_supervisor_id = ? OR j.planning_owner_id = ? OR j.marketing_owner_id = ? OR j.accounts_owner_id = ?)
    ORDER BY CASE j.health WHEN 'red' THEN 1 WHEN 'amber' THEN 2 ELSE 3 END, j.start_date DESC
    LIMIT 20
  `).all(userId, userId, userId, userId, userId);

  const overdueTasksList = db.prepare(`
    SELECT t.*, j.job_number, j.client, u.full_name as owner_name
    FROM tasks t
    LEFT JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.owner_id = u.id
    WHERE t.owner_id = ? AND t.due_date < ? AND t.status != 'complete' AND t.deleted_at IS NULL${adminGuard}
    ORDER BY t.due_date ASC LIMIT 10
  `).all(userId, today);

  const recentUpdates = db.prepare(`
    SELECT pu.*, j.job_number, j.client, u.full_name as submitted_by_name
    FROM project_updates pu
    JOIN jobs j ON pu.job_id = j.id
    JOIN users u ON pu.submitted_by_id = u.id
    WHERE pu.week_ending >= ?
    ORDER BY pu.created_at DESC LIMIT 10
  `).all(last7);

  return { myJobs, overdueTasksList, recentUpdates };
}

function getMyTasks(db, user, today) {
  const userId = user && user.id ? user.id : user;
  const adminGuard = isAdminRole(user) ? '' : " AND t.division != 'admin'";
  return db.prepare(`
    SELECT t.*, j.job_number, j.client, u.full_name as owner_name,
      cb.full_name as created_by_name
    FROM tasks t
    LEFT JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.owner_id = u.id
    LEFT JOIN users cb ON t.created_by = cb.id
    WHERE t.owner_id = ? AND t.status != 'complete' AND t.deleted_at IS NULL${adminGuard}
    ORDER BY
      CASE WHEN t.due_date < ? THEN 0 ELSE 1 END,
      t.due_date ASC,
      CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 15
  `).all(userId, today);
}

function getTasksIAssigned(db, user, today) {
  const userId = user && user.id ? user.id : user;
  const adminGuard = isAdminRole(user) ? '' : " AND t.division != 'admin'";
  return db.prepare(`
    SELECT t.*, j.job_number, j.client, u.full_name as owner_name
    FROM tasks t
    LEFT JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.owner_id = u.id
    WHERE t.created_by = ? AND t.owner_id != ? AND t.status != 'complete' AND t.deleted_at IS NULL${adminGuard}
    ORDER BY
      CASE WHEN t.due_date < ? THEN 0 ELSE 1 END,
      t.due_date ASC,
      CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 20
  `).all(userId, userId, today);
}

function getComplianceUrgent(db, today) {
  const next14 = addDays(today, 14);
  const next30 = addDays(today, 30);

  return db.prepare(`
    SELECT c.id, c.title, c.item_type, c.status, c.due_date, c.expiry_date,
      j.job_number, j.client as job_client,
      cl.company_name as client_name,
      a.full_name as assigned_name
    FROM compliance c
    LEFT JOIN jobs j ON c.job_id = j.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users a ON c.assigned_to_id = a.id
    WHERE (
      (c.due_date IS NOT NULL AND c.due_date <= ? AND c.status NOT IN ('approved','expired','submitted'))
      OR (c.due_date IS NOT NULL AND c.due_date > ? AND c.due_date <= ? AND c.status NOT IN ('approved','expired','submitted'))
      OR (c.due_date IS NOT NULL AND c.due_date <= ? AND c.status = 'submitted')
      OR (c.expiry_date IS NOT NULL AND c.expiry_date >= ? AND c.expiry_date <= ? AND c.status = 'approved')
      OR (c.expiry_date IS NOT NULL AND c.expiry_date < ? AND c.status = 'approved')
      OR (c.status IN ('not_started','submitted') AND c.due_date IS NOT NULL)
    )
    ORDER BY
      CASE
        WHEN c.due_date IS NOT NULL AND c.due_date < ? AND c.status NOT IN ('approved','expired','submitted') THEN 1
        WHEN c.expiry_date IS NOT NULL AND c.expiry_date < ? THEN 2
        WHEN c.due_date IS NOT NULL AND c.due_date <= ? AND c.status NOT IN ('approved','expired','submitted') THEN 3
        WHEN c.expiry_date IS NOT NULL AND c.expiry_date <= ? THEN 4
        ELSE 5
      END,
      COALESCE(c.due_date, c.expiry_date) ASC
    LIMIT 10
  `).all(today, today, next14, today, today, next30, today, today, today, next14, next30);
}

function getMyPlans(db, userId, today) {
  return db.prepare(`
    SELECT c.id, c.title, c.item_type, c.item_types, c.status, c.due_date, c.expiry_date,
      j.job_number, j.client as job_client,
      cl.company_name as client_name
    FROM compliance c
    LEFT JOIN jobs j ON c.job_id = j.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    WHERE c.assigned_to_id = ? AND c.status NOT IN ('approved','expired')
    ORDER BY
      CASE
        WHEN c.due_date IS NOT NULL AND c.due_date < ? THEN 1
        WHEN c.due_date IS NOT NULL AND c.due_date <= date(?, '+14 days') THEN 2
        ELSE 3
      END,
      COALESCE(c.due_date, '9999-12-31') ASC
    LIMIT 10
  `).all(userId, today, today);
}

function getRecentActivity(db) {
  return db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    ORDER BY al.created_at DESC LIMIT 10
  `).all();
}

module.exports = {
  addDays,
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
};
