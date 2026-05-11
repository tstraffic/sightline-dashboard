// Public, token-protected sign-off page.
// Mounted at /sop-sign — requires no auth (token in URL is the gate).
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getDb } = require('../db/database');
const { currentVersion: currentSopVersion, ackText: sopAckText, activeDocuments: activeSopDocuments } = require('../lib/sop');

const SOP_DOC_DIR = path.join(__dirname, '..', 'data', 'uploads', 'sop-documents');
const SOP_PAGE_DIR = path.join(SOP_DOC_DIR, 'page-renders');

function loadSession(token) {
  return getDb().prepare('SELECT * FROM sop_signing_sessions WHERE token = ?').get(token);
}

// Fetch attendee list for a session — pulled from active crew_members so the
// signer can pick their name rather than re-typing. Already-signed people are
// flagged so they don't accidentally sign twice.
function loadAttendeeList(sessionId) {
  const db = getDb();
  const crew = db.prepare(`
    SELECT id, full_name, employee_id, email
    FROM crew_members
    WHERE active = 1
    ORDER BY full_name
  `).all();
  const signedIds = new Set(
    db.prepare('SELECT crew_member_id FROM sop_acknowledgements WHERE session_id = ? AND crew_member_id IS NOT NULL')
      .all(sessionId)
      .map(r => r.crew_member_id)
  );
  return crew.map(m => ({ ...m, alreadySigned: signedIds.has(m.id) }));
}

// GET /sop-sign/:token — pick name + sign
router.get('/:token', (req, res) => {
  const db = getDb();
  const session = loadSession(req.params.token);
  if (!session) {
    return res.status(404).render('sop-sign/error', { layout: false, message: 'This sign-off link is invalid.' });
  }
  if (session.closed_at) {
    return res.status(410).render('sop-sign/error', { layout: false, message: 'This sign-off session has been closed. Please ask the presenter to start a new one.' });
  }

  // Individual link (target set) → lock the name to one person and short-circuit
  // if they've already signed the current SOP version
  let targetCrew = null;
  if (session.target_crew_member_id) {
    targetCrew = db.prepare('SELECT id, full_name, employee_id, email FROM crew_members WHERE id = ?').get(session.target_crew_member_id);
    if (targetCrew) {
      const existing = db.prepare(
        'SELECT id FROM sop_acknowledgements WHERE crew_member_id = ? AND sop_version = ? ORDER BY id DESC LIMIT 1'
      ).get(targetCrew.id, session.sop_version);
      if (existing) {
        return res.render('sop-sign/mobile', {
          layout: false, session, attendees: [], ackText: sopAckText(), sopVersion: session.sop_version,
          submitted: true, signedName: targetCrew.full_name, alreadyDone: true, error: null,
        });
      }
    }
  }

  const attendees = session.target_crew_member_id ? [] : loadAttendeeList(session.id);
  const documents = activeSopDocuments(db);

  res.render('sop-sign/mobile', {
    layout: false,
    session,
    targetCrew,
    attendees,
    documents,
    ackText: sopAckText(),
    sopVersion: currentSopVersion(),
    submitted: false,
    error: null,
  });
});

// GET /sop-sign/:token/document/:docId/page/:pageFile — token-gated PNG
// serving for the inline PDF page renders.
router.get('/:token/document/:docId/page/:pageFile', (req, res) => {
  const session = loadSession(req.params.token);
  if (!session || session.closed_at) return res.status(404).send('Session unavailable');
  const db = getDb();
  const doc = db.prepare('SELECT * FROM sop_documents WHERE id = ? AND active = 1').get(req.params.docId);
  if (!doc) return res.status(404).send('Document not found');
  const pageFile = path.basename(req.params.pageFile);
  const safe = path.resolve(SOP_PAGE_DIR, String(doc.id), pageFile);
  if (!safe.startsWith(SOP_PAGE_DIR) || !fs.existsSync(safe)) return res.status(404).send('Page missing');
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(safe);
});

// GET /sop-sign/:token/document/:docId — token-gated file serving so workers
// can open the SOP / SWMS PDFs from the sign page without a separate login.
router.get('/:token/document/:docId', (req, res) => {
  const session = loadSession(req.params.token);
  if (!session || session.closed_at) return res.status(404).send('Session unavailable');

  const db = getDb();
  const doc = db.prepare('SELECT * FROM sop_documents WHERE id = ? AND active = 1').get(req.params.docId);
  if (!doc) return res.status(404).send('Document not found');

  const safe = path.resolve(SOP_DOC_DIR, path.basename(doc.filename));
  if (!safe.startsWith(SOP_DOC_DIR) || !fs.existsSync(safe)) return res.status(404).send('File missing');

  if (doc.mime_type) res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', 'inline; filename="' + (doc.original_name || doc.filename) + '"');
  res.sendFile(safe);
});

// POST /sop-sign/:token/submit — save signature
router.post('/:token/submit', (req, res) => {
  const db = getDb();
  const session = loadSession(req.params.token);
  if (!session || session.closed_at) {
    return res.status(400).json({ ok: false, error: 'Session not available' });
  }

  const wantsJson = (req.headers.accept || '').includes('application/json') || req.headers['content-type']?.includes('application/json');
  const fail = (msg, status) => {
    if (wantsJson) return res.status(status || 400).json({ ok: false, error: msg });
    return res.status(status || 400).render('sop-sign/error', { layout: false, message: msg });
  };

  // If session is bound to one specific person, ignore any client-side picker
  // and force that crew member to be the signer.
  let crewId = null;
  if (session.target_crew_member_id) {
    crewId = session.target_crew_member_id;
  } else if (req.body.crew_member_id) {
    crewId = parseInt(req.body.crew_member_id, 10);
  }

  const typedName = (req.body.full_name || '').toString().trim();
  const email = (req.body.email || '').toString().trim();
  const sigDataUrl = (req.body.signature_data || '').toString();

  let resolvedName = typedName;
  let resolvedEmail = email;
  if (crewId) {
    const m = db.prepare('SELECT full_name, email FROM crew_members WHERE id = ?').get(crewId);
    if (!m) return fail('Could not find that person on the crew list.');
    resolvedName = m.full_name;
    if (!resolvedEmail) resolvedEmail = m.email || '';
  }
  if (!resolvedName) return fail('Please pick your name from the list or type it.');

  if (!/^data:image\/(png|jpeg);base64,/.test(sigDataUrl)) {
    return fail('Please draw your signature.');
  }

  // Save signature image
  let signatureUrl = '';
  try {
    const sigDir = path.join(__dirname, '..', 'data', 'uploads', 'sop-signatures');
    fs.mkdirSync(sigDir, { recursive: true });
    const fname = `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
    const base64 = sigDataUrl.split(',')[1];
    fs.writeFileSync(path.join(sigDir, fname), Buffer.from(base64, 'base64'));
    signatureUrl = `/data/uploads/sop-signatures/${fname}`;
  } catch (e) {
    console.error('SOP signature save failed:', e.message);
    return fail('Could not save signature. Please try again.', 500);
  }

  const signedIp = (req.ip || req.connection?.remoteAddress || '').toString().slice(0, 45);

  db.prepare(`
    INSERT INTO sop_acknowledgements
      (session_id, crew_member_id, full_name, email, sop_version, signature_url, signed_via, signed_ip)
    VALUES (?, ?, ?, ?, ?, ?, 'mobile', ?)
  `).run(session.id, crewId, resolvedName, resolvedEmail, session.sop_version, signatureUrl, signedIp);

  // For individual sessions (sent via email), close them once signed so the
  // link can't be reused — keeps the audit trail tidy.
  if (session.target_crew_member_id) {
    db.prepare("UPDATE sop_signing_sessions SET closed_at = datetime('now') WHERE id = ?").run(session.id);
  }

  if (wantsJson) return res.json({ ok: true });
  res.render('sop-sign/mobile', {
    layout: false,
    session,
    attendees: [],
    ackText: sopAckText(),
    sopVersion: session.sop_version,
    submitted: true,
    signedName: resolvedName,
    error: null,
  });
});

module.exports = router;
