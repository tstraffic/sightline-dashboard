// lib/competency.js
// Worker readiness + competency-status helpers, extracted verbatim from
// routes/hr.js so the safety-audit ticket-currency check shares one source.

// Recompute an employee's competency statuses from expiry dates.
function refreshCompetencyStatuses(db, employeeId) {
  db.prepare(`UPDATE employee_competencies SET status = 'expired' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date < DATE('now') AND status != 'suspended'`).run(employeeId);
  db.prepare(`UPDATE employee_competencies SET status = 'expiring_soon' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date >= DATE('now') AND expiry_date <= DATE('now', '+30 days') AND status NOT IN ('expired','suspended','missing')`).run(employeeId);
  db.prepare(`UPDATE employee_competencies SET status = 'valid' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date > DATE('now', '+30 days') AND status NOT IN ('suspended','missing')`).run(employeeId);
}

// Overall readiness from employment status + mandatory competencies/documents.
function computeReadiness(employee, competencies, documents) {
  if (employee.employment_status === 'offboarded') return { status: 'offboarded', color: 'gray' };
  if (employee.employment_status === 'on_leave') return { status: 'on_leave', color: 'blue' };
  if (employee.employment_status === 'onboarding') return { status: 'onboarding', color: 'purple' };
  if (employee.employment_status === 'suspended') return { status: 'blocked', color: 'red' };
  if (employee.blocked_from_allocation) return { status: 'blocked', color: 'red' };

  const expiredMandatory = (competencies || []).filter(c => c.mandatory_for_role && (c.status === 'expired' || c.status === 'missing'));
  const missingMandatoryDocs = (documents || []).filter(d => d.mandatory && d.verification_status !== 'verified');

  if (expiredMandatory.length > 0 || missingMandatoryDocs.length > 0) return { status: 'non_compliant', color: 'red' };

  const expiringSoon = (competencies || []).filter(c => c.status === 'expiring_soon');
  if (expiringSoon.length > 0) return { status: 'ready_with_warnings', color: 'amber' };

  return { status: 'ready', color: 'green' };
}

module.exports = { refreshCompetencyStatuses, computeReadiness };
