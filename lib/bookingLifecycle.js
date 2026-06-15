// Booking ↔ crew_allocations lifecycle coherence.
//
// A booking is what the office manages; crew_allocations is what the worker
// portal reads. Historically they drifted: rescheduling a booking left
// allocations on the old date, cancelling/deleting a booking left live
// allocations behind, and re-saving the crew picker wiped confirmations.
// Every route that mutates a booking's schedule, status or crew goes through
// these helpers so both tables always tell the same story.

const { logActivity } = require('../middleware/audit');

// Booking statuses after which a booking is "done" — no new sign-ons, no
// conflict checks, hidden from workers' active views. One list, used
// everywhere (lib/shiftDocket re-exports it as BOOKING_TERMINAL).
const TERMINAL_STATUSES = ['cancelled', 'complete', 'late_cancellation', 'finalised'];

function bookingDateParts(booking) {
  const start = String(booking.start_datetime || '');
  const end = String(booking.end_datetime || '');
  return {
    date: start.slice(0, 10),
    startTime: start.slice(11, 16) || '06:00',
    endTime: end.slice(11, 16) || '14:30',
  };
}

/**
 * After a booking's date/times change, move its crew_allocations with it —
 * date + start/end follow the booking, status is preserved (a confirmed
 * worker stays confirmed across a reschedule).
 */
function syncAllocationsToBooking(db, bookingId) {
  const booking = db.prepare('SELECT id, start_datetime, end_datetime FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return 0;
  const p = bookingDateParts(booking);
  if (!p.date) return 0;
  const r = db.prepare(`
    UPDATE crew_allocations
    SET allocation_date = ?, start_time = ?, end_time = ?
    WHERE booking_id = ? AND status NOT IN ('cancelled','declined')
      AND (allocation_date != ? OR start_time != ? OR end_time != ?)
  `).run(p.date, p.startTime, p.endTime, bookingId, p.date, p.startTime, p.endTime);
  return r.changes;
}

/**
 * Booking cancelled / late-cancelled / soft-deleted: cancel its live
 * allocations (rows kept for audit). Returns affected crew_member_ids so the
 * caller can notify them.
 */
function cascadeCancel(db, bookingId) {
  const crew = db.prepare(`
    SELECT DISTINCT crew_member_id FROM crew_allocations
    WHERE booking_id = ? AND status NOT IN ('cancelled','declined')
  `).all(bookingId).map(r => r.crew_member_id);
  db.prepare(`
    UPDATE crew_allocations SET status = 'cancelled'
    WHERE booking_id = ? AND status NOT IN ('cancelled','declined')
  `).run(bookingId);
  return crew;
}

/**
 * Booking restored from soft-delete (or un-cancelled): revive its allocations
 * to match each person's booking_crew status — confirmed stays confirmed,
 * everyone else returns to 'allocated'. Declined stays declined.
 */
function cascadeRestore(db, bookingId) {
  const r = db.prepare(`
    UPDATE crew_allocations
    SET status = CASE
      WHEN EXISTS (SELECT 1 FROM booking_crew bc
                   WHERE bc.booking_id = crew_allocations.booking_id
                     AND bc.crew_member_id = crew_allocations.crew_member_id
                     AND bc.status = 'confirmed') THEN 'confirmed'
      ELSE 'allocated'
    END
    WHERE booking_id = ? AND status = 'cancelled'
      AND NOT EXISTS (SELECT 1 FROM booking_crew bc2
                      WHERE bc2.booking_id = crew_allocations.booking_id
                        AND bc2.crew_member_id = crew_allocations.crew_member_id
                        AND bc2.status = 'declined')
  `).run(bookingId);
  return r.changes;
}

/**
 * Replace the crew picker's DELETE+re-INSERT with a diff so existing rows —
 * and their confirmed/declined statuses + confirmed_at — survive a re-save.
 *
 * crewIds: array of crew_member ids that should be on the booking.
 * roleFor(crewId) -> role_on_site string for new/updated rows.
 * Returns { added: [ids], removed: [ids], kept: [ids] }.
 */
function diffCrew(db, bookingId, crewIds, roleFor, opts = {}) {
  const wanted = new Set((crewIds || []).map(n => parseInt(n, 10)).filter(n => n > 0));
  const existing = db.prepare('SELECT crew_member_id, role_on_site FROM booking_crew WHERE booking_id = ?').all(bookingId);
  const existingIds = new Set(existing.map(r => r.crew_member_id));

  const added = [], removed = [], kept = [];
  const booking = db.prepare('SELECT id, job_id, start_datetime, end_datetime FROM bookings WHERE id = ?').get(bookingId);
  const p = booking ? bookingDateParts(booking) : null;

  const insCrew = db.prepare("INSERT OR IGNORE INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')");
  const insAlloc = db.prepare(`
    INSERT OR IGNORE INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id, allocated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?)
  `);
  const delCrew = db.prepare('DELETE FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?');
  const delAlloc = db.prepare('DELETE FROM crew_allocations WHERE booking_id = ? AND crew_member_id = ?');
  const clearDriver = db.prepare('UPDATE booking_vehicles SET crew_member_id = NULL WHERE booking_id = ? AND crew_member_id = ?');
  const updRole = db.prepare('UPDATE booking_crew SET role_on_site = ? WHERE booking_id = ? AND crew_member_id = ?');

  // Removals: in booking_crew but not wanted.
  for (const r of existing) {
    if (!wanted.has(r.crew_member_id)) {
      delCrew.run(bookingId, r.crew_member_id);
      delAlloc.run(bookingId, r.crew_member_id);
      clearDriver.run(bookingId, r.crew_member_id);
      removed.push(r.crew_member_id);
    }
  }
  // Additions + kept (role refresh only — status untouched).
  for (const cid of wanted) {
    const role = roleFor ? roleFor(cid) : 'traffic_controller';
    if (existingIds.has(cid)) {
      updRole.run(role, bookingId, cid);
      kept.push(cid);
    } else {
      insCrew.run(bookingId, cid, role);
      if (booking && p && p.date) {
        try { insAlloc.run(booking.job_id || null, cid, p.date, p.startTime, p.endTime, role, bookingId, opts.userId || null); } catch (e) { /* job_id NOT NULL on legacy schema */ }
      }
      added.push(cid);
    }
  }
  return { added, removed, kept };
}

/**
 * All-crew-accepted → Green to Go.
 *
 * Once every assigned (non-declined) crew member on a booking has confirmed,
 * the booking auto-advances to 'green_to_go'. Only promotes from the pre-GTG
 * states ('confirmed' / 'unconfirmed') — it never drags a booking that's
 * already in_progress / complete / cancelled backwards or forwards.
 *
 * Returns true only on the actual transition (so the caller can fire the
 * one-time "good to go" notification), false otherwise.
 */
function maybePromoteToGreenToGo(db, bookingId) {
  const booking = db.prepare('SELECT id, status FROM bookings WHERE id = ?').get(bookingId);
  if (!booking) return false;
  if (booking.status !== 'confirmed' && booking.status !== 'unconfirmed') return false;

  // Count only crew who still count — declined members have bowed out and
  // shouldn't hold the whole shift back from going green.
  const active = db.prepare("SELECT COUNT(*) AS c FROM booking_crew WHERE booking_id = ? AND status != 'declined'").get(bookingId);
  const confirmed = db.prepare("SELECT COUNT(*) AS c FROM booking_crew WHERE booking_id = ? AND status = 'confirmed'").get(bookingId);
  if (!active || active.c === 0) return false;
  if (confirmed.c < active.c) return false;

  db.prepare("UPDATE bookings SET status = 'green_to_go', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(bookingId);
  return true;
}

module.exports = { TERMINAL_STATUSES, syncAllocationsToBooking, cascadeCancel, cascadeRestore, diffCrew, bookingDateParts, maybePromoteToGreenToGo };
