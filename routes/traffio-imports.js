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

const PERM = 'traffio_imports';

function parseProposed(row) {
  try { return JSON.parse(row.proposed_json || '{}'); } catch (e) { return {}; }
}

// GET /traffio-imports — queue
router.get('/', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const status = (req.query.status || 'pending').trim(); // pending | confirmed | discarded | all
  const where = ['1=1'];
  const params = [];
  if (status !== 'all') { where.push('ti.status = ?'); params.push(status); }

  const rows = db.prepare(`
    SELECT ti.*, mj.job_number AS matched_job_number, cj.job_number AS created_job_number,
      u.full_name AS reviewer_name
    FROM traffio_imports ti
    LEFT JOIN jobs mj ON mj.id = ti.matched_job_id
    LEFT JOIN jobs cj ON cj.id = ti.created_job_id
    LEFT JOIN users u ON u.id = ti.reviewed_by_id
    WHERE ${where.join(' AND ')}
    ORDER BY CASE ti.status WHEN 'pending' THEN 0 ELSE 1 END, ti.created_at DESC
    LIMIT 300
  `).all(...params);

  const counts = {
    pending: db.prepare("SELECT COUNT(*) AS c FROM traffio_imports WHERE status='pending'").get().c,
    confirmed: db.prepare("SELECT COUNT(*) AS c FROM traffio_imports WHERE status='confirmed'").get().c,
    discarded: db.prepare("SELECT COUNT(*) AS c FROM traffio_imports WHERE status='discarded'").get().c,
  };

  res.render('traffio-imports/index', { title: 'Traffio Reconciliation', rows, counts, status });
});

// GET /traffio-imports/:id — detail + match/create form
router.get('/:id', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM traffio_imports WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Import not found.'); return res.redirect('/traffio-imports'); }

  const payload = parseProposed(row);
  // Active jobs for the picker
  const jobs = db.prepare(`
    SELECT id, job_number, job_name, client FROM jobs
    WHERE status NOT IN ('closed','completed')
    ORDER BY job_number DESC LIMIT 500
  `).all();

  res.render('traffio-imports/show', { title: 'Reconcile Traffio Import', row, payload, jobs });
});

// POST /traffio-imports/:id/confirm — map to existing job or create new, then create the booking
router.post('/:id/confirm', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM traffio_imports WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Import not found.'); return res.redirect('/traffio-imports'); }
  if (row.status !== 'pending') {
    req.flash('error', 'This import has already been reconciled.');
    return res.redirect('/traffio-imports/' + row.id);
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
    return res.redirect('/traffio-imports/' + row.id);
  }

  res.redirect('/traffio-imports');
});

// POST /traffio-imports/:id/discard — ignore this Traffio record
router.post('/:id/discard', requirePermission(PERM), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM traffio_imports WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Import not found.'); return res.redirect('/traffio-imports'); }

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
  res.redirect('/traffio-imports');
});

module.exports = router;
