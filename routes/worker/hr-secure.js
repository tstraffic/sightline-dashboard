// Secure HR forms: Bank, Super, TFN. All writes require PIN re-auth.
// Sensitive fields are encrypted via services/encryption — plaintext never
// touches logs or activity_log payloads.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../../db/database');
const { encrypt, maskLast } = require('../../services/encryption');
const { logActivity } = require('../../middleware/audit');
const { requirePinConfirm } = require('../../middleware/pinRateLimit');
const { generateTfnPdf } = require('../../services/tfnPdf');
const { notifyUsers } = (() => { try { return require('../../middleware/notifications'); } catch (e) { return { notifyUsers: () => {} }; } })();

const UPLOAD_BASE = path.join(__dirname, '..', '..', 'data', 'uploads', 'hr');

// --- Multer for super choice form + signature + tfn pdf ---
const choiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const empId = req.session.worker ? req.session.worker.id : 'unknown';
    const dir = path.join(UPLOAD_BASE, `emp_${empId}`, 'super');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.pdf').toLowerCase() || '.pdf';
    cb(null, `choice_${Date.now()}${ext}`);
  }
});
const choiceUpload = multer({
  storage: choiceStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^application\/pdf$/i.test(file.mimetype)) return cb(new Error('Only PDF allowed'));
    cb(null, true);
  }
});

// Helper: load linked employee for current worker
function loadEmployee(worker) {
  const db = getDb();
  const byLink = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  if (byLink) return byLink;
  const member = db.prepare('SELECT employee_id FROM crew_members WHERE id = ?').get(worker.id);
  if (member && member.employee_id) {
    return db.prepare('SELECT * FROM employees WHERE employee_code = ?').get(member.employee_id);
  }
  return null;
}

function workerForAudit(worker) {
  return { id: null, full_name: `Worker: ${worker.full_name} (${worker.employee_id})` };
}

// Default super fund from system_config (optional)
function getDefaultSuper() {
  const db = getDb();
  try {
    const row = db.prepare("SELECT value FROM system_config WHERE key = 'default_super_fund'").get();
    if (row && row.value) return JSON.parse(row.value);
  } catch (e) { /* ignore */ }
  return null;
}

// Notify admins/HR of a pending sensitive-data submission
function notifyAdminsOfPending(entityType, employeeName) {
  try {
    const db = getDb();
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('admin','hr') AND active = 1").all();
    const label = entityType === 'tfn_declaration' ? 'TFN declaration'
               : entityType === 'bank_account' ? 'Bank details'
               : 'Superannuation details';
    const link = '/hr/secure-queue';
    const stmt = db.prepare(`
      INSERT INTO notifications (user_id, type, entity_type, entity_id, title, message, link, created_at)
      VALUES (?, 'approval_request', ?, NULL, ?, ?, ?, datetime('now'))
    `);
    for (const a of admins) {
      try { stmt.run(a.id, entityType, `${label} submitted`, `${employeeName} submitted ${label} — action in QBO`, link); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore — notifications table may vary */ }
}

// ==============================================================
// BANK ACCOUNT
// ==============================================================

router.get('/hr/bank', (req, res) => {
  const employee = loadEmployee(req.session.worker);
  if (!employee) return res.redirect('/w/hr');
  const db = getDb();
  const current = db.prepare('SELECT id, account_name, bsb_last3, account_last3, status, synced_at, updated_at FROM bank_accounts WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);

  logActivity({
    user: workerForAudit(req.session.worker),
    action: 'view', entityType: 'bank_account',
    entityId: current ? current.id : null, entityLabel: req.session.worker.full_name,
    details: 'Worker viewed masked bank details',
    ip: req.ip,
  });

  res.render('worker/hr-bank', {
    title: 'Bank Account',
    currentPage: 'more',
    employee,
    current,
    flash_success: req.flash('success'),
    flash_error: req.flash('error'),
  });
});

router.post('/hr/bank', requirePinConfirm('bank'), (req, res) => {
  const employee = loadEmployee(req.session.worker);
  if (!employee) { req.flash('error', 'Linked employee not found.'); return res.redirect('/w/hr/bank'); }

  const account_name = (req.body.account_name || '').trim();
  const bsb = (req.body.bsb || '').replace(/\s|-/g, '').trim();
  const account_number = (req.body.account_number || '').replace(/\s|-/g, '').trim();

  if (!account_name || !bsb || !account_number) {
    req.flash('error', 'All bank fields are required.');
    return res.redirect('/w/hr/bank');
  }
  if (!/^\d{6}$/.test(bsb)) {
    req.flash('error', 'BSB must be 6 digits (e.g. 062-000).');
    return res.redirect('/w/hr/bank');
  }
  if (!/^\d{6,10}$/.test(account_number)) {
    req.flash('error', 'Account number must be 6–10 digits.');
    return res.redirect('/w/hr/bank');
  }

  const db = getDb();
  db.prepare(`
    INSERT INTO bank_accounts (employee_id, account_name, bsb_last3, account_last3, bsb_encrypted, account_number_encrypted, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `).run(
    employee.id, account_name, bsb.slice(-3), account_number.slice(-3),
    encrypt(bsb), encrypt(account_number)
  );

  logActivity({
    user: workerForAudit(req.session.worker),
    action: 'update', entityType: 'bank_account',
    entityId: employee.id, entityLabel: employee.full_name,
    details: `Worker submitted bank details (BSB •••${bsb.slice(-3)}, Acct •••${account_number.slice(-3)}). Pending QBO sync.`,
    ip: req.ip,
  });
  notifyAdminsOfPending('bank_account', employee.full_name);

  req.flash('success', 'Bank details submitted — pending admin approval.');
  res.redirect('/w/hr/bank');
});

// ==============================================================
// SUPERANNUATION
// ==============================================================

router.get('/hr/super', (req, res) => {
  const employee = loadEmployee(req.session.worker);
  if (!employee) return res.redirect('/w/hr');
  const db = getDb();
  const current = db.prepare('SELECT * FROM super_funds WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);

  logActivity({
    user: workerForAudit(req.session.worker),
    action: 'view', entityType: 'super_fund',
    entityId: current ? current.id : null, entityLabel: req.session.worker.full_name,
    details: 'Worker viewed super details',
    ip: req.ip,
  });

  res.render('worker/hr-super', {
    title: 'Superannuation',
    currentPage: 'more',
    employee,
    current,
    defaultFund: getDefaultSuper(),
    flash_success: req.flash('success'),
    flash_error: req.flash('error'),
  });
});

router.post('/hr/super', (req, res) => {
  // multer first (for optional PDF), then PIN check, then handler.
  choiceUpload.single('choice_form')(req, res, function (err) {
    if (err) { req.flash('error', err.message); return res.redirect('/w/hr/super'); }

    // Re-use PIN middleware (multer populates req.body)
    return requirePinConfirm('super')(req, res, function () {
      const employee = loadEmployee(req.session.worker);
      if (!employee) { req.flash('error', 'Linked employee not found.'); return res.redirect('/w/hr/super'); }

      const useDefault = !!req.body.use_default;
      let fund_name = (req.body.fund_name || '').trim();
      let usi = (req.body.usi || '').trim();
      let member_number = (req.body.member_number || '').trim();
      let fund_abn = (req.body.fund_abn || '').replace(/\s/g, '').trim();

      if (useDefault) {
        const d = getDefaultSuper();
        if (d) { fund_name = d.fund_name || fund_name; usi = d.usi || usi; fund_abn = d.fund_abn || fund_abn; }
      }

      if (!useDefault && !req.file && (!fund_name || !usi || !member_number)) {
        req.flash('error', 'Provide fund name, USI and member number — or upload a Super Choice form.');
        return res.redirect('/w/hr/super');
      }
      if (fund_abn && !/^\d{11}$/.test(fund_abn)) {
        req.flash('error', 'Fund ABN must be 11 digits.');
        return res.redirect('/w/hr/super');
      }

      const choiceUrl = req.file ? `/data/uploads/hr/emp_${req.session.worker.id}/super/${req.file.filename}` : null;
      const db = getDb();
      db.prepare(`
        INSERT INTO super_funds (employee_id, fund_name, usi, member_number, fund_abn, choice_form_url, use_default, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
      `).run(employee.id, fund_name || '', usi || '', member_number || '', fund_abn || '', choiceUrl, useDefault ? 1 : 0);

      logActivity({
        user: workerForAudit(req.session.worker),
        action: 'update', entityType: 'super_fund',
        entityId: employee.id, entityLabel: employee.full_name,
        details: `Worker submitted superannuation details${useDefault ? ' (company default fund)' : ''}${req.file ? ' + Super Choice PDF' : ''}. Pending QBO sync.`,
        ip: req.ip,
      });
      notifyAdminsOfPending('super_fund', employee.full_name);

      req.flash('success', 'Superannuation details submitted — pending admin approval.');
      res.redirect('/w/hr/super');
    });
  });
});

// ==============================================================
// TFN DECLARATION
// ==============================================================

// ATO TFN checksum: weights [1,4,3,7,5,8,6,9,10] over 9 digits, sum mod 11 == 0
function validateTfnChecksum(tfn) {
  const d = String(tfn).replace(/\D/g, '');
  if (d.length !== 9) return false;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(d[i], 10) * weights[i];
  return sum % 11 === 0;
}

router.get('/hr/tfn', (req, res) => {
  const employee = loadEmployee(req.session.worker);
  if (!employee) return res.redirect('/w/hr');
  const db = getDb();
  const current = db.prepare('SELECT id, tfn_last3, residency_status, claim_threshold, has_help_debt, has_stsl_debt, medicare_variation, status, submitted_at, pdf_url FROM tfn_declarations WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);

  logActivity({
    user: workerForAudit(req.session.worker),
    action: 'view', entityType: 'tfn_declaration',
    entityId: current ? current.id : null, entityLabel: req.session.worker.full_name,
    details: 'Worker viewed TFN declaration',
    ip: req.ip,
  });

  res.render('worker/hr-tfn', {
    title: 'TFN Declaration',
    currentPage: 'more',
    employee,
    current,
    flash_success: req.flash('success'),
    flash_error: req.flash('error'),
  });
});

router.post('/hr/tfn', requirePinConfirm('tfn'), async (req, res) => {
  const employee = loadEmployee(req.session.worker);
  if (!employee) { req.flash('error', 'Linked employee not found.'); return res.redirect('/w/hr/tfn'); }

  const tfnRaw = (req.body.tfn || '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(tfnRaw) || !validateTfnChecksum(tfnRaw)) {
    req.flash('error', 'Enter a valid 9-digit TFN.');
    return res.redirect('/w/hr/tfn');
  }
  const residency = req.body.residency_status;
  if (!['resident','foreign','working_holiday'].includes(residency)) {
    req.flash('error', 'Select a residency status.'); return res.redirect('/w/hr/tfn');
  }
  const claim = req.body.claim_threshold ? 1 : 0;
  const help = req.body.has_help_debt ? 1 : 0;
  const stsl = req.body.has_stsl_debt ? 1 : 0;
  const medicare = ['none','reduction','exemption'].includes(req.body.medicare_variation) ? req.body.medicare_variation : 'none';
  const signatureDataUrl = req.body.signature_data || '';
  if (!/^data:image\/(png|jpeg);base64,/.test(signatureDataUrl)) {
    req.flash('error', 'Please sign the declaration.'); return res.redirect('/w/hr/tfn');
  }

  const db = getDb();

  // Save signature file
  const sigDir = path.join(UPLOAD_BASE, `emp_${req.session.worker.id}`, 'tfn');
  fs.mkdirSync(sigDir, { recursive: true });
  const sigFile = `signature_${Date.now()}.png`;
  const sigPath = path.join(sigDir, sigFile);
  try {
    const base64 = signatureDataUrl.split(',')[1];
    fs.writeFileSync(sigPath, Buffer.from(base64, 'base64'));
  } catch (e) { /* signature save failure is non-fatal; PDF will omit it */ }
  const sigUrl = `/data/uploads/hr/emp_${req.session.worker.id}/tfn/${sigFile}`;

  // Insert record first
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO tfn_declarations (employee_id, tfn_encrypted, tfn_last3, residency_status, claim_threshold, has_help_debt, has_stsl_debt, medicare_variation, signature_url, submitted_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
  `).run(employee.id, encrypt(tfnRaw), tfnRaw.slice(-3), residency, claim, help, stsl, medicare, sigUrl, now);

  const newId = info.lastInsertRowid;

  // Generate PDF
  const pdfFile = `tfn_declaration_${newId}_${Date.now()}.pdf`;
  const pdfPath = path.join(sigDir, pdfFile);
  try {
    await generateTfnPdf({
      employee,
      declaration: { residency_status: residency, claim_threshold: claim, has_help_debt: help, has_stsl_debt: stsl, medicare_variation: medicare, submitted_at: now },
      tfn: tfnRaw,
      signatureDataUrl,
      outPath: pdfPath,
    });
    const pdfUrl = `/data/uploads/hr/emp_${req.session.worker.id}/tfn/${pdfFile}`;
    db.prepare('UPDATE tfn_declarations SET pdf_url = ? WHERE id = ?').run(pdfUrl, newId);
  } catch (e) {
    console.error('TFN PDF generation failed:', e.message);
  }

  logActivity({
    user: workerForAudit(req.session.worker),
    action: 'create', entityType: 'tfn_declaration',
    entityId: newId, entityLabel: employee.full_name,
    details: `Worker submitted TFN declaration (TFN •••${tfnRaw.slice(-3)}, residency ${residency}). Pending QBO sync.`,
    ip: req.ip,
  });
  notifyAdminsOfPending('tfn_declaration', employee.full_name);

  req.flash('success', 'TFN declaration submitted — admin notified for QBO action.');
  res.redirect('/w/hr/tfn');
});

module.exports = router;
