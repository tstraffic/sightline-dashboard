// Crew ↔ HR roster consistency. The roster (employees) is the source of
// truth for headcounts; crew_members is the operational table booking_crew
// points at. Migration 333 reconciled the historical drift; these tests pin
// the paths that keep it closed:
//   - every crew-creation path also puts the person on the roster
//     (lib/employeeSync ensureRosterRecord)
//   - crew bulk-deactivate mirrors the employee soft-delete
//
// Previously /crew/new and the timesheets add-crew form minted crew rows
// with NO roster record — the exact orphans that made the Today page say
// "235 crew" while the roster said 123. Non-serial: seeds are namespaced
// 'CRCON' and cleaned up per test.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

function cleanup(name) {
  withDb(db => {
    db.prepare('DELETE FROM employees WHERE full_name = ?').run(name);
    db.prepare('DELETE FROM crew_members WHERE full_name = ?').run(name);
  });
}

test('/crew/new puts the person on the HR roster', async ({ page }, testInfo) => {
  const name = `CRCON Newhire ${testInfo.project.name.includes('mobile') ? 'M' : 'D'}`;
  cleanup(name);

  await loginAs(page);
  // The Add Crew form is a multi-step wizard (public/js/step-wizard.js only
  // renders Save on the last step), so post the form the way it does rather
  // than clicking through every step — the invariant under test is the
  // route's, not the wizard's.
  await page.goto('/crew/new');
  const csrf = await page.locator('form[action="/crew"] input[name="_csrf"]').inputValue();
  const res = await page.request.post('/crew', {
    form: { full_name: name, role: 'traffic_controller', active: '1', _csrf: csrf },
  });
  expect(res.status()).toBeLessThan(400);

  // The person must appear on the roster (employees row linked to the new
  // crew row) — this is what the old code never created.
  await page.goto('/hr/roster?search=' + encodeURIComponent(name));
  await expect(page.locator('table')).toContainText(name);
  const link = withDb(db => db.prepare(`
    SELECT e.id FROM employees e
    JOIN crew_members cm ON cm.id = e.linked_crew_member_id
    WHERE e.full_name = ? AND e.deleted_at IS NULL AND cm.active = 1
  `).get(name));
  expect(link).toBeTruthy();

  cleanup(name);
});

test('timesheets add-crew puts the person on the HR roster', async ({ page }, testInfo) => {
  const name = `CRCON Sheetadd ${testInfo.project.name.includes('mobile') ? 'M' : 'D'}`;
  cleanup(name);

  await loginAs(page);
  // The timesheets add form is a plain POST — drive it with the page's CSRF
  // token so cookies/session match the UI flow.
  await page.goto('/crew/new');
  const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
  const res = await page.request.post('/timesheets/crew', {
    form: { full_name: name, role: 'traffic_controller', _csrf: csrf },
  });
  expect(res.status()).toBeLessThan(400);

  const link = withDb(db => db.prepare(`
    SELECT e.id FROM employees e
    JOIN crew_members cm ON cm.id = e.linked_crew_member_id
    WHERE e.full_name = ? AND e.deleted_at IS NULL
  `).get(name));
  expect(link).toBeTruthy();

  cleanup(name);
});

test('crew bulk-deactivate soft-deletes the linked employee', async ({ page }, testInfo) => {
  const name = `CRCON Bulkgone ${testInfo.project.name.includes('mobile') ? 'M' : 'D'}`;
  cleanup(name);
  const { crewId } = withDb(db => {
    const crewId = db.prepare(
      "INSERT INTO crew_members (full_name, role, active) VALUES (?, 'traffic_controller', 1)"
    ).run(name).lastInsertRowid;
    db.prepare(`
      INSERT INTO employees (full_name, first_name, last_name, employment_status, active, linked_crew_member_id)
      VALUES (?, 'CRCON', 'Bulkgone', 'active', 1, ?)
    `).run(name, crewId);
    return { crewId };
  });

  await loginAs(page);
  await page.goto('/crew/new');
  const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
  const res = await page.request.post('/crew/bulk', {
    form: { ids: String(crewId), action: 'deactivate', _csrf: csrf },
  });
  expect(res.status()).toBeLessThan(400);

  const after = withDb(db => ({
    crew: db.prepare('SELECT active FROM crew_members WHERE id = ?').get(crewId),
    emp: db.prepare('SELECT deleted_at, active FROM employees WHERE linked_crew_member_id = ?').get(crewId),
  }));
  expect(after.crew.active).toBe(0);
  expect(after.emp.deleted_at).toBeTruthy(); // the mirror the old bulk path lacked
  expect(after.emp.active).toBe(0);

  cleanup(name);
});
