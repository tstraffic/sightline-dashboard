'use strict';
// ============================================================
// Sidebar navigation registry — THE single source of truth for
// the admin nav (Phase 4 of the nav review).
//
// - Sections render iff any child link is visible (derived gate,
//   no hand-maintained lists). lib/departments.js delegates hub
//   access to sectionVisibleByKey(), so "I can see the section
//   ⇔ I can open its hub" holds by construction.
// - Section keys MUST match lib/departments.js dept keys where a
//   hub exists (planning, safety, operations, finance, people,
//   assets — reports merged into assets, /departments/reports
//   redirects there).
// - Compound gates are predicates via show(ctx); simple gates are
//   perm: 'key' (canAccess) or perm: ['or','keys'].
// - active: currentPage sentinels; activeWhen(ctx) for the one
//   Wage Tiers quirk (parity with the old sidebar).
// - NEVER register a link whose href differs only by query string
//   from another — the customiser keys saved layouts by pathname
//   and silently deletes duplicates.
// ============================================================
const { canAccess, canViewInternalCost } = require('../middleware/auth');

function makeCtx(user) {
  return {
    user,
    can: (k) => canAccess(user, k),
    canSeeCost: canViewInternalCost(user),
  };
}

const TOP_LINKS = [
    { label: "Today", href: "/dashboard",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6\"/>",
      active: [],
      perm: "dashboard" },
    { label: "Tasks", href: "/tasks",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4\"/>",
      active: ["tasks"],
      perm: "tasks",
      badges: [{ value: (b) => (b.tasksPlanningOverdue || 0) + (b.tasksOpsOverdue || 0), tone: 'danger' }, { value: (b) => (b.tasksPlanning || 0) + (b.tasksOps || 0), tone: 'muted' }],
      title: (b) => `${b.tasksPlanningOverdue || 0} planning · ${b.tasksOpsOverdue || 0} ops overdue` },
    { label: "Notes", href: "/notes",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-7 7h4m-4 4h4m-7-8h.01M5 16h.01\"/>",
      active: ["notes"],
      perm: "notes" },
    // Company Meetings — the weekly all-of-company minutes. Dept slices
    // surface on the dept hubs, so this register is admin/management only.
    // Presentation-board glyph: the user-group one is the People section's.
    { label: "Meetings", href: "/meetings",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 4h18M4 4v11a1 1 0 001 1h14a1 1 0 001-1V4M12 16v5m0 0l-3 0m3 0l3 0M8 12l2.5-2.5L13 12l3-3.5\"/>",
      active: ["meetings"],
      perm: "meetings" },
];

const SECTIONS = [
  // Grid/hub glyph, deliberately NOT the calendar — Bookings sits directly
  // under this header and owns the calendar. The dept hub page title reuses
  // this same icon via deptIcon().
  { key: 'operations', label: 'Operations', hubHref: '/departments/operations', hubActive: 'dept-operations',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z\"/>",
    links: [
    { label: "Bookings", href: "/bookings",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z\"/>",
      active: ["bookings"],
      perm: "bookings",
      badges: [{ key: 'allocations', tone: 'muted' }] },
    { label: "Jobs", href: "/projects",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4\"/>",
      active: ["projects"],
      perm: "projects",
      badges: [{ key: 'jobActions', tone: 'muted' }] },
    { label: "Tasks Board", href: "/shift-tasks",
      icon: "<rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" rx=\"2\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 11l2 2 4-4\"/>",
      active: ["shift-tasks"],
      perm: "ops_final_plans" },
    { label: "Job Pack", href: "/safety-forms",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 11l3 3 5-5\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M21 12c0 6-4.5 9-9 10C7.5 21 3 18 3 12V6l9-3 9 3z\"/>",
      active: ["safety-forms", "checklist-register", "dockets-admin"],
      perm: "ops_final_plans" },
    { label: "Leave Approvals", href: "/leave-approvals",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M2.5 19l19-7.5L2.5 4v7l13 .5-13 .5z\"/>",
      active: ["leave-approvals"],
      perm: "leave_approvals",
      badges: [{ key: 'leavePending', tone: 'muted' }] },
    { label: "Traffio Sync", href: "/traffio-imports",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M4 4v5h5M20 20v-5h-5M5.5 9A7 7 0 0118 7.5M18.5 15A7 7 0 016 16.5\"/>",
      active: ["traffio-imports"],
      perm: "traffio_imports",
      badges: [{ key: 'traffioPending', tone: 'danger' }] },
  ] },

  { key: 'planning', label: 'Planning', hubHref: '/departments/planning', hubActive: 'dept-planning',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7\"/>",
    links: [
    { label: "Plans & Approvals", href: "/compliance",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z\"/>",
      active: ["compliance"],
      perm: "compliance",
      badges: [{ key: 'complianceOverdue', tone: 'danger' }, { key: 'compliance', tone: 'muted' }] },
    { label: "TGS Risk Assessment", href: "/tgs-risk-assessments",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z\"/>",
      active: ["tgs-risk-assessments"],
      perm: "compliance" },
    { label: "Tenders", href: "/tenders",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z\"/>",
      active: ["tenders"],
      perm: "tenders" },
    { label: "Quotes", href: "/quotes",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 7h6m-6 4h6m-6 4h4M5 5a2 2 0 012-2h10a2 2 0 012 2v14l-4-2-3 2-3-2-4 2V5z\"/>",
      active: ["quotes"],
      perm: "quoting" },
    { label: "Rate Cards", href: "/rate-cards",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 10h18M3 14h18M3 18h18M3 6h18\"/>",
      active: ["quoting"],
      perm: "quoting" },
  ] },

  { key: 'safety', label: 'Safety', hubHref: '/departments/safety', hubActive: 'dept-safety',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z\"/>",
    links: [
    { label: "Safety Today", href: "/safety-today",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M13 10V3L4 14h7v7l9-11h-7z\"/>",
      active: ["safety-today"],
      perm: "safety_today",
      pill: "New" },
    { label: "Incidents", href: "/incidents",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z\"/>",
      active: ["incidents"],
      perm: "incidents",
      badges: [{ key: 'incidents', tone: 'danger' }] },
    { label: "Audits", href: "/audits",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z\"/>",
      active: ["audits", "vehicle-audits"],
      perm: "audits" },
    { label: "Checklists", href: "/checklists",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4\"/>",
      active: ["checklists"],
      perm: "checklists" },
    { label: "Risk Assessments", href: "/risk-assessments",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z\"/>",
      active: ["risk-assessments"],
      perm: "risk_assessments" },
    { label: "VOCs", href: "/voc-assessments",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z\"/>",
      active: ["voc-assessments"],
      perm: "voc" },
    { label: "SWMS", href: "/swms",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z\"/>",
      active: ["swms"],
      perm: "swms",
      sub: "Library" },
    { label: "SOP", href: "/sop-register",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z M14 3v6h6 M9 14h6 M9 17h4\"/>",
      active: ["sop-register"],
      perm: "sop_register",
      sub: "Library" },
    { label: "Toolbox Talks", href: "/toolbox-talks",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z\"/>",
      active: ["toolbox-talks"],
      perm: "toolbox_talks",
      sub: "Library" },
    { label: "Safety Updates", href: "/safety-updates",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z\"/>",
      active: ["safety-updates"],
      perm: "safety_updates",
      sub: "Library" },
    { label: "Safety Comments", href: "/safety-comments",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z\"/>",
      active: ["safety-comments"],
      perm: "safety_comments",
      sub: "Library" },
    { label: "Safety Quizzes", href: "/safety-quizzes",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4\"/>",
      active: ["safety-quizzes"],
      perm: "safety_quizzes",
      sub: "Training" },
    { label: "Workshops", href: "/safety-workshops",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z\"/>",
      active: ["safety-workshops"],
      perm: "safety_workshops",
      sub: "Training" },
  ] },

  { key: 'people', label: 'People', hubHref: '/departments/people', hubActive: 'dept-people',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z\"/>",
    links: [
    { label: "HR Dashboard", href: "/hr",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z\"/>",
      active: ["hr-competencies", "hr-dashboard"],
      perm: "hr_dashboard" },
    { label: "Roster", href: "/hr/roster",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z\"/>",
      active: ["crew", "hr-employees", "hr-roster"],
      perm: ["crew", "hr_employees"],
      badges: [{ key: 'crew', tone: 'muted' }] },
    { label: "Hiring", href: "/induction/admin/submissions",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01\"/>",
      active: ["induction"],
      perm: "induction" },
    { label: "Contracts", href: "/contracts",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2zM15 12l-1.5 1.5\"/>",
      active: ["contracts"],
      perm: "hr_contracts" },
    { label: "Training Slides", href: "/induction/admin/presentations",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z\"/>",
      active: ["induction-presentations"],
      perm: "induction" },
    { label: "Kudos", href: "/kudos-admin/feed",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 2l2.9 6.3 6.6.6-5 4.5 1.5 6.8L12 17l-6 3.2 1.5-6.8-5-4.5 6.6-.6L12 2z\"/>",
      active: ["kudos-feed", "kudos-queue", "kudos-values"],
      perm: ["crew", "hr_employees"] },
    { label: "Payroll Sync", href: "/hr/secure-queue",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z\"/>",
      active: ["hr-secure-queue"],
      perm: ["crew", "hr_employees"] },
  ] },

  { key: 'finance', label: 'Money', hubHref: '/departments/finance', hubActive: 'dept-finance',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
    links: [
    { label: "Invoicing", href: "/finance/invoicing",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 14h6m-6-4h6m-7 8l-2 2V6a2 2 0 012-2h8a2 2 0 012 2v14l-2-2-2 2-2-2-2 2-2-2z\"/>",
      active: ["invoicing"],
      perm: "invoicing" },
    { label: "Pay Runs", href: "/payroll/runs",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z\"/>",
      active: ["pay-runs"],
      perm: "payroll" },
    { label: "Payslips", href: "/payroll/payslips",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z\"/>",
      active: ["payslips"],
      perm: "payroll" },
    { label: "Timesheets", href: "/timesheets",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
      active: ["timesheets"],
      perm: "timesheets" },
    { label: "Wage Tiers", href: "/payroll/wage-tiers",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z\"/>",
      active: [],
      perm: "payroll",
      activeWhen: ({ currentPage, title }) => currentPage === 'pay-runs' && title === 'Wage Tiers' },
    { label: "Budgets & Costs", href: "/budgets",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
      active: ["budgets"],
      perm: "budgets" },
    { label: "Plan P&L", href: "/finance/pnl",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z\"/>",
      active: ["finance-pnl"],
      show: (ctx) => ctx.canSeeCost },
    { label: "Abergeldie Payment Sheet", href: "/finance/abergeldie",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z\"/>",
      active: ["abergeldie-payments"],
      perm: "abergeldie_payments" },
  ] },

  { key: 'sales', label: 'Clients & Sales', 
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M13 7h8m0 0v8m0-8l-8 8-4-4-6 6\"/>",
    links: [
    { label: "Clients", href: "/clients",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4\"/>",
      active: ["clients"],
      perm: "clients" },
    { label: "Contacts", href: "/contacts",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z\"/>",
      active: ["contacts"],
      perm: "contacts" },
    { label: "Pipeline", href: "/opportunities/pipeline",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M13 7h8m0 0v8m0-8l-8 8-4-4-6 6\"/>",
      active: ["pipeline"],
      perm: "crm" },
    { label: "BDM Dashboard", href: "/crm",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z\"/>",
      active: ["crm-dashboard"],
      perm: "crm" },
    { label: "Activities", href: "/crm/activities",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z\"/>",
      active: ["crm-activities"],
      perm: "crm" },
    { label: "CRM Meetings", href: "/crm/meetings",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z\"/>",
      active: ["crm-meetings"],
      perm: "crm" },
    { label: "Marketing", href: "/marketing",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z\"/>",
      active: ["marketing"],
      perm: "marketing" },
  ] },

  { key: 'assets', label: 'Assets', hubHref: '/departments/assets', hubActive: 'dept-assets',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.7\" d=\"M3 13l1.5-5A2 2 0 016.43 6.5h11.14a2 2 0 011.93 1.5L21 13m-18 0v5a1 1 0 001 1h1a1 1 0 001-1v-1h12v1a1 1 0 001 1h1a1 1 0 001-1v-5M3 13h18M7 16h.01M17 16h.01\"/>",
    links: [
    { label: "Vehicles", href: "/fleet",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.7\" d=\"M3 13l1.5-5A2 2 0 016.43 6.5h11.14a2 2 0 011.93 1.5L21 13m-18 0v5a1 1 0 001 1h1a1 1 0 001-1v-1h12v1a1 1 0 001 1h1a1 1 0 001-1v-5M3 13h18M7 16h.01M17 16h.01\"/>",
      active: ["fleet"],
      perm: "fleet" },
    { label: "Equipment / Hire", href: "/equipment",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z\"/>",
      active: ["equipment"],
      perm: "equipment",
      badges: [{ key: 'hireOverdue', tone: 'danger' }],
      title: (b) => b.hireOverdue ? `${b.hireOverdue} hire(s) past return date — still on meter` : '' },
    { label: "Documents", href: "/documents",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4\"/>",
      active: ["documents"],
      perm: "documents" },
    // Reports merged in here — the standalone Reports section (and hub) is
    // gone; Assets absorbed it. The negated gates on Safety/HR Reports let
    // specialised-report users keep their link without duplicating it for
    // umbrella `reports` users, exactly as before the merge.
    { label: "Reports", href: "/reports",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z\"/>",
      active: ["reports"],
      perm: "reports" },
    { label: "Safety Reports", href: "/safety-reports",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z\"/>",
      active: ["safety-reports"],
      show: (ctx) => ctx.can('safety_reports') && !ctx.can('reports') },
    { label: "HR Reports", href: "/hr/reports",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z\"/>",
      active: ["hr-reports"],
      show: (ctx) => ctx.can('hr_reports') && !ctx.can('reports') },
  ] },

  { key: 'admin', label: 'Admin', 
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"/>",
    links: [
    { label: "Manage Users", href: "/admin/users",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m13.5-9a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z\"/>",
      active: ["admin"],
      perm: "admin" },
    { label: "Activity Log", href: "/activity",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
      active: ["activity"],
      perm: "admin" },
    { label: "Settings", href: "/settings",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z\"/><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M15 12a3 3 0 11-6 0 3 3 0 016 0z\"/>",
      active: ["settings"],
      perm: "settings" },
    { label: "Integrations", href: "/admin/integrations",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M13 7l-1.5-1.5a3.5 3.5 0 00-5 5L8 12m3 5l1.5 1.5a3.5 3.5 0 005-5L19 12M9 15l6-6\"/>",
      active: ["integrations"],
      perm: "admin" },
    { label: "Role Permissions", href: "/admin/permissions",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" d=\"M9 12l2 2 4-4M12 3l8 4v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V7l8-4z\"/>",
      active: ["admin-permissions"],
      perm: "admin" },
    { label: "IT Feedback", href: "/feedback",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.4-4 8-9 8a9.9 9.9 0 01-4-.8L3 21l1.5-4.5C3.5 15.3 3 13.7 3 12c0-4.4 4-8 9-8s9 3.6 9 8z\"/>",
      active: ["feedback"],
      show: (ctx) => ctx.can('admin') || (ctx.user && ctx.user.role === 'admin') },
  ] },
];

function linkVisible(ctx, l) {
  if (l.show) return !!l.show(ctx);
  if (!l.perm) return true;
  return Array.isArray(l.perm) ? l.perm.some(ctx.can) : ctx.can(l.perm);
}

function sectionVisible(ctx, s) {
  return s.links.some((l) => linkVisible(ctx, l));
}

// Hub access for lib/departments.js — hub opens iff its sidebar section
// renders for this user (replaces the old hand-synced accessKeys arrays).
function sectionVisibleByKey(user, key) {
  const s = SECTIONS.find((x) => x.key === key);
  return !!s && sectionVisible(makeCtx(user), s);
}

module.exports = { TOP_LINKS, SECTIONS, makeCtx, linkVisible, sectionVisible, sectionVisibleByKey };
