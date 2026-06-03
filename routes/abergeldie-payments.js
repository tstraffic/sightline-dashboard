// /finance/abergeldie — Abergeldie Payment Sheet
//
// Imports a Traffio CSV (Person Dockets OR Person Hours by Client) and keeps
// only the rows where client_name contains "Abergeldie" (case-insensitive,
// substring — "Abergeldie Complex Infrastructure" matches). Each kept row
// becomes a line on the sheet with hours and fee = hours × fee_per_hour.
// The show page groups lines by project_name with per-project subtotals and
// a sheet grand total.
//
// Aim: replace the manual Excel sheet finance currently maintains for billing
// Abergeldie. Same Traffio CSV that drives the pay run can drive this too —
// no double handling.

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
const { parseCsv, inferPeriod } = require('../lib/payroll');

// Pull a value from a row trying multiple column-name variants. Traffio
// switches casing/spacing between exports (Person Dockets uses
// `time_on_date`, Person Hours by Client uses `Date` etc), so we accept any
// of the common shapes.
function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Lenient row → shift normaliser. Unlike lib/payroll's normalizeShift, this
// does NOT require time_on_date — the Abergeldie sheet only needs person +
// project + hours, so an aggregated "Person Hours by Client" export works
// fine even though it has no per-shift date column.
function normaliseAbergeldieRow(row) {
  if (!row) return null;
  const isDeleted = String(row.is_deleted || '').trim() === '1';
  const excluded  = String(row.person_exclude_from_payrun || '').trim() === '1';
  if (isDeleted || excluded) return null;

  const hoursStr = pick(row, ['hours_worked', 'hours', 'total_hours', 'Hours', 'Total Hours']);
  const hours = parseFloat(hoursStr);
  if (!isFinite(hours) || hours <= 0) return null;

  const fullName = pick(row, ['full_name', 'Full Name', 'person_full_name', 'name', 'Name', 'Person']) ||
    ((pick(row, ['first_name', 'First Name']) || '') + ' ' + (pick(row, ['last_name', 'Last Name']) || '')).trim();
  if (!fullName) return null;

  return {
    person_id:        pick(row, ['person_id', 'Person ID', 'employee_reference']),
    full_name:        fullName,
    client_name:      pick(row, ['client_name', 'Client Name', 'client', 'Client']),
    project_name:     pick(row, ['project_name', 'Project Name', 'project', 'Project']),
    job_number:       pick(row, ['job_number', 'Job Number', 'Job #', 'job']),
    booking_id:       pick(row, ['booking_id', 'Booking ID', 'Booking']),
    booking_address:  pick(row, ['booking_address', 'Address', 'address', 'Site Address']),
    date:             pick(row, ['time_on_date', 'shift_date', 'date', 'Date', 'Shift Date']) || null,
    time_on:          pick(row, ['time_on_time', 'time_on', 'start_time', 'Start']),
    time_off:         pick(row, ['time_off_time', 'time_off', 'end_time', 'End']),
    hours,
    notes:            pick(row, ['works_docket_notes', 'notes', 'Notes', 'Comments']),
  };
}

const CLIENT_NAME = 'Abergeldie';
const DEFAULT_FEE_PER_HOUR = 1.50;

// ---------------------------------------------------------------------------
// CSV upload setup — mirrors the pay run import.
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads', 'abergeldie-csv');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '.csv') || '.csv').toLowerCase();
      cb(null, `abergeldie_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtHours(n) {
  return (Math.round((parseFloat(n) || 0) * 100) / 100).toLocaleString('en-AU', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}
function periodLabel(start, end) {
  if (!end) return '';
  const d = new Date(end + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return `WE ${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`;
}
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

// Filter shifts to those for the target client. Case-insensitive substring so
// "Abergeldie Complex Infrastructure" still matches "Abergeldie".
function shiftIsForClient(shift, clientName) {
  if (!shift) return false;
  const target = String(clientName || '').trim().toLowerCase();
  if (!target) return false;
  const got = String(shift.client_name || '').trim().toLowerCase();
  return got.includes(target);
}

// ===========================================================================
// GET /finance/abergeldie — list of all sheets with bottom-row totals.
// Total Fee = sum of every sheet's total_fee.
// Total Ready to Pay = sum of total_fee for sheets where ready_to_pay = 1
//   AND paid = 0 (i.e. waiting on payment, not yet settled).
// Total Paid = sum of total_fee for sheets where paid = 1.
// ===========================================================================
router.get('/abergeldie', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheets = db.prepare(`
    SELECT s.*, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS shift_count,
      (SELECT COALESCE(SUM(hours), 0) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS total_hours,
      (SELECT COALESCE(SUM(fee_total), 0) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS total_fee,
      (SELECT COALESCE(SUM(fee_total), 0) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id AND COALESCE(line_type, 'person') = 'ute') AS ute_fee,
      (SELECT COUNT(*) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id AND COALESCE(line_type, 'person') = 'ute') AS ute_line_count,
      (SELECT COUNT(DISTINCT project_name) FROM abergeldie_payment_sheet_lines WHERE sheet_id = s.id) AS project_count
    FROM abergeldie_payment_sheets s
    LEFT JOIN users u ON u.id = s.created_by_id
    ORDER BY s.period_end DESC, s.id DESC
    LIMIT 200
  `).all();

  let totalFee = 0, totalReady = 0, totalPaid = 0;
  for (const s of sheets) {
    const fee = parseFloat(s.total_fee) || 0;
    totalFee += fee;
    if (s.paid) totalPaid += fee;
    else if (s.ready_to_pay) totalReady += fee;
  }

  res.render('abergeldie-payments/index', {
    title: 'Abergeldie Payment Sheet',
    currentPage: 'abergeldie-payments',
    sheets,
    totals: { fee: round2(totalFee), ready: round2(totalReady), paid: round2(totalPaid) },
    fmtMoney, fmtHours, periodLabel,
    clientName: CLIENT_NAME,
  });
});

// ===========================================================================
// GET /finance/abergeldie/new — upload form
// ===========================================================================
router.get('/abergeldie/new', requirePermission('abergeldie_payments'), (req, res) => {
  res.render('abergeldie-payments/new', {
    title: 'New Abergeldie Payment Sheet',
    currentPage: 'abergeldie-payments',
    clientName: CLIENT_NAME,
    defaultFee: DEFAULT_FEE_PER_HOUR,
  });
});

// ===========================================================================
// POST /finance/abergeldie — create a new sheet from a Traffio CSV
// ===========================================================================
router.post('/abergeldie', requirePermission('abergeldie_payments'), (req, res) => {
  upload.single('csv')(req, res, (err) => {
    if (err) { req.flash('error', err.message); return res.redirect('/finance/abergeldie/new'); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/finance/abergeldie/new'); }

    const db = getDb();
    const feePerHour = round2(req.body.fee_per_hour);
    if (!feePerHour || feePerHour <= 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'Fee per hour must be a positive number.');
      return res.redirect('/finance/abergeldie/new');
    }
    const targetClient = CLIENT_NAME;
    const labelInput = String(req.body.label || '').trim();
    const notes = String(req.body.notes || '').trim();

    let raw;
    try { raw = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/finance/abergeldie/new');
    }

    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'CSV had no data rows.');
      return res.redirect('/finance/abergeldie/new');
    }

    const allShifts = rows.map(normaliseAbergeldieRow).filter(Boolean);
    const matchingShifts = allShifts.filter(s => shiftIsForClient(s, targetClient));
    if (matchingShifts.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      const hint = allShifts.length === 0
        ? `Couldn't read any rows from this CSV — check that it's a Traffio export with a Hours column and a Person/Name column.`
        : `No rows mention "${targetClient}". Total rows read: ${allShifts.length}.`;
      req.flash('error', hint);
      return res.redirect('/finance/abergeldie/new');
    }

    const period = inferPeriod(matchingShifts);
    const label = labelInput || (`${targetClient} — ` + periodLabel(period.period_start, period.period_end));

    let sheetId;
    const tx = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO abergeldie_payment_sheets
          (client_name, period_start, period_end, label, csv_filename, fee_per_hour, notes, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        targetClient, period.period_start, period.period_end, label,
        path.basename(req.file.path), feePerHour, notes,
        req.session.user.id,
      );
      sheetId = r.lastInsertRowid;

      const insertLine = db.prepare(`
        INSERT INTO abergeldie_payment_sheet_lines
          (sheet_id, project_name, job_number, person_id, full_name,
           shift_date, time_on, time_off, hours, fee_per_hour, fee_total,
           booking_address, booking_id, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of matchingShifts) {
        const hrs = round2(s.hours);
        const fee = round2(hrs * feePerHour);
        insertLine.run(
          sheetId,
          (s.project_name || '').trim() || '(no project name)',
          s.job_number || '',
          s.person_id || '',
          s.full_name || '',
          s.date || null,
          s.time_on || '',
          s.time_off || '',
          hrs,
          feePerHour,
          fee,
          s.booking_address || '',
          s.booking_id || '',
          s.notes || '',
        );
      }
    });
    tx();

    logActivity({
      user: req.session.user, action: 'create', entityType: 'abergeldie_payment_sheet',
      entityId: sheetId, entityLabel: label,
      details: `Imported ${matchingShifts.length} shifts (of ${allShifts.length} total) for client "${targetClient}"`,
      ip: req.ip,
    });

    req.flash('success', `Imported ${matchingShifts.length} shifts for ${targetClient} across ${new Set(matchingShifts.map(s => s.project_name || '(none)')).size} project(s).`);
    res.redirect('/finance/abergeldie/' + sheetId);
  });
});

// ===========================================================================
// GET /finance/abergeldie/:id — sheet detail, grouped by project
// ===========================================================================
router.get('/abergeldie/:id', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Payment sheet not found.'); return res.redirect('/finance/abergeldie'); }

  const allLines = db.prepare(`
    SELECT * FROM abergeldie_payment_sheet_lines
    WHERE sheet_id = ?
    ORDER BY line_type ASC, project_name ASC, shift_date ASC, LOWER(full_name) ASC, plate ASC, LOWER(driver_name) ASC
  `).all(sheet.id);

  // Split by line_type then group by project_name. Each project shows its
  // worker shifts and ute rows together so Abergeldie sees the full charge
  // for that project on the email.
  const groupsMap = new Map();
  let grandHours = 0, grandWorkerFee = 0, grandShifts = 0, grandUteFee = 0;
  for (const l of allLines) {
    const key = l.project_name || '(no project name)';
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        project_name: key,
        job_number: l.job_number || '',
        booking_address: l.booking_address || '',
        person_lines: [],
        ute_lines: [],
        total_hours: 0, total_worker_fee: 0,
        total_shifts: 0, total_ute_fee: 0,
      });
    }
    const g = groupsMap.get(key);
    if ((l.line_type || 'person') === 'ute') {
      g.ute_lines.push(l);
      g.total_shifts   += parseInt(l.shift_count, 10) || 0;
      g.total_ute_fee  += parseFloat(l.fee_total)    || 0;
      grandShifts      += parseInt(l.shift_count, 10) || 0;
      grandUteFee      += parseFloat(l.fee_total)    || 0;
    } else {
      g.person_lines.push(l);
      g.total_hours       += parseFloat(l.hours)     || 0;
      g.total_worker_fee  += parseFloat(l.fee_total) || 0;
      grandHours          += parseFloat(l.hours)     || 0;
      grandWorkerFee      += parseFloat(l.fee_total) || 0;
    }
  }
  const groups = Array.from(groupsMap.values()).sort((a, b) => a.project_name.localeCompare(b.project_name));
  // Compute project totals once
  for (const g of groups) {
    g.total_fee = round2(g.total_worker_fee + g.total_ute_fee);
    g.total_worker_fee = round2(g.total_worker_fee);
    g.total_ute_fee = round2(g.total_ute_fee);
    g.total_hours = round2(g.total_hours);
  }

  // Prefill the ute "only rego" box when every existing ute line is the same
  // plate (so a re-upload keeps the same scope without retyping).
  const utePlates = [...new Set(allLines.filter(l => l.line_type === 'ute' && l.plate).map(l => l.plate))];
  const uteOnlyRego = utePlates.length === 1 ? utePlates[0] : '';

  res.render('abergeldie-payments/show', {
    title: sheet.label || 'Abergeldie Payment Sheet',
    currentPage: 'abergeldie-payments',
    sheet, groups, uteOnlyRego,
    grand: {
      hours: round2(grandHours), worker_fee: round2(grandWorkerFee),
      shifts: grandShifts, ute_fee: round2(grandUteFee),
      fee: round2(grandWorkerFee + grandUteFee),
      line_count: allLines.length, project_count: groups.length,
      ute_count: allLines.filter(l => l.line_type === 'ute').length,
    },
    fmtMoney, fmtHours, periodLabel,
  });
});

// ===========================================================================
// POST /finance/abergeldie/:id — edit sheet metadata (label, period dates,
// fee/hr, notes). When fee/hr changes, every line's fee_total is
// recalculated as hours × new fee.
// ===========================================================================
router.post('/abergeldie/:id', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Payment sheet not found.'); return res.redirect('/finance/abergeldie'); }

  const label = String(req.body.label || '').trim().slice(0, 200);
  const periodStart = String(req.body.period_start || '').trim();
  const periodEnd   = String(req.body.period_end || '').trim();
  const feePerHour  = round2(req.body.fee_per_hour);
  const uteRate     = req.body.default_ute_rate_per_shift !== undefined && req.body.default_ute_rate_per_shift !== ''
    ? round2(req.body.default_ute_rate_per_shift)
    : (parseFloat(sheet.default_ute_rate_per_shift) || 0);
  const notes       = String(req.body.notes || '').trim().slice(0, 1000);

  // Both dates required and well-formed; end must be on/after start.
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRe.test(periodStart) || !dateRe.test(periodEnd)) {
    req.flash('error', 'Period start + end dates are required (YYYY-MM-DD).');
    return res.redirect('/finance/abergeldie/' + sheet.id);
  }
  if (periodEnd < periodStart) {
    req.flash('error', 'Period end must be on or after period start.');
    return res.redirect('/finance/abergeldie/' + sheet.id);
  }
  if (!feePerHour || feePerHour <= 0) {
    req.flash('error', 'Fee per hour must be a positive number.');
    return res.redirect('/finance/abergeldie/' + sheet.id);
  }
  if (uteRate < 0) {
    req.flash('error', 'Ute rate must be 0 or more.');
    return res.redirect('/finance/abergeldie/' + sheet.id);
  }

  const feeChanged  = feePerHour !== parseFloat(sheet.fee_per_hour);
  const uteRateChanged = uteRate !== parseFloat(sheet.default_ute_rate_per_shift);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE abergeldie_payment_sheets
      SET label = ?, period_start = ?, period_end = ?, fee_per_hour = ?, default_ute_rate_per_shift = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(label || sheet.label || '', periodStart, periodEnd, feePerHour, uteRate, notes, sheet.id);

    // Recalculate per-line fee on person lines if fee/hr changed
    if (feeChanged) {
      db.prepare(`
        UPDATE abergeldie_payment_sheet_lines
        SET fee_per_hour = ?,
            fee_total = ROUND(hours * ?, 2)
        WHERE sheet_id = ? AND COALESCE(line_type, 'person') = 'person'
      `).run(feePerHour, feePerHour, sheet.id);
    }
    // Recalculate ute lines if ute rate changed
    if (uteRateChanged) {
      db.prepare(`
        UPDATE abergeldie_payment_sheet_lines
        SET rate_per_shift = ?,
            fee_total = ROUND(shift_count * ?, 2)
        WHERE sheet_id = ? AND COALESCE(line_type, 'person') = 'ute'
      `).run(uteRate, uteRate, sheet.id);
    }
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update', entityType: 'abergeldie_payment_sheet',
    entityId: sheet.id, entityLabel: label || sheet.label,
    details: `Updated Abergeldie payment sheet (period ${periodStart}→${periodEnd}, $${feePerHour}/hr, ute $${uteRate}/shift)`,
    ip: req.ip,
  });

  req.flash('success', 'Sheet updated.');
  res.redirect('/finance/abergeldie/' + sheet.id);
});

// ===========================================================================
// POST /finance/abergeldie/:id/ready — toggle ready-to-pay
// POST /finance/abergeldie/:id/paid  — toggle paid
//   Body: { value: '1' | '0' }. Returns JSON for AJAX or redirects on form post.
// ===========================================================================
function makeToggle(field) {
  return (req, res) => {
    const db = getDb();
    const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
    if (!sheet) {
      if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Not found' });
      req.flash('error', 'Payment sheet not found.');
      return res.redirect('/finance/abergeldie');
    }
    const checked = req.body.value === '1' || req.body.value === 'on' || req.body.value === 'true' || req.body.value === 1 || req.body.value === true;
    const atCol = field + '_at';
    const byCol = field + '_by_id';
    db.prepare(`
      UPDATE abergeldie_payment_sheets
      SET ${field} = ?, ${atCol} = ?, ${byCol} = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      checked ? 1 : 0,
      checked ? new Date().toISOString() : null,
      checked ? req.session.user.id : null,
      sheet.id,
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'abergeldie_payment_sheet',
      entityId: sheet.id, entityLabel: sheet.label,
      details: `Set ${field} = ${checked ? 'true' : 'false'} on Abergeldie sheet`,
      ip: req.ip,
    });
    if (req.xhr || (req.headers.accept || '').includes('json')) {
      return res.json({ ok: true, [field]: checked ? 1 : 0 });
    }
    return res.redirect('/finance/abergeldie');
  };
}
router.post('/abergeldie/:id/ready', requirePermission('abergeldie_payments'), makeToggle('ready_to_pay'));
router.post('/abergeldie/:id/paid',  requirePermission('abergeldie_payments'), makeToggle('paid'));

// ===========================================================================
// POST /finance/abergeldie/:id/upload-utes — adds ute lines to an existing
// sheet from a Traffio "Vehicle Job Report" CSV. Skips Cancelled bookings,
// keeps only Abergeldie rows, groups by (plate, driver, project_name) so
// the same plate moving between projects becomes separate billable lines.
// Re-uploading replaces existing ute lines (person lines are untouched).
// ===========================================================================
router.post('/abergeldie/:id/upload-utes', requirePermission('abergeldie_payments'), (req, res) => {
  upload.single('csv')(req, res, (err) => {
    if (err) { req.flash('error', err.message); return res.redirect('/finance/abergeldie/' + req.params.id); }
    if (!req.file) { req.flash('error', 'CSV file is required.'); return res.redirect('/finance/abergeldie/' + req.params.id); }

    const db = getDb();
    const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
    if (!sheet) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'Payment sheet not found.');
      return res.redirect('/finance/abergeldie');
    }
    const rateOverride = req.body.default_ute_rate_per_shift;
    const ratePerShift = rateOverride !== undefined && rateOverride !== ''
      ? round2(rateOverride)
      : (parseFloat(sheet.default_ute_rate_per_shift) || 0);
    // Optional: scope the import to a single vehicle rego (e.g. EUT88J).
    const onlyRego = (req.body.only_rego || '').toUpperCase().replace(/\s+/g, '');
    if (ratePerShift < 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'Rate per shift must be 0 or more.');
      return res.redirect('/finance/abergeldie/' + sheet.id);
    }

    let raw;
    try { raw = fs.readFileSync(req.file.path, 'utf8'); }
    catch (e) {
      req.flash('error', 'Could not read uploaded file: ' + e.message);
      return res.redirect('/finance/abergeldie/' + sheet.id);
    }
    const { rows } = parseCsv(raw);
    if (rows.length === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', 'CSV had no data rows.');
      return res.redirect('/finance/abergeldie/' + sheet.id);
    }

    // Filter to Abergeldie + non-cancelled + has plate, then group.
    const groups = new Map();
    let kept = 0, dropped = 0;
    for (const row of rows) {
      const status = pick(row, ['booking_status_name', 'Booking Status', 'status']).toLowerCase();
      if (status === 'cancelled' || status === 'canceled') { dropped++; continue; }
      const isDeleted = String(row.is_deleted || '').trim() === '1';
      if (isDeleted) { dropped++; continue; }
      const client = pick(row, ['client_name', 'Client Name', 'client', 'Client']);
      if (!/abergeldie/i.test(client)) { dropped++; continue; }
      const plate = pick(row, ['vehicle_rego', 'Vehicle Rego', 'vehicle_registration', 'Vehicle Registration', 'rego', 'Rego', 'plate', 'Plate']).toUpperCase().replace(/\s+/g, '');
      if (!plate) { dropped++; continue; }
      if (onlyRego && plate !== onlyRego) { dropped++; continue; }
      const friendly = pick(row, ['vehicle_friendly_name', 'Vehicle Friendly Name', 'vehicle_resource_name', 'Vehicle Resource Name', 'vehicle_name']);
      const driver = pick(row, ['driver_name', 'Driver Name', 'driver', 'Driver']) || '(no driver)';
      const project = pick(row, ['project_name', 'Project Name', 'project', 'Project']) || '(no project)';
      const jobNumber = pick(row, ['job_number', 'Job Number', 'Job #']);
      const address = pick(row, ['street_address', 'Street Address', 'booking_address', 'address']);

      const key = plate + '||' + driver + '||' + project;
      const existing = groups.get(key);
      if (existing) existing.shift_count += 1;
      else groups.set(key, { plate, driver_name: driver, project_name: project, vehicle_friendly_name: friendly, job_number: jobNumber, booking_address: address, shift_count: 1 });
      kept++;
    }

    if (groups.size === 0) {
      try { fs.unlinkSync(req.file.path); } catch (e) {}
      req.flash('error', `No matching ute rows in the CSV (read ${rows.length}, skipped ${dropped})${onlyRego ? ` for rego ${onlyRego}` : ''}. Check that the file is a Traffio Vehicle Job Report for an Abergeldie project${onlyRego ? `, and that ${onlyRego} appears in it` : ''}.`);
      return res.redirect('/finance/abergeldie/' + sheet.id);
    }

    const tx = db.transaction(() => {
      // Replace existing ute lines (person lines untouched)
      db.prepare("DELETE FROM abergeldie_payment_sheet_lines WHERE sheet_id = ? AND COALESCE(line_type, 'person') = 'ute'").run(sheet.id);
      const insertLine = db.prepare(`
        INSERT INTO abergeldie_payment_sheet_lines
          (sheet_id, line_type, project_name, job_number, booking_address,
           plate, vehicle_friendly_name, driver_name,
           full_name, hours, fee_per_hour,
           shift_count, rate_per_shift, fee_total)
        VALUES (?, 'ute', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
      `);
      for (const g of Array.from(groups.values()).sort((a, b) => a.project_name.localeCompare(b.project_name) || a.plate.localeCompare(b.plate))) {
        const fee = round2(g.shift_count * ratePerShift);
        // Reuse `full_name` for the driver too so existing UI bits that expect it don't break.
        insertLine.run(
          sheet.id, g.project_name, g.job_number, g.booking_address,
          g.plate, g.vehicle_friendly_name, g.driver_name,
          g.driver_name,
          g.shift_count, ratePerShift, fee,
        );
      }
      db.prepare(`
        UPDATE abergeldie_payment_sheets
        SET default_ute_rate_per_shift = ?, utes_csv_filename = ?, utes_uploaded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(ratePerShift, path.basename(req.file.path), sheet.id);
    });
    tx();

    logActivity({
      user: req.session.user, action: 'upload_utes', entityType: 'abergeldie_payment_sheet',
      entityId: sheet.id, entityLabel: sheet.label,
      details: `Imported ${kept} ute rows → ${groups.size} (plate, driver, project) lines @ $${ratePerShift}/shift (skipped ${dropped})`,
      ip: req.ip,
    });

    req.flash('success', `Imported ${kept} ute shifts → ${groups.size} line(s) @ $${ratePerShift}/shift${onlyRego ? ` (rego ${onlyRego} only)` : ''}.`);
    res.redirect('/finance/abergeldie/' + sheet.id);
  });
});

// ===========================================================================
// POST /finance/abergeldie/:id/lines/:lineId — edit a single ute line.
// Accepts shift_count and/or rate_per_shift; recomputes fee_total. Returns
// JSON for AJAX or redirects.
// ===========================================================================
router.post('/abergeldie/:id/lines/:lineId', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const line = db.prepare('SELECT * FROM abergeldie_payment_sheet_lines WHERE id = ? AND sheet_id = ?').get(req.params.lineId, req.params.id);
  if (!line) {
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(404).json({ error: 'Line not found' });
    req.flash('error', 'Line not found.');
    return res.redirect('/finance/abergeldie/' + req.params.id);
  }
  if ((line.line_type || 'person') !== 'ute') {
    if (req.xhr || (req.headers.accept || '').includes('json')) return res.status(400).json({ error: 'Only ute lines are editable here' });
    req.flash('error', 'Only ute lines are editable here.');
    return res.redirect('/finance/abergeldie/' + req.params.id);
  }

  const updates = {};
  if (req.body.shift_count !== undefined)    updates.shift_count    = Math.max(0, parseInt(req.body.shift_count, 10) || 0);
  if (req.body.rate_per_shift !== undefined) updates.rate_per_shift = Math.max(0, round2(req.body.rate_per_shift));
  const newCount = updates.shift_count    != null ? updates.shift_count    : (parseInt(line.shift_count, 10) || 0);
  const newRate  = updates.rate_per_shift != null ? updates.rate_per_shift : (parseFloat(line.rate_per_shift) || 0);
  updates.fee_total = round2(newCount * newRate);

  const cols = Object.keys(updates);
  const setSql = cols.map(c => `${c} = ?`).join(', ');
  const params = cols.map(c => updates[c]);
  params.push(line.id);
  db.prepare(`UPDATE abergeldie_payment_sheet_lines SET ${setSql} WHERE id = ?`).run(...params);

  if (req.xhr || (req.headers.accept || '').includes('json')) {
    const fresh = db.prepare('SELECT * FROM abergeldie_payment_sheet_lines WHERE id = ?').get(line.id);
    return res.json({ ok: true, line: fresh });
  }
  req.flash('success', 'Ute line updated.');
  res.redirect('/finance/abergeldie/' + req.params.id);
});

// ===========================================================================
// POST /finance/abergeldie/:id/clear-utes — delete every ute line on a sheet
// (person lines untouched). Used when finance needs to re-upload from
// scratch or remove utes from a sheet entirely.
// ===========================================================================
router.post('/abergeldie/:id/clear-utes', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Payment sheet not found.'); return res.redirect('/finance/abergeldie'); }
  const result = db.prepare("DELETE FROM abergeldie_payment_sheet_lines WHERE sheet_id = ? AND COALESCE(line_type, 'person') = 'ute'").run(sheet.id);
  if (sheet.utes_csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, sheet.utes_csv_filename)); } catch (e) { /* ignore */ }
    db.prepare("UPDATE abergeldie_payment_sheets SET utes_csv_filename = '', utes_uploaded_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sheet.id);
  }
  req.flash('success', `Removed ${result.changes} ute line(s).`);
  res.redirect('/finance/abergeldie/' + sheet.id);
});

// ===========================================================================
// POST /finance/abergeldie/:id/delete
// ===========================================================================
router.post('/abergeldie/:id/delete', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) { req.flash('error', 'Payment sheet not found.'); return res.redirect('/finance/abergeldie'); }
  db.prepare('DELETE FROM abergeldie_payment_sheets WHERE id = ?').run(sheet.id);
  if (sheet.csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, sheet.csv_filename)); } catch (e) { /* ignore */ }
  }
  if (sheet.utes_csv_filename) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, sheet.utes_csv_filename)); } catch (e) { /* ignore */ }
  }
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'abergeldie_payment_sheet',
    entityId: sheet.id, entityLabel: sheet.label,
    details: `Deleted Abergeldie payment sheet ${sheet.label}`, ip: req.ip,
  });
  req.flash('success', `Deleted ${sheet.label}.`);
  res.redirect('/finance/abergeldie');
});

// ===========================================================================
// GET /finance/abergeldie/:id/export.xlsx — single-sheet xlsx for emailing
// to Abergeldie. One row per shift, grouped by project with subtotal rows
// between groups, and a Sheet Total at the bottom. Built as raw OOXML
// streamed through archiver — no extra dependencies.
// ===========================================================================
router.get('/abergeldie/:id/export.xlsx', requirePermission('abergeldie_payments'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM abergeldie_payment_sheets WHERE id = ?').get(req.params.id);
  if (!sheet) return res.status(404).send('Payment sheet not found');

  const allLines = db.prepare(`
    SELECT * FROM abergeldie_payment_sheet_lines
    WHERE sheet_id = ?
    ORDER BY line_type ASC, project_name ASC, shift_date ASC, LOWER(full_name) ASC, plate ASC
  `).all(sheet.id);

  // Group by project, split person/ute
  const groupsMap = new Map();
  let grandHours = 0, grandWorkerFee = 0, grandShifts = 0, grandUteFee = 0;
  for (const l of allLines) {
    const key = l.project_name || '(no project name)';
    if (!groupsMap.has(key)) groupsMap.set(key, { project_name: key, person_lines: [], ute_lines: [], total_hours: 0, total_worker_fee: 0, total_shifts: 0, total_ute_fee: 0 });
    const g = groupsMap.get(key);
    if ((l.line_type || 'person') === 'ute') {
      g.ute_lines.push(l);
      g.total_shifts  += parseInt(l.shift_count, 10) || 0;
      g.total_ute_fee += parseFloat(l.fee_total) || 0;
      grandShifts     += parseInt(l.shift_count, 10) || 0;
      grandUteFee     += parseFloat(l.fee_total) || 0;
    } else {
      g.person_lines.push(l);
      g.total_hours      += parseFloat(l.hours) || 0;
      g.total_worker_fee += parseFloat(l.fee_total) || 0;
      grandHours         += parseFloat(l.hours) || 0;
      grandWorkerFee     += parseFloat(l.fee_total) || 0;
    }
  }
  const groups = Array.from(groupsMap.values()).sort((a, b) => a.project_name.localeCompare(b.project_name));

  const sheetXml = buildAbergeldieSheetXml({
    sheet, groups,
    grand: {
      hours: round2(grandHours), worker_fee: round2(grandWorkerFee),
      shifts: grandShifts, ute_fee: round2(grandUteFee),
      fee: round2(grandWorkerFee + grandUteFee),
    },
  });

  const filename = `${sheet.client_name || 'Abergeldie'}_${(sheet.label || periodLabel(sheet.period_start, sheet.period_end)).replace(/[^A-Za-z0-9._-]/g, '_')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => { console.error('[abergeldie xlsx]', err); try { res.end(); } catch (e) {} });
  archive.pipe(res);

  archive.append(buildContentTypes(), { name: '[Content_Types].xml' });
  archive.append(buildRels(), { name: '_rels/.rels' });
  archive.append(buildWorkbook(), { name: 'xl/workbook.xml' });
  archive.append(buildWorkbookRels(), { name: 'xl/_rels/workbook.xml.rels' });
  archive.append(buildStyles(), { name: 'xl/styles.xml' });
  archive.append(sheetXml, { name: 'xl/worksheets/sheet1.xml' });
  archive.finalize();
});

// ----- xlsx builders -------------------------------------------------------
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function cellRef(c, r) { return colLetter(c) + r; }

function buildContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;
}
function buildRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}
function buildWorkbook() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Payment Sheet" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}
function buildWorkbookRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}
// Style indexes used in cells:
//   0 = default plain
//   1 = bold
//   2 = currency $#,##0.00 (plain)
//   3 = currency bold
//   4 = bold w/ light grey fill (project header)
//   5 = bold currency w/ light grey fill (project subtotal money)
//   6 = bold w/ accent fill (sheet total)
//   7 = bold currency w/ accent fill (grand total money)
//   8 = number 2dp (hours)
//   9 = number 2dp bold (subtotal hours)
function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
  <numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/>
  <numFmt numFmtId="165" formatCode="0.00"/>
</numFmts>
<fonts count="3">
  <font><sz val="11"/><name val="Calibri"/><color rgb="FF111827"/></font>
  <font><b/><sz val="11"/><name val="Calibri"/><color rgb="FF111827"/></font>
  <font><b/><sz val="12"/><name val="Calibri"/><color rgb="FFFFFFFF"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1D6AE5"/></patternFill></fill>
</fills>
<borders count="2">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border><top style="thin"><color rgb="FF9CA3AF"/></top></border>
</borders>
<cellXfs count="10">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  <xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="164" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
  <xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  <xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
  <xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
  <xf numFmtId="165" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>
</cellXfs>
</styleSheet>`;
}

function buildAbergeldieSheetXml({ sheet, groups, grand }) {
  const rows = [];
  let r = 0;
  // Style helpers
  const rowBuilder = (rowIdx, cells) => {
    const tags = cells.map((cIn, i) => {
      const ref = cellRef(i + 1, rowIdx);
      const c = cIn || {};
      const style = c.s != null ? ` s="${c.s}"` : '';
      if (c.t === 'n') {
        return `<c r="${ref}"${style} t="n"><v>${c.v}</v></c>`;
      }
      if (c.v == null || c.v === '') return `<c r="${ref}"${style}/>`;
      return `<c r="${ref}"${style} t="inlineStr"><is><t>${xmlEscape(c.v)}</t></is></c>`;
    });
    return `<row r="${rowIdx}">${tags.join('')}</row>`;
  };

  // Header: title + period + rates
  r++;
  rows.push(rowBuilder(r, [
    { v: (sheet.label || `${sheet.client_name} Payment Sheet`), s: 1 },
  ]));
  r++;
  rows.push(rowBuilder(r, [
    { v: `Period: ${sheet.period_start || ''} → ${sheet.period_end || ''}` },
    null, null,
    { v: `Fee per hour: $${(parseFloat(sheet.fee_per_hour) || 0).toFixed(2)} · Ute / shift: $${(parseFloat(sheet.default_ute_rate_per_shift) || 0).toFixed(2)}` },
  ]));
  r++; // blank

  // Per-project sections: workers first, then utes (if any), then a project total
  groups.forEach(g => {
    r++;
    rows.push(rowBuilder(r, [
      { v: g.project_name, s: 4 }, { v: '', s: 4 }, { v: '', s: 4 }, { v: '', s: 4 }, { v: '', s: 4 },
    ]));

    // Worker hours block
    if (g.person_lines.length > 0) {
      r++;
      rows.push(rowBuilder(r, [
        { v: 'Worker', s: 1 }, { v: 'Date', s: 1 }, { v: 'Time', s: 1 },
        { v: 'Hours', s: 1 }, { v: 'Fee', s: 1 },
      ]));
      g.person_lines.forEach(l => {
        r++;
        const time = (l.time_on || l.time_off) ? `${l.time_on || ''} → ${l.time_off || ''}` : '';
        rows.push(rowBuilder(r, [
          { v: l.full_name || '' },
          { v: l.shift_date || '' },
          { v: time },
          { t: 'n', v: parseFloat(l.hours) || 0, s: 8 },
          { t: 'n', v: parseFloat(l.fee_total) || 0, s: 2 },
        ]));
      });
      r++;
      rows.push(rowBuilder(r, [
        { v: 'Workers subtotal', s: 4 }, { v: '', s: 4 }, { v: '', s: 4 },
        { t: 'n', v: round2(g.total_hours), s: 9 },
        { t: 'n', v: round2(g.total_worker_fee), s: 5 },
      ]));
    }

    // Ute block
    if (g.ute_lines.length > 0) {
      r++;
      rows.push(rowBuilder(r, [
        { v: 'Plate', s: 1 }, { v: 'Driver', s: 1 }, { v: 'Shifts', s: 1 },
        { v: 'Rate / shift', s: 1 }, { v: 'Fee', s: 1 },
      ]));
      g.ute_lines.forEach(l => {
        r++;
        rows.push(rowBuilder(r, [
          { v: l.plate || '' },
          { v: l.driver_name || '' },
          { t: 'n', v: parseInt(l.shift_count, 10) || 0 },
          { t: 'n', v: parseFloat(l.rate_per_shift) || 0, s: 2 },
          { t: 'n', v: parseFloat(l.fee_total) || 0, s: 2 },
        ]));
      });
      r++;
      rows.push(rowBuilder(r, [
        { v: 'Utes subtotal', s: 4 }, { v: '', s: 4 },
        { t: 'n', v: parseInt(g.total_shifts, 10) || 0, s: 4 },
        { v: '', s: 4 },
        { t: 'n', v: round2(g.total_ute_fee), s: 5 },
      ]));
    }

    // Project total (workers + utes)
    if (g.person_lines.length > 0 && g.ute_lines.length > 0) {
      r++;
      rows.push(rowBuilder(r, [
        { v: 'Project total', s: 4 }, { v: '', s: 4 }, { v: '', s: 4 }, { v: '', s: 4 },
        { t: 'n', v: round2((parseFloat(g.total_worker_fee) || 0) + (parseFloat(g.total_ute_fee) || 0)), s: 5 },
      ]));
    }
    r++; // blank between projects
  });

  // Grand total row
  r++;
  rows.push(rowBuilder(r, [
    { v: 'Sheet total', s: 6 }, { v: '', s: 6 }, { v: '', s: 6 }, { v: '', s: 6 },
    { t: 'n', v: grand.fee, s: 7 },
  ]));

  // Column widths — A worker, B date, C time, D hours, E fee
  const cols = `<cols>
    <col min="1" max="1" width="28" customWidth="1"/>
    <col min="2" max="2" width="12" customWidth="1"/>
    <col min="3" max="3" width="18" customWidth="1"/>
    <col min="4" max="4" width="10" customWidth="1"/>
    <col min="5" max="5" width="14" customWidth="1"/>
  </cols>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${cols}
<sheetData>
${rows.join('\n')}
</sheetData>
</worksheet>`;
}

module.exports = router;
