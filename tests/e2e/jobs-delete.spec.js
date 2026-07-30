// Deleting jobs, and the single jobs register.
//
// Previously: no UI could delete a job, and both delete routes were unsafe —
// `DELETE FROM jobs` with foreign_keys = ON throws "FOREIGN KEY constraint
// failed" as soon as a job has a booking (bookings.job_id declares no ON
// DELETE action), and routes/projects.js' hand-written cascade list missed
// bookings, safety_forms, toolbox_talks, child jobs and more. Also, /jobs
// rendered a SECOND jobs register that only the edit-form breadcrumb reached,
// so editing a job and pressing "Jobs" landed somewhere that looked nothing
// like the register you came from.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const tag = (p) => (p.includes('mobile') ? 'M' : 'D');

function cleanup(num) {
  withDb(db => {
    const j = db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(num);
    if (!j) return;
    try { db.prepare('DELETE FROM bookings WHERE job_id = ?').run(j.id); } catch (e) {}
    try { db.prepare('DELETE FROM tasks WHERE job_id = ?').run(j.id); } catch (e) {}
    db.prepare('DELETE FROM jobs WHERE id = ?').run(j.id);
  });
}

// Explicit high ids: SQLite reuses freed rowids, and other specs leave rows
// pointing at low job_ids — a recycled id would inherit their bookings and
// look "not clean" to the delete guard.
function seedJob(num, id) {
  cleanup(num);
  return withDb(db => db.prepare(`
    INSERT INTO jobs (id, job_number, job_name, client, site_address, suburb, start_date, status)
    VALUES (?, ?, ?, 'JDEL Client', '1 Test St', 'Testville', '2026-08-01', 'active')
  `).run(id, num, 'JDEL ' + num).lastInsertRowid);
}

async function csrfFrom(page, url) {
  await page.goto(url);
  return page.locator('input[name="_csrf"]').first().inputValue();
}

test('a clean job can be deleted from its page', async ({ page }, testInfo) => {
  const num = 'JDEL-CLEAN-' + tag(testInfo.project.name);
  const id = seedJob(num, 99101 + (tag(testInfo.project.name) === 'M' ? 50 : 0));

  await loginAs(page);
  await page.goto('/projects/' + id);
  // The Delete button is on the job page for admins.
  const del = page.locator('form[action="/projects/' + id + '/delete"] button');
  await expect(del).toBeVisible();

  page.once('dialog', d => d.accept()); // confirm()
  await del.click();
  await expect(page).toHaveURL(/\/projects(\?|$)/);

  expect(withDb(db => db.prepare('SELECT id FROM jobs WHERE id = ?').get(id))).toBeFalsy();
});

test('a job with a booking is refused, not cascaded through', async ({ page }, testInfo) => {
  const num = 'JDEL-BUSY-' + tag(testInfo.project.name);
  const id = seedJob(num, 99102 + (tag(testInfo.project.name) === 'M' ? 50 : 0));
  withDb(db => db.prepare(`
    INSERT INTO bookings (booking_number, job_id, title, start_datetime, end_datetime, status)
    VALUES (?, ?, 'JDEL booking', '2026-08-01 07:00', '2026-08-01 15:00', 'confirmed')
  `).run('BK-' + num, id));

  await loginAs(page);
  const csrf = await csrfFrom(page, '/projects/' + id);
  // maxRedirects: 0 — flashes are one-shot, and following the redirect here
  // would consume the message before the assertion below can see it.
  const res = await page.request.post('/projects/' + id + '/delete', {
    form: { _csrf: csrf }, maxRedirects: 0,
  });
  expect(res.status()).toBeLessThan(500); // never a FK-constraint 500

  // Job survives, and so does its booking.
  const after = withDb(db => ({
    job: db.prepare('SELECT id FROM jobs WHERE id = ?').get(id),
    bk: db.prepare('SELECT id FROM bookings WHERE job_id = ?').get(id),
  }));
  expect(after.job).toBeTruthy();
  expect(after.bk).toBeTruthy();

  // …and the page says why.
  await page.goto('/projects/' + id);
  await expect(page.locator('body')).toContainText('shift booking');

  cleanup(num);
});

test('deleting a job detaches its tasks instead of destroying them', async ({ page }, testInfo) => {
  const num = 'JDEL-TASK-' + tag(testInfo.project.name);
  const id = seedJob(num, 99103 + (tag(testInfo.project.name) === 'M' ? 50 : 0));
  const taskId = withDb(db => db.prepare(
    "INSERT INTO tasks (title, job_id, status) VALUES ('JDEL keep me', ?, 'open')"
  ).run(id).lastInsertRowid);

  await loginAs(page);
  const csrf = await csrfFrom(page, '/projects/' + id);
  const res = await page.request.post('/projects/' + id + '/delete', { form: { _csrf: csrf } });
  expect(res.status()).toBeLessThan(400);

  const after = withDb(db => ({
    job: db.prepare('SELECT id FROM jobs WHERE id = ?').get(id),
    task: db.prepare('SELECT id, job_id FROM tasks WHERE id = ?').get(taskId),
  }));
  expect(after.job).toBeFalsy();
  expect(after.task).toBeTruthy();
  expect(after.task.job_id).toBeNull();

  withDb(db => db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId));
});

test('there is one jobs register: /jobs redirects to /projects', async ({ page }) => {
  await loginAs(page);
  await page.goto('/jobs');
  await expect(page).toHaveURL(/\/projects$/);
  // Filters carry over.
  await page.goto('/jobs?status=active');
  await expect(page).toHaveURL(/\/projects\?status=active$/);
});

test('the job edit breadcrumb returns to the canonical register', async ({ page }, testInfo) => {
  const num = 'JDEL-CRUMB-' + tag(testInfo.project.name);
  const id = seedJob(num, 99104 + (tag(testInfo.project.name) === 'M' ? 50 : 0));

  await loginAs(page);
  await page.goto('/projects/' + id);
  await page.locator('a[href="/jobs/' + id + '/edit"]').first().click();
  await expect(page).toHaveURL(new RegExp('/jobs/' + id + '/edit'));

  // "Jobs" in the breadcrumb must land on /projects, not the old register.
  // Scope to the breadcrumb: the sidebar's "Jobs" link now points at
  // /projects too, and on mobile that rail is off-canvas (unclickable).
  await page.locator('[data-breadcrumb] a').first().click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator('h1')).toContainText('Jobs');

  cleanup(num);
});
