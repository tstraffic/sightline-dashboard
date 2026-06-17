const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { SCORE_GROUPS, computeScore } = require('../lib/auditQuestions');
const { resolveForAudit, getActiveTemplateVersion } = require('../lib/auditTemplate');
const { getOnSiteCrew, resolveEmployeeForCrew, syncAuditReviews } = require('../lib/auditCrew');
const { syncCorrectiveActionsFromAudit } = require('../lib/auditActions');

// Build { questionKey: {text, is_critical, risk_band} } from resolved template sections.
function questionMetaOf(tpl) {
  const m = {};
  (tpl.sections || []).forEach(function (s) {
    (s.questions || []).forEach(function (q) { m[q.key] = { text: q.text, is_critical: q.is_critical, risk_band: q.risk_band }; });
  });
  return m;
}
const { autoLogDiary } = require('../lib/diary');
const { generateAuditPdf } = require('../services/auditPdf');

// ---- Multer storage: data/uploads/audits/{auditId}/ ----
const auditStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const auditId = req.params.id;
    const dest = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(auditId));
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
  },
});
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|heic)|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)|text\/plain)$/i;
const auditUpload = multer({
  storage: auditStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (ALLOWED_MIME.test(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

function parseJson(s, fallback) {
  try { return JSON.parse(s || ''); } catch (e) { return fallback; }
}
function firstVal(v) {
  if (v == null) return '';
  if (Array.isArray(v)) { for (const x of v) { if (x != null && String(x).trim() !== '') return String(x); } return ''; }
  return String(v);
}
function firstTrim(v) { return firstVal(v).trim(); }
function arrayify(v) { return Array.isArray(v) ? v : (v != null && v !== '' ? [v] : []); }
function dateOf(dt) { return (dt || '').slice(0, 10); }

// Drawn-signature capture (mirrors routes/equipmentHireDockets.js writeSignaturePng).
const AUDIT_SIG_SLOTS = new Set(['auditor', 'supervisor']);
function writeSignaturePng(dest, dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || '').replace(/\s+/g, ''));
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length === 0 || buf.length > 500 * 1024) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return true;
}

// ── Build responses_json from the form body, driven by the resolved template
// question list (so it works for both the new template and legacy fallback). ──
function buildResponsesFromBody(b, scoringQuestions) {
  const responses = {};
  for (const q of scoringQuestions) {
    const key = q.key;
    const raw = firstVal(b[`q_${key}_state`]);
    const state = ['yes', 'no', 'na'].includes(raw) ? raw : '';
    const entry = {};
    if (state) entry.state = state;
    const notes = firstTrim(b[`q_${key}_notes`]);
    if (notes) entry.notes = notes;

    // N/A "not applicable to this scenario" justification (mandatory on criticals client-side)
    if (state === 'na') {
      const naReason = firstTrim(b[`q_${key}_na_reason`]);
      if (naReason) entry.na_reason = naReason;
    }

    if (q.scoring_mode === 'per_person') {
      const members = arrayify(b[`q_${key}_tag_members`]).map(String).filter(Boolean);
      const onSite = parseInt(firstVal(b[`q_${key}_on_site_count`]), 10);
      if (!Number.isNaN(onSite)) entry.on_site_count = onSite;
      if (members.length) {
        entry.exceptions = members.map(cmId => ({
          crew_member_id: parseInt(cmId, 10),
          risk_level: firstTrim(b[`q_${key}_tag_${cmId}_risk`]) || 'Medium',
        }));
        if (!entry.state) entry.state = 'yes'; // crew compliant-by-default with tagged exceptions
      }
    } else if (state === 'no') {
      const obs = firstTrim(b[`q_${key}_observation`]);
      const risk = firstTrim(b[`q_${key}_risk_level`]);
      const corr = firstTrim(b[`q_${key}_corrective_action`]);
      const resp = firstTrim(b[`q_${key}_responsible`]);
      const rect = firstVal(b[`q_${key}_rectified`]);
      if (obs) entry.observation = obs;
      if (risk) entry.risk_level = risk;
      if (corr) entry.corrective_action = corr;
      if (resp) entry.responsible = resp;
      if (rect === 'yes') entry.rectified_on_site = true;
      else if (rect === 'no') entry.rectified_on_site = false;
    }

    // Critical auto-fail override (with justification) — applies to any question
    if (firstVal(b[`q_${key}_critical_override`]) === '1') {
      entry.critical_override = true;
      const reason = firstTrim(b[`q_${key}_override_reason`]);
      if (reason) entry.override_reason = reason;
    }

    if (Object.keys(entry).length) responses[key] = entry;
  }

  const sectionComments = {};
  // section comments keyed by section_key (S1..) — collected generically
  Object.keys(b).forEach(k => {
    const m = k.match(/^section_(.+)_comments$/);
    if (m) { const c = firstTrim(b[k]); if (c) sectionComments[m[1]] = c; }
  });
  return { responses, sectionComments };
}

// Per-person tags for persistence into audit_question_tags
function buildCrewTagsFromBody(b, scoringQuestions, crewById) {
  const tags = [];
  for (const q of scoringQuestions) {
    if (q.scoring_mode !== 'per_person') continue;
    const key = q.key;
    const members = arrayify(b[`q_${key}_tag_members`]).map(String).filter(Boolean);
    for (const cmId of members) {
      const crew = crewById[cmId] || {};
      tags.push({
        question_key: key,
        crew_member_id: parseInt(cmId, 10),
        issue: firstTrim(b[`q_${key}_tag_${cmId}_issue`]),
        risk_level: firstTrim(b[`q_${key}_tag_${cmId}_risk`]) || 'Medium',
        visibility: firstVal(b[`q_${key}_tag_${cmId}_visibility`]) === 'worker' ? 'worker' : 'internal',
        worker_name_snapshot: crew.full_name || '',
        employee_id: crew.employee_id || null,
      });
    }
  }
  return tags;
}

function buildNonconformancesFromBody(b) {
  const rows = [];
  for (let i = 1; i <= 10; i++) {
    const issue = firstTrim(b[`nc_${i}_issue`]);
    if (!issue) continue;
    rows.push({
      issue,
      risk: firstTrim(b[`nc_${i}_risk`]),
      action: firstTrim(b[`nc_${i}_action`]),
      responsible: firstTrim(b[`nc_${i}_responsible`]),
      due_date: firstTrim(b[`nc_${i}_due`]),
      closed: !!b[`nc_${i}_closed`],
    });
  }
  return rows;
}

// Selected on-site crew → audit_crew (replace set each save)
function persistAuditCrew(db, auditId, b, onSiteCrew) {
  const selected = arrayify(b.crew_member_ids).map(s => parseInt(s, 10)).filter(Boolean);
  const byId = {}; onSiteCrew.forEach(c => { byId[c.crew_member_id] = c; });
  db.prepare('DELETE FROM audit_crew WHERE audit_id = ?').run(auditId);
  const ins = db.prepare(`INSERT OR IGNORE INTO audit_crew (audit_id, crew_member_id, employee_id, full_name, role_on_site, source, added_by_id) VALUES (?,?,?,?,?,?,?)`);
  for (const cmId of selected) {
    let c = byId[cmId];
    if (!c) {
      const cm = db.prepare('SELECT id, full_name FROM crew_members WHERE id = ?').get(cmId);
      if (!cm) continue;
      const emp = resolveEmployeeForCrew(db, cmId);
      c = { crew_member_id: cmId, full_name: cm.full_name, employee_id: emp.employeeId, role_on_site: '', source: 'manual' };
    }
    ins.run(auditId, cmId, c.employee_id || null, c.full_name || '', c.role_on_site || '', c.source || 'manual', null);
  }
}

// Per-person tags → audit_question_tags (upsert; preserve employee_review_id)
function persistAuditTags(db, auditId, tags, userId) {
  const upsert = db.prepare(`
    INSERT INTO audit_question_tags (audit_id, question_key, crew_member_id, employee_id, worker_name_snapshot, issue, risk_level, visibility, created_by_id)
    VALUES (@audit_id,@question_key,@crew_member_id,@employee_id,@worker_name_snapshot,@issue,@risk_level,@visibility,@created_by_id)
    ON CONFLICT(audit_id, question_key, crew_member_id) DO UPDATE SET
      issue=excluded.issue, risk_level=excluded.risk_level, visibility=excluded.visibility,
      worker_name_snapshot=excluded.worker_name_snapshot,
      employee_id=COALESCE(audit_question_tags.employee_id, excluded.employee_id),
      updated_at=CURRENT_TIMESTAMP
  `);
  const keep = new Set();
  for (const t of tags) {
    keep.add(t.question_key + '|' + t.crew_member_id);
    upsert.run({ audit_id: auditId, created_by_id: userId, ...t });
  }
  // remove tags no longer present
  const existing = db.prepare('SELECT id, question_key, crew_member_id FROM audit_question_tags WHERE audit_id = ?').all(auditId);
  const del = db.prepare('DELETE FROM audit_question_tags WHERE id = ?');
  for (const e of existing) if (!keep.has(e.question_key + '|' + e.crew_member_id)) del.run(e.id);
}

// Resolve template + crew context for an audit row (or a fresh form).
function contextFor(db, { audit, b }) {
  const versionId = (audit && audit.template_version_id) || null;
  const workType = (b && b.work_type) || (audit && audit.work_type) || 'static';
  const timeOfDay = (b && b.time_of_day) || (audit && audit.time_of_day) || 'day';
  const tpl = resolveForAudit(db, { versionId, workType, timeOfDay });
  const jobId = (b && b.job_id) || (audit && audit.job_id) || null;
  const dateISO = dateOf((b && b.audit_datetime) || (audit && audit.audit_datetime) || '');
  const onSiteCrew = getOnSiteCrew(db, jobId, dateISO);
  return { tpl, workType, timeOfDay, jobId, dateISO, onSiteCrew };
}

// Compute + return the score using template metadata.
function scoreFor(tpl, responses, onSiteCount) {
  return computeScore(responses, { questions: tpl.scoringQuestions, onSiteCount });
}

// Persist all the score-derived columns from a computed snapshot + chosen finding.
function scoreColumns(score, chosenFinding, overrideReason) {
  const suggested = score.suggestedFinding || '';
  let chosen = chosenFinding || suggested;
  if (score.criticalFail) chosen = 'fail';
  const overridden = chosen !== suggested ? 1 : 0;
  return {
    overall_finding: chosen,
    suggested_finding: suggested,
    finding_overridden: overridden,
    finding_override_reason: overridden ? (overrideReason || '') : '',
    score_total: score.total || 0,
    score_max: score.max || 0,
    score_percent: score.percent || 0,
    score_weighted_percent: score.weightedPercent != null ? score.weightedPercent : (score.percent || 0),
    critical_fail: score.criticalFail ? 1 : 0,
    score_json: JSON.stringify(score),
    scoring_model_version: 2,
  };
}

// GET / — list
router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id } = req.query;
  let where = '1=1';
  const params = [];
  if (status && status !== 'all') { where += ' AND a.status = ?'; params.push(status); }
  if (job_id) { where += ' AND a.job_id = ?'; params.push(job_id); }
  const audits = db.prepare(`
    SELECT a.*, j.job_number, j.client as job_client, u.full_name as created_by_name
    FROM site_audits a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN users u ON a.created_by_id = u.id
    WHERE ${where} ORDER BY a.id DESC
  `).all(...params);
  const counts = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) as draft,
      SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN status='signed_off' THEN 1 ELSE 0 END) as signed_off,
      SUM(CASE WHEN overall_finding='fail' THEN 1 ELSE 0 END) as fail_count
    FROM site_audits
  `).get();
  res.render('audits/index', {
    title: 'Site Audits', audits, counts: counts || {}, filters: req.query,
    user: req.session.user, currentPage: 'audits',
  });
});

// POST /draft — create an empty draft, pinning the active template version + context
router.post('/draft', (req, res) => {
  try {
    const db = getDb();
    const b = req.body || {};
    const active = getActiveTemplateVersion(db);
    const result = db.prepare(`
      INSERT INTO site_audits (
        job_id, project_site, client, location, supervisor_name, tgs_ref, weather,
        auditor_id, auditor_name, audit_datetime, shift, work_type, time_of_day,
        template_version_id, status, created_by_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      b.job_id || null, b.project_site || '', b.client || '', b.location || '',
      b.supervisor_name || '', b.tgs_ref || '', b.weather || '',
      req.session.user.id, b.auditor_name || req.session.user.full_name || '',
      b.audit_datetime || new Date().toISOString().slice(0, 16),
      b.shift || 'day', b.work_type || 'static', b.time_of_day || 'day',
      active ? active.id : null, req.session.user.id
    );
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error('[Audits] Draft create error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /new — create form
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, job_name, client, site_address, suburb FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const { tpl, workType, timeOfDay, onSiteCrew } = contextFor(db, { audit: null, b: {} });
  res.render('audits/form', {
    title: 'New Site Audit', audit: null,
    responses: {}, sectionComments: {}, nonconformances: [], attachments: [], attachmentsByContext: {},
    sections: tpl.sections, scoreGroups: SCORE_GROUPS, score: scoreFor(tpl, {}, onSiteCrew.length),
    templateDraft: tpl.isDraft, templateLegacy: tpl.isLegacy,
    workType, timeOfDay, onSiteCrew, auditCrew: [], tagsByKey: {},
    jobs, user: req.session.user, currentPage: 'audits', isEdit: false,
  });
});

// POST / — create
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const active = getActiveTemplateVersion(db);
    const ctx = contextFor(db, { audit: { template_version_id: active ? active.id : null }, b });
    const { responses, sectionComments } = buildResponsesFromBody(b, ctx.tpl.scoringQuestions);
    const nonconformances = buildNonconformancesFromBody(b);
    const score = scoreFor(ctx.tpl, responses, ctx.onSiteCrew.length);
    const cols = scoreColumns(score, b.overall_finding, b.finding_override_reason);
    const status = b.submit === '1' ? 'submitted' : 'draft';

    const result = db.prepare(`
      INSERT INTO site_audits (
        job_id, project_site, client, location, audit_datetime,
        auditor_id, auditor_name, supervisor_name, tgs_ref, shift, weather,
        work_type, time_of_day, template_version_id,
        overall_result, overall_finding, suggested_finding, finding_overridden, finding_override_reason,
        responses_json, nonconformances_json,
        score_total, score_max, score_percent, score_weighted_percent, critical_fail, score_json, scoring_model_version,
        status, follow_up_required, follow_up_date, created_by_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      b.job_id || null, b.project_site || '', b.client || '', b.location || '', b.audit_datetime || '',
      req.session.user.id, b.auditor_name || req.session.user.full_name, b.supervisor_name || '',
      b.tgs_ref || '', b.shift || 'day', b.weather || '',
      ctx.workType, ctx.timeOfDay, active ? active.id : null,
      b.overall_result || '', cols.overall_finding, cols.suggested_finding, cols.finding_overridden, cols.finding_override_reason,
      JSON.stringify({ responses, sectionComments }), JSON.stringify(nonconformances),
      cols.score_total, cols.score_max, cols.score_percent, cols.score_weighted_percent, cols.critical_fail, cols.score_json, cols.scoring_model_version,
      status, b.follow_up_required ? 1 : 0, b.follow_up_date || null, req.session.user.id
    );
    const newId = result.lastInsertRowid;

    const crewById = {}; ctx.onSiteCrew.forEach(c => { crewById[c.crew_member_id] = c; });
    const tags = buildCrewTagsFromBody(b, ctx.tpl.scoringQuestions, crewById);
    const qMeta = questionMetaOf(ctx.tpl);
    db.transaction(() => {
      persistAuditCrew(db, newId, b, ctx.onSiteCrew);
      persistAuditTags(db, newId, tags, req.session.user.id);
      syncCorrectiveActionsFromAudit(db, newId, { responses, questionMeta: qMeta, tags, jobId: b.job_id || null, user: req.session.user });
    })();

    if (b.job_id && status === 'submitted') {
      autoLogDiary(db, { jobId: b.job_id, summary: `[${req.session.user.full_name}] Site audit completed — ${cols.score_weighted_percent}% (${cols.overall_finding || 'no finding'}).`, userId: req.session.user.id });
    }
    req.flash('success', status === 'submitted' ? 'Audit submitted.' : 'Audit saved as draft.');
    res.redirect('/audits/' + newId);
  } catch (err) {
    console.error('[Audits] Create error:', err.message, err.stack);
    req.flash('error', 'Failed to save audit: ' + err.message);
    res.redirect('/audits/new');
  }
});

// GET /:id/crew/available — JSON on-site crew for a job+date (form refresh)
router.get('/:id/crew/available', (req, res) => {
  const db = getDb();
  const crew = getOnSiteCrew(db, req.query.job_id || null, dateOf(req.query.date || ''));
  res.json({ ok: true, crew });
});

// Helper: load everything a show/pdf/edit view needs
function loadAuditView(db, audit) {
  const stored = parseJson(audit.responses_json, {}) || {};
  const responses = stored.responses || stored;
  const sectionComments = stored.sectionComments || {};
  const nonconformances = parseJson(audit.nonconformances_json, []) || [];
  const tpl = resolveForAudit(db, { versionId: audit.template_version_id || null, workType: audit.work_type || 'static', timeOfDay: audit.time_of_day || 'day' });
  const auditCrew = db.prepare('SELECT * FROM audit_crew WHERE audit_id = ? ORDER BY full_name').all(audit.id);
  const tags = db.prepare(`
    SELECT t.*, e.id AS emp_id, r.id AS review_id
    FROM audit_question_tags t
    LEFT JOIN employees e ON e.id = t.employee_id
    LEFT JOIN employee_reviews r ON r.id = t.employee_review_id
    WHERE t.audit_id = ? ORDER BY t.question_key
  `).all(audit.id);
  const tagsByKey = {};
  tags.forEach(t => { (tagsByKey[t.question_key] = tagsByKey[t.question_key] || []).push(t); });
  // v2 audits read the frozen snapshot; legacy rows recompute flat.
  let score;
  if (audit.scoring_model_version >= 2 && audit.score_json) score = parseJson(audit.score_json, null) || scoreFor(tpl, responses, auditCrew.length);
  else score = computeScore(responses); // legacy flat
  const attachments = db.prepare('SELECT * FROM audit_attachments WHERE audit_id = ? ORDER BY uploaded_at DESC').all(audit.id);
  const attachmentsByContext = {};
  attachments.forEach(att => { const k = att.context_key || 'general'; (attachmentsByContext[k] = attachmentsByContext[k] || []).push(att); });
  // Unified corrective actions auto-created from this audit's "No"s + tags
  const auditActions = db.prepare(`
    SELECT ca.*, emp.full_name AS involved_emp_name, cm.full_name AS involved_crew_name
    FROM corrective_actions ca
    LEFT JOIN employees emp ON ca.involved_employee_id = emp.id
    LEFT JOIN crew_members cm ON ca.involved_crew_member_id = cm.id
    WHERE ca.source_audit_id = ? ORDER BY ca.id
  `).all(audit.id);
  return { responses, sectionComments, nonconformances, tpl, auditCrew, tags, tagsByKey, score, attachments, attachmentsByContext, auditActions };
}

// GET /:id/pdf — export branded PDF
router.get('/:id/pdf', (req, res) => {
  try {
    const db = getDb();
    const audit = db.prepare(`
      SELECT a.*, j.job_number, j.client as job_client, creator.full_name as created_by_name, signer.full_name as signed_off_by_name
      FROM site_audits a
      LEFT JOIN jobs j ON a.job_id = j.id
      LEFT JOIN users creator ON a.created_by_id = creator.id
      LEFT JOIN users signer ON a.signed_off_by_id = signer.id
      WHERE a.id = ?`).get(req.params.id);
    if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
    const v = loadAuditView(db, audit);
    const safeName = (audit.project_site || 'audit').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Audit_${audit.id}_${safeName}.pdf"`);
    generateAuditPdf({ audit, responses: v.responses, sectionComments: v.sectionComments, nonconformances: v.nonconformances, score: v.score, attachments: v.attachments, attachmentsByContext: v.attachmentsByContext, sections: v.tpl.sections, tagsByKey: v.tagsByKey, auditCrew: v.auditCrew }, res);
  } catch (err) {
    console.error('[Audits] PDF export error:', err.message, err.stack);
    req.flash('error', 'PDF export failed: ' + err.message);
    res.redirect('/audits/' + req.params.id);
  }
});

// GET /:id — view
router.get('/:id', (req, res) => {
  const db = getDb();
  const audit = db.prepare(`
    SELECT a.*, j.job_number, j.client as job_client, creator.full_name as created_by_name,
           signer.full_name as signed_off_by_name, auditor.full_name as auditor_full_name
    FROM site_audits a
    LEFT JOIN jobs j ON a.job_id = j.id
    LEFT JOIN users creator ON a.created_by_id = creator.id
    LEFT JOIN users signer ON a.signed_off_by_id = signer.id
    LEFT JOIN users auditor ON a.auditor_id = auditor.id
    WHERE a.id = ?`).get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
  const v = loadAuditView(db, audit);
  res.render('audits/show', {
    title: 'Audit #' + audit.id, audit,
    responses: v.responses, sectionComments: v.sectionComments, nonconformances: v.nonconformances,
    attachments: v.attachments, attachmentsByContext: v.attachmentsByContext,
    sections: v.tpl.sections, scoreGroups: SCORE_GROUPS, score: v.score,
    auditCrew: v.auditCrew, tagsByKey: v.tagsByKey, auditActions: v.auditActions,
    templateDraft: v.tpl.isDraft, templateLegacy: v.tpl.isLegacy,
    user: req.session.user, currentPage: 'audits',
  });
});

// GET /:id/edit — edit form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const audit = db.prepare('SELECT * FROM site_audits WHERE id = ?').get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
  if (audit.status === 'signed_off' && (req.session.user.role || '').toLowerCase() !== 'admin') {
    req.flash('error', 'Signed-off audits can only be edited by admin.');
    return res.redirect('/audits/' + audit.id);
  }
  const v = loadAuditView(db, audit);
  const jobs = db.prepare("SELECT id, job_number, job_name, client, site_address, suburb FROM jobs ORDER BY job_number").all();
  const onSiteCrew = getOnSiteCrew(db, audit.job_id, dateOf(audit.audit_datetime));
  res.render('audits/form', {
    title: 'Edit Audit #' + audit.id, audit,
    responses: v.responses, sectionComments: v.sectionComments, nonconformances: v.nonconformances,
    attachments: v.attachments, attachmentsByContext: v.attachmentsByContext,
    sections: v.tpl.sections, scoreGroups: SCORE_GROUPS, score: v.score,
    templateDraft: v.tpl.isDraft, templateLegacy: v.tpl.isLegacy,
    workType: audit.work_type || 'static', timeOfDay: audit.time_of_day || 'day',
    onSiteCrew, auditCrew: v.auditCrew, tagsByKey: v.tagsByKey,
    jobs, user: req.session.user, currentPage: 'audits', isEdit: true,
  });
});

// POST /:id — update
router.post('/:id', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const existing = db.prepare('SELECT * FROM site_audits WHERE id = ?').get(req.params.id);
    if (!existing) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }

    const ctx = contextFor(db, { audit: existing, b });
    const { responses, sectionComments } = buildResponsesFromBody(b, ctx.tpl.scoringQuestions);
    const nonconformances = buildNonconformancesFromBody(b);
    const score = scoreFor(ctx.tpl, responses, ctx.onSiteCrew.length);
    const cols = scoreColumns(score, b.overall_finding, b.finding_override_reason);
    const newStatus = b.submit === '1' ? 'submitted' : (existing.status === 'signed_off' ? 'signed_off' : (existing.status || 'draft'));

    // Typed signatures (drawn-pad signatures land in a later pass)
    const auditorSig = (b.auditor_signature_text || '').trim();
    const supervisorSig = (b.supervisor_signature_text || '').trim();
    const auditorSignedAt = auditorSig && !existing.auditor_signature_text ? new Date().toISOString() : existing.auditor_signed_at;
    const supervisorSignedAt = supervisorSig && !existing.supervisor_signature_text ? new Date().toISOString() : existing.supervisor_signed_at;

    db.prepare(`
      UPDATE site_audits SET
        job_id=?, project_site=?, client=?, location=?, audit_datetime=?,
        auditor_name=?, supervisor_name=?, tgs_ref=?, shift=?, weather=?,
        work_type=?, time_of_day=?,
        overall_result=?, overall_finding=?, suggested_finding=?, finding_overridden=?, finding_override_reason=?,
        responses_json=?, nonconformances_json=?,
        score_total=?, score_max=?, score_percent=?, score_weighted_percent=?, critical_fail=?, score_json=?, scoring_model_version=?,
        status=?, follow_up_required=?, follow_up_date=?,
        auditor_signature_text=?, auditor_signed_at=?, supervisor_signature_text=?, supervisor_signed_at=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.job_id || null, b.project_site || '', b.client || '', b.location || '', b.audit_datetime || '',
      b.auditor_name || '', b.supervisor_name || '', b.tgs_ref || '', b.shift || 'day', b.weather || '',
      ctx.workType, ctx.timeOfDay,
      b.overall_result || '', cols.overall_finding, cols.suggested_finding, cols.finding_overridden, cols.finding_override_reason,
      JSON.stringify({ responses, sectionComments }), JSON.stringify(nonconformances),
      cols.score_total, cols.score_max, cols.score_percent, cols.score_weighted_percent, cols.critical_fail, cols.score_json, cols.scoring_model_version,
      newStatus, b.follow_up_required ? 1 : 0, b.follow_up_date || null,
      auditorSig, auditorSignedAt, supervisorSig, supervisorSignedAt,
      req.params.id
    );

    const crewById = {}; ctx.onSiteCrew.forEach(c => { crewById[c.crew_member_id] = c; });
    const tags = buildCrewTagsFromBody(b, ctx.tpl.scoringQuestions, crewById);
    const qMeta = questionMetaOf(ctx.tpl);
    db.transaction(() => {
      persistAuditCrew(db, existing.id, b, ctx.onSiteCrew);
      persistAuditTags(db, existing.id, tags, req.session.user.id);
      syncCorrectiveActionsFromAudit(db, existing.id, { responses, questionMeta: qMeta, tags, jobId: b.job_id || null, user: req.session.user });
    })();

    if (b.job_id && newStatus === 'submitted' && existing.status !== 'submitted') {
      autoLogDiary(db, { jobId: b.job_id, summary: `[${req.session.user.full_name}] Site audit submitted — ${cols.score_weighted_percent}% (${cols.overall_finding || 'no finding'}).`, userId: req.session.user.id });
    }
    req.flash('success', 'Audit updated.');
    res.redirect('/audits/' + req.params.id);
  } catch (err) {
    console.error('[Audits] Update error:', err.message, err.stack);
    req.flash('error', 'Failed to update audit: ' + err.message);
    res.redirect('/audits/' + req.params.id + '/edit');
  }
});

// POST /:id/attachments — upload one or more files
router.post('/:id/attachments', auditUpload.array('files', 20), (req, res) => {
  const wantJson = req.query.json === '1' || (req.headers.accept || '').includes('application/json');
  try {
    const db = getDb();
    const audit = db.prepare('SELECT id FROM site_audits WHERE id = ?').get(req.params.id);
    if (!audit) { if (wantJson) return res.status(404).json({ ok: false, error: 'Audit not found' }); req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
    if (!req.files || !req.files.length) { if (wantJson) return res.status(400).json({ ok: false, error: 'No files uploaded' }); req.flash('error', 'No files uploaded.'); return res.redirect('/audits/' + req.params.id); }
    const context = (req.body.context_key || 'general').trim();
    const caption = (req.body.caption || '').trim();
    const insert = db.prepare(`INSERT INTO audit_attachments (audit_id, context_key, caption, filename, original_name, file_path, file_size, mime_type, uploaded_by_id) VALUES (?,?,?,?,?,?,?,?,?)`);
    const inserted = [];
    for (const f of req.files) {
      const servedPath = `/data/uploads/audits/${req.params.id}/${f.filename}`;
      const r = insert.run(audit.id, context, caption, f.filename, f.originalname, servedPath, f.size, f.mimetype, req.session.user.id);
      inserted.push({ id: r.lastInsertRowid, audit_id: audit.id, context_key: context, caption, filename: f.filename, original_name: f.originalname, file_path: servedPath, file_size: f.size, mime_type: f.mimetype });
    }
    if (wantJson) return res.json({ ok: true, attachments: inserted });
    req.flash('success', `${req.files.length} file(s) uploaded.`);
    res.redirect(req.body.return_to || ('/audits/' + req.params.id));
  } catch (err) {
    console.error('[Audits] Upload error:', err.message);
    if (wantJson) return res.status(500).json({ ok: false, error: err.message });
    req.flash('error', 'Upload failed: ' + err.message);
    res.redirect('/audits/' + req.params.id);
  }
});

// POST /:id/attachments/:attId/delete — delete an attachment
router.post('/:id/attachments/:attId/delete', (req, res) => {
  const wantJson = req.query.json === '1' || (req.headers.accept || '').includes('application/json');
  const db = getDb();
  const att = db.prepare('SELECT * FROM audit_attachments WHERE id = ? AND audit_id = ?').get(req.params.attId, req.params.id);
  if (att) {
    try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'uploads', 'audits', String(req.params.id), att.filename)); } catch (e) {}
    db.prepare('DELETE FROM audit_attachments WHERE id = ?').run(att.id);
  }
  if (wantJson) return res.json({ ok: true });
  req.flash('success', 'Attachment deleted.');
  res.redirect(req.body.return_to || ('/audits/' + req.params.id));
});

// POST /:id/signature/:slot — save a drawn signature (base64 PNG → disk)
router.post('/:id/signature/:slot', (req, res) => {
  const wantJson = req.query.json === '1' || (req.headers.accept || '').includes('application/json');
  const db = getDb();
  const slot = req.params.slot;
  if (!AUDIT_SIG_SLOTS.has(slot)) { if (wantJson) return res.status(400).json({ ok: false, error: 'Invalid slot' }); return res.redirect('/audits/' + req.params.id); }
  const audit = db.prepare('SELECT id FROM site_audits WHERE id = ?').get(req.params.id);
  if (!audit) { if (wantJson) return res.status(404).json({ ok: false, error: 'Audit not found' }); req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
  const filename = slot + '-' + Date.now() + '.png';
  const dest = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(req.params.id), 'signatures', filename);
  if (!writeSignaturePng(dest, req.body.signature_data)) {
    if (wantJson) return res.status(400).json({ ok: false, error: 'Invalid signature image' });
    req.flash('error', 'Could not save signature.'); return res.redirect('/audits/' + req.params.id + '/edit');
  }
  db.prepare(`UPDATE site_audits SET ${slot}_signature_path = ?, ${slot}_signed_at = COALESCE(${slot}_signed_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(filename, req.params.id);
  if (wantJson) return res.json({ ok: true, path: filename });
  res.redirect('/audits/' + req.params.id + '/edit#signoff');
});

// POST /:id/sign-off — final sign-off + write tagged exceptions to HR Reviews
router.post('/:id/sign-off', (req, res) => {
  const db = getDb();
  const audit = db.prepare('SELECT * FROM site_audits WHERE id = ?').get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/audits'); }
  // Require at least the auditor's signature (drawn or typed) before locking.
  if (!audit.auditor_signature_path && !audit.auditor_signature_text) {
    req.flash('error', 'Capture the auditor signature before signing off.');
    return res.redirect('/audits/' + req.params.id + '/edit#signoff');
  }
  db.prepare(`UPDATE site_audits SET status='signed_off', signed_off_by_id=?, signed_off_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.session.user.id, req.params.id);

  let review;
  try { review = syncAuditReviews(db, audit.id, req.session.user.id); }
  catch (e) { console.error('[Audits] review write-back error:', e.message); }

  if (audit.job_id) {
    autoLogDiary(db, { jobId: audit.job_id, summary: `[${req.session.user.full_name}] Site audit signed off — ${audit.score_weighted_percent != null ? audit.score_weighted_percent : audit.score_percent}% (${audit.overall_finding || ''}).`, userId: req.session.user.id });
  }
  let msg = 'Audit signed off.';
  if (review) {
    if (review.created || review.updated) msg += ` ${review.created + review.updated} worker review(s) recorded.`;
    if (review.skipped && review.skipped.length) msg += ` ${review.skipped.length} tag(s) skipped — worker not linked to an HR profile.`;
  }
  req.flash('success', msg);
  res.redirect('/audits/' + req.params.id);
});

// POST /:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const role = (req.session.user.role || '').toLowerCase();
  if (!['admin', 'management'].includes(role)) { req.flash('error', 'Only admin or management can delete audits.'); return res.redirect('/audits/' + req.params.id); }
  db.prepare('DELETE FROM site_audits WHERE id = ?').run(req.params.id);
  req.flash('success', 'Audit deleted.');
  res.redirect('/audits');
});

module.exports = router;
