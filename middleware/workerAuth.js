// Worker Portal authentication and authorization middleware

/**
 * Require an authenticated worker session.
 * Redirects to /w/login if no worker session exists.
 */
function requireWorker(req, res, next) {
  if (req.session && req.session.worker) {
    return next();
  }
  req.session.workerReturnTo = req.originalUrl;
  // Persist before redirecting — same session-store race as the logins.
  req.session.save(() => res.redirect('/w/login'));
}

/**
 * Ensure the worker can only access their own data.
 * Compares req.params[paramName] against req.session.worker.id.
 */
function requireOwnData(paramName) {
  return (req, res, next) => {
    if (!req.session || !req.session.worker) {
      return res.redirect('/w/login');
    }
    if (String(req.params[paramName]) !== String(req.session.worker.id)) {
      return res.status(403).render('worker/error', {
        layout: 'worker/layout',
        title: 'Access Denied',
        message: 'You can only view your own records.',
        worker: req.session.worker,
      });
    }
    next();
  };
}

/**
 * Block worker-only sessions from accessing admin routes.
 * If user has a worker session but NO admin session, redirect to worker home.
 * Must be mounted BEFORE admin route handlers.
 */
function blockWorkerFromAdmin(req, res, next) {
  // Skip for worker routes (they start with /w)
  if (req.path.startsWith('/w')) return next();
  // Skip for static assets and login
  if (req.path.startsWith('/css') || req.path.startsWith('/js') || req.path.startsWith('/images') || req.path === '/login' || req.path === '/manifest.json') return next();

  // If worker session exists but no admin session, redirect to worker portal
  if (req.session && req.session.worker && !req.session.user) {
    return res.redirect('/w/home');
  }
  next();
}

// Portal-role hierarchy. Higher tier inherits everything below it.
//   traffic_controller (1) — baseline
//   team_leader        (2) — TC + Team Leader Checklist + audit own crew
//   supervisor         (3) — TL + sign off other workers / stand-in office
const PORTAL_ROLE_RANK = { traffic_controller: 1, team_leader: 2, supervisor: 3 };

/**
 * Returns true if the given crew_member (or just their portal_role string)
 * has at least the required tier. Always true for supervisor when asking
 * for tc/tl/supervisor; always true for team_leader when asking for tc/tl.
 */
function hasPortalRole(memberOrRole, requiredRole) {
  const role = (memberOrRole && typeof memberOrRole === 'object')
    ? memberOrRole.portal_role
    : memberOrRole;
  const have = PORTAL_ROLE_RANK[role] || 0;
  const need = PORTAL_ROLE_RANK[requiredRole] || 0;
  // Need rank 0 (unknown role) means "no requirement" — pass.
  if (need === 0) return true;
  return have >= need;
}

/**
 * Express middleware: refuse to continue unless req.session.worker has
 * the required portal_role tier or higher. Falls back to /w/home with a
 * flash explaining the gap. Use on routes that should only be reachable
 * by team_leader+ or supervisor only.
 */
function requirePortalRole(requiredRole) {
  return (req, res, next) => {
    if (!req.session || !req.session.worker) return res.redirect('/w/login');
    // Pull the live role from the DB on each request — small (<1ms) and
    // means promotions/demotions take effect without a re-login.
    let portalRole = req.session.worker.portal_role;
    if (!portalRole) {
      try {
        const { getDb } = require('../db/database');
        const row = getDb().prepare('SELECT portal_role FROM crew_members WHERE id = ?').get(req.session.worker.id);
        portalRole = row && row.portal_role;
      } catch (_) {}
    }
    if (!hasPortalRole(portalRole, requiredRole)) {
      const friendly = requiredRole === 'team_leader' ? 'Team Leader' : requiredRole === 'supervisor' ? 'Supervisor' : 'higher';
      req.flash('error', `${friendly} access only.`);
      return res.redirect('/w/home');
    }
    next();
  };
}

/**
 * Set worker-specific template locals.
 * Sets res.locals.worker and overrides layout to worker/layout.
 */
function workerLocals(req, res, next) {
  res.locals.worker = req.session.worker || null;
  res.locals.layout = 'worker/layout';
  // Remember which portal was used last (page loads only, not API polls)
  // so the root route can send dual-session users to the right side.
  if (req.session && req.session.worker && req.session.lastPortal !== 'worker'
      && req.headers.accept && req.headers.accept.includes('text/html')) {
    req.session.lastPortal = 'worker';
  }
  // Flash messages for worker views. The GLOBAL locals middleware in
  // server.js already consumed req.flash() into res.locals for EVERY
  // request; re-reading here returns [] and used to overwrite the real
  // message — which is why flash banners never appeared anywhere in the
  // worker portal. Keep the captured values; only read as a fallback if
  // the global middleware didn't run.
  if (!Array.isArray(res.locals.flash_success)) res.locals.flash_success = req.flash('success');
  if (!Array.isArray(res.locals.flash_error)) res.locals.flash_error = req.flash('error');
  // Portal role helpers — pulled fresh from DB so promotions take effect
  // without the worker logging out and back in.
  let portalRole = 'traffic_controller';
  if (req.session && req.session.worker) {
    try {
      const { getDb } = require('../db/database');
      const row = getDb().prepare('SELECT portal_role FROM crew_members WHERE id = ?').get(req.session.worker.id);
      if (row && row.portal_role) portalRole = row.portal_role;
    } catch (_) {}
  }
  res.locals.portalRole = portalRole;
  res.locals.isTeamLeader = hasPortalRole(portalRole, 'team_leader');
  res.locals.isSupervisor = hasPortalRole(portalRole, 'supervisor');
  res.locals.hasPortalRole = (r) => hasPortalRole(portalRole, r);
  next();
}

module.exports = { requireWorker, requireOwnData, blockWorkerFromAdmin, workerLocals, requirePortalRole, hasPortalRole, PORTAL_ROLE_RANK };
