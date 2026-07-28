// Shift Forms tab — crew-aware and vehicle-aware checklist completion.
//
// Previously every checklist was per-worker: safety_forms WHERE
// crew_member_id = me AND allocation_id = mine. A teammate's filed Team
// Leader checklist showed "not done" for everyone else, everyone was asked
// to duplicate one-per-shift checklists, and the vehicle checklists had no
// notion of WHICH ute they covered. New semantics:
//   - team_leader + risk_toolbox: one submitted copy per shift completes it
//     for the whole crew ("Filed by <name> · View"), own copies optional;
//   - tc_prestart: per person, with a crew tally;
//   - vehicle_prestart + post_shift_vehicle: per booking vehicle, owed by
//     its driver (booking_vehicles.crew_member_id), matched by
//     safety_forms.vehicle_id (mig 330) with a legacy data.vehicle
//     name-match fallback;
//   - the docket gate accepts any crew member's submitted copies of the two
//     required checklists (drafts never count — they used to).
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');

test.describe.configure({ mode: 'serial' });

const WORKER_ID = 'EMP-TEST';
const WORKER_PIN = '1234';

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

async function loginWorker(page, employeeId = WORKER_ID) {
  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', employeeId);
  await page.fill('input[name="pin"]', WORKER_PIN);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/w\//);
}

// Booking today: EMP-TEST + one teammate on the crew, two utes, EMP-TEST
// driving ute 2. Allocations created for both so submissions can hang off
// them (the visitor's would lazy-bind anyway; the teammate's must exist).
function seedShift() {
  return withDb(db => {
    const today = sydneyToday();
    const me = db.prepare('SELECT id, pin_hash FROM crew_members WHERE employee_id = ?').get(WORKER_ID);
    if (!me) return null;

    const mkWorker = (name, empId) => {
      let cm = db.prepare('SELECT id FROM crew_members WHERE full_name = ?').get(name);
      if (!cm) {
        db.prepare('INSERT INTO crew_members (full_name, employee_id, pin_hash, active) VALUES (?, ?, ?, 1)')
          .run(name, empId, me.pin_hash);
        cm = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      } else {
        db.prepare('UPDATE crew_members SET employee_id = ?, pin_hash = ?, active = 1 WHERE id = ?')
          .run(empId, me.pin_hash, cm.id);
      }
      return cm.id;
    };
    const mateId = mkWorker('Jp Teammate One', 'EMP-JPMATE');
    const outsiderId = mkWorker('Jp Outsider One', 'EMP-JPOUT');

    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-JPFORMS'").get();
    if (!bk) {
      db.prepare(`
        INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
        VALUES ('BK-JPFORMS', 'Job pack forms booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    } else {
      db.prepare("UPDATE bookings SET start_datetime = ? || 'T07:00', end_datetime = ? || 'T15:00' WHERE id = ?")
        .run(today, today, bk.id);
    }
    const bookingId = bk.id;

    db.prepare('DELETE FROM booking_vehicles WHERE booking_id = ?').run(bookingId);
    db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role, crew_member_id) VALUES (?, 'JP-UTE-1', 'ute', ?)").run(bookingId, mateId);
    const v1 = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role, crew_member_id) VALUES (?, 'JP-UTE-2', 'ute', ?)").run(bookingId, me.id);
    const v2 = db.prepare('SELECT last_insert_rowid() AS id').get().id;

    db.prepare('DELETE FROM booking_crew WHERE booking_id = ?').run(bookingId);
    db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, status, assigned_vehicle_id) VALUES (?, ?, 'confirmed', ?)").run(bookingId, me.id, v2);
    db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, status, assigned_vehicle_id) VALUES (?, ?, 'confirmed', ?)").run(bookingId, mateId, v1);

    const mkAlloc = (cmId) => {
      let a = db.prepare('SELECT id FROM crew_allocations WHERE booking_id = ? AND crew_member_id = ?').get(bookingId, cmId);
      if (!a) {
        db.prepare(`
          INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id)
          VALUES (NULL, ?, ?, '07:00', '15:00', 'traffic_controller', 'allocated', ?)
        `).run(cmId, today, bookingId);
        a = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      return a.id;
    };
    const myAlloc = mkAlloc(me.id);
    const mateAlloc = mkAlloc(mateId);

    // Clean slate for submissions each run.
    db.prepare('DELETE FROM safety_forms WHERE allocation_id IN (?, ?) OR booking_id = ?').run(myAlloc, mateAlloc, bookingId);

    return { bookingId, v1, v2, meId: me.id, mateId, outsiderId, myAlloc, mateAlloc, today };
  });
}

// A submitted safety_form for the teammate. booking_id deliberately NULL by
// default — resolution must work through the allocation like legacy rows.
function fileAs(seed, formType, opts = {}) {
  return withDb(db => {
    db.prepare(`
      INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, booking_id, vehicle_id, data, status, submitted_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      opts.by || seed.mateId, formType,
      opts.allocationId !== undefined ? opts.allocationId : seed.mateAlloc,
      opts.bookingId !== undefined ? opts.bookingId : null,
      opts.vehicleId !== undefined ? opts.vehicleId : null,
      JSON.stringify(opts.data || {}),
      opts.status || 'submitted'
    );
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
  });
}

const formsTab = (seed) => `/w/booking-shift/${seed.bookingId}?tab=forms`;

test("a teammate's team leader checklist completes the shift for everyone", async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  const subId = fileAs(seed, 'team_leader', { data: { team_leader_name: 'Jp Teammate One' } });

  await loginWorker(page);
  await page.goto(formsTab(seed));

  const row = page.locator('[data-jp="team_leader"]');
  await expect(row).toHaveAttribute('data-jp-state', 'done');
  await expect(row).toContainText('Filed by Jp Teammate One');

  // The View link is that teammate's PDF, and it must actually serve.
  const pdf = await page.evaluate(async (id) => {
    const r = await fetch(`/w/forms/history/${id}/pdf`, { credentials: 'same-origin' });
    return { status: r.status, type: r.headers.get('content-type') };
  }, subId);
  expect(pdf.status).toBe(200);
  expect(pdf.type).toContain('application/pdf');

  // Filing my own copy stays possible.
  const own = row.locator('[data-jp-own="team_leader"]');
  await expect(own).toBeVisible();
  expect(await own.getAttribute('href')).toContain('/w/forms/team-leader?allocationId=');
});

test("the TC declaration stays per-person with a crew tally", async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  fileAs(seed, 'tc_prestart', {});

  await loginWorker(page);
  await page.goto(formsTab(seed));

  const row = page.locator('[data-jp="tc_prestart"]');
  await expect(row).toHaveAttribute('data-jp-state', 'pending'); // mate's copy ≠ mine
  await expect(row).toContainText("You haven't signed yet");
  await expect(row.locator('[data-jp-tally]')).toContainText('1/2 crew signed');
});

test('vehicle checklists track each ute, and the driver owes their own', async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  // Teammate pre-started THEIR ute (v1), attributed by vehicle_id.
  fileAs(seed, 'vehicle_prestart', { vehicleId: seed.v1, data: { vehicle: 'JP-UTE-1' } });

  await loginWorker(page);
  await page.goto(formsTab(seed));

  const v1pre = page.locator(`[data-jp-veh-form="vehicle_prestart:${seed.v1}"]`);
  await expect(v1pre).toHaveAttribute('data-jp-state', 'done');
  await expect(v1pre).toContainText('Filed by Jp Teammate One');

  // My ute (v2) is still pending, marked as owed by me, and its action link
  // carries the vehicle id so the form pre-fills THIS ute.
  const v2pre = page.locator(`[data-jp-veh-form="vehicle_prestart:${seed.v2}"]`);
  await expect(v2pre).toHaveAttribute('data-jp-state', 'pending');
  await expect(v2pre.locator('[data-jp-owes]')).toContainText('You drive this ute');
  expect(await v2pre.getAttribute('href')).toContain(`vehicleId=${seed.v2}`);
});

test('a legacy submission with only a typed vehicle name still matches its ute', async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  // vehicle_id NULL — the pre-migration shape. Name matching is normalised
  // (case/punctuation-insensitive).
  fileAs(seed, 'post_shift_vehicle', { vehicleId: null, data: { vehicle: 'jp ute 2' } });

  await loginWorker(page);
  await page.goto(formsTab(seed));

  const v2post = page.locator(`[data-jp-veh-form="post_shift_vehicle:${seed.v2}"]`);
  await expect(v2post).toHaveAttribute('data-jp-state', 'done');
  const v1post = page.locator(`[data-jp-veh-form="post_shift_vehicle:${seed.v1}"]`);
  await expect(v1post).toHaveAttribute('data-jp-state', 'pending');
});

test("the docket gate accepts the crew's copies — but never a draft", async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  // Only a DRAFT team_leader exists → gate must still list it as missing.
  fileAs(seed, 'risk_toolbox', {});
  fileAs(seed, 'team_leader', { status: 'draft' });

  await loginWorker(page);
  await page.goto(`/w/dockets/shift/${seed.bookingId}`);
  // The sign page's prereq banner lists the Team Leader checklist as missing
  // (only a DRAFT exists) and blocks the form.
  const prereq = page.locator('.ds-prereq');
  await expect(prereq).toBeVisible();
  await expect(prereq).toContainText('Team Leader Checklist');

  // Submit the draft's real counterpart → gate clears without ME filing anything.
  fileAs(seed, 'team_leader', { data: { team_leader_name: 'Jp Teammate One' } });
  await page.goto(`/w/dockets/shift/${seed.bookingId}`);
  await expect(page.locator('.ds-prereq')).toHaveCount(0);
  await expect(page.locator('#docket-form')).toHaveAttribute('data-blocked', '');
});

test('a worker outside the booking cannot open the crew PDF', async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  const subId = fileAs(seed, 'team_leader', {});

  await loginWorker(page, 'EMP-JPOUT');
  const pdf = await page.evaluate(async (id) => {
    const r = await fetch(`/w/forms/history/${id}/pdf`, { credentials: 'same-origin' });
    return r.status;
  }, subId);
  expect(pdf).toBe(404);
});

test('a pure job shift keeps the legacy per-person list', async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded');
  // A job-only allocation (no booking) for EMP-TEST.
  const jobAlloc = withDb(db => {
    const today = sydneyToday();
    let job = db.prepare("SELECT id FROM jobs WHERE job_name = 'Jp Legacy Job'").get();
    if (!job) {
      db.prepare(`
        INSERT INTO jobs (job_number, job_name, client, site_address, suburb, start_date, status)
        VALUES ('J-JPLEGACY', 'Jp Legacy Job', 'Test Client', '1 Test St', 'Testville', ?, 'active')
      `).run(today);
      job = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    let a = db.prepare('SELECT id FROM crew_allocations WHERE job_id = ? AND crew_member_id = ? AND booking_id IS NULL').get(job.id, seed.meId);
    if (!a) {
      db.prepare(`
        INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status)
        VALUES (?, ?, ?, '07:00', '15:00', 'traffic_controller', 'allocated')
      `).run(job.id, seed.meId, today);
      a = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    return a.id;
  });

  await loginWorker(page);
  await page.goto(`/w/jobs/${jobAlloc}?tab=forms`);
  await expect(page.locator('body')).toContainText('Required checklists');
  await expect(page.locator('[data-jp="team_leader"]')).toHaveCount(0);
});
