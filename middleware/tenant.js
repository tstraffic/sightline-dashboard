/**
 * Tenant resolution middleware.
 *
 * Attaches req.tenant + req.db to every request. Phase 0 hardcodes the
 * T&S tenant — real subdomain lookup against the `tenants` table ships
 * in Phase 3 Prompt 03.A once that table exists (Phase 2 Prompt 02.A).
 *
 * Until then, every request behaves as tenant 'ts'. The wrapper still
 * enforces tenant_id scoping on every query, so routes that get
 * migrated to req.db are already safe even though there's only one
 * tenant.
 *
 * Mount order in server.js: AFTER express-session, BEFORE route
 * handlers. The session needs req.session populated first; route
 * handlers need req.tenant + req.db available.
 */
const { getDb } = require('../db/database');
const { tenantDb } = require('../lib/tenant-db');

// Phase-0 stub. Replaced with a real tenants-table lookup in Phase 3.
// Keep the shape stable so downstream code doesn't need updating then.
const TS_TENANT = Object.freeze({
  id: 'ts',
  name: 'T&S Traffic Control',
  subdomain: 'ts',
  status: 'active',
  tier: 'operator',
});

function tenantMiddleware(req, res, next) {
  // Hardcoded until Phase 3 brings real subdomain resolution online.
  req.tenant = TS_TENANT;
  req.db = tenantDb(getDb(), TS_TENANT.id);

  // Make tenant available to every EJS render without each route having
  // to pass it explicitly. Phase 3 Prompt 03.B will lean on this.
  res.locals.tenant = TS_TENANT;

  next();
}

module.exports = { tenantMiddleware, TS_TENANT };
