const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { EQUIPMENT_TYPES } = require('../lib/hireDocketConfig');

// EQUIPMENT LIST — the "Owned" tab. Hired gear lives under /equipment/hire.
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  // This register is owned equipment only (treat legacy NULL as owned).
  where.push("(e.ownership_type = 'owned' OR e.ownership_type IS NULL)");
  if (req.query.category) { where.push('e.category = ?'); params.push(req.query.category); }
  if (req.query.condition) { where.push('e.current_condition = ?'); params.push(req.query.condition); }
  if (req.query.status) { where.push('e.status = ?'); params.push(req.query.status); }
  if (req.query.search) { where.push("(e.name LIKE ? OR e.asset_number LIKE ? OR e.serial_number LIKE ?)"); const s = `%${req.query.search}%`; params.push(s, s, s); }
  if (req.query.active === '0') {
    // Show all including inactive
  } else {
    where.push('e.active = 1'); // default show active only
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  // Sorting
  const allowedSorts = { 'name': 'e.name', 'category': 'e.category', 'current_condition': 'e.current_condition', 'next_inspection_date': 'e.next_inspection_date', 'asset_number': 'e.asset_number' };
  const sort = allowedSorts[req.query.sort] ? req.query.sort : 'name';
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';
  const orderByCol = allowedSorts[sort] || 'e.name';

  const equipment = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM equipment_assignments ea WHERE ea.equipment_id = e.id AND ea.actual_return_date IS NULL) as currently_deployed,
      (SELECT j.job_number FROM equipment_assignments ea2 JOIN jobs j ON ea2.job_id = j.id WHERE ea2.equipment_id = e.id AND ea2.actual_return_date IS NULL ORDER BY ea2.assigned_date DESC LIMIT 1) as deployed_to_job,
      (SELECT COUNT(*) FROM equipment_assignments ea3 WHERE ea3.equipment_id = e.id) as total_assignments,
      (SELECT r.condition FROM equipment_condition_reports r WHERE r.equipment_id = e.id ORDER BY r.created_at DESC LIMIT 1) as latest_report_condition,
      (SELECT r.destination FROM equipment_condition_reports r WHERE r.equipment_id = e.id ORDER BY r.created_at DESC LIMIT 1) as latest_report_destination,
      (SELECT r.created_at FROM equipment_condition_reports r WHERE r.equipment_id = e.id ORDER BY r.created_at DESC LIMIT 1) as latest_report_at
    FROM equipment e
    ${whereClause}
    ORDER BY ${orderByCol} ${order}
  `).all(...params);

  const today = new Date().toISOString().split('T')[0];
  const allActive = db.prepare("SELECT * FROM equipment WHERE active = 1").all();
  const inspectionsDue = allActive.filter(e => e.next_inspection_date && e.next_inspection_date <= today).length;
  const totalDeployed = db.prepare("SELECT COUNT(DISTINCT equipment_id) as count FROM equipment_assignments WHERE actual_return_date IS NULL").get().count;
  const poorDamaged = allActive.filter(e => ['poor', 'damaged'].includes(e.current_condition)).length;
  const totalHired = allActive.filter(e => e.ownership_type === 'hired').length;

  res.render('equipment/index', {
    title: 'Equipment / Hire — Owned',
    currentPage: 'equipment',
    tabActive: 'owned',
    equipment,
    filters: req.query,
    stats: { total: equipment.length, inspectionsDue, totalDeployed, poorDamaged, totalHired },
    today,
    sort,
    order: order.toLowerCase(),
  });
});

// ADD-NEW WIZARD — step 1 owned/hired, step 2 equipment type, then
// type-specific fields. Owned posts here (POST /equipment); hired posts to
// /equipment/hire.
router.get('/new', (req, res) => {
  const db = getDb();
  const companies = db.prepare('SELECT id, name FROM hire_companies WHERE active = 1 ORDER BY name').all();
  res.render('equipment/new', {
    title: 'Add Equipment / Hire',
    currentPage: 'equipment',
    equipmentTypes: EQUIPMENT_TYPES,
    companies,
    rateUnits: ['hour', 'day', 'week', 'month'],
    ownership: req.query.ownership === 'hired' ? 'hired' : (req.query.ownership === 'owned' ? 'owned' : ''),
  });
});

// CREATE EQUIPMENT
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  const validStatuses = ['available', 'deployed', 'maintenance', 'inspection_due', 'retired'];
  const equipStatus = validStatuses.includes(b.status) ? b.status : 'available';

  const result = db.prepare(`
    INSERT INTO equipment (asset_number, name, category, equipment_type, description, serial_number, registration, location, purchase_date, purchase_cost, current_condition, storage_location, next_inspection_date, inspection_interval_days, notes, status,
      ownership_type, hire_supplier, hire_daily_rate, hire_start_date, hire_end_date, hire_reference)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.asset_number, b.name, b.category || 'other', b.equipment_type || '', b.description || '', b.serial_number || '', b.registration || '', b.location || '', b.purchase_date || null, parseFloat(b.purchase_cost) || 0, b.current_condition || 'good', b.storage_location || '', b.next_inspection_date || null, parseInt(b.inspection_interval_days) || 90, b.notes || '', equipStatus,
    'owned', b.hire_supplier || '', parseFloat(b.hire_daily_rate) || 0, b.hire_start_date || null, b.hire_end_date || null, b.hire_reference || '');

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment', entityId: result.lastInsertRowid, entityLabel: `${b.asset_number} - ${b.name}`, ip: req.ip });
  req.flash('success', `Equipment ${b.asset_number} added.`);
  req.session.save(() => res.redirect('/equipment'));
});

// POST /bulk — Bulk actions on equipment
router.post('/bulk', (req, res) => {
  const db = getDb();
  const ids = (req.body.ids || '').split(',').map(Number).filter(n => n > 0);
  const action = req.body.action;
  if (ids.length === 0) return res.redirect('/equipment');

  if (action === 'retire') {
    const stmt = db.prepare('UPDATE equipment SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    ids.forEach(id => stmt.run(id));
    logActivity({ user: req.session.user, action: 'update', entityType: 'equipment', entityLabel: `Bulk retired ${ids.length} items`, ip: req.ip });
    req.flash('success', ids.length + ' equipment item(s) retired.');
  } else if (action === 'set_maintenance') {
    const stmt = db.prepare("UPDATE equipment SET current_condition = 'fair', updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    ids.forEach(id => stmt.run(id));
    logActivity({ user: req.session.user, action: 'update', entityType: 'equipment', entityLabel: `Bulk set maintenance for ${ids.length} items`, ip: req.ip });
    req.flash('success', ids.length + ' equipment item(s) flagged for maintenance.');
  }
  req.session.save(() => res.redirect('/equipment'));
});

// SHOW EQUIPMENT DETAIL
router.get('/:id', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Equipment not found.'); return req.session.save(() => res.redirect('/equipment')); }

  const assignments = db.prepare(`
    SELECT ea.*, j.job_number, j.client, u.full_name as assigned_by_name
    FROM equipment_assignments ea
    JOIN jobs j ON ea.job_id = j.id
    JOIN users u ON ea.assigned_by_id = u.id
    WHERE ea.equipment_id = ?
    ORDER BY ea.assigned_date DESC
  `).all(req.params.id);

  const maintenance = db.prepare(`
    SELECT * FROM equipment_maintenance WHERE equipment_id = ? ORDER BY performed_date DESC
  `).all(req.params.id);

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'equipment' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(req.params.id);

  let hireChecklists = [];
  try { hireChecklists = db.prepare('SELECT * FROM equipment_hire_checklists WHERE equipment_id = ? ORDER BY checked_date DESC').all(req.params.id); } catch (e) {}

  // Crew return reports (migration 322) — the worker-reported condition +
  // where the gear went after each shift.
  let conditionReports = [];
  try {
    conditionReports = db.prepare(`
      SELECT r.*, b.booking_number, b.title AS booking_title, cm.full_name AS reporter_name
      FROM equipment_condition_reports r
      LEFT JOIN bookings b ON b.id = r.booking_id
      LEFT JOIN crew_members cm ON cm.id = r.reported_by_crew_id
      WHERE r.equipment_id = ?
      ORDER BY r.created_at DESC LIMIT 50
    `).all(req.params.id);
  } catch (e) {}

  res.render('equipment/show', {
    title: `Equipment - ${item.asset_number}`,
    currentPage: 'equipment',
    item,
    assignments,
    maintenance,
    activities,
    hireChecklists,
    conditionReports,
    jobs
  });
});

// EDIT FORM
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Equipment not found.'); return req.session.save(() => res.redirect('/equipment')); }
  res.render('equipment/form', { title: `Edit ${item.asset_number}`, currentPage: 'equipment', item, equipmentTypes: EQUIPMENT_TYPES });
});

// UPDATE EQUIPMENT
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;

  const validStatuses = ['available', 'deployed', 'maintenance', 'inspection_due', 'retired'];
  const equipStatus = validStatuses.includes(b.status) ? b.status : 'available';

  db.prepare(`
    UPDATE equipment SET asset_number=?, name=?, category=?, equipment_type=?, description=?, serial_number=?, registration=?, location=?, purchase_date=?, purchase_cost=?, current_condition=?, storage_location=?, next_inspection_date=?, inspection_interval_days=?, notes=?, active=?, status=?,
    hire_supplier=?, hire_daily_rate=?, hire_start_date=?, hire_end_date=?, hire_reference=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?
  `).run(b.asset_number, b.name, b.category, b.equipment_type || '', b.description || '', b.serial_number || '', b.registration || '', b.location || '', b.purchase_date || null, parseFloat(b.purchase_cost) || 0, b.current_condition, b.storage_location || '', b.next_inspection_date || null, parseInt(b.inspection_interval_days) || 90, b.notes || '', b.active !== undefined ? (b.active ? 1 : 0) : 1, equipStatus,
    b.hire_supplier || '', parseFloat(b.hire_daily_rate) || 0, b.hire_start_date || null, b.hire_end_date || null, b.hire_reference || '',
    req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'equipment', entityId: parseInt(req.params.id), entityLabel: `${b.asset_number} - ${b.name}`, ip: req.ip });
  req.flash('success', 'Equipment updated.');
  req.session.save(() => res.redirect(`/equipment/${req.params.id}`));
});

// DELETE EQUIPMENT
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Equipment not found.'); return req.session.save(() => res.redirect('/equipment')); }

  const assignments = db.prepare('SELECT COUNT(*) as count FROM equipment_assignments WHERE equipment_id = ? AND actual_return_date IS NULL').get(req.params.id).count;
  if (assignments > 0) {
    req.flash('error', `Cannot delete ${item.asset_number} — it is currently deployed. Return it first or deactivate instead.`);
    return req.session.save(() => res.redirect('/equipment/' + item.id));
  }

  db.prepare('DELETE FROM equipment_maintenance WHERE equipment_id = ?').run(req.params.id);
  db.prepare('DELETE FROM equipment_assignments WHERE equipment_id = ?').run(req.params.id);
  db.prepare('DELETE FROM equipment WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'equipment', entityId: item.id, entityLabel: `${item.asset_number} - ${item.name}`, ip: req.ip });
  req.flash('success', `Equipment ${item.asset_number} deleted.`);
  req.session.save(() => res.redirect('/equipment'));
});

// ASSIGN TO JOB
router.post('/:id/assign', (req, res) => {
  const db = getDb();
  const { job_id, assigned_date, expected_return_date, quantity, notes } = req.body;
  const item = db.prepare('SELECT asset_number, name FROM equipment WHERE id = ?').get(req.params.id);
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  db.prepare(`
    INSERT INTO equipment_assignments (equipment_id, job_id, assigned_date, expected_return_date, quantity, assigned_by_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, job_id, assigned_date, expected_return_date || null, parseInt(quantity) || 1, req.session.user.id, notes || '');

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment_assignment', entityLabel: `${item ? item.asset_number : ''} -> ${job ? job.job_number : ''}`, jobId: parseInt(job_id), jobNumber: job ? job.job_number : '', ip: req.ip });
  req.flash('success', 'Equipment assigned to job.');
  req.session.save(() => res.redirect(`/equipment/${req.params.id}`));
});

// RETURN EQUIPMENT
router.post('/:id/assignments/:assignId/return', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  db.prepare('UPDATE equipment_assignments SET actual_return_date = ? WHERE id = ?').run(today, req.params.assignId);
  logActivity({ user: req.session.user, action: 'update', entityType: 'equipment_assignment', entityId: parseInt(req.params.assignId), details: 'Returned', ip: req.ip });
  req.flash('success', 'Equipment returned.');
  req.session.save(() => res.redirect(`/equipment/${req.params.id}`));
});

// LOG MAINTENANCE
router.post('/:id/maintenance', (req, res) => {
  const db = getDb();
  const { maintenance_type, description, performed_date, performed_by, cost, next_due_date, result, notes } = req.body;

  db.prepare(`
    INSERT INTO equipment_maintenance (equipment_id, maintenance_type, description, performed_date, performed_by, cost, next_due_date, result, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, maintenance_type, description, performed_date, performed_by || '', parseFloat(cost) || 0, next_due_date || null, result || 'pass', notes || '');

  // Update next inspection date on equipment
  if (next_due_date) {
    db.prepare('UPDATE equipment SET next_inspection_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next_due_date, req.params.id);
  }

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment_maintenance', details: `${maintenance_type}: ${description.substring(0, 40)}`, ip: req.ip });
  req.flash('success', 'Maintenance record added.');
  req.session.save(() => res.redirect(`/equipment/${req.params.id}`));
});

// POST /:id/hire-checklist — Submit a hire pickup/return checklist
router.post('/:id/hire-checklist', (req, res) => {
  const db = getDb();
  const b = req.body;

  db.prepare(`
    INSERT INTO equipment_hire_checklists (equipment_id, checklist_type, checked_by, checked_date,
      general_condition, body_exterior, lights_indicators, safety_features, tyres_wheels, fluid_levels, beacons_signals, cleanliness,
      defects_noted, notes, odometer_reading, fuel_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, b.checklist_type || 'pickup', b.checked_by || req.session.user.full_name,
    b.checked_date || new Date().toISOString(),
    b.general_condition || 'good', b.body_exterior || 'pass', b.lights_indicators || 'pass',
    b.safety_features || 'pass', b.tyres_wheels || 'pass', b.fluid_levels || 'pass',
    b.beacons_signals || 'pass', b.cleanliness || 'pass',
    b.defects_noted || '', b.notes || '', b.odometer_reading || '', b.fuel_level || '');

  logActivity({ user: req.session.user, action: 'create', entityType: 'equipment', entityId: parseInt(req.params.id), details: `Hire ${b.checklist_type || 'pickup'} checklist`, ip: req.ip });
  req.flash('success', `Hire ${b.checklist_type || 'pickup'} checklist saved.`);
  req.session.save(() => res.redirect(`/equipment/${req.params.id}`));
});

module.exports = router;
