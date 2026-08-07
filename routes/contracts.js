// Contracts — generate the T&S casual employment agreement for a worker,
// send it as a tokenised public signing link, and archive the PDF both
// before and after signature.
//
// Lifecycle: draft → sent → signed (or void at any point before signing).
// Every placeholder value is snapshotted into fields_json at generation,
// so the rendered agreement is reproducible even if the employee record
// changes later. Editing a contract bumps `version`, regenerates the
// unsigned PDF and (if it had been sent) pulls the old link.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { formatDateShortAU, formatDateTimeAU } = require('../lib/sydney');
const tpl = require('../lib/contractTemplate');
const { renderContractPdf, writeContractPdf } = require('../services/contractPdf');

const TOKEN_DAYS = 14;

// ── Helpers ──────────────────────────────────────────────────────────
function nextAgreementNumber(db) {
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(agreement_number, 6) AS INTEGER)) AS n
    FROM contracts WHERE agreement_number LIKE 'TSEA-%'
  `).get();
  return 'TSEA-' + String((row && row.n ? row.n : 0) + 1).padStart(4, '0');
}

function parseFields(contract) {
  try { return JSON.parse(contract.fields_json || '{}'); } catch (e) { return {}; }
}

// The *_DISPLAY variants feed the PDF and the signing page so dates read
// as "06 Aug 2026" rather than raw ISO, without touching the stored values.
function displayFields(contract, fields) {
  return Object.assign({}, fields, {
    OFFER_DATE: formatDateShortAU(contract.created_at),
    START_DATE_DISPLAY: fields.START_DATE ? formatDateShortAU(fields.START_DATE) : '',
    WORKER_DOB_DISPLAY: fields.WORKER_DOB ? formatDateShortAU(fields.WORKER_DOB) : '',
    SIGNED_AT_DISPLAY: contract.signed_at ? formatDateTimeAU(contract.signed_at) + ' (AEST/AEDT)' : '',
  });
}

// Collect + validate the wizard's posted fields against FIELD_DEFS.
function collectFields(body) {
  const fields = {};
  const errors = [];
  for (const def of tpl.FIELD_DEFS) {
    let v = String(body[def.key] == null ? '' : body[def.key]).trim();
    if (def.key === 'TIER') {
      if (!tpl.TIERS[Number(v)]) { errors.push('Pick a valid tier (1–6).'); continue; }
    }
    if (def.options && v && !def.options.includes(v)) v = def.options[0];
    if (def.required && !v) errors.push(`${def.label} is required.`);
    fields[def.key] = v;
  }
  if (fields.WORKER_DOB && !/^\d{4}-\d{2}-\d{2}$/.test(fields.WORKER_DOB)) errors.push('Date of birth must be a valid date.');
  if (fields.START_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(fields.START_DATE)) errors.push('Commencement date must be a valid date.');
  // Lock today's wage panel into the contract. A signed agreement must keep
  // rendering the rates it was signed on, no matter how many Annual Wage
  // Reviews land afterwards — editing a contract re-snapshots deliberately.
  fields.RATES_SNAPSHOT = tpl.ratesSnapshot();
  return { fields, errors };
}

function loadAcks(db, contractId) {
  try { return db.prepare('SELECT * FROM contract_acknowledgements WHERE contract_id = ? ORDER BY id').all(contractId); }
  catch (e) { return []; }
}

// Render + persist the current PDF for a contract. which: 'unsigned'|'signed'.
async function regeneratePdf(db, contract, which) {
  const fields = displayFields(contract, parseFields(contract));
  const acks = which === 'signed' ? loadAcks(db, contract.id) : [];
  // Render against the target state, not whatever status happens to be set.
  const renderRow = Object.assign({}, contract, { status: which === 'signed' ? 'signed' : contract.status === 'signed' ? 'signed' : contract.status });
  if (which === 'unsigned') renderRow.status = 'draft';
  const buf = await renderContractPdf(renderRow, fields, acks);
  const fname = `${contract.agreement_number}-v${contract.version}-${which}.pdf`;
  const rel = writeContractPdf(buf, fname);
  db.prepare(`UPDATE contracts SET ${which === 'signed' ? 'signed_pdf_path' : 'unsigned_pdf_path'} = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(rel, contract.id);
  return rel;
}

function streamPdf(res, relPath, downloadName) {
  const abs = path.join(__dirname, '..', relPath);
  if (!fs.existsSync(abs)) return false;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  fs.createReadStream(abs).pipe(res);
  return true;
}

const STATUS_LABELS = { draft: 'Draft', sent: 'Sent', signed: 'Signed', void: 'Void' };

// ── Register ─────────────────────────────────────────────────────────
router.get('/', requirePermission('hr_contracts'), (req, res) => {
  const db = getDb();
  const status = ['draft', 'sent', 'signed', 'void'].includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').trim();

  const where = ['1=1'];
  const params = [];
  if (status) { where.push('c.status = ?'); params.push(status); }
  if (q) { where.push('(e.full_name LIKE ? OR c.agreement_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const rows = db.prepare(`
    SELECT c.*, e.full_name AS employee_name, e.employee_code,
      u.full_name AS created_by_name
    FROM contracts c
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN users u ON u.id = c.created_by_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.created_at DESC
    LIMIT 300
  `).all(...params);

  const count = (s) => db.prepare('SELECT COUNT(*) AS c FROM contracts WHERE status = ?').get(s).c;
  const counts = { draft: count('draft'), sent: count('sent'), signed: count('signed'), void: count('void') };
  counts.all = counts.draft + counts.sent + counts.signed + counts.void;

  res.render('contracts/index', {
    title: 'Contracts',
    currentPage: 'contracts',
    rows, counts,
    filters: { status, q },
    STATUS_LABELS,
    user: req.session.user,
  });
});

// ── Generate wizard ──────────────────────────────────────────────────
router.get('/new', requirePermission('hr_contracts'), (req, res) => {
  const db = getDb();
  const employees = db.prepare(`
    SELECT id, full_name, employee_code, employment_status
    FROM employees WHERE deleted_at IS NULL AND employment_status IN ('active','onboarding','reserved')
    ORDER BY full_name
  `).all();

  const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
  let employee = null, prefill = null;
  if (employeeId) {
    employee = db.prepare('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL').get(employeeId);
    if (employee) {
      let latestSuper = null;
      try {
        latestSuper = db.prepare('SELECT fund_name, member_number FROM super_funds WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);
      } catch (e) { /* table may not exist on old deploys */ }
      const addr = [employee.address, employee.suburb, employee.state, employee.postcode].filter(Boolean).join(', ');
      const tier = employee.tier && tpl.TIERS[Number(employee.tier)] ? String(employee.tier) : '2';
      prefill = {
        WORKER_FULL_NAME: employee.full_name || '',
        WORKER_DOB: employee.date_of_birth || '',
        WORKER_ADDRESS: addr,
        WORKER_MOBILE: employee.phone || '',
        WORKER_EMAIL: employee.email || '',
        START_DATE: employee.start_date || '',
        TIER: tier,
        POSITION_TITLE: employee.role_title || tpl.TIERS[Number(tier)].role,
        SUPER_FUND_NAME: (latestSuper && latestSuper.fund_name) || '',
        SUPER_MEMBER_NUMBER: (latestSuper && latestSuper.member_number) || '',
        TS_SIGNATORY_NAME: req.session.user.full_name || '',
      };
    }
  }

  res.render('contracts/new', {
    title: 'Generate Contract',
    currentPage: 'contracts',
    employees, employee, prefill,
    contract: null, fields: prefill || {},
    fieldDefs: tpl.FIELD_DEFS, tiers: tpl.TIERS,
    user: req.session.user,
  });
});

// Edit an existing draft/sent contract — same wizard, prefilled from the snapshot.
router.get('/:id/edit', requirePermission('hr_contracts'), (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT c.*, e.full_name AS employee_name FROM contracts c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?').get(req.params.id);
  if (!contract) { req.flash('error', 'Contract not found.'); return req.session.save(() => res.redirect('/contracts')); }
  if (!['draft', 'sent'].includes(contract.status)) {
    req.flash('error', 'A ' + contract.status + ' contract can\'t be edited. Generate a new one instead.');
    return req.session.save(() => res.redirect('/contracts/' + contract.id));
  }
  res.render('contracts/new', {
    title: 'Edit ' + contract.agreement_number,
    currentPage: 'contracts',
    employees: [], employee: { id: contract.employee_id, full_name: contract.employee_name },
    prefill: null,
    contract, fields: parseFields(contract),
    fieldDefs: tpl.FIELD_DEFS, tiers: tpl.TIERS,
    user: req.session.user,
  });
});

// ── Create ───────────────────────────────────────────────────────────
router.post('/', requirePermission('hr_contracts'), async (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ? AND deleted_at IS NULL').get(req.body.employee_id);
  if (!employee) { req.flash('error', 'Pick a worker first.'); return req.session.save(() => res.redirect('/contracts/new')); }

  const { fields, errors } = collectFields(req.body);
  if (errors.length) {
    req.flash('error', errors.join(' '));
    return req.session.save(() => res.redirect('/contracts/new?employee_id=' + employee.id));
  }

  const agreementNumber = nextAgreementNumber(db);
  const r = db.prepare(`
    INSERT INTO contracts (agreement_number, employee_id, status, version, template_version, fields_json, created_by_id, updated_at)
    VALUES (?, ?, 'draft', 1, ?, ?, ?, datetime('now'))
  `).run(agreementNumber, employee.id, tpl.TEMPLATE_VERSION, JSON.stringify(fields), req.session.user.id);

  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(r.lastInsertRowid);
  try { await regeneratePdf(db, contract, 'unsigned'); }
  catch (e) { console.error('[contracts] unsigned PDF render failed:', e.message); }

  logActivity({ user: req.session.user, action: 'create', entityType: 'contract', entityId: contract.id, entityLabel: agreementNumber, details: `Contract generated for ${employee.full_name}`, ip: req.ip });
  req.flash('success', `${agreementNumber} generated for ${employee.full_name}. Review it, then send the signing link.`);
  req.session.save(() => res.redirect('/contracts/' + contract.id));
});

// ── Update (draft/sent) ──────────────────────────────────────────────
router.post('/:id', requirePermission('hr_contracts'), async (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) { req.flash('error', 'Contract not found.'); return req.session.save(() => res.redirect('/contracts')); }
  if (!['draft', 'sent'].includes(contract.status)) {
    req.flash('error', 'A ' + contract.status + ' contract can\'t be edited.');
    return req.session.save(() => res.redirect('/contracts/' + contract.id));
  }

  const { fields, errors } = collectFields(req.body);
  if (errors.length) {
    req.flash('error', errors.join(' '));
    return req.session.save(() => res.redirect('/contracts/' + contract.id + '/edit'));
  }

  // Editing invalidates any live link: the worker must only ever sign the
  // exact document T&S generated, so a changed contract goes back to draft
  // with a fresh version number and no token.
  const wasSent = contract.status === 'sent';
  db.prepare(`
    UPDATE contracts SET fields_json = ?, version = version + 1, status = 'draft',
      token = NULL, token_expires_at = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(fields), contract.id);

  const updated = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract.id);
  try { await regeneratePdf(db, updated, 'unsigned'); }
  catch (e) { console.error('[contracts] unsigned PDF render failed:', e.message); }

  logActivity({ user: req.session.user, action: 'update', entityType: 'contract', entityId: contract.id, entityLabel: contract.agreement_number, details: `Edited — now version ${updated.version}${wasSent ? '; previous signing link revoked' : ''}`, ip: req.ip });
  req.flash('success', `${contract.agreement_number} updated to version ${updated.version}.` + (wasSent ? ' The old signing link no longer works — send a new one.' : ''));
  req.session.save(() => res.redirect('/contracts/' + contract.id));
});

// ── Detail ───────────────────────────────────────────────────────────
router.get('/:id', requirePermission('hr_contracts'), (req, res) => {
  const db = getDb();
  const contract = db.prepare(`
    SELECT c.*, e.full_name AS employee_name, e.employee_code, e.id AS emp_id,
      u.full_name AS created_by_name
    FROM contracts c
    JOIN employees e ON e.id = c.employee_id
    LEFT JOIN users u ON u.id = c.created_by_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!contract) { req.flash('error', 'Contract not found.'); return req.session.save(() => res.redirect('/contracts')); }

  const fields = parseFields(contract);
  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  res.render('contracts/show', {
    title: contract.agreement_number,
    currentPage: 'contracts',
    contract, fields,
    acks: loadAcks(db, contract.id),
    ackDefs: tpl.ACKNOWLEDGEMENTS,
    // The contract's own locked-in rates, not today's — so an old signed
    // agreement keeps showing what was actually agreed.
    tiers: tpl.ratesFor(fields).tiers,
    signUrl: contract.token ? `${base}/contract-sign/${contract.token}` : null,
    STATUS_LABELS,
    user: req.session.user,
  });
});

// ── Send / copy link ─────────────────────────────────────────────────
router.post('/:id/send', requirePermission('hr_contracts'), async (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT c.*, e.full_name AS employee_name FROM contracts c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?').get(req.params.id);
  if (!contract) { req.flash('error', 'Contract not found.'); return req.session.save(() => res.redirect('/contracts')); }
  if (!['draft', 'sent'].includes(contract.status)) {
    req.flash('error', 'This contract is ' + contract.status + ' — it can\'t be sent.');
    return req.session.save(() => res.redirect('/contracts/' + contract.id));
  }

  const fields = parseFields(contract);
  const mode = req.body.mode === 'link' ? 'link' : 'email';
  const email = (req.body.email || fields.WORKER_EMAIL || '').trim();
  if (mode === 'email' && !email) {
    req.flash('error', 'No email on the contract — add one or use Copy link.');
    return req.session.save(() => res.redirect('/contracts/' + contract.id));
  }

  // Fresh token on every send: a re-send always supersedes the old link.
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(`
    UPDATE contracts SET token = ?, token_expires_at = datetime('now', '+${TOKEN_DAYS} days'),
      status = 'sent', sent_to_email = ?, sent_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `).run(token, mode === 'email' ? email : (contract.sent_to_email || null), contract.id);

  const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const signUrl = `${base}/contract-sign/${token}`;

  if (mode === 'email') {
    try {
      const { sendEmail } = require('../services/email');
      const { contractSignLinkEmail } = require('../services/emailTemplates');
      // Attach the unsigned PDF so the worker has the offer in hand even
      // before opening the link.
      const attachments = [];
      const updated = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract.id);
      let rel = updated.unsigned_pdf_path;
      if (!rel || !fs.existsSync(path.join(__dirname, '..', rel))) rel = await regeneratePdf(db, updated, 'unsigned');
      attachments.push({ filename: `${contract.agreement_number}.pdf`, content: fs.readFileSync(path.join(__dirname, '..', rel)) });
      await sendEmail(email, 'Your T&S employment agreement — review and sign', contractSignLinkEmail(fields.WORKER_FULL_NAME || contract.employee_name, signUrl, contract.agreement_number), { attachments });
      req.flash('success', `Signing link emailed to ${email}. The link stays live for ${TOKEN_DAYS} days.`);
    } catch (e) {
      console.error('[contracts] send email failed:', e.message);
      req.flash('error', 'Email failed to send (' + e.message + ') — the link below still works, copy it manually.');
    }
  } else {
    req.flash('success', `Signing link created — it stays live for ${TOKEN_DAYS} days. Copy it from the panel below.`);
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'contract', entityId: contract.id, entityLabel: contract.agreement_number, details: mode === 'email' ? `Signing link emailed to ${email}` : 'Signing link created (copy-link)', ip: req.ip });
  req.session.save(() => res.redirect('/contracts/' + contract.id));
});

// ── Void ─────────────────────────────────────────────────────────────
router.post('/:id/void', requirePermission('hr_contracts'), (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) { req.flash('error', 'Contract not found.'); return req.session.save(() => res.redirect('/contracts')); }
  if (contract.status === 'signed') {
    // A signed agreement is a record, not a draft — voiding it doesn't
    // un-sign anything, it just marks it superseded.
    req.flash('error', 'A signed agreement can\'t be voided from here. Generate a replacement contract instead.');
    return req.session.save(() => res.redirect('/contracts/' + contract.id));
  }
  db.prepare(`
    UPDATE contracts SET status = 'void', token = NULL, token_expires_at = NULL,
      voided_at = datetime('now'), void_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run((req.body.reason || '').trim() || null, contract.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'contract', entityId: contract.id, entityLabel: contract.agreement_number, details: 'Voided' + (req.body.reason ? ': ' + req.body.reason : ''), ip: req.ip });
  req.flash('success', `${contract.agreement_number} voided — its signing link no longer works.`);
  req.session.save(() => res.redirect('/contracts'));
});

// ── PDF (admin side) ─────────────────────────────────────────────────
router.get('/:id/pdf', requirePermission('hr_contracts'), async (req, res) => {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!contract) return res.status(404).send('Not found');

  const which = req.query.which === 'unsigned' ? 'unsigned' : (contract.status === 'signed' ? 'signed' : 'unsigned');
  let rel = which === 'signed' ? contract.signed_pdf_path : contract.unsigned_pdf_path;
  if (!rel || !fs.existsSync(path.join(__dirname, '..', rel))) {
    // Regenerate on demand — survives a fresh deploy where data/ is intact
    // but a render previously failed.
    try { rel = await regeneratePdf(db, contract, which); }
    catch (e) { console.error('[contracts] on-demand render failed:', e.message); return res.status(500).send('Could not render the PDF'); }
  }
  if (!streamPdf(res, rel, `${contract.agreement_number}-${which}.pdf`)) res.status(404).send('File missing');
});

module.exports = router;
module.exports.regeneratePdf = regeneratePdf;
module.exports.displayFields = displayFields;
module.exports.parseFields = parseFields;
module.exports.loadAcks = loadAcks;
