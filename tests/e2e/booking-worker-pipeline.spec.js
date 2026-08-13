// The booking → worker-portal information pipeline, guarded end-to-end.
// Born from the Aug 2026 pre-launch audit, which found four launch-blockers
// this file pins down forever:
//
//   1. UNCONFIRMED LEAK — adding crew creates a crew_allocations row
//      immediately, and the worker home's allocation-path queries didn't
//      gate on booking status, so a booking the office hadn't committed
//      showed on the worker's home screen (while /w/jobs correctly hid it).
//   2. WRONG DAY — the shift detail page parsed the naive Sydney
//      start_datetime with `new Date()`; on a UTC host every shift starting
//      ≥14:00 AEST rendered the NEXT day's weekday ("Friday" for a
//      Thursday 22:00 night shift).
//   3. DOCKET IDOR — /w/dockets/shift/:bookingId had no membership check:
//      any logged-in worker could open (and sign!) another crew's docket.
//   4. SILENT BOARD EDITS — the board slide-over's quick-update discarded
//      location_notes / location_context / booking_type /
//      depot_meeting_time / straight_to_site_time while appearing to save.
//
// Worker fixture: EMP-TEST / PIN 1234 (migration 114, SEED_TEST_USERS).

const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

const TODAY = '2026-09-01'; // fixed future date — deterministic, never "today"

function db() { return new Database(TEST_DB); }

function seedBooking({ number, status, start, end, crewId }) {
  const d = db();
  try {
    d.prepare('DELETE FROM crew_allocations WHERE booking_id IN (SELECT id FROM bookings WHERE booking_number = ?)').run(number);
    d.prepare('DELETE FROM booking_crew WHERE booking_id IN (SELECT id FROM bookings WHERE booking_number = ?)').run(number);
    d.prepare('DELETE FROM bookings WHERE booking_number = ?').run(number);
    const r = d.prepare(`
      INSERT INTO bookings (booking_number, title, status, start_datetime, end_datetime, site_address, suburb, created_by_id)
      VALUES (?, ?, ?, ?, ?, '12 Pipeline St', 'Testville', 1)
    `).run(number, 'Pipeline ' + number, status, start, end);
    const bookingId = r.lastInsertRowid;
    if (crewId) {
      d.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, 'traffic_controller', 'assigned')").run(bookingId, crewId);
      d.prepare(`
        INSERT INTO crew_allocations (crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id)
        VALUES (?, ?, ?, ?, 'traffic_controller', 'allocated', ?)
      `).run(crewId, start.slice(0, 10), start.slice(11, 16), end.slice(11, 16), bookingId);
    }
    return bookingId;
  } finally { d.close(); }
}

function testWorkerId() {
  const d = db();
  try { return d.prepare("SELECT id FROM crew_members WHERE employee_id = 'EMP-TEST'").get().id; }
  finally { d.close(); }
}

async function workerLogin(page, employeeId = 'EMP-TEST', pin = '1234') {
  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', employeeId);
  await page.fill('input[name="pin"]', pin);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/w\/home/);
}

test('an unconfirmed booking with crew attached appears nowhere in the portal', async ({ page }) => {
  const crewId = testWorkerId();
  seedBooking({ number: 'BK-LEAK', status: 'unconfirmed', start: `${TODAY}T06:00:00`, end: `${TODAY}T14:00:00`, crewId });
  await workerLogin(page);

  for (const url of ['/w/home', '/w/jobs', '/w/dockets']) {
    await page.goto(url);
    await expect(page.locator('body')).not.toContainText('BK-LEAK');
    await expect(page.locator('body')).not.toContainText('Pipeline BK-LEAK');
  }

  // The moment the office commits it, it surfaces.
  const d = db();
  d.prepare("UPDATE bookings SET status = 'confirmed' WHERE booking_number = 'BK-LEAK'").run();
  d.close();
  await page.goto('/w/jobs');
  await expect(page.locator('body')).toContainText('BK-LEAK');
});

test('a night shift renders its own start date, not the next day', async ({ page }) => {
  const crewId = testWorkerId();
  const bookingId = seedBooking({ number: 'BK-NIGHT', status: 'confirmed', start: `${TODAY}T22:00:00`, end: `2026-09-02T06:00:00`, crewId });
  await workerLogin(page);
  await page.goto('/w/booking-shift/' + bookingId);
  // 2026-09-01 is a Tuesday — everywhere on Earth. The old code showed
  // Wednesday on any UTC host for a 22:00 Sydney start.
  await expect(page.locator('body')).toContainText('Tuesday, 1 September 2026');
  await expect(page.locator('body')).not.toContainText('Wednesday, 2 September');
});

test('a worker not on the booking cannot open its shift docket', async ({ page }) => {
  // EMP-TEST is deliberately NOT crew on this booking.
  const bookingId = seedBooking({ number: 'BK-IDOR', status: 'confirmed', start: `${TODAY}T06:00:00`, end: `${TODAY}T14:00:00`, crewId: null });
  await workerLogin(page);
  await page.goto('/w/dockets/shift/' + bookingId);
  await expect(page).toHaveURL(/\/w\/dockets$/);
  await expect(page.locator('body')).not.toContainText('BK-IDOR');
});

test('the board slide-over persists the fields it used to silently drop', async ({ page }) => {
  const bookingId = seedBooking({ number: 'BK-QSAVE', status: 'confirmed', start: `${TODAY}T06:00:00`, end: `${TODAY}T14:00:00`, crewId: null });
  await loginAs(page);
  await page.goto('/bookings?date=' + TODAY);
  const csrf = await page.locator('input[name="_csrf"]').first().inputValue();
  const res = await page.request.post('/bookings/' + bookingId + '/quick-update', {
    headers: { Accept: 'application/json' },
    form: {
      _csrf: csrf,
      client_name: 'Pipeline Client',
      title: 'Pipeline BK-QSAVE',
      site_address: '12 Pipeline St', suburb: 'Testville', state: 'NSW',
      start_date: TODAY, start_time: '06:00', end_time: '14:00',
      depot: 'Sydney',
      location_notes: 'gate code 9182',
      location_context: 'Bridge deck',
      booking_type: 'hire',
      depot_meeting_time: '05:30',
      straight_to_site_time: '',
    },
  });
  expect(res.ok()).toBeTruthy();
  const d = db();
  const row = d.prepare('SELECT location_notes, location_context, booking_type, depot_meeting_time FROM bookings WHERE id = ?').get(bookingId);
  d.close();
  expect(row.location_notes).toBe('gate code 9182');
  expect(row.location_context).toBe('Bridge deck');
  expect(row.booking_type).toBe('hire');
  expect(row.depot_meeting_time).toBe('05:30');
});
