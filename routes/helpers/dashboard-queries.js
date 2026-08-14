// Dashboard query helpers — extracted for clarity and role-based filtering.
//
// The dashboard is three bands (see views/dashboard.ejs):
//   1. "Needs you now"      — getNeedsYouNow(): registry of urgency rows
//   2. "Today's operations" — getTodayOps(): live crew/booking state
//   3. One trend            — getChartData(): job pipeline
// plus the personal "Your work" lists (getMyTasks / getMyPlans).
//
// lib/departments.js copies several of these predicates by hand for the hub
// stat strips — keep them in sync when a definition changes.
const { isAdminRole } = require('../../lib/taskVisibility');
const { canAccess } = require('../../middleware/auth');
const { formatDateShortAU } = require('../../lib/sydney');

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

// Task visibility scoping shared by the overdue-tasks row: planning only sees
// planning-division + own + compliance-linked tasks; everyone but admin has
// admin-division tasks hidden.
function taskScopeSql(user) {
  const userRole = user ? (user.role || '').toLowerCase() : '';
  const userId = user ? user.id : 0;
  const taskFilter = userRole === 'planning'
    ? `AND (division = 'planning' OR owner_id = ${userId} OR compliance_id IS NOT NULL)`
    : '';
  const adminGuard = isAdminRole(user) ? '' : " AND division != 'admin'";
  return taskFilter + adminGuard;
}

// A checklist type at or above this month-to-date completion % is considered
// on track; below it the register surfaces in "Needs you now". Matches the
// red band the old dashboard widget used.
const CHECKLIST_TARGET_PCT = 75;

// "Needs you now" registry. Each builder returns { count, label, detail?,
// tone?, priority? } — label is the noun phrase WITHOUT the count (the view
// renders the number separately). Rows with count 0 never render; a builder
// that throws is skipped (one bad table must never 500 the dashboard); a
// builder whose gate fails is never run.
const NEEDS_ROWS = [
  {
    // Sightline CRM: follow-ups due/overdue + proposals awaiting response +
    // won-but-unconverted (brief §3.6). One row so the dashboard stays calm.
    key: 'crm_followups_due', gate: 'crm', priority: 18, tone: 'warn', href: '/crm',
    build(db, user, today) {
      const due = db.prepare(`
        SELECT COUNT(*) AS c FROM (
          SELECT next_step_due_date AS d FROM opportunities WHERE status = 'open' AND next_step_due_date IS NOT NULL AND next_step_due_date <= ?
          UNION ALL
          SELECT next_step_due_date FROM crm_activities WHERE is_completed = 0 AND next_step_due_date IS NOT NULL AND next_step_due_date <= ?
          UNION ALL
          SELECT next_action_date FROM clients WHERE active = 1 AND next_action_date IS NOT NULL AND next_action_date <= ?
          UNION ALL
          SELECT follow_up_date FROM proposals WHERE status = 'sent' AND follow_up_date IS NOT NULL AND follow_up_date <= ?
        )
      `).get(today, today, today, today).c;
      const unconverted = db.prepare("SELECT COUNT(*) AS c FROM opportunities WHERE status = 'won' AND related_job_id IS NULL").get().c;
      return {
        count: due + unconverted,
        label: 'CRM follow-ups due',
        detail: unconverted > 0 ? `${unconverted} won not converted` : '',
        tone: unconverted > 0 ? 'critical' : undefined,
      };
    },
  },
  {
    key: 'overdue_plans', gate: 'compliance', priority: 10, tone: 'critical', href: '/compliance',
    build(db, user, today) {
      // Canonical overdue definition — submitted-inclusive, same as the
      // /compliance page summary and the Planning hub.
      const r = db.prepare("SELECT COUNT(*) AS c, MIN(due_date) AS oldest FROM compliance WHERE due_date < ? AND status NOT IN ('approved','expired')").get(today);
      return {
        count: r.c,
        label: r.c === 1 ? 'overdue plan' : 'overdue plans',
        detail: r.oldest ? 'oldest ' + formatDateShortAU(r.oldest) : '',
      };
    },
  },
  {
    key: 'open_incidents', gate: 'incidents', priority: 15, tone: 'critical', href: '/incidents',
    build(db) {
      const open = db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE investigation_status NOT IN ('closed','resolved')").get().c;
      const notifiable = db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE notifiable_incident = 1 AND investigation_status NOT IN ('closed','resolved')").get().c;
      return {
        count: open,
        label: open === 1 ? 'open incident' : 'open incidents',
        detail: notifiable > 0 ? `${notifiable} notifiable` : '',
        // A notifiable incident outranks everything on the page.
        priority: notifiable > 0 ? 5 : undefined,
      };
    },
  },
  {
    key: 'overdue_tasks', gate: 'tasks', priority: 20, tone: 'warn', href: '/tasks',
    build(db, user, today) {
      const scope = taskScopeSql(user);
      const total = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE due_date < ? AND status != 'complete' AND deleted_at IS NULL ${scope}`).get(today).c;
      const mine = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE due_date < ? AND status != 'complete' AND deleted_at IS NULL AND owner_id = ? ${scope}`).get(today, user.id).c;
      return {
        count: total,
        label: total === 1 ? 'overdue task' : 'overdue tasks',
        detail: mine > 0 ? `${mine} yours` : '',
      };
    },
  },
  {
    key: 'fleet_flagged', gate: 'fleet', priority: 25, tone: 'warn', href: '/fleet/compliance',
    build(db, user, today) {
      // vehicle_summary may not exist on a legacy DB — the try/catch in
      // getNeedsYouNow absorbs it, same as the old inline card did.
      const { badgesFor } = require('../../lib/fleetStatus');
      const rows = db.prepare("SELECT * FROM vehicle_summary WHERE status != 'Retired'").all();
      const flagged = rows.filter(v => {
        const b = badgesFor(v, today);
        return ['registration', 'service', 'inspection', 'fireExt'].some(k => b[k].tone === 'bad' || b[k].tone === 'warn');
      });
      return {
        count: flagged.length,
        label: flagged.length === 1 ? 'vehicle needs compliance attention' : 'vehicles need compliance attention',
      };
    },
  },
  {
    key: 'missing_site_docs', gate: 'bookings', priority: 30, tone: 'warn', href: '/bookings?missing_docs=1',
    build(db, user, today) {
      // Bookings starting today/tomorrow with no site documents attached.
      // Coverage = a booking_documents row, a job_documents row, or a final
      // traffic plan on the same job (re-using a job-level pack is fine).
      const c = db.prepare(`
        SELECT COUNT(*) AS c
        FROM bookings b
        WHERE b.status IN ('confirmed','green_to_go','unconfirmed')
          AND b.deleted_at IS NULL
          AND date(b.start_datetime) BETWEEN date(?) AND date(?,'+1 day')
          AND NOT EXISTS (SELECT 1 FROM booking_documents bd WHERE bd.booking_id = b.id)
          AND NOT EXISTS (SELECT 1 FROM job_documents jd WHERE jd.job_id = b.job_id AND jd.archived_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM traffic_plans tp WHERE tp.job_id = b.job_id AND tp.is_final = 1)
      `).get(today, today).c;
      return {
        count: c,
        label: c === 1 ? 'booking starting soon without site docs' : 'bookings starting soon without site docs',
      };
    },
  },
  {
    key: 'rol_alerts', gate: 'compliance', priority: 35, tone: 'warn', href: '/compliance',
    build(db) {
      // Alert-flagged ROL conditions live in the Compliance module
      // (compliance_rol_conditions); a legacy register also exists on
      // traffic_plans (rol_conditions). Sum both — either may hold the data.
      let n = 0;
      try {
        n += db.prepare(`
          SELECT COUNT(*) AS c FROM compliance_rol_conditions rc
          JOIN compliance c ON c.id = rc.compliance_id
          WHERE rc.is_alert = 1 AND c.status NOT IN ('expired','rejected')
        `).get().c;
      } catch (e) { /* table absent on legacy DBs */ }
      try {
        n += db.prepare(`
          SELECT COUNT(*) AS c FROM rol_conditions rc
          JOIN traffic_plans tp ON tp.id = rc.plan_id
          WHERE rc.is_alert = 1 AND tp.status NOT IN ('rejected','expired')
        `).get().c;
      } catch (e) { /* table absent on legacy DBs */ }
      return {
        count: n,
        label: n === 1 ? 'ROL condition alert' : 'ROL condition alerts',
      };
    },
  },
  {
    key: 'checklist_below_target', gate: 'audits', priority: 40, tone: 'warn', href: '/checklist-register',
    build(db) {
      const summary = require('../../services/checklistRegister').dashboardSummary(db);
      const low = summary.month
        .filter(r => r.required > 0 && r.completion_pct < CHECKLIST_TARGET_PCT)
        .sort((a, b) => a.completion_pct - b.completion_pct);
      return {
        count: low.length,
        label: low.length === 1 ? 'checklist type below target this month' : 'checklist types below target this month',
        detail: low.length ? `worst: ${low[0].label} ${low[0].completion_pct}%` : '',
      };
    },
  },
  {
    key: 'pending_leave', gate: 'leave_approvals', priority: 45, tone: 'info', href: '/leave-approvals',
    build(db) {
      const c = db.prepare("SELECT COUNT(*) AS c FROM employee_leave WHERE status = 'pending'").get().c;
      return {
        count: c,
        label: c === 1 ? 'leave request awaiting approval' : 'leave requests awaiting approval',
      };
    },
  },
  {
    key: 'expiring_tickets', gate: 'hr_compliance_view', priority: 50, tone: 'info', href: '/hr/roster',
    build(db, user, today) {
      const next30 = addDays(today, 30);
      const c = db.prepare(`
        SELECT COUNT(*) AS c FROM crew_members WHERE active = 1 AND (
          (tc_ticket_expiry IS NOT NULL AND tc_ticket_expiry BETWEEN ? AND ?)
          OR (ti_ticket_expiry IS NOT NULL AND ti_ticket_expiry BETWEEN ? AND ?)
          OR (white_card_expiry IS NOT NULL AND white_card_expiry BETWEEN ? AND ?)
          OR (first_aid_expiry IS NOT NULL AND first_aid_expiry BETWEEN ? AND ?)
          OR (medical_expiry IS NOT NULL AND medical_expiry BETWEEN ? AND ?)
        )
      `).get(today, next30, today, next30, today, next30, today, next30, today, next30).c;
      return {
        count: c,
        label: c === 1 ? 'crew ticket expiring within 30 days' : 'crew tickets expiring within 30 days',
      };
    },
  },
];

// Band 1. Returns { top, overflow, allClear } — top is capped at 5 rows,
// sorted most-urgent first; overflow feeds the "+N more" disclosure; rows
// with count 0 are never built, so "zero tiles" cannot render by design.
// extraRows lets the route inject pre-built rows that need data the
// registry can't reach (e.g. the weather-driven wet-window row).
// opts.only (an ARRAY of registry keys, [] allowed) restricts which NEEDS_ROWS
// run — the department hubs use it to scope the panel; extras always pass
// through, so hub extras must permission-check themselves.
function getNeedsYouNow(db, user, today, extraRows, opts = {}) {
  const only = Array.isArray(opts.only) ? new Set(opts.only) : null;
  const rows = (extraRows || []).filter(r => r && r.count > 0);
  for (const spec of NEEDS_ROWS) {
    if (only && !only.has(spec.key)) continue;
    if (!canAccess(user, spec.gate)) continue;
    try {
      const r = spec.build(db, user, today);
      if (!r || !r.count) continue;
      rows.push({
        key: spec.key,
        href: spec.href,
        tone: r.tone || spec.tone,
        priority: r.priority != null ? r.priority : spec.priority,
        count: r.count,
        label: r.label,
        detail: r.detail || '',
      });
    } catch (e) {
      console.error(`[dashboard] needs-you-now '${spec.key}' failed:`, e.message);
    }
  }
  rows.sort((a, b) => a.priority - b.priority || b.count - a.count);
  return { top: rows.slice(0, 5), overflow: rows.slice(5), allClear: rows.length === 0 };
}

// Band 2 — today's live operations state, built from bookings + booking_crew
// (see CREW_TODAY_SQL note above for why not crew_allocations).
function getTodayOps(db, today) {
  const totalActiveCrew = db.prepare("SELECT COUNT(*) AS c FROM crew_members WHERE active = 1").get().c;
  const crewAssignedToday = db.prepare(CREW_TODAY_SQL).get(today, today).c;
  const jobsRunningToday = db.prepare(`
    SELECT COUNT(DISTINCT b.job_id) AS c FROM bookings b
    WHERE date(b.start_datetime) = date(?) AND b.job_id IS NOT NULL
      AND b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')
  `).get(today).c;
  const bookingsNext24h = db.prepare(`
    SELECT COUNT(*) AS c FROM bookings b
    WHERE date(b.start_datetime) BETWEEN date(?) AND date(?,'+1 day')
      AND b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')
  `).get(today, today).c;
  // Uncapped: the day-bar lanes and jobs-in-flight table need the whole day
  // (the view caps lanes at 6 with a "+N more" link). start/end_datetime are
  // Sydney wall-clock strings, so slice(11,16) is the lane position.
  const todaysBookings = db.prepare(`
    SELECT b.id, b.booking_number, b.title, b.start_datetime, b.end_datetime,
      b.suburb, b.site_address, b.status,
      j.job_number, c.company_name AS client_name
    FROM bookings b
    LEFT JOIN jobs j ON j.id = b.job_id
    LEFT JOIN clients c ON c.id = b.client_id
    WHERE date(b.start_datetime) = date(?)
      AND b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')
    ORDER BY b.start_datetime ASC
  `).all(today);

  // One grouped crew query for all of today's bookings (no N+1). Leaders
  // sort first so the face row shows them leftmost.
  if (todaysBookings.length) {
    const ids = todaysBookings.map(b => b.id);
    const rows = db.prepare(`
      SELECT bc.booking_id, bc.is_team_leader, cm.full_name
      FROM booking_crew bc
      JOIN crew_members cm ON cm.id = bc.crew_member_id
      WHERE bc.booking_id IN (${ids.map(() => '?').join(',')})
        AND bc.status != 'declined'
      ORDER BY bc.is_team_leader DESC, cm.full_name ASC
    `).all(...ids);
    const byBooking = {};
    for (const r of rows) (byBooking[r.booking_id] = byBooking[r.booking_id] || []).push(r);
    for (const b of todaysBookings) b.crew = byBooking[b.id] || [];
  }

  return {
    totalActiveCrew,
    crewAssignedToday,
    availableCrew: Math.max(0, totalActiveCrew - crewAssignedToday),
    jobsRunningToday,
    bookingsNext24h,
    todaysBookings,
  };
}

// Day-bar "Due" lane. Only entities with a REAL clock time get a timed
// marker (meetings, ROL shift windows); date-only deadlines (compliance due,
// quotes expiring, tasks due) cluster at an end-of-day pin — no fake times.
function getDayMarkers(db, user, today) {
  const timed = [];
  const eod = [];

  try {
    const meetings = db.prepare(`
      SELECT id, dept_key, title, meeting_time FROM dept_meetings
      WHERE meeting_date = ? AND status = 'scheduled' AND meeting_time != ''
      ORDER BY meeting_time ASC
    `).all(today);
    for (const m of meetings) {
      timed.push({
        hm: m.meeting_time,
        label: `${m.meeting_time} ${m.title}`,
        tone: 'info',
        href: `/departments/${m.dept_key}/meetings/${m.id}`,
      });
    }
  } catch (e) { /* dept_meetings absent on legacy DBs */ }

  try {
    const rolStarts = db.prepare(`
      SELECT rs.start_time, c.title FROM compliance_rol_shifts rs
      JOIN compliance c ON c.id = rs.compliance_id
      WHERE rs.start_date = ? AND rs.start_time IS NOT NULL AND rs.start_time != ''
      ORDER BY rs.start_time ASC
    `).all(today);
    for (const r of rolStarts) {
      timed.push({ hm: r.start_time, label: `${r.start_time} ROL window opens — ${r.title}`, tone: 'warn', href: '/compliance' });
    }
    const rolEnds = db.prepare(`
      SELECT rs.end_time, c.title FROM compliance_rol_shifts rs
      JOIN compliance c ON c.id = rs.compliance_id
      WHERE rs.end_date = ? AND rs.end_time IS NOT NULL AND rs.end_time != ''
      ORDER BY rs.end_time ASC
    `).all(today);
    for (const r of rolEnds) {
      timed.push({ hm: r.end_time, label: `${r.end_time} ROL expires — ${r.title}`, tone: 'critical', href: '/compliance' });
    }
  } catch (e) { /* rol shifts absent on legacy DBs */ }

  try {
    const c = db.prepare("SELECT COUNT(*) AS c FROM compliance WHERE due_date = ? AND status NOT IN ('approved','expired')").get(today).c;
    if (c) eod.push({ count: c, label: c === 1 ? 'plan due today' : 'plans due today', href: '/compliance' });
  } catch (e) { /* ignore */ }
  try {
    const c = db.prepare("SELECT COUNT(*) AS c FROM quotes WHERE valid_until_date = ? AND status IN ('draft','sent')").get(today).c;
    if (c) eod.push({ count: c, label: c === 1 ? 'quote expires today' : 'quotes expire today', href: '/quotes' });
  } catch (e) { /* quotes table/columns may differ on legacy DBs */ }
  try {
    const scope = taskScopeSql(user);
    const c = db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE due_date = ? AND status != 'complete' AND deleted_at IS NULL ${scope}`).get(today).c;
    if (c) eod.push({ count: c, label: c === 1 ? 'task due today' : 'tasks due today', href: '/tasks' });
  } catch (e) { /* ignore */ }

  timed.sort((a, b) => a.hm.localeCompare(b.hm));
  return { timed, eod };
}

// Band 3 — the one trend chart (job pipeline). Job health and crew hours were
// dropped deliberately: health only covers active jobs (tiny n) and the
// timesheets table is empty until Sprint 4 ships.
function getChartData(db) {
  return {
    jobStatusDist: db.prepare("SELECT status, COUNT(*) as count FROM jobs GROUP BY status").all(),
  };
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

module.exports = {
  addDays,
  CHECKLIST_TARGET_PCT,
  getNeedsYouNow,
  getTodayOps,
  getDayMarkers,
  getChartData,
  getMyTasks,
  getMyPlans,
};
