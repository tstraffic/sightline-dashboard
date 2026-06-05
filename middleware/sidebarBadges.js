// Sidebar badge counts — lightweight middleware, cached for 60 seconds
const { getDb } = require('../db/database');
const { isAdminRole } = require('../lib/taskVisibility');

// Per-role cache — different counts for different roles
let cacheByRole = {};

function safeCount(db, sql, params) {
  try { return db.prepare(sql).get(...(params || [])).c; }
  catch (e) { return 0; }
}

function sidebarBadges(req, res, next) {
  if (!req.session || !req.session.user) return next();

  const now = Date.now();
  const userRole = (req.session.user.role || '').toLowerCase();
  const userId = req.session.user.id;
  const isAdmin = isAdminRole(req.session.user);
  // Admins see admin-division tasks; everyone else has them filtered out.
  // Cache bucket has to separate the two or admin totals leak into non-admin badges.
  const cacheKey = isAdmin
    ? 'admin_global'
    : userRole === 'planning' ? `planning_${userId}` : 'nonadmin_global';

  if (cacheByRole[cacheKey] && now < cacheByRole[cacheKey].expires) {
    res.locals.sidebarBadges = cacheByRole[cacheKey].data;
    return next();
  }

  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const next30 = new Date(now + 30 * 86400000).toISOString().split('T')[0];
    const isPlanningRole = userRole === 'planning';

    // Task filter: planning only sees planning division + their own + compliance-linked
    const taskFilter = isPlanningRole
      ? `(division = 'planning' OR owner_id = ${userId} OR compliance_id IS NOT NULL)`
      : '1=1';
    // Everyone except admin/management has admin-division tasks hidden.
    const adminGuard = isAdmin ? '' : " AND division != 'admin'";

    const badges = {
      // Bookings — today's allocations
      allocations: safeCount(db, "SELECT COUNT(*) as c FROM crew_allocations WHERE allocation_date = ? AND status = 'allocated'", [today]),

      // Jobs — jobs with outstanding items (blue)
      jobActions: safeCount(db, "SELECT COUNT(DISTINCT j.id) as c FROM jobs j WHERE j.status NOT IN ('completed','closed','cancelled') AND (EXISTS (SELECT 1 FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL) OR EXISTS (SELECT 1 FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved','expired')))", []),

      // Tasks — role-aware totals (kept for any legacy consumers)
      tasksOverdue: safeCount(db, `SELECT COUNT(*) as c FROM tasks WHERE status != 'complete' AND deleted_at IS NULL AND due_date < ? AND ${taskFilter}${adminGuard}`, [today]),
      tasks: safeCount(db, `SELECT COUNT(*) as c FROM tasks WHERE status != 'complete' AND deleted_at IS NULL AND (due_date >= ? OR due_date IS NULL) AND ${taskFilter}${adminGuard}`, [today]),

      // Tasks — per-division counts so the Planning and Operations sidebar entries show their own workload
      tasksPlanningOverdue: safeCount(db, "SELECT COUNT(*) as c FROM tasks WHERE status != 'complete' AND deleted_at IS NULL AND division = 'planning' AND due_date < ?", [today]),
      tasksPlanning: safeCount(db, "SELECT COUNT(*) as c FROM tasks WHERE status != 'complete' AND deleted_at IS NULL AND division = 'planning' AND (due_date >= ? OR due_date IS NULL)", [today]),
      tasksOpsOverdue: safeCount(db, "SELECT COUNT(*) as c FROM tasks WHERE status != 'complete' AND deleted_at IS NULL AND division = 'ops' AND due_date < ?", [today]),
      tasksOps: safeCount(db, "SELECT COUNT(*) as c FROM tasks WHERE status != 'complete' AND deleted_at IS NULL AND division = 'ops' AND (due_date >= ? OR due_date IS NULL)", [today]),

      // Plans & Approvals — split: overdue (red) vs outstanding non-overdue (blue)
      complianceOverdue: safeCount(db, "SELECT COUNT(*) as c FROM compliance WHERE status NOT IN ('approved','expired','submitted') AND due_date IS NOT NULL AND due_date < ?", [today]),
      compliance: safeCount(db, "SELECT COUNT(*) as c FROM compliance WHERE status NOT IN ('approved','expired') AND (due_date >= ? OR due_date IS NULL)", [today]),

      // Safety
      incidents: safeCount(db, "SELECT COUNT(*) as c FROM incidents WHERE investigation_status NOT IN ('closed', 'resolved')"),

      // Hire dockets past their return date but still marked picked_up —
      // every day past is money the supplier might still be charging.
      hireOverdue: safeCount(db, "SELECT COUNT(*) as c FROM hire_dockets WHERE status = 'picked_up' AND hire_end_date IS NOT NULL AND hire_end_date < ? AND deleted_at IS NULL", [today]),

      // Pending leave requests waiting on an approver decision.
      leavePending: safeCount(db, "SELECT COUNT(*) as c FROM employee_leave WHERE status = 'pending'"),

      // Traffio imports awaiting reconciliation (ambiguous bookings/dockets).
      traffioPending: safeCount(db, "SELECT COUNT(*) as c FROM traffio_imports WHERE status = 'pending'"),

      // Crew — expiring certs within 30 days
      crew: safeCount(db, `
        SELECT COUNT(*) as c FROM crew_members WHERE active = 1 AND (
          (tc_ticket_expiry IS NOT NULL AND tc_ticket_expiry BETWEEN ? AND ?)
          OR (ti_ticket_expiry IS NOT NULL AND ti_ticket_expiry BETWEEN ? AND ?)
          OR (white_card_expiry IS NOT NULL AND white_card_expiry BETWEEN ? AND ?)
          OR (first_aid_expiry IS NOT NULL AND first_aid_expiry BETWEEN ? AND ?)
          OR (medical_expiry IS NOT NULL AND medical_expiry BETWEEN ? AND ?)
        )
      `, [today, next30, today, next30, today, next30, today, next30, today, next30]),
    };

    cacheByRole[cacheKey] = { data: badges, expires: now + 60000 };
    res.locals.sidebarBadges = badges;
  } catch (e) {
    res.locals.sidebarBadges = {};
  }
  next();
}

module.exports = { sidebarBadges };
