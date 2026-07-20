const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../../db/database');
const { validateToken, markTokenUsed } = require('../../services/invitations');
const { logActivity } = require('../../middleware/audit');

// GET /w/setup/:token — Show PIN setup page
router.get('/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'crew_member');
  if (!invitation) {
    return res.render('worker/setup-pin', {
      layout: false,
      title: 'Invalid Link',
      error: 'This setup link is invalid or has expired. Please contact your supervisor for a new one.',
      token: null,
      fullName: '',
    });
  }

  const db = getDb();
  const member = db.prepare('SELECT full_name FROM crew_members WHERE id = ?').get(invitation.target_id);

  res.render('worker/setup-pin', {
    layout: false,
    title: 'Set Your PIN',
    error: null,
    token: req.params.token,
    fullName: member ? member.full_name : '',
  });
});

// POST /w/setup/:token — Set PIN
router.post('/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'crew_member');
  if (!invitation) {
    req.flash('error', 'This setup link is invalid or has expired.');
    return req.session.save(() => res.redirect('/w/login'));
  }

  const { pin, pin_confirm } = req.body;

  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return req.session.save(() => res.redirect('/w/setup/' + req.params.token));
  }

  if (pin !== pin_confirm) {
    req.flash('error', 'PINs do not match.');
    return req.session.save(() => res.redirect('/w/setup/' + req.params.token));
  }

  const db = getDb();
  const pinHash = bcrypt.hashSync(pin, 12);

  db.prepare(`
    UPDATE crew_members SET pin_hash = ?, pin_plain = ?, pin_set_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(pinHash, pin, invitation.target_id);
  markTokenUsed(req.params.token);

  const member = db.prepare('SELECT full_name FROM crew_members WHERE id = ?').get(invitation.target_id);
  logActivity({
    user: { id: invitation.created_by_id || 0, full_name: 'System' },
    action: 'update',
    entityType: 'crew_member',
    entityId: invitation.target_id,
    entityLabel: member ? member.full_name : 'Unknown',
    details: 'Set worker portal PIN via email invitation',
    ip: req.ip,
  });

  req.flash('success', 'Your PIN has been set! You can now sign in.');
  // Wait for the flash to persist into the session store before the
  // 302 — without this the worker hits /w/login before the success
  // message has been written and the page renders blank.
  req.session.save(() => res.redirect('/w/login'));
});

module.exports = router;
