const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

// ---- CSV Helpers ----
function escapeCsv(val) {
  if (val == null) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCsv(columns, rows) {
  const headers = columns.map(c => c.label);
  const keys = columns.map(c => c.key);
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) {
    lines.push(keys.map(k => escapeCsv(typeof k === 'function' ? k(row) : row[k])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n'); // BOM for Excel
}

function sendCsv(res, req, filename, columns, rows, entityType) {
  const csv = toCsv(columns, rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  logActivity({ user: req.session.user, action: 'download', entityType, details: `Exported ${filename} (${rows.length} rows)`, ip: req.ip });
  res.send(csv);
}

// ---- JOBS CSV ----
router.get('/jobs.csv', (req, res) => {
  const db = getDb();
  const { status, search, suburb } = req.query;
  let query = `SELECT j.*, u.full_name as pm_name, bm.budget_contract, bm.total_spent as budget_spent FROM jobs j LEFT JOIN users u ON j.project_manager_id = u.id LEFT JOIN (SELECT b.job_id, b.contract_value as budget_contract, COALESCE((SELECT SUM(amount) FROM cost_entries ce WHERE ce.job_id = b.job_id), 0) as total_spent FROM job_budgets b) bm ON j.id = bm.job_id WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { query += ` AND j.status = ?`; params.push(status); }
  if (search) { query += ` AND (j.job_number LIKE ? OR j.client LIKE ? OR j.suburb LIKE ? OR j.job_name LIKE ?)`; const s = `%${search}%`; params.push(s, s, s, s); }
  if (suburb && suburb !== 'all') { query += ` AND j.suburb = ?`; params.push(suburb); }
  query += ` ORDER BY j.job_number`;
  const rows = db.prepare(query).all(...params);

  sendCsv(res, req, 'jobs-export.csv', [
    { key: 'job_number', label: 'Job #' },
    { key: 'job_name', label: 'Job Name' },
    { key: 'client', label: 'Client' },
    { key: 'site_address', label: 'Site Address' },
    { key: 'suburb', label: 'Suburb' },
    { key: 'status', label: 'Status' },
    { key: 'stage', label: 'Stage' },
    { key: 'percent_complete', label: '% Complete' },
    { key: 'start_date', label: 'Start Date' },
    { key: 'end_date', label: 'End Date' },
    { key: 'health', label: 'Health' },
    { key: 'pm_name', label: 'Project Manager' },
    { key: 'budget_contract', label: 'Contract Value' },
    { key: 'budget_spent', label: 'Total Spent' },
    { key: (r) => r.budget_contract > 0 ? (((r.budget_contract - (r.budget_spent || 0)) / r.budget_contract) * 100).toFixed(1) + '%' : '', label: 'Margin %' },
  ], rows, 'job');
});

// ---- TIMESHEETS CSV ----
router.get('/timesheets.csv', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('t.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.crew_member_id) { where.push('t.crew_member_id = ?'); params.push(req.query.crew_member_id); }
  if (req.query.work_date) { where.push('t.work_date = ?'); params.push(req.query.work_date); }
  if (req.query.approved === '0') { where.push('t.approved = 0'); }
  if (req.query.approved === '1') { where.push('t.approved = 1'); }
  if (req.query.week_of) {
    const d = new Date(req.query.week_of);
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    where.push('t.work_date BETWEEN ? AND ?');
    params.push(monday.toISOString().split('T')[0], sunday.toISOString().split('T')[0]);
  }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT t.*, c.full_name as crew_name, c.role as crew_role, j.job_number, j.client, u.full_name as submitted_by_name, a.full_name as approved_by_name
    FROM timesheets t JOIN crew_members c ON t.crew_member_id = c.id JOIN jobs j ON t.job_id = j.id JOIN users u ON t.submitted_by_id = u.id LEFT JOIN users a ON t.approved_by_id = a.id
    ${whereClause} ORDER BY t.work_date DESC, c.full_name ASC
  `).all(...params);

  sendCsv(res, req, 'timesheets-export.csv', [
    { key: 'work_date', label: 'Date' },
    { key: 'crew_name', label: 'Crew Member' },
    { key: 'crew_role', label: 'Role' },
    { key: 'job_number', label: 'Job #' },
    { key: 'client', label: 'Client' },
    { key: 'start_time', label: 'Start' },
    { key: 'end_time', label: 'End' },
    { key: 'break_minutes', label: 'Break (min)' },
    { key: 'total_hours', label: 'Hours' },
    { key: 'shift_type', label: 'Shift' },
    { key: 'role_on_site', label: 'Role on Site' },
    { key: (r) => r.approved ? 'Yes' : 'No', label: 'Approved' },
    { key: 'approved_by_name', label: 'Approved By' },
    { key: 'notes', label: 'Notes' },
  ], rows, 'timesheet');
});

// ---- TIMESHEET SUMMARY CSV ----
router.get('/timesheet-summary.csv', (req, res) => {
  const db = getDb();
  const weekOf = req.query.week_of || new Date().toISOString().split('T')[0];
  const d = new Date(weekOf);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const monStr = monday.toISOString().split('T')[0];
  const sunStr = sunday.toISOString().split('T')[0];

  const rows = db.prepare(`
    SELECT c.full_name, SUM(t.total_hours) as total_hours, COUNT(t.id) as entry_count,
      SUM(CASE WHEN t.approved = 1 THEN 1 ELSE 0 END) as approved_count,
      GROUP_CONCAT(DISTINCT j.job_number) as jobs_worked
    FROM timesheets t JOIN crew_members c ON t.crew_member_id = c.id JOIN jobs j ON t.job_id = j.id
    WHERE t.work_date BETWEEN ? AND ? GROUP BY c.id ORDER BY c.full_name
  `).all(monStr, sunStr);

  sendCsv(res, req, `timesheet-summary-${monStr}.csv`, [
    { key: 'full_name', label: 'Crew Member' },
    { key: (r) => (r.total_hours || 0).toFixed(1), label: 'Total Hours' },
    { key: 'entry_count', label: 'Entries' },
    { key: 'approved_count', label: 'Approved' },
    { key: 'jobs_worked', label: 'Jobs Worked' },
  ], rows, 'timesheet');
});

// ---- INCIDENTS CSV ----
router.get('/incidents.csv', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('i.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.incident_type) { where.push('i.incident_type = ?'); params.push(req.query.incident_type); }
  if (req.query.severity) { where.push('i.severity = ?'); params.push(req.query.severity); }
  if (req.query.status) { where.push('i.investigation_status = ?'); params.push(req.query.status); }
  if (req.query.date_from) { where.push('i.incident_date >= ?'); params.push(req.query.date_from); }
  if (req.query.date_to) { where.push('i.incident_date <= ?'); params.push(req.query.date_to); }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT i.*, j.job_number, j.client, u.full_name as reported_by_name
    FROM incidents i JOIN jobs j ON i.job_id = j.id JOIN users u ON i.reported_by_id = u.id
    ${whereClause} ORDER BY i.incident_date DESC
  `).all(...params);

  sendCsv(res, req, 'incidents-export.csv', [
    { key: 'incident_number', label: 'Incident #' },
    { key: 'incident_date', label: 'Date' },
    { key: 'incident_type', label: 'Type' },
    { key: 'severity', label: 'Severity' },
    { key: 'title', label: 'Title' },
    { key: 'location', label: 'Location' },
    { key: 'job_number', label: 'Job #' },
    { key: 'client', label: 'Client' },
    { key: 'reported_by_name', label: 'Reported By' },
    { key: 'investigation_status', label: 'Status' },
    { key: (r) => r.notifiable_incident ? 'Yes' : 'No', label: 'Notifiable' },
    { key: 'description', label: 'Description' },
  ], rows, 'incident');
});

// ---- COMPLIANCE CSV ----
router.get('/compliance.csv', (req, res) => {
  const db = getDb();
  const { status, job_id, item_type } = req.query;
  let query = `SELECT c.*, j.job_number, j.client, u.full_name as approver_name FROM compliance c JOIN jobs j ON c.job_id = j.id LEFT JOIN users u ON c.internal_approver_id = u.id WHERE 1=1`;
  const params = [];
  if (status && status !== 'all') { query += ` AND c.status = ?`; params.push(status); }
  if (job_id) { query += ` AND c.job_id = ?`; params.push(job_id); }
  if (item_type && item_type !== 'all') { query += ` AND c.item_type = ?`; params.push(item_type); }
  query += ` ORDER BY c.due_date ASC`;
  const rows = db.prepare(query).all(...params);

  sendCsv(res, req, 'compliance-export.csv', [
    { key: 'title', label: 'Title' },
    { key: 'item_type', label: 'Type' },
    { key: 'job_number', label: 'Job #' },
    { key: 'client', label: 'Client' },
    { key: 'status', label: 'Status' },
    { key: 'due_date', label: 'Due Date' },
    { key: 'submitted_date', label: 'Submitted' },
    { key: 'approved_date', label: 'Approved' },
    { key: 'expiry_date', label: 'Expiry' },
    { key: 'authority_approver', label: 'Authority' },
    { key: 'approver_name', label: 'Internal Approver' },
    { key: 'notes', label: 'Notes' },
  ], rows, 'compliance');
});

// ---- EQUIPMENT CSV ----
router.get('/equipment.csv', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.category) { where.push('e.category = ?'); params.push(req.query.category); }
  if (req.query.condition) { where.push('e.current_condition = ?'); params.push(req.query.condition); }
  if (req.query.search) { where.push("(e.name LIKE ? OR e.asset_number LIKE ? OR e.serial_number LIKE ?)"); const s = `%${req.query.search}%`; params.push(s, s, s); }
  if (req.query.active !== '0') { where.push('e.active = 1'); }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT e.*,
      (SELECT j.job_number FROM equipment_assignments ea2 JOIN jobs j ON ea2.job_id = j.id WHERE ea2.equipment_id = e.id AND ea2.actual_return_date IS NULL ORDER BY ea2.assigned_date DESC LIMIT 1) as deployed_to_job
    FROM equipment e ${whereClause} ORDER BY e.category, e.name
  `).all(...params);

  sendCsv(res, req, 'equipment-export.csv', [
    { key: 'asset_number', label: 'Asset #' },
    { key: 'name', label: 'Name' },
    { key: 'category', label: 'Category' },
    { key: 'serial_number', label: 'Serial #' },
    { key: 'registration', label: 'Registration' },
    { key: 'current_condition', label: 'Condition' },
    { key: 'storage_location', label: 'Storage Location' },
    { key: 'deployed_to_job', label: 'Deployed To' },
    { key: 'next_inspection_date', label: 'Next Inspection' },
    { key: 'purchase_date', label: 'Purchase Date' },
    { key: 'purchase_cost', label: 'Purchase Cost' },
  ], rows, 'equipment');
});

// ---- ALLOCATIONS CSV ----
router.get('/allocations.csv', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const fromDate = req.query.from_date || today;
  const toDate = req.query.to_date || today;

  const rows = db.prepare(`
    SELECT ca.*, cm.full_name, cm.role, cm.tcp_level, j.job_number, j.client
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.allocation_date BETWEEN ? AND ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date, j.job_number, cm.full_name
  `).all(fromDate, toDate);

  sendCsv(res, req, `allocations-${fromDate}-to-${toDate}.csv`, [
    { key: 'allocation_date', label: 'Date' },
    { key: 'full_name', label: 'Crew Member' },
    { key: 'role', label: 'Role' },
    { key: 'tcp_level', label: 'TC Level' },
    { key: 'job_number', label: 'Job #' },
    { key: 'client', label: 'Client' },
    { key: 'start_time', label: 'Start' },
    { key: 'end_time', label: 'End' },
    { key: 'shift_type', label: 'Shift' },
    { key: 'role_on_site', label: 'Role on Site' },
    { key: 'status', label: 'Status' },
    { key: 'notes', label: 'Notes' },
  ], rows, 'crew_allocation');
});

// ---- BUDGETS CSV (management/accounts only) ----
router.get('/budgets.csv', (req, res) => {
  if (!canViewAccounts(req.session.user)) {
    req.flash('error', 'Access denied');
    return req.session.save(() => res.redirect('/dashboard'));
  }
  const db = getDb();
  const rows = db.prepare(`
    SELECT j.job_number, j.client, j.status,
      b.contract_value, b.variations_approved,
      (b.budget_labour + b.budget_materials + b.budget_subcontractors + b.budget_equipment + b.budget_other + COALESCE(b.budget_contingency, 0)) as total_budget,
      COALESCE((SELECT SUM(amount) FROM cost_entries ce WHERE ce.job_id = j.id), 0) as total_spent
    FROM jobs j LEFT JOIN job_budgets b ON j.id = b.job_id
    WHERE j.status IN ('active', 'on_hold', 'won', 'completed')
    ORDER BY j.job_number
  `).all();

  sendCsv(res, req, 'budgets-export.csv', [
    { key: 'job_number', label: 'Job #' },
    { key: 'client', label: 'Client' },
    { key: 'status', label: 'Status' },
    { key: 'contract_value', label: 'Contract Value' },
    { key: 'variations_approved', label: 'Variations' },
    { key: 'total_budget', label: 'Total Budget' },
    { key: 'total_spent', label: 'Total Spent' },
    { key: (r) => ((r.total_budget || 0) - (r.total_spent || 0)).toFixed(2), label: 'Remaining' },
    { key: (r) => r.contract_value > 0 ? (((r.contract_value - (r.total_spent || 0)) / r.contract_value) * 100).toFixed(1) + '%' : '', label: 'Margin %' },
  ], rows, 'budget');
});

// ---- COST ENTRIES CSV (per job, management/accounts only) ----
router.get('/cost-entries.csv', (req, res) => {
  if (!canViewAccounts(req.session.user)) {
    req.flash('error', 'Access denied');
    return req.session.save(() => res.redirect('/dashboard'));
  }
  const db = getDb();
  const jobId = req.query.job_id;
  if (!jobId) { req.flash('error', 'Job ID required'); return req.session.save(() => res.redirect('/budgets')); }

  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(jobId);
  const rows = db.prepare(`
    SELECT ce.*, u.full_name as entered_by_name
    FROM cost_entries ce JOIN users u ON ce.entered_by_id = u.id
    WHERE ce.job_id = ? ORDER BY ce.entry_date DESC
  `).all(jobId);

  sendCsv(res, req, `cost-entries-${job ? job.job_number : jobId}.csv`, [
    { key: 'entry_date', label: 'Date' },
    { key: 'category', label: 'Category' },
    { key: 'description', label: 'Description' },
    { key: 'amount', label: 'Amount' },
    { key: 'invoice_ref', label: 'Invoice Ref' },
    { key: 'supplier', label: 'Supplier' },
    { key: 'entered_by_name', label: 'Entered By' },
    { key: 'receipt_url', label: 'Receipt URL' },
  ], rows, 'cost_entry');
});

// ---- JOB SUMMARY PDF ----
router.get('/job-report.pdf', (req, res) => {
  const db = getDb();
  const jobId = req.query.job_id;
  if (!jobId) { req.flash('error', 'Job ID required'); return req.session.save(() => res.redirect('/jobs')); }

  const job = db.prepare('SELECT j.*, u.full_name as pm_name FROM jobs j LEFT JOIN users u ON j.project_manager_id = u.id WHERE j.id = ?').get(jobId);
  if (!job) { req.flash('error', 'Job not found'); return req.session.save(() => res.redirect('/jobs')); }

  const budget = db.prepare('SELECT * FROM job_budgets WHERE job_id = ?').get(jobId);
  const totalSpent = db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM cost_entries WHERE job_id = ?').get(jobId).total;
  const timesheets = db.prepare(`
    SELECT t.work_date, c.full_name, t.total_hours, t.shift_type, j.job_number
    FROM timesheets t JOIN crew_members c ON t.crew_member_id = c.id JOIN jobs j ON t.job_id = j.id
    WHERE t.job_id = ? ORDER BY t.work_date DESC LIMIT 20
  `).all(jobId);
  const equipAssignments = db.prepare(`
    SELECT e.name, e.asset_number, ea.assigned_date, ea.expected_return_date
    FROM equipment_assignments ea JOIN equipment e ON ea.equipment_id = e.id
    WHERE ea.job_id = ? AND ea.actual_return_date IS NULL ORDER BY ea.assigned_date
  `).all(jobId);
  const compliance = db.prepare(`
    SELECT title, item_type, status, due_date FROM compliance
    WHERE job_id = ? AND status NOT IN ('approved','expired') ORDER BY due_date
  `).all(jobId);

  // Build PDF
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="job-report-${job.job_number}.pdf"`);
  doc.pipe(res);

  // Header
  doc.fontSize(20).font('Helvetica-Bold').text('T&S Traffic Control', { align: 'center' });
  doc.fontSize(14).font('Helvetica').text('Job Summary Report', { align: 'center' });
  doc.fontSize(9).fillColor('#666').text(`Generated ${new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' })}`, { align: 'center' });
  doc.moveDown(1.5);

  // Job Details
  doc.fillColor('#000').fontSize(13).font('Helvetica-Bold').text('Job Details');
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
  doc.moveDown(0.5);
  doc.fontSize(10).font('Helvetica');
  const details = [
    ['Job Number', job.job_number], ['Client', job.client],
    ['Site', job.site_address + ', ' + job.suburb], ['Status', job.status + ' / ' + job.stage],
    ['Dates', (job.start_date || 'N/A') + ' to ' + (job.end_date || 'TBD')],
    ['Project Manager', job.pm_name || 'N/A'], ['Health', job.health],
    ['Progress', job.percent_complete + '%']
  ];
  for (const [label, value] of details) {
    doc.font('Helvetica-Bold').text(label + ': ', { continued: true });
    doc.font('Helvetica').text(value);
  }
  doc.moveDown(1);

  // Budget Summary (if exists)
  if (budget) {
    const totalBudget = (budget.budget_labour || 0) + (budget.budget_materials || 0) + (budget.budget_subcontractors || 0) + (budget.budget_equipment || 0) + (budget.budget_other || 0) + (budget.budget_contingency || 0);
    const margin = budget.contract_value > 0 ? ((budget.contract_value - totalSpent) / budget.contract_value * 100).toFixed(1) : 'N/A';

    doc.fontSize(13).font('Helvetica-Bold').text('Budget Summary');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica');
    const budgetRows = [
      ['Contract Value', '$' + (budget.contract_value || 0).toLocaleString()],
      ['Total Budget', '$' + totalBudget.toLocaleString()],
      ['Total Spent', '$' + totalSpent.toLocaleString()],
      ['Remaining', '$' + (totalBudget - totalSpent).toLocaleString()],
      ['Margin', margin + '%'],
    ];
    for (const [label, value] of budgetRows) {
      doc.font('Helvetica-Bold').text(label + ': ', { continued: true });
      doc.font('Helvetica').text(value);
    }
    doc.moveDown(1);
  }

  // Recent Timesheets
  if (timesheets.length > 0) {
    doc.fontSize(13).font('Helvetica-Bold').text('Recent Timesheets (last 20)');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica');
    doc.font('Helvetica-Bold').text('Date', 50, doc.y, { width: 80, continued: false });
    const headerY = doc.y - 12;
    doc.text('Crew Member', 130, headerY, { width: 150 });
    doc.text('Hours', 280, headerY, { width: 50 });
    doc.text('Shift', 330, headerY, { width: 60 });
    doc.moveDown(0.3);
    doc.font('Helvetica');
    for (const ts of timesheets) {
      const y = doc.y;
      if (y > 720) { doc.addPage(); }
      doc.text(ts.work_date || '', 50, doc.y, { width: 80, continued: false });
      const rowY = doc.y - 12;
      doc.text(ts.full_name || '', 130, rowY, { width: 150 });
      doc.text(String(ts.total_hours || 0), 280, rowY, { width: 50 });
      doc.text(ts.shift_type || '', 330, rowY, { width: 60 });
    }
    doc.moveDown(1);
  }

  // Equipment Assignments
  if (equipAssignments.length > 0) {
    doc.fontSize(13).font('Helvetica-Bold').text('Active Equipment');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica');
    for (const eq of equipAssignments) {
      doc.text(`${eq.asset_number} - ${eq.name} (assigned ${eq.assigned_date})`);
    }
    doc.moveDown(1);
  }

  // Open Compliance
  if (compliance.length > 0) {
    doc.fontSize(13).font('Helvetica-Bold').text('Open Compliance Items');
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ccc');
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica');
    for (const c of compliance) {
      doc.text(`${c.title} (${c.item_type}) - ${c.status} - Due: ${c.due_date || 'N/A'}`);
    }
  }

  logActivity({ user: req.session.user, action: 'download', entityType: 'job', entityId: parseInt(jobId), details: `Generated PDF report for ${job.job_number}`, ip: req.ip });

  doc.end();
});

module.exports = router;
