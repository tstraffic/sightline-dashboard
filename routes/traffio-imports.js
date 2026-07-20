// Traffio reconciliation queue — ambiguous Traffio bookings (those the sync
// couldn't confidently match to a job) land here as `pending`. An ops user
// maps each one to an existing job or creates a new job; on confirm we create
// the local booking + external_ref mapping. Mirrors the induction-submission
// review flow (review proposed data → approve → side-effects create records).

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { upsertBookingFromTraffio, summarizeBooking } = require('../middleware/traffio');
const { getInternalRef } = require('../middleware/integrations');

const PERM = 'traffio_imports';

function parseProposed(row) {
  try { return JSON.parse(row.proposed_json || '{}'); } catch (e) { return {}; }
}

// GET /traffio-imports — queue. The pending tab groups bookings by Traffio project so
// one "Reconcile project" action maps every queued shift of a project at once; pending
// rows without a project_id (and confirmed/discarded/all) stay as a flat per-row list.
router.get('/', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const status = (req.query.status || 'pending').trim(); // pending | confirmed | discarded | all

  let projectGroups = [];
  let ungrouped = [];
  let rows = [];

  if (status === 'pending') {
    projectGroups = db.prepare(`
      SELECT project_id,
        COALESCE(MAX(NULLIF(project_name, '')), '') AS project_name,
        COUNT(*) AS shift_count,
        MIN(event_date) AS first_date,
        MAX(event_date) AS last_date,
        MAX(json_extract(proposed_json, '$.booking_address')) AS sample_address,
        MAX(json_extract(proposed_json, '$.booking_title'))   AS sample_title
      FROM traffio_imports
      WHERE status = 'pending' AND record_type = 'booking'
        AND project_id IS NOT NULL AND project_id != ''
      GROUP BY project_id
      ORDER BY MAX(event_date) IS NULL, MAX(event_date) DESC
      LIMIT 300
    `).all();
    ungrouped = db.prepare(`
      SELECT ti.* FROM traffio_imports ti
      WHERE ti.status = 'pending' AND (ti.project_id IS NULL OR ti.project_id = '')
      ORDER BY ti.event_date IS NULL, ti.event_date DESC, ti.created_at DESC
      LIMIT 200
    `).all();
  } else {
    const where = ['1=1'];
    const params = [];
    if (status !== 'all') { where.push('ti.status = ?'); params.push(status); }
    rows = db.prepare(`
      SELECT ti.*, mj.job_number AS matched_job_number, cj.job_number AS created_job_number,
        u.full_name AS reviewer_name
      FROM traffio_imports ti
      LEFT JOIN jobs mj ON mj.id = ti.matched_job_id
      LEFT JOIN jobs cj ON cj.id = ti.created_job_id
      LEFT JOIN users u ON u.id = ti.reviewed_by_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE ti.status WHEN 'pending' THEN 0 ELSE 1 END,
               ti.event_date IS NULL, ti.event_date DESC, ti.created_at DESC
      LIMIT 300
    `).all(...params);
  }

  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM traffio_imports WHERE status='pending'").get().c,
    confirmed: db.prepare("SELECT COUNT(*) AS c FROM traffio_imports WHERE status='confirmed'").get().c,
    discarded: db.prepare("SELECT COUNT(*) AS c FROM traffio_imports WHERE status='discarded'").get().c,
  };
  const projectCount = db.prepare(`
    SELECT COUNT(DISTINCT project_id) AS c FROM traffio_imports
    WHERE status='pending' AND project_id IS NOT NULL AND project_id != ''
  `).get().c;

  res.render('traffio-imports/index', {
    title: 'Traffio Reconciliation', rows, projectGroups, ungrouped, counts, status, projectCount,
  });
});

// GET /traffio-imports/project/:projectId — review all pending shifts of one Traffio
// project + pick a single job to map them all to. (Registered before /:id.)
router.get('/project/:projectId', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const projectId = String(req.params.projectId);
  const shifts = db.prepare(`
    SELECT * FROM traffio_imports
    WHERE status = 'pending' AND project_id = ?
    ORDER BY event_date IS NULL, event_date ASC
  `).all(projectId);
  if (!shifts.length) {
    req.flash('error', 'No pending shifts for that project.');
    return req.session.save(() => res.redirect('/traffio-imports'));
  }
  let first = {};
  try { first = JSON.parse(shifts[0].proposed_json || '{}'); } catch (e) { first = {}; }
  const named = shifts.find(s => s.project_name);
  const projectName = (named && named.project_name) || first.project_name || first.project_title || '';

  const jobs = db.prepare(`
    SELECT id, job_number, job_name, client, suburb, start_date FROM jobs
    WHERE status NOT IN ('closed','completed')
    ORDER BY job_number DESC LIMIT 500
  `).all();

  // If this project was reconciled before, suggest the job it mapped to.
  let suggestedJob = null;
  const ref = getInternalRef('traffio', 'job', projectId);
  if (ref) suggestedJob = db.prepare('SELECT id, job_number, job_name, client, suburb, start_date FROM jobs WHERE id = ?').get(ref.internal_id);

  res.render('traffio-imports/project', {
    title: 'Reconcile project', projectId, projectName, shifts, jobs, first, suggestedJob,
  });
});

// POST /traffio-imports/project/:projectId/confirm — map every pending shift of the
// project to one job (existing or newly created) in a single transaction.
router.post('/project/:projectId/confirm', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const projectId = String(req.params.projectId);
  const mode = req.body.mode === 'new' ? 'new' : 'existing';
  const shifts = db.prepare(`
    SELECT * FROM traffio_imports WHERE status = 'pending' AND project_id = ?
    ORDER BY event_date IS NULL, event_date ASC
  `).all(projectId);
  if (!shifts.length) {
    req.flash('error', 'No pending shifts left for that project.');
    return req.session.save(() => res.redirect('/traffio-imports'));
  }

  let done = 0;
  try {
    const tx = db.transaction(() => {
      let jobId;
      let createdJobId = null;

      if (mode === 'existing') {
        jobId = Number(req.body.job_id);
        if (!jobId || !db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId)) {
          throw new Error('Pick a valid job to map to.');
        }
      } else {
        const jobName = (req.body.job_name || '').trim();
        const client = (req.body.client || '').trim();
        if (!jobName || !client) throw new Error('New job needs a name and client.');
        let first = {};
        try { first = JSON.parse(shifts[0].proposed_json || '{}'); } catch (e) { first = {}; }
        const startDate = (first.booking_start_time || first.date || first.start_datetime || first.starts_at || '')
          .toString().slice(0, 10) || new Date().toISOString().slice(0, 10);
        const jobNumber = (req.body.job_number || '').trim() || `TRF-P-${projectId}`;
        const result = db.prepare(`
          INSERT INTO jobs (job_number, job_name, client, site_address, suburb, status, stage, start_date, client_project_number)
          VALUES (?, ?, ?, ?, ?, 'active', 'delivery', ?, ?)
        `).run(
          jobNumber, jobName, client,
          (first.booking_address || first.site_address || first.address || '').toString(),
          (first.suburb || '').toString(),
          startDate,
          (first.job_reference || first.reference || '').toString()
        );
        jobId = result.lastInsertRowid;
        createdJobId = jobId;
      }

      const upd = db.prepare(`
        UPDATE traffio_imports
        SET matched_job_id = ?, created_job_id = ?, reviewed_by_id = ?,
            reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `);
      for (const s of shifts) {
        let payload = {};
        try { payload = JSON.parse(s.proposed_json || '{}'); } catch (e) { payload = {}; }
        // Creates/updates the booking, flips this import to confirmed, and (on the first
        // call) records project_id → job so future syncs of this project auto-match.
        upsertBookingFromTraffio(db, payload, jobId, req.session.user.id);
        upd.run(mode === 'existing' ? jobId : null, createdJobId, req.session.user.id, s.id);
        done++;
      }
    });
    tx();

    logActivity({
      user: req.session.user, action: 'create',
      entityType: 'traffio_import', entityLabel: `Traffio project ${projectId}`,
      details: `Reconciled ${done} shift(s) of Traffio project ${projectId} → ${mode === 'new' ? 'new job' : 'existing job'}`,
      ip: req.ip,
    });
    req.flash('success', `Reconciled ${done} shift${done === 1 ? '' : 's'} for the project. Future shifts of this project will now auto-match.`);
  } catch (err) {
    req.flash('error', err.message || 'Could not reconcile this project.');
    return req.session.save(() => res.redirect('/traffio-imports/project/' + encodeURIComponent(projectId)));
  }

  req.session.save(() => res.redirect('/traffio-imports'));
});

// GET /traffio-imports/:id — detail + match/create form
router.get('/:id', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM traffio_imports WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Import not found.'); return req.session.save(() => res.redirect('/traffio-imports')); }

  const payload = parseProposed(row);
  // Active jobs for the picker
  const jobs = db.prepare(`
    SELECT id, job_number, job_name, client, suburb, start_date FROM jobs
    WHERE status NOT IN ('closed','completed')
    ORDER BY job_number DESC LIMIT 500
  `).all();

  res.render('traffio-imports/show', { title: 'Reconcile Traffio Import', row, payload, jobs });
});

// POST /traffio-imports/:id/confirm — map to existing job or create new, then create the booking
router.post('/:id/confirm', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM traffio_imports WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Import not found.'); return req.session.save(() => res.redirect('/traffio-imports')); }
  if (row.status !== 'pending') {
    req.flash('error', 'This import has already been reconciled.');
    return req.session.save(() => res.redirect('/traffio-imports/' + row.id));
  }

  const payload = parseProposed(row);
  const mode = req.body.mode === 'new' ? 'new' : 'existing';

  try {
    const tx = db.transaction(() => {
      let jobId;
      let createdJobId = null;

      if (mode === 'existing') {
        jobId = Number(req.body.job_id);
        if (!jobId || !db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId)) {
          throw new Error('Pick a valid job to map to.');
        }
      } else {
        const jobName = (req.body.job_name || '').trim();
        const client = (req.body.client || '').trim();
        if (!jobName || !client) throw new Error('New job needs a name and client.');
        const startDate = (payload.date || payload.start_datetime || payload.starts_at || '')
          .toString().slice(0, 10) || new Date().toISOString().slice(0, 10);
        const jobNumber = (req.body.job_number || '').trim()
          || `TRF-J-${row.traffio_external_id}`;
        const result = db.prepare(`
          INSERT INTO jobs (job_number, job_name, client, site_address, suburb, status, stage, start_date, client_project_number)
          VALUES (?, ?, ?, ?, ?, 'active', 'delivery', ?, ?)
        `).run(
          jobNumber, jobName, client,
          (payload.site_address || payload.address || '').toString(),
          (payload.suburb || '').toString(),
          startDate,
          (payload.job_reference || payload.reference || '').toString()
        );
        jobId = result.lastInsertRowid;
        createdJobId = jobId;
      }

      // Create the booking + external_ref; helper also flips this import to confirmed.
      const bookingId = upsertBookingFromTraffio(db, payload, jobId, req.session.user.id);

      // Record the reviewer + which job path was taken (helper set status/resulting_booking_id).
      db.prepare(`
        UPDATE traffio_imports
        SET matched_job_id = ?, created_job_id = ?, resulting_booking_id = ?,
            reviewed_by_id = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(mode === 'existing' ? jobId : null, createdJobId, bookingId, req.session.user.id, row.id);

      return bookingId;
    });
    const bookingId = tx();

    logActivity({
      user: req.session.user, action: 'create',
      entityType: 'traffio_import', entityId: row.id,
      entityLabel: row.summary || `Traffio ${row.record_type} ${row.traffio_external_id}`,
      details: `Reconciled Traffio ${row.record_type} → booking #${bookingId} (${mode === 'new' ? 'new job' : 'existing job'})`,
      ip: req.ip,
    });
    req.flash('success', 'Reconciled — booking created from the Traffio record.');
  } catch (err) {
    req.flash('error', err.message || 'Could not reconcile this import.');
    return req.session.save(() => res.redirect('/traffio-imports/' + row.id));
  }

  req.session.save(() => res.redirect('/traffio-imports'));
});

// POST /traffio-imports/:id/discard — ignore this Traffio record
router.post('/:id/discard', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM traffio_imports WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Import not found.'); return req.session.save(() => res.redirect('/traffio-imports')); }

  db.prepare(`
    UPDATE traffio_imports
    SET status = 'discarded', reviewed_by_id = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(req.session.user.id, row.id);

  logActivity({
    user: req.session.user, action: 'update',
    entityType: 'traffio_import', entityId: row.id,
    entityLabel: row.summary || `Traffio ${row.record_type} ${row.traffio_external_id}`,
    details: 'Discarded Traffio import', ip: req.ip,
  });
  req.flash('success', 'Import discarded.');
  req.session.save(() => res.redirect('/traffio-imports'));
});

module.exports = router;
