const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { requirePermission, canViewSensitiveHR } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { workerInviteEmail, sopSignLinkEmail, pinResetEmail } = require('../services/emailTemplates');
const crypto = require('crypto');
const { currentVersion: currentSopVersion } = require('../lib/sop');
const { REQUIRED_MODULES } = require('../lib/induction');

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

// --- Readiness computation ---
function computeReadiness(employee, competencies, documents) {
  if (employee.employment_status === 'offboarded') return { status: 'offboarded', color: 'gray' };
  if (employee.employment_status === 'on_leave') return { status: 'on_leave', color: 'blue' };
  if (employee.employment_status === 'onboarding') return { status: 'onboarding', color: 'purple' };
  if (employee.employment_status === 'suspended') return { status: 'blocked', color: 'red' };
  if (employee.blocked_from_allocation) return { status: 'blocked', color: 'red' };

  const expiredMandatory = (competencies || []).filter(c => c.mandatory_for_role && (c.status === 'expired' || c.status === 'missing'));
  const missingMandatoryDocs = (documents || []).filter(d => d.mandatory && d.verification_status !== 'verified');

  if (expiredMandatory.length > 0 || missingMandatoryDocs.length > 0) return { status: 'non_compliant', color: 'red' };

  const expiringSoon = (competencies || []).filter(c => c.status === 'expiring_soon');
  if (expiringSoon.length > 0) return { status: 'ready_with_warnings', color: 'amber' };

  return { status: 'ready', color: 'green' };
}

// Auto-compute competency status based on expiry
function refreshCompetencyStatuses(db, employeeId) {
  db.prepare(`UPDATE employee_competencies SET status = 'expired' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date < DATE('now') AND status != 'suspended'`).run(employeeId);
  db.prepare(`UPDATE employee_competencies SET status = 'expiring_soon' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date >= DATE('now') AND expiry_date <= DATE('now', '+30 days') AND status NOT IN ('expired','suspended','missing')`).run(employeeId);
  db.prepare(`UPDATE employee_competencies SET status = 'valid' WHERE employee_id = ? AND expiry_date IS NOT NULL AND expiry_date > DATE('now', '+30 days') AND status NOT IN ('suspended','missing')`).run(employeeId);
}

// ============================================
// HR DASHBOARD
// ============================================
router.get('/', requirePermission('hr_dashboard'), (req, res) => {
  const db = getDb();
  const { company, division, region, employment_type, manager_id } = req.query;

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

  // Missing mandatory documents
  const missingDocs = db.prepare(`
    SELECT e.id, e.full_name, e.employee_code, e.company,
      COUNT(CASE WHEN ed.verification_status != 'verified' THEN 1 END) as unverified_count
    FROM employees e
    LEFT JOIN employee_documents ed ON ed.employee_id = e.id AND ed.mandatory = 1
    WHERE e.active = 1
    GROUP BY e.id
    HAVING unverified_count > 0
    ORDER BY unverified_count DESC LIMIT 10
  `).all();

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
    employmentTypes,
    headcountByDivision,
    filters: { company, division, region, employment_type, manager_id },
    filterOptions: { companies, divisions, regions, managers },
    user: req.session.user
  });
});

// ============================================
// ROSTER (new employees list — replaces /employees view)
// ============================================
router.get('/roster', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { employment_type, status, level, search, sort, order, payment_type, view, induction } = req.query;
  const showDeleted = view === 'deleted';

  let where = showDeleted ? 'e.deleted_at IS NOT NULL' : 'e.deleted_at IS NULL';
  const params = [];
  if (payment_type) { where += ' AND e.payment_type = ?'; params.push(payment_type); }
  if (employment_type) { where += ' AND e.employment_type = ?'; params.push(employment_type); }
  if (status) { where += ' AND e.employment_status = ?'; params.push(status); }
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

  // Stats (all exclude deleted except totalDeleted)
  const totalActive = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'active' AND deleted_at IS NULL").get().c;
  const totalDeactivated = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('inactive', 'deactivated') AND deleted_at IS NULL").get().c;
  const totalOnLeave = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status = 'on_leave' AND deleted_at IS NULL").get().c;
  const totalTerminated = db.prepare("SELECT COUNT(*) as c FROM employees WHERE employment_status IN ('terminated', 'offboarded') AND deleted_at IS NULL").get().c;
  const totalCash = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'cash' AND active = 1 AND deleted_at IS NULL").get().c;
  const totalTfn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'tfn' AND active = 1 AND deleted_at IS NULL").get().c;
  const totalAbn = db.prepare("SELECT COUNT(*) as c FROM employees WHERE payment_type = 'abn' AND active = 1 AND deleted_at IS NULL").get().c;
  const totalActiveAll = db.prepare("SELECT COUNT(*) as c FROM employees WHERE deleted_at IS NULL").get().c;
  const totalDeleted = db.prepare("SELECT COUNT(*) as c FROM employees WHERE deleted_at IS NOT NULL").get().c;

  res.render('hr/roster', {
    title: 'Roster',
    currentPage: 'hr-roster',
    employees,
    stats: { totalActive, totalDeactivated, totalOnLeave, totalTerminated, totalCash, totalTfn, totalAbn, totalActiveAll, totalDeleted, inductedCount, notInductedCount },
    filters: { employment_type, status, level, search, sort, order, payment_type, view, induction },
    showDeleted,
    sopVersion,
    sopUnsignedCount,
    user: req.session.user
  });
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
    return res.redirect('/hr/roster');
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
  if (!ids) { req.flash('error', 'No employees selected.'); return res.redirect('/hr/roster'); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return res.redirect('/hr/roster'); }

  const placeholders = ids.map(() => '?').join(',');
  try {
    // Deactivate linked login users BEFORE soft-deleting the employees
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${placeholders}) AND linked_user_id IS NOT NULL`).all(...ids);
    const userIds = linkedUsers.map(r => r.linked_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET active = 0 WHERE id IN (${userPlaceholders})`).run(...userIds);
    }
    // Soft-delete employees — preserve all related records for restore
    db.prepare(`UPDATE employees SET deleted_at = CURRENT_TIMESTAMP, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    req.flash('success', `${ids.length} employee(s) moved to Deleted.`);
  } catch (err) {
    console.error('Roster bulk soft-delete error:', err);
    req.flash('error', 'Error deleting employees: ' + err.message);
  }
  res.redirect('/hr/roster');
});

// ============================================
// ROSTER BULK RESTORE (from Deleted tab)
// ============================================
router.post('/roster/restore', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return res.redirect('/hr/roster?view=deleted'); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return res.redirect('/hr/roster?view=deleted'); }

  const placeholders = ids.map(() => '?').join(',');
  try {
    // Reactivate linked login users
    const linkedUsers = db.prepare(`SELECT linked_user_id FROM employees WHERE id IN (${placeholders}) AND linked_user_id IS NOT NULL`).all(...ids);
    const userIds = linkedUsers.map(r => r.linked_user_id).filter(Boolean);
    if (userIds.length > 0) {
      const userPlaceholders = userIds.map(() => '?').join(',');
      db.prepare(`UPDATE users SET active = 1 WHERE id IN (${userPlaceholders})`).run(...userIds);
    }
    // Restore employees — clear deleted_at, reactivate, set status back to active
    db.prepare(`UPDATE employees SET deleted_at = NULL, active = 1, employment_status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(...ids);
    req.flash('success', `${ids.length} employee(s) restored.`);
  } catch (err) {
    console.error('Roster bulk restore error:', err);
    req.flash('error', 'Error restoring employees: ' + err.message);
  }
  res.redirect('/hr/roster?view=deleted');
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

// ============================================
// CREATE EMPLOYEE
// ============================================
router.post('/employees', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const b = req.body;

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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  res.redirect(`/hr/employees/${result.lastInsertRowid}`);
});

// ============================================
// BULK DELETE EMPLOYEES
// ============================================
router.post('/employees/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No employees selected.'); return res.redirect('/hr/employees'); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid employees selected.'); return res.redirect('/hr/employees'); }

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
  res.redirect('/hr/employees');
});

// ============================================
// EMPLOYEE DETAIL
// ============================================
router.get('/employees/:id', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/employees'); }

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

  // Toolbox meetings: every published toolbox + this worker's attendance
  // status (attended / caught_up / absent + reason / not recorded).
  // Joined by linked_crew_member_id so we get a row per meeting even if
  // the worker didn't respond — the user wants the full list visible.
  let toolboxMeetings = [];
  try {
    toolboxMeetings = db.prepare(`
      SELECT
        t.id, t.title, t.held_at, t.presenter, t.key_points, t.published_at,
        a.status AS my_status, a.absence_reason, a.recorded_at AS my_recorded_at
      FROM toolbox_talks t
      LEFT JOIN toolbox_attendance a
        ON a.toolbox_id = t.id AND a.crew_member_id = ?
      WHERE t.status = 'published'
      ORDER BY COALESCE(t.held_at, t.published_at) DESC, t.id DESC
    `).all(employee.linked_crew_member_id || -1);
  } catch (e) { /* table may not exist on stale DB */ }

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
    induction,
    sopStatus,
    sopHistory,
    trainingPasses,
    toolboxMeetings,
    inductionMarkedBy: inductionMarkedBy ? inductionMarkedBy.full_name : null,
    settingsOptions,
    canViewSensitive: canViewSensitiveHR(req.session.user),
    showRates: canViewRates(req.session.user),
    user: req.session.user
  });
});

// ============================================
// EDIT EMPLOYEE FORM
// ============================================
router.get('/employees/:id/edit', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/employees'); }

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
  // Deduplicate: form has some fields appearing twice (noscript fallback + wizard panels).
  // Express parses duplicates as arrays — take the last value (most recent panel's input).
  const b = {};
  for (const [key, val] of Object.entries(req.body)) {
    b[key] = Array.isArray(val) ? val[val.length - 1] : val;
  }
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
  res.redirect(`/hr/employees/${req.params.id}`);
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

// POST /employees/:id/enable-portal — Auto-create crew member + link + activate
router.post('/employees/:id/enable-portal', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}`);
  // Ensure the crew member is active for portal login
  const db = getDb();
  db.prepare('UPDATE crew_members SET active = 1 WHERE id = ?').run(data.crewMember.id);
  req.flash('success', `Portal access enabled for ${data.employee.full_name}. You can now set a PIN or send an invite.`);
  res.redirect(`/hr/employees/${req.params.id}#workforce`);
});

// POST /employees/:id/set-pin — Set or reset worker portal PIN
router.post('/employees/:id/set-pin', requirePermission('hr_employees'), (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  const { pin } = req.body;
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect(`/hr/employees/${employee.id}#workforce`);
  }

  const pinHash = bcrypt.hashSync(pin, 12);
  getDb().prepare('UPDATE crew_members SET pin_hash = ?, pin_plain = ?, pin_set_at = CURRENT_TIMESTAMP, pin_set_by_id = ? WHERE id = ?')
    .run(pinHash, pin, req.session.user.id, crewMember.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: crewMember.id, entityLabel: crewMember.full_name, details: 'Set worker portal PIN (from HR)', ip: req.ip });
  req.flash('success', 'Portal PIN set for ' + crewMember.full_name);
  res.redirect(`/hr/employees/${employee.id}#workforce`);
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
  res.redirect(`/hr/employees/${employee.id}#workforce`);
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
  res.redirect(`/hr/employees/${employee.id}#workforce`);
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
    return res.redirect('/hr/roster');
  }
  const pt = (req.body.payment_type || '').toLowerCase();
  const allowed = ['', 'cash', 'tfn', 'abn'];
  if (!allowed.includes(pt)) {
    req.flash('error', 'Invalid payment type.');
    return res.redirect(req.headers.referer || '/hr/roster');
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
  return res.redirect(req.headers.referer || '/hr/roster');
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
    return res.redirect('/hr/roster');
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
  return res.redirect(req.headers.referer || '/hr/roster');
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
    return res.redirect(`/hr/employees/${employee.id}#workforce`);
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
  if (ref.includes('/hr/roster')) return res.redirect('/hr/roster');
  if (ref.includes('/hr') && !ref.includes('/employees/')) return res.redirect(ref);
  res.redirect(`/hr/employees/${employee.id}#workforce`);
});

// POST /employees/:id/send-invite — Send email invitation for worker portal
router.post('/employees/:id/send-invite', requirePermission('hr_employees'), async (req, res) => {
  const data = loadEmployeeWithCrew(req, res, { autoCreate: true });
  if (!data) return res.redirect(`/hr/employees/${req.params.id}#workforce`);
  const { employee, crewMember } = data;

  // Only send invite emails for active employees
  if (employee.employment_status !== 'active') {
    req.flash('error', 'Employee must be set to Active before sending an invite email.');
    return res.redirect(`/hr/employees/${employee.id}#workforce`);
  }

  if (!crewMember.email) {
    req.flash('error', 'Crew member needs an email address to receive an invite.');
    return res.redirect(`/hr/employees/${employee.id}#workforce`);
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
      ? 'Reset your T&S Worker Portal PIN'
      : 'Set up your T&S Worker Portal PIN';
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
  res.redirect(`/hr/employees/${employee.id}#workforce`);
});

// ============================================
// DOCUMENT UPLOAD
// ============================================
router.post('/employees/:id/documents/upload', requirePermission('hr_documents'), upload.single('file'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id FROM employees WHERE id = ?').get(req.params.id);
  if (!employee || !req.file) { req.flash('error', 'Upload failed.'); return res.redirect('back'); }

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
  res.redirect(`/hr/employees/${employee.id}#documents`);
});

// ============================================
// DOCUMENT VERIFY / REJECT
// ============================================
router.post('/documents/:id/verify', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return res.redirect('back'); }

  const action = req.body.action; // 'verify' or 'reject'
  const newStatus = action === 'reject' ? 'rejected' : 'verified';

  db.prepare('UPDATE employee_documents SET verification_status = ?, verified_by_id = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(newStatus, req.session.user.id, doc.id);

  req.flash('success', `Document ${newStatus}.`);
  res.redirect(`/hr/employees/${doc.employee_id}#documents`);
});

// ============================================
// DOCUMENT DOWNLOAD
// ============================================
router.get('/documents/:id/download', requirePermission('hr_documents'), (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM employee_documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'Document not found.'); return res.redirect('back'); }

  if (!fs.existsSync(doc.file_path)) {
    req.flash('error', 'File not found on disk.');
    return res.redirect('back');
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
  if (!doc) { req.flash('error', 'Document not found.'); return res.redirect('back'); }

  // Delete file from disk
  try { if (fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path); } catch (e) { /* ignore */ }

  db.prepare('DELETE FROM employee_documents WHERE id = ?').run(doc.id);
  req.flash('success', 'Document deleted.');
  res.redirect(`/hr/employees/${doc.employee_id}#documents`);
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
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('back'); }

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
  res.redirect(`/hr/employees/${employee.id}#competencies`);
});

// ============================================
// UPDATE COMPETENCY
// ============================================
router.post('/competencies/:id', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const b = req.body;
  const comp = db.prepare('SELECT * FROM employee_competencies WHERE id = ?').get(req.params.id);
  if (!comp) { req.flash('error', 'Competency not found.'); return res.redirect('back'); }

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
  res.redirect(`/hr/employees/${comp.employee_id}#competencies`);
});

// ============================================
// DELETE COMPETENCY
// ============================================
router.post('/competencies/:id/delete', requirePermission('hr_competencies'), (req, res) => {
  const db = getDb();
  const comp = db.prepare('SELECT * FROM employee_competencies WHERE id = ?').get(req.params.id);
  if (!comp) { req.flash('error', 'Competency not found.'); return res.redirect('back'); }

  db.prepare('DELETE FROM employee_competencies WHERE id = ?').run(comp.id);
  req.flash('success', 'Competency removed.');
  res.redirect(`/hr/employees/${comp.employee_id}#competencies`);
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
// DEACTIVATE / REACTIVATE EMPLOYEE
// ============================================
router.post('/employees/:id/toggle-active', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, employment_status, active FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/employees'); }

  const action = req.body.action; // 'deactivate' or 'reactivate'
  if (action === 'deactivate') {
    db.prepare('UPDATE employees SET employment_status = ?, active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('inactive', employee.id);
    req.flash('success', 'Employee deactivated.');
  } else if (action === 'reactivate') {
    db.prepare('UPDATE employees SET employment_status = ?, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('active', employee.id);
    req.flash('success', 'Employee reactivated.');
  }
  res.redirect(`/hr/employees/${employee.id}`);
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
  res.redirect(`/hr/employees/${req.params.id}`);
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
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/roster'); }
  if (!employee.linked_crew_member_id) {
    req.flash('error', 'This employee has no linked crew record yet — can\'t generate a sign link.');
    return res.redirect(`/hr/employees/${employee.id}`);
  }

  const session = getOrCreateIndividualSession(db, employee.linked_crew_member_id, req.session.user.id);
  const signUrl = buildSignUrl(req, session.token);
  const action = (req.body.action || 'copy').toLowerCase();

  if (action === 'email') {
    const recipient = (req.body.email || employee.email || '').trim();
    if (!recipient) {
      req.flash('error', 'No email on file for this person — use Copy Link instead, or set their email first.');
      return res.redirect(`/hr/employees/${employee.id}`);
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

  res.redirect(`/hr/employees/${employee.id}`);
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
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/roster'); }

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
  res.redirect(`/hr/employees/${employee.id}`);
});

// POST /hr/employees/:id/toggle-online-training — grant/revoke online-training access
router.post('/employees/:id/toggle-online-training', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employee = db.prepare('SELECT id, full_name, online_training_allowed FROM employees WHERE id = ?').get(req.params.id);
  if (!employee) { req.flash('error', 'Employee not found.'); return res.redirect('/hr/roster'); }

  const newValue = employee.online_training_allowed ? 0 : 1;
  db.prepare('UPDATE employees SET online_training_allowed = ? WHERE id = ?').run(newValue, employee.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'employee_training_permission',
    entityId: employee.id, entityLabel: employee.full_name,
    details: newValue ? 'Granted online training access' : 'Revoked online training access',
    ip: req.ip });

  req.flash('success', newValue ? `${employee.full_name} can now take training on their portal.` : `${employee.full_name}'s online training access revoked.`);
  res.redirect(`/hr/employees/${employee.id}`);
});

module.exports = router;
