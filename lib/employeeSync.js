// lib/employeeSync.js
// Keeps the two crew tables in step: employees (the HR roster — the source
// of truth for every headcount and picker) and crew_members (the operational
// table booking_crew points at). Migration 333 reconciled the historical
// drift (active crew rows with no live roster record); these helpers stop it
// re-opening — every path that mints a crew_members row must also put the
// person on the roster via ensureRosterRecord, and every deactivation path
// mirrors across (see routes/hr.js roster delete/restore and routes/crew.js
// deactivate for the existing two-way cascade).

'use strict';

// Allocate a unique EMP-XXX code based on the largest numeric suffix across
// BOTH crew_members.employee_id AND employees.employee_code (ignoring
// non-numeric codes like EMP-TEST), so a code already used by an unlinked
// employee record can't be reissued (which would collide on the employees
// insert). Single canonical copy — routes/induction-admin.js and
// lib/seekApplicantConverter.js import this rather than keeping their own.
function allocateEmployeeId(db) {
  const rows = db.prepare(`
    SELECT employee_id AS code FROM crew_members WHERE employee_id LIKE 'EMP-%'
    UNION ALL
    SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP-%'
  `).all();
  let maxNum = 0;
  for (const r of rows) {
    const suffix = (r.code || '').replace(/^EMP-/, '');
    if (/^\d+$/.test(suffix)) {
      const n = parseInt(suffix, 10);
      if (n > maxNum) maxNum = n;
    }
  }
  const checkCrew = db.prepare('SELECT 1 FROM crew_members WHERE employee_id = ?');
  const checkEmp = db.prepare('SELECT 1 FROM employees WHERE employee_code = ?');
  for (let tries = 0; tries < 1000; tries++) {
    const candidate = `EMP-${String(maxNum + 1 + tries).padStart(3, '0')}`;
    if (!checkCrew.get(candidate) && !checkEmp.get(candidate)) return candidate;
  }
  throw new Error('Could not allocate a free employee_id after 1000 attempts');
}

function splitName(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// crew_members.employment_type vocabulary ('employee'/'subcontractor') →
// employees vocabulary ('full_time'/'casual'/'subcontractor').
function mapEmploymentType(t) {
  return t === 'subcontractor' ? 'subcontractor' : 'casual';
}

// Ensure a live roster (employees) row links this crew member, creating a
// minimal one from the crew row's own fields when none exists. No-op (returns
// null) when the crew member is already on the roster or doesn't exist.
// `note` lands in internal_notes so HR can see where the record came from.
function ensureRosterRecord(db, crewMemberId, note) {
  const existing = db.prepare(
    'SELECT id FROM employees WHERE linked_crew_member_id = ? AND deleted_at IS NULL'
  ).get(crewMemberId);
  if (existing) return null;
  const cm = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(crewMemberId);
  if (!cm) return null;

  const { firstName, lastName } = splitName(cm.full_name);
  // Reuse the crew row's EMP code when it's free on the employees side;
  // otherwise mint a fresh one (null if allocation is impossible — the
  // column is nullable).
  let code = cm.employee_id || null;
  if (!code || db.prepare('SELECT 1 FROM employees WHERE employee_code = ?').get(code)) {
    try { code = allocateEmployeeId(db); } catch (e) { code = null; }
  }

  const r = db.prepare(`
    INSERT INTO employees (employee_code, first_name, last_name, full_name, company,
      employment_type, employment_status, payment_type, start_date, email, phone,
      allocatable, active, linked_crew_member_id, internal_notes)
    VALUES (?, ?, ?, ?, ?, ?, 'active', '', date('now'), ?, ?, 1, 1, ?, ?)
  `).run(
    code, firstName, lastName, cm.full_name, cm.company || '',
    mapEmploymentType(cm.employment_type), cm.email || '', cm.phone || '',
    crewMemberId,
    note || 'Auto-created so this crew member appears on the HR roster.'
  );
  return r.lastInsertRowid;
}

module.exports = { allocateEmployeeId, ensureRosterRecord, splitName };
