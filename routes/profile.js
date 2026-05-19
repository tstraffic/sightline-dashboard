const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail, isConfigured: emailConfigured } = require('../services/email');
const { passwordResetEmail } = require('../services/emailTemplates');

// GET /profile — show profile page
router.get('/', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, username, full_name, email, role, email_notifications_enabled, notification_frequency, created_at FROM users WHERE id = ?').get(req.session.user.id);

  if (!user) {
    req.flash('error', 'User not found.');
    return res.redirect('/dashboard');
  }

  res.render('profile', {
    title: 'My Profile',
    profile: user,
    emailEnabled: emailConfigured(),
    flash_success: req.flash('success'),
    flash_error: req.flash('error'),
  });
});

// POST /profile — update basic info
router.post('/', (req, res) => {
  const db = getDb();
  const { full_name, email, email_notifications_enabled, notification_frequency } = req.body;

  if (!full_name || full_name.trim().length < 2) {
    req.flash('error', 'Full name is required (at least 2 characters).');
    return res.redirect('/profile');
  }

  const emailVal = (email || '').trim();

  // Check email uniqueness (if provided)
  if (emailVal) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(emailVal, req.session.user.id);
    if (existing) {
      req.flash('error', 'That email address is already in use by another account.');
      return res.redirect('/profile');
    }
  }

  db.prepare(`
    UPDATE users SET full_name = ?, email = ?, email_notifications_enabled = ?, notification_frequency = ?
    WHERE id = ?
  `).run(
    full_name.trim(),
    emailVal || null,
    email_notifications_enabled === 'on' ? 1 : 0,
    notification_frequency || 'immediate',
    req.session.user.id
  );

  // Update session so header reflects changes immediately
  req.session.user.full_name = full_name.trim();
  req.session.user.email = emailVal || null;

  req.flash('success', 'Profile updated successfully.');
  res.redirect('/profile');
});

// POST /profile/change-password — change password directly (must know current)
router.post('/change-password', (req, res) => {
  const db = getDb();
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password) {
    req.flash('error', 'All password fields are required.');
    return res.redirect('/profile');
  }

  if (new_password.length < 8) {
    req.flash('error', 'New password must be at least 8 characters.');
    return res.redirect('/profile');
  }

  if (new_password !== confirm_password) {
    req.flash('error', 'New passwords do not match.');
    return res.redirect('/profile');
  }

  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password_hash)) {
    req.flash('error', 'Current password is incorrect.');
    return res.redirect('/profile');
  }

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, req.session.user.id);

  // Clear the forced password change flag in session
  req.session._mustChangePassword = false;

  req.flash('success', 'Password changed successfully.');
  res.redirect('/profile');
});

// POST /profile/send-reset-email — send password reset link to own email
router.post('/send-reset-email', async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(req.session.user.id);

  if (!user || !user.email) {
    req.flash('error', 'You need an email address on your profile to use email reset.');
    return res.redirect('/profile');
  }

  try {
    const { token } = createInvitation({ type: 'password_reset', targetId: user.id, email: user.email, createdById: user.id });
    const resetUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/reset/' + token;
    await sendEmail(user.email, 'Reset your Atomis password', passwordResetEmail(user.full_name, resetUrl, TOKEN_EXPIRY_HOURS));
    req.flash('success', 'Password reset link sent to ' + user.email + '. Check your inbox.');
  } catch (err) {
    console.error('[Profile] Reset email error:', err.message);
    req.flash('error', 'Failed to send reset email. Please try again later.');
  }

  res.redirect('/profile');
});

// POST /profile/dismiss-onboarding
router.post('/dismiss-onboarding', (req, res) => {
  const db = getDb();
  try {
    const current = JSON.parse(db.prepare('SELECT preferences FROM users WHERE id = ?').get(req.session.user.id)?.preferences || '{}');
    current.onboarding_dismissed = true;
    db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(current), req.session.user.id);
  } catch (e) { /* ignore */ }
  res.json({ success: true });
});

module.exports = router;
