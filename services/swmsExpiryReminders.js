// SWMS expiry reminders.
//
// Mirrors the cert-expiry pattern (services/certExpiryReminders.js) but for
// SWMS documents instead of personal tickets. Audience is office staff
// (admin / safety / operations roles) rather than individual workers —
// SWMS renewal is an office responsibility.
//
// Fires when swms.expiry_date is exactly 30, 14 or 7 days out. Active SWMS
// only (drafts and archived are excluded). Dedup via swms_expiry_reminder_log
// so multiple cron firings the same day collapse to one notification.
//
// The audit (AUDIT_REPORT.md Component 6) flagged that mig 166 added
// expiry_date + last_reminded_at columns but no cron extended or warned
// on them — so SWMS silently went 'expired' with admins finding out by
// noticing workers couldn't sign on. This service closes that gap.

'use strict';

const { getDb } = require('../db/database');
const { sendPushToUser } = require('./pushNotification');

const WINDOWS = [30, 14, 7];

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Roles that should receive SWMS expiry notifications. Mirrors the SWMS
// permission set from middleware/auth.js (admin/safety/operations/planning)
// but tightened to the people who actually act on it.
const NOTIFY_ROLES = ['admin', 'safety', 'operations'];

async function sendSwmsExpiryReminders() {
  const db = getDb();

  // Bail if the column isn't there (older DB without migration 166).
  const cols = db.prepare("PRAGMA table_info(swms)").all().map(c => c.name);
  if (!cols.includes('expiry_date')) return { sent: 0, scanned: 0 };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const targetDates = WINDOWS.map(n => {
    const d = new Date(today); d.setDate(d.getDate() + n);
    return { days: n, date: ymd(d) };
  });

  const recipients = db.prepare(
    `SELECT id, full_name, email FROM users WHERE role IN (${NOTIFY_ROLES.map(() => '?').join(',')}) AND active = 1`
  ).all(...NOTIFY_ROLES);

  if (!recipients.length) return { sent: 0, scanned: 0 };

  let sent = 0;
  let scanned = 0;
  for (const t of targetDates) {
    const rows = db.prepare(`
      SELECT s.id, s.title, s.kind, s.expiry_date, s.job_id,
        j.job_number, j.client AS job_client
      FROM swms s
      LEFT JOIN jobs j ON j.id = s.job_id
      WHERE s.status = 'active' AND s.expiry_date = ?
    `).all(t.date);
    scanned += rows.length;

    for (const swms of rows) {
      // Dedup once per (swms_id, days_out, expiry_date). If anyone has
      // already received this exact reminder, skip the whole SWMS so
      // we don't re-notify other admins when a new admin joins the
      // recipient set mid-window.
      const dup = db.prepare(`
        SELECT 1 FROM swms_expiry_reminder_log
        WHERE swms_id = ? AND days_out = ? AND expiry_date = ?
      `).get(swms.id, t.days, swms.expiry_date);
      if (dup) continue;

      const jobSuffix = swms.job_number
        ? ` (job ${swms.job_number}${swms.job_client ? ' · ' + swms.job_client : ''})`
        : swms.kind === 'template' ? ' (template)' : '';
      const title = `SWMS expires in ${t.days} day${t.days === 1 ? '' : 's'}`;
      const body = `${swms.title}${jobSuffix} expires on ${swms.expiry_date}. Renew or extend before workers lose access.`;

      // Notification row per admin so it surfaces in the bell — and fire
      // a push for whoever has a subscription registered.
      const insertNotif = db.prepare(`
        INSERT INTO notifications (user_id, type, title, message, link)
        VALUES (?, 'swms_expiry', ?, ?, '/swms/' || ?)
      `);

      for (const u of recipients) {
        try {
          insertNotif.run(u.id, title, body, swms.id);
          await sendPushToUser(u.id, {
            title,
            body,
            url: '/swms/' + swms.id,
            type: 'swms_expiry',
          });
        } catch (e) {
          console.error('[swms-expiry] notify error for user', u.id, ':', e.message);
        }
      }

      // Log once per (swms, days, expiry) — outer loop over recipients
      // doesn't insert here because the dedup key is per-SWMS.
      try {
        db.prepare(`
          INSERT OR IGNORE INTO swms_expiry_reminder_log
            (swms_id, days_out, expiry_date)
          VALUES (?, ?, ?)
        `).run(swms.id, t.days, swms.expiry_date);
      } catch (e) {
        console.error('[swms-expiry] dedup log error for swms', swms.id, ':', e.message);
      }
      sent++;
    }
  }

  if (sent > 0 || scanned > 0) {
    console.log(`[swms-expiry] scanned ${scanned} candidates, notified ${sent} SWMS x ${recipients.length} recipients`);
  }
  return { sent, scanned, recipients: recipients.length };
}

module.exports = { sendSwmsExpiryReminders };
