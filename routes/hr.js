const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requirePermission, canViewSensitiveHR, canAccess } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { createEmployeeReview } = require('../lib/reviews');
const { refreshCompetencyStatuses, computeReadiness } = require('../lib/competency');
const { sendEmail } = require('../services/email');
const { workerInviteEmail, sopSignLinkEmail, pinResetEmail } = require('../services/emailTemplates');
const { createNotification } = require('../middleware/create-notification');
const { sendPushToUser } = require('../services/pushNotification');
const crypto = require('crypto');
const { currentVersion: currentSopVersion } = require('../lib/sop');
const { REQUIRED_MODULES } = require('../lib/induction');
const { forCrewMember: trainingRecordsForCrew, distinctNames: distinctTrainingNames } = require('../lib/trainingRecords');
const { normalizePhone, normalizeEmail, normalizeName } = require('../lib/crewDedup');

// Only admin and finance can see pay rates
function canViewRates(user) {
  const role = (user.role || '').toLowerCase();
  return role === 'admin' || role === 'finance';
}

// --- Multer config for HR document uploads ---
const UPLOAD_BASE = path.join(__dirname, '..', 'data', 'uploads', 'hr');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const empId = req.params.id || 'unknown';
    const docType = req.body.document_type || 'other';
    const dir = path.join(UPLOAD_BASE, `emp_${empId}`, docType);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const ALLOWED_HR_FILES = /\.(pdf|doc|docx|xls|xlsx|png|jpg|jpeg|gif|csv|txt|zip)$/i;
const hrFileFilter = (req, file, cb) => {
  if (ALLOWED_HR_FILES.test(file.originalname)) cb(null, true);
  else cb(new Error('File type not allowed'), false);
};
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: hrFileFilter });

// computeReadiness + refreshCompetencyStatuses now live in ../lib/competency
// (shared with the safety-audit ticket-currency check). Imported above.

// ============================================
// HR DASHBOARD
// ============================================
// The set of document types every active worker must have on file.
// "Missing" means no row at all in employee_documents for that type —
// not just unverified. Edit this list to change what the dashboard's
// Missing Documents tab flags.
const MANDATORY_DOC_TYPES = [
  { key: 'white_card',       label: 'White Card' },
  { key: 'licence',          label: 'Driver Licence' },
  { key: 'contract',         label: 'Signed Contract' },
  { key: 'induction_record', label: 'Induction Record' },
];

router.get('/', requirePermission('hr_dashboard'), (req, res) => {
  const db = getDb();
  const { company, division, region, employment_type, manager_id, tab } = req.query;
  const activeTab = tab === 'missing-docs' ? 'missing-docs' : 'overview';

  let baseWhere = '1=1';
  const params = [];
  if (company) { baseWhere += ' AND e.company = ?'; params.push(company); }
  if (division) { baseWhere += ' AND e.division = ?'; params.push(division); }
  if (region) { baseWhere += ' AND e.primary_work_region = ?'; params.push(region); }
  if (employment_type) { baseWhere += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (manager_id) { baseWhere += ' AND e.manager_id = ?'; params.push(manager_id); }

  // Headcount stats
  const total = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.active = 1`).get(...params).c;
  const active = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_status = 'active'`).get(...params).c;
  const casual = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_type = 'casual' AND e.active = 1`).get(...params).c;
  const subcontractor = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_type = 'subcontractor' AND e.active = 1`).get(...params).c;
  const onLeave = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_status = 'on_leave'`).get(...params).c;
  const onboarding = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.employment_status = 'onboarding'`).get(...params).c;

  // Compliance stats
  const expiring7 = db.prepare(`SELECT COUNT(DISTINCT ec.employee_id) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ${baseWhere} AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+7 days')`).get(...params).c;
  const expiring30 = db.prepare(`SELECT COUNT(DISTINCT ec.employee_id) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ${baseWhere} AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days')`).get(...params).c;
  const expired = db.prepare(`SELECT COUNT(DISTINCT ec.employee_id) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ${baseWhere} AND ec.expiry_date < DATE('now') AND e.active = 1`).get(...params).c;
  const blocked = db.prepare(`SELECT COUNT(*) as c FROM employees e WHERE ${baseWhere} AND e.blocked_from_allocation = 1 AND e.active = 1`).get(...params).c;
  const pendingVerification = db.prepare(`SELECT COUNT(*) as c FROM employee_documents ed JOIN employees e ON ed.employee_id = e.id WHERE ${baseWhere} AND ed.verification_status = 'pending'`).get(...params).c;

  // Recent employees
  const recentEmployees = db.prepare(`SELECT e.*, m.full_name as manager_name FROM employees e LEFT JOIN employees m ON e.manager_id = m.id WHERE ${baseWhere.replace(/e\./g, 'e.')} AND e.active = 1 ORDER BY e.created_at DESC LIMIT 10`).all(...params);

  // Expiring competencies (next 30 days) for licence/expiry section
  const expiringCompetencies = db.prepare(`
    SELECT ec.*, e.full_name, e.employee_code, e.id as employee_id
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    WHERE ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days') AND e.active = 1
    ORDER BY ec.expiry_date ASC LIMIT 15
  `).all();

  // Blocked workers
  const blockedWorkers = db.prepare(`
    SELECT id, full_name, employee_code, company, block_reason
    FROM employees WHERE blocked_from_allocation = 1 AND active = 1
    ORDER BY full_name
  `).all();

  // Missing mandatory documents — for each active worker, which of the
  // required document TYPES they don't have on file at all (no row in
  // employee_documents, not just unverified).
  const docTypeKeys = MANDATORY_DOC_TYPES.map(d => d.key);
  const placeholders = docTypeKeys.map(() => '?').join(',');
  const activeEmployees = db.prepare(`
    SELECT e.id, e.full_name, e.employee_code, e.company, e.employment_status, e.start_date
    FROM employees e
    WHERE ${baseWhere} AND e.active = 1 AND e.deleted_at IS NULL
      AND e.employment_status IN ('active', 'reserved', 'on_leave')
    ORDER BY e.full_name
  `).all(...params);
  const existingTypesByEmp = db.prepare(`
    SELECT employee_id, document_type FROM employee_documents
    WHERE document_type IN (${placeholders})
  `).all(...docTypeKeys);
  const docMap = {};
  for (const row of existingTypesByEmp) {
    (docMap[row.employee_id] = docMap[row.employee_id] || new Set()).add(row.document_type);
  }
  const missingDocs = activeEmployees
    .map(emp => {
      const have = docMap[emp.id] || new Set();
      const missing = MANDATORY_DOC_TYPES.filter(d => !have.has(d.key));
      return { ...emp, missing, missing_count: missing.length };
    })
    .filter(e => e.missing_count > 0)
    .sort((a, b) => b.missing_count - a.missing_count || a.full_name.localeCompare(b.full_name));

  // Employment type breakdown for reports section
  const employmentTypes = db.prepare(`
    SELECT employment_type, COUNT(*) as count
    FROM employees WHERE active = 1
    GROUP BY employment_type ORDER BY count DESC
  `).all();

  // Headcount by division for bar chart
  const headcountByDivision = db.prepare(`
    SELECT division, COUNT(*) as count
    FROM employees WHERE active = 1 AND division != ''
    GROUP BY division ORDER BY count DESC
  `).all();

  // Filter options (map to plain string arrays for view templates)
  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const divisions = db.prepare("SELECT DISTINCT division FROM employees WHERE division != '' ORDER BY division").all().map(r => r.division);
  const regions = db.prepare("SELECT DISTINCT primary_work_region FROM employees WHERE primary_work_region != '' ORDER BY primary_work_region").all().map(r => r.primary_work_region);
  const managers = db.prepare('SELECT id, full_name FROM employees WHERE id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL) ORDER BY full_name').all();

  res.render('hr/dashboard', {
    title: 'HR Dashboard',
    currentPage: 'hr-dashboard',
    stats: { total, active, casual, subcontractor, onLeave, onboarding, expiring7, expiring30, expired, blocked, pendingVerification },
    recentEmployees,
    expiringCompetencies,
    blockedWorkers,
    missingDocs,
    mandatoryDocTypes: MANDATORY_DOC_TYPES,
    employmentTypes,
    headcountByDivision,
    activeTab,
    filters: { company, division, region, employment_type, manager_id },
    filterOptions: { companies, divisions, regions, managers },
    user: req.session.user
  });
});

// ============================================
// ROSTER (new employees list — replaces /employees view)
// ============================================
// Roster is THE single listing of everyone (the old /crew "Workforce" page
// now redirects here). Viewing is open to crew-permission holders too —
// operations could always see the workforce list, and the sidebar already
// shows them the Roster link. Export + bulk actions stay hr_employees-only.
function requireRosterView(req, res, next) {
  if (!req.session || !req.session.user) return res.redirect('/login');
  const u = req.session.user;
  if (canAccess(u, 'hr_employees') || canAccess(u, 'crew')) return next();
  return res.status(403).render('error', {
    title: 'Access Denied',
    message: 'You do not have permission to access this resource.',
    user: u,
  });
}
router.get('/roster', requireRosterView, (req, res) => {
  const db = getDb();
  const { employment_type, status, level, search, sort, order, payment_type, view, induction } = req.query;
  const showDeleted = view === 'deleted';

  let where = showDeleted ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL';
  const params = [];
  if (payment_type) { where += ' AND e.payment_type = ?'; params.push(payment_type); }
  if (employment_type) { where += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (status === 'inactive' || status === 'deactivated') {
    where += " AND e.employment_status IN ('inactive', 'deactivated')";
  } else if (status === 'terminated') {
    where += " AND e.employment_status IN ('terminated', 'offboarded')";
  } else if (status) {
    where += ' AND e.employment_status = ?'; params.push(status);
  }
  if (level) { where += ' AND (e.traffic_role_level = ? OR e.role_title = ?)'; params.push(level, level); }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s, s); }
  if (induction === 'inducted') { where += ' AND e.inducted_at IS NOT NULL'; }
  else if (induction === 'not_inducted') { where += ' AND e.inducted_at IS NULL'; }

  const sortCol = { full_name: 'e.full_name', employee_code: 'e.employee_code', start_date: 'e.start_date', status: 'e.employment_status', deleted_at: 'e.deleted_at' }[sort] || (showDeleted ? 'e.deleted_at' : 'e.full_name');
  const sortOrder = order === 'desc' ? 'DESC' : (showDeleted && !sort ? 'DESC' : 'ASC');

  const sopVersion = currentSopVersion();
  const employees = db.prepare(`
    SELECT e.*, m.full_name as manager_name,
      cm.employee_id as worker_id, cm.pin_plain as worker_pin,
      cm.portal_role as portal_role,
      CASE WHEN cm.pin_hash IS NOT NULL THEN 1 ELSE 0 END as has_pin,
      (SELECT MIN(ec.expiry_date) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.expiry_date IS NOT NULL AND ec.expiry_date >= DATE('now')) as next_expiry,
      (SELECT id FROM sop_acknowledgements a WHERE a.crew_member_id = e.linked_crew_member_id AND a.sop_version = ? ORDER BY id DESC LIMIT 1) as sop_ack_id
    FROM employees e
    LEFT JOIN employees m ON e.manager_id = m.id
    LEFT JOIN crew_members cm ON e.linked_crew_member_id = cm.id
    WHERE ${where}
    ORDER BY ${sortCol} ${sortOrder}
  `).all(sopVersion, ...params);

  employees.forEach(emp => {
    const comps = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ?').all(emp.id);
    const docs = db.prepare('SELECT * FROM employee_documents WHERE employee_id = ?').all(emp.id);
    emp.readiness = computeReadiness(emp, comps, docs);
    emp.sopSigned = !!emp.sop_ack_id;
  });

  // Count of active employees still missing the current-version acknowledgement
  const sopUnsignedCount = employees.filter(e => e.linked_crew_member_id && e.employment_status === 'active' && !e.sopSigned).length;
  const inductedCount = employees.filter(e => e.employment_status === 'active' && e.inducted_at).length;
  const notInductedCount = employees.filter(e => e.employment_status === 'active' && !e.inducted_at).length;

  // Stats — these drive the pill counts above the table. They previously
  // used two different definitions of "active" (employment_status='active'
  // for the Active tab vs. the legacy `active = 1` column for Cash/TFN/ABN),
  // which is why Cash could show 45 while Active showed 37. Everything now
  // counts against the same population: employees not deleted, matching
  // whichever status tab the operator has selected. Cash/TFN/ABN are strict
  // subsets so they can never exceed "All" on this row.
  // Build the "currently viewed population" predicate once and reuse it for
  // every pill so they're guaranteed to share the same scope.
  let pillWhere = 'deleted_at IS NULL';
  const pillParams = [];
  if (status === 'inactive' || status === 'deactivated') {
    pillWhere += " AND employment_status IN ('inactive','deactivated')";
  } else if (status === 'terminated') {
    pillWhere += " AND employment_status IN ('terminated','offboarded')";
  } else if (status) {
    pillWhere += ' AND employment_status = ?'; pillParams.push(status);
  } else {
    // No status filter selected → default the payment pills to the "Active"
    // population so Cash + TFN + ABN add up to the green Active tab number,
    // not the broader "All employees" tab. That's what operators expect from
    // the row and matches the page's primary working set.
    pillWhere += " AND employment_status = 'active'";
  }
  const totalPillAll = db.prepare(`SELECT COUNT(*) AS c FROM employees WHERE ${pillWhere}`).get(...pillParams).c;
  const totalCash = db.prepare(`SELECT COUNT(*) AS c FROM employees WHERE ${pillWhere} AND payment_type = 'cash'`).get(...pillParams).c;
  const totalTfn  = db.prepare(`SELECT COUNT(*) AS c FROM employees WHERE ${pillWhere} AND payment_type = 'tfn'`).get(...pillParams).c;
  const totalAbn  = db.prepare(`SELECT COUNT(*) AS c FROM employees WHERE ${pillWhere} AND payment_type = 'abn'`).get(...pillParams).c;

  // Status-tab counts — unchanged definitions, just kept beside the pills.
  const totalActive = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'active' AND deleted_at IS NULL").get().c;
  const totalReserved = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'reserved' AND deleted_at IS NULL").get().c;
  const totalDeactivated = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('inactive', 'deactivated') AND deleted_at IS NULL").get().c;
  const totalOnLeave = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'on_leave' AND deleted_at IS NULL").get().c;
  const totalTerminated = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('terminated', 'offboarded') AND deleted_at IS NULL").get().c;
  const totalActiveAll = db.prepare("SELECT COUNT(*) as c FROM employees WHERE deleted_at IS NULL").get().c;
  const totalDeleted = db.prepare("SELECT COUNT(*) as c FROM employees WHERE deleted_at IS NOT NULL").get().c;

  res.render('hr/roster', {
    title: 'Roster',
    currentPage: 'hr-roster',
    employees,
    stats: { totalActive, totalReserved, totalDeactivated, totalOnLeave, totalTerminated, totalCash, totalTfn, totalAbn, totalPillAll, totalActiveAll, totalDeleted, inductedCount, notInductedCount },
    filters: { employment_type, status, level, search, sort, order, payment_type, view, induction },
    showDeleted,
    sopVersion,
    sopUnsignedCount,
    user: req.session.user
  });
});

// GET /hr/roster/export.csv — Export the current roster filter set as CSV.
// Honours the same query params as the roster page (status / payment_type /
// employment_type / level / induction / search / view) so whatever's on
// screen is what gets exported. Format=names returns a single-column
// list of full names; the default is a fuller details export.
router.get('/roster/export.csv', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { employment_type, status, level, search, payment_type, view, induction, format } = req.query;
  const showDeleted = view === 'deleted';

  let where = showDeleted ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL';
  const params = [];
  if (payment_type) { where += ' AND e.payment_type = ?'; params.push(payment_type); }
  if (employment_type) { where += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (status === 'inactive' || status === 'deactivated') {
    where += " AND e.employment_status IN ('inactive', 'deactivated')";
  } else if (status === 'terminated') {
    where += " AND e.employment_status IN ('terminated', 'offboarded')";
  } else if (status) {
    where += ' AND e.employment_status = ?'; params.push(status);
  }
  if (level) { where += ' AND (e.traffic_role_level = ? OR e.role_title = ?)'; params.push(level, level); }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s, s); }
  if (induction === 'inducted') where += ' AND e.inducted_at IS NOT NULL';
  else if (induction === 'not_inducted') where += ' AND e.inducted_at IS NULL';

  const rows = db.prepare(`
    SELECT e.full_name, e.employee_code, e.role_title, e.employment_type, e.employment_status,
           e.payment_type, e.phone, e.email, e.start_date, e.inducted_at, m.full_name AS manager_name
    FROM employees e
    LEFT JOIN employees m ON e.manager_id = m.id
    WHERE ${where}
    ORDER BY e.full_name ASC
  `).all(...params);

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  let csv;
  if (format === 'names') {
    // Single-column names-only export — for quick paste into emails / lists.
    csv = ['Name', ...rows.map(r => csvCell(r.full_name))].join('\r\n');
  } else {
    const headers = ['#', 'Name', 'Employee Code', 'Role', 'Employment Type', 'Status', 'Payment Type', 'Phone', 'Email', 'Start Date', 'Inducted', 'Manager'];
    const lines = [headers.join(',')];
    rows.forEach((r, i) => {
      lines.push([
        i + 1, r.full_name, r.employee_code || '', r.role_title || '',
        r.employment_type || '', r.employment_status || '', r.payment_type || '',
        r.phone || '', r.email || '',
        r.start_date || '', r.inducted_at ? 'Yes' : 'No', r.manager_name || '',
      ].map(csvCell).join(','));
    });
    csv = lines.join('\r\n');
  }

  // Filename reflects what was exported so the file is recognisable on disk.
  const stamp = new Date().toISOString().slice(0, 10);
  const tag = [
    showDeleted ? 'deleted' : (status || 'all'),
    payment_type, induction === 'inducted' ? 'inducted' : induction === 'not_inducted' ? 'not_inducted' : null,
    format === 'names' ? 'names' : null,
  ].filter(Boolean).join('-');
  const filename = `roster-${tag || 'all'}-${stamp}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// WORKER PORTAL PREVIEW — log in as test dummy account
// ============================================
router.post('/roster/preview-worker', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const member = db.prepare(
    "SELECT id, full_name, employee_id, role, phone, email, active, pin_hash FROM crew_members WHERE employee_id = 'EMP-TEST'"
  ).get();

  if (!member || !member.active || !member.pin_hash) {
    req.flash('error', 'Test worker account not ready. Run migrations and retry.');
    return req.session.save(() => res.redirect('/hr/roster'));
  }

  req.session.worker = {
    id: member.id,
    full_name: member.full_name,
    employee_id: member.employee_id,
    role: member.role,
    phone: member.phone,
    email: member.email,
  };

  try {
    db.prepare("UPDATE crew_members SET last_worker_login = CURRENT_TIMESTAMP, worker_login_count = COALESCE(worker_login_count, 0) + 1 WHERE id = ?").run(member.id);
  } catch (e) { /* column may not exist */ }

  res.redirect('/w/home');
});

// ============================================
// ROSTER BULK SOFT-DELETE (move to Deleted tab)
// ============================================
router.post('/roster/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return req.session.save(() => res.redirect('/hr/roster')); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return req.session.save(() => res.redirect('/hr/roster')); }

  const placeholders = ids.map(() => '?').join(',');
  try {
    // Deactivate linked login users BEFORE soft-deleting the employees
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${placeholders}) AND linked_user_id IS NOT NULL`).all(...ids);
    const userIds = linkedUsers.map(r => r.linked_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET active = 0 WHERE id IN (${userPlaceholders})`).run(...userIds);
    }
    // Cascade to crew_members so operational lookups (VOC dropdown,
    // workforce roster, allocation pickers) immediately reflect the
    // deactivation. Without this the employee disappears from /hr/roster
    // but stays active=1 in crew_members — which is how the "duplicate
    // Saadat Ahmed" still showed in the Quick VOC dropdown after HR
    // thought they'd deactivated it.
    const linkedCrew = db.prepare(`SELECT linked_crew_member_id FROM employees WHERE id IN (${placeholders}) AND linked_crew_member_id IS NOT NULL`).all(...ids);
    const crewIds = linkedCrew.map(r => r.linked_crew_member_id).filter(Boolean);
    if (crewIds.length > 0) {
      const crewPlaceholders = crewIds.map(() => '?').join(',');
      db.prepare(`UPDATE crew_members SET active = 0 WHERE id IN (${crewPlaceholders})`).run(...crewIds);
    }
    // Soft-delete employees — preserve all related records for restore
    db.prepare(`UPDATE employees SET deleted_at = CURRENT_TIMESTAMP, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    req.flash('success', `${ids.length} employee(s) moved to Deleted.`);
  } catch (err) {
    console.error('Roster bulk soft-delete error:', err);
    req.flash('error', 'Error deleting employees: ' + err.message);
  }
  req.session.save(() => res.redirect('/hr/roster'));
});

// ============================================
// ROSTER BULK RESTORE (from Deleted tab)
// ============================================
router.post('/roster/restore', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return req.session.save(() => res.redirect('/hr/roster?view=deleted')); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return req.session.save(() => res.redirect('/hr/roster?view=deleted')); }

  const placeholders = ids.map(() => '?').join(',');
  try {
    // Reactivate linked login users
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${placeholders}) AND linked_user_id IS NOT NULL`).all(...ids);
    const userIds = linkedUsers.map(r => r.linked_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET active = 1 WHERE id IN (${userPlaceholders})`).run(...userIds);
    }
    // Cascade reactivation to crew_members so the operational side
    // matches HR. Mirror of the cascade in /hr/roster/delete above.
    const linkedCrew = db.prepare(`SELECT linked_crew_member_id FROM employees WHERE id IN (${placeholders}) AND linked_crew_member_id IS NOT NULL`).all(...ids);
    const crewIds = linkedCrew.map(r => r.linked_crew_member_id).filter(Boolean);
    if (crewIds.length > 0) {
      const crewPlaceholders = crewIds.map(() => '?').join(',');
      db.prepare(`UPDATE crew_members SET active = 1 WHERE id IN (${crewPlaceholders})`).run(...crewIds);
    }
    // Restore employees — clear deleted_at, reactivate, set status back to active
    db.prepare(`UPDATE employees SET deleted_at = NULL, active = 1, employment_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    req.flash('success', `${ids.length} employee(s) restored.`);
  } catch (err) {
    console.error('Roster bulk restore error:', err);
    req.flash('error', 'Error restoring employees: ' + err.message);
  }
  req.session.save(() => res.redirect('/hr/roster?view=deleted'));
});

// ============================================
// ROSTER DUPLICATES — find people on the roster more than once (e.g. added
// via recruitment "Hired" AND the induction form). Groups active employees by
// normalised phone / email / name. Resolving keeps one and soft-deletes the
// rest (same cascade as /roster/delete: deactivate login + linked crew).
// ============================================
router.get('/roster/duplicates', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.id, e.full_name, e.employee_code, e.employment_status, e.payment_type, e.phone, e.email,
      e.linked_crew_member_id, (e.inducted_at IS NOT NULL) AS inducted,
      CASE WHEN cm.pin_hash IS NOT NULL THEN 1 ELSE 0 END AS has_pin,
      (SELECT COUNT(*) FROM crew_allocations ca WHERE ca.crew_member_id = e.linked_crew_member_id) AS allocations
    FROM employees e
    LEFT JOIN crew_members cm ON cm.id = e.linked_crew_member_id
    WHERE e.deleted_at IS NULL
  `).all();

  // Connected-components grouping: two people are duplicates if they share ANY
  // of phone (last-9) / email / name. Union-find is used so e.g. same-name
  // people with different phone numbers (Araam) are still grouped — a simple
  // "first key wins" pass would file each under its own singleton phone group
  // and never reach the name match.
  const keyMembers = new Map(); // normalised key -> [ids]
  const addKey = (k, id) => { if (!k) return; if (!keyMembers.has(k)) keyMembers.set(k, []); keyMembers.get(k).push(id); };
  rows.forEach(m => {
    const np = normalizePhone(m.phone); if (np.length >= 8) addKey('p:' + np, m.id);
    const e = normalizeEmail(m.email); if (e) addKey('e:' + e, m.id);
    const n = normalizeName(m.full_name); if (n) addKey('n:' + n, m.id);
  });
  const parent = {};
  rows.forEach(m => { parent[m.id] = m.id; });
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { parent[find(a)] = find(b); };
  keyMembers.forEach(ids => { for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]); });

  const byRoot = new Map();
  rows.forEach(m => { const r = find(m.id); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(m); });

  const reasonsFor = (members) => {
    const reasons = [];
    const dupCount = (vals) => { const v = vals.filter(Boolean); return new Set(v).size < v.length; };
    if (dupCount(members.map(m => normalizePhone(m.phone)).filter(p => p.length >= 8))) reasons.push('phone');
    if (dupCount(members.map(m => normalizeEmail(m.email)))) reasons.push('email');
    if (dupCount(members.map(m => normalizeName(m.full_name)))) reasons.push('name');
    return reasons.join(' / ') || 'match';
  };

  const dupes = Array.from(byRoot.values())
    .filter(g => g.length > 1)
    .map(members => {
      members.sort((a, b) =>
        (b.has_pin - a.has_pin) || (b.allocations - a.allocations) || (b.inducted - a.inducted) || (a.id - b.id));
      const nameVaries = new Set(members.map(m => normalizeName(m.full_name))).size > 1;
      return { members, reason: reasonsFor(members), suggestedKeepId: members[0].id, nameVaries };
    })
    .sort((a, b) => a.members[0].full_name.localeCompare(b.members[0].full_name));

  res.render('hr/duplicates', { title: 'Duplicate roster records', currentPage: 'hr_employees', dupes });
});

router.post('/roster/duplicates/resolve', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const removeIds = [];
  Object.keys(req.body).forEach(k => {
    if (!k.startsWith('keep_')) return;
    const keepId = parseInt(req.body[k], 10);
    const ids = String(req.body['members_' + k.slice(5)] || '').split(',').map(n => parseInt(n, 10)).filter(Boolean);
    ids.forEach(id => { if (id && id !== keepId) removeIds.push(id); });
  });
  if (!removeIds.length) { req.flash('error', 'Nothing to resolve.'); return req.session.save(() => res.redirect('/hr/roster/duplicates')); }

  const ph = removeIds.map(() => '?').join(',');
  try {
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${ph}) AND linked_user_id IS NOT NULL`).all(...removeIds).map(r => r.linked_user_id).filter(Boolean);
    if (linkedUsers.length) db.prepare(`UPDATE users SET active = 0 WHERE id IN (${linkedUsers.map(() => '?').join(',')})`).run(...linkedUsers);
    const linkedCrew = db.prepare(`SELECT linked_crew_member_id FROM employees WHERE id IN (${ph}) AND linked_crew_member_id IS NOT NULL`).all(...removeIds).map(r => r.linked_crew_member_id).filter(Boolean);
    if (linkedCrew.length) db.prepare(`UPDATE crew_members SET active = 0 WHERE id IN (${linkedCrew.map(() => '?').join(',')})`).run(...linkedCrew);
    db.prepare(`UPDATE employees SET deleted_at = CURRENT_TIMESTAMP, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${ph})`).run(...removeIds);
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'employee', entityLabel: `Resolved duplicates — removed ${removeIds.length} record(s)`, ip: req.ip }); } catch (e) {}
    req.flash('success', `Resolved duplicates — moved ${removeIds.length} record(s) to Deleted.`);
  } catch (err) {
    console.error('Duplicate resolve error:', err);
    req.flash('error', 'Error resolving duplicates: ' + err.message);
  }
  req.session.save(() => res.redirect('/hr/roster/duplicates'));
});

// ============================================
// EMPLOYEES LIST (legacy — kept for backward compat)
// ============================================
router.get('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { company, division, employment_type, status, manager_id, search, allocatable, sort, order, payment_type } = req.query;

  let where = '1=1';
  const params = [];
  if (payment_type) { where += ' AND e.payment_type = ?'; params.push(payment_type); }
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (division) { where += ' AND e.division = ?'; params.push(division); }
  if (employment_type) { where += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (status) { where += ' AND e.employment_status = ?'; params.push(status); }
  if (manager_id) { where += ' AND e.manager_id = ?'; params.push(manager_id); }
  if (allocatable === '1') { where += ' AND e.allocatable = 1 AND e.blocked_from_allocation = 0'; }
  if (allocatable === '0') { where += ' AND (e.allocatable = 0 OR e.blocked_from_allocation = 1)'; }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ? OR e.email LIKE ? OR e.phone LIKE ?)'; const s = `%${search}%`; params.push(s, s, s, s); }

  const sortCol = { full_name: 'e.full_name', employee_code: 'e.employee_code', company: 'e.company', start_date: 'e.start_date', status: 'e.employment_status' }[sort] || 'e.full_name';
  const sortOrder = order === 'desc' ? 'DESC' : 'ASC';

  const employees = db.prepare(`
    SELECT e.*, m.full_name as manager_name,
      (SELECT MIN(ec.expiry_date) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.expiry_date IS NOT NULL AND ec.expiry_date >= DATE('now')) as next_expiry
    FROM employees e
    LEFT JOIN employees m ON e.manager_id = m.id
    WHERE ${where}
    ORDER BY ${sortCol} ${sortOrder}
  `).all(...params);

  // Compute readiness for each
  employees.forEach(emp => {
    const comps = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ?').all(emp.id);
    const docs = db.prepare('SELECT * FROM employee_documents WHERE employee_id = ?').all(emp.id);
    emp.readiness = computeReadiness(emp, comps, docs);
  });

  // Stats
  const totalActive = db.prepare("SELECT COUNT(*) as c FROM employees WHERE active = 1").get().c;
  const totalOnboarding = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'onboarding'").get().c;
  const totalBlocked = db.prepare("SELECT COUNT(*) as c FROM employees WHERE blocked_from_allocation = 1 AND active = 1").get().c;
  const totalCash = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'cash' AND active = 1").get().c;
  const totalTfn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'tfn' AND active = 1").get().c;
  const totalAbn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'abn' AND active = 1").get().c;

  // Filter options (map to plain string arrays for view templates)
  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const divisions = db.prepare("SELECT DISTINCT division FROM employees WHERE division != '' ORDER BY division").all().map(r => r.division);
  const managers = db.prepare('SELECT id, full_name FROM employees WHERE id IN (SELECT DISTINCT manager_id FROM employees WHERE manager_id IS NOT NULL) ORDER BY full_name').all();

  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/employees', {
    title: 'Employees',
    currentPage: 'hr-employees',
    employees,
    stats: { totalActive, totalOnboarding, totalBlocked, totalCash, totalTfn, totalAbn },
    filters: { company, division, employment_type, status, manager_id, search, allocatable, sort, order, payment_type },
    filterOptions: { companies, divisions, managers },
    settingsOptions,
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// ADD EMPLOYEE FORM
// ============================================
router.get('/employees/new', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const allEmployees = db.prepare('SELECT id, full_name FROM employees WHERE active = 1 ORDER BY full_name').all();
  const crewMembers = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const users = db.prepare('SELECT id, full_name, username FROM users WHERE active = 1 ORDER BY full_name').all();
  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/employee-form', {
    title: 'New Employee',
    currentPage: 'hr-employees',
    employee: null,
    allEmployees,
    crewMembers,
    users,
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// The employee form (views/hr/employee-form.ejs, shared by create + edit)
// renders ~28 of its fields twice — the wizard panels plus a no-JS fallback
// block — so Express hands us arrays for those keys. Passing an array on to
// better-sqlite3 is not a no-op: it expands into MULTIPLE bind values and
// blows up the statement with "Too many parameter values were provided".
// Collapse to the last value the user actually filled, preferring a non-empty
// one so an empty duplicate can never wipe a real entry.
function dedupeBody(body) {
  const out = {};
  for (const [key, val] of Object.entries(body)) {
    if (!Array.isArray(val)) { out[key] = val; continue; }
    const filled = val.filter(v => String(v == null ? '' : v).trim() !== '');
    out[key] = filled.length ? filled[filled.length - 1] : val[val.length - 1];
  }
  return out;
}

// ============================================
// CREATE EMPLOYEE
// ============================================
router.post('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const b = dedupeBody(req.body);

  const fullName = [(b.first_name || '').trim(), (b.middle_name || '').trim(), (b.last_name || '').trim()].filter(Boolean).join(' ');

  // Only save rates if user has permission
  const rateFields = canViewRates(req.session.user) ? {
    rate_day: parseFloat(b.rate_day) || 0, rate_ot: parseFloat(b.rate_ot) || 0, rate_dt: parseFloat(b.rate_dt) || 0,
    rate_night: parseFloat(b.rate_night) || 0, rate_night_ot: parseFloat(b.rate_night_ot) || 0, rate_night_dt: parseFloat(b.rate_night_dt) || 0,
    rate_travel: parseFloat(b.rate_travel) || 0, rate_meal: parseFloat(b.rate_meal) || 0, rate_weekend: parseFloat(b.rate_weekend) || 0,
  } : {};

  const result = db.prepare(`
    INSERT INTO employees (employee_code, first_name, middle_name, last_name, full_name, preferred_name, company, division, role_title,
      employment_type, employment_status, payment_type, start_date, end_date, probation_end_date, manager_id,
      email, phone, address, suburb, state, postcode,
      traffic_role_level, ticket_classification, white_card_required, medical_required,
      allocatable, blocked_from_allocation, block_reason, induction_status,
      ppe_issued_status, uniform_issued_status, company_vehicle_assigned,
      primary_work_region, base_location,
      emergency_contact_name, emergency_contact_phone, emergency_contact_relationship,
      date_of_birth, payroll_reference, internal_notes, active,
      linked_crew_member_id, linked_user_id,
      rate_day, rate_ot, rate_dt, rate_night, rate_night_ot, rate_night_dt, rate_travel, rate_meal, rate_weekend)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.employee_code || null, b.first_name, b.middle_name || '', b.last_name, fullName, b.preferred_name || '',
    b.company || '', b.division || '', b.role_title || '',
    b.employment_type || 'full_time', b.employment_status || 'active', b.payment_type || '',
    b.start_date || null, b.end_date || null, b.probation_end_date || null, b.manager_id || null,
    b.email || '', b.phone || '', b.address || '', b.suburb || '', b.state || '', b.postcode || '',
    b.traffic_role_level || '', b.ticket_classification || '',
    b.white_card_required ? 1 : 0, b.medical_required ? 1 : 0,
    b.allocatable ? 1 : 0, b.blocked_from_allocation ? 1 : 0, b.block_reason || '',
    b.induction_status || 'pending',
    b.ppe_issued_status || 'not_issued', b.uniform_issued_status || 'not_issued',
    b.company_vehicle_assigned || '',
    b.primary_work_region || '', b.base_location || '',
    b.emergency_contact_name || '', b.emergency_contact_phone || '', b.emergency_contact_relationship || '',
    b.date_of_birth || null, b.payroll_reference || '', b.internal_notes || '',
    b.linked_crew_member_id || null, b.linked_user_id || null,
    rateFields.rate_day || 0, rateFields.rate_ot || 0, rateFields.rate_dt || 0,
    rateFields.rate_night || 0, rateFields.rate_night_ot || 0, rateFields.rate_night_dt || 0,
    rateFields.rate_travel || 0, rateFields.rate_meal || 0, rateFields.rate_weekend || 0
  );

  req.flash('success', 'Employee created successfully.');
  req.session.save(() => res.redirect(`/hr/employees/${result.lastInsertRowid}`));
});

// ============================================
// BULK DELETE EMPLOYEES
// ============================================
router.post('/employees/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return req.session.save(() => res.redirect('/hr/employees')); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return req.session.save(() => res.redirect('/hr/employees')); }

  const placeholders = ids.map(() => '?').join(',');

  // Delete uploaded document files from disk first (before deleting DB records)
  try {
    const docs = db.prepare(`SELECT file_path FROM employee_documents WHERE employee_id IN (${placeholders})`).all(...ids);
    for (const doc of docs) {
      if (doc.file_path) { try { fs.unlinkSync(doc.file_path); } catch (e) { /* ignore */ } }
    }
  } catch (e) { /* ignore */ }

  // Delete related records from all tables that reference employees
  const relatedTables = ['employee_competencies', 'employee_documents', 'employee_leave'];
  for (const table of relatedTables) {
    try { db.prepare(`DELETE FROM ${table} WHERE employee_id IN (${placeholders})`).run(...ids); } catch (e) { /* table may not exist */ }
  }

  // Null out manager_id self-references so other employees aren't blocked
  try { db.prepare(`UPDATE employees SET manager_id = NULL WHERE manager_id IN (${placeholders})`).run(...ids); } catch (e) { /* ignore */ }

  // Cascade to crew_members — hard-deleting the HR employee row would
  // orphan the operational crew_members row otherwise (no FK link left
  // to find it later). Mark inactive so operational pickers stop
  // surfacing it. We don't hard-delete crew_members because it's
  // referenced by timesheets / allocations / VOC assessments that
  // we want to keep for audit.
  try {
    const linkedCrew = db.prepare(`SELECT linked_crew_member_id FROM employees WHERE id IN (${placeholders}) AND linked_crew_member_id IS NOT NULL`).all(...ids);
    const crewIds = linkedCrew.map(r => r.linked_crew_member_id).filter(Boolean);
    if (crewIds.length > 0) {
      const crewPlaceholders = crewIds.map(() => '?').join(',');
      db.prepare(`UPDATE crew_members SET active = 0 WHERE id IN (${crewPlaceholders})`).run(...crewIds);
    }
  } catch (e) { /* ignore */ }

  // Delete uploaded HR folders
  for (const id of ids) {
    const empDir = path.join(UPLOAD_BASE, `emp_${id}`);
    try { fs.rmSync(empDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  try {
    const result = db.prepare(`DELETE FROM employees WHERE id IN (${placeholders})`).run(...ids);
    const count = result.changes;
    req.flash('success', `Deleted ${count} employee${count !== 1 ? 's' : ''}.`);
  } catch (e) {
    console.error('Employee delete error:', e.message);
    req.flash('error', 'Could not delete employee(s): ' + e.message);
  }
  req.session.save(() => res.redirect('/hr/employees'));
});

// ============================================
// EMPLOYEE DETAIL
// ============================================
router.get('/employees/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/employees')); }

  const manager = employee.manager_id ? db.prepare('SELECT id, full_name FROM employees WHERE id = ?').get(employee.manager_id) : null;
  const documents = db.prepare('SELECT ed.*, u.full_name as uploaded_by_name, v.full_name as verified_by_name FROM employee_documents ed LEFT JOIN users u ON ed.uploaded_by_id = u.id LEFT JOIN users v ON ed.verified_by_id = v.id WHERE ed.employee_id = ? ORDER BY ed.created_at DESC').all(employee.id);

  refreshCompetencyStatuses(db, employee.id);
  const competencies = db.prepare('SELECT * FROM employee_competencies WHERE employee_id = ? ORDER BY expiry_date ASC').all(employee.id);

  const readiness = computeReadiness(employee, competencies, documents);

  // Linked crew data
  let crewMember = null;
  let upcomingShifts = [];
  let recentTimesheets = [];
  if (employee.linked_crew_member_id) {
    crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(employee.linked_crew_member_id);
    try {
      upcomingShifts = db.prepare(`
        SELECT ca.*, j.job_number, j.client FROM crew_allocations ca
        JOIN jobs j ON ca.job_id = j.id
        WHERE ca.crew_member_id = ? AND ca.allocation_date >= DATE('now') AND ca.status != 'cancelled'
        ORDER BY ca.allocation_date ASC LIMIT 10
      `).all(employee.linked_crew_member_id);
    } catch (e) { upcomingShifts = []; }
    try {
      recentTimesheets = db.prepare(`
        SELECT t.*, j.job_number, j.client FROM timesheets t
        JOIN jobs j ON t.job_id = j.id
        WHERE t.crew_member_id = ? ORDER BY t.work_date DESC LIMIT 10
      `).all(employee.linked_crew_member_id);
    } catch (e) { recentTimesheets = []; }
  }

  const settingsOptions = res.locals.settingsOptions || {};

  // Training completions — match by any of (employee_id, crew_member_id,
  // legacy-orphan email) so group-induction completions surface even when
  // the historical employees.linked_crew_member_id wasn't set.
  let training = [];
  try {
    training = db.prepare(`
      SELECT * FROM training_completions
      WHERE
        employee_id = ?
        OR (crew_member_id IS NOT NULL AND crew_member_id = ?)
        OR (employee_id IS NULL AND email IS NOT NULL AND LOWER(email) = LOWER(?))
      ORDER BY completed_at DESC
    `).all(employee.id, employee.linked_crew_member_id || -1, employee.email || '');
  } catch (e) {}

  // SOP acknowledgement status — current version + history
  const sopVersion = currentSopVersion();
  let sopStatus = { signed: false, signedAt: null, version: sopVersion, openLinkUrl: null };
  let sopHistory = [];
  if (employee.linked_crew_member_id) {
    try {
      sopHistory = db.prepare(
        'SELECT id, sop_version, signed_at, signed_via, signature_url FROM sop_acknowledgements WHERE crew_member_id = ? ORDER BY signed_at DESC LIMIT 10'
      ).all(employee.linked_crew_member_id);
      const current = sopHistory.find(a => a.sop_version === sopVersion);
      if (current) { sopStatus.signed = true; sopStatus.signedAt = current.signed_at; }
      if (!sopStatus.signed) {
        const openSession = db.prepare(
          'SELECT token FROM sop_signing_sessions WHERE target_crew_member_id = ? AND sop_version = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1'
        ).get(employee.linked_crew_member_id, sopVersion);
        if (openSession) {
          const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
          sopStatus.openLinkUrl = `${baseUrl}/sop-sign/${openSession.token}`;
        }
      }
    } catch (e) { /* tables may not exist on stale deploys */ }
  }

  // Induction submission (for super/bank details) — linked via crew member
  let induction = null;
  if (employee.linked_crew_member_id) {
    try { induction = db.prepare("SELECT * FROM induction_submissions WHERE linked_crew_member_id = ? AND status IN ('submitted','approved') ORDER BY submitted_at DESC LIMIT 1").get(employee.linked_crew_member_id); } catch (e) {}
  }
  if (!induction && employee.email) {
    try { induction = db.prepare("SELECT * FROM induction_submissions WHERE email = ? AND status IN ('submitted','approved') ORDER BY submitted_at DESC LIMIT 1").get(employee.email); } catch (e) {}
  }

  // Induction status: aggregate of training_completions + SOP ack + manual flag.
  // Group-induction (per-attendee multi-write) stores crew_member_id directly,
  // so a row counts if EITHER (a) employee_id matches this profile, OR
  // (b) crew_member_id matches this employee's linked_crew_member_id.
  // Falls back to a case-insensitive email match for legacy completions
  // recorded before migration 203 added crew_member_id.
  const trainingPasses = {};
  REQUIRED_MODULES.forEach(m => {
    const row = db.prepare(`
      SELECT id, completed_at, score, total
      FROM training_completions
      WHERE module = ? AND passed = 1
        AND (
          employee_id = ?
          OR (crew_member_id IS NOT NULL AND crew_member_id = ?)
          OR (employee_id IS NULL AND email IS NOT NULL AND LOWER(email) = LOWER(?))
        )
      ORDER BY completed_at DESC LIMIT 1
    `).get(m, employee.id, employee.linked_crew_member_id || -1, employee.email || '');
    trainingPasses[m] = row || null;
  });
  let inductionMarkedBy = null;
  if (employee.inducted_marked_by_id) {
    inductionMarkedBy = db.prepare('SELECT full_name FROM users WHERE id = ?').get(employee.inducted_marked_by_id);
  }

  // In-house training records (Portaboom, Trailer, Spotter, etc.). Distinct
  // from training_completions (which is online quiz module passes). Only
  // loaded when the employee is linked to a crew_member since records are
  // keyed on crew_member_id.
  let trainingRecords = [];
  let trainingNameSuggestions = [];
  if (employee.linked_crew_member_id) {
    try { trainingRecords = trainingRecordsForCrew(db, employee.linked_crew_member_id); }
    catch (e) { console.error('[hr] training records load failed:', e.message); }
  }
  try { trainingNameSuggestions = distinctTrainingNames(db); } catch (e) {}

  // Toolbox meetings: every published toolbox + this worker's attendance
  // status (attended / caught_up / absent + reason / not recorded).
  // Joined by linked_crew_member_id so we get a row per meeting even if
  // the worker didn't respond — the user wants the full list visible.
  let toolboxMeetings = [];
  try {
    // Show a toolbox in the worker profile only if it's open to everyone
    // (no invitees set) OR this worker is on the explicit invitee list.
    toolboxMeetings = db.prepare(`
      SELECT
        t.id, t.title, t.held_at, t.presenter, t.key_points, t.published_at,
        a.status AS my_status, a.absence_reason, a.recorded_at AS my_recorded_at
      FROM toolbox_talks t
      LEFT JOIN toolbox_attendance a
        ON a.toolbox_id = t.id AND a.crew_member_id = ?
      WHERE t.status = 'published'
        AND (
          NOT EXISTS (SELECT 1 FROM toolbox_invitees i WHERE i.toolbox_id = t.id)
          OR EXISTS (SELECT 1 FROM toolbox_invitees i WHERE i.toolbox_id = t.id AND i.crew_member_id = ?)
        )
      ORDER BY COALESCE(t.held_at, t.published_at) DESC, t.id DESC
    `).all(employee.linked_crew_member_id || -1, employee.linked_crew_member_id || -1);
  } catch (e) { /* table may not exist on stale DB */ }

  // Employee reviews — quick notes + full performance reviews. JSON
  // payload columns (sections, peer comments) are parsed here so the
  // view doesn't have to. Author name resolved once per row.
  let reviews = [];
  try {
    const rows = db.prepare(`
      SELECT r.*, u.full_name AS created_by_name
      FROM employee_reviews r
      LEFT JOIN users u ON u.id = r.created_by_id
      WHERE r.employee_id = ?
      ORDER BY COALESCE(r.review_date, substr(r.created_at, 1, 10)) DESC, r.id DESC
    `).all(employee.id);
    reviews = rows.map(r => ({
      ...r,
      sections:      safeParseJson(r.sections_json, []),
      peer_comments: safeParseJson(r.peer_comments_json, []),
      comments:      [],
    }));

    // Load HR-internal comments in one round-trip and bucket by review.
    // The comments table is created by migration 230 — wrap the read in
    // its own try so a stale DB still renders the rest of the tab.
    if (reviews.length) {
      try {
        const reviewIds = reviews.map(r => r.id);
        const placeholders = reviewIds.map(() => '?').join(',');
        const commentRows = db.prepare(`
          SELECT c.*, u.full_name AS created_by_name
          FROM employee_review_comments c
          LEFT JOIN users u ON u.id = c.created_by_id
          WHERE c.review_id IN (${placeholders})
          ORDER BY c.created_at ASC, c.id ASC
        `).all(...reviewIds);
        const byReview = new Map(reviews.map(r => [r.id, r]));
        for (const c of commentRows) {
          c.body_html = renderCommentHtml(c.body);
          const r = byReview.get(c.review_id);
          if (r) r.comments.push(c);
        }
      } catch (e) { /* migration 230 not yet applied */ }
    }
  } catch (e) { /* table will exist after migration 225 runs */ }

  // Users available for @mention autocomplete in the comment box.
  let mentionUsers = [];
  try {
    mentionUsers = db.prepare(
      `SELECT id, username, full_name FROM users WHERE active = 1 ORDER BY full_name`
    ).all();
  } catch (e) { /* no users yet */ }

  res.render('hr/employee-show', {
    title: employee.full_name,
    currentPage: 'hr-employees',
    employee,
    manager,
    documents,
    competencies,
    readiness,
    crewMember,
    upcomingShifts,
    recentTimesheets,
    training,
    trainingRecords,
    trainingNameSuggestions,
    induction,
    sopStatus,
    sopHistory,
    trainingPasses,
    toolboxMeetings,
    reviews,
    mentionUsers,
    inductionMarkedBy: inductionMarkedBy ? inductionMarkedBy.full_name : null,
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// Tiny helper for the reviews JSON columns. Local rather than imported
// because schema.js + lib/* already have their own JSON utilities and I
// don't want to thread another import through this file.
function safeParseJson(s, fallback) {
  if (!s) return fallback;
  try { var v = JSON.parse(s); return Array.isArray(v) || (v && typeof v === 'object') ? v : fallback; }
  catch (e) { return fallback; }
}

// HTML-escape (NOT a full sanitiser — we never trust comment bodies).
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Match @username tokens (letters / digits / dot / underscore / hyphen).
// Has to start after whitespace or string start so emails (foo@bar) don't
// false-positive. Username comes back as capture group 1.
const MENTION_RE = /(^|\s)@([A-Za-z0-9._-]{2,40})/g;

// Render a comment body to safe HTML with @mentions wrapped in a chip.
// Pure presentation — the canonical mention list is stored separately on
// the comment row, so this can change format without losing notifications.
function renderCommentHtml(body) {
  const safe = escapeHtml(body || '');
  return safe.replace(MENTION_RE, (m, lead, name) =>
    `${lead}<span class="inline-block bg-brand-50 text-brand-700 rounded px-1 font-semibold">@${name}</span>`
  );
}

// Extract distinct usernames from a comment body. Lowercased so the
// downstream user lookup is case-insensitive.
function extractMentions(body) {
  const out = new Set();
  String(body || '').replace(MENTION_RE, (_, _lead, name) => { out.add(name.toLowerCase()); return ''; });
  return [...out];
}

// ============================================
// EMPLOYEE REVIEWS — create / delete
// ============================================
// POST /hr/employees/:id/reviews — add a note or a full performance
// review. Visibility = 'internal' keeps it HR-only; 'worker' surfaces
// it in the worker portal's My Reviews tab.
router.post('/employees/:id/reviews', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/employees')); }

  const b = req.body || {};
  const kind = b.kind === 'review' ? 'review' : 'note';
  const visibility = b.visibility === 'worker' ? 'worker' : 'internal';
  const title = (b.title || '').trim() || (kind === 'review' ? 'Performance review' : 'Note');
  const summary = (b.summary || '').trim();
  const reviewDate = (b.review_date || '').trim() || null;
  const heldBy = (b.held_by || '').trim();

  // Sections + peer comments arrive as parallel arrays from the form
  // (one row per section/comment). Drop blank rows so the JSON payload
  // doesn't bloat with empty pairs.
  const secHeadings = [].concat(b.section_heading || []);
  const secContents = [].concat(b.section_content || []);
  const sections = [];
  for (let i = 0; i < Math.max(secHeadings.length, secContents.length); i++) {
    const h = (secHeadings[i] || '').trim();
    const c = (secContents[i] || '').trim();
    if (h || c) sections.push({ heading: h, content: c });
  }
  const peerFrom = [].concat(b.peer_from || []);
  const peerText = [].concat(b.peer_comment || []);
  const peerComments = [];
  for (let i = 0; i < Math.max(peerFrom.length, peerText.length); i++) {
    const from = (peerFrom[i] || '').trim();
    const text = (peerText[i] || '').trim();
    if (from || text) peerComments.push({ from, comment: text });
  }

  try {
    createEmployeeReview(db, {
      employeeId: employee.id,
      kind, title, summary,
      reviewDate, heldBy, visibility,
      sections, peerComments,
      createdById: req.session.user.id,
    });
    req.flash('success', visibility === 'worker'
      ? `${kind === 'review' ? 'Review' : 'Note'} saved and shared to the worker's portal.`
      : `${kind === 'review' ? 'Review' : 'Note'} saved (internal only).`);
  } catch (e) {
    console.error('[hr] add review failed:', e.message);
    req.flash('error', 'Could not save review.');
  }
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#reviews`));
});

// POST /hr/reviews/:id/delete — remove a review/note.
router.post('/reviews/:id/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id, employee_id FROM employee_reviews WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Review not found.'); return req.session.save(() => res.redirect('back')); }
  db.prepare('DELETE FROM employee_reviews WHERE id = ?').run(row.id);
  req.flash('success', 'Review removed.');
  req.session.save(() => res.redirect(`/hr/employees/${row.employee_id}#reviews`));
});

// POST /hr/reviews/:reviewId/comments — add a comment to a note/review.
// HR-internal: comments are never surfaced to the worker portal, even
// when the parent review is shared. `@username` tokens fan out to in-app
// + push notifications for each matched, active user (skipping the
// author themselves so we don't ping people for their own comment).
router.post('/reviews/:reviewId/comments', requirePermission('hr_employees'), async (req, res) => {
  const db = getDb();
  const review = db.prepare(`
    SELECT r.id, r.employee_id, r.title, e.full_name AS employee_name
    FROM employee_reviews r
    JOIN employees e ON e.id = r.employee_id
    WHERE r.id = ?
  `).get(req.params.reviewId);
  if (!review) { req.flash('error', 'Review not found.'); return req.session.save(() => res.redirect('back')); }

  const body = (req.body && req.body.body || '').trim();
  if (!body) {
    req.flash('error', 'Comment cannot be empty.');
    return req.session.save(() => res.redirect(`/hr/employees/${review.employee_id}#reviews`));
  }

  const mentionedNames = extractMentions(body);
  let mentionedUsers = [];
  if (mentionedNames.length) {
    const placeholders = mentionedNames.map(() => '?').join(',');
    mentionedUsers = db.prepare(
      `SELECT id, username, full_name FROM users
       WHERE active = 1 AND LOWER(username) IN (${placeholders})`
    ).all(...mentionedNames);
  }

  try {
    const result = db.prepare(`
      INSERT INTO employee_review_comments (review_id, body, mentioned_user_ids, created_by_id)
      VALUES (?, ?, ?, ?)
    `).run(
      review.id,
      body,
      JSON.stringify(mentionedUsers.map(u => u.id)),
      req.session.user.id
    );

    // Notify each tagged user (skipping the author). Best-effort: push
    // failures are logged inside sendPushToUser, in-app notification is
    // wrapped in its own try inside createNotification.
    const authorId = req.session.user.id;
    const authorName = req.session.user.full_name || req.session.user.username || 'Someone';
    const link = `/hr/employees/${review.employee_id}#reviews`;
    const snippet = body.length > 140 ? body.slice(0, 137) + '…' : body;
    for (const u of mentionedUsers) {
      if (u.id === authorId) continue;
      createNotification({
        userId: u.id,
        type: 'general',
        title: `${authorName} mentioned you on ${review.employee_name}`,
        message: snippet,
        link
      });
      sendPushToUser(u.id, {
        title: `${authorName} mentioned you`,
        body: snippet,
        url: link,
        icon: '/icon-192.png'
      }).catch(err => console.error('[hr review comment] push failed:', err.message));
    }

    req.flash('success', mentionedUsers.length
      ? `Comment added and ${mentionedUsers.length} teammate(s) notified.`
      : 'Comment added.');
  } catch (e) {
    console.error('[hr] add review comment failed:', e.message);
    req.flash('error', 'Could not save comment.');
  }
  req.session.save(() => res.redirect(`/hr/employees/${review.employee_id}#reviews`));
});

// POST /hr/reviews/comments/:id/delete — remove a comment. Limited to
// the original author and admin/management roles.
router.post('/reviews/comments/:id/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT c.id, c.created_by_id, r.employee_id
    FROM employee_review_comments c
    JOIN employee_reviews r ON r.id = c.review_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!row) { req.flash('error', 'Comment not found.'); return req.session.save(() => res.redirect('back')); }

  const u = req.session.user;
  const isOwner = u && u.id === row.created_by_id;
  const isPrivileged = u && ['admin', 'management'].includes((u.role || '').toLowerCase());
  if (!isOwner && !isPrivileged) {
    req.flash('error', "You can only delete your own comments.");
    return req.session.save(() => res.redirect(`/hr/employees/${row.employee_id}#reviews`));
  }

  db.prepare('DELETE FROM employee_review_comments WHERE id = ?').run(row.id);
  req.flash('success', 'Comment removed.');
  req.session.save(() => res.redirect(`/hr/employees/${row.employee_id}#reviews`));
});

// ============================================
// EDIT EMPLOYEE FORM
// ============================================
router.get('/employees/:id/edit', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/employees')); }

  const allEmployees = db.prepare('SELECT id, full_name FROM employees WHERE active = 1 AND id != ? ORDER BY full_name').all(employee.id);
  const crewMembers = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const users = db.prepare('SELECT id, full_name, username FROM users WHERE active = 1 ORDER BY full_name').all();
  const settingsOptions = res.locals.settingsOptions || {};

  // Latest payroll records (shown for admins who already see sensitive HR data)
  let latestBank = null, latestSuper = null, latestTfn = null;
  try {
    latestBank = db.prepare('SELECT id, account_name, bsb_last3, account_last3, status, synced_at, updated_at FROM bank_accounts WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);
    latestSuper = db.prepare('SELECT id, fund_name, usi, member_number, fund_abn, status, synced_at, updated_at FROM super_funds WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);
    latestTfn = db.prepare('SELECT id, tfn_last3, residency_status, claim_threshold, has_help_debt, has_stsl_debt, medicare_variation, status, submitted_at FROM tfn_declarations WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employee.id);
  } catch (e) { /* tables may not exist on very old deploys */ }

  res.render('hr/employee-form', {
    title: 'Edit Employee: ' + employee.full_name,
    currentPage: 'hr-employees',
    employee,
    allEmployees,
    crewMembers,
    users,
    settingsOptions,
    latestBank, latestSuper, latestTfn,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// UPDATE EMPLOYEE
// ============================================
router.post('/employees/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  // Same duplicate-field handling as create — see dedupeBody above.
  const b = dedupeBody(req.body);
  const fullName = [(b.first_name || '').trim(), (b.middle_name || '').trim(), (b.last_name || '').trim()].filter(Boolean).join(' ');

  // Build SET pairs and params array dynamically
  const sets = [];
  const params = [];

  function set(col, val) { sets.push(col + ' = ?'); params.push(val); }

  set('employee_code', b.employee_code || null);
  set('first_name', b.first_name || '');
  set('middle_name', b.middle_name || '');
  set('last_name', b.last_name || '');
  set('full_name', fullName);
  set('preferred_name', b.preferred_name || '');
  set('company', b.company || '');
  set('division', b.division || '');
  set('role_title', b.role_title || '');
  set('employment_type', b.employment_type || 'full_time');
  set('employment_status', b.employment_status || 'active');
  set('payment_type', b.payment_type || '');
  set('start_date', b.start_date || null);
  set('end_date', b.end_date || null);
  set('probation_end_date', b.probation_end_date || null);
  set('manager_id', b.manager_id || null);
  set('email', b.email || '');
  set('phone', b.phone || '');
  set('address', b.address || '');
  set('suburb', b.suburb || '');
  set('state', b.state || '');
  set('postcode', b.postcode || '');
  set('traffic_role_level', b.traffic_role_level || '');
  set('ticket_classification', b.ticket_classification || '');
  set('white_card_required', b.white_card_required ? 1 : 0);
  set('medical_required', b.medical_required ? 1 : 0);
  set('allocatable', b.allocatable ? 1 : 0);
  set('blocked_from_allocation', b.blocked_from_allocation ? 1 : 0);
  set('block_reason', b.block_reason || '');
  set('induction_status', b.induction_status || 'pending');
  set('ppe_issued_status', b.ppe_issued_status || 'not_issued');
  set('uniform_issued_status', b.uniform_issued_status || 'not_issued');
  set('company_vehicle_assigned', b.company_vehicle_assigned || '');
  set('primary_work_region', b.primary_work_region || '');
  set('base_location', b.base_location || '');
  set('emergency_contact_name', b.emergency_contact_name || '');
  set('emergency_contact_phone', b.emergency_contact_phone || '');
  set('emergency_contact_relationship', b.emergency_contact_relationship || '');
  set('date_of_birth', b.date_of_birth || null);
  set('payroll_reference', b.payroll_reference || '');
  set('internal_notes', b.internal_notes || '');
  set('linked_crew_member_id', b.linked_crew_member_id || null);
  set('linked_user_id', b.linked_user_id || null);
  set('white_card_number', b.white_card_number || '');
  set('tc_licence_number', b.tc_licence_number || '');
  set('tc_licence_state', b.tc_licence_state || '');
  set('tc_licence_date_of_issue', b.tc_licence_date_of_issue || '');
  set('drivers_licence_number', b.drivers_licence_number || '');

  if (canViewRates(req.session.user)) {
    set('rate_day', parseFloat(b.rate_day) || 0);
    set('rate_ot', parseFloat(b.rate_ot) || 0);
    set('rate_dt', parseFloat(b.rate_dt) || 0);
    set('rate_night', parseFloat(b.rate_night) || 0);
    set('rate_night_ot', parseFloat(b.rate_night_ot) || 0);
    set('rate_night_dt', parseFloat(b.rate_night_dt) || 0);
    set('rate_travel', parseFloat(b.rate_travel) || 0);
    set('rate_meal', parseFloat(b.rate_meal) || 0);
    set('rate_weekend', parseFloat(b.rate_weekend) || 0);

    // Management payroll fields — gated to admin/finance because
    // weekly_salary is sensitive. PRAGMA-guarded so a stale deploy
    // missing the column doesn't crash the whole save.
    set('on_management_payroll', (b.on_management_payroll === '1' || b.on_management_payroll === 'on') ? 1 : 0);
    set('weekly_salary', parseFloat(b.weekly_salary) || 0);
    set('super_rate', parseFloat(b.super_rate) || 0.12);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(req.params.id);

  try {
    db.prepare('UPDATE employees SET ' + sets.join(', ') + ' WHERE id = ?').run(...params);

    // Keep the linked crew_members row in sync — its full_name / email /
    // phone feed every public picker (toolbox attendance, group induction,
    // SOP sign-off) and the worker portal. Without this, capitalising
    // someone's name in the HR roster left old-case "salif hoque" sitting
    // in the public attendance link.
    try {
      const linkedRow = db.prepare('SELECT linked_crew_member_id FROM employees WHERE id = ?').get(req.params.id);
      const linkedId = linkedRow && linkedRow.linked_crew_member_id;
      if (linkedId) {
        db.prepare(`
          UPDATE crew_members
          SET full_name = ?, email = ?, phone = ?
          WHERE id = ?
        `).run(fullName, b.email || '', b.phone || '', linkedId);
      }
    } catch (e) { /* column drift ok, don't block the HR save */ }

    // --- Payroll details (bank, super, TFN) ---
    // Admin can edit these inline. We write into the encrypted payroll tables
    // (not employees.internal_notes). Each change creates a new row tagged
    // 'synced' with synced_by = the admin user, so history is preserved and
    // the /hr/secure-queue doesn't raise them as pending.
    if (canViewSensitiveHR(req.session.user)) {
      try {
        const { encrypt } = require('../services/encryption');
        const employeeId = parseInt(req.params.id, 10);

        // Bank: only act if the admin typed a new BSB/account number OR is updating the account name on an existing row
        const bsb = (b.bank_bsb || '').replace(/\s|-/g, '').trim();
        const acct = (b.bank_account_number || '').replace(/\s|-/g, '').trim();
        const accName = (b.bank_account_name || '').trim();
        if (/^\d{6}$/.test(bsb) && /^\d{6,10}$/.test(acct)) {
          db.prepare(`
            INSERT INTO bank_accounts (employee_id, account_name, bsb_last3, account_last3, bsb_encrypted, account_number_encrypted, status, synced_at, synced_by_id)
            VALUES (?, ?, ?, ?, ?, ?, 'synced', datetime('now'), ?)
          `).run(employeeId, accName, bsb.slice(-3), acct.slice(-3), encrypt(bsb), encrypt(acct), req.session.user.id);
          logActivity({
            user: req.session.user, action: 'update', entityType: 'bank_account',
            entityId: employeeId, entityLabel: b.full_name || fullName,
            details: `Admin updated bank (BSB •••${bsb.slice(-3)}, Acct •••${acct.slice(-3)}) from employee edit`,
            ip: req.ip,
          });
        } else if (accName) {
          // Name-only update on existing record
          const existing = db.prepare('SELECT id FROM bank_accounts WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employeeId);
          if (existing) db.prepare("UPDATE bank_accounts SET account_name = ?, updated_at = datetime('now') WHERE id = ?").run(accName, existing.id);
        }

        // Super: update in place if any meaningful value changed, else insert fresh
        const fundName = (b.super_fund_name || '').trim();
        const superUsi = (b.super_usi || '').trim();
        const superMember = (b.super_member_number || '').trim();
        const superAbn = (b.super_fund_abn || '').replace(/\s/g, '').trim();
        const hasAnySuper = fundName || superUsi || superMember || superAbn;
        if (hasAnySuper) {
          const existingSuper = db.prepare('SELECT * FROM super_funds WHERE employee_id = ? ORDER BY id DESC LIMIT 1').get(employeeId);
          const changed = !existingSuper ||
            existingSuper.fund_name !== fundName ||
            existingSuper.usi !== superUsi ||
            existingSuper.member_number !== superMember ||
            existingSuper.fund_abn !== superAbn;
          if (changed) {
            db.prepare(`
              INSERT INTO super_funds (employee_id, fund_name, usi, member_number, fund_abn, use_default, status, synced_at, synced_by_id)
              VALUES (?, ?, ?, ?, ?, 0, 'synced', datetime('now'), ?)
            `).run(employeeId, fundName, superUsi, superMember, superAbn, req.session.user.id);
            logActivity({
              user: req.session.user, action: 'update', entityType: 'super_fund',
              entityId: employeeId, entityLabel: b.full_name || fullName,
              details: `Admin updated super (${fundName || 'no fund name'}) from employee edit`,
              ip: req.ip,
            });
          }
        }

        // TFN: only when admin types a new 9-digit value
        const tfn = (b.tfn_number || '').replace(/\D/g, '');
        if (/^\d{9}$/.test(tfn)) {
          const residency = ['resident','foreign','working_holiday'].includes(b.tfn_residency) ? b.tfn_residency : 'resident';
          db.prepare(`
            INSERT INTO tfn_declarations (employee_id, tfn_encrypted, tfn_last3, residency_status, claim_threshold, has_help_debt, has_stsl_debt, medicare_variation, submitted_at, status, processed_at, processed_by_id)
            VALUES (?, ?, ?, ?, ?, 0, 0, 'none', datetime('now'), 'synced', datetime('now'), ?)
          `).run(employeeId, encrypt(tfn), tfn.slice(-3), residency, b.tfn_claim_threshold ? 1 : 0, req.session.user.id);
          logActivity({
            user: req.session.user, action: 'update', entityType: 'tfn_declaration',
            entityId: employeeId, entityLabel: b.full_name || fullName,
            details: `Admin set TFN (•••${tfn.slice(-3)}) from employee edit`,
            ip: req.ip,
          });
        }
      } catch (payrollErr) {
        console.error('Payroll save error (non-fatal):', payrollErr.message);
      }
    }

    req.flash('success', 'Employee updated successfully.');
  } catch (err) {
    console.error('UPDATE employee error:', err.message, { id: req.params.id, setCount: sets.length, paramCount: params.length });
    req.flash('error', 'Error updating employee: ' + err.message);
  }
  req.session.save(() => res.redirect(`/hr/employees/${req.params.id}`));
});

// ============================================
// WORKER PORTAL PIN MANAGEMENT
// ============================================

// Helper: load employee + linked crew member. Auto-creates crew member if missing.
function loadEmployeeWithCrew(req, res, opts = {}) {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return null; }

  let crewMember = null;
  if (employee.linked_crew_member_id) {
    crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(employee.linked_crew_member_id);
  }

  // Self-heal: if the linked crew_member row is unusable (deactivated
  // dupe with cleared email — the migration-206 fingerprint), re-resolve
  // to the surviving canonical row by matching employee.email. Updates
  // the link so subsequent edits / invites land on the right row.
  if (crewMember && employee.email &&
      (!crewMember.active || !crewMember.email || crewMember.email.trim() === '')) {
    try {
      const canonical = db.prepare(`
        SELECT id FROM crew_members
        WHERE active = 1 AND LOWER(email) = LOWER(?)
        ORDER BY (pin_hash IS NOT NULL AND pin_hash != '') DESC, id DESC
        LIMIT 1
      `).get(employee.email);
      if (canonical && canonical.id !== crewMember.id) {
        db.prepare('UPDATE employees SET linked_crew_member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(canonical.id, employee.id);
        employee.linked_crew_member_id = canonical.id;
        crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(canonical.id);
      }
    } catch (e) { /* fall through to standard auto-create below */ }
  }

  // Auto-create crew member if not linked and auto-create is requested
  if (!crewMember && opts.autoCreate) {
    if (!employee.email) { req.flash('error', 'Employee needs an email address before enabling portal access.'); return null; }
    try {
      // Check if a crew member with this email already exists
      const existingByEmail = db.prepare('SELECT id FROM crew_members WHERE LOWER(email) = LOWER(?)').get(employee.email);
      if (existingByEmail) {
        // Link to existing crew member and ensure they're active
        db.prepare('UPDATE crew_members SET active = 1, full_name = ? WHERE id = ?').run(employee.full_name, existingByEmail.id);
        db.prepare('UPDATE employees SET linked_crew_member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(existingByEmail.id, employee.id);
        employee.linked_crew_member_id = existingByEmail.id;
        crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(existingByEmail.id);
      } else {
        // Generate employee_id for crew member
        const lastCrew = db.prepare("SELECT employee_id FROM crew_members WHERE employee_id LIKE 'EMP-%' ORDER BY CAST(REPLACE(employee_id, 'EMP-', '') AS INTEGER) DESC LIMIT 1").get();
        let nextNum = 1;
        if (lastCrew && lastCrew.employee_id) { const n = parseInt(lastCrew.employee_id.replace('EMP-', ''), 10); if (!isNaN(n)) nextNum = n + 1; }
        const crewEmpId = employee.employee_code || ('EMP-' + String(nextNum).padStart(6, '0'));

        const result = db.prepare(`
          INSERT INTO crew_members (full_name, employee_id, role, phone, email, company, employment_type, active, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'available')
        `).run(employee.full_name, crewEmpId, employee.traffic_role_level || employee.role_title || 'Traffic Controller',
          employee.phone || '', employee.email, employee.company || 'T&S Traffic Control',
          employee.employment_type || 'casual');

        const crewId = result.lastInsertRowid;
        db.prepare('UPDATE employees SET linked_crew_member_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(crewId, employee.id);
        employee.linked_crew_member_id = crewId;
        crewMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(crewId);
        if (req.session && req.session.user) {
          logActivity({ user: req.session.user, action: 'create', entityType: 'crew_member', entityId: crewId, entityLabel: employee.full_name, details: 'Auto-created crew member from employee profile', ip: req.ip });
        }
      }
    } catch (err) {
      console.error('Auto-create crew member error:', err.message, { employeeId: employee.id, email: employee.email });
      req.flash('error', 'Error creating portal access: ' + err.message);
      return null;
    }
  }

  if (!crewMember) { req.flash('error', 'Employee is not linked to a crew member. Click "Enable Portal Access" first.'); return null; }
  return { employee, crewMember };
}

// POST /employees/:id/assign-tier — Set the worker's wage-panel tier + roster
// pattern directly from the profile page. Stamps rates from the matching
// preset and persists tier + payment_type + night_pattern atomically.
router.post('/employees/:id/assign-tier', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const empId = parseInt(req.params.id, 10);
  const employee = db.prepare('SELECT id, full_name, payment_type FROM employees WHERE id = ? AND deleted_at IS NULL').get(empId);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/employees')); }

  const tier = parseInt(req.body.tier, 10);
  // Payment type can be overridden in the same submit — fall back to the
  // worker's existing one so admins setting only the tier don't wipe it.
  const pt = String(req.body.payment_type || employee.payment_type || '').toLowerCase();
  const nightPattern = String(req.body.night_pattern || 'occasional').toLowerCase();

  if (!tier || tier < 1 || tier > 6) {
    req.flash('error', 'Pick a tier between 1 and 6.');
    return req.session.save(() => res.redirect(`/hr/employees/${empId}`));
  }
  if (!['cash', 'abn', 'tfn'].includes(pt)) {
    req.flash('error', 'Pick a payment type (Cash / ABN / TFN) before assigning a tier.');
    return req.session.save(() => res.redirect(`/hr/employees/${empId}`));
  }

  // force = the admin ticked "reset custom rates to tier defaults". Without
  // it, a worker carrying hand-edited rates (rates_overridden=1) is left alone
  // and we ask for confirmation rather than silently clobbering their rates.
  const force = !!req.body.force;

  try {
    const { stampEmployeeRates } = require('../lib/wageTiers');
    const result = stampEmployeeRates(db, empId, tier, pt, { nightPattern, force });
    if (!result.ok) {
      if (result.overridden) {
        req.flash('error', `${employee.full_name} has custom rates. Tick "Reset custom rates to tier defaults" to overwrite them with the Tier ${tier} (${pt.toUpperCase()}) preset.`);
      } else {
        req.flash('error', `Tier stamp failed: ${result.error}`);
      }
      return req.session.save(() => res.redirect(`/hr/employees/${empId}`));
    }
    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'employee',
        entityId: empId, entityLabel: employee.full_name,
        details: `Set wage tier to ${tier} (${pt.toUpperCase()}, ${nightPattern}) — rates stamped from FY26 panel${force ? ' (custom rates reset)' : ''}`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block save */ }
    req.flash('success', `${employee.full_name} set to Tier ${tier} (${pt.toUpperCase()}). Rates stamped from the wage panel.`);
  } catch (e) {
    console.error('[/hr/employees/:id/assign-tier]', e);
    req.flash('error', `Could not assign tier: ${e.message}`);
  }
  return req.session.save(() => res.redirect(`/hr/employees/${empId}`));
});

// POST /employees/:id/rates — adjust an individual worker's rates + allowance
// blocks straight from their roster profile. Writes employees.rate_* / block_*
// directly (the single source of truth read by the Worker Rates grid, the
// worker portal, and the next pay run). When the saved rates diverge from the
// worker's tier preset we set rates_overridden so a later tier re-stamp won't
// quietly wipe these hand edits.
router.post('/employees/:id/rates', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const empId = parseInt(req.params.id, 10);
  const employee = db.prepare('SELECT id, full_name, tier, payment_type, night_pattern FROM employees WHERE id = ? AND deleted_at IS NULL').get(empId);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/employees')); }

  try {
    const empCols = new Set(db.prepare("PRAGMA table_info(employees)").all().map(c => c.name));
    const RATE_COLS = [
      'rate_day', 'rate_ot', 'rate_dt',
      'rate_night', 'rate_night_5plus',
      'rate_weekend_short', 'rate_weekend', 'rate_public_holiday',
      'rate_fares_daily', 'rate_meal',
    ].filter(c => empCols.has(c));

    const sets = [];
    const params = [];
    const submitted = {};
    for (const col of RATE_COLS) {
      if (req.body[col] === undefined) continue; // only update posted fields
      const n = parseFloat(req.body[col]);
      const v = Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
      sets.push(`${col} = ?`); params.push(v);
      submitted[col] = v;
    }
    // Allowance blocks (unchecked checkbox posts nothing → 0).
    if (empCols.has('block_travel_allowance')) { sets.push('block_travel_allowance = ?'); params.push(req.body.block_travel_allowance ? 1 : 0); }
    if (empCols.has('block_meal_allowance')) { sets.push('block_meal_allowance = ?'); params.push(req.body.block_meal_allowance ? 1 : 0); }

    // Decide the override flag from the submitted rates vs the tier preset.
    if (empCols.has('rates_overridden')) {
      const { ratesDivergeFromPreset } = require('../lib/wageTiers');
      const probe = Object.assign({
        tier: employee.tier, payment_type: employee.payment_type, night_pattern: employee.night_pattern,
      }, submitted);
      sets.push('rates_overridden = ?'); params.push(ratesDivergeFromPreset(db, probe) ? 1 : 0);
    }
    if (empCols.has('updated_at')) sets.push('updated_at = CURRENT_TIMESTAMP');

    if (!sets.length) { req.flash('error', 'No rate fields submitted.'); return req.session.save(() => res.redirect(`/hr/employees/${empId}`)); }
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...params, empId);

    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'employee',
        entityId: empId, entityLabel: employee.full_name,
        details: `Adjusted individual rates/allowance blocks${req.body.block_travel_allowance ? ' [travel blocked]' : ''}${req.body.block_meal_allowance ? ' [meal blocked]' : ''}`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block save */ }
    req.flash('success', `Saved rates for ${employee.full_name}. Changes apply to the Worker Rates grid, their portal, and future pay runs.`);
  } catch (e) {
    console.error('[/hr/employees/:id/rates]', e);
    req.flash('error', `Could not save rates: ${e.message}`);
  }
  return req.session.save(() => res.redirect(`/hr/employees/${empId}`));
});

// POST /employees/:id/enable-portal — Auto-create crew member + link + activate
router.post('/employees/:id/enable-portal', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}`);
  // Ensure the crew member is active for portal login
  const db = getDb();
  db.prepare('UPDATE crew_members SET active = 1 WHERE id = ?').run(data.crewMember.id);
  req.flash('success', `Portal access enabled for ${data.employee.full_name}. You can now set a PIN or send an invite.`);
  req.session.save(() => res.redirect(`/hr/employees/${req.params.id}#workforce`));
});

// POST /employees/:id/set-pin — Set or reset worker portal PIN
router.post('/employees/:id/set-pin', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  const { pin } = req.body;
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
  }

  const pinHash = bcrypt.hashSync(pin, 12);
  getDb().prepare('UPDATE crew_members SET pin_hash = ?, pin_plain = ?, pin_set_at = CURRENT_TIMESTAMP, pin_set_by_id = ? WHERE id = ?')
    .run(pinHash, pin, req.session.user.id, crewMember.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: crewMember.id, entityLabel: crewMember.full_name, details: 'Set worker portal PIN (from HR)', ip: req.ip });
  req.flash('success', 'Portal PIN set for ' + crewMember.full_name);
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
});

// POST /employees/:id/clear-pin — Remove worker portal PIN
router.post('/employees/:id/clear-pin', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res);
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  getDb().prepare('UPDATE crew_members SET pin_hash = NULL, pin_plain = NULL, pin_set_at = NULL, pin_set_by_id = NULL WHERE id = ?')
    .run(crewMember.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: crewMember.id, entityLabel: crewMember.full_name, details: 'Cleared worker portal PIN (from HR)', ip: req.ip });
  req.flash('success', 'Portal PIN cleared for ' + crewMember.full_name);
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
});

// POST /employees/:id/toggle-manager — Grant or revoke manager portal access
router.post('/employees/:id/toggle-manager', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  const enable = req.body.enable === '1';
  getDb().prepare('UPDATE crew_members SET is_manager = ? WHERE id = ?').run(enable ? 1 : 0, crewMember.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'crew_member',
    entityId: crewMember.id, entityLabel: crewMember.full_name,
    details: enable ? 'Granted manager portal access' : 'Revoked manager portal access',
    ip: req.ip,
  });
  req.flash('success', enable ? `${crewMember.full_name} is now a manager in the portal.` : `Manager access removed for ${crewMember.full_name}.`);
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
});

// POST /employees/:id/payment-type — inline change to TFN / ABN / Cash
// from the roster + employees lists. Mirrors the portal_role pattern
// below so the office can flip an employee's pay arrangement without
// drilling into the detail page.
router.post('/employees/:id/payment-type', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, first_name, last_name, payment_type FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) {
    req.flash('error', 'Employee not found.');
    return req.session.save(() => res.redirect('/hr/roster'));
  }
  const pt = (req.body.payment_type || '').toLowerCase();
  const allowed = ['', 'cash', 'tfn', 'abn'];
  if (!allowed.includes(pt)) {
    req.flash('error', 'Invalid payment type.');
    return req.session.save(() => res.redirect(req.headers.referer || '/hr/roster'));
  }
  db.prepare('UPDATE employees SET payment_type = ? WHERE id = ?').run(pt, employee.id);
  const fullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || ('Employee #' + employee.id);
  const friendly = pt ? pt.toUpperCase() : 'cleared';
  logActivity({
    user: req.session.user, action: 'update', entityType: 'employee',
    entityId: employee.id, entityLabel: fullName,
    details: `Payment type set to ${friendly}`, ip: req.ip,
  });
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.json({ success: true, payment_type: pt });
  }
  req.flash('success', `${fullName} payment type set to ${friendly}.`);
  return req.session.save(() => res.redirect(req.headers.referer || '/hr/roster'));
});

// POST /employees/:id/management-payroll — toggle on_management_payroll.
// Gated to admin/finance/accounts because management salaries are
// sensitive; HR users can't see this control. Mirrors the
// payment-type/portal-role inline-edit pattern (JSON when xhr,
// flash + redirect otherwise).
router.post('/employees/:id/management-payroll', requirePermission('payroll'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, first_name, last_name FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) {
    if ((req.headers.accept || '').includes('application/json')) return res.status(404).json({ error: 'Employee not found' });
    req.flash('error', 'Employee not found.');
    return req.session.save(() => res.redirect('/hr/roster'));
  }
  const flag = (req.body.on_management_payroll === '1' || req.body.on_management_payroll === 1 || req.body.on_management_payroll === true || req.body.on_management_payroll === 'on') ? 1 : 0;
  db.prepare('UPDATE employees SET on_management_payroll = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(flag, employee.id);
  const fullName = `${employee.first_name || ''} ${employee.last_name || ''}`.trim() || ('Employee #' + employee.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'employee',
    entityId: employee.id, entityLabel: fullName,
    details: `Management payroll ${flag ? 'enabled' : 'disabled'}`, ip: req.ip,
  });
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.json({ success: true, on_management_payroll: flag });
  }
  req.flash('success', `${fullName} management payroll ${flag ? 'enabled' : 'disabled'}.`);
  return req.session.save(() => res.redirect(req.headers.referer || '/hr/roster'));
});

// POST /employees/:id/portal-role — Set the worker's portal_role tier.
// Hierarchy: traffic_controller (default) ⊂ team_leader ⊂ supervisor.
router.post('/employees/:id/portal-role', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  const role = req.body.portal_role;
  const allowed = ['traffic_controller','team_leader','supervisor'];
  if (!allowed.includes(role)) {
    req.flash('error', 'Invalid portal role.');
    return req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
  }
  const db = getDb();
  db.prepare('UPDATE crew_members SET portal_role = ? WHERE id = ?').run(role, crewMember.id);
  // Keep the legacy is_manager flag in sync so any code still reading it
  // (older routes, dashboards) treats team_leader+ as managers without
  // needing a wider refactor.
  db.prepare('UPDATE crew_members SET is_manager = ? WHERE id = ?').run(role === 'traffic_controller' ? 0 : 1, crewMember.id);
  const friendly = { traffic_controller: 'Traffic Controller', team_leader: 'Team Leader', supervisor: 'Supervisor' }[role];
  logActivity({
    user: req.session.user, action: 'update', entityType: 'crew_member',
    entityId: crewMember.id, entityLabel: crewMember.full_name,
    details: `Portal role set to ${friendly}`, ip: req.ip,
  });
  if (req.xhr || (req.headers.accept || '').includes('application/json')) {
    return res.json({ success: true, portal_role: role });
  }
  req.flash('success', `${crewMember.full_name} is now ${friendly}.`);
  // Bounce back to wherever the form was submitted from — roster page,
  // dashboard, or the employee detail itself — instead of always
  // dragging the user out of the list view.
  const ref = req.get('referrer') || '';
  if (ref.includes('/hr/roster')) return req.session.save(() => res.redirect('/hr/roster'));
  if (ref.includes('/hr') && !ref.includes('/employees/')) return req.session.save(() => res.redirect(ref));
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
});

// POST /employees/:id/send-invite — Send email invitation for worker portal
router.post('/employees/:id/send-invite', requirePermission('hr_employees'), async (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  // Only send invite emails for active employees
  if (employee.employment_status !== 'active') {
    req.flash('error', 'Employee must be set to Active before sending an invite email.');
    return req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
  }

  // Backfill the crew_member's email from the employees record if it's
  // missing (e.g. cleared by the dedupe migration). Lets the invite
  // succeed even if the data is mid-migration.
  if (!crewMember.email && employee.email) {
    try {
      getDb().prepare('UPDATE crew_members SET email = ? WHERE id = ?').run(employee.email, crewMember.id);
      crewMember.email = employee.email;
    } catch (e) { /* fall through */ }
  }
  if (!crewMember.email) {
    req.flash('error', 'Crew member needs an email address to receive an invite. Please set the worker\'s email on the HR profile first.');
    return req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
  }
  if (!crewMember.active) {
    try {
      getDb().prepare('UPDATE crew_members SET active = 1 WHERE id = ?').run(crewMember.id);
      crewMember.active = 1;
    } catch (e) { /* fall through */ }
  }

  try {
    const db = getDb();
    // If the worker already set their PIN, "Email Invite" can't send them
    // to /w/setup any more (that token only works once). Send a Reset PIN
    // link instead — same email button, smart payload.
    const hasPin = !!crewMember.pin_hash;
    const tokenType = hasPin ? 'pin_reset' : 'crew_member';

    // Invalidate any earlier unused tokens of this type for this worker
    // so the previous email they have sitting in Gmail can't be clicked
    // (the user reported clicking an older email landed on
    // "link is invalid or expired"). The freshest email is now the only
    // valid one.
    db.prepare(
      "UPDATE invitations SET used_at = CURRENT_TIMESTAMP WHERE type = ? AND target_id = ? AND used_at IS NULL"
    ).run(tokenType, crewMember.id);

    const { token } = createInvitation({
      type: tokenType,
      targetId: crewMember.id,
      email: crewMember.email,
      createdById: req.session.user.id,
    });
    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    const linkUrl = hasPin
      ? `${baseUrl}/w/reset-pin/${token}`
      : `${baseUrl}/w/setup/${token}`;
    const subject = hasPin
      ? 'Reset your Atomis Crew PIN'
      : 'Set up your Atomis Crew PIN';
    const html = hasPin
      ? pinResetEmail(crewMember.full_name, linkUrl, TOKEN_EXPIRY_HOURS)
      : workerInviteEmail(crewMember.full_name, linkUrl, TOKEN_EXPIRY_HOURS);
    await sendEmail(crewMember.email, subject, html);

    logActivity({
      user: req.session.user, action: 'update', entityType: 'crew_member',
      entityId: crewMember.id, entityLabel: crewMember.full_name,
      details: hasPin ? 'Sent worker portal PIN reset link (from HR)' : 'Sent worker portal email invitation (from HR)',
      ip: req.ip,
    });
    req.flash('success', hasPin
      ? `Sent a Reset PIN link to ${crewMember.email}.`
      : `Invitation email sent to ${crewMember.email}.`
    );
  } catch (err) {
    console.error('Send invite error:', err);
    req.flash('error', 'Failed to send invitation email.');
  }
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#workforce`));
});

// ============================================
// DOCUMENT UPLOAD
// ============================================
router.post('/employees/:id/documents/upload', requirePermission('hr_documents'), upload.single('file'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee || !req.file) { req.flash('error', 'Upload failed.'); return req.session.save(() => res.redirect('back')); }

  const b = req.body;
  const docType = b.document_type || 'other';
  const issueDate = b.issue_date || null;
  const expiryDate = b.expiry_date || null;

  const docResult = db.prepare(`
    INSERT INTO employee_documents (employee_id, document_type, document_name, filename, original_name, file_path, file_size,
      issue_date, expiry_date, mandatory, notes, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employee.id, docType, b.document_name || req.file.originalname,
    req.file.filename, req.file.originalname, req.file.path, req.file.size,
    issueDate, expiryDate, b.mandatory ? 1 : 0,
    b.notes || '', req.session.user.id
  );

  // Mirror licence/ticket uploads into employee_competencies so they show
  // up in compliance views, expiry alerts and the worker wallet — same
  // behaviour as induction approval. Idempotent.
  try {
    const { ensureCompetencyForDoc } = require('../lib/competencyMap');
    ensureCompetencyForDoc(db, {
      employeeId:   employee.id,
      documentId:   docResult.lastInsertRowid,
      documentType: docType,
      issueDate,
      expiryDate,
      source: `Auto-created from manual document upload by ${req.session.user.username || 'admin'}`,
    });
  } catch (e) { console.error('competency auto-create failed:', e.message); }

  req.flash('success', 'Document uploaded.');
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#documents`));
});

// ============================================
// DOCUMENT VERIFY / REJECT
// ============================================
router.post('/documents/:id/verify', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('back')); }

  const action = req.body.action; // 'verify' or 'reject'
  const newStatus = action === 'reject' ? 'rejected' : 'verified';

  db.prepare('UPDATE employee_documents SET verification_status = ?, verified_by_id = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, req.session.user.id, doc.id);

  req.flash('success', `Document ${newStatus}.`);
  req.session.save(() => res.redirect(`/hr/employees/${doc.employee_id}#documents`));
});

// ============================================
// DOCUMENT DOWNLOAD
// ============================================
router.get('/documents/:id/download', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('back')); }

  if (!fs.existsSync(doc.file_path)) {
    req.flash('error', 'File not found on disk.');
    return req.session.save(() => res.redirect('back'));
  }

  // If ?inline=1 or the request is for an image, serve inline for preview
  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif)$/i.test(doc.original_name || doc.filename);
  if (req.query.inline || isImage) {
    const ext = path.extname(doc.original_name || doc.filename).toLowerCase();
    const mimeTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.pdf': 'application/pdf' };
    const mime = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${doc.original_name || doc.filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.resolve(doc.file_path));
  }

  res.download(doc.file_path, doc.original_name);
});

// ============================================
// DOCUMENT DELETE
// ============================================
router.post('/documents/:id/delete', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('back')); }

  // Delete file from disk
  try { if (fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path); } catch (e) { /* ignore */ }

  db.prepare('DELETE FROM employee_documents WHERE id = ?').run(doc.id);
  req.flash('success', 'Document deleted.');
  req.session.save(() => res.redirect(`/hr/employees/${doc.employee_id}#documents`));
});

// ============================================
// DOCUMENTS LIST (central view)
// ============================================
router.get('/documents', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const { document_type, verification_status, expiry, employee_id, company, mandatory } = req.query;

  let where = '1=1';
  const params = [];
  if (document_type) { where += ' AND ed.document_type = ?'; params.push(document_type); }
  if (verification_status) { where += ' AND ed.verification_status = ?'; params.push(verification_status); }
  if (employee_id) { where += ' AND ed.employee_id = ?'; params.push(employee_id); }
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (mandatory === '1') { where += ' AND ed.mandatory = 1'; }
  if (expiry === 'expired') { where += " AND ed.expiry_date < DATE('now')"; }
  if (expiry === '7days') { where += " AND ed.expiry_date BETWEEN DATE('now') AND DATE('now', '+7 days')"; }
  if (expiry === '30days') { where += " AND ed.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days')"; }

  const documents = db.prepare(`
    SELECT ed.*, e.full_name as employee_name, e.employee_code, e.company as employee_company,
      u.full_name as uploaded_by_name, v.full_name as verified_by_name
    FROM employee_documents ed
    JOIN employees e ON ed.employee_id = e.id
    LEFT JOIN users u ON ed.uploaded_by_id = u.id
    LEFT JOIN users v ON ed.verified_by_id = v.id
    WHERE ${where}
    ORDER BY ed.created_at DESC
  `).all(...params);

  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const settingsOptions = res.locals.settingsOptions || {};

  res.render('hr/documents', {
    title: 'HR Documents',
    currentPage: 'hr-documents',
    documents,
    filters: { document_type, verification_status, expiry, employee_id, company, mandatory },
    filterOptions: { companies },
    settingsOptions,
    user: req.session.user
  });
});

// ============================================
// COMPETENCIES LIST
// ============================================
router.get('/competencies', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const { competency_type, status, company, mandatory, view } = req.query;

  // Refresh all statuses first
  db.prepare(`UPDATE employee_competencies SET status = 'expired' WHERE expiry_date IS NOT NULL AND expiry_date < DATE('now') AND status NOT IN ('suspended','missing')`).run();
  db.prepare(`UPDATE employee_competencies SET status = 'expiring_soon' WHERE expiry_date IS NOT NULL AND expiry_date >= DATE('now') AND expiry_date <= DATE('now', '+30 days') AND status NOT IN ('expired','suspended','missing')`).run();

  let where = '1=1';
  const params = [];
  if (competency_type) { where += ' AND ec.competency_type = ?'; params.push(competency_type); }
  if (status) { where += ' AND ec.status = ?'; params.push(status); }
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (mandatory === '1') { where += ' AND ec.mandatory_for_role = 1'; }
  if (view === '7days') { where += " AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+7 days')"; }
  if (view === '30days') { where += " AND ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days')"; }
  if (view === 'expired') { where += " AND ec.expiry_date < DATE('now')"; }
  if (view === 'missing') { where += " AND ec.status = 'missing'"; }

  const competencies = db.prepare(`
    SELECT ec.*, e.full_name as employee_name, e.employee_code, e.company as employee_company,
      ed.original_name as linked_doc_name
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    LEFT JOIN employee_documents ed ON ec.linked_document_id = ed.id
    WHERE ${where} AND e.active = 1
    ORDER BY ec.expiry_date ASC NULLS LAST
  `).all(...params);

  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' ORDER BY company").all().map(r => r.company);
  const settingsOptions = res.locals.settingsOptions || {};

  // Stats
  const totalExpired = db.prepare("SELECT COUNT(*) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ec.status = 'expired' AND e.active = 1").get().c;
  const totalExpiring = db.prepare("SELECT COUNT(*) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ec.status = 'expiring_soon' AND e.active = 1").get().c;
  const totalMissing = db.prepare("SELECT COUNT(*) as c FROM employee_competencies ec JOIN employees e ON ec.employee_id = e.id WHERE ec.status = 'missing' AND e.active = 1").get().c;

  res.render('hr/competencies', {
    title: 'Licences & Competencies',
    currentPage: 'hr-competencies',
    competencies,
    stats: { totalExpired, totalExpiring, totalMissing },
    filters: { competency_type, status, company, mandatory, view },
    filterOptions: { companies },
    settingsOptions,
    user: req.session.user
  });
});

// ============================================
// ADD COMPETENCY
// ============================================
router.post('/employees/:id/competencies', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('back')); }

  db.prepare(`
    INSERT INTO employee_competencies (employee_id, competency_type, competency_name, competency_level,
      issue_date, expiry_date, status, mandatory_for_role, linked_document_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employee.id, b.competency_type || 'other', b.competency_name || '',
    b.competency_level || '', b.issue_date || null, b.expiry_date || null,
    b.status || 'valid', b.mandatory_for_role ? 1 : 0,
    b.linked_document_id || null, b.notes || ''
  );

  refreshCompetencyStatuses(db, employee.id);
  req.flash('success', 'Competency added.');
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}#competencies`));
});

// ============================================
// UPDATE COMPETENCY
// ============================================
router.post('/competencies/:id', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const comp = db.prepare('SELECT * FROM employee_competencies WHERE id = ?').get(req.params.id);
  if (!comp) { req.flash('error', 'Competency not found.'); return req.session.save(() => res.redirect('back')); }

  db.prepare(`
    UPDATE employee_competencies SET competency_type = ?, competency_name = ?, competency_level = ?,
      issue_date = ?, expiry_date = ?, status = ?, mandatory_for_role = ?,
      linked_document_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    b.competency_type || 'other', b.competency_name || '', b.competency_level || '',
    b.issue_date || null, b.expiry_date || null, b.status || 'valid',
    b.mandatory_for_role ? 1 : 0, b.linked_document_id || null, b.notes || '',
    comp.id
  );

  refreshCompetencyStatuses(db, comp.employee_id);
  req.flash('success', 'Competency updated.');
  req.session.save(() => res.redirect(`/hr/employees/${comp.employee_id}#competencies`));
});

// ============================================
// DELETE COMPETENCY
// ============================================
router.post('/competencies/:id/delete', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const comp = db.prepare('SELECT * FROM employee_competencies WHERE id = ?').get(req.params.id);
  if (!comp) { req.flash('error', 'Competency not found.'); return req.session.save(() => res.redirect('back')); }

  db.prepare('DELETE FROM employee_competencies WHERE id = ?').run(comp.id);
  req.flash('success', 'Competency removed.');
  req.session.save(() => res.redirect(`/hr/employees/${comp.employee_id}#competencies`));
});

// ============================================
// TRAINING RECORDS (in-house) — CRUD
// Reuses the hr_competencies permission since these are functionally the
// same audience: HR admins managing per-employee skill/training history.
// All routes redirect back to the Training tab on the employee profile.
// ============================================
function findEmployeeCrewIds(db, employeeId) {
  const employee = db.prepare('SELECT id, linked_crew_member_id FROM employees WHERE id = ?').get(employeeId);
  if (!employee || !employee.linked_crew_member_id) return null;
  return { employeeId: employee.id, crewMemberId: employee.linked_crew_member_id };
}

router.post('/employees/:id/training-records', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const ids = findEmployeeCrewIds(db, req.params.id);
  if (!ids) {
    req.flash('error', 'Link a crew member from the Linked Workforce tab before adding training.');
    return req.session.save(() => res.redirect(`/hr/employees/${req.params.id}#training`));
  }
  const b = req.body;
  const trainingName = (b.training_name || '').toString().trim().slice(0, 200);
  if (!trainingName) {
    req.flash('error', 'Training name is required.');
    return req.session.save(() => res.redirect(`/hr/employees/${ids.employeeId}#training`));
  }
  db.prepare(`
    INSERT INTO training_records
      (crew_member_id, employee_id, training_name, completed_date, expiry_date,
       trainer_name, notes, certificate_url, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ids.crewMemberId, ids.employeeId, trainingName,
    b.completed_date || null, b.expiry_date || null,
    (b.trainer_name || '').toString().trim().slice(0, 200),
    (b.notes || '').toString().slice(0, 2000),
    (b.certificate_url || '').toString().trim().slice(0, 500),
    req.session.user ? req.session.user.id : null
  );
  req.flash('success', `Added "${trainingName}".`);
  req.session.save(() => res.redirect(`/hr/employees/${ids.employeeId}#training`));
});

router.post('/training-records/:id', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT id, employee_id FROM training_records WHERE id = ?').get(req.params.id);
  if (!rec) { req.flash('error', 'Training record not found.'); return req.session.save(() => res.redirect('back')); }
  const b = req.body;
  const trainingName = (b.training_name || '').toString().trim().slice(0, 200);
  if (!trainingName) {
    req.flash('error', 'Training name is required.');
    return req.session.save(() => res.redirect(`/hr/employees/${rec.employee_id}#training`));
  }
  db.prepare(`
    UPDATE training_records SET
      training_name = ?, completed_date = ?, expiry_date = ?,
      trainer_name = ?, notes = ?, certificate_url = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    trainingName, b.completed_date || null, b.expiry_date || null,
    (b.trainer_name || '').toString().trim().slice(0, 200),
    (b.notes || '').toString().slice(0, 2000),
    (b.certificate_url || '').toString().trim().slice(0, 500),
    rec.id
  );
  req.flash('success', 'Training record updated.');
  req.session.save(() => res.redirect(`/hr/employees/${rec.employee_id}#training`));
});

router.post('/training-records/:id/delete', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT id, employee_id, training_name FROM training_records WHERE id = ?').get(req.params.id);
  if (!rec) { req.flash('error', 'Training record not found.'); return req.session.save(() => res.redirect('back')); }
  db.prepare('DELETE FROM training_records WHERE id = ?').run(rec.id);
  req.flash('success', `Removed "${rec.training_name}".`);
  req.session.save(() => res.redirect(`/hr/employees/${rec.employee_id}#training`));
});

// ============================================
// HR REPORTS
// ============================================
router.get('/reports', requirePermission('hr_reports'), (req, res) => {
  const db = getDb();

  // Headcount by company
  const headcountByCompany = db.prepare(`
    SELECT company, COUNT(*) as count, employment_type
    FROM employees WHERE active = 1 AND company != ''
    GROUP BY company, employment_type ORDER BY company
  `).all();

  // Headcount by division
  const headcountByDivision = db.prepare(`
    SELECT division, COUNT(*) as count
    FROM employees WHERE active = 1 AND division != ''
    GROUP BY division ORDER BY count DESC
  `).all();

  // Employment type breakdown
  const employmentTypes = db.prepare(`
    SELECT employment_type, COUNT(*) as count
    FROM employees WHERE active = 1
    GROUP BY employment_type ORDER BY count DESC
  `).all();

  // Expiring competencies
  const expiringCompetencies = db.prepare(`
    SELECT ec.*, e.full_name, e.employee_code
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    WHERE ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+30 days') AND e.active = 1
    ORDER BY ec.expiry_date ASC
  `).all();

  // Missing mandatory documents
  const missingDocs = db.prepare(`
    SELECT e.id, e.full_name, e.employee_code, e.company,
      COUNT(CASE WHEN ed.verification_status != 'verified' THEN 1 END) as unverified_count
    FROM employees e
    LEFT JOIN employee_documents ed ON ed.employee_id = e.id AND ed.mandatory = 1
    WHERE e.active = 1
    GROUP BY e.id
    HAVING unverified_count > 0
    ORDER BY unverified_count DESC
  `).all();

  // Blocked workers
  const blockedWorkers = db.prepare(`
    SELECT id, full_name, employee_code, company, block_reason
    FROM employees WHERE blocked_from_allocation = 1 AND active = 1
    ORDER BY full_name
  `).all();

  // Headcount by employment status
  const headcountByStatus = db.prepare(`
    SELECT employment_status, COUNT(*) as count
    FROM employees
    GROUP BY employment_status
    ORDER BY count DESC
  `).all();

  // Expiring competencies in next 90 days (for timeline chart)
  const expiringCompetencies90 = db.prepare(`
    SELECT ec.*, e.full_name, e.employee_code,
      CAST(julianday(ec.expiry_date) - julianday('now') AS INTEGER) as days_left
    FROM employee_competencies ec
    JOIN employees e ON ec.employee_id = e.id
    WHERE ec.expiry_date BETWEEN DATE('now') AND DATE('now', '+90 days') AND e.active = 1
    ORDER BY ec.expiry_date ASC
  `).all();

  // Compliance rate calculation
  const totalActive = db.prepare("SELECT COUNT(*) as count FROM employees WHERE active = 1").get().count;
  const blockedCount = blockedWorkers.length;
  const complianceRate = totalActive > 0 ? Math.round(((totalActive - blockedCount) / totalActive) * 100) : 100;

  res.render('hr/reports', {
    title: 'HR Reports',
    currentPage: 'hr-reports',
    headcountByCompany,
    headcountByDivision,
    employmentTypes,
    expiringCompetencies,
    missingDocs,
    blockedWorkers,
    headcountByStatus,
    expiringCompetencies90,
    complianceRate,
    totalActive,
    blockedCount,
    user: req.session.user
  });
});

// ============================================
// COMPLIANCE VIEW (for ops/planning — read-only)
// ============================================
router.get('/compliance', requirePermission('hr_compliance_view'), (req, res) => {
  const db = getDb();
  const { company, search } = req.query;

  let where = "e.active = 1";
  const params = [];
  if (company) { where += ' AND e.company = ?'; params.push(company); }
  if (search) { where += ' AND (e.full_name LIKE ? OR e.employee_code LIKE ?)'; const s = `%${search}%`; params.push(s, s); }

  const employees = db.prepare(`
    SELECT e.id, e.employee_code, e.full_name, e.company, e.division, e.role_title,
      e.employment_status, e.allocatable, e.blocked_from_allocation, e.block_reason,
      e.induction_status,
      (SELECT MIN(ec.expiry_date) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.expiry_date IS NOT NULL AND ec.expiry_date >= DATE('now')) as next_expiry,
      (SELECT COUNT(*) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.status = 'expired') as expired_count,
      (SELECT COUNT(*) FROM employee_competencies ec WHERE ec.employee_id = e.id AND ec.status = 'expiring_soon') as expiring_count
    FROM employees e
    WHERE ${where}
    ORDER BY e.full_name
  `).all(...params);

  employees.forEach(emp => {
    if (emp.blocked_from_allocation) emp.readiness = { status: 'blocked', color: 'red' };
    else if (emp.employment_status === 'on_leave') emp.readiness = { status: 'on_leave', color: 'blue' };
    else if (emp.expired_count > 0) emp.readiness = { status: 'non_compliant', color: 'red' };
    else if (emp.expiring_count > 0) emp.readiness = { status: 'ready_with_warnings', color: 'amber' };
    else emp.readiness = { status: 'ready', color: 'green' };
  });

  const companies = db.prepare("SELECT DISTINCT company FROM employees WHERE company != '' AND active = 1 ORDER BY company").all().map(r => r.company);

  res.render('hr/compliance-view', {
    title: 'Workforce Compliance',
    currentPage: 'hr-compliance',
    employees,
    filters: { company, search },
    filterOptions: { companies },
    user: req.session.user
  });
});

// ============================================
// INLINE EMPLOYMENT STATUS CHANGE (roster picker)
// ============================================
router.post('/employees/:id/employment-status', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const allowed = ['active', 'reserved', 'on_leave', 'inactive', 'terminated'];
  const next = String(req.body.employment_status || '').trim();
  if (!allowed.includes(next)) {
    if (isJson) return res.status(400).json({ error: 'Invalid status' });
    req.flash('error', 'Invalid status.');
    return req.session.save(() => res.redirect(req.get('referer') || '/hr/roster'));
  }
  const emp = db.prepare('SELECT id FROM employees WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
  if (!emp) {
    if (isJson) return res.status(404).json({ error: 'Employee not found' });
    req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/roster'));
  }
  // active flag: 1 for active/reserved/on_leave (can still access portal), 0 for inactive/terminated
  const activeFlag = (next === 'inactive' || next === 'terminated') ? 0 : 1;
  db.prepare('UPDATE employees SET employment_status = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(next, activeFlag, emp.id);
  if (isJson) return res.json({ ok: true, employment_status: next });
  req.flash('success', `Status updated to ${next.replace(/_/g, ' ')}.`);
  req.session.save(() => res.redirect(req.get('referer') || '/hr/roster'));
});

// Bulk employment-status change — used by the roster bulk bar.
router.post('/roster/bulk-status', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const allowed = ['active', 'reserved', 'on_leave', 'inactive', 'terminated'];
  const next = String(req.body.employment_status || '').trim();
  if (!allowed.includes(next)) {
    req.flash('error', 'Invalid status.');
    return req.session.save(() => res.redirect(req.get('referer') || '/hr/roster'));
  }
  let ids = req.body.employee_ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return req.session.save(() => res.redirect('/hr/roster')); }
  if (!Array.isArray(ids)) ids = String(ids).split(',');
  ids = ids.map(id => parseInt(id, 10)).filter(n => Number.isFinite(n));
  if (!ids.length) { req.flash('error', 'No valid employees selected.'); return req.session.save(() => res.redirect('/hr/roster')); }
  const activeFlag = (next === 'inactive' || next === 'terminated') ? 0 : 1;
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(`UPDATE employees SET employment_status = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE deleted_at IS NULL AND id IN (${placeholders})`)
    .run(next, activeFlag, ...ids);
  req.flash('success', `Updated ${result.changes} employee${result.changes === 1 ? '' : 's'} to ${next.replace(/_/g, ' ')}.`);
  req.session.save(() => res.redirect(req.get('referer') || '/hr/roster'));
});

// ============================================
// DEACTIVATE / REACTIVATE EMPLOYEE
// ============================================
router.post('/employees/:id/toggle-active', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, employment_status, active FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/employees')); }

  const action = req.body.action; // 'deactivate' or 'reactivate'
  if (action === 'deactivate') {
    db.prepare('UPDATE employees SET employment_status = ?, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('inactive', employee.id);
    req.flash('success', 'Employee deactivated.');
  } else if (action === 'reactivate') {
    db.prepare('UPDATE employees SET employment_status = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('active', employee.id);
    req.flash('success', 'Employee reactivated.');
  }
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}`));
});

// ============================================
// BLOCK / UNBLOCK EMPLOYEE
// ============================================
router.post('/employees/:id/block', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const action = req.body.action; // 'block' or 'unblock'
  if (action === 'unblock') {
    db.prepare('UPDATE employees SET blocked_from_allocation = 0, block_reason = "", updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    req.flash('success', 'Employee unblocked from allocation.');
  } else {
    db.prepare('UPDATE employees SET blocked_from_allocation = 1, block_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.block_reason || '', req.params.id);
    req.flash('success', 'Employee blocked from allocation.');
  }
  req.session.save(() => res.redirect(`/hr/employees/${req.params.id}`));
});

// ============================================
// SOP SIGN-LINK MANAGEMENT
// ============================================
// Helper: get or create an open individual signing session for a crew member.
// Re-uses an existing open session for the current SOP version so we don't
// orphan tokens every time the admin clicks "Send link".
function getOrCreateIndividualSession(db, crewMemberId, createdById) {
  const version = currentSopVersion();
  const existing = db.prepare(`
    SELECT * FROM sop_signing_sessions
    WHERE target_crew_member_id = ? AND sop_version = ? AND closed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(crewMemberId, version);
  if (existing) return existing;

  const token = crypto.randomBytes(8).toString('hex');
  const result = db.prepare(`
    INSERT INTO sop_signing_sessions (token, title, sop_version, target_crew_member_id, created_by_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, 'Individual sign-off', version, crewMemberId, createdById);
  return db.prepare('SELECT * FROM sop_signing_sessions WHERE id = ?').get(result.lastInsertRowid);
}

function buildSignUrl(req, token) {
  const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/sop-sign/${token}`;
}

// POST /hr/employees/:id/sop-link — generate a sign link, optionally email it.
// Returns the URL on the flash so the admin can copy/paste; sends email if
// action=email and the linked crew member has an email on file.
router.post('/employees/:id/sop-link', requirePermission('hr_employees'), async (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, full_name, email, linked_crew_member_id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/roster')); }
  if (!employee.linked_crew_member_id) {
    req.flash('error', 'This employee has no linked crew record yet — can\'t generate a sign link.');
    return req.session.save(() => res.redirect(`/hr/employees/${employee.id}`));
  }

  const session = getOrCreateIndividualSession(db, employee.linked_crew_member_id, req.session.user.id);
  const signUrl = buildSignUrl(req, session.token);
  const action = (req.body.action || 'copy').toLowerCase();

  if (action === 'email') {
    const recipient = (req.body.email || employee.email || '').trim();
    if (!recipient) {
      req.flash('error', 'No email on file for this person — use Copy Link instead, or set their email first.');
      return req.session.save(() => res.redirect(`/hr/employees/${employee.id}`));
    }
    try {
      await sendEmail(recipient, 'Action required: SOP sign-off', sopSignLinkEmail(employee.full_name, signUrl));
      db.prepare("UPDATE sop_signing_sessions SET sent_to_email = ?, sent_at = datetime('now') WHERE id = ?").run(recipient, session.id);
      logActivity({ user: req.session.user, action: 'update', entityType: 'sop_acknowledgement_request',
        entityId: employee.id, entityLabel: employee.full_name,
        details: `Emailed SOP sign link to ${recipient}`, ip: req.ip });
      req.flash('success', `SOP sign link emailed to ${recipient}.`);
    } catch (e) {
      console.error('SOP email failed:', e.message);
      req.flash('error', `Email failed: ${e.message}. The link is still valid: ${signUrl}`);
    }
  } else {
    req.flash('success', `Copy this link: ${signUrl}`);
  }

  req.session.save(() => res.redirect(`/hr/employees/${employee.id}`));
});

// POST /hr/roster/sop-bulk-send — send SOP sign links to every active employee
// who hasn't acknowledged the current SOP version. Skips anyone without an
// email on file and reports them in the flash.
router.post('/roster/sop-bulk-send', requirePermission('hr_employees'), async (req, res) => {
  const db = getDb();
  const version = currentSopVersion();

  // Find all active employees with a linked crew_member who don't have a
  // current-version acknowledgement.
  const targets = db.prepare(`
    SELECT e.id as employee_id, e.full_name, e.email, e.linked_crew_member_id
    FROM employees e
    WHERE e.deleted_at IS NULL
      AND e.employment_status = 'active'
      AND e.linked_crew_member_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sop_acknowledgements a
        WHERE a.crew_member_id = e.linked_crew_member_id AND a.sop_version = ?
      )
  `).all(version);

  let sent = 0;
  const skippedNoEmail = [];
  const failed = [];

  for (const t of targets) {
    if (!t.email) { skippedNoEmail.push(t.full_name); continue; }
    try {
      const session = getOrCreateIndividualSession(db, t.linked_crew_member_id, req.session.user.id);
      const signUrl = buildSignUrl(req, session.token);
      await sendEmail(t.email, 'Action required: SOP sign-off', sopSignLinkEmail(t.full_name, signUrl));
      db.prepare("UPDATE sop_signing_sessions SET sent_to_email = ?, sent_at = datetime('now') WHERE id = ?").run(t.email, session.id);
      sent += 1;
    } catch (e) {
      console.error(`SOP bulk email failed for ${t.full_name}:`, e.message);
      failed.push(t.full_name);
    }
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'sop_acknowledgement_request',
    details: `Bulk SOP sign link sent: ${sent} sent, ${skippedNoEmail.length} skipped (no email), ${failed.length} failed`, ip: req.ip });

  const parts = [`Sent ${sent} SOP sign link${sent === 1 ? '' : 's'}.`];
  if (skippedNoEmail.length) parts.push(`Skipped (no email): ${skippedNoEmail.join(', ')}.`);
  if (failed.length) parts.push(`Failed: ${failed.join(', ')}.`);
  req.flash(sent > 0 ? 'success' : 'error', parts.join(' '));
  res.redirect('/hr/roster');
});

// ============================================
// IN-PERSON INDUCTION + ONLINE TRAINING PERMISSION
// ============================================
// POST /hr/employees/:id/mark-inducted — toggle the "induction completed" flag.
// Body: completed=on (set) or unset (clear). Records who marked it and when.
router.post('/employees/:id/mark-inducted', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, full_name, inducted_at FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/roster')); }

  const setting = req.body.completed === 'on' || req.body.completed === '1' || req.body.completed === 'true';
  if (setting) {
    db.prepare(`
      UPDATE employees SET inducted_at = datetime('now'), inducted_method = 'in_person', inducted_marked_by_id = ? WHERE id = ?
    `).run(req.session.user.id, employee.id);
  } else {
    db.prepare("UPDATE employees SET inducted_at = NULL, inducted_method = '', inducted_marked_by_id = NULL WHERE id = ?").run(employee.id);
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'employee_induction',
    entityId: employee.id, entityLabel: employee.full_name,
    details: setting ? 'Marked in-person induction complete' : 'Cleared induction status',
    ip: req.ip });

  req.flash('success', setting ? `${employee.full_name} marked as inducted.` : `Induction status cleared for ${employee.full_name}.`);
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}`));
});

// POST /hr/employees/:id/toggle-online-training — grant/revoke online-training access
router.post('/employees/:id/toggle-online-training', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, full_name, online_training_allowed FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return req.session.save(() => res.redirect('/hr/roster')); }

  const newValue = employee.online_training_allowed ? 0 : 1;
  db.prepare('UPDATE employees SET online_training_allowed = ? WHERE id = ?').run(newValue, employee.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'employee_training_permission',
    entityId: employee.id, entityLabel: employee.full_name,
    details: newValue ? 'Granted online training access' : 'Revoked online training access',
    ip: req.ip });

  req.flash('success', newValue ? `${employee.full_name} can now take training on their portal.` : `${employee.full_name}'s online training access revoked.`);
  req.session.save(() => res.redirect(`/hr/employees/${employee.id}`));
});

// =============================================
// Management Contacts — Operations / Accounts / HR phone + email
// surfaced on /w/contacts in the worker app. Editor lives under the HR
// Dashboard's toolbar so admins know exactly where to change them.
// Storage is system_config.management_contacts as JSON; defaults are
// returned by services/management-contacts.js when the row is empty.
// =============================================
router.get('/management-contacts', requirePermission('hr_dashboard'), (req, res) => {
  const { getContacts, DEFAULT_CONTACTS } = require('../services/management-contacts');
  res.render('hr/management-contacts', {
    title: 'Management Contacts', currentPage: 'hr',
    contacts: getContacts(),
    defaults: DEFAULT_CONTACTS,
  });
});

router.post('/management-contacts', requirePermission('hr_dashboard'), (req, res) => {
  const { setContacts } = require('../services/management-contacts');
  // Form posts parallel arrays — key[i] / label[i] / email[i] / phone[i].
  // Zip them into a contacts list and drop any row whose label was
  // cleared (admin's way to delete a row).
  const keys   = [].concat(req.body['key']   || []);
  const labels = [].concat(req.body['label'] || []);
  const emails = [].concat(req.body['email'] || []);
  const phones = [].concat(req.body['phone'] || []);
  const n = Math.max(keys.length, labels.length, emails.length, phones.length);
  const incoming = [];
  for (let i = 0; i < n; i++) {
    incoming.push({
      key:   (keys[i]   || '').toString(),
      label: (labels[i] || '').toString(),
      email: (emails[i] || '').toString(),
      phone: (phones[i] || '').toString(),
    });
  }
  try {
    setContacts(incoming, req.session.user ? req.session.user.id : null);
    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'management_contacts',
        entityId: 0, entityLabel: 'Management Contacts',
        details: incoming.filter(c => c.label).length + ' contact(s)',
        ip: req.ip,
      });
    } catch (e) {}
    req.flash('success', 'Management contacts saved — workers see them on /w/contacts.');
  } catch (e) {
    console.error('[hr management-contacts save]', e);
    req.flash('error', 'Could not save: ' + e.message);
  }
  return req.session.save(() => res.redirect('/hr/management-contacts'));
});

// ============================================================================
// Merge duplicate workers
//   GET  /hr/merge?a=<empId>&b=<empId>  — side-by-side preview + field chooser
//   POST /hr/merge                       — execute the merge in one transaction
//
// A "worker" = employees row + linked crew_members row. The survivor defaults
// to the profile with competencies + documents; staff resolve any conflicting
// scalar field, and ALL child records move to the survivor (lib/mergeWorkers).
// ============================================================================
router.get('/merge', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const a = parseInt(req.query.a, 10);
  const b = parseInt(req.query.b, 10);
  if (!a || !b) { req.flash('error', 'Pick two profiles to merge (select two rows on the roster).'); return req.session.save(() => res.redirect('/hr/roster')); }
  const { buildPreview } = require('../lib/mergeWorkers');
  const preview = buildPreview(db, a, b, req.query.winner);
  if (preview.error) { req.flash('error', preview.error); return req.session.save(() => res.redirect('/hr/roster')); }
  res.render('hr/merge', {
    title: 'Merge duplicate workers',
    currentPage: 'hr-roster',
    preview,
    user: req.session.user,
  });
});

router.post('/merge', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const winnerEmpId = parseInt(req.body.winner_emp_id, 10);
  const loserEmpId = parseInt(req.body.loser_emp_id, 10);
  if (!winnerEmpId || !loserEmpId) { req.flash('error', 'Missing merge targets.'); return req.session.save(() => res.redirect('/hr/roster')); }

  // Field choices arrive as choice[emp][<col>] / choice[crew][<col>] = 'loser'.
  const raw = req.body.choice || {};
  const fieldChoices = { emp: raw.emp || {}, crew: raw.crew || {} };

  try {
    const { executeMerge } = require('../lib/mergeWorkers');
    const result = executeMerge(db, { winnerEmpId, loserEmpId, fieldChoices, userId: req.session.user.id });
    const movedTotal = Object.values(result.moved).reduce((s, n) => s + n, 0);
    try {
      logActivity({
        user: req.session.user, action: 'update', entityType: 'employee',
        entityId: result.winnerEmpId, entityLabel: result.winnerName,
        details: `Merged duplicate "${result.loserName}" (#${result.loserEmpId}) into "${result.winnerName}" (#${result.winnerEmpId}). Moved ${movedTotal} child record(s) across ${Object.keys(result.moved).length} table(s).`,
        ip: req.ip,
      });
    } catch (e) { /* audit shouldn't block the merge */ }
    req.flash('success', `Merged ${result.loserName} into ${result.winnerName}. ${movedTotal} record(s) moved; the duplicate is archived.`);
    return req.session.save(() => res.redirect(`/hr/employees/${result.winnerEmpId}`));
  } catch (e) {
    console.error('[hr/merge]', e);
    req.flash('error', `Merge failed: ${e.message}`);
    return req.session.save(() => res.redirect(`/hr/merge?a=${winnerEmpId}&b=${loserEmpId}`));
  }
});

module.exports = router;
