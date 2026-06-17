// lib/auditCrew.js
// Crew-on-site resolution, the crew_member → employee identity bridge, and the
// write-back of per-person audit tags into the HR Reviews tab.

const { createEmployeeReview, updateEmployeeReview } = require('./reviews');

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

/**
 * Workers on site for a job + date. Sourced from crew_allocations (allocated/
 * confirmed) and, if present, the crew_roster scheduling grid; de-duped by
 * crew_member_id. Each row carries the resolved HR employee_id (via
 * employees.linked_crew_member_id) and a `linked` flag for the block-with-
 * prompt fallback. Returns [] when job/date are missing.
 */
function getOnSiteCrew(db, jobId, dateISO) {
  if (!jobId || !dateISO) return [];
  const byCrew = new Map();

  const allocs = db.prepare(`
    SELECT ca.crew_member_id, cm.full_name, ca.role_on_site, e.id AS employee_id
    FROM crew_allocations ca
    JOIN crew_members cm ON cm.id = ca.crew_member_id
    LEFT JOIN employees e ON e.linked_crew_member_id = cm.id
    WHERE ca.job_id = ? AND ca.allocation_date = ? AND ca.status IN ('allocated','confirmed')
    ORDER BY cm.full_name
  `).all(jobId, dateISO);
  for (const r of allocs) {
    byCrew.set(r.crew_member_id, {
      crew_member_id: r.crew_member_id, full_name: r.full_name,
      role_on_site: r.role_on_site || '', employee_id: r.employee_id || null,
      linked: !!r.employee_id, source: 'allocation',
    });
  }

  if (tableExists(db, 'crew_roster')) {
    const roster = db.prepare(`
      SELECT cr.crew_member_id, cm.full_name, cr.role_on_site, e.id AS employee_id
      FROM crew_roster cr
      JOIN crew_members cm ON cm.id = cr.crew_member_id
      LEFT JOIN employees e ON e.linked_crew_member_id = cm.id
      WHERE cr.job_id = ? AND cr.roster_date = ? AND IFNULL(cr.status,'') != 'cancelled'
    `).all(jobId, dateISO);
    for (const r of roster) {
      if (byCrew.has(r.crew_member_id)) continue; // allocation wins
      byCrew.set(r.crew_member_id, {
        crew_member_id: r.crew_member_id, full_name: r.full_name,
        role_on_site: r.role_on_site || '', employee_id: r.employee_id || null,
        linked: !!r.employee_id, source: 'roster',
      });
    }
  }

  return Array.from(byCrew.values());
}

/** Resolve a crew member to their HR employee profile via the bridge. */
function resolveEmployeeForCrew(db, crewMemberId) {
  if (!crewMemberId) return { employeeId: null, linked: false };
  const e = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ? ORDER BY id LIMIT 1').get(crewMemberId);
  return { employeeId: e ? e.id : null, linked: !!e };
}

/** Read-only coverage measurement (run on prod before rollout). */
function linkCoverageReport(db) {
  const activeCrew = db.prepare('SELECT COUNT(*) c FROM crew_members WHERE active = 1').get().c;
  const linked = db.prepare(`SELECT COUNT(*) c FROM crew_members cm WHERE cm.active = 1 AND EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)`).get().c;
  return { activeCrew, linked, unlinked: activeCrew - linked, pct: activeCrew ? Math.round((linked / activeCrew) * 100) : 0 };
}

/**
 * Write each per-person tag into the worker's HR Reviews tab. Idempotent via
 * audit_question_tags.employee_review_id (re-submitting updates the same
 * review). Unlinked workers are skipped with a reason (block-with-prompt).
 */
function syncAuditReviews(db, auditId, userId) {
  const tags = db.prepare('SELECT * FROM audit_question_tags WHERE audit_id = ?').all(auditId);
  let created = 0, updated = 0;
  const skipped = [];
  for (const t of tags) {
    let employeeId = t.employee_id;
    if (!employeeId && t.crew_member_id) {
      employeeId = resolveEmployeeForCrew(db, t.crew_member_id).employeeId;
      if (employeeId) db.prepare('UPDATE audit_question_tags SET employee_id = ? WHERE id = ?').run(employeeId, t.id);
    }
    if (!employeeId) { skipped.push({ tagId: t.id, crewMemberId: t.crew_member_id, name: t.worker_name_snapshot, reason: 'no_hr_profile' }); continue; }

    const title = `Site audit #${auditId} — ${t.question_key}`;
    const summary = `${t.issue || 'Non-compliance noted during site safety audit'} (Risk: ${t.risk_level}). Logged from a site safety audit.`;
    if (t.employee_review_id) {
      try { updateEmployeeReview(db, t.employee_review_id, { title, summary, visibility: t.visibility }); updated++; }
      catch (e) { /* review may have been deleted */ }
    } else {
      const rid = createEmployeeReview(db, { employeeId, kind: 'note', title, summary, visibility: t.visibility, createdById: userId });
      db.prepare('UPDATE audit_question_tags SET employee_review_id = ? WHERE id = ?').run(rid, t.id);
      created++;
    }
  }
  return { created, updated, skipped };
}

module.exports = { getOnSiteCrew, resolveEmployeeForCrew, linkCoverageReport, syncAuditReviews, tableExists };
