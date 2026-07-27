// Worker portal — the equipment-return ("Gear returned") sheet.
//
// Regression guard: the sheet's markup, CSS and script were emitted for
// EVERY booking whose Tasks tab was opened, gear or no gear, and were held
// off-screen by a single CSS transform with no visibility/display fallback.
// Any hiccup (paint order, bfcache restore, a stylesheet that hadn't landed)
// surfaced a "Gear returned — quick report" dialog on a shift with nothing
// to return, mid-shift. An earlier fix added a JS forceShut() on pageshow,
// which cannot help on a first load because the sheet is never given .open
// server-side — the real defect was that it shipped at all.
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

async function workerLogin(page) {
  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', WORKER_ID);
  await page.fill('input[name="pin"]', WORKER_PIN);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/w\//);
}

// A booking today with the test worker on it. Returns { bookingId, crewId }.
function seedShift() {
  return withDb(db => {
    const today = sydneyToday();
    const worker = db.prepare("SELECT id FROM crew_members WHERE employee_id = ?").get(WORKER_ID);
    if (!worker) return null;
    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-GEAR-TEST'").get();
    if (!bk) {
      db.prepare(`
        INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
        VALUES ('BK-GEAR-TEST', 'Gear sheet booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    } else {
      db.prepare("UPDATE bookings SET start_datetime = ? || 'T07:00', end_datetime = ? || 'T15:00' WHERE id = ?")
        .run(today, today, bk.id);
    }
    if (!db.prepare('SELECT id FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(bk.id, worker.id)) {
      db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, status) VALUES (?, ?, 'confirmed')").run(bk.id, worker.id);
    }
    // No gear tasks for this shift.
    db.prepare("DELETE FROM shift_tasks WHERE booking_id = ? AND kind = 'equipment_return'").run(bk.id);
    return { bookingId: bk.id, workerId: worker.id };
  });
}

test('Tasks tab ships no gear sheet when the shift has no gear', async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded in this DB');
  await workerLogin(page);

  await page.goto(`/w/booking-shift/${seed.bookingId}?tab=tasks`);
  await expect(page.locator('body')).not.toContainText('Server error');

  // The dialog must not exist at all — not merely be translated off-screen.
  await expect(page.locator('#rt-sheet')).toHaveCount(0);
  await expect(page.locator('#rt-bg')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Gear returned');
});

test('with gear to return the sheet exists but stays hidden until opened', async ({ page }) => {
  const seed = seedShift();
  test.skip(!seed, 'EMP-TEST worker not seeded in this DB');

  // Give the shift one pending return task.
  withDb(db => {
    db.prepare(`
      INSERT INTO shift_tasks (booking_id, crew_member_id, title, kind, status, group_key)
      VALUES (?, ?, 'Return Arrow Board to yard', 'equipment_return', 'pending', 'beq:e2e-gear')
    `).run(seed.bookingId, seed.workerId);
  });

  await workerLogin(page);
  await page.goto(`/w/booking-shift/${seed.bookingId}?tab=tasks`);

  // Now it renders — and the trigger is there.
  await expect(page.locator('#rt-sheet')).toHaveCount(1);
  await expect(page.locator('[data-rt-open]').first()).toBeVisible();

  // ...but it is NOT showing: hidden by visibility, not just a transform,
  // so losing the transform can't surface it.
  const sheet = page.locator('#rt-sheet');
  await expect(sheet).not.toBeVisible();
  const hidden = await sheet.evaluate(el => getComputedStyle(el).visibility);
  expect(hidden).toBe('hidden');

  // Tapping the task opens it, which is the only way in.
  await page.locator('[data-rt-open]').first().click();
  await expect(sheet).toBeVisible();
  await expect(page.locator('body')).toContainText('Gear returned');

  withDb(db => db.prepare("DELETE FROM shift_tasks WHERE group_key = 'beq:e2e-gear'").run());
});
