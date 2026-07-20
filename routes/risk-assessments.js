// /risk-assessments — Risk Assessment register (templates + job-linked docs).
// Mirrors the SWMS module 1:1 — templates renew every 3 months, job-linked
// renew every 6 months, expiry reminders share the same notifier loop.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { autoLogDiary } = require('../lib/diary');
const tgsTemplate = require('../lib/raTemplates/tgsRiskOptions');
const { mergePdfs } = require('../lib/pdfMerge');

const RA_DIR = path.join(__dirname, '..', 'data', 'uploads', 'risk-assessments');
if (!fs.existsSync(RA_DIR)) fs.mkdirSync(RA_DIR, { recursive: true });

const raStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, RA_DIR),
  filename: (req, file, cb) => {
    const stamp = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, stamp + path.extname(file.originalname));
  }
});
const raUpload = multer({
  storage: raStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx?|xlsx?|jpg|jpeg|png)$/i.test(file.originalname);
    cb(null, ok);
  }
});

const KIND_LABELS = { template: 'Template', job: 'Job-linked' };
const STATUS_LABELS = { draft: 'Draft', active: 'Active', archived: 'Archived' };
const STATUS_VALUES = ['draft', 'active', 'archived'];
const KIND_VALUES = ['template', 'job'];
const CYCLE_MONTHS = { template: 3, job: 6 };

function defaultExpiryFor(kind, baseDate = new Date()) {
  const months = CYCLE_MONTHS[kind] || 6;
  const d = new Date(baseDate.getTime());
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function loadFormChoices(db) {
  return {
    jobs: db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all(),
    users: db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all(),
  };
}

// GET /risk-assessments — register list (split into Templates + Job-linked sections)
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id } = req.query;
  let where = '1=1';
  const params = [];
  if (status && STATUS_VALUES.includes(status)) { where += ' AND s.status = ?'; params.push(status); }
  if (job_id) { where += ' AND s.job_id = ?'; params.push(parseInt(job_id, 10) || 0); }

  const sql = `
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM risk_assessments s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE ${where}
    ORDER BY s.created_at DESC
  `;
  const all = db.prepare(sql).all(...params);
  const templates = all.filter(r => r.kind === 'template');
  const jobLinked = all.filter(r => r.kind === 'job');

  const counts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN kind = 'template' THEN 1 ELSE 0 END) AS templates,
      SUM(CASE WHEN kind = 'job'      THEN 1 ELSE 0 END) AS job_linked,
      SUM(CASE WHEN status = 'draft'  THEN 1 ELSE 0 END) AS drafts,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date < date('now')      THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date BETWEEN date('now') AND date('now','+30 days') THEN 1 ELSE 0 END) AS expiring_soon
    FROM risk_assessments
  `).get();

  res.render('risk-assessments/index', {
    title: 'Risk Assessment Register', currentPage: 'risk-assessments',
    templates, jobLinked, counts,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    filters: { status: status || 'all', job_id: job_id || '' },
  });
});

// GET /risk-assessments/new — create form
router.get('/new', (req, res) => {
  const db = getDb();
  const choices = loadFormChoices(db);
  res.render('risk-assessments/form', {
    title: 'New Risk Assessment', currentPage: 'risk-assessments',
    ra: null, isEdit: false,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: req.query.job_id || '',
    prefillKind: req.query.kind === 'template' ? 'template' : 'job',
    ...choices,
  });
});

// POST /risk-assessments — create (with optional file)
router.post('/', raUpload.single('ra_file'), (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return req.session.save(() => res.redirect('/risk-assessments/new'));
    }
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : 'job';
    const filePath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/') : '';
    const fileName = req.file ? req.file.originalname : '';
    let status = STATUS_VALUES.includes(b.status) ? b.status : (filePath ? 'active' : 'draft');

    const expiryDate = (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) ? b.expiry_date : defaultExpiryFor(kind);
    const r = db.prepare(`
      INSERT INTO risk_assessments (title, description, kind, status, job_id, owner_id, file_path, file_original_name, notes, expiry_date, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title,
      String(b.description || '').trim(),
      kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      req.session.user ? req.session.user.id : null
    );
    try { logActivity({ user: req.session.user, action: 'create', entityType: 'risk_assessment', entityId: r.lastInsertRowid, entityLabel: title, details: kind, ip: req.ip }); } catch (e) {}
    req.flash('success', kind === 'template' ? 'Risk Assessment template imported.' : 'Risk Assessment created.');
    return req.session.save(() => res.redirect('/risk-assessments/' + r.lastInsertRowid));
  } catch (err) {
    console.error('[risk-assessments POST]', err);
    req.flash('error', 'Could not create Risk Assessment: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/risk-assessments/new'));
  }
});

// GET /risk-assessments/:id — detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const ra = db.prepare(`
    SELECT s.*, j.job_number, j.project_name, j.client,
      u.full_name AS owner_name, cu.full_name AS created_by_name
    FROM risk_assessments s
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = s.owner_id
    LEFT JOIN users cu ON cu.id = s.created_by_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!ra) { req.flash('error', 'Risk Assessment not found.'); return req.session.save(() => res.redirect('/risk-assessments')); }
  res.render('risk-assessments/show', {
    title: ra.title, currentPage: 'risk-assessments',
    ra,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
  });
});

// GET /risk-assessments/:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
  if (!ra) { req.flash('error', 'Risk Assessment not found.'); return req.session.save(() => res.redirect('/risk-assessments')); }
  const choices = loadFormChoices(db);
  res.render('risk-assessments/form', {
    title: 'Edit Risk Assessment', currentPage: 'risk-assessments',
    ra, isEdit: true,
    kindLabels: KIND_LABELS, statusLabels: STATUS_LABELS,
    prefillJobId: '', prefillKind: ra.kind,
    ...choices,
  });
});

// POST /risk-assessments/:id — update (file optional; replaces if uploaded)
router.post('/:id', raUpload.single('ra_file'), (req, res) => {
  try {
    const db = getDb();
    const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
    if (!ra) { req.flash('error', 'Risk Assessment not found.'); return req.session.save(() => res.redirect('/risk-assessments')); }
    const b = req.body;
    const title = String(b.title || '').trim() || ra.title;
    const kind = KIND_VALUES.includes(b.kind) ? b.kind : ra.kind;
    let filePath = ra.file_path;
    let fileName = ra.file_original_name;
    if (req.file) {
      filePath = path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/');
      fileName = req.file.originalname;
    }
    const status = STATUS_VALUES.includes(b.status) ? b.status : ra.status;
    let expiryDate = ra.expiry_date;
    if (b.expiry_date === '') {
      expiryDate = defaultExpiryFor(kind);
    } else if (b.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(b.expiry_date)) {
      expiryDate = b.expiry_date;
    }
    const expiryChanged = String(expiryDate || '') !== String(ra.expiry_date || '');
    db.prepare(`
      UPDATE risk_assessments SET title = ?, description = ?, kind = ?, status = ?, job_id = ?, owner_id = ?,
        file_path = ?, file_original_name = ?, notes = ?, expiry_date = ?,
        last_reminded_at = CASE WHEN ? = 1 THEN NULL ELSE last_reminded_at END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, String(b.description || '').trim(), kind, status,
      kind === 'job' ? (parseInt(b.job_id, 10) || null) : null,
      b.owner_id ? (parseInt(b.owner_id, 10) || null) : null,
      filePath, fileName,
      String(b.notes || '').trim(),
      expiryDate,
      expiryChanged ? 1 : 0,
      ra.id
    );
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'risk_assessment', entityId: ra.id, entityLabel: title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'Risk Assessment updated.');
    return req.session.save(() => res.redirect('/risk-assessments/' + ra.id));
  } catch (err) {
    console.error('[risk-assessments PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return req.session.save(() => res.redirect('/risk-assessments/' + req.params.id + '/edit'));
  }
});

// GET /risk-assessments/:id/file — auth-gated download
router.get('/:id/file', (req, res) => {
  const db = getDb();
  const ra = db.prepare("SELECT file_path, file_original_name FROM risk_assessments WHERE id = ?").get(req.params.id);
  if (!ra || !ra.file_path) { req.flash('error', 'No file attached.'); return req.session.save(() => res.redirect('/risk-assessments/' + req.params.id)); }
  const abs = path.join(__dirname, '..', ra.file_path);
  if (!fs.existsSync(abs)) { req.flash('error', 'File missing on disk.'); return req.session.save(() => res.redirect('/risk-assessments/' + req.params.id)); }
  return res.download(abs, ra.file_original_name || path.basename(abs));
});

// POST /risk-assessments/:id/delete
router.post('/:id/delete', (req, res) => {
  try {
    const db = getDb();
    const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
    if (!ra) { req.flash('error', 'Risk Assessment not found.'); return req.session.save(() => res.redirect('/risk-assessments')); }
    db.prepare("DELETE FROM risk_assessments WHERE id = ?").run(ra.id);
    try { logActivity({ user: req.session.user, action: 'delete', entityType: 'risk_assessment', entityId: ra.id, entityLabel: ra.title, details: '', ip: req.ip }); } catch (e) {}
    req.flash('success', 'Risk Assessment deleted.');
    return req.session.save(() => res.redirect('/risk-assessments'));
  } catch (err) {
    console.error('[risk-assessments DELETE]', err);
    req.flash('error', 'Delete failed.');
    return req.session.save(() => res.redirect('/risk-assessments'));
  }
});

// ===== TGS Risk & Options Assessment — interactive form + combined PDF =====

// Load an RA plus its linked compliance sub-plan, parent Plan, and job
// in a single shot. Returns null if the RA isn't of template_type
// 'tgs_risk_options'.
function loadTgsContext(db, raId) {
  const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(raId);
  if (!ra) return null;
  if (ra.template_type !== 'tgs_risk_options') return { ra, sub: null, parent: null, job: null, fallback: true };
  let sub = null, parent = null, job = null;
  if (ra.compliance_id) {
    sub = db.prepare("SELECT * FROM compliance WHERE id = ?").get(ra.compliance_id);
    if (sub && sub.parent_id) parent = db.prepare("SELECT * FROM compliance WHERE id = ?").get(sub.parent_id);
  }
  if (ra.job_id) job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(ra.job_id);
  return { ra, sub, parent, job };
}

// GET /risk-assessments/:id/fill — render the TGS RA form. Falls through
// to the legacy edit page for any other template_type / NULL.
router.get('/:id/fill', (req, res) => {
  const db = getDb();
  const ctx = loadTgsContext(db, req.params.id);
  if (!ctx) { req.flash('error', 'Risk Assessment not found.'); return req.session.save(() => res.redirect('/risk-assessments')); }
  if (ctx.fallback) return req.session.save(() => res.redirect('/risk-assessments/' + req.params.id + '/edit'));

  let responses = {};
  if (ctx.ra.responses_json) {
    try { responses = JSON.parse(ctx.ra.responses_json); } catch (e) { responses = {}; }
  }
  // First-time-open prefill: take what we can from the sub-plan + job so
  // the user doesn't retype obvious context.
  if (!ctx.ra.responses_json) {
    responses.site = responses.site || {};
    if (ctx.job) {
      responses.site.suburb = responses.site.suburb || ctx.job.suburb || '';
      responses.site.road = responses.site.road || ctx.job.site_address || '';
      responses.site.client_principal = responses.site.client_principal || ctx.job.client || '';
    }
    if (ctx.sub) responses.site.tgs_design_no = responses.site.tgs_design_no || ctx.sub.reference_number || '';
    responses.sign_off = responses.sign_off || {};
    responses.sign_off.tgs_ref_no = responses.sign_off.tgs_ref_no || (ctx.sub && ctx.sub.reference_number) || '';
  }

  res.render('risk-assessments/fill-tgs', {
    title: ctx.ra.title || 'Risk Assessment',
    ra: ctx.ra, sub: ctx.sub, parent: ctx.parent, job: ctx.job, responses,
    questions: tgsTemplate.QUESTIONS,
    matrixHeaders: tgsTemplate.MATRIX_HEADERS,
    matrixRows: tgsTemplate.MATRIX_ROWS,
    actionLevels: tgsTemplate.ACTION_LEVELS,
    ratingOptions: tgsTemplate.RATING_OPTIONS,
    user: req.session.user,
  });
});

// POST /risk-assessments/:id/fill — accept form payload, serialise into
// responses_json, flip status draft → active.
router.post('/:id/fill', (req, res) => {
  const db = getDb();
  const ra = db.prepare("SELECT * FROM risk_assessments WHERE id = ?").get(req.params.id);
  if (!ra) { req.flash('error', 'Risk Assessment not found.'); return req.session.save(() => res.redirect('/risk-assessments')); }
  if (ra.template_type !== 'tgs_risk_options') return req.session.save(() => res.redirect('/risk-assessments/' + req.params.id + '/edit'));

  const b = req.body || {};
  // Build answers map for the canonical question list. Each row carries
  // { yn, desc, rating } keyed by question number.
  const answers = {};
  tgsTemplate.QUESTIONS.forEach(q => {
    answers[q.number] = {
      yn: (b['yn_' + q.number] === 'yes' || b['yn_' + q.number] === 'no') ? b['yn_' + q.number] : '',
      desc: String(b['desc_' + q.number] || '').trim(),
      rating: String(b['rating_' + q.number] || '').trim(),
    };
  });
  // Section 4 free rows + risk-management rows arrive as parallel arrays
  // (HTML multi-row inputs). Filter blank rows so the JSON stays tight.
  const section4 = [];
  const s4Qs = [].concat(b.section4_question || []);
  const s4Yn = [].concat(b.section4_yn || []);
  const s4Desc = [].concat(b.section4_desc || []);
  const s4Rate = [].concat(b.section4_rating || []);
  for (let i = 0; i < s4Qs.length; i++) {
    const row = { question: String(s4Qs[i] || '').trim(), yn: String(s4Yn[i] || ''), desc: String(s4Desc[i] || '').trim(), rating: String(s4Rate[i] || '') };
    if (row.question || row.desc) section4.push(row);
  }
  const riskMgmt = [];
  const rmH = [].concat(b.rm_hazard || []);
  const rmC = [].concat(b.rm_controls || []);
  const rmR = [].concat(b.rm_remaining || []);
  for (let i = 0; i < rmH.length; i++) {
    const row = { hazard: String(rmH[i] || '').trim(), controls: String(rmC[i] || '').trim(), remaining: String(rmR[i] || '').trim() };
    if (row.hazard || row.controls) riskMgmt.push(row);
  }

  const responses = {
    site: {
      road: String(b.site_road || '').trim(),
      from_side_st: String(b.site_from_side_st || '').trim(),
      to_side_st: String(b.site_to_side_st || '').trim(),
      suburb: String(b.site_suburb || '').trim(),
      direction: String(b.site_direction || '').trim().toUpperCase(),
      posted_speed: String(b.site_posted_speed || '').trim(),
      client_principal: String(b.site_client_principal || '').trim(),
      road_authority: String(b.site_road_authority || '').trim(),
      scope_of_works: String(b.site_scope_of_works || '').trim(),
      tgs_design_no: String(b.site_tgs_design_no || '').trim(),
      design_date: String(b.site_design_date || '').trim(),
      estimated_duration: String(b.site_estimated_duration || '').trim(),
    },
    options: {
      method_selected: ['around', 'past', 'through'].includes(b.method_selected) ? b.method_selected : '',
      method_reason: String(b.method_reason || '').trim(),
    },
    shuttle_applies: b.shuttle_applies === '1' || b.shuttle_applies === 'on',
    detour_applies: b.detour_applies === '1' || b.detour_applies === 'on',
    answers,
    section4,
    risk_management: riskMgmt,
    additional_comments: String(b.additional_comments || '').trim(),
    sign_off: {
      author: { name: String(b.author_name || '').trim(), pwz: String(b.author_pwz || '').trim(), date: String(b.author_date || '').trim() },
      approver: { name: String(b.approver_name || '').trim(), pwz: String(b.approver_pwz || '').trim(), date: String(b.approver_date || '').trim() },
      one_up: { name: String(b.one_up_name || '').trim(), pwz: String(b.one_up_pwz || '').trim(), accreditation: String(b.one_up_accreditation || '').trim(), date: String(b.one_up_date || '').trim() },
      tgs_ref_no: String(b.tgs_ref_no || '').trim(),
    },
  };

  // Status flips draft → active on the first save with non-blank content.
  const hasContent = responses.site.road || responses.site.tgs_design_no || Object.values(answers).some(a => a.yn) || riskMgmt.length > 0;
  const newStatus = hasContent ? 'active' : ra.status;
  db.prepare(`UPDATE risk_assessments SET responses_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(JSON.stringify(responses), newStatus, ra.id);

  try { logActivity({ user: req.session.user, action: 'update', entityType: 'risk_assessment', entityId: ra.id, entityLabel: ra.title, details: 'Filled TGS RA form', ip: req.ip }); } catch (e) {}
  if (ra.job_id) {
    try { autoLogDiary(db, { jobId: ra.job_id, summary: `[${req.session.user.full_name}] Risk Assessment "${ra.title}" updated.`, userId: req.session.user.id }); } catch (e) {}
  }
  req.flash('success', 'Risk Assessment saved.');
  req.session.save(() => res.redirect('/risk-assessments/' + ra.id + '/fill'));
});

// POST /risk-assessments/:id/generate-combined — render the filled RA to
// PDF, merge with the linked sub-plan's TGS file, store the merged file
// as the canonical attachment on the sub-plan.
router.post('/:id/generate-combined', async (req, res) => {
  const db = getDb();
  const ctx = loadTgsContext(db, req.params.id);
  if (!ctx || ctx.fallback) { req.flash('error', 'Combined PDF only supported for TGS Risk Assessments.'); return req.session.save(() => res.redirect('/risk-assessments/' + req.params.id)); }
  if (!ctx.sub) { req.flash('error', 'This Risk Assessment is not linked to a sub-plan.'); return req.session.save(() => res.redirect('/risk-assessments/' + ctx.ra.id + '/fill')); }
  if (ctx.ra.status !== 'active') { req.flash('error', 'Fill the Risk Assessment before generating the combined PDF.'); return req.session.save(() => res.redirect('/risk-assessments/' + ctx.ra.id + '/fill')); }

  // Find the most recent TGS doc on the sub-plan.
  const tgsDoc = db.prepare("SELECT * FROM compliance_documents WHERE compliance_id = ? ORDER BY id DESC LIMIT 1").get(ctx.sub.id);
  if (!tgsDoc) { req.flash('error', 'Upload the TGS PDF on the sub-plan first.'); return req.session.save(() => res.redirect('/risk-assessments/' + ctx.ra.id + '/fill')); }

  const tgsDiskPath = tgsDoc.file_path.startsWith('/') ? path.join(__dirname, '..', tgsDoc.file_path) : path.join(__dirname, '..', tgsDoc.file_path);
  if (!fs.existsSync(tgsDiskPath)) { req.flash('error', 'TGS file missing on disk.'); return req.session.save(() => res.redirect('/risk-assessments/' + ctx.ra.id + '/fill')); }
  if (!/\.pdf$/i.test(tgsDoc.original_name || tgsDoc.file_path)) {
    req.flash('error', 'Combined generation requires the TGS to be a PDF.');
    return req.session.save(() => res.redirect('/risk-assessments/' + ctx.ra.id + '/fill'));
  }

  try {
    let responses = {};
    try { responses = JSON.parse(ctx.ra.responses_json || '{}'); } catch (e) {}
    const raBuf = await tgsTemplate.renderTgsRiskOptionsPdf({ ra: ctx.ra, sub: ctx.sub, parent: ctx.parent, job: ctx.job, responses });
    const tgsBuf = fs.readFileSync(tgsDiskPath);
    const combinedBuf = await mergePdfs([raBuf, tgsBuf]);

    const outDir = path.join(__dirname, '..', 'data', 'uploads', 'compliance', String(ctx.sub.id));
    fs.mkdirSync(outDir, { recursive: true });
    const fname = Date.now() + '-' + Math.round(Math.random() * 1e9) + '-combined.pdf';
    const absPath = path.join(outDir, fname);
    fs.writeFileSync(absPath, combinedBuf);
    const relPath = '/data/uploads/compliance/' + ctx.sub.id + '/' + fname;
    const niceName = ((ctx.sub.reference_number || ctx.parent && ('plan-' + ctx.parent.plan_number) || 'plan') + ' — RA + TGS.pdf').replace(/\s+/g, ' ');

    // Rewrite the existing TGS row so the sub-plan card downloads the
    // combined file. Old bare TGS file stays on disk untouched (no GC) —
    // we can clean it up later if storage gets tight.
    db.prepare("UPDATE compliance_documents SET filename = ?, original_name = ?, file_path = ?, file_size = ?, mime_type = 'application/pdf' WHERE id = ?")
      .run(fname, niceName, relPath, combinedBuf.length, tgsDoc.id);
    db.prepare("UPDATE risk_assessments SET combined_pdf_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(relPath, ctx.ra.id);

    try { logActivity({ user: req.session.user, action: 'upload', entityType: 'risk_assessment', entityId: ctx.ra.id, entityLabel: ctx.ra.title, details: 'Generated combined RA + TGS PDF', ip: req.ip }); } catch (e) {}
    if (ctx.ra.job_id) {
      try { autoLogDiary(db, { jobId: ctx.ra.job_id, complianceItemId: ctx.sub.parent_id, summary: `[${req.session.user.full_name}] Generated combined RA + TGS for ${ctx.sub.reference_number}.`, userId: req.session.user.id }); } catch (e) {}
    }
    req.flash('success', 'Combined RA + TGS PDF generated and attached.');
    if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true, file_path: relPath });
    return req.session.save(() => res.redirect('/compliance/' + ctx.sub.parent_id + '/edit'));
  } catch (err) {
    console.error('[risk-assessments] generate-combined failed:', err);
    req.flash('error', 'Combined PDF generation failed: ' + err.message);
    return req.session.save(() => res.redirect('/risk-assessments/' + ctx.ra.id + '/fill'));
  }
});

module.exports = router;
