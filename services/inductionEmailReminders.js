// Applicant-facing induction reminder emails — 36h and 12h before the
// booked induction time.
//
// Distinct from services/inductionReminders.js, which pushes 7/3/1/0-day
// reminders to admin/ops/hr STAFF. This one emails the PERSON BOOKED for
// the induction (seek_applicants.email), same audience as the booking
// confirmation email in routes/recruitment.js.
//
// Cron cadence: every 15 minutes (hour-scale windows need better than the
// daily tick). A window fires once we're inside it (now >= inductionAt -
// Nh) and still before the induction itself; dedup via
// induction_email_reminder_log (mig 326), keyed on date AND time so a
// re-schedule re-arms both windows. When a booking is made already inside
// both windows, only the most imminent one emails — the other is logged as
// spent so the applicant never gets two reminders back-to-back.
//
// Time handling: induction_date is a plain YYYY-MM-DD, induction_time an
// optional 'HH:MM' — both Sydney wall-clock. The epoch is built with
// lib/sydney's DST-aware offset. No booked time ⇒ anchor 09:00 for window
// maths and leave the time out of the email (mirrors the confirmation).

'use strict';

const { getDb } = require('../db/database');
const { sendEmail } = require('./email');
const { inductionReminderEmail } = require('./emailTemplates');
const { sydneyOffsetForDate } = require('../lib/sydney');

const WINDOW_HOURS = [36, 12]; // ordered longest-first; most imminent wins ties
// Same skip list as the staff-facing service (inductionReminders.js): once
// someone is INDUCTED/HIRED the induction happened; NO_SHOW/DECLINED means
// it won't. Note lib/recruitmentStages.isTerminal covers only the latter
// two — INDUCTED/HIRED are forward stages there, so it can't be used here.
const SKIP_STAGES = new Set(['INDUCTED', 'HIRED', 'NO_SHOW', 'DECLINED']);
const INDUCTION_FORM_URL = (process.env.APP_BASE_URL || 'https://tstc.up.railway.app').replace(/\/$/, '') + '/induction';

// 'YYYY-MM-DD' + optional 'HH:MM' (Sydney wall clock) → epoch ms, or null.
function inductionEpoch(dateStr, timeStr) {
  const iso = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  const hhmm = m ? String(parseInt(m[1], 10)).padStart(2, '0') + ':' + m[2] : '09:00';
  const t = new Date(iso + 'T' + hhmm + ':00' + sydneyOffsetForDate(iso)).getTime();
  return Number.isFinite(t) ? t : null;
}

// "on Friday, 24 July 2026 at 9:00 am" — same wording as the confirmation.
function whenText(dateStr, timeStr) {
  const iso = String(dateStr || '').slice(0, 10);
  const nice = new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  let t = '';
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    let h = parseInt(m[1], 10); const min = m[2];
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    t = ' at ' + h + ':' + min + ' ' + ampm;
  }
  return 'on ' + nice + t;
}

function leadLabel(hoursOut, msUntil) {
  const h = Math.max(1, Math.round(msUntil / 3600000));
  if (hoursOut === 12) return h <= 14 ? 'coming up in about ' + h + ' hours' : 'coming up soon';
  return 'coming up in about ' + h + ' hours';
}

async function sendInductionEmailReminders() {
  const db = getDb();

  // Bail safely on a DB that predates the tables.
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('seek_applicants','induction_email_reminder_log')"
  ).all().map(r => r.name);
  if (tables.length < 2) return { sent: 0, scanned: 0 };

  const now = Date.now();
  // Candidates: booked for today or tomorrow-ish (36h horizon ⇒ two
  // calendar dates is enough; the epoch check below does the exact maths).
  const rows = db.prepare(`
    SELECT id, applicant_name, email, induction_date, induction_time, stage
    FROM seek_applicants
    WHERE induction_date IS NOT NULL AND induction_date != ''
      AND DATE(induction_date) BETWEEN DATE('now', 'localtime') AND DATE('now', 'localtime', '+2 day')
      AND email IS NOT NULL AND email LIKE '%@%'
  `).all();

  const hasLog = db.prepare(
    'SELECT 1 FROM induction_email_reminder_log WHERE applicant_id = ? AND hours_out = ? AND induction_date = ? AND induction_time = ?'
  );
  const insertLog = db.prepare(
    'INSERT OR IGNORE INTO induction_email_reminder_log (applicant_id, hours_out, induction_date, induction_time) VALUES (?, ?, ?, ?)'
  );

  let sent = 0;
  for (const a of rows) {
    if (SKIP_STAGES.has(String(a.stage || '').toUpperCase())) continue;
    const at = inductionEpoch(a.induction_date, a.induction_time);
    if (!at || now >= at) continue; // unparseable or already started

    const timeKey = String(a.induction_time || '');
    const due = WINDOW_HOURS.filter(h =>
      now >= at - h * 3600000 && !hasLog.get(a.id, h, a.induction_date, timeKey)
    );
    if (!due.length) continue;

    // Most imminent due window emails; every due window is marked spent so a
    // late booking doesn't double-send.
    const fireHours = Math.min(...due);
    const html = inductionReminderEmail(whenText(a.induction_date, a.induction_time), INDUCTION_FORM_URL, leadLabel(fireHours, at - now));
    let ok = false;
    try {
      ok = await sendEmail(a.email, 'Induction Reminder — T&S Traffic Control', html);
    } catch (e) {
      console.error('[induction-email-reminder] send error for applicant', a.id, ':', e.message);
    }
    if (ok) {
      for (const h of due) {
        try { insertLog.run(a.id, h, a.induction_date, timeKey); } catch (e) { /* dup — fine */ }
      }
      sent++;
    }
    // Not sent (service unconfigured / transient failure): no log row, so the
    // next 15-min tick retries until the induction time passes.
  }

  if (sent > 0) console.log(`[induction-email-reminder] emailed ${sent} applicant(s)`);
  return { sent, scanned: rows.length };
}

module.exports = { sendInductionEmailReminders, inductionEpoch };
