// Authentication and role-based access middleware

// ---- Role Aliases ----
// Maps legacy DB role names to current role names.
// SQLite CHECK constraints prevent renaming in existing databases,
// so we normalise at runtime instead.
const ROLE_ALIASES = {
  management: 'admin',
  accounts:   'finance',
  // 'marketing' used to alias to 'operations' when there was no Marketing
  // module to land on. Now that /marketing exists, marketing is a real
  // standalone role — see PERMISSIONS.marketing below.
};

/** Normalise a role: convert legacy names to current ones */
function normaliseRole(role) {
  return ROLE_ALIASES[role] || role;
}

// ---- Centralised Permission Map ----
// Single source of truth: which roles can access which modules.
// Admin always has full access. Crew uses separate portal.
// Roles: admin (full), operations (no finance), planning (no finance), finance (finance + reporting),
//        hr (HR modules + limited ops), sales (CRM + limited ops)
const PERMISSIONS = {
  // ── Shared ──
  // 'sales' has been retired — kept out of every list so any historical
  // sales-role user is now effectively read-only at the auth layer until
  // an admin migrates them. The role still passes the users.role CHECK
  // (no migration), so existing rows aren't destroyed; they just can't
  // reach any module via the sidebar gates.
  dashboard:     ['admin', 'operations', 'planning', 'finance', 'hr', 'management', 'accounts', 'safety'],
  notes:         ['admin', 'operations', 'planning', 'finance', 'hr', 'management', 'accounts', 'safety'],
  jobs:          ['admin', 'operations', 'planning', 'finance', 'management'],
  projects:      ['admin', 'operations', 'planning', 'finance', 'management'],
  tenders:       ['admin', 'planning', 'management'],
  // Quotes = fixed-price offers for a known scope (vs. tenders = competitive
  // bid submissions). Same office cohort as tenders. Margin/cost columns
  // inside the module are gated separately by canViewInternalCost.
  quoting:       ['admin', 'planning', 'management'],
  clients:       ['admin', 'operations', 'planning', 'finance', 'hr', 'management', 'accounts'],
  notifications: ['admin', 'operations', 'planning', 'finance', 'hr', 'management', 'accounts', 'safety'],
  // ── Company Meetings (weekly all-of-company minutes; each department's
  //     tagged slice surfaces on its dept hub, so only admin/management need
  //     the main register. 'management' is redundant at runtime — ROLE_ALIASES
  //     normalises it to admin before canAccess checks — but listing it keeps
  //     the /admin/permissions matrix column honest, which reads these
  //     defaults without normalising.) ──
  meetings:      ['admin', 'management'],

  // ── Operations only (no planning) ──
  tasks:         ['admin', 'operations', 'planning'],  // planning sees only their own + plan-linked tasks
  incidents:     ['admin', 'operations', 'safety'],
  contacts:      ['admin', 'operations', 'hr'],
  timesheets:    ['admin', 'operations', 'finance'],
  crew:          ['admin', 'operations'],
  allocations:   ['admin', 'operations'],
  // Traffio reconciliation queue — ops/management map ambiguous Traffio
  // bookings/dockets to a job (or create one) before they become bookings.
  traffio_imports: ['admin', 'operations', 'management'],
  schedule:      ['admin', 'operations'],
  equipment:     ['admin', 'operations'],
  fleet:         ['admin', 'operations'],
  defects:       ['admin', 'operations'],
  documents:     ['admin', 'operations', 'finance'],
  bookings:      ['admin', 'operations'],
  reports:       ['admin', 'operations', 'finance', 'hr', 'management', 'accounts'],
  exports:       ['admin', 'operations', 'finance', 'hr', 'management', 'accounts'],
  // 'defects' permission retired with the Defects feature removal — kept
  // out of this map so canAccess(user, 'defects') returns false everywhere.

  // ── Planning only (no operations) ──
  // Finance is in here so they can open a plan and see its P&L. Cost +
  // profit tiles are role-gated again at render time so planning/ops
  // never see internal cost numbers.
  compliance:    ['admin', 'planning', 'management', 'operations', 'finance'],
  plans:         ['admin', 'planning', 'management', 'operations'],
  updates:       ['admin', 'planning'],

  // ── Site audits (safety/ops/planning/admin) ──
  audits:        ['admin', 'operations', 'planning', 'management', 'safety'],

  // ── Checklist templates (admin/planning manage templates, ops can view) ──
  checklists:    ['admin', 'operations', 'planning', 'safety'],

  // ── SWMS register (Safety-led, ops/planning can view) ──
  swms:          ['admin', 'safety', 'operations', 'planning'],

  // ── SOP register (Safety-led, ops/planning can view) ──
  sop_register:  ['admin', 'safety', 'operations', 'planning'],

  // ── Safety Updates (bulletins published to the worker portal) ──
  safety_updates: ['admin', 'safety', 'operations', 'planning'],

  // ── Toolbox Talks (archive + attendance tracking; office records, workers view) ──
  toolbox_talks: ['admin', 'safety', 'operations', 'planning'],

  // ── Safety Comments / Flags (worker submissions inbox; office moderates + responds) ──
  safety_comments: ['admin', 'safety', 'operations'],

  // ── Safety Quizzes (knowledge-check builder; office authors, workers take) ──
  safety_quizzes: ['admin', 'safety', 'operations', 'planning'],

  // ── Safety Workshops (facilitator-led office crew exercise; admins run
  //     sessions, office staff scan a QR and play on their phones) ──
  safety_workshops: ['admin', 'safety', 'operations', 'planning'],

  // ── Safety Reports (compliance + engagement dashboards; tighter than other
  //     Safety modules — admin/safety/management only, not ops/planning) ──
  safety_reports: ['admin', 'safety', 'management'],

  // ── Safety Today (cross-module safety command centre; the office safety
  //     cohort — admins see the full company picture) ──
  safety_today:  ['admin', 'safety', 'operations', 'management'],


  // ── Risk Assessment register (same access pattern as SWMS) ──
  risk_assessments: ['admin', 'safety', 'operations', 'planning'],

  // ── VOC (Verification of Competency) ──
  // Trainers (operations/safety) and admins create and submit assessments.
  // Template editing (theory Qs + practical checklist + validity) is
  // admin-only since changes affect compliance records org-wide.
  voc:            ['admin', 'operations', 'safety'],
  voc_admin:      ['admin'],

  // ── Finance / Admin ──
  // `finance` is the section gate — controls whether the Finance heading
  // even shows in the sidebar. Individual links inside have their own
  // gates so a user with only Timesheets access still sees the section
  // (they just see one item in it).
  finance:       ['admin', 'finance', 'accounts'],
  payroll:       ['admin', 'finance', 'accounts'],   // pay runs list + management runs
  invoicing:     ['admin', 'finance', 'accounts'],   // Traffio docket → QuickBooks invoicing
  payslips:      ['admin', 'finance', 'accounts'],   // payslips list (alias for clarity)
  abergeldie_payments: ['admin', 'finance', 'accounts'], // client payment sheet
  budgets:       ['admin', 'finance'],
  crm:           ['admin'],
  admin:         ['admin'],
  activity:      ['admin'],
  settings:      ['admin', 'planning'],

  // ── Job detail page tabs ──
  // Each key gates one tab on views/jobs/show.ejs (both the /jobs/:id and
  // /projects/:id mounts). Defaults reproduce the old hardcoded TABS_BY_ROLE
  // matrix exactly; /admin/permissions overrides now actually apply. The
  // planning_/ops_ prefixes are historical — kept so saved override rows and
  // admin-UI labels stay valid. The Overview tab is deliberately ungated.
  planning_plans:     ['admin', 'planning'],              // Traffic Plans tab (drafts, revisions, mark final)
  planning_diary:     ['admin', 'planning', 'operations'],// Site Diary tab
  planning_chat:      ['admin', 'operations', 'planning', 'finance', 'safety', 'hr', 'marketing'], // Chat tab (the old matrix's fallback gave Chat to every role)
  ops_tasks:          ['admin', 'operations'],            // Tasks tab
  ops_timesheets:     ['admin', 'operations', 'finance'], // Timesheets tab
  ops_incidents:      ['admin', 'operations', 'safety'],  // Incidents tab
  job_final_plans:    ['admin', 'operations', 'planning', 'finance', 'safety'], // Final Plans tab (read-only view; distinct from ops_final_plans below)
  job_safety:         ['admin', 'operations', 'planning', 'safety'], // Safety tab (SWMS/RA/audits/incidents roll-up)
  job_equipment:      ['admin', 'operations'],            // Equipment tab
  job_contacts:       ['admin', 'operations'],            // Contacts tab
  job_budget:         ['admin', 'operations', 'finance'], // Budget tab
  job_accounts:       ['admin', 'finance'],               // Accounts tab + accounts document library (canViewAccounts delegates here)

  // ── Ops sidebar links (NOT job tabs) ──
  ops_final_plans:    ['admin', 'operations'],            // "Tasks Board" + "Job Pack" sidebar links (lib/sidebarNav.js) — widening this moves the sidebar/hubs too
  ops_flag:           ['admin', 'operations'],            // flag for review on final plans

  // ── Induction ──
  induction:          ['admin', 'operations', 'hr'],

  // ── HR modules ──
  hr_dashboard:       ['admin', 'hr'],
  hr_employees:       ['admin', 'hr'],
  // Leave approvals — ops + HR + admin can approve/reject worker leave.
  leave_approvals:    ['admin', 'operations', 'hr', 'management'],
  hr_documents:       ['admin', 'hr'],
  // Employment contracts — generation + signing links carry pay rates and
  // personal details, so this stays as tight as the other sensitive HR keys.
  hr_contracts:       ['admin', 'hr'],
  hr_competencies:    ['admin', 'hr'],
  hr_reports:         ['admin', 'hr'],
  hr_settings:        ['admin'],
  hr_compliance_view: ['admin', 'hr', 'operations'],

  // ── Marketing ──
  // Standalone role + admin. Marketing users see only /marketing (plus
  // /profile and /logout, which bypass permission checks).
  marketing:          ['admin', 'marketing'],
};

// ---- Role permission overrides ----
// Admins can flip individual (role, permission) pairs via /admin/permissions.
// The DB row wins over the PERMISSIONS default for that pair only; everything
// else still uses the default map. Admin is always allowed (never blocked by
// an override) so a misconfigured save can't lock everyone out.
//
// Cache is invalidated on every save (see refreshRolePermissionOverrides).
let _rolePermissionOverrides = null; // Map<role, Map<permission, allowed:boolean>>

function loadRolePermissionOverrides() {
  try {
    const { getDb } = require('../db/database');
    const db = getDb();
    const rows = db.prepare('SELECT role, permission, allowed FROM role_permissions').all();
    const map = new Map();
    for (const r of rows) {
      if (!map.has(r.role)) map.set(r.role, new Map());
      map.get(r.role).set(r.permission, !!r.allowed);
    }
    _rolePermissionOverrides = map;
  } catch (e) {
    // Table may not exist yet (first boot before migration 253) — fall back to
    // an empty map so canAccess() just uses the hardcoded defaults.
    _rolePermissionOverrides = new Map();
  }
  return _rolePermissionOverrides;
}

function refreshRolePermissionOverrides() {
  _rolePermissionOverrides = null;
  return loadRolePermissionOverrides();
}

function getRoleOverride(role, module) {
  if (!_rolePermissionOverrides) loadRolePermissionOverrides();
  const roleMap = _rolePermissionOverrides.get(role);
  if (!roleMap) return undefined;
  return roleMap.has(module) ? roleMap.get(module) : undefined;
}

// ---- Helpers ----

/** Check if a user can access a given module (for templates / sidebar) */
function canAccess(user, module) {
  if (!user || !user.role) return false;
  const role = normaliseRole(user.role);
  // Admin is never blocked by an override.
  if (role === 'admin') {
    const allowed = PERMISSIONS[module];
    return Array.isArray(allowed) ? allowed.includes('admin') : false;
  }
  const override = getRoleOverride(role, module);
  if (override !== undefined) return override;
  const allowed = PERMISSIONS[module];
  if (!allowed) return false; // unknown module = deny
  return allowed.includes(role);
}

/** Express middleware: require permission for a module */
function requirePermission(module) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (canAccess(req.session.user, module)) {
      return next();
    }
    res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You do not have permission to access this resource.',
      user: req.session.user
    });
  };
}

// ---- Existing middleware ----

function requireLogin(req, res, next) {
  if (req.session && req.session.user) {
    // Normalise legacy role in session so templates see current name
    req.session.user.role = normaliseRole(req.session.user.role);
    res.locals.user = req.session.user;
    // Remember which portal was used last (page loads only, not API polls)
    // so the root route can send dual-session users to the right side.
    if (req.session.lastPortal !== 'admin' && req.headers.accept && req.headers.accept.includes('text/html')) {
      req.session.lastPortal = 'admin';
    }
    return next();
  }
  // For AJAX / API requests, return 401 instead of saving the URL as returnTo
  // and redirecting. Otherwise a background poll (e.g. /chat/api/unread-count)
  // that fires after the session expires will hijack the post-login redirect,
  // landing the user on a raw JSON response after they sign back in.
  const isApi = req.xhr
    || req.path.startsWith('/api/')
    || req.path.includes('/api/')
    || (req.headers.accept && !req.headers.accept.includes('text/html'));
  if (isApi) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  req.session.returnTo = req.originalUrl;
  // Persist returnTo before the browser follows the redirect — otherwise
  // the session-store write can race the /login request and the post-login
  // redirect falls back to the dashboard.
  req.session.save(() => res.redirect('/login'));
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/login');
    }
    if (roles.includes(normaliseRole(req.session.user.role))) {
      return next();
    }
    res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You do not have permission to access this resource.',
      user: req.session.user
    });
  };
}

function requireAccountsAccess(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  if (canViewAccounts(req.session.user)) {
    return next();
  }
  res.status(403).render('error', {
    title: 'Access Denied',
    message: 'Accounts documents are restricted to Finance and Admin only.',
    user: req.session.user
  });
}

// Accounts surface = the job Accounts tab, the "Accounts Owner" overview
// field, and the accounts document library (documents/exports/reports).
// One `job_accounts` toggle in /admin/permissions governs all of it —
// default finance + admin, same as the old hardcoded role check.
function canViewAccounts(user) {
  return canAccess(user, 'job_accounts');
}

/** Check if user can view sensitive HR data (DOB, emergency contacts, disciplinary, etc.) */
function canViewSensitiveHR(user) {
  if (!user) return false;
  const role = normaliseRole(user.role);
  return role === 'admin' || role === 'hr';
}

// Internal labour cost + plan-level profit/loss. Compliance is open to
// planning/ops/safety so they can manage sub-plans, but the cost and
// profit numbers must stay invisible to anyone other than admin/finance.
function canViewInternalCost(user) {
  if (!user) return false;
  const role = normaliseRole(user.role);
  return role === 'admin' || role === 'finance';
}

module.exports = { requireLogin, requireRole, requirePermission, requireAccountsAccess, canViewAccounts, canViewSensitiveHR, canViewInternalCost, canAccess, normaliseRole, PERMISSIONS, refreshRolePermissionOverrides };
