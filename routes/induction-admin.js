const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { employeeGuideSlides, tcTrainingSlides } = require('../induction-slides');
const { encrypt } = require('../services/encryption');
const { currentVersion: currentSopVersion, ackText: sopAckText, activeDocuments: activeSopDocuments } = require('../lib/sop');
const { maybeMarkInducted } = require('../lib/induction');
const { findExistingCrew } = require('../lib/crewDedup');

// SOP document uploads — accept PDFs first, also images/Word docs as a
// fallback in case the user has an existing file format that's not PDF.
const SOP_DOC_DIR = path.join(__dirname, '..', 'data', 'uploads', 'sop-documents');
const SOP_PAGE_DIR = path.join(SOP_DOC_DIR, 'page-renders');
const { renderPdfToPngs } = require('../lib/pdf-render');

// Render the PDF's pages and save the filenames on the row. Called from the
// upload handler and the re-render endpoint. Best-effort — the original PDF
// is still served even if this fails, and the mobile sign page falls back
// to an iframe.
async function renderAndPersistPages(db, docRow) {
  if (!/pdf/i.test(docRow.mime_type) && !/\.pdf$/i.test(docRow.original_name)) return { pages: [], error: null };
  try {
    const out = path.join(SOP_PAGE_DIR, String(docRow.id));
    fs.mkdirSync(out, { recursive: true });
    const pages = await renderPdfToPngs(docRow.file_path, out);
    db.prepare('UPDATE sop_documents SET page_renders = ? WHERE id = ?').run(JSON.stringify(pages), docRow.id);
    return { pages, error: null };
  } catch (e) {
    console.error(`[sop-render] doc ${docRow.id} failed:`, e.message);
    return { pages: [], error: e.message };
  }
}

// Same idea, but for a single child file row in sop_document_files.
// Renders into page-renders/<page_renders_dir>/ — each file gets its own
// directory so the legacy parent-keyed renders don't collide with new ones.
async function renderAndPersistPagesForFile(db, fileRow) {
  if (!/pdf/i.test(fileRow.mime_type || '') && !/\.pdf$/i.test(fileRow.original_name || '')) {
    return { pages: [], error: null };
  }
  try {
    const dirKey = fileRow.page_renders_dir || `file-${fileRow.id}`;
    const out = path.join(SOP_PAGE_DIR, dirKey);
    fs.mkdirSync(out, { recursive: true });
    const pages = await renderPdfToPngs(fileRow.file_path, out);
    db.prepare('UPDATE sop_document_files SET page_renders = ?, page_renders_dir = ? WHERE id = ?')
      .run(JSON.stringify(pages), dirKey, fileRow.id);
    return { pages, error: null };
  } catch (e) {
    console.error(`[sop-render] file ${fileRow.id} failed:`, e.message);
    return { pages: [], error: e.message };
  }
}

// Keep the parent sop_documents row in sync with the first child file so
// older code paths that still read parent columns (e.g. /sop-documents/:id/file,
// /sop-sign/:token/document/:id) keep working. Called whenever a section's
// file list changes — upload of first file, deletion, reordering, etc.
function syncParentToFirstFile(db, sopDocumentId) {
  const first = db.prepare(`
    SELECT id, filename, original_name, file_path, file_size, mime_type, page_renders
    FROM sop_document_files
    WHERE sop_document_id = ?
    ORDER BY display_order ASC, id ASC
    LIMIT 1
  `).get(sopDocumentId);
  if (first) {
    db.prepare(`
      UPDATE sop_documents
      SET filename = ?, original_name = ?, file_path = ?, file_size = ?, mime_type = ?, page_renders = ?
      WHERE id = ?
    `).run(
      first.filename, first.original_name, first.file_path,
      first.file_size || 0, first.mime_type || '', first.page_renders || null,
      sopDocumentId
    );
  } else {
    // No files left on the section — null out the parent file columns so the
    // section is visibly empty in the UI.
    db.prepare(`
      UPDATE sop_documents
      SET filename = '', original_name = '', file_path = '', file_size = 0, mime_type = '', page_renders = NULL
      WHERE id = ?
    `).run(sopDocumentId);
  }
}

// Load all files for a section in display order. Used by the admin view to
// list files under each section.
function loadFilesForSection(db, sopDocumentId) {
  return db.prepare(`
    SELECT id, sop_document_id, filename, original_name, file_path, file_size, mime_type,
           page_renders, page_renders_dir, display_order, created_at
    FROM sop_document_files
    WHERE sop_document_id = ?
    ORDER BY display_order ASC, id ASC
  `).all(sopDocumentId).map(r => {
    let pageCount = 0;
    if (r.page_renders) { try { pageCount = (JSON.parse(r.page_renders) || []).length; } catch (e) {} }
    return { ...r, pageCount };
  });
}

const sopDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(SOP_DOC_DIR, { recursive: true });
    cb(null, SOP_DOC_DIR);
  },
  filename: (req, file, cb) => {
    const safe = (file.originalname || 'doc').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${safe}`);
  }
});
const sopDocUpload = multer({
  storage: sopDocStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB per doc
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|png|jpe?g|webp|docx?|xlsx?)$/i.test(file.originalname);
    if (!ok) return cb(new Error('Only PDF, image, Word or Excel files are allowed'));
    cb(null, true);
  },
});

// Copy the bank / super / TFN payroll data from an induction submission into
// the three encrypted per-employee tables. Skips any table that already has a
// row for this employee so we never overwrite something the worker has edited
// in the portal. Returns an array describing what was seeded — useful for the
// admin flash and the backfill migration.
function seedPayrollFromSubmission(db, employeeId, submission) {
  const seeded = [];
  if (!employeeId || !submission) return seeded;

  // Bank — BSB + account number encrypted; last-3 stored for UI hints
  try {
    const hasBank = db.prepare('SELECT 1 FROM bank_accounts WHERE employee_id = ?').get(employeeId);
    const bsb = (submission.bank_bsb || '').replace(/\s|-/g, '');
    const acct = (submission.bank_account_number || '').replace(/\s|-/g, '');
    if (!hasBank && /^\d{6}$/.test(bsb) && /^\d{6,10}$/.test(acct)) {
      db.prepare(`
        INSERT INTO bank_accounts (employee_id, account_name, bsb_last3, account_last3,
          bsb_encrypted, account_number_encrypted, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        employeeId,
        (submission.bank_account_name || submission.full_name || '').trim(),
        bsb.slice(-3),
        acct.slice(-3),
        encrypt(bsb),
        encrypt(acct),
      );
      seeded.push('bank');
    }
  } catch (e) { console.log('[seedPayroll] bank skipped:', e.message); }

  // Super — fund name, USI, member number, ABN
  try {
    const hasSuper = db.prepare('SELECT 1 FROM super_funds WHERE employee_id = ?').get(employeeId);
    const hasAny = (submission.super_fund_name || submission.super_usi || submission.super_member_number || submission.super_fund_abn);
    if (!hasSuper && hasAny) {
      db.prepare(`
        INSERT INTO super_funds (employee_id, fund_name, usi, member_number, fund_abn, use_default, status)
        VALUES (?, ?, ?, ?, ?, 0, 'pending')
      `).run(
        employeeId,
        (submission.super_fund_name || '').trim(),
        (submission.super_usi || '').trim(),
        (submission.super_member_number || '').trim(),
        (submission.super_fund_abn || '').replace(/\s/g, '').trim(),
      );
      seeded.push('super');
    }
  } catch (e) { console.log('[seedPayroll] super skipped:', e.message); }

  // TFN — encrypted; last-3 stored for UI hints
  try {
    const hasTfn = db.prepare('SELECT 1 FROM tfn_declarations WHERE employee_id = ?').get(employeeId);
    const tfn = (submission.tax_file_number || '').replace(/\D/g, '');
    if (!hasTfn && /^\d{9}$/.test(tfn)) {
      db.prepare(`
        INSERT INTO tfn_declarations (employee_id, tfn_encrypted, tfn_last3,
          residency_status, claim_threshold, has_help_debt, has_stsl_debt,
          medicare_variation, submitted_at, status)
        VALUES (?, ?, ?, 'resident', 1, 0, 0, 'none', datetime('now'), 'pending')
      `).run(employeeId, encrypt(tfn), tfn.slice(-3));
      seeded.push('tfn');
    }
  } catch (e) { console.log('[seedPayroll] tfn skipped:', e.message); }

  return seeded;
}

// Allocate a unique EMP-XXX code based on the largest numeric suffix actually
// in crew_members (ignoring non-numeric codes like EMP-TEST) and verify
// it isn't already taken. Returns a string like "EMP-001".
function allocateEmployeeId(db) {
  // Scan BOTH crew_members.employee_id AND employees.employee_code for the
  // largest numeric suffix, so a code already used by an unlinked employee
  // record can't be reissued (which would collide on the employees insert).
  const rows = db.prepare(`
    SELECT employee_id AS code FROM crew_members WHERE employee_id LIKE 'EMP-%'
    UNION ALL
    SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP-%'
  `).all();
  let maxNum = 0;
  for (const r of rows) {
    const suffix = (r.code || '').replace(/^EMP-/, '');
    if (/^\d+$/.test(suffix)) {
      const n = parseInt(suffix, 10);
      if (n > maxNum) maxNum = n;
    }
  }
  const checkCrew = db.prepare('SELECT 1 FROM crew_members WHERE employee_id = ?');
  const checkEmp = db.prepare('SELECT 1 FROM employees WHERE employee_code = ?');
  for (let tries = 0; tries < 1000; tries++) {
    const candidate = `EMP-${String(maxNum + 1 + tries).padStart(3, '0')}`;
    if (!checkCrew.get(candidate) && !checkEmp.get(candidate)) return candidate;
  }
  throw new Error('Could not allocate a free employee_id after 1000 attempts');
}

// Import induction file uploads as employee_documents AND create the matching
// employee_competencies rows so the worker's wallet shows both the file and
// the structured cert record. Used by both the "approve" and the manual
// "convert" routes — kept identical between them so the two paths can never
// drift.
//
// Mapping (induction field → document type → competency):
//   white_card_photo   → white_card     → "SafeWork NSW White Card"
//   tc_licence_photo   → tc_licence     → "Traffic Control and IMP Licenses"
//   drivers_licence_*  → drivers_licence_* (file only; not a competency)
function importInductionDocsAndCompetencies(db, submission, newEmpId, userId) {
  const { ensureCompetencyForDoc } = require('../lib/competencyMap');
  const inductionUploadsDir = path.resolve(__dirname, '..', 'data', 'uploads', 'inductions');
  const hrUploadsBase = path.resolve(__dirname, '..', 'data', 'uploads', 'hr');

  // Per-mapping competency_level captures the cert/ID number from the
  // induction form so it shows alongside the competency. document_type values
  // here MUST match the keys in lib/competencyMap.js for the mirror to fire.
  const docMappings = [
    { field: 'white_card_photo', type: 'white_card', name: 'White Card', mandatory: 1,
      level: submission.white_card_number || '', issueDate: null },
    { field: 'tc_licence_photo', type: 'tc_licence', name: 'TC Licence', mandatory: 1,
      level: [submission.tc_licence_number, submission.tc_licence_state].filter(Boolean).join(' · '),
      issueDate: submission.tc_licence_date_of_issue || null },
    { field: 'drivers_licence_photo', type: 'drivers_licence_front', name: "Driver's Licence (Front)", mandatory: 1 },
    { field: 'drivers_licence_back_photo', type: 'drivers_licence_back', name: "Driver's Licence (Back)", mandatory: 1 },
  ];

  const insertDoc = db.prepare(`
    INSERT INTO employee_documents (employee_id, document_type, document_name, filename, original_name, file_path, file_size,
      issue_date, mandatory, verification_status, notes, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  for (const mapping of docMappings) {
    const srcFilename = submission[mapping.field];
    if (!srcFilename) continue;

    try {
      const srcPath = path.join(inductionUploadsDir, srcFilename);
      if (!fs.existsSync(srcPath)) continue;

      const destDir = path.join(hrUploadsBase, `emp_${newEmpId}`, mapping.type);
      fs.mkdirSync(destDir, { recursive: true });
      const destFilename = `${Date.now()}-${srcFilename}`;
      const destPath = path.join(destDir, destFilename);
      fs.copyFileSync(srcPath, destPath);
      const stats = fs.statSync(destPath);

      const docResult = insertDoc.run(
        newEmpId, mapping.type, mapping.name, destFilename, srcFilename, destPath, stats.size,
        mapping.issueDate || null, mapping.mandatory,
        `Auto-imported from induction #${submission.id}`, userId
      );

      try {
        ensureCompetencyForDoc(db, {
          employeeId:   newEmpId,
          documentId:   docResult.lastInsertRowid,
          documentType: mapping.type,
          issueDate:    mapping.issueDate || null,
          expiryDate:   null,
          level:        mapping.level || '',
          source:       `Auto-created from induction #${submission.id}`,
        });
      } catch (compErr) {
        console.error(`Competency mirror failed for ${mapping.field}:`, compErr.message);
      }
    } catch (docErr) {
      console.error(`Failed to copy induction doc ${mapping.field}:`, docErr);
    }
  }
}

// GET /induction/admin/submissions — list all submissions with filtering
router.get('/submissions', (req, res) => {
  const { status, payment_type, search, date_from, date_to } = req.query;

  let where = [];
  let params = [];

  if (status && status !== 'all') {
    where.push('s.status = ?');
    params.push(status);
  }
  if (payment_type && payment_type !== 'all') {
    where.push('s.payment_type = ?');
    params.push(payment_type);
  }
  if (search) {
    where.push("(s.full_name LIKE ? OR s.email LIKE ? OR s.phone LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (date_from) {
    where.push('s.submitted_at >= ?');
    params.push(date_from);
  }
  if (date_to) {
    where.push('s.submitted_at <= ?');
    params.push(date_to + ' 23:59:59');
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const submissions = getDb().prepare(`
    SELECT s.*, u.full_name as reviewed_by_name
    FROM induction_submissions s
    LEFT JOIN users u ON s.reviewed_by_id = u.id
    ${whereClause}
    ORDER BY s.submitted_at DESC
  `).all(...params);

  const stats = {
    total: getDb().prepare('SELECT COUNT(*) as c FROM induction_submissions').get().c,
    submitted: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'submitted'").get().c,
    approved: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'approved'").get().c,
    rejected: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'rejected'").get().c,
    converted: getDb().prepare("SELECT COUNT(*) as c FROM induction_submissions WHERE status = 'approved' AND linked_crew_member_id IS NOT NULL").get().c,
  };

  res.render('induction/admin/submissions', {
    title: 'Induction Submissions',
    currentPage: 'induction',
    submissions,
    filters: { status: status || 'all', payment_type: payment_type || 'all', search: search || '', date_from: date_from || '', date_to: date_to || '' },
    stats,
    currentUrl: req.originalUrl,
  });
});

// GET /induction/admin/submissions/:id — view single submission
router.get('/submissions/:id', (req, res) => {
  const submission = getDb().prepare(`
    SELECT s.*, u.full_name as reviewed_by_name
    FROM induction_submissions s
    LEFT JOIN users u ON s.reviewed_by_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!submission) {
    return res.status(404).render('error', { title: 'Not Found', message: 'Submission not found', user: req.session.user });
  }

  // Award classifications for the rate-prefill dropdown on the approve modal
  let awardClassifications = [];
  try {
    awardClassifications = getDb().prepare(`
      SELECT id, classification, award_name FROM award_classifications
      WHERE active = 1 ORDER BY award_name, classification
    `).all();
  } catch (e) { /* table may not exist on stale deploy */ }

  // Resolve the linked employee record so the "View in Roster" button can
  // jump straight into the same HR employee profile that the Roster tab uses,
  // rather than the legacy /crew/:id workforce view.
  let linkedEmployeeId = null;
  if (submission.linked_crew_member_id) {
    const emp = getDb().prepare('SELECT id FROM employees WHERE linked_crew_member_id = ? AND deleted_at IS NULL').get(submission.linked_crew_member_id);
    if (emp) linkedEmployeeId = emp.id;
  }

  res.render('induction/admin/submission-detail', {
    title: submission.full_name || 'Submission',
    currentPage: 'induction',
    submission,
    awardClassifications,
    linkedEmployeeId,
  });
});

// Apply a submission's suitability call to its linked employee (if any).
// 'unsuitable' blocks them from allocation so the roster flags them and the
// allocator can skip them; flipping to suitable/maybe/cleared lifts a block.
// Reuses the existing employees.blocked_from_allocation + block_reason fields
// (same mechanism as the HR block toggle in routes/hr.js). We only clear a
// block when one is set — manual HR blocks for other reasons are noted as an
// accepted edge (a re-block in HR is one click).
function applySuitabilityToEmployee(db, submission) {
  if (!submission || !submission.linked_crew_member_id) return;
  const emp = db.prepare('SELECT id, blocked_from_allocation FROM employees WHERE linked_crew_member_id = ? AND deleted_at IS NULL').get(submission.linked_crew_member_id);
  if (!emp) return;
  if (submission.suitability === 'unsuitable') {
    const reason = (submission.suitability_note && submission.suitability_note.trim()) || 'Marked not suitable at induction';
    db.prepare("UPDATE employees SET blocked_from_allocation = 1, block_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(reason, emp.id);
  } else if (emp.blocked_from_allocation) {
    db.prepare("UPDATE employees SET blocked_from_allocation = 0, block_reason = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(emp.id);
  }
}

// POST /induction/admin/submissions/:id/suitability — set the allocator-facing
// suitability rating + comment (AJAX, JSON). Persists on the submission and
// mirrors 'unsuitable' onto the linked employee's block flag for the roster.
router.post('/submissions/:id/suitability', (req, res) => {
  const db = getDb();
  const VALID = ['', 'suitable', 'maybe', 'unsuitable'];
  let suitability = String(req.body.suitability || '').toLowerCase();
  if (!VALID.includes(suitability)) suitability = '';
  const note = String(req.body.suitability_note || '').slice(0, 2000);
  const s = db.prepare('SELECT id FROM induction_submissions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ ok: false, error: 'Submission not found' });
  db.prepare(`UPDATE induction_submissions
      SET suitability = ?, suitability_note = ?, suitability_by_id = ?, suitability_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ?`)
    .run(suitability, note, (req.session.user && req.session.user.id) || null, s.id);
  // Re-read the persisted values, then push the call onto the linked employee.
  const fresh = db.prepare('SELECT id, linked_crew_member_id, suitability, suitability_note FROM induction_submissions WHERE id = ?').get(s.id);
  try { applySuitabilityToEmployee(db, fresh); } catch (e) { console.error('[suitability propagate]', e.message); }
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!wantsJson) { req.flash('success', 'Suitability saved.'); return req.session.save(() => res.redirect(`/induction/admin/submissions/${s.id}`)); }
  return res.json({ ok: true, suitability, suitability_note: note });
});

// POST /induction/admin/submissions/:id/status — approve/reject
router.post('/submissions/:id/status', (req, res) => {
  const { status, review_notes } = req.body;
  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).send('Invalid status');
  }

  const db = getDb();
  const s = db.prepare('SELECT * FROM induction_submissions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).send('Submission not found');

  // Where to land afterwards. The Inductions LIST passes return_to so an
  // approve/reject from the list stays on the list instead of bouncing into
  // the submission page (which reads as "opening their profile"). Only
  // internal hiring-area paths are honoured; the submission-detail modal
  // sends nothing, so it stays on the detail as before.
  const rt = typeof req.body.return_to === 'string' ? req.body.return_to : '';
  const dest = /^\/induction\/admin\/[A-Za-z0-9/_\-?=&%.]*$/.test(rt)
    ? rt
    : `/induction/admin/submissions/${req.params.id}`;

  // Update submission status
  db.prepare(`
    UPDATE induction_submissions
    SET status = ?, reviewed_by_id = ?, reviewed_at = datetime('now'), review_notes = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, req.session.user.id, review_notes || '', req.params.id);

  // If approved, auto-create Crew Member + Employee records
  if (status === 'approved') {
    try {
      // ── Dedup guards — prevent the "approve creates 2 profiles" bug ──
      // The conversion was idempotent on the /convert route but not here,
      // so a double-click on Approve (or two separate induction submissions
      // for the same person, e.g. they re-filled the form) would mint a
      // second crew_member + employee. Two checks now sit in front of the
      // create:
      //   1. This submission already has a linked_crew_member_id (and the
      //      target still exists) → return early.
      //   2. A crew_member already matches the submission's email or phone
      //      → link to that one instead of creating a duplicate.
      // Only fall through to the create when neither hit.
      const fresh = db.prepare('SELECT linked_crew_member_id FROM induction_submissions WHERE id = ?').get(req.params.id);
      if (fresh && fresh.linked_crew_member_id) {
        const stillThere = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE id = ?').get(fresh.linked_crew_member_id);
        if (stillThere) {
          req.flash('success', `${stillThere.full_name} is already on the roster as ${stillThere.employee_id}.`);
          return req.session.save(() => res.redirect(dest));
        }
        // Linked crew was deleted — clear the broken pointer and re-create.
        db.prepare('UPDATE induction_submissions SET linked_crew_member_id = NULL WHERE id = ?').run(req.params.id);
      }

      // Strong dedup via the shared matcher (lib/crewDedup): email OR last-9
      // phone OR normalised name, across crew_members + employees, regardless
      // of active/deleted_at. One implementation shared with the recruitment
      // "Hired" conversion so the two paths can't drift apart.
      const matched = findExistingCrew(db, { email: s.email, phone: s.phone, fullName: s.full_name });
      if (matched) {
        db.prepare(`
          UPDATE induction_submissions SET linked_crew_member_id = ?, updated_at = datetime('now') WHERE id = ?
        `).run(matched.id, req.params.id);
        req.flash('success', `Matched to existing roster member ${matched.full_name} (${matched.employee_id}). No duplicate created.`);
        return req.session.save(() => res.redirect(dest));
      }

      // Allocate next EMP-XXX — ignores non-numeric codes (e.g. EMP-TEST) and
      // retries if the allocated code is already in use.
      const employeeId = allocateEmployeeId(db);

      // Use split name fields (fall back to splitting full_name for old submissions)
      let firstName = (s.first_name || '').trim();
      let middleName = (s.middle_name || '').trim();
      let lastName = (s.last_name || '').trim();
      if (!firstName && !lastName && s.full_name) {
        const nameParts = s.full_name.trim().split(/\s+/);
        firstName = nameParts[0] || '';
        lastName = nameParts.slice(1).join(' ') || '';
      }
      const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ') || s.full_name || '';

      // Determine employment type from payment type
      const employmentType = s.payment_type === 'abn' ? 'subcontractor' : 'casual';

      // 1. Create Crew Member
      const crewResult = db.prepare(`
        INSERT INTO crew_members (full_name, employee_id, role, phone, email, company, employment_type,
          white_card, licence_type, induction_date, induction_status, active, status)
        VALUES (?, ?, 'traffic_controller', ?, ?, 'T&S Traffic Control', ?, ?, ?, date('now'), 'completed', 1, 'active')
      `).run(
        fullName, employeeId, s.phone || '', s.email || '', employmentType,
        s.white_card_number || '', s.drivers_licence_number || ''
      );
      const crewMemberId = crewResult.lastInsertRowid;

      // 2. Create Employee record linked to crew member
      db.prepare(`
        INSERT INTO employees (employee_code, first_name, middle_name, last_name, full_name, company,
          employment_type, employment_status, payment_type, start_date,
          email, phone, address, suburb, state, postcode,
          date_of_birth, induction_status, allocatable, active,
          linked_crew_member_id, internal_notes,
          white_card_number, tc_licence_number, tc_licence_state, tc_licence_date_of_issue, drivers_licence_number,
          emergency_contact_name, emergency_contact_phone, emergency_contact_relationship)
        VALUES (?, ?, ?, ?, ?, 'T&S Traffic Control', ?, 'reserved', ?, date('now'), ?, ?, ?, ?, ?, ?, ?, 'completed', 1, 1, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?)
      `).run(
        employeeId, firstName, middleName, lastName, fullName, employmentType,
        s.payment_type || '',
        s.email || '', s.phone || '', s.address || '', s.suburb || '', s.state || '', s.postcode || '',
        s.date_of_birth || null, crewMemberId,
        `Auto-created from induction #${s.id}. Payroll details (bank/super/TFN) stored in the encrypted payroll tables — review at /hr/secure-queue.`,
        s.white_card_number || '', s.tc_licence_number || '', s.tc_licence_state || '', s.tc_licence_date_of_issue || '', s.drivers_licence_number || '',
        s.emergency_contact_name || '', s.emergency_contact_phone || '', s.emergency_contact_relationship || ''
      );

      // 3. Get the new employee record ID
      const newEmployee = db.prepare("SELECT id FROM employees WHERE employee_code = ?").get(employeeId);
      const newEmpId = newEmployee ? newEmployee.id : null;

      // 3a. Stamp wage-panel rates from the tier picked in the Approve
      // modal. The FY26 panel (/payroll/wage-tiers) is the canonical
      // source — the helper resolves the right preset for (tier,
      // payment_type), maps it to the employee's rate_* columns, and
      // persists. Falls back silently when the wage_tier_presets table
      // is missing (stale deploy pre-migration 226) or no tier was sent.
      if (newEmpId) {
        try {
          const tier = parseInt(req.body.tier, 10);
          const pt = String(req.body.payment_type || s.payment_type || '').toLowerCase();
          if (tier && ['cash', 'abn', 'tfn'].includes(pt)) {
            const { stampEmployeeRates } = require('../lib/wageTiers');
            const nightPattern = String(req.body.night_pattern || 'occasional').toLowerCase();
            const result = stampEmployeeRates(db, newEmpId, tier, pt, { nightPattern });
            if (!result.ok) {
              console.warn(`Induction approve: tier stamp skipped — ${result.error}`);
            }
            // Also persist tier on the submission so the audit trail is preserved
            try {
              db.prepare('UPDATE induction_submissions SET tier = ? WHERE id = ?').run(tier, s.id);
            } catch (e) { /* tier column may not exist on stale deploy */ }
          }
        } catch (e) { console.error('Induction approve: tier stamp failed:', e.message); }
      }

      // 3a. Seed the encrypted payroll tables (bank, super, TFN) from the induction form
      if (newEmpId) {
        try {
          const seeded = seedPayrollFromSubmission(db, newEmpId, s);
          if (seeded.length) console.log(`Induction #${s.id}: seeded payroll tables: ${seeded.join(', ')}`);
        } catch (e) { console.error('Seed payroll from induction failed:', e.message); }
      }

      // 4. Auto-import induction uploads as employee_documents + matching
      //    employee_competencies (white card + TC ticket). See helper above.
      if (newEmpId) {
        importInductionDocsAndCompetencies(db, s, newEmpId, req.session.user.id);
      }

      // 5. Update submission with link to crew member (stay as 'approved' — conversion tracked by linked_crew_member_id)
      db.prepare(`
        UPDATE induction_submissions SET linked_crew_member_id = ?, updated_at = datetime('now') WHERE id = ?
      `).run(crewMemberId, s.id);

      // If a suitability call was already recorded before approval, apply it to
      // the freshly-created (reserved) employee so a "not suitable" person lands
      // on the roster already flagged.
      try {
        const sf = db.prepare('SELECT linked_crew_member_id, suitability, suitability_note FROM induction_submissions WHERE id = ?').get(s.id);
        applySuitabilityToEmployee(db, sf);
      } catch (e) { console.error('[suitability on approve]', e.message); }

      // Note: SOP acknowledgement is NOT auto-created from the induction
      // consent signature. The induction-form signature is for the consent
      // agreement, not the SOPs. New starters need to go through the actual
      // presentation and sign at the end — admin sends them a sign link from
      // their roster profile.

      req.flash('success', `${fullName} approved and added as employee ${employeeId}. Documents imported to their profile.`);
      return req.session.save(() => res.redirect(dest));
    } catch (err) {
      console.error('Auto-convert error:', err);
      req.flash('error', `Approved but failed to create employee record: ${err.message}`);
      return req.session.save(() => res.redirect(dest));
    }
  }

  req.flash('success', `Submission ${status} successfully.`);
  req.session.save(() => res.redirect(dest));
});

// POST /submissions/:id/convert — Manual convert approved submission to employee
router.post('/submissions/:id/convert', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT * FROM induction_submissions WHERE id = ?').get(req.params.id);
  if (!s) { req.flash('error', 'Submission not found.'); return req.session.save(() => res.redirect('/induction/admin/submissions')); }
  // Honour a return_to from the list (stay put) — same rule as /status.
  const rt = typeof req.body.return_to === 'string' ? req.body.return_to : '';
  const dest = /^\/induction\/admin\/[A-Za-z0-9/_\-?=&%.]*$/.test(rt)
    ? rt
    : `/induction/admin/submissions/${req.params.id}`;
  if (s.linked_crew_member_id) { req.flash('error', 'Already converted to employee.'); return req.session.save(() => res.redirect(dest)); }

  // Same strong dedup as the approve route — link to an existing roster member
  // instead of minting a duplicate when the worker already exists (re-submitted
  // induction, manually onboarded earlier, etc.). Matches email/phone/name
  // across crew_members + employees regardless of active/deleted_at.
  try {
    const matched = findExistingCrew(db, { email: s.email, phone: s.phone, fullName: s.full_name });
    if (matched) {
      db.prepare('UPDATE induction_submissions SET linked_crew_member_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(matched.id, req.params.id);
      req.flash('success', `Matched to existing roster member ${matched.full_name} (${matched.employee_id}). No duplicate created.`);
      return req.session.save(() => res.redirect(dest));
    }
  } catch (e) { /* dedup is best-effort — fall through to create on error */ }

  try {
    const employeeId = allocateEmployeeId(db);

    let firstName = (s.first_name || '').trim();
    let middleName = (s.middle_name || '').trim();
    let lastName = (s.last_name || '').trim();
    if (!firstName && !lastName && s.full_name) {
      const nameParts = s.full_name.trim().split(/\s+/);
      firstName = nameParts[0] || '';
      lastName = nameParts.slice(1).join(' ') || '';
    }
    const fullName = [firstName, middleName, lastName].filter(Boolean).join(' ') || s.full_name || '';
    const employmentType = s.payment_type === 'abn' ? 'subcontractor' : 'casual';

    const crewResult = db.prepare(`
      INSERT INTO crew_members (full_name, employee_id, role, phone, email, company, employment_type,
        white_card, licence_type, induction_date, induction_status, active, status)
      VALUES (?, ?, 'traffic_controller', ?, ?, 'T&S Traffic Control', ?, ?, ?, date('now'), 'completed', 1, 'active')
    `).run(fullName, employeeId, s.phone || '', s.email || '', employmentType, s.white_card_number || '', s.drivers_licence_number || '');
    const crewMemberId = crewResult.lastInsertRowid;

    db.prepare(`
      INSERT INTO employees (employee_code, first_name, middle_name, last_name, full_name, company,
        employment_type, employment_status, payment_type, start_date,
        email, phone, address, suburb, state, postcode,
        date_of_birth, induction_status, allocatable, active,
        linked_crew_member_id, internal_notes,
        white_card_number, tc_licence_number, tc_licence_state, tc_licence_date_of_issue, drivers_licence_number,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relationship)
      VALUES (?, ?, ?, ?, ?, 'T&S Traffic Control', ?, 'active', ?, date('now'), ?, ?, ?, ?, ?, ?, ?, 'completed', 1, 1, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?)
    `).run(employeeId, firstName, middleName, lastName, fullName, employmentType, s.payment_type || '',
      s.email || '', s.phone || '', s.address || '', s.suburb || '', s.state || '', s.postcode || '',
      s.date_of_birth || null, crewMemberId,
      `Converted from induction #${s.id}. Payroll details (bank/super/TFN) stored in the encrypted payroll tables — review at /hr/secure-queue.`,
      s.white_card_number || '', s.tc_licence_number || '', s.tc_licence_state || '', s.tc_licence_date_of_issue || '', s.drivers_licence_number || '',
      s.emergency_contact_name || '', s.emergency_contact_phone || '', s.emergency_contact_relationship || '');

    // Auto-create employee documents from induction uploads
    const newEmployee = db.prepare("SELECT id FROM employees WHERE employee_code = ?").get(employeeId);
    const newEmpId = newEmployee ? newEmployee.id : null;

    // Seed encrypted payroll tables (bank, super, TFN) from the induction form
    if (newEmpId) {
      try {
        const seeded = seedPayrollFromSubmission(db, newEmpId, s);
        if (seeded.length) console.log(`Induction #${s.id} (manual convert): seeded payroll tables: ${seeded.join(', ')}`);
      } catch (e) { console.error('Seed payroll (manual convert) failed:', e.message); }
    }

    if (newEmpId) {
      importInductionDocsAndCompetencies(db, s, newEmpId, req.session.user.id);
    }

    db.prepare("UPDATE induction_submissions SET linked_crew_member_id = ?, updated_at = datetime('now') WHERE id = ?").run(crewMemberId, s.id);

    // Carry any pre-set suitability call onto the new employee.
    try {
      const sf = db.prepare('SELECT linked_crew_member_id, suitability, suitability_note FROM induction_submissions WHERE id = ?').get(s.id);
      applySuitabilityToEmployee(db, sf);
    } catch (e) { console.error('[suitability on convert]', e.message); }

    // SOP acknowledgement is intentionally NOT auto-created here — the
    // induction consent signature is for the consent agreement, not the SOPs.
    // New starters go through the actual presentation and sign at the end via
    // the SOP sign link.

    req.flash('success', `${fullName} converted to employee ${employeeId}. Documents imported.`);
  } catch (err) {
    console.error('Convert error:', err);
    req.flash('error', `Failed to convert: ${err.message}`);
  }
  req.session.save(() => res.redirect(dest));
});

// POST /induction/admin/submissions/delete — bulk delete submissions
router.post('/submissions/delete', (req, res) => {
  const db = getDb();
  let ids = req.body.ids;

  // Support both single id and array of ids
  if (!ids) {
    req.flash('error', 'No submissions selected.');
    return req.session.save(() => res.redirect('/induction/admin/submissions'));
  }
  if (!Array.isArray(ids)) ids = [ids];

  // Sanitize to integers
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) {
    req.flash('error', 'No valid submissions selected.');
    return req.session.save(() => res.redirect('/induction/admin/submissions'));
  }

  // Fetch submissions to clean up uploaded files
  const placeholders = ids.map(() => '?').join(',');
  const submissions = db.prepare(`SELECT id, white_card_photo, tc_licence_photo, drivers_licence_photo, drivers_licence_back_photo FROM induction_submissions WHERE id IN (${placeholders})`).all(...ids);

  // Delete uploaded files from disk (check both new and legacy paths)
  const newUploadsDir = path.resolve(__dirname, '..', 'data', 'uploads', 'inductions');
  const legacyUploadsDir = path.resolve(__dirname, '..', 'uploads', 'inductions');
  for (const s of submissions) {
    for (const field of ['white_card_photo', 'tc_licence_photo', 'drivers_licence_photo', 'drivers_licence_back_photo']) {
      if (s[field]) {
        try { fs.unlinkSync(path.join(newUploadsDir, s[field])); } catch (e) { /* ignore */ }
        try { fs.unlinkSync(path.join(legacyUploadsDir, s[field])); } catch (e) { /* ignore */ }
      }
    }
  }

  // Delete from database
  db.prepare(`DELETE FROM induction_submissions WHERE id IN (${placeholders})`).run(...ids);

  const count = submissions.length;
  req.flash('success', `Deleted ${count} submission${count !== 1 ? 's' : ''}.`);
  req.session.save(() => res.redirect('/induction/admin/submissions'));
});

// Serve uploaded induction files (authenticated)
// View URLs: /induction/admin/uploads/:id/:filename — :id is for context only, files are stored flat
// Images and PDFs are served inline so the admin can preview them in the
// in-app lightbox (iframe / <img>). Anything else falls back to attachment.
router.get('/uploads/:id/:filename', (req, res) => {
  // Sanitize filename — prevent path traversal attacks
  const filename = path.basename(req.params.filename);
  // Check both new (data/uploads) and legacy (uploads) paths for backwards compat
  const newUploadsDir = path.resolve(__dirname, '..', 'data', 'uploads', 'inductions');
  const legacyUploadsDir = path.resolve(__dirname, '..', 'uploads', 'inductions');
  let filePath = path.resolve(newUploadsDir, filename);
  if (!filePath.startsWith(newUploadsDir) || !fs.existsSync(filePath)) {
    // Fallback to legacy path
    filePath = path.resolve(legacyUploadsDir, filename);
    if (!filePath.startsWith(legacyUploadsDir) || !fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }
  }
  const ext = path.extname(filename).toLowerCase();
  const inlineMime = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.avif': 'image/avif', '.heic': 'image/heic',
    '.pdf': 'application/pdf',
  };
  if (inlineMime[ext] && req.query.download !== '1') {
    res.setHeader('Content-Type', inlineMime[ext]);
    res.setHeader('Content-Disposition', 'inline; filename="' + filename + '"');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(filePath);
  }
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.sendFile(filePath);
});

// GET /induction/admin/present/:module — group-induction presenter.
// Renders the SAME polished deck used at /training/:slug (the standalone
// trainee flow), with one extra slide injected right before the first
// interactive-quiz: an attendee picker so the presenter can mark off who
// is in the room. On quiz pass, one training_completions row is written
// per ticked attendee (see /quiz-result handler below).
router.get('/present/:module', (req, res) => {
  const { module } = req.params;
  let slides, moduleTitle, moduleKey, modulePath;

  if (module === 'employee-guide') {
    slides = employeeGuideSlides;
    moduleTitle = 'T&S Employee Guide';
    moduleKey = 'employee_guide';
    modulePath = '/induction/admin/present/employee-guide';
  } else if (module === 'tc-training-1') {
    slides = tcTrainingSlides;
    moduleTitle = 'Traffic Control Training — Module 1';
    moduleKey = 'tc_training_1';
    modulePath = '/induction/admin/present/tc-training-1';
  } else {
    return res.status(404).send('Unknown module');
  }

  // Inject the attendee-picker slide right before the first interactive
  // quiz slide so it's the last thing the presenter sees before the room
  // starts answering questions.
  const firstQuizIdx = slides.findIndex(s => s.layout === 'interactive-quiz');
  const mergedSlides = firstQuizIdx >= 0
    ? [
        ...slides.slice(0, firstQuizIdx),
        { layout: 'attendee-picker', title: 'Who is here today?' },
        ...slides.slice(firstQuizIdx),
      ]
    : slides;

  // Active crew for the picker — excludes any crew_member whose linked
  // employees row has been soft-deleted so deleted profiles don't show.
  const attendees = getDb().prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id
    FROM crew_members cm
    WHERE cm.active = 1
      AND (
        NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
        OR EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL)
      )
    ORDER BY cm.full_name
  `).all();

  res.render('training/guide', {
    layout: false,
    slides: mergedSlides,
    totalSlides: mergedSlides.length,
    moduleTitle,
    modulePath,
    completionUrl: modulePath + '/quiz-result',
    startUrl: modulePath + '/start',
    groupMode: true,
    attendees,
    csrfToken: req.session && req.session._csrf,
  });
});

// GET /induction/admin/presentations — history of presentations.
// Returns the rows split by module so the template can tab them; each
// module is sorted newest-first.
router.get('/presentations', (req, res) => {
  const db = getDb();
  // Self-heal: clear out empty "In progress" rows — never completed, no
  // quiz, no attendees. These are the stranded page-open/preview sessions
  // from the old on-load-create behaviour; nothing legitimate is ever
  // both in-progress AND empty now that rows are created at quiz time.
  try {
    db.prepare(`
      DELETE FROM induction_presentations
      WHERE completed_at IS NULL AND quiz_score IS NULL
        AND (attendee_names IS NULL OR TRIM(attendee_names) = '')
    `).run();
  } catch (e) { console.error('[presentations] prune failed:', e.message); }

  const rows = db.prepare(`
    SELECT p.*, u.full_name as presenter_name
    FROM induction_presentations p
    LEFT JOIN users u ON p.presented_by_id = u.id
    ORDER BY p.started_at DESC
  `).all();

  const byModule = {
    employee_guide: rows.filter(r => r.module === 'employee_guide'),
    tc_training_1: rows.filter(r => r.module === 'tc_training_1'),
  };

  res.render('induction/admin/presentations', {
    title: 'Training Presentations',
    currentPage: 'induction-presentations',
    presentations: rows,           // kept for back-compat in case other views call this template
    presentationsByModule: byModule,
  });
});

// POST /induction/admin/presentations/:id/delete — remove a history row.
// We deliberately do NOT cascade-delete the per-attendee
// training_completions rows; those are the worker's audit record and
// should outlive the presentation entry. Only the history-table row is
// removed.
router.post('/presentations/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) {
    req.flash('error', 'Invalid presentation id.');
    return req.session.save(() => res.redirect('/induction/admin/presentations'));
  }
  try {
    getDb().prepare('DELETE FROM induction_presentations WHERE id = ?').run(id);
    req.flash('success', 'Presentation removed from history.');
  } catch (e) {
    req.flash('error', 'Could not delete presentation: ' + e.message);
  }
  req.session.save(() => res.redirect('/induction/admin/presentations'));
});

// POST /induction/admin/present/:module/start — start a presentation session
router.post('/present/:module/start', (req, res) => {
  const { module } = req.params;
  const moduleKey = module === 'employee-guide' ? 'employee_guide' : module === 'tc-training-1' ? 'tc_training_1' : null;
  if (!moduleKey) return res.status(400).send('Invalid module');

  const slides = moduleKey === 'employee_guide' ? employeeGuideSlides : tcTrainingSlides;
  const { attendee_names } = req.body;

  const result = getDb().prepare(`
    INSERT INTO induction_presentations (module, presented_by_id, attendee_names, total_slides)
    VALUES (?, ?, ?, ?)
  `).run(moduleKey, req.session.user.id, attendee_names || '', slides.length);

  res.json({ id: result.lastInsertRowid });
});

// POST /induction/admin/present/:module/complete — mark presentation complete
router.post('/present/:module/complete', (req, res) => {
  const { presentation_id } = req.body;
  if (presentation_id) {
    getDb().prepare(`
      UPDATE induction_presentations SET completed_at = datetime('now') WHERE id = ?
    `).run(presentation_id);
  }
  res.json({ success: true });
});

// POST /induction/admin/present/:module/quiz-result — save quiz score and
// (when the quiz passes) record a training_completions row for each selected
// attendee. attendee_ids are crew_member.id values from the picker slide.
router.post('/present/:module/quiz-result', (req, res) => {
  const { module } = req.params;
  const moduleKey = module === 'employee-guide' ? 'employee_guide'
                  : module === 'tc-training-1' ? 'tc_training_1'
                  : null;
  if (!moduleKey) return res.status(400).json({ success: false, error: 'Unknown module' });

  const db = getDb();
  const { presentation_id, score, total, passed, answers, attendee_ids, attendee_names } = req.body;
  const passedFlag = passed ? 1 : 0;
  const ids = Array.isArray(attendee_ids) ? attendee_ids.map(n => parseInt(n, 10)).filter(n => n > 0) : [];

  // Log the run. The presentation row is created HERE (not on page load)
  // so History only ever records a session that actually reached the quiz
  // — no more stranded "In progress" rows from previews / abandoned runs.
  try {
    const slides = moduleKey === 'employee_guide' ? employeeGuideSlides : tcTrainingSlides;
    if (presentation_id) {
      db.prepare(`
        UPDATE induction_presentations
        SET quiz_score = ?, quiz_passed = ?, quiz_answers = ?, attendee_names = ?,
            completed_at = datetime('now')
        WHERE id = ?
      `).run(score, passedFlag, JSON.stringify(answers || {}), attendee_names || '', presentation_id);
    } else {
      db.prepare(`
        INSERT INTO induction_presentations
          (module, presented_by_id, attendee_names, total_slides,
           quiz_score, quiz_passed, quiz_answers, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(moduleKey, req.session.user.id, attendee_names || '', slides.length,
             score, passedFlag, JSON.stringify(answers || {}));
    }
  } catch (e) { console.error('Record presentation failed:', e.message); }

  // Only record completions when they actually passed
  let recorded = [];
  if (passedFlag && ids.length > 0) {
    const insertCompletion = db.prepare(`
      INSERT INTO training_completions
        (employee_id, crew_member_id, module, full_name, email, score, total, passed)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    for (const crewId of ids) {
      try {
        const crew = db.prepare(`
          SELECT cm.id, cm.full_name, cm.email,
            (SELECT id FROM employees WHERE linked_crew_member_id = cm.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) as linked_employee_id
          FROM crew_members cm WHERE cm.id = ?
        `).get(crewId);
        if (!crew) continue;
        // Resolve the employees row for this attendee. Prefer the explicit
        // linked_crew_member_id; fall back to an email match so workers
        // who were added before the linking columns existed still get
        // their profile credited. The crew_member_id column on the row
        // is the source of truth — it's always written.
        let employeeId = crew.linked_employee_id || null;
        if (!employeeId && crew.email) {
          const byEmail = db.prepare(
            "SELECT id FROM employees WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
          ).get(crew.email);
          if (byEmail) employeeId = byEmail.id;
        }
        // Last-resort name match — handles workers whose crew_member email
        // is blank but their employees record has them by full_name.
        if (!employeeId && crew.full_name) {
          const byName = db.prepare(
            "SELECT id FROM employees WHERE LOWER(full_name) = LOWER(?) AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
          ).get(crew.full_name);
          if (byName) employeeId = byName.id;
        }
        // Backfill the canonical link both directions if we resolved the
        // employees row via fallback. Future training reads then hit the
        // fast crew_member_id path and the admin profile knows about the
        // link.
        if (employeeId && !crew.linked_employee_id) {
          try {
            db.prepare(
              "UPDATE employees SET linked_crew_member_id = ? WHERE id = ? AND linked_crew_member_id IS NULL"
            ).run(crew.id, employeeId);
          } catch (e) { /* column may be missing on legacy DB; ignore */ }
        }
        insertCompletion.run(
          employeeId || null,
          crew.id,
          moduleKey,
          crew.full_name,
          crew.email || '',
          score || 0,
          total || 0
        );
        if (employeeId) maybeMarkInducted(db, employeeId, 'in_person');
        recorded.push(crew.full_name);
      } catch (e) { console.error('Completion insert failed for crew', crewId, e.message); }
    }
  }

  res.json({ success: true, recorded });
});

// ============================================================
// SOP Sign-Off Sessions (in-person group inductions via QR)
// ============================================================

// POST /induction/admin/sign-session/start — create a new group session
router.post('/sign-session/start', (req, res) => {
  const db = getDb();
  const { title, presentation_id } = req.body;
  const token = crypto.randomBytes(8).toString('hex');
  const result = db.prepare(`
    INSERT INTO sop_signing_sessions (token, title, sop_version, presentation_id, created_by_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    token,
    (title || 'In-person sign-off').toString().slice(0, 200),
    currentSopVersion(),
    presentation_id ? parseInt(presentation_id, 10) : null,
    req.session.user.id,
  );
  res.redirect(`/induction/admin/sign-session/${result.lastInsertRowid}`);
});

// GET /induction/admin/sign-session/:id — presenter view (QR + live list)
router.get('/sign-session/:id', (req, res) => {
  const db = getDb();
  const session = db.prepare(`
    SELECT s.*, u.full_name as created_by_name
    FROM sop_signing_sessions s
    LEFT JOIN users u ON s.created_by_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!session) {
    return res.status(404).render('error', { title: 'Not Found', message: 'Sign-off session not found', user: req.session.user });
  }

  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const signUrl = `${baseUrl}/sop-sign/${session.token}`;

  res.render('induction/admin/sign-session', {
    title: 'Sign-Off Session',
    currentPage: 'induction-presentations',
    layout: false,
    session,
    signUrl,
  });
});

// GET /induction/admin/sign-session/:id/status.json — poll for new sigs
router.get('/sign-session/:id/status.json', (req, res) => {
  const db = getDb();
  const session = db.prepare('SELECT id, closed_at FROM sop_signing_sessions WHERE id = ?').get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Not found' });

  const acks = db.prepare(`
    SELECT id, full_name, email, signed_at, signed_via, crew_member_id
    FROM sop_acknowledgements
    WHERE session_id = ?
    ORDER BY signed_at ASC
  `).all(session.id);

  res.json({ closed: !!session.closed_at, count: acks.length, acks });
});

// POST /induction/admin/sign-session/:id/close — finalise the session
router.post('/sign-session/:id/close', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE sop_signing_sessions SET closed_at = datetime('now') WHERE id = ? AND closed_at IS NULL").run(req.params.id);
  res.redirect('/induction/admin/presentations');
});

// GET /induction/admin/acknowledgements — list everyone who's signed (audit list)
router.get('/acknowledgements', (req, res) => {
  const db = getDb();
  const { version, search } = req.query;
  const whereParts = [];
  const params = [];
  if (version) { whereParts.push('a.sop_version = ?'); params.push(version); }
  if (search) { whereParts.push('(a.full_name LIKE ? OR a.email LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  const whereClause = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';

  const acks = db.prepare(`
    SELECT a.*, s.title as session_title, cm.employee_id as crew_employee_code
    FROM sop_acknowledgements a
    LEFT JOIN sop_signing_sessions s ON a.session_id = s.id
    LEFT JOIN crew_members cm ON a.crew_member_id = cm.id
    ${whereClause}
    ORDER BY a.signed_at DESC
    LIMIT 500
  `).all(...params);

  const versions = db.prepare('SELECT DISTINCT sop_version FROM sop_acknowledgements ORDER BY sop_version DESC').all().map(r => r.sop_version);

  res.render('induction/admin/acknowledgements', {
    title: 'SOP Acknowledgements',
    currentPage: 'induction-presentations',
    acks,
    versions,
    currentVersion: currentSopVersion(),
    filters: { version: version || '', search: search || '' },
  });
});

// ============================================================
// Admin preview of the SOP/SWMS sign page — exactly what workers see, but
// no row is written when "submitted". Useful for previewing content + image
// changes before sending real links.
// ============================================================
router.get('/sop-preview', (req, res) => {
  const db = getDb();
  const documents = activeSopDocuments(db);

  res.render('sop-sign/mobile', {
    layout: false,
    session: { id: 0, token: 'preview', title: 'Preview', sop_version: currentSopVersion(), target_crew_member_id: null, closed_at: null },
    targetCrew: null,
    attendees: [],
    documents,
    ackText: sopAckText(),
    sopVersion: currentSopVersion(),
    submitted: false,
    error: null,
    previewMode: true,
  });
});

// ============================================================
// SOP / SWMS Document Library
// ============================================================

// GET /induction/admin/sop-documents — list + upload page
router.get('/sop-documents', (req, res) => {
  const db = getDb();
  const docs = db.prepare(`
    SELECT d.*, u.full_name as uploaded_by_name
    FROM sop_documents d
    LEFT JOIN users u ON d.created_by_id = u.id
    ORDER BY d.active DESC, d.display_order ASC, d.id ASC
  `).all();

  // Attach the file list to each section so the view can render multi-file
  // editing controls. Falls back to an empty list — the view handles "no files".
  for (const d of docs) {
    d.files = loadFilesForSection(db, d.id);
  }

  res.render('induction/admin/sop-documents', {
    title: 'SOP / SWMS Sections',
    currentPage: 'induction-presentations',
    docs,
    sopVersion: currentSopVersion(),
  });
});

// POST /induction/admin/sop-documents — upload a new section + first file.
// The file goes into sop_document_files; the parent sop_documents row holds
// only metadata (title, description, sop_slug) plus a mirror of the first
// file's columns for back-compat with legacy readers.
router.post('/sop-documents', sopDocUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      req.flash('error', 'No file uploaded.');
      return req.session.save(() => res.redirect('/induction/admin/sop-documents'));
    }
    const db = getDb();
    const title = (req.body.title || req.file.originalname.replace(/\.[^.]+$/, '')).toString().trim().slice(0, 200);
    const next = db.prepare('SELECT COALESCE(MAX(display_order), 0) + 1 as n FROM sop_documents').get();

    const sopSlug = (req.body.sop_slug || '').toString().trim() || null;
    const description = (req.body.description || '').toString().trim().slice(0, 20000);

    // Build the INSERT dynamically based on which columns actually exist on
    // this deploy. Older deploys may not have run migration 180 (sop_slug)
    // or 182 (description) yet — without this check the INSERT throws and
    // bubbles up as a generic 500 to the user.
    const cols = new Set(db.prepare('PRAGMA table_info(sop_documents)').all().map(c => c.name));
    const fields = ['title', 'filename', 'original_name', 'file_path', 'file_size', 'mime_type', 'display_order', 'active', 'created_by_id'];
    const values = [title, req.file.filename, req.file.originalname, req.file.path, req.file.size, req.file.mimetype || '', next.n, 1, req.session.user.id];
    if (cols.has('sop_slug'))    { fields.push('sop_slug');    values.push(sopSlug); }
    if (cols.has('description')) { fields.push('description'); values.push(description); }

    const placeholders = fields.map(() => '?').join(', ');
    const result = db.prepare(`INSERT INTO sop_documents (${fields.join(', ')}) VALUES (${placeholders})`).run(...values);
    const sopDocumentId = result.lastInsertRowid;

    // Insert the first child file row. page_renders_dir uses 'file-<id>' so
    // its rendered PNGs land in their own folder, separate from the legacy
    // parent-keyed renders.
    const fileInsert = db.prepare(`
      INSERT INTO sop_document_files
        (sop_document_id, filename, original_name, file_path, file_size, mime_type, display_order, page_renders_dir)
      VALUES (?, ?, ?, ?, ?, ?, 0, '')
    `).run(
      sopDocumentId, req.file.filename, req.file.originalname,
      req.file.path, req.file.size, req.file.mimetype || ''
    );
    const fileId = fileInsert.lastInsertRowid;
    db.prepare("UPDATE sop_document_files SET page_renders_dir = ? WHERE id = ?")
      .run(`file-${fileId}`, fileId);

    // Render PDF pages to PNGs so the mobile sign page can display them inline.
    // Best-effort — done synchronously here so the admin sees the result on
    // redirect, but failures are non-fatal and caught inside the helper.
    const fileRow = db.prepare('SELECT * FROM sop_document_files WHERE id = ?').get(fileId);
    const { pages, error } = await renderAndPersistPagesForFile(db, fileRow);
    // Mirror the (now-rendered) first file back onto the parent row.
    syncParentToFirstFile(db, sopDocumentId);

    let suffix = '';
    if (pages.length > 0) suffix = ` — rendered ${pages.length} page${pages.length === 1 ? '' : 's'} for inline display.`;
    else if (error) suffix = ` (Inline render failed: ${error}. The PDF will still display via the browser's PDF viewer.)`;
    req.flash(pages.length > 0 || !error ? 'success' : 'error', `Uploaded "${title}".${suffix}`);
    res.redirect('/induction/admin/sop-documents');
  } catch (err) {
    console.error('[sop-documents upload] failed:', err);
    req.flash('error', `Upload failed: ${err.message}. The file may have been received but the section row could not be saved.`);
    req.session.save(() => res.redirect('/induction/admin/sop-documents'));
  }
});

// POST /induction/admin/sop-documents/:id/files — add another file to a section
router.post('/sop-documents/:id/files', sopDocUpload.single('file'), async (req, res) => {
  try {
    const db = getDb();
    const section = db.prepare('SELECT id, title FROM sop_documents WHERE id = ?').get(req.params.id);
    if (!section) {
      req.flash('error', 'Section not found.');
      return req.session.save(() => res.redirect('/induction/admin/sop-documents'));
    }
    if (!req.file) {
      req.flash('error', 'No file uploaded.');
      return req.session.save(() => res.redirect('/induction/admin/sop-documents'));
    }
    const next = db.prepare(
      'SELECT COALESCE(MAX(display_order), -1) + 1 AS n FROM sop_document_files WHERE sop_document_id = ?'
    ).get(section.id);
    const ins = db.prepare(`
      INSERT INTO sop_document_files
        (sop_document_id, filename, original_name, file_path, file_size, mime_type, display_order, page_renders_dir)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
    `).run(
      section.id, req.file.filename, req.file.originalname,
      req.file.path, req.file.size, req.file.mimetype || '', next.n
    );
    const fileId = ins.lastInsertRowid;
    db.prepare('UPDATE sop_document_files SET page_renders_dir = ? WHERE id = ?')
      .run(`file-${fileId}`, fileId);

    const fileRow = db.prepare('SELECT * FROM sop_document_files WHERE id = ?').get(fileId);
    const { pages, error } = await renderAndPersistPagesForFile(db, fileRow);
    // Only resync the parent if this was added at position 0 (i.e. the
    // section had no files until now). The mirror tracks the FIRST file.
    if (next.n === 0) syncParentToFirstFile(db, section.id);

    let suffix = '';
    if (pages.length > 0) suffix = ` — rendered ${pages.length} page${pages.length === 1 ? '' : 's'}.`;
    else if (error) suffix = ` (Inline render failed: ${error}.)`;
    req.flash(pages.length > 0 || !error ? 'success' : 'error', `Added file to "${section.title}".${suffix}`);
    res.redirect('/induction/admin/sop-documents');
  } catch (err) {
    console.error('[sop-documents file add] failed:', err);
    req.flash('error', `Could not add file: ${err.message}`);
    req.session.save(() => res.redirect('/induction/admin/sop-documents'));
  }
});

// POST /induction/admin/sop-documents/:id/files/:fileId/delete
router.post('/sop-documents/:id/files/:fileId/delete', (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare(
      'SELECT * FROM sop_document_files WHERE id = ? AND sop_document_id = ?'
    ).get(req.params.fileId, req.params.id);
    if (!file) { req.flash('error', 'File not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }
    // Clean up the actual file + its rendered pages directory.
    try { if (file.file_path) fs.unlinkSync(file.file_path); } catch (e) { /* may already be gone */ }
    if (file.page_renders_dir) {
      try { fs.rmSync(path.join(SOP_PAGE_DIR, file.page_renders_dir), { recursive: true, force: true }); } catch (e) { /* ok */ }
    }
    db.prepare('DELETE FROM sop_document_files WHERE id = ?').run(file.id);
    // Re-pack display_order so the next "up/down" move doesn't bump into gaps.
    const remaining = db.prepare(
      'SELECT id FROM sop_document_files WHERE sop_document_id = ? ORDER BY display_order ASC, id ASC'
    ).all(req.params.id);
    const reorder = db.prepare('UPDATE sop_document_files SET display_order = ? WHERE id = ?');
    remaining.forEach((r, i) => reorder.run(i, r.id));
    syncParentToFirstFile(db, parseInt(req.params.id, 10));
    req.flash('success', `Removed "${file.original_name || file.filename}".`);
  } catch (err) {
    console.error('[sop-documents file delete] failed:', err);
    req.flash('error', `Delete failed: ${err.message}`);
  }
  req.session.save(() => res.redirect('/induction/admin/sop-documents'));
});

// POST /induction/admin/sop-documents/:id/files/:fileId/move — up/down within a section
router.post('/sop-documents/:id/files/:fileId/move', (req, res) => {
  const db = getDb();
  const file = db.prepare(
    'SELECT id, sop_document_id, display_order FROM sop_document_files WHERE id = ? AND sop_document_id = ?'
  ).get(req.params.fileId, req.params.id);
  if (!file) return res.redirect('/induction/admin/sop-documents');
  const dir = req.body.dir === 'up' ? 'up' : 'down';
  const op = dir === 'up' ? '<' : '>';
  const ord = dir === 'up' ? 'DESC' : 'ASC';
  const neighbour = db.prepare(`
    SELECT id, display_order FROM sop_document_files
    WHERE sop_document_id = ? AND display_order ${op} ?
    ORDER BY display_order ${ord} LIMIT 1
  `).get(file.sop_document_id, file.display_order);
  if (neighbour) {
    db.prepare('UPDATE sop_document_files SET display_order = ? WHERE id = ?').run(neighbour.display_order, file.id);
    db.prepare('UPDATE sop_document_files SET display_order = ? WHERE id = ?').run(file.display_order, neighbour.id);
    syncParentToFirstFile(db, file.sop_document_id);
  }
  res.redirect('/induction/admin/sop-documents');
});

// POST /induction/admin/sop-documents/:id/files/:fileId/render — re-render
router.post('/sop-documents/:id/files/:fileId/render', async (req, res) => {
  const db = getDb();
  const file = db.prepare(
    'SELECT * FROM sop_document_files WHERE id = ? AND sop_document_id = ?'
  ).get(req.params.fileId, req.params.id);
  if (!file) { req.flash('error', 'File not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }
  const { pages, error } = await renderAndPersistPagesForFile(db, file);
  if (pages.length > 0) {
    req.flash('success', `Rendered ${pages.length} page${pages.length === 1 ? '' : 's'} for "${file.original_name}".`);
  } else {
    req.flash('error', `Couldn't render "${file.original_name}": ${error || 'unknown reason'}.`);
  }
  // If this was the primary file, sync the page_renders mirror onto the parent.
  if (file.display_order === 0) syncParentToFirstFile(db, file.sop_document_id);
  req.session.save(() => res.redirect('/induction/admin/sop-documents'));
});

// GET /induction/admin/sop-documents/:id/files/:fileId/file — admin file serving
router.get('/sop-documents/:id/files/:fileId/file', (req, res) => {
  const db = getDb();
  const file = db.prepare(
    'SELECT * FROM sop_document_files WHERE id = ? AND sop_document_id = ?'
  ).get(req.params.fileId, req.params.id);
  if (!file) return res.status(404).send('Not found');
  const safe = path.resolve(SOP_DOC_DIR, path.basename(file.filename));
  if (!fs.existsSync(safe)) return res.status(404).send('File missing');
  if (file.mime_type) res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Disposition', 'inline; filename="' + (file.original_name || file.filename) + '"');
  res.sendFile(safe);
});

// POST /induction/admin/sop-documents/:id/render — re-render pages for every
// file in the section (backfill or refresh after a doc was replaced).
router.post('/sop-documents/:id/render', async (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }

  const files = loadFilesForSection(db, doc.id);
  if (files.length === 0) {
    // No child files yet — fall back to the legacy parent-row render so older
    // sections (pre-209 migration) still have a way to render.
    const { pages, error } = await renderAndPersistPages(db, doc);
    if (pages.length > 0) req.flash('success', `Rendered ${pages.length} page${pages.length === 1 ? '' : 's'} for "${doc.title}".`);
    else req.flash('error', `Couldn't render "${doc.title}": ${error || 'unknown reason'}.`);
    return req.session.save(() => res.redirect('/induction/admin/sop-documents'));
  }

  let totalPages = 0;
  const errors = [];
  for (const f of files) {
    const { pages, error } = await renderAndPersistPagesForFile(db, f);
    totalPages += pages.length;
    if (error) errors.push(`${f.original_name}: ${error}`);
  }
  syncParentToFirstFile(db, doc.id);

  if (errors.length === 0) {
    req.flash('success', `Rendered ${totalPages} page${totalPages === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'} for "${doc.title}".`);
  } else {
    req.flash('error', `Rendered ${totalPages} page${totalPages === 1 ? '' : 's'}, with ${errors.length} error${errors.length === 1 ? '' : 's'}: ${errors.join('; ')}`);
  }
  req.session.save(() => res.redirect('/induction/admin/sop-documents'));
});

// POST /induction/admin/sop-documents/:id/update — edit title + description.
// Admin builds the section content here; HTML is allowed and rendered raw on
// the sign page (admin-only input, no XSS surface — only authenticated admins
// with the 'induction' permission can reach this route).
router.post('/sop-documents/:id/update', (req, res) => {
  try {
    const db = getDb();
    const doc = db.prepare('SELECT id FROM sop_documents WHERE id = ?').get(req.params.id);
    if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }
    const title = (req.body.title || '').toString().trim().slice(0, 200);
    const description = (req.body.description || '').toString().slice(0, 20000);
    if (!title) { req.flash('error', 'Title is required.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }
    const cols = new Set(db.prepare('PRAGMA table_info(sop_documents)').all().map(c => c.name));
    if (cols.has('description')) {
      db.prepare('UPDATE sop_documents SET title = ?, description = ? WHERE id = ?').run(title, description, doc.id);
    } else {
      db.prepare('UPDATE sop_documents SET title = ? WHERE id = ?').run(title, doc.id);
    }
    req.flash('success', `Updated "${title}".`);
    req.session.save(() => res.redirect('/induction/admin/sop-documents'));
  } catch (err) {
    console.error('[sop-documents update] failed:', err);
    req.flash('error', `Update failed: ${err.message}`);
    req.session.save(() => res.redirect('/induction/admin/sop-documents'));
  }
});

// POST /induction/admin/sop-documents/:id/link — change which SOP this doc belongs to
router.post('/sop-documents/:id/link', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, title FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }
  const slug = (req.body.sop_slug || '').toString().trim() || null;
  db.prepare('UPDATE sop_documents SET sop_slug = ? WHERE id = ?').run(slug, doc.id);
  req.flash('success', slug ? `Linked "${doc.title}" to ${slug}.` : `Unlinked "${doc.title}" — will appear under Reference Documents.`);
  req.session.save(() => res.redirect('/induction/admin/sop-documents'));
});

// POST /induction/admin/sop-documents/:id/toggle — activate / deactivate
router.post('/sop-documents/:id/toggle', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, title, active FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }
  const newVal = doc.active ? 0 : 1;
  db.prepare('UPDATE sop_documents SET active = ? WHERE id = ?').run(newVal, doc.id);
  req.flash('success', `${doc.title} is now ${newVal ? 'active' : 'hidden'}.`);
  req.session.save(() => res.redirect('/induction/admin/sop-documents'));
});

// POST /induction/admin/sop-documents/:id/delete — permanently remove section
// + every file inside it, plus their rendered-page directories on disk.
router.post('/sop-documents/:id/delete', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, title, file_path FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('/induction/admin/sop-documents')); }

  // Tear down every child file's bytes + page-render directory first.
  const files = db.prepare(
    'SELECT file_path, page_renders_dir FROM sop_document_files WHERE sop_document_id = ?'
  ).all(doc.id);
  for (const f of files) {
    try { if (f.file_path) fs.unlinkSync(f.file_path); } catch (e) { /* ok */ }
    if (f.page_renders_dir) {
      try { fs.rmSync(path.join(SOP_PAGE_DIR, f.page_renders_dir), { recursive: true, force: true }); } catch (e) { /* ok */ }
    }
  }

  // Legacy: the parent row itself used to own a file + page-renders dir
  // keyed by sop_documents.id. Clean those up too in case anything's left.
  try { if (doc.file_path) fs.unlinkSync(doc.file_path); } catch (e) { /* ok */ }
  try { fs.rmSync(path.join(SOP_PAGE_DIR, String(doc.id)), { recursive: true, force: true }); } catch (e) { /* ok */ }

  // ON DELETE CASCADE on the FK takes care of the child rows in the DB.
  db.prepare('DELETE FROM sop_documents WHERE id = ?').run(doc.id);
  req.flash('success', `Deleted "${doc.title}".`);
  req.session.save(() => res.redirect('/induction/admin/sop-documents'));
});

// POST /induction/admin/sop-documents/:id/move — change display order
// body.dir = 'up' | 'down'. Simple swap with the neighbour at the same active state.
router.post('/sop-documents/:id/move', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id, display_order, active FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.redirect('/induction/admin/sop-documents');
  const dir = req.body.dir === 'up' ? 'up' : 'down';
  const op = dir === 'up' ? '<' : '>';
  const ord = dir === 'up' ? 'DESC' : 'ASC';
  const neighbour = db.prepare(`
    SELECT id, display_order FROM sop_documents
    WHERE active = ? AND display_order ${op} ?
    ORDER BY display_order ${ord} LIMIT 1
  `).get(doc.active, doc.display_order);
  if (neighbour) {
    db.prepare('UPDATE sop_documents SET display_order = ? WHERE id = ?').run(neighbour.display_order, doc.id);
    db.prepare('UPDATE sop_documents SET display_order = ? WHERE id = ?').run(doc.display_order, neighbour.id);
  }
  res.redirect('/induction/admin/sop-documents');
});

// GET /induction/admin/sop-documents/:id/file — admin file serving
router.get('/sop-documents/:id/file', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM sop_documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).send('Not found');
  // basename guard against path traversal even though stored path is server-set
  const safe = path.resolve(SOP_DOC_DIR, path.basename(doc.filename));
  if (!fs.existsSync(safe)) return res.status(404).send('File missing');
  if (doc.mime_type) res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', 'inline; filename="' + (doc.original_name || doc.filename) + '"');
  res.sendFile(safe);
});

module.exports = router;
