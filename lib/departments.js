// lib/departments.js
// Registry for the department home pages at /departments/:key — the single
// source of truth for what a department is: who can open its hub, what its
// hero action is, which stats and attention rows it surfaces.
//
// Hub access = sidebar section visibility, delegated to lib/sidebarNav.js
// (the nav registry is the single source of truth), so the invariant
// "I can see the section in the sidebar" ⇔ "I can open its hub" holds by
// construction — no hand-synced permission lists. Module links come from the
// same registry via moduleLinks() below, so they carry the sidebar's icons
// and permission gates for free; extraLinks covers destinations that live in
// another department's sidebar section (or none at all).
//
// stats(db, today) returns [{ label, value, tone, href, sub? }] where tone is
// a .stat-card-value modifier: is-good / is-info / is-warn / is-critical /
// is-muted. Stat queries reuse the exact predicates from
// routes/helpers/dashboard-queries.js and safety-today-queries.js — keep them
// in sync with the source when those change. A stats() throw must never take
// the hub down; the route wraps the call.
//
// needsKeys / needsExtras drive the hub's "Needs attention" panel through
// getNeedsYouNow (routes/helpers/dashboard-queries.js): needsKeys picks rows
// from the shared registry (still permission-gated there); needsExtras
// returns pre-built rows for data the registry doesn't cover. Extras bypass
// the registry's gates, so each one must canAccess-check itself.

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
    heroLink: {
      label: 'Open Plans & Approvals',
      href: '/compliance',
      permKey: 'compliance',
      sub: 'ROLs, permits and TGS packs — the approval pipeline end to end',
    },
    extraLinks: [
      { label: 'Jobs', href: '/projects', permKey: 'projects',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/>' },
    ],
    needsKeys: ['overdue_plans', 'rol_alerts'],
    needsExtras(db, user, today) {
      const rows = [];
      if (canAccess(user, 'tenders')) {
        const c = count(db, "SELECT COUNT(*) AS c FROM tenders WHERE LOWER(COALESCE(status,'open')) = 'open' AND submission_due IS NOT NULL AND date(submission_due) BETWEEN ? AND date(?, '+7 day')", today, today);
        if (c) rows.push({ key: 'tenders_due', href: '/tenders', tone: 'warn', priority: 18, count: c, label: c === 1 ? 'tender due within 7 days' : 'tenders due within 7 days', detail: '' });
      }
      if (canAccess(user, 'quoting')) {
        const c = count(db, "SELECT COUNT(*) AS c FROM quotes WHERE status = 'sent' AND valid_until_date IS NOT NULL AND date(valid_until_date) BETWEEN ? AND date(?, '+7 day')", today, today);
        if (c) rows.push({ key: 'quotes_expiring', href: '/quotes', tone: 'warn', priority: 22, count: c, label: c === 1 ? 'sent quote expires within 7 days' : 'sent quotes expire within 7 days', detail: '' });
      }
      return rows;
    },
    stats(db, today) {
      // Canonical overdue definition — submitted-inclusive, same as the
      // dashboard tile and the /compliance page summary.
      const overduePlans = count(db, "SELECT COUNT(*) as c FROM compliance WHERE due_date < ? AND status NOT IN ('approved','expired')", today);
      const raDraft = count(db, "SELECT COUNT(*) as c FROM tgs_risk_assessments WHERE status = 'draft'");
      const quotesSent = count(db, "SELECT COUNT(*) as c FROM quotes WHERE status = 'sent'");
      return [
        { label: 'Open plans', value: count(db, "SELECT COUNT(*) as c FROM compliance WHERE parent_id IS NULL AND status NOT IN ('approved','expired','rejected')"), tone: 'is-info', href: '/compliance' },
        { label: 'Plans overdue', value: overduePlans, tone: overduePlans > 0 ? 'is-critical' : 'is-good', href: '/compliance' },
        { label: 'Open tenders', value: count(db, "SELECT COUNT(*) as c FROM tenders WHERE LOWER(COALESCE(status,'open')) = 'open'"), tone: 'is-info', href: '/tenders' },
        { label: 'Quotes sent', value: quotesSent, tone: quotesSent > 0 ? 'is-info' : 'is-muted', href: '/quotes', sub: 'Awaiting response' },
        { label: 'Risk assessments', value: count(db, "SELECT COUNT(*) as c FROM tgs_risk_assessments"), tone: 'is-muted', href: '/tgs-risk-assessments', sub: raDraft ? raDraft + ' draft' : '' },
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
    extraLinks: [
      { label: 'Vehicle Audits', href: '/vehicle-audits', permKey: 'audits',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M3 13l1.5-5A2 2 0 016.43 6.5h11.14a2 2 0 011.93 1.5L21 13m-18 0v5a1 1 0 001 1h1a1 1 0 001-1v-1h12v1a1 1 0 001 1h1a1 1 0 001-1v-5M3 13h18M7 16h.01M17 16h.01"/>' },
      { label: 'Safety Reports', href: '/safety-reports', permKey: 'safety_reports',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>' },
    ],
    needsKeys: ['open_incidents', 'checklist_below_target'],
    stats(db, today) {
      // getSafetyKpis covers the number tiles; safetyHealth adds the
      // composite gauge the hub leads with (same pair Safety Today runs).
      // Don't stack further helpers on top — this is already ~18 queries.
      const { getSafetyKpis } = require('../routes/helpers/safety-today-queries');
      const { safetyHealth } = require('./safetyHealth');
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const k = getSafetyKpis(db, since, null);
      let health = null;
      try { health = safetyHealth(db, since, null); } catch (e) { /* factors need tables a legacy DB may lack */ }
      const band = health ? health.band : 'none';
      const healthTone = band === 'green' ? 'is-good' : band === 'amber' ? 'is-warn' : band === 'red' ? 'is-critical' : 'is-muted';
      return [
        { label: 'Safety health', value: health && health.score != null ? health.score : '—', tone: healthTone, href: '/safety-today', sub: 'Last 30 days' },
        { label: 'Open incidents', value: k.openIncidents, tone: k.openIncidents > 0 ? 'is-critical' : 'is-good', href: '/incidents' },
        { label: 'Overdue actions', value: k.overdueActions, tone: k.overdueActions > 0 ? 'is-warn' : 'is-good', href: '/actions' },
        { label: 'VOCs pending', value: k.vocPending || 0, tone: k.vocPending > 0 ? 'is-info' : 'is-good', href: '/voc-assessments', sub: 'Awaiting marking' },
        { label: 'Toolbox coverage', value: (k.toolboxCoverage != null ? k.toolboxCoverage : 0) + '%', tone: 'is-info', href: '/toolbox-talks', sub: 'Last 30 days' },
      ];
    },
  },

  operations: {
    key: 'operations',
    label: 'Operations',
    blurb: 'Bookings, crew, fleet and day-to-day delivery.',
    heroLink: {
      label: 'Open the Bookings Board',
      href: '/bookings',
      permKey: 'bookings',
      sub: 'Live shift board — crews, vehicles, acceptance and checklists',
    },
    extraLinks: [
      { label: 'Equipment / Hire', href: '/equipment', permKey: 'equipment',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"/>' },
      { label: 'Vehicles', href: '/fleet', permKey: 'fleet',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.7" d="M3 13l1.5-5A2 2 0 016.43 6.5h11.14a2 2 0 011.93 1.5L21 13m-18 0v5a1 1 0 001 1h1a1 1 0 001-1v-1h12v1a1 1 0 001 1h1a1 1 0 001-1v-5M3 13h18M7 16h.01M17 16h.01"/>' },
    ],
    needsKeys: ['missing_site_docs', 'overdue_tasks'],
    stats(db, today) {
      // Predicates from dashboard-queries getOpsData/getTodayOps (without
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
      const next24 = count(db, `
        SELECT COUNT(*) as c FROM bookings b
        WHERE date(b.start_datetime) BETWEEN date(?) AND date(?, '+1 day')
          AND b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')`, today, today);
      return [
        { label: 'Bookings next 24h', value: next24, tone: 'is-good', href: '/bookings' },
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
    // needsKeys [] = no registry rows; the panel runs on extras alone.
    needsKeys: [],
    needsExtras(db, user, today) {
      // ready_for_invoice lives on compliance (plan billing flags), not jobs —
      // same predicate as the /compliance summary's readyForInvoice count.
      if (!canAccess(user, 'compliance')) return [];
      const c = count(db, "SELECT COUNT(*) AS c FROM compliance WHERE COALESCE(ready_for_invoice,0) = 1 AND COALESCE(invoiced,0) = 0");
      return c ? [{ key: 'ready_to_invoice', href: '/compliance?invoice_state=ready', tone: 'info', priority: 20, count: c, label: c === 1 ? 'plan ready to invoice' : 'plans ready to invoice', detail: '' }] : [];
    },
    stats(db, today) {
      const overdue = count(db, "SELECT COUNT(*) as c FROM jobs WHERE accounts_status = 'overdue'");
      const draftInvoices = count(db, "SELECT COUNT(*) as c FROM invoices WHERE status = 'draft'");
      const readyInvoice = count(db, "SELECT COUNT(*) as c FROM compliance WHERE COALESCE(ready_for_invoice,0) = 1 AND COALESCE(invoiced,0) = 0");
      let spend = 0;
      try { spend = db.prepare('SELECT COALESCE(SUM(amount), 0) as t FROM cost_entries').get().t; } catch (e) {}
      return [
        { label: 'Ready to invoice', value: readyInvoice, tone: readyInvoice > 0 ? 'is-info' : 'is-muted', href: '/compliance?invoice_state=ready', sub: 'Compliance plans' },
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
    heroLink: {
      label: 'Open the HR Dashboard',
      href: '/hr',
      permKey: 'hr_dashboard',
      sub: 'Competency matrix, ticket expiries and workforce compliance at a glance',
    },
    extraLinks: [
      { label: 'Contacts', href: '/contacts', permKey: 'contacts',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>' },
      { label: 'HR Reports', href: '/hr/reports', permKey: 'hr_reports',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>' },
    ],
    needsKeys: ['pending_leave', 'expiring_tickets'],
    needsExtras(db, user, today) {
      if (!canAccess(user, 'induction')) return [];
      const c = count(db, "SELECT COUNT(*) AS c FROM induction_submissions WHERE status = 'submitted'");
      return c ? [{ key: 'onboarding_review', href: '/induction/admin/submissions', tone: 'info', priority: 30, count: c, label: c === 1 ? 'induction submission awaiting review' : 'induction submissions awaiting review', detail: '' }] : [];
    },
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
      const onboarding = count(db, "SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'submitted'");
      return [
        { label: 'Active crew', value: count(db, "SELECT COUNT(*) as c FROM crew_members WHERE active = 1"), tone: 'is-good', href: '/hr/roster' },
        { label: 'Tickets expiring', value: ticketsExpiring, tone: ticketsExpiring > 0 ? 'is-warn' : 'is-good', href: '/hr/roster', sub: 'Next 30 days' },
        { label: 'Pending leave', value: pendingLeave, tone: pendingLeave > 0 ? 'is-info' : 'is-muted', href: '/leave-approvals' },
        { label: 'In hiring pipeline', value: pipeline, tone: 'is-info', href: '/induction/admin/submissions' },
        { label: 'Onboarding to review', value: onboarding, tone: onboarding > 0 ? 'is-info' : 'is-muted', href: '/induction/admin/submissions', sub: 'Submitted inductions' },
      ];
    },
  },

  assets: {
    key: 'assets',
    label: 'Assets',
    blurb: 'Fleet, equipment, hire, documents and company reporting.',
    // Absorbed the Reports hub: the main /reports link arrives via the assets
    // sidebar section (moduleLinks pulls section links first), and only the
    // two curated report extras that aren't reachable from /reports itself
    // were carried over. /departments/reports redirects here.
    extraLinks: [
      { label: 'Vehicle Audits', href: '/vehicle-audits', permKey: 'audits',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>' },
      { label: 'Audit reports', href: '/audits/reports', permKey: 'audits', sub: 'Site audit outcomes and trends',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"/>' },
      { label: 'Plan P&L', href: '/finance/pnl', permKey: 'finance', sub: 'Compliance plan profitability',
        icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>' },
    ],
    needsKeys: ['fleet_flagged'],
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

  // 'reports' was a department here until Jul 2026 — merged into 'assets'
  // (sidebar section, hub, meetings and todos all moved across; migration 339
  // re-keyed the data and routes/departments.js redirects the old URLs).
};

const DEPARTMENT_ORDER = ['planning', 'safety', 'operations', 'finance', 'people', 'assets'];

function getDepartment(key) {
  return Object.prototype.hasOwnProperty.call(DEPARTMENTS, key) ? DEPARTMENTS[key] : null;
}

function userCanAccessDept(user, dept) {
  return require('./sidebarNav').sectionVisibleByKey(user, dept.key);
}

// The department's icon comes from the nav registry (lib/sidebarNav.js
// SECTIONS), so the sidebar section header and the hub page title always show
// the same mark — one source, no drifting copies.
function deptIcon(key) {
  const { SECTIONS } = require('./sidebarNav');
  const s = SECTIONS.find(x => x.key === key);
  return (s && s.icon) || '';
}

// Module grid for the hub: the department's sidebar links (same icons, same
// permission gates) plus extraLinks, with the hero's destination and any
// duplicate hrefs filtered out. Icons are raw SVG inner strings rendered
// inside <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">.
function moduleLinks(user, dept) {
  const { SECTIONS, makeCtx, linkVisible } = require('./sidebarNav');
  const ctx = makeCtx(user);
  const heroHref = dept.heroLink ? dept.heroLink.href : null;
  const out = [];
  const seen = new Set();
  const push = (l) => {
    if (!l.href || seen.has(l.href) || l.href === heroHref) return;
    seen.add(l.href);
    out.push({ label: l.label, href: l.href, icon: l.icon || '', sub: l.sub || '' });
  };
  if (dept.sectionLinks !== false) {
    const s = SECTIONS.find(x => x.key === dept.key);
    if (s) s.links.filter(l => linkVisible(ctx, l)).forEach(push);
  }
  (dept.extraLinks || []).filter(l => !l.permKey || canAccess(user, l.permKey)).forEach(push);
  return out;
}

module.exports = { DEPARTMENTS, DEPARTMENT_ORDER, getDepartment, userCanAccessDept, moduleLinks, deptIcon };
