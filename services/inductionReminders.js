// Induction reminder notifications.
//
// Daily-cron friendly: scans seek_applicants for upcoming inductions and
// fires push + bell notifications to admin / operations / hr users at
// 7 / 3 / 1 days out and on the morning of the induction. Deduped via
// induction_reminder_log so the same window only fires once even if the
// cron is invoked twice in a day or the process restarts. Re-scheduling
// an applicant to a new date regenerates the windows because the dedup
// key includes induction_date.
//
// Reminder body includes the booked time (if set) so the recipient can
// see at a glance when the induction starts.

'use strict';

const { getDb } = require('../db/database');
const { sendPushToUser } = require('./pushNotification');

const WINDOWS = [7, 3, 1, 0];
const NOTIFY_ROLES = ['admin', 'operations', 'hr'];

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function fmtFriendlyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' });
}

function windowLabel(days) {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return 'in ' + days + ' days';
}

async function sendInductionReminders() {
  const db = getDb();

  // Bail safely if migration hasn't run yet.
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('seek_applicants','induction_reminder_log')").all().map(r => r.name);
  if (!tables.includes('seek_applicants') || !tables.includes('induction_reminder_log')) {
    return { sent: 0, scanned: 0, recipients: 0 };
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const targetDates = WINDOWS.map(n => {
    const d = new Date(today); d.setDate(d.getDate() + n);
    return { days: n, date: ymd(d) };
  });

  const recipients = db.prepare(
    `SELECT id, full_name, email FROM users WHERE LOWER(role) IN (${NOTIFY_ROLES.map(() => '?').join(',')}) AND active = 1`
  ).all(...NOTIFY_ROLES);
  if (!recipients.length) return { sent: 0, scanned: 0, recipients: 0 };

  // notifications.type is CHECK-constrained across migrations to a fixed
  // vocab. 'general' is the only value safe in every historical schema, so
  // we use that for the bell entry and put the context in title + message.
  const insertNotif = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (?, 'general', ?, ?, '/induction/admin/recruitment')
  `);
  const insertLog = db.prepare(`
    INSERT OR IGNORE INTO induction_reminder_log
      (applicant_id, days_out, induction_date)
    VALUES (?, ?, ?)
  `);

  let sent = 0;
  let scanned = 0;

  for (const t of targetDates) {
    // Only remind for applicants still in the pre-induction pipeline. If
    // they've already been Inducted/Hired/No Show/Withdrew/Not Suitable
    // the induction either happened or won't, so skip.
    const rows = db.prepare(`
      SELECT id, applicant_name, induction_date, induction_time, status, phone, email
      FROM seek_applicants
      WHERE induction_date = ?
        AND LOWER(COALESCE(status,'')) NOT IN ('inducted','hired','no show','withdrew','not suitable')
    `).all(t.date);
    scanned += rows.length;

    for (const a of rows) {
      const dup = db.prepare(`
        SELECT 1 FROM induction_reminder_log
        WHERE applicant_id = ? AND days_out = ? AND induction_date = ?
      `).get(a.id, t.days, a.induction_date);
      if (dup) continue;

      const when = windowLabel(t.days);
      const timeSuffix = a.induction_time ? ' at ' + a.induction_time : '';
      const title = `Induction ${when}: ${a.applicant_name}`;
      const body = `${a.applicant_name}'s induction is ${when} (${fmtFriendlyDate(a.induction_date)}${timeSuffix}).`
        + (a.phone ? ` Phone: ${a.phone}.` : '');

      for (const u of recipients) {
        try { insertNotif.run(u.id, title, body); } catch (e) { /* CHECK or FK — log but keep going */ console.error('[induction-reminder] notif insert error for user', u.id, ':', e.message); }
        try {
          await sendPushToUser(u.id, {
            title,
            body,
            url: '/induction/admin/recruitment',
            type: 'induction_reminder',
          });
        } catch (e) {
          console.error('[induction-reminder] push error for user', u.id, ':', e.message);
        }
      }

      try { insertLog.run(a.id, t.days, a.induction_date); }
      catch (e) { console.error('[induction-reminder] dedup log error for applicant', a.id, ':', e.message); }
      sent++;
    }
  }

  if (sent > 0 || scanned > 0) {
    console.log(`[induction-reminder] scanned ${scanned} candidates, notified ${sent} applicants x ${recipients.length} recipients`);
  }
  return { sent, scanned, recipients: recipients.length };
}

module.exports = { sendInductionReminders };
