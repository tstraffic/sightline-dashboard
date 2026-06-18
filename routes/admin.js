const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { autoAddUserToChannels } = require('../lib/chat');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail, isConfigured } = require('../services/email');
const { adminInviteEmail } = require('../services/emailTemplates');
const { logActivity } = require('../middleware/audit');
const { reloadSettings } = require('../middleware/settings');

// Only admin can access admin panel
router.use(requireRole('admin'));

// ── Global sidebar layout (folders, order, renamed tabs) ──
// Stored once in system_config and applied for everyone (still filtered by each
// user's permissions client-side). Body: { layout: <json string|object> } with
// shape { v, tree:[ {t:'item',key,label?} | {t:'folder',name,collapsed,children:[...]} ] }.
router.post('/sidebar-layout', (req, res) => {
  const db = getDb();
  let parsed;
  try {
    parsed = typeof req.body.layout === 'string' ? JSON.parse(req.body.layout) : req.body.layout;
  } catch (e) { return res.status(400).json({ ok: false, error: 'Invalid JSON.' }); }
  if (!parsed || !Array.isArray(parsed.tree)) return res.status(400).json({ ok: false, error: 'Invalid layout shape.' });
  const json = JSON.stringify(parsed);
  if (json.length > 200000) return res.status(400).json({ ok: false, error: 'Layout too large.' });
  const exists = db.prepare("SELECT id FROM system_config WHERE config_key = 'sidebar_layout'").get();
  if (exists) {
    db.prepare("UPDATE system_config SET config_value = ?, config_type = 'string', updated_at = CURRENT_TIMESTAMP, updated_by_id = ? WHERE config_key = 'sidebar_layout'").run(json, req.session.user.id);
  } else {
    db.prepare("INSERT INTO system_config (config_key, config_value, config_type, description, updated_by_id) VALUES ('sidebar_layout', ?, 'string', 'Custom sidebar folders / order / labels (global)', ?)").run(json, req.session.user.id);
  }
  try { reloadSettings(); } catch (e) { /* cache reload best-effort */ }
  try { logActivity({ user: req.session.user, action: 'update', entityType: 'settings', entityLabel: 'Sidebar layout', ip: req.ip }); } catch (e) {}
  res.json({ ok: true });
});

// Reset to the default (permission-driven) sidebar for everyone.
router.post('/sidebar-layout/reset', (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM system_config WHERE config_key = 'sidebar_layout'").run();
  try { reloadSettings(); } catch (e) {}
  res.json({ ok: true });
});

router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, username, full_name, email, role, active, created_at, CASE WHEN password_hash = \'INVITE_PENDING\' THEN 0 ELSE 1 END as has_password FROM users ORDER BY full_name').all();

  // Stats
  const roleAliases = { management: 'admin', accounts: 'finance' };
  const stats = {
    total: users.length,
    active: users.filter(u => u.active && u.has_password).length,
    pending: users.filter(u => !u.has_password).length,
    inactive: users.filter(u => !u.active && u.has_password).length,
    byRole: {}
  };
  users.forEach(u => {
    const r = roleAliases[u.role] || u.role || 'unknown';
    stats.byRole[r] = (stats.byRole[r] || 0) + 1;
  });

  res.render('admin/users', { title: 'User Management', users, user: req.session.user, stats });
});

router.get('/users/new', (req, res) => {
  res.render('admin/user-form', { title: 'Add User', editUser: null, user: req.session.user });
});

router.post('/users', async (req, res) => {
  const db = getDb();
  const b = req.body;
  const sendInvite = [].concat(b.send_invite).pop() === '1' && b.email;

  try {
    if (sendInvite) {
      if (!isConfigured()) {
        req.flash('error', 'Email invitations require SMTP to be configured. Go to Settings → System Configuration to set up SMTP, or add SMTP environment variables in Railway.');
        return res.redirect('/admin/users/new');
      }
      const result = db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
        b.username, 'INVITE_PENDING', b.full_name, b.email, b.role, 0
      );
      const userId = result.lastInsertRowid;
      const { token } = createInvitation({ type: 'admin_user', targetId: userId, email: b.email, createdById: req.session.user.id });
      const inviteUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/invite/' + token;
      const emailResult = await sendEmail(b.email, 'You\'ve been invited to Atomis', adminInviteEmail(b.full_name, inviteUrl, TOKEN_EXPIRY_HOURS));
      logActivity({ user: req.session.user, action: 'create', entityType: 'user', entityId: userId, entityLabel: b.full_name, details: 'Created user via email invitation', ip: req.ip });
      autoAddUserToChannels(Number(userId), b.role);
      if (emailResult) {
        req.flash('success', `Invitation sent to ${b.email} for ${b.username}.`);
      } else {
        req.flash('success', `User ${b.username} created but email failed to send. Use "Resend Invite" from the user list once SMTP is configured.`);
      }
    } else {
      if (!b.password) {
        req.flash('error', 'Password is required when not sending an invite.');
        return res.redirect('/admin/users/new');
      }
      const hash = bcrypt.hashSync(b.password, 12);
      const directResult = db.prepare('INSERT INTO users (username, password_hash, full_name, email, role, active) VALUES (?, ?, ?, ?, ?, ?)').run(
        b.username, hash, b.full_name, b.email || '', b.role, b.active ? 1 : 0
      );
      autoAddUserToChannels(Number(directResult.lastInsertRowid), b.role);
      req.flash('success', `User ${b.username} created.`);
    }
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', `Username "${b.username}" already exists.`);
    } else {
      req.flash('error', 'Failed to create user: ' + err.message);
    }
  }
  res.redirect('/admin/users');
});

router.get('/users/:id/edit', (req, res) => {
  const db = getDb();
  const editUser = db.prepare('SELECT id, username, full_name, email, role, active FROM users WHERE id = ?').get(req.params.id);
  if (!editUser) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }
  res.render('admin/user-form', { title: 'Edit User', editUser, user: req.session.user });
});

router.post('/users/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  if (b.password) {
    const hash = bcrypt.hashSync(b.password, 12);
    db.prepare('UPDATE users SET full_name=?, email=?, role=?, active=?, password_hash=? WHERE id=?').run(
      b.full_name, b.email || '', b.role, b.active ? 1 : 0, hash, req.params.id
    );
  } else {
    db.prepare('UPDATE users SET full_name=?, email=?, role=?, active=? WHERE id=?').run(
      b.full_name, b.email || '', b.role, b.active ? 1 : 0, req.params.id
    );
  }
  req.flash('success', 'User updated.');
  res.redirect('/admin/users');
});

// DELETE USER
router.post('/users/:id/delete', (req, res) => {
  const db = getDb();
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }

  // Prevent deleting yourself
  if (targetUser.id === req.session.user.id) {
    req.flash('error', 'You cannot delete your own account.');
    return res.redirect('/admin/users');
  }

  try {
    // Dynamically discover every table with a foreign key pointing at users.
    // For NO ACTION / RESTRICT FKs we NULL out the column so the DELETE can
    // proceed; CASCADE / SET NULL columns are handled by SQLite itself.
    // This replaces an old hard-coded list that missed most references —
    // anything outside the list would block the DELETE with an FK error.
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all();
    for (const t of tables) {
      let fks;
      try { fks = db.prepare(`PRAGMA foreign_key_list('${t.name}')`).all(); } catch (e) { continue; }
      for (const fk of fks) {
        if (fk.table !== 'users') continue;
        if (fk.on_delete === 'CASCADE' || fk.on_delete === 'SET NULL') continue; // DB handles it
        try {
          db.prepare(`UPDATE "${t.name}" SET "${fk.from}" = NULL WHERE "${fk.from}" = ?`).run(req.params.id);
        } catch (e) {
          console.warn(`[user-delete] could not null ${t.name}.${fk.from}:`, e.message);
        }
      }
    }

    // Clean up invitations — no FK declared but the rows are orphaned without the user.
    try { db.prepare('DELETE FROM invitations WHERE target_id = ?').run(req.params.id); } catch (e) {}

    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    logActivity({ user: req.session.user, action: 'delete', entityType: 'user', entityId: targetUser.id, entityLabel: targetUser.full_name, details: 'Deleted user account', ip: req.ip });
    req.flash('success', `User ${targetUser.username} deleted.`);
  } catch (err) {
    console.error('[user-delete] failed for id=' + req.params.id + ':', err);
    req.flash('error', `Failed to delete user: ${err.message}`);
  }
  res.redirect('/admin/users');
});

// Reset password
router.post('/users/:id/reset-password', (req, res) => {
  const db = getDb();
  const targetUser = db.prepare('SELECT id, username, full_name FROM users WHERE id = ?').get(req.params.id);
  if (!targetUser) { req.flash('error', 'User not found.'); return res.redirect('/admin/users'); }

  const newPassword = req.body.new_password;
  if (!newPassword || newPassword.length < 6) {
    req.flash('error', 'Password must be at least 6 characters.');
    return res.redirect('/admin/users');
  }

  try {
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
    logActivity({ user: req.session.user, action: 'update', entityType: 'user', entityId: targetUser.id, entityLabel: targetUser.full_name, details: 'Reset password', ip: req.ip });
    req.flash('success', `Password reset for ${targetUser.username}.`);
  } catch (err) {
    req.flash('error', 'Failed to reset password: ' + err.message);
  }
  res.redirect('/admin/users');
});

// Resend invitation email
router.post('/users/:id/resend-invite', async (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u || u.password_hash !== 'INVITE_PENDING' || !u.email) {
    req.flash('error', 'No pending invitation for this user.');
    return res.redirect('/admin/users');
  }
  const { token } = createInvitation({ type: 'admin_user', targetId: u.id, email: u.email, createdById: req.session.user.id });
  const inviteUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/invite/' + token;
  await sendEmail(u.email, 'You\'ve been invited to Atomis', adminInviteEmail(u.full_name, inviteUrl, TOKEN_EXPIRY_HOURS));
  req.flash('success', `Invitation resent to ${u.email}.`);
  res.redirect('/admin/users');
});

module.exports = router;
