// Phantom empty "TC ×N" slots on the bookings board.
//
// The board's empty-slot drop sends the block's DISPLAY label as the role
// ('TC' — data-role-on-site="<%= blk.role || 'TC' %>"), and the pool chips
// send crew_members.role free text. POST /bookings/:id/crew stored that raw,
// while stealAddonSlot in deriveCrewBlocks maps roles via canonical
// snake_case keys only — 'TC' missed, so a worker seated on a ute never
// absorbed their people-addon requirement slot. The card kept an empty
// "TC ×N" block ("2 more TC slots · drop workers here") even though every
// requirement was genuinely filled. Seen on BK-0046 with 6 of 6 crew seated.
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

// A booking shaped like the report: a 'Traffic Controller' people add-on,
// one spare vehicle (no "Nx TC Crew" rows, so the vehicle isn't swallowed
// into a crew block), and crew seated on it whose role_on_site carries the
// board's display label.
function seedPhantom() {
  return withDb(db => {
    const today = sydneyToday();
    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-PHANTOM'").get();
    if (!bk) {
      db.prepare(`
        INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
        VALUES ('BK-PHANTOM', 'Phantom slot booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    } else {
      db.prepare("UPDATE bookings SET start_datetime = ? || 'T07:00', end_datetime = ? || 'T15:00' WHERE id = ?")
        .run(today, today, bk.id);
    }
    const bookingId = bk.id;

    db.prepare('DELETE FROM booking_requirements WHERE booking_id = ?').run(bookingId);
    db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, 'Traffic Controller', 2)").run(bookingId);
    db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, 'Spotter', 1)").run(bookingId);

    let veh = db.prepare("SELECT id FROM booking_vehicles WHERE booking_id = ? AND vehicle_name = 'PH-UTE-1'").get(bookingId);
    if (!veh) {
      db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role) VALUES (?, 'PH-UTE-1', 'ute')").run(bookingId);
      veh = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }

    const mkCrew = (name) => {
      let cm = db.prepare('SELECT id FROM crew_members WHERE full_name = ?').get(name);
      if (!cm) {
        db.prepare('INSERT INTO crew_members (full_name, active) VALUES (?, 1)').run(name);
        cm = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      return cm.id;
    };
    db.prepare('DELETE FROM booking_crew WHERE booking_id = ?').run(bookingId);
    const ids = {};
    // Two seated workers with the board's DISPLAY label as their role.
    for (const name of ['Phantom Tc One', 'Phantom Tc Two']) {
      db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status, assigned_vehicle_id) VALUES (?, ?, 'TC', 'confirmed', ?)")
        .run(bookingId, mkCrew(name), veh.id);
    }
    // An off-vehicle Spotter, display-labelled, with a Spotter add-on open.
    db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status, assigned_vehicle_id, off_vehicle) VALUES (?, ?, 'Spotter', 'confirmed', NULL, 1)")
      .run(bookingId, mkCrew('Phantom Spotter One'));
    return { bookingId, vehicleId: veh.id };
  });
}

async function openBoard(page) {
  await loginAs(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('bk2-density', 'comfortable'); } catch (e) {}
  });
  await page.goto('/bookings/board');
  await page.waitForLoadState('networkidle');
}

const cardOf = (page) => page.locator('.bk2-card', { hasText: 'BK-PHANTOM' }).first();

test('seated display-label crew leave no phantom empty TC slots', async ({ page }) => {
  seedPhantom();
  await openBoard(page);
  const card = cardOf(page);
  await expect(card).toHaveCount(1);

  // Both workers render on the vehicle...
  await expect(card).toContainText('Phantom Tc One');
  await expect(card).toContainText('Phantom Tc Two');

  // ...and the Traffic Controller requirement they satisfy must not linger
  // as empty droppable person-slots. (The spare vehicle's own drop target
  // is a vehicle slot, not a person slot, so it doesn't match this.)
  await expect(
    card.locator('.bk2-slot--empty[data-role-on-site="TC"]'),
    'no phantom empty TC person-slots'
  ).toHaveCount(0);
});

test('an off-vehicle display-label Spotter lands in the Spotter group, not the pool', async ({ page }) => {
  seedPhantom();
  await openBoard(page);
  const card = cardOf(page);

  // Pre-fix, ROLE_TO_ADDON missed 'Spotter'-as-typed only when unmapped —
  // here the display label matches the map after normalisation, so the
  // worker must sit inside the Spotter add-on group (filling its slot)
  // rather than duplicating: one filled Spotter slot, zero empty ones,
  // and no "Not in any vehicle" pool entry for them.
  const pool = card.locator('.bk2-unassigned');
  if (await pool.count()) {
    await expect(pool).not.toContainText('Phantom Spotter One');
  }
  await expect(card.locator('.bk2-slot--empty[data-role-on-site="Spotter"]')).toHaveCount(0);
  await expect(card).toContainText('Phantom Spotter One');
});

test('a fully-seated spare-vehicle card still offers the take-off drop zone', async ({ page }) => {
  const seed = seedPhantom();
  // Seat the spotter too — nobody left in the pool. The zone used to render
  // only when a CREW BLOCK carried a vehicle or the pool was non-empty, so a
  // card whose utes are all spare (people add-on requirements) lost the only
  // drag target for unseating the moment everyone was aboard.
  withDb(db => db.prepare(
    'UPDATE booking_crew SET assigned_vehicle_id = ?, off_vehicle = 0 WHERE booking_id = ?'
  ).run(seed.vehicleId, seed.bookingId));

  await openBoard(page);
  const card = cardOf(page);
  await expect(card.locator('.bk2-unassigned')).toHaveCount(0 + 1); // zone present…
  await expect(card.locator('.bk2-slot--drop-unassign')).toHaveCount(1);
  // …and it's the empty "drop here" affordance, not a populated pool.
  await expect(card.locator('.bk2-unassigned')).toContainText('Drop here to take off the ute');
});

test('the crew-add endpoint canonicalises display labels on write', async ({ page }) => {
  const seed = seedPhantom();
  await loginAs(page);
  await page.goto('/bookings/board');

  const cm = withDb(db => {
    let row = db.prepare("SELECT id FROM crew_members WHERE full_name = 'Phantom Add Target'").get();
    if (!row) {
      db.prepare("INSERT INTO crew_members (full_name, active) VALUES ('Phantom Add Target', 1)").run();
      row = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    db.prepare('DELETE FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').run(seed.bookingId, row.id);
    db.prepare('DELETE FROM crew_allocations WHERE booking_id = ? AND crew_member_id = ?').run(seed.bookingId, row.id);
    return row.id;
  });

  const res = await page.evaluate(async ({ bookingId, crewId }) => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const token = meta ? meta.getAttribute('content') : '';
    const r = await fetch(`/bookings/${bookingId}/crew`, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': token },
      body: new URLSearchParams({ _csrf: token, crew_member_id: String(crewId), role_on_site: 'TC' }),
      credentials: 'same-origin',
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { bookingId: seed.bookingId, crewId: cm });
  expect(res.status).toBe(200);

  const stored = withDb(db => ({
    bc: db.prepare('SELECT role_on_site AS r FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(seed.bookingId, cm),
    ca: db.prepare('SELECT role_on_site AS r FROM crew_allocations WHERE booking_id = ? AND crew_member_id = ?').get(seed.bookingId, cm),
  }));
  expect(stored.bc.r).toBe('traffic_controller');
  expect(stored.ca && stored.ca.r).toBe('traffic_controller');
});
