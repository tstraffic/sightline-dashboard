// Admin view of pending bank / super / TFN submissions. Decryption and export
// happen here; every read of a sensitive field writes an activity_log entry.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { decrypt, maskLast } = require('../services/encryption');

// GET /hr/secure-queue — list of pending bank/super/TFN submissions
router.get('/secure-queue', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const pendingBank = db.prepare(`
    SELECT b.id, b.employee_id, b.account_name, b.bsb_last3, b.account_last3, b.status, b.updated_at, e.full_name, e.employee_code
    FROM bank_accounts b JOIN employees e ON e.id = b.employee_id
    WHERE b.status = 'pending' ORDER BY b.updated_at DESC
  `).all();
  const pendingSuper = db.prepare(`
    SELECT s.id, s.employee_id, s.fund_name, s.usi, s.member_number, s.use_default, s.choice_form_url, s.status, s.updated_at, e.full_name, e.employee_code
    FROM super_funds s JOIN employees e ON e.id = s.employee_id
    WHERE s.status = 'pending' ORDER BY s.updated_at DESC
  `).all();
  const pendingTfn = db.prepare(`
    SELECT t.id, t.employee_id, t.tfn_last3, t.residency_status, t.claim_threshold, t.has_help_debt, t.has_stsl_debt, t.medicare_variation, t.pdf_url, t.submitted_at, e.full_name, e.employee_code
    FROM tfn_declarations t JOIN employees e ON e.id = t.employee_id
    WHERE t.status = 'pending' ORDER BY t.submitted_at DESC
  `).all();

  res.render('hr/secure-queue', {
    title: 'Pending payroll sync',
    currentPage: 'hr-secure-queue',
    pendingBank, pendingSuper, pendingTfn,
    user: req.session.user,
  });
});

// GET /hr/secure-queue/:type/:id/reveal — one-time reveal of decrypted value for QBO export
router.get('/secure-queue/:type/:id/reveal', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { type, id } = req.params;
  let payload = null;
  if (type === 'bank') {
    const row = db.prepare('SELECT b.*, e.full_name FROM bank_accounts b JOIN employees e ON e.id = b.employee_id WHERE b.id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    payload = {
      type: 'bank',
      account_name: row.account_name,
      bsb: decrypt(row.bsb_encrypted),
      account_number: decrypt(row.account_number_encrypted),
    };
    logActivity({
      user: req.session.user, action: 'view', entityType: 'bank_account_sensitive',
      entityId: row.id, entityLabel: row.full_name,
      details: 'Admin revealed decrypted bank details for QBO export',
      ip: req.ip,
    });
  } else if (type === 'tfn') {
    const row = db.prepare('SELECT t.*, e.full_name FROM tfn_declarations t JOIN employees e ON e.id = t.employee_id WHERE t.id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'not found' });
    payload = { type: 'tfn', tfn: decrypt(row.tfn_encrypted), pdf_url: row.pdf_url };
    logActivity({
      user: req.session.user, action: 'view', entityType: 'tfn_sensitive',
      entityId: row.id, entityLabel: row.full_name,
      details: 'Admin revealed decrypted TFN for QBO export',
      ip: req.ip,
    });
  } else {
    return res.status(400).json({ error: 'invalid type' });
  }
  res.json({ ok: true, data: payload });
});

// POST /hr/secure-queue/:type/:id/sync — mark as synced to QBO
router.post('/secure-queue/:type/:id/sync', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { type, id } = req.params;
  const table = type === 'bank' ? 'bank_accounts' : type === 'super' ? 'super_funds' : type === 'tfn' ? 'tfn_declarations' : null;
  if (!table) { req.flash('error', 'Invalid type.'); return req.session.save(() => res.redirect('/hr/secure-queue')); }

  if (type === 'tfn') {
    db.prepare(`UPDATE tfn_declarations SET status = 'synced', processed_at = datetime('now'), processed_by_id = ? WHERE id = ?`).run(req.session.user.id, id);
  } else {
    db.prepare(`UPDATE ${table} SET status = 'synced', synced_at = datetime('now'), synced_by_id = ? WHERE id = ?`).run(req.session.user.id, id);
  }

  logActivity({
    user: req.session.user, action: 'approve', entityType: `${type}_sync`,
    entityId: id, details: `Marked ${type} as synced to QBO`,
    ip: req.ip,
  });

  req.flash('success', `${type.toUpperCase()} marked as synced.`);
  req.session.save(() => res.redirect('/hr/secure-queue'));
});

// POST /hr/secure-queue/:type/:id/reject — reject submission
router.post('/secure-queue/:type/:id/reject', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { type, id } = req.params;
  const table = type === 'bank' ? 'bank_accounts' : type === 'super' ? 'super_funds' : type === 'tfn' ? 'tfn_declarations' : null;
  if (!table) { req.flash('error', 'Invalid type.'); return req.session.save(() => res.redirect('/hr/secure-queue')); }

  db.prepare(`UPDATE ${table} SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`).run(id);

  logActivity({
    user: req.session.user, action: 'reject', entityType: `${type}_reject`,
    entityId: id, details: `Rejected ${type} submission`,
    ip: req.ip,
  });

  req.flash('success', 'Submission rejected.');
  req.session.save(() => res.redirect('/hr/secure-queue'));
});

module.exports = router;
