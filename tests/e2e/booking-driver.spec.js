// Driver assignment on a multi-vehicle booking.
//
// Regression guard: POST /bookings/:id/crew/:crewId/driver used to attach the
// driver to `booking_vehicles ... ORDER BY id LIMIT 1` — the booking's FIRST
// vehicle — whoever the clicked worker actually was. On a big booking that
// evicted vehicle #1's real driver and left the clicked worker undriven,
// which the planner saw as "assigning a driver takes someone else off".
// The route must key on the vehicle the crew member is seated in (or an
// explicit vehicle_id), and must never touch another vehicle's occupant.
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

// A booking with TWO vehicles and one crew member seated in each.
function seedTwoVehicleBooking() {
  return withDb(db => {
    const today = sydneyToday();
    let bk = db.prepare("SELECT id FROM bookings WHERE booking_number = 'BK-DRV-TEST'").get();
    if (!bk) {
      db.prepare(`
        INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
        VALUES ('BK-DRV-TEST', 'Driver regression booking', ? || 'T07:00', ? || 'T15:00', 'confirmed', 'Villawood')
      `).run(today, today);
      bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    const bookingId = bk.id;

    // Two crew members, two vehicles, one seat each. The fresh test DB seeds
    // only one active crew member, so top up.
    for (const name of ['Driver Test Alice', 'Driver Test Bob']) {
      if (!db.prepare('SELECT id FROM crew_members WHERE full_name = ?').get(name)) {
        db.prepare("INSERT INTO crew_members (full_name, active) VALUES (?, 1)").run(name);
      }
    }
    const crew = db.prepare("SELECT id FROM crew_members WHERE full_name IN ('Driver Test Alice','Driver Test Bob') ORDER BY id").all();
    let vehicles = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id').all(bookingId);
    if (vehicles.length < 2) {
      for (const name of ['DRV-UTE-1', 'DRV-UTE-2']) {
        db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role) VALUES (?, ?, 'ute')").run(bookingId, name);
      }
      vehicles = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id').all(bookingId);
    }
    const [v1, v2] = vehicles;

    const seat = (crewMemberId, vehicleId) => {
      const existing = db.prepare('SELECT id FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(bookingId, crewMemberId);
      if (existing) {
        db.prepare('UPDATE booking_crew SET assigned_vehicle_id = ?, status = ? WHERE id = ?').run(vehicleId, 'confirmed', existing.id);
        return existing.id;
      }
      db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, assigned_vehicle_id, status) VALUES (?, ?, ?, 'confirmed')")
        .run(bookingId, crewMemberId, vehicleId);
      return db.prepare('SELECT last_insert_rowid() AS id').get().id;
    };
    const crewRow1 = seat(crew[0].id, v1.id);
    const crewRow2 = seat(crew[1].id, v2.id);

    // Alice already drives vehicle 1; vehicle 2 has no driver yet.
    db.prepare('UPDATE booking_vehicles SET crew_member_id = ? WHERE id = ?').run(crew[0].id, v1.id);
    db.prepare('UPDATE booking_vehicles SET crew_member_id = NULL WHERE id = ?').run(v2.id);

    return { bookingId, v1: v1.id, v2: v2.id, crewRow1, crewRow2, member1: crew[0].id, member2: crew[1].id };
  });
}

const readDrivers = (ids) => withDb(db => ({
  v1: db.prepare('SELECT crew_member_id AS d FROM booking_vehicles WHERE id = ?').get(ids.v1).d,
  v2: db.prepare('SELECT crew_member_id AS d FROM booking_vehicles WHERE id = ?').get(ids.v2).d,
}));

test('setting a driver in vehicle 2 leaves vehicle 1 alone', async ({ page }) => {
  const ids = seedTwoVehicleBooking();
  await loginAs(page);

  const before = readDrivers(ids);
  expect(before.v1).toBe(ids.member1); // Alice drives ute 1
  expect(before.v2).toBeNull();

  // Make the ute-2 occupant its driver — exactly what the board's DRV
  // button does, including the vehicle_id the slot now sends.
  const res = await page.evaluate(async ({ bookingId, crewRowId }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const r = await fetch(`/bookings/${bookingId}/crew/${crewRowId}/driver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    return { status: r.status, body: await r.json() };
  }, { bookingId: ids.bookingId, crewRowId: ids.crewRow2 });

  expect(res.status).toBe(200);
  expect(res.body.value).toBe(1);

  const after = readDrivers(ids);
  expect(after.v2).toBe(ids.member2);  // the person we clicked now drives their ute
  expect(after.v1).toBe(ids.member1);  // and Alice was NOT evicted
});

test('a person can only hold one driving seat per booking', async ({ page }) => {
  const ids = seedTwoVehicleBooking();
  await loginAs(page);

  // Re-seat Alice into ute 2 and make her its driver: her ute-1 seat must clear.
  withDb(db => db.prepare('UPDATE booking_crew SET assigned_vehicle_id = ? WHERE id = ?').run(ids.v2, ids.crewRow1));
  await page.evaluate(async ({ bookingId, crewRowId }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    await fetch(`/bookings/${bookingId}/crew/${crewRowId}/driver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
  }, { bookingId: ids.bookingId, crewRowId: ids.crewRow1 });

  const after = readDrivers(ids);
  expect(after.v2).toBe(ids.member1);
  expect(after.v1).toBeNull();
});

test('an unseated crew member cannot silently steal another vehicle', async ({ page }) => {
  const ids = seedTwoVehicleBooking();
  await loginAs(page);
  // Take away their seat — the route must refuse rather than guess.
  withDb(db => db.prepare('UPDATE booking_crew SET assigned_vehicle_id = NULL WHERE id = ?').run(ids.crewRow2));

  const res = await page.evaluate(async ({ bookingId, crewRowId }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const r = await fetch(`/bookings/${bookingId}/crew/${crewRowId}/driver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: new URLSearchParams({ _csrf: csrf }).toString(),
    });
    return { status: r.status, body: await r.json() };
  }, { bookingId: ids.bookingId, crewRowId: ids.crewRow2 });

  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/vehicle/i);
  // Crucially: vehicle 1's driver is untouched.
  expect(readDrivers(ids).v1).toBe(ids.member1);
});
