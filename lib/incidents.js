// lib/incidents.js
// Reusable incident creation, extracted from the inline POST handler in
// routes/incidents.js so the safety-audit module can escalate high-risk
// non-conformances into the Incidents module through one shared path.
//
// The source_type / source_audit_id handling is fully guarded: it only runs
// once those columns exist on the incidents table (added in the audit-redesign
// schema migrations). Until then this behaves exactly like the original route.

const { ensureThreadForEntity, addMembersToThread, postSystemMessage } = require('./chat');
const { logActivity } = require('../middleware/audit');

function nextIncidentNumber(db) {
  const last = db.prepare('SELECT incident_number FROM incidents ORDER BY id DESC LIMIT 1').get();
  if (!last) return 'INC-00001';
  const num = parseInt(last.incident_number.replace('INC-', '')) + 1;
  return 'INC-' + String(num).padStart(5, '0');
}

/**
 * Link crew members to an incident. crewLinks = [{ crew_member_id, involvement_type }].
 */
function linkCrewToIncident(db, incidentId, crewLinks = []) {
  const insertCrew = db.prepare(
    'INSERT OR IGNORE INTO incident_crew_members (incident_id, crew_member_id, involvement_type) VALUES (?, ?, ?)'
  );
  for (const link of crewLinks) {
    if (link && link.crew_member_id) {
      insertCrew.run(incidentId, parseInt(link.crew_member_id), link.involvement_type || 'involved');
    }
  }
}

/**
 * Create an incident. Returns { id, incident_number, created }.
 * When payload.source_type === 'audit' and an incident already exists for the
 * same source_audit_id, returns the existing one with created=false (so a
 * re-submitted/edited audit never spawns duplicates).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} payload incident fields + optional crewLinks + source_type/source_audit_id
 * @param {{user?: object, ip?: string}} ctx
 */
function createIncident(db, payload = {}, ctx = {}) {
  const { user, ip } = ctx;
  const incidentCols = new Set(db.prepare("PRAGMA table_info('incidents')").all().map((c) => c.name));
  const hasSourceCols = incidentCols.has('source_type') && incidentCols.has('source_audit_id');

  // Idempotency: one incident per source audit
  if (hasSourceCols && payload.source_type === 'audit' && payload.source_audit_id) {
    const existing = db.prepare('SELECT id, incident_number FROM incidents WHERE source_audit_id = ?')
      .get(payload.source_audit_id);
    if (existing) return { id: existing.id, incident_number: existing.incident_number, created: false };
  }

  const incident_number = nextIncidentNumber(db);
  const job = payload.job_id ? db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(payload.job_id) : null;

  const result = db.prepare(`
    INSERT INTO incidents (job_id, incident_number, incident_type, severity, title, description, location, incident_date, incident_time, reported_by_id, persons_involved, witnesses, immediate_actions, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date, photo_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    payload.job_id, incident_number, payload.incident_type, payload.severity || 'low',
    payload.title, payload.description, payload.location || '', payload.incident_date, payload.incident_time || '',
    user ? user.id : null, payload.persons_involved || '', payload.witnesses || '', payload.immediate_actions || '',
    payload.notifiable_incident ? 1 : 0, payload.traffic_disruption ? 1 : 0, payload.police_notified ? 1 : 0,
    payload.client_notified ? 1 : 0, payload.close_out_date || null, payload.photo_path || ''
  );

  const incidentId = result.lastInsertRowid;

  if (hasSourceCols && payload.source_type) {
    db.prepare('UPDATE incidents SET source_type = ?, source_audit_id = ? WHERE id = ?')
      .run(payload.source_type, payload.source_audit_id || null, incidentId);
  }

  linkCrewToIncident(db, incidentId, payload.crewLinks || []);

  if (user) {
    logActivity({
      user, action: 'create', entityType: 'incident', entityId: incidentId,
      entityLabel: `${incident_number} - ${payload.title}`,
      jobId: payload.job_id ? parseInt(payload.job_id) : null,
      jobNumber: job ? job.job_number : '',
      details: `Severity: ${payload.severity}, Type: ${payload.incident_type}`, ip,
    });

    // Auto-create chat thread for this incident
    const threadId = ensureThreadForEntity('incident', incidentId, `Incident ${incident_number}`, user.id);
    const jobDetails = payload.job_id
      ? db.prepare('SELECT project_manager_id, ops_supervisor_id FROM jobs WHERE id = ?').get(payload.job_id)
      : null;
    const memberIds = [...new Set([
      user.id,
      jobDetails ? jobDetails.project_manager_id : null,
      jobDetails ? jobDetails.ops_supervisor_id : null,
    ].filter(Boolean))];
    addMembersToThread(threadId, memberIds, 'member', true);
    postSystemMessage(threadId, `Incident ${incident_number} reported — ${payload.severity} severity`);
  }

  return { id: incidentId, incident_number, created: true };
}

module.exports = { createIncident, linkCrewToIncident, nextIncidentNumber };
