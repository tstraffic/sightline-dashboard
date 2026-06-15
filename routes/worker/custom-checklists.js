/**
 * Worker portal — admin-built forms & checklists (the template engine).
 *
 * Admin authors a form on /checklists, ticks "Visible to workers" and
 * publishes a revision. The published revision shows up here for workers
 * to fill in. Submissions land in custom_checklist_responses keyed by
 * template + revision_number, so a future revision doesn't change
 * historical data. Photos for media_upload questions are stored in
 * custom_checklist_response_photos under data/uploads/custom-forms/.
 *
 * Incident-flavoured system templates (see INCIDENT_TEMPLATES) also create
 * a row in the incidents table so the admin incident pipeline keeps
 * working no matter how the office reshapes the questions.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { getDb } = require('../../db/database');

const CUSTOM_FORMS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'custom-forms');
const TMP_DIR = path.join(CUSTOM_FORMS_DIR, '_tmp');

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(TMP_DIR, `w${req.session.worker.id}_${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '.jpg') || '.jpg').toLowerCase();
    cb(null, `photo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: 12 },
  fileFilter: (req, file, cb) => {
    if (!/^image\//i.test(file.mimetype)) return cb(new Error('Images only'));
    cb(null, true);
  },
});

// system_key → default incidents.incident_type. A submission against one of
// these templates ALSO creates an incidents row, so worker reports keep
// flowing into the existing admin investigation pipeline. Well-known
// item_keys (title, description, location, severity, incident_type) are
// pulled out of the answers when present; everything else degrades
// gracefully so admins can reshape the questions without breaking it.
const INCIDENT_TEMPLATES = {
  incident_report: 'other',
  vehicle_incident: 'vehicle',
  bullying_harassment: 'other',
  near_miss: 'near_miss',
};

function slugify(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, '_'); }

// Build { item_key: answerValue } from the revision's items + answers keyed
// by item id, so the incident extraction works on stable keys.
function answersByItemKey(items, answers) {
  const out = {};
  items.forEach(it => {
    if (!it.item_key) return;
    const v = answers[String(it.id)];
    if (v !== undefined) out[it.item_key] = Array.isArray(v) ? v.join(', ') : v;
  });
  return out;
}

function maybeCreateIncident(db, template, items, answers, worker) {
  const defaultType = INCIDENT_TEMPLATES[template.system_key];
  if (!defaultType) return null;
  const byKey = answersByItemKey(items, answers);

  const VALID_TYPES = ['injury', 'near_miss', 'property_damage', 'environmental', 'vehicle', 'hazard', 'other'];
  const VALID_SEV = ['low', 'medium', 'high', 'critical'];
  const rawType = slugify(byKey.incident_type);
  const incidentType = VALID_TYPES.includes(rawType) ? rawType : defaultType;
  const rawSev = slugify(byKey.severity);
  const severity = VALID_SEV.includes(rawSev) ? rawSev
    : template.system_key === 'bullying_harassment' ? 'high' : 'medium';

  const title = byKey.title || `${template.name} — ${worker.full_name}`;
  const description = byKey.description ||
    items.filter(it => answers[String(it.id)] !== undefined)
      .map(it => `${it.question}: ${Array.isArray(answers[String(it.id)]) ? answers[String(it.id)].join(', ') : answers[String(it.id)]}`)
      .join('\n');

  const count = db.prepare('SELECT COUNT(*) as c FROM incidents').get().c;
  const incidentNumber = 'INC-' + String(count + 1).padStart(4, '0');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  try {
    db.prepare(`
      INSERT INTO incidents (incident_number, incident_type, severity, title, description, location, incident_date, investigation_status, reported_by_crew_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reported', ?)
    `).run(incidentNumber, incidentType, severity, title, description, byKey.location || null, today, worker.id);
  } catch (e) {
    // Legacy schema without reported_by_crew_id (pre-migration 266 deploys).
    db.prepare(`
      INSERT INTO incidents (incident_number, incident_type, severity, title, description, location, incident_date, investigation_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reported')
    `).run(incidentNumber, incidentType, severity, title, description, byKey.location || null, today);
  }
  return incidentNumber;
}

// Parse a revision's items_json into normalized items (options object ready).
function revisionItems(rev) {
  let items = [];
  try { items = JSON.parse(rev.items_json || '[]'); } catch (e) { items = []; }
  items.forEach(function (it) {
    if (it.options_json && typeof it.options_json === 'string') {
      try { it.options = JSON.parse(it.options_json); } catch (e) { it.options = null; }
    } else if (it.options && typeof it.options === 'object' && !Array.isArray(it.options)) {
      // already an object — leave it
    } else if (Array.isArray(it.options)) {
      it.options = { options: it.options };
    }
  });
  return items;
}

// GET /w/forms/custom — list templates available to fill in
router.get('/forms/custom', (req, res) => {
  const db = getDb();
  let templates = [];
  try {
    templates = db.prepare(`
      SELECT t.id, t.name, t.description, t.published_revision, t.require_signature, t.require_photo,
        (SELECT COUNT(*) FROM custom_checklist_responses r WHERE r.template_id = t.id AND r.crew_member_id = ?) AS my_submissions
      FROM checklist_templates t
      WHERE t.worker_visible = 1
        AND t.status = 'active'
        AND t.published_revision IS NOT NULL
        AND t.published_revision > 0
      ORDER BY t.sort_order ASC, t.name ASC
    `).all(req.session.worker.id);
  } catch (e) { /* migration 150 not yet applied */ }

  res.render('worker/forms-custom', {
    title: 'Custom Checklists',
    currentPage: 'forms',
    templates,
  });
});

// GET /w/forms/custom/:id — fill-in form for the latest published revision
router.get('/forms/custom/:id', (req, res) => {
  const db = getDb();
  const template = db.prepare(`
    SELECT id, name, description, published_revision, worker_visible, status, require_signature, require_photo
    FROM checklist_templates WHERE id = ?
  `).get(req.params.id);
  if (!template || !template.worker_visible || template.status !== 'active' || !template.published_revision) {
    req.flash('error', 'Checklist is not available.');
    return res.redirect('/w/forms');
  }
  const rev = db.prepare(`
    SELECT * FROM checklist_template_revisions WHERE template_id = ? AND revision_number = ?
  `).get(template.id, template.published_revision);
  if (!rev) {
    req.flash('error', 'Published revision missing.');
    return res.redirect('/w/forms');
  }
  const items = revisionItems(rev);

  // Group items by section so the form reads as a structured doc.
  const sections = [];
  const byKey = {};
  items.forEach(it => {
    const key = it.section || '';
    if (!byKey[key]) { byKey[key] = { name: key, items: [] }; sections.push(byKey[key]); }
    byKey[key].items.push(it);
  });

  // Optional ?allocationId= so the submission can be linked to a shift.
  const allocationId = req.query.allocationId ? Number(req.query.allocationId) : null;
  let allocation = null;
  if (allocationId) {
    allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(allocationId, req.session.worker.id);
  }

  res.render('worker/forms-custom-fill', {
    title: template.name,
    currentPage: 'forms',
    template, revision: rev, sections, allocation,
  });
});

// POST /w/forms/custom/:id — accept a submission against the latest revision
router.post('/forms/custom/:id', photoUpload.any(), async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const template = db.prepare(`
    SELECT id, name, system_key, worker_visible, status, published_revision, require_signature
    FROM checklist_templates WHERE id = ?
  `).get(req.params.id);
  if (!template || !template.worker_visible || template.status !== 'active' || !template.published_revision) {
    req.flash('error', 'Checklist is not available.');
    return res.redirect('/w/forms');
  }

  const allocationId = req.body.allocation_id ? Number(req.body.allocation_id) : null;
  const bookingId    = req.body.booking_id    ? Number(req.body.booking_id)    : null;
  const signature    = req.body.signature_data || null;

  if (template.require_signature && !signature) {
    req.flash('error', 'Signature is required for this checklist.');
    return res.redirect(`/w/forms/custom/${template.id}` + (allocationId ? `?allocationId=${allocationId}` : ''));
  }

  // Pick out keys named "answer_<itemId>" → build answers JSON.
  const answers = {};
  Object.keys(req.body || {}).forEach(k => {
    if (!k.startsWith('answer_')) return;
    const id = k.slice('answer_'.length).replace(/\[\]$/, '');
    answers[id] = req.body[k];
  });

  const result = db.prepare(`
    INSERT INTO custom_checklist_responses
      (template_id, revision_number, crew_member_id, allocation_id, booking_id, answers_json, signature_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(template.id, template.published_revision, worker.id, allocationId, bookingId, JSON.stringify(answers), signature);
  const responseId = result.lastInsertRowid;

  // Persist photos for media_upload questions (field name answer_<itemId>).
  const files = (req.files || []).filter(f => f.fieldname.startsWith('answer_'));
  if (files.length) {
    const homeDir = path.join(CUSTOM_FORMS_DIR, String(responseId));
    fs.mkdirSync(homeDir, { recursive: true });
    const insertPhoto = db.prepare(`
      INSERT INTO custom_checklist_response_photos (response_id, item_id, file_path, original_name, mime_type, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const f of files) {
      const itemId = f.fieldname.slice('answer_'.length).replace(/\[\]$/, '');
      const finalPath = path.join(homeDir, path.basename(f.path));
      try {
        const buf = await sharp(f.path).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
        fs.writeFileSync(finalPath, buf);
        fs.unlinkSync(f.path);
        insertPhoto.run(responseId, itemId, path.relative(path.join(__dirname, '..', '..'), finalPath), f.originalname || '', 'image/jpeg', buf.length);
      } catch (e) {
        console.error('[custom-forms] photo resize failed, raw copy:', e.message);
        try { fs.renameSync(f.path, finalPath); } catch (_) {}
        const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : { size: 0 };
        insertPhoto.run(responseId, itemId, path.relative(path.join(__dirname, '..', '..'), finalPath), f.originalname || '', f.mimetype || '', stat.size);
      }
    }
    try { fs.rmSync(path.dirname(files[0].path), { recursive: true, force: true }); } catch (_) {}
  }

  // Incident-flavoured templates also feed the incidents pipeline.
  let incidentNumber = null;
  try {
    const rev = db.prepare('SELECT items_json FROM checklist_template_revisions WHERE template_id = ? AND revision_number = ?')
      .get(template.id, template.published_revision);
    if (rev) incidentNumber = maybeCreateIncident(db, template, revisionItems(rev), answers, worker);
  } catch (e) { console.error('[custom-forms] incident create failed:', e.message); }

  req.flash('success', incidentNumber ? `${template.name} submitted — reference ${incidentNumber}.` : `${template.name} submitted.`);
  if (allocationId) return res.redirect('/w/jobs/' + allocationId + '?tab=forms');
  res.redirect('/w/forms');
});

// GET /w/forms/custom/photos/:photoId — stream a photo from one of the
// worker's own submissions.
router.get('/forms/custom/photos/:photoId', (req, res) => {
  const db = getDb();
  const photo = db.prepare(`
    SELECT p.*, r.crew_member_id FROM custom_checklist_response_photos p
    JOIN custom_checklist_responses r ON r.id = p.response_id
    WHERE p.id = ?
  `).get(req.params.photoId);
  if (!photo || photo.crew_member_id !== req.session.worker.id) return res.status(404).send('Not found');
  const abs = path.join(__dirname, '..', '..', photo.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('Not found');
  res.type(photo.mime_type || 'image/jpeg');
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
