const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const {
  EQUIPMENT_TYPES,
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_CATEGORY_KEYS,
  DOCKET_SIGNATURE_SLOTS,
  ITEM_SIGNATURE_SLOTS,
  FUEL_LEVELS,
  FUEL_LABELS,
  STATUSES,
  OFFHIRE_METHODS,
  OFFHIRE_METHOD_LABELS,
  getEquipmentType,
  getPowerKind,
} = require('../lib/hireDocketConfig');

const ROADWORTHY_KEYS = ['tyres', 'lights', 'indicators', 'plate', 'chains', 'coupling'];
const ADMIN_ROLES = new Set(['admin', 'management', 'finance']);

// ---------- Shared helpers ----------

function nextDocketNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `HD-${year}-`;
  const row = db.prepare(
    "SELECT docket_number FROM hire_dockets WHERE docket_number LIKE ? ORDER BY id DESC LIMIT 1"
  ).get(prefix + '%');
  let n = 1;
  if (row && row.docket_number) {
    const m = row.docket_number.match(/(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function roadworthyCsv(body, prefix) {
  return ROADWORTHY_KEYS.filter(k => body[`${prefix}_roadworthy_${k}`]).join(',');
}

function bool(v) { return v ? 1 : 0; }
function int(v) { return v == null || v === '' ? null : parseInt(v, 10); }
function num(v) { return v == null || v === '' ? 0 : parseFloat(v) || 0; }
function trimOr(v, d = '') { return v == null ? d : String(v).trim(); }
function yesNoNa(v) { return ['yes', 'no', 'na'].includes(v) ? v : ''; }
function yesNo(v) { return ['yes', 'no'].includes(v) ? v : ''; }
function safeToUse(v) { return ['safe', 'unsafe'].includes(v) ? v : ''; }
function isAdminRole(user) { return !!(user && ADMIN_ROLES.has((user.role || '').toLowerCase())); }

function docketUploadRoot(docketId) {
  return path.join(__dirname, '..', 'data', 'uploads', 'hire-dockets', String(docketId));
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp|heic|heif)|application\/pdf)$/i;

// ---------- Multer: photos (per item) ----------

const photoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(docketUploadRoot(req.params.id), 'items', String(req.params.itemId));
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed (images + PDF only)'));
  },
});

// ---------- Multer: attachments (docket-level, by category) ----------

const attachmentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(docketUploadRoot(req.params.id), 'attachments');
    ensureDir(dest);
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const attachmentUpload = multer({
  storage: attachmentStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.test(file.mimetype)) cb(null, true);
    else cb(new Error('File type not allowed (images + PDF only)'));
  },
});

// ---------- Find helpers ----------

function loadDocket(db, id, opts = {}) {
  const where = opts.includeDeleted ? '' : ' AND hd.deleted_at IS NULL';
  return db.prepare(`
    SELECT hd.*, j.job_number as linked_job_number, j.client as linked_client,
      ru.full_name as recon_reviewer_name,
      du.full_name as deleted_by_name
    FROM hire_dockets hd
    LEFT JOIN jobs j ON hd.job_id = j.id
    LEFT JOIN users ru ON hd.recon_reviewed_by_id = ru.id
    LEFT JOIN users du ON hd.deleted_by = du.id
    WHERE hd.id = ?${where}
  `).get(id);
}

function loadItem(db, docketId, itemId) {
  return db.prepare('SELECT * FROM hire_docket_items WHERE id = ? AND docket_id = ?').get(itemId, docketId);
}

function loadSuppliers(db) {
  try {
    return db.prepare(`
      SELECT id, name, contact_person, phone, pickup_address,
        included_allowance, excess_charge, fuel_return_requirement,
        cleaning_expectation, damage_liability_received, late_return_approved
      FROM hire_suppliers
      ORDER BY name COLLATE NOCASE ASC
    `).all();
  } catch (e) { return []; /* table may not exist yet on pre-131 DBs */ }
}

function groupPhotos(rows) {
  const grouped = { pickup: {}, dropoff: {} };
  rows.forEach(p => {
    const phase = p.phase === 'dropoff' ? 'dropoff' : 'pickup';
    const key = p.checklist_key || '_additional';
    if (!grouped[phase][key]) grouped[phase][key] = [];
    grouped[phase][key].push(p);
  });
  return grouped;
}

// ==================================================
// LIST
// ==================================================
router.get('/', (req, res) => {
  const db = getDb();
  const where = ['hd.deleted_at IS NULL'];
  const params = [];
  if (req.query.status && STATUSES.includes(req.query.status)) {
    where.push('hd.status = ?');
    params.push(req.query.status);
  }
  if (req.query.search) {
    where.push("(hd.docket_number LIKE ? OR hd.job_number LIKE ? OR hd.supplier_name LIKE ? OR hd.site_location LIKE ?)");
    const s = `%${req.query.search}%`;
    params.push(s, s, s, s);
  }
  const whereClause = 'WHERE ' + where.join(' AND ');
  const today = new Date().toISOString().split('T')[0];

  const dockets = db.prepare(`
    SELECT hd.*, j.job_number as linked_job_number,
      (SELECT COUNT(*) FROM hire_docket_items hdi WHERE hdi.docket_id = hd.id) as item_count,
      CASE WHEN hd.status = 'picked_up' AND hd.hire_end_date IS NOT NULL AND hd.hire_end_date < ?
           THEN 1 ELSE 0 END as is_overdue
    FROM hire_dockets hd
    LEFT JOIN jobs j ON hd.job_id = j.id
    ${whereClause}
    ORDER BY hd.created_at DESC
  `).all(today, ...params);

  const counts = db.prepare(`
    SELECT status, COUNT(*) as c FROM hire_dockets WHERE deleted_at IS NULL GROUP BY status
  `).all().reduce((acc, r) => { acc[r.status] = r.c; return acc; }, {});

  let deletedCount = 0;
  try {
    deletedCount = db.prepare('SELECT COUNT(*) as c FROM hire_dockets WHERE deleted_at IS NOT NULL').get().c;
  } catch (e) { /* ignore */ }

  res.render('equipment/hire-dockets/index', {
    title: 'Hire Dockets',
    currentPage: 'equipment',
    dockets,
    filters: req.query,
    deletedCount,
    stats: {
      total: dockets.length,
      open: counts.open || 0,
      picked_up: counts.picked_up || 0,
      returned: counts.returned || 0,
      closed: counts.closed || 0,
    }
  });
});

// ==================================================
// NEW (create form)
// ==================================================
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number DESC").all();
  res.render('equipment/hire-dockets/new', {
    title: 'New Hire Docket',
    currentPage: 'equipment',
    jobs,
    suppliers: loadSuppliers(db),
    today: new Date().toISOString().split('T')[0],
  });
});

// ==================================================
// API — supplier profile JSON (must come before /:id so the "api" token
// isn't captured as a docket id)
// ==================================================
router.get('/api/suppliers/:supplierId', (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare('SELECT * FROM hire_suppliers WHERE id = ?').get(req.params.supplierId);
    if (!row) return res.status(404).json({ error: 'Supplier not found' });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: 'Supplier lookup failed' });
  }
});

// ==================================================
// DELETED LIST (must come before /:id)
// ==================================================
router.get('/deleted', (req, res) => {
  if (!isAdminRole(req.session.user)) {
    req.flash('error', 'Only admin/management can view deleted dockets.');
    return req.session.save(() => res.redirect('/equipment/hire-dockets'));
  }
  const db = getDb();
  const dockets = db.prepare(`
    SELECT hd.*, j.job_number as linked_job_number,
      (SELECT COUNT(*) FROM hire_docket_items hdi WHERE hdi.docket_id = hd.id) as item_count,
      du.full_name as deleted_by_name
    FROM hire_dockets hd
    LEFT JOIN jobs j ON hd.job_id = j.id
    LEFT JOIN users du ON hd.deleted_by = du.id
    WHERE hd.deleted_at IS NOT NULL
    ORDER BY hd.deleted_at DESC
  `).all();
  res.render('equipment/hire-dockets/deleted', {
    title: 'Deleted Hire Dockets',
    currentPage: 'equipment',
    dockets,
  });
});

// ==================================================
// CREATE
// ==================================================
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const docketNumber = nextDocketNumber(db);

  const result = db.prepare(`
    INSERT INTO hire_dockets (
      docket_number, job_number, job_id, date_prepared, site_location,
      prepared_by, prepared_by_contact, supervisor, crew,
      supplier_name, supplier_hire_ref, supplier_contact, supplier_phone,
      pickup_address, hire_period, hire_end_date, agreed_rate,
      created_by_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    docketNumber,
    trimOr(b.job_number),
    int(b.job_id),
    b.date_prepared || null,
    trimOr(b.site_location),
    trimOr(b.prepared_by) || req.session.user.full_name || '',
    trimOr(b.prepared_by_contact),
    trimOr(b.supervisor),
    trimOr(b.crew),
    trimOr(b.supplier_name),
    trimOr(b.supplier_hire_ref),
    trimOr(b.supplier_contact),
    trimOr(b.supplier_phone),
    trimOr(b.pickup_address),
    trimOr(b.hire_period),
    b.hire_end_date || null,
    trimOr(b.agreed_rate),
    req.session.user.id,
  );

  logActivity({
    user: req.session.user, action: 'create', entityType: 'hire_docket',
    entityId: result.lastInsertRowid, entityLabel: docketNumber, ip: req.ip
  });
  req.flash('success', `Hire docket ${docketNumber} created.`);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${result.lastInsertRowid}`));
});

// ==================================================
// SHOW (full detail)
// ==================================================
router.get('/:id', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }

  const items = db.prepare(`
    SELECT * FROM hire_docket_items WHERE docket_id = ? ORDER BY position ASC, id ASC
  `).all(docket.id);

  // Enrich each item with: accessories rows + photos grouped by phase+key
  const accStmt = db.prepare('SELECT * FROM hire_docket_accessories WHERE item_id = ? ORDER BY id ASC');
  const photoStmt = db.prepare('SELECT * FROM hire_docket_photos WHERE item_id = ? ORDER BY uploaded_at ASC');
  items.forEach(it => {
    it.pickup_roadworthy_set = new Set((it.pickup_roadworthy || '').split(',').filter(Boolean));
    it.dropoff_roadworthy_set = new Set((it.dropoff_roadworthy || '').split(',').filter(Boolean));
    it.accessories = accStmt.all(it.id);
    it.photos = groupPhotos(photoStmt.all(it.id));
  });

  // Attachments grouped by category
  const attachmentRows = db.prepare(`
    SELECT a.*, u.full_name as uploaded_by_name
    FROM hire_docket_attachments a
    LEFT JOIN users u ON a.uploaded_by_id = u.id
    WHERE a.docket_id = ?
    ORDER BY a.uploaded_at DESC
  `).all(docket.id);
  const attachmentsByCategory = {};
  ATTACHMENT_CATEGORY_KEYS.forEach(k => { attachmentsByCategory[k] = []; });
  attachmentRows.forEach(a => {
    if (attachmentsByCategory[a.category]) attachmentsByCategory[a.category].push(a);
    else (attachmentsByCategory.other ||= []).push(a);
  });

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number DESC").all();
  const equipment = db.prepare("SELECT id, asset_number, name, registration, serial_number FROM equipment WHERE active = 1 AND ownership_type = 'hired' ORDER BY asset_number").all();

  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'hire_docket' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(docket.id);

  res.render('equipment/hire-dockets/show', {
    title: `Hire Docket ${docket.docket_number}`,
    currentPage: 'equipment',
    docket, items, jobs, equipment, activities,
    attachmentsByCategory,
    attachmentCategories: ATTACHMENT_CATEGORIES,
    equipmentTypes: EQUIPMENT_TYPES,
    roadworthyKeys: ROADWORTHY_KEYS,
    fuelLevels: FUEL_LEVELS,
    fuelLabels: FUEL_LABELS,
    getPowerKind,
    suppliers: loadSuppliers(db),
    offhireMethods: OFFHIRE_METHODS,
    offhireMethodLabels: OFFHIRE_METHOD_LABELS,
    canReconcile: isAdminRole(req.session.user),
    print: req.query.print === '1',
  });
});

// ==================================================
// UPDATE HEADER (docket-level fields)
// ==================================================
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }

  const status = STATUSES.includes(b.status) ? b.status : docket.status;
  const reconAllowed = isAdminRole(req.session.user);

  // Core update — excludes reconciliation fields.
  db.prepare(`
    UPDATE hire_dockets SET
      job_number = ?, job_id = ?, date_prepared = ?, site_location = ?,
      prepared_by = ?, prepared_by_contact = ?, supervisor = ?, crew = ?,
      supplier_name = ?, supplier_hire_ref = ?, supplier_contact = ?, supplier_phone = ?,
      pickup_address = ?, hire_period = ?, hire_end_date = ?, agreed_rate = ?,
      included_allowance = ?, excess_charge = ?, fuel_return_requirement = ?, cleaning_expectation = ?,
      damage_liability_received = ?, late_return_approved = ?,
      pickup_notes = ?, dropoff_notes = ?,
      pickup_collected_by = ?, pickup_signature = ?, pickup_date = ?, pickup_supplier_rep = ?,
      dropoff_returned_by = ?, dropoff_signature = ?, dropoff_date = ?, dropoff_supplier_rep = ?,
      offhire_method = ?, offhire_notified_at = ?, offhire_person_notified = ?, offhire_reference = ?,
      offhire_notified_by = ?, offhire_confirmed = ?,
      dispute_alleged_damage = ?, dispute_photos_both_parties = ?, dispute_raised_immediately = ?,
      dispute_details = ?, dispute_internal_notified = ?, dispute_est_value = ?, dispute_next_action = ?,
      dispute_item_id = ?,
      status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    trimOr(b.job_number), int(b.job_id), b.date_prepared || null, trimOr(b.site_location),
    trimOr(b.prepared_by), trimOr(b.prepared_by_contact), trimOr(b.supervisor), trimOr(b.crew),
    trimOr(b.supplier_name), trimOr(b.supplier_hire_ref), trimOr(b.supplier_contact), trimOr(b.supplier_phone),
    trimOr(b.pickup_address), trimOr(b.hire_period), b.hire_end_date || null, trimOr(b.agreed_rate),
    trimOr(b.included_allowance), trimOr(b.excess_charge), trimOr(b.fuel_return_requirement), trimOr(b.cleaning_expectation),
    bool(b.damage_liability_received === '1'), yesNoNa(b.late_return_approved),
    trimOr(b.pickup_notes), trimOr(b.dropoff_notes),
    trimOr(b.pickup_collected_by), trimOr(b.pickup_signature), b.pickup_date || null, trimOr(b.pickup_supplier_rep),
    trimOr(b.dropoff_returned_by), trimOr(b.dropoff_signature), b.dropoff_date || null, trimOr(b.dropoff_supplier_rep),
    OFFHIRE_METHODS.includes(b.offhire_method) ? b.offhire_method : '',
    b.offhire_notified_at || null,
    trimOr(b.offhire_person_notified), trimOr(b.offhire_reference), trimOr(b.offhire_notified_by),
    bool(b.offhire_confirmed === '1'),
    bool(b.dispute_alleged_damage === '1'), bool(b.dispute_photos_both_parties === '1'), bool(b.dispute_raised_immediately === '1'),
    trimOr(b.dispute_details), trimOr(b.dispute_internal_notified), num(b.dispute_est_value), trimOr(b.dispute_next_action),
    int(b.dispute_item_id),
    status, docket.id,
  );

  // Reconciliation (admin/management/finance only)
  if (reconAllowed && b._save_recon === '1') {
    db.prepare(`
      UPDATE hire_dockets SET
        recon_reviewed_by_id = ?, recon_review_date = ?, recon_invoice_number = ?,
        recon_charges_checked = ?, recon_variations_reconciled = ?, recon_closed_out = ?, recon_notes = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      int(b.recon_reviewed_by_id) || req.session.user.id,
      b.recon_review_date || null,
      trimOr(b.recon_invoice_number),
      bool(b.recon_charges_checked === '1'),
      yesNoNa(b.recon_variations_reconciled),
      bool(b.recon_closed_out === '1'),
      trimOr(b.recon_notes),
      docket.id,
    );
  }

  logActivity({
    user: req.session.user, action: 'update', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: docket.docket_number, ip: req.ip
  });
  req.flash('success', 'Docket saved.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

// ==================================================
// SOFT-DELETE + RESTORE + PURGE
// ==================================================
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  db.prepare('UPDATE hire_dockets SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL')
    .run(req.session.user.id, docket.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: docket.docket_number, ip: req.ip
  });
  req.flash('success', `Hire docket ${docket.docket_number} moved to Deleted.`);
  req.session.save(() => res.redirect('/equipment/hire-dockets'));
});

router.post('/:id/restore', (req, res) => {
  if (!isAdminRole(req.session.user)) {
    req.flash('error', 'Only admin/management can restore dockets.');
    return req.session.save(() => res.redirect('/equipment/hire-dockets/deleted'));
  }
  const db = getDb();
  const docket = loadDocket(db, req.params.id, { includeDeleted: true });
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets/deleted')); }
  db.prepare('UPDATE hire_dockets SET deleted_at = NULL, deleted_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(docket.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: docket.docket_number + ' (restored)', ip: req.ip
  });
  req.flash('success', `Hire docket ${docket.docket_number} restored.`);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

router.post('/:id/purge', (req, res) => {
  if (!isAdminRole(req.session.user)) {
    req.flash('error', 'Only admin/management can permanently delete dockets.');
    return req.session.save(() => res.redirect('/equipment/hire-dockets/deleted'));
  }
  const db = getDb();
  const docket = loadDocket(db, req.params.id, { includeDeleted: true });
  if (!docket || !docket.deleted_at) {
    req.flash('error', 'Deleted docket not found.');
    return req.session.save(() => res.redirect('/equipment/hire-dockets/deleted'));
  }
  // Best-effort: remove the upload folder.
  try {
    const root = docketUploadRoot(docket.id);
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
  db.prepare('DELETE FROM hire_dockets WHERE id = ?').run(docket.id);
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: docket.docket_number + ' (purged)', ip: req.ip
  });
  req.flash('success', `Hire docket ${docket.docket_number} permanently deleted.`);
  req.session.save(() => res.redirect('/equipment/hire-dockets/deleted'));
});

// ==================================================
// ITEMS
// ==================================================
router.post('/:id/items', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }

  const b = req.body;
  const nextPos = (db.prepare('SELECT MAX(position) as m FROM hire_docket_items WHERE docket_id = ?').get(docket.id).m || 0) + 1;

  db.prepare(`
    INSERT INTO hire_docket_items (
      docket_id, position, equipment_type, rego_serial, asset_id, equipment_id,
      quantity, summary_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    docket.id,
    nextPos,
    trimOr(b.equipment_type),
    trimOr(b.rego_serial),
    trimOr(b.asset_id),
    int(b.equipment_id),
    parseInt(b.quantity, 10) || 1,
    trimOr(b.summary_notes),
  );

  req.flash('success', 'Item added.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

router.post('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }

  const b = req.body;
  const wantsPickupDamage = b.pickup_damage_observed === '1' || b.pickup_damage_observed === 1;
  const wantsDropoffDamage = b.dropoff_damage_observed === '1' || b.dropoff_damage_observed === 1;

  // Damage-requires-photo guard: you said damage was observed, so at least one
  // photo must be on file for that phase before we let the save land.
  if (wantsPickupDamage) {
    const count = db.prepare("SELECT COUNT(*) as c FROM hire_docket_photos WHERE item_id = ? AND phase = 'pickup'").get(item.id).c;
    if (count === 0) {
      req.flash('error', 'Upload at least one pick-up photo before saving with damage observed.');
      return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
    }
  }
  if (wantsDropoffDamage) {
    const count = db.prepare("SELECT COUNT(*) as c FROM hire_docket_photos WHERE item_id = ? AND phase = 'dropoff'").get(item.id).c;
    if (count === 0) {
      req.flash('error', 'Upload at least one drop-off photo before saving with damage observed.');
      return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
    }
  }

  db.prepare(`
    UPDATE hire_docket_items SET
      equipment_type = ?, rego_serial = ?, asset_id = ?, equipment_id = ?,
      quantity = ?, summary_notes = ?,
      collected_full_name = ?, collected_mobile = ?, collected_company = ?,
      returned_full_name = ?, returned_mobile = ?, returned_company = ?,
      pickup_datetime = ?, pickup_hours_odometer = ?, pickup_fuel = ?,
      pickup_damage_observed = ?, pickup_photos_taken = ?, pickup_damage_notes = ?,
      pickup_roadworthy = ?, pickup_clean = ?, pickup_initials = ?,
      pickup_pre_existing_damage_ack = ?, pickup_supplier_disputes_damage = ?,
      pickup_op_test_completed = ?, pickup_op_powers_on = ?, pickup_op_safe_to_use = ?,
      pickup_op_reported_to_supplier = ?, pickup_op_faults = ?,
      pickup_site_conditions = ?, pickup_weather = ?,
      pickup_full_inspection_not_possible = ?, pickup_inspection_reason = ?,
      pickup_limited_photos = ?, pickup_supplier_notified_limited = ?,
      pickup_signoff_name = ?,
      dropoff_datetime = ?, dropoff_hours_odometer = ?, dropoff_fuel = ?,
      dropoff_damage_observed = ?, dropoff_photos_taken = ?, dropoff_damage_notes = ?,
      dropoff_roadworthy = ?, dropoff_clean = ?, dropoff_initials = ?,
      dropoff_op_test_completed = ?, dropoff_op_powers_on = ?, dropoff_op_safe_to_use = ?,
      dropoff_op_reported_to_supplier = ?, dropoff_op_faults = ?,
      dropoff_site_conditions = ?, dropoff_weather = ?,
      dropoff_full_inspection_not_possible = ?, dropoff_inspection_reason = ?,
      dropoff_limited_photos = ?, dropoff_supplier_notified_limited = ?,
      dropoff_signoff_name = ?
    WHERE id = ?
  `).run(
    trimOr(b.equipment_type), trimOr(b.rego_serial), trimOr(b.asset_id), int(b.equipment_id),
    parseInt(b.quantity, 10) || 1, trimOr(b.summary_notes),
    trimOr(b.collected_full_name), trimOr(b.collected_mobile), trimOr(b.collected_company),
    trimOr(b.returned_full_name), trimOr(b.returned_mobile), trimOr(b.returned_company),
    b.pickup_datetime || null, trimOr(b.pickup_hours_odometer),
    FUEL_LEVELS.includes(b.pickup_fuel) ? b.pickup_fuel : '',
    bool(wantsPickupDamage), bool(b.pickup_photos_taken === '1'), trimOr(b.pickup_damage_notes),
    roadworthyCsv(b, 'pickup'), bool(b.pickup_clean === '1'), trimOr(b.pickup_initials),
    bool(b.pickup_pre_existing_damage_ack === '1'), yesNo(b.pickup_supplier_disputes_damage),
    bool(b.pickup_op_test_completed === '1'), bool(b.pickup_op_powers_on === '1'),
    safeToUse(b.pickup_op_safe_to_use), yesNoNa(b.pickup_op_reported_to_supplier), trimOr(b.pickup_op_faults),
    trimOr(b.pickup_site_conditions), trimOr(b.pickup_weather),
    bool(b.pickup_full_inspection_not_possible === '1'), trimOr(b.pickup_inspection_reason),
    bool(b.pickup_limited_photos === '1'), bool(b.pickup_supplier_notified_limited === '1'),
    trimOr(b.pickup_signoff_name),
    b.dropoff_datetime || null, trimOr(b.dropoff_hours_odometer),
    FUEL_LEVELS.includes(b.dropoff_fuel) ? b.dropoff_fuel : '',
    bool(wantsDropoffDamage), bool(b.dropoff_photos_taken === '1'), trimOr(b.dropoff_damage_notes),
    roadworthyCsv(b, 'dropoff'), bool(b.dropoff_clean === '1'), trimOr(b.dropoff_initials),
    bool(b.dropoff_op_test_completed === '1'), bool(b.dropoff_op_powers_on === '1'),
    safeToUse(b.dropoff_op_safe_to_use), yesNoNa(b.dropoff_op_reported_to_supplier), trimOr(b.dropoff_op_faults),
    trimOr(b.dropoff_site_conditions), trimOr(b.dropoff_weather),
    bool(b.dropoff_full_inspection_not_possible === '1'), trimOr(b.dropoff_inspection_reason),
    bool(b.dropoff_limited_photos === '1'), bool(b.dropoff_supplier_notified_limited === '1'),
    trimOr(b.dropoff_signoff_name),
    item.id,
  );

  db.prepare('UPDATE hire_dockets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(docket.id);

  logActivity({
    user: req.session.user, action: 'update', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: `${docket.docket_number} item ${item.id}`, ip: req.ip
  });
  req.flash('success', 'Item saved.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

router.post('/:id/items/:itemId/delete', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  db.prepare('DELETE FROM hire_docket_items WHERE id = ? AND docket_id = ?').run(req.params.itemId, docket.id);
  // Best-effort: remove item's photo folder
  try {
    const dir = path.join(docketUploadRoot(docket.id), 'items', String(req.params.itemId));
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) { /* ignore */ }
  req.flash('success', 'Item removed.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

// Duplicate an item — clones type + accessories + summary notes so hiring
// three identical light towers is three clicks instead of three full fills.
// Fresh rego / asset / inspection fields so nothing gets copied by mistake.
router.post('/:id/items/:itemId/duplicate', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const src = loadItem(db, docket.id, req.params.itemId);
  if (!src) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }

  const nextPos = (db.prepare('SELECT MAX(position) as m FROM hire_docket_items WHERE docket_id = ?').get(docket.id).m || 0) + 1;
  const result = db.prepare(`
    INSERT INTO hire_docket_items (
      docket_id, position, equipment_type, rego_serial, asset_id, equipment_id,
      quantity, summary_notes
    ) VALUES (?, ?, ?, '', '', NULL, 1, ?)
  `).run(docket.id, nextPos, src.equipment_type || '', src.summary_notes || '');
  const newItemId = result.lastInsertRowid;

  // Clone accessory lines (qty_out only — qty_back/condition/missing are
  // drop-off state and shouldn't carry across).
  try {
    const accRows = db.prepare('SELECT item_name, qty_out, notes FROM hire_docket_accessories WHERE item_id = ? ORDER BY id ASC').all(src.id);
    const insAcc = db.prepare('INSERT INTO hire_docket_accessories (item_id, item_name, qty_out, notes) VALUES (?, ?, ?, ?)');
    accRows.forEach(r => insAcc.run(newItemId, r.item_name, r.qty_out || 0, r.notes || ''));
  } catch (e) { /* accessories table may not exist on very old DBs */ }

  logActivity({
    user: req.session.user, action: 'create', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: `${docket.docket_number} item ${newItemId} (duplicated from ${src.id})`, ip: req.ip
  });
  req.flash('success', 'Item duplicated — fill in the new rego / asset ID.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${newItemId}`));
});

// ==================================================
// ACCESSORIES
// ==================================================
router.post('/:id/items/:itemId/accessories/load-preset', (req, res) => {
  // NB: this must come BEFORE /:accId so Express doesn't capture "load-preset"
  // as an accessory id and route to the update handler.
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  const type = getEquipmentType(item.equipment_type);
  if (!type || !type.accessoryPresets || type.accessoryPresets.length === 0) {
    req.flash('error', 'No preset for this equipment type.');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
  }
  const existing = new Set(db.prepare('SELECT item_name FROM hire_docket_accessories WHERE item_id = ?').all(item.id).map(r => r.item_name.toLowerCase()));
  const ins = db.prepare('INSERT INTO hire_docket_accessories (item_id, item_name, qty_out) VALUES (?, ?, 1)');
  let added = 0;
  for (const name of type.accessoryPresets) {
    if (!existing.has(name.toLowerCase())) { ins.run(item.id, name); added++; }
  }
  req.flash('success', `Loaded ${added} preset accessor${added === 1 ? 'y' : 'ies'}.`);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

router.post('/:id/items/:itemId/accessories', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  const b = req.body;
  const name = trimOr(b.item_name);
  if (!name) {
    req.flash('error', 'Accessory name is required.');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
  }
  db.prepare(`
    INSERT INTO hire_docket_accessories (item_id, item_name, qty_out, qty_back, condition, missing_damaged, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(item.id, name, int(b.qty_out) || 0, int(b.qty_back) || 0, trimOr(b.condition), bool(b.missing_damaged === '1'), trimOr(b.notes));
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

router.post('/:id/items/:itemId/accessories/:accId', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  const b = req.body;
  db.prepare(`
    UPDATE hire_docket_accessories SET
      item_name = ?, qty_out = ?, qty_back = ?, condition = ?, missing_damaged = ?, notes = ?
    WHERE id = ? AND item_id = ?
  `).run(trimOr(b.item_name), int(b.qty_out) || 0, int(b.qty_back) || 0, trimOr(b.condition), bool(b.missing_damaged === '1'), trimOr(b.notes), req.params.accId, item.id);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

router.post('/:id/items/:itemId/accessories/:accId/delete', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  db.prepare('DELETE FROM hire_docket_accessories WHERE id = ? AND item_id = ?').run(req.params.accId, item.id);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

// ==================================================
// PHOTOS (per item, per phase)
// ==================================================
router.post('/:id/items/:itemId/photos', photoUpload.array('photos', 10), (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  const phase = req.body.phase === 'dropoff' ? 'dropoff' : 'pickup';
  const checklistKey = trimOr(req.body.checklist_key);

  const ins = db.prepare(`
    INSERT INTO hire_docket_photos (item_id, phase, checklist_key, file_path, original_name, mime_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  (req.files || []).forEach(f => {
    ins.run(item.id, phase, checklistKey, f.filename, f.originalname, f.mimetype);
  });
  req.flash('success', `${(req.files || []).length} photo(s) uploaded.`);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

router.post('/:id/items/:itemId/photos/:photoId/delete', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  const photo = db.prepare('SELECT * FROM hire_docket_photos WHERE id = ? AND item_id = ?').get(req.params.photoId, item.id);
  if (photo) {
    try {
      const fp = path.join(docketUploadRoot(docket.id), 'items', String(item.id), photo.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) { /* ignore */ }
    db.prepare('DELETE FROM hire_docket_photos WHERE id = ?').run(photo.id);
  }
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

// Serve a photo (auth-gated; does NOT expose /data/uploads publicly).
router.get('/:id/photos/:photoId', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) return res.sendStatus(404);
  const photo = db.prepare(`
    SELECT p.* FROM hire_docket_photos p
    JOIN hire_docket_items i ON p.item_id = i.id
    WHERE p.id = ? AND i.docket_id = ?
  `).get(req.params.photoId, docket.id);
  if (!photo) return res.sendStatus(404);
  const fp = path.join(docketUploadRoot(docket.id), 'items', String(photo.item_id), photo.file_path);
  if (!fs.existsSync(fp)) return res.sendStatus(404);
  res.sendFile(fp);
});

// ==================================================
// ATTACHMENTS (docket-level, categorised)
// ==================================================
router.post('/:id/attachments', attachmentUpload.array('files', 10), (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const category = ATTACHMENT_CATEGORY_KEYS.includes(req.body.category) ? req.body.category : 'other';

  const ins = db.prepare(`
    INSERT INTO hire_docket_attachments (docket_id, category, file_path, original_name, mime_type, size_bytes, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  (req.files || []).forEach(f => {
    ins.run(docket.id, category, f.filename, f.originalname, f.mimetype, f.size, req.session.user.id);
  });
  req.flash('success', `${(req.files || []).length} file(s) attached.`);
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

router.post('/:id/attachments/:attId/delete', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const att = db.prepare('SELECT * FROM hire_docket_attachments WHERE id = ? AND docket_id = ?').get(req.params.attId, docket.id);
  if (att) {
    try {
      const fp = path.join(docketUploadRoot(docket.id), 'attachments', att.file_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (e) { /* ignore */ }
    db.prepare('DELETE FROM hire_docket_attachments WHERE id = ?').run(att.id);
  }
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

router.get('/:id/attachments/:attId', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) return res.sendStatus(404);
  const att = db.prepare('SELECT * FROM hire_docket_attachments WHERE id = ? AND docket_id = ?').get(req.params.attId, docket.id);
  if (!att) return res.sendStatus(404);
  const fp = path.join(docketUploadRoot(docket.id), 'attachments', att.file_path);
  if (!fs.existsSync(fp)) return res.sendStatus(404);
  res.download(fp, att.original_name || att.file_path);
});

// ==================================================
// SUPPLIER PROFILES (save / upsert from a docket's supplier fields)
// ==================================================

// Upsert a hire_suppliers row from the docket's current supplier + commercial
// terms fields. Matching is by case-insensitive name — so hitting "Save
// supplier" twice on the same supplier updates the row instead of dupe-ing.
router.post('/:id/save-supplier', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  // Prefer form values from the current request (so clicking Save Supplier
  // captures whatever the user just typed into the supplier fields). Fall
  // back to the stored docket values when the field wasn't posted — that way
  // the button works whether or not the docket was saved first.
  const b = req.body || {};
  const pick = (formKey, docketKey) => {
    const v = formKey in b ? b[formKey] : docket[docketKey || formKey];
    return trimOr(v);
  };
  const name = pick('supplier_name');
  if (!name) {
    req.flash('error', 'Supplier name is blank — fill it in on the docket first.');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
  }
  let existing = null;
  try {
    existing = db.prepare('SELECT id FROM hire_suppliers WHERE name = ? COLLATE NOCASE LIMIT 1').get(name);
  } catch (e) { /* table may not exist — will fail on insert too */ }
  const values = [
    pick('supplier_contact'),
    pick('supplier_phone'),
    pick('pickup_address'),
    pick('included_allowance'),
    pick('excess_charge'),
    pick('fuel_return_requirement'),
    pick('cleaning_expectation'),
    bool(('damage_liability_received' in b) ? (b.damage_liability_received === '1') : docket.damage_liability_received),
    yesNoNa(('late_return_approved' in b) ? b.late_return_approved : docket.late_return_approved),
  ];
  try {
    if (existing) {
      db.prepare(`
        UPDATE hire_suppliers SET
          contact_person=?, phone=?, pickup_address=?,
          included_allowance=?, excess_charge=?, fuel_return_requirement=?,
          cleaning_expectation=?, damage_liability_received=?, late_return_approved=?,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(...values, existing.id);
      req.flash('success', `Supplier "${name}" updated in profile — future dockets can pre-fill from it.`);
    } else {
      db.prepare(`
        INSERT INTO hire_suppliers (
          name, contact_person, phone, pickup_address,
          included_allowance, excess_charge, fuel_return_requirement,
          cleaning_expectation, damage_liability_received, late_return_approved,
          created_by_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, ...values, req.session.user.id);
      req.flash('success', `Supplier "${name}" saved — future dockets can pre-fill from it.`);
    }
  } catch (e) {
    req.flash('error', 'Could not save supplier profile: ' + e.message);
  }
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

// ==================================================
// SIGNATURES (canvas → PNG file)
// ==================================================

function writeSignaturePng(dest, dataUrl) {
  // Accept "data:image/png;base64,...." payloads. Anything else = reject.
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec((dataUrl || '').replace(/\s+/g, ''));
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length === 0 || buf.length > 500 * 1024) return false; // sanity: ≤ 500 KB
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
  return true;
}

router.post('/:id/signature', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const slot = req.body.slot;
  if (!DOCKET_SIGNATURE_SLOTS.has(slot)) {
    req.flash('error', 'Unknown signature slot.');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
  }
  const filename = `${slot}-${Date.now()}.png`;
  const dest = path.join(docketUploadRoot(docket.id), 'signatures', filename);
  if (!writeSignaturePng(dest, req.body.signature_data)) {
    req.flash('error', 'Signature image rejected (must be a PNG under 500 KB).');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
  }
  db.prepare(`UPDATE hire_dockets SET ${slot}_signature_path = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(filename, docket.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'hire_docket',
    entityId: docket.id, entityLabel: `${docket.docket_number} signature:${slot}`, ip: req.ip
  });
  req.flash('success', 'Signature captured.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`));
});

router.post('/:id/items/:itemId/signature', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Hire docket not found.'); return req.session.save(() => res.redirect('/equipment/hire-dockets')); }
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}`)); }
  const phase = req.body.slot;
  if (!ITEM_SIGNATURE_SLOTS.has(phase)) {
    req.flash('error', 'Unknown signature slot.');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
  }
  const filename = `item${item.id}-${phase}-${Date.now()}.png`;
  const dest = path.join(docketUploadRoot(docket.id), 'signatures', filename);
  if (!writeSignaturePng(dest, req.body.signature_data)) {
    req.flash('error', 'Signature image rejected (must be a PNG under 500 KB).');
    return req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
  }
  db.prepare(`UPDATE hire_docket_items SET ${phase}_signoff_signature_path = ?, ${phase}_signoff_at = CURRENT_TIMESTAMP WHERE id = ?`).run(filename, item.id);
  req.flash('success', 'Signature captured.');
  req.session.save(() => res.redirect(`/equipment/hire-dockets/${docket.id}#item-${item.id}`));
});

router.get('/:id/signature/:slot', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) return res.sendStatus(404);
  // slot is either a docket-level column or a per-item path: ignore item-level here.
  if (!DOCKET_SIGNATURE_SLOTS.has(req.params.slot)) return res.sendStatus(404);
  const filename = docket[`${req.params.slot}_signature_path`];
  if (!filename) return res.sendStatus(404);
  const fp = path.join(docketUploadRoot(docket.id), 'signatures', filename);
  if (!fs.existsSync(fp)) return res.sendStatus(404);
  res.sendFile(fp);
});

router.get('/:id/items/:itemId/signature/:phase', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) return res.sendStatus(404);
  const item = loadItem(db, docket.id, req.params.itemId);
  if (!item) return res.sendStatus(404);
  if (!ITEM_SIGNATURE_SLOTS.has(req.params.phase)) return res.sendStatus(404);
  const filename = item[`${req.params.phase}_signoff_signature_path`];
  if (!filename) return res.sendStatus(404);
  const fp = path.join(docketUploadRoot(docket.id), 'signatures', filename);
  if (!fs.existsSync(fp)) return res.sendStatus(404);
  res.sendFile(fp);
});

module.exports = router;
