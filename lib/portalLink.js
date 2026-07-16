// Bridge between the office (admin) session and the worker portal.
//
// An admin whose employee record links both a user account and a crew
// profile can enter the worker portal without a PIN. The worker session is
// set ALONGSIDE the admin one — the two portals stay separate: each has its
// own sign-out, and leaving one never signs you out of the other.
const { getDb } = require('../db/database');

/**
 * Resolve the crew_member linked to an admin user via the employee record
 * (employees.linked_user_id → linked_crew_member_id). Returns null when the
 * account has no active roster profile.
 */
function resolveLinkedCrew(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id, cm.role, cm.phone, cm.email
    FROM employees e JOIN crew_members cm ON cm.id = e.linked_crew_member_id
    WHERE e.linked_user_id = ? AND e.deleted_at IS NULL AND cm.active = 1
    ORDER BY e.id DESC LIMIT 1
  `).get(userId) || null;
}

/**
 * Start a worker session for the given crew row — same shape as a PIN login.
 * Caller is responsible for req.session.save() before redirecting.
 */
function startWorkerSession(req, crew) {
  req.session.worker = {
    id: crew.id,
    full_name: crew.full_name,
    employee_id: crew.employee_id,
    role: crew.role,
    phone: crew.phone,
    email: crew.email,
  };
  try {
    getDb().prepare('UPDATE crew_members SET last_worker_login = CURRENT_TIMESTAMP, worker_login_count = COALESCE(worker_login_count, 0) + 1 WHERE id = ?').run(crew.id);
  } catch (e) { /* non-fatal */ }
}

module.exports = { resolveLinkedCrew, startWorkerSession };
