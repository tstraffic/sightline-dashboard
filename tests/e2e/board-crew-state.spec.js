// Bookings board — crew acceptance state, and moving crew without dragging.
//
// Three complaints from the allocators, all on the same card:
//
//  1. The board never showed who had ACCEPTED a shift. booking_crew.status
//     was rendered as a single hard-coded green tick, inline-styled, in ONE
//     of the four slot branches — so a DECLINED crew member was pixel-for-
//     pixel identical to a confirmed one and a hole in tomorrow's crew was
//     invisible.
//  2. In light mode the card collapsed to flat grey: utes, TCs, warnings and
//     equipment all rendered at the same weight.
//  3. Crew could only be moved between utes by dragging. HTML5 drag-and-drop
//     emits no touch events, so on a tablet it was impossible; and the crew
//     popover could take someone OFF a ute but never put them ON one.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const PEOPLE = [
  { name: 'Accept Yes One', status: 'confirmed' },
  { name: 'Accept Pending One', status: 'assigned' },
  { name: 'Accept No One', status: 'declined' },
];

// One booking today, two utes, three crew in the three acceptance states.
// Everyone starts on ute 1 so "move to ute 2" is a real state change.
function seedBoard() {
  return withDb(db => {
    const today = sydneyToday();
    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-ACCEPT'").get();
    if (!bk) {
      db.prepare(`
        INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
        VALUES ('BK-ACCEPT', 'Acceptance board booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    } else {
      db.prepare("UPDATE bookings SET start_datetime = ? || 'T07:00', end_datetime = ? || 'T15:00' WHERE id = ?")
        .run(today, today, bk.id);
    }
    const bookingId = bk.id;

    let vehicles = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id').all(bookingId);
    if (vehicles.length < 2) {
      for (const n of ['ACC-UTE-1', 'ACC-UTE-2']) {
        db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role) VALUES (?, ?, 'ute')").run(bookingId, n);
      }
      vehicles = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id').all(bookingId);
    }
    const [v1, v2] = vehicles;

    const rows = {};
    for (const p of PEOPLE) {
      let cm = db.prepare('SELECT id FROM crew_members WHERE full_name = ?').get(p.name);
      if (!cm) {
        db.prepare('INSERT INTO crew_members (full_name, active) VALUES (?, 1)').run(p.name);
        cm = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      const existing = db.prepare('SELECT id FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(bookingId, cm.id);
      if (existing) {
        db.prepare('UPDATE booking_crew SET status = ?, assigned_vehicle_id = ?, off_vehicle = 0 WHERE id = ?')
          .run(p.status, v1.id, existing.id);
        rows[p.name] = existing.id;
      } else {
        db.prepare('INSERT INTO booking_crew (booking_id, crew_member_id, status, assigned_vehicle_id) VALUES (?, ?, ?, ?)')
          .run(bookingId, cm.id, p.status, v1.id);
        rows[p.name] = db.prepare('SELECT last_insert_rowid() AS id').get().id;
      }
    }
    return { bookingId, v1: v1.id, v2: v2.id, rows };
  });
}

async function openBoard(page, density = 'comfortable') {
  await loginAs(page);
  await page.addInitScript(d => {
    try { localStorage.setItem('bk2-density', d); } catch (e) {}
  }, density);
  await page.goto('/bookings/board');
  await page.waitForLoadState('networkidle');
}

function cardFor(page) {
  return page.locator('.bk2-card', { hasText: 'BK-ACCEPT' }).first();
}

test('every crew member on the card shows an accept / pending / declined badge', async ({ page }) => {
  seedBoard();
  await openBoard(page);
  const card = cardFor(page);
  await expect(card).toHaveCount(1);

  // The old markup rendered a badge for confirmed only, in one branch.
  for (const [name, cls, label] of [
    ['Accept Yes One',     'bk2-accept--yes',     'Accepted'],
    ['Accept Pending One', 'bk2-accept--pending', 'Awaiting reply'],
    ['Accept No One',      'bk2-accept--no',      'Declined'],
  ]) {
    const slot = card.locator('.bk2-slot--filled', { hasText: name }).first();
    await expect(slot).toHaveCount(1);
    const badge = slot.locator('.bk2-slot-accept');
    await expect(badge).toHaveClass(new RegExp(cls));
    await expect(badge).toHaveAttribute('title', label);
  }

  // The three states must be visually distinct, not just semantically —
  // this is what made a declined worker indistinguishable before.
  const colours = await card.locator('.bk2-slot-accept').evaluateAll(
    els => els.map(e => getComputedStyle(e).color)
  );
  expect(new Set(colours).size).toBeGreaterThanOrEqual(3);
});

test('a declined crew member is called out, not silently styled as pending', async ({ page }) => {
  seedBoard();
  await openBoard(page);
  const card = cardFor(page);

  const declined = card.locator('.bk2-slot--filled', { hasText: 'Accept No One' }).first();
  await expect(declined).toHaveClass(/bk2-slot--st-no/);
  await expect(declined.locator('.bk2-slot-name')).toHaveCSS('text-decoration-line', 'line-through');

  const pending = card.locator('.bk2-slot--filled', { hasText: 'Accept Pending One' }).first();
  await expect(pending).toHaveClass(/bk2-slot--st-pending/);
  // Declined and pending must not share a background.
  const [decBg, penBg] = await Promise.all([
    declined.evaluate(e => getComputedStyle(e).backgroundColor),
    pending.evaluate(e => getComputedStyle(e).backgroundColor),
  ]);
  expect(decBg).not.toBe(penBg);
});

test('the card header rolls up acceptance so it reads without opening the card', async ({ page }) => {
  seedBoard();
  await openBoard(page);
  const chip = cardFor(page).locator('.bk2-acccount').first();
  await expect(chip).toBeVisible();
  // 1 of 3 accepted, 1 declined.
  await expect(chip).toContainText('1/3 in');
  await expect(chip).toContainText('1 out');
  await expect(chip).toHaveClass(/bk2-acccount--bad/);
});

test('roles that are not traffic controllers stop being labelled TC', async ({ page }) => {
  const seed = seedBoard();
  withDb(db => db.prepare('UPDATE booking_crew SET role_on_site = ? WHERE id = ?')
    .run('labourer', seed.rows['Accept Yes One']));
  await openBoard(page);
  const tag = cardFor(page)
    .locator('.bk2-slot--filled', { hasText: 'Accept Yes One' })
    .first().locator('.bk2-slot-role-tag');
  // roleAbbr collapsed labourer / trainee / security into 'TC'.
  await expect(tag).toHaveText('LAB');
  await expect(tag).toHaveClass(/bk2-role--lab/);
  withDb(db => db.prepare('UPDATE booking_crew SET role_on_site = NULL WHERE id = ?').run(seed.rows['Accept Yes One']));
});

test('a worker can be moved onto another ute by clicking, with no drag', async ({ page }) => {
  const seed = seedBoard();
  await openBoard(page);
  const card = cardFor(page);

  await card.locator('.bk2-slot--filled.bk2-slot--click', { hasText: 'Accept Yes One' }).first().click();
  const pop = page.locator('.bk2-pop');
  await expect(pop).toBeVisible();

  // Both utes plus the pool are offered; the current one is marked, disabled.
  const moves = pop.locator('.bk2-pop-move');
  await expect(moves).toHaveCount(3);
  await expect(pop.locator('.bk2-pop-move.is-here')).toHaveCount(1);
  await expect(pop.locator('.bk2-pop-move.is-here')).toContainText('ACC-UTE-1');

  await pop.locator('.bk2-pop-move', { hasText: 'ACC-UTE-2' }).first().click();
  await expect(pop).toHaveCount(0);

  await expect.poll(
    () => withDb(db => db.prepare('SELECT assigned_vehicle_id AS v FROM booking_crew WHERE id = ?')
      .get(seed.rows['Accept Yes One']).v),
    { timeout: 5000 }
  ).toBe(seed.v2);

  // ...and only that person moved.
  const others = withDb(db => db.prepare('SELECT assigned_vehicle_id AS v FROM booking_crew WHERE id IN (?, ?)')
    .all(seed.rows['Accept Pending One'], seed.rows['Accept No One']));
  expect(others.every(r => r.v === seed.v1)).toBe(true);
});

test('a worker can be dropped back to the pool from the same menu', async ({ page }) => {
  const seed = seedBoard();
  await openBoard(page);
  const card = cardFor(page);

  await card.locator('.bk2-slot--filled.bk2-slot--click', { hasText: 'Accept Pending One' }).first().click();
  const pop = page.locator('.bk2-pop');
  await pop.locator('.bk2-pop-move--pool').first().click();

  await expect.poll(
    () => withDb(db => db.prepare('SELECT assigned_vehicle_id AS v FROM booking_crew WHERE id = ?')
      .get(seed.rows['Accept Pending One']).v),
    { timeout: 5000 }
  ).toBe(null);
});

test('compact density keeps acceptance and the move menu', async ({ page }) => {
  seedBoard();
  await openBoard(page, 'compact');
  const card = cardFor(page);

  const row = card.locator('.bk2-csum-person', { hasText: 'Accept No One' }).first();
  await expect(row).toHaveClass(/bk2-slot--st-no/);
  await expect(row.locator('.bk2-slot-accept')).toHaveClass(/bk2-accept--no/);

  // Compact used to have no crew interaction at all — not even drag.
  await row.click();
  await expect(page.locator('.bk2-pop')).toBeVisible();
  // Deduped across the two density markups, which are both in the DOM.
  await expect(page.locator('.bk2-pop-move')).toHaveCount(3);
  // The click must not also trigger the card's own quick-edit slide-over.
  await expect(page.locator('.bk2-editor.is-open')).toHaveCount(0);
});

test('the editing view distinguishes declined from awaiting-reply', async ({ page }) => {
  const seed = seedBoard();
  await loginAs(page);
  await page.goto(`/bookings/${seed.bookingId}`);

  const declined = page.locator('.crew-chip.assigned', { hasText: 'Accept No One' }).first();
  await expect(declined).toHaveClass(/declined/);
  const pending = page.locator('.crew-chip.assigned', { hasText: 'Accept Pending One' }).first();
  await expect(pending).toHaveClass(/unconfirmed/);
  const accepted = page.locator('.crew-chip.assigned', { hasText: 'Accept Yes One' }).first();
  await expect(accepted).toHaveClass(/confirmed/);
});
