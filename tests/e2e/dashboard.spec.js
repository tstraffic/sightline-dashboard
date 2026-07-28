// The three-band dashboard (Phase 2 of the nav review).
//
// Structure guards:
//  - The 5-tab mini-app and the pinned KPI tile grid are GONE — the page is
//    Band 1 "Needs you now" (registry, zero-hidden, capped at 5 + overflow),
//    "Your work", Band 2 "Today's operations" (ops roles only), and exactly
//    one trend chart.
//  - Zero-value rule: a metric that is 0 never renders. Rows are built only
//    when count > 0, so asserting "every rendered row shows >= 1" pins the
//    rule structurally, whatever data other specs have seeded.
//  - One overdue definition: the Band 1 overdue-plans count must equal the
//    /compliance page summary. The old tile excluded status='submitted' and
//    read 2 while the table below it showed 10 — the seeded row here is
//    submitted AND past due, so it only counts if the unified (submitted-
//    inclusive) definition is in force on BOTH surfaces.
//
// Seeding is direct better-sqlite3 against the shared test DB (both browser
// projects run this file serially against one DB, so every seed is
// idempotent via a marker lookup). busy_timeout because the server holds
// the same file open.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');
const { addDays } = require('../../routes/helpers/dashboard-queries');

test.describe.configure({ mode: 'serial' });

function seed(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

// Band 1 rows render their count in the .attn-count numeral.
// textContent, not innerText: rows inside the closed <details> overflow are
// hidden, and innerText of a hidden element is '' (→ NaN).
async function rowCount(locator) {
  return parseInt((await locator.locator('.attn-count').textContent()).trim(), 10);
}

test('the console instrument panel themes light in light mode', async ({ page }) => {
  // The console band + day bar + weather card were fixed dark hex in BOTH
  // themes ("the 2 overlays stay dark even on light mode"). Force the light
  // theme the same way the worker spec does — a stored id beats
  // prefers-color-scheme, and 'daylight' maps to mode 'light'.
  await page.addInitScript(() => {
    try { localStorage.setItem('atomis-theme', 'daylight'); } catch (e) {}
  });
  await loginAs(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  const band = page.locator('#console');
  await expect(band).toBeVisible();
  const bandBg = await band.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bandBg, 'console band must not keep the dark surface').not.toBe('rgb(22, 26, 33)');

  // The thesis had a light-mode `color:#fff !important` guard from the
  // fixed-dark era — on a light band that is white-on-white.
  const thesis = page.locator('.console-thesis').first();
  if (await thesis.count()) {
    const ink = await thesis.evaluate(el => getComputedStyle(el).color);
    expect(ink, 'thesis ink must not be white on the light band').not.toBe('rgb(255, 255, 255)');
  }

  // Day bar inherits the re-skin when present (needs a booking today).
  const daybar = page.locator('#day-bar');
  if (await daybar.count()) {
    const dbBg = await daybar.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(dbBg, 'day bar must not keep the dark surface').not.toBe('rgb(30, 36, 45)');
  }
});

test('no tabs, three bands, and no zero-value rows anywhere', async ({ page }) => {
  await loginAs(page);

  // The tab strip and its panels are gone.
  await expect(page.locator('[data-tab]')).toHaveCount(0);
  await expect(page.locator('[data-tab-panel]')).toHaveCount(0);

  // Bands present (today-ops is admin-visible; your-work only when populated).
  await expect(page.locator('#console')).toBeVisible();
  await expect(page.locator('#needs-you-now')).toBeVisible();
  await expect(page.locator('#today-ops')).toBeVisible();
  await expect(page.locator('#trend')).toBeVisible();

  // Hermetic runs set DISABLE_WEATHER — every weather element must hide.
  await expect(page.locator('#wx-card')).toHaveCount(0);
  await expect(page.locator('.db-wxband')).toHaveCount(0);

  // At most one chart on the whole page (zero when the test DB has no jobs).
  expect(await page.locator('canvas').count()).toBeLessThanOrEqual(1);

  // Band 1 is either the all-clear line or rows — and every row is non-zero.
  const rows = page.locator('[data-attn]:not([data-attn="all-clear"])');
  const n = await rows.count();
  if (n === 0) {
    await expect(page.locator('[data-attn="all-clear"]')).toBeVisible();
  } else {
    for (let i = 0; i < n; i++) {
      expect(await rowCount(rows.nth(i))).toBeGreaterThan(0);
    }
  }

  // The dead metrics may not render as zeros anywhere.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/\$0\b/);
  expect(body).not.toMatch(/pending timesheet/i);
  expect(body).not.toMatch(/HOURS \(7D\)/i);
});

test('overdue plans row uses the same definition as /compliance', async ({ page }) => {
  seed(db => {
    // Submitted AND past due — visible only under the unified definition.
    const marker = "SELECT id FROM compliance WHERE title = 'E2E overdue submitted plan'";
    if (!db.prepare(marker).get()) {
      db.prepare(`
        INSERT INTO compliance (item_type, title, status, due_date)
        VALUES ('council_permit', 'E2E overdue submitted plan', 'submitted', '2026-01-01')
      `).run();
    }
  });

  await loginAs(page);
  const row = page.locator('[data-attn="overdue_plans"]');
  await expect(row).toBeAttached(); // may sit inside the <details> overflow
  const dashCount = await rowCount(row);
  expect(dashCount).toBeGreaterThanOrEqual(1);
  expect(await row.getAttribute('href')).toBe('/compliance');

  // Same number on the /compliance summary — one definition, one truth.
  await page.goto('/compliance');
  const stat = page.locator('.stat-card', { hasText: /overdue/i }).first();
  await expect(stat).toBeVisible();
  const pageCount = parseInt((await stat.innerText()).match(/\d+/)[0], 10);
  expect(pageCount).toBe(dashCount);
});

test('finance role gets no operations band', async ({ page }) => {
  // finance_user is seeded by SEED_TEST_USERS with password 'password'
  // (must_change_password already cleared by resetTestDb).
  await loginAs(page, 'finance_user', 'password');
  await expect(page.locator('#needs-you-now')).toBeVisible();
  await expect(page.locator('#today-ops')).toHaveCount(0);
});

test('six-plus triggers cap at five rows with a working overflow', async ({ page }, testInfo) => {
  const today = sydneyToday();
  seed(db => {
    const once = (marker, run) => { if (!db.prepare(marker).get()) run(); };

    once("SELECT id FROM incidents WHERE title = 'E2E open incident'", () =>
      db.prepare(`
        INSERT INTO incidents (incident_number, incident_type, title, description, investigation_status)
        VALUES ('INC-E2E-1', 'near_miss', 'E2E open incident', 'seeded by dashboard.spec', 'open')
      `).run());

    once("SELECT id FROM tasks WHERE title = 'E2E overdue task'", () =>
      db.prepare(`
        INSERT INTO tasks (title, due_date, status, division)
        VALUES ('E2E overdue task', '2026-01-02', 'open', 'ops')
      `).run());

    once("SELECT id FROM employee_leave WHERE reason = 'E2E pending leave'", () =>
      db.prepare(`
        INSERT INTO employee_leave (crew_member_id, leave_type, start_date, end_date, status, reason)
        VALUES ((SELECT id FROM crew_members LIMIT 1), 'annual', ?, ?, 'pending', 'E2E pending leave')
      `).run(addDays(today, 7), addDays(today, 8)));

    // A crew ticket expiring inside the 30-day window.
    db.prepare("UPDATE crew_members SET tc_ticket_expiry = ?, active = 1 WHERE id = (SELECT id FROM crew_members LIMIT 1)")
      .run(addDays(today, 10));

    // A booking starting today with no site docs — also gives the checklist
    // register a non-zero denominator for the month (another Band 1 row).
    once("SELECT id FROM bookings WHERE booking_number = 'BK-E2E-DASH'", () =>
      db.prepare(`
        INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
        VALUES ('BK-E2E-DASH', 'E2E dashboard booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(today, today));
  });

  await loginAs(page);

  // Exactly 5 rows in the always-visible list...
  await expect(page.locator('#needs-you-now > .divide-y > [data-attn]')).toHaveCount(5);

  // ...and the rest behind a native <details> disclosure.
  const details = page.locator('#needs-you-now details');
  await expect(details).toBeVisible();
  await expect(details.locator('summary')).toHaveText(/\+\d+ more/);
  await details.locator('summary').click();
  expect(await details.locator('[data-attn]').count()).toBeGreaterThanOrEqual(1);

  // The seeded booking gives the console a day-bar lane + the NOW line.
  await expect(page.locator('#day-bar')).toBeVisible();
  expect(await page.locator('#day-bar .db-blk').count()).toBeGreaterThanOrEqual(1);
  await expect(page.locator('#now-line')).toBeAttached();

  // Jobs in flight lists the seeded booking with its window.
  const opsText = await page.locator('#today-ops').innerText();
  expect(opsText).toMatch(/07:00/);
});
