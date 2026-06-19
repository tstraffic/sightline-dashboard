// Admin review of submitted safety_forms (Job-Pack checklists). Workers
// submit at /w/forms/<form-type>; this is the office-side view that lets
// allocators / management open a submission, see every answer, the photos,
// and the signature(s).

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');

// Pretty labels for the form_type slugs that ship in safety_forms.form_type.
// Anything missing falls back to a Title-Cased version of the slug.
const FORM_LABEL = {
  prestart:           'Pre-Start (legacy)',
  take5:              'Take 5 (legacy)',
  incident:           'Incident',
  hazard:             'Hazard',
  equipment:          'Equipment Check',
  vehicle_prestart:   'Vehicle Pre-Start',
  risk_toolbox:       'Risk Assessment & Toolbox',
  tc_prestart:        'TC Prestart Declaration',
  team_leader:        'Team Leader Checklist',
  post_shift_vehicle: 'Post-Shift Vehicle Checklist',
};

// Form-type slugs we treat as the Job-Pack checklists for the default tab.
// Legacy slugs still appear under "All" so nothing is hidden.
const JOB_PACK_TYPES = ['vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'];

function fmtLabel(slug) {
  if (!slug) return '—';
  if (FORM_LABEL[slug]) return FORM_LABEL[slug];
  return slug.split('_').map(s => s[0] ? s[0].toUpperCase() + s.slice(1) : s).join(' ');
}

// GET /safety-forms — list view with filters
router.get('/', (req, res) => {
  const db = getDb();
  const formType = (req.query.form_type || '').trim();
  const crewId = req.query.crew_member_id ? Number(req.query.crew_member_id) : null;
  const jobId = req.query.job_id ? Number(req.query.job_id) : null;
  const bookingId = req.query.booking_id ? Number(req.query.booking_id) : null;
  const since = (req.query.since || '').trim(); // YYYY-MM-DD
  const scope = (req.query.scope || 'jobpack'); // 'jobpack' | 'all'
  const search = (req.query.q || '').trim();

  const where = [];
  const params = [];
  if (formType) { where.push('sf.form_type = ?'); params.push(formType); }
  else if (scope === 'jobpack') {
    where.push('sf.form_type IN (' + JOB_PACK_TYPES.map(() => '?').join(',') + ')');
    params.push(...JOB_PACK_TYPES);
  }
  if (crewId) { where.push('sf.crew_member_id = ?'); params.push(crewId); }
  if (jobId)  { where.push('sf.job_id = ?'); params.push(jobId); }
  if (bookingId) { where.push('sf.booking_id = ?'); params.push(bookingId); }
  if (since)  { where.push('date(sf.submitted_at) >= date(?)'); params.push(since); }
  if (search) {
    where.push('(cm.full_name LIKE ? OR j.job_number LIKE ? OR j.client LIKE ?)');
    const s = '%' + search + '%';
    params.push(s, s, s);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT
      sf.id, sf.form_type, sf.submitted_at, sf.signed_name, sf.allocation_id,
      sf.crew_member_id, sf.job_id, sf.signature_data IS NOT NULL AS has_sig,
      cm.full_name AS crew_name,
      j.job_number, j.client AS job_client, j.job_name,
      (SELECT COUNT(*) FROM safety_form_photos p WHERE p.safety_form_id = sf.id) AS photo_count
    FROM safety_forms sf
    LEFT JOIN crew_members cm ON sf.crew_member_id = cm.id
    LEFT JOIN jobs j ON sf.job_id = j.id
    ${whereSql}
    ORDER BY sf.submitted_at DESC
    LIMIT 200
  `).all(...params);

  // Counts per form_type for the filter chips at the top
  const counts = db.prepare(`
    SELECT form_type, COUNT(*) AS c FROM safety_forms
    WHERE date(submitted_at) >= date('now','-30 day')
    GROUP BY form_type
  `).all().reduce((acc, r) => { acc[r.form_type] = r.c; return acc; }, {});

  res.render('safety-forms/index', {
    title: 'Job-Pack Submissions',
    rows,
    counts,
    formType,
    scope,
    crewId,
    jobId,
    since,
    search,
    fmtLabel,
    JOB_PACK_TYPES,
    FORM_LABEL,
  });
});

// GET /safety-forms/export.zip?since=YYYY-MM-DD&until=YYYY-MM-DD&form_type=…
// Declared BEFORE /:id so Express matches the literal 'export.zip' first.
router.get('/export.zip', async (req, res) => {
  const archiver = require('archiver');
  const { renderSubmissionPdf } = require('../services/jobPackPdf');
  const db = getDb();
  const since = (req.query.since || '').trim();
  const until = (req.query.until || '').trim();
  const formType = (req.query.form_type || '').trim();

  const where = ['1=1'];
  const params = [];
  if (formType) { where.push('sf.form_type = ?'); params.push(formType); }
  if (since)    { where.push('date(sf.submitted_at) >= date(?)'); params.push(since); }
  if (until)    { where.push('date(sf.submitted_at) <= date(?)'); params.push(until); }

  const rows = db.prepare(`
    SELECT sf.id, sf.form_type, sf.submitted_at
    FROM safety_forms sf
    WHERE ${where.join(' AND ')}
    ORDER BY sf.submitted_at ASC
    LIMIT 500
  `).all(...params);

  if (!rows.length) {
    req.flash('error', 'No submissions match those filters.');
    return res.redirect('/safety-forms');
  }

  const labelStart = since || (rows[0] && new Date(rows[0].submitted_at).toISOString().slice(0,10)) || 'all';
  const labelEnd   = until || (rows[rows.length-1] && new Date(rows[rows.length-1].submitted_at).toISOString().slice(0,10)) || 'all';
  const zipName = `TSTC_jobpack_${labelStart}_to_${labelEnd}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', err => {
    console.error('[safety-forms] zip error:', err.message);
    try { res.status(500).end(); } catch (_) {}
  });
  archive.pipe(res);

  for (const r of rows) {
    try {
      const buf = await renderSubmissionPdf(db, r.id);
      const date = new Date(r.submitted_at).toISOString().slice(0, 10);
      archive.append(buf, { name: `TSTC_${r.form_type}_${date}_${r.id}.pdf` });
    } catch (e) {
      console.error('[safety-forms] skipping submission', r.id, e.message);
      archive.append(`Failed to render submission ${r.id}: ${e.message}\n`, { name: `errors/${r.id}.txt` });
    }
  }
  archive.finalize();
});

// GET /safety-forms/:id — submission detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const sub = db.prepare(`
    SELECT sf.*, cm.full_name AS crew_name, cm.employee_id AS employee_code,
      j.job_number, j.client AS job_client, j.job_name,
      ca.allocation_date, ca.start_time AS shift_start, ca.end_time AS shift_end
    FROM safety_forms sf
    LEFT JOIN crew_members cm ON sf.crew_member_id = cm.id
    LEFT JOIN jobs j ON sf.job_id = j.id
    LEFT JOIN crew_allocations ca ON sf.allocation_id = ca.id
    WHERE sf.id = ?
  `).get(req.params.id);
  if (!sub) {
    req.flash('error', 'Submission not found.');
    return res.redirect('/safety-forms');
  }
  let parsed = {};
  try { parsed = sub.data ? JSON.parse(sub.data) : {}; } catch (e) { /* keep empty */ }

  const photos = db.prepare(`
    SELECT id, tag, file_path, original_name, mime_type, size_bytes, width, height
    FROM safety_form_photos WHERE safety_form_id = ?
    ORDER BY id ASC
  `).all(sub.id);

  // Group photos by tag so the detail page can render them under the right
  // heading (arrow_board / setup / interior / equipment_cage / fuel_gauge / team).
  const photosByTag = {};
  for (const p of photos) {
    (photosByTag[p.tag || 'other'] = photosByTag[p.tag || 'other'] || []).push(p);
  }

  res.render('safety-forms/show', {
    title: fmtLabel(sub.form_type) + ' — ' + (sub.crew_name || '#' + sub.crew_member_id),
    sub,
    parsed,
    photos,
    photosByTag,
    fmtLabel,
    formLabel: fmtLabel(sub.form_type),
  });
});

// GET /safety-forms/:id/pdf — render submission as a branded T&S PDF
router.get('/:id/pdf', async (req, res) => {
  try {
    const { renderSubmissionPdf } = require('../services/jobPackPdf');
    const buf = await renderSubmissionPdf(getDb(), req.params.id);
    const meta = getDb().prepare('SELECT form_type, submitted_at FROM safety_forms WHERE id = ?').get(req.params.id);
    const date = meta ? new Date(meta.submitted_at).toISOString().slice(0, 10) : 'submission';
    const slug = (meta && meta.form_type) ? meta.form_type : 'submission';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="TSTC_${slug}_${date}_${req.params.id}.pdf"`);
    res.send(buf);
  } catch (e) {
    console.error('[safety-forms] PDF render failed:', e.message);
    res.status(500).send('PDF render failed: ' + e.message);
  }
});

// GET /safety-forms/:id/photos/:photoId — stream a stored photo to the admin
router.get('/:id/photos/:photoId', (req, res) => {
  const db = getDb();
  const photo = db.prepare(`
    SELECT * FROM safety_form_photos
    WHERE id = ? AND safety_form_id = ?
  `).get(req.params.photoId, req.params.id);
  if (!photo) return res.status(404).send('Not found');
  const abs = path.isAbsolute(photo.file_path) ? photo.file_path : path.join(__dirname, '..', photo.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', photo.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
