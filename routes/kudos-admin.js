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
    flash_success: req.flash('success'),
    flash_error: req.flash('error'),
  });
});

router.post('/values', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { name, colour, icon, description, sort_order, points_value } = req.body;
  if (!name) { req.flash('error', 'Name required'); return res.redirect('/kudos-admin/values'); }
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + Date.now().toString(36).slice(-4);
  const pts = Math.max(0, parseInt(points_value, 10) || 0);
  db.prepare('INSERT INTO company_values (name, slug, colour, icon, description, sort_order, points_value) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, slug, colour || '#2B7FFF', icon || 'star', description || '', parseInt(sort_order, 10) || 0, pts);
  req.flash('success', 'Value added');
  res.redirect('/kudos-admin/values');
});

router.post('/values/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { name, colour, icon, description, sort_order, active, points_value } = req.body;
  const pts = Math.max(0, parseInt(points_value, 10) || 0);
  db.prepare(`UPDATE company_values SET name = ?, colour = ?, icon = ?, description = ?, sort_order = ?, points_value = ?, active = ? WHERE id = ?`)
    .run(name, colour, icon || 'star', description || '', parseInt(sort_order, 10) || 0, pts, active ? 1 : 0, req.params.id);
  req.flash('success', 'Value updated');
  res.redirect('/kudos-admin/values');
});

router.post('/values/:id/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  // Soft delete (deactivate) to preserve foreign keys on existing kudos
  db.prepare('UPDATE company_values SET active = 0 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Value deactivated');
  res.redirect('/kudos-admin/values');
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
    flash_success: req.flash('success'),
  });
});

router.post('/queue/:reportId/hide', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const report = db.prepare('SELECT * FROM kudos_reports WHERE id = ?').get(req.params.reportId);
  if (report && report.kudos_id) hideKudos({ kudosId: report.kudos_id, userId: req.session.user.id, reason: req.body.reason || 'Admin hid' });
  if (report && report.comment_id) db.prepare("UPDATE kudos_comments SET hidden_at = datetime('now') WHERE id = ?").run(report.comment_id);
  db.prepare("UPDATE kudos_reports SET status = 'actioned' WHERE id = ?").run(req.params.reportId);
  req.flash('success', 'Hidden and report closed');
  res.redirect('/kudos-admin/queue');
});

router.post('/queue/:reportId/dismiss', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  db.prepare("UPDATE kudos_reports SET status = 'dismissed' WHERE id = ?").run(req.params.reportId);
  req.flash('success', 'Report dismissed');
  res.redirect('/kudos-admin/queue');
});

module.exports = router;
