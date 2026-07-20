// Admin tools for kudos: values CRUD, moderation queue, analytics.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { hideKudos, getActiveValues } = require('../services/kudos');

// ========== Values ==========
router.get('/values', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const values = db.prepare('SELECT * FROM company_values ORDER BY sort_order, id').all();
  res.render('kudos-admin/values', {
    title: 'Company values',
    currentPage: 'kudos-values',
    values,
  });
});

router.post('/values', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { name, colour, icon, description, sort_order, points_value } = req.body;
  if (!name) { req.flash('error', 'Name required'); return req.session.save(() => res.redirect('/kudos-admin/values')); }
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
  const pts = Math.max(0, parseInt(points_value, 10) || 0);
  db.prepare('INSERT INTO company_values (name, slug, colour, icon, description, sort_order, points_value) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, slug, colour || '#2B7FFF', icon || 'star', description || '', parseInt(sort_order, 10) || 0, pts);
  req.flash('success', 'Value added');
  req.session.save(() => res.redirect('/kudos-admin/values'));
});

router.post('/values/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { name, colour, icon, description, sort_order, active, points_value } = req.body;
  const pts = Math.max(0, parseInt(points_value, 10) || 0);
  db.prepare(`UPDATE company_values SET name = ?, colour = ?, icon = ?, description = ?, sort_order = ?, points_value = ?, active = ? WHERE id = ?`)
    .run(name, colour, icon || 'star', description || '', parseInt(sort_order, 10) || 0, pts, active ? 1 : 0, req.params.id);
  req.flash('success', 'Value updated');
  req.session.save(() => res.redirect('/kudos-admin/values'));
});

router.post('/values/:id/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  // Soft delete (deactivate) to preserve foreign keys on existing kudos
  db.prepare('UPDATE company_values SET active = 0 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Value deactivated');
  req.session.save(() => res.redirect('/kudos-admin/values'));
});

// ========== Live feed (all kudos, newest first) ==========
router.get('/feed', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const valueId = parseInt(req.query.value, 10) || null;
  const showHidden = req.query.hidden === '1';
  const before = parseInt(req.query.before, 10) || null;
  const LIMIT = 30;
  const where = [];
  const params = [];
  if (!showHidden) where.push('k.hidden_at IS NULL');
  if (valueId) { where.push('k.value_id = ?'); params.push(valueId); }
  if (before) { where.push('k.id < ?'); params.push(before); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT k.id, k.message, k.photo_url, k.visibility, k.hidden_at, k.created_at,
      s.full_name AS sender_name,
      v.name AS value_name, v.colour AS value_colour, v.points_value AS value_points,
      (SELECT COUNT(*) FROM kudos_comments kc WHERE kc.kudos_id = k.id AND kc.hidden_at IS NULL) AS comment_count,
      (SELECT COUNT(*) FROM kudos_reactions kx WHERE kx.kudos_id = k.id) AS reaction_count
    FROM kudos k
    JOIN crew_members s ON s.id = k.sender_crew_id
    LEFT JOIN company_values v ON v.id = k.value_id
    ${whereSql}
    ORDER BY k.id DESC LIMIT ${LIMIT + 1}
  `).all(...params);
  const hasMore = rows.length > LIMIT;
  const items = rows.slice(0, LIMIT);
  if (items.length) {
    const ids = items.map(r => r.id);
    const inClause = ids.map(() => '?').join(',');
    const recips = db.prepare(`
      SELECT kr.kudos_id, cm.full_name FROM kudos_recipients kr
      JOIN crew_members cm ON cm.id = kr.recipient_crew_id WHERE kr.kudos_id IN (${inClause})
    `).all(...ids);
    const byId = new Map(items.map(r => [r.id, r]));
    items.forEach(r => { r.recipient_names = []; });
    recips.forEach(r => { const k = byId.get(r.kudos_id); if (k) k.recipient_names.push(r.full_name); });
  }
  const nextBefore = hasMore ? items[items.length - 1].id : null;

  // AJAX "load older" returns just the rows.
  if (req.query.partial === '1') {
    return res.render('kudos-admin/_feed_items', { items, layout: false, nextBefore });
  }

  const values = db.prepare('SELECT id, name, colour FROM company_values WHERE active = 1 ORDER BY sort_order, id').all();
  const totalKudos = db.prepare('SELECT COUNT(*) AS c FROM kudos' + (showHidden ? '' : ' WHERE hidden_at IS NULL')).get().c;
  const last7 = db.prepare("SELECT COUNT(*) AS c FROM kudos WHERE hidden_at IS NULL AND created_at >= datetime('now','-7 days')").get().c;
  res.render('kudos-admin/feed', {
    title: 'Kudos feed', currentPage: 'kudos-feed',
    items, values, valueId, showHidden, nextBefore, totalKudos, last7,
  });
});

// Hide / unhide a kudos straight from the feed (moderation without a report).
router.post('/kudos/:id/hide', requirePermission('hr_employees'), (req, res) => {
  hideKudos({ kudosId: parseInt(req.params.id, 10), userId: req.session.user.id, reason: req.body.reason || 'Hidden by admin' });
  req.flash('success', 'Kudos hidden');
  req.session.save(() => res.redirect(req.get('Referer') || '/kudos-admin/feed'));
});
router.post('/kudos/:id/unhide', requirePermission('hr_employees'), (req, res) => {
  getDb().prepare('UPDATE kudos SET hidden_at = NULL, hidden_by_user_id = NULL, hidden_reason = NULL WHERE id = ?').run(req.params.id);
  req.flash('success', 'Kudos restored');
  req.session.save(() => res.redirect(req.get('Referer') || '/kudos-admin/feed?hidden=1'));
});

// ========== Moderation queue ==========
router.get('/queue', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const reports = db.prepare(`
    SELECT r.*, cm.full_name as reporter_name, k.message as kudos_message, k.id as kudos_id,
      s.full_name as sender_name, k.hidden_at
    FROM kudos_reports r
    JOIN crew_members cm ON cm.id = r.reporter_crew_id
    LEFT JOIN kudos k ON k.id = r.kudos_id
    LEFT JOIN crew_members s ON s.id = k.sender_crew_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at DESC
  `).all();

  // Analytics
  const totalKudos = db.prepare('SELECT COUNT(*) as c FROM kudos WHERE hidden_at IS NULL').get().c;
  const last30 = db.prepare("SELECT COUNT(*) as c FROM kudos WHERE hidden_at IS NULL AND created_at >= datetime('now','-30 days')").get().c;
  const topSenders = db.prepare(`
    SELECT cm.full_name, COUNT(*) as c FROM kudos k JOIN crew_members cm ON cm.id = k.sender_crew_id
    WHERE k.hidden_at IS NULL AND k.created_at >= datetime('now','-30 days')
    GROUP BY cm.id ORDER BY c DESC LIMIT 5
  `).all();
  const topReceivers = db.prepare(`
    SELECT cm.full_name, COUNT(*) as c FROM kudos_recipients kr
    JOIN kudos k ON k.id = kr.kudos_id JOIN crew_members cm ON cm.id = kr.recipient_crew_id
    WHERE k.hidden_at IS NULL AND k.created_at >= datetime('now','-30 days')
    GROUP BY cm.id ORDER BY c DESC LIMIT 5
  `).all();
  const valueDist = db.prepare(`
    SELECT v.name, v.colour, v.points_value, COUNT(*) as c, COUNT(*) * COALESCE(v.points_value, 0) AS points_total FROM kudos k
    LEFT JOIN company_values v ON v.id = k.value_id
    WHERE k.hidden_at IS NULL AND k.created_at >= datetime('now','-30 days') AND v.id IS NOT NULL
    GROUP BY v.id ORDER BY c DESC
  `).all();

  res.render('kudos-admin/queue', {
    title: 'Kudos moderation',
    currentPage: 'kudos-queue',
    reports, totalKudos, last30, topSenders, topReceivers, valueDist,
  });
});

router.post('/queue/:reportId/hide', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM kudos_reports WHERE id = ?').get(req.params.reportId);
  if (report && report.kudos_id) hideKudos({ kudosId: report.kudos_id, userId: req.session.user.id, reason: req.body.reason || 'Admin hid' });
  if (report && report.comment_id) db.prepare("UPDATE kudos_comments SET hidden_at = datetime('now') WHERE id = ?").run(report.comment_id);
  db.prepare("UPDATE kudos_reports SET status = 'actioned' WHERE id = ?").run(req.params.reportId);
  req.flash('success', 'Hidden and report closed');
  req.session.save(() => res.redirect('/kudos-admin/queue'));
});

router.post('/queue/:reportId/dismiss', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  db.prepare("UPDATE kudos_reports SET status = 'dismissed' WHERE id = ?").run(req.params.reportId);
  req.flash('success', 'Report dismissed');
  req.session.save(() => res.redirect('/kudos-admin/queue'));
});

module.exports = router;
