const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { createInvitation, validateToken, markTokenUsed, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { passwordResetEmail } = require('../services/emailTemplates');

function landingFor(user) {
  return user && user.role === 'marketing' ? '/marketing' : '/dashboard';
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(landingFor(req.session.user));
  res.render('login', { layout: false, title: 'Login', user: null, flash_error: req.flash('error') });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'Invalid username or password.');
    return res.redirect('/login');
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    email: user.email,
    role: user.role
  };

  // Force password change for accounts with default/seed credentials
  if (user.must_change_password) {
    req.flash('error', 'You must change your password before continuing. This account is using a default password.');
    return res.redirect('/profile');
  }

  const returnTo = req.session.returnTo || landingFor(req.session.user);
  delete req.session.returnTo;
  res.redirect(returnTo);
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Forgot password
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', {
    layout: false,
    title: 'Forgot Password',
    flash_error: req.flash('error'),
    flash_success: req.flash('success'),
  });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT id, full_name, email FROM users WHERE email = ? AND active = 1').get(email);

  if (user && user.email) {
    const { token } = createInvitation({ type: 'password_reset', targetId: user.id, email: user.email, createdById: null });
    const resetUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/reset/' + token;
    await sendEmail(user.email, 'Reset your Atomis password', passwordResetEmail(user.full_name, resetUrl, TOKEN_EXPIRY_HOURS));
  }

  req.flash('success', 'If an account exists with that email, a reset link has been sent.');
  res.redirect('/forgot-password');
});

// Reset password via token
router.get('/reset/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'password_reset');
  if (!invitation) {
    return res.render('reset-password', {
      layout: false,
      title: 'Invalid Link',
      error: 'This reset link is invalid or has expired.',
      token: null,
      flash_error: [],
    });
  }
  res.render('reset-password', {
    layout: false,
    title: 'Reset Password',
    error: null,
    token: req.params.token,
    flash_error: req.flash('error'),
  });
});

router.post('/reset/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'password_reset');
  if (!invitation) {
    req.flash('error', 'This reset link is invalid or has expired.');
    return res.redirect('/forgot-password');
  }

  const { password, password_confirm } = req.body;
  if (!password || password.length < 8) {
    req.flash('error', 'Password must be at least 8 characters.');
    return res.redirect('/reset/' + req.params.token);
  }
  if (password !== password_confirm) {
    req.flash('error', 'Passwords do not match.');
    return res.redirect('/reset/' + req.params.token);
  }

  const db = getDb();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, invitation.target_id);
  markTokenUsed(req.params.token);

  req.flash('success', 'Your password has been reset. You can now sign in.');
  res.redirect('/login');
});

module.exports = router;
