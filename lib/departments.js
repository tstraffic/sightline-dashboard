// lib/departments.js
// Registry for the department home pages at /departments/:key — the single
// source of truth for what a department is: who can open its hub, which
// modules it links to, and what its stats strip shows.
//
// Hub access = sidebar section visibility, delegated to lib/sidebarNav.js
// (the nav registry is the single source of truth), so the invariant
// "I can see the section in the sidebar" ⇔ "I can open its hub" holds by
// construction — no hand-synced permission lists.
//
// stats(db, today) returns [{ label, value, tone, href, sub? }] where tone is
// a .stat-card-value modifier: is-good / is-info / is-warn / is-critical /
// is-muted. Stat queries reuse the exact predicates from
// routes/helpers/dashboard-queries.js and safety-today-queries.js — keep them
// in sync with the source when those change. A stats() throw must never take
// the hub down; the route wraps the call.

'use strict';

const { canAccess } = require('../middleware/auth');

function count(db, sql, ...params) {
  try { return db.prepare(sql).get(...params).c; } catch (e) { return 0; }
}

function money(n) {
  const v = Math.round(Number(n) || 0);
  if (v >= 1000000) return '$' + (v / 1000000).toFixed(1) + 'M';
  if (v >= 10000) return '$' + Math.round(v / 1000) + 'k';
  return '$' + v.toLocaleString('en-AU');
}

const DEPARTMENTS = {
  planning: {
    key: 'planning',
    label: 'Planning',
    blurb: 'Tenders, quotes, jobs and plan approvals.',
    quickLinks: [
      { label: 'Tenders', href: '/tenders', permKey: 'tenders' },
      { label: 'Quotes', href: '/quotes', permKey: 'quoting' },
      { label: 'Rate Cards', href: '/rate-cards', permKey: 'quoting' },
      { label: 'Jobs', href: '/projects', permKey: 'projects' },
      { label: 'Plans & Approvals', href: '/compliance', permKey: 'compliance' },
      { label: 'TGS Risk Assessment', href: '/tgs-risk-assessments', permKey: 'compliance' },
    ],
    stats(db, today) {
      // Canonical overdue definition — submitted-inclusive, same as the
      // dashboard tile and the /compliance page summary.
      const overduePlans = count(db, "SELECT COUNT(*) as c FROM compliance WHERE due_date < ? AND status NOT IN ('approved','expired')", today);
      return [
        { label: 'Active jobs', value: count(db, "SELECT COUNT(*) as c FROM jobs WHERE status = 'active'"), tone: 'is-good', href: '/projects' },
        { label: 'Plans overdue', value: overduePlans, tone: overduePlans > 0 ? 'is-critical' : 'is-good', href: '/compliance' },
        { label: 'Open tenders', value: count(db, "SELECT COUNT(*) as c FROM tenders WHERE LOWER(COALESCE(status,'open')) = 'open'"), tone: 'is-info', href: '/tenders' },
        { label: 'Draft quotes', value: count(db, "SELECT COUNT(*) as c FROM quotes WHERE status = 'draft'"), tone: 'is-muted', href: '/quotes' },
      ];
    },
  },

  safety: {
    key: 'safety',
    label: 'Safety',
    blurb: 'Incidents, audits, SWMS, toolbox talks and safety engagement.',
    heroLink: {
      label: 'Open Safety Today',
      href: '/safety-today',
      permKey: 'safety_today',
      sub: 'Live cross-module safety command centre — health gauge, attention queue, registers',
    },
    quickLinks: [
      { label: 'Incidents', href: '/incidents', permKey: 'incidents' },
      { label: 'Site Audits', href: '/audits', permKey: 'audits' },
      { label: 'Vehicle Audits', href: '/vehicle-audits', permKey: 'audits' },
      { label: 'Forms & Checklists', href: '/checklists', permKey: 'checklists' },
      { label: 'SWMS', href: '/swms', permKey: 'swms' },
      { label: 'SOP', href: '/sop-register', permKey: 'sop_register' },
      { label: 'Toolbox Talks', href: '/toolbox-talks', permKey: 'toolbox_talks' },
      { label: 'Safety Updates', href: '/safety-updates', permKey: 'safety_updates' },
      { label: 'Risk Assessments', href: '/risk-assessments', permKey: 'risk_assessments' },
      { label: 'VOCs', href: '/voc-assessments', permKey: 'voc' },
      { label: 'Safety Reports', href: '/safety-reports', permKey: 'safety_reports' },
    ],
    stats(db, today) {
      // One helper call covers the whole strip (same aggregates Safety Today
      // itself runs) — don't stack more helpers on top, it's ~12 queries.
      const { getSafetyKpis } = require('../routes/helpers/safety-today-queries');
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const k = getSafetyKpis(db, since, null);
      return [
        { label: 'Open incidents', value: k.openIncidents, tone: k.openIncidents > 0 ? 'is-critical' : 'is-good', href: '/incidents' },
        { label: 'Overdue actions', value: k.overdueActions, tone: k.overdueActions > 0 ? 'is-warn' : 'is-good', href: '/actions' },
        { label: 'SWMS expiring', value: k.swmsExpiring, tone: k.swmsExpiring > 0 ? 'is-info' : 'is-good', href: '/swms', sub: 'Next 30 days' },
        { label: 'Toolbox coverage', value: (k.toolboxCoverage != null ? k.toolboxCoverage : 0) + '%', tone: 'is-info', href: '/toolbox-talks', sub: 'Last 30 days' },
      ];
    },
  },

  operations: {
    key: 'operations',
    label: 'Operations',
    blurb: 'Bookings, crew, fleet and day-to-day delivery.',
    quickLinks: [
      { label: 'Bookings', href: '/bookings', permKey: 'bookings' },
      { label: 'Jobs', href: '/projects', permKey: 'projects' },
      { label: 'Traffio Sync', href: '/traffio-imports', permKey: 'traffio_imports' },
      { label: 'Tasks Board', href: '/shift-tasks', permKey: 'ops_final_plans' },
      { label: 'Leave Approvals', href: '/leave-approvals', permKey: 'leave_approvals' },
      { label: 'Equipment / Hire', href: '/equipment', permKey: 'equipment' },
      { label: 'Vehicles', href: '/fleet', permKey: 'fleet' },
    ],
    stats(db, today) {
      // Predicates from dashboard-queries getOpsData/getUrgencyKpis (without
      // the todaysAllocations join list the hub doesn't need).
      const totalActiveCrew = count(db, "SELECT COUNT(*) as c FROM crew_members WHERE active = 1");
      // Crew on today reads booking_crew — the table the live scheduling flow
      // writes — plus legacy crew_allocations rows, deduped. Counting
      // crew_allocations alone reads 0 forever (same fix as the dashboard's
      // CREW_TODAY_SQL in routes/helpers/dashboard-queries.js).
      const allocatedToday = count(db, `
        SELECT COUNT(*) as c FROM (
          SELECT bc.crew_member_id AS id
          FROM booking_crew bc
          JOIN bookings b ON b.id = bc.booking_id
          WHERE date(b.start_datetime) = date(?)
            AND b.deleted_at IS NULL
            AND b.status NOT IN ('cancelled','late_cancellation')
            AND bc.status != 'declined'
          UNION
          SELECT crew_member_id AS id FROM crew_allocations WHERE allocation_date = ?
        )`, today, today);
      // Unconfirmed today = crew assigned to a shift today who haven't
      // accepted yet (booking_crew.status stays at its 'assigned' default
      // until the worker confirms; vocabulary is assigned/confirmed/declined/
      // completed). The old crew_allocations status='allocated' count was
      // permanently 0 for the same reason as above.
      const unconfirmed = count(db, `
        SELECT COUNT(*) as c FROM booking_crew bc
        JOIN bookings b ON b.id = bc.booking_id
        WHERE date(b.start_datetime) = date(?)
          AND b.deleted_at IS NULL
          AND b.status NOT IN ('cancelled','late_cancellation')
          AND bc.status = 'assigned'`, today);
      return [
        { label: 'Active jobs', value: count(db, "SELECT COUNT(*) as c FROM jobs WHERE status = 'active'"), tone: 'is-good', href: '/projects' },
        { label: 'Crew on today', value: allocatedToday, tone: 'is-info', href: '/bookings', sub: totalActiveCrew ? `of ${totalActiveCrew} active` : '' },
        { label: 'Unconfirmed today', value: unconfirmed, tone: unconfirmed > 0 ? 'is-warn' : 'is-good', href: '/bookings' },
        { label: 'Gear deployed', value: count(db, "SELECT COUNT(*) as c FROM equipment_assignments WHERE actual_return_date IS NULL"), tone: 'is-muted', href: '/equipment' },
      ];
    },
  },

  finance: {
    key: 'finance',
    label: 'Finance',
    blurb: 'Payroll, timesheets, budgets and invoicing.',
    quickLinks: [
      { label: 'Pay Runs', href: '/payroll/runs', permKey: 'payroll' },
      { label: 'Payslips', href: '/payroll/payslips', permKey: 'payroll' },
      { label: 'Timesheets', href: '/timesheets', permKey: 'timesheets' },
      { label: 'Budgets & Costs', href: '/budgets', permKey: 'budgets' },
      { label: 'Invoicing', href: '/finance/invoicing', permKey: 'invoicing' },
      { label: 'Plan P&L', href: '/finance/pnl', permKey: 'finance' },
    ],
    stats(db, today) {
      const overdue = count(db, "SELECT COUNT(*) as c FROM jobs WHERE accounts_status = 'overdue'");
      const draftInvoices = count(db, "SELECT COUNT(*) as c FROM invoices WHERE status = 'draft'");
      let spend = 0;
      try { spend = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM cost_entries').get().t; } catch (e) {}
      return [
        { label: 'Draft invoices', value: draftInvoices, tone: draftInvoices > 0 ? 'is-info' : 'is-muted', href: '/finance/invoicing' },
        { label: 'Draft pay runs', value: count(db, "SELECT COUNT(*) as c FROM pay_runs WHERE status = 'draft'"), tone: 'is-muted', href: '/payroll/runs' },
        { label: 'Accounts overdue', value: overdue, tone: overdue > 0 ? 'is-critical' : 'is-good', href: '/projects' },
        { label: 'Total spend', value: money(spend), tone: 'is-info', href: '/budgets', sub: 'All recorded costs' },
      ];
    },
  },

  people: {
    key: 'people',
    label: 'People / HR',
    blurb: 'Hiring, training, roster and employee records.',
    quickLinks: [
      { label: 'HR Dashboard', href: '/hr', permKey: 'hr_dashboard' },
      { label: 'Hiring', href: '/induction/admin/submissions', permKey: 'induction' },
      { label: 'Training Slides', href: '/induction/admin/presentations', permKey: 'induction' },
      { label: 'Roster', href: '/hr/roster', permKey: 'hr_employees' },
      { label: 'Contacts', href: '/contacts', permKey: 'contacts' },
      { label: 'HR Reports', href: '/hr/reports', permKey: 'hr_reports' },
    ],
    stats(db, today) {
      const next30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const pendingLeave = count(db, "SELECT COUNT(*) as c FROM employee_leave WHERE status = 'pending'");
      // Same 5-column expiry predicate as dashboard-queries getUrgencyKpis.
      const ticketsExpiring = count(db, `
        SELECT COUNT(*) as c FROM crew_members WHERE active = 1 AND (
          (tc_ticket_expiry IS NOT NULL AND tc_ticket_expiry BETWEEN ? AND ?)
          OR (ti_ticket_expiry IS NOT NULL AND ti_ticket_expiry BETWEEN ? AND ?)
          OR (white_card_expiry IS NOT NULL AND white_card_expiry BETWEEN ? AND ?)
          OR (first_aid_expiry IS NOT NULL AND first_aid_expiry BETWEEN ? AND ?)
          OR (medical_expiry IS NOT NULL AND medical_expiry BETWEEN ? AND ?)
        )`, today, next30, today, next30, today, next30, today, next30, today, next30);
      const pipeline = count(db, "SELECT COUNT(*) as c FROM seek_applicants WHERE UPPER(COALESCE(stage,'NEW')) NOT IN ('INDUCTED','HIRED','NO_SHOW','DECLINED')");
      return [
        { label: 'Active crew', value: count(db, "SELECT COUNT(*) as c FROM crew_members WHERE active = 1"), tone: 'is-good', href: '/hr/roster' },
        { label: 'Tickets expiring', value: ticketsExpiring, tone: ticketsExpiring > 0 ? 'is-warn' : 'is-good', href: '/hr/roster', sub: 'Next 30 days' },
        { label: 'Pending leave', value: pendingLeave, tone: pendingLeave > 0 ? 'is-info' : 'is-muted', href: '/leave-approvals' },
        { label: 'In hiring pipeline', value: pipeline, tone: 'is-info', href: '/induction/admin/submissions' },
      ];
    },
  },

  assets: {
    key: 'assets',
    label: 'Assets',
    blurb: 'Fleet, equipment, hire and asset documents.',
    quickLinks: [
      { label: 'Vehicles', href: '/fleet', permKey: 'fleet' },
      { label: 'Equipment / Hire', href: '/equipment', permKey: 'equipment' },
      { label: 'Vehicle Audits', href: '/vehicle-audits', permKey: 'audits' },
      { label: 'Documents', href: '/documents', permKey: 'documents' },
    ],
    stats(db, today) {
      // Fleet-alert pattern from routes/dashboard.js fleet compliance card.
      let vehicles = 0, flagged = 0;
      try {
        const { badgesFor } = require('./fleetStatus');
        const rows = db.prepare("SELECT * FROM vehicle_summary WHERE status != 'Retired'").all();
        vehicles = rows.length;
        flagged = rows.filter(v => {
          const b = badgesFor(v, today);
          return ['registration', 'service', 'inspection', 'fireExt'].some(k => b[k].tone === 'bad' || b[k].tone === 'warn');
        }).length;
      } catch (e) { /* legacy DB without fleet tables */ }
      return [
        { label: 'Fleet vehicles', value: vehicles, tone: 'is-good', href: '/fleet' },
        { label: 'Vehicles flagged', value: flagged, tone: flagged > 0 ? 'is-warn' : 'is-good', href: '/fleet', sub: 'Rego / service / inspection' },
        { label: 'Gear deployed', value: count(db, "SELECT COUNT(*) as c FROM equipment_assignments WHERE actual_return_date IS NULL"), tone: 'is-info', href: '/equipment' },
        { label: 'On hire', value: count(db, "SELECT COUNT(*) as c FROM equipment_hires WHERE status = 'on_hire'"), tone: 'is-muted', href: '/equipment' },
      ];
    },
  },

  reports: {
    key: 'reports',
    label: 'Reports',
    blurb: 'Company reporting and data exports.',
    linksFocus: true, // no stats strip — the link grid is the page
    quickLinks: [
      { label: 'Crew reports', href: '/reports?tab=crew', permKey: 'reports', sub: 'Utilisation, hours, fatigue risk' },
      { label: 'Job reports', href: '/reports?tab=jobs', permKey: 'reports', sub: 'Health, overdue, over budget' },
      { label: 'Finance reports', href: '/reports?tab=finance', permKey: 'reports', sub: 'Portfolio and monthly spend' },
      { label: 'Timesheet reports', href: '/reports?tab=timesheets', permKey: 'reports', sub: 'Hours by crew and job' },
      { label: 'Safety reports', href: '/safety-reports', permKey: 'safety_reports', sub: 'Engagement and incident analytics' },
      { label: 'Audit reports', href: '/audits/reports', permKey: 'audits', sub: 'Site audit outcomes and trends' },
      { label: 'Plan P&L', href: '/finance/pnl', permKey: 'finance', sub: 'Compliance plan profitability' },
      { label: 'HR reports', href: '/hr/reports', permKey: 'hr_reports', sub: 'Workforce and compliance' },
    ],
    stats() { return []; },
  },
};

const DEPARTMENT_ORDER = ['planning', 'safety', 'operations', 'finance', 'people', 'assets', 'reports'];

function getDepartment(key) {
  return Object.prototype.hasOwnProperty.call(DEPARTMENTS, key) ? DEPARTMENTS[key] : null;
}

function userCanAccessDept(user, dept) {
  return require('./sidebarNav').sectionVisibleByKey(user, dept.key);
}

function visibleQuickLinks(user, dept) {
  return dept.quickLinks.filter(l => canAccess(user, l.permKey));
}

module.exports = { DEPARTMENTS, DEPARTMENT_ORDER, getDepartment, userCanAccessDept, visibleQuickLinks };
