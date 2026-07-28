// Final traffic plans on a booking must be openable AND reach the crew.
//
// Commit 6f5e5bb started counting `traffic_plans WHERE is_final = 1` toward a
// booking's document total, but gave them no download route, no worker
// reader and no place in /w/. The result on a real booking: "it says 4
// documents ... but [I] cant edit them to make them visible or actually use
// them in the shift" — the two job-side entries were inert, and their
// download link pointed at a job_documents id that 404s.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');
const { getJobDocumentsForJob, countJobLinkedDocs } = require('../../lib/bookingDocs');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

// A job with a final plan, and a booking on it.
function seed() {
  return withDb(db => {
    const today = sydneyToday();
    let job = db.prepare("SELECT id FROM jobs WHERE job_name = 'Final Plan Job'").get();
    if (!job) {
      db.prepare(`
        INSERT INTO jobs (job_number, job_name, client, site_address, suburb, start_date, status)
        VALUES ('J-FINALPLAN', 'Final Plan Job', 'Test Client', '1 Test St', 'Testville', ?, 'active')
      `).run(today);
      job = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-FINALPLAN'").get();
    if (!bk) {
      db.prepare(`
        INSERT INTO bookings (booking_number, title, job_id, start_datetime, end_datetime, status, depot)
        VALUES ('BK-FINALPLAN', 'Final plan booking', ?, ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(job.id, today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    if (!db.prepare("SELECT id FROM traffic_plans WHERE plan_number = 'TSTGS-FINAL-E2E'").get()) {
      db.prepare(`
        INSERT INTO traffic_plans (job_id, plan_number, plan_type, status, file_path, file_original_name, is_final, marked_final_at)
        VALUES (?, 'TSTGS-FINAL-E2E', 'TGS', 'approved', 'uploads/plans/e2e-final.pdf', 'e2e-final.pdf', 1, CURRENT_TIMESTAMP)
      `).run(job.id);
    }
    return { jobId: job.id, bookingId: bk.id };
  });
}

test('a final plan is listed with a working link, not a job_documents URL', () => {
  const { jobId } = seed();
  const docs = withDb(db => getJobDocumentsForJob(db, jobId));
  const fp = docs.find(d => d.source === 'final_plan');
  expect(fp).toBeTruthy();

  // The old code let the view build /jobs/:jobId/documents/:id/download from
  // a traffic_plans id — a 404, or worse another job's document.
  expect(fp.href).not.toMatch(/\/documents\//);
  expect(fp.href).toBe('/uploads/plans/e2e-final.pdf');

  // doc_type must be lowercase or the board's Req. Plans chip never matches
  // (traffic_plans.plan_type is stored uppercase).
  expect(fp.doc_type).toBe('tgs');
  expect(withDb(db => countJobLinkedDocs(db, jobId))).toBeGreaterThanOrEqual(1);
});

test('the booking page renders the final plan with its real link', async ({ page }) => {
  const { bookingId } = seed();
  await loginAs(page);
  await page.goto(`/bookings/${bookingId}`);
  await expect(page.locator('body')).toContainText('TSTGS-FINAL-E2E');
  // No job_documents-shaped link anywhere for it.
  const badLink = page.locator('a[href*="/documents/"][href*="/download"]', { hasText: 'TSTGS-FINAL-E2E' });
  await expect(badLink).toHaveCount(0);
});

test('the crew can open the final plan from their shift', async ({ page }) => {
  const { bookingId } = seed();
  // Put the test worker on the booking via booking_crew (the live table).
  const ok = withDb(db => {
    const w = db.prepare("SELECT id FROM crew_members WHERE employee_id = 'EMP-TEST'").get();
    if (!w) return null;
    if (!db.prepare('SELECT id FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(bookingId, w.id)) {
      db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, status) VALUES (?, ?, 'confirmed')").run(bookingId, w.id);
    }
    return w.id;
  });
  test.skip(!ok, 'EMP-TEST worker not seeded');

  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', 'EMP-TEST');
  await page.fill('input[name="pin"]', '1234');
  await page.click('form button[type="submit"]');

  await page.goto(`/w/booking-shift/${bookingId}?tab=docs`);
  // The plan is now part of the shift's site pack.
  await expect(page.locator('body')).toContainText('TSTGS-FINAL-E2E');

  // And the streamer authorises a booking_crew-only worker (it used to
  // demand a crew_allocations row, which the live flow no longer writes).
  const planId = withDb(db => db.prepare("SELECT id FROM traffic_plans WHERE plan_number = 'TSTGS-FINAL-E2E'").get().id);
  const status = await page.evaluate(async (id) => (await fetch(`/w/final-plans/${id}`, { credentials: 'same-origin' })).status, planId);
  // 404 = authorised but the fixture file isn't on disk. 403 would mean the
  // permission check rejected a worker who is genuinely on the shift.
  expect(status).not.toBe(403);
});
