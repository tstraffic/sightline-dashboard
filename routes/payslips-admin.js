// Admin payroll / payslips routes. Upload a signed payslip PDF per employee
// per pay period, along with gross / tax / super / net / YTD figures. Workers
// pick them up at /w/hr/payslips.

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { requirePermission } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

const PAYSLIP_DIR = path.join(__dirname, '..', 'data', 'uploads', 'payroll');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const empId = req.body.employee_id || req.body.single_employee_id || 'batch';
    const dir = path.join(PAYSLIP_DIR, `emp_${empId}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '.pdf') || '.pdf').toLowerCase();
    cb(null, `payslip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^application\/pdf$/i.test(file.mimetype)) return cb(new Error('PDF only (max 5MB)'));
    cb(null, true);
  }
});

// ====================================================
// GET /payroll/payslips — list all uploaded payslips
// ====================================================
router.get('/payslips', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const { emp, from, to } = req.query;
  const where = ['1=1']; const params = [];
  if (emp) { where.push('p.employee_id = ?'); params.push(emp); }
  if (from) { where.push('p.pay_date >= ?'); params.push(from); }
  if (to) { where.push('p.pay_date <= ?'); params.push(to); }

  const payslips = db.prepare(`
    SELECT p.*, e.full_name, e.employee_code,
      u.full_name as uploader_name
    FROM payslips p
    JOIN employees e ON e.id = p.employee_id
    LEFT JOIN users u ON u.id = p.uploaded_by_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.pay_date DESC, e.full_name ASC
    LIMIT 500
  `).all(...params);

  const stats = {
    total: db.prepare('SELECT COUNT(*) as c FROM payslips').get().c,
    last30: db.prepare("SELECT COUNT(*) as c FROM payslips WHERE pay_date >= date('now', '-30 days')").get().c,
    totalPaid: db.prepare("SELECT COALESCE(SUM(net_pay), 0) as s FROM payslips WHERE pay_date >= date('now', '-90 days')").get().s,
    viewed: db.prepare('SELECT COUNT(*) as c FROM payslips WHERE viewed_at IS NOT NULL').get().c,
  };

  const employees = db.prepare("SELECT id, employee_code, full_name FROM employees WHERE active = 1 ORDER BY full_name ASC").all();

  res.render('payslips-admin/index', {
    title: 'Payslips', currentPage: 'payslips',
    payslips, stats, employees, filters: { emp, from, to },
  });
});

// ====================================================
// GET /payroll/payslips/new — upload form
// ====================================================
router.get('/payslips/new', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const employees = db.prepare("SELECT id, employee_code, full_name FROM employees WHERE active = 1 ORDER BY full_name ASC").all();
  res.render('payslips-admin/new', {
    title: 'Upload payslip', currentPage: 'payslips',
    employees,
  });
});

// ====================================================
// POST /payroll/payslips — create new payslip
// ====================================================
router.post('/payslips', requirePermission('hr_employees'), (req, res) => {
  upload.single('pdf')(req, res, function (err) {
    if (err) { req.flash('error', err.message); return req.session.save(() => res.redirect('/payroll/payslips/new')); }

    const db = getDb();
    const b = req.body;
    const empId = parseInt(b.employee_id, 10);
    const emp = empId ? db.prepare('SELECT id, full_name, employee_code FROM employees WHERE id = ?').get(empId) : null;
    if (!emp) { req.flash('error', 'Pick a valid employee'); return req.session.save(() => res.redirect('/payroll/payslips/new')); }

    const required = ['period_start', 'period_end', 'pay_date'];
    for (const k of required) {
      if (!b[k] || !/^\d{4}-\d{2}-\d{2}$/.test(b[k])) { req.flash('error', `Missing or invalid ${k.replace(/_/g, ' ')}`); return req.session.save(() => res.redirect('/payroll/payslips/new')); }
    }
    if (b.period_end < b.period_start) { req.flash('error', 'Period end must be on or after period start'); return req.session.save(() => res.redirect('/payroll/payslips/new')); }

    const num = (s) => { const n = parseFloat(s); return isFinite(n) ? n : 0; };
    const gross = num(b.gross_pay);
    const tax = num(b.tax_withheld);
    const sup = num(b.super_amount);
    const net = num(b.net_pay) || Math.max(0, gross - tax);

    try {
      const result = db.prepare(`
        INSERT INTO payslips (employee_id, period_start, period_end, pay_date,
          gross_pay, tax_withheld, super_amount, net_pay,
          ytd_gross, ytd_tax, ytd_super, ytd_net, notes,
          pdf_filename, pdf_original_name, pdf_size, uploaded_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        emp.id, b.period_start, b.period_end, b.pay_date,
        gross, tax, sup, net,
        num(b.ytd_gross), num(b.ytd_tax), num(b.ytd_super), num(b.ytd_net),
        (b.notes || '').trim(),
        req.file ? req.file.filename : null,
        req.file ? req.file.originalname : null,
        req.file ? req.file.size : 0,
        req.session.user.id,
      );
      logActivity({
        user: req.session.user, action: 'upload', entityType: 'payslip',
        entityId: result.lastInsertRowid, entityLabel: `${emp.employee_code} ${b.pay_date}`,
        details: `Uploaded payslip for ${emp.full_name} (${b.period_start} → ${b.period_end}, net $${net.toFixed(2)})`,
        ip: req.ip,
      });
      req.flash('success', `Payslip uploaded for ${emp.full_name}.`);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) {
        req.flash('error', `A payslip for ${emp.full_name} on that period already exists — delete it first if you need to replace.`);
      } else {
        req.flash('error', 'Upload failed: ' + e.message);
      }
      return req.session.save(() => res.redirect('/payroll/payslips/new'));
    }

    req.session.save(() => res.redirect('/payroll/payslips'));
  });
});

// ====================================================
// GET /payroll/payslips/:id/download — admin stream a payslip PDF
// ====================================================
router.get('/payslips/:id/download', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT p.*, e.full_name, e.employee_code FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?').get(req.params.id);
  if (!p || !p.pdf_filename) return res.status(404).send('Not found');

  const filePath = path.join(PAYSLIP_DIR, `emp_${p.employee_id}`, p.pdf_filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File missing on disk');

  logActivity({
    user: req.session.user, action: 'download', entityType: 'payslip',
    entityId: p.id, entityLabel: `${p.employee_code} ${p.pay_date}`,
    details: `Admin downloaded payslip for ${p.full_name}`,
    ip: req.ip,
  });

  const downloadName = `Payslip_${p.employee_code}_${p.pay_date}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ====================================================
// POST /payroll/payslips/:id/delete — remove payslip + file
// ====================================================
router.post('/payslips/:id/delete', requirePermission('hr_employees'), (req, res) => {
  const db = getDb();
  const p = db.prepare('SELECT p.*, e.full_name, e.employee_code FROM payslips p JOIN employees e ON e.id = p.employee_id WHERE p.id = ?').get(req.params.id);
  if (!p) { req.flash('error', 'Not found'); return req.session.save(() => res.redirect('/payroll/payslips')); }
  if (p.pdf_filename) {
    const filePath = path.join(PAYSLIP_DIR, `emp_${p.employee_id}`, p.pdf_filename);
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (e) {}
  }
  db.prepare('DELETE FROM payslips WHERE id = ?').run(p.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'payslip',
    entityId: p.id, entityLabel: `${p.employee_code} ${p.pay_date}`,
    details: `Deleted payslip for ${p.full_name}`,
    ip: req.ip,
  });
  req.flash('success', `Payslip removed.`);
  req.session.save(() => res.redirect('/payroll/payslips'));
});

module.exports = router;
