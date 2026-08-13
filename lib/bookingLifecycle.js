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

// ── Worker-facing status policy — the ONE source of truth ────────────────
// Six files used to carry six slightly different status lists deciding what
// workers see and what they get pushed about, and every divergence was a
// real bug: unconfirmed bookings leaking onto the home screen, confirmed
// shifts cancelled without a push, "New shift assigned" pings for conflict
// bookings the portal refuses to list, finalised shifts vanishing from a
// worker's history. Import these — never write a local status list again.
//
// WORKER_VISIBLE_STATUSES — the portal shows the shift (home/list/detail).
// NOTIFIABLE_STATUSES     — changes push to the crew. Visibility minus
//                           on_hold: if a worker can see a shift they must
//                           hear when it changes; if they can't see it,
//                           never ping them about it.
// REMINDABLE_STATUSES     — pre-shift 24h/2h reminders (upcoming states
//                           only; a live or finished shift needs none).
const WORKER_VISIBLE_STATUSES = ['confirmed', 'locked', 'green_to_go', 'in_progress', 'complete', 'finalised', 'on_hold'];
const NOTIFIABLE_STATUSES = ['confirmed', 'locked', 'green_to_go', 'in_progress', 'complete', 'finalised'];
const REMINDABLE_STATUSES = ['confirmed', 'locked', 'green_to_go'];

// SQL helper: "b.status IN (?,?,…)" placeholder list for one of the sets.
function statusPlaceholders(list) { return list.map(() => '?').join(','); }

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

  // Removals: in booking_crew but not wanted. The allocation delete can hit
  // an FK wall when history hangs off it (safety_forms / docket rows /
  // clock_events reference allocation_id) — mirror the direct remove
  // endpoint: fall back to status='cancelled' so the worker's shift
  // disappears from the portal instead of a 500 mid-diff leaving a ghost
  // 'allocated' row behind.
  const cancelAlloc = db.prepare("UPDATE crew_allocations SET status = 'cancelled' WHERE booking_id = ? AND crew_member_id = ?");
  for (const r of existing) {
    if (!wanted.has(r.crew_member_id)) {
      delCrew.run(bookingId, r.crew_member_id);
      try {
        delAlloc.run(bookingId, r.crew_member_id);
      } catch (e) {
        try { cancelAlloc.run(bookingId, r.crew_member_id); } catch (e2) { /* legacy schema */ }
      }
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
  // Workers get the allocation notice at 'locked' and confirm from there, so
  // locked is the normal source state; confirmed/unconfirmed kept for
  // bookings that gathered confirmations before being locked.
  if (booking.status !== 'locked' && booking.status !== 'confirmed' && booking.status !== 'unconfirmed') return false;

  // Count only crew who still count — declined members have bowed out and
  // shouldn't hold the whole shift back from going green.
  const active = db.prepare("SELECT COUNT(*) AS c FROM booking_crew WHERE booking_id = ? AND status != 'declined'").get(bookingId);
  const confirmed = db.prepare("SELECT COUNT(*) AS c FROM booking_crew WHERE booking_id = ? AND status = 'confirmed'").get(bookingId);
  if (!active || active.c === 0) return false;
  if (confirmed.c < active.c) return false;

  db.prepare("UPDATE bookings SET status = 'green_to_go', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(bookingId);
  return true;
}

/**
 * Repair crew_allocations.status drift from booking_crew for one worker —
 * a historical bug left accepted shifts stuck 'allocated' (so they sat in
 * Requests forever) and declines unmirrored. Cheap two-UPDATE fix-on-read;
 * call it from any worker surface that renders shift statuses.
 */
function reconcileWorkerAllocations(db, crewMemberId) {
  try {
    db.prepare(`
      UPDATE crew_allocations
      SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)
      WHERE crew_member_id = ?
        AND status = 'allocated'
        AND booking_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM booking_crew bc
           WHERE bc.booking_id = crew_allocations.booking_id
             AND bc.crew_member_id = crew_allocations.crew_member_id
             AND bc.status = 'confirmed'
        )
    `).run(crewMemberId);
    db.prepare(`
      UPDATE crew_allocations
      SET status = 'declined'
      WHERE crew_member_id = ?
        AND status IN ('allocated','confirmed')
        AND booking_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM booking_crew bc
           WHERE bc.booking_id = crew_allocations.booking_id
             AND bc.crew_member_id = crew_allocations.crew_member_id
             AND bc.status = 'declined'
        )
    `).run(crewMemberId);
  } catch (e) { /* legacy DB without booking_crew — skip */ }
}

// Current Sydney wall-clock as a "YYYY-MM-DDTHH:MM:SS" string that sorts the
// same way the stored start_datetime does (also local Sydney time).
function sydneyNowStamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Sydney', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).reduce((m, p) => { m[p.type] = p.value; return m; }, {});
  // en-CA gives 24h "24" for midnight in some engines — normalise.
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}`;
}

/**
 * Auto-advance bookings whose shift is currently live to 'in_progress'
 * ("Ongoing"). Only promotes from ready-to-run statuses; a docket submit
 * later flips them to 'complete' (see lib/shiftDocket completeShift), so we
 * intentionally put no upper bound on end_datetime — a started shift stays
 * Ongoing until its docket is submitted. Cheap single UPDATE; safe to call
 * on every board / detail render (single-instance deployment).
 */
function autoAdvanceOngoing(db) {
  try {
    // Normalise the separator before comparing: Traffio imports store
    // "YYYY-MM-DD HH:MM:SS" (space) while the app writes "…T…". A space
    // sorts before 'T', so a raw string compare flipped every same-day
    // Traffio booking to in_progress at first render — a 23:00 night
    // shift viewed at 09:00 read as already started.
    const now = sydneyNowStamp().replace('T', ' ');
    return db.prepare(
      `UPDATE bookings SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
       WHERE status IN ('confirmed','green_to_go','locked')
         AND start_datetime IS NOT NULL AND REPLACE(start_datetime, 'T', ' ') <= ?
         AND (deleted_at IS NULL)`
    ).run(now).changes;
  } catch (e) { return 0; }
}

module.exports = { TERMINAL_STATUSES, WORKER_VISIBLE_STATUSES, NOTIFIABLE_STATUSES, REMINDABLE_STATUSES, statusPlaceholders, syncAllocationsToBooking, cascadeCancel, cascadeRestore, diffCrew, bookingDateParts, maybePromoteToGreenToGo, autoAdvanceOngoing, reconcileWorkerAllocations };
