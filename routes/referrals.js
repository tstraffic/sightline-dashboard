// Referrals register (brief §3.1) — who introduced each opportunity and
// what it generated. Attributed values are derived at read time from the
// linked opportunity (and its won project's contract value), never stored.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sydneyToday } = require('../lib/sydney');

const LIST_SQL = `
  SELECT r.*,
    rc.company_name AS referring_company, rcc.full_name AS referring_contact,
    dc.company_name AS referred_company, dcc.full_name AS referred_contact,
    u.full_name AS owner_name,
    o.opportunity_number, o.title AS opp_title, o.status AS opp_status,
    o.estimated_value AS opp_value, o.related_job_id,
    j.job_number, j.contract_value AS job_value
  FROM referrals r
  LEFT JOIN clients rc ON r.referring_client_id = rc.id
  LEFT JOIN client_contacts rcc ON r.referring_contact_id = rcc.id
  LEFT JOIN clients dc ON r.referred_client_id = dc.id
  LEFT JOIN client_contacts dcc ON r.referred_contact_id = dcc.id
  LEFT JOIN users u ON r.owner_id = u.id
  LEFT JOIN opportunities o ON r.opportunity_id = o.id
  LEFT JOIN jobs j ON o.related_job_id = j.id
`;

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { outcome, thank_you, channel, search } = req.query;
    let where = [];
    const params = [];
    if (outcome) { where.push('r.outcome = ?'); params.push(outcome); }
    if (thank_you === 'pending') { where.push("r.thank_you_status = 'pending'"); }
    if (channel) { where.push('r.channel = ?'); params.push(channel); }
    if (search) {
      where.push('(rc.company_name LIKE ? OR dc.company_name LIKE ? OR o.opportunity_number LIKE ? OR o.title LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    const referrals = db.prepare(
      LIST_SQL + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY r.referral_date DESC, r.id DESC'
    ).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'won' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN outcome = 'open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN thank_you_status = 'pending' THEN 1 ELSE 0 END) AS thanks_pending
      FROM referrals
    `).get();
    // Attributed value — derived: proposal value = linked opp expected value;
    // won value = won opp's project contract value (fallback opp value).
    const attributed = db.prepare(`
      SELECT
        COALESCE(SUM(o.estimated_value), 0) AS attributed_pipeline,
        COALESCE(SUM(CASE WHEN o.status = 'won' THEN COALESCE(j.contract_value, o.estimated_value) ELSE 0 END), 0) AS attributed_won
      FROM referrals r
      JOIN opportunities o ON r.opportunity_id = o.id
      LEFT JOIN jobs j ON o.related_job_id = j.id
    `).get();

    res.render('referrals/index', {
      title: 'Referrals',
      currentPage: 'referrals',
      referrals,
      stats,
      attributed,
      filters: { outcome, thank_you, channel, search },
    });
  } catch (err) { next(err); }
});

// New referral form
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    res.render('referrals/form', {
      title: 'New Referral',
      currentPage: 'referrals',
      referral: null,
      companies: db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all(),
      contacts: db.prepare('SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name').all(),
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      opportunities: db.prepare('SELECT id, opportunity_number, title FROM opportunities ORDER BY id DESC LIMIT 200').all(),
    });
  } catch (err) { next(err); }
});

// Create
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO referrals (referring_client_id, referring_contact_id, referred_client_id, referred_contact_id,
        opportunity_id, referral_date, owner_id, channel, notes, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.referring_client_id || null, b.referring_contact_id || null,
      b.referred_client_id || null, b.referred_contact_id || null,
      b.opportunity_id || null, b.referral_date || sydneyToday(),
      b.owner_id || (req.session.user ? req.session.user.id : null),
      b.channel || '', b.notes || '',
      req.session.user ? req.session.user.id : null
    );
    if (b.opportunity_id) {
      db.prepare('UPDATE opportunities SET referral_id = ? WHERE id = ? AND referral_id IS NULL').run(result.lastInsertRowid, b.opportunity_id);
    }
    logActivity({
      user: req.session.user, action: 'create', entityType: 'referral',
      entityId: result.lastInsertRowid, entityLabel: `Referral #${result.lastInsertRowid}`, ip: req.ip,
    });
    req.flash('success', 'Referral recorded.');
    req.session.save(() => res.redirect('/referrals'));
  } catch (err) {
    req.flash('error', 'Failed to record referral: ' + err.message);
    req.session.save(() => res.redirect('/referrals/new'));
  }
});

// Edit form
router.get('/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(req.params.id);
    if (!referral) {
      req.flash('error', 'Referral not found.');
      return req.session.save(() => res.redirect('/referrals'));
    }
    res.render('referrals/form', {
      title: 'Edit Referral',
      currentPage: 'referrals',
      referral,
      companies: db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all(),
      contacts: db.prepare('SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name').all(),
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      opportunities: db.prepare('SELECT id, opportunity_number, title FROM opportunities ORDER BY id DESC LIMIT 200').all(),
    });
  } catch (err) { next(err); }
});

// Update
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    db.prepare(`
      UPDATE referrals SET referring_client_id=?, referring_contact_id=?, referred_client_id=?, referred_contact_id=?,
        opportunity_id=?, referral_date=?, owner_id=?, channel=?, notes=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.referring_client_id || null, b.referring_contact_id || null,
      b.referred_client_id || null, b.referred_contact_id || null,
      b.opportunity_id || null, b.referral_date || null,
      b.owner_id || null, b.channel || '', b.notes || '', req.params.id
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'referral',
      entityId: parseInt(req.params.id), entityLabel: `Referral #${req.params.id}`, ip: req.ip,
    });
    req.flash('success', 'Referral updated.');
    req.session.save(() => res.redirect('/referrals'));
  } catch (err) {
    req.flash('error', 'Failed to update referral: ' + err.message);
    req.session.save(() => res.redirect('/referrals/' + req.params.id + '/edit'));
  }
});

// Referral stewardship (brief §3.6): mark the thank-you done / reopen it.
router.post('/:id/thank-you', (req, res) => {
  const db = getDb();
  const referral = db.prepare('SELECT * FROM referrals WHERE id = ?').get(req.params.id);
  if (!referral) {
    req.flash('error', 'Referral not found.');
    return req.session.save(() => res.redirect('/referrals'));
  }
  const done = referral.thank_you_status !== 'done';
  db.prepare('UPDATE referrals SET thank_you_status = ?, thank_you_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(done ? 'done' : 'pending', done ? sydneyToday() : null, req.params.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'referral',
    entityId: parseInt(req.params.id), entityLabel: `Referral #${req.params.id}`,
    details: done ? 'Thank-you recorded' : 'Thank-you reopened', ip: req.ip,
  });
  req.flash('success', done ? 'Thank-you recorded.' : 'Thank-you reopened.');
  req.session.save(() => res.redirect(req.body.return_to || '/referrals'));
});

// Delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('UPDATE opportunities SET referral_id = NULL WHERE referral_id = ?').run(req.params.id);
    db.prepare('DELETE FROM referrals WHERE id = ?').run(req.params.id);
    logActivity({
      user: req.session.user, action: 'delete', entityType: 'referral',
      entityId: parseInt(req.params.id), entityLabel: `Referral #${req.params.id}`, ip: req.ip,
    });
    req.flash('success', 'Referral deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete referral: ' + err.message);
  }
  req.session.save(() => res.redirect('/referrals'));
});

module.exports = router;
