// /payroll/runs — weekly pay runs imported from a Traffio Person Dockets CSV.
// Each pay run breaks workers into Cash / TFN / ABN sections with up to 8
// hour buckets per worker (day_normal/day_ot/day_dt, night_normal/night_ot/
// night_dt, weekend, public_holiday). Rates + classifications snapshot at
// import time so historical runs are immutable.

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const archiver = require('archiver');

const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { sendEmail } = require('../services/email');
const { notificationEmail } = require('../services/emailTemplates');
const { sendPushForNotifications } = require('../services/pushNotification');
const {
  parseCsv, normalizeShift, aggregateByWorker, inferPeriod,
  matchEmployee, fetchClassification,
  buildLine, recomputeLine, recategorizeFromShifts, computeAutoAllowances,
  resolveRates, totalsFromBuckets, emptyBuckets,
  formatLocalDate, safeParseJson,
  BUCKETS, BUCKET_LABELS, BUCKET_RATE_FIELDS,
  round2, toNum, payAsYouGo,
} = require('../lib/payroll');

// ----------------------------------------------------------------------------
// Upload setup
// ----------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'payroll-csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '.csv') || '.csv').toLowerCase();
      cb(null, `payrun_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okExt = /\.csv$/i.test(file.originalname || '');
    const okMime = /text|csv|excel|octet-stream/i.test(file.mimetype || '');
    if (!okExt && !okMime) return cb(new Error('CSV files only'));
    cb(null, true);
  },
});

const SECTIONS = [
  { key: 'cash', label: 'Cash', accent: 'amber',   buckets: ['day_normal', 'night_normal'] },
  { key: 'tfn',  label: 'TFN',  accent: 'emerald', buckets: BUCKETS },
  { key: 'abn',  label: 'ABN',  accent: 'sky',     buckets: ['day_normal', 'day_ot', 'night_normal', 'night_ot', 'weekend'] },
];
const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function fmtMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Worker-Rates row diverged from its tier preset? Delegates to the shared
// helper in lib/wageTiers so the grid + the roster profile agree on when to
// set employees.rates_overridden.
function rowDivergesFromPreset(db, r) {
  const { ratesDivergeFromPreset } = require('../lib/wageTiers');
  return ratesDivergeFromPreset(db, r);
}

function periodLabel(start, end) {
  if (!end) return '';
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return `WE ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}

// ---- Approval workflow helpers --------------------------------------------
// Approver = whose sign-off is required. Default: username 'saadat'.
// Unlockers = who can re-open an approved run for edits. Default: 'saadat' + 'sajid'.
// If neither username exists yet (fresh deploy / dev DB), fall back to all
// active admin users so the workflow still works.
function getApproverUserIds(db) {
  const matches = db.prepare("SELECT id FROM users WHERE LOWER(username) IN ('saadat') AND active = 1").all().map(u => u.id);
  if (matches.length) return matches;
  return db.prepare("SELECT id FROM users WHERE LOWER(role) = 'admin' AND active = 1").all().map(u => u.id);
}
function getUnlockerUserIds(db) {
  const matches = db.prepare("SELECT id FROM users WHERE LOWER(username) IN ('saadat', 'sajid') AND active = 1").all().map(u => u.id);
  if (matches.length) return matches;
  return db.prepare("SELECT id FROM users WHERE LOWER(role) = 'admin' AND active = 1").all().map(u => u.id);
}
function getFinanceUserIds(db, alsoIncludeUserId) {
  const ids = db.prepare("SELECT id FROM users WHERE LOWER(role) IN ('finance', 'accounts') AND active = 1").all().map(u => u.id);
  if (alsoIncludeUserId && !ids.includes(alsoIncludeUserId)) ids.push(alsoIncludeUserId);
  return ids;
}
function isApprover(db, user) {
  if (!user || !user.id) return false;
  return getApproverUserIds(db).includes(user.id);
}
function isUnlocker(db, user) {
  if (!user || !user.id) return false;
  return getUnlockerUserIds(db).includes(user.id);
}
function isRunLocked(run) {
  if (!run) return false;
  return run.status === 'pending_approval' || run.status === 'approved' || run.status === 'paid';
}
// Friendly label for the status pill
function statusLabel(status) {
  switch (status) {
    case 'pending_approval': return 'Pending approval';
    case 'approved':         return 'Approved';
    case 'paid':             return 'Paid';
    case 'finalized':        return 'Finalized';
    default:                 return 'Draft';
  }
}
// Block edits on locked runs. Returns true if request should proceed.
// On block: sends 423 JSON for XHR, otherwise flashes + redirects.
function assertEditable(req, res, run) {
  if (!isRunLocked(run)) return true;
  const msg = `This pay run is ${statusLabel(run.status).toLowerCase()} and locked. Ask an approver to unlock it before editing.`;
  if (req.xhr || (req.headers.accept || '').includes('json')) {
    res.status(423).json({ error: msg });
  } else {
    req.flash('error', msg);
    res.redirect('/payroll/runs/' + run.id);
  }
  return false;
}
// Loads pay_run for a request that only has a line id route. Used by line
// mutation endpoints so they can also check edit lock state.
function getRunForLineRoute(db, runId) {
  return db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(runId);
}
// Send in-app + push + email to a list of user ids.
function notifyPayrollUsers(db, userIds, title, message, link) {
  if (!userIds || !userIds.length) return;
  try {
    const insert = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link)
      VALUES (?, 'general', ?, ?, ?)
    `);
    const newNotifs = [];
    for (const userId of userIds) {
      try {
        insert.run(userId, title, message, link);
        newNotifs.push({ userId, title, message, link });
      } catch (e) { /* ignore individual failure */ }
    }
    // Push immediately for the new in-app notifications
    try { sendPushForNotifications(db, newNotifs); } catch (e) { console.error('[payroll/notify] push error:', e.message); }
    // Email immediately for users who opted in
    const placeholders = userIds.map(() => '?').join(',');
    const users = db.prepare(`
      SELECT id, full_name, email, email_notifications_enabled, notification_frequency
      FROM users WHERE id IN (${placeholders})
    `).all(...userIds);
    for (const u of users) {
      if (!u.email) continue;
      if (!u.email_notifications_enabled) continue;
      if (u.notification_frequency && u.notification_frequency !== 'immediate') continue;
      try {
        const html = notificationEmail(u.full_name || '', title, message, link);
        sendEmail(u.email, title, html).catch(() => {});
      } catch (e) { /* ignore individual failure */ }
    }
  } catch (err) {
    console.error('[payroll/notify] error:', err.message);
  }
}

function loadPHSet(db) {
  const rows = db.prepare('SELECT date FROM public_holidays').all();
  return new Set(rows.map(r => r.date));
}
function makeIsPH(phSet) { return (date) => phSet.has(date); }

function hydrateLine(line) {
  line.buckets = safeParseJson(line.buckets_json, null);
  if (!line.buckets) {
    // Old line missing buckets — synthesize from legacy day/night
    const day = safeParseJson(line.day_hours_json, [0,0,0,0,0,0,0]);
    const night = safeParseJson(line.night_hours_json, [0,0,0,0,0,0,0]);
    line.buckets = emptyBuckets({ day_normal: line.rate_day, night_normal: line.rate_night });
    line.buckets.day_normal.hours = day;
    line.buckets.day_normal.total_hours = line.total_day_hours || 0;
    line.buckets.day_normal.total_wages = line.total_day_wages || 0;
    line.buckets.night_normal.hours = night;
    line.buckets.night_normal.total_hours = line.total_night_hours || 0;
    line.buckets.night_normal.total_wages = line.total_night_wages || 0;
  }
  line.shifts = safeParseJson(line.shifts_json, []);
  return line;
}

// Creates a Management pay run + auto-seeds one Salary line per employee
// flagged with on_management_payroll. Used by POST /runs when the form
// posts pay_run_type=management.
function createManagementRun(req, res) {
  try {
    const db = getDb();
    const period_start = (req.body.period_start || '').trim();
    const period_end = (req.body.period_end || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(period_end)) {
      req.flash('error', 'Period start + end dates are required (YYYY-MM-DD).');
      return res.redirect('/payroll/runs/new?type=management');
    }
    const label = (req.body.label || '').trim() || ('Management — ' + periodLabel(period_start, period_end));
    const notes = (req.body.notes || '').trim();

    let runId;
    let seeded = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO pay_runs (period_start, period_end, label, csv_filename, status, created_by_id, notes, pay_run_type)
        VALUES (?, ?, ?, '', 'draft', ?, ?, 'management')
      `).run(period_start, period_end, label, req.session.user.id, notes);
      runId = r.lastInsertRowid;

      const staff = db.prepare(`
        SELECT id, employee_code, first_name, last_name, payment_type,
          COALESCE(weekly_salary, 0) AS weekly_salary,
          COALESCE(super_rate, 0.12) AS super_rate,
          COALESCE(payroll_bsb, '') AS payroll_bsb,
          COALESCE(payroll_account, '') AS payroll_account
        FROM employees
        WHERE on_management_payroll = 1 AND deleted_at IS NULL
        ORDER BY LOWER(first_name), LOWER(last_name)
      `).all();

      const insertLine = db.prepare(`
        INSERT INTO pay_run_lines (
          pay_run_id, employee_id, full_name, payment_type, bsb, acc_number,
          salary_amount, super_amount, income_label,
          total_wages, grand_total, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Salary', ?, ?, ?)
      `);
      let order = 0;
      for (const e of staff) {
        const fullName = ((e.first_name || '') + ' ' + (e.last_name || '')).trim() || ('Employee #' + e.id);
        const salary = round2(toNum(e.weekly_salary));
        const superAmt = round2(salary * toNum(e.super_rate));
        insertLine.run(
          runId, e.id, fullName, e.payment_type || '',
          e.payroll_bsb, e.payroll_account,
          salary, superAmt,
          salary, salary,   // total_wages and grand_total mirror salary for management lines
          order++,
        );
        seeded++;
      }
    });
    tx();

    try {
      logActivity({
        user: req.session.user, action: 'create', entityType: 'pay_run',
        entityId: runId, entityLabel: label,
        details: `Created Management pay run — ${seeded} starter line(s)`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block */ }

    req.flash('success', seeded > 0
      ? `Created Management pay run with ${seeded} starter line(s).`
      : 'Created Management pay run. No staff are flagged for management payroll yet — tick "On management payroll" on an employee record to populate it.');
    return res.redirect('/payroll/runs/' + runId);
  } catch (err) {
    console.error('[payroll/runs] createManagementRun:', err);
    req.flash('error', 'Failed to create Management pay run: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/new?type=management');
  }
}

function sectionTotal(arr) {
  let hours = 0, wages = 0, allow = 0, total = 0;
  let tfn_super = 0, tfn_tax = 0, tfn_net = 0;
  for (const l of arr) {
    hours += toNum(l.total_hours);
    wages += toNum(l.total_wages);
    allow += toNum(l.total_allowance);
    total += toNum(l.grand_total);
    // TFN-only super/tax/net are pre-computed on the line in the GET handler
    tfn_super += toNum(l.tfn_super);
    tfn_tax   += toNum(l.tfn_tax);
    tfn_net   += toNum(l.tfn_net);
  }
  return {
    hours: round2(hours), wages: round2(wages), allow: round2(allow), total: round2(total),
    gst: round2(total * 0.10), with_gst: round2(total * 1.10),
    tfn_super: round2(tfn_super), tfn_tax: round2(tfn_tax), tfn_net: round2(tfn_net),
  };
}

// Number of weeks in a pay period (1 if missing/invalid). Used for tax calc.
function periodWeeks(run) {
  if (!run || !run.period_start || !run.period_end) return 1;
  const ms = new Date(run.period_end + 'T00:00:00') - new Date(run.period_start + 'T00:00:00');
  return Math.max(1, Math.round(ms / (7 * 86400000) + 1) || 1);
}

// ============================================================================
// GET /payroll/runs — list
// ============================================================================
router.get('/runs', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const VALID_TYPES = ['traffic_control', 'management'];
  const typeFilter = VALID_TYPES.includes(req.query.type) ? req.query.type : null;

  let where = '1=1';
  const params = [];
  if (typeFilter) { where += ' AND COALESCE(pr.pay_run_type, \'traffic_control\') = ?'; params.push(typeFilter); }

  // Bucket aggregation:
  //   Traffic Control runs use the line's payment_type (set per worker — cash/tfn/abn).
  //   Management runs are all TFN salaried staff, except for income lines
  //   labelled like "Cash Wages" which are paid out as cash. ABN doesn't
  //   apply to management runs.
  const runs = db.prepare(`
    SELECT pr.*, u.full_name AS created_by_name,
      COALESCE(pr.pay_run_type, 'traffic_control') AS pay_run_type,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id) AS line_count,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id) AS grand_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines prl WHERE prl.pay_run_id = pr.id AND (
        (COALESCE(pr.pay_run_type, 'traffic_control') = 'traffic_control' AND prl.payment_type = 'cash')
        OR (COALESCE(pr.pay_run_type, 'traffic_control') = 'management' AND LOWER(COALESCE(prl.income_label, '')) LIKE '%cash%')
      )) AS cash_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines prl WHERE prl.pay_run_id = pr.id AND (
        (COALESCE(pr.pay_run_type, 'traffic_control') = 'traffic_control' AND prl.payment_type = 'tfn')
        OR (COALESCE(pr.pay_run_type, 'traffic_control') = 'management' AND LOWER(COALESCE(prl.income_label, '')) NOT LIKE '%cash%')
      )) AS tfn_total,
      (SELECT COALESCE(SUM(grand_total), 0) FROM pay_run_lines WHERE pay_run_id = pr.id AND payment_type = 'abn'
        AND COALESCE(pr.pay_run_type, 'traffic_control') = 'traffic_control') AS abn_total,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id AND COALESCE(payment_type, '') = ''
        AND COALESCE(pr.pay_run_type, 'traffic_control') = 'traffic_control') AS unclassified_count,
      (SELECT COUNT(*) FROM pay_run_lines WHERE pay_run_id = pr.id AND paid = 1) AS paid_count
    FROM pay_runs pr
    LEFT JOIN users u ON u.id = pr.created_by_id
    WHERE ${where}
    ORDER BY pr.period_end DESC, pr.id DESC
    LIMIT 200
  `).all(...params);

  // Per-type counts for the tab badges (computed independent of the filter)
  const counts = db.prepare(`
    SELECT COALESCE(pay_run_type, 'traffic_control') AS t, COUNT(*) AS n
    FROM pay_runs GROUP BY 1
  `).all().reduce((acc, r) => { acc[r.t] = r.n; return acc; }, {});

  res.render('payroll-runs/index', {
    title: 'Pay Runs',
    currentPage: 'pay-runs',
    runs, fmtMoney, periodLabel,
    typeFilter,
    counts: { traffic_control: counts.traffic_control || 0, management: counts.management || 0 },
  });
});

// ============================================================================
// GET /payroll/runs/new
// Renders a type picker. Management runs skip CSV; TC runs upload it.
// ============================================================================
router.get('/runs/new', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  // Show how many staff would be auto-pre-filled if they pick Management
  let mgmtCount = 0;
  try { mgmtCount = db.prepare("SELECT COUNT(*) AS c FROM employees WHERE on_management_payroll = 1 AND deleted_at IS NULL").get().c; } catch (e) {}
  res.render('payroll-runs/new', {
    title: 'New Pay Run',
    currentPage: 'pay-runs',
    runType: req.query.type === 'management' ? 'management' : 'traffic_control',
    mgmtCount,
  });
});

// ============================================================================
// POST /payroll/runs — branch on pay_run_type
//   - 'management': create the parent row + auto-seed one Salary line per
//     employee with on_management_payroll = 1.
//   - default ('traffic_control'): existing CSV import path.
// ============================================================================
router.post('/runs', requirePermission('payroll'), (req, res) => {
  // Management branch: no CSV, just period dates. Detect via the
  // pay_run_type form field. multipart/form-data isn't required, so
  // we sniff before invoking multer.
  const requestedType = (req.body && req.body.pay_run_type) || '';
  if (requestedType === 'management') {
    return createManagementRun(req, res);
  }
  upload.single('csv')(req, res, function (err) {
    if (err) { req.flash('error', err.message); return res.redirect('/payroll/runs/new'); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/payroll/runs/new'); }

    let raw;
    try { raw = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/payroll/runs/new');
    }

    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      req.flash('error', 'CSV had no data rows.');
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/payroll/runs/new');
    }

    const shifts = rows.map(normalizeShift).filter(Boolean);
    if (shifts.length === 0) {
      req.flash('error', 'CSV had no usable shifts.');
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      return res.redirect('/payroll/runs/new');
    }

    const inferred = inferPeriod(shifts);
    const period_start = (req.body.period_start && /^\d{4}-\d{2}-\d{2}$/.test(req.body.period_start))
      ? req.body.period_start : inferred.period_start;
    const period_end = (req.body.period_end && /^\d{4}-\d{2}-\d{2}$/.test(req.body.period_end))
      ? req.body.period_end : inferred.period_end;
    const label = (req.body.label || '').trim() || periodLabel(period_start, period_end);
    const notes = (req.body.notes || '').trim();

    const workers = aggregateByWorker(shifts);
    const db = getDb();
    const isPH = makeIsPH(loadPHSet(db));

    let runId;
    try {
      const insertRun = db.prepare(`
        INSERT INTO pay_runs (period_start, period_end, label, csv_filename, status, created_by_id, notes, pay_run_type)
        VALUES (?, ?, ?, ?, 'draft', ?, ?, 'traffic_control')
      `);
      const insertLine = db.prepare(`
        INSERT INTO pay_run_lines (
          pay_run_id, employee_id, person_id, full_name, payment_type, bsb, acc_number,
          buckets_json, day_hours_json, night_hours_json,
          total_day_hours, total_night_hours, total_hours,
          rate_day, rate_night,
          total_day_wages, total_night_wages, total_wages,
          travel_allowance, meal_allowance, other_allowance, total_allowance,
          grand_total, paid, paid_ref, paid_at, notes, shifts_json, sort_order
        ) VALUES (
          @pay_run_id, @employee_id, @person_id, @full_name, @payment_type, @bsb, @acc_number,
          @buckets_json, @day_hours_json, @night_hours_json,
          @total_day_hours, @total_night_hours, @total_hours,
          @rate_day, @rate_night,
          @total_day_wages, @total_night_wages, @total_wages,
          @travel_allowance, @meal_allowance, @other_allowance, @total_allowance,
          @grand_total, @paid, @paid_ref, @paid_at, @notes, @shifts_json, @sort_order
        )
      `);

      const tx = db.transaction(() => {
        const r = insertRun.run(period_start, period_end, label, req.file.filename, req.session.user.id, notes);
        runId = r.lastInsertRowid;
        let order = 0;
        for (const agg of workers) {
          const employee = matchEmployee(db, agg);
          const classification = (employee && employee.award_classification_id)
            ? fetchClassification(db, employee.award_classification_id) : null;
          const line = buildLine({ pay_run_id: runId, agg, employee, classification, isPH });
          line.sort_order = order++;
          insertLine.run(line);
        }
      });
      tx();
    } catch (e) {
      console.error('Pay run import failed:', e);
      req.flash('error', 'Import failed: ' + e.message);
      try { fs.unlinkSync(req.file.path); } catch (er) {}
      return res.redirect('/payroll/runs/new');
    }

    logActivity({
      user: req.session.user, action: 'create', entityType: 'pay_run',
      entityId: runId, entityLabel: label,
      details: `Imported pay run ${label} — ${workers.length} workers, ${shifts.length} shifts`,
      ip: req.ip,
    });

    req.flash('success', `Imported ${workers.length} workers from ${shifts.length} shifts.`);
    res.redirect('/payroll/runs/' + runId);
  });
});

// ============================================================================
// GET /payroll/runs/:id — main detail page. Branches view on pay_run_type.
// ============================================================================
router.get('/runs/:id', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  run.pay_run_type = run.pay_run_type || 'traffic_control';

  // Management runs use a salary-grid view: one row per income line,
  // grouped by employee, with inline-editable salary/super.
  if (run.pay_run_type === 'management') {
    const lines = db.prepare(`
      SELECT prl.*, e.employee_code, e.first_name, e.last_name,
        COALESCE(e.weekly_salary, 0) AS emp_weekly_salary,
        COALESCE(e.super_rate, 0.12) AS emp_super_rate
      FROM pay_run_lines prl
      LEFT JOIN employees e ON e.id = prl.employee_id
      WHERE prl.pay_run_id = ?
      ORDER BY LOWER(prl.full_name) ASC, prl.id ASC
    `).all(run.id);

    // All on-management staff, so the "+ Add line" picker has every
    // option even if a particular run hasn't seeded a row for them yet.
    const eligibleStaff = db.prepare(`
      SELECT id, first_name, last_name, employee_code,
        COALESCE(weekly_salary, 0) AS weekly_salary,
        COALESCE(super_rate, 0.12) AS super_rate
      FROM employees
      WHERE on_management_payroll = 1 AND deleted_at IS NULL
      ORDER BY LOWER(first_name), LOWER(last_name)
    `).all();

    // Tax/net computed at the EMPLOYEE level (not per line) so a person
    // with multiple income lines (Salary + Director fee + Bonus) is taxed
    // on the combined total, not each line independently. PAYG → Schedule 1
    // weekly TFT-claimed approximation; period derived from run dates.
    const { payAsYouGo } = require('../lib/payroll');
    const periodWeeks = (() => {
      if (!run.period_start || !run.period_end) return 1;
      const ms = new Date(run.period_end + 'T00:00:00') - new Date(run.period_start + 'T00:00:00');
      return Math.max(1, Math.round(ms / (7 * 86400000) + 1) || 1);
    })();

    // Sum gross per employee, then split tax proportionally back to lines.
    // Lines labelled "Cash Wages" are excluded from tax — those amounts are
    // paid as cash and any tax is handled manually outside the system. They
    // still count toward gross/super/net, just with zero PAYG withheld.
    const isCashWages = (l) => /cash/i.test(String(l.income_label || ''));
    const grossByEmp = {};
    for (const l of lines) {
      if (isCashWages(l)) continue;
      const k = l.employee_id || ('name:' + (l.full_name || ''));
      grossByEmp[k] = (grossByEmp[k] || 0) + toNum(l.salary_amount);
    }
    const taxByEmp = {};
    for (const k of Object.keys(grossByEmp)) {
      taxByEmp[k] = payAsYouGo(grossByEmp[k], periodWeeks);
    }
    let totalSalary = 0, totalSuper = 0, totalTax = 0;
    for (const l of lines) {
      if (isCashWages(l)) {
        l.tax_withheld = 0;
        l.net_pay = round2(toNum(l.salary_amount));
      } else {
        const k = l.employee_id || ('name:' + (l.full_name || ''));
        const g = grossByEmp[k] || 0;
        const taxFull = taxByEmp[k] || 0;
        // Allocate this line's share of the employee's (taxable) gross
        l.tax_withheld = g > 0 ? round2(taxFull * (toNum(l.salary_amount) / g)) : 0;
        l.net_pay = round2(toNum(l.salary_amount) - l.tax_withheld);
      }
      totalSalary += toNum(l.salary_amount);
      totalSuper  += toNum(l.super_amount);
      totalTax    += l.tax_withheld;
    }

    let incomeLabels = [];
    try {
      incomeLabels = db.prepare("SELECT label FROM income_labels WHERE active = 1 ORDER BY sort_order ASC, label ASC").all().map(r => r.label);
    } catch (e) { /* table missing on stale deploy */ }

    return res.render('payroll-runs/management-show', {
      title: run.label || 'Management Pay Run',
      currentPage: 'pay-runs',
      run, lines, eligibleStaff, incomeLabels,
      totals: {
        salary: round2(totalSalary),
        super: round2(totalSuper),
        tax: round2(totalTax),
        net: round2(totalSalary - totalTax),
        grand: round2(totalSalary + totalSuper),
      },
      fmtMoney, periodLabel, statusLabel,
      runLocked: isRunLocked(run),
      canApprove: isApprover(db, req.session.user),
      canUnlock: isUnlocker(db, req.session.user),
      submittedBy: run.submitted_by_id ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(run.submitted_by_id) : null,
      approvedBy: run.approved_by_id ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(run.approved_by_id) : null,
      paidBy: run.paid_by_id ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(run.paid_by_id) : null,
    });
  }

  // Pull the employee's configured rates alongside each line so the edit
  // modal can fall back to the worker rates page values when a line was
  // imported before the rate was set (those columns end up at 0 on the
  // line itself, which then renders "Rate $0.00" in the modal).
  const lines = db.prepare(`
    SELECT prl.*, e.employee_code, e.payment_type AS emp_payment_type,
      e.award_classification_id,
      COALESCE(e.rate_fares_daily, 0) AS emp_travel_rate,
      COALESCE(e.rate_meal, 0)         AS emp_meal_rate,
      COALESCE(e.super_rate, 0.12)     AS emp_super_rate,
      COALESCE(e.payroll_bsb, '')      AS emp_payroll_bsb,
      COALESCE(e.payroll_account, '')  AS emp_payroll_account,
      ac.classification AS classification_name
    FROM pay_run_lines prl
    LEFT JOIN employees e ON e.id = prl.employee_id
    LEFT JOIN award_classifications ac ON ac.id = e.award_classification_id
    WHERE prl.pay_run_id = ?
    ORDER BY LOWER(prl.full_name) ASC
  `).all(run.id);

  // Always-visible BSB/Acc: when a line carries no snapshot and the employee
  // has no plaintext fallback, decrypt the latest bank_accounts row so the
  // payroll list shows real bank details wherever they exist. Truly-missing
  // rows render a "collect" marker in the view (never a silent blank).
  try {
    const { decrypt } = require('../services/encryption');
    const latestBank = db.prepare(`
      SELECT bsb_encrypted, account_number_encrypted FROM bank_accounts
      WHERE employee_id = ? ORDER BY id DESC LIMIT 1
    `);
    for (const l of lines) {
      if (!l.employee_id) continue;
      const haveBsb = l.bsb || l.emp_payroll_bsb;
      const haveAcc = l.acc_number || l.emp_payroll_account;
      if (haveBsb && haveAcc) continue;
      const bank = latestBank.get(l.employee_id);
      if (!bank) continue;
      if (!haveBsb && bank.bsb_encrypted) { const v = decrypt(bank.bsb_encrypted); if (v) l.emp_payroll_bsb = v; }
      if (!haveAcc && bank.account_number_encrypted) { const v = decrypt(bank.account_number_encrypted); if (v) l.emp_payroll_account = v; }
    }
  } catch (e) { /* encryption/table unavailable — fall back to whatever's on the line */ }

  // Load expenses + deductions for every line in this run (one query each)
  const expensesByLine = {}, deductionsByLine = {};
  if (lines.length) {
    const lineIds = lines.map(l => l.id);
    const placeholders = lineIds.map(() => '?').join(',');
    try {
      const expenseRows = db.prepare(`
        SELECT * FROM pay_run_line_expenses
        WHERE pay_run_line_id IN (${placeholders})
        ORDER BY pay_run_line_id, id ASC
      `).all(...lineIds);
      for (const r of expenseRows) {
        if (!expensesByLine[r.pay_run_line_id]) expensesByLine[r.pay_run_line_id] = [];
        expensesByLine[r.pay_run_line_id].push(r);
      }
    } catch (e) { /* table may not exist on a stale deploy */ }
    try {
      const dedRows = db.prepare(`
        SELECT * FROM pay_run_line_deductions
        WHERE pay_run_line_id IN (${placeholders})
        ORDER BY pay_run_line_id, sort_order ASC, id ASC
      `).all(...lineIds);
      for (const r of dedRows) {
        if (!deductionsByLine[r.pay_run_line_id]) deductionsByLine[r.pay_run_line_id] = [];
        deductionsByLine[r.pay_run_line_id].push(r);
      }
    } catch (e) { /* table may not exist on a stale deploy */ }
  }

  // Tax is calculated on the period's wages, then converted to weekly + back
  // to period for ATO bracket alignment. Super = wages × employee super_rate
  // (default 12%). Net = (wages + allow) − tax (allowances are typically
  // tax-exempt, so they pass through to net unchanged). TFN only — Cash and
  // ABN don't have employer-side withholding/super.
  const weeks = periodWeeks(run);
  const buckets = { cash: [], tfn: [], abn: [], unclassified: [] };
  for (const l of lines) {
    hydrateLine(l);
    l.expenses = expensesByLine[l.id] || [];
    l.deductions = deductionsByLine[l.id] || [];
    const t = (l.payment_type || '').toLowerCase();
    if (t === 'tfn') {
      const wages = toNum(l.total_wages);
      const superRate = toNum(l.emp_super_rate) || 0.12;
      l.tfn_super = round2(wages * superRate);
      l.tfn_tax   = payAsYouGo(wages, weeks);
      l.tfn_net   = round2(toNum(l.grand_total) - l.tfn_tax);
    }
    if      (t === 'cash') buckets.cash.push(l);
    else if (t === 'tfn')  buckets.tfn.push(l);
    else if (t === 'abn')  buckets.abn.push(l);
    else                    buckets.unclassified.push(l);
  }

  const totals = {
    cash:         sectionTotal(buckets.cash),
    tfn:          sectionTotal(buckets.tfn),
    abn:          sectionTotal(buckets.abn),
    unclassified: sectionTotal(buckets.unclassified),
  };
  const grand = {
    total: round2(totals.cash.total + totals.tfn.total + totals.abn.total + totals.unclassified.total),
    paid:  round2(lines.filter(l => l.paid).reduce((s, l) => s + toNum(l.grand_total), 0)),
    paid_count: lines.filter(l => l.paid).length,
    line_count: lines.length,
    tfn_super: totals.tfn.tfn_super || 0,
    tfn_tax:   totals.tfn.tfn_tax   || 0,
    tfn_net:   totals.tfn.tfn_net   || 0,
  };

  const employees = db.prepare(`
    SELECT id, employee_code, full_name, payment_type
    FROM employees WHERE active = 1 ORDER BY LOWER(full_name) ASC
  `).all();

  res.render('payroll-runs/show', {
    title: run.label || periodLabel(run.period_start, run.period_end),
    currentPage: 'pay-runs',
    run,
    sections: SECTIONS,
    dowLabels: DOW_LABELS,
    bucketLabels: BUCKET_LABELS,
    bucketKeys: BUCKETS,
    buckets, totals, grand, employees,
    fmtMoney, periodLabel, statusLabel,
    runLocked: isRunLocked(run),
    canApprove: isApprover(db, req.session.user),
    canUnlock: isUnlocker(db, req.session.user),
    submittedBy: run.submitted_by_id ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(run.submitted_by_id) : null,
    approvedBy: run.approved_by_id ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(run.approved_by_id) : null,
    paidBy: run.paid_by_id ? db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(run.paid_by_id) : null,
  });
});

// ============================================================================
// GET /payroll/employee/:id/payroll-details.json — full payroll detail for the
//   clickable-name popup on the pay-run list. Returns decrypted BSB, account,
//   and TFN alongside super + contact details. Gated to `payroll` permission
//   and every view is written to the activity log (these are the most
//   sensitive fields in the system — see services/encryption.js).
// ============================================================================
router.get('/employee/:id/payroll-details.json', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const empId = parseInt(req.params.id, 10);
    const e = db.prepare(`
      SELECT id, employee_code, full_name, email, phone,
        address, address_line1, address_line2, suburb, state, postcode,
        date_of_birth, payment_type, payroll_bsb, payroll_account
      FROM employees WHERE id = ? AND deleted_at IS NULL
    `).get(empId);
    if (!e) return res.status(404).json({ error: 'Employee not found.' });

    const { decrypt } = require('../services/encryption');
    const bank = db.prepare('SELECT * FROM bank_accounts WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(empId) || null;
    const sup = db.prepare('SELECT * FROM super_funds WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(empId) || null;
    const tfn = db.prepare('SELECT * FROM tfn_declarations WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(empId) || null;

    // Prefer the encrypted bank row; fall back to the plaintext payroll_*
    // mirror columns so a worker imported before encryption still shows.
    const bsb = (bank && bank.bsb_encrypted && decrypt(bank.bsb_encrypted)) || e.payroll_bsb || '';
    const acc = (bank && bank.account_number_encrypted && decrypt(bank.account_number_encrypted)) || e.payroll_account || '';
    const tfnNumber = (tfn && tfn.tfn_encrypted && decrypt(tfn.tfn_encrypted)) || '';

    const address = [e.address || e.address_line1, e.address_line2, e.suburb, e.state, e.postcode]
      .map(s => (s || '').trim()).filter(Boolean).join(', ');

    try {
      logActivity({
        user: req.session.user, action: 'view', entityType: 'employee',
        entityId: empId, entityLabel: e.full_name,
        details: `Viewed full payroll details (BSB/account/TFN) for ${e.full_name}`,
        ip: req.ip,
      });
    } catch (err) { /* audit shouldn't block the read */ }

    res.json({
      id: e.id,
      employee_code: e.employee_code || '',
      full_name: e.full_name || '',
      email: e.email || '',
      phone: e.phone || '',
      address,
      date_of_birth: e.date_of_birth || '',
      payment_type: (e.payment_type || '').toUpperCase(),
      bank: {
        account_name: bank ? (bank.account_name || '') : '',
        bsb, account: acc,
        missing: !bsb && !acc,
      },
      super: sup ? {
        fund_name: sup.fund_name || '', usi: sup.usi || '',
        member_number: sup.member_number || '', fund_abn: sup.fund_abn || '',
        use_default: !!sup.use_default,
      } : null,
      tfn: {
        number: tfnNumber,
        residency_status: tfn ? (tfn.residency_status || '') : '',
        missing: !tfnNumber,
      },
    });
  } catch (e) {
    console.error('[payroll/employee/:id/payroll-details.json]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// POST /payroll/runs/:id/lines/:lineId — update a line
//   - If payment_type changes → re-categorize from shifts_json
//   - Else if `buckets[]` is present → use those edits
//   - Always recompute totals + apply allowance edits
// ============================================================================
router.post('/runs/:id/lines/:lineId', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Pay run not found' });
  // Allow paid-only updates on locked runs — finance still needs to tick "paid"
  // off after Saadat approves the run. Anything that touches wages, allowances,
  // payment type, etc. requires the run to be editable.
  const bodyKeys = Object.keys(req.body || {});
  const PAID_ONLY_KEYS = new Set(['paid', 'paid_ref', '_csrf']);
  const isPaidOnlyUpdate = bodyKeys.length > 0 && bodyKeys.every(k => PAID_ONLY_KEYS.has(k));
  if (!isPaidOnlyUpdate && !assertEditable(req, res, run)) return;
  const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, run.id);
  if (!line) return res.status(404).json({ error: 'Line not found' });

  const b = req.body || {};
  const updates = {};

  // Payment type
  let newPT = line.payment_type || '';
  let ptChanged = false;
  if (b.payment_type !== undefined) {
    const pt = String(b.payment_type || '').toLowerCase();
    newPT = ['cash', 'tfn', 'abn'].includes(pt) ? pt : '';
    if (newPT !== (line.payment_type || '')) {
      ptChanged = true;
      updates.payment_type = newPT;
    }
  }

  // BSB / Account
  if (b.bsb !== undefined)        updates.bsb = String(b.bsb || '').trim();
  if (b.acc_number !== undefined) updates.acc_number = String(b.acc_number || '').trim();

  // Allowances — Travel and Meal accept rate × count breakdown.
  // If `*_override = 1` is sent, the explicit `*_allowance` value wins.
  // Otherwise the allowance is recomputed from rate × count.
  if (b.travel_rate !== undefined)  updates.travel_rate  = toNum(b.travel_rate);
  if (b.travel_count !== undefined) updates.travel_count = Math.max(0, parseInt(b.travel_count, 10) || 0);
  if (b.meal_rate !== undefined)    updates.meal_rate    = toNum(b.meal_rate);
  if (b.meal_count !== undefined)   updates.meal_count   = Math.max(0, parseInt(b.meal_count, 10) || 0);

  const travelOverride = String(b.travel_override || '') === '1';
  if (travelOverride && b.travel_allowance !== undefined) {
    updates.travel_allowance = toNum(b.travel_allowance);
  } else if (b.travel_rate !== undefined || b.travel_count !== undefined) {
    const r = updates.travel_rate  != null ? updates.travel_rate  : toNum(line.travel_rate);
    const c = updates.travel_count != null ? updates.travel_count : (parseInt(line.travel_count, 10) || 0);
    updates.travel_allowance = round2(r * c);
  } else if (b.travel_allowance !== undefined) {
    updates.travel_allowance = toNum(b.travel_allowance);
  }

  const mealOverride = String(b.meal_override || '') === '1';
  if (mealOverride && b.meal_allowance !== undefined) {
    updates.meal_allowance = toNum(b.meal_allowance);
  } else if (b.meal_rate !== undefined || b.meal_count !== undefined) {
    const r = updates.meal_rate  != null ? updates.meal_rate  : toNum(line.meal_rate);
    const c = updates.meal_count != null ? updates.meal_count : (parseInt(line.meal_count, 10) || 0);
    updates.meal_allowance = round2(r * c);
  } else if (b.meal_allowance !== undefined) {
    updates.meal_allowance = toNum(b.meal_allowance);
  }

  if (b.other_allowance !== undefined) updates.other_allowance = toNum(b.other_allowance);

  // Meal + travel are TFN-only. Whatever the form posted, a Cash/ABN/
  // unclassified line always saves with zeroed travel + meal so the rule
  // can't be bypassed from the modal.
  if (!isPaidOnlyUpdate && newPT !== 'tfn') {
    updates.travel_rate = 0;  updates.travel_count = 0;  updates.travel_allowance = 0;
    updates.meal_rate   = 0;  updates.meal_count   = 0;  updates.meal_allowance   = 0;
  }

  // Paid
  if (b.paid !== undefined) {
    const paidNow = (b.paid === true || b.paid === '1' || b.paid === 1 || b.paid === 'true' || b.paid === 'on') ? 1 : 0;
    updates.paid = paidNow;
    if (paidNow && !line.paid_at) updates.paid_at = new Date().toISOString();
    if (!paidNow) updates.paid_at = null;
  }
  if (b.paid_ref !== undefined) updates.paid_ref = String(b.paid_ref || '').trim();
  if (b.notes !== undefined)    updates.notes    = String(b.notes || '').trim();

  // Resolve buckets — three paths
  const isPH = makeIsPH(loadPHSet(db));
  let bucketsState = null;

  if (ptChanged) {
    // Re-categorize from shifts_json with new section's rules + employee/classification rates
    const employee = line.employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(line.employee_id) : null;
    const classification = (employee && employee.award_classification_id)
      ? fetchClassification(db, employee.award_classification_id) : null;
    const { buckets, auto } = recategorizeFromShifts(line, { paymentType: newPT, employee, classification, isPH });
    bucketsState = buckets;
    if (b.travel_allowance === undefined) updates.travel_allowance = auto.travel;
    if (b.meal_allowance   === undefined) updates.meal_allowance   = auto.meal;
  } else if (b.buckets && typeof b.buckets === 'object') {
    // Manual bucket edits — accept hours[7] + rate per bucket
    bucketsState = safeParseJson(line.buckets_json, null) || emptyBuckets({});
    for (const k of BUCKETS) {
      if (!bucketsState[k]) bucketsState[k] = { hours: [0,0,0,0,0,0,0], total_hours: 0, rate: 0, total_wages: 0 };
      const bk = b.buckets[k];
      if (!bk) continue;
      if (Array.isArray(bk.hours) && bk.hours.length === 7) {
        bucketsState[k].hours = bk.hours.map(toNum).map(round2);
      }
      if (bk.rate !== undefined) bucketsState[k].rate = toNum(bk.rate);
    }
  } else {
    // No bucket changes, no section change — keep existing
    bucketsState = safeParseJson(line.buckets_json, null);
  }

  if (bucketsState) updates.buckets_json = JSON.stringify(bucketsState);

  // Merge & recompute totals (uses buckets_json + travel/meal/other from updates+line)
  const merged = Object.assign({}, line, updates);
  const recomputed = recomputeLine(merged, { isPH });
  Object.assign(updates, recomputed);
  updates.updated_at = new Date().toISOString();

  // Optionally save back to the employee record
  if (line.employee_id) {
    const empUpdates = [];
    const empParams = [];
    if (b.save_bsb_to_employee) {
      if (updates.bsb !== undefined)        { empUpdates.push('payroll_bsb = ?');     empParams.push(updates.bsb); }
      if (updates.acc_number !== undefined) { empUpdates.push('payroll_account = ?'); empParams.push(updates.acc_number); }
    }
    if (b.save_payment_type_to_employee && updates.payment_type !== undefined) {
      empUpdates.push('payment_type = ?'); empParams.push(updates.payment_type);
    }
    if (empUpdates.length > 0) {
      empParams.push(line.employee_id);
      db.prepare(`UPDATE employees SET ${empUpdates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...empParams);
    }
  }

  // Apply UPDATE
  const cols = Object.keys(updates);
  if (cols.length > 0) {
    const setSql = cols.map(c => `${c} = ?`).join(', ');
    const params = cols.map(c => updates[c]);
    params.push(req.params.lineId);
    db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);
  }

  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (wantsJson) {
    const fresh = db.prepare('SELECT * FROM pay_run_lines WHERE id = ?').get(req.params.lineId);
    return res.json({ ok: true, line: hydrateLine(fresh) });
  }
  return res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// POST /payroll/runs/:id/lines/:lineId/match — link to employee + recategorize
// ============================================================================
router.post('/runs/:id/lines/:lineId/match', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = getRunForLineRoute(db, req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (!assertEditable(req, res, run)) return;
  const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
  if (!line) { req.flash('error', 'Line not found'); return res.redirect('/payroll/runs/' + req.params.id); }

  const empId = parseInt(req.body.employee_id, 10);
  if (!empId) { req.flash('error', 'Pick an employee'); return res.redirect('/payroll/runs/' + req.params.id); }
  const emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
  if (!emp) { req.flash('error', 'Employee not found'); return res.redirect('/payroll/runs/' + req.params.id); }

  const newPT = (emp.payment_type && ['cash', 'tfn', 'abn'].includes(String(emp.payment_type).toLowerCase()))
    ? String(emp.payment_type).toLowerCase() : (line.payment_type || '');
  const classification = emp.award_classification_id ? fetchClassification(db, emp.award_classification_id) : null;
  const isPH = makeIsPH(loadPHSet(db));
  const { buckets, auto } = recategorizeFromShifts(line, { paymentType: newPT, employee: emp, classification, isPH });

  const updates = {
    employee_id: emp.id,
    payment_type: newPT,
    bsb: line.bsb || (emp.payroll_bsb || ''),
    acc_number: line.acc_number || (emp.payroll_account || ''),
    buckets_json: JSON.stringify(buckets),
    travel_allowance: auto.travel,
    meal_allowance: auto.meal,
    updated_at: new Date().toISOString(),
  };
  const merged = Object.assign({}, line, updates);
  const recomputed = recomputeLine(merged, { isPH });
  Object.assign(updates, recomputed);

  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]);
  params.push(line.id);
  db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);

  req.flash('success', `Linked ${line.full_name} → ${emp.full_name}.`);
  res.redirect('/payroll/runs/' + req.params.id);
});

// ============================================================================
// POST /payroll/runs/:id/refresh — re-categorize ALL lines from shifts_json
//   Useful after editing rates / classifications / public holidays.
// ============================================================================
router.post('/runs/:id/refresh', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (!assertEditable(req, res, run)) return;

  const isPH = makeIsPH(loadPHSet(db));
  const lines = db.prepare('SELECT * FROM pay_run_lines WHERE pay_run_id = ?').all(run.id);

  const tx = db.transaction(() => {
    let n = 0;
    for (const line of lines) {
      const employee = line.employee_id ? db.prepare('SELECT * FROM employees WHERE id = ?').get(line.employee_id) : null;
      const classification = (employee && employee.award_classification_id)
        ? fetchClassification(db, employee.award_classification_id) : null;
      const { buckets, auto } = recategorizeFromShifts(line, {
        paymentType: line.payment_type || '', employee, classification, isPH,
      });
      const updates = {
        buckets_json: JSON.stringify(buckets),
        travel_allowance: auto.travel,
        meal_allowance:   auto.meal,
        bsb: employee ? (employee.payroll_bsb || line.bsb || '') : line.bsb,
        acc_number: employee ? (employee.payroll_account || line.acc_number || '') : line.acc_number,
        updated_at: new Date().toISOString(),
      };
      const merged = Object.assign({}, line, updates);
      const recomputed = recomputeLine(merged, { isPH });
      Object.assign(updates, recomputed);
      const cols = Object.keys(updates);
      const setSql = cols.map(c => `${c} = ?`).join(', ');
      const params = cols.map(c => updates[c]);
      params.push(line.id);
      db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);
      n++;
    }
    return n;
  });
  const n = tx();

  req.flash('success', `Refreshed ${n} lines from current rates and classifications.`);
  res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// POST /payroll/runs/:id/lines — add a one-off worker to a TC run.
//   Used for casuals or sub-contractors who didn't come in via the Traffio
//   CSV but need to be paid for this week. Creates a line with empty buckets
//   so the user can click Edit and fill in hours/rates straight after.
//   Optionally links to an existing employee record so future runs can match.
// ============================================================================
router.post('/runs/:id/lines', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare("SELECT *, COALESCE(pay_run_type, 'traffic_control') AS pay_run_type FROM pay_runs WHERE id = ?").get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (run.pay_run_type === 'management') {
    req.flash('error', 'Management runs use the Add income line form instead.');
    return res.redirect('/payroll/runs/' + run.id);
  }
  if (!assertEditable(req, res, run)) return;

  const fullName = String(req.body.full_name || '').trim().slice(0, 120);
  const paymentType = String(req.body.payment_type || '').toLowerCase();
  if (!fullName) {
    req.flash('error', 'Worker name is required.');
    return res.redirect('/payroll/runs/' + run.id);
  }
  if (!['cash', 'tfn', 'abn'].includes(paymentType)) {
    req.flash('error', 'Pick a section (Cash, TFN or ABN).');
    return res.redirect('/payroll/runs/' + run.id);
  }

  // Optional employee link — if provided, pull in BSB/account + classification
  // rates so the edit modal has sensible defaults.
  const empId = parseInt(req.body.employee_id, 10) || null;
  let emp = null;
  let classification = null;
  if (empId) {
    emp = db.prepare('SELECT * FROM employees WHERE id = ?').get(empId);
    if (emp && emp.award_classification_id) {
      try { classification = fetchClassification(db, emp.award_classification_id); } catch (e) { /* ignore */ }
    }
  }

  // Default rates from classification + employee fallback. If neither is set
  // (truly one-off worker), buckets are seeded with $0 rates — user fills
  // them in via the Edit modal.
  const rates = resolveRates(emp, classification);
  const buckets = emptyBuckets(rates);

  const result = db.prepare(`
    INSERT INTO pay_run_lines (
      pay_run_id, employee_id, full_name, payment_type, bsb, acc_number,
      buckets_json, total_hours, total_wages, total_allowance, grand_total,
      sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 999)
  `).run(
    run.id,
    emp ? emp.id : null,
    fullName,
    paymentType,
    emp ? (emp.payroll_bsb || '') : '',
    emp ? (emp.payroll_account || '') : '',
    JSON.stringify(buckets),
  );

  logActivity({
    user: req.session.user, action: 'add_one_off', entityType: 'pay_run_line',
    entityId: result.lastInsertRowid, entityLabel: fullName,
    details: `Added one-off ${paymentType.toUpperCase()} worker "${fullName}" to pay run ${run.id}`,
    ip: req.ip,
  });

  req.flash('success', `Added ${fullName} to ${paymentType.toUpperCase()}. Click Edit to fill in hours.`);
  res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// Management pay run line endpoints — separate from the TC line editor
// because the column shape is different (salary/super/income_label vs
// hours buckets) and we want the cleaner per-row try/catch pattern.
// ============================================================================

// Loads a line and confirms it lives on a Management run.
function getManagementLine(db, runId, lineId) {
  return db.prepare(`
    SELECT prl.*, COALESCE(pr.pay_run_type, 'traffic_control') AS pay_run_type
    FROM pay_run_lines prl
    JOIN pay_runs pr ON pr.id = prl.pay_run_id
    WHERE prl.pay_run_id = ? AND prl.id = ? AND COALESCE(pr.pay_run_type, 'traffic_control') = 'management'
  `).get(runId, lineId);
}

// POST /payroll/runs/:id/management-lines — add a new income line to a Management run.
router.post('/runs/:id/management-lines', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = db.prepare("SELECT *, COALESCE(pay_run_type, 'traffic_control') AS pay_run_type FROM pay_runs WHERE id = ?").get(req.params.id);
    if (!run || run.pay_run_type !== 'management') {
      req.flash('error', 'Management pay run not found.');
      return res.redirect('/payroll/runs');
    }
    if (!assertEditable(req, res, run)) return;
    const empId = parseInt(req.body.employee_id, 10);
    if (!empId) {
      req.flash('error', 'Employee is required.');
      return res.redirect('/payroll/runs/' + run.id);
    }
    const emp = db.prepare(`
      SELECT id, first_name, last_name, payment_type,
        COALESCE(weekly_salary, 0) AS weekly_salary,
        COALESCE(super_rate, 0.12) AS super_rate,
        COALESCE(payroll_bsb, '') AS payroll_bsb,
        COALESCE(payroll_account, '') AS payroll_account
      FROM employees WHERE id = ?
    `).get(empId);
    if (!emp) {
      req.flash('error', 'Employee not found.');
      return res.redirect('/payroll/runs/' + run.id);
    }
    const incomeLabel = String(req.body.income_label || 'Salary').trim().slice(0, 80) || 'Salary';
    const salary = round2(toNum(req.body.salary_amount));
    // If super amount blank, default to salary × employee's super_rate
    const superAmt = req.body.super_amount === '' || req.body.super_amount == null
      ? round2(salary * toNum(emp.super_rate))
      : round2(toNum(req.body.super_amount));
    const fullName = ((emp.first_name || '') + ' ' + (emp.last_name || '')).trim() || ('Employee #' + emp.id);

    db.prepare(`
      INSERT INTO pay_run_lines (
        pay_run_id, employee_id, full_name, payment_type, bsb, acc_number,
        salary_amount, super_amount, income_label,
        total_wages, grand_total, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, emp.id, fullName, emp.payment_type || '',
      emp.payroll_bsb, emp.payroll_account,
      salary, superAmt, incomeLabel,
      salary, salary,
      999);

    req.flash('success', `Added "${incomeLabel}" line for ${fullName}.`);
    return res.redirect('/payroll/runs/' + run.id);
  } catch (err) {
    console.error('[payroll/runs] add management line:', err);
    req.flash('error', 'Failed to add line: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// POST /payroll/runs/:id/management-lines/:lineId — edit a single line.
// Accepts partial body: any of income_label, salary_amount, super_amount.
router.post('/runs/:id/management-lines/:lineId', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
    if (!assertEditable(req, res, run)) return;
    const line = getManagementLine(db, req.params.id, req.params.lineId);
    if (!line) {
      if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Line not found' });
      req.flash('error', 'Management pay run line not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    const incomeLabel = req.body.income_label != null ? String(req.body.income_label).trim().slice(0, 80) : line.income_label;
    const salary = req.body.salary_amount != null ? round2(toNum(req.body.salary_amount)) : toNum(line.salary_amount);
    const superAmt = req.body.super_amount != null ? round2(toNum(req.body.super_amount)) : toNum(line.super_amount);
    db.prepare(`
      UPDATE pay_run_lines
      SET income_label = ?, salary_amount = ?, super_amount = ?,
          total_wages = ?, grand_total = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(incomeLabel, salary, superAmt, salary, salary, line.id);
    if (req.headers.accept && req.headers.accept.includes('json')) {
      return res.json({ success: true, income_label: incomeLabel, salary_amount: salary, super_amount: superAmt });
    }
    req.flash('success', 'Line updated.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[payroll/runs] edit management line:', err);
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Failed to update line: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// POST /payroll/runs/:id/management-lines/:lineId/delete — drop a line.
router.post('/runs/:id/management-lines/:lineId/delete', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
    if (!assertEditable(req, res, run)) return;
    const line = getManagementLine(db, req.params.id, req.params.lineId);
    if (!line) {
      req.flash('error', 'Management pay run line not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    db.prepare('DELETE FROM pay_run_lines WHERE id = ?').run(line.id);
    req.flash('success', `Removed "${line.income_label || 'line'}" for ${line.full_name}.`);
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[payroll/runs] delete management line:', err);
    req.flash('error', 'Failed to delete line: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// ============================================================================
// Approval workflow:
//   draft → pending_approval → approved → paid
// Anyone with payroll perm can request approval, recall their request, or
// mark a run as paid. Only the configured approver (Saadat) can approve;
// only Saadat or Sajid can unlock a locked run back to draft.
// ============================================================================

// POST /payroll/runs/:id/submit-for-approval — finance asks Saadat to approve
router.post('/runs/:id/submit-for-approval', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (run.status !== 'draft' && run.status !== 'finalized') {
    req.flash('error', `Pay run is already ${statusLabel(run.status).toLowerCase()}.`);
    return res.redirect('/payroll/runs/' + run.id);
  }
  db.prepare(`
    UPDATE pay_runs SET status = 'pending_approval',
      submitted_for_approval_at = CURRENT_TIMESTAMP,
      submitted_by_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.session.user.id, run.id);

  const period = run.label || periodLabel(run.period_start, run.period_end);
  const submitter = req.session.user.full_name || req.session.user.username;
  notifyPayrollUsers(db, getApproverUserIds(db),
    'Pay run ready for approval',
    `${submitter} submitted "${period}" for approval — please review and approve.`,
    '/payroll/runs/' + run.id);

  logActivity({
    user: req.session.user, action: 'submit_for_approval', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: `Submitted pay run for approval: ${period}`, ip: req.ip,
  });
  req.flash('success', 'Sent for approval. Saadat has been notified.');
  res.redirect('/payroll/runs/' + run.id);
});

// POST /payroll/runs/:id/recall — pull back a submission before it's approved
router.post('/runs/:id/recall', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (run.status !== 'pending_approval') {
    req.flash('error', 'Only pending pay runs can be recalled.');
    return res.redirect('/payroll/runs/' + run.id);
  }
  db.prepare(`
    UPDATE pay_runs SET status = 'draft',
      submitted_for_approval_at = NULL,
      submitted_by_id = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(run.id);
  logActivity({
    user: req.session.user, action: 'recall', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: 'Recalled pay run from pending approval', ip: req.ip,
  });
  req.flash('success', 'Recalled. Pay run is back to draft.');
  res.redirect('/payroll/runs/' + run.id);
});

// POST /payroll/runs/:id/approve — Saadat signs off.
// Saadat can approve from either 'draft' (when handling a run himself, no
// finance review needed) or 'pending_approval' (the normal flow where finance
// has flagged the run for sign-off).
router.post('/runs/:id/approve', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  if (!isApprover(db, req.session.user)) {
    req.flash('error', 'Only Saadat can approve pay runs.');
    return res.redirect('/payroll/runs/' + req.params.id);
  }
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (run.status !== 'pending_approval' && run.status !== 'draft' && run.status !== 'finalized') {
    req.flash('error', `Can't approve a ${statusLabel(run.status).toLowerCase()} pay run.`);
    return res.redirect('/payroll/runs/' + run.id);
  }
  db.prepare(`
    UPDATE pay_runs SET status = 'approved',
      approved_at = CURRENT_TIMESTAMP,
      approved_by_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.session.user.id, run.id);

  // Notify the finance team (and the submitter if they aren't on finance) so
  // they can release payment.
  const financeIds = getFinanceUserIds(db, run.submitted_by_id);
  const period = run.label || periodLabel(run.period_start, run.period_end);
  const approver = req.session.user.full_name || req.session.user.username;
  notifyPayrollUsers(db, financeIds,
    'Pay run approved — ready to pay',
    `${approver} approved "${period}". Workers can now be paid.`,
    '/payroll/runs/' + run.id);

  logActivity({
    user: req.session.user, action: 'approve', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: `Approved pay run: ${period}`, ip: req.ip,
  });
  req.flash('success', 'Approved. Finance team has been notified.');
  res.redirect('/payroll/runs/' + run.id);
});

// POST /payroll/runs/:id/unlock — Saadat or Sajid send it back to draft
router.post('/runs/:id/unlock', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  if (!isUnlocker(db, req.session.user)) {
    req.flash('error', 'Only Saadat or Sajid can unlock pay runs.');
    return res.redirect('/payroll/runs/' + req.params.id);
  }
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (!isRunLocked(run)) {
    req.flash('error', 'Pay run is not locked.');
    return res.redirect('/payroll/runs/' + run.id);
  }
  db.prepare(`
    UPDATE pay_runs SET status = 'draft',
      unlocked_at = CURRENT_TIMESTAMP,
      unlocked_by_id = ?,
      submitted_for_approval_at = NULL,
      submitted_by_id = NULL,
      approved_at = NULL,
      approved_by_id = NULL,
      paid_at = NULL,
      paid_by_id = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.session.user.id, run.id);

  const financeIds = getFinanceUserIds(db, run.submitted_by_id);
  const period = run.label || periodLabel(run.period_start, run.period_end);
  const unlocker = req.session.user.full_name || req.session.user.username;
  notifyPayrollUsers(db, financeIds,
    'Pay run unlocked for edits',
    `${unlocker} reopened "${period}" for changes. Re-submit for approval once edits are done.`,
    '/payroll/runs/' + run.id);

  logActivity({
    user: req.session.user, action: 'unlock', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: `Unlocked pay run: ${period}`, ip: req.ip,
  });
  req.flash('success', 'Unlocked — back to draft. Finance team notified.');
  res.redirect('/payroll/runs/' + run.id);
});

// POST /payroll/runs/:id/mark-paid — finance confirms payment went out
router.post('/runs/:id/mark-paid', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found.'); return res.redirect('/payroll/runs'); }
  if (run.status !== 'approved') {
    req.flash('error', 'Only approved pay runs can be marked as paid.');
    return res.redirect('/payroll/runs/' + run.id);
  }
  db.prepare(`
    UPDATE pay_runs SET status = 'paid',
      paid_at = CURRENT_TIMESTAMP,
      paid_by_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.session.user.id, run.id);

  logActivity({
    user: req.session.user, action: 'mark_paid', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: `Marked pay run as paid: ${run.label || periodLabel(run.period_start, run.period_end)}`,
    ip: req.ip,
  });
  req.flash('success', 'Marked as paid.');
  res.redirect('/payroll/runs/' + run.id);
});

// ============================================================================
// POST /payroll/runs/:id/delete
// ============================================================================
router.post('/runs/:id/delete', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) { req.flash('error', 'Pay run not found'); return res.redirect('/payroll/runs'); }
  if (isRunLocked(run)) {
    req.flash('error', `Can't delete a ${statusLabel(run.status).toLowerCase()} pay run — unlock it first.`);
    return res.redirect('/payroll/runs/' + run.id);
  }
  db.prepare('DELETE FROM pay_runs WHERE id = ?').run(run.id);
  if (run.csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, run.csv_filename)); } catch (e) {}
  }
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'pay_run',
    entityId: run.id, entityLabel: run.label,
    details: `Deleted pay run ${run.label}`,
    ip: req.ip,
  });
  req.flash('success', `Pay run ${run.label} removed.`);
  res.redirect('/payroll/runs');
});

// ============================================================================
// GET /payroll/runs/:id/export.xlsx
// ============================================================================
router.get('/runs/:id/export.xlsx', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const run = db.prepare('SELECT * FROM pay_runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).send('Pay run not found');

  const lines = db.prepare(`
    SELECT * FROM pay_run_lines WHERE pay_run_id = ?
    ORDER BY payment_type ASC, LOWER(full_name) ASC
  `).all(run.id);
  for (const l of lines) hydrateLine(l);

  const sectionData = SECTIONS.map(s => ({
    name: s.label, key: s.key, accent: s.accent, bucketKeys: s.buckets, gst: s.key === 'cash',
    lines: lines.filter(l => l.payment_type === s.key),
  }));

  const filename = `PayRun_${(run.label || periodLabel(run.period_start, run.period_end)).replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('xlsx archive error:', err); try { res.end(); } catch (e) {} });
  archive.pipe(res);

  archive.append(buildContentTypes(sectionData), { name: '[Content_Types].xml' });
  archive.append(buildRels(), { name: '_rels/.rels' });
  archive.append(buildWorkbook(sectionData), { name: 'xl/workbook.xml' });
  archive.append(buildWorkbookRels(sectionData), { name: 'xl/_rels/workbook.xml.rels' });
  archive.append(buildStyles(), { name: 'xl/styles.xml' });
  sectionData.forEach((s, idx) => {
    archive.append(buildSheetXml(s, run), { name: `xl/worksheets/sheet${idx + 1}.xml` });
  });
  archive.finalize();
});

// ----- xlsx XML builders (one row per non-zero bucket per worker) ----------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function cellRef(c, r) { return colLetter(c) + r; }

function buildContentTypes(sheets) {
  const overrides = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${overrides}
</Types>`;
}
function buildRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}
function buildWorkbook(sheets) {
  const t = sheets.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${t}</sheets>
</workbook>`;
}
function buildWorkbookRels(sheets) {
  const r = sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  const sId = sheets.length + 1;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${r}
<Relationship Id="rId${sId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}
function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
<fonts count="2">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function buildSheetXml(section, run) {
  const cols = ['First & Last Name', 'BSB / Acc', 'Time', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
    'Total Hours', 'Rate', 'Sub-total', 'Total Wages', 'Travel', 'Meal', 'Other', 'Total Allow.', 'Total'];
  const rows = {};

  // Top corner
  rows[1] = { 1: { v: `Pay run: ${run.label || ''}`, t: 'inlineStr', s: 1 } };
  rows[2] = { 1: { v: `${run.period_start} → ${run.period_end}`, t: 'inlineStr' } };

  // Section heading
  rows[7] = { 1: { v: `${section.name.toUpperCase()} WORKERS`, t: 'inlineStr', s: 1 } };

  // Column headers
  const headerRow = {};
  cols.forEach((c, i) => { if (c) headerRow[i + 1] = { v: c, t: 'inlineStr', s: 3 }; });
  rows[8] = headerRow;

  let r = 9;
  for (const line of section.lines) {
    const buckets = line.buckets || {};
    const activeKeys = section.bucketKeys.filter(k => (buckets[k]?.total_hours || 0) > 0);
    if (activeKeys.length === 0) {
      // Show worker even if no hours, on a single empty row
      activeKeys.push('day_normal');
    }

    activeKeys.forEach((bk, idx) => {
      const b = buckets[bk] || { hours: [0,0,0,0,0,0,0], total_hours: 0, rate: 0, total_wages: 0 };
      const row = {};
      if (idx === 0) {
        row[1] = { v: line.full_name, t: 'inlineStr' };
        row[2] = { v: [line.bsb, line.acc_number].filter(Boolean).join(' / '), t: 'inlineStr' };
      }
      row[3] = { v: BUCKET_LABELS[bk] || bk, t: 'inlineStr' };
      for (let d = 0; d < 7; d++) {
        const h = (b.hours && b.hours[d]) || 0;
        if (h) row[4 + d] = { v: h, t: 'n' };
      }
      row[11] = { v: b.total_hours || 0, t: 'n' };
      row[12] = { v: b.rate || 0, t: 'n', s: 2 };
      row[13] = { v: b.total_wages || 0, t: 'n', s: 2 };
      // Worker totals appear on the LAST row (so it lines up visually)
      if (idx === activeKeys.length - 1) {
        row[14] = { v: line.total_wages || 0, t: 'n', s: 2 };
        row[15] = { v: line.travel_allowance || 0, t: 'n', s: 2 };
        row[16] = { v: line.meal_allowance || 0, t: 'n', s: 2 };
        row[17] = { v: line.other_allowance || 0, t: 'n', s: 2 };
        row[18] = { v: line.total_allowance || 0, t: 'n', s: 2 };
        row[19] = { v: line.grand_total || 0, t: 'n', s: 2 };
      }
      rows[r++] = row;
    });
  }

  // Subtotals
  const totals = section.lines.reduce((acc, l) => {
    acc.total += toNum(l.grand_total); return acc;
  }, { total: 0 });
  r++;
  rows[r++] = { 16: { v: 'Total', t: 'inlineStr', s: 1 }, 19: { v: round2(totals.total), t: 'n', s: 2 } };
  if (section.gst) {
    rows[r++] = { 16: { v: 'GST', t: 'inlineStr', s: 1 }, 19: { v: round2(totals.total * 0.10), t: 'n', s: 2 } };
    rows[r++] = { 16: { v: 'Total + GST', t: 'inlineStr', s: 1 }, 19: { v: round2(totals.total * 1.10), t: 'n', s: 2 } };
  }

  // Render to XML
  let xmlRows = '';
  Object.keys(rows).map(n => parseInt(n, 10)).sort((a, b) => a - b).forEach(rowNum => {
    const row = rows[rowNum];
    const cells = Object.keys(row).map(n => parseInt(n, 10)).sort((a, b) => a - b).map(colNum => {
      const c = row[colNum];
      const ref = cellRef(colNum, rowNum);
      const styleAttr = c.s ? ` s="${c.s}"` : '';
      if (c.t === 'inlineStr') return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t>${xmlEscape(c.v)}</t></is></c>`;
      return `<c r="${ref}"${styleAttr}><v>${c.v}</v></c>`;
    }).join('');
    xmlRows += `<row r="${rowNum}">${cells}</row>`;
  });

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${xmlRows}</sheetData>
</worksheet>`;
}

// ============================================================================
// GET /payroll/rates — section-tabbed bulk rate editor.
//
// Schema-aware: builds the SELECT from columns that actually exist so a
// stale deploy missing one (rate_meal, payroll_bsb, award_classification_id, …)
// renders the page anyway with the missing fields treated as 0/null. Top-
// level try/catch turns any other failure into a flash banner — never a
// generic 500. The matching POST below uses the same pattern.
// ============================================================================
router.get('/rates', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const empCols = new Set(db.prepare("PRAGMA table_info(employees)").all().map(c => c.name));
    const WANT = ['id', 'employee_code', 'full_name', 'payment_type',
      'tier', 'night_pattern',
      'rate_day', 'rate_ot', 'rate_dt',
      'rate_night', 'rate_night_ot', 'rate_night_dt', 'rate_night_5plus',
      'rate_weekend', 'rate_weekend_short', 'rate_public_holiday',
      'rate_meal', 'rate_fares_daily',
      'block_travel_allowance', 'block_meal_allowance', 'rates_overridden',
      'payroll_bsb', 'payroll_account',
      'award_classification_id'];
    const cols = WANT.filter(c => empCols.has(c));
    // id and full_name are required for the page to function. If they're
    // missing the schema is in a state we can't recover from without a
    // proper migration run.
    if (!cols.includes('id') || !cols.includes('full_name')) {
      req.flash('error', 'Employee table is missing core columns — check that migrations have run.');
      return res.redirect('/payroll/runs');
    }
    const activeClause = empCols.has('active') ? 'WHERE active = 1' : '';
    // Pull base_rate_day off the employee's award classification (when set) so the
    // rates table can show "Base $X.XX" under each derived rate column. Schema-aware
    // so a deploy missing migration 161 still renders — base_rate_day just stays null.
    let acHasBase = false;
    try { acHasBase = db.prepare("PRAGMA table_info(award_classifications)").all().some(c => c.name === 'base_rate_day'); } catch (e) {}
    const baseSelect = acHasBase ? ', ac.base_rate_day' : '';
    const baseJoin   = (cols.includes('award_classification_id') && acHasBase)
      ? ' LEFT JOIN award_classifications ac ON ac.id = e.award_classification_id'
      : '';
    const empSelect  = cols.map(c => 'e.' + c).join(', ');
    const employees = db.prepare(`SELECT ${empSelect}${baseSelect} FROM employees e${baseJoin} ${activeClause ? activeClause.replace('WHERE', 'WHERE e.') : ''} ORDER BY LOWER(e.full_name) ASC`).all();

    let classifications = [];
    try {
      classifications = db.prepare(`
        SELECT id, classification, award_name, effective_from
        FROM award_classifications WHERE active = 1
        ORDER BY classification ASC
      `).all();
    } catch (e) { /* table may not exist on a stale deploy */ }

    res.render('payroll-runs/rates', {
      title: 'Worker Rates',
      currentPage: 'pay-runs',
      employees, classifications,
    });
  } catch (err) {
    console.error('[payroll/rates GET] Unhandled error:', err);
    req.flash('error', 'Could not load Worker Rates: ' + (err && err.message ? err.message : 'unknown error'));
    return res.redirect('/payroll/runs');
  }
});

// POST /payroll/rates — bulk update.
//
// Wrapped in a top-level try/catch so any unexpected schema drift on a
// stale deploy (missing column, FK mismatch, anything else) lands as a
// red flash banner instead of an Express 500. Inspect the server log
// for the original error text — it's printed there with a stack trace.
router.post('/rates', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const data = req.body && req.body.rows;
    if (!data || typeof data !== 'object') {
      req.flash('error', 'No rate data submitted.');
      return res.redirect('/payroll/rates');
    }

    // Probe which rate/payroll columns actually exist on this DB. Earlier
    // versions of the schema were missing some of these (rate_meal,
    // rate_fares_daily, rate_public_holiday, payroll_bsb, payroll_account,
    // award_classification_id) and a stale deploy would 500 the whole
    // save the moment we tried to UPDATE a non-existent column. Build the
    // SET clause from the columns that exist so the route works on any
    // deploy generation.
    const empCols = new Set(db.prepare("PRAGMA table_info(employees)").all().map(c => c.name));
    const FIELDS = [
      { col: 'payment_type',            kind: 'pt'    },
      { col: 'tier',                    kind: 'tier'  },
      { col: 'night_pattern',           kind: 'np'    },
      { col: 'award_classification_id', kind: 'cid'   },
      { col: 'rate_day',                kind: 'num'   },
      { col: 'rate_ot',                 kind: 'num'   },
      { col: 'rate_dt',                 kind: 'num'   },
      { col: 'rate_night',              kind: 'num'   },
      { col: 'rate_night_ot',           kind: 'num'   },
      { col: 'rate_night_dt',           kind: 'num'   },
      { col: 'rate_night_5plus',        kind: 'num'   },
      { col: 'rate_weekend',            kind: 'num'   },
      { col: 'rate_weekend_short',      kind: 'num'   },
      { col: 'rate_public_holiday',     kind: 'num'   },
      { col: 'rate_meal',               kind: 'num'   },
      { col: 'rate_fares_daily',        kind: 'num'   },
      { col: 'block_travel_allowance',  kind: 'bool'  },
      { col: 'block_meal_allowance',    kind: 'bool'  },
      { col: 'payroll_bsb',             kind: 'str'   },
      { col: 'payroll_account',         kind: 'str'   },
    ].filter(f => empCols.has(f.col));
    if (FIELDS.length === 0) {
      req.flash('error', 'Rate columns missing from database — migrations may not have run.');
      return res.redirect('/payroll/rates');
    }

    // Pre-validate award_classification_id values so a stale/missing row
    // in the dropdown doesn't trip the foreign-key constraint.
    const validClassIds = new Set();
    try {
      db.prepare("SELECT id FROM award_classifications").all().forEach(r => validClassIds.add(r.id));
    } catch (e) { /* table missing — treat as no valid ids */ }

    const setClause = FIELDS.map(f => `${f.col} = ?`).join(', ') + ', updated_at = CURRENT_TIMESTAMP';
    const stmt = db.prepare(`UPDATE employees SET ${setClause} WHERE id = ?`);

    // Per-row try/catch so one bad employee doesn't take down the whole
    // save. The form posts each row as `rows[emp_<id>][field]`. The
    // `emp_` prefix is critical: without it, qs treats numeric bracket
    // indices as array positions and (for low IDs) compacts the result,
    // throwing away the employee ID entirely.
    let saved = 0;
    const failures = [];
    for (const id of Object.keys(data)) {
      const empId = parseInt(String(id).replace(/^emp_/, ''), 10);
      if (!empId) continue;
      const r = data[id];
      if (!r || typeof r !== 'object') continue;
      try {
        // Meal + travel are TFN-only — zero them on Cash/ABN rows before both
        // the UPDATE and the diverges-from-preset probe below.
        const rowPT = String(r.payment_type || '').toLowerCase();
        if (rowPT !== 'tfn') { r.rate_meal = 0; r.rate_fares_daily = 0; }
        const values = FIELDS.map(f => {
          if (f.kind === 'pt') {
            const pt = String(r.payment_type || '').toLowerCase();
            return ['cash', 'tfn', 'abn'].includes(pt) ? pt : '';
          }
          if (f.kind === 'cid') {
            const cid = parseInt(r.award_classification_id, 10);
            return Number.isFinite(cid) && validClassIds.has(cid) ? cid : null;
          }
          if (f.kind === 'tier') {
            const t = parseInt(r.tier, 10);
            return Number.isFinite(t) && t >= 1 && t <= 6 ? t : null;
          }
          if (f.kind === 'np') {
            const np = String(r.night_pattern || 'occasional').toLowerCase();
            return ['occasional', 'permanent', 'continuous_5plus'].includes(np) ? np : 'occasional';
          }
          if (f.kind === 'bool') return r[f.col] ? 1 : 0;
          if (f.kind === 'num') return toNum(r[f.col]);
          if (f.kind === 'str') return String(r[f.col] || '').trim();
          return null;
        });
        stmt.run(...values, empId);

        // Flag the worker as rate-overridden when the saved rates diverge
        // from the tier preset for (tier, payment_type, night_pattern). This
        // guards a later tier re-stamp from silently clobbering hand edits.
        // Matches the preset (or no tier set) → clears the flag.
        if (empCols.has('rates_overridden')) {
          db.prepare('UPDATE employees SET rates_overridden = ? WHERE id = ?')
            .run(rowDivergesFromPreset(db, r) ? 1 : 0, empId);
        }
        saved++;
      } catch (e) {
        console.error(`[payroll/rates] Failed to save employee ${empId}: ${e.message}`);
        failures.push({ empId, error: e.message });
      }
    }

    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'employee',
        entityLabel: 'rates', details: `Bulk-updated rates for ${saved} employees${failures.length ? ` (${failures.length} failed)` : ''}`,
        ip: req.ip,
      });
    } catch (e) { /* audit log shouldn't block the save */ }

    if (failures.length === 0) {
      req.flash('success', `Saved rates for ${saved} employees.`);
    } else if (saved > 0) {
      req.flash('error', `Saved ${saved} employees, ${failures.length} failed: ${failures.slice(0, 3).map(f => '#' + f.empId).join(', ')}${failures.length > 3 ? '…' : ''}. Check the server log.`);
    } else {
      req.flash('error', `Save failed for all ${failures.length} employees. ${failures[0] ? 'First error: ' + failures[0].error : ''}`);
    }
    return res.redirect('/payroll/rates');
  } catch (err) {
    // Catch-all — turns any unhandled exception (schema drift, FK trip,
    // anything else) into a flash banner instead of a generic 500 page.
    console.error('[payroll/rates] Unhandled error:', err);
    req.flash('error', 'Save failed: ' + (err && err.message ? err.message : 'unknown error') + '. Check the server log.');
    return res.redirect('/payroll/rates');
  }
});

// ============================================================================
// /payroll/wage-tiers — FY26 Internal Wage Panel.
//
//   The six-tier framework (Trainee TC → Site Supervisor) is the canonical
//   source for what a worker on a given payment type gets paid. Each (tier ×
//   payment_type) row in wage_tier_presets stores the full PDF rate card.
//   The Allowances tab holds the global allowance table (fares, meal, first
//   aid, leading hand %, km rates, industry).
//
//   Phase 1: this admin page lets management edit the panel directly. Phase
//   2 will wire tier selection into the Approve modal + employee profile
//   and have the pay-run engine read from these presets.
// ============================================================================
router.get('/wage-tiers', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const presets = db.prepare(`
      SELECT * FROM wage_tier_presets
      WHERE active = 1
      ORDER BY payment_type, tier ASC
    `).all();
    const allowances = db.prepare(`
      SELECT * FROM award_allowances
      WHERE active = 1
      ORDER BY display_order ASC, id ASC
    `).all();

    // Group presets by payment_type for clean tab rendering
    const byType = { cash: [], abn: [], tfn: [] };
    for (const p of presets) {
      if (byType[p.payment_type]) byType[p.payment_type].push(p);
    }

    res.render('payroll-runs/wage-tiers', {
      title: 'Wage Tiers',
      currentPage: 'pay-runs',
      byType,
      allowances,
    });
  } catch (err) {
    console.error('[payroll/wage-tiers GET]', err);
    req.flash('error', 'Could not load Wage Tiers: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs');
  }
});

// POST /payroll/wage-tiers — bulk update tier rates + allowances.
//
//   Body shape:
//     presets[<id>][rate_day]            = number
//     presets[<id>][rate_sat_short]      = number
//     ... etc (per the tab's visible columns)
//     allowances[<id>][amount]           = number
//
//   Schema-aware-ish: only writes columns we know exist on wage_tier_presets.
//   Per-row try/catch so one bad row doesn't tank the whole save.
router.post('/wage-tiers', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const presetData = req.body && req.body.presets;
    const allowanceData = req.body && req.body.allowances;

    const PRESET_COLS = [
      'rate_day', 'rate_sat_short', 'rate_sat_long',
      'rate_sun', 'rate_public_holiday',
      'rate_night', 'rate_night_perm', 'rate_night_5plus',
      'travel_allowance', 'meal_allowance',
    ];
    const setClause = PRESET_COLS.map(c => `${c} = ?`).join(', ') + ', updated_at = CURRENT_TIMESTAMP';
    const updatePreset = db.prepare(`UPDATE wage_tier_presets SET ${setClause} WHERE id = ?`);
    const updateAllowance = db.prepare(`UPDATE award_allowances SET amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`);

    let presetSaved = 0, allowanceSaved = 0;
    const failures = [];

    // IDs are namespaced with `p_` / `a_` prefixes to dodge qs's array-
    // compaction behaviour on numeric bracket keys (the same trap the
    // /payroll/rates route works around with `emp_`). Without the prefix
    // qs reindexes presets[1..18] into a 0-based array and the POST
    // handler ends up writing each row's data to the *previous* DB id.
    if (presetData && typeof presetData === 'object') {
      for (const key of Object.keys(presetData)) {
        const presetId = parseInt(String(key).replace(/^p_/, ''), 10);
        if (!presetId) continue;
        const r = presetData[key];
        if (!r || typeof r !== 'object') continue;
        try {
          const values = PRESET_COLS.map(c => {
            const n = parseFloat(r[c]);
            return Number.isFinite(n) && n >= 0 ? n : 0;
          });
          updatePreset.run(...values, presetId);
          presetSaved++;
        } catch (e) {
          console.error(`[payroll/wage-tiers] preset ${presetId} failed:`, e.message);
          failures.push(`preset #${presetId}`);
        }
      }
    }

    if (allowanceData && typeof allowanceData === 'object') {
      for (const key of Object.keys(allowanceData)) {
        const allowId = parseInt(String(key).replace(/^a_/, ''), 10);
        if (!allowId) continue;
        const r = allowanceData[key];
        if (!r || typeof r !== 'object') continue;
        try {
          const n = parseFloat(r.amount);
          updateAllowance.run(Number.isFinite(n) && n >= 0 ? n : 0, allowId);
          allowanceSaved++;
        } catch (e) {
          console.error(`[payroll/wage-tiers] allowance ${allowId} failed:`, e.message);
          failures.push(`allowance #${allowId}`);
        }
      }
    }

    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'wage_tier_presets',
        entityLabel: 'wage panel',
        details: `Updated ${presetSaved} tier preset(s) and ${allowanceSaved} allowance(s)${failures.length ? ` (failed: ${failures.join(', ')})` : ''}`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block save */ }

    if (failures.length === 0) {
      req.flash('success', `Saved ${presetSaved} tier preset${presetSaved === 1 ? '' : 's'} and ${allowanceSaved} allowance${allowanceSaved === 1 ? '' : 's'}.`);
    } else {
      req.flash('error', `Saved ${presetSaved + allowanceSaved} row(s), ${failures.length} failed: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}.`);
    }
    return res.redirect('/payroll/wage-tiers');
  } catch (err) {
    console.error('[payroll/wage-tiers POST]', err);
    req.flash('error', 'Save failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/wage-tiers');
  }
});

// POST /payroll/rates/bulk-tier — bulk-assign a tier to every worker in a
// given payment_type bucket who currently has no tier set. Per the FY26
// panel's operational rule: "Default all new workers to Tier 2 unless
// documented otherwise" — so calling without a tier param defaults to 2.
router.post('/rates/bulk-tier', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const tier = parseInt(req.body.tier, 10) || 2;
    const pt = String(req.body.payment_type || '').toLowerCase();
    if (tier < 1 || tier > 6) {
      req.flash('error', 'Tier must be between 1 and 6.');
      return res.redirect('/payroll/rates');
    }
    if (!['cash', 'abn', 'tfn'].includes(pt)) {
      req.flash('error', 'Pick a payment type (Cash / ABN / TFN) for the bulk assign.');
      return res.redirect('/payroll/rates');
    }
    // Find every active employee on this payment type with no tier set.
    // tier IS NULL covers both NULL and unset rows.
    const targets = db.prepare(`
      SELECT id, full_name FROM employees
      WHERE active = 1 AND payment_type = ? AND tier IS NULL
        AND COALESCE(deleted_at, '') = ''
    `).all(pt);
    if (targets.length === 0) {
      req.flash('success', `No unassigned ${pt.toUpperCase()} workers to stamp — every active worker on this section already has a tier.`);
      return res.redirect('/payroll/rates');
    }
    const { stampEmployeeRates } = require('../lib/wageTiers');
    let stamped = 0;
    const failures = [];
    for (const t of targets) {
      const r = stampEmployeeRates(db, t.id, tier, pt, { nightPattern: 'occasional' });
      if (r.ok) stamped++;
      else failures.push(t.full_name);
    }
    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'employee',
        entityLabel: 'rates',
        details: `Bulk-stamped ${stamped} ${pt.toUpperCase()} workers to Tier ${tier} from the FY26 panel`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block save */ }
    if (failures.length) {
      req.flash('error', `Stamped ${stamped} workers; ${failures.length} failed: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '…' : ''}`);
    } else {
      req.flash('success', `Defaulted ${stamped} ${pt.toUpperCase()} worker${stamped === 1 ? '' : 's'} to Tier ${tier}. Rates stamped from the wage panel.`);
    }
    return res.redirect('/payroll/rates');
  } catch (e) {
    console.error('[payroll/rates/bulk-tier]', e);
    req.flash('error', `Bulk tier failed: ${e.message}`);
    return res.redirect('/payroll/rates');
  }
});

// GET /payroll/wage-tiers/preset.json — feeds the live preview in the
// Approve modal + the Worker Rates tier dropdown. Returns the preset
// row plus the resolved employee-shape rates so the modal can show
// "Day $X · Night $X · Travel $X" without recomputing client-side.
router.get('/wage-tiers/preset.json', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const { getPreset, getAllowance, mapPresetToEmployeeRates, tierMeta, NIGHT_PATTERNS } = require('../lib/wageTiers');
    const tier = parseInt(req.query.tier, 10);
    const paymentType = String(req.query.payment_type || '').toLowerCase();
    const nightPattern = NIGHT_PATTERNS.includes(String(req.query.night_pattern || '').toLowerCase())
      ? String(req.query.night_pattern).toLowerCase()
      : 'occasional';
    const preset = getPreset(db, tier, paymentType);
    if (!preset) return res.status(404).json({ error: 'No preset for (tier, payment_type).' });
    const fares = getAllowance(db, 'fares_daily');
    const meal  = getAllowance(db, 'meal');
    const rates = mapPresetToEmployeeRates(preset, paymentType, {
      fares: fares ? fares.amount : 0,
      meal:  meal  ? meal.amount  : 0,
    }, { nightPattern });
    res.json({ preset, rates, meta: tierMeta(tier), nightPattern });
  } catch (e) {
    console.error('[payroll/wage-tiers/preset.json]', e);
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// /payroll/income-labels — managed dropdown values for management pay runs
// ============================================================================
router.get('/income-labels', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const labels = db.prepare(`
      SELECT id, label, sort_order, active,
        (SELECT COUNT(*) FROM pay_run_lines WHERE income_label = income_labels.label) AS use_count
      FROM income_labels
      ORDER BY active DESC, sort_order ASC, label ASC
    `).all();
    res.render('payroll-runs/income-labels', {
      title: 'Income Labels',
      currentPage: 'pay-runs',
      labels,
    });
  } catch (err) {
    console.error('[payroll/income-labels GET]', err);
    req.flash('error', 'Could not load income labels: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs');
  }
});

router.post('/income-labels', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const label = String(req.body.label || '').trim().slice(0, 80);
    const sortOrder = parseInt(req.body.sort_order, 10) || 100;
    if (!label) {
      req.flash('error', 'Label is required.');
      return res.redirect('/payroll/income-labels');
    }
    try {
      db.prepare("INSERT INTO income_labels (label, sort_order, active) VALUES (?, ?, 1)").run(label, sortOrder);
      req.flash('success', `Added "${label}".`);
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) req.flash('error', `"${label}" already exists.`);
      else throw e;
    }
    return res.redirect('/payroll/income-labels');
  } catch (err) {
    console.error('[payroll/income-labels POST]', err);
    req.flash('error', 'Could not add label: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/income-labels');
  }
});

router.post('/income-labels/:id', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const existing = db.prepare("SELECT * FROM income_labels WHERE id = ?").get(id);
    if (!existing) { req.flash('error', 'Label not found.'); return res.redirect('/payroll/income-labels'); }
    const updates = [];
    const params = [];
    if (req.body.label !== undefined) {
      const newLabel = String(req.body.label || '').trim().slice(0, 80);
      if (!newLabel) { req.flash('error', 'Label cannot be empty.'); return res.redirect('/payroll/income-labels'); }
      updates.push('label = ?'); params.push(newLabel);
      // Cascade rename to existing pay_run_lines so denormalised data stays consistent
      if (newLabel !== existing.label) {
        db.prepare("UPDATE pay_run_lines SET income_label = ? WHERE income_label = ?").run(newLabel, existing.label);
      }
    }
    if (req.body.sort_order !== undefined) {
      updates.push('sort_order = ?'); params.push(parseInt(req.body.sort_order, 10) || 100);
    }
    if (req.body.active !== undefined) {
      const a = (req.body.active === '1' || req.body.active === 'on' || req.body.active === true) ? 1 : 0;
      updates.push('active = ?'); params.push(a);
    }
    if (updates.length) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(id);
      db.prepare(`UPDATE income_labels SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      req.flash('success', 'Label updated.');
    }
    return res.redirect('/payroll/income-labels');
  } catch (err) {
    console.error('[payroll/income-labels PUT]', err);
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/income-labels');
  }
});

router.post('/income-labels/:id/delete', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const row = db.prepare("SELECT * FROM income_labels WHERE id = ?").get(id);
    if (!row) { req.flash('error', 'Label not found.'); return res.redirect('/payroll/income-labels'); }
    const inUse = db.prepare("SELECT COUNT(*) AS c FROM pay_run_lines WHERE income_label = ?").get(row.label).c;
    if (inUse > 0) {
      req.flash('error', `Cannot delete "${row.label}" — it's used by ${inUse} pay-run line${inUse === 1 ? '' : 's'}. Disable it instead.`);
      return res.redirect('/payroll/income-labels');
    }
    db.prepare("DELETE FROM income_labels WHERE id = ?").run(id);
    req.flash('success', `Deleted "${row.label}".`);
    return res.redirect('/payroll/income-labels');
  } catch (err) {
    console.error('[payroll/income-labels DELETE]', err);
    req.flash('error', 'Delete failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/income-labels');
  }
});

// ============================================================================
// Per-line expenses (Fuel / Tolls / Parking / Other) with optional receipts
// ============================================================================

// Helper — recalc other_allowance + grand_total for a line after expenses change
function recalcOtherAllowanceAndTotals(db, line) {
  const sum = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM pay_run_line_expenses WHERE pay_run_line_id = ?").get(line.id).s;
  const isPH = makeIsPH(loadPHSet(db));
  const merged = Object.assign({}, line, { other_allowance: round2(toNum(sum)) });
  const recomputed = recomputeLine(merged, { isPH });
  const updates = Object.assign({ other_allowance: round2(toNum(sum)) }, recomputed, { updated_at: new Date().toISOString() });
  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]); params.push(line.id);
  db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);
  return updates;
}

function recalcDeductionsAndTotals(db, line) {
  const sum = db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM pay_run_line_deductions WHERE pay_run_line_id = ?").get(line.id).s;
  const isPH = makeIsPH(loadPHSet(db));
  const merged = Object.assign({}, line, { total_deductions: round2(toNum(sum)) });
  const recomputed = recomputeLine(merged, { isPH });
  const updates = Object.assign({ total_deductions: round2(toNum(sum)) }, recomputed, { updated_at: new Date().toISOString() });
  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]); params.push(line.id);
  db.prepare(`UPDATE pay_run_lines SET ${setSql} WHERE id = ?`).run(...params);
  return updates;
}

const { payrollReceiptUpload, payrollReceiptsDir } = require('../middleware/upload');

// POST /payroll/runs/:id/lines/:lineId/expenses — create a new expense.
// Multipart so a receipt file can be attached at create time.
router.post('/runs/:id/lines/:lineId/expenses', requirePermission('payroll'), (req, res) => {
  payrollReceiptUpload.single('receipt')(req, res, (multerErr) => {
    try {
      if (multerErr) {
        if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(400).json({ error: multerErr.message });
        req.flash('error', 'Upload failed: ' + multerErr.message);
        return res.redirect('/payroll/runs/' + req.params.id);
      }
      const db = getDb();
      const run = getRunForLineRoute(db, req.params.id);
      if (!run) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Pay run not found' });
        req.flash('error', 'Pay run not found.');
        return res.redirect('/payroll/runs');
      }
      if (isRunLocked(run)) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        return assertEditable(req, res, run);
      }
      const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
      if (!line) {
        if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
        if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Line not found' });
        req.flash('error', 'Line not found.');
        return res.redirect('/payroll/runs/' + req.params.id);
      }

      const labelRaw = String(req.body.label || 'Fuel').trim().slice(0, 40) || 'Fuel';
      const customLabel = labelRaw === 'Other' ? String(req.body.custom_label || '').trim().slice(0, 80) : null;
      const amount = round2(toNum(req.body.amount));

      let relPath = null, fname = null, mime = null, size = null;
      if (req.file) {
        relPath = path.relative(payrollReceiptsDir, req.file.path).replace(/\\/g, '/');
        fname = req.file.originalname;
        mime = req.file.mimetype;
        size = req.file.size;
      }

      const result = db.prepare(`
        INSERT INTO pay_run_line_expenses (pay_run_line_id, label, custom_label, amount, receipt_path, receipt_filename, mime_type, file_size, uploaded_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(line.id, labelRaw, customLabel, amount, relPath, fname, mime, size,
        (req.session && req.session.user && req.session.user.id) || null);

      recalcOtherAllowanceAndTotals(db, line);

      if (req.xhr || (req.headers.accept || '').includes('json')) {
        const fresh = db.prepare("SELECT * FROM pay_run_line_expenses WHERE id = ?").get(result.lastInsertRowid);
        const lineFresh = db.prepare("SELECT other_allowance, total_allowance, grand_total FROM pay_run_lines WHERE id = ?").get(line.id);
        return res.json({ ok: true, expense: fresh, line: lineFresh });
      }
      req.flash('success', 'Expense added.');
      return res.redirect('/payroll/runs/' + req.params.id);
    } catch (err) {
      console.error('[expenses POST]', err);
      if (req.file) try { fs.unlinkSync(req.file.path); } catch (e) {}
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(500).json({ error: err.message });
      req.flash('error', 'Add expense failed: ' + (err && err.message || 'unknown error'));
      return res.redirect('/payroll/runs/' + req.params.id);
    }
  });
});

// POST /payroll/runs/:id/lines/:lineId/expenses/:expenseId — update label / amount.
// Receipt replacement handled by the create endpoint (delete + create).
router.post('/runs/:id/lines/:lineId/expenses/:expenseId', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Pay run not found' });
      req.flash('error', 'Pay run not found.');
      return res.redirect('/payroll/runs');
    }
    if (!assertEditable(req, res, run)) return;
    const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
    const exp = db.prepare("SELECT * FROM pay_run_line_expenses WHERE id = ? AND pay_run_line_id = ?").get(req.params.expenseId, req.params.lineId);
    if (!line || !exp) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Not found' });
      req.flash('error', 'Expense not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    const updates = [];
    const params = [];
    if (req.body.label !== undefined) {
      const lbl = String(req.body.label || 'Fuel').trim().slice(0, 40) || 'Fuel';
      updates.push('label = ?'); params.push(lbl);
      if (lbl === 'Other') {
        updates.push('custom_label = ?');
        params.push(String(req.body.custom_label || '').trim().slice(0, 80));
      } else {
        updates.push('custom_label = ?'); params.push(null);
      }
    } else if (req.body.custom_label !== undefined) {
      updates.push('custom_label = ?'); params.push(String(req.body.custom_label || '').trim().slice(0, 80));
    }
    if (req.body.amount !== undefined) {
      updates.push('amount = ?'); params.push(round2(toNum(req.body.amount)));
    }
    if (updates.length) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(exp.id);
      db.prepare(`UPDATE pay_run_line_expenses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      recalcOtherAllowanceAndTotals(db, line);
    }
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      const fresh = db.prepare("SELECT * FROM pay_run_line_expenses WHERE id = ?").get(exp.id);
      const lineFresh = db.prepare("SELECT other_allowance, total_allowance, grand_total FROM pay_run_lines WHERE id = ?").get(line.id);
      return res.json({ ok: true, expense: fresh, line: lineFresh });
    }
    req.flash('success', 'Expense updated.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[expenses PUT]', err);
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// POST /payroll/runs/:id/lines/:lineId/expenses/:expenseId/delete
router.post('/runs/:id/lines/:lineId/expenses/:expenseId/delete', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Pay run not found' });
      req.flash('error', 'Pay run not found.');
      return res.redirect('/payroll/runs');
    }
    if (!assertEditable(req, res, run)) return;
    const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
    const exp = db.prepare("SELECT * FROM pay_run_line_expenses WHERE id = ? AND pay_run_line_id = ?").get(req.params.expenseId, req.params.lineId);
    if (!line || !exp) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Not found' });
      req.flash('error', 'Expense not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    if (exp.receipt_path) {
      const abs = path.join(payrollReceiptsDir, exp.receipt_path);
      try { fs.unlinkSync(abs); } catch (e) { /* file may already be gone */ }
    }
    db.prepare("DELETE FROM pay_run_line_expenses WHERE id = ?").run(exp.id);
    recalcOtherAllowanceAndTotals(db, line);
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      const lineFresh = db.prepare("SELECT other_allowance, total_allowance, grand_total FROM pay_run_lines WHERE id = ?").get(line.id);
      return res.json({ ok: true, line: lineFresh });
    }
    req.flash('success', 'Expense removed.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[expenses DELETE]', err);
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Delete failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// GET /payroll/runs/:id/lines/:lineId/expenses/:expenseId/receipt — auth-checked stream
router.get('/runs/:id/lines/:lineId/expenses/:expenseId/receipt', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const exp = db.prepare(`
      SELECT prle.* FROM pay_run_line_expenses prle
      JOIN pay_run_lines prl ON prl.id = prle.pay_run_line_id
      WHERE prle.id = ? AND prl.id = ? AND prl.pay_run_id = ?
    `).get(req.params.expenseId, req.params.lineId, req.params.id);
    if (!exp || !exp.receipt_path) return res.status(404).send('Receipt not found');
    const abs = path.join(payrollReceiptsDir, exp.receipt_path);
    if (!fs.existsSync(abs)) return res.status(404).send('Receipt file missing');
    res.setHeader('Content-Type', exp.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(exp.receipt_filename || 'receipt').replace(/"/g, '')}"`);
    return fs.createReadStream(abs).pipe(res);
  } catch (err) {
    console.error('[expenses receipt GET]', err);
    return res.status(500).send('Error reading receipt');
  }
});

// ============================================================================
// Per-line deductions
// ============================================================================
router.post('/runs/:id/lines/:lineId/deductions', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Pay run not found' });
      req.flash('error', 'Pay run not found.');
      return res.redirect('/payroll/runs');
    }
    if (!assertEditable(req, res, run)) return;
    const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
    if (!line) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Line not found' });
      req.flash('error', 'Line not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    const description = String(req.body.description || '').trim().slice(0, 200);
    const amount = round2(toNum(req.body.amount));
    if (!description) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(400).json({ error: 'Description required' });
      req.flash('error', 'Description is required.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    const result = db.prepare(`
      INSERT INTO pay_run_line_deductions (pay_run_line_id, description, amount, sort_order)
      VALUES (?, ?, ?, ?)
    `).run(line.id, description, amount, parseInt(req.body.sort_order, 10) || 100);
    recalcDeductionsAndTotals(db, line);
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      const fresh = db.prepare("SELECT * FROM pay_run_line_deductions WHERE id = ?").get(result.lastInsertRowid);
      const lineFresh = db.prepare("SELECT total_deductions, grand_total FROM pay_run_lines WHERE id = ?").get(line.id);
      return res.json({ ok: true, deduction: fresh, line: lineFresh });
    }
    req.flash('success', 'Deduction added.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[deductions POST]', err);
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Add deduction failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

router.post('/runs/:id/lines/:lineId/deductions/:dedId', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Pay run not found' });
      req.flash('error', 'Pay run not found.');
      return res.redirect('/payroll/runs');
    }
    if (!assertEditable(req, res, run)) return;
    const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
    const ded = db.prepare("SELECT * FROM pay_run_line_deductions WHERE id = ? AND pay_run_line_id = ?").get(req.params.dedId, req.params.lineId);
    if (!line || !ded) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Not found' });
      req.flash('error', 'Deduction not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    const updates = [];
    const params = [];
    if (req.body.description !== undefined) {
      const desc = String(req.body.description || '').trim().slice(0, 200);
      if (!desc) {
        if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(400).json({ error: 'Description required' });
        req.flash('error', 'Description is required.');
        return res.redirect('/payroll/runs/' + req.params.id);
      }
      updates.push('description = ?'); params.push(desc);
    }
    if (req.body.amount !== undefined) {
      updates.push('amount = ?'); params.push(round2(toNum(req.body.amount)));
    }
    if (updates.length) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      params.push(ded.id);
      db.prepare(`UPDATE pay_run_line_deductions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      recalcDeductionsAndTotals(db, line);
    }
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      const fresh = db.prepare("SELECT * FROM pay_run_line_deductions WHERE id = ?").get(ded.id);
      const lineFresh = db.prepare("SELECT total_deductions, grand_total FROM pay_run_lines WHERE id = ?").get(line.id);
      return res.json({ ok: true, deduction: fresh, line: lineFresh });
    }
    req.flash('success', 'Deduction updated.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[deductions PUT]', err);
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Update failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

router.post('/runs/:id/lines/:lineId/deductions/:dedId/delete', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const run = getRunForLineRoute(db, req.params.id);
    if (!run) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Pay run not found' });
      req.flash('error', 'Pay run not found.');
      return res.redirect('/payroll/runs');
    }
    if (!assertEditable(req, res, run)) return;
    const line = db.prepare('SELECT * FROM pay_run_lines WHERE id = ? AND pay_run_id = ?').get(req.params.lineId, req.params.id);
    const ded = db.prepare("SELECT * FROM pay_run_line_deductions WHERE id = ? AND pay_run_line_id = ?").get(req.params.dedId, req.params.lineId);
    if (!line || !ded) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Not found' });
      req.flash('error', 'Deduction not found.');
      return res.redirect('/payroll/runs/' + req.params.id);
    }
    db.prepare("DELETE FROM pay_run_line_deductions WHERE id = ?").run(ded.id);
    recalcDeductionsAndTotals(db, line);
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      const lineFresh = db.prepare("SELECT total_deductions, grand_total FROM pay_run_lines WHERE id = ?").get(line.id);
      return res.json({ ok: true, line: lineFresh });
    }
    req.flash('success', 'Deduction removed.');
    return res.redirect('/payroll/runs/' + req.params.id);
  } catch (err) {
    console.error('[deductions DELETE]', err);
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(500).json({ error: err.message });
    req.flash('error', 'Delete failed: ' + (err && err.message || 'unknown error'));
    return res.redirect('/payroll/runs/' + req.params.id);
  }
});

// GET /payroll/award-classifications/:id.json — used by the worker rates
// page to auto-fill rate inputs when a TFN worker's classification changes.
router.get('/award-classifications/:id.json', requirePermission('payroll'), (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    // Schema-aware: base_rate_day was added in migration 161, so a stale
    // deploy may not have it yet — probe before selecting.
    const acCols = new Set(db.prepare("PRAGMA table_info(award_classifications)").all().map(c => c.name));
    const baseSelect = acCols.has('base_rate_day') ? 'base_rate_day,' : '';
    const row = db.prepare(`
      SELECT id, classification, award_name,
        ${baseSelect}
        rate_day, rate_day_ot, rate_day_dt,
        rate_night, rate_night_ot, rate_night_dt,
        rate_weekend, rate_public_holiday,
        rate_meal, rate_fares_daily
      FROM award_classifications WHERE id = ?
    `).get(id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // Map column names to the form input keys used in views/payroll-runs/rates.ejs.
    return res.json({
      id: row.id,
      classification: row.classification,
      award_name: row.award_name,
      base_rate_day: row.base_rate_day || null,
      rates: {
        rate_day:            row.rate_day,
        rate_ot:             row.rate_day_ot,
        rate_dt:             row.rate_day_dt,
        rate_night:          row.rate_night,
        rate_night_ot:       row.rate_night_ot,
        rate_night_dt:       row.rate_night_dt,
        rate_weekend:        row.rate_weekend,
        rate_public_holiday: row.rate_public_holiday,
        rate_meal:           row.rate_meal,
        rate_fares_daily:    row.rate_fares_daily,
      },
    });
  } catch (err) {
    console.error('[award-classifications/:id.json]', err);
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// /payroll/award-rates — Fair Work classification rates
// ============================================================================
router.get('/award-rates', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const classifications = db.prepare(`
    SELECT * FROM award_classifications ORDER BY active DESC, classification ASC
  `).all();
  res.render('payroll-runs/award-rates', {
    title: 'Award Rates',
    currentPage: 'pay-runs',
    classifications,
  });
});

router.post('/award-rates', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const id = parseInt(b.id, 10) || null;
  const fields = {
    award_name: String(b.award_name || '').trim(),
    classification: String(b.classification || '').trim(),
    effective_from: /^\d{4}-\d{2}-\d{2}$/.test(b.effective_from || '') ? b.effective_from : '2024-07-01',
    effective_to: /^\d{4}-\d{2}-\d{2}$/.test(b.effective_to || '') ? b.effective_to : null,
    rate_day: toNum(b.rate_day),
    rate_day_ot: toNum(b.rate_day_ot),
    rate_day_dt: toNum(b.rate_day_dt),
    rate_night: toNum(b.rate_night),
    rate_night_ot: toNum(b.rate_night_ot),
    rate_night_dt: toNum(b.rate_night_dt),
    rate_weekend: toNum(b.rate_weekend),
    rate_public_holiday: toNum(b.rate_public_holiday),
    rate_meal: toNum(b.rate_meal),
    rate_fares_daily: toNum(b.rate_fares_daily),
    notes: String(b.notes || '').trim(),
    active: b.active === '0' ? 0 : 1,
  };
  if (!fields.classification) {
    req.flash('error', 'Classification name is required.');
    return res.redirect('/payroll/award-rates');
  }

  if (id) {
    const cols = Object.keys(fields);
    const setSql = cols.map(c => `${c} = ?`).join(', ');
    const params = cols.map(c => fields[c]);
    params.push(id);
    db.prepare(`UPDATE award_classifications SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...params);
    req.flash('success', `Updated ${fields.classification}.`);
  } else {
    const cols = Object.keys(fields);
    const placeholders = cols.map(() => '?').join(', ');
    const params = cols.map(c => fields[c]);
    db.prepare(`INSERT INTO award_classifications (${cols.join(', ')}) VALUES (${placeholders})`).run(...params);
    req.flash('success', `Added ${fields.classification}.`);
  }
  res.redirect('/payroll/award-rates');
});

router.post('/award-rates/:id/delete', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const cls = db.prepare('SELECT * FROM award_classifications WHERE id = ?').get(req.params.id);
  if (!cls) { req.flash('error', 'Classification not found.'); return res.redirect('/payroll/award-rates'); }
  // Soft-delete: set active = 0 (so historical pay runs aren't broken)
  db.prepare('UPDATE award_classifications SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(cls.id);
  req.flash('success', `Deactivated ${cls.classification}.`);
  res.redirect('/payroll/award-rates');
});

// ============================================================================
// /payroll/holidays — public holidays (NSW seeded for 2025–2027)
// ============================================================================
router.get('/holidays', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const holidays = db.prepare('SELECT * FROM public_holidays ORDER BY date ASC').all();
  res.render('payroll-runs/holidays', {
    title: 'Public Holidays',
    currentPage: 'pay-runs',
    holidays,
  });
});

router.post('/holidays', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const date = String(b.date || '').trim();
  const label = String(b.label || '').trim();
  const jurisdiction = String(b.jurisdiction || 'NSW').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !label) {
    req.flash('error', 'Date (YYYY-MM-DD) and label required.');
    return res.redirect('/payroll/holidays');
  }
  try {
    db.prepare('INSERT INTO public_holidays (date, label, jurisdiction) VALUES (?, ?, ?)').run(date, label, jurisdiction);
    req.flash('success', `Added ${label} on ${date}.`);
  } catch (e) {
    req.flash('error', String(e.message).includes('UNIQUE') ? `${date} already exists` : e.message);
  }
  res.redirect('/payroll/holidays');
});

router.post('/holidays/:id/delete', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM public_holidays WHERE id = ?').run(req.params.id);
  req.flash('success', 'Holiday removed.');
  res.redirect('/payroll/holidays');
});

module.exports = router;
