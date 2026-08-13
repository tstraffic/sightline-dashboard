/**
 * Time-based booking lifecycle automation. Runs every ~15 minutes from
 * server.js alongside the shift reminders.
 *
 *   advanceShiftStatuses()  — once a shift's start time passes, the booking
 *                             moves confirmed / green_to_go → in_progress.
 *                             Silent: workers get no notification for this.
 *                             (Docket submission later flips it to 'complete'.)
 *
 *   sendInShiftFormsReminders() — ~2 hours into a shift that's still running,
 *                             remind every rostered (non-declined) crew member
 *                             to submit their forms (Risk Assessment & Toolbox,
 *                             Team Leader Checklist). Deduped via
 *                             shift_reminder_log kind 'forms_2h_in'.
 */
const { getDb } = require('../db/database');
const { sendPushToCrew } = require('./pushNotification');
const { sydneyWallClock } = require('../lib/sydney');

// Statuses from which a shift can roll into 'in_progress' at start time.
// 'locked' included to match lib/bookingLifecycle.autoAdvanceOngoing — the
// two auto-advance paths (this 15-min cron and the render-time sweep) used
// to disagree on it, so whether a locked shift went Ongoing depended on
// whether anyone happened to open the board.
const PRE_PROGRESS_STATUSES = ['confirmed', 'green_to_go', 'locked'];
// While a shift is genuinely running, its booking sits in one of these.
const RUNNING_STATUSES = ['confirmed', 'green_to_go', 'locked', 'in_progress'];

// Sydney wall-clock 'YYYY-MM-DD HH:MM:SS' for now ± hours. Shift start times
// are stored as naive Sydney local strings, so the comparison must be in
// Sydney wall-clock, not UTC.
function nowSqlOffset(hours) {
  return sydneyWallClock(new Date(Date.now() + hours * 3600 * 1000));
}

// Shift start time has arrived → move the booking to in_progress. No push.
function advanceShiftStatuses() {
  try {
    const db = getDb();
    const nowIso = nowSqlOffset(0);
    const r = db.prepare(`
      UPDATE bookings
      SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
      WHERE deleted_at IS NULL
        AND status IN (${PRE_PROGRESS_STATUSES.map(() => '?').join(',')})
        AND REPLACE(start_datetime, 'T', ' ') <= ?
    `).run(...PRE_PROGRESS_STATUSES, nowIso);
    if (r.changes > 0) console.log(`[ShiftAdvance] ${r.changes} booking(s) → in_progress.`);
  } catch (e) {
    console.error('[ShiftAdvance] advanceShiftStatuses error:', e.message);
  }
}

// ~2 hours into a still-running shift → nudge the crew to get their forms in.
async function sendInShiftFormsReminders() {
  try {
    const db = getDb();
    // Shift started between 2h15 and 1h45 ago (a 30-min window so the 15-min
    // scanner catches every shift exactly once; dedup makes it idempotent).
    const lowerIso = nowSqlOffset(-2.25); // older bound
    const upperIso = nowSqlOffset(-1.75); // newer bound

    const rows = db.prepare(`
      SELECT bc.id AS bc_id, bc.crew_member_id, b.id AS booking_id,
             b.booking_number, b.title, b.suburb
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE b.deleted_at IS NULL
        AND b.status IN (${RUNNING_STATUSES.map(() => '?').join(',')})
        AND bc.status != 'declined'
        AND REPLACE(b.start_datetime, 'T', ' ') BETWEEN ? AND ?
    `).all(...RUNNING_STATUSES, lowerIso, upperIso);

    if (rows.length === 0) return;

    const checkSent = db.prepare("SELECT 1 FROM shift_reminder_log WHERE crew_member_id = ? AND shift_key = ? AND kind = 'forms_2h_in'");
    const recordSent = db.prepare("INSERT OR IGNORE INTO shift_reminder_log (crew_member_id, shift_key, kind) VALUES (?, ?, 'forms_2h_in')");

    let sent = 0;
    for (const r of rows) {
      const shiftKey = 'bc:' + r.bc_id;
      if (checkSent.get(r.crew_member_id, shiftKey)) continue;
      const where = [r.title, r.suburb].filter(Boolean).join(' · ');
      try {
        await sendPushToCrew(r.crew_member_id, {
          title: 'Forms due — you’re 2 hours in',
          body: (where ? where + ': ' : '') + 'submit your Risk Assessment & Toolbox and Team Leader Checklist.',
          url: '/w/jobs',
          type: 'shift_forms_2h_in',
          category: 'shift_reminder',
        });
        recordSent.run(r.crew_member_id, shiftKey);
        sent++;
      } catch (e) {
        console.error('[ShiftAdvance] forms reminder send failed crew=', r.crew_member_id, e.message);
      }
    }
    if (sent > 0) console.log(`[ShiftAdvance] Sent ${sent} in-shift forms reminder(s).`);
  } catch (e) {
    console.error('[ShiftAdvance] sendInShiftFormsReminders error:', e.message);
  }
}

module.exports = { advanceShiftStatuses, sendInShiftFormsReminders };
