// Cert expiry push reminders.
//
// Daily-cron friendly: scans crew_members for the standard ticket/licence
// expiry columns and fires a push when an item is exactly 30, 14 or 7 days
// from expiry. Deduplicated via cert_expiry_reminder_log so the same
// 14-day warning only fires once per (worker, item, days_out, expiry_date)
// tuple — even if the cron is invoked twice in a day or the expiry date
// later shifts to a new value.
//
// Category 'cert_expiry' is honoured by sendPushToCrew, so workers who've
// muted that category get nothing.

'use strict';

const { getDb } = require('../db/database');
const { sendPushToCrew } = require('./pushNotification');

// Columns on crew_members + the human-readable label for the push body.
// The schema also has *_ticket_expiry columns; include any that exist.
const ITEMS = [
  { col: 'licence_expiry',     key: 'licence',     label: 'Driver licence' },
  { col: 'white_card_expiry',  key: 'white_card',  label: 'White Card' },
  { col: 'medical_expiry',     key: 'medical',     label: 'Medical' },
  { col: 'tc_ticket_expiry',   key: 'tc_ticket',   label: 'TC Ticket' },
  { col: 'ti_ticket_expiry',   key: 'ti_ticket',   label: 'TI Ticket' },
  { col: 'first_aid_expiry',   key: 'first_aid',   label: 'First Aid' },
];

const WINDOWS = [30, 14, 7]; // days before expiry

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Pull the column list once so we don't query columns that don't exist on
// older databases (the schema was added by migrations 14+).
function existingColumns(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(crew_members)").all().map(c => c.name);
    return new Set(cols);
  } catch (e) { return new Set(); }
}

async function sendCertExpiryReminders() {
  const db = getDb();
  const cols = existingColumns(db);
  const items = ITEMS.filter(i => cols.has(i.col));
  if (!items.length) return { sent: 0, scanned: 0 };

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const targetDates = WINDOWS.map(n => {
    const d = new Date(today); d.setDate(d.getDate() + n);
    return { days: n, date: ymd(d) };
  });

  let sent = 0;
  let scanned = 0;
  for (const item of items) {
    for (const t of targetDates) {
      // Find every active worker whose <col> falls exactly on the target date.
      const rows = db.prepare(`
        SELECT id, full_name, ${item.col} AS expiry_date
        FROM crew_members
        WHERE active = 1 AND ${item.col} = ?
      `).all(t.date);
      scanned += rows.length;
      for (const w of rows) {
        // Skip if we already sent this exact reminder.
        const dup = db.prepare(`
          SELECT 1 FROM cert_expiry_reminder_log
          WHERE crew_member_id = ? AND item_key = ? AND days_out = ? AND expiry_date = ?
        `).get(w.id, item.key, t.days, w.expiry_date);
        if (dup) continue;

        try {
          await sendPushToCrew(w.id, {
            title: item.label + ' expires in ' + t.days + ' day' + (t.days === 1 ? '' : 's'),
            body: 'Your ' + item.label + ' expires on ' + w.expiry_date + '. Send the office your updated copy.',
            url: '/w/hr/certs',
            type: 'cert_expiry',
            category: 'cert_expiry',
          });
          db.prepare(`
            INSERT OR IGNORE INTO cert_expiry_reminder_log
              (crew_member_id, item_key, days_out, expiry_date)
            VALUES (?, ?, ?, ?)
          `).run(w.id, item.key, t.days, w.expiry_date);
          sent++;
        } catch (e) {
          console.error('[cert-expiry] push error for crew', w.id, ':', e.message);
        }
      }
    }
  }
  // ── VOC expiries ──
  // Same WINDOWS + dedup table, but VOC rows live in voc_assessments and
  // join to crew_members for the push target. item_key is `voc:<id>` so
  // it never collides with the crew_members column-based items above.
  let vocTableExists = false;
  try {
    vocTableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='voc_assessments'").get();
  } catch (e) { /* leave false */ }

  if (vocTableExists) {
    for (const t of targetDates) {
      const rows = db.prepare(`
        SELECT a.id AS voc_id, a.crew_member_id, a.valid_until,
          t.name AS equipment_name
        FROM voc_assessments a
        JOIN voc_templates t ON t.id = a.template_id
        JOIN crew_members cm ON cm.id = a.crew_member_id
        WHERE cm.active = 1
          AND a.status = 'submitted'
          AND a.outcome = 'competent'
          AND COALESCE(a.certificate_status, 'active') = 'active'
          AND a.valid_until = ?
      `).all(t.date);
      scanned += rows.length;
      for (const v of rows) {
        const itemKey = 'voc:' + v.voc_id;
        const dup = db.prepare(`
          SELECT 1 FROM cert_expiry_reminder_log
          WHERE crew_member_id = ? AND item_key = ? AND days_out = ? AND expiry_date = ?
        `).get(v.crew_member_id, itemKey, t.days, v.valid_until);
        if (dup) continue;

        try {
          await sendPushToCrew(v.crew_member_id, {
            title: 'VOC expires in ' + t.days + ' day' + (t.days === 1 ? '' : 's'),
            body: 'Your ' + v.equipment_name + ' VOC expires on ' + v.valid_until + '. Book a re-assessment with your trainer.',
            url: '/w/hr/certs',
            type: 'cert_expiry',
            category: 'cert_expiry',
          });
          db.prepare(`
            INSERT OR IGNORE INTO cert_expiry_reminder_log
              (crew_member_id, item_key, days_out, expiry_date)
            VALUES (?, ?, ?, ?)
          `).run(v.crew_member_id, itemKey, t.days, v.valid_until);
          sent++;
        } catch (e) {
          console.error('[voc-expiry] push error for crew', v.crew_member_id, 'voc', v.voc_id, ':', e.message);
        }
      }
    }
  }

  if (sent > 0 || scanned > 0) {
    console.log('[cert-expiry] scanned ' + scanned + ' candidates, sent ' + sent + ' push(es)');
  }
  return { sent, scanned };
}

module.exports = { sendCertExpiryReminders };
