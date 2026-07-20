const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const {
  checkAllocationBlocks,
  getComplianceStatusBatch,
  getBatchFatigue,
  tcpLevelMeetsRequirement,
} = require('../middleware/compliance');
const { sendAllocationEmail } = require('../middleware/email');

// GET / — Main booking board
router.get('/', (req, res) => {
  const db = getDb();
  const view = req.query.view || 'day';
  const today = new Date().toISOString().split('T')[0];
  const selectedDate = req.query.date || today;

  // Clients for quick-create shift modal
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  // Projects for linking shifts
  const projects = db.prepare('SELECT id, job_number, client, project_name FROM jobs WHERE parent_project_id IS NULL AND status IN (\'active\',\'on_hold\',\'won\') ORDER BY job_number').all();

  if (view === 'month') {
    // Calculate month boundaries
    const d = new Date(selectedDate);
    const year = d.getFullYear();
    const month = d.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const monthStart = firstDay.toISOString().split('T')[0];
    const monthEnd = lastDay.toISOString().split('T')[0];

    // Get allocation counts per date for the month
    const dayCounts = db.prepare(`
      SELECT allocation_date, COUNT(DISTINCT crew_member_id) as crew_count, COUNT(DISTINCT job_id) as job_count
      FROM crew_allocations
      WHERE allocation_date BETWEEN ? AND ? AND status IN ('allocated','confirmed')
      GROUP BY allocation_date
    `).all(monthStart, monthEnd);

    const dayCountMap = {};
    for (const row of dayCounts) {
      dayCountMap[row.allocation_date] = { crew: row.crew_count, jobs: row.job_count };
    }

    return res.render('allocations/index', {
      title: 'Allocations',
      currentPage: 'allocations',
      view: 'month',
      selectedDate,
      today,
      year, month, firstDay, lastDay, dayCountMap,
      weekDays: [],
      jobs: [],
      allocMap: {},
      allocations: [],
      equipmentAssignments: [],
      equipmentList: [],
      crewMembers: [],
      clients,
      projects,
      stats: { jobsToday: 0, crewAllocated: 0, unconfirmed: 0, gaps: 0 },
      userRole: req.session.user.role,
    });
  }

  if (view === 'week') {
    // Calculate Monday of the selected week
    const d = new Date(selectedDate);
    const dayOfWeek = d.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(d);
    monday.setDate(d.getDate() + mondayOffset);

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(monday);
      day.setDate(monday.getDate() + i);
      weekDays.push(day.toISOString().split('T')[0]);
    }

    const weekStart = weekDays[0];
    const weekEnd = weekDays[6];

    const jobs = db.prepare(`
      SELECT j.id, j.job_number, j.client, j.suburb, j.crew_size, j.start_date, j.end_date, j.status, j.required_tcp_level
      FROM jobs j
      WHERE j.status IN ('active','on_hold','won')
      ORDER BY j.job_number ASC
    `).all();

    const allocCounts = db.prepare(`
      SELECT job_id, allocation_date, COUNT(*) as cnt
      FROM crew_allocations
      WHERE allocation_date BETWEEN ? AND ?
      AND status IN ('allocated','confirmed')
      GROUP BY job_id, allocation_date
    `).all(weekStart, weekEnd);

    const allocMap = {};
    for (const row of allocCounts) {
      if (!allocMap[row.job_id]) allocMap[row.job_id] = {};
      allocMap[row.job_id][row.allocation_date] = row.cnt;
    }

    return res.render('allocations/index', {
      title: 'Allocations',
      currentPage: 'allocations',
      view: 'week',
      selectedDate,
      today,
      weekDays,
      jobs,
      allocMap,
      allocations: [],
      equipmentAssignments: [],
      equipmentList: [],
      crewMembers: [],
      clients,
      projects,
      stats: { jobsToday: jobs.length, crewAllocated: 0, unconfirmed: 0, gaps: 0 },
      userRole: req.session.user.role,
    });
  }

  // Day view
  const jobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.suburb, j.crew_size, j.start_date, j.end_date, j.status,
      j.required_tcp_level, u.full_name as pm_name
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.status IN ('active','on_hold','won')
    ORDER BY j.job_number ASC
  `).all();

  // Crew allocations for the selected date
  const allocations = db.prepare(`
    SELECT ca.*, cm.full_name, cm.role, cm.tcp_level,
      cm.tc_ticket_expiry, cm.ti_ticket_expiry, cm.white_card_expiry, cm.first_aid_expiry, cm.medical_expiry
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.job_id, cm.full_name
  `).all(selectedDate);

  // Equipment assignments active on selected date
  const equipmentAssignments = db.prepare(`
    SELECT ea.*, e.name as equipment_name, e.asset_number, e.category
    FROM equipment_assignments ea
    JOIN equipment e ON ea.equipment_id = e.id
    WHERE ea.assigned_date <= ? AND (ea.actual_return_date IS NULL OR ea.actual_return_date >= ?)
    ORDER BY ea.job_id
  `).all(selectedDate, selectedDate);

  // Active crew with compliance status for crew panel
  const crewMembersRaw = db.prepare('SELECT * FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const fatigueMap = getBatchFatigue(selectedDate);

  // Count how many times each crew member is already allocated today
  const allocCountMap = {};
  for (const a of allocations) {
    allocCountMap[a.crew_member_id] = (allocCountMap[a.crew_member_id] || 0) + 1;
  }

  const crewMembers = crewMembersRaw.map(m => ({
    ...m,
    compliance: getComplianceStatusBatch(m, fatigueMap, selectedDate),
    allocatedToday: allocCountMap[m.id] || 0,
  }));

  // Stats
  const crewAllocated = new Set(allocations.map(a => a.crew_member_id)).size;
  const unconfirmed = allocations.filter(a => a.status === 'allocated').length;
  const jobAllocCounts = {};
  for (const a of allocations) {
    jobAllocCounts[a.job_id] = (jobAllocCounts[a.job_id] || 0) + 1;
  }
  const gaps = jobs.filter(j => j.crew_size > 0 && (jobAllocCounts[j.id] || 0) < j.crew_size).length;

  // Equipment list for the equipment panel
  const equipmentList = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM equipment_assignments ea WHERE ea.equipment_id = e.id AND ea.assigned_date <= ? AND (ea.actual_return_date IS NULL OR ea.actual_return_date >= ?)) as assigned_count
    FROM equipment e WHERE e.active = 1
    ORDER BY e.category, e.name
  `).all(selectedDate, selectedDate);

  res.render('allocations/index', {
    title: 'Allocations',
    currentPage: 'allocations',
    view: 'day',
    selectedDate,
    today,
    jobs,
    allocations,
    equipmentAssignments,
    equipmentList,
    crewMembers,
    clients,
    projects,
    stats: { jobsToday: jobs.length, crewAllocated, unconfirmed, gaps },
    weekDays: [],
    allocMap: {},
    userRole: req.session.user.role,
  });
});

// POST / — Create allocation (with blocking)
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, force_override } = req.body;

  const check = checkAllocationBlocks(
    parseInt(crew_member_id), parseInt(job_id),
    allocation_date, start_time || '06:00', end_time || '14:30', null
  );

  // If blocks exist and no override, reject
  if (!check.allowed && !force_override) {
    for (const b of check.blocks) req.flash('error', 'BLOCKED: ' + b);
    for (const w of check.warnings) req.flash('error', w);
    return req.session.save(() => res.redirect('/allocations?date=' + allocation_date));
  }

  // If override requested, check authorisation
  if (!check.allowed && force_override) {
    const userRole = req.session.user.role;
    if (userRole !== 'admin' && userRole !== 'management' && userRole !== 'operations') {
      req.flash('error', 'Only Admin, Management or Operations can override allocation blocks');
      return req.session.save(() => res.redirect('/allocations?date=' + allocation_date));
    }
    logActivity({
      user: req.session.user, action: 'update', entityType: 'allocation_override',
      jobId: parseInt(job_id),
      details: 'Override: ' + check.blocks.join('; '), ip: req.ip,
    });
  }

  // Show warnings (non-blocking)
  for (const w of check.warnings) req.flash('error', w);

  db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, allocated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(job_id), parseInt(crew_member_id), allocation_date,
    start_time || '06:00', end_time || '14:30', shift_type || 'day',
    role_on_site || '', notes || '', req.session.user.id
  );

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    jobId: parseInt(job_id), details: 'Allocated crew to job on ' + allocation_date, ip: req.ip });

  // Send email notification to job PM/supervisor
  try {
    const job = db.prepare('SELECT j.*, u.full_name as pm_name, u.email as pm_email, u.id as pm_id FROM jobs j LEFT JOIN users u ON j.project_manager_id = u.id WHERE j.id = ?').get(parseInt(job_id));
    const crewMember = db.prepare('SELECT full_name FROM crew_members WHERE id = ?').get(parseInt(crew_member_id));
    if (job && crewMember) {
      const allocData = { crew_name: crewMember.full_name, job_number: job.job_number, client: job.client, allocation_date, shift_type: shift_type || 'day' };
      const allocatedByName = req.session.user.full_name;
      const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
      // Notify PM (if different from allocator)
      if (job.pm_id && job.pm_id !== req.session.user.id && job.pm_email) {
        sendAllocationEmail(allocData, { full_name: job.pm_name, email: job.pm_email }, allocatedByName, baseUrl);
      }
      // Notify ops supervisor (if different from PM and allocator)
      if (job.ops_supervisor_id && job.ops_supervisor_id !== req.session.user.id && job.ops_supervisor_id !== job.pm_id) {
        const sup = db.prepare('SELECT full_name, email FROM users WHERE id = ?').get(job.ops_supervisor_id);
        if (sup && sup.email) sendAllocationEmail(allocData, sup, allocatedByName, baseUrl);
      }
    }
  } catch (emailErr) {
    console.error('[Allocations] Email error:', emailErr.message);
  }

  if (check.blocks.length === 0 && check.warnings.length === 0) {
    req.flash('success', 'Crew member allocated successfully');
  }

  req.session.save(() => res.redirect('/allocations?date=' + allocation_date));
});

// ============================================================
// JSON API endpoints for drag-and-drop booking board
// ============================================================

// GET /api/crew-panel.json — Crew list with compliance status
router.get('/api/crew-panel.json', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const crewRaw = db.prepare('SELECT * FROM crew_members WHERE active = 1 ORDER BY full_name').all();
  const fatigueMap = getBatchFatigue(date);

  // Count allocations per crew for the date
  const allocs = db.prepare(`
    SELECT crew_member_id, COUNT(*) as cnt FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
    GROUP BY crew_member_id
  `).all(date);
  const allocCounts = {};
  for (const a of allocs) allocCounts[a.crew_member_id] = a.cnt;

  const crew = crewRaw.map(m => {
    const c = getComplianceStatusBatch(m, fatigueMap, date);
    return {
      id: m.id,
      full_name: m.full_name,
      role: m.role,
      tcp_level: m.tcp_level,
      canAllocate: c.canAllocate,
      fatigueBlocked: c.fatigueBlocked,
      inductionComplete: c.inductionComplete,
      allTicketsValid: c.allTicketsValid,
      supervisorApproved: c.supervisorApproved,
      missingDocs: c.missingDocs,
      daysWorked: c.daysWorked,
      allocatedToday: allocCounts[m.id] || 0,
    };
  });

  res.json(crew);
});

// POST /api/allocate.json — Create allocation via drag-drop
router.post('/api/allocate.json', (req, res) => {
  const db = getDb();
  const { job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, force_override } = req.body;

  const check = checkAllocationBlocks(
    parseInt(crew_member_id), parseInt(job_id),
    allocation_date, start_time || '06:00', end_time || '14:30', null
  );

  if (!check.allowed && !force_override) {
    return res.json({ success: false, blocks: check.blocks, warnings: check.warnings, overridable: check.overridable });
  }

  if (!check.allowed && force_override) {
    const userRole = req.session.user.role;
    if (userRole !== 'admin' && userRole !== 'management' && userRole !== 'operations') {
      return res.json({ success: false, blocks: ['Unauthorised to override'], warnings: [] });
    }
    logActivity({
      user: req.session.user, action: 'update', entityType: 'allocation_override',
      jobId: parseInt(job_id),
      details: 'Override (drag-drop): ' + check.blocks.join('; '), ip: req.ip,
    });
  }

  const result = db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, notes, allocated_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    parseInt(job_id), parseInt(crew_member_id), allocation_date,
    start_time || '06:00', end_time || '14:30', shift_type || 'day',
    role_on_site || '', notes || '', req.session.user.id
  );

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    jobId: parseInt(job_id), details: 'Allocated crew via board on ' + allocation_date, ip: req.ip });

  // Fetch the new allocation with crew info for the UI
  const alloc = db.prepare(`
    SELECT ca.*, cm.full_name, cm.role, cm.tcp_level
    FROM crew_allocations ca JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.id = ?
  `).get(result.lastInsertRowid);

  res.json({ success: true, allocationId: result.lastInsertRowid, allocation: alloc, warnings: check.warnings });
});

// POST /api/move.json — Move allocation between jobs
router.post('/api/move.json', (req, res) => {
  const db = getDb();
  const { allocation_id, new_job_id, force_override } = req.body;

  const alloc = db.prepare('SELECT * FROM crew_allocations WHERE id = ?').get(allocation_id);
  if (!alloc) return res.json({ success: false, blocks: ['Allocation not found'] });

  const check = checkAllocationBlocks(
    alloc.crew_member_id, parseInt(new_job_id),
    alloc.allocation_date, alloc.start_time, alloc.end_time, alloc.id
  );

  if (!check.allowed && !force_override) {
    return res.json({ success: false, blocks: check.blocks, warnings: check.warnings, overridable: check.overridable });
  }

  if (!check.allowed && force_override) {
    const userRole = req.session.user.role;
    if (userRole !== 'admin' && userRole !== 'management' && userRole !== 'operations') {
      return res.json({ success: false, blocks: ['Unauthorised to override'], warnings: [] });
    }
    logActivity({
      user: req.session.user, action: 'update', entityType: 'allocation_override',
      entityId: parseInt(allocation_id), jobId: parseInt(new_job_id),
      details: 'Override (move): ' + check.blocks.join('; '), ip: req.ip,
    });
  }

  db.prepare('UPDATE crew_allocations SET job_id = ?, status = ? WHERE id = ?')
    .run(parseInt(new_job_id), 'allocated', allocation_id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    entityId: parseInt(allocation_id), jobId: parseInt(new_job_id),
    details: 'Moved allocation to new job', ip: req.ip });

  res.json({ success: true, warnings: check.warnings });
});

// DELETE /api/:id.json — Remove allocation
router.delete('/api/:id.json', (req, res) => {
  const db = getDb();
  const result = db.prepare("DELETE FROM crew_allocations WHERE id = ? AND status = 'allocated'").run(req.params.id);
  if (result.changes > 0) {
    logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_allocation',
      entityId: parseInt(req.params.id), details: 'Removed allocation via board', ip: req.ip });
  }
  res.json({ success: result.changes > 0 });
});

// ============================================================
// Standard form-based endpoints (kept for fallback)
// ============================================================

// POST /:id/confirm — Confirm allocation
router.post('/:id/confirm', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    entityId: parseInt(req.params.id), details: 'Confirmed allocation', ip: req.ip });
  req.flash('success', 'Allocation confirmed');
  req.session.save(() => res.redirect('/allocations?date=' + date));
});

// POST /:id/cancel — Cancel allocation
router.post('/:id/cancel', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    UPDATE crew_allocations SET status = 'cancelled' WHERE id = ?
  `).run(req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    entityId: parseInt(req.params.id), details: 'Cancelled allocation', ip: req.ip });
  req.flash('success', 'Allocation cancelled');
  req.session.save(() => res.redirect('/allocations?date=' + date));
});

// POST /:id/delete — Delete allocation (only if still allocated)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  db.prepare(`
    DELETE FROM crew_allocations WHERE id = ? AND status = 'allocated'
  `).run(req.params.id);

  req.flash('success', 'Allocation removed');
  req.session.save(() => res.redirect('/allocations?date=' + date));
});

// POST /confirm-all — Bulk confirm all for a date
router.post('/confirm-all', (req, res) => {
  const db = getDb();
  const { allocation_date } = req.body;

  const result = db.prepare(`
    UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
    WHERE allocation_date = ? AND status = 'allocated'
  `).run(allocation_date);

  logActivity({ user: req.session.user, action: 'update', entityType: 'crew_allocation',
    details: 'Bulk confirmed ' + result.changes + ' allocations for ' + allocation_date, ip: req.ip });
  req.flash('success', result.changes + ' allocations confirmed');
  req.session.save(() => res.redirect('/allocations?date=' + allocation_date));
});

// POST /copy-day — Copy allocations from one day to another
router.post('/copy-day', (req, res) => {
  const db = getDb();
  const { from_date, to_date } = req.body;

  const existingCount = db.prepare(`
    SELECT COUNT(*) as count FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
  `).get(to_date).count;

  if (existingCount > 0) {
    req.flash('error', to_date + ' already has ' + existingCount + ' allocations. Clear them first or allocate manually.');
    return req.session.save(() => res.redirect('/allocations?date=' + to_date));
  }

  const result = db.prepare(`
    INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, notes, allocated_by_id)
    SELECT job_id, crew_member_id, ?, start_time, end_time, shift_type, role_on_site, 'allocated', notes, ?
    FROM crew_allocations
    WHERE allocation_date = ? AND status IN ('allocated','confirmed')
  `).run(to_date, req.session.user.id, from_date);

  logActivity({ user: req.session.user, action: 'create', entityType: 'crew_allocation',
    details: 'Copied ' + result.changes + ' allocations from ' + from_date + ' to ' + to_date, ip: req.ip });
  req.flash('success', result.changes + ' allocations copied from ' + from_date + ' to ' + to_date);
  req.session.save(() => res.redirect('/allocations?date=' + to_date));
});

// POST /create-shift — Quick create a shift (lightweight job entry for daily allocation)
router.post('/create-shift', (req, res) => {
  const db = getDb();
  const b = req.body;
  const date = b.shift_date || new Date().toISOString().split('T')[0];

  // Resolve client name
  let clientName = '';
  if (b.client_id) {
    const client = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (client) clientName = client.company_name;
  }

  // Generate shift job number
  const lastShift = db.prepare("SELECT job_number FROM jobs WHERE job_number LIKE 'S-%' ORDER BY id DESC LIMIT 1").get();
  let nextNum = 1;
  if (lastShift) {
    const match = lastShift.job_number.match(/S-(\d+)/);
    if (match) nextNum = parseInt(match[1]) + 1;
  }
  const shiftNumber = 'S-' + String(nextNum).padStart(5, '0');
  const jobName = `${shiftNumber} | ${clientName} | ${b.suburb || ''} | ${date}`;

  try {
    const result = db.prepare(`
      INSERT INTO jobs (job_number, job_name, client, client_id, parent_project_id, site_address, suburb, status, stage, start_date, end_date,
        crew_size, required_tcp_level, notes, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'delivery', ?, ?, ?, ?, ?, 'NSW')
    `).run(
      shiftNumber, jobName, clientName, b.client_id || null, b.parent_project_id || null,
      b.site_address || '', b.suburb || '', date, date,
      parseInt(b.crew_size) || 0, b.required_tcp_level || '', b.notes || ''
    );

    logActivity({ user: req.session.user, action: 'create', entityType: 'shift',
      jobId: result.lastInsertRowid, details: 'Quick-created shift ' + shiftNumber + ' for ' + date, ip: req.ip });

    req.flash('success', 'Shift ' + shiftNumber + ' created for ' + date);
    req.session.save(() => res.redirect('/allocations?date=' + date));
  } catch (err) {
    req.flash('error', 'Failed to create shift: ' + err.message);
    req.session.save(() => res.redirect('/allocations?date=' + date));
  }
});

// GET /api/equipment-panel.json — Equipment list with availability
router.get('/api/equipment-panel.json', (req, res) => {
  const db = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];

  const equipment = db.prepare(`
    SELECT e.*,
      (SELECT GROUP_CONCAT(j.job_number) FROM equipment_assignments ea JOIN jobs j ON ea.job_id = j.id
       WHERE ea.equipment_id = e.id AND ea.assigned_date <= ? AND (ea.actual_return_date IS NULL OR ea.actual_return_date >= ?)) as assigned_to
    FROM equipment e WHERE e.active = 1
    ORDER BY e.category, e.name
  `).all(date, date);

  res.json(equipment);
});

// POST /api/assign-equipment.json — Assign equipment to a job
router.post('/api/assign-equipment.json', (req, res) => {
  const db = getDb();
  const { equipment_id, job_id, date } = req.body;

  const result = db.prepare(`
    INSERT INTO equipment_assignments (equipment_id, job_id, assigned_date, quantity, assigned_by_id)
    VALUES (?, ?, ?, 1, ?)
  `).run(parseInt(equipment_id), parseInt(job_id), date, req.session.user.id);

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment_assignment',
    jobId: parseInt(job_id), details: 'Assigned equipment to job via allocations board', ip: req.ip });

  res.json({ success: true, assignmentId: result.lastInsertRowid });
});

module.exports = router;
