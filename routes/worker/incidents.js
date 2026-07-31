const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');
const { stashForm, takeForm } = require('../../lib/formEcho');

// Multer config for incident photo uploads.
// Lives under data/ — the only tree on the persistent volume. public/uploads
// is rebuilt from the image on every deploy, which silently destroyed every
// crew-submitted incident photo and left the DB pointing at nothing.
const INCIDENT_STORED_PREFIX = 'data/uploads/incidents';
const incidentUploadsDir = path.join(__dirname, '..', '..', INCIDENT_STORED_PREFIX);
if (!fs.existsSync(incidentUploadsDir)) fs.mkdirSync(incidentUploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, incidentUploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'incident_' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|heic|heif/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = /image\//i.test(file.mimetype);
    cb(null, ext || mime);
  }
});

// Helper to generate next incident number
function nextIncidentNumber(db) {
  const last = db.prepare("SELECT incident_number FROM incidents ORDER BY id DESC LIMIT 1").get();
  if (!last) return 'INC-00001';
  const num = parseInt(last.incident_number.replace('INC-', '')) + 1;
  return 'INC-' + String(num).padStart(5, '0');
}

// GET /w/incidents — List worker's reported incidents
router.get('/incidents', (req, res) => {
  const db = getDb();
  const crewMemberId = req.session.worker.id; // session stores the crew id as .id (was .crew_member_id — undefined, which broke the whole module)

  const incidents = db.prepare(`
    SELECT i.*, j.job_number, j.client, j.site_address
    FROM incidents i
    JOIN jobs j ON i.job_id = j.id
    JOIN incident_crew_members icm ON icm.incident_id = i.id
    WHERE icm.crew_member_id = ? AND icm.involvement_type = 'reporting'
    ORDER BY i.incident_date DESC, i.created_at DESC
  `).all(crewMemberId);

  res.render('worker/incidents', {
    layout: 'worker/layout',
    title: 'My Incidents',
    currentPage: 'incidents',
    incidents,
    worker: req.session.worker,
  });
});

// GET /w/incidents/new — New incident report form
router.get('/incidents/new', (req, res) => {
  const db = getDb();
  const crewMemberId = req.session.worker.id;

  // Get worker's current/recent allocations for job selector
  const allocations = db.prepare(`
    SELECT DISTINCT j.id as job_id, j.job_number, j.client, j.site_address, j.suburb
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ?
      AND ca.allocation_date >= DATE('now', '-7 days')
      AND j.status IN ('active', 'won', 'prestart')
    ORDER BY ca.allocation_date DESC
  `).all(crewMemberId);

  const today = sydneyToday();
  const now = new Date().toTimeString().slice(0, 5);

  res.render('worker/incident-form', {
    layout: 'worker/layout',
    title: 'Report Incident',
    currentPage: 'incidents',
    allocations,
    today,
    now,
    old: takeForm(req, 'incident'), // repopulate after a validation bounce
    worker: req.session.worker,
  });
});

// POST /w/incidents — Submit incident report
router.post('/incidents', upload.array('photos', 5), (req, res) => {
  const db = getDb();
  const crewMemberId = req.session.worker.id;
  const workerName = req.session.worker.full_name;

  const {
    job_id, incident_type, severity, incident_date, incident_time,
    location, description, weather_conditions, gps_lat, gps_lng
  } = req.body;

  // Validation
  if (!job_id || !incident_type || !description) {
    req.flash('error', 'Please fill in all required fields.');
    stashForm(req, 'incident', req.body);
    return req.session.save(() => res.redirect('/w/incidents/new'));
  }

  const validTypes = ['near_miss', 'traffic_incident', 'worker_injury', 'vehicle_damage', 'public_complaint', 'environmental', 'injury', 'hazard', 'property_damage', 'vehicle', 'other'];
  if (!validTypes.includes(incident_type)) {
    req.flash('error', 'Invalid incident type.');
    stashForm(req, 'incident', req.body);
    return req.session.save(() => res.redirect('/w/incidents/new'));
  }

  const validSeverity = ['low', 'medium', 'high', 'critical'];
  if (!validSeverity.includes(severity)) {
    req.flash('error', 'Invalid severity level.');
    stashForm(req, 'incident', req.body);
    return req.session.save(() => res.redirect('/w/incidents/new'));
  }

  try {
    const incidentNumber = nextIncidentNumber(db);

    // Build photo path (comma-separated — incidents.photo_path holds the list;
    // every reader must split on ',' before using a value as a URL)
    const photoPaths = (req.files || []).map(f => '/' + INCIDENT_STORED_PREFIX + '/' + f.filename);
    const photoPath = photoPaths.join(',');

    // GPS + weather now go to first-class columns (mig 218). Coerce GPS to
    // numbers — only persist if both are present and parse to finite floats;
    // otherwise leave NULL. Weather stays text.
    const gpsLatNum = (gps_lat !== undefined && gps_lat !== '') ? parseFloat(gps_lat) : null;
    const gpsLngNum = (gps_lng !== undefined && gps_lng !== '') ? parseFloat(gps_lng) : null;
    const gpsValid = Number.isFinite(gpsLatNum) && Number.isFinite(gpsLngNum);
    const weather = (weather_conditions || '').toString().trim();

    // Use admin user id=1 as reported_by_id (FK constraint requires users reference)
    // The actual crew member is linked via incident_crew_members
    const adminUser = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get();
    const reportedById = adminUser ? adminUser.id : 1;

    const title = `${incident_type.replace(/_/g, ' ')} - reported by ${workerName}`.substring(0, 200);

    const result = db.prepare(`
      INSERT INTO incidents (
        job_id, incident_number, incident_type, severity, title, description,
        location, incident_date, incident_time, reported_by_id,
        weather_conditions, gps_lat, gps_lng,
        investigation_status, photo_path, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reported', ?, CURRENT_TIMESTAMP)
    `).run(
      job_id, incidentNumber, incident_type, severity, title, description,
      location || '', incident_date || sydneyToday(),
      incident_time || '', reportedById,
      weather, gpsValid ? gpsLatNum : null, gpsValid ? gpsLngNum : null,
      photoPath
    );

    // Link the reporting crew member
    if (result.lastInsertRowid) {
      db.prepare(`
        INSERT INTO incident_crew_members (incident_id, crew_member_id, involvement_type, notes)
        VALUES (?, ?, 'reporting', ?)
      `).run(result.lastInsertRowid, crewMemberId, `Reported via Worker Portal by ${workerName}`);
    }

    req.flash('success', `Incident ${incidentNumber} reported successfully.`);
    req.session.save(() => res.redirect('/w/incidents'));
  } catch (err) {
    console.error('Worker incident submission error:', err);
    req.flash('error', 'Failed to submit incident report. Please try again.');
    stashForm(req, 'incident', req.body);
    req.session.save(() => res.redirect('/w/incidents/new'));
  }
});

// GET /w/incidents/:id — View incident detail
router.get('/incidents/:id', (req, res) => {
  const db = getDb();
  const crewMemberId = req.session.worker.id;

  // Verify the worker reported this incident
  const incident = db.prepare(`
    SELECT i.*, j.job_number, j.client, j.site_address, j.suburb,
      u.full_name as reported_by_name
    FROM incidents i
    JOIN jobs j ON i.job_id = j.id
    JOIN users u ON i.reported_by_id = u.id
    JOIN incident_crew_members icm ON icm.incident_id = i.id
    WHERE i.id = ? AND icm.crew_member_id = ? AND icm.involvement_type = 'reporting'
  `).get(req.params.id, crewMemberId);

  if (!incident) {
    req.flash('error', 'Incident not found.');
    return req.session.save(() => res.redirect('/w/incidents'));
  }

  // Get corrective actions if any
  const correctiveActions = db.prepare(`
    SELECT ca.*, u.full_name as assigned_to_name
    FROM corrective_actions ca
    LEFT JOIN users u ON ca.assigned_to_id = u.id
    WHERE ca.incident_id = ?
    ORDER BY ca.due_date ASC
  `).all(incident.id);

  res.render('worker/incident-detail', {
    layout: 'worker/layout',
    title: `Incident ${incident.incident_number}`,
    currentPage: 'incidents',
    incident,
    correctiveActions,
    worker: req.session.worker,
  });
});

module.exports = router;
