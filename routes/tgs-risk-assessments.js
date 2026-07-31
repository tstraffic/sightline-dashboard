// Standalone TGS Risk & Options Assessment — fill, persist, export PDF,
// optionally attach to a traffic_plans row via plan_revisions.
//
// Not to be confused with /risk-assessments/:id/fill (which is the existing
// flow that ties a TGS RA to a compliance sub-plan). This module is a
// fresh standalone planning tool that lives under /tgs-risk-assessments,
// linked from the sidebar (Planning section) and the /plans index page.

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const {
  QUESTIONS,
  LIKELIHOOD,
  CONSEQUENCE,
  RISK_MATRIX,
  MATRIX_HEADERS,
  MATRIX_ROWS,
  ACTION_LEVELS,
  computeRating,
  computeResidualRisk,
} = require('../lib/raTemplates/tgsRiskOptions');
const { renderTgsRiskAssessmentPdf } = require('../lib/pdf/tgsRiskAssessmentPdf');
const { resolveUploadPath } = require('../middleware/upload');

// Stored under data/ — the only tree on the persistent volume. public/uploads
// is rebuilt from the container image on every deploy. These PDFs are
// regenerable from responses_json (see GET /:id/pdf), so a wiped file was
// cosmetic here — but an attached plan revision links the path statically with
// no regeneration fallback, and that link 404'd for good.
const PDF_STORED_PREFIX = 'data/uploads/tgs-risk-assessments';
const PDF_DIR = path.join(__dirname, '..', PDF_STORED_PREFIX);
function ensurePdfDir() {
  try { fs.mkdirSync(PDF_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

// Walk submitted form fields and rebuild the responses_json shape that the
// view + PDF renderer consume. Inputs use parallel-array naming for the
// dynamic Section 4 and Risk Management tables (s4_question[], rm_hazard[]).
function buildResponsesFromForm(b) {
  const site = {
    road: b.site_road || '',
    from_side_st: b.site_from_side_st || '',
    to_side_st: b.site_to_side_st || '',
    suburb: b.site_suburb || '',
    direction: b.site_direction || '',
    posted_speed: b.site_posted_speed || '',
    client_principal: b.site_client_principal || '',
    road_authority: b.site_road_authority || '',
    scope_of_works: b.site_scope_of_works || '',
    tgs_design_no: b.site_tgs_design_no || '',
    design_date: b.site_design_date || '',
    estimated_duration: b.site_estimated_duration || '',
  };

  const options = {
    method_selected: b.method_selected || '',
    method_reason: b.method_reason || '',
  };

  // Sections 1-3: stored answers keyed by question number ('1.1'...'3.5').
  const answers = {};
  QUESTIONS.forEach(q => {
    const yn = b['yn_' + q.number] || '';
    const desc = b['desc_' + q.number] || '';
    const likelihood = b['likelihood_' + q.number] || '';
    const consequence = b['consequence_' + q.number] || '';
    const rating = computeRating(likelihood, consequence) || '';
    answers[q.number] = { yn, desc, likelihood, consequence, rating };
  });

  // Section 4 — parallel arrays. Body-parser delivers single value or array;
  // normalise to arrays.
  const arr = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));
  const s4Q  = arr(b.s4_question);
  const s4YN = arr(b.s4_yn);
  const s4D  = arr(b.s4_desc);
  const s4L  = arr(b.s4_likelihood);
  const s4C  = arr(b.s4_consequence);
  const section4 = [];
  for (let i = 0; i < s4Q.length; i++) {
    const q = (s4Q[i] || '').trim();
    const d = (s4D[i] || '').trim();
    const yn = s4YN[i] || '';
    const l = s4L[i] || '';
    const c = s4C[i] || '';
    if (!q && !d && !yn && !l && !c) continue;
    section4.push({
      question: q,
      yn,
      desc: d,
      likelihood: l,
      consequence: c,
      rating: computeRating(l, c) || '',
    });
  }

  // Risk Management — parallel arrays.
  const rmRef  = arr(b.rm_ref);
  const rmHaz  = arr(b.rm_hazard);
  const rmCtrl = arr(b.rm_controls);
  const rmL    = arr(b.rm_likelihood);
  const rmC    = arr(b.rm_consequence);
  const risk_management = [];
  for (let i = 0; i < rmHaz.length; i++) {
    const ref = (rmRef[i] || '').trim();
    const haz = (rmHaz[i] || '').trim();
    const ctrl = (rmCtrl[i] || '').trim();
    const l = rmL[i] || '';
    const c = rmC[i] || '';
    if (!ref && !haz && !ctrl && !l && !c) continue;
    risk_management.push({
      ref,
      hazard: haz,
      controls: ctrl,
      likelihood: l,
      consequence: c,
      rating: computeRating(l, c) || '',
    });
  }

  const sign_off = {
    author: { name: b.author_name || '', pwz: b.author_pwz || '', date: b.author_date || '' },
    approver: { name: b.approver_name || '', pwz: b.approver_pwz || '', date: b.approver_date || '' },
    one_up: {
      name: b.one_up_name || '',
      accreditation: b.one_up_accreditation || '',
      pwz: b.one_up_pwz || '',
      date: b.one_up_date || '',
    },
    tgs_ref_no: b.tgs_ref_no || '',
  };

  return {
    site,
    options,
    answers,
    section4,
    risk_management,
    additional_comments: b.additional_comments || '',
    sign_off,
  };
}

// Common locals for new/edit form. Pass everything the view needs in one go
// so the EJS file is dumb and only reads from `locals.*`.
function formLocals(req, assessment, responses) {
  const db = getDb();
  const plans = db.prepare(`
    SELECT id, plan_number, plan_type, plan_types, job_id
    FROM traffic_plans
    ORDER BY created_at DESC LIMIT 200
  `).all();
  const jobs = db.prepare(`
    SELECT id, job_number, client, project_name
    FROM jobs
    WHERE status IN ('active','on_hold','won','prestart','tender')
    ORDER BY job_number DESC
  `).all();
  return {
    title: assessment ? `Edit TGS Risk Assessment ${assessment.tgs_ref_no || '#' + assessment.id}` : 'New TGS Risk Assessment',
    assessment,
    responses,
    questions: QUESTIONS,
    likelihood: LIKELIHOOD,
    consequence: CONSEQUENCE,
    riskMatrix: RISK_MATRIX,
    matrixHeaders: MATRIX_HEADERS,
    matrixRows: MATRIX_ROWS,
    actionLevels: ACTION_LEVELS,
    plans,
    jobs,
    user: req.session.user,
    currentPage: 'tgs-risk-assessments',
  };
}

// ─── LIST ─────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const { status } = req.query;
  let query = `
    SELECT tra.*,
      u.full_name AS created_by_name,
      tp.plan_number AS plan_number,
      j.job_number AS job_number
    FROM tgs_risk_assessments tra
    LEFT JOIN users u ON tra.created_by_id = u.id
    LEFT JOIN traffic_plans tp ON tra.plan_id = tp.id
    LEFT JOIN jobs j ON tra.job_id = j.id
    WHERE 1=1
  `;
  const params = [];
  if (status && status !== 'all') { query += ' AND tra.status = ?'; params.push(status); }
  query += ' ORDER BY tra.created_at DESC';
  const assessments = db.prepare(query).all(...params);
  res.render('tgs-risk-assessments/index', {
    title: 'TGS Risk Assessments',
    assessments,
    filters: { status: status || '' },
    user: req.session.user,
    currentPage: 'tgs-risk-assessments',
  });
});

// ─── NEW FORM (un-persisted) ─────────────────────
router.get('/new', (req, res) => {
  // Render a blank form. We do NOT insert a draft row on GET; only on POST.
  res.render('tgs-risk-assessments/form', formLocals(req, null, null));
});

// ─── CREATE ───────────────────────────────────────
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const responses = buildResponsesFromForm(b);
  const residual = computeResidualRisk(responses.risk_management);
  const requiresOneUp = residual === 'High' || residual === 'Extreme' ? 1 : 0;

  try {
    const result = db.prepare(`
      INSERT INTO tgs_risk_assessments
        (plan_id, job_id, title, tgs_ref_no, status, responses_json, residual_risk, requires_one_up, created_by_id)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      b.plan_id || null,
      b.job_id || null,
      b.title || '',
      b.tgs_ref_no || '',
      JSON.stringify(responses),
      residual,
      requiresOneUp,
      req.session.user.id
    );
    req.flash('success', 'TGS Risk Assessment created.');
    req.session.save(() => res.redirect(`/tgs-risk-assessments/${result.lastInsertRowid}/edit`));
  } catch (err) {
    req.flash('error', 'Failed to create: ' + err.message);
    req.session.save(() => res.redirect('/tgs-risk-assessments/new'));
  }
});

// ─── EDIT FORM ────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const assessment = db.prepare('SELECT * FROM tgs_risk_assessments WHERE id = ?').get(req.params.id);
  if (!assessment) {
    req.flash('error', 'Assessment not found.');
    return req.session.save(() => res.redirect('/tgs-risk-assessments'));
  }
  let responses = {};
  try { responses = JSON.parse(assessment.responses_json || '{}'); } catch (e) { responses = {}; }
  res.render('tgs-risk-assessments/form', formLocals(req, assessment, responses));
});

// ─── UPDATE ───────────────────────────────────────
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const existing = db.prepare('SELECT * FROM tgs_risk_assessments WHERE id = ?').get(req.params.id);
  if (!existing) {
    req.flash('error', 'Assessment not found.');
    return req.session.save(() => res.redirect('/tgs-risk-assessments'));
  }
  const responses = buildResponsesFromForm(b);
  const residual = computeResidualRisk(responses.risk_management);
  const requiresOneUp = residual === 'High' || residual === 'Extreme' ? 1 : 0;

  try {
    db.prepare(`
      UPDATE tgs_risk_assessments SET
        plan_id = ?, job_id = ?, title = ?, tgs_ref_no = ?,
        responses_json = ?, residual_risk = ?, requires_one_up = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.plan_id || null,
      b.job_id || null,
      b.title || '',
      b.tgs_ref_no || '',
      JSON.stringify(responses),
      residual,
      requiresOneUp,
      req.params.id
    );
    req.flash('success', 'Assessment saved.');
    req.session.save(() => res.redirect(`/tgs-risk-assessments/${req.params.id}/edit`));
  } catch (err) {
    req.flash('error', 'Failed to save: ' + err.message);
    req.session.save(() => res.redirect(`/tgs-risk-assessments/${req.params.id}/edit`));
  }
});

// ─── FINALIZE + GENERATE PDF ─────────────────────
router.post('/:id/finalize', async (req, res) => {
  const db = getDb();
  const assessment = db.prepare('SELECT * FROM tgs_risk_assessments WHERE id = ?').get(req.params.id);
  if (!assessment) {
    req.flash('error', 'Assessment not found.');
    return req.session.save(() => res.redirect('/tgs-risk-assessments'));
  }

  let responses = {};
  try { responses = JSON.parse(assessment.responses_json || '{}'); } catch (e) { responses = {}; }

  try {
    ensurePdfDir();
    const buf = await renderTgsRiskAssessmentPdf(assessment, responses);
    const filename = `tgs-ra-${assessment.id}-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(PDF_DIR, filename), buf);
    const relPath = PDF_STORED_PREFIX + '/' + filename;
    db.prepare(`
      UPDATE tgs_risk_assessments
      SET status = 'finalized', pdf_path = ?, pdf_generated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(relPath, assessment.id);
    req.flash('success', 'Assessment finalized and PDF generated.');
  } catch (err) {
    console.error('[TGS RA] Finalize/PDF error:', err);
    req.flash('error', 'Failed to generate PDF: ' + err.message);
  }
  req.session.save(() => res.redirect(`/tgs-risk-assessments/${req.params.id}/edit`));
});

// ─── DOWNLOAD PDF ─────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const db = getDb();
  const assessment = db.prepare('SELECT * FROM tgs_risk_assessments WHERE id = ?').get(req.params.id);
  if (!assessment) {
    req.flash('error', 'Assessment not found.');
    return req.session.save(() => res.redirect('/tgs-risk-assessments'));
  }

  // If a PDF was generated previously and still exists, stream it.
  // resolveUploadPath covers both the current data/uploads location and
  // legacy public/uploads rows; a miss just falls through to regeneration.
  if (assessment.pdf_path) {
    const fullPath = resolveUploadPath(assessment.pdf_path);
    if (fullPath) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="TGS-RA-${assessment.id}.pdf"`);
      return fs.createReadStream(fullPath).pipe(res);
    }
  }

  // Otherwise generate on the fly (don't persist if user is just previewing).
  let responses = {};
  try { responses = JSON.parse(assessment.responses_json || '{}'); } catch (e) { responses = {}; }
  try {
    const buf = await renderTgsRiskAssessmentPdf(assessment, responses);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="TGS-RA-${assessment.id}.pdf"`);
    res.end(buf);
  } catch (err) {
    console.error('[TGS RA] PDF stream error:', err);
    req.flash('error', 'Failed to render PDF: ' + err.message);
    req.session.save(() => res.redirect(`/tgs-risk-assessments/${req.params.id}/edit`));
  }
});

// ─── ATTACH TO PLAN ───────────────────────────────
// Links the assessment to a traffic_plans row AND writes a row into
// plan_revisions so the PDF appears in the plan's revision history.
router.post('/:id/attach/:planId', (req, res) => {
  const db = getDb();
  const assessment = db.prepare('SELECT * FROM tgs_risk_assessments WHERE id = ?').get(req.params.id);
  if (!assessment) {
    req.flash('error', 'Assessment not found.');
    return req.session.save(() => res.redirect('/tgs-risk-assessments'));
  }
  const plan = db.prepare('SELECT * FROM traffic_plans WHERE id = ?').get(req.params.planId);
  if (!plan) {
    req.flash('error', 'Plan not found.');
    return req.session.save(() => res.redirect(`/tgs-risk-assessments/${assessment.id}/edit`));
  }
  if (!assessment.pdf_path) {
    req.flash('error', 'Finalize the assessment first to generate a PDF, then attach.');
    return req.session.save(() => res.redirect(`/tgs-risk-assessments/${assessment.id}/edit`));
  }

  try {
    db.prepare('UPDATE tgs_risk_assessments SET plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(plan.id, assessment.id);

    // Auto-increment revision label like routes/plans.js does.
    const lastRevision = db.prepare(
      'SELECT revision_label FROM plan_revisions WHERE plan_id = ? ORDER BY id DESC LIMIT 1'
    ).get(plan.id);
    let nextLabel = 'Rev A';
    if (lastRevision) {
      const letter = (lastRevision.revision_label || 'Rev A').replace('Rev ', '');
      nextLabel = 'Rev ' + String.fromCharCode(letter.charCodeAt(0) + 1);
    } else if (plan.current_revision_label) {
      const letter = plan.current_revision_label.replace('Rev ', '');
      nextLabel = 'Rev ' + String.fromCharCode(letter.charCodeAt(0) + 1);
    }
    const fileOriginalName = `TGS-Risk-Assessment-${assessment.id}.pdf`;

    db.prepare(`
      INSERT INTO plan_revisions
        (plan_id, revision_label, file_url, file_path, file_original_name, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      plan.id,
      nextLabel,
      '',
      assessment.pdf_path,
      fileOriginalName,
      `Auto-attached from TGS Risk Assessment #${assessment.id}`,
      req.session.user.id
    );
    db.prepare('UPDATE traffic_plans SET current_revision_label = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(nextLabel, plan.id);

    req.flash('success', `Assessment attached to plan ${plan.plan_number} as ${nextLabel}.`);
  } catch (err) {
    console.error('[TGS RA] Attach error:', err);
    req.flash('error', 'Failed to attach: ' + err.message);
  }
  req.session.save(() => res.redirect(`/tgs-risk-assessments/${assessment.id}/edit`));
});

// ─── DELETE ───────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const assessment = db.prepare('SELECT * FROM tgs_risk_assessments WHERE id = ?').get(req.params.id);
  if (!assessment) {
    req.flash('error', 'Assessment not found.');
    return req.session.save(() => res.redirect('/tgs-risk-assessments'));
  }
  try {
    // Remove generated PDF file if present (best-effort; ignore missing file).
    if (assessment.pdf_path) {
      const fullPath = resolveUploadPath(assessment.pdf_path);
      if (fullPath) { try { fs.unlinkSync(fullPath); } catch (e) { /* ignore */ } }
    }
    db.prepare('DELETE FROM tgs_risk_assessments WHERE id = ?').run(assessment.id);
    req.flash('success', 'Assessment deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete: ' + err.message);
  }
  req.session.save(() => res.redirect('/tgs-risk-assessments'));
});

module.exports = router;
