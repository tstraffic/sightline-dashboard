// In-house training records — Portaboom, Trailer, Spotter, etc.
//
// Separate from training_completions (online quiz module results) and
// employee_competencies (tickets/licences with regulator-set cycles).
// Admins log these manually as crew members are trained on equipment or
// tasks; workers see their own list read-only on /w/safety/training.

'use strict';

function localIso(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

// Compute a derived status for a record based on expiry_date vs today.
// Returns one of: 'valid', 'expiring_soon' (<= 30 days), 'expired', 'no_expiry'.
// Used for the tone chips on both worker + admin views.
function recordStatus(row, todayIso) {
  if (!row || !row.expiry_date) return 'no_expiry';
  const today = todayIso || localIso();
  if (row.expiry_date < today) return 'expired';
  // 30-day soft warning window.
  const soon = new Date(today + 'T00:00:00');
  soon.setDate(soon.getDate() + 30);
  if (row.expiry_date <= soon.toISOString().slice(0, 10)) return 'expiring_soon';
  return 'valid';
}

// All training records for one crew member, newest first. Returns plain
// rows + a `status` field per row so views don't recompute.
function forCrewMember(db, crewMemberId) {
  if (!crewMemberId) return [];
  const rows = db.prepare(`
    SELECT tr.*, u.full_name AS created_by_name
    FROM training_records tr
    LEFT JOIN users u ON u.id = tr.created_by_id
    WHERE tr.crew_member_id = ?
    ORDER BY (tr.completed_date IS NULL OR tr.completed_date = '') ASC,
             tr.completed_date DESC, tr.id DESC
  `).all(crewMemberId);
  const today = localIso();
  return rows.map(r => ({ ...r, status: recordStatus(r, today) }));
}

// Distinct training_name values across the whole table — fed into the
// admin form's <datalist> so common names ("Portaboom Training",
// "Trailer Training") autocomplete after the first entry.
function distinctNames(db) {
  try {
    return db.prepare(`
      SELECT DISTINCT training_name FROM training_records
      WHERE training_name IS NOT NULL AND training_name <> ''
      ORDER BY training_name COLLATE NOCASE
    `).all().map(r => r.training_name);
  } catch (e) { return []; }
}

module.exports = { forCrewMember, distinctNames, recordStatus, localIso };
