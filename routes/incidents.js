const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const upload = require('../middleware/upload');
const { ensureThreadForEntity, addMembersToThread, postSystemMessage, getThreadForEntity } = require('../lib/chat');
const { createLinkedTask, closeTaskFromCa } = require('../lib/correctiveActions');
const { sydneyToday } = require('../lib/sydney');

// Helper to generate next incident number
function nextIncidentNumber(db) {
  const last = db.prepare("SELECT incident_number FROM incidents ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'INC-00001';
  const num = parseInt(last.incident_number.replace('INC-', '')) + 1;
  return 'INC-' + String(num).padStart(5, '0');
}

// Fleet vehicles for the incident's "vehicle involved" picker. Labelled by
// ASSET NAME (asset_id) first — never just the make/model — with make/model +
// rego as secondary detail. Retired vehicles included last so an incident can
// still reference a since-retired vehicle. Guarded for legacy DBs w/o fleet.
function incidentVehicleList(db) {
  try {
    return db.prepare(`
      SELECT id, asset_id, rego,
             NULLIF(TRIM(COALESCE(make,'') || ' ' || COALESCE(model,'')), '') AS model_label,
             status
      FROM vehicles
      ORDER BY CASE WHEN status = 'Retired' THEN 1 ELSE 0 END, asset_id
    `).all();
  } catch (e) { return []; }
}

// LIST
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];

  if (req.query.job_id) { where.push('i.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.incident_type) { where.push('i.incident_type = ?'); params.push(req.query.incident_type); }
  if (req.query.severity) { where.push('i.severity = ?'); params.push(req.query.severity); }
  if (req.query.status) { where.push('i.investigation_status = ?'); params.push(req.query.status); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  // Sorting
  const allowedSorts = { 'incident_date': 'i.incident_date', 'severity': 'i.severity', 'investigation_status': 'i.investigation_status', 'title': 'i.title' };
  const sort = allowedSorts[req.query.sort] ? req.query.sort : 'incident_date';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const orderByCol = allowedSorts[sort] || 'i.incident_date';

  // LEFT JOIN jobs — job is now optional, so an incident with no job must
  // still appear (an inner join silently dropped them).
  const incidents = db.prepare(`
    SELECT i.*, j.job_number, j.client, u.full_name as reported_by_name,
      veh.asset_id AS vehicle_asset,
      (SELECT COUNT(*) FROM corrective_actions ca WHERE ca.incident_id = i.id) as corrective_action_count,
      (SELECT COUNT(*) FROM corrective_actions ca2 WHERE ca2.incident_id = i.id AND ca2.status != 'completed') as open_actions
    FROM incidents i
    LEFT JOIN jobs j ON i.job_id = j.id
    LEFT JOIN vehicles veh ON i.vehicle_id = veh.id
    JOIN users u ON i.reported_by_id = u.id
    ${whereClause}
    ORDER BY ${orderByCol} ${order}
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs ORDER BY job_number DESC").all();

  const today = new Date().toISOString().split('T')[0];

  // Compute stats
  const allIncidents = db.prepare('SELECT severity, investigation_status, incident_date, close_out_date FROM incidents').all();
  const openActions = db.prepare("SELECT COUNT(*) as count FROM corrective_actions WHERE status != 'completed'").get().count;
  const stats = {
    total: allIncidents.length,
    open: allIncidents.filter(i => ['reported', 'investigating'].includes(i.investigation_status)).length,
    critical: allIncidents.filter(i => ['critical', 'high'].includes(i.severity) && ['reported', 'investigating'].includes(i.investigation_status)).length,
    thisMonth: allIncidents.filter(i => i.incident_date && i.incident_date >= new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0]).length,
    openActions,
  };

  res.render('incidents/index', {
    title: 'Safety & Incidents',
    currentPage: 'incidents',
    incidents,
    jobs,
    filters: req.query,
    stats,
    today,
    sort,
    order: order.toLowerCase(),
  });
});

// Inline status change
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const valid = ['reported', 'investigating', 'resolved', 'closed'];
  if (!valid.includes(status)) { req.flash('error', 'Invalid status'); return res.redirect('/incidents'); }
  db.prepare('UPDATE incidents SET investigation_status = ? WHERE id = ?').run(status, req.params.id);
  res.redirect('/incidents');
});

// NEW FORM
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs ORDER BY job_number DESC").all();
  const crewMembers = db.prepare("SELECT id, full_name, role FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  const vehicles = incidentVehicleList(db);
  res.render('incidents/form', {
    title: 'Report Incident',
    currentPage: 'incidents',
    incident: null,
    jobs,
    crewMembers,
    vehicles,
    linkedCrew: [],
    preselectedJobId: req.query.job_id || ''
  });
});

// CREATE
router.post('/', upload.single('photo'), (req, res) => {
  const db = getDb();
  const { incident_type, severity, title, description, location, incident_date, incident_time, persons_involved, witnesses, immediate_actions, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date } = req.body;
  // Job is optional now. Empty string → NULL (an incident can be logged before
  // it's tied to a job, or for something with no job at all).
  const jobId = req.body.job_id ? parseInt(req.body.job_id, 10) || null : null;
  const vehicleId = req.body.vehicle_id ? parseInt(req.body.vehicle_id, 10) || null : null;
  const incident_number = nextIncidentNumber(db);
  const job = jobId ? db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(jobId) : null;
  const photo_path = req.file ? '/uploads/' + req.file.filename : '';

  const result = db.prepare(`
    INSERT INTO incidents (job_id, vehicle_id, incident_number, incident_type, severity, title, description, location, incident_date, incident_time, reported_by_id, persons_involved, witnesses, immediate_actions, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date, photo_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(jobId, vehicleId, incident_number, incident_type, severity || 'low', title, description, location || '', incident_date, incident_time || '', req.session.user.id, persons_involved || '', witnesses || '', immediate_actions || '', notifiable_incident ? 1 : 0, traffic_disruption ? 1 : 0, police_notified ? 1 : 0, client_notified ? 1 : 0, close_out_date || null, photo_path);

  const incidentId = result.lastInsertRowid;

  // Save linked crew members
  const crewIds = Array.isArray(req.body.crew_member_ids) ? req.body.crew_member_ids : (req.body.crew_member_ids ? [req.body.crew_member_ids] : []);
  const crewTypes = Array.isArray(req.body.crew_involvement_types) ? req.body.crew_involvement_types : (req.body.crew_involvement_types ? [req.body.crew_involvement_types] : []);
  const insertCrew = db.prepare('INSERT OR IGNORE INTO incident_crew_members (incident_id, crew_member_id, involvement_type) VALUES (?, ?, ?)');
  for (let i = 0; i < crewIds.length; i++) {
    if (crewIds[i]) {
      insertCrew.run(incidentId, parseInt(crewIds[i]), crewTypes[i] || 'involved');
    }
  }

  logActivity({ user: req.session.user, action: 'create', entityType: 'incident', entityId: incidentId, entityLabel: `${incident_number} - ${title}`, jobId: jobId || null, jobNumber: job ? job.job_number : '', details: `Severity: ${severity}, Type: ${incident_type}`, ip: req.ip });

  // Auto-create chat thread for this incident
  const threadId = ensureThreadForEntity('incident', incidentId, `Incident ${incident_number}`, req.session.user.id);
  const jobDetails = jobId ? db.prepare('SELECT project_manager_id, ops_supervisor_id FROM jobs WHERE id = ?').get(jobId) : null;
  const memberIds = [...new Set([req.session.user.id,
    jobDetails ? jobDetails.project_manager_id : null,
    jobDetails ? jobDetails.ops_supervisor_id : null
  ].filter(Boolean))];
  addMembersToThread(threadId, memberIds, 'member', true);
  postSystemMessage(threadId, `Incident ${incident_number} reported — ${severity} severity`);

  req.flash('success', `Incident ${incident_number} reported successfully.`);
  res.redirect(`/incidents/${incidentId}`);
});

// SHOW
router.get('/:id', (req, res) => {
  const db = getDb();
  const incident = db.prepare(`
    SELECT i.*, j.job_number, j.client, u.full_name as reported_by_name,
      veh.asset_id AS vehicle_asset, veh.rego AS vehicle_rego,
      NULLIF(TRIM(COALESCE(veh.make,'') || ' ' || COALESCE(veh.model,'')), '') AS vehicle_model
    FROM incidents i
    LEFT JOIN jobs j ON i.job_id = j.id
    LEFT JOIN vehicles veh ON i.vehicle_id = veh.id
    JOIN users u ON i.reported_by_id = u.id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!incident) {
    req.flash('error', 'Incident not found.');
    return res.redirect('/incidents');
  }

  const correctiveActions = db.prepare(`
    SELECT ca.*, u.full_name as assigned_to_name
    FROM corrective_actions ca
    LEFT JOIN users u ON ca.assigned_to_id = u.id
    WHERE ca.incident_id = ?
    ORDER BY ca.due_date ASC
  `).all(req.params.id);

  const linkedCrew = db.prepare(`
    SELECT icm.*, cm.full_name, cm.role, cm.employee_id
    FROM incident_crew_members icm
    JOIN crew_members cm ON icm.crew_member_id = cm.id
    WHERE icm.incident_id = ?
    ORDER BY cm.full_name
  `).all(req.params.id);

  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'incident' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(req.params.id);

  // Lazy-create chat thread for pre-existing incidents
  let chatThreadId = getThreadForEntity('incident', incident.id);
  if (!chatThreadId) {
    chatThreadId = ensureThreadForEntity('incident', incident.id, `Incident ${incident.incident_number}`, req.session.user.id);
    const jobDetails = db.prepare('SELECT project_manager_id, ops_supervisor_id FROM jobs WHERE id = ?').get(incident.job_id);
    const memberIds = [...new Set([req.session.user.id, incident.reported_by_id,
      jobDetails ? jobDetails.project_manager_id : null,
      jobDetails ? jobDetails.ops_supervisor_id : null
    ].filter(Boolean))];
    addMembersToThread(chatThreadId, memberIds, 'member', true);
    postSystemMessage(chatThreadId, `Thread created for incident ${incident.incident_number}`);
  }

  res.render('incidents/show', {
    title: `Incident ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    correctiveActions,
    linkedCrew,
    activities,
    users,
    chatThreadId
  });
});

// EDIT FORM
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) {
    req.flash('error', 'Incident not found.');
    return res.redirect('/incidents');
  }
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs ORDER BY job_number DESC").all();
  const crewMembers = db.prepare("SELECT id, full_name, role FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  const vehicles = incidentVehicleList(db);
  const linkedCrew = db.prepare(`
    SELECT icm.crew_member_id, icm.involvement_type
    FROM incident_crew_members icm
    WHERE icm.incident_id = ?
  `).all(req.params.id);
  res.render('incidents/form', {
    title: `Edit ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    jobs,
    crewMembers,
    vehicles,
    linkedCrew,
    preselectedJobId: ''
  });
});

// UPDATE
router.post('/:id', upload.single('photo'), (req, res) => {
  const db = getDb();
  const { incident_type, severity, title, description, location, incident_date, incident_time, persons_involved, witnesses, immediate_actions, root_cause, investigation_status, notifiable_incident, traffic_disruption, police_notified, client_notified, close_out_date } = req.body;
  const jobId = req.body.job_id ? parseInt(req.body.job_id, 10) || null : null;
  const vehicleId = req.body.vehicle_id ? parseInt(req.body.vehicle_id, 10) || null : null;
  const job = jobId ? db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(jobId) : null;
  const existing = db.prepare('SELECT incident_number, photo_path FROM incidents WHERE id = ?').get(req.params.id);

  // Use new photo if uploaded, otherwise keep existing
  const photo_path = req.file ? '/uploads/' + req.file.filename : (existing ? existing.photo_path : '');

  db.prepare(`
    UPDATE incidents SET job_id=?, vehicle_id=?, incident_type=?, severity=?, title=?, description=?, location=?, incident_date=?, incident_time=?, persons_involved=?, witnesses=?, immediate_actions=?, root_cause=?, investigation_status=?, notifiable_incident=?, traffic_disruption=?, police_notified=?, client_notified=?, close_out_date=?, photo_path=?, updated_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(jobId, vehicleId, incident_type, severity, title, description, location || '', incident_date, incident_time || '', persons_involved || '', witnesses || '', immediate_actions || '', root_cause || '', investigation_status, notifiable_incident ? 1 : 0, traffic_disruption ? 1 : 0, police_notified ? 1 : 0, client_notified ? 1 : 0, close_out_date || null, photo_path, req.params.id);

  // Sync linked crew members: delete existing, re-insert
  db.prepare('DELETE FROM incident_crew_members WHERE incident_id = ?').run(req.params.id);
  const crewIds = Array.isArray(req.body.crew_member_ids) ? req.body.crew_member_ids : (req.body.crew_member_ids ? [req.body.crew_member_ids] : []);
  const crewTypes = Array.isArray(req.body.crew_involvement_types) ? req.body.crew_involvement_types : (req.body.crew_involvement_types ? [req.body.crew_involvement_types] : []);
  const insertCrew = db.prepare('INSERT OR IGNORE INTO incident_crew_members (incident_id, crew_member_id, involvement_type) VALUES (?, ?, ?)');
  for (let i = 0; i < crewIds.length; i++) {
    if (crewIds[i]) {
      insertCrew.run(parseInt(req.params.id), parseInt(crewIds[i]), crewTypes[i] || 'involved');
    }
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'incident', entityId: parseInt(req.params.id), entityLabel: existing ? existing.incident_number : title, jobId: jobId || null, jobNumber: job ? job.job_number : '', ip: req.ip });

  // Archive chat thread when incident is closed
  if (investigation_status === 'closed') {
    const threadId = getThreadForEntity('incident', parseInt(req.params.id));
    if (threadId) {
      db.prepare("UPDATE chat_threads SET status = 'archived' WHERE id = ?").run(threadId);
      postSystemMessage(threadId, 'Thread archived — incident closed');
    }
  }

  req.flash('success', 'Incident updated.');
  res.redirect(`/incidents/${req.params.id}`);
});

// DELETE
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (incident) {
    db.prepare('DELETE FROM incidents WHERE id = ?').run(req.params.id);
    logActivity({ user: req.session.user, action: 'delete', entityType: 'incident', entityId: parseInt(req.params.id), entityLabel: incident.incident_number, jobId: incident.job_id, ip: req.ip });
  }
  req.flash('success', 'Incident deleted.');
  res.redirect('/incidents');
});

// ADD CORRECTIVE ACTION
// Each CA with an assignee spawns a task in the Safety division so the
// assigned user sees it on /tasks. The task id is stored on the CA so
// closing one side later cascades to the other.
router.post('/:id/corrective-actions', (req, res) => {
  const db = getDb();
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) { req.flash('error', 'Incident not found.'); return res.redirect('/incidents'); }

  const { description, assigned_to_id, due_date, priority } = req.body;
  const ownerId = assigned_to_id || null;
  const ca = {
    job_id: incident.job_id,
    description,
    assigned_to_id: ownerId,
    due_date,
    priority: priority || 'medium',
  };

  const taskId = createLinkedTask(db, ca, incident, req.session.user);

  const result = db.prepare(`
    INSERT INTO corrective_actions (incident_id, job_id, description, assigned_to_id, due_date, priority, task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, incident.job_id, description, ownerId, due_date, ca.priority, taskId);

  logActivity({ user: req.session.user, action: 'create', entityType: 'corrective_action', entityId: result.lastInsertRowid, entityLabel: description.substring(0, 60), jobId: incident.job_id, ip: req.ip });

  req.flash('success', taskId ? 'Corrective action added and assigned as a task.' : 'Corrective action added.');
  res.redirect(`/incidents/${req.params.id}`);
});

// COMPLETE CORRECTIVE ACTION — closes the linked task too if any.
router.post('/:id/corrective-actions/:caId/complete', (req, res) => {
  const db = getDb();
  const today = sydneyToday();
  db.prepare(`
    UPDATE corrective_actions SET status='completed', completed_date=?, completion_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(today, req.body.completion_notes || '', req.params.caId);

  const flippedTask = closeTaskFromCa(db, req.params.caId, req.session.user);

  logActivity({ user: req.session.user, action: 'complete', entityType: 'corrective_action', entityId: parseInt(req.params.caId), ip: req.ip });

  req.flash('success', flippedTask ? 'Corrective action completed and linked task closed.' : 'Corrective action completed.');
  res.redirect(`/incidents/${req.params.id}`);
});

// ESCALATE INCIDENT
router.post('/:id/escalate', (req, res) => {
  const db = getDb();
  const { escalation_level } = req.body;
  const allowed = ['standard', 'elevated', 'critical', 'regulator'];
  if (!allowed.includes(escalation_level)) {
    req.flash('error', 'Invalid escalation level.');
    return res.redirect('/incidents/' + req.params.id);
  }

  const incident = db.prepare('SELECT incident_number, job_id, escalation_level as old_level FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) {
    req.flash('error', 'Incident not found.');
    return res.redirect('/incidents');
  }

  db.prepare('UPDATE incidents SET escalation_level = ?, escalated_at = CURRENT_TIMESTAMP, escalated_by_id = ? WHERE id = ?')
    .run(escalation_level, req.session.user.id, req.params.id);

  logActivity({ user: req.session.user, action: 'escalate', entityType: 'incident', entityId: parseInt(req.params.id), entityLabel: `${incident.incident_number} escalation: ${incident.old_level || 'standard'} -> ${escalation_level}`, jobId: incident.job_id, ip: req.ip });

  req.flash('success', `Escalation level updated to ${escalation_level}.`);
  res.redirect('/incidents/' + req.params.id);
});

module.exports = router;
