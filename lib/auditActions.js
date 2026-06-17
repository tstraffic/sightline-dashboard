// lib/auditActions.js
// Unifies the audit non-conformance flow onto the existing corrective_actions
// table: every site-level "No" and every per-person tag becomes a corrective
// action (source_type='audit'), idempotently keyed by (source_audit_id,
// source_question_key). High-severity un-rectified items can escalate to the
// Incidents module. A central cross-audit register lives at /actions.

const { createIncident, linkCrewToIncident } = require('./incidents');
const { closeTaskFromCa } = require('./correctiveActions');
const { sydneyToday } = require('./sydney');

function riskToPriority(risk) {
  switch ((risk || '').toLowerCase()) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'low': return 'low';
    default: return 'medium';
  }
}

/**
 * Re-derive the audit's corrective actions from its responses + per-person tags.
 * Idempotent: open audit-sourced CAs that no longer have a matching "No"/tag are
 * removed; existing rows are updated in place; closed rows are preserved.
 *
 * @param {object} ctx { responses, questionMeta:{key:{text,is_critical}}, tags:[], jobId, user }
 * @returns {{created,updated,removed,incidentsCreated}}
 */
function syncCorrectiveActionsFromAudit(db, auditId, ctx = {}) {
  const { responses = {}, questionMeta = {}, tags = [], jobId = null, user = null } = ctx;

  // Build the desired set of corrective actions
  const desired = [];
  for (const key of Object.keys(responses)) {
    const r = responses[key] || {};
    if (r.state !== 'no') continue;
    const meta = questionMeta[key] || {};
    desired.push({
      source_question_key: key,
      description: r.corrective_action || r.observation || meta.text || ('Non-conformance: ' + key),
      observation: r.observation || '',
      risk_level: r.risk_level || meta.risk_band || 'Medium',
      involved_employee_id: null,
      involved_crew_member_id: null,
      involved_person_name: r.responsible || '',
      rectified: r.rectified_on_site === true,
      is_critical: !!meta.is_critical,
    });
  }
  for (const t of tags) {
    const meta = questionMeta[t.question_key] || {};
    desired.push({
      source_question_key: t.question_key + '#' + t.crew_member_id,
      description: t.issue || ('Per-person non-conformance: ' + (meta.text || t.question_key)),
      observation: t.issue || '',
      risk_level: t.risk_level || 'Medium',
      involved_employee_id: t.employee_id || null,
      involved_crew_member_id: t.crew_member_id || null,
      involved_person_name: t.worker_name_snapshot || '',
      rectified: false,
      is_critical: !!meta.is_critical,
    });
  }

  const findCA = db.prepare('SELECT id, status FROM corrective_actions WHERE source_audit_id = ? AND source_question_key = ?');
  const insCA = db.prepare(`
    INSERT INTO corrective_actions
      (job_id, description, due_date, status, priority, source_type, source_audit_id, source_question_key,
       involved_employee_id, involved_crew_member_id, involved_person_name, risk_level, observation)
    VALUES (?, ?, NULL, 'open', ?, 'audit', ?, ?, ?, ?, ?, ?, ?)
  `);
  const updCA = db.prepare(`
    UPDATE corrective_actions SET description=?, priority=?, risk_level=?, observation=?,
      involved_employee_id=?, involved_crew_member_id=?, involved_person_name=?, job_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='open'
  `);

  let created = 0, updated = 0, removed = 0;
  const desiredKeys = new Set();
  for (const d of desired) {
    desiredKeys.add(d.source_question_key);
    const priority = riskToPriority(d.risk_level);
    const existing = findCA.get(auditId, d.source_question_key);
    if (!existing) {
      insCA.run(jobId || null, d.description, priority, auditId, d.source_question_key,
        d.involved_employee_id, d.involved_crew_member_id, d.involved_person_name, d.risk_level, d.observation);
      created++;
    } else if (existing.status === 'open') {
      updCA.run(d.description, priority, d.risk_level, d.observation,
        d.involved_employee_id, d.involved_crew_member_id, d.involved_person_name, jobId || null, existing.id);
      updated++;
    }
  }

  // Self-heal: drop open audit CAs whose "No"/tag was removed (question flipped to Yes/N-A)
  const existingRows = db.prepare("SELECT id, source_question_key FROM corrective_actions WHERE source_audit_id = ? AND status = 'open'").all(auditId);
  const delCA = db.prepare('DELETE FROM corrective_actions WHERE id = ?');
  for (const row of existingRows) {
    if (!desiredKeys.has(row.source_question_key)) { delCA.run(row.id); removed++; }
  }

  // Escalate to Incidents: any CRITICAL, un-rectified non-conformance → one
  // incident per audit (idempotent on source_audit_id), if a job is linked.
  let incidentsCreated = 0;
  const criticals = desired.filter(d => (d.risk_level === 'Critical' || d.is_critical) && !d.rectified);
  if (criticals.length && jobId && user) {
    try {
      const involvedCrew = criticals.filter(c => c.involved_crew_member_id)
        .map(c => ({ crew_member_id: c.involved_crew_member_id, involvement_type: 'involved' }));
      const res = createIncident(db, {
        job_id: jobId,
        incident_type: 'hazard',
        severity: 'critical',
        title: 'Critical non-conformance(s) from Site Audit #' + auditId,
        description: criticals.map(c => '• ' + (c.description || c.observation)).join('\n'),
        incident_date: sydneyToday(),
        source_type: 'audit',
        source_audit_id: auditId,
        crewLinks: involvedCrew,
      }, { user });
      if (res && res.created) incidentsCreated = 1;
    } catch (e) { /* incident escalation must never block audit save */ }
  }

  return { created, updated, removed, incidentsCreated };
}

/** Close a corrective action from the central register (cascades to its task). */
function closeAuditAction(db, caId, { closedById = null, verificationNote = '' } = {}) {
  const ca = db.prepare('SELECT id, status FROM corrective_actions WHERE id = ?').get(caId);
  if (!ca) return false;
  db.prepare(`
    UPDATE corrective_actions
    SET status='completed', completed_date=?, closed_at=CURRENT_TIMESTAMP, closed_by_id=?, verification=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(sydneyToday(), closedById, verificationNote || '', caId);
  try { closeTaskFromCa(db, caId, closedById ? { id: closedById } : null); } catch (e) {}
  return true;
}

module.exports = { syncCorrectiveActionsFromAudit, closeAuditAction, riskToPriority };
