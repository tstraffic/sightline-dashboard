/**
 * tenantDb — the safety wrapper around better-sqlite3.
 *
 * Every request gets req.db = tenantDb(rawDb, req.tenant.id). Route
 * handlers call req.db.prepare(sql) instead of importing better-sqlite3
 * directly. The wrapper asserts that every query is scoped by tenant_id
 * before executing it, so a missed WHERE clause throws at runtime
 * instead of silently leaking one tenant's data into another's view.
 *
 * The SQL inspection is REGEX-based, not a real parser. Three reasons:
 * - No new dependency (node-sql-parser pulls a whole AST library)
 * - Crude regex catches every realistic mistake we'd make
 * - Cross-tenant leak tests (tests/cross-tenant/) are the second line
 *
 * What it catches:
 * - SELECT/UPDATE/DELETE without a 'tenant_id' substring → throws
 * - INSERT without tenant_id in the column list → throws
 * - Queries against non-whitelisted tables → throws
 *
 * What it deliberately doesn't catch:
 * - JOIN onto a second tenant-scoped table whose tenant_id isn't filtered
 *   (the WHERE clause check passes for the primary table, the joined one
 *   relies on referential integrity). Documented limitation.
 * - Dynamic SQL constructed in pieces and bound piecemeal. Don't write
 *   that style; if you must, use explicit assertions.
 * - Subqueries against other tables. Same JOIN caveat.
 *
 * Phase 0 hardcodes tenant_id = 'ts' via middleware/tenant.js. Real
 * subdomain resolution ships in Phase 3 Prompt 03.A.
 */

// Global tables — these are not tenant-scoped and queries against them
// must NOT include a tenant_id filter. New globals get added here as
// they're created.
const GLOBAL_TABLES = new Set([
  'tenants',            // Phase 2 prompt 02.A creates this
  'system_config',      // platform-wide config (VAPID keys, etc.)
  'audit_log',          // system-wide audit
  'admin_audit_log',    // Phase 4 — atomis admin actions
  'atomis_admins',      // Phase 4 — separate from any tenant's users
  'atomis_admin_recovery_codes', // Phase 4 — MFA recovery
  'schema_migrations',  // migration tracking
  'sessions',           // cookie-domain scoping handles tenant isolation
  // SQLite internal
  'sqlite_master',
  'sqlite_sequence',
  'sqlite_temp_master',
]);

class TenantScopeError extends Error {
  constructor(msg) { super(msg); this.name = 'TenantScopeError'; }
}

function truncate(s, n = 240) {
  return s.length > n ? s.slice(0, n) + '...' : s;
}

/**
 * Find the first target table in a SQL statement. Returns { op, table }
 * or null for statements that don't touch a table (PRAGMA, EXPLAIN,
 * BEGIN/COMMIT, etc.).
 */
function detectTarget(sql) {
  // Strip line comments to avoid false matches inside `-- ...`.
  const stripped = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const tail = stripped.trim();
  let m;
  if ((m = tail.match(/^\s*UPDATE\s+([a-zA-Z_]\w*)/i))) return { op: 'UPDATE', table: m[1] };
  if ((m = tail.match(/^\s*DELETE\s+FROM\s+([a-zA-Z_]\w*)/i))) return { op: 'DELETE', table: m[1] };
  if ((m = tail.match(/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([a-zA-Z_]\w*)/i))) return { op: 'INSERT', table: m[1] };
  if ((m = tail.match(/^\s*(?:WITH\s+[\s\S]+?\s+)?SELECT\b[\s\S]*?\bFROM\s+([a-zA-Z_]\w*)/i))) return { op: 'SELECT', table: m[1] };
  return null;
}

/**
 * Throw if `sql` isn't safely tenant-scoped. Whitelisted (global) tables
 * are allowed without a tenant filter.
 */
function assertScoped(sql) {
  const det = detectTarget(sql);
  if (!det) return; // PRAGMA / EXPLAIN / BEGIN / etc.

  if (GLOBAL_TABLES.has(det.table.toLowerCase())) return;

  if (det.op === 'INSERT') {
    // Pull out the column list — `INSERT INTO foo (a, b, c) VALUES ...`
    const cols = sql.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s*\(([^)]+)\)/i);
    if (cols) {
      if (!/\btenant_id\b/i.test(cols[1])) {
        throw new TenantScopeError(
          `INSERT missing tenant_id column for table "${det.table}". SQL: ${truncate(sql)}`
        );
      }
      return;
    }
    // INSERT without an explicit column list (e.g. INSERT INTO foo SELECT ...)
    // Fall through to substring check so the SELECT's tenant_id is required.
  }

  // SELECT / UPDATE / DELETE / column-less INSERT — require the substring
  // `tenant_id` anywhere in the SQL. Crude but catches every realistic miss.
  if (!/\btenant_id\b/i.test(sql)) {
    throw new TenantScopeError(
      `Query against "${det.table}" missing tenant_id filter. SQL: ${truncate(sql)}`
    );
  }
}

/**
 * Wrap a better-sqlite3 Statement so calls go through the same surface as
 * the raw statement but with the safety check already applied at prepare
 * time. .pluck()/.raw() return the wrapper so they remain chainable.
 */
function wrapStatement(stmt) {
  const wrapped = {
    get: (...args) => stmt.get(...args),
    all: (...args) => stmt.all(...args),
    run: (...args) => stmt.run(...args),
    iterate: (...args) => stmt.iterate(...args),
    pluck(toggle = true) { stmt.pluck(toggle); return wrapped; },
    raw(toggle = true) { stmt.raw(toggle); return wrapped; },
    expand(toggle = true) { stmt.expand(toggle); return wrapped; },
    bind: (...args) => { stmt.bind(...args); return wrapped; },
  };
  return wrapped;
}

/**
 * Build a tenant-scoped DB handle. Routes use this via req.db; the raw
 * better-sqlite3 handle is hidden from request-context code.
 *
 * @param {Database} rawDb - the underlying better-sqlite3 instance
 * @param {string} tenantId - the active tenant id (e.g. 'ts')
 * @returns {object} - wrapper exposing .prepare() and .transaction()
 */
function tenantDb(rawDb, tenantId) {
  if (!rawDb) throw new Error('tenantDb requires a better-sqlite3 instance');
  if (!tenantId) throw new Error('tenantDb requires a tenant id');

  const wrapper = {
    /**
     * Identical to better-sqlite3's prepare(), except every query is
     * inspected for tenant scoping first.
     */
    prepare(sql) {
      assertScoped(sql);
      const stmt = rawDb.prepare(sql);
      return wrapStatement(stmt);
    },

    /**
     * Delegates to rawDb.transaction(). The fn closes over the wrapped
     * db in the caller's scope, so all .prepare() calls inside the
     * transaction still go through assertScoped.
     */
    transaction(fn) {
      return rawDb.transaction(fn);
    },

    /**
     * Exposed for diagnostics (logging, tenant tag in errors). Don't use
     * this to build SQL — bind tenant_id as a parameter instead.
     */
    get tenantId() { return tenantId; },
  };

  return wrapper;
}

module.exports = {
  tenantDb,
  assertScoped,
  detectTarget,
  TenantScopeError,
  GLOBAL_TABLES,
};
