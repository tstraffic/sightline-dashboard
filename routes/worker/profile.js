const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { getDb } = require('../../db/database');
const { logActivity } = require('../../middleware/audit');
const { getWorkerNotificationPrefs, setWorkerNotificationPref } = require('../../services/pushNotification');

// Notification categories shown on /w/profile/notifications. Each one
// corresponds to a `category` string the push senders pass. Default-on
// when no row exists in worker_notification_prefs.
const NOTIFICATION_CATEGORIES = [
  { key: 'shift_reminder', label: 'Shift reminders', sub: 'Day before each shift starts' },
  { key: 'bookings', label: 'Shift updates', sub: 'When a shift is assigned, moved, cancelled, or its notes change' },
  { key: 'announcement', label: 'Announcements', sub: 'Company-wide messages from the office' },
  { key: 'swms_update', label: 'New SWMS', sub: 'SWMS that need your acknowledgement' },
  { key: 'sop_update', label: 'New SOP', sub: 'SOPs that need your acknowledgement' },
  { key: 'safety_update', label: 'Safety updates', sub: 'Bulletins, alerts, policy changes' },
  { key: 'toolbox', label: 'Toolbox talks', sub: 'New toolbox sessions posted' },
  { key: 'quiz', label: 'Safety quizzes', sub: 'When a new quiz is published' },
  { key: 'kudos', label: 'Kudos', sub: 'When a workmate sends you kudos' },
  { key: 'comment_response', label: 'Office responses', sub: 'Replies to your safety comments' },
  { key: 'cert_expiry', label: 'Certificate expiry', sub: '30 / 14 / 7 days before tickets lapse' },
  { key: 'birthday', label: 'Birthday wishes', sub: 'A happy-birthday ping on your day' },
];

const PHOTO_BASE = path.join(__dirname, '..', '..', 'data', 'uploads', 'hr');

// --- Multer setup: keep photo in /uploads/hr/emp_{id}/photo/{ts-name}.ext, 2MB cap ---
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const empId = req.session.worker ? req.session.worker.id : 'unknown';
    const dir = path.join(PHOTO_BASE, `emp_${empId}`, 'photo');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '.jpg') || '.jpg').toLowerCase();
    cb(null, `profile_${Date.now()}${ext}`);
  }
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|jpg|png|webp|heic)$/i.test(file.mimetype);
    if (!ok) return cb(new Error('Only JPEG, PNG, WEBP or HEIC images are allowed'));
    cb(null, true);
  }
});

// --- Validation helpers ---
const AU_PHONE_RE = /^(?:\+?61\s?)?(?:0?4\d{2}\s?\d{3}\s?\d{3}|0?[237]\s?\d{4}\s?\d{4})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const POSTCODE_RE = /^\d{4}$/;
const PIN_RE = /^\d{4,6}$/;
const BAD_PIN_SEQ = new Set(['0000','1111','2222','3333','4444','5555','6666','7777','8888','9999','1234','12345','123456','4321','54321','654321','0123','01234','012345']);

function validateProfile(body) {
  const errors = {};
  if (body.phone && !AU_PHONE_RE.test(String(body.phone).trim())) errors.phone = 'Enter a valid Australian phone number.';
  if (body.email && !EMAIL_RE.test(String(body.email).trim())) errors.email = 'Enter a valid email address.';
  if (body.postcode && !POSTCODE_RE.test(String(body.postcode).trim())) errors.postcode = 'Postcode must be 4 digits.';
  return errors;
}

function isSequentialPin(pin) {
  if (BAD_PIN_SEQ.has(pin)) return true;
  // Reject strict ascending/descending sequences
  let asc = true, desc = true;
  for (let i = 1; i < pin.length; i++) {
    if (pin.charCodeAt(i) !== pin.charCodeAt(i-1) + 1) asc = false;
    if (pin.charCodeAt(i) !== pin.charCodeAt(i-1) - 1) desc = false;
  }
  return asc || desc;
}

// Helper: load linked employee + crew_member for current worker
function loadSelf(worker) {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);
  let employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  // Fallback: lookup by employee_code matching crew_members.employee_id
  if (!employee && member) {
    employee = db.prepare('SELECT * FROM employees WHERE employee_code = ?').get(member.employee_id);
  }
  const contacts = employee
    ? db.prepare('SELECT * FROM emergency_contacts WHERE employee_id = ? ORDER BY is_primary DESC, id ASC').all(employee.id)
    : [];
  return { member, employee, contacts };
}

// Pseudo-user for audit log (workers aren't in users table)
function workerForAudit(worker) {
  return { id: null, full_name: `Worker: ${worker.full_name} (${worker.employee_id})` };
}

function wantsJson(req) {
  return req.xhr || (req.headers.accept || '').includes('application/json');
}

// ============================================
// GET /w/profile — View + edit screen
// ============================================
router.get('/profile', (req, res) => {
  const { member, employee, contacts } = loadSelf(req.session.worker);
  let kudosSummary = null;
  try {
    const { getProfileSummary } = require('../../services/kudos');
    kudosSummary = getProfileSummary({ crewId: req.session.worker.id });
  } catch (e) { /* service may not be loaded — view has a null-guard */ }
  res.render('worker/profile', {
    title: 'My Profile',
    currentPage: 'more',
    member,
    employee,
    contacts,
    kudosSummary,
  });
});

// ============================================
// POST /w/profile — Update editable fields
// ============================================
router.post('/profile', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { phone, email, address_line1, address_line2, suburb, state, postcode } = req.body;

  const errors = validateProfile({ phone, email, postcode });
  if (Object.keys(errors).length > 0) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, errors });
    req.flash('error', Object.values(errors).join(' '));
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const { member, employee } = loadSelf(worker);

  // Snapshot before values for audit
  const before = employee ? {
    phone: employee.phone, email: employee.email,
    address_line1: employee.address_line1, address_line2: employee.address_line2,
    suburb: employee.suburb, state: employee.state, postcode: employee.postcode,
  } : { phone: member.phone, email: member.email };

  // Update employees (preferred source of truth if linked)
  if (employee) {
    db.prepare(`
      UPDATE employees
      SET phone = ?, email = ?, address_line1 = ?, address_line2 = ?, suburb = ?, state = ?, postcode = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(phone || '', email || '', address_line1 || '', address_line2 || '', suburb || '', state || '', postcode || '', employee.id);
  }
  // Always mirror phone/email on crew_members (session auth source)
  db.prepare('UPDATE crew_members SET phone = ?, email = ? WHERE id = ?').run(phone || null, email || null, worker.id);
  req.session.worker.phone = phone || null;
  req.session.worker.email = email || null;

  logActivity({
    user: workerForAudit(worker),
    action: 'update', entityType: 'profile',
    entityId: employee ? employee.id : worker.id, entityLabel: worker.full_name,
    details: 'Worker updated profile contact/address',
    beforeValue: JSON.stringify(before),
    afterValue: JSON.stringify({ phone, email, address_line1, address_line2, suburb, state, postcode }),
    ip: req.ip || req.connection.remoteAddress,
  });

  if (wantsJson(req)) return res.json({ ok: true });
  req.flash('success', 'Profile updated.');
  req.session.save(() => res.redirect('/w/profile'));
});

// ============================================
// POST /w/profile/photo — Upload profile photo
// ============================================
router.post('/profile/photo', (req, res) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (err) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: err.message });
      req.flash('error', err.message);
      return req.session.save(() => res.redirect('/w/profile'));
    }
    if (!req.file) {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'No file uploaded' });
      req.flash('error', 'No file uploaded.');
      return req.session.save(() => res.redirect('/w/profile'));
    }

    const db = getDb();
    const worker = req.session.worker;
    const { employee } = loadSelf(worker);
    const publicUrl = `/data/uploads/hr/emp_${worker.id}/photo/${req.file.filename}`;

    if (employee) {
      // Remove old file if it exists (strip leading /data prefix when mapping to disk)
      if (employee.profile_photo_url) {
        const rel = employee.profile_photo_url.replace(/^\/data\//, '').replace(/^\//, '');
        const oldPath = path.join(__dirname, '..', '..', rel);
        try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (e) { /* ignore */ }
      }
      db.prepare("UPDATE employees SET profile_photo_url = ?, updated_at = datetime('now') WHERE id = ?").run(publicUrl, employee.id);
    }

    logActivity({
      user: workerForAudit(worker),
      action: 'upload', entityType: 'profile_photo',
      entityId: employee ? employee.id : worker.id, entityLabel: worker.full_name,
      details: `Uploaded profile photo: ${req.file.filename} (${req.file.size} bytes)`,
      afterValue: publicUrl,
      ip: req.ip || req.connection.remoteAddress,
    });

    if (wantsJson(req)) return res.json({ ok: true, url: publicUrl });
    req.flash('success', 'Photo updated.');
    req.session.save(() => res.redirect('/w/profile'));
  });
});

// ============================================
// POST /w/profile/pin — Change PIN
// ============================================
router.post('/profile/pin', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { current_pin, new_pin, confirm_pin } = req.body;

  if (!current_pin || !new_pin || !confirm_pin) {
    req.flash('error', 'All PIN fields are required.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (new_pin !== confirm_pin) {
    req.flash('error', 'New PINs do not match.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (!PIN_RE.test(new_pin)) {
    req.flash('error', 'PIN must be 4–6 digits.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (isSequentialPin(new_pin)) {
    req.flash('error', 'PIN cannot be sequential or a repeating pattern (e.g. 1234, 0000).');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const member = db.prepare('SELECT pin_hash FROM crew_members WHERE id = ?').get(worker.id);
  if (!member || !member.pin_hash || !bcrypt.compareSync(current_pin, member.pin_hash)) {
    req.flash('error', 'Current PIN is incorrect.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const newHash = bcrypt.hashSync(new_pin, 12);
  db.prepare("UPDATE crew_members SET pin_hash = ?, pin_set_at = datetime('now') WHERE id = ?").run(newHash, worker.id);

  logActivity({
    user: workerForAudit(worker),
    action: 'update', entityType: 'profile_pin',
    entityId: worker.id, entityLabel: worker.full_name,
    details: 'Worker changed PIN',
    ip: req.ip || req.connection.remoteAddress,
  });

  req.flash('success', 'PIN changed successfully.');
  req.session.save(() => res.redirect('/w/profile'));
});

// ============================================
// POST /w/profile/contacts — Create emergency contact
// ============================================
router.post('/profile/contacts', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { employee } = loadSelf(worker);
  if (!employee) {
    req.flash('error', 'Profile not linked to an employee record. Contact your supervisor.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const name = (req.body.name || '').trim();
  const relationship = (req.body.relationship || '').trim();
  const phone = (req.body.phone || '').trim();
  const alt_phone = (req.body.alt_phone || '').trim();
  const is_primary = req.body.is_primary ? 1 : 0;

  if (!name || !phone) {
    req.flash('error', 'Name and phone are required for emergency contacts.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (!AU_PHONE_RE.test(phone)) {
    req.flash('error', 'Primary contact phone must be a valid Australian number.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (alt_phone && !AU_PHONE_RE.test(alt_phone)) {
    req.flash('error', 'Alternate phone must be a valid Australian number.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const tx = db.transaction(() => {
    // If marking as primary, clear any existing primary flag
    if (is_primary) db.prepare('UPDATE emergency_contacts SET is_primary = 0 WHERE employee_id = ?').run(employee.id);
    // If there are no contacts yet, force primary = 1
    const count = db.prepare('SELECT COUNT(*) as c FROM emergency_contacts WHERE employee_id = ?').get(employee.id).c;
    const finalPrimary = (count === 0) ? 1 : is_primary;
    const result = db.prepare(`
      INSERT INTO emergency_contacts (employee_id, name, relationship, phone, alt_phone, is_primary)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(employee.id, name, relationship, phone, alt_phone, finalPrimary);
    return result.lastInsertRowid;
  });
  const newId = tx();

  logActivity({
    user: workerForAudit(worker),
    action: 'create', entityType: 'emergency_contact',
    entityId: newId, entityLabel: `${name} (${relationship})`,
    details: `Worker added emergency contact`,
    afterValue: JSON.stringify({ name, relationship, phone, alt_phone, is_primary }),
    ip: req.ip || req.connection.remoteAddress,
  });

  req.flash('success', 'Emergency contact added.');
  req.session.save(() => res.redirect('/w/profile'));
});

// ============================================
// POST /w/profile/contacts/:id — Update emergency contact
// ============================================
router.post('/profile/contacts/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { employee } = loadSelf(worker);
  if (!employee) {
    req.flash('error', 'Profile not linked.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const contactId = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM emergency_contacts WHERE id = ? AND employee_id = ?').get(contactId, employee.id);
  if (!existing) {
    req.flash('error', 'Contact not found.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const name = (req.body.name || '').trim();
  const relationship = (req.body.relationship || '').trim();
  const phone = (req.body.phone || '').trim();
  const alt_phone = (req.body.alt_phone || '').trim();
  const is_primary = req.body.is_primary ? 1 : 0;

  if (!name || !phone) {
    req.flash('error', 'Name and phone are required.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (!AU_PHONE_RE.test(phone)) {
    req.flash('error', 'Primary contact phone must be a valid Australian number.');
    return req.session.save(() => res.redirect('/w/profile'));
  }
  if (alt_phone && !AU_PHONE_RE.test(alt_phone)) {
    req.flash('error', 'Alternate phone must be a valid Australian number.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const tx = db.transaction(() => {
    if (is_primary) db.prepare('UPDATE emergency_contacts SET is_primary = 0 WHERE employee_id = ? AND id != ?').run(employee.id, contactId);
    db.prepare(`
      UPDATE emergency_contacts
      SET name = ?, relationship = ?, phone = ?, alt_phone = ?, is_primary = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(name, relationship, phone, alt_phone, is_primary, contactId);

    // Ensure at least one primary exists
    const stillPrimary = db.prepare('SELECT COUNT(*) as c FROM emergency_contacts WHERE employee_id = ? AND is_primary = 1').get(employee.id).c;
    if (stillPrimary === 0) {
      db.prepare('UPDATE emergency_contacts SET is_primary = 1 WHERE id = ?').run(contactId);
    }
  });
  tx();

  logActivity({
    user: workerForAudit(worker),
    action: 'update', entityType: 'emergency_contact',
    entityId: contactId, entityLabel: name,
    details: 'Worker updated emergency contact',
    beforeValue: JSON.stringify(existing),
    afterValue: JSON.stringify({ name, relationship, phone, alt_phone, is_primary }),
    ip: req.ip || req.connection.remoteAddress,
  });

  req.flash('success', 'Emergency contact updated.');
  req.session.save(() => res.redirect('/w/profile'));
});

// ============================================
// POST /w/profile/contacts/:id/delete — Remove emergency contact
// ============================================
router.post('/profile/contacts/:id/delete', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { employee } = loadSelf(worker);
  if (!employee) {
    req.flash('error', 'Profile not linked.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const contactId = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM emergency_contacts WHERE id = ? AND employee_id = ?').get(contactId, employee.id);
  if (!existing) {
    req.flash('error', 'Contact not found.');
    return req.session.save(() => res.redirect('/w/profile'));
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM emergency_contacts WHERE id = ?').run(contactId);
    // If we just removed the primary, promote the first remaining contact
    if (existing.is_primary) {
      const next = db.prepare('SELECT id FROM emergency_contacts WHERE employee_id = ? ORDER BY id ASC LIMIT 1').get(employee.id);
      if (next) db.prepare('UPDATE emergency_contacts SET is_primary = 1 WHERE id = ?').run(next.id);
    }
  });
  tx();

  logActivity({
    user: workerForAudit(worker),
    action: 'delete', entityType: 'emergency_contact',
    entityId: contactId, entityLabel: existing.name,
    details: 'Worker removed emergency contact',
    beforeValue: JSON.stringify(existing),
    ip: req.ip || req.connection.remoteAddress,
  });

  req.flash('success', 'Emergency contact removed.');
  req.session.save(() => res.redirect('/w/profile'));
});

// GET /w/profile/notifications — per-category opt-in/out for worker push.
router.get('/profile/notifications', (req, res) => {
  const workerId = req.session.worker.id;
  const prefsMap = getWorkerNotificationPrefs(workerId);
  // Build a categories[] with enabled (default-on if not set).
  const categories = NOTIFICATION_CATEGORIES.map(c => ({
    key: c.key, label: c.label, sub: c.sub,
    enabled: prefsMap[c.key + ':push'] === undefined ? true : prefsMap[c.key + ':push'],
  }));
  // How many devices this worker has subscribed — drives the status panel at
  // the top of the page so they know whether the push pipeline is actually
  // alive end-to-end before the per-category toggles matter.
  let subscribedDevices = 0;
  try {
    const r = require('../../db/database').getDb()
      .prepare('SELECT COUNT(*) AS c FROM worker_push_subscriptions WHERE crew_member_id = ?')
      .get(workerId);
    subscribedDevices = (r && r.c) || 0;
  } catch (e) { /* table may not exist on a fresh install */ }
  res.render('worker/profile-notifications', {
    title: 'Notification settings',
    currentPage: 'more',
    categories,
    subscribedDevices,
  });
});

// POST /w/profile/notifications — save toggles. Form submits the list of
// currently-enabled categories; anything not in the list is turned off.
router.post('/profile/notifications', (req, res) => {
  const workerId = req.session.worker.id;
  const enabledSet = new Set(
    [].concat(req.body.enabled || []).map(String)
  );
  for (const c of NOTIFICATION_CATEGORIES) {
    setWorkerNotificationPref(workerId, c.key, 'push', enabledSet.has(c.key));
  }
  req.flash('success', 'Notification settings saved.');
  req.session.save(() => res.redirect('/w/profile/notifications'));
});

module.exports = router;
