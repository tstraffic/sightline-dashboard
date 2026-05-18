const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');

// GET /w/hr — HR hub
router.get('/hr', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Find linked employee record
  const employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);

  // Get certifications count
  let certs = [];
  let expiringSoon = 0;
  if (employee) {
    certs = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ? ORDER BY expiry_date ASC').all(employee.id);
    const thirtyDays = new Date();
    thirtyDays.setDate(thirtyDays.getDate() + 30);
    expiringSoon = certs.filter(c => c.expiry_date && new Date(c.expiry_date) <= thirtyDays && new Date(c.expiry_date) >= new Date()).length;
  }

  // Get leave requests
  const leaveRequests = db.prepare('SELECT * FROM employee_leave WHERE crew_member_id = ? ORDER BY created_at DESC LIMIT 10').all(worker.id);
  const pendingLeave = leaveRequests.filter(l => l.status === 'pending').length;

  // Get crew member details
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);

  res.render('worker/hr', {
    title: 'HR & My Info',
    currentPage: 'more',
    employee,
    member,
    certs,
    expiringSoon,
    leaveRequests,
    pendingLeave,
  });
});

// GET /w/hr/certs — My Certifications (worker "wallet")
//
// Surfaces everything the office has on file for this worker:
//   - crew_members.licence_type / licence_expiry (the traffic-control ticket)
//   - employee_competencies rows (structured cert records)
//   - employee_documents rows (uploaded files — licences, white card, RSA,
//     anything attached via the recruitment-registry approval flow OR via
//     manual upload on the crew profile). Both intake paths write into the
//     same employee_documents table, so reading it here makes the wallet a
//     single source of truth.
router.get('/hr/certs', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);

  let certs = [];
  let documents = [];
  if (employee) {
    certs = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ? ORDER BY expiry_date ASC').all(employee.id);
    documents = db.prepare(`
      SELECT id, document_type, document_name, original_name, filename,
             issue_date, expiry_date, verification_status, mandatory, notes, created_at
      FROM employee_documents
      WHERE employee_id = ?
      ORDER BY
        CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
        expiry_date ASC,
        created_at DESC
    `).all(employee.id);
  }

  // Also get crew_member licence info
  const member = db.prepare('SELECT licence_type, licence_expiry, induction_date FROM crew_members WHERE id = ?').get(worker.id);

  // Submitted VOCs for this worker. Drafts are not shown — the wallet
  // only surfaces completed verifications. Both Competent and NYC
  // outcomes appear so the worker can see why they're not certified
  // on a given item.
  const vocs = db.prepare(`
    SELECT a.id, a.voc_number, a.outcome, a.valid_from, a.valid_until,
      a.certificate_status, a.certificate_id, a.pdf_path, a.assessment_date,
      t.name AS equipment_name
    FROM voc_assessments a
    JOIN voc_templates t ON t.id = a.template_id
    WHERE a.crew_member_id = ? AND a.status = 'submitted'
    ORDER BY a.assessment_date DESC, a.id DESC
  `).all(worker.id);

  res.render('worker/hr-certs', {
    title: 'My Wallet',
    currentPage: 'more',
    certs,
    documents,
    member,
    vocs,
  });
});

// GET /w/hr/vocs/:id/pdf — Stream the worker's own VOC certificate PDF.
//
// Worker-scoped: only returns the PDF if the assessment belongs to the
// logged-in crew_member AND outcome=competent AND certificate_status is
// active (revoked certs disappear from the wallet flow). Regenerates the
// PDF on the fly if the file isn't on disk (e.g. fresh deploy).
const certPath = require('path');
const certFs = require('fs');
const { renderVocCertificatePdf } = require('../../lib/pdf/vocCertificatePdf');
const VOC_CERT_DIR = certPath.join(__dirname, '..', '..', 'data', 'uploads', 'voc-certificates');

router.get('/hr/vocs/:id/pdf', async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const a = db.prepare(`
    SELECT a.*, t.name AS template_name, t.default_validity_months,
      cm.full_name AS worker_name, cm.employee_id AS worker_emp_id
    FROM voc_assessments a
    JOIN voc_templates t ON t.id = a.template_id
    JOIN crew_members cm ON cm.id = a.crew_member_id
    WHERE a.id = ? AND a.crew_member_id = ?
      AND a.status = 'submitted' AND a.outcome = 'competent'
      AND COALESCE(a.certificate_status, 'active') = 'active'
  `).get(req.params.id, worker.id);
  if (!a || !a.certificate_id) return res.status(404).send('Certificate not available.');

  // Try the stored path first.
  if (a.pdf_path) {
    const full = certPath.join(VOC_CERT_DIR, certPath.basename(a.pdf_path));
    if (certFs.existsSync(full)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${a.certificate_id}.pdf"`);
      return certFs.createReadStream(full).pipe(res);
    }
  }
  // Regenerate.
  try {
    const base = process.env.APP_BASE_URL || 'https://tstc.up.railway.app';
    const verifyUrl = base.replace(/\/$/, '') + '/voc/verify/' + encodeURIComponent(a.certificate_id);
    const buf = await renderVocCertificatePdf(a, a.certificate_id, verifyUrl);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${a.certificate_id}.pdf"`);
    return res.end(buf);
  } catch (e) {
    console.error('[w-hr-vocs] PDF render failed:', e);
    return res.status(500).send('Failed to render certificate.');
  }
});

// GET /w/hr/documents/:id — Stream a worker's own uploaded document.
//
// Worker-scoped equivalent of the admin /hr/documents/:id/download route.
// The admin route requires the hr_documents permission, so workers can't
// hit it. Here we re-check that the document belongs to the worker's own
// linked employee record before serving the file.
router.get('/hr/documents/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const employee = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  if (!employee) return res.status(404).send('Not found');

  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ? AND employee_id = ?')
    .get(req.params.id, employee.id);
  if (!doc) return res.status(404).send('Not found');

  if (!fs.existsSync(doc.file_path)) return res.status(404).send('File missing');

  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif)$/i.test(doc.original_name || doc.filename);
  const ext = path.extname(doc.original_name || doc.filename).toLowerCase();
  const mimeTypes = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf',
  };
  const mime = mimeTypes[ext] || 'application/octet-stream';

  if (req.query.inline || isImage || ext === '.pdf') {
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${doc.original_name || doc.filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.resolve(doc.file_path));
  }

  res.download(doc.file_path, doc.original_name);
});

// Helper: format a Date using local Y-M-D (avoid toISOString timezone shift)
function localIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Helper: expand a set of options into a flat list of ISO date strings
function expandLeaveDates(body) {
  const out = new Set();
  // Plain array of dates (multi-select)
  if (Array.isArray(body.dates)) {
    body.dates.forEach(d => { if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d); });
  } else if (typeof body.dates === 'string' && body.dates.trim()) {
    // Comma-separated fallback
    body.dates.split(',').forEach(d => { d = d.trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(d)) out.add(d); });
  }

  // Recurring expansion
  const mode = body.mode; // 'single' | 'multiple' | 'recurring'
  if (mode === 'recurring' && body.recur_start && body.recur_until) {
    const [sy, sm, sd] = body.recur_start.split('-').map(Number);
    const [uy, um, ud] = body.recur_until.split('-').map(Number);
    const start = new Date(sy, sm - 1, sd);
    const until = new Date(uy, um - 1, ud);
    if (!isNaN(start) && !isNaN(until) && until >= start) {
      const freq = body.recur_freq || 'weekly'; // weekly | fortnightly | monthly
      const weekdays = []
        .concat(Array.isArray(body.recur_weekdays) ? body.recur_weekdays : body.recur_weekdays ? [body.recur_weekdays] : [])
        .map(x => parseInt(x, 10)).filter(x => !isNaN(x) && x >= 0 && x <= 6);
      let cursor = new Date(start);
      let safety = 0;
      while (cursor <= until && safety < 400) {
        safety++;
        if (freq === 'monthly') {
          out.add(localIso(cursor));
          cursor.setMonth(cursor.getMonth() + 1);
        } else {
          // weekly / fortnightly, with optional weekdays list
          if (weekdays.length > 0) {
            // Add each selected weekday within the current week window
            for (let i = 0; i < 7 && cursor <= until; i++) {
              const d = new Date(cursor); d.setDate(d.getDate() + i);
              if (d > until) break;
              if (weekdays.includes(d.getDay())) out.add(localIso(d));
            }
            cursor.setDate(cursor.getDate() + (freq === 'fortnightly' ? 14 : 7));
          } else {
            out.add(localIso(cursor));
            cursor.setDate(cursor.getDate() + (freq === 'fortnightly' ? 14 : 7));
          }
        }
      }
    }
  }

  // Also accept legacy start_date/end_date range (inclusive)
  if (body.start_date && body.end_date && !out.size) {
    const [sy, sm, sd] = body.start_date.split('-').map(Number);
    const [ey, em, ed] = body.end_date.split('-').map(Number);
    const s = new Date(sy, sm - 1, sd);
    const e = new Date(ey, em - 1, ed);
    if (!isNaN(s) && !isNaN(e) && e >= s) {
      const cur = new Date(s);
      let safety = 0;
      while (cur <= e && safety < 400) { out.add(localIso(cur)); cur.setDate(cur.getDate() + 1); safety++; }
    }
  }

  return Array.from(out).sort();
}

// GET /w/hr/leave — Calendar view of leave
router.get('/hr/leave', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Month to display: ?m=YYYY-MM, default current month
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth(); // 0-indexed
  const m = (req.query.m || '').match(/^(\d{4})-(\d{2})$/);
  if (m) { year = parseInt(m[1], 10); month = parseInt(m[2], 10) - 1; }

  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const monthLabel = first.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);
  const pad = n => String(n).padStart(2, '0');
  const prevM = `${prevMonth.getFullYear()}-${pad(prevMonth.getMonth() + 1)}`;
  const nextM = `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}`;

  // Build grid cells: pad to Monday-start week
  const cells = [];
  const firstWeekday = (first.getDay() + 6) % 7; // 0=Mon
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= last.getDate(); d++) {
    cells.push(`${year}-${pad(month + 1)}-${pad(d)}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  // Load leave records overlapping the month
  const startIso = `${year}-${pad(month + 1)}-01`;
  const endIso = `${year}-${pad(month + 1)}-${pad(last.getDate())}`;
  const leaveRows = db.prepare(`
    SELECT * FROM employee_leave
    WHERE crew_member_id = ? AND status != 'cancelled'
      AND NOT (end_date < ? OR start_date > ?)
    ORDER BY start_date ASC
  `).all(worker.id, startIso, endIso);

  // Expand each row into per-date entries for the current month
  const byDate = {};
  for (const r of leaveRows) {
    const s = new Date(r.start_date + 'T00:00:00');
    const e = new Date(r.end_date + 'T00:00:00');
    for (const cell of cells) {
      if (!cell) continue;
      const cd = new Date(cell + 'T00:00:00');
      if (cd >= s && cd <= e) {
        if (!byDate[cell]) byDate[cell] = [];
        byDate[cell].push({ id: r.id, status: r.status, period: r.shift_period || 'full_day', type: r.leave_type, reason: r.reason });
      }
    }
  }

  // Also load ALL recent leave for history list
  // Pull a wider history (was 30) — the view buckets it into Pending /
  // Upcoming / Recent past / Archived, so we'd rather have the archive
  // tab show real depth than truncate it at the SQL layer.
  const recentLeave = db.prepare('SELECT * FROM employee_leave WHERE crew_member_id = ? ORDER BY start_date DESC LIMIT 100').all(worker.id);

  // Flashes are already exposed via res.locals by workerLocals — DON'T
  // pass them again here, that would consume req.flash() a second time
  // and the empty arrays would override the populated res.locals values.
  res.render('worker/hr-leave', {
    title: 'Leave',
    currentPage: 'leave',
    cells,
    byDate,
    monthLabel,
    prevM,
    nextM,
    currentM: `${year}-${pad(month + 1)}`,
    todayIso: sydneyToday(),
    recentLeave,
  });
});

// POST /w/hr/leave — Submit leave (single/multiple/recurring)
router.post('/hr/leave', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const leaveType = req.body.leave_type || 'annual';
  const shiftPeriod = ['day','night','full_day'].includes(req.body.shift_period) ? req.body.shift_period : 'full_day';
  const reason = req.body.reason || null;

  // Loud trace on every leave submission — if the worker says the form
  // didn't go through we want a server log to confirm whether the
  // handler actually ran.
  console.log('[leave] POST received', {
    worker_id: worker && worker.id,
    worker_name: worker && worker.full_name,
    body_mode: req.body.mode,
    body_dates: req.body.dates,
    body_recur_start: req.body.recur_start,
    body_recur_until: req.body.recur_until,
    body_leave_type: req.body.leave_type,
    body_shift_period: req.body.shift_period,
  });

  const dates = expandLeaveDates(req.body);
  if (dates.length === 0) {
    // Be loud about why this failed so the worker isn't left guessing —
    // log the body shape + redirect with a specific message describing
    // which mode-specific field was blank.
    console.warn('[leave] no dates resolved from body:', {
      mode: req.body.mode, dates: req.body.dates,
      start_date: req.body.start_date, end_date: req.body.end_date,
      recur_start: req.body.recur_start, recur_until: req.body.recur_until,
    });
    let msg = 'Please pick at least one date.';
    if (req.body.mode === 'recurring') msg = 'Pick a start, an end, and at least one weekday for the recurring leave.';
    else if (req.body.mode === 'multiple') msg = 'Add at least one date to the multiple-date list.';
    req.flash('error', msg);
    return res.redirect('/w/hr/leave');
  }

  // Cap at 180 dates as a safety
  const capped = dates.slice(0, 180);
  const employee = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  const empId = employee ? employee.id : null;

  const insert = db.prepare(`
    INSERT INTO employee_leave (employee_id, crew_member_id, leave_type, shift_period, start_date, end_date, total_days, reason, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  let inserted = 0;
  try {
    const tx = db.transaction(() => {
      for (const d of capped) {
        const r = insert.run(empId, worker.id, leaveType, shiftPeriod, d, d, shiftPeriod === 'full_day' ? 1 : 0.5, reason);
        if (r.changes > 0) inserted++;
      }
    });
    tx();
  } catch (e) {
    console.error('[leave] insert failed:', e.message, { worker_id: worker.id, dates: capped });
    req.flash('error', 'Could not save leave: ' + e.message);
    return res.redirect('/w/hr/leave');
  }

  if (inserted === 0) {
    console.warn('[leave] tx ran but inserted 0 rows', { worker_id: worker.id, dates: capped });
    req.flash('error', 'Submission accepted but no rows saved — try again or contact the office.');
    return res.redirect('/w/hr/leave');
  }

  console.log('[leave] submitted', { worker_id: worker.id, count: inserted, dates: capped });
  req.flash('success', inserted === 1 ? 'Leave submitted — pending approval.' : `${inserted} leave days submitted — pending approval.`);
  res.redirect('/w/hr/leave');
});

// POST /w/hr/leave/:id/cancel — Cancel a leave record
router.post('/hr/leave/:id/cancel', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const record = db.prepare('SELECT * FROM employee_leave WHERE id = ? AND crew_member_id = ?').get(req.params.id, worker.id);
  if (!record) { req.flash('error', 'Leave not found.'); return res.redirect('/w/hr/leave'); }
  if (record.status === 'approved') {
    req.flash('error', 'Approved leave cannot be cancelled — contact your supervisor.');
    return res.redirect('/w/hr/leave');
  }
  db.prepare("UPDATE employee_leave SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  req.flash('success', 'Leave cancelled.');
  res.redirect('/w/hr/leave');
});

// ============================================
// PAYSLIPS
// ============================================
const path = require('path');
const fs = require('fs');
const PAYSLIP_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'payroll');

// Load the worker's linked employee id once per request. Returns null if the
// crew_member isn't linked to an employees row — which also means no payslips.
function loadLinkedEmployeeId(workerId) {
  const db = getDb();
  const linked = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ?').get(workerId);
  if (linked) return linked.id;
  const member = db.prepare('SELECT employee_id FROM crew_members WHERE id = ?').get(workerId);
  if (member && member.employee_id) {
    const byCode = db.prepare('SELECT id FROM employees WHERE employee_code = ?').get(member.employee_id);
    if (byCode) return byCode.id;
  }
  return null;
}

// GET /w/hr/payslips — List the worker's own payslips
router.get('/hr/payslips', (req, res) => {
  const db = getDb();
  const empId = loadLinkedEmployeeId(req.session.worker.id);
  if (!empId) {
    return res.render('worker/hr-payslips', {
      title: 'Payslips', currentPage: 'more',
      payslips: [], summary: null, notLinked: true,
      flash_success: req.flash('success'), flash_error: req.flash('error'),
    });
  }
  const payslips = db.prepare(`
    SELECT * FROM payslips WHERE employee_id = ?
    ORDER BY pay_date DESC, id DESC LIMIT 100
  `).all(empId);
  const summary = db.prepare(`
    SELECT
      COALESCE(MAX(ytd_gross), 0) as ytd_gross,
      COALESCE(MAX(ytd_tax), 0) as ytd_tax,
      COALESCE(MAX(ytd_super), 0) as ytd_super,
      COALESCE(MAX(ytd_net), 0) as ytd_net,
      COUNT(*) as total
    FROM payslips WHERE employee_id = ?
  `).get(empId);
  res.render('worker/hr-payslips', {
    title: 'Payslips', currentPage: 'more',
    payslips, summary, notLinked: false,
    flash_success: req.flash('success'), flash_error: req.flash('error'),
  });
});

// GET /w/hr/payslips/:id — Download the worker's own payslip (auth-checked stream)
router.get('/hr/payslips/:id', (req, res) => {
  const db = getDb();
  const empId = loadLinkedEmployeeId(req.session.worker.id);
  if (!empId) return res.status(404).send('Not found');

  const p = db.prepare('SELECT * FROM payslips WHERE id = ? AND employee_id = ?').get(req.params.id, empId);
  if (!p || !p.pdf_filename) return res.status(404).send('Not found');

  const filePath = path.join(PAYSLIP_DIR, `emp_${p.employee_id}`, p.pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing');

  // First-view timestamp (for admin visibility) + always bump view_count
  try {
    if (!p.viewed_at) db.prepare("UPDATE payslips SET viewed_at = datetime('now'), view_count = view_count + 1 WHERE id = ?").run(p.id);
    else db.prepare("UPDATE payslips SET view_count = view_count + 1 WHERE id = ?").run(p.id);
  } catch (e) { /* audit-only */ }

  const downloadName = `Payslip_${p.pay_date}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ============================================
// PAY RUN BREAKDOWN — per-line wage breakdown for the logged-in worker
// Filters out rate categories the worker didn't earn (e.g. Cash workers
// never see DT/Weekend/PH; no travel row if travel_count = 0).
// ============================================
const { BUCKETS: PR_BUCKETS, BUCKET_LABELS: PR_BUCKET_LABELS, safeParseJson: prSafeParseJson } = require('../../lib/payroll');

// Section → bucket whitelist. Mirrors routes/payroll-runs.js SECTIONS.
const SECTION_BUCKETS_WHITELIST = {
  cash: ['day_normal', 'night_normal'],
  tfn:  PR_BUCKETS,
  abn:  ['day_normal', 'day_ot', 'night_normal', 'night_ot', 'weekend'],
  '':   PR_BUCKETS,
};

function fmtMoney(n) {
  const v = parseFloat(n) || 0;
  return v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// GET /w/hr/pay-runs — list of finalized pay-run lines belonging to this worker
router.get('/hr/pay-runs', (req, res) => {
  const db = getDb();
  const empId = loadLinkedEmployeeId(req.session.worker.id);
  if (!empId) {
    return res.render('worker/hr-pay-runs', {
      title: 'Pay breakdown', currentPage: 'more',
      lines: [], notLinked: true,
      flash_success: req.flash('success'), flash_error: req.flash('error'),
    });
  }
  const lines = db.prepare(`
    SELECT prl.id, prl.pay_run_id, prl.payment_type, prl.total_wages,
      prl.travel_allowance, prl.meal_allowance, prl.other_allowance,
      prl.total_allowance, prl.total_deductions, prl.grand_total, prl.paid,
      pr.period_start, pr.period_end, pr.label, pr.status,
      COALESCE(pr.pay_run_type, 'traffic_control') AS pay_run_type
    FROM pay_run_lines prl
    JOIN pay_runs pr ON pr.id = prl.pay_run_id
    WHERE prl.employee_id = ? AND pr.status = 'finalized'
    ORDER BY pr.period_end DESC, prl.id DESC
    LIMIT 50
  `).all(empId);
  res.render('worker/hr-pay-runs', {
    title: 'Pay breakdown', currentPage: 'more',
    lines, notLinked: false, fmtMoney,
    flash_success: req.flash('success'), flash_error: req.flash('error'),
  });
});

// GET /w/hr/pay-runs/:lineId — filtered breakdown for one line
router.get('/hr/pay-runs/:lineId', (req, res) => {
  const db = getDb();
  const empId = loadLinkedEmployeeId(req.session.worker.id);
  if (!empId) return res.status(404).send('Not linked');
  const line = db.prepare(`
    SELECT prl.*, pr.period_start, pr.period_end, pr.label, pr.status,
      COALESCE(pr.pay_run_type, 'traffic_control') AS pay_run_type
    FROM pay_run_lines prl
    JOIN pay_runs pr ON pr.id = prl.pay_run_id
    WHERE prl.id = ? AND prl.employee_id = ? AND pr.status = 'finalized'
  `).get(req.params.lineId, empId);
  if (!line) return res.status(404).send('Pay-run line not found');

  // Hydrate buckets from JSON (fallback to legacy columns)
  let buckets = prSafeParseJson(line.buckets_json, null);
  if (!buckets) buckets = {};

  // Apply filter rule 1: only buckets the worker's section allows AND total_hours > 0
  const allowedSection = SECTION_BUCKETS_WHITELIST[line.payment_type || ''] || PR_BUCKETS;
  const visibleBuckets = [];
  for (const k of allowedSection) {
    const b = buckets[k];
    if (!b) continue;
    const hrs = parseFloat(b.total_hours) || 0;
    if (hrs > 0) {
      visibleBuckets.push({
        key: k,
        label: PR_BUCKET_LABELS[k] || k,
        total_hours: hrs,
        rate: parseFloat(b.rate) || 0,
        total_wages: parseFloat(b.total_wages) || 0,
      });
    }
  }

  // Allowances — only show if this worker actually earned them
  const showTravel = (parseInt(line.travel_count, 10) || 0) > 0 || parseFloat(line.travel_allowance) > 0;
  const showMeal   = (parseInt(line.meal_count, 10)   || 0) > 0 || parseFloat(line.meal_allowance) > 0;

  // Expense items
  let expenses = [];
  try {
    expenses = db.prepare("SELECT id, label, custom_label, amount FROM pay_run_line_expenses WHERE pay_run_line_id = ? ORDER BY id ASC").all(line.id);
  } catch (e) { /* table may not exist */ }

  // Deductions
  let deductions = [];
  try {
    deductions = db.prepare("SELECT id, description, amount FROM pay_run_line_deductions WHERE pay_run_line_id = ? ORDER BY sort_order ASC, id ASC").all(line.id);
  } catch (e) { /* table may not exist */ }

  res.render('worker/hr-pay-run-detail', {
    title: 'Pay breakdown', currentPage: 'more',
    line, visibleBuckets, showTravel, showMeal, expenses, deductions, fmtMoney,
    flash_success: req.flash('success'), flash_error: req.flash('error'),
  });
});

module.exports = router;
