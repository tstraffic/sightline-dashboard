// Convert a row from the Recruitment tab (seek_applicants) into a crew_member +
// employee record so the worker shows up on the roster.
//
// Mirrors the create-crew-member step in routes/induction-admin.js' approval
// flow, but sourced from the much thinner Seek applicant fields
// (name + phone + email + induction_date). Everything else gets sensible
// defaults that admin can fill in later on the crew profile.
//
// Idempotency: callers should skip applicants whose linked_crew_member_id is
// already set. As a belt-and-braces guard this function also writes the link
// back to seek_applicants before returning.

const { findExistingCrew } = require('./crewDedup');

// Canonical copies live in lib/employeeSync — this converter's old local
// allocator only scanned crew_members, so it could reissue a code already
// held by an unlinked employees row; the shared one scans both tables.
const { allocateEmployeeId, splitName } = require('./employeeSync');

// Returns { crewMemberId, employeeId, employeeCode } on success. Throws on
// failure so the caller (route handler or migration) can decide whether to
// surface or log it.
function convertSeekApplicantToCrew(db, applicant) {
  const fullName = (applicant.applicant_name || '').trim();
  if (!fullName) throw new Error('Applicant has no name');

  // Dedup — if this email or phone already exists on the roster, re-link
  // rather than mint a duplicate. Uses the shared matcher (last-9-digit phone
  // normalisation) so this and the induction-approval path can't drift apart.
  const matched = findExistingCrew(db, { email: applicant.email, phone: applicant.phone, fullName: applicant.applicant_name });
  if (matched) {
    db.prepare('UPDATE seek_applicants SET linked_crew_member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(matched.id, applicant.id);
    return { crewMemberId: matched.id, employeeCode: matched.employee_id, matched: true };
  }

  const employeeCode = allocateEmployeeId(db);
  const { firstName, lastName } = splitName(fullName);
  const startDate = applicant.induction_date || new Date().toISOString().slice(0, 10);

  // 1. crew_members — the roster reads from here (WHERE active = 1).
  const crewResult = db.prepare(`
    INSERT INTO crew_members (full_name, employee_id, role, phone, email, company, employment_type,
      induction_date, induction_status, active, status)
    VALUES (?, ?, 'traffic_controller', ?, ?, 'T&S Traffic Control', 'casual',
      ?, ?, 1, 'active')
  `).run(
    fullName, employeeCode,
    applicant.phone || '', applicant.email || '',
    startDate,
    applicant.induction_date ? 'completed' : 'pending'
  );
  const crewMemberId = crewResult.lastInsertRowid;

  // 2. employees — HR record, linked back to crew_member.
  db.prepare(`
    INSERT INTO employees (employee_code, first_name, last_name, full_name,
      company, employment_type, employment_status, start_date,
      email, phone, induction_status, allocatable, active,
      linked_crew_member_id, internal_notes)
    VALUES (?, ?, ?, ?,
      'T&S Traffic Control', 'casual', 'active', ?,
      ?, ?, ?, 1, 1,
      ?, ?)
  `).run(
    employeeCode, firstName, lastName || firstName, fullName,
    startDate,
    applicant.email || '', applicant.phone || '',
    applicant.induction_date ? 'completed' : 'pending',
    crewMemberId,
    `Auto-created from Recruitment applicant #${applicant.id} on status=Hired.`
  );

  // 3. Link back so re-saves are idempotent.
  db.prepare(`
    UPDATE seek_applicants SET linked_crew_member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(crewMemberId, applicant.id);

  return { crewMemberId, employeeCode };
}

module.exports = { convertSeekApplicantToCrew };
