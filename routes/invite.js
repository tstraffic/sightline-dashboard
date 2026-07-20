const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { validateToken, markTokenUsed } = require('../services/invitations');
const { logActivity } = require('../middleware/audit');

// GET /invite/:token — Show password setup page
router.get('/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'admin_user');
  if (!invitation) {
    return res.render('invite/setup-password', {
      layout: false,
      title: 'Invalid Link',
      error: 'This invitation link is invalid or has expired. Please contact your administrator for a new one.',
      token: null,
    });
  }

  const db = getDb();
  const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(invitation.target_id);

  res.render('invite/setup-password', {
    layout: false,
    title: 'Set Your Password',
    error: null,
    token: req.params.token,
    fullName: user ? user.full_name : '',
  });
});

// POST /invite/:token — Set password and activate account
router.post('/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'admin_user');
  if (!invitation) {
    req.flash('error', 'This invitation link is invalid or has expired.');
    return req.session.save(() => res.redirect('/login'));
  }

  const { password, password_confirm } = req.body;

  if (!password || password.length < 8) {
    req.flash('error', 'Password must be at least 8 characters.');
    return req.session.save(() => res.redirect('/invite/' + req.params.token));
  }

  if (password !== password_confirm) {
    req.flash('error', 'Passwords do not match.');
    return req.session.save(() => res.redirect('/invite/' + req.params.token));
  }

  const db = getDb();
  const hash = bcrypt.hashSync(password, 12);

  db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?').run(hash, invitation.target_id);
  markTokenUsed(req.params.token);

  const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(invitation.target_id);
  logActivity({
    user: { id: invitation.target_id, full_name: user ? user.full_name : 'Unknown' },
    action: 'update',
    entityType: 'user',
    entityId: invitation.target_id,
    entityLabel: user ? user.full_name : 'Unknown',
    details: 'Set password via email invitation',
    ip: req.ip,
  });

  req.flash('success', 'Your password has been set. You can now sign in.');
  req.session.save(() => res.redirect('/login'));
});

module.exports = router;
