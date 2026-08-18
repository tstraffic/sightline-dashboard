// Time & WIP (brief §5.9, §5.15) — per-USER time entries against projects
// with the brief's 10 activity codes. Never the legacy crew timesheets.
// Every write re-syncs jobs.actual_hours (lib/wip.js) so budget-vs-actual
// is always current. charge/cost rates are snapshotted at insert; cost
// figures are only shown to canViewInternalCost (admin/finance).
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { canViewInternalCost } = require('../middleware/auth');
const { getConfig } = require('../middleware/settings');
const { syncJobActualHours, getJobWip } = require('../lib/wip');
const { sydneyToday, sydneyDow } = require('../lib/sydney');

function isAdmin(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return ['admin', 'management'].includes(role);
}

// Pure calendar maths on YYYY-MM-DD strings (UTC parse keeps it date-only).
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Monday of the week containing `ymd` (Sydney weeks run Mon–Sun, §5.9).
function mondayOf(ymd) {
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay(); // 0=Sun
  return addDays(ymd, -((dow + 6) % 7));
}

function activityCodes(db) {
  return db.prepare(`
    SELECT key, label FROM app_settings
    WHERE category = 'time_activity_codes' AND is_active = 1
    ORDER BY display_order
  `).all();
}

// GET / — my-week view (?week=YYYY-MM-DD any date in the week), or
// ?job_id= for the project WIP view.
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const user = req.session.user;
    const canSeeCost = canViewInternalCost(user);
    const codes = activityCodes(db);
    const codeLabels = Object.fromEntries(codes.map(c => [c.key, c.label]));

    // ---- Project view ----
    if (req.query.job_id) {
      const job = db.prepare('SELECT id, job_number, project_name, job_name, estimated_hours FROM jobs WHERE id = ?').get(req.query.job_id);
      if (!job) {
        req.flash('error', 'Project not found.');
        return req.session.save(() => res.redirect('/time'));
      }
      const entries = db.prepare(`
        SELECT te.*, u.full_name AS user_name, sp.package_ref
        FROM time_entries te
        JOIN users u ON te.user_id = u.id
        LEFT JOIN service_packages sp ON te.service_package_id = sp.id
        WHERE te.job_id = ?
        ORDER BY te.entry_date DESC, te.id DESC
      `).all(job.id);
      const wip = getJobWip(db, job.id, { canSeeCost });
      const jobPackages = db.prepare('SELECT id, package_ref FROM service_packages WHERE job_id = ? ORDER BY package_ref').all(job.id);
      return res.render('time/index', {
        title: 'Time — ' + job.job_number,
        currentPage: 'time',
        mode: 'job',
        job, entries, wip, codes, codeLabels,
        canSeeCost,
        isAdmin: isAdmin(user),
        weekStart: null, weekDays: [], jobs: [], packages: jobPackages, today: sydneyToday(),
      });
    }

    // ---- My-week view ----
    const today = sydneyToday();
    const anchor = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? req.query.week : today;
    const weekStart = mondayOf(anchor);
    const weekEnd = addDays(weekStart, 6);
    const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

    // Admin/management can review someone else's week.
    let targetUserId = user.id;
    if (req.query.user_id && isAdmin(user)) targetUserId = parseInt(req.query.user_id, 10) || user.id;

    const entries = db.prepare(`
      SELECT te.*, j.job_number, j.project_name, j.job_name, sp.package_ref
      FROM time_entries te
      JOIN jobs j ON te.job_id = j.id
      LEFT JOIN service_packages sp ON te.service_package_id = sp.id
      WHERE te.user_id = ? AND te.entry_date BETWEEN ? AND ?
      ORDER BY te.entry_date, te.id
    `).all(targetUserId, weekStart, weekEnd);

    const byDay = {};
    weekDays.forEach(d => { byDay[d] = []; });
    entries.forEach(e => { (byDay[e.entry_date] = byDay[e.entry_date] || []).push(e); });
    const weekTotal = entries.reduce((s, e) => s + (e.hours || 0), 0);
    const billableTotal = entries.reduce((s, e) => s + (e.billable ? (e.hours || 0) : 0), 0);

    const jobs = db.prepare(`
      SELECT id, job_number, project_name, job_name FROM jobs
      WHERE job_number LIKE 'ST-%' AND status NOT IN ('closed','cancelled')
      ORDER BY job_number DESC
    `).all();
    const packages = db.prepare(`
      SELECT sp.id, sp.package_ref, sp.job_id FROM service_packages sp
      JOIN jobs j ON sp.job_id = j.id
      WHERE j.status NOT IN ('closed','cancelled')
      ORDER BY sp.package_ref
    `).all();
    const users = isAdmin(user)
      ? db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all()
      : [];

    res.render('time/index', {
      title: 'My Time',
      currentPage: 'time',
      mode: 'week',
      weekStart, weekEnd, weekDays, byDay, weekTotal, billableTotal,
      prevWeek: addDays(weekStart, -7), nextWeek: addDays(weekStart, 7),
      targetUserId, users,
      jobs, packages, codes, codeLabels,
      canSeeCost,
      isAdmin: isAdmin(user),
      job: null, entries, wip: null, today,
    });
  } catch (err) { next(err); }
});

// Create entry — always snapshots both rates so history never drifts.
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const back = b.return_to || '/time' + (b.week ? '?week=' + b.week : '');
  try {
    const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(b.job_id);
    if (!job) {
      req.flash('error', 'Pick the project the time was spent on.');
      return req.session.save(() => res.redirect(back));
    }
    const hours = parseFloat(b.hours);
    if (!(hours > 0) || hours > 24) {
      req.flash('error', 'Hours must be between 0 and 24.');
      return req.session.save(() => res.redirect(back));
    }
    const codes = activityCodes(db).map(c => c.key);
    const activity = codes.includes(b.activity_code) ? b.activity_code : (codes[0] || '01');
    const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(b.entry_date || '') ? b.entry_date : sydneyToday();
    // Rate snapshots at insert (finance can adjust per-entry later).
    const chargeRate = parseFloat(getConfig('default_charge_rate', 180)) || 180;
    const costRate = parseFloat(getConfig('internal_hourly_rate', 40)) || 40;
    // Entries are logged for yourself; admin/management can log for others.
    let userId = req.session.user.id;
    if (b.user_id && isAdmin(req.session.user)) userId = parseInt(b.user_id, 10) || userId;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO time_entries (user_id, job_id, service_package_id, entry_date, activity_code, hours, billable, description, charge_rate, cost_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, job.id, b.service_package_id || null, entryDate, activity, hours,
        b.billable === '0' ? 0 : 1, b.description || '', chargeRate, costRate
      );
      syncJobActualHours(db, job.id);
    })();
    logActivity({
      user: req.session.user, action: 'create', entityType: 'time_entry',
      entityLabel: `${hours}h · ${activity} · ${job.job_number}`,
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', `${hours}h logged to ${job.job_number}.`);
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to log time: ' + err.message);
    req.session.save(() => res.redirect(back));
  }
});

// Update entry (own entry, or admin/management)
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const entry = db.prepare('SELECT te.*, j.job_number FROM time_entries te JOIN jobs j ON te.job_id = j.id WHERE te.id = ?').get(req.params.id);
  const back = b.return_to || '/time';
  if (!entry) {
    req.flash('error', 'Time entry not found.');
    return req.session.save(() => res.redirect('/time'));
  }
  if (entry.user_id !== req.session.user.id && !isAdmin(req.session.user)) {
    req.flash('error', 'You can only edit your own time entries.');
    return req.session.save(() => res.redirect(back));
  }
  try {
    const hours = b.hours !== undefined ? parseFloat(b.hours) : entry.hours;
    if (!(hours > 0) || hours > 24) {
      req.flash('error', 'Hours must be between 0 and 24.');
      return req.session.save(() => res.redirect(back));
    }
    const codes = activityCodes(db).map(c => c.key);
    const activity = codes.includes(b.activity_code) ? b.activity_code : entry.activity_code;
    const entryDate = /^\d{4}-\d{2}-\d{2}$/.test(b.entry_date || '') ? b.entry_date : entry.entry_date;
    // Rate corrections are a finance/admin concern only.
    const canRate = canViewInternalCost(req.session.user);
    const chargeRate = canRate && b.charge_rate !== undefined && b.charge_rate !== '' ? (parseFloat(b.charge_rate) || entry.charge_rate) : entry.charge_rate;
    const costRate = canRate && b.cost_rate !== undefined && b.cost_rate !== '' ? (parseFloat(b.cost_rate) || entry.cost_rate) : entry.cost_rate;
    db.transaction(() => {
      db.prepare(`
        UPDATE time_entries SET service_package_id=?, entry_date=?, activity_code=?, hours=?,
          billable=?, description=?, charge_rate=?, cost_rate=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        b.service_package_id !== undefined ? (b.service_package_id || null) : entry.service_package_id,
        entryDate, activity, hours,
        b.billable !== undefined ? (b.billable === '0' ? 0 : 1) : entry.billable,
        b.description !== undefined ? b.description : entry.description,
        chargeRate, costRate, entry.id
      );
      syncJobActualHours(db, entry.job_id);
    })();
    logActivity({
      user: req.session.user, action: 'update', entityType: 'time_entry',
      entityId: entry.id, entityLabel: `${hours}h · ${entry.job_number}`,
      jobId: entry.job_id, jobNumber: entry.job_number, ip: req.ip,
    });
    req.flash('success', 'Time entry updated.');
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to update entry: ' + err.message);
    req.session.save(() => res.redirect(back));
  }
});

// Delete entry (own entry, or admin/management)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT te.*, j.job_number FROM time_entries te JOIN jobs j ON te.job_id = j.id WHERE te.id = ?').get(req.params.id);
  const back = req.body.return_to || '/time';
  if (!entry) {
    req.flash('error', 'Time entry not found.');
    return req.session.save(() => res.redirect('/time'));
  }
  if (entry.user_id !== req.session.user.id && !isAdmin(req.session.user)) {
    req.flash('error', 'You can only delete your own time entries.');
    return req.session.save(() => res.redirect(back));
  }
  db.transaction(() => {
    db.prepare('DELETE FROM time_entries WHERE id = ?').run(entry.id);
    syncJobActualHours(db, entry.job_id);
  })();
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'time_entry',
    entityId: entry.id, entityLabel: `${entry.hours}h · ${entry.job_number}`,
    jobId: entry.job_id, jobNumber: entry.job_number, ip: req.ip,
  });
  req.flash('success', 'Time entry deleted.');
  req.session.save(() => res.redirect(back));
});

module.exports = router;
