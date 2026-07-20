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

// Only ever redirect to an internal path — a `next` value must start with a
// single '/' (no '//host' or 'proto:' forms) or it is dropped.
function sanitizeNext(raw) {
  if (typeof raw !== 'string' || raw.length > 500) return null;
  return /^\/(?!\/)/.test(raw) ? raw : null;
}

router.get('/login', (req, res) => {
  const nextPath = sanitizeNext(req.query.next);
  if (req.session.user) return res.redirect(nextPath || landingFor(req.session.user));
  res.render('login', { layout: false, title: 'Login', user: null, nextPath });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  // The form carries `next` as a hidden field so the destination survives
  // even when the session-store write races a redirect.
  const nextPath = sanitizeNext(req.body.next);
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.flash('error', 'Invalid username or password.');
    return req.session.save(() => res.redirect(nextPath ? '/login?next=' + encodeURIComponent(nextPath) : '/login'));
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
    // Keep the destination so finishing the password change resumes the
    // flow (e.g. entering the worker portal via /w/office-login).
    if (nextPath) req.session.returnTo = nextPath;
    req.flash('error', 'You must change your password before continuing. This account is using a default password.');
    return req.session.save(() => res.redirect('/profile'));
  }

  const returnTo = nextPath || req.session.returnTo || landingFor(req.session.user);
  delete req.session.returnTo;
  // Persist the session before the browser follows the redirect — the same
  // store race the worker login guards against.
  req.session.save(() => res.redirect(returnTo));
});

router.get('/logout', (req, res) => {
  // Sign out of the office portal only. A worker session in the same
  // browser (an admin who also uses the crew app) stays signed in — the
  // two portals have separate sign-outs.
  delete req.session.user;
  delete req.session.returnTo;
  delete req.session._mustChangePassword;
  delete req.session.lastPortal;
  req.session.save(() => res.redirect('/login'));
});

// Forgot password
router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', {
    layout: false,
    title: 'Forgot Password',
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
  req.session.save(() => res.redirect('/forgot-password'));
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
    });
  }
  res.render('reset-password', {
    layout: false,
    title: 'Reset Password',
    error: null,
    token: req.params.token,
  });
});

router.post('/reset/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'password_reset');
  if (!invitation) {
    req.flash('error', 'This reset link is invalid or has expired.');
    return req.session.save(() => res.redirect('/forgot-password'));
  }

  const { password, password_confirm } = req.body;
  if (!password || password.length < 8) {
    req.flash('error', 'Password must be at least 8 characters.');
    return req.session.save(() => res.redirect('/reset/' + req.params.token));
  }
  if (password !== password_confirm) {
    req.flash('error', 'Passwords do not match.');
    return req.session.save(() => res.redirect('/reset/' + req.params.token));
  }

  const db = getDb();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, invitation.target_id);
  markTokenUsed(req.params.token);

  req.flash('success', 'Your password has been reset. You can now sign in.');
  req.session.save(() => res.redirect('/login'));
});

module.exports = router;
