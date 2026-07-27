// Linking a booking to its job, and inheriting the job's plans.
//
// Two regressions, both reported as "I made a new project on the booking,
// added plans on the job, and the booking showed nothing":
//
//  1. The full booking form's "+ New project" control was a dead CSS toggle.
//     The typed name posted as `site_label`, which only the board's /quick
//     handlers ever resolved — POST /bookings and POST /bookings/:id dropped
//     it and saved job_id NULL. Nothing job-side could ever surface.
//  2. The job page's "Push to Final Plans" uploader writes ONLY
//     `traffic_plans.is_final`, a table no booking surface read — so even a
//     correctly linked booking showed 0 documents.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');
const { countJobLinkedDocs, getJobDocumentsForJob } = require('../../lib/bookingDocs');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const suffix = (t) => (t.project.name.includes('mobile') ? 'M' : 'D');

test('creating a booking with a typed new project links them', async ({ page }, testInfo) => {
  const s = suffix(testInfo);
  const projectName = `Inline Project ${s}`;
  const bookingTitle = `Inline link booking ${s}`;
  const today = sydneyToday();

  await loginAs(page);
  // A client to hang the new job off (lazyCreateProject needs one).
  const clientId = await page.evaluate(async (name) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const r = await fetch('/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify({ company_name: name, company_type: 'client' }),
    });
    return (await r.json()).client.id;
  }, `Inline Link Co ${s}`);

  // Post exactly what the form sends in new-project mode: a typed
  // site_label and NO job_id (the select is disabled).
  const res = await page.evaluate(async (payload) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const body = new URLSearchParams({ ...payload, _csrf: csrf });
    const r = await fetch('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: body.toString(),
      redirect: 'follow',
    });
    return { status: r.status, url: r.url };
  }, {
    title: bookingTitle,
    site_label: projectName,
    client_id: String(clientId),
    depot: 'Villawood',
    status: 'unconfirmed',
    start_date: today, start_time: '07:00',
    end_date: today, end_time: '15:00',
  });
  expect(res.status).toBeLessThan(400);

  // The job exists AND the booking points at it.
  const row = withDb(db => db.prepare(`
    SELECT b.id, b.job_id, j.job_name, j.job_number
    FROM bookings b LEFT JOIN jobs j ON j.id = b.job_id
    WHERE b.title = ?
  `).get(bookingTitle));
  expect(row).toBeTruthy();
  expect(row.job_id).not.toBeNull();
  expect(row.job_name).toBe(projectName);
  expect(row.job_number).toBeTruthy(); // real job, not a stub
});

test('a typed name that matches an existing project reuses it', async ({ page }, testInfo) => {
  const s = suffix(testInfo);
  const projectName = `Inline Project ${s}`; // same name as the test above
  const bookingTitle = `Inline reuse booking ${s}`;
  const today = sydneyToday();

  const jobsBefore = withDb(db => db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE LOWER(job_name) = LOWER(?)').get(projectName).c);
  expect(jobsBefore).toBe(1);

  await loginAs(page);
  const clientId = withDb(db => db.prepare('SELECT id FROM clients ORDER BY id DESC LIMIT 1').get().id);
  await page.evaluate(async (payload) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    await fetch('/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: new URLSearchParams({ ...payload, _csrf: csrf }).toString(),
    });
  }, {
    title: bookingTitle,
    site_label: projectName,
    client_id: String(clientId),
    depot: 'Villawood', status: 'unconfirmed',
    start_date: today, start_time: '07:00', end_date: today, end_time: '15:00',
  });

  // No duplicate job, and the second booking joined the same one.
  const after = withDb(db => ({
    jobs: db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE LOWER(job_name) = LOWER(?)').get(projectName).c,
    linked: db.prepare('SELECT job_id FROM bookings WHERE title = ?').get(bookingTitle),
  }));
  expect(after.jobs).toBe(1);
  expect(after.linked.job_id).not.toBeNull();
});

test('final traffic plans count as the job pack on the booking', () => {
  // Unit-level: lib/bookingDocs is what every booking surface reads.
  const jobId = withDb(db => {
    const j = db.prepare("SELECT id FROM jobs WHERE job_name LIKE 'Inline Project %' ORDER BY id LIMIT 1").get();
    if (!j) return null;
    if (!db.prepare('SELECT id FROM traffic_plans WHERE job_id = ? AND is_final = 1').get(j.id)) {
      db.prepare(`
        INSERT INTO traffic_plans (job_id, plan_number, plan_type, status, is_final, marked_final_at)
        VALUES (?, 'TP-FINAL-E2E', 'TGS', 'approved', 1, CURRENT_TIMESTAMP)
      `).run(j.id);
    }
    return j.id;
  });
  expect(jobId).toBeTruthy();

  const docs = withDb(db => getJobDocumentsForJob(db, jobId));
  const count = withDb(db => countJobLinkedDocs(db, jobId));

  const finals = docs.filter(d => d.source === 'final_plan');
  expect(finals.length).toBeGreaterThanOrEqual(1);
  expect(finals[0].title).toBe('TP-FINAL-E2E');
  expect(count).toBeGreaterThanOrEqual(1);
});
