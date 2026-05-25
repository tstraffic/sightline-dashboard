// VOC (Verification of Competency) Assessments — list / new / edit /
// update / submit / delete. Snapshots theory + practical content from
// the template into responses_json at submit time so later edits to
// the template don't retroactively change historical records.
//
// Gated to admin/operations/safety via requirePermission('voc') at the
// server.js mount. Delete + (Phase 2) revoke require admin role inline.

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { getDb } = require('../db/database');
const { normaliseRole } = require('../middleware/auth');
const { renderVocCertificatePdf } = require('../lib/pdf/vocCertificatePdf');
const { sendPushToCrew } = require('../services/pushNotification');

// Fire a push to the crew member when a VOC certificate is issued for
// them. Category 'voc_issued' is honoured by sendPushToCrew so workers
// who muted it from /w/profile/notifications get nothing. Best-effort:
// errors are logged but never block the HTTP response.
function notifyWorkerOfVocIssued(crewMemberId, equipmentName, certId, validUntil) {
  if (!crewMemberId || !certId) return;
  const bodyTail = validUntil ? ` Valid until ${validUntil}.` : '';
  sendPushToCrew(crewMemberId, {
    title: 'New VOC issued: ' + (equipmentName || 'Equipment'),
    body: 'Your certificate is ready to download in My Wallet.' + bodyTail,
    url: '/w/hr/certs',
    type: 'voc_issued',
    category: 'voc_issued',
  }).catch(err => console.error('[voc-issued push] crew', crewMemberId, ':', err.message));
}

const CERT_DIR = path.join(__dirname, '..', 'data', 'uploads', 'voc-certificates');
function ensureCertDir() {
  try { fs.mkdirSync(CERT_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

// Certificate ID: TSC-{year}-{6-char hex}-{voc_seq}, deterministic per voc.id.
// Once persisted on voc_assessments.certificate_id, never recomputed.
function deriveCertId(assessment) {
  const seedDate = assessment.valid_from || assessment.assessment_date || new Date().toISOString();
  const year = String(seedDate).slice(0, 4);
  const hex = crypto.createHash('sha256').update('voc:' + assessment.id).digest('hex').slice(0, 6).toUpperCase();
  const seq = String(assessment.id).padStart(4, '0');
  return `TSC-${year}-${hex}-${seq}`;
}

// Where the QR code points. APP_BASE_URL is set on Railway; falls back to
// the production URL per CLAUDE.md, then to localhost for dev.
function verifyUrlFor(certId) {
  const base = process.env.APP_BASE_URL || 'https://tstc.up.railway.app';
  return base.replace(/\/$/, '') + '/voc/verify/' + encodeURIComponent(certId);
}

// ────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s || ''); } catch (e) { return fallback; }
}

function arr(v) {
  return v == null ? [] : (Array.isArray(v) ? v : [v]);
}

// Add `months` to a YYYY-MM-DD date and return YYYY-MM-DD.
function addMonths(dateStr, months) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCMonth(dt.getUTCMonth() + months);
  return dt.toISOString().slice(0, 10);
}

// VOC reference numbers follow VOC-YYYY-NNNN, sequential per calendar year.
function nextVocNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `VOC-${year}-`;
  const last = db.prepare(`
    SELECT voc_number FROM voc_assessments
    WHERE voc_number LIKE ?
    ORDER BY voc_number DESC LIMIT 1
  `).get(prefix + '%');
  let n = 1;
  if (last && last.voc_number) {
    const tail = parseInt(last.voc_number.split('-').pop(), 10);
    if (Number.isFinite(tail)) n = tail + 1;
  }
  return prefix + String(n).padStart(4, '0');
}

// Build a responses payload from the multipart form body. Mirrors the
// shape used by buildResponsesFromForm in routes/tgs-risk-assessments.js
// but adapted for VOC. The template snapshot rides along so historical
// records survive future template edits unchanged.
function buildResponses(b, template) {
  const theoryQs = safeJsonParse(template.theory_questions_json, []);
  const practicalSections = safeJsonParse(template.practical_checklist_json, []);

  const prereqList = [
    'driver_licence',
    'industry_ticket',
    'inductions',
    'sop_read',
    'swms_read',
    'fit_for_duty',
    'ppe',
    'equipment_inspected',
  ];
  const prerequisites = {};
  prereqList.forEach(k => { prerequisites[k] = b['prereq_' + k] === 'on' || b['prereq_' + k] === '1'; });

  const worker_details = {
    position: b.worker_position || '',
    years_experience: b.worker_years || '',
    driver_licence: b.worker_licence || '',
    white_card: b.worker_white_card || '',
    pwz: b.worker_pwz || '',
    other_tickets: b.worker_other_tickets || '',
  };

  // Theory: one response per question. Skip server-side validation of
  // counts so saved drafts can be partial.
  const theoryAnswers = arr(b.theory_answer);
  const theoryCorrect = arr(b.theory_correct);
  const theory_responses = theoryQs.map((q, i) => ({
    q,
    response: (theoryAnswers[i] || '').toString(),
    correct: theoryCorrect[i] === 'yes',
  }));
  const theory_correct_count = theory_responses.filter(r => r.correct).length;
  const theory_total = theory_responses.length;
  const theory_pass = theory_total > 0 && (theory_correct_count / theory_total) >= 0.8;

  // Practical: walk the template sections in order; each (section, item)
  // gets a result + notes from prac_result_<sIdx>_<iIdx> + prac_notes_*.
  const practical_responses = [];
  practicalSections.forEach((sec, sIdx) => {
    (sec.items || []).forEach((item, iIdx) => {
      const ref = String.fromCharCode(65 + sIdx) + (iIdx + 1); // A1, A2, B1...
      practical_responses.push({
        section: sec.section || '',
        ref,
        label: item,
        result: b[`prac_result_${sIdx}_${iIdx}`] || '',
        notes: b[`prac_notes_${sIdx}_${iIdx}`] || '',
      });
    });
  });
  // Practical pass = every row has result='C' AND at least one row exists.
  const practical_pass = practical_responses.length > 0 &&
    practical_responses.every(r => r.result === 'C');

  return {
    prerequisites,
    worker_details,
    theory_responses,
    theory_correct_count,
    theory_total,
    theory_pass,
    practical_responses,
    practical_pass,
  };
}

// Resolve the assessment with its template joined.
function getAssessmentWithTemplate(db, id) {
  return db.prepare(`
    SELECT a.*,
      t.name AS template_name, t.item_key AS template_item_key,
      t.default_validity_months,
      t.theory_questions_json, t.practical_checklist_json,
      cm.full_name AS worker_name, cm.employee_id AS worker_emp_id,
      assessor.full_name AS assessor_name,
      manager.full_name AS manager_name
    FROM voc_assessments a
    JOIN voc_templates t ON t.id = a.template_id
    JOIN crew_members cm ON cm.id = a.crew_member_id
    LEFT JOIN users assessor ON assessor.id = a.assessor_user_id
    LEFT JOIN users manager ON manager.id = a.manager_user_id
    WHERE a.id = ?
  `).get(id);
}

// ────────────────────────────────────────────────
// LIST
// ────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const { status, outcome, template_id, crew_member_id } = req.query;
  let where = '1=1';
  const params = [];
  if (status) { where += ' AND a.status = ?'; params.push(status); }
  if (outcome) { where += ' AND a.outcome = ?'; params.push(outcome); }
  if (template_id) { where += ' AND a.template_id = ?'; params.push(template_id); }
  if (crew_member_id) { where += ' AND a.crew_member_id = ?'; params.push(crew_member_id); }
  const rows = db.prepare(`
    SELECT a.id, a.voc_number, a.status, a.outcome, a.valid_until,
      a.assessment_date, a.certificate_status, a.marking_complete,
      t.name AS template_name,
      cm.full_name AS worker_name, cm.employee_id AS worker_emp_id,
      assessor.full_name AS assessor_name
    FROM voc_assessments a
    JOIN voc_templates t ON t.id = a.template_id
    JOIN crew_members cm ON cm.id = a.crew_member_id
    LEFT JOIN users assessor ON assessor.id = a.assessor_user_id
    WHERE ${where}
    ORDER BY a.created_at DESC
    LIMIT 500
  `).all(...params);

  // Pending Marking queue — quick-cert rows that still need their
  // theory/practical responses entered. Always loaded so the
  // assessor can see the backlog from the top of the index regardless
  // of which filters are active in the main list.
  const pendingMarking = db.prepare(`
    SELECT a.id, a.voc_number, a.assessment_date, a.valid_until,
      a.certificate_id, t.name AS template_name,
      cm.full_name AS worker_name, cm.employee_id AS worker_emp_id,
      assessor.full_name AS assessor_name
    FROM voc_assessments a
    JOIN voc_templates t ON t.id = a.template_id
    JOIN crew_members cm ON cm.id = a.crew_member_id
    LEFT JOIN users assessor ON assessor.id = a.assessor_user_id
    WHERE a.marking_complete = 0
    ORDER BY a.created_at DESC
    LIMIT 200
  `).all();

  const templates = db.prepare('SELECT id, name FROM voc_templates ORDER BY sort_order').all();
  res.render('voc-assessments/index', {
    title: 'Verifications of Competency',
    assessments: rows,
    pendingMarking,
    templates,
    filters: { status: status || '', outcome: outcome || '', template_id: template_id || '', crew_member_id: crew_member_id || '' },
    user: req.session.user,
    currentPage: 'voc-assessments',
  });
});

// ────────────────────────────────────────────────
// QUICK CERT GENERATOR
// Built for live VOC sessions where 30+ people queue for certificates.
// Bypasses the full assessor flow: the assessor types name + date +
// signatures, hits Save, walks away with a printable cert. Theory +
// practical responses are filled in later from the Pending Marking
// queue. status='submitted', outcome='competent', marking_complete=0.
// ────────────────────────────────────────────────
router.get('/quick', (req, res) => {
  const db = getDb();
  const templates = db.prepare(`
    SELECT id, name, item_key, default_validity_months
    FROM voc_templates WHERE active = 1 ORDER BY sort_order
  `).all();
  // Active crew names → <datalist> for typeahead so common cases reuse
  // the existing crew_member row instead of spawning duplicates.
  const workers = db.prepare(`
    SELECT id, full_name, employee_id FROM crew_members
    WHERE active = 1 ORDER BY full_name
  `).all();
  // Carry the "last submitted" stats through the redirect chain so the
  // assessor sees a running tally as they rapid-fire through the queue.
  const sessionCount = req.session.quickVocCount || 0;
  const lastQuick = req.session.lastQuickVoc || null;
  res.render('voc-assessments/quick', {
    title: 'Quick VOC Certificate',
    templates,
    workers,
    sessionCount,
    lastQuick,
    today: new Date().toISOString().slice(0, 10),
    user: req.session.user,
    currentPage: 'voc-assessments',
  });
});

router.post('/quick', async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const templateId = parseInt(b.template_id, 10);
  const typedName = String(b.worker_name || '').trim();
  if (!templateId || !typedName) {
    req.flash('error', 'Pick an equipment template and type a worker name.');
    return res.redirect('/voc-assessments/quick');
  }
  const tpl = db.prepare('SELECT id, default_validity_months FROM voc_templates WHERE id = ? AND active = 1').get(templateId);
  if (!tpl) {
    req.flash('error', 'That equipment template is no longer active.');
    return res.redirect('/voc-assessments/quick');
  }

  // Find-or-create the crew_member. Exact (case-insensitive) full_name
  // match on active crew wins; otherwise spin up a sparse row that HR
  // can finish onboarding later. Auto-created rows get a placeholder
  // employee_id ('VOC-PENDING-<ts>') so they're easy to find + clean
  // up if they shouldn't have been created.
  let crewId = parseInt(b.crew_member_id, 10);
  if (!crewId) {
    const existing = db.prepare(`
      SELECT id FROM crew_members
      WHERE active = 1 AND LOWER(full_name) = LOWER(?)
      LIMIT 1
    `).get(typedName);
    if (existing) {
      crewId = existing.id;
    } else {
      const placeholderEmpId = 'VOC-PENDING-' + Date.now().toString(36).toUpperCase();
      const ins = db.prepare(`
        INSERT INTO crew_members (full_name, employee_id, active)
        VALUES (?, ?, 1)
      `).run(typedName, placeholderEmpId);
      crewId = ins.lastInsertRowid;
    }
  }

  const today = (b.assessment_date || new Date().toISOString().slice(0, 10));
  const validityMonths = parseInt(b.validity_months, 10) || tpl.default_validity_months || 24;
  const validFrom = today;
  const validUntil = addMonths(validFrom, validityMonths);
  const assessorSigned = String(b.assessor_signed_name || '').trim();
  const workerSigned = String(b.worker_signed_name || '').trim() || typedName;

  const vocNumber = nextVocNumber(db);

  try {
    const result = db.prepare(`
      INSERT INTO voc_assessments
        (voc_number, template_id, crew_member_id, assessor_user_id,
         assessment_type, assessment_date, location_site,
         status, outcome,
         worker_signed_name, worker_signed_date,
         assessor_signed_name, assessor_signed_date,
         valid_from, valid_until,
         marking_complete,
         created_by_id)
      VALUES (?, ?, ?, ?, 'initial', ?, ?, 'submitted', 'competent',
              ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      vocNumber, templateId, crewId, req.session.user.id,
      today, b.location_site || '',
      workerSigned, today,
      assessorSigned, today,
      validFrom, validUntil,
      req.session.user.id
    );
    const newId = result.lastInsertRowid;

    // Generate the certificate PDF immediately — that's the whole point
    // of the quick path. The full record is hydrated via the same
    // template join the regular submit flow uses so the cert looks
    // identical to one produced through the full assessment.
    const fresh = getAssessmentWithTemplate(db, newId);
    const certId = deriveCertId(fresh);
    try {
      ensureCertDir();
      const pdfBuf = await renderVocCertificatePdf(fresh, certId, verifyUrlFor(certId));
      const filename = `voc-${fresh.id}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(CERT_DIR, filename), pdfBuf);
      const relPath = 'voc-certificates/' + filename;
      db.prepare(`
        UPDATE voc_assessments
        SET certificate_id = ?, certificate_status = 'active',
            pdf_path = ?, pdf_generated_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(certId, relPath, fresh.id);
    } catch (e) {
      console.error('[voc-quick] PDF generation failed:', e);
      db.prepare(`
        UPDATE voc_assessments SET certificate_id = ?, certificate_status = 'active'
        WHERE id = ? AND certificate_id IS NULL
      `).run(certId, fresh.id);
    }

    // Push the worker a "your VOC is ready" notification. No-op for
    // VOC-PENDING-* auto-created rows since they don't have a worker
    // PIN / push subscription yet — sendPushToCrew returns
    // {reason: 'no-subscriptions'} which is fine.
    notifyWorkerOfVocIssued(crewId, fresh.template_name, certId, validUntil);

    // Stash redirect breadcrumbs so the form re-renders with a running
    // count and a download link for the cert that was just issued.
    req.session.quickVocCount = (req.session.quickVocCount || 0) + 1;
    req.session.lastQuickVoc = {
      id: newId,
      certId,
      vocNumber,
      workerName: typedName,
      templateId,
      assessor: assessorSigned,
      assessmentDate: today,
      validityMonths,
    };

    req.flash('success', `Cert issued for ${typedName} (${certId}). Theory + practical pending marking.`);
    res.redirect('/voc-assessments/quick');
  } catch (err) {
    console.error('[voc-quick] create error:', err);
    req.flash('error', 'Failed to create quick cert: ' + err.message);
    res.redirect('/voc-assessments/quick');
  }
});

// ────────────────────────────────────────────────
// NEW (picker)
// ────────────────────────────────────────────────
router.get('/new', (req, res) => {
  const db = getDb();
  const templates = db.prepare(`
    SELECT id, name, item_key, default_validity_months, theory_questions_json, practical_checklist_json
    FROM voc_templates WHERE active = 1 ORDER BY sort_order
  `).all().map(t => ({
    ...t,
    theory_count: safeJsonParse(t.theory_questions_json, []).length,
    practical_count: safeJsonParse(t.practical_checklist_json, []).reduce((n, s) => n + (Array.isArray(s.items) ? s.items.length : 0), 0),
  }));
  const workers = db.prepare(`
    SELECT id, full_name, employee_id FROM crew_members
    WHERE active = 1 ORDER BY full_name
  `).all();
  res.render('voc-assessments/new', {
    title: 'New VOC',
    templates,
    workers,
    user: req.session.user,
    currentPage: 'voc-assessments',
  });
});

// ────────────────────────────────────────────────
// CREATE
// ────────────────────────────────────────────────
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const templateId = parseInt(b.template_id, 10);
  const crewId = parseInt(b.crew_member_id, 10);
  if (!templateId || !crewId) {
    req.flash('error', 'Pick a worker and an equipment template.');
    return res.redirect('/voc-assessments/new');
  }
  const tpl = db.prepare('SELECT id FROM voc_templates WHERE id = ?').get(templateId);
  const worker = db.prepare('SELECT id FROM crew_members WHERE id = ?').get(crewId);
  if (!tpl || !worker) {
    req.flash('error', 'Invalid worker or template.');
    return res.redirect('/voc-assessments/new');
  }
  const vocNumber = nextVocNumber(db);
  const today = new Date().toISOString().slice(0, 10);

  try {
    const result = db.prepare(`
      INSERT INTO voc_assessments
        (voc_number, template_id, crew_member_id, assessor_user_id,
         assessment_type, assessment_date, status, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      vocNumber, templateId, crewId, req.session.user.id,
      b.assessment_type || 'initial', today, req.session.user.id
    );
    req.flash('success', `Created ${vocNumber}.`);
    res.redirect(`/voc-assessments/${result.lastInsertRowid}/edit`);
  } catch (err) {
    console.error('[voc-assessments] create error:', err);
    req.flash('error', 'Failed to create VOC: ' + err.message);
    res.redirect('/voc-assessments/new');
  }
});

// ────────────────────────────────────────────────
// EDIT
// ────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const a = getAssessmentWithTemplate(db, req.params.id);
  if (!a) { req.flash('error', 'VOC not found.'); return res.redirect('/voc-assessments'); }

  const theoryQs = safeJsonParse(a.theory_questions_json, []);
  const practicalSections = safeJsonParse(a.practical_checklist_json, []);
  const theoryResponses = safeJsonParse(a.theory_responses_json, []);
  const practicalResponses = safeJsonParse(a.practical_responses_json, []);
  const prerequisites = safeJsonParse(a.prerequisites_json, {});
  const workerDetails = safeJsonParse(a.worker_details_json, {});

  // Build a lookup by ref for hydrating practical responses against the
  // current template structure (responses indexed by ref like 'A1').
  const practicalByRef = {};
  practicalResponses.forEach(r => { if (r.ref) practicalByRef[r.ref] = r; });

  const users = db.prepare(`
    SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name
  `).all();

  res.render('voc-assessments/form', {
    title: `Edit ${a.voc_number || ('VOC #' + a.id)}`,
    a,
    theoryQs,
    practicalSections,
    theoryResponses,
    practicalByRef,
    prerequisites,
    workerDetails,
    users,
    user: req.session.user,
    currentPage: 'voc-assessments',
    isSubmitted: a.status === 'submitted',
  });
});

// ────────────────────────────────────────────────
// UPDATE (save draft / re-save submitted)
// ────────────────────────────────────────────────
router.post('/:id', (req, res) => {
  const db = getDb();
  const existing = getAssessmentWithTemplate(db, req.params.id);
  if (!existing) { req.flash('error', 'VOC not found.'); return res.redirect('/voc-assessments'); }
  const b = req.body;
  const responses = buildResponses(b, existing);

  // A quick-cert row flips to marking_complete=1 once the assessor
  // enters at least one real response on either side. "Real response"
  // means a non-empty theory answer OR a non-empty practical result —
  // template counts alone don't qualify (those are baseline, not
  // marking work). Records that started marking_complete=1 stay 1.
  const anyTheoryAnswered = responses.theory_responses.some(r =>
    String(r.response || '').trim() !== '' || r.correct
  );
  const anyPracticalMarked = responses.practical_responses.some(r =>
    String(r.result || '').trim() !== ''
  );
  const markingComplete = existing.marking_complete ? 1
    : ((anyTheoryAnswered || anyPracticalMarked) ? 1 : 0);

  try {
    db.prepare(`
      UPDATE voc_assessments SET
        assessment_type = ?, assessment_type_other_text = ?,
        assessment_date = ?, location_site = ?,
        assessor_user_id = ?, manager_user_id = ?,
        prerequisites_json = ?, worker_details_json = ?,
        theory_responses_json = ?, theory_correct_count = ?, theory_total = ?, theory_pass = ?,
        practical_responses_json = ?, practical_pass = ?,
        valid_from = ?, valid_until = ?,
        reassessment_trigger = ?, assessor_comments = ?,
        worker_signed_name = ?, worker_signed_date = ?,
        assessor_signed_name = ?, assessor_signed_date = ?,
        manager_signed_name = ?, manager_signed_position = ?, manager_signed_date = ?,
        records_filed_yes = ?, records_filed_by = ?, records_filed_date = ?,
        copy_to_worker_yes = ?, matrix_entered_by = ?,
        marking_complete = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.assessment_type || existing.assessment_type, b.assessment_type_other_text || '',
      b.assessment_date || null, b.location_site || '',
      b.assessor_user_id ? parseInt(b.assessor_user_id, 10) : null,
      b.manager_user_id ? parseInt(b.manager_user_id, 10) : null,
      JSON.stringify(responses.prerequisites),
      JSON.stringify(responses.worker_details),
      JSON.stringify(responses.theory_responses),
      responses.theory_correct_count, responses.theory_total, responses.theory_pass ? 1 : 0,
      JSON.stringify(responses.practical_responses), responses.practical_pass ? 1 : 0,
      b.valid_from || null, b.valid_until || null,
      b.reassessment_trigger || '', b.assessor_comments || '',
      b.worker_signed_name || '', b.worker_signed_date || null,
      b.assessor_signed_name || '', b.assessor_signed_date || null,
      b.manager_signed_name || '', b.manager_signed_position || '', b.manager_signed_date || null,
      b.records_filed_yes === 'on' ? 1 : 0, b.records_filed_by || '', b.records_filed_date || null,
      b.copy_to_worker_yes === 'on' ? 1 : 0, b.matrix_entered_by || '',
      markingComplete,
      existing.id
    );
    // Show a clear flash when a quick-cert just transitioned to fully
    // marked so the assessor knows the backlog shrank.
    if (!existing.marking_complete && markingComplete) {
      req.flash('success', 'Marking complete — VOC removed from pending queue.');
    } else {
      req.flash('success', 'Saved.');
    }
  } catch (err) {
    console.error('[voc-assessments] update error:', err);
    req.flash('error', 'Failed to save: ' + err.message);
  }
  res.redirect(`/voc-assessments/${existing.id}/edit`);
});

// ────────────────────────────────────────────────
// SUBMIT (finalize, set outcome + expiry)
// ────────────────────────────────────────────────
router.post('/:id/submit', async (req, res) => {
  const db = getDb();
  const existing = getAssessmentWithTemplate(db, req.params.id);
  if (!existing) { req.flash('error', 'VOC not found.'); return res.redirect('/voc-assessments'); }
  const b = req.body;
  const responses = buildResponses(b, existing);

  // Outcome rule: competent iff theory_pass AND practical_pass AND
  // user didn't explicitly select NYC. The form sends `outcome_select`
  // = 'competent' | 'nyc'; trust it but cross-check.
  const wantsCompetent = b.outcome_select === 'competent';
  const canBeCompetent = responses.theory_pass && responses.practical_pass;
  const outcome = (wantsCompetent && canBeCompetent) ? 'competent' : 'nyc';

  // Manager block required when outcome is NYC, or when the assessment
  // type indicates a tenure/incident scenario.
  if (outcome === 'nyc') {
    if (!b.manager_signed_name || !b.manager_signed_date) {
      req.flash('error', 'NYC outcomes require Manager / Supervisor sign-off (name + date).');
      return res.redirect(`/voc-assessments/${existing.id}/edit`);
    }
  }
  if (!b.assessor_signed_name) {
    req.flash('error', 'Assessor signature name is required to submit.');
    return res.redirect(`/voc-assessments/${existing.id}/edit`);
  }

  const validFrom = b.valid_from || existing.assessment_date || new Date().toISOString().slice(0, 10);
  const validUntil = b.valid_until || addMonths(validFrom, existing.default_validity_months || 24);

  try {
    db.prepare(`
      UPDATE voc_assessments SET
        status = 'submitted', outcome = ?,
        valid_from = ?, valid_until = ?,
        assessment_type = ?, assessment_type_other_text = ?,
        assessment_date = ?, location_site = ?,
        assessor_user_id = ?, manager_user_id = ?,
        prerequisites_json = ?, worker_details_json = ?,
        theory_responses_json = ?, theory_correct_count = ?, theory_total = ?, theory_pass = ?,
        practical_responses_json = ?, practical_pass = ?,
        reassessment_trigger = ?, assessor_comments = ?,
        worker_signed_name = ?, worker_signed_date = ?,
        assessor_signed_name = ?, assessor_signed_date = ?,
        manager_signed_name = ?, manager_signed_position = ?, manager_signed_date = ?,
        records_filed_yes = ?, records_filed_by = ?, records_filed_date = ?,
        copy_to_worker_yes = ?, matrix_entered_by = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      outcome, validFrom, validUntil,
      b.assessment_type || existing.assessment_type, b.assessment_type_other_text || '',
      b.assessment_date || existing.assessment_date, b.location_site || '',
      b.assessor_user_id ? parseInt(b.assessor_user_id, 10) : null,
      b.manager_user_id ? parseInt(b.manager_user_id, 10) : null,
      JSON.stringify(responses.prerequisites),
      JSON.stringify(responses.worker_details),
      JSON.stringify(responses.theory_responses),
      responses.theory_correct_count, responses.theory_total, responses.theory_pass ? 1 : 0,
      JSON.stringify(responses.practical_responses), responses.practical_pass ? 1 : 0,
      b.reassessment_trigger || '', b.assessor_comments || '',
      b.worker_signed_name || '', b.worker_signed_date || null,
      b.assessor_signed_name || '', b.assessor_signed_date || null,
      b.manager_signed_name || '', b.manager_signed_position || '', b.manager_signed_date || null,
      b.records_filed_yes === 'on' ? 1 : 0, b.records_filed_by || '', b.records_filed_date || null,
      b.copy_to_worker_yes === 'on' ? 1 : 0, b.matrix_entered_by || '',
      existing.id
    );

    // On Competent: assign a certificate id (idempotent — only if missing)
    // and regenerate the PDF. A revoked cert that's re-submitted as
    // competent flips back to 'active'.
    if (outcome === 'competent') {
      const fresh = getAssessmentWithTemplate(db, existing.id);
      const certId = fresh.certificate_id || deriveCertId(fresh);
      const isFirstIssue = !fresh.certificate_id;
      try {
        ensureCertDir();
        const pdfBuf = await renderVocCertificatePdf(fresh, certId, verifyUrlFor(certId));
        const filename = `voc-${fresh.id}-${Date.now()}.pdf`;
        fs.writeFileSync(path.join(CERT_DIR, filename), pdfBuf);
        const relPath = 'voc-certificates/' + filename;
        db.prepare(`
          UPDATE voc_assessments
          SET certificate_id = ?, certificate_status = 'active',
              certificate_revoked_at = NULL, certificate_revoked_by = NULL,
              certificate_revoked_reason = '',
              pdf_path = ?, pdf_generated_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(certId, relPath, fresh.id);
      } catch (e) {
        console.error('[voc-assessments] cert PDF generation failed:', e);
        // Persist cert_id even if PDF render fails so the verify URL stays
        // stable; the next download attempt can regenerate the PDF.
        db.prepare(`
          UPDATE voc_assessments SET certificate_id = ?, certificate_status = 'active'
          WHERE id = ? AND certificate_id IS NULL
        `).run(certId, fresh.id);
      }
      // Only push on the FIRST issue — re-saves of an already-competent
      // assessment (e.g. fixing a typo in assessor comments) shouldn't
      // re-notify. Also suppresses re-pushes for previously-revoked
      // certs that are being reinstated — admins do that explicitly via
      // /unrevoke, not the submit flow.
      if (isFirstIssue) {
        notifyWorkerOfVocIssued(fresh.crew_member_id, fresh.template_name, certId, validUntil);
      }
    }

    req.flash('success', outcome === 'competent'
      ? `Submitted as Competent. Certificate issued — valid until ${validUntil}.`
      : 'Submitted as Not Yet Competent. Schedule re-assessment.');
  } catch (err) {
    console.error('[voc-assessments] submit error:', err);
    req.flash('error', 'Failed to submit: ' + err.message);
  }
  res.redirect(`/voc-assessments/${existing.id}/edit`);
});

// ────────────────────────────────────────────────
// CERTIFICATE PREVIEW
// Screen-only render of what the Phase 2 cert will look like. Renders
// the certificate.ejs view with the existing voc_assessments record.
// Phase 2 will: persist a real certificate_id at submit time, embed a
// real QR via the qrcode npm dep, and pipe this through PDFKit for
// download. Right now it's a preview — useful for getting the layout +
// branding signed off before wiring up the full Phase 2 flow.
// ────────────────────────────────────────────────
router.get('/:id/certificate', async (req, res) => {
  const db = getDb();
  const a = getAssessmentWithTemplate(db, req.params.id);
  if (!a) { req.flash('error', 'VOC not found.'); return res.redirect('/voc-assessments'); }
  if (a.outcome !== 'competent') {
    req.flash('error', 'Only Competent assessments have a certificate.');
    return res.redirect(`/voc-assessments/${a.id}/edit`);
  }
  const certId = a.certificate_id || deriveCertId(a);
  const verifyUrl = verifyUrlFor(certId);
  let qrDataUrl = '';
  try {
    qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: { dark: '#1f3864', light: '#FFFFFF' },
    });
  } catch (e) {
    console.error('[voc-assessments] QR generation failed:', e);
  }
  res.render('voc-assessments/certificate', {
    a, certId, qrDataUrl, verifyUrl,
    isRevoked: a.certificate_status === 'revoked',
    // Use a bare layout (no admin chrome) since the cert is its own page.
    layout: false,
  });
});

// ────────────────────────────────────────────────
// CERTIFICATE PDF DOWNLOAD
// Streams the persisted PDF; regenerates on the fly if missing (e.g. first
// download after a Railway redeploy that lost the uploads volume contents).
// ────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  const db = getDb();
  const a = getAssessmentWithTemplate(db, req.params.id);
  if (!a || a.outcome !== 'competent') return res.status(404).send('Certificate not available.');
  const certId = a.certificate_id || deriveCertId(a);
  let pdfBuffer = null;
  if (a.pdf_path) {
    const full = path.join(__dirname, '..', 'data', 'uploads', path.basename(path.dirname(a.pdf_path)), path.basename(a.pdf_path));
    // Fallback resolution — the pdf_path is stored as 'voc-certificates/<file>'.
    const altFull = path.join(CERT_DIR, path.basename(a.pdf_path));
    const which = fs.existsSync(altFull) ? altFull : (fs.existsSync(full) ? full : null);
    if (which) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${certId}.pdf"`);
      return fs.createReadStream(which).pipe(res);
    }
  }
  try {
    pdfBuffer = await renderVocCertificatePdf(a, certId, verifyUrlFor(certId));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${certId}.pdf"`);
    return res.end(pdfBuffer);
  } catch (e) {
    console.error('[voc-assessments] PDF render failed:', e);
    return res.status(500).send('Failed to render certificate.');
  }
});

// ────────────────────────────────────────────────
// REVOKE CERTIFICATE (admin only)
// Worker portal + public verify page reflect immediately.
// ────────────────────────────────────────────────
router.post('/:id/revoke', (req, res) => {
  if (normaliseRole(req.session.user.role) !== 'admin') {
    req.flash('error', 'Only admins can revoke certificates.');
    return res.redirect(`/voc-assessments/${req.params.id}/edit`);
  }
  const db = getDb();
  const a = db.prepare('SELECT id, certificate_id, certificate_status FROM voc_assessments WHERE id = ?').get(req.params.id);
  if (!a || !a.certificate_id) {
    req.flash('error', 'No certificate to revoke.');
    return res.redirect(`/voc-assessments/${req.params.id}/edit`);
  }
  const reason = (req.body.reason || '').trim();
  if (!reason) {
    req.flash('error', 'Provide a revocation reason.');
    return res.redirect(`/voc-assessments/${req.params.id}/edit`);
  }
  db.prepare(`
    UPDATE voc_assessments
    SET certificate_status = 'revoked',
        certificate_revoked_at = CURRENT_TIMESTAMP,
        certificate_revoked_by = ?,
        certificate_revoked_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.session.user.id, reason, a.id);
  req.flash('success', `Certificate ${a.certificate_id} revoked.`);
  res.redirect(`/voc-assessments/${a.id}/edit`);
});

// ────────────────────────────────────────────────
// UNREVOKE — restore an active cert (admin only).
// Useful when a revoke was made in error; doesn't reset
// the worker's underlying competency record.
// ────────────────────────────────────────────────
router.post('/:id/unrevoke', (req, res) => {
  if (normaliseRole(req.session.user.role) !== 'admin') {
    req.flash('error', 'Only admins can change certificate status.');
    return res.redirect(`/voc-assessments/${req.params.id}/edit`);
  }
  const db = getDb();
  db.prepare(`
    UPDATE voc_assessments
    SET certificate_status = 'active',
        certificate_revoked_at = NULL,
        certificate_revoked_by = NULL,
        certificate_revoked_reason = '',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.params.id);
  req.flash('success', 'Certificate restored to active.');
  res.redirect(`/voc-assessments/${req.params.id}/edit`);
});

// ────────────────────────────────────────────────
// DELETE (admin only)
// ────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  if (normaliseRole(req.session.user.role) !== 'admin') {
    req.flash('error', 'Only admins can delete VOCs.');
    return res.redirect(`/voc-assessments/${req.params.id}/edit`);
  }
  const db = getDb();
  try {
    db.prepare('DELETE FROM voc_assessments WHERE id = ?').run(req.params.id);
    req.flash('success', 'VOC deleted.');
  } catch (err) {
    req.flash('error', 'Delete failed: ' + err.message);
  }
  res.redirect('/voc-assessments');
});

module.exports = router;
