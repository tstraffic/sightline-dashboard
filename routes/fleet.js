const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { badgesFor, needsAction, todayISO } = require('../lib/fleetStatus');

// Service-record invoice uploads — drag-drop PDFs / images of the
// workshop invoice straight onto the service record. Stored under
// uploads/fleet/vehicle_<id>/ so deleting a vehicle leaves a single
// directory to clear out.
const INVOICE_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'fleet');
const invoiceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(INVOICE_UPLOAD_DIR, 'vehicle_' + req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).substring(7) + ext);
  }
});
const INVOICE_ALLOWED = /\.(pdf|png|jpg|jpeg|gif|webp|heic|tif|tiff)$/i;
const invoiceUpload = multer({
  storage: invoiceStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (INVOICE_ALLOWED.test(file.originalname)) cb(null, true);
    else cb(new Error('Invoice must be a PDF or image.'), false);
  },
});

// Heuristic linkage between a vehicle and free-text reports submitted by
// crew (incidents + safety_forms equipment counts). Workers type the
// rego or asset_id into the description, so we LIKE-match those values
// across title/description/location. Returns empty arrays for vehicles
// missing both identifiers (avoids a SQL match on '' which would return
// every row).
function lookupRelatedReports(db, vehicle) {
  const out = { incidents: [], equipmentChecks: [] };
  const tokens = [vehicle.rego, vehicle.asset_id, vehicle.fleet_id]
    .map(s => (s == null ? '' : String(s).trim()))
    .filter(t => t && t.length >= 2);
  if (!tokens.length) return out;

  // Incidents — only query if the table exists and has the columns we need.
  try {
    const incidentParts = tokens.map(() => '(title LIKE ? OR description LIKE ? OR COALESCE(location, \'\') LIKE ?)').join(' OR ');
    const incidentParams = [];
    tokens.forEach(t => { const wild = `%${t}%`; incidentParams.push(wild, wild, wild); });
    out.incidents = db.prepare(`
      SELECT i.id, i.incident_number, i.incident_type, i.severity, i.title, i.description,
             i.location, i.incident_date, i.investigation_status, i.created_at
      FROM incidents i
      WHERE ${incidentParts}
      ORDER BY COALESCE(i.incident_date, i.created_at) DESC LIMIT 50
    `).all(...incidentParams);
  } catch (e) {
    console.warn('[fleet] incident lookup failed for vehicle', vehicle.id, ':', e.message);
  }

  // Equipment counts live in safety_forms with form_type='equipment' and a
  // JSON data blob; LIKE the raw JSON for the tokens.
  try {
    const equipParts = tokens.map(() => 'data LIKE ?').join(' OR ');
    const equipParams = tokens.map(t => `%${t}%`);
    out.equipmentChecks = db.prepare(`
      SELECT sf.id, sf.form_type, sf.data, sf.status, sf.submitted_at, sf.created_at,
             cm.full_name AS submitted_by
      FROM safety_forms sf
      LEFT JOIN crew_members cm ON cm.id = sf.crew_member_id
      WHERE sf.form_type = 'equipment' AND (${equipParts})
      ORDER BY COALESCE(sf.submitted_at, sf.created_at) DESC LIMIT 50
    `).all(...equipParams);
  } catch (e) {
    console.warn('[fleet] equipment lookup failed for vehicle', vehicle.id, ':', e.message);
  }

  return out;
}

const SERVICE_TYPES = [
  'Major Service',
  'Minor Service',
  'Oil Change / Minor',
  'Tyres',
  'Brakes',
  'Battery / Electrical',
  'Repairs / Accident',
  'Inspection / Slip',
  'Safety Equipment',
  'Other',
];

const VEHICLE_STATUSES = ['Active', 'Spare', 'Retired', 'Verify'];
const VEHICLE_TYPES   = ['Light Vehicle', 'Heavy Vehicle'];

// Normalise an empty / blank form value into NULL for nullable DB columns
// — passing '' into a DATE / INTEGER column would store the empty string
// instead of NULL, which then breaks the status logic and the aggregates.
const orNull = v => (v === undefined || v === null || v === '') ? null : v;
const intOrNull = v => {
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  if (s === '') return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
};
const numOrNull = v => {
  const s = (v === undefined || v === null) ? '' : String(v).trim();
  if (s === '') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
};

// ── DEPOTS — list + CRUD ─────────────────────────────────────────────
// Manages the depot list referenced when picking a booking depot.
// Stored in the `depots` table (migration 257). getDepots() in
// routes/bookings.js reads the same table, so an edit here is visible
// to the next /bookings page render with no restart.
router.get('/depots', (req, res) => {
  const db = getDb();
  const depots = db.prepare("SELECT id, name, address, suburb, state, postcode, notes, active, sort_order FROM depots ORDER BY sort_order, name").all();
  // Count bookings per depot so the planner can see usage before deleting.
  const usage = {};
  try {
    const rows = db.prepare("SELECT depot, COUNT(*) AS n FROM bookings WHERE deleted_at IS NULL AND depot IS NOT NULL AND depot != '' GROUP BY depot").all();
    rows.forEach(r => { usage[r.depot] = r.n; });
  } catch (e) { /* depot col may not exist on legacy DB */ }
  res.render('fleet/depots', {
    title: 'Depots',
    currentPage: 'fleet',
    depots,
    usage,
  });
});

router.post('/depots', (req, res) => {
  const db = getDb();
  const name = (req.body.name || '').trim();
  if (!name) { req.flash('error', 'Depot name is required.'); return res.redirect('/fleet/depots'); }
  // Get next sort_order
  const maxSort = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM depots").get();
  try {
    db.prepare(`
      INSERT INTO depots (name, address, suburb, state, postcode, notes, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(
      name,
      (req.body.address || '').trim(),
      (req.body.suburb || '').trim(),
      (req.body.state || '').trim(),
      (req.body.postcode || '').trim(),
      (req.body.notes || '').trim(),
      maxSort.n
    );
    logActivity({ user: req.session.user, action: 'create', entityType: 'depot', entityLabel: name, ip: req.ip });
    req.flash('success', `Depot "${name}" added.`);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) req.flash('error', `A depot named "${name}" already exists.`);
    else req.flash('error', 'Could not add depot: ' + e.message);
  }
  res.redirect('/fleet/depots');
});

router.post('/depots/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare("SELECT id, name FROM depots WHERE id = ?").get(req.params.id);
  if (!existing) { req.flash('error', 'Depot not found.'); return res.redirect('/fleet/depots'); }
  const newName = (req.body.name || '').trim();
  if (!newName) { req.flash('error', 'Depot name is required.'); return res.redirect('/fleet/depots'); }
  const active = req.body.active === '1' || req.body.active === 'on' || req.body.active === 'true' ? 1 : 0;
  try {
    db.prepare(`
      UPDATE depots SET name=?, address=?, suburb=?, state=?, postcode=?, notes=?, active=?, updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      newName,
      (req.body.address || '').trim(),
      (req.body.suburb || '').trim(),
      (req.body.state || '').trim(),
      (req.body.postcode || '').trim(),
      (req.body.notes || '').trim(),
      active,
      req.params.id
    );
    // If the depot was renamed, also rename the depot field on every
    // existing booking so the dropdown selection still matches.
    if (newName !== existing.name) {
      try { db.prepare("UPDATE bookings SET depot = ? WHERE depot = ?").run(newName, existing.name); } catch (e) {}
    }
    logActivity({ user: req.session.user, action: 'update', entityType: 'depot', entityId: req.params.id, entityLabel: newName, ip: req.ip });
    req.flash('success', `Depot updated.`);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) req.flash('error', `A depot named "${newName}" already exists.`);
    else req.flash('error', 'Could not update depot: ' + e.message);
  }
  res.redirect('/fleet/depots');
});

router.post('/depots/:id/delete', (req, res) => {
  const db = getDb();
  const depot = db.prepare("SELECT id, name FROM depots WHERE id = ?").get(req.params.id);
  if (!depot) { req.flash('error', 'Depot not found.'); return res.redirect('/fleet/depots'); }
  // Block delete if any bookings still reference it — soft-deactivate
  // is the planner-safe path.
  let inUse = 0;
  try { inUse = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE depot = ? AND deleted_at IS NULL").get(depot.name).n; } catch (e) {}
  if (inUse > 0) {
    req.flash('error', `Cannot delete "${depot.name}" — still used by ${inUse} booking${inUse === 1 ? '' : 's'}. Untick "Active" to retire it without deleting.`);
    return res.redirect('/fleet/depots');
  }
  db.prepare("DELETE FROM depots WHERE id = ?").run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'depot', entityId: req.params.id, entityLabel: depot.name, ip: req.ip });
  req.flash('success', `Depot "${depot.name}" deleted.`);
  res.redirect('/fleet/depots');
});

// ── FLEET REGISTER (list) ────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const today = todayISO();

  const where = [];
  const params = [];
  if (req.query.status && VEHICLE_STATUSES.includes(req.query.status)) {
    where.push('status = ?'); params.push(req.query.status);
  }
  if (req.query.vehicle_type && VEHICLE_TYPES.includes(req.query.vehicle_type)) {
    where.push('vehicle_type = ?'); params.push(req.query.vehicle_type);
  }
  if (req.query.search) {
    where.push('(asset_id LIKE ? OR rego LIKE ? OR fleet_id LIKE ? OR make LIKE ? OR model LIKE ?)');
    const s = `%${req.query.search}%`;
    params.push(s, s, s, s, s);
  }
  const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const allowedSorts = {
    asset_id: 'asset_id', rego: 'rego', status: 'status',
    last_service_date: 'last_service_date',
    highest_odo_km: 'highest_odo_km',
    total_maint_cost: 'total_maint_cost',
  };
  const sort = allowedSorts[req.query.sort] ? req.query.sort : 'asset_id';
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';

  const vehicles = db.prepare(`
    SELECT * FROM vehicle_summary
    ${whereClause}
    ORDER BY ${allowedSorts[sort]} ${order}, asset_id ASC
  `).all(...params);

  // Fleet-wide rollups for the KPI strip
  const allRows = db.prepare('SELECT * FROM vehicle_summary').all();
  const totalSpend = allRows.reduce((s, v) => s + (Number(v.total_maint_cost) || 0), 0);
  const counts = {
    total:    allRows.length,
    active:   allRows.filter(v => v.status === 'Active').length,
    verify:   allRows.filter(v => v.status === 'Verify').length,
    retired:  allRows.filter(v => v.status === 'Retired').length,
  };
  const compliance = {
    registration: allRows.filter(v => { const b = badgesFor(v, today); return b.registration.tone === 'bad' || b.registration.tone === 'warn'; }).length,
    service:      allRows.filter(v => { const b = badgesFor(v, today); return b.service.tone === 'bad'      || b.service.tone === 'warn'; }).length,
    inspection:   allRows.filter(v => { const b = badgesFor(v, today); return b.inspection.tone === 'bad'   || b.inspection.tone === 'warn'; }).length,
    fireExt:      allRows.filter(v => { const b = badgesFor(v, today); return b.fireExt.tone === 'bad'      || b.fireExt.tone === 'warn'; }).length,
  };

  // Spend by service type + spend by vehicle (small tables on the index)
  const spendByType = db.prepare(`
    SELECT COALESCE(service_type, 'Other') AS service_type, COALESCE(SUM(cost),0) AS total
    FROM service_records
    GROUP BY COALESCE(service_type, 'Other')
    ORDER BY total DESC
  `).all();

  res.render('fleet/index', {
    title: 'Fleet Register',
    currentPage: 'fleet',
    vehicles,
    filters: req.query,
    sort,
    order: order.toLowerCase(),
    today,
    counts,
    totalSpend,
    compliance,
    spendByType,
    serviceTypes: SERVICE_TYPES,
    vehicleStatuses: VEHICLE_STATUSES,
    vehicleTypes: VEHICLE_TYPES,
    badgesFor,
  });
});

// ── RECONCILE EQUIPMENT ↔ FLEET ──────────────────────────────────────
// One-time admin tool: walk through every equipment row that looks like
// a registered vehicle, link it to its Fleet counterpart, and deactivate
// the equipment row so it stops appearing in vehicle pickers. The
// `fleet_vehicle_id` column on equipment (migration 237) keeps the audit
// trail intact — pickers just hide rows where it's set.
router.get('/reconcile', (req, res) => {
  const db = getDb();
  const showResolved = req.query.show === 'all';

  // Vehicle-shaped equipment rows: anything with a licence plate, the
  // vehicle category, or a name that smells like a road vehicle.
  const filter = `
    (
      e.category = 'vehicle'
      OR (e.licence_plate IS NOT NULL AND e.licence_plate != '')
      OR LOWER(e.name) LIKE '%ute%'
      OR LOWER(e.name) LIKE '%truck%'
      OR LOWER(e.name) LIKE '%hilux%'
      OR LOWER(e.name) LIKE '%d-max%'
      OR LOWER(e.name) LIKE '%dmax%'
    )
  `;
  const activeClause = showResolved
    ? '' // show everything including already-linked + already-deactivated
    : 'AND (e.fleet_vehicle_id IS NULL AND e.active = 1)';

  let rows = [];
  try {
    rows = db.prepare(`
      SELECT e.id, e.asset_number, e.name, e.category, e.licence_plate, e.active,
             e.fleet_vehicle_id, v.asset_id AS fleet_asset_id, v.rego AS fleet_rego
      FROM equipment e
      LEFT JOIN vehicles v ON v.id = e.fleet_vehicle_id
      WHERE ${filter} ${activeClause}
      ORDER BY (e.fleet_vehicle_id IS NOT NULL) ASC, e.asset_number, e.name
    `).all();
  } catch (e) { /* migration may not have applied yet on a legacy DB */ }

  // All active Fleet vehicles for the dropdown
  const fleet = db.prepare(`
    SELECT id, asset_id, rego, status,
      COALESCE(NULLIF(TRIM(make || ' ' || model), ''), asset_id) AS label
    FROM vehicles
    ORDER BY asset_id
  `).all();

  // Suggest a match by exact rego (case + space tolerant). Confidence:
  //   'exact'  → rego strings match after normalisation
  //   'asset'  → equipment.asset_number matches a fleet asset_id
  //   null     → no auto-suggestion
  const norm = s => String(s || '').toUpperCase().replace(/\s+/g, '');
  const byRego  = new Map(fleet.filter(f => f.rego).map(f => [norm(f.rego), f]));
  const byAsset = new Map(fleet.map(f => [norm(f.asset_id), f]));

  const items = rows.map(r => {
    let suggestion = null, confidence = null;
    if (r.licence_plate) {
      const m = byRego.get(norm(r.licence_plate));
      if (m) { suggestion = m; confidence = 'exact'; }
    }
    if (!suggestion && r.asset_number) {
      const m = byAsset.get(norm(r.asset_number));
      if (m) { suggestion = m; confidence = 'asset'; }
    }
    return { ...r, suggestion, confidence };
  });

  // Reconciliation progress stats
  let stats = { total: 0, linked: 0, pending: 0 };
  try {
    stats = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN fleet_vehicle_id IS NOT NULL THEN 1 ELSE 0 END) AS linked,
        SUM(CASE WHEN fleet_vehicle_id IS NULL AND active = 1 THEN 1 ELSE 0 END) AS pending
      FROM equipment e
      WHERE ${filter}
    `).get();
  } catch (e) {}

  res.render('fleet/reconcile', {
    title: 'Reconcile Equipment ↔ Fleet',
    currentPage: 'fleet',
    items,
    fleet,
    stats,
    showResolved,
  });
});

// Link an equipment row to a Fleet vehicle. Also deactivates the
// equipment row (default) so duplicates vanish from pickers — pass
// keep_active=1 to keep it visible (rare; for cases where the equipment
// row genuinely represents something distinct from the fleet vehicle).
router.post('/reconcile/:equipmentId/link', (req, res) => {
  const db = getDb();
  const eqId = parseInt(req.params.equipmentId, 10);
  const fleetId = parseInt(req.body.fleet_vehicle_id, 10);
  if (!eqId || !fleetId) {
    req.flash('error', 'Pick a Fleet vehicle first.');
    return res.redirect('/fleet/reconcile');
  }
  const eq = db.prepare('SELECT id, asset_number, name FROM equipment WHERE id = ?').get(eqId);
  const fv = db.prepare('SELECT id, asset_id FROM vehicles WHERE id = ?').get(fleetId);
  if (!eq || !fv) {
    req.flash('error', 'Equipment or Fleet vehicle not found.');
    return res.redirect('/fleet/reconcile');
  }
  const keepActive = req.body.keep_active === '1';
  db.prepare(`
    UPDATE equipment SET fleet_vehicle_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(fv.id, keepActive ? 1 : 0, eq.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'equipment',
    entityId: eq.id,
    entityLabel: `${eq.asset_number || eq.name} → Fleet/${fv.asset_id}${keepActive ? ' (kept active)' : ' (deactivated)'}`,
    ip: req.ip,
  });
  req.flash('success', `Linked ${eq.asset_number || eq.name} to Fleet/${fv.asset_id}${keepActive ? '.' : ' and deactivated the equipment row.'}`);
  res.redirect('/fleet/reconcile');
});

// Mark an equipment row as a standalone (not in Fleet). No DB change —
// we just clear any stale link so the row stops appearing as a
// suggestion. The intent gets logged so future reviewers can see it
// was already considered.
router.post('/reconcile/:equipmentId/standalone', (req, res) => {
  const db = getDb();
  const eq = db.prepare('SELECT id, asset_number, name FROM equipment WHERE id = ?').get(req.params.equipmentId);
  if (!eq) { req.flash('error', 'Equipment not found.'); return res.redirect('/fleet/reconcile'); }
  db.prepare('UPDATE equipment SET fleet_vehicle_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eq.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'equipment',
    entityId: eq.id,
    entityLabel: `${eq.asset_number || eq.name} marked standalone (not in Fleet)`,
    ip: req.ip,
  });
  req.flash('success', `${eq.asset_number || eq.name} marked as standalone.`);
  res.redirect('/fleet/reconcile');
});

// Undo: clear the link + reactivate the equipment row. For when the
// operator linked the wrong row.
router.post('/reconcile/:equipmentId/unlink', (req, res) => {
  const db = getDb();
  const eq = db.prepare('SELECT id, asset_number, name, fleet_vehicle_id FROM equipment WHERE id = ?').get(req.params.equipmentId);
  if (!eq) { req.flash('error', 'Equipment not found.'); return res.redirect('/fleet/reconcile'); }
  db.prepare('UPDATE equipment SET fleet_vehicle_id = NULL, active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(eq.id);
  logActivity({
    user: req.session.user, action: 'update', entityType: 'equipment',
    entityId: eq.id,
    entityLabel: `${eq.asset_number || eq.name} unlinked from Fleet + reactivated`,
    ip: req.ip,
  });
  req.flash('success', `${eq.asset_number || eq.name} unlinked.`);
  res.redirect('/fleet/reconcile?show=all');
});

// ── COMPLIANCE ALERTS (page) ─────────────────────────────────────────
router.get('/compliance', (req, res) => {
  const db = getDb();
  const today = todayISO();
  const all = db.prepare("SELECT * FROM vehicle_summary WHERE status != 'Retired'").all();
  const flagged = all
    .map(v => ({ vehicle: v, b: badgesFor(v, today) }))
    .filter(({ b }) => Object.values(b).some(s => s.tone === 'bad' || s.tone === 'warn'))
    .sort((a, b) => {
      // bad-first, then by smallest daysUntil
      const min = x => Math.min(...Object.values(x).filter(s => s.daysUntil !== null).map(s => s.daysUntil));
      return min(a.b) - min(b.b);
    });

  res.render('fleet/compliance', {
    title: 'Fleet Compliance Alerts',
    currentPage: 'fleet',
    flagged,
    today,
  });
});

// ── NEW VEHICLE FORM ─────────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('fleet/form', {
    title: 'Add Vehicle',
    currentPage: 'fleet',
    vehicle: null,
    vehicleStatuses: VEHICLE_STATUSES,
    vehicleTypes: VEHICLE_TYPES,
  });
});

// ── CREATE VEHICLE ───────────────────────────────────────────────────
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  if (!b.asset_id || !b.asset_id.trim()) {
    req.flash('error', 'Asset ID is required.');
    return res.redirect('/fleet/new');
  }
  const status = VEHICLE_STATUSES.includes(b.status) ? b.status : 'Active';
  const vehicleType = VEHICLE_TYPES.includes(b.vehicle_type) ? b.vehicle_type : null;

  try {
    const result = db.prepare(`
      INSERT INTO vehicles (
        asset_id, fleet_id, rego, make, model, year, vin, vehicle_type, toll_tag, assigned_to, status,
        registration_expiry, ctp_expiry, insurance_renewal, inspection_due,
        next_service_date, next_service_km, fire_extinguisher_expiry, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.asset_id.trim(), orNull(b.fleet_id), orNull(b.rego), orNull(b.make), orNull(b.model),
      intOrNull(b.year), orNull(b.vin), vehicleType, orNull(b.toll_tag), orNull(b.assigned_to), status,
      orNull(b.registration_expiry), orNull(b.ctp_expiry), orNull(b.insurance_renewal), orNull(b.inspection_due),
      orNull(b.next_service_date), intOrNull(b.next_service_km), orNull(b.fire_extinguisher_expiry), orNull(b.notes)
    );
    logActivity({ user: req.session.user, action: 'create', entityType: 'vehicle', entityId: result.lastInsertRowid, entityLabel: b.asset_id, ip: req.ip });
    req.flash('success', `Vehicle ${b.asset_id} added.`);
    res.redirect(`/fleet/${result.lastInsertRowid}`);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      req.flash('error', `Asset ID "${b.asset_id}" is already in use.`);
    } else {
      req.flash('error', 'Could not save vehicle: ' + e.message);
    }
    res.redirect('/fleet/new');
  }
});

// ── VEHICLE DETAIL ───────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const db = getDb();
  const vehicle = db.prepare('SELECT * FROM vehicle_summary WHERE id = ?').get(req.params.id);
  if (!vehicle) { req.flash('error', 'Vehicle not found.'); return res.redirect('/fleet'); }
  const services = db.prepare(`
    SELECT * FROM service_records WHERE vehicle_id = ?
    ORDER BY COALESCE(service_date, '0000-00-00') DESC, id DESC
  `).all(vehicle.id);
  // Attach all invoice attachments (multiple per record, migration 302).
  const invStmt = db.prepare('SELECT id, file_name FROM service_record_invoices WHERE service_record_id = ? ORDER BY id');
  services.forEach(s => { s.invoices = invStmt.all(s.id); });

  const { incidents, equipmentChecks } = lookupRelatedReports(db, vehicle);
  const initialTab = ['overview','service','incidents','equipment'].includes(req.query.tab) ? req.query.tab : 'overview';

  res.render('fleet/detail', {
    title: `${vehicle.asset_id} — ${vehicle.make || ''} ${vehicle.model || ''}`.trim(),
    currentPage: 'fleet',
    vehicle,
    services,
    incidents,
    equipmentChecks,
    initialTab,
    serviceTypes: SERVICE_TYPES,
    badges: badgesFor(vehicle),
    today: todayISO(),
  });
});

// ── DOWNLOAD invoice file for a service record ───────────────────────
router.get('/:id/service/:sid/invoice', (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT invoice_file_path, invoice_file_name FROM service_records WHERE id = ? AND vehicle_id = ?').get(req.params.sid, req.params.id);
  if (!record || !record.invoice_file_path) { req.flash('error', 'Invoice file not found.'); return res.redirect('/fleet/' + req.params.id); }
  const abs = path.resolve(record.invoice_file_path);
  if (!abs.startsWith(path.resolve(INVOICE_UPLOAD_DIR))) { return res.status(403).send('Forbidden'); }
  if (!fs.existsSync(abs)) { req.flash('error', 'Invoice file missing on disk.'); return res.redirect('/fleet/' + req.params.id); }
  res.download(abs, record.invoice_file_name || path.basename(abs));
});

// ── DELETE invoice file (keep the service record) ────────────────────
router.post('/:id/service/:sid/invoice/delete', (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT id, invoice_file_path FROM service_records WHERE id = ? AND vehicle_id = ?').get(req.params.sid, req.params.id);
  if (record && record.invoice_file_path) {
    try { if (fs.existsSync(record.invoice_file_path)) fs.unlinkSync(record.invoice_file_path); } catch (e) { /* ignore */ }
    db.prepare('UPDATE service_records SET invoice_file_path = NULL, invoice_file_name = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.sid);
    logActivity({ user: req.session.user, action: 'update', entityType: 'service_record', entityId: req.params.sid, entityLabel: `Invoice removed from #${req.params.sid}`, ip: req.ip });
  }
  res.redirect('/fleet/' + req.params.id + '?tab=service');
});

// ── DOWNLOAD a specific invoice attachment (multiple per record) ─────
router.get('/:id/service/:sid/invoice/:invId', (req, res) => {
  const db = getDb();
  const inv = db.prepare(`
    SELECT sri.file_path, sri.file_name FROM service_record_invoices sri
    JOIN service_records sr ON sr.id = sri.service_record_id
    WHERE sri.id = ? AND sri.service_record_id = ? AND sr.vehicle_id = ?
  `).get(req.params.invId, req.params.sid, req.params.id);
  if (!inv || !inv.file_path) { req.flash('error', 'Invoice file not found.'); return res.redirect('/fleet/' + req.params.id); }
  const abs = path.resolve(inv.file_path);
  if (!abs.startsWith(path.resolve(INVOICE_UPLOAD_DIR))) { return res.status(403).send('Forbidden'); }
  if (!fs.existsSync(abs)) { req.flash('error', 'Invoice file missing on disk.'); return res.redirect('/fleet/' + req.params.id); }
  res.download(abs, inv.file_name || path.basename(abs));
});

// ── DELETE a specific invoice attachment (keep the service record) ───
router.post('/:id/service/:sid/invoice/:invId/delete', (req, res) => {
  const db = getDb();
  const inv = db.prepare(`
    SELECT sri.id, sri.file_path FROM service_record_invoices sri
    JOIN service_records sr ON sr.id = sri.service_record_id
    WHERE sri.id = ? AND sri.service_record_id = ? AND sr.vehicle_id = ?
  `).get(req.params.invId, req.params.sid, req.params.id);
  if (inv) {
    try { if (inv.file_path && fs.existsSync(inv.file_path)) fs.unlinkSync(inv.file_path); } catch (e) { /* ignore */ }
    db.prepare('DELETE FROM service_record_invoices WHERE id = ?').run(inv.id);
    logActivity({ user: req.session.user, action: 'update', entityType: 'service_record', entityId: req.params.sid, entityLabel: `Invoice removed from #${req.params.sid}`, ip: req.ip });
  }
  const back = req.get('Referer') || ('/fleet/' + req.params.id + '?tab=service');
  res.redirect(back);
});

// ── EDIT VEHICLE FORM ────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) { req.flash('error', 'Vehicle not found.'); return res.redirect('/fleet'); }
  res.render('fleet/form', {
    title: `Edit ${vehicle.asset_id}`,
    currentPage: 'fleet',
    vehicle,
    vehicleStatuses: VEHICLE_STATUSES,
    vehicleTypes: VEHICLE_TYPES,
  });
});

// ── UPDATE VEHICLE ───────────────────────────────────────────────────
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const existing = db.prepare('SELECT id, asset_id FROM vehicles WHERE id = ?').get(req.params.id);
  if (!existing) { req.flash('error', 'Vehicle not found.'); return res.redirect('/fleet'); }
  if (!b.asset_id || !b.asset_id.trim()) {
    req.flash('error', 'Asset ID is required.');
    return res.redirect(`/fleet/${req.params.id}/edit`);
  }
  const status = VEHICLE_STATUSES.includes(b.status) ? b.status : 'Active';
  const vehicleType = VEHICLE_TYPES.includes(b.vehicle_type) ? b.vehicle_type : null;

  try {
    db.prepare(`
      UPDATE vehicles SET
        asset_id=?, fleet_id=?, rego=?, make=?, model=?, year=?, vin=?, vehicle_type=?,
        toll_tag=?, assigned_to=?, status=?,
        registration_expiry=?, ctp_expiry=?, insurance_renewal=?, inspection_due=?,
        next_service_date=?, next_service_km=?, fire_extinguisher_expiry=?, notes=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.asset_id.trim(), orNull(b.fleet_id), orNull(b.rego), orNull(b.make), orNull(b.model),
      intOrNull(b.year), orNull(b.vin), vehicleType, orNull(b.toll_tag), orNull(b.assigned_to), status,
      orNull(b.registration_expiry), orNull(b.ctp_expiry), orNull(b.insurance_renewal), orNull(b.inspection_due),
      orNull(b.next_service_date), intOrNull(b.next_service_km), orNull(b.fire_extinguisher_expiry), orNull(b.notes),
      req.params.id
    );
    logActivity({ user: req.session.user, action: 'update', entityType: 'vehicle', entityId: req.params.id, entityLabel: b.asset_id, ip: req.ip });
    req.flash('success', `${b.asset_id} updated.`);
    res.redirect(`/fleet/${req.params.id}`);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      req.flash('error', `Asset ID "${b.asset_id}" is already in use.`);
    } else {
      req.flash('error', 'Could not update vehicle: ' + e.message);
    }
    res.redirect(`/fleet/${req.params.id}/edit`);
  }
});

// ── DELETE VEHICLE ───────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const vehicle = db.prepare('SELECT id, asset_id FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) { req.flash('error', 'Vehicle not found.'); return res.redirect('/fleet'); }
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id); // cascade removes service_records
  logActivity({ user: req.session.user, action: 'delete', entityType: 'vehicle', entityId: req.params.id, entityLabel: vehicle.asset_id, ip: req.ip });
  req.flash('success', `${vehicle.asset_id} removed.`);
  res.redirect('/fleet');
});

// ── NEW SERVICE RECORD FORM ──────────────────────────────────────────
router.get('/:id/service/new', (req, res) => {
  const db = getDb();
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) { req.flash('error', 'Vehicle not found.'); return res.redirect('/fleet'); }
  res.render('fleet/service-form', {
    title: `New Service Record — ${vehicle.asset_id}`,
    currentPage: 'fleet',
    vehicle,
    record: null,
    serviceTypes: SERVICE_TYPES,
  });
});

// ── CREATE SERVICE RECORD ────────────────────────────────────────────
router.post('/:id/service', invoiceUpload.array('invoice_file', 10), (req, res) => {
  const db = getDb();
  const vehicle = db.prepare('SELECT id, asset_id FROM vehicles WHERE id = ?').get(req.params.id);
  if (!vehicle) { req.flash('error', 'Vehicle not found.'); return res.redirect('/fleet'); }
  const b = req.body;
  const serviceType = SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'Other';
  const files = req.files || [];

  const result = db.prepare(`
    INSERT INTO service_records (vehicle_id, service_date, odometer_km, work_performed, service_type, performed_by, cost, invoice_number, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    vehicle.id, orNull(b.service_date), intOrNull(b.odometer_km),
    orNull(b.work_performed), serviceType, orNull(b.performed_by),
    numOrNull(b.cost), orNull(b.invoice_number), orNull(b.notes)
  );
  // Store every uploaded invoice as its own attachment row.
  const insInv = db.prepare('INSERT INTO service_record_invoices (service_record_id, file_path, file_name) VALUES (?, ?, ?)');
  files.forEach(f => insInv.run(result.lastInsertRowid, f.path, f.originalname));
  logActivity({
    user: req.session.user, action: 'create', entityType: 'service_record',
    entityId: result.lastInsertRowid,
    entityLabel: `${vehicle.asset_id} — ${b.service_date || 'no date'} — ${serviceType}`,
    ip: req.ip,
  });
  req.flash('success', 'Service record added.');
  res.redirect(`/fleet/${vehicle.id}?tab=service`);
});

// ── EDIT SERVICE RECORD FORM ─────────────────────────────────────────
router.get('/:id/service/:sid/edit', (req, res) => {
  const db = getDb();
  const vehicle = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id);
  const record  = db.prepare('SELECT * FROM service_records WHERE id = ? AND vehicle_id = ?').get(req.params.sid, req.params.id);
  if (!vehicle || !record) { req.flash('error', 'Service record not found.'); return res.redirect('/fleet'); }
  record.invoices = db.prepare('SELECT id, file_name FROM service_record_invoices WHERE service_record_id = ? ORDER BY id').all(record.id);
  res.render('fleet/service-form', {
    title: `Edit Service Record — ${vehicle.asset_id}`,
    currentPage: 'fleet',
    vehicle,
    record,
    serviceTypes: SERVICE_TYPES,
  });
});

// ── UPDATE SERVICE RECORD ────────────────────────────────────────────
router.post('/:id/service/:sid', invoiceUpload.array('invoice_file', 10), (req, res) => {
  const db = getDb();
  const record = db.prepare('SELECT id FROM service_records WHERE id = ? AND vehicle_id = ?').get(req.params.sid, req.params.id);
  if (!record) { req.flash('error', 'Service record not found.'); return res.redirect(`/fleet/${req.params.id}`); }
  const b = req.body;
  const serviceType = SERVICE_TYPES.includes(b.service_type) ? b.service_type : 'Other';
  const files = req.files || [];

  db.prepare(`
    UPDATE service_records SET service_date=?, odometer_km=?, work_performed=?, service_type=?, performed_by=?, cost=?, invoice_number=?, notes=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(
    orNull(b.service_date), intOrNull(b.odometer_km), orNull(b.work_performed),
    serviceType, orNull(b.performed_by), numOrNull(b.cost),
    orNull(b.invoice_number), orNull(b.notes),
    req.params.sid
  );
  // Newly-dropped invoices are ADDED (existing ones are kept; remove via the
  // per-attachment delete link).
  const insInv = db.prepare('INSERT INTO service_record_invoices (service_record_id, file_path, file_name) VALUES (?, ?, ?)');
  files.forEach(f => insInv.run(req.params.sid, f.path, f.originalname));
  logActivity({ user: req.session.user, action: 'update', entityType: 'service_record', entityId: req.params.sid, entityLabel: `Service record #${req.params.sid}`, ip: req.ip });
  req.flash('success', 'Service record updated.');
  res.redirect(`/fleet/${req.params.id}?tab=service`);
});

// ── DELETE SERVICE RECORD ────────────────────────────────────────────
router.post('/:id/service/:sid/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM service_records WHERE id = ? AND vehicle_id = ?').run(req.params.sid, req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'service_record', entityId: req.params.sid, entityLabel: `Service record #${req.params.sid}`, ip: req.ip });
  req.flash('success', 'Service record removed.');
  res.redirect(`/fleet/${req.params.id}`);
});

module.exports = router;
