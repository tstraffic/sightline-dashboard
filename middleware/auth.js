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
  payslips:      ['admin', 'finance', 'accounts'],   // payslips list (alias for clarity)
  abergeldie_payments: ['admin', 'finance', 'accounts'], // client payment sheet
  budgets:       ['admin', 'finance'],
  crm:           ['admin'],
  admin:         ['admin'],
  activity:      ['admin'],
  settings:      ['admin', 'planning'],

  // ── Dual-view: Planning job tabs ──
  planning_plans:     ['admin', 'planning'],              // full plan workspace (drafts, revisions, mark final)
  planning_diary:     ['admin', 'planning', 'operations'],// site diary (both views)
  planning_chat:      ['admin', 'planning'],              // job-level chat

  // ── Dual-view: Operations job tabs ──
  ops_final_plans:    ['admin', 'operations'],            // read-only final plans
  ops_tasks:          ['admin', 'operations'],            // tasks (ops only)
  ops_timesheets:     ['admin', 'operations', 'finance'], // timesheet entry
  ops_incidents:      ['admin', 'operations'],            // incident reporting
  ops_flag:           ['admin', 'operations'],            // flag for review on final plans

  // ── Induction ──
  induction:          ['admin', 'operations', 'hr'],

  // ── HR modules ──
  hr_dashboard:       ['admin', 'hr'],
  hr_employees:       ['admin', 'hr'],
  // Leave approvals — ops + HR + admin can approve/reject worker leave.
  leave_approvals:    ['admin', 'operations', 'hr', 'management'],
  hr_documents:       ['admin', 'hr'],
  hr_competencies:    ['admin', 'hr'],
  hr_reports:         ['admin', 'hr'],
  hr_settings:        ['admin'],
  hr_compliance_view: ['admin', 'hr', 'operations'],

  // ── Marketing ──
  // Standalone role + admin. Marketing users see only /marketing (plus
  // /profile and /logout, which bypass permission checks).
  marketing:          ['admin', 'marketing'],
};

// ---- Helpers ----

/** Check if a user can access a given module (for templates / sidebar) */
function canAccess(user, module) {
  if (!user || !user.role) return false;
  const allowed = PERMISSIONS[module];
  if (!allowed) return false; // unknown module = deny
  return allowed.includes(normaliseRole(user.role));
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
  res.redirect('/login');
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
  const role = normaliseRole(req.session.user.role);
  if (role === 'finance' || role === 'admin') {
    return next();
  }
  res.status(403).render('error', {
    title: 'Access Denied',
    message: 'Accounts documents are restricted to Finance and Admin only.',
    user: req.session.user
  });
}

function canViewAccounts(user) {
  if (!user) return false;
  const role = normaliseRole(user.role);
  return role === 'finance' || role === 'admin';
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

module.exports = { requireLogin, requireRole, requirePermission, requireAccountsAccess, canViewAccounts, canViewSensitiveHR, canViewInternalCost, canAccess, normaliseRole, PERMISSIONS };
