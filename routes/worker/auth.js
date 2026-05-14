const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../../db/database');
const { createInvitation, validateToken, markTokenUsed, TOKEN_EXPIRY_HOURS } = require('../../services/invitations');
const { sendEmail } = require('../../services/email');
const { pinResetEmail } = require('../../services/emailTemplates');

// GET /w/login — Show worker login form
router.get('/login', (req, res) => {
  if (req.session && req.session.worker) {
    return res.redirect('/w/home');
  }
  res.render('worker/login', {
    layout: false,
    title: 'Sign In',
    flash_error: req.flash('error'),
    flash_success: req.flash('success'),
  });
});

// POST /w/login — Authenticate worker (accepts email OR employee_id)
router.post('/login', (req, res) => {
  const { employee_id, pin } = req.body;
  const loginId = (employee_id || '').trim();

  function loginError(msg) {
    console.log('Worker login failed:', msg, { loginId });
    req.flash('error', msg);
    return res.redirect('/w/login?err=' + encodeURIComponent(msg));
  }

  if (!loginId || !pin) {
    return loginError('Please enter your Email or Employee ID and PIN.');
  }

  const db = getDb();
  // Try email first, then employee_id. If the database ever ended up
  // with two crew_members rows for the same person (e.g. a seeded demo
  // row + a row auto-created by the HR linker), prefer the one that's
  // actually usable: has a PIN set, is active, has the most recent
  // login, then the most-recent row id.
  const orderBy = `
    ORDER BY (pin_hash IS NOT NULL AND pin_hash != '') DESC,
             (active = 1) DESC,
             (last_worker_login IS NOT NULL) DESC,
             last_worker_login DESC,
             id DESC
  `;
  let member = db.prepare(
    `SELECT id, full_name, employee_id, role, phone, email, pin_hash, active
       FROM crew_members
      WHERE LOWER(email) = LOWER(?)
      ${orderBy}
      LIMIT 1`
  ).get(loginId);
  if (!member) {
    member = db.prepare(
      `SELECT id, full_name, employee_id, role, phone, email, pin_hash, active
         FROM crew_members
        WHERE employee_id = ?
        ${orderBy}
        LIMIT 1`
    ).get(loginId);
  }

  if (!member) {
    return loginError('No account found for "' + loginId + '". Check your email or Employee ID.');
  }

  if (!member.active) {
    return loginError('Your account is inactive. Please contact your supervisor.');
  }

  if (!member.pin_hash) {
    return loginError('No PIN has been set for your account. Please contact your supervisor to set one.');
  }

  const pinMatch = bcrypt.compareSync(pin, member.pin_hash);
  if (!pinMatch) {
    return loginError('Incorrect PIN. Please try again.');
  }

  req.session.worker = {
    id: member.id,
    full_name: member.full_name,
    employee_id: member.employee_id,
    role: member.role,
    phone: member.phone,
    email: member.email,
  };

  db.prepare(`
    UPDATE crew_members SET last_worker_login = CURRENT_TIMESTAMP, worker_login_count = COALESCE(worker_login_count, 0) + 1 WHERE id = ?
  `).run(member.id);

  const returnTo = req.session.workerReturnTo || '/w/home';
  delete req.session.workerReturnTo;
  // Wait for the SQLite session store to persist req.session.worker
  // before redirecting. Without this the 302 races the async store
  // write — the browser hits /w/home, requireWorker doesn't see the
  // worker session yet, bounces to /w/login, and the user sees the
  // login form "just refresh". The race is non-deterministic, hence
  // some workers (admin's pre-seeded test account on a fast laptop)
  // happened to win it while phone testers consistently lost.
  req.session.save((err) => {
    if (err) {
      console.error('[worker login] session save failed:', err.message);
      req.flash('error', 'Login succeeded but the session could not be saved. Please try again.');
      return res.redirect('/w/login');
    }
    res.redirect(returnTo);
  });
});

// GET /w/logout — Sign out worker
router.get('/logout', (req, res) => {
  delete req.session.worker;
  delete req.session.workerReturnTo;
  req.flash('success', 'You have been signed out.');
  // Same redirect-before-save race as POST /w/login — flash + cleared
  // session must persist before the browser navigates.
  req.session.save(() => res.redirect('/w/login'));
});

// Forgot PIN
router.get('/forgot-pin', (req, res) => {
  res.render('worker/forgot-pin', {
    layout: false,
    title: 'Forgot PIN',
    flash_error: req.flash('error'),
    flash_success: req.flash('success'),
  });
});

router.post('/forgot-pin', async (req, res) => {
  const { employee_id, email } = req.body;
  const db = getDb();
  const member = db.prepare('SELECT id, full_name, email FROM crew_members WHERE employee_id = ? AND email = ? AND active = 1').get(employee_id, email);

  if (member && member.email) {
    const { token } = createInvitation({ type: 'pin_reset', targetId: member.id, email: member.email, createdById: null });
    const resetUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/w/reset-pin/' + token;
    await sendEmail(member.email, 'Reset your T&S Worker Portal PIN', pinResetEmail(member.full_name, resetUrl, TOKEN_EXPIRY_HOURS));
  }

  req.flash('success', 'If a matching account exists, a reset link has been sent to your email.');
  res.redirect('/w/forgot-pin');
});

// Reset PIN via token
router.get('/reset-pin/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'pin_reset');
  if (!invitation) {
    return res.render('worker/reset-pin', {
      layout: false,
      title: 'Invalid Link',
      error: 'This reset link is invalid or has expired.',
      token: null,
      flash_error: [],
    });
  }
  res.render('worker/reset-pin', {
    layout: false,
    title: 'Reset PIN',
    error: null,
    token: req.params.token,
    flash_error: req.flash('error'),
  });
});

router.post('/reset-pin/:token', (req, res) => {
  const invitation = validateToken(req.params.token, 'pin_reset');
  if (!invitation) {
    req.flash('error', 'This reset link is invalid or has expired.');
    return res.redirect('/w/forgot-pin');
  }

  const { pin, pin_confirm } = req.body;
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect('/w/reset-pin/' + req.params.token);
  }
  if (pin !== pin_confirm) {
    req.flash('error', 'PINs do not match.');
    return res.redirect('/w/reset-pin/' + req.params.token);
  }

  const db = getDb();
  const pinHash = bcrypt.hashSync(pin, 12);
  db.prepare('UPDATE crew_members SET pin_hash = ?, pin_plain = ?, pin_set_at = CURRENT_TIMESTAMP WHERE id = ?').run(pinHash, pin, invitation.target_id);
  markTokenUsed(req.params.token);

  req.flash('success', 'Your PIN has been reset. You can now sign in.');
  req.session.save(() => res.redirect('/w/login'));
});

module.exports = router;
