const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

// TIMESHEETS LIST
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];

  if (req.query.job_id) { where.push('t.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.crew_member_id) { where.push('t.crew_member_id = ?'); params.push(req.query.crew_member_id); }
  if (req.query.work_date) { where.push('t.work_date = ?'); params.push(req.query.work_date); }
  if (req.query.approved === '0') { where.push('t.approved = 0'); }
  if (req.query.approved === '1') { where.push('t.approved = 1'); }
  if (req.query.week_of) {
    // Filter to 7-day range starting from the Monday of the given date
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

  // Sorting
  const allowedSorts = { 'work_date': 't.work_date', 'crew_name': 'c.full_name', 'total_hours': 't.total_hours', 'approved': 't.approved' };
  const sort = allowedSorts[req.query.sort] ? req.query.sort : 'work_date';
  const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
  const orderByCol = allowedSorts[sort] || 't.work_date';

  const timesheets = db.prepare(`
    SELECT t.*, c.full_name as crew_name, c.role as crew_role, j.job_number, j.client, u.full_name as submitted_by_name, a.full_name as approved_by_name
    FROM timesheets t
    JOIN crew_members c ON t.crew_member_id = c.id
    JOIN jobs j ON t.job_id = j.id
    JOIN users u ON t.submitted_by_id = u.id
    LEFT JOIN users a ON t.approved_by_id = a.id
    ${whereClause}
    ORDER BY ${orderByCol} ${order}
    LIMIT 200
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const crew = db.prepare("SELECT id, full_name FROM crew_members WHERE active = 1 ORDER BY full_name").all();

  // Summary stats
  const totalHours = timesheets.reduce((sum, t) => sum + (t.total_hours || 0), 0);
  const pendingApproval = timesheets.filter(t => !t.approved).length;
  const approvedCount = timesheets.filter(t => t.approved).length;
  const uniqueCrew = new Set(timesheets.map(t => t.crew_member_id)).size;

  res.render('timesheets/index', {
    title: 'Timesheets',
    currentPage: 'timesheets',
    timesheets,
    jobs,
    crew,
    filters: req.query,
    stats: { totalHours: totalHours.toFixed(1), pendingApproval, approvedCount, uniqueCrew },
    sort,
    order: order.toLowerCase(),
  });
});

// NEW TIMESHEET FORM (daily log - batch entry for multiple crew)
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const crew = db.prepare("SELECT id, full_name, role FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  res.render('timesheets/form', {
    title: 'Log Timesheet',
    currentPage: 'timesheets',
    timesheet: null,
    jobs,
    crew,
    preselectedJobId: req.query.job_id || ''
  });
});

// CREATE (supports single or batch entries)
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, work_date, shift_type, entries } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  // entries is an array of { crew_member_id, start_time, end_time, break_minutes, role_on_site, notes }
  const insert = db.prepare(`
    INSERT INTO timesheets (job_id, crew_member_id, work_date, start_time, end_time, break_minutes, total_hours, ordinary_hours, overtime_hours, shift_type, role_on_site, notes, submitted_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const entryArray = Array.isArray(entries) ? entries : [entries];

  const insertMany = db.transaction((items) => {
    for (const entry of items) {
      if (!entry || !entry.crew_member_id || !entry.start_time || !entry.end_time) continue;
      // Calculate hours
      const [sh, sm] = entry.start_time.split(':').map(Number);
      const [eh, em] = entry.end_time.split(':').map(Number);
      let totalMin = (eh * 60 + em) - (sh * 60 + sm);
      if (totalMin < 0) totalMin += 24 * 60; // overnight
      const breakMin = parseInt(entry.break_minutes) || 30;
      const totalHours = Math.max(0, (totalMin - breakMin) / 60);
      const ordinaryHours = Math.min(totalHours, 7.6);
      const overtimeHours = Math.max(0, Math.round((totalHours - 7.6) * 100) / 100);

      insert.run(job_id, entry.crew_member_id, work_date, entry.start_time, entry.end_time, breakMin, totalHours.toFixed(2), ordinaryHours.toFixed(2), overtimeHours.toFixed(2), shift_type || 'day', entry.role_on_site || '', entry.notes || '', req.session.user.id);
      count++;
    }
  });

  insertMany(entryArray);

  logActivity({ user: req.session.user, action: 'create', entityType: 'timesheet', entityLabel: `${count} entries for ${work_date}`, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', ip: req.ip });

  req.flash('success', `${count} timesheet entries logged.`);
  req.session.save(() => res.redirect('/timesheets'));
});

// POST /bulk — Bulk actions on timesheets
router.post('/bulk', (req, res) => {
  const db = getDb();
  const ids = (req.body.ids || '').split(',').map(Number).filter(n => n > 0);
  const action = req.body.action;
  if (ids.length === 0) return res.redirect('/timesheets');

  if (action === 'approve') {
    const stmt = db.prepare('UPDATE timesheets SET approved = 1, approved_by_id = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?');
    ids.forEach(id => stmt.run(req.session.user.id, id));
    logActivity({ user: req.session.user, action: 'approve', entityType: 'timesheet', entityLabel: `Bulk approved ${ids.length} entries`, ip: req.ip });
    req.flash('success', ids.length + ' timesheet(s) approved.');
  } else if (action === 'delete') {
    const stmt = db.prepare('DELETE FROM timesheets WHERE id = ?');
    ids.forEach(id => stmt.run(id));
    logActivity({ user: req.session.user, action: 'delete', entityType: 'timesheet', entityLabel: `Bulk deleted ${ids.length} entries`, ip: req.ip });
    req.flash('success', ids.length + ' timesheet(s) deleted.');
  }
  req.session.save(() => res.redirect('/timesheets'));
});

// APPROVE (management/operations only)
router.post('/:id/approve', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  db.prepare('UPDATE timesheets SET approved = 1, approved_by_id = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.user.id, req.params.id);
  logActivity({ user: req.session.user, action: 'approve', entityType: 'timesheet', entityId: parseInt(req.params.id), ip: req.ip });
  req.flash('success', 'Timesheet approved.');
  req.session.save(() => res.redirect(req.get('Referer') || '/timesheets'));
});

// BULK APPROVE
router.post('/approve-bulk', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const ids = req.body.timesheet_ids;
  if (!ids) { req.flash('error', 'No timesheets selected.'); return req.session.save(() => res.redirect('/timesheets')); }
  const idArray = Array.isArray(ids) ? ids : [ids];
  const update = db.prepare('UPDATE timesheets SET approved = 1, approved_by_id = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?');
  idArray.forEach(id => update.run(req.session.user.id, id));
  logActivity({ user: req.session.user, action: 'approve', entityType: 'timesheet', entityLabel: `Bulk approved ${idArray.length} entries`, ip: req.ip });
  req.flash('success', `${idArray.length} timesheets approved.`);
  req.session.save(() => res.redirect('/timesheets'));
});

// DELETE
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM timesheets WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'timesheet', entityId: parseInt(req.params.id), ip: req.ip });
  req.flash('success', 'Timesheet entry deleted.');
  req.session.save(() => res.redirect('/timesheets'));
});

// CREW MANAGEMENT
router.get('/crew', (req, res) => {
  const db = getDb();
  const crewMembers = db.prepare('SELECT * FROM crew_members ORDER BY active DESC, full_name ASC').all();
  res.render('timesheets/crew', {
    title: 'Crew Members',
    currentPage: 'timesheets',
    crewMembers
  });
});

router.get('/crew/new', (req, res) => {
  res.render('timesheets/crew-form', {
    title: 'Add Crew Member',
    currentPage: 'timesheets',
    member: null
  });
});

router.post('/crew', (req, res) => {
  const db = getDb();
  const { full_name, employee_id, role, phone, email, licence_type, licence_expiry, induction_date, hourly_rate, tcp_level, white_card, white_card_expiry, first_aid, first_aid_expiry, tc_ticket, tc_ticket_expiry, ti_ticket, ti_ticket_expiry, induction_status, company, medical_expiry, employment_type } = req.body;
  const result = db.prepare(`
    INSERT INTO crew_members (full_name, employee_id, role, phone, email, licence_type, licence_expiry, induction_date, hourly_rate, tcp_level, white_card, white_card_expiry, first_aid, first_aid_expiry, tc_ticket, tc_ticket_expiry, ti_ticket, ti_ticket_expiry, induction_status, company, medical_expiry, employment_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(full_name, employee_id || null, role || 'traffic_controller', phone || '', email || '', licence_type || '', licence_expiry || null, induction_date || null, parseFloat(hourly_rate) || 0, tcp_level || '', white_card || '', white_card_expiry || null, first_aid || '', first_aid_expiry || null, tc_ticket || '', tc_ticket_expiry || null, ti_ticket || '', ti_ticket_expiry || null, induction_status || 'pending', company || '', medical_expiry || null, employment_type || 'employee');

  // Crew rows created here default active=1 — put them on the HR roster too,
  // or the two tables drift apart again (see migration 333).
  try { require('../lib/employeeSync').ensureRosterRecord(db, result.lastInsertRowid, 'Created from the timesheets Add Crew form.'); }
  catch (e) { console.error('[timesheets] roster record create failed:', e.message); }

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_member', entityLabel: full_name, ip: req.ip });
  req.flash('success', `Crew member ${full_name} added.`);
  req.session.save(() => res.redirect('/timesheets/crew'));
});

router.get('/crew/:id/edit', (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found.'); return req.session.save(() => res.redirect('/timesheets/crew')); }
  res.render('timesheets/crew-form', {
    title: `Edit ${member.full_name}`,
    currentPage: 'timesheets',
    member
  });
});

router.post('/crew/:id', (req, res) => {
  const db = getDb();
  const { full_name, employee_id, role, phone, email, licence_type, licence_expiry, induction_date, hourly_rate, active, tcp_level, white_card, white_card_expiry, first_aid, first_aid_expiry, tc_ticket, tc_ticket_expiry, ti_ticket, ti_ticket_expiry, induction_status, company, medical_expiry, employment_type } = req.body;
  db.prepare(`
    UPDATE crew_members SET full_name=?, employee_id=?, role=?, phone=?, email=?, licence_type=?, licence_expiry=?, induction_date=?, hourly_rate=?, active=?, tcp_level=?, white_card=?, white_card_expiry=?, first_aid=?, first_aid_expiry=?, tc_ticket=?, tc_ticket_expiry=?, ti_ticket=?, ti_ticket_expiry=?, induction_status=?, company=?, medical_expiry=?, employment_type=? WHERE id=?
  `).run(full_name, employee_id || null, role, phone || '', email || '', licence_type || '', licence_expiry || null, induction_date || null, parseFloat(hourly_rate) || 0, active ? 1 : 0, tcp_level || '', white_card || '', white_card_expiry || null, first_aid || '', first_aid_expiry || null, tc_ticket || '', tc_ticket_expiry || null, ti_ticket || '', ti_ticket_expiry || null, induction_status || 'pending', company || '', medical_expiry || null, employment_type || 'employee', req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: parseInt(req.params.id), entityLabel: full_name, ip: req.ip });
  req.flash('success', `Crew member updated.`);
  req.session.save(() => res.redirect('/timesheets/crew'));
});

// WEEKLY SUMMARY
router.get('/summary', (req, res) => {
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

  const summary = db.prepare(`
    SELECT c.full_name, c.id as crew_member_id,
      SUM(t.total_hours) as total_hours,
      COUNT(t.id) as entry_count,
      SUM(CASE WHEN t.approved = 1 THEN 1 ELSE 0 END) as approved_count,
      GROUP_CONCAT(DISTINCT j.job_number) as jobs_worked
    FROM timesheets t
    JOIN crew_members c ON t.crew_member_id = c.id
    JOIN jobs j ON t.job_id = j.id
    WHERE t.work_date BETWEEN ? AND ?
    GROUP BY c.id
    ORDER BY c.full_name
  `).all(monStr, sunStr);

  const grandTotal = summary.reduce((sum, s) => sum + (s.total_hours || 0), 0);

  res.render('timesheets/summary', {
    title: 'Weekly Summary',
    currentPage: 'timesheets',
    summary,
    weekOf: monStr,
    weekEnd: sunStr,
    grandTotal: grandTotal.toFixed(1)
  });
});

module.exports = router;
