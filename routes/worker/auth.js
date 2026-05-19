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

// Per-account PIN lockout.
//
// PINs are 4 digits = 10,000 combinations. The global 10/15-min rate
// limit in server.js is per-IP — useless against a distributed attack
// targeting one Employee ID. After PIN_MAX_ATTEMPTS wrong PINs we lock
// the crew_members row for PIN_LOCK_MINUTES. Counters live on the row
// (pin_failed_attempts, pin_locked_until) so the lock survives restarts
// and is account-scoped rather than IP-scoped.
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

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
  const selectCols = `
    id, full_name, employee_id, role, phone, email, pin_hash, active,
    pin_failed_attempts, pin_locked_until
  `;
  let member = db.prepare(
    `SELECT ${selectCols}
       FROM crew_members
      WHERE LOWER(email) = LOWER(?)
      ${orderBy}
      LIMIT 1`
  ).get(loginId);
  if (!member) {
    member = db.prepare(
      `SELECT ${selectCols}
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

  // Locked? Refuse before doing the bcrypt compare so attackers can't
  // even measure timing differences while waiting out the lock.
  if (member.pin_locked_until) {
    const lockedUntil = new Date(member.pin_locked_until + (member.pin_locked_until.includes('Z') ? '' : 'Z'));
    if (!isNaN(lockedUntil.getTime()) && lockedUntil.getTime() > Date.now()) {
      const minsLeft = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60000));
      return loginError(`Too many wrong PINs. Try again in ${minsLeft} min, or use Forgot PIN.`);
    }
    // Lock has expired — clear it so this attempt counts fresh.
    db.prepare('UPDATE crew_members SET pin_locked_until = NULL, pin_failed_attempts = 0 WHERE id = ?').run(member.id);
    member.pin_failed_attempts = 0;
    member.pin_locked_until = null;
  }

  const pinMatch = bcrypt.compareSync(pin, member.pin_hash);
  if (!pinMatch) {
    const newAttempts = (member.pin_failed_attempts || 0) + 1;
    if (newAttempts >= PIN_MAX_ATTEMPTS) {
      const lockUntilSql = `datetime('now', '+${PIN_LOCK_MINUTES} minutes')`;
      db.prepare(`UPDATE crew_members SET pin_failed_attempts = ?, pin_locked_until = ${lockUntilSql} WHERE id = ?`)
        .run(newAttempts, member.id);
      console.warn('[worker login] account locked after repeated wrong PINs', { loginId, crew_member_id: member.id });
      return loginError(`Too many wrong PINs. Account locked for ${PIN_LOCK_MINUTES} min — use Forgot PIN to unlock immediately.`);
    }
    db.prepare('UPDATE crew_members SET pin_failed_attempts = ? WHERE id = ?').run(newAttempts, member.id);
    const remaining = PIN_MAX_ATTEMPTS - newAttempts;
    return loginError(`Incorrect PIN. ${remaining} attempt${remaining === 1 ? '' : 's'} left before lockout.`);
  }

  // Successful PIN — clear any failed-attempt state on the row.
  db.prepare('UPDATE crew_members SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = ?').run(member.id);

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
    await sendEmail(member.email, 'Reset your Atomis Crew PIN', pinResetEmail(member.full_name, resetUrl, TOKEN_EXPIRY_HOURS));
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
  // Resetting the PIN also clears any active lockout — the user's whole
  // point in coming through this flow is "I'm locked out". If we left the
  // lock in place they'd reset their PIN then still get bounced for 15
  // minutes from /w/login, which makes the email link feel broken.
  db.prepare(`
    UPDATE crew_members
       SET pin_hash = ?, pin_plain = ?, pin_set_at = CURRENT_TIMESTAMP,
           pin_failed_attempts = 0, pin_locked_until = NULL
     WHERE id = ?
  `).run(pinHash, pin, invitation.target_id);
  markTokenUsed(req.params.token);

  req.flash('success', 'Your PIN has been reset. You can now sign in.');
  req.session.save(() => res.redirect('/w/login'));
});

module.exports = router;
