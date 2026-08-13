/**
 * Shift reminder scanner.
 *
 * Runs every ~15 minutes from server.js. Sends two pre-shift reminders to
 * each rostered worker:
 *   - 24h out  (NOW+23h .. NOW+25h) — "shift tomorrow, please confirm"
 *   - 2h out   (NOW+1h45 .. NOW+2h15) — "shift starts soon"
 *
 * Dedupes via the `shift_reminder_log` table — each (crew_member_id,
 * shift_key, kind) tuple gets a notification at most once, so the 24h and 2h
 * reminders are independent and neither double-fires across scanner ticks.
 */
const { getDb } = require('../db/database');
const { sendPushToCrew } = require('./pushNotification');
const { sydneyWallClock } = require('../lib/sydney');
const { REMINDABLE_STATUSES } = require('../lib/bookingLifecycle');

// Crew must never hear about a shift — including 24h reminders — until the
// allocator has committed the booking. The list is the canonical
// REMINDABLE_STATUSES from lib/bookingLifecycle: pre-shift states only.
// (The old local copy here claimed to "mirror bookingNotify.isNotifiable"
// while actually differing from it, and included 'conflict' — a status the
// portal never shows — plus already-running/finished states no pre-shift
// reminder can apply to.)
const NOTIFIABLE_BOOKING_STATUSES = REMINDABLE_STATUSES;

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Build a shift_key that uniquely identifies the rostered shift for dedupe.
// Allocations have a real id; bookings use bc.id (booking_crew row id).
function allocKey(allocId) { return 'alloc:' + allocId; }
function bookingKey(bcId) { return 'bc:' + bcId; }

// Gather every rostered shift whose start falls in [lowerIso, upperIso],
// from both the allocation and booking_crew sources, gated on booking
// confirmation. Returns a flat list of reminder candidates.
function gatherCandidates(db, lowerIso, upperIso) {
    const candidates = [];

    // ---------- Allocations (job-bound shifts) ----------
    // Synthesize a start_datetime out of allocation_date + start_time so we
    // can window-match in a single comparison. start_time is HH:MM.
    try {
      const allocRows = db.prepare(`
        SELECT ca.id AS allocation_id, ca.crew_member_id, ca.allocation_date,
               ca.start_time, ca.end_time, ca.status,
               j.id AS job_id, j.job_number, j.client AS client_name, j.suburb,
               (ca.allocation_date || ' ' || COALESCE(ca.start_time,'00:00') || ':00') AS start_dt
        FROM crew_allocations ca
        LEFT JOIN jobs j ON ca.job_id = j.id
        LEFT JOIN bookings b ON ca.booking_id = b.id
        WHERE ca.status NOT IN ('cancelled','declined')
          -- A booking-linked allocation only counts once its booking is
          -- confirmed; allocations with no booking (pure job rosters) are unaffected.
          AND (ca.booking_id IS NULL OR b.status IN (${NOTIFIABLE_BOOKING_STATUSES.map(() => '?').join(',')}))
          AND ca.allocation_date >= date(?)
          AND ca.allocation_date <= date(?)
          AND (ca.allocation_date || ' ' || COALESCE(ca.start_time,'00:00') || ':00')
              BETWEEN ? AND ?
      `).all(...NOTIFIABLE_BOOKING_STATUSES, lowerIso, upperIso, lowerIso, upperIso);

      for (const r of allocRows) {
        candidates.push({
          crew_member_id: r.crew_member_id,
          shift_key: allocKey(r.allocation_id),
          start_time: r.start_time,
          end_time: r.end_time,
          allocation_date: r.allocation_date,
          client: r.client_name,
          job_number: r.job_number,
          suburb: r.suburb,
          status: r.status,
          link: r.job_id ? ('/w/jobs/' + r.job_id) : '/w/home',
        });
      }
    } catch (e) { console.error('[ShiftReminders] alloc query failed:', e.message); }

    // ---------- Booking crew (booking-bound shifts without allocations) ----------
    try {
      const bcRows = db.prepare(`
        SELECT bc.id AS bc_id, bc.crew_member_id, bc.booking_id, bc.status,
               b.booking_number, b.title, b.suburb,
               b.start_datetime, b.end_datetime,
               DATE(b.start_datetime) AS shift_date,
               SUBSTR(b.start_datetime, 12, 5) AS start_time,
               SUBSTR(b.end_datetime, 12, 5) AS end_time
        FROM booking_crew bc
        JOIN bookings b ON bc.booking_id = b.id
        WHERE b.deleted_at IS NULL
          AND b.status IN (${NOTIFIABLE_BOOKING_STATUSES.map(() => '?').join(',')})
          AND bc.status IN ('assigned','confirmed','tentative')
          AND REPLACE(b.start_datetime, 'T', ' ') BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM crew_allocations ca
             WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id
          )
      `).all(...NOTIFIABLE_BOOKING_STATUSES, lowerIso, upperIso);

      for (const r of bcRows) {
        candidates.push({
          crew_member_id: r.crew_member_id,
          shift_key: bookingKey(r.bc_id),
          start_time: r.start_time,
          end_time: r.end_time,
          allocation_date: r.shift_date,
          client: r.title,
          job_number: r.booking_number,
          suburb: r.suburb,
          status: r.status,
          link: '/w/booking-shift/' + r.booking_id,
        });
      }
    } catch (e) { /* booking_crew may not exist on legacy DBs */ }

    return candidates;
}

// Run one reminder window: scan [hoursLower, hoursUpper] out from now and
// push a deduped reminder (keyed by `kind`) to each candidate. `titleFor`
// builds the heading from the candidate (so 24h and 2h can read differently).
async function runReminderWindow(db, { hoursLower, hoursUpper, kind, type, titleFor }) {
  // Windows are Sydney wall-clock to match how shift start times are stored
  // (naive local strings, no offset) — comparing against UTC would be off by
  // the 10–11h Sydney offset.
  const now = Date.now();
  const lowerIso = sydneyWallClock(new Date(now + hoursLower * 3600 * 1000));
  const upperIso = sydneyWallClock(new Date(now + hoursUpper * 3600 * 1000));

  const candidates = gatherCandidates(db, lowerIso, upperIso);
  if (candidates.length === 0) return 0;

  const checkSent = db.prepare('SELECT 1 FROM shift_reminder_log WHERE crew_member_id = ? AND shift_key = ? AND kind = ?');
  const recordSent = db.prepare('INSERT OR IGNORE INTO shift_reminder_log (crew_member_id, shift_key, kind) VALUES (?, ?, ?)');

  let sentCount = 0;
  for (const c of candidates) {
    if (checkSent.get(c.crew_member_id, c.shift_key, kind)) continue;
    const body =
      (c.client ? c.client + ' · ' : '') +
      (c.start_time || '') + (c.end_time ? '–' + c.end_time : '') +
      (c.suburb ? ' · ' + c.suburb : '');
    try {
      await sendPushToCrew(c.crew_member_id, {
        title: titleFor(c),
        body: body.trim() || 'Tap to view your shift details.',
        url: c.link,
        type,
        category: 'shift_reminder',
      });
      recordSent.run(c.crew_member_id, c.shift_key, kind);
      sentCount++;
    } catch (e) {
      console.error('[ShiftReminders] send failed crew=', c.crew_member_id, e.message);
    }
  }
  return sentCount;
}

function isAwaitingConfirm(c) {
  return c.status === 'allocated' || c.status === 'assigned' || c.status === 'tentative';
}

async function sendUpcomingShiftReminders() {
  try {
    const db = getDb();
    const sent24 = await runReminderWindow(db, {
      hoursLower: 23, hoursUpper: 25, kind: '24h', type: 'shift_reminder_24h',
      titleFor: c => isAwaitingConfirm(c) ? 'Shift tomorrow — please confirm' : 'Shift reminder — starts in 24 hours',
    });
    const sent2 = await runReminderWindow(db, {
      hoursLower: 1.75, hoursUpper: 2.25, kind: '2h', type: 'shift_reminder_2h',
      titleFor: c => isAwaitingConfirm(c) ? 'Shift starts in ~2 hours — please confirm' : 'Shift starts in ~2 hours',
    });
    if (sent24 + sent2 > 0) console.log(`[ShiftReminders] Sent ${sent24} × 24h and ${sent2} × 2h shift reminder(s).`);
  } catch (err) {
    console.error('[ShiftReminders] scanner error:', err.message);
  }
}

module.exports = { sendUpcomingShiftReminders };
