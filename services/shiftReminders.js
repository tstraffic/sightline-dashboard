/**
 * Shift reminder scanner.
 *
 * Runs every ~15 minutes from server.js. Finds shifts whose start time is
 * between NOW+23h and NOW+25h (i.e. ~24 hours out) and sends each rostered
 * worker a push notification asking them to confirm/accept the shift.
 *
 * Dedupes via the `shift_reminder_log` table — each (crew_member_id,
 * shift_key, kind) tuple gets a notification at most once. shift_key is
 * deterministic so the same shift can't double-fire even if the scanner
 * runs slightly off-cadence.
 */
const { getDb } = require('../db/database');
const { sendPushToCrew } = require('./pushNotification');

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// Build a shift_key that uniquely identifies the rostered shift for dedupe.
// Allocations have a real id; bookings use bc.id (booking_crew row id).
function allocKey(allocId) { return 'alloc:' + allocId; }
function bookingKey(bcId) { return 'bc:' + bcId; }

async function sendUpcomingShiftReminders() {
  try {
    const db = getDb();
    const now = new Date();
    const lower = new Date(now.getTime() + 23 * 3600 * 1000);
    const upper = new Date(now.getTime() + 25 * 3600 * 1000);

    // Window iso strings used by both queries below.
    const lowerIso = lower.toISOString().slice(0, 19).replace('T', ' ');
    const upperIso = upper.toISOString().slice(0, 19).replace('T', ' ');

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
        WHERE ca.status NOT IN ('cancelled','declined')
          AND ca.allocation_date >= date(?)
          AND ca.allocation_date <= date(?)
          AND (ca.allocation_date || ' ' || COALESCE(ca.start_time,'00:00') || ':00')
              BETWEEN ? AND ?
      `).all(lowerIso, upperIso, lowerIso, upperIso);

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
          AND b.status NOT IN ('cancelled')
          AND bc.status IN ('assigned','confirmed','tentative')
          AND b.start_datetime BETWEEN ? AND ?
          AND NOT EXISTS (
            SELECT 1 FROM crew_allocations ca
             WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id
          )
      `).all(lowerIso, upperIso);

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

    if (candidates.length === 0) return;

    const checkSent = db.prepare(`
      SELECT 1 FROM shift_reminder_log
      WHERE crew_member_id = ? AND shift_key = ? AND kind = '24h'
    `);
    const recordSent = db.prepare(`
      INSERT OR IGNORE INTO shift_reminder_log (crew_member_id, shift_key, kind)
      VALUES (?, ?, '24h')
    `);

    let sentCount = 0;
    for (const c of candidates) {
      if (checkSent.get(c.crew_member_id, c.shift_key)) continue;

      const isUnconfirmed = c.status === 'allocated' || c.status === 'assigned' || c.status === 'tentative';
      const title = isUnconfirmed ? 'Shift tomorrow — please confirm' : 'Shift reminder — starts in 24 hours';
      const body =
        (c.client ? c.client + ' · ' : '') +
        (c.start_time || '') + (c.end_time ? '–' + c.end_time : '') +
        (c.suburb ? ' · ' + c.suburb : '');

      try {
        await sendPushToCrew(c.crew_member_id, {
          title,
          body: body.trim() || 'Tap to view your shift details.',
          url: c.link,
          type: 'shift_reminder_24h',
          category: 'shift_reminder',
        });
        recordSent.run(c.crew_member_id, c.shift_key);
        sentCount++;
      } catch (e) {
        console.error('[ShiftReminders] send failed crew=', c.crew_member_id, e.message);
      }
    }

    if (sentCount > 0) console.log(`[ShiftReminders] Sent ${sentCount} 24-hour shift reminder(s).`);
  } catch (err) {
    console.error('[ShiftReminders] scanner error:', err.message);
  }
}

module.exports = { sendUpcomingShiftReminders };
