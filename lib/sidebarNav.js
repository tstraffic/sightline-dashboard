'use strict';
// ============================================================
// Sidebar navigation registry — THE single source of truth for
// the admin nav (Phase 4 of the nav review).
//
// - Sections render iff any child link is visible (derived gate,
//   no hand-maintained lists). lib/departments.js delegates hub
//   access to sectionVisibleByKey(), so "I can see the section
//   ⇔ I can open its hub" holds by construction.
// - Compound gates are predicates via show(ctx); simple gates are
//   perm: 'key' (canAccess) or perm: ['or','keys'].
// - active: currentPage sentinels; activeWhen(ctx) for quirks.
// - NEVER register a link whose href differs only by query string
//   from another — the customiser keys saved layouts by pathname
//   and silently deletes duplicates.
//
// SIGHTLINE TRIM (Phase 1): this deployment serves Sightline
// Traffic Engineers — the T&S traffic-control modules (bookings,
// crew, safety, fleet, payroll, quoting, worker portal…) are
// HIDDEN from the nav, not deleted. Their routes and permissions
// still exist; to restore a module, re-add its link here (the
// full T&S registry lives in git history of this file). Section
// keys 'sales', 'operations', 'finance', 'admin' are retained so
// pathname-keyed customiser layouts and lib/departments.js gating
// stay coherent. Hub links (hubHref) are delisted — Sightline has
// no department hubs in the nav.
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
    // Company Meetings — the weekly all-of-company minutes.
    { label: "Meetings", href: "/meetings",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M3 4h18M4 4v11a1 1 0 001 1h14a1 1 0 001-1V4M12 16v5m0 0l-3 0m3 0l3 0M8 12l2.5-2.5L13 12l3-3.5\"/>",
      active: ["meetings"],
      perm: "meetings" },
];

const SECTIONS = [
  // CRM — the front of the Sightline lifecycle (brief §3). Key stays
  // 'sales' (legacy) so canAccess gates and saved layouts hold.
  // Proposals / Referrals links land with their modules.
  { key: 'sales', label: 'CRM',
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
    { label: "Opportunities", href: "/opportunities",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 21a9 9 0 100-18 9 9 0 000 18zm0-4a5 5 0 100-10 5 5 0 000 10zm0-4a1 1 0 100-2 1 1 0 000 2z\"/>",
      active: ["opportunities"],
      perm: "crm" },
    { label: "Proposals", href: "/proposals",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z\"/>",
      active: ["proposals"],
      perm: "crm" },
    { label: "Referrals", href: "/referrals",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 12.632a3 3 0 105.367 2.684 3 3 0 00-5.367-2.684z\"/>",
      active: ["referrals"],
      perm: "crm" },
    { label: "CRM Dashboard", href: "/crm",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z\"/>",
      active: ["crm-dashboard"],
      perm: "crm" },
    { label: "Activities", href: "/crm/activities",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z\"/>",
      active: ["crm-activities"],
      perm: "crm" },
    { label: "CRM Meetings", href: "/crm/meetings",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z\"/>",
      active: ["crm-meetings"],
      perm: "crm" },
  ] },

  // Delivery — projects and their service packages (brief §4–5).
  // Key stays 'operations' (legacy) for layout/gating continuity.
  // The Service Packages link lands with its module.
  { key: 'operations', label: 'Delivery',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z\"/>",
    links: [
    { label: "Projects", href: "/projects",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4\"/>",
      active: ["projects"],
      perm: "projects",
      badges: [{ key: 'jobActions', tone: 'muted' }] },
  ] },

  // Money — trimmed to the project-facing pieces Sightline uses.
  { key: 'finance', label: 'Money',
    icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
    links: [
    { label: "Budgets & Costs", href: "/budgets",
      icon: "<path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z\"/>",
      active: ["budgets"],
      perm: "budgets" },
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
