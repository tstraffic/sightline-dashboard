/**
 * Wrapper-level safety tests.
 *
 * Exhaustively exercises assertScoped — the regex that decides whether
 * a SQL statement is safe to run. Every variant of an "I forgot the
 * tenant_id" mistake should throw a TenantScopeError BEFORE the query
 * reaches better-sqlite3. Every legitimate scoped query should pass.
 *
 * If this test file goes red, the wrapper has regressed. Don't merge
 * Phase 2 work until it's green.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertScoped, TenantScopeError } = require('../../lib/tenant-db');

test.describe('assertScoped — unscoped queries throw', () => {
  for (const sql of [
    'SELECT * FROM jobs',
    'SELECT id, name FROM jobs WHERE id = 1',
    'SELECT * FROM crew_members',
    'UPDATE jobs SET status = ? WHERE id = ?',
    'DELETE FROM jobs WHERE id = ?',
    'INSERT INTO jobs (name, status) VALUES (?, ?)',
    'INSERT OR REPLACE INTO jobs (id, name) VALUES (?, ?)',
    'INSERT OR IGNORE INTO crew_members (id, name) VALUES (?, ?)',
  ]) {
    test(sql, () => {
      assert.throws(
        () => assertScoped(sql),
        (err) => err instanceof TenantScopeError && err.message.includes('tenant_id'),
        `expected TenantScopeError, got nothing or wrong type for: ${sql}`,
      );
    });
  }
});

test.describe('assertScoped — scoped queries pass', () => {
  for (const sql of [
    'SELECT * FROM jobs WHERE tenant_id = ?',
    'SELECT j.* FROM jobs j WHERE j.tenant_id = ? AND j.status = ?',
    'UPDATE jobs SET status = ? WHERE id = ? AND tenant_id = ?',
    'DELETE FROM jobs WHERE id = ? AND tenant_id = ?',
    'INSERT INTO jobs (tenant_id, name, status) VALUES (?, ?, ?)',
    'INSERT OR REPLACE INTO jobs (tenant_id, id, name) VALUES (?, ?, ?)',
    'WITH live AS (SELECT id FROM jobs WHERE tenant_id = ?) SELECT * FROM live',
  ]) {
    test(sql, () => {
      assert.doesNotThrow(() => assertScoped(sql), `unexpected throw for: ${sql}`);
    });
  }
});

test.describe('assertScoped — whitelisted global tables pass without scoping', () => {
  for (const sql of [
    'SELECT * FROM tenants',
    'SELECT * FROM tenants WHERE id = ?',
    'SELECT * FROM system_config',
    'INSERT INTO system_config (config_key, config_value) VALUES (?, ?)',
    'SELECT * FROM schema_migrations',
    'SELECT * FROM atomis_admins WHERE username = ?',
    'SELECT * FROM admin_audit_log',
    'SELECT * FROM sessions WHERE sid = ?',
    'SELECT * FROM sqlite_master',
  ]) {
    test(sql, () => {
      assert.doesNotThrow(() => assertScoped(sql), `unexpected throw for whitelisted: ${sql}`);
    });
  }
});

test.describe('assertScoped — non-table statements pass', () => {
  for (const sql of [
    'PRAGMA foreign_keys = ON',
    'PRAGMA journal_mode = WAL',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'EXPLAIN QUERY PLAN SELECT 1',
  ]) {
    test(sql, () => {
      assert.doesNotThrow(() => assertScoped(sql), `unexpected throw for non-table SQL: ${sql}`);
    });
  }
});

test('error message includes the offending table name and SQL snippet', () => {
  try {
    assertScoped('SELECT * FROM crew_members WHERE id = ?');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof TenantScopeError);
    assert.match(err.message, /crew_members/);
    assert.match(err.message, /tenant_id/);
  }
});
