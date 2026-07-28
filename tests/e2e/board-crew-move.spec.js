// Bookings board — moving a crew member BETWEEN shifts by dragging their
// row from one card onto another.
//
// Before this, a cross-booking move was remove-from-A then re-add-on-B: two
// slide-overs, and every per-shift side effect done by hand. The drag now
// does it in one gesture, with the move semantics owned by one endpoint:
//
//   POST /bookings/:id/crew/:crewId/move-to  { to_booking_id, vehicle_id? }
//
//   - acceptance RESETS to 'assigned': the worker accepted shift A, nobody
//     has asked them about shift B yet;
//   - the driver pointer on any source vehicle they drove is cleared;
//   - colleagues on the source shift hold their seats (holdOthersStill);
//   - gear-return tasks re-sync on BOTH bookings;
//   - a duplicate (already on the target shift) is rejected;
//   - a dead target (cancelled / complete / finalised / late_cancellation)
//     is rejected.
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

// Two bookings on today's board. Source has two crew (mover + bystander)
// and a ute; target has one ute and no crew.
function seedTwoBookings() {
  return withDb(db => {
    const today = sydneyToday();
    const mkBooking = (num, title, startHm, endHm) => {
      let bk = db.prepare('SELECT id FROM bookings WHERE booking_number = ?').get(num);
      if (!bk) {
        db.prepare(`
          INSERT INTO bookings (booking_number, title, start_datetime, end_datetime, status, depot)
          VALUES (?, ?, ? || ?, ? || ?, 'confirmed', 'Villawood')
        `).run(num, title, today, 'T' + startHm, today, 'T' + endHm);
        bk = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      } else {
        db.prepare("UPDATE bookings SET status = 'confirmed', start_datetime = ? || ?, end_datetime = ? || ? WHERE id = ?")
          .run(today, 'T' + startHm, today, 'T' + endHm, bk.id);
      }
      return bk.id;
    };
    const srcId = mkBooking('BK-MOVE-SRC', 'Move source booking', '07:00', '15:00');
    const dstId = mkBooking('BK-MOVE-DST', 'Move target booking', '07:00', '15:00');

    const mkVehicle = (bookingId, name) => {
      let v = db.prepare('SELECT id FROM booking_vehicles WHERE booking_id = ? AND vehicle_name = ?').get(bookingId, name);
      if (!v) {
        db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, vehicle_role) VALUES (?, ?, 'ute')").run(bookingId, name);
        v = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      return v.id;
    };
    const srcVeh = mkVehicle(srcId, 'MOVE-UTE-A');
    const dstVeh = mkVehicle(dstId, 'MOVE-UTE-B');

    const mkCrew = (name) => {
      let cm = db.prepare('SELECT id FROM crew_members WHERE full_name = ?').get(name);
      if (!cm) {
        db.prepare('INSERT INTO crew_members (full_name, active) VALUES (?, 1)').run(name);
        cm = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
      }
      return cm.id;
    };
    const moverCm = mkCrew('Mover Person');
    const stayerCm = mkCrew('Stayer Person');

    // Fresh placement every run: mover accepted the SOURCE shift and drives
    // its ute; the stayer is seat-derived (unpinned). Target starts empty.
    //
    // Requirements and allocations must be reset too, not just crew: every
    // move bumps a requirement row on the destination, and across serial
    // tests those accumulate into extra empty slots that make the cards
    // grow until two of them no longer fit on screen for a drag.
    db.prepare('DELETE FROM booking_crew WHERE booking_id IN (?, ?)').run(srcId, dstId);
    db.prepare('DELETE FROM booking_requirements WHERE booking_id IN (?, ?)').run(srcId, dstId);
    db.prepare('DELETE FROM crew_allocations WHERE booking_id IN (?, ?)').run(srcId, dstId);
    db.prepare(`
      INSERT INTO booking_crew (booking_id, crew_member_id, status, assigned_vehicle_id)
      VALUES (?, ?, 'confirmed', ?)
    `).run(srcId, moverCm, srcVeh);
    const moverRow = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare(`
      INSERT INTO booking_crew (booking_id, crew_member_id, status, assigned_vehicle_id, off_vehicle)
      VALUES (?, ?, 'confirmed', NULL, 0)
    `).run(srcId, stayerCm);
    const stayerRow = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare('UPDATE booking_vehicles SET crew_member_id = ? WHERE id = ?').run(moverCm, srcVeh);
    db.prepare('UPDATE booking_vehicles SET crew_member_id = NULL WHERE id = ?').run(dstVeh);

    return { srcId, dstId, srcVeh, dstVeh, moverCm, stayerCm, moverRow, stayerRow };
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

const cardOf = (page, num) => page.locator('.bk2-card', { hasText: num }).first();

// Drag helper shared with board-crew-state.spec.js semantics: both ends must
// be inside the viewport, clear of the drag's own edge auto-scroll band.
async function bringBothIntoView(page, from, to) {
  await from.scrollIntoViewIfNeeded();
  const vh = page.viewportSize().height;
  for (let i = 0; i < 5; i++) {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    if (a && b) {
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y + a.height, b.y + b.height);
      if (lo >= 100 && hi <= vh - 100) return [a, b];
      const delta = hi > vh - 100 ? hi - (vh - 100) : lo - 100;
      await page.mouse.wheel(0, delta);
    } else {
      await page.mouse.wheel(0, 200);
    }
    await page.waitForTimeout(150);
  }
  return [await from.boundingBox(), await to.boundingBox()];
}

async function pointerDrag(page, from, to, { release = true } = {}) {
  const [a, b] = await bringBothIntoView(page, from, to);
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 8, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 200), { steps: 14 });
  if (release) await page.mouse.up();
}

// Two full-width cards cannot both be on screen at 375x812, and a
// cross-card drag there is not a real workflow — the popover is. Endpoint
// behaviour is still covered on both projects.
const desktopOnly = (page) => (page.viewportSize().width < 900);

test('dragging a worker onto another shift moves them there, acceptance reset', async ({ page }) => {
  const seed = seedTwoBookings();
  await openBoard(page);
  test.skip(desktopOnly(page), 'cross-card drag is a desktop gesture');

  const src = cardOf(page, 'BK-MOVE-SRC').locator('.bk2-slot--filled.bk2-slot--click', { hasText: 'Mover Person' }).first();
  const dstUte = cardOf(page, 'BK-MOVE-DST').locator('.bk2-veh-slot.bk2-slot--drop-veh-assign[data-vehicle-id="' + seed.dstVeh + '"]').first();

  await pointerDrag(page, src, dstUte, { release: false });
  // The cross-card destination is highlighted before release.
  await expect(page.locator('.bk2-drop-live')).toHaveCount(1);
  await page.mouse.up();

  await expect.poll(
    () => withDb(db => db.prepare('SELECT booking_id AS b FROM booking_crew WHERE id = ?').get(seed.moverRow).b),
    { timeout: 5000 }
  ).toBe(seed.dstId);

  const row = withDb(db => db.prepare(
    'SELECT booking_id, status, assigned_vehicle_id FROM booking_crew WHERE id = ?'
  ).get(seed.moverRow));
  expect(row.status).toBe('assigned');              // accepted A ≠ accepted B
  expect(row.assigned_vehicle_id).toBe(seed.dstVeh); // dropped on that ute

  // They no longer drive the source ute.
  expect(withDb(db => db.prepare('SELECT crew_member_id AS d FROM booking_vehicles WHERE id = ?')
    .get(seed.srcVeh).d)).toBe(null);

  // The colleague left behind was not rewritten.
  const stayer = withDb(db => db.prepare(
    'SELECT booking_id, status, assigned_vehicle_id FROM booking_crew WHERE id = ?'
  ).get(seed.stayerRow));
  expect(stayer.booking_id).toBe(seed.srcId);
  expect(stayer.status).toBe('confirmed');

  // Both cards re-rendered: mover appears on the target card, gone from source.
  await expect(cardOf(page, 'BK-MOVE-DST')).toContainText('Mover Person');
  await expect(cardOf(page, 'BK-MOVE-SRC')).not.toContainText('Mover Person');
});

test('dropping on the card body (no specific ute) lands them in the pool', async ({ page }) => {
  const seed = seedTwoBookings();
  await openBoard(page);
  test.skip(desktopOnly(page), 'cross-card drag is a desktop gesture');

  const src = cardOf(page, 'BK-MOVE-SRC').locator('.bk2-slot--filled.bk2-slot--click', { hasText: 'Mover Person' }).first();
  // The target card's title block — inside the card, not on any ute or pool.
  const dstBody = cardOf(page, 'BK-MOVE-DST').locator('.bk2-card-h3').first();

  await pointerDrag(page, src, dstBody);

  await expect.poll(
    () => withDb(db => db.prepare('SELECT booking_id AS b FROM booking_crew WHERE id = ?').get(seed.moverRow).b),
    { timeout: 5000 }
  ).toBe(seed.dstId);
  const row = withDb(db => db.prepare('SELECT assigned_vehicle_id AS v, off_vehicle AS o FROM booking_crew WHERE id = ?').get(seed.moverRow));
  expect(row.v).toBe(null);
  expect(row.o).toBe(1); // parked in the pool, not re-fanned into a seat
});

test('the endpoint rejects a duplicate and a dead target', async ({ page }) => {
  const seed = seedTwoBookings();
  // Put the mover on BOTH bookings to provoke the duplicate.
  withDb(db => db.prepare(
    "INSERT INTO booking_crew (booking_id, crew_member_id, status) VALUES (?, ?, 'assigned')"
  ).run(seed.dstId, seed.moverCm));

  await openBoard(page);
  const post = (path, body) => page.evaluate(async ({ path, body }) => {
    const meta = document.querySelector('meta[name="csrf-token"]');
    const token = meta ? meta.getAttribute('content') : '';
    const r = await fetch(path, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': token || '',
      },
      body: new URLSearchParams(Object.assign({ _csrf: token }, body)),
      credentials: 'same-origin',
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, { path, body });

  const dup = await post(`/bookings/${seed.srcId}/crew/${seed.moverRow}/move-to`, { to_booking_id: String(seed.dstId) });
  expect(dup.status).toBe(400);
  expect(String(dup.json && dup.json.error)).toMatch(/already on/i);

  // Row untouched by the rejection.
  expect(withDb(db => db.prepare('SELECT booking_id AS b FROM booking_crew WHERE id = ?').get(seed.moverRow).b)).toBe(seed.srcId);

  // Dead target: cancel the destination, remove the duplicate, try again.
  withDb(db => {
    db.prepare('DELETE FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').run(seed.dstId, seed.moverCm);
    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(seed.dstId);
  });
  const dead = await post(`/bookings/${seed.srcId}/crew/${seed.moverRow}/move-to`, { to_booking_id: String(seed.dstId) });
  expect(dead.status).toBe(400);
  expect(withDb(db => db.prepare('SELECT booking_id AS b FROM booking_crew WHERE id = ?').get(seed.moverRow).b)).toBe(seed.srcId);

  withDb(db => db.prepare("UPDATE bookings SET status = 'confirmed' WHERE id = ?").run(seed.dstId));
});

test('undo restores the shift, the seat and the original acceptance', async ({ page }) => {
  const seed = seedTwoBookings();
  await openBoard(page);
  test.skip(desktopOnly(page), 'cross-card drag is a desktop gesture');

  const src = cardOf(page, 'BK-MOVE-SRC').locator('.bk2-slot--filled.bk2-slot--click', { hasText: 'Mover Person' }).first();
  const dstUte = cardOf(page, 'BK-MOVE-DST').locator('.bk2-veh-slot.bk2-slot--drop-veh-assign[data-vehicle-id="' + seed.dstVeh + '"]').first();
  await pointerDrag(page, src, dstUte);

  await expect.poll(
    () => withDb(db => db.prepare('SELECT booking_id AS b FROM booking_crew WHERE id = ?').get(seed.moverRow).b),
    { timeout: 5000 }
  ).toBe(seed.dstId);

  // The toast offers Undo; taking it puts everything back — including the
  // 'confirmed' acceptance that a plain reverse-move would have wiped.
  const undo = page.locator('[data-bk2-toast-action]');
  await expect(undo).toBeVisible();
  await undo.click();

  await expect.poll(
    () => withDb(db => db.prepare('SELECT booking_id AS b FROM booking_crew WHERE id = ?').get(seed.moverRow).b),
    { timeout: 5000 }
  ).toBe(seed.srcId);
  const row = withDb(db => db.prepare('SELECT status, assigned_vehicle_id AS v FROM booking_crew WHERE id = ?').get(seed.moverRow));
  expect(row.status).toBe('confirmed');
  expect(row.v).toBe(seed.srcVeh);
});
