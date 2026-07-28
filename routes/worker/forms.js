const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { getDb } = require('../../db/database');
const { notifySubmission } = require('../../services/jobPackNotify');
const { sydneyToday } = require('../../lib/sydney');
const { resolveShift, getCurrentDocket } = require('../../lib/shiftDocket');

// Fire-and-forget email-the-PDF-to-ops on every Job-Pack submission.
// The email send happens off the request path so a slow / failed Resend
// call doesn't make the worker think their submission didn't go through.
function fireOpsNotification(db, submissionId) {
  Promise.resolve()
    .then(() => notifySubmission(db, submissionId))
    .catch(err => console.error('[jobPackNotify] failed for submission', submissionId, err.message));
}

// Photos uploaded against a safety_forms submission live under
// data/uploads/job-forms/<safety_form_id>/<filename>. We don't know the form
// id at upload time so multer drops files into a per-allocation tmp dir and
// the route handler moves them into the right place after the row is inserted.
const JOB_FORMS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'job-forms');
const TMP_FORMS_DIR = path.join(JOB_FORMS_DIR, '_tmp');

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(TMP_FORMS_DIR, `w${req.session.worker.id}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    req._formUploadDir = dir; // capture so handler can find files after upload
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '.jpg') || '.jpg').toLowerCase();
    cb(null, `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  // Raised from 12 → 25 to cover the busiest checklist (Team Leader allows
  // 8 worker photos + 10 setup photos = 18) with headroom for the multer
  // global file count vs. per-field maxCount, which used to silently 500
  // when team_photos + setup_photos crossed the old 12-file ceiling.
  // Per-file ceiling raised from 8MB → 15MB so iPhone HEIC/Live photos
  // (often 8-12MB) don't get rejected.
  limits: { fileSize: 15 * 1024 * 1024, files: 25 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//i.test(file.mimetype)) return cb(new Error('Images only'));
    cb(null, true);
  },
});

// Wrap `photoUpload.fields(...)` so multer errors surface as flash messages
// the worker can actually read instead of bubbling into a 500. Without this
// a too-many-files / file-too-large rejection just looked like the form
// silently failed to submit. The wrapped middleware redirects back to the
// page the worker came from with a specific reason, e.g. "Photo too large —
// keep each one under 15 MB. Please try again."
function withPhotoUploadError(fields) {
  const handler = photoUpload.fields(fields);
  return (req, res, next) => {
    handler(req, res, (err) => {
      if (!err) return next();
      let msg;
      if (err.code === 'LIMIT_FILE_SIZE') {
        msg = 'A photo is over 15 MB. iPhone "Live" photos and 4K bursts are common culprits — try a smaller image or take a fresh one.';
      } else if (err.code === 'LIMIT_FILE_COUNT') {
        msg = 'Too many photos uploaded at once (max 25 across all fields). Submit what you have, then add the rest as a follow-up.';
      } else if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        msg = 'Too many photos for one of the fields. Each field has its own cap — check the limits next to each upload.';
      } else if (err.message === 'Images only') {
        msg = "Only photos can be uploaded here. Don't attach PDFs or videos to a checklist.";
      } else {
        msg = 'Photo upload failed: ' + (err.message || 'unknown error') + '.';
      }
      console.error('[forms] photo upload error:', err.code || err.message);
      req.flash('error', msg);
      return req.session.save(() => res.redirect('back'));
    });
  };
}

// Move every uploaded photo from the request's tmp dir into the form's home
// dir (data/uploads/job-forms/<safety_form_id>/), resize to a sane max size,
// and write a row into safety_form_photos for each.
async function persistFormPhotos(db, safetyFormId, files, tagFor) {
  if (!files || !files.length) return;
  const homeDir = path.join(JOB_FORMS_DIR, String(safetyFormId));
  fs.mkdirSync(homeDir, { recursive: true });
  const insert = db.prepare(`
    INSERT INTO safety_form_photos (safety_form_id, tag, file_path, original_name, mime_type, size_bytes, width, height)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of files) {
    const finalName = path.basename(f.path);
    const finalPath = path.join(homeDir, finalName);
    try {
      // Resize down to max 1600px on the long edge to keep storage sane.
      const buf = await sharp(f.path).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
      const meta = await sharp(buf).metadata();
      fs.writeFileSync(finalPath, buf);
      fs.unlinkSync(f.path);
      insert.run(safetyFormId, tagFor(f.fieldname), path.relative(path.join(__dirname, '..', '..'), finalPath), f.originalname || finalName, 'image/jpeg', buf.length, meta.width || null, meta.height || null);
    } catch (e) {
      console.error('[forms] photo resize failed, falling back to raw copy:', e.message);
      try { fs.renameSync(f.path, finalPath); } catch (_) { /* already moved */ }
      const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : { size: 0 };
      insert.run(safetyFormId, tagFor(f.fieldname), path.relative(path.join(__dirname, '..', '..'), finalPath), f.originalname || finalName, f.mimetype || null, stat.size, null, null);
    }
  }
  // Best-effort tmp dir cleanup
  try { fs.rmSync(path.dirname(files[0].path), { recursive: true, force: true }); } catch (_) {}
}

// ===========================================================================
// Team-shared drafts (migration 267)
//
// Any worker on a shift can save partial form state as a draft; teammates
// on the same shift see and resume that same draft. shift_key identifies
// the shift: 'b:<bookingId>' or 'j:<jobId>:<allocationDate>'. Drafts hold
// the same JSON-blob `data` + `safety_form_photos` rows as a submitted
// form, just with status='draft'. Submitting transitions the draft row
// to status='submitted' so the photos and notes carry across without
// re-uploading.
// ===========================================================================

function computeShiftKey(db, allocation) {
  if (!allocation) return null;
  if (allocation.booking_id) return 'b:' + allocation.booking_id;
  if (allocation.job_id && allocation.allocation_date) return 'j:' + allocation.job_id + ':' + allocation.allocation_date;
  return null;
}

function findTeamDraft(db, shiftKey, formType, fallbackAllocationId) {
  if (shiftKey) {
    const row = db.prepare(`
      SELECT sf.*, cm.full_name AS draft_started_by_name
      FROM safety_forms sf
      LEFT JOIN crew_members cm ON cm.id = sf.draft_started_by_id
      WHERE sf.shift_key = ? AND sf.form_type = ? AND sf.status = 'draft'
      ORDER BY sf.id DESC LIMIT 1
    `).get(shiftKey, formType);
    if (row) return row;
  }
  // Fallback for allocations without booking/job context — scope to the
  // allocation itself so a worker on a legacy shift can still resume their
  // own draft (just not team-shared).
  if (fallbackAllocationId) {
    return db.prepare(`
      SELECT sf.*, cm.full_name AS draft_started_by_name
      FROM safety_forms sf
      LEFT JOIN crew_members cm ON cm.id = sf.draft_started_by_id
      WHERE sf.allocation_id = ? AND sf.form_type = ? AND sf.status = 'draft'
      ORDER BY sf.id DESC LIMIT 1
    `).get(fallbackAllocationId, formType);
  }
  return null;
}

function getDraftPhotos(db, draftId) {
  if (!draftId) return [];
  return db.prepare(`
    SELECT id, tag, original_name, mime_type
    FROM safety_form_photos
    WHERE safety_form_id = ?
    ORDER BY id
  `).all(draftId);
}

// GET /w/forms/draft-photos/:id — worker-accessible photo serve. Restricted
// to a draft whose shift the worker is currently on. (Submitted-form photos
// are surfaced only to admins via /safety-forms/:id/photos/:photoId.)
router.get('/forms/draft-photos/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const photo = db.prepare(`
    SELECT p.*, sf.shift_key, sf.status
    FROM safety_form_photos p JOIN safety_forms sf ON sf.id = p.safety_form_id
    WHERE p.id = ?
  `).get(req.params.id);
  if (!photo) return res.status(404).send('Not found');
  if (photo.status !== 'draft') return res.status(403).send('Forbidden');
  // Make sure the worker is on this shift.
  let allowed = false;
  if (photo.shift_key && photo.shift_key.startsWith('b:')) {
    const bid = parseInt(photo.shift_key.slice(2), 10);
    allowed = !!db.prepare('SELECT 1 FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(bid, worker.id);
  } else if (photo.shift_key && photo.shift_key.startsWith('j:')) {
    const parts = photo.shift_key.slice(2).split(':');
    if (parts.length === 2) {
      allowed = !!db.prepare("SELECT 1 FROM crew_allocations WHERE job_id = ? AND allocation_date = ? AND crew_member_id = ? AND status != 'cancelled'").get(parts[0], parts[1], worker.id);
    }
  }
  if (!allowed) return res.status(403).send('Not on this shift');
  const abs = path.isAbsolute(photo.file_path) ? photo.file_path : path.join(__dirname, '..', '..', photo.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', photo.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(abs).pipe(res);
});

// POST /w/forms/draft/:id/delete — delete a team draft. Anyone on the shift
// can wipe it (drafts are owned by the team, not the starter).
router.post('/forms/draft/:id/delete', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const draft = db.prepare("SELECT * FROM safety_forms WHERE id = ? AND status = 'draft'").get(req.params.id);
  if (!draft) { req.flash('error', 'Draft not found or already submitted.'); return req.session.save(() => res.redirect('back')); }
  // Guard: worker has to be on this draft's shift.
  let allowed = false;
  if (draft.shift_key && draft.shift_key.startsWith('b:')) {
    allowed = !!db.prepare('SELECT 1 FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(parseInt(draft.shift_key.slice(2), 10), worker.id);
  } else if (draft.shift_key && draft.shift_key.startsWith('j:')) {
    const parts = draft.shift_key.slice(2).split(':');
    if (parts.length === 2) allowed = !!db.prepare("SELECT 1 FROM crew_allocations WHERE job_id = ? AND allocation_date = ? AND crew_member_id = ? AND status != 'cancelled'").get(parts[0], parts[1], worker.id);
  }
  if (!allowed) { req.flash('error', "You're not on this shift."); return req.session.save(() => res.redirect('back')); }

  // Photo files on disk get cleaned along with the row (FK ON DELETE CASCADE
  // wipes safety_form_photos automatically; here we also unlink the files).
  const photos = db.prepare('SELECT file_path FROM safety_form_photos WHERE safety_form_id = ?').all(draft.id);
  db.prepare('DELETE FROM safety_form_photos WHERE safety_form_id = ?').run(draft.id);
  db.prepare("DELETE FROM safety_forms WHERE id = ? AND status = 'draft'").run(draft.id);
  for (const p of photos) {
    try {
      const abs = path.isAbsolute(p.file_path) ? p.file_path : path.join(__dirname, '..', '..', p.file_path);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (_) {}
  }
  // Also remove the per-form photo directory if it's now empty.
  try {
    const homeDir = path.join(JOB_FORMS_DIR, String(draft.id));
    if (fs.existsSync(homeDir)) fs.rmSync(homeDir, { recursive: true, force: true });
  } catch (_) {}

  req.flash('success', 'Draft deleted.');
  return req.session.save(() => res.redirect('back'));
});

// GET /w/forms — Form type selector with today's status
router.get('/forms', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = sydneyToday();

  // Count recent submissions
  const recentCount = db.prepare('SELECT COUNT(*) as c FROM safety_forms WHERE crew_member_id = ? AND submitted_at >= datetime(\'now\', \'-7 days\')').get(worker.id).c;

  // Get today's shifts
  const todaysShifts = db.prepare(`
    SELECT ca.id, ca.allocation_date, ca.start_time, ca.end_time, ca.job_id,
      j.job_number, j.client, j.suburb
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  // Get today's completed forms
  const todaysForms = db.prepare(`
    SELECT form_type, allocation_id, created_at
    FROM safety_forms
    WHERE crew_member_id = ? AND date(created_at) = ?
  `).all(worker.id, today);

  // Build status per shift. Dockets are now per-shift (one docket covers the
  // whole crew), so "has docket" = a current shift docket exists for the shift
  // this allocation belongs to.
  const shiftStatus = todaysShifts.map(s => {
    const hasPrestart = todaysForms.some(f => f.form_type === 'prestart' && (f.allocation_id === s.id || f.allocation_id === null));
    const hasTake5 = todaysForms.some(f => f.form_type === 'take5' && (f.allocation_id === s.id || f.allocation_id === null));
    const shift = resolveShift(db, { allocationId: s.id });
    const hasDocket = shift ? !!getCurrentDocket(db, shift) : false;
    return { ...s, hasPrestart, hasTake5, hasDocket };
  });

  const hasTodaysPrestart = todaysForms.some(f => f.form_type === 'prestart');
  const hasTodaysTake5 = todaysForms.some(f => f.form_type === 'take5');

  // Admin-built form templates published to workers. The 5 Job-Pack shift
  // checklists are excluded — they're opened from a shift's Forms tab so
  // the submission lands against the right allocation.
  const JOB_PACK_KEYS = ['vehicle_prestart', 'risk_toolbox', 'tc_prestart', 'team_leader', 'post_shift_vehicle'];
  let formTemplates = [];
  try {
    formTemplates = db.prepare(`
      SELECT id, name, description FROM checklist_templates
      WHERE worker_visible = 1 AND status = 'active'
        AND published_revision IS NOT NULL AND published_revision > 0
        AND (system_key IS NULL OR system_key NOT IN (${JOB_PACK_KEYS.map(() => '?').join(',')}))
      ORDER BY sort_order ASC, name ASC
    `).all(...JOB_PACK_KEYS);
  } catch (e) { /* templates table predates migration 105 */ }

  res.render('worker/forms/index', {
    title: 'Forms',
    currentPage: 'forms',
    recentCount,
    todaysShifts,
    shiftStatus,
    hasTodaysPrestart,
    hasTodaysTake5,
    formTemplates,
  });
});

// Legacy form URLs → their template-driven replacements. The old hardcoded
// EJS forms are superseded by admin-editable templates (migration 265); we
// keep the URLs alive because they're bookmarked / linked from old pushes.
// If the template doesn't exist (migration not run), fall through to the
// legacy renderer below.
function redirectToTemplate(db, res, systemKey) {
  try {
    const t = db.prepare(`
      SELECT id FROM checklist_templates
      WHERE system_key = ? AND status = 'active' AND worker_visible = 1
        AND published_revision IS NOT NULL AND published_revision > 0
    `).get(systemKey);
    if (t) { res.redirect('/w/forms/custom/' + t.id); return true; }
  } catch (e) { /* fall through to legacy form */ }
  return false;
}

// GET /w/forms/prestart
router.get('/forms/prestart', (req, res) => {
  const db = getDb();
  // The signage variant became its own editable template (migration 265);
  // the plain prestart stays as the legacy renderer.
  if (req.query.type === 'signage' && redirectToTemplate(db, res, 'signage_inspection')) return;
  const worker = req.session.worker;
  const today = sydneyToday();

  const todaysShifts = db.prepare(`
    SELECT ca.id, j.job_number, j.client FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  // Pre-select allocation if passed via query
  const selectedAllocation = req.query.allocation_id || '';

  res.render('worker/forms/prestart', {
    title: 'Pre-Start Checklist',
    currentPage: 'forms',
    todaysShifts,
    selectedAllocation,
  });
});

// POST /w/forms/prestart
router.post('/forms/prestart', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { allocation_id, ...checklistData } = req.body;

  // Remove _csrf from data
  delete checklistData._csrf;

  const allocation = allocation_id ? db.prepare('SELECT job_id FROM crew_allocations WHERE id = ?').get(allocation_id) : null;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, data, status, latitude, longitude)
    VALUES (?, 'prestart', ?, ?, ?, 'submitted', ?, ?)
  `).run(worker.id, allocation ? allocation.job_id : null, allocation_id || null, JSON.stringify(checklistData), req.body.latitude || null, req.body.longitude || null);

  req.flash('success', 'Pre-start checklist submitted.');

  // Redirect back to job detail if came from there
  if (allocation_id) {
    return req.session.save(() => res.redirect('/w/jobs/' + allocation_id + '?tab=forms'));
  }
  req.session.save(() => res.redirect('/w/forms'));
});

// GET /w/forms/take5
router.get('/forms/take5', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = sydneyToday();

  const todaysShifts = db.prepare(`
    SELECT ca.id, j.job_number, j.client FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
  `).all(worker.id, today);

  const selectedAllocation = req.query.allocation_id || '';

  res.render('worker/forms/take5', {
    title: 'Take 5 Safety Check',
    currentPage: 'forms',
    todaysShifts,
    selectedAllocation,
  });
});

// POST /w/forms/take5
router.post('/forms/take5', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { allocation_id, ...formData } = req.body;
  delete formData._csrf;

  const allocation = allocation_id ? db.prepare('SELECT job_id FROM crew_allocations WHERE id = ?').get(allocation_id) : null;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, data, status)
    VALUES (?, 'take5', ?, ?, ?, 'submitted')
  `).run(worker.id, allocation ? allocation.job_id : null, allocation_id || null, JSON.stringify(formData));

  req.flash('success', 'Take 5 submitted.');
  if (allocation_id) {
    return req.session.save(() => res.redirect('/w/jobs/' + allocation_id + '?tab=forms'));
  }
  req.session.save(() => res.redirect('/w/forms'));
});

// GET /w/forms/incident
router.get('/forms/incident', (req, res) => {
  const db = getDb();
  const byType = { bullying: 'bullying_harassment', vehicle: 'vehicle_incident' };
  const systemKey = byType[String(req.query.type || '')] || 'incident_report';
  if (redirectToTemplate(db, res, systemKey)) return;
  res.render('worker/forms/incident', {
    title: 'Report Incident',
    currentPage: 'forms',
  });
});

// POST /w/forms/incident
router.post('/forms/incident', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { incident_type, severity, title, description, location, latitude, longitude } = req.body;

  if (!title || !description) {
    req.flash('error', 'Title and description are required.');
    return req.session.save(() => res.redirect('/w/forms/incident'));
  }

  // Generate incident number
  const count = db.prepare('SELECT COUNT(*) as c FROM incidents').get().c;
  const incidentNumber = 'INC-' + String(count + 1).padStart(4, '0');

  // Insert into incidents table for admin visibility
  try {
    db.prepare(`
      INSERT INTO incidents (incident_number, incident_type, severity, title, description, location, investigation_status, reported_by_crew_id)
      VALUES (?, ?, ?, ?, ?, ?, 'reported', ?)
    `).run(incidentNumber, incident_type || 'other', severity || 'medium', title, description, location || null, worker.id);
  } catch(e) {
    // If reported_by_crew_id column doesn't exist yet, try without it
    db.prepare(`
      INSERT INTO incidents (incident_number, incident_type, severity, title, description, location, investigation_status)
      VALUES (?, ?, ?, ?, ?, ?, 'reported')
    `).run(incidentNumber, incident_type || 'other', severity || 'medium', title, description, location || null);
  }

  // Also insert into safety_forms
  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, data, status, latitude, longitude)
    VALUES (?, 'incident', ?, 'submitted', ?, ?)
  `).run(worker.id, JSON.stringify({ incident_type, severity, title, description, location, incident_number: incidentNumber }), latitude || null, longitude || null);

  req.flash('success', 'Incident reported: ' + incidentNumber);
  req.session.save(() => res.redirect('/w/forms'));
});

// GET /w/forms/hazard
router.get('/forms/hazard', (req, res) => {
  if (redirectToTemplate(getDb(), res, 'near_miss')) return;
  res.render('worker/forms/hazard', {
    title: 'Report Hazard',
    currentPage: 'forms',
  });
});

// POST /w/forms/hazard
router.post('/forms/hazard', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { ...formData } = req.body;
  delete formData._csrf;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, data, status, latitude, longitude)
    VALUES (?, 'hazard', ?, 'submitted', ?, ?)
  `).run(worker.id, JSON.stringify(formData), req.body.latitude || null, req.body.longitude || null);

  req.flash('success', 'Hazard reported.');
  req.session.save(() => res.redirect('/w/forms'));
});

// GET /w/forms/equipment
router.get('/forms/equipment', (req, res) => {
  if (redirectToTemplate(getDb(), res, 'pre_delivery_vehicle')) return;
  res.render('worker/forms/equipment', {
    title: 'Equipment Check',
    currentPage: 'forms',
    allocation_id: req.query.allocation_id || '',
  });
});

// POST /w/forms/equipment
router.post('/forms/equipment', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { allocation_id, ...formData } = req.body;
  delete formData._csrf;

  db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, data, status)
    VALUES (?, 'equipment', ?, 'submitted')
  `).run(worker.id, JSON.stringify(formData));

  req.flash('success', 'Equipment check submitted.');
  if (allocation_id) {
    return req.session.save(() => res.redirect('/w/jobs/' + allocation_id + '?tab=forms'));
  }
  req.session.save(() => res.redirect('/w/forms'));
});

// GET /w/forms/history — My submitted forms
router.get('/forms/history', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const forms = db.prepare(`
    SELECT sf.*, j.job_number, j.client
    FROM safety_forms sf
    LEFT JOIN jobs j ON sf.job_id = j.id
    WHERE sf.crew_member_id = ?
    ORDER BY sf.created_at DESC LIMIT 50
  `).all(worker.id);

  res.render('worker/forms/history', {
    title: 'Form History',
    currentPage: 'forms',
    forms,
  });
});

// ============================================
// VEHICLE PRE-START — Traffio "1. T&S Vehicle Pre-Start"
// ============================================

// Canonical 22-item OK / Not OK / N/A check list. Order is the same as the
// PDF so the rendered output sits side-by-side with the original.
// Hardcoded fallbacks below — used until an admin publishes a revision
// of the matching system template. After mig 151 ships, migration 151
// auto-publishes revision 1 mirroring these arrays, so by default the
// worker portal still renders the same items the workers are used to.
// Admin edits + republishes change this content live.
const { getSystemItems } = require('../../services/systemChecklists');

// Map a system-template item back to the shape the existing EJS expects
// for the simple OK/Not OK/N/A and Yes/No/N/A forms. They only need
// { key, label }.
function toSimpleItem(it) {
  return { key: it.item_key, label: it.question };
}

const VEHICLE_PRESTART_ITEMS = [
  { key: 'jack_wrench',       label: 'Jack and Wrench' },
  { key: 'steering',          label: 'Steering' },
  { key: 'horn',              label: 'Horn' },
  { key: 'vehicle_damage',    label: 'Vehicle Damage' },
  { key: 'spare_wheel',       label: 'Spare Wheel' },
  { key: 'windshield',        label: 'Windshield' },
  { key: 'brakes',            label: 'Brakes' },
  { key: 'headlights',        label: 'Headlights' },
  { key: 'tail_lights',       label: 'Tail Lights' },
  { key: 'mirrors',           label: 'Mirrors' },
  { key: 'seatbelts',         label: 'Seatbelts' },
  { key: 'tyre_wear',         label: 'Tyre Wear' },
  { key: 'arrow_board',       label: 'Arrow Board' },
  { key: 'vms_board',         label: 'VMS Board' },
  { key: 'beacons_front',     label: 'Flashing Beacons (Front)' },
  { key: 'beacons_rear',      label: 'Flashing Beacons (Rear)' },
  { key: 'fluid_leaks',       label: 'Fluid Leaks' },
  { key: 'reverse_squawker',  label: 'Reverse Squawker' },
  { key: 'fire_extinguisher', label: 'Fire Extinguisher' },
  { key: 'first_aid_kit',     label: 'Fully Stocked First Aid Kit' },
  { key: 'cabin_clean',       label: 'Cabin/Tray Free From Litter/Rubbish' },
  { key: 'load_restraint',    label: 'Load Restraint' },
];

// All five Job-Pack forms only make sense bound to a specific shift. If a
// worker hits one of these routes without an allocationId we redirect them
// back to their jobs list — the FORMS tab on the relevant shift is the
// only entry point that gets the submission tied to the right allocation.
function requireAllocation(req, res) {
  const db = getDb();
  const worker = req.session.worker;
  const allocationId = req.query.allocationId ? Number(req.query.allocationId) : null;
  if (!allocationId) {
    req.flash('error', 'Open this checklist from the shift it belongs to.');
    req.session.save(() => res.redirect('/w/jobs'));
    return null;
  }
  const allocation = db.prepare(`
    SELECT ca.*, j.job_number, j.client, j.site_address, j.suburb
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(allocationId, worker.id);
  if (!allocation) {
    req.flash('error', 'Shift not found or not yours.');
    req.session.save(() => res.redirect('/w/jobs'));
    return null;
  }
  return allocation;
}

// GET /w/forms/vehicle-prestart — Render the form
router.get('/forms/vehicle-prestart', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const allocation = requireAllocation(req, res);
  if (!allocation) return;

  // Vehicle suggestions: prefer the company_vehicle_assigned field on the
  // worker's employee row, then anything they've used on previous vehicle
  // pre-starts. crew_allocations has no vehicle column so we don't pull from
  // there. Worst case the datalist is empty and the input behaves as plain text.
  const seen = new Set();
  const recentVehicles = [];
  try {
    const empVeh = db.prepare(`
      SELECT e.company_vehicle_assigned AS v
      FROM employees e
      WHERE (e.linked_crew_member_id = ? OR e.id = (SELECT employee_id FROM crew_members WHERE id = ?))
        AND e.company_vehicle_assigned IS NOT NULL AND e.company_vehicle_assigned != ''
      LIMIT 1
    `).get(worker.id, worker.id);
    if (empVeh && empVeh.v) { seen.add(empVeh.v); recentVehicles.push(empVeh.v); }
  } catch (_) { /* employees table or column may not exist on dev DBs */ }
  try {
    const prior = db.prepare(`
      SELECT data FROM safety_forms
      WHERE crew_member_id = ? AND form_type = 'vehicle_prestart' AND data IS NOT NULL
      ORDER BY submitted_at DESC LIMIT 10
    `).all(worker.id);
    for (const row of prior) {
      try {
        const v = (JSON.parse(row.data) || {}).vehicle;
        if (v && !seen.has(v)) { seen.add(v); recentVehicles.push(v); }
      } catch (_) { /* malformed JSON — skip */ }
    }
  } catch (_) { /* table may be empty */ }

  // Pull the full element list from the latest published revision.
  // Each element carries response_type + options + item_key, so the
  // EJS renders the form 1:1 with what the admin published in
  // /checklists. Falls back to the hardcoded 22-row inspection list
  // when no system revision exists yet.
  const items = getSystemItems('vehicle_prestart', VEHICLE_PRESTART_ITEMS.map(i => ({
    item_key: i.key, question: i.label, response_type: 'ok_notok_na', section: 'Inspection', required: 1,
  })));

  // Group by section so the rendered form reads as a structured doc
  // (Vehicle / Inspection / Photos / Sign off etc.) just like the
  // admin's preview on /checklists/:id.
  const sections = [];
  const byKey = {};
  items.forEach(function (it) {
    const k = it.section || '';
    if (!byKey[k]) { byKey[k] = { name: k, items: [] }; sections.push(byKey[k]); }
    byKey[k].items.push(it);
  });

  // Per-vehicle entry from the shift Forms tab: ?vehicleId=<booking_vehicles.id>
  // pre-fills the vehicle field with THAT ute and threads the id through a
  // hidden input so the submission is attributed to the right vehicle.
  let prefillVehicle = null, bookingVehicleId = null;
  if (req.query.vehicleId && allocation && allocation.booking_id) {
    const bv = db.prepare('SELECT id, vehicle_name, registration FROM booking_vehicles WHERE id = ? AND booking_id = ?')
      .get(Number(req.query.vehicleId) || 0, allocation.booking_id);
    if (bv) {
      bookingVehicleId = bv.id;
      prefillVehicle = bv.vehicle_name || bv.registration || '';
    }
  }

  res.render('worker/forms/vehicle-prestart', {
    title: 'Vehicle Pre-Start',
    currentPage: 'forms',
    items, sections,
    allocation,
    recentVehicles,
    prefillVehicle,
    bookingVehicleId,
  });
});

// POST /w/forms/vehicle-prestart — Submit
router.post('/forms/vehicle-prestart', photoUpload.array('answer_arrow_board_photos', 6), async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const body = req.body || {};
  const allocationId = body.allocation_id ? Number(body.allocation_id) : null;

  // Validate allocation is owned by worker if supplied
  let allocation = null;
  if (allocationId) {
    allocation = db.prepare('SELECT id, job_id, booking_id, allocation_date FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(allocationId, worker.id);
    if (!allocation) {
      req.flash('error', 'Allocation not found or not yours.');
      return req.session.save(() => res.redirect('/w/forms/vehicle-prestart'));
    }
  }

  // Walk the live element list and pull the right answer shape per
  // response_type. Storage shape is back-compat with the legacy hand-
  // built form: { vehicle, odo_start_km, items, notes } stays at the
  // top level so any reports / safety_forms readers downstream still
  // find their fields, while the full keyed answer set lives under
  // `answers` for any custom rows the admin adds.
  const liveItems = getSystemItems('vehicle_prestart',
    VEHICLE_PRESTART_ITEMS.map(i => ({ item_key: i.key, response_type: 'ok_notok_na' })));
  const answers = {};
  const items = {};
  let driverSignature = null;
  let signedName = null;
  for (const it of liveItems) {
    const k = it.item_key;
    const raw = body['answer_' + k];
    switch (it.response_type) {
      case 'heading':
      case 'information':
      case 'hyperlink':
      case 'media':
        // Display elements — nothing to capture.
        break;
      case 'ok_notok_na':
        answers[k] = ['ok','not_ok','na'].includes(raw) ? raw : 'ok';
        items[k] = answers[k]; // legacy bucket
        break;
      case 'yes_no_na':
        answers[k] = ['yes','no','na'].includes(raw) ? raw : null;
        break;
      case 'pass_fail':
        answers[k] = ['pass','fail'].includes(raw) ? raw : null;
        break;
      case 'number':
      case 'measurement':
        answers[k] = (raw === '' || raw == null) ? null : Number(raw);
        break;
      case 'multiple_choice':
        answers[k] = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
        break;
      case 'signature':
        answers[k] = raw || null;
        if (k === 'driver_signature') driverSignature = raw || null;
        break;
      case 'media_upload':
        // photos persisted below via photoUpload — just record
        // that this slot existed so reports can verify.
        answers[k] = (req.files && req.files.length) ? req.files.length : 0;
        break;
      case 'datetime':
        answers[k] = (raw || '').toString().trim() || null;
        break;
      case 'textarea':
      case 'text':
      default:
        answers[k] = (raw || '').toString().trim();
        if (k === 'signed_name') signedName = answers[k];
        break;
    }
  }
  const data = {
    vehicle: (answers.vehicle || body.vehicle || '').toString().trim(),
    odo_start_km: answers.odo_start_km != null ? Number(answers.odo_start_km) : null,
    items,
    notes: (answers.notes || body.notes || '').toString().trim(),
    answers, // full keyed map for any new admin-added elements
  };

  // Prefer the dynamic-form signature (driver_signature element) if set,
  // otherwise fall back to a top-level signature_data field for back-compat.
  const sigBlob = driverSignature || body.signature_data || null;
  const printedName = signedName || (body.signed_name || '').trim() || null;

  // Which booking ute this pre-start covers. Vehicle checklists are per
  // vehicle (each ute has its own, owed by its driver) — the Forms tab
  // passes booking_vehicle_id through a hidden input. Re-validate against
  // the allocation's booking; a stale id degrades to NULL rather than
  // blocking the submission (legacy rows fall back to a name match).
  let vehicleId = null;
  if (allocation && allocation.booking_id && body.booking_vehicle_id) {
    const bv = db.prepare('SELECT id FROM booking_vehicles WHERE id = ? AND booking_id = ?')
      .get(Number(body.booking_vehicle_id) || 0, allocation.booking_id);
    if (bv) vehicleId = bv.id;
  }

  const result = db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, booking_id, allocation_date, shift_key, vehicle_id, data, signature_data, signed_name, status, submitted_at)
    VALUES (?, 'vehicle_prestart', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))
  `).run(
    worker.id,
    allocation ? allocation.job_id : null,
    allocation ? allocation.id : null,
    allocation ? allocation.booking_id : null,
    allocation ? allocation.allocation_date : null,
    computeShiftKey(db, allocation),
    vehicleId,
    JSON.stringify(data),
    sigBlob,
    printedName,
  );
  const safetyFormId = result.lastInsertRowid;

  try {
    await persistFormPhotos(db, safetyFormId, req.files, () => 'arrow_board');
  } catch (e) {
    console.error('[vehicle-prestart] photo persist error:', e.message);
  }

  fireOpsNotification(db, safetyFormId);

  req.flash('success', 'Vehicle Pre-Start submitted.');
  if (allocation) return req.session.save(() => res.redirect('/w/jobs/' + allocation.id + '?tab=forms'));
  return req.session.save(() => res.redirect('/w/forms'));
});

// SWMS dropdown is shared between Risk Assessment & TC Prestart Declaration —
// declared up here so RA_QUESTIONS (defined immediately below) can reference it.
const SWMS_OPTIONS = [
  'SWMS 01 - National Generic SWMS',
  'SWMS 01 - T&S National Generic Traffic Operations SWMS',
  'SWMS 02 - Mobile Plant Spotting',
  'SWMS 03 - Pedestrian Management',
  'SWMS 04 - Manual Lane Closures',
  'Other',
];

// ============================================
// RISK ASSESSMENT & TOOLBOX — Traffio "2. Risk Assessment and Toolbox"
// ============================================
// Big multi-select form. Every multi-select question is keyed off the same
// data shape: { key, label, options: [...], allowOther? }. Single-select
// questions use { key, label, type: 'radio', options: [...], allowOther? }.
// Free-text questions use type: 'text' or 'textarea'.
// Keeping this declarative makes it easy to add/remove items without churning
// the route or the view.
const RA_QUESTIONS = [
  { key: 'employee_name',  label: 'Name of Employee conducting the Toolbox',  type: 'text', required: true },
  { key: 'works_at_address', label: 'Is works taking place at the address provided?', type: 'radio', options: ['Yes','No - see notes'], required: true },
  { key: 'address_override', label: "If not, what's the actual location?", type: 'textarea' },
  { key: 'scope_of_works', label: 'Scope of Works (select all that apply)', type: 'checkbox', options: ['Utility (Electric, Gas, Telecom, etc)','Civil','Asphalt','School Management','Construction','Telecommunications','Demolition','Other'] },
  { key: 'road_hazards', label: 'Road Hazards', type: 'checkbox', options: ['Hills/Dips/Crests','High Speed Area','Sharp Bends','Roundabouts','Intersections','Schools / Pedestrian Areas','Wet/Slippery Surface','Reduced Visibility','None Identified'] },
  { key: 'emergency_assembly', label: 'Where is the Emergency Assembly Point?', type: 'text', required: true, placeholder: 'e.g. Traffic Control Vehicle' },
  { key: 'amenities', label: 'Closest amenities / toilets to the work site', type: 'text' },
  { key: 'tcs_have_licence', label: 'Do all Traffic Controllers hold a current Safe Work NSW Licence (TCR & IMP)?', type: 'radio', options: ['Yes - Sighted and verified by Team Leader','No - notify supervisor'], required: true },
  { key: 'swms', label: 'Select the relevant Safe Work Method Statement (SWMS)', type: 'radio', options: SWMS_OPTIONS, required: true },
  { key: 'tc_activity', label: 'Traffic Control Activity (select all that apply)', type: 'checkbox', options: ['Lane Closure','Pedestrian Management','Mobile Works','Static Works','Stop/Slow','School Crossing','Pilot Vehicle','Other'] },
  { key: 'traffic_volume', label: 'Traffic Volume', type: 'radio', options: ['Low Volume (eg. Local Road)','Moderate Volume (eg. Arterial Road)','High Volume (eg. Motorway/Highway)'] },
  { key: 'speed_limit', label: 'Normal posted speed limit (km/h)', type: 'number' },
  { key: 'speed_reduced_to', label: 'Speed being reduced to (km/h)', type: 'number' },
  { key: 'struck_by_traffic_controls', label: 'Controls for being struck by traffic', type: 'checkbox', options: ['Buffer Vehicle','Clear visibility of control points','Clear visibility of signs','Escape Routes','Not turning back to traffic','Remain outside live traffic lanes'] },
  { key: 'exclusion_zone_items', label: 'Items / machinery needing exclusion zones', type: 'checkbox', options: ['Open excavation, pits and manholes','Overhead Crane or EWP','Mobile Plant','None Identified'] },
  { key: 'exclusion_zone_controls', label: 'Controls for exclusion zones', type: 'checkbox', options: ['Client mandated exclusion zone','Delineation (cones/Tiger Tails/Bollards/Tape)','Protected pedestrian corridors','Visible contact / confirmation with Plant operators'] },
  { key: 'pedestrian_controls', label: 'Controls for pedestrians being struck by traffic', type: 'checkbox', options: ['Delineation (cones/tiger tails/bollards/tape)','Escort','Signs','Pedestrian corridor','None - no pedestrians on site'] },
  { key: 'slip_trip_controls', label: 'Controls for slips, trips and falls', type: 'checkbox', options: ['Boot Safety - Laces tied and zips pulled up',"Don't rush tasks",'Isolate hazardous area','Cones around manholes/trip hazards'] },
  { key: 'weather_conditions', label: 'Adverse weather conditions', type: 'checkbox', options: ['N/A - No adverse weather','Heat','Cold','Rain','Strong Wind','Reduced Visibility / Fog','Storm / Lightning'] },
  { key: 'manual_handling_controls', label: 'Controls for manual handling', type: 'checkbox', options: ['N/A - Not stopping traffic','Two-person lifts','Use of trolley/dolly','Lifting techniques','PPE'] },
  { key: 'queue_management', label: 'How are end-of-queue lengths being managed?', type: 'checkbox', options: ['N/A - Not stopping traffic','VMS / Arrow Board','Tail-end controller','Queue protection vehicle','Police support'] },
  { key: 'other_hazards', label: 'Other hazards identified', type: 'textarea', placeholder: 'N/A - All hazards identified and controlled' },
  { key: 'safe_to_proceed', label: 'With the selected controls in place, can the job be conducted safely?', type: 'radio', options: ['Yes','No - work must not commence'], required: true },
  { key: 'communicated_items', label: 'Items communicated to all staff in the toolbox', type: 'checkbox', options: ['Breaks','Client Requirements','Emergency Procedures','Exclusion Zones','Golden Rules of Safety','Sequencing','Site Set Up and Pack Up'] },
];

router.get('/forms/risk-assessment', (req, res) => {
  const allocation = requireAllocation(req, res);
  if (!allocation) return;

  // Resolve questions from the system template, falling back to
  // the hardcoded RA_QUESTIONS array. The system template snapshot
  // has shape { item_key, question, response_type, options, required }
  // so we map back to the EJS's expected shape { key, label, type, options, required }.
  const sysQ = getSystemItems('risk_toolbox', RA_QUESTIONS.map(q => ({
    item_key: q.key, question: q.label, response_type: q.type, options: q.options, required: q.required ? 1 : 0,
  })));
  // Admin editor stores multi-option questions as response_type='multiple_choice'
  // with options={ options: [...], multi: bool }. Translate back to the
  // simple {type:'radio'|'checkbox', options: [...]} the view expects.
  // Display-only items (heading/information/hyperlink/media) and signature
  // are filtered out — risk-assessment has its own hardcoded signature pad
  // and section dividers come from `it.section` already.
  const questions = sysQ
    .filter(it => !['heading','information','hyperlink','media','signature'].includes(it.response_type))
    .map(it => {
      let type = 'text';
      let options = [];
      if (it.response_type === 'multiple_choice') {
        const opts = it.options || {};
        options = Array.isArray(opts.options) ? opts.options : (Array.isArray(opts) ? opts : []);
        type = opts.multi ? 'checkbox' : 'radio';
      } else if (it.response_type === 'checkbox') {
        type = 'checkbox';
        options = Array.isArray(it.options) ? it.options : (it.options && it.options.options) || [];
      } else if (it.response_type === 'radio' || it.response_type === 'yes_no_na' || it.response_type === 'pass_fail' || it.response_type === 'ok_notok_na') {
        type = 'radio';
        if (it.response_type === 'yes_no_na')      options = ['Yes', 'No', 'N/A'];
        else if (it.response_type === 'pass_fail') options = ['Pass', 'Fail'];
        else if (it.response_type === 'ok_notok_na') options = ['OK', 'Not OK', 'N/A'];
        else options = Array.isArray(it.options) ? it.options : (it.options && it.options.options) || [];
      } else if (it.response_type === 'textarea') {
        type = 'textarea';
      } else if (it.response_type === 'number' || it.response_type === 'measurement') {
        type = 'number';
      } else {
        type = 'text';
      }
      return {
        key: it.item_key,
        label: it.question,
        type,
        options,
        required: !!it.required,
      };
    });

  res.render('worker/forms/risk-assessment', {
    title: 'Risk Assessment & Toolbox',
    currentPage: 'forms',
    allocation,
    questions,
  });
});

router.post('/forms/risk-assessment', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const body = req.body || {};
  const allocationId = body.allocation_id ? Number(body.allocation_id) : null;

  let allocation = null;
  if (allocationId) {
    allocation = db.prepare('SELECT id, job_id, booking_id, allocation_date FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(allocationId, worker.id);
    if (!allocation) {
      req.flash('error', 'Allocation not found or not yours.');
      return req.session.save(() => res.redirect('/w/forms/risk-assessment'));
    }
  }

  // Walk every declared question. Pull from the live system template
  // so admin-added/renamed questions still save cleanly. Translate
  // admin-editor response types (multiple_choice / yes_no_na / etc.)
  // into the same {type: 'checkbox'|'radio'|'number'|'text'|'textarea'}
  // shape the GET handler builds for the view, so the input names match.
  const liveQ = getSystemItems('risk_toolbox', RA_QUESTIONS.map(q => ({
    item_key: q.key, response_type: q.type, options: q.options,
  })))
    .filter(it => !['heading','information','hyperlink','media','signature'].includes(it.response_type))
    .map(it => {
      let type = 'text';
      if (it.response_type === 'multiple_choice') {
        type = (it.options && it.options.multi) ? 'checkbox' : 'radio';
      } else if (it.response_type === 'checkbox')               type = 'checkbox';
      else if (it.response_type === 'textarea')                 type = 'textarea';
      else if (it.response_type === 'number' || it.response_type === 'measurement') type = 'number';
      else if (it.response_type === 'radio' || it.response_type === 'yes_no_na' ||
               it.response_type === 'pass_fail' || it.response_type === 'ok_notok_na') type = 'radio';
      return { key: it.item_key, type };
    });
  const answers = {};
  for (const q of liveQ) {
    const raw = body['q_' + q.key];
    if (q.type === 'checkbox') {
      answers[q.key] = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
    } else if (q.type === 'number') {
      answers[q.key] = raw === '' || raw == null ? null : Number(raw);
    } else {
      answers[q.key] = (raw || '').toString().trim();
    }
  }

  const data = {
    answers,
    notes: (body.notes || '').trim(),
  };

  const raResult = db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, booking_id, allocation_date, shift_key, data, signature_data, signed_name, status, submitted_at)
    VALUES (?, 'risk_toolbox', ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))
  `).run(
    worker.id,
    allocation ? allocation.job_id : null,
    allocation ? allocation.id : null,
    allocation ? allocation.booking_id : null,
    allocation ? allocation.allocation_date : null,
    computeShiftKey(db, allocation),
    JSON.stringify(data),
    body.signature_data || null,
    answers.employee_name || worker.full_name || null,
  );
  fireOpsNotification(db, raResult.lastInsertRowid);

  req.flash('success', 'Risk Assessment & Toolbox submitted.');
  if (allocation) return req.session.save(() => res.redirect('/w/jobs/' + allocation.id + '?tab=forms'));
  return req.session.save(() => res.redirect('/w/forms'));
});

// ============================================
// TC PRESTART DECLARATION — Traffio "3. Traffic Controller Prestart Declaration"
// ============================================
// SWMS_OPTIONS is declared higher up (above RA_QUESTIONS) so both forms
// share the same canonical list.

router.get('/forms/tc-prestart', (req, res) => {
  const allocation = requireAllocation(req, res);
  if (!allocation) return;

  res.render('worker/forms/tc-prestart', {
    title: 'TC Prestart Declaration',
    currentPage: 'forms',
    allocation,
    swmsOptions: SWMS_OPTIONS,
  });
});

router.post('/forms/tc-prestart', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const body = req.body || {};
  const allocationId = body.allocation_id ? Number(body.allocation_id) : null;

  let allocation = null;
  if (allocationId) {
    allocation = db.prepare('SELECT id, job_id, booking_id, allocation_date FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(allocationId, worker.id);
    if (!allocation) {
      req.flash('error', 'Allocation not found or not yours.');
      return req.session.save(() => res.redirect('/w/forms/tc-prestart'));
    }
  }

  const data = {
    swms: (body.swms || '').trim(),
    confirm_toolbox: body.confirm_toolbox === 'yes',
    confirm_radio: body.confirm_radio === 'yes',
    radio_channel: (body.radio_channel || '').trim(),
    confirm_assembly: body.confirm_assembly === 'yes',
    assembly_point: (body.assembly_point || '').trim(),
    declaration_acknowledged: body.declaration_acknowledged === '1',
    notes: (body.notes || '').trim(),
  };

  const tcResult = db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, booking_id, allocation_date, shift_key, data, signature_data, signed_name, status, submitted_at)
    VALUES (?, 'tc_prestart', ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))
  `).run(
    worker.id,
    allocation ? allocation.job_id : null,
    allocation ? allocation.id : null,
    allocation ? allocation.booking_id : null,
    allocation ? allocation.allocation_date : null,
    computeShiftKey(db, allocation),
    JSON.stringify(data),
    body.signature_data || null,
    (body.signed_name || worker.full_name || '').trim() || null,
  );
  fireOpsNotification(db, tcResult.lastInsertRowid);

  req.flash('success', 'TC Prestart Declaration submitted.');
  if (allocation) return req.session.save(() => res.redirect('/w/jobs/' + allocation.id + '?tab=forms'));
  return req.session.save(() => res.redirect('/w/forms'));
});

// ============================================
// POST-SHIFT VEHICLE CHECKLIST — Traffio "5. Post Shift Vehicle Checklist"
// ============================================

router.get('/forms/post-shift-vehicle', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const allocation = requireAllocation(req, res);
  if (!allocation) return;

  // Suggest the vehicle the worker used on their most recent vehicle pre-start
  // today — most workers stay on the same vehicle for the day.
  let suggestedVehicle = '';
  try {
    const recent = db.prepare(`
      SELECT data FROM safety_forms
      WHERE crew_member_id = ? AND form_type = 'vehicle_prestart'
        AND date(submitted_at) = date('now')
      ORDER BY submitted_at DESC LIMIT 1
    `).get(worker.id);
    if (recent && recent.data) suggestedVehicle = (JSON.parse(recent.data) || {}).vehicle || '';
  } catch (_) { /* best effort */ }

  // Per-vehicle entry (same contract as the pre-start): ?vehicleId= wins
  // over the last-prestart suggestion and carries through a hidden input.
  let prefillVehicle = null, bookingVehicleId = null;
  if (req.query.vehicleId && allocation && allocation.booking_id) {
    const bv = db.prepare('SELECT id, vehicle_name, registration FROM booking_vehicles WHERE id = ? AND booking_id = ?')
      .get(Number(req.query.vehicleId) || 0, allocation.booking_id);
    if (bv) {
      bookingVehicleId = bv.id;
      prefillVehicle = bv.vehicle_name || bv.registration || '';
    }
  }

  res.render('worker/forms/post-shift-vehicle', {
    title: 'Post-Shift Vehicle Checklist',
    currentPage: 'forms',
    allocation,
    suggestedVehicle,
    prefillVehicle,
    bookingVehicleId,
  });
});

router.post('/forms/post-shift-vehicle', photoUpload.fields([
  { name: 'fuel_gauge_photos',  maxCount: 2 },
  { name: 'interior_photos',    maxCount: 6 },
  { name: 'equipment_photos',   maxCount: 6 },
  { name: 'arrow_board_photos', maxCount: 6 },
]), async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const body = req.body || {};
  const allocationId = body.allocation_id ? Number(body.allocation_id) : null;

  let allocation = null;
  if (allocationId) {
    allocation = db.prepare('SELECT id, job_id, booking_id, allocation_date FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(allocationId, worker.id);
    if (!allocation) {
      req.flash('error', 'Allocation not found or not yours.');
      return req.session.save(() => res.redirect('/w/forms/post-shift-vehicle'));
    }
    // Note: T&S crews don't use a clock in/out flow — the post-shift
    // vehicle checklist is filed at end of shift on its own merit, so we
    // don't gate it on clock_events.
  }

  const data = {
    vehicle: (body.vehicle || '').trim(),
    driver_name: (body.driver_name || worker.full_name || '').trim(),
    odo_end_km: body.odo_end_km ? Number(body.odo_end_km) : null,
    signs_left_behind: (body.signs_left_behind || '').trim(),
    equipment_damaged_lost: (body.equipment_damaged_lost || '').trim(),
    vehicle_issues: (body.vehicle_issues || '').trim(),
  };

  // Per-vehicle attribution, same contract as the pre-start: hidden
  // booking_vehicle_id from the Forms tab, re-validated, NULL on staleness.
  let vehicleId = null;
  if (allocation && allocation.booking_id && body.booking_vehicle_id) {
    const bv = db.prepare('SELECT id FROM booking_vehicles WHERE id = ? AND booking_id = ?')
      .get(Number(body.booking_vehicle_id) || 0, allocation.booking_id);
    if (bv) vehicleId = bv.id;
  }

  const result = db.prepare(`
    INSERT INTO safety_forms (crew_member_id, form_type, job_id, allocation_id, booking_id, allocation_date, shift_key, vehicle_id, data, status, submitted_at)
    VALUES (?, 'post_shift_vehicle', ?, ?, ?, ?, ?, ?, ?, 'submitted', datetime('now'))
  `).run(
    worker.id,
    allocation ? allocation.job_id : null,
    allocation ? allocation.id : null,
    allocation ? allocation.booking_id : null,
    allocation ? allocation.allocation_date : null,
    computeShiftKey(db, allocation),
    vehicleId,
    JSON.stringify(data),
  );
  const safetyFormId = result.lastInsertRowid;

  // Flatten { fuel_gauge_photos: [...], interior_photos: [...], ... } into
  // one [{ ...file, fieldname }] array so persistFormPhotos can tag each.
  const allFiles = [];
  for (const key of Object.keys(req.files || {})) {
    for (const f of req.files[key]) allFiles.push({ ...f, fieldname: key });
  }
  try {
    await persistFormPhotos(db, safetyFormId, allFiles, (field) => {
      if (field === 'fuel_gauge_photos') return 'fuel_gauge';
      if (field === 'interior_photos') return 'interior';
      if (field === 'equipment_photos') return 'equipment_cage';
      if (field === 'arrow_board_photos') return 'arrow_board';
      return 'other';
    });
  } catch (e) {
    console.error('[post-shift-vehicle] photo persist error:', e.message);
  }

  fireOpsNotification(db, safetyFormId);

  req.flash('success', 'Post-Shift Vehicle Checklist submitted.');
  if (allocation) return req.session.save(() => res.redirect('/w/jobs/' + allocation.id + '?tab=forms'));
  return req.session.save(() => res.redirect('/w/forms'));
});

// ============================================
// TEAM LEADER CHECKLIST — Traffio "4. Team Leader Checklist"
// ============================================

const PPE_ITEMS = [
  { key: 'hi_vis_pants', label: 'Double Stripe Hi Vis Pants (Navy day / White night)' },
  { key: 'hi_vis_shirt', label: 'Double Stripe Hi Vis Shirt / Jacket' },
  { key: 'steel_cap',    label: 'Steel Cap Boots' },
  { key: 'hard_hat',     label: 'Hard Hat' },
  { key: 'radio',        label: 'Radio' },
  { key: 'night_wands',  label: 'Night Wands (Nights only — N/A for day shift)' },
];

// Team Leader Checklist is open to every worker on the shift — anyone can
// be acting as TL on the day. The form itself shows an amber "you're not
// flagged as TL" hint when a non-TL opens it (see the isManager flag in
// views/worker/forms/team-leader.ejs).
const { hasPortalRole } = require('../../middleware/workerAuth');

router.get('/forms/team-leader', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const allocation = requireAllocation(req, res);
  if (!allocation) return;

  const me = db.prepare('SELECT portal_role FROM crew_members WHERE id = ?').get(worker.id);
  const isManager = !!(me && hasPortalRole(me.portal_role, 'team_leader'));

  // Resolve from system template; fall back to PPE_ITEMS so the form
  // always renders even if migration 151 hasn't run yet. From migration
  // 272 onwards, the team_leader template carries the whole worker
  // form (name + workers-present + photos + PPE + setup + signature) —
  // but only the PPE-section rows drive the per-worker yes/no list
  // here, so filter to those. If the admin template has no PPE rows
  // (custom edit) fall back to the hardcoded PPE_ITEMS.
  const sysAll = getSystemItems('team_leader', []);
  const sysPPE = sysAll.filter(i => /PPE/i.test(i.section || ''));
  const ppeItems = (sysPPE.length ? sysPPE : PPE_ITEMS.map(i => ({ item_key: i.key, question: i.label }))).map(toSimpleItem);

  // Team draft: if anyone on this shift has saved a draft, surface it so
  // the worker can resume + add their own photos / answers on top.
  const shiftKey = computeShiftKey(db, allocation);
  const draft = findTeamDraft(db, shiftKey, 'team_leader', allocation ? allocation.id : null);
  let draftData = null, draftPhotos = [];
  if (draft) {
    try { draftData = JSON.parse(draft.data || '{}'); } catch (e) { draftData = {}; }
    draftPhotos = getDraftPhotos(db, draft.id);
  }

  res.render('worker/forms/team-leader', {
    title: 'Team Leader Checklist',
    currentPage: 'forms',
    allocation,
    ppeItems,
    isManager,
    draft,
    draftData,
    draftPhotos,
  });
});

router.post('/forms/team-leader', withPhotoUploadError([
  { name: 'team_photos',  maxCount: 8 },
  { name: 'setup_photos', maxCount: 10 },
]), async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const body = req.body || {};
  const allocationId = body.allocation_id ? Number(body.allocation_id) : null;
  const isSaveDraft = body.save_as_draft === '1';

  let allocation = null;
  if (allocationId) {
    allocation = db.prepare(`
      SELECT id, job_id, booking_id, allocation_date
      FROM crew_allocations WHERE id = ? AND crew_member_id = ?
    `).get(allocationId, worker.id);
    if (!allocation) {
      req.flash('error', "We couldn't match this shift to you — please reopen it from your Jobs list.");
      return req.session.save(() => res.redirect('/w/forms/team-leader'));
    }
  }

  const ppe = {};
  // Pull PPE list from the live system template so admin-renamed
  // items still capture cleanly. Only PPE-section rows count; the rest
  // of the team_leader template carries name/photos/signature fields
  // (see migration 272). Fall back to hardcoded PPE_ITEMS if nothing.
  const liveAll = getSystemItems('team_leader', []);
  const liveSysPPE = liveAll.filter(i => /PPE/i.test(i.section || ''));
  const livePPE = liveSysPPE.length ? liveSysPPE : PPE_ITEMS.map(i => ({ item_key: i.key }));
  for (const it of livePPE) ppe[it.item_key] = body['ppe_' + it.item_key] === 'yes';

  const data = {
    team_leader_name: (body.team_leader_name || worker.full_name || '').trim(),
    workers_present: body.workers_present === 'yes',
    late_notes: (body.late_notes || '').trim(),
    ppe,
    setup_correct: body.setup_correct === 'yes',
    notes: (body.notes || '').trim(),
  };

  // Server-side validation for SUBMIT only. Drafts can have any state — that's
  // the point of saving partial progress. We list every missing field in one
  // message so the worker doesn't have to fix them one at a time.
  const shiftKey = computeShiftKey(db, allocation);
  const existingDraft = findTeamDraft(db, shiftKey, 'team_leader', allocation ? allocation.id : null);

  if (!isSaveDraft) {
    const missing = [];
    if (!data.team_leader_name) missing.push("Team Leader's name");
    if (body.workers_present !== 'yes' && body.workers_present !== 'no') missing.push('whether all workers are present');
    if (body.setup_correct !== 'yes' && body.setup_correct !== 'no') missing.push('whether the setup is correct');
    if (missing.length) {
      req.flash('error', 'Checklist not submitted — please answer: ' + missing.join('; ') + '. Your other answers are kept; finish those and submit again. (Tip: tap "Save as draft" to keep your progress while you sort the rest.)');
      // Best-effort: persist whatever was filled so the worker doesn't lose it.
      try {
        const draftRow = upsertDraft(db, { worker, allocation, shiftKey, formType: 'team_leader', data, signature: body.signature_data, signedName: data.team_leader_name, existingDraft });
        const allFiles = collectMulterFiles(req);
        if (allFiles.length) await persistFormPhotos(db, draftRow.id, allFiles, tagForTeamLeader);
      } catch (e) { console.error('[team-leader] auto-draft on validation fail:', e.message); }
      return allocation ? req.session.save(() => res.redirect('/w/forms/team-leader?allocationId=' + allocation.id)) : req.session.save(() => res.redirect('/w/forms/team-leader'));
    }
  }

  // Either reuse the existing team draft (UPDATE in place — keeps photos) or
  // INSERT a new row. Submitting transitions an existing draft → submitted.
  const draftRow = upsertDraft(db, {
    worker, allocation, shiftKey, formType: 'team_leader', data,
    signature: body.signature_data, signedName: data.team_leader_name,
    existingDraft,
    finalStatus: isSaveDraft ? 'draft' : 'submitted',
  });
  const safetyFormId = draftRow.id;

  const allFiles = collectMulterFiles(req);
  try {
    await persistFormPhotos(db, safetyFormId, allFiles, tagForTeamLeader);
  } catch (e) {
    console.error('[team-leader] photo persist error:', e.message);
    if (allFiles.length) req.flash('error', "Saved everything except the photos — they failed to attach. Try uploading them again from the same form.");
  }

  if (isSaveDraft) {
    req.flash('success', existingDraft ? 'Draft updated. Your team can pick this up.' : 'Draft saved. Your team can resume it here.');
    return allocation ? req.session.save(() => res.redirect('/w/forms/team-leader?allocationId=' + allocation.id)) : req.session.save(() => res.redirect('/w/forms/team-leader'));
  }

  fireOpsNotification(db, safetyFormId);

  req.flash('success', 'Team Leader Checklist submitted.');
  if (allocation) return req.session.save(() => res.redirect('/w/jobs/' + allocation.id + '?tab=forms'));
  return req.session.save(() => res.redirect('/w/forms'));
});

function collectMulterFiles(req) {
  const out = [];
  for (const key of Object.keys(req.files || {})) {
    for (const f of req.files[key]) out.push({ ...f, fieldname: key });
  }
  return out;
}

function tagForTeamLeader(field) {
  if (field === 'team_photos') return 'team';
  if (field === 'setup_photos') return 'setup';
  return 'other';
}

// Insert or update a safety_forms row, scoped to a team shift draft. Reuses
// the existing draft when one is present so photos persist across saves and
// multiple workers contribute to the same team form. `finalStatus` controls
// whether the row ends up as 'draft' (save-as-draft) or 'submitted' (live).
function upsertDraft(db, opts) {
  const { worker, allocation, shiftKey, formType, data, signature, signedName, existingDraft, finalStatus = 'draft' } = opts;
  const dataJson = JSON.stringify(data || {});
  if (existingDraft) {
    db.prepare(`
      UPDATE safety_forms SET
        data = ?,
        signature_data = COALESCE(NULLIF(?, ''), signature_data),
        signed_name = COALESCE(NULLIF(?, ''), signed_name),
        status = ?,
        submitted_at = CASE WHEN ? = 'submitted' THEN datetime('now') ELSE submitted_at END,
        job_id = COALESCE(?, job_id),
        allocation_id = COALESCE(?, allocation_id),
        booking_id = COALESCE(?, booking_id),
        allocation_date = COALESCE(?, allocation_date),
        shift_key = COALESCE(?, shift_key)
      WHERE id = ?
    `).run(
      dataJson,
      signature || '',
      signedName || '',
      finalStatus,
      finalStatus,
      allocation ? allocation.job_id : null,
      allocation ? allocation.id : null,
      allocation ? allocation.booking_id : null,
      allocation ? allocation.allocation_date : null,
      shiftKey || null,
      existingDraft.id
    );
    return { id: existingDraft.id };
  }
  const result = db.prepare(`
    INSERT INTO safety_forms (
      crew_member_id, form_type, job_id, allocation_id, booking_id, allocation_date, shift_key,
      data, signature_data, signed_name, status, submitted_at, draft_started_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    worker.id, formType,
    allocation ? allocation.job_id : null,
    allocation ? allocation.id : null,
    allocation ? allocation.booking_id : null,
    allocation ? allocation.allocation_date : null,
    shiftKey || null,
    dataJson,
    signature || null,
    signedName || null,
    finalStatus,
    finalStatus === 'draft' ? worker.id : null
  );
  return { id: result.lastInsertRowid };
}

// GET /w/forms/history/:id/pdf — the branded PDF of a submission.
// Auth: the submitter (any status), OR a crew member of the SAME BOOKING
// (submitted forms only). The second leg exists because shift-level
// checklists (Team Leader, Risk & Toolbox) complete the shift for the
// whole crew — the Forms tab shows "Filed by <name> · View", and that
// View must work for teammates. Booking resolution: sf.booking_id when
// the handler wrote it, else via the submission's allocation. Everything
// else stays a 404 (no job-wide or org-wide leak; drafts stay private
// to their author; photo streaming stays owner-only — the PDF embeds
// photos server-side).
router.get('/forms/history/:id/pdf', async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const sf = db.prepare('SELECT id, crew_member_id, status, booking_id, allocation_id FROM safety_forms WHERE id = ?').get(req.params.id);
  if (!sf) return res.status(404).send('Not found');
  let allowed = sf.crew_member_id === worker.id;
  if (!allowed && sf.status === 'submitted') {
    let bookingId = sf.booking_id;
    if (!bookingId && sf.allocation_id) {
      const alloc = db.prepare('SELECT booking_id FROM crew_allocations WHERE id = ?').get(sf.allocation_id);
      bookingId = alloc ? alloc.booking_id : null;
    }
    if (bookingId) {
      allowed = !!db.prepare(
        "SELECT 1 FROM booking_crew WHERE booking_id = ? AND crew_member_id = ? AND status != 'declined'"
      ).get(bookingId, worker.id);
    }
  }
  if (!allowed) return res.status(404).send('Not found');
  try {
    const { renderSubmissionPdf } = require('../../services/jobPackPdf');
    const buf = await renderSubmissionPdf(db, req.params.id);
    const meta = db.prepare('SELECT form_type, submitted_at FROM safety_forms WHERE id = ?').get(req.params.id);
    const date = meta ? new Date(meta.submitted_at).toISOString().slice(0, 10) : 'submission';
    const slug = (meta && meta.form_type) ? meta.form_type : 'submission';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="TSTC_${slug}_${date}_${req.params.id}.pdf"`);
    res.send(buf);
  } catch (e) {
    console.error('[w/forms/history pdf] render failed:', e.message);
    res.status(500).send('PDF render failed');
  }
});

// GET /w/forms/photos/:photoId — Stream a safety-form photo back to the worker
// who submitted it (or to the crew member that the form belongs to).
router.get('/forms/photos/:photoId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const row = db.prepare(`
    SELECT p.*, sf.crew_member_id
    FROM safety_form_photos p
    JOIN safety_forms sf ON p.safety_form_id = sf.id
    WHERE p.id = ?
  `).get(req.params.photoId);
  if (!row || row.crew_member_id !== worker.id) return res.status(404).send('Not found');
  const abs = path.join(__dirname, '..', '..', row.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', row.mime_type || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
