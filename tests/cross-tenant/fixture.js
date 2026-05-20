/**
 * Cross-tenant test fixture.
 *
 * Each test gets a fresh in-memory SQLite database with:
 *  - a `tenants` table (matches the shape Phase 2 Prompt 02.A will create)
 *  - two seeded tenants: 'tenant-a' and 'tenant-b'
 *  - a `test_data` table that has a tenant_id column, used as a stand-in
 *    for real business tables until Phase 2 adds tenant_id to them
 *  - tenantDb instances scoped to each tenant
 *
 * Tests use this fixture to prove the wrapper actually isolates writes
 * between tenants — not just that assertScoped throws on bad SQL, but
 * that two tenants writing to the same table cannot see each other's
 * rows when each goes through its own tenantDb.
 *
 * In-memory (:memory:) keeps each test's state isolated and the suite
 * fast — no file I/O, no cleanup.
 */
const Database = require('better-sqlite3');
const { tenantDb } = require('../../lib/tenant-db');

function createTwoTenants() {
  const rawDb = new Database(':memory:');
  rawDb.pragma('journal_mode = WAL');
  rawDb.pragma('foreign_keys = ON');

  // Minimal tenants table — same shape Phase 2 Prompt 02.A will ship.
  rawDb.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      subdomain TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      tier TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE test_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL REFERENCES tenants(id),
      label TEXT NOT NULL
    );
    CREATE INDEX idx_test_data_tenant ON test_data(tenant_id);
  `);

  rawDb.prepare('INSERT INTO tenants (id, name, subdomain) VALUES (?, ?, ?)').run('tenant-a', 'Tenant A', 'a');
  rawDb.prepare('INSERT INTO tenants (id, name, subdomain) VALUES (?, ?, ?)').run('tenant-b', 'Tenant B', 'b');

  return {
    rawDb,
    dbA: tenantDb(rawDb, 'tenant-a'),
    dbB: tenantDb(rawDb, 'tenant-b'),
    cleanup() { rawDb.close(); },
  };
}

module.exports = { createTwoTenants };
