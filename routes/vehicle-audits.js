// Vehicle Audits (Safety) — monthly yard/site roadworthiness audits against
// the EXISTING fleet register (vehicles table). The vehicle picker, every FK
// and the post-submit redirect all key off vehicles.id; the checklist is
// selected by vehicles.traffic_class ('common' template rows apply to all).
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// ── Item photo uploads ───────────────────────────────────────────────
// Stored under data/uploads/vehicle-audits/ which server.js already
// serves statically at /data/uploads — no extra download route needed.
const PHOTO_DIR = path.join(__dirname, '..', 'data', 'uploads', 'vehicle-audits');
const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => { fs.mkdirSync(PHOTO_DIR, { recursive: true }); cb(null, PHOTO_DIR); },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg').toLowerCase();
    cb(null, Date.now() + '-' + Math.random().toString(36).substring(2, 8) + ext);
  },
});
const PHOTO_ALLOWED = /\.(png|jpg|jpeg|gif|webp|heic)$/i;
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 10 * 1024 * 1024, files: 40 },
  fileFilter: (req, file, cb) => cb(null, PHOTO_ALLOWED.test(file.originalname || '')),
});

const TYPE_LABELS = { common: 'All types', ute: 'Traffic Ute', vms: 'VMS Ute', pod: 'Pod Truck', tma: 'TMA', truck: 'Truck' };
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const plusDaysISO = (days) => {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Australia/Sydney' }));
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
};

// Checklist for one traffic class: common rows first, then type rows.
function templatesFor(db, trafficClass) {
  return db.prepare(`
    SELECT id, vehicle_type, section, item_label, is_critical
    FROM vehicle_checklist_templates
    WHERE active = 1 AND (vehicle_type = 'common' OR vehicle_type = ?)
    ORDER BY CASE WHEN vehicle_type = 'common' THEN 0 ELSE 1 END, sort_order, id
  `).all(trafficClass || '');
}

function groupBySection(items) {
  const sections = [];
  const byName = new Map();
  for (const it of items) {
    if (!byName.has(it.section)) { const s = { section: it.section, items: [] }; byName.set(it.section, s); sections.push(s); }
    byName.get(it.section).items.push(it);
  }
  return sections;
}

const vehicleListStmt = (db) => db.prepare(`
  SELECT id, asset_id, rego, make, model, status, traffic_class
  FROM vehicles WHERE status != 'Retired'
  ORDER BY asset_id
`).all();

// Roster for the "Fault of…" pickers — one entry per person. crew_members
// carries duplicate rows for some people (test accounts + re-imports), which
// made the picker list the same name many times; collapse to the canonical
// (lowest-id) active row per name.
const crewListStmt = (db) => db.prepare(`
  SELECT id, full_name FROM crew_members
  WHERE (status = 'active' OR status IS NULL) AND merged_into_id IS NULL
    AND id IN (
      SELECT MIN(id) FROM crew_members
      WHERE (status = 'active' OR status IS NULL) AND merged_into_id IS NULL
      GROUP BY full_name
    )
  ORDER BY full_name
`).all();

// Open-defect count shown as a badge on the module sub-nav (every page).
const openDefectCount = (db) => db.prepare(
  "SELECT COUNT(*) AS n FROM vehicle_defects WHERE status != 'fixed'"
).get().n;

// ── DASHBOARD — all vehicles + last-audit meta + summary cards ──────
router.get('/', (req, res) => {
  const db = getDb();
  const vehicles = db.prepare(`
    SELECT v.id, v.asset_id, v.rego, v.make, v.model, v.status, v.traffic_class,
      la.id AS last_audit_id, la.audit_date AS last_audit_date,
      la.overall_result AS last_audit_result, la.audit_type AS last_audit_type,
      CAST(julianday(date('now','localtime')) - julianday(la.audit_date) AS INTEGER) AS days_since,
      (SELECT COUNT(*) FROM vehicle_defects d WHERE d.vehicle_id = v.id AND d.status != 'fixed') AS open_defects
    FROM vehicles v
    LEFT JOIN vehicle_audits la ON la.id = (
      SELECT id FROM vehicle_audits WHERE vehicle_id = v.id
      ORDER BY audit_date DESC, id DESC LIMIT 1
    )
    WHERE v.status != 'Retired'
    ORDER BY v.asset_id
  `).all();

  const cards = {
    totalVehicles: vehicles.length,
    auditedThisMonth: db.prepare(`
      SELECT COUNT(DISTINCT vehicle_id) AS n FROM vehicle_audits
      WHERE strftime('%Y-%m', audit_date) = strftime('%Y-%m', date('now','localtime'))
    `).get().n,
    offRoad: db.prepare("SELECT COUNT(*) AS n FROM vehicles WHERE status = 'Off-Road'").get().n,
    openDefects: db.prepare("SELECT COUNT(*) AS n FROM vehicle_defects WHERE status != 'fixed'").get().n,
    openDefectCost: db.prepare("SELECT COALESCE(SUM(cost_estimate), 0) AS c FROM vehicle_defects WHERE status != 'fixed'").get().c,
  };

  res.render('vehicle-audits/index', {
    title: 'Vehicle Audits',
    currentPage: 'vehicle-audits',
    vehicles, cards,
    typeLabels: TYPE_LABELS,
    vaOpen: cards.openDefects,
    user: req.session.user,
  });
});

// ── START AUDIT — pick a vehicle, auto-load its type's checklist ─────
router.get('/new', (req, res) => {
  const db = getDb();
  const vehicles = vehicleListStmt(db);
  let vehicle = null, sections = [];
  const vid = parseInt(req.query.vehicle_id, 10);
  if (Number.isFinite(vid)) {
    vehicle = db.prepare('SELECT id, asset_id, rego, make, model, status, traffic_class FROM vehicles WHERE id = ?').get(vid);
    if (vehicle) sections = groupBySection(templatesFor(db, vehicle.traffic_class));
  }
  res.render('vehicle-audits/new', {
    title: 'Start Vehicle Audit',
    currentPage: 'vehicle-audits',
    vehicles, vehicle, sections,
    crew: crewListStmt(db),          // "Fault of…" picker on failed items
    typeLabels: TYPE_LABELS,
    vaOpen: openDefectCount(db),
    today: todayISO(),
    user: req.session.user,
  });
});

// ── SUBMIT — save audit + items, auto-create defects, redirect to the
//    vehicle's EXISTING profile (/fleet/:id?tab=audits) ───────────────
router.post('/', photoUpload.any(), (req, res) => {
  const db = getDb();
  const b = req.body;
  const vid = parseInt(b.vehicle_id, 10);
  const vehicle = Number.isFinite(vid) ? db.prepare('SELECT id, asset_id, traffic_class FROM vehicles WHERE id = ?').get(vid) : null;
  if (!vehicle) { req.flash('error', 'Pick a vehicle from the fleet list.'); return res.redirect('/vehicle-audits/new'); }

  const templates = templatesFor(db, vehicle.traffic_class);
  if (!templates.length) { req.flash('error', 'No checklist templates found for this vehicle type.'); return res.redirect('/vehicle-audits/new?vehicle_id=' + vehicle.id); }

  // Photos arrive as photo_<templateId> file fields.
  const photoByTpl = {};
  for (const f of (req.files || [])) {
    const m = /^photo_(\d+)$/.exec(f.fieldname);
    if (m) photoByTpl[m[1]] = 'data/uploads/vehicle-audits/' + f.filename;
  }

  // Validate any "fault of" picks against real crew ids once, up front.
  const crewIds = new Set(db.prepare('SELECT id FROM crew_members').all().map(c => c.id));
  const results = templates.map(t => {
    const raw = String(b['result_' + t.id] || 'na');
    const result = ['pass', 'fail', 'na'].includes(raw) ? raw : 'na';
    const faultRaw = parseInt(b['fault_' + t.id], 10);
    return {
      tpl: t, result,
      comment: String(b['comment_' + t.id] || '').trim(),
      photo: photoByTpl[String(t.id)] || null,
      // Optional per-item fault allocation — the auditor can pin a failed
      // item on a driver right in the audit, or leave it for later.
      fault: Number.isFinite(faultRaw) && crewIds.has(faultRaw) ? faultRaw : null,
    };
  });
  const criticalFail = results.some(r => r.tpl.is_critical && r.result === 'fail');
  const overall = criticalFail ? 'fail' : 'pass';
  const auditDate = /^\d{4}-\d{2}-\d{2}$/.test(b.audit_date || '') ? b.audit_date : todayISO();

  const tx = db.transaction(() => {
    const auditId = db.prepare(`
      INSERT INTO vehicle_audits (vehicle_id, auditor, audit_type, audit_date, location, overall_result, notes, signed_by, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vehicle.id,
      String(b.auditor || (req.session.user && req.session.user.full_name) || '').trim(),
      b.audit_type === 'site' ? 'site' : 'yard',
      auditDate,
      String(b.location || '').trim(),
      overall,
      String(b.notes || '').trim(),
      String(b.signed_by || '').trim(),
      req.session.user ? req.session.user.id : null
    ).lastInsertRowid;

    const insItem = db.prepare(`
      INSERT INTO vehicle_audit_items (audit_id, template_item_id, section, item_label, is_critical, result, comment, photo_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insDefect = db.prepare(`
      INSERT INTO vehicle_defects (audit_id, vehicle_id, item_label, severity, assigned_to, status, due_date, notes)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
    `);
    let defects = 0;
    for (const r of results) {
      insItem.run(auditId, r.tpl.id, r.tpl.section, r.tpl.item_label, r.tpl.is_critical, r.result, r.comment, r.photo);
      if (r.result === 'fail') {
        // Failed items are chased to be fixed that week — default due +7 days.
        // Fault (assigned_to) lands straight on the defect when picked in-audit.
        insDefect.run(auditId, vehicle.id, r.tpl.item_label, r.tpl.is_critical ? 'critical' : 'major', r.fault, plusDaysISO(7), r.comment);
        defects += 1;
      }
    }

    // Critical fail + auditor confirmed → vehicle off the road.
    if (criticalFail && b.set_off_road === '1') {
      db.prepare("UPDATE vehicles SET status = 'Off-Road', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(vehicle.id);
    }
    return { auditId, defects };
  });

  const { auditId, defects } = tx();
  logActivity({
    user: req.session.user, action: 'create', entityType: 'vehicle_audit', entityId: auditId,
    entityLabel: `${vehicle.asset_id} — ${overall.toUpperCase()}${defects ? ` (${defects} defect${defects === 1 ? '' : 's'})` : ''}`,
    ip: req.ip,
  });

  req.flash('success',
    overall === 'pass'
      ? `Audit saved — ${vehicle.asset_id} passed${defects ? ` with ${defects} defect${defects === 1 ? '' : 's'} logged` : ''}.`
      : `Audit saved — ${vehicle.asset_id} FAILED. ${defects} defect${defects === 1 ? '' : 's'} logged${b.set_off_road === '1' ? ' and vehicle set Off-Road' : ''}.`);
  // Smooth landing on the vehicle's existing profile, Audits tab.
  res.redirect('/fleet/' + vehicle.id + '?tab=audits');
});

// ── DEFECTS — open register, filter by vehicle / worker / status ─────
router.get('/defects', (req, res) => {
  const db = getDb();
  const f = {
    vehicle: parseInt(req.query.vehicle, 10) || '',
    worker: parseInt(req.query.worker, 10) || '',
    status: ['open', 'chasing', 'fixed'].includes(req.query.status) ? req.query.status : '',
    sort: ['due', 'cost'].includes(req.query.sort) ? req.query.sort : 'due',
  };
  let where = '1=1';
  const params = [];
  if (f.vehicle) { where += ' AND d.vehicle_id = ?'; params.push(f.vehicle); }
  if (f.worker) { where += ' AND d.assigned_to = ?'; params.push(f.worker); }
  if (f.status) { where += ' AND d.status = ?'; params.push(f.status); }
  else { where += " AND d.status != 'fixed'"; } // default view = still being chased
  const orderBy = f.sort === 'cost'
    ? 'COALESCE(d.cost_estimate, 0) DESC, d.due_date'
    : "COALESCE(d.due_date, '9999-12-31'), d.id";

  const defects = db.prepare(`
    SELECT d.*, v.asset_id, v.rego, cm.full_name AS worker_name
    FROM vehicle_defects d
    JOIN vehicles v ON v.id = d.vehicle_id
    LEFT JOIN crew_members cm ON cm.id = d.assigned_to
    WHERE ${where}
    ORDER BY ${orderBy}
  `).all(...params);

  // Register-wide pulse for the chips row (unfiltered, so the numbers
  // stay meaningful while drilling into a single vehicle/worker).
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'open'    THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'chasing' THEN 1 ELSE 0 END) AS chasing,
      SUM(CASE WHEN status = 'fixed'   THEN 1 ELSE 0 END) AS fixed,
      COALESCE(SUM(CASE WHEN status != 'fixed' THEN cost_estimate ELSE 0 END), 0) AS openCost,
      SUM(CASE WHEN status != 'fixed' AND due_date IS NOT NULL AND due_date < date('now','localtime') THEN 1 ELSE 0 END) AS overdue
    FROM vehicle_defects
  `).get();

  res.render('vehicle-audits/defects', {
    title: 'Vehicle Defects',
    currentPage: 'vehicle-audits',
    defects, f, stats,
    vehicles: vehicleListStmt(db),
    crew: crewListStmt(db),
    vaOpen: (stats.open || 0) + (stats.chasing || 0),
    today: todayISO(),
    user: req.session.user,
  });
});

// Quick inline update from the defects register.
router.post('/defects/:id(\\d+)', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM vehicle_defects WHERE id = ?').get(req.params.id);
  if (!d) { req.flash('error', 'Defect not found.'); return res.redirect('/vehicle-audits/defects'); }
  const b = req.body;
  const status = ['open', 'chasing', 'fixed'].includes(b.status) ? b.status : d.status;
  const severity = ['critical', 'major', 'minor'].includes(b.severity) ? b.severity : d.severity;
  const assigned = b.assigned_to === '' ? null : (parseInt(b.assigned_to, 10) || d.assigned_to);
  const due = /^\d{4}-\d{2}-\d{2}$/.test(b.due_date || '') ? b.due_date : null;
  const cost = b.cost_estimate === '' ? null : (Number.isFinite(parseFloat(b.cost_estimate)) ? parseFloat(b.cost_estimate) : d.cost_estimate);
  const resolved = status === 'fixed' ? (d.resolved_date || todayISO()) : null;
  db.prepare(`
    UPDATE vehicle_defects SET status = ?, severity = ?, assigned_to = ?, due_date = ?, cost_estimate = ?, resolved_date = ?
    WHERE id = ?
  `).run(status, severity, assigned, due, cost, resolved, req.params.id);
  req.flash('success', 'Defect updated.');
  res.redirect(req.get('Referrer') || '/vehicle-audits/defects');
});

// ── ACCOUNTABILITY — defects grouped by responsible worker + cost ────
router.get('/accountability', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT d.*, v.asset_id, cm.full_name AS worker_name
    FROM vehicle_defects d
    JOIN vehicles v ON v.id = d.vehicle_id
    LEFT JOIN crew_members cm ON cm.id = d.assigned_to
    ORDER BY cm.full_name IS NULL, cm.full_name, d.created_at DESC
  `).all();
  const groups = [];
  const byKey = new Map();
  for (const d of rows) {
    const key = d.assigned_to || 0;
    if (!byKey.has(key)) {
      const g = { worker: d.worker_name || 'Unassigned', workerId: d.assigned_to, defects: [], totalCost: 0, open: 0 };
      byKey.set(key, g); groups.push(g);
    }
    const g = byKey.get(key);
    g.defects.push(d);
    g.totalCost += d.cost_estimate || 0;
    if (d.status !== 'fixed') { g.open += 1; g.openCost = (g.openCost || 0) + (d.cost_estimate || 0); }
  }
  // Named workers first (sorted by cost owed), Unassigned bucket last.
  groups.sort((a, b) => (a.workerId ? 0 : 1) - (b.workerId ? 0 : 1) || b.totalCost - a.totalCost);

  res.render('vehicle-audits/accountability', {
    title: 'Defect Accountability',
    currentPage: 'vehicle-audits',
    groups,
    vaOpen: openDefectCount(db),
    user: req.session.user,
  });
});

// ── FULL AUDIT RECORD ────────────────────────────────────────────────
router.get('/:id(\\d+)', (req, res) => {
  const db = getDb();
  const audit = db.prepare(`
    SELECT a.*, v.asset_id, v.rego, v.make, v.model, v.traffic_class, v.status AS vehicle_status
    FROM vehicle_audits a JOIN vehicles v ON v.id = a.vehicle_id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/vehicle-audits'); }
  const items = db.prepare('SELECT * FROM vehicle_audit_items WHERE audit_id = ? ORDER BY id').all(audit.id);
  const defects = db.prepare(`
    SELECT d.*, cm.full_name AS worker_name FROM vehicle_defects d
    LEFT JOIN crew_members cm ON cm.id = d.assigned_to
    WHERE d.audit_id = ? ORDER BY d.id
  `).all(audit.id);

  res.render('vehicle-audits/show', {
    title: `Audit — ${audit.asset_id} (${audit.audit_date})`,
    currentPage: 'vehicle-audits',
    audit,
    sections: groupBySection(items),
    defects,
    crew: crewListStmt(db),          // fault can be (re)allocated on past audits
    typeLabels: TYPE_LABELS,
    vaOpen: openDefectCount(db),
    today: todayISO(),
    user: req.session.user,
  });
});

// ── DELETE a past audit — removes the audit, its checklist items and the
//    defects it raised (items cascade via FK; defects deleted explicitly so
//    an audit's whole footprint goes with it). Vehicle status is left as-is.
router.post('/:id(\\d+)/delete', (req, res) => {
  const db = getDb();
  const audit = db.prepare('SELECT a.id, a.vehicle_id, v.asset_id, v.status AS vehicle_status FROM vehicle_audits a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.id = ?').get(req.params.id);
  if (!audit) { req.flash('error', 'Audit not found.'); return res.redirect('/vehicle-audits'); }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM vehicle_defects WHERE audit_id = ?').run(audit.id);
    db.prepare('DELETE FROM vehicle_audit_items WHERE audit_id = ?').run(audit.id); // also cascades, belt-and-braces
    db.prepare('DELETE FROM vehicle_audits WHERE id = ?').run(audit.id);
  });
  tx();

  logActivity({
    user: req.session.user, action: 'delete', entityType: 'vehicle_audit', entityId: audit.id,
    entityLabel: `${audit.asset_id} audit #${audit.id}`, ip: req.ip,
  });
  req.flash('success', `Audit #${audit.id} deleted.`);
  // If the delete was launched from the vehicle profile, go back there.
  const ref = req.get('Referrer') || '';
  if (/\/fleet\/\d+/.test(ref)) return res.redirect('/fleet/' + audit.vehicle_id + '?tab=audits');
  res.redirect('/vehicle-audits');
});

module.exports = router;
