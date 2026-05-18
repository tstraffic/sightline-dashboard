// Birthday helpers — DOB lookup + coworker wish messages.
//
// DOB lives on the `employees` table, not `crew_members`. We join through
// employees.linked_crew_member_id so the birthday detection still works for
// crew members who don't have a separate employee row (e.g. subcontractors)
// — those just won't show up as having a DOB.
//
// All "today" comparisons run against the Sydney local date so the banner
// fires on the right day for everyone, regardless of Railway's UTC clock.

'use strict';

// YYYY-MM-DD in Sydney TZ. Mirrors the helper in services/homeContext.js so
// every "today" anchor across the app is consistent.
function localIso(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

// Returns the Sydney-local MM-DD substring for matching against DOB.
function sydneyMmDd(d) {
  const iso = localIso(d);
  return iso.slice(5, 10); // YYYY-MM-DD → MM-DD
}

// All active crew members whose DOB month+day matches today (Sydney).
// Each row carries the crew_member.id, full_name, employee.date_of_birth,
// and the age they're turning today.
function todaysBirthdays(db) {
  const mmdd = sydneyMmDd();
  const today = localIso();
  return db.prepare(`
    SELECT cm.id AS crew_member_id,
           cm.full_name,
           cm.email,
           cm.employee_id AS employee_code,
           e.id          AS employee_id,
           e.date_of_birth,
           CAST(substr(?, 1, 4) AS INTEGER) - CAST(substr(e.date_of_birth, 1, 4) AS INTEGER) AS turning
    FROM crew_members cm
    JOIN employees e ON e.linked_crew_member_id = cm.id
    WHERE cm.active = 1
      AND e.deleted_at IS NULL
      AND e.date_of_birth IS NOT NULL
      AND substr(e.date_of_birth, 6, 5) = ?
    ORDER BY cm.full_name
  `).all(today, mmdd);
}

// All messages left for a specific target's birthday (in chronological order).
function messagesForBirthday(db, targetCrewId, birthdayDate) {
  return db.prepare(`
    SELECT bm.id, bm.from_crew_member_id, bm.message, bm.created_at,
           cm.full_name AS from_name
    FROM birthday_messages bm
    JOIN crew_members cm ON cm.id = bm.from_crew_member_id
    WHERE bm.target_crew_member_id = ?
      AND bm.birthday_date = ?
    ORDER BY bm.created_at ASC
  `).all(targetCrewId, birthdayDate);
}

// Has this sender already wished this target today?
function hasMessaged(db, fromCrewId, targetCrewId, birthdayDate) {
  const row = db.prepare(`
    SELECT id FROM birthday_messages
    WHERE from_crew_member_id = ?
      AND target_crew_member_id = ?
      AND birthday_date = ?
  `).get(fromCrewId, targetCrewId, birthdayDate);
  return !!row;
}

// Insert a wish. Returns the new row id, or null if it was a duplicate
// (UNIQUE constraint hit — caller treats this as "already wished").
function addMessage(db, fromCrewId, targetCrewId, birthdayDate, message) {
  try {
    const r = db.prepare(`
      INSERT INTO birthday_messages (target_crew_member_id, from_crew_member_id, birthday_date, message)
      VALUES (?, ?, ?, ?)
    `).run(targetCrewId, fromCrewId, birthdayDate, message);
    return r.lastInsertRowid;
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return null;
    throw e;
  }
}

module.exports = {
  localIso,
  todaysBirthdays,
  messagesForBirthday,
  hasMessaged,
  addMessage,
};
