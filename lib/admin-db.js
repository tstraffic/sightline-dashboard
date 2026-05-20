/**
 * adminDb — INTENTIONAL bypass of tenant scoping.
 *
 * The atomis admin portal (admin.atomis.com.au, built in Phase 4) needs
 * cross-tenant queries: "list all tenants", "sum MRR across all
 * tenants", "show platform-wide churn", "find which tenant owns this
 * user". Those queries cannot go through lib/tenant-db.js — the wrapper
 * would throw on every one of them.
 *
 * This helper exposes the raw better-sqlite3 handle to admin routes
 * without the scope check. It is the ONLY sanctioned way to bypass
 * tenant scoping in request-context code.
 *
 * Import rules (enforced by scripts/check-raw-db.js):
 * - Only files under routes/admin/* may import this module.
 * - Only files under scripts/ may import this module (one-off
 *   maintenance / migration tools).
 * - Adding an import from anywhere else should fail CI; if there's a
 *   real need, justify it in a code review and add the path to the
 *   ADMIN_DB_ALLOWLIST in scripts/check-raw-db.js.
 *
 * The admin portal itself is built in Phase 4 (Prompt 04.A). This
 * helper exists in Phase 0 so the pattern is established and the grep
 * check has a target to enforce; until Phase 4 ships there are no
 * actual callers.
 */

/**
 * Wrap better-sqlite3 for admin routes. Same surface as the raw db
 * (prepare returns the raw Statement), but the call site has gone
 * through this helper and so is implicitly audited.
 */
function adminDb(rawDb) {
  if (!rawDb) throw new Error('adminDb requires a better-sqlite3 instance');
  return {
    prepare(sql) { return rawDb.prepare(sql); },
    transaction(fn) { return rawDb.transaction(fn); },
    exec(sql) { return rawDb.exec(sql); },
    pragma(s, opts) { return rawDb.pragma(s, opts); },
  };
}

/**
 * Middleware for admin routes. Checks the session is an authenticated
 * atomis admin and attaches req.adminDb. Returns 403 otherwise.
 *
 * Phase 0 stub: there is no atomis_admins table yet (Phase 4 Prompt
 * 04.A creates it), and there are no admin routes yet. This middleware
 * exists so the pattern is in place; until Phase 4 it always 403s,
 * which is the right behaviour for "admin portal isn't built yet."
 */
function requireAdmin(req, res, next) {
  const adminId = req.session && req.session.atomis_admin_id;
  if (!adminId) {
    return res.status(403).json({ error: 'atomis admin authentication required' });
  }
  // Phase 4 will replace this stub with a real lookup against the
  // atomis_admins table and attach req.adminDb here. For now the lack
  // of any atomis_admin_id in the session means we never get past the
  // 403 above, so the stub is safe to leave.
  return res.status(403).json({ error: 'atomis admin portal not yet built (Phase 4)' });
}

module.exports = { adminDb, requireAdmin };
