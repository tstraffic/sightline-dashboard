// Public contract signing — token-gated, no login. The URL token is the
// capability: it is only ever sent to the worker's own email (or handed
// over by the office), is unguessable (48 hex chars), expires, and dies
// the moment the contract is signed, edited or voided.
//
// Mounted in server.js BEFORE blockWorkerFromAdmin so the link works in
// any session state (or none). Its POST prefix is in middleware/csrf.js
// SKIP_PREFIXES — an external phone has no session, so no CSRF token;
// the signed URL itself is the proof of authorisation.
//
// Signing requirements (all enforced server-side, not just in the UI):
//   - the full agreement must have been scrolled to the end,
//   - every Schedule B acknowledgement ticked (each stored as its own
//     timestamped row with the signer's IP),
//   - full legal name typed exactly as it appears on the agreement,
//   - date of birth matching the contract,
//   - a drawn signature.

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getDb } = require('../db/database');
const { formatDateShortAU, formatDateTimeAU } = require('../lib/sydney');
const tpl = require('../lib/contractTemplate');
const contractsAdmin = require('./contracts');

function loadByToken(db, token) {
  if (!/^[a-f0-9]{16,64}$/i.test(String(token || ''))) return null;
  return db.prepare(`
    SELECT c.*, e.full_name AS employee_name
    FROM contracts c JOIN employees e ON e.id = c.employee_id
    WHERE c.token = ?
  `).get(token);
}

function tokenState(contract) {
  if (!contract) return 'invalid';
  if (contract.status === 'signed') return 'signed';
  if (contract.status === 'void') return 'void';
  if (contract.status !== 'sent') return 'invalid';
  if (contract.token_expires_at && contract.token_expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)) return 'expired';
  return 'ok';
}

function renderStatus(res, state, contract) {
  const messages = {
    invalid: { title: 'Link not found', body: 'This signing link isn\'t valid. It may have been replaced by a newer one — check for a more recent email, or contact the T&S office.' },
    expired: { title: 'Link expired', body: 'This signing link has expired. Contact the T&S office and they\'ll send you a fresh one.' },
    void: { title: 'Agreement withdrawn', body: 'This agreement has been withdrawn by T&S. If you were expecting to sign, contact the office.' },
    signed: { title: 'Agreement signed', body: 'This agreement has been signed. You can download your copy below — keep it for your records.' },
  };
  const m = messages[state] || messages.invalid;
  res.status(state === 'invalid' ? 404 : 200).render('contract-sign/status', {
    layout: false,
    state, contract: contract || null,
    heading: m.title, body: m.body,
    signedAt: contract && contract.signed_at ? formatDateTimeAU(contract.signed_at) : null,
  });
}

// ── The agreement page ───────────────────────────────────────────────
router.get('/:token', (req, res) => {
  const db = getDb();
  const contract = loadByToken(db, req.params.token);
  const state = tokenState(contract);
  if (state !== 'ok') return renderStatus(res, state, contract);

  if (!contract.viewed_at) {
    db.prepare("UPDATE contracts SET viewed_at = datetime('now') WHERE id = ?").run(contract.id);
  }

  const fields = contractsAdmin.displayFields(contract, contractsAdmin.parseFields(contract));
  res.render('contract-sign/sign', {
    layout: false,
    contract, fields,
    sections: tpl.sections(fields),
    scheduleA: tpl.scheduleA(fields),
    acks: tpl.ACKNOWLEDGEMENTS,
    toHtml: tpl.toHtml,
    escapeHtml: tpl.escapeHtml,
    company: tpl.COMPANY,
    token: req.params.token,
  });
});

// ── PDF via token — unsigned before signing, signed after ────────────
router.get('/:token/pdf', async (req, res) => {
  const db = getDb();
  const contract = loadByToken(db, req.params.token);
  const state = tokenState(contract);
  if (state === 'invalid' || state === 'void') return res.status(404).send('Not available');

  const which = contract.status === 'signed' ? 'signed' : 'unsigned';
  let rel = which === 'signed' ? contract.signed_pdf_path : contract.unsigned_pdf_path;
  if (!rel || !fs.existsSync(path.join(__dirname, '..', rel))) {
    try { rel = await contractsAdmin.regeneratePdf(db, contract, which); }
    catch (e) { console.error('[contract-sign] render failed:', e.message); return res.status(500).send('Could not render the PDF'); }
  }
  const abs = path.join(__dirname, '..', rel);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${contract.agreement_number}-${which}.pdf"`);
  fs.createReadStream(abs).pipe(res);
});

// ── Sign ─────────────────────────────────────────────────────────────
router.post('/:token/sign', async (req, res) => {
  const db = getDb();
  const contract = loadByToken(db, req.params.token);
  const state = tokenState(contract);
  if (state === 'signed') return res.json({ ok: true, already: true });
  if (state !== 'ok') return res.status(410).json({ ok: false, error: 'This signing link is no longer valid. Contact the T&S office for a fresh one.' });

  const fields = contractsAdmin.parseFields(contract);
  const fail = (msg) => res.status(400).json({ ok: false, error: msg });

  // Identity checks — mirror of the UI gates, enforced here so a crafted
  // POST can't skip them.
  const typed = String(req.body.typed_name || '').trim().replace(/\s+/g, ' ');
  const expected = String(fields.WORKER_FULL_NAME || '').trim().replace(/\s+/g, ' ');
  if (!typed || typed.toLowerCase() !== expected.toLowerCase()) {
    return fail('Type your full legal name exactly as it appears on the agreement: ' + expected);
  }
  const dob = String(req.body.dob || '').trim();
  if (!dob || dob !== String(fields.WORKER_DOB || '')) {
    return fail('The date of birth doesn\'t match our records. Check it and try again, or contact the T&S office.');
  }
  if (String(req.body.scrolled) !== '1') {
    return fail('Please read the agreement through to the end before signing.');
  }

  // Every acknowledgement, individually — with the client-side tick time
  // captured the moment each box was ticked.
  let ackTimes = {};
  try { ackTimes = JSON.parse(req.body.acks_json || '{}'); } catch (e) { ackTimes = {}; }
  const missing = tpl.ACKNOWLEDGEMENTS.filter(a => !ackTimes[a.key]);
  if (missing.length) return fail('Please tick every acknowledgement in Schedule B before signing.');

  const sigDataUrl = String(req.body.signature_data || '');
  if (!/^data:image\/(png|jpeg);base64,.{100,}/.test(sigDataUrl)) {
    return fail('Draw your signature in the box before submitting.');
  }
  const { writeSignaturePng } = require('../services/contractPdf');
  const sigRel = writeSignaturePng(sigDataUrl, `${contract.agreement_number}-signature-${Date.now()}.png`);
  if (!sigRel) return fail('The signature couldn\'t be saved — clear the box and draw it again.');

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);

  // The signature record commits atomically: acknowledgements + contract
  // status together. PDF/archive/notification afterwards are best-effort —
  // a render hiccup must never lose a signature that was lawfully given.
  const insertAck = db.prepare(`
    INSERT INTO contract_acknowledgements (contract_id, ack_key, ack_label, ticked_at_client, ip)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(contract_id, ack_key) DO UPDATE SET ticked_at_client = excluded.ticked_at_client, ip = excluded.ip
  `);
  db.transaction(() => {
    for (const a of tpl.ACKNOWLEDGEMENTS) {
      insertAck.run(contract.id, a.key, tpl.toPlain(a.label), String(ackTimes[a.key]).slice(0, 40), ip);
    }
    db.prepare(`
      UPDATE contracts SET status = 'signed', signed_at = datetime('now'),
        signer_ip = ?, signer_user_agent = ?, signed_name_typed = ?, signature_path = ?,
        updated_at = datetime('now')
      WHERE id = ? AND status = 'sent'
    `).run(ip, ua, typed, sigRel, contract.id);
  })();

  const signedRow = db.prepare('SELECT * FROM contracts WHERE id = ?').get(contract.id);

  // Signed PDF
  let signedRel = null;
  try { signedRel = await contractsAdmin.regeneratePdf(db, signedRow, 'signed'); }
  catch (e) { console.error('[contract-sign] signed PDF render failed:', e.message); }

  // Archive against the employee record — document_type 'contract' is
  // already a mandatory HR doc type, so this clears the missing-docs flag.
  try {
    if (signedRel) {
      const abs = path.join(__dirname, '..', signedRel);
      const size = fs.existsSync(abs) ? fs.statSync(abs).size : null;
      const docR = db.prepare(`
        INSERT INTO employee_documents (employee_id, document_type, document_name, filename, original_name, file_path, file_size, issue_date, verification_status, verified_at, uploaded_by_id, notes)
        VALUES (?, 'contract', ?, ?, ?, ?, ?, DATE('now'), 'verified', datetime('now'), ?, ?)
      `).run(
        contract.employee_id,
        `Casual Employment Agreement ${contract.agreement_number} (signed)`,
        path.basename(signedRel), path.basename(signedRel), signedRel, size,
        contract.created_by_id,
        `Signed electronically ${formatDateTimeAU(signedRow.signed_at)} · IP ${ip}`
      );
      db.prepare('UPDATE contracts SET employee_document_id = ? WHERE id = ?').run(docR.lastInsertRowid, contract.id);
    }
  } catch (e) { console.error('[contract-sign] employee_documents archive failed:', e.message); }

  // Tell the sender
  try {
    if (contract.created_by_id) {
      db.prepare(`INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'general', ?, ?, ?)`)
        .run(contract.created_by_id, 'Contract signed',
          `${fields.WORKER_FULL_NAME || contract.employee_name} signed ${contract.agreement_number}.`,
          '/contracts/' + contract.id);
    }
  } catch (e) { /* notification is a nicety, never a blocker */ }

  // Email the worker their signed copy
  try {
    if (signedRel && fields.WORKER_EMAIL) {
      const { sendEmail } = require('../services/email');
      const { contractSignedEmail } = require('../services/emailTemplates');
      await sendEmail(fields.WORKER_EMAIL, `Your signed T&S employment agreement (${contract.agreement_number})`,
        contractSignedEmail(fields.WORKER_FULL_NAME || contract.employee_name, contract.agreement_number),
        { attachments: [{ filename: `${contract.agreement_number}-signed.pdf`, content: fs.readFileSync(path.join(__dirname, '..', signedRel)) }] });
    }
  } catch (e) { console.error('[contract-sign] signed-copy email failed:', e.message); }

  res.json({ ok: true });
});

module.exports = router;
