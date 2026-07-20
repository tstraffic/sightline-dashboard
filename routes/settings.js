const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { reloadSettings, CATEGORY_META, getOptions } = require('../middleware/settings');
const { sendEmail, testConnection, isConfigured } = require('../services/email');

// ─── Settings Dashboard ────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const counts = db.prepare(`
    SELECT category, COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active
    FROM app_settings GROUP BY category ORDER BY category
  `).all();

  // Build category list with metadata
  const categories = counts.map(c => ({
    ...c,
    meta: CATEGORY_META[c.category] || { label: c.category, group: 'Other', icon: 'settings' },
  }));

  // Group categories
  const groups = {};
  for (const cat of categories) {
    const group = cat.meta.group;
    if (!groups[group]) groups[group] = [];
    groups[group].push(cat);
  }

  res.render('settings/index', {
    title: 'Settings',
    currentPage: 'settings',
    categories,
    groups,
  });
});

// ─── System Configuration ──────────────────────────────────────────
router.get('/system', (req, res) => {
  const db = getDb();
  const configs = db.prepare('SELECT * FROM system_config ORDER BY id').all();
  res.render('settings/system', {
    title: 'System Configuration',
    currentPage: 'settings',
    configs,
  });
});

router.post('/system', (req, res) => {
  const db = getDb();
  const configs = db.prepare('SELECT * FROM system_config ORDER BY id').all();
  const updateStmt = db.prepare('UPDATE system_config SET config_value = ?, updated_at = CURRENT_TIMESTAMP, updated_by_id = ? WHERE config_key = ?');

  const changes = [];
  for (const config of configs) {
    const newValue = req.body[config.config_key];
    if (newValue !== undefined && newValue !== config.config_value) {
      changes.push({ key: config.config_key, from: config.config_value, to: newValue });
      updateStmt.run(newValue, req.session.user.id, config.config_key);
    }
  }

  if (changes.length > 0) {
    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'system_config',
      entityLabel: 'System Configuration',
      details: changes.map(c => `${c.key}: "${c.from}" → "${c.to}"`).join('; '),
      ip: req.ip,
    });
    reloadSettings();
  }

  req.flash('success', changes.length > 0 ? `Updated ${changes.length} setting(s).` : 'No changes made.');
  req.session.save(() => res.redirect('/settings/system'));
});

// ─── Test Email ───────────────────────────────────────────────────
router.post('/system/test-email', async (req, res) => {
  const toEmail = req.body.test_email || req.session.user.email;
  if (!toEmail) {
    req.flash('error', 'No email address provided. Enter a test email or set one on your user profile.');
    return req.session.save(() => res.redirect('/settings/system'));
  }

  if (!isConfigured()) {
    req.flash('error', 'SMTP is not configured. Add SMTP settings below or set environment variables in Railway.');
    return req.session.save(() => res.redirect('/settings/system'));
  }

  try {
    // First test the connection
    await testConnection();

    // Then send a test email
    const result = await sendEmail(
      toEmail,
      'Atomis — Test Email',
      `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto;">
        <div style="background: #0F1115; padding: 20px 24px; border-radius: 12px 12px 0 0;">
          <h2 style="color: #F5F5F7; margin: 0; font-size: 22px; font-weight: 500; letter-spacing: -0.03em; font-family: Georgia, serif;">atomis</h2>
        </div>
        <div style="border: 1px solid #E5E7EB; border-top: none; padding: 24px; border-radius: 0 0 12px 12px; background: #FAFAFA;">
          <h3 style="color: #111827; margin: 0 0 12px;">Email is working!</h3>
          <p style="color: #6B7280; margin: 0 0 16px;">This is a test email from Atomis. If you received this, your SMTP configuration is correct.</p>
          <p style="color: #9CA3AF; font-size: 12px; margin: 0;">Sent at ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney' })} AEST</p>
        </div>
      </div>`
    );

    if (result) {
      req.flash('success', `Test email sent to ${toEmail} — check your inbox!`);
    } else {
      req.flash('error', 'Email send failed. Check your SMTP credentials and try again.');
    }
  } catch (err) {
    req.flash('error', `SMTP connection failed: ${err.message}`);
  }
  req.session.save(() => res.redirect('/settings/system'));
});

// ─── Category Editor ───────────────────────────────────────────────
router.get('/category/:category', (req, res) => {
  const { category } = req.params;
  const meta = CATEGORY_META[category];
  if (!meta) {
    req.flash('error', 'Unknown settings category.');
    return req.session.save(() => res.redirect('/settings'));
  }

  const db = getDb();
  const items = db.prepare('SELECT * FROM app_settings WHERE category = ? ORDER BY display_order, label').all(category);

  res.render('settings/category', {
    title: `${meta.label} Settings`,
    currentPage: 'settings',
    category,
    meta,
    items,
  });
});

// Add item to category
router.post('/category/:category/add', (req, res) => {
  const { category } = req.params;
  const { key, label, color } = req.body;

  if (!key || !label) {
    req.flash('error', 'Key and label are required.');
    return req.session.save(() => res.redirect(`/settings/category/${category}`));
  }

  const db = getDb();
  const maxOrder = db.prepare('SELECT MAX(display_order) as max FROM app_settings WHERE category = ?').get(category);

  try {
    db.prepare(`
      INSERT INTO app_settings (category, key, label, display_order, is_active, color)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(category, key.toLowerCase().replace(/\s+/g, '_'), label, (maxOrder.max || 0) + 1, color || '');

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'app_setting',
      entityLabel: `${category}.${key}`,
      details: `Added "${label}" to ${category}`,
      ip: req.ip,
    });

    reloadSettings();
    req.flash('success', `Added "${label}" to ${CATEGORY_META[category]?.label || category}.`);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', `Key "${key}" already exists in this category.`);
    } else {
      req.flash('error', 'Failed to add item: ' + err.message);
    }
  }

  req.session.save(() => res.redirect(`/settings/category/${category}`));
});

// Update item
router.post('/category/:category/:id', (req, res) => {
  const { category, id } = req.params;
  const { label, color, is_active } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM app_settings WHERE id = ?').get(id);
  if (!existing) {
    req.flash('error', 'Setting not found.');
    return req.session.save(() => res.redirect(`/settings/category/${category}`));
  }

  db.prepare(`
    UPDATE app_settings SET label = ?, color = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(label, color || '', is_active === 'on' || is_active === '1' ? 1 : 0, id);

  const changes = [];
  if (existing.label !== label) changes.push(`label: "${existing.label}" → "${label}"`);
  if (existing.color !== (color || '')) changes.push(`color: "${existing.color}" → "${color || ''}"`);
  const newActive = is_active === 'on' || is_active === '1' ? 1 : 0;
  if (existing.is_active !== newActive) changes.push(newActive ? 'reactivated' : 'deactivated');

  if (changes.length > 0) {
    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'app_setting',
      entityId: parseInt(id),
      entityLabel: `${category}.${existing.key}`,
      details: changes.join('; '),
      beforeValue: JSON.stringify({ label: existing.label, color: existing.color, is_active: existing.is_active }),
      afterValue: JSON.stringify({ label, color: color || '', is_active: newActive }),
      ip: req.ip,
    });
  }

  reloadSettings();
  req.flash('success', `Updated "${label}".`);
  req.session.save(() => res.redirect(`/settings/category/${category}`));
});

// Delete item (hard delete — only if safe)
router.post('/category/:category/:id/delete', (req, res) => {
  const { category, id } = req.params;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM app_settings WHERE id = ?').get(id);
  if (!existing) {
    req.flash('error', 'Setting not found.');
    return req.session.save(() => res.redirect(`/settings/category/${category}`));
  }

  // Soft-delete (deactivate) instead of hard-deleting to preserve data integrity
  db.prepare('UPDATE app_settings SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

  logActivity({
    user: req.session.user,
    action: 'delete',
    entityType: 'app_setting',
    entityId: parseInt(id),
    entityLabel: `${category}.${existing.key}`,
    details: `Deactivated "${existing.label}" from ${category}`,
    ip: req.ip,
  });

  reloadSettings();
  req.flash('success', `"${existing.label}" has been deactivated.`);
  req.session.save(() => res.redirect(`/settings/category/${category}`));
});

// Reorder items (bulk update display_order)
router.post('/category/:category/reorder', (req, res) => {
  const { category } = req.params;
  const { order } = req.body; // comma-separated IDs in new order
  const db = getDb();

  if (order) {
    const ids = order.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
    const updateStmt = db.prepare('UPDATE app_settings SET display_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND category = ?');

    ids.forEach((id, idx) => {
      updateStmt.run(idx + 1, id, category);
    });

    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'app_setting',
      entityLabel: `${category} (reorder)`,
      details: `Reordered ${ids.length} items`,
      ip: req.ip,
    });

    reloadSettings();
  }

  req.flash('success', 'Order updated.');
  req.session.save(() => res.redirect(`/settings/category/${category}`));
});

module.exports = router;
