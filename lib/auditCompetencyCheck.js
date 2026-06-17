// lib/auditCompetencyCheck.js
// Cross-checks on-site crew against their HR competency records so the audit
// can surface ticket currency from the roster instead of re-asking it.
// An expired/missing MANDATORY competency flags the worker on the audit form.

const { refreshCompetencyStatuses } = require('./competency');

/**
 * Decorate each on-site crew row (from getOnSiteCrew) with ticket currency:
 *   c.ticketExpired  — true if a mandatory competency is expired/missing
 *   c.ticketWarning  — human summary of the offending competencies
 * Crew without a resolved HR employee are left undecorated (can't verify).
 */
function decorateCrewCompetency(db, crew) {
  const stmt = db.prepare(
    "SELECT competency_name, status FROM employee_competencies WHERE employee_id = ? AND mandatory_for_role = 1 AND status IN ('expired','missing')"
  );
  for (const c of crew || []) {
    c.ticketExpired = false;
    c.ticketWarning = '';
    if (!c.employee_id) continue;
    try {
      refreshCompetencyStatuses(db, c.employee_id);
      const bad = stmt.all(c.employee_id);
      if (bad.length) {
        c.ticketExpired = true;
        c.ticketWarning = bad.map(b => `${b.competency_name} (${b.status})`).join(', ');
      }
    } catch (e) { /* leave undecorated on error */ }
  }
  return crew;
}

module.exports = { decorateCrewCompetency };
