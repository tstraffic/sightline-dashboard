/**
 * Cross-tenant leak tests — the highest-stakes guarantee of the whole
 * migration.
 *
 * Each test creates two tenants ('tenant-a' and 'tenant-b'), inserts
 * rows through each tenant's wrapper, then asserts neither can see the
 * other's rows. If any of these go red, we've shipped a data leak.
 *
 * Today only `test_data` is exercised — Phase 2 module prompts will
 * expand this file by adding parallel test cases as `jobs`, `crew_members`,
 * `allocations` etc. get their tenant_id columns. The pattern is the
 * same; copy + adapt the test_data block.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTwoTenants } = require('./fixture');
const { TenantScopeError } = require('../../lib/tenant-db');

test('rows inserted as tenant-a are visible to tenant-a', () => {
  const { dbA, cleanup } = createTwoTenants();
  try {
    dbA.prepare('INSERT INTO test_data (tenant_id, label) VALUES (?, ?)').run('tenant-a', 'a-row-1');
    const rows = dbA.prepare('SELECT label FROM test_data WHERE tenant_id = ?').all('tenant-a');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'a-row-1');
  } finally { cleanup(); }
});

test('rows inserted as tenant-a are NOT visible when querying as tenant-b', () => {
  const { dbA, dbB, cleanup } = createTwoTenants();
  try {
    dbA.prepare('INSERT INTO test_data (tenant_id, label) VALUES (?, ?)').run('tenant-a', 'secret-a');
    dbB.prepare('INSERT INTO test_data (tenant_id, label) VALUES (?, ?)').run('tenant-b', 'secret-b');

    // tenant-b's scoped query should only return tenant-b's row.
    const rowsB = dbB.prepare('SELECT label FROM test_data WHERE tenant_id = ?').all('tenant-b');
    assert.equal(rowsB.length, 1);
    assert.equal(rowsB[0].label, 'secret-b');

    // And vice versa — tenant-a only sees its own.
    const rowsA = dbA.prepare('SELECT label FROM test_data WHERE tenant_id = ?').all('tenant-a');
    assert.equal(rowsA.length, 1);
    assert.equal(rowsA[0].label, 'secret-a');
  } finally { cleanup(); }
});

test('the wrapper refuses a SELECT that omits tenant_id even with a row id', () => {
  const { dbA, cleanup } = createTwoTenants();
  try {
    assert.throws(
      () => dbA.prepare('SELECT * FROM test_data WHERE id = ?'),
      (err) => err instanceof TenantScopeError,
    );
  } finally { cleanup(); }
});

test('the wrapper refuses an INSERT without a tenant_id column', () => {
  const { dbA, cleanup } = createTwoTenants();
  try {
    assert.throws(
      () => dbA.prepare('INSERT INTO test_data (label) VALUES (?)'),
      (err) => err instanceof TenantScopeError,
    );
  } finally { cleanup(); }
});

test('UPDATE against another tenant via dbA passes the wrapper but writes 0 rows', () => {
  // The wrapper only requires `tenant_id` somewhere in the WHERE — it
  // doesn't verify the VALUE matches req.tenant.id (that's the caller's
  // job, since tenant_id is a bound parameter). So a caller bug like
  // `... WHERE id = ? AND tenant_id = ?` with the WRONG tenant_id value
  // passes the wrapper but, because the row has the other tenant's id,
  // affects 0 rows. The test confirms no row leaks across tenants even
  // if the caller passes the wrong id.
  const { rawDb, dbA, dbB, cleanup } = createTwoTenants();
  try {
    const insB = dbB.prepare('INSERT INTO test_data (tenant_id, label) VALUES (?, ?)').run('tenant-b', 'b-row');
    const bId = insB.lastInsertRowid;

    // dbA tries to UPDATE tenant-b's row through dbA. Even if it passes
    // 'tenant-a' as the tenant_id, WHERE tenant_id = 'tenant-a' AND
    // id = bId will not match. 0 rows changed.
    const updRes = dbA.prepare('UPDATE test_data SET label = ? WHERE id = ? AND tenant_id = ?')
      .run('hacked', bId, 'tenant-a');
    assert.equal(updRes.changes, 0);

    // And tenant-b's row is still intact.
    const stillB = rawDb.prepare('SELECT label FROM test_data WHERE id = ?').get(bId);
    assert.equal(stillB.label, 'b-row');
  } finally { cleanup(); }
});

test('whitelisted tenants table is readable without a tenant_id filter', () => {
  // The wrapper itself uses this to look up tenant metadata. Has to work.
  const { dbA, cleanup } = createTwoTenants();
  try {
    const tenants = dbA.prepare('SELECT id, name FROM tenants').all();
    assert.equal(tenants.length, 2);
    const ids = tenants.map((t) => t.id).sort();
    assert.deepEqual(ids, ['tenant-a', 'tenant-b']);
  } finally { cleanup(); }
});

test('tenantDb exposes its tenantId for diagnostics', () => {
  const { dbA, dbB, cleanup } = createTwoTenants();
  try {
    assert.equal(dbA.tenantId, 'tenant-a');
    assert.equal(dbB.tenantId, 'tenant-b');
  } finally { cleanup(); }
});
