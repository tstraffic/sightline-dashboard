// IT Feedback — captures one-shot bug reports / suggestions from
// both the admin dashboard and the worker portal. Mounted at /feedback;
// the POST endpoint accepts submissions from either source (auth comes
// from req.session.user for admin or req.session.worker for worker),
// while GET / and the resolve / delete routes are admin-only.

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireLogin, requirePermission, canAccess } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

// POST /feedback/submit — open to both portals. The session decides
// which source bucket the row lands in. JSON in, JSON out so the
// fixed-position widgets in both layouts can fire-and-acknowledge
// without a page reload.
router.post('/submit', express.json({ limit: '32kb' }), (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const title = String(body.title || '').trim().slice(0, 200);
  const comment = String(body.comment || '').trim().slice(0, 5000);
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  let source = null, userId = null, crewId = null, fullName = '';
  if (req.session && req.session.user) {
    source = 'admin';
    userId = req.session.user.id;
    fullName = req.session.user.full_name || req.session.user.username || '';
  } else if (req.session && req.session.worker) {
    source = 'worker';
    crewId = req.session.worker.id;
    fullName = req.session.worker.full_name || '';
  } else {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const pageUrl = String(body.page_url || req.get('Referrer') || '').slice(0, 500);
  const userAgent = String(req.get('User-Agent') || '').slice(0, 300);

  try {
    const r = db.prepare(`
      INSERT INTO it_feedback (source, user_id, crew_member_id, full_name, title, comment, page_url, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(source, userId, crewId, fullName, title, comment, pageUrl, userAgent);
    return res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) {
    console.error('[feedback] insert error:', e.message);
    return res.status(500).json({ error: 'Could not save feedback. Please try again.' });
  }
});

// GET / — admin-only feedback inbox. Two tabs (admin vs worker source)
// driven by the ?source= query param.
router.get('/', requireLogin, (req, res) => {
  // Anyone signed in as an admin can view; pages without the chip
  // shouldn't pop the form, but we still gate the inbox by role to
  // keep the feedback feed admin-only.
  if (!canAccess(req.session.user, 'admin') && req.session.user.role !== 'admin') {
    req.flash('error', 'Admins only.');
    return req.session.save(() => res.redirect('/dashboard'));
  }
  const db = getDb();
  const source = req.query.source === 'worker' ? 'worker' : 'admin';
  const status = req.query.status || 'all';
  let where = 'source = ?';
  const params = [source];
  if (status === 'open' || status === 'in_progress' || status === 'resolved') {
    where += ' AND status = ?'; params.push(status);
  }
  const items = db.prepare(`
    SELECT f.*, u.full_name AS resolver_name
    FROM it_feedback f
    LEFT JOIN users u ON u.id = f.resolved_by_id
    WHERE ${where}
    ORDER BY f.created_at DESC
  `).all(...params);
  const counts = db.prepare(`
    SELECT source, COUNT(*) AS n,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS n_open
    FROM it_feedback GROUP BY source
  `).all().reduce((acc, r) => { acc[r.source] = r; return acc; }, {});

  res.render('feedback/index', {
    title: 'IT Feedback',
    currentPage: 'feedback',
    items, source, status,
    counts: {
      admin:  counts.admin  || { n: 0, n_open: 0 },
      worker: counts.worker || { n: 0, n_open: 0 },
    },
  });
});

// POST /:id/status — flip a feedback item's status (admin only).
router.post('/:id/status', requireLogin, (req, res) => {
  if (!canAccess(req.session.user, 'admin') && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only.' });
  }
  const db = getDb();
  const next = req.body.status;
  if (!['open', 'in_progress', 'resolved'].includes(next)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  if (next === 'resolved') {
    db.prepare("UPDATE it_feedback SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by_id = ? WHERE id = ?")
      .run(next, req.session.user.id, req.params.id);
  } else {
    db.prepare("UPDATE it_feedback SET status = ?, resolved_at = NULL, resolved_by_id = NULL WHERE id = ?")
      .run(next, req.params.id);
  }
  try { logActivity({ user: req.session.user, action: 'update', entityType: 'it_feedback', entityId: req.params.id, details: 'status → ' + next, req }); } catch (e) {}
  req.flash('success', 'Feedback updated.');
  return req.session.save(() => res.redirect('/feedback?source=' + (req.body.source || 'admin')));
});

// POST /:id/delete — admin only.
router.post('/:id/delete', requireLogin, (req, res) => {
  if (!canAccess(req.session.user, 'admin') && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only.' });
  }
  const db = getDb();
  db.prepare('DELETE FROM it_feedback WHERE id = ?').run(req.params.id);
  req.flash('success', 'Feedback deleted.');
  return req.session.save(() => res.redirect('/feedback?source=' + (req.body.source || 'admin')));
});

module.exports = router;
