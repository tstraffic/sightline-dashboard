const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { requireRole } = require('../middleware/auth');

// Multer config for booking document uploads
const BOOKING_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'bookings');
const bookingStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(BOOKING_UPLOAD_DIR, 'booking_' + req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.random().toString(36).substring(7) + ext);
  }
});
const ALLOWED_FILE_TYPES = /\.(pdf|doc|docx|xls|xlsx|png|jpg|jpeg|gif|csv|txt|zip)$/i;
const fileFilter = (req, file, cb) => {
  if (ALLOWED_FILE_TYPES.test(file.originalname)) cb(null, true);
  else cb(new Error('File type not allowed. Accepted: PDF, DOC, XLS, images, CSV, TXT, ZIP'), false);
};
const uploadDoc = multer({ storage: bookingStorage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter });

// Depot names — pulled from the depots table (migration 257). Wrapped
// in a function so an edit on /fleet/depots takes effect on the next
// request without restarting the server. Falls back to the original
// four-name list if the table doesn't exist yet (legacy DB).
function getDepots() {
  try {
    const rows = getDb().prepare("SELECT name FROM depots WHERE active = 1 ORDER BY sort_order, name").all();
    if (rows.length) return rows.map(r => r.name);
  } catch (e) { /* table not migrated yet */ }
  return ['Villawood', 'Penrith', 'Campbelltown', 'Parramatta'];
}
const VALID_STATUSES = ['client_booking', 'unconfirmed', 'confirmed', 'locked', 'conflict', 'green_to_go', 'in_progress', 'complete', 'finalised', 'cancelled', 'late_cancellation', 'on_hold'];

// (Beta flag retired — the day board is now /bookings for everyone.)

// Auto-vehicle sync — every "Nx TC Crew" booking_requirement row carries
// 1 ute. After requirements are saved we make sure booking_vehicles has
// at least that many ute-role rows (placeholder rows the allocator can
// assign from the fleet register). Existing utes the office added by
// hand are kept; we only top up the difference. Never deletes rows the
// allocator assigned a driver to.
function syncTCCrewVehicles(db, bookingId) {
  try {
    const reqs = db.prepare("SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id = ?").all(bookingId);
    let target = 0;
    for (const r of reqs) {
      // Match "Nx TC Crew" — 1 ute per package, multiplied by qty.
      const m = /^(\d+)x TC Crew$/.exec(r.resource_type || '');
      if (m) target += (parseInt(r.quantity_required) || 0); // 1 ute per package, ignore N
    }
    if (target <= 0) return;
    const existing = db.prepare("SELECT COUNT(*) AS c FROM booking_vehicles WHERE booking_id = ? AND vehicle_role = 'ute'").get(bookingId).c;
    const missing = target - existing;
    if (missing <= 0) return;
    const ins = db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, vehicle_role) VALUES (?, '', '', 'ute')");
    for (let i = 0; i < missing; i++) ins.run(bookingId);
  } catch (e) {
    console.error('[syncTCCrewVehicles]', e.message);
  }
}

function generateBookingNumber(db) {
  // Find the highest BK-NNNN already used. Other booking_number
  // formats (e.g. "TRF-B-12345" from the Traffio sync) have their own
  // namespace and are ignored. The previous version of this function
  // looked at the booking_number of the row with the highest `id` and
  // incremented — fine until a Traffio import landed last, at which
  // point parseInt("TRF-B-12345".replace("BK-","")) → NaN, the fallback
  // returned "BK-0001", and we hit a UNIQUE constraint failure.
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(booking_number, 4) AS INTEGER)) AS maxNum
    FROM bookings
    WHERE booking_number LIKE 'BK-%'
      AND SUBSTR(booking_number, 4) GLOB '[0-9]*'
  `).get();
  let next = (row && Number.isFinite(row.maxNum) ? row.maxNum : 0) + 1;
  // Self-heal: if the candidate is somehow still taken (race, corrupt
  // numbering, manual SQL fiddling), step forward until we find a free
  // slot. Bounded to keep accidental gaps from running away.
  const check = db.prepare("SELECT 1 AS x FROM bookings WHERE booking_number = ?");
  for (let i = 0; i < 10000; i++) {
    const candidate = 'BK-' + String(next).padStart(4, '0');
    if (!check.get(candidate)) return candidate;
    next++;
  }
  throw new Error('No free booking number after 10000 attempts');
}

function transformBooking(db, row) {
  const today = new Date().toISOString().split('T')[0];
  const crew = db.prepare(`
    SELECT bc.id, bc.crew_member_id, bc.role_on_site, bc.status, cm.full_name,
      cm.tc_ticket_expiry, cm.white_card_expiry, cm.licence_expiry, cm.tcp_level,
      cm.role as crew_role, cm.licence_type
    FROM booking_crew bc LEFT JOIN crew_members cm ON cm.id = bc.crew_member_id
    WHERE bc.booking_id = ?
  `).all(row.id);
  const vehicles = db.prepare("SELECT id, vehicle_name, registration, vehicle_role, crew_member_id FROM booking_vehicles WHERE booking_id = ?").all(row.id);
  const noteCount = db.prepare("SELECT COUNT(*) as c FROM booking_notes WHERE booking_id = ?").get(row.id).c;

  let supervisorName = '';
  if (row.supervisor_id) {
    const sup = db.prepare("SELECT full_name FROM crew_members WHERE id = ?").get(row.supervisor_id);
    if (sup) supervisorName = sup.full_name;
  }

  let projectName = row.title || '', clientName = '', projectAddress = row.site_address || '';
  if (row.job_id) {
    const job = db.prepare("SELECT job_name, client, site_address FROM jobs WHERE id = ?").get(row.job_id);
    if (job) { projectName = projectName || job.job_name; clientName = job.client || ''; projectAddress = projectAddress || job.site_address || ''; }
  }
  if (row.client_id) {
    try { const client = db.prepare("SELECT company_name FROM clients WHERE id = ?").get(row.client_id); if (client) clientName = client.company_name; } catch (e) {}
  }

  let scheduleWarning = null;
  for (const c of crew) {
    const conflict = db.prepare(`
      SELECT b.booking_number FROM booking_crew bc2 JOIN bookings b ON b.id = bc2.booking_id
      WHERE bc2.crew_member_id = ? AND bc2.booking_id != ? AND b.status NOT IN ('cancelled','complete','late_cancellation')
        AND b.start_datetime < ? AND b.end_datetime > ? LIMIT 1
    `).get(c.crew_member_id, row.id, row.end_datetime, row.start_datetime);
    if (conflict) { scheduleWarning = c.full_name + ' also on ' + conflict.booking_number; break; }
  }

  return {
    id: row.id, booking_number: row.booking_number, status: row.status,
    startDateTime: row.start_datetime, endDateTime: row.end_datetime,
    depot: row.depot || '', supervisor: supervisorName,
    project: { name: projectName, client: clientName, address: projectAddress, orderNumber: row.order_number || '', billingCode: row.billing_code || '' },
    personnel: crew.map(c => {
      const warnings = [];
      if (c.tc_ticket_expiry && c.tc_ticket_expiry < today) warnings.push('TC ticket expired');
      if (c.white_card_expiry && c.white_card_expiry < today) warnings.push('White card expired');
      if (c.licence_expiry && c.licence_expiry < today) warnings.push('Licence expired');
      if ((c.role_on_site === 'traffic_controller' || c.role_on_site === 'TC') && !c.tc_ticket_expiry) warnings.push('No TC ticket');
      return { id: c.crew_member_id, name: c.full_name || 'Unknown', role: c.role_on_site || '', confirmed: c.status === 'confirmed', tcpLevel: c.tcp_level || '', warnings };
    }),
    vehicles: vehicles.map(v => ({ id: v.id, registration: v.registration || '', name: v.vehicle_name || '' })),
    scheduleWarning,
    dockets: db.prepare("SELECT COUNT(*) as c FROM booking_dockets WHERE booking_id = ?").get(row.id).c,
    notes: noteCount, tasks: 0,
    docs: (() => { try { return db.prepare("SELECT COUNT(*) as c FROM booking_documents WHERE booking_id = ?").get(row.id).c; } catch(e) { return 0; } })(),
    bookingNumber: row.booking_number || '', suburb: row.suburb || '', deletedAt: row.deleted_at || null,
    latitude: row.latitude || null, longitude: row.longitude || null,
    stillRequired: (() => {
      try {
        const reqs = db.prepare("SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id = ?").all(row.id);
        const unfilled = [];
        const totalCrewCount = crew.length;
        for (const r of reqs) {
          const resType = r.resource_type.toLowerCase().replace(/_/g, ' ');
          // TC Crew requirements count all assigned crew
          const assignedCount = (resType.includes('tc crew') || resType.includes('traffic controller') || resType.includes('hoist') || resType.includes('ip'))
            ? totalCrewCount
            : crew.filter(c => {
                const role = (c.role_on_site || c.crew_role || '').toLowerCase().replace(/_/g, ' ');
                return role.includes(resType);
              }).length;
          const remaining = r.quantity_required - assignedCount;
          if (remaining > 0) {
            const label = r.resource_type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            unfilled.push(remaining > 1 ? `${remaining}x ${label}` : label);
          }
        }
        return unfilled;
      } catch(e) { return []; }
    })(),
  };
}

function loadBookingDetail(db, bookingId) {
  const row = db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId);
  if (!row) return null;
  const crew = db.prepare(`SELECT bc.*, cm.full_name, cm.phone, cm.email, cm.role as crew_role, cm.employee_id FROM booking_crew bc LEFT JOIN crew_members cm ON cm.id = bc.crew_member_id WHERE bc.booking_id = ? ORDER BY bc.created_at`).all(bookingId);
  const notes = db.prepare(`SELECT bn.*, u.full_name as author_name FROM booking_notes bn LEFT JOIN users u ON u.id = bn.user_id WHERE bn.booking_id = ? ORDER BY bn.created_at DESC`).all(bookingId);
  // Left-join the new Fleet register so every booking_vehicles row carries
  // its source asset (if any) for the back-link + "Fleet" badge on the
  // detail page. The legacy text-only / equipment-derived rows still work
  // — they just have NULL fleet fields.
  const vehicles = db.prepare(`
    SELECT bv.*, fv.asset_id AS fleet_asset_id, fv.rego AS fleet_rego, fv.status AS fleet_status
    FROM booking_vehicles bv
    LEFT JOIN vehicles fv ON fv.id = bv.fleet_vehicle_id
    WHERE bv.booking_id = ?
    ORDER BY bv.created_at
  `).all(bookingId);
  let supervisorName = '';
  if (row.supervisor_id) { const sup = db.prepare("SELECT full_name FROM crew_members WHERE id = ?").get(row.supervisor_id); if (sup) supervisorName = sup.full_name; }
  let jobInfo = row.job_id ? db.prepare("SELECT id, job_number, job_name, client, site_address, suburb, status FROM jobs WHERE id = ?").get(row.job_id) : null;
  let clientInfo = null;
  if (row.client_id) { try { clientInfo = db.prepare("SELECT id, company_name, primary_contact_name, primary_contact_phone, primary_contact_email FROM clients WHERE id = ?").get(row.client_id); } catch (e) {} }
  const dockets = db.prepare("SELECT * FROM booking_dockets WHERE booking_id = ? ORDER BY created_at DESC").all(bookingId);
  let documents = [];
  try { documents = db.prepare("SELECT bd.*, u.full_name as uploader_name FROM booking_documents bd LEFT JOIN users u ON u.id = bd.uploaded_by_id WHERE bd.booking_id = ? ORDER BY bd.created_at DESC").all(bookingId); } catch(e) {}
  const activity = db.prepare("SELECT al.*, u.full_name as user_name FROM activity_log al LEFT JOIN users u ON u.id = al.user_id WHERE al.entity_type = 'booking' AND al.entity_id = ? ORDER BY al.created_at DESC LIMIT 30").all(bookingId);
  let requirements = [];
  try { requirements = db.prepare("SELECT * FROM booking_requirements WHERE booking_id = ? ORDER BY resource_type").all(bookingId); } catch(e) {}
  let equipmentList = [];
  try { equipmentList = db.prepare("SELECT be.*, e.name as asset_name, e.category as eq_category FROM booking_equipment be LEFT JOIN equipment e ON e.id = be.equipment_id WHERE be.booking_id = ? ORDER BY be.created_at").all(bookingId); } catch(e) {}

  // Compute requirement fulfilment. Defensive: a single bad row (null
  // resource_type, weird quantity) must NOT crash the whole response —
  // that's how the slide-over was getting stuck on "Loading…".
  const totalCrewAssigned = crew.length;
  try {
    requirements.forEach(r => {
      const resType = String(r.resource_type || '').toLowerCase().replace(/_/g, ' ');
      if (!resType) { r.quantity_assigned = 0; r.status = 'unfulfilled'; return; }
      if (resType.includes('tc crew') || resType.includes('traffic controller') || resType.includes('hoist') || resType.includes('ip')) {
        r.quantity_assigned = totalCrewAssigned;
      } else {
        const assigned = crew.filter(c => {
          const role = String(c.role_on_site || c.crew_role || '').toLowerCase().replace(/_/g, ' ');
          return role && role.includes(resType);
        }).length;
        r.quantity_assigned = assigned;
      }
      r.status = r.quantity_assigned >= r.quantity_required ? 'fulfilled' : r.quantity_assigned > 0 ? 'partial' : 'unfulfilled';
    });
  } catch (e) {
    console.error('[loadBookingDetail] requirement-fulfilment failed:', e.message);
  }

  return { ...row, supervisor_name: supervisorName, internal_notes: row.notes || '', crew, notes, vehicles, dockets, documents, activity, requirements, equipment: equipmentList, job: jobInfo, client: clientInfo };
}

// GET /classic — legacy list view (was GET /). Preserved for any old
// bookmarks or links; the canonical experience is now GET / (the day
// board with universal slide-over).
router.get('/classic', (req, res) => {
  const db = getDb();
  const view = req.query.view || 'board';
  // Use Australia/Sydney local date as default (not UTC — avoids showing yesterday after midnight AEST)
  const dateStr = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const depot = req.query.depot || '', status = req.query.status || '', search = req.query.search || '';

  // Load bookings based on view type
  let where;
  const params = [];
  const deletedFilter = req.query.deleted || 'hide';
  if (view === 'calendar') {
    const d = new Date(dateStr + 'T00:00:00');
    const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0];
    const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().split('T')[0];
    where = "WHERE DATE(b.start_datetime) BETWEEN ? AND ?";
    params.push(firstOfMonth, lastOfMonth);
  } else if (view === 'archive') {
    where = "WHERE b.status IN ('complete','finalised','cancelled','late_cancellation')";
  } else if (view === 'requests') {
    where = "WHERE b.status = 'client_booking'";
  } else if (view === 'map') {
    where = "WHERE DATE(b.start_datetime) = ?";
    params.push(dateStr);
  } else {
    where = "WHERE DATE(b.start_datetime) = ?";
    params.push(dateStr);
  }
  // Soft-delete filter
  if (deletedFilter === 'hide') { where += " AND b.deleted_at IS NULL"; }
  else if (deletedFilter === 'only') { where += " AND b.deleted_at IS NOT NULL"; }
  // 'show' = no filter, shows all

  if (depot) { where += " AND b.depot = ?"; params.push(depot); }
  if (status && view !== 'requests') { where += " AND b.status = ?"; params.push(status); }
  if (search) { where += " AND (b.title LIKE ? OR b.booking_number LIKE ? OR b.site_address LIKE ? OR b.suburb LIKE ?)"; const s = '%' + search + '%'; params.push(s, s, s, s); }

  // Dashboard "missing site docs" alert links here with ?missing_docs=1.
  // Filter the list to upcoming bookings (today + tomorrow) that have no
  // booking_documents AND no job_documents on the same job.
  if (req.query.missing_docs === '1') {
    where += `
      AND date(b.start_datetime) BETWEEN date('now') AND date('now','+1 day')
      AND b.status IN ('confirmed','green_to_go','unconfirmed')
      AND NOT EXISTS (SELECT 1 FROM booking_documents bd WHERE bd.booking_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM job_documents jd WHERE jd.job_id = b.job_id AND jd.archived_at IS NULL)
    `;
  }

  const orderDir = (view === 'archive') ? 'DESC' : 'ASC';
  const rows = db.prepare(`SELECT b.* FROM bookings b ${where} ORDER BY b.start_datetime ${orderDir} LIMIT ${view === 'archive' ? 200 : 500}`).all(...params);
  const bookings = rows.map(r => transformBooking(db, r));
  const allForDate = db.prepare("SELECT status FROM bookings WHERE DATE(start_datetime) = ? AND deleted_at IS NULL").all(dateStr);
  const stats = {
    total: allForDate.length,
    greenToGo: allForDate.filter(r => r.status === 'green_to_go').length,
    confirmed: allForDate.filter(r => r.status === 'confirmed').length,
    unconfirmed: allForDate.filter(r => r.status === 'unconfirmed').length,
    inProgress: allForDate.filter(r => r.status === 'in_progress').length,
    complete: allForDate.filter(r => r.status === 'complete').length,
    finalised: allForDate.filter(r => r.status === 'finalised').length,
    cancelled: allForDate.filter(r => r.status === 'cancelled').length,
    lateCancellation: allForDate.filter(r => r.status === 'late_cancellation').length,
    conflict: allForDate.filter(r => r.status === 'conflict').length,
    locked: allForDate.filter(r => r.status === 'locked').length,
    clientBooking: allForDate.filter(r => r.status === 'client_booking').length,
  };

  // Load form data for the slide-in panel
  let jobs = []; try { jobs = db.prepare("SELECT id, job_number, job_name, client FROM jobs WHERE status NOT IN ('closed','completed') ORDER BY job_name").all(); } catch (e) {}
  let clients = []; try { clients = db.prepare("SELECT id, company_name FROM clients ORDER BY company_name").all(); } catch (e) {}
  let supervisors = []; try { supervisors = db.prepare("SELECT id, full_name FROM crew_members WHERE active = 1 ORDER BY full_name").all(); } catch (e) {}
  let contacts = []; try { contacts = db.prepare("SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name").all(); } catch (e) {}
  let crewForSelect = []; try { crewForSelect = db.prepare("SELECT id, full_name, role, portal_role FROM crew_members WHERE active = 1 ORDER BY full_name").all(); } catch (e) {}

  res.render('bookings/index', { title: 'Bookings (classic)', bookings, stats, depots: getDepots(), currentView: view, currentDate: dateStr, currentDepot: depot, currentStatus: status, currentSearch: search, currentDeleted: deletedFilter, user: req.session.user, jobs, clients, supervisors, contacts, crewForSelect, v2Enabled: false });
});

// GET /new
router.get('/new', (req, res) => {
  try {
    const db = getDb();
    let jobs = []; try { jobs = db.prepare("SELECT id, job_number, job_name, client FROM jobs WHERE status NOT IN ('closed','completed') ORDER BY job_name").all(); } catch (e) {}
    let clients = []; try { clients = db.prepare("SELECT id, company_name FROM clients ORDER BY company_name").all(); } catch (e) {}
    let supervisors = []; try { supervisors = db.prepare("SELECT id, full_name FROM crew_members WHERE active = 1 ORDER BY full_name").all(); } catch (e) {}
    let contacts = []; try { contacts = db.prepare("SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name").all(); } catch (e) {}
    let crewForSelect = []; try { crewForSelect = db.prepare("SELECT id, full_name, role, portal_role FROM crew_members WHERE active = 1 ORDER BY full_name").all(); } catch (e) {}
    res.render('bookings/form', { title: 'New Booking', booking: null, jobs, clients, supervisors, contacts, crewForSelect, depots: getDepots(), user: req.session.user });
  } catch (err) {
    console.error('Bookings /new error:', err);
    req.flash('error', 'Failed to load form: ' + err.message);
    res.redirect('/bookings');
  }
});

// Normalise HH:MM or HHMM or HH:MM:SS input to strict HH:MM
function normaliseTimeStr(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';
  let h, m;
  if (digits.length >= 4) { h = parseInt(digits.slice(0,2),10); m = parseInt(digits.slice(2,4),10); }
  else if (digits.length === 3) { h = parseInt(digits.slice(0,1),10); m = parseInt(digits.slice(1,3),10); }
  else if (digits.length === 2) { h = parseInt(digits,10); m = 0; }
  else { h = parseInt(digits,10); m = 0; }
  if (isNaN(h) || h > 23) h = 23;
  if (isNaN(m) || m > 59) m = 59;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

// Auto-fill lat/lng from the address fields after every save. Imported
// here so the booking POST/PUT routes can fire-and-forget the geocode.
const { geocodeBookingIfNeeded, geocodeBackfill } = require('../services/bookingGeocode');

// POST /geocode/backfill — admin-only utility to upgrade every booking's
// coordinates using the currently-configured provider (Google if the
// GOOGLE_MAPS_API_KEY env var is set, else Open-Meteo). Useful one-shot
// after enabling Google Geocoding so existing bookings get street-level
// precision instead of the legacy suburb-level pins.
router.post('/geocode/backfill', requireRole('management', 'admin'), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.body.limit, 10) || 500, 2000);
    const onlyMissing = req.body.only_missing === '1' || req.body.only_missing === 'true' || req.body.only_missing === true;
    const summary = await geocodeBackfill({ limit, onlyMissing });
    logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: 0, details: `Geocode backfill (${summary.provider}): scanned ${summary.scanned}, upgraded ${summary.upgraded}, failed ${summary.failed}`, req });
    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST / — Create booking
router.post('/', (req, res) => {
  const db = getDb(); const b = req.body;
  if (!b.title || !b.start_date || !b.start_time || !b.end_date || !b.end_time) { req.flash('error', 'Title and schedule are required.'); return res.redirect('/bookings/new'); }
  // Normalise time fields
  b.depot_meeting_time = normaliseTimeStr(b.depot_meeting_time);
  b.straight_to_site_time = normaliseTimeStr(b.straight_to_site_time);
  const bookingNumber = generateBookingNumber(db);
  const siteContacts = Array.isArray(b.site_contacts) ? JSON.stringify(b.site_contacts) : (b.site_contacts ? JSON.stringify([b.site_contacts]) : '[]');
  const bookingTags = b.booking_tags ? JSON.stringify(b.booking_tags.split(',').map(t => t.trim()).filter(Boolean)) : '[]';
  const result = db.prepare(`
    INSERT INTO bookings (booking_number, job_id, client_id, title, description, status, depot, start_datetime, end_datetime, site_address, suburb, state, postcode, order_number, billing_code, client_contact, supervisor_id, requirements_text, is_emergency, is_callout, billable, invoiced, notes, created_by_id,
      site_contacts, depot_meeting_time, straight_to_site_time, booking_tags, latitude, longitude, marker_is_accurate, location_notes, worksite_location, works_direction, chainage_from, chainage_to, has_mobile_works, booking_type, is_booking_pool, requester_id, planner_id, location_context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bookingNumber, b.job_id || null, b.client_id || null, b.title, b.description || '', b.status || 'unconfirmed', b.depot || '',
    b.start_date + 'T' + b.start_time + ':00', b.end_date + 'T' + b.end_time + ':00',
    b.site_address || '', b.suburb || '', b.state || '', b.postcode || '', b.order_number || '', b.billing_code || '', b.client_contact || '',
    b.supervisor_id || null, b.requirements_text || '', b.is_emergency ? 1 : 0, b.is_callout ? 1 : 0, b.billable ? 1 : 0, b.notes || '', req.session.user.id,
    siteContacts, b.depot_meeting_time || '', b.straight_to_site_time || '', bookingTags,
    b.latitude ? parseFloat(b.latitude) : null, b.longitude ? parseFloat(b.longitude) : null,
    b.marker_is_accurate ? 1 : 0, b.location_notes || '', b.worksite_location || '', b.works_direction || '',
    b.chainage_from || '', b.chainage_to || '', b.has_mobile_works ? 1 : 0,
    b.booking_type || 'regular', b.is_booking_pool ? 1 : 0,
    b.requester_id || null, b.planner_id || null, b.location_context || '');

  // Save requirements grid
  const bookingId = result.lastInsertRowid;
  const reqTypes = Array.isArray(b.req_resource_type) ? b.req_resource_type : (b.req_resource_type ? [b.req_resource_type] : []);
  const reqQtys = Array.isArray(b.req_quantity) ? b.req_quantity : (b.req_quantity ? [b.req_quantity] : []);
  const insertReq = db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)");
  for (let i = 0; i < reqTypes.length; i++) {
    if (reqTypes[i] && reqQtys[i] && parseInt(reqQtys[i]) > 0) {
      insertReq.run(bookingId, reqTypes[i], parseInt(reqQtys[i]));
    }
  }
  syncTCCrewVehicles(db, bookingId);

  // Assign crew from form crew selector + auto-create allocations for worker portal.
  // Per-crew on-site role comes from `crew_role_<id>` (TC / TL / Supervisor —
  // the three portal roles), validated against an allow-list. Falls back to
  // the worker's stored portal_role, then their crew_members.role.
  const crewIds = Array.isArray(b.crew_ids) ? b.crew_ids : (b.crew_ids ? [b.crew_ids] : []);
  const VALID_SITE_ROLES = ['traffic_controller','team_leader','supervisor'];
  function pickSiteRole(cid, fallback) {
    const raw = b['crew_role_' + cid];
    if (raw && VALID_SITE_ROLES.includes(raw)) return raw;
    if (fallback && VALID_SITE_ROLES.includes(fallback)) return fallback;
    return 'traffic_controller';
  }
  const insertCrew = db.prepare("INSERT OR IGNORE INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')");
  const insertAlloc = db.prepare("INSERT OR IGNORE INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id, allocated_by_id) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?)");
  const allocDate = (b.start_date + 'T' + b.start_time + ':00').substring(0, 10);
  const allocStart = b.start_time || '06:00';
  const allocEnd = b.end_time || '15:00';
  crewIds.forEach(cid => {
    if (cid) {
      const member = db.prepare("SELECT role, portal_role FROM crew_members WHERE id = ?").get(cid);
      const siteRole = pickSiteRole(cid, member && member.portal_role);
      insertCrew.run(bookingId, cid, siteRole);
      if (b.job_id) {
        try { insertAlloc.run(b.job_id, cid, allocDate, allocStart, allocEnd, siteRole, bookingId, req.session.user.id); } catch (e) {}
      }
    }
  });

  logActivity({ user: req.session.user, action: 'create', entityType: 'booking', entityId: bookingId, details: `Created booking ${bookingNumber}`, req });
  req.flash('success', `Booking ${bookingNumber} created — now assign your crew and vehicles below.`);
  // Land the planner directly on the detail page so the crew + vehicle
  // picker is right in front of them (was redirecting to the list).
  res.redirect('/bookings/' + bookingId);

  // Background geocode after the response goes out — never blocks the
  // user's save. Skips if the user already pinned the marker manually
  // OR coords are already populated.
  setImmediate(() => { geocodeBookingIfNeeded(bookingId).catch(() => {}); });
});

// ============================================================
// BOOKINGS v2 — board view + 5-field Quick Book slide-over.
// Gated by per-user `bookings_v2` preference (or ?v2=1 override).
// Co-exists with the classic /bookings list — no URLs broken.
// ============================================================

// Lifecycle columns displayed on the board (in order). Statuses not
// listed here are bucketed into 'unconfirmed' so nothing disappears.
const V2_LIFECYCLE = [
  { key: 'client_booking', label: 'Client booking', tone: 'gray' },
  { key: 'unconfirmed',    label: 'Unconfirmed',    tone: 'gray' },
  { key: 'confirmed',      label: 'Confirmed',      tone: 'blue' },
  { key: 'locked',         label: 'Locked',         tone: 'blue' },
  { key: 'conflict',       label: 'Conflict',       tone: 'amber' },
  { key: 'green_to_go',    label: 'Green to go',    tone: 'emerald' },
  { key: 'complete',       label: 'Complete',       tone: 'gray' },
];

// Build crew_blocks for one booking — derives N-man crew composites from
// booking_requirements rows matching /^(\d+)x TC Crew$/, then fans the
// flat booking_crew + booking_vehicles arrays into them in assignment
// order. This is the Phase 1 heuristic; Phase 2 introduces a real
// booking_crew_groups table and replaces this function.
function deriveCrewBlocks(crewRows, vehicleRows, requirementRows) {
  const blocks = [];
  // Each "Nx TC Crew" requirement row becomes one crew block of size N.
  // Quantity in the row multiplies that.
  for (const r of (requirementRows || [])) {
    const m = String(r.resource_type || '').match(/^(\d+)x TC Crew$/i);
    if (!m) continue;
    const size = parseInt(m[1], 10);
    const qty = Math.max(1, parseInt(r.quantity_required, 10) || 1);
    for (let i = 0; i < qty; i++) {
      blocks.push({
        ordinal: blocks.length + 1,
        size,
        role: 'TC',
        worker_slots: Array.from({ length: size }, () => ({ filled: false })),
        vehicle_slot: { filled: false },
        addons: [],
      });
    }
  }
  // If there are crew members on the booking but no "Nx TC Crew" rows,
  // synthesise a single block sized to the assigned crew so they still
  // render. Defensive fallback for legacy bookings.
  if (!blocks.length && (crewRows || []).length) {
    blocks.push({
      ordinal: 1,
      size: crewRows.length,
      role: 'TC',
      worker_slots: Array.from({ length: crewRows.length }, () => ({ filled: false })),
      vehicle_slot: { filled: false },
      addons: [],
    });
  }

  // Assign vehicles to blocks FIRST so blocks know their vehicle_id
  // before we slot workers in. A row with empty name AND empty rego
  // is treated as a placeholder (not filled) so the drop target still
  // renders and the planner can complete it by dragging a vehicle
  // from the resource panel.
  const vehicles = (vehicleRows || []).slice();
  for (const blk of blocks) {
    const v = vehicles.shift();
    if (v) {
      const hasName = v.vehicle_name && String(v.vehicle_name).trim() !== '';
      const hasRego = v.registration  && String(v.registration).trim()  !== '';
      blk.vehicle_slot = {
        filled: hasName || hasRego,
        vehicle_id: v.id,
        name: v.vehicle_name,
        registration: v.registration,
        role: v.vehicle_role || 'ute',
        driver_id: v.driver_id || null,
      };
    }
  }

  // Look-up: vehicle_id → block (used to place workers under the
  // ute they were dragged onto).
  const blockByVehicle = new Map();
  for (const blk of blocks) {
    if (blk.vehicle_slot.vehicle_id) blockByVehicle.set(blk.vehicle_slot.vehicle_id, blk);
  }

  function fillSlot(slot, c) {
    slot.filled = true;
    slot.booking_crew_id = c.booking_crew_id;
    slot.crew_member_id = c.crew_member_id;
    slot.name = c.full_name;
    slot.role = c.role_on_site || c.portal_role || c.role || 'traffic_controller';
    slot.employment_status = c.employment_status || 'active';
    slot.bc_status = c.bc_status || 'assigned';
    slot.warnings = c.warnings || [];
    slot.is_team_leader   = !!c.is_team_leader;
    slot.is_first_aid     = !!c.is_first_aid;
    slot.straight_to_site = !!c.straight_to_site;
    slot.non_billable     = !!c.non_billable;
    slot.assigned_vehicle_id = c.assigned_vehicle_id || null;
  }

  // Two-pass worker placement:
  //   pass 1 — workers with assigned_vehicle_id matching a block's
  //            vehicle go into that block's first empty slot.
  //   pass 2 — remaining workers (no assignment OR vehicle no longer
  //            present) fill remaining slots in order. Truly
  //            unassigned crew that couldn't fit anywhere collect
  //            into the unassigned pool.
  const unassigned = [];
  const remaining = [];
  for (const c of (crewRows || [])) {
    if (c.assigned_vehicle_id && blockByVehicle.has(c.assigned_vehicle_id)) {
      const blk = blockByVehicle.get(c.assigned_vehicle_id);
      const slot = blk.worker_slots.find(s => !s.filled);
      if (slot) { fillSlot(slot, c); continue; }
      // overflow — fall through
    }
    if (c.assigned_vehicle_id == null) {
      // Workers explicitly with no vehicle assignment. If the booking
      // has any vehicles, they go to the "Unassigned" pool. If the
      // booking has NO vehicles, they go into block slots in order.
      if (blockByVehicle.size > 0) { unassigned.push(c); continue; }
    }
    remaining.push(c);
  }
  let workerIdx = 0;
  for (const c of remaining) {
    while (workerIdx < blocks.length) {
      const blk = blocks[workerIdx];
      const slot = blk.worker_slots.find(s => !s.filled);
      if (slot) { fillSlot(slot, c); break; }
      workerIdx += 1;
    }
    if (workerIdx >= blocks.length) unassigned.push(c);
  }

  // Mark whichever crew slot belongs to the driver of each vehicle.
  for (const blk of blocks) {
    const v = blk.vehicle_slot;
    if (v && v.driver_id) {
      const driverSlot = blk.worker_slots.find(s => s.filled && s.crew_member_id == v.driver_id);
      if (driverSlot) driverSlot.is_driver = true;
    }
  }

  // Attach unassigned pool to the blocks array so the caller can read
  // it via `crew_blocks.unassigned`. Keeps the return type backwards-
  // compatible (still an array) without forcing every caller to use
  // an object shape.
  blocks.unassigned = unassigned.map(c => {
    const slot = { filled: true };
    fillSlot(slot, c);
    return slot;
  });
  // Stragglers (extra vehicles beyond what blocks needed) collect on the
  // first block as "extras" — render them at the bottom of that block.
  if (vehicles.length && blocks.length) {
    blocks[0].extra_vehicles = vehicles.map(v => ({
      vehicle_id: v.id, name: v.vehicle_name, registration: v.registration, role: v.vehicle_role || 'ute',
    }));
  }
  return blocks;
}

// GET / — Day-focused Board view + universal slide-over.
// Single-column wide cards sorted by start time, status as a per-card
// banner. View switcher (Board/List/Calendar/Map) is client-side on
// the same page. /bookings/board is kept as a redirect alias below.
router.get('/', (req, res) => {
  const db = getDb();
  const dateStr = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const filterDepot = req.query.depot || '';
  const filterStatus = req.query.status || '';
  const filterSearch = (req.query.q || '').trim().toLowerCase();
  const openBookingId = req.query.b || ''; // for slide-over deep-link

  // Filtered, date-sorted list — single column, no status grouping.
  // Show bookings in every status (incl. cancelled / complete / finalised)
  // so the planner can revisit historical bookings and shuffle the
  // crew/vehicle assignments after the fact. Only deleted rows are
  // hidden. Explicit ?status= filtering still works via the chip.
  let where = "DATE(b.start_datetime) = ? AND (b.deleted_at IS NULL)";
  const params = [dateStr];
  if (filterDepot) { where += ' AND b.depot = ?'; params.push(filterDepot); }
  if (filterStatus) { where += ' AND b.status = ?'; params.push(filterStatus); }

  const rows = db.prepare(`
    SELECT b.id, b.booking_number, b.title, b.status, b.start_datetime, b.end_datetime,
      b.site_address, b.suburb, b.state, b.postcode, b.depot, b.is_emergency, b.is_callout,
      b.order_number, b.location_notes, b.latitude, b.longitude,
      j.job_name, j.job_number, c.company_name AS client_name,
      cm_req.full_name AS requester_name, cm_plan.full_name AS planner_name,
      (SELECT COUNT(*) FROM booking_crew bc WHERE bc.booking_id = b.id) AS crew_count,
      (SELECT COUNT(*) FROM booking_crew bc WHERE bc.booking_id = b.id AND bc.status = 'confirmed') AS crew_confirmed,
      (SELECT COUNT(*) FROM booking_vehicles bv WHERE bv.booking_id = b.id) AS vehicle_count,
      (SELECT COUNT(*) FROM booking_documents bd WHERE bd.booking_id = b.id) AS doc_count,
      (SELECT COUNT(*) FROM booking_notes bn WHERE bn.booking_id = b.id) AS note_count,
      (SELECT COUNT(*) FROM booking_dockets bdk WHERE bdk.booking_id = b.id) AS docket_count
    FROM bookings b
    LEFT JOIN jobs j ON b.job_id = j.id
    LEFT JOIN clients c ON b.client_id = c.id
    LEFT JOIN crew_members cm_req ON b.requester_id = cm_req.id
    LEFT JOIN crew_members cm_plan ON b.planner_id = cm_plan.id
    WHERE ${where}
    ORDER BY b.start_datetime
  `).all(...params);

  // Eager-load crew, vehicles and requirements for every booking so the
  // dream cards render without N+1 queries.
  const bookingIds = rows.map(r => r.id);
  const crewByBooking = {};
  const vehiclesByBooking = {};
  const reqsByBooking = {};
  if (bookingIds.length) {
    const placeholders = bookingIds.map(() => '?').join(',');
    const crewRows = db.prepare(`
      SELECT bc.id AS booking_crew_id, bc.booking_id, bc.crew_member_id, bc.status AS bc_status, bc.role_on_site,
        bc.is_team_leader, bc.is_first_aid, bc.straight_to_site, bc.non_billable, bc.assigned_vehicle_id,
        cm.full_name, cm.role, cm.portal_role,
        COALESCE(e.employment_status, 'active') AS employment_status
      FROM booking_crew bc
      JOIN crew_members cm ON cm.id = bc.crew_member_id
      LEFT JOIN employees e ON e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL
      WHERE bc.booking_id IN (${placeholders})
      ORDER BY bc.created_at
    `).all(...bookingIds);
    for (const c of crewRows) (crewByBooking[c.booking_id] = crewByBooking[c.booking_id] || []).push(c);

    const vRows = db.prepare(`
      SELECT id, booking_id, vehicle_name, registration, vehicle_role, crew_member_id AS driver_id
      FROM booking_vehicles WHERE booking_id IN (${placeholders})
      ORDER BY created_at
    `).all(...bookingIds);
    for (const v of vRows) (vehiclesByBooking[v.booking_id] = vehiclesByBooking[v.booking_id] || []).push(v);

    const rqRows = db.prepare(`
      SELECT booking_id, resource_type, quantity_required FROM booking_requirements
      WHERE booking_id IN (${placeholders})
      ORDER BY id
    `).all(...bookingIds);
    for (const r of rqRows) (reqsByBooking[r.booking_id] = reqsByBooking[r.booking_id] || []).push(r);
  }

  // Detect scheduling clashes (a worker is on >1 booking the same day).
  const conflictIds = new Set();
  if (bookingIds.length) {
    const allCrewIds = Object.values(crewByBooking).flat().map(c => c.crew_member_id);
    if (allCrewIds.length) {
      const phc = allCrewIds.map(() => '?').join(',');
      const conflictRows = db.prepare(`
        SELECT bc.crew_member_id, COUNT(DISTINCT bc.booking_id) AS bookings_today
        FROM booking_crew bc
        JOIN bookings b ON b.id = bc.booking_id
        WHERE bc.crew_member_id IN (${phc})
          AND DATE(b.start_datetime) = ?
          AND b.status NOT IN ('cancelled','late_cancellation','complete')
        GROUP BY bc.crew_member_id
        HAVING bookings_today > 1
      `).all(...allCrewIds, dateStr);
      for (const r of conflictRows) conflictIds.add(r.crew_member_id);
    }
  }

  // Build the final bookings array with derived crew_blocks.
  const bookings = rows
    .map(r => {
      const crewWithWarn = (crewByBooking[r.id] || []).map(c => ({
        ...c,
        warnings: conflictIds.has(c.crew_member_id) ? ['tight_schedule'] : [],
      }));
      const crew_blocks = deriveCrewBlocks(crewWithWarn, vehiclesByBooking[r.id], reqsByBooking[r.id]);
      return { ...r, crew_blocks, counts: { docs: r.doc_count, notes: r.note_count, dockets: r.docket_count } };
    })
    .filter(b => {
      if (!filterSearch) return true;
      const hay = (b.title + ' ' + (b.site_address || '') + ' ' + (b.client_name || '') + ' ' + (b.job_name || '') + ' ' + (b.booking_number || '')).toLowerCase();
      return hay.includes(filterSearch);
    });

  // Quick-book preselect data
  let clients = []; try { clients = db.prepare("SELECT id, company_name FROM clients ORDER BY company_name").all(); } catch (e) {}
  let jobs = []; try { jobs = db.prepare("SELECT id, job_number, job_name, client_id, client, site_address FROM jobs WHERE status NOT IN ('closed','completed') ORDER BY job_name").all(); } catch (e) {}

  // Day navigator metadata
  const d = new Date(dateStr + 'T00:00:00');
  const prevDate = new Date(d); prevDate.setDate(prevDate.getDate() - 1);
  const nextDate = new Date(d); nextDate.setDate(nextDate.getDate() + 1);
  const isToday = dateStr === new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

  res.render('bookings/board', {
    title: 'Bookings — Board',
    currentPage: 'bookings',
    bookings,
    dateStr,
    isToday,
    prevDate: prevDate.toISOString().substring(0,10),
    nextDate: nextDate.toISOString().substring(0,10),
    dayLabel: d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }),
    clients,
    jobs,
    depots: getDepots(),
    statuses: VALID_STATUSES,
    addons: QUICK_ADDONS,
    filters: { depot: filterDepot, status: filterStatus, q: req.query.q || '' },
    openBookingId,
    user: req.session.user,
  });
});

// GET /board — Permanent alias of GET / so old bookmarks survive.
router.get('/board', (req, res) => {
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect('/bookings' + qs);
});

// Add-on equipment types the Quick Book stepper exposes. These map
// straight to booking_equipment rows; the resource_type on the
// requirement row uses the same labels so reporting stays consistent.
const QUICK_ADDONS = [
  { key: 'portaboom',         label: 'Portaboom',           category: 'sign' },
  { key: 'arrow_board',       label: 'Arrow Board',         category: 'arrow_board' },
  { key: 'vms_board',         label: 'VMS Board',           category: 'vms' },
  { key: 'speed_advisory',    label: 'Speed Advisory Sign', category: 'sign' },
  { key: 'light_tower',       label: 'Light Tower',         category: 'lighting' },
  { key: 'pod_truck',         label: 'Pod Truck',           category: 'vehicle' },
  { key: 'tma',               label: 'TMA',                 category: 'vehicle' },
];

// GET /api/places — address autocomplete via Nominatim (OpenStreetMap).
// Free, AU-biased. Returns up to 8 suggestions as { label, lat, lng,
// suburb, state, postcode, formatted }.
router.get('/api/places', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=8&countrycodes=au&q=' + encodeURIComponent(q);
    const resp = await fetch(url, { headers: { 'User-Agent': 'Atomis/1.0 (operations dashboard)' } });
    if (!resp.ok) return res.json({ results: [] });
    const rows = await resp.json();
    const results = (rows || []).map(r => {
      const a = r.address || {};
      return {
        label: r.display_name,
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        site_address: [a.house_number, a.road].filter(Boolean).join(' ') || r.name || '',
        suburb: a.suburb || a.city || a.town || a.village || '',
        state: (a.state || '').replace(/^.*?\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b.*$/i, (m, s) => s.toUpperCase()) || a.state || '',
        postcode: a.postcode || '',
      };
    });
    res.json({ results });
  } catch (e) {
    res.json({ results: [], error: e.message });
  }
});

// POST /quick — Quick Book create from the slide-over. Persists the
// booking, the crew composition as `Nx TC Crew` requirement rows, and
// the add-ons as booking_equipment rows. Auto-creates ute placeholders
// via the existing syncTCCrewVehicles. JSON-aware.
router.post('/quick', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const b = req.body;

  // Required per the brief: client, site_address, site_label, date, time, depot.
  // Validate everything that has a UI field; complain in plain English.
  const missing = [];
  if (!b.client_name) missing.push('client');
  if (!b.site_address) missing.push('site address');
  if (!b.start_date) missing.push('date');
  if (!b.start_time) missing.push('start time');
  if (missing.length) {
    const msg = 'Missing: ' + missing.join(', ');
    if (isJson) return res.status(400).json({ error: msg });
    req.flash('error', msg); return res.redirect('/bookings');
  }
  const startTime = b.start_time;
  const endTime = b.end_time || '14:30';
  const bookingNumber = generateBookingNumber(db);
  const title = (b.title && b.title.trim()) || (b.site_label && b.site_label.trim()) || ('Quick booking ' + bookingNumber);

  // Resolve / auto-create client and project.
  let clientId = b.client_id ? parseInt(b.client_id, 10) : null;
  if (!clientId && b.client_name) {
    const existing = db.prepare("SELECT id FROM clients WHERE LOWER(company_name) = LOWER(?)").get(b.client_name.trim());
    if (existing) clientId = existing.id;
    else {
      // Create the client on the fly so allocators don't have to leave
      // the slide-over for a one-time client.
      try {
        const ins = db.prepare("INSERT INTO clients (company_name, created_at) VALUES (?, CURRENT_TIMESTAMP)").run(b.client_name.trim());
        clientId = ins.lastInsertRowid;
      } catch (e) { /* schema may differ — leave clientId null */ }
    }
  }
  let jobId = b.job_id ? parseInt(b.job_id, 10) : null;
  if (!jobId && b.site_label) {
    const proj = db.prepare("SELECT id FROM jobs WHERE LOWER(job_name) = LOWER(?) LIMIT 1").get(b.site_label.trim());
    if (proj) jobId = proj.id;
    else if (clientId) {
      try {
        const ins = db.prepare("INSERT INTO jobs (job_name, client_id, status, created_at) VALUES (?, ?, 'active', CURRENT_TIMESTAMP)").run(b.site_label.trim(), clientId);
        jobId = ins.lastInsertRowid;
      } catch (e) { /* table may not allow these columns — leave jobId null */ }
    }
  }

  // Parse optional lat/lng from the address autocomplete picker.
  const lat = b.latitude ? parseFloat(b.latitude) : null;
  const lng = b.longitude ? parseFloat(b.longitude) : null;
  let result;
  try {
    result = db.prepare(`
      INSERT INTO bookings (booking_number, job_id, client_id, title, status, depot,
        start_datetime, end_datetime, site_address, suburb, state, postcode,
        latitude, longitude, marker_is_accurate,
        created_by_id, booking_type, is_booking_pool)
      VALUES (?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'regular', 0)
    `).run(
      bookingNumber, jobId, clientId, title, b.depot || '',
      b.start_date + 'T' + startTime + ':00',
      b.start_date + 'T' + endTime + ':00',
      b.site_address || b.site_label || '',
      b.suburb || '', b.state || '', b.postcode || '',
      lat, lng, lat ? 1 : 0,
      req.session.user.id
    );
  } catch (err) {
    console.error('[bookings/quick] INSERT failed:', err.message);
    if (isJson) return res.status(500).json({ error: 'Could not create booking: ' + err.message });
    req.flash('error', 'Could not create booking: ' + err.message);
    return res.redirect('/bookings');
  }
  const newId = result.lastInsertRowid;

  // Crew composition steppers: crew_size_1..5 → "Nx TC Crew" requirement rows.
  const insertReq = db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)");
  let totalCrews = 0;
  for (let n = 1; n <= 5; n++) {
    const qty = parseInt(b['crew_size_' + n], 10);
    if (Number.isFinite(qty) && qty > 0) {
      insertReq.run(newId, n + 'x TC Crew', qty);
      totalCrews += qty;
    }
  }
  // Default to 1× 2-man crew if the user didn't pick anything (brief rule).
  if (totalCrews === 0) {
    insertReq.run(newId, '2x TC Crew', 1);
  }
  // Sync ute placeholders for every TC-Crew requirement.
  try { syncTCCrewVehicles(db, newId); } catch (e) { console.error('syncTCCrewVehicles:', e.message); }

  // Add-ons: each addon_<key>=qty → booking_equipment row.
  const insertEq = db.prepare("INSERT INTO booking_equipment (booking_id, equipment_name, equipment_type, quantity) VALUES (?, ?, ?, ?)");
  QUICK_ADDONS.forEach(a => {
    const qty = parseInt(b['addon_' + a.key], 10);
    if (Number.isFinite(qty) && qty > 0) {
      try { insertEq.run(newId, a.label, a.category, qty); } catch (e) { /* swallow */ }
    }
  });

  logActivity({ user: req.session.user, action: 'create', entityType: 'booking', entityId: newId, details: `Quick-created booking ${bookingNumber}`, req });

  // Background geocode if we don't have coords yet.
  if (!lat || !lng) setImmediate(() => { geocodeBookingIfNeeded(newId).catch(() => {}); });

  if (isJson) return res.json({ ok: true, id: newId, booking_number: bookingNumber });
  req.flash('success', `Booking ${bookingNumber} created — finish assigning crew and vehicles below.`);
  // Land the planner on the full booking detail page so they can keep
  // working on the booking they just created, instead of back on the
  // day board with the new row buried in the list.
  res.redirect('/bookings/' + newId);
});

// GET /resources — Available crew (JSON) with qualification data
router.get('/resources', (req, res) => {
  try {
    const db = getDb();
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const assignedIds = db.prepare(`SELECT DISTINCT bc.crew_member_id FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id WHERE DATE(b.start_datetime) = ? AND b.status NOT IN ('cancelled','complete','late_cancellation')`).all(date).map(r => r.crew_member_id);
    const allCrew = db.prepare(`SELECT id, full_name, role, phone, employee_id, employment_type,
      tc_ticket_expiry, white_card_expiry, licence_expiry, tcp_level,
      first_aid, company
      FROM crew_members WHERE active = 1 ORDER BY full_name`).all();

    // Enrich with warnings
    const enriched = allCrew.map(c => {
      const warnings = [];
      if (c.tc_ticket_expiry && c.tc_ticket_expiry < today) warnings.push('TC ticket expired');
      if (c.white_card_expiry && c.white_card_expiry < today) warnings.push('White card expired');
      if (c.licence_expiry && c.licence_expiry < today) warnings.push('Licence expired');
      if (c.role === 'traffic_controller' && !c.tc_ticket_expiry) warnings.push('No TC ticket');
      return { ...c, warnings, blocked: warnings.length > 0 };
    });

    res.json({
      date,
      available: enriched.filter(c => !assignedIds.includes(c.id)),
      assigned: enriched.filter(c => assignedIds.includes(c.id))
    });
  } catch (err) {
    console.error('[Resources]', err.message);
    res.status(500).json({ error: err.message, available: [], assigned: [] });
  }
});

// GET /api/week — Calendar feed: every booking in a 7-day window
// starting on Monday of the given date. Returns a flat list with
// day index (0–6) and minute offsets, so the front-end can lay them
// out as time blocks per day column.
router.get('/api/week', (req, res) => {
  try {
    const db = getDb();
    const anchor = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const d = new Date(anchor + 'T00:00:00');
    const day = d.getDay();
    const offsetToMonday = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d); monday.setDate(d.getDate() + offsetToMonday);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    const fromStr = monday.toISOString().substring(0, 10);
    const toStr   = sunday.toISOString().substring(0, 10);
    const rows = db.prepare(`
      SELECT id, booking_number, title, status, start_datetime, end_datetime,
             depot, site_address, suburb,
             (SELECT COUNT(*) FROM booking_crew bc WHERE bc.booking_id = bookings.id) AS crew_count
      FROM bookings
      WHERE DATE(start_datetime) BETWEEN ? AND ?
        AND deleted_at IS NULL
        AND status NOT IN ('cancelled','late_cancellation')
      ORDER BY start_datetime
    `).all(fromStr, toStr);
    const items = rows.map(r => {
      const start = new Date(r.start_datetime);
      const end   = new Date(r.end_datetime);
      const dayDate = new Date(r.start_datetime.substring(0, 10) + 'T00:00:00');
      const di = Math.max(0, Math.min(6, Math.round((dayDate - monday) / 86400000)));
      const startMin = start.getHours() * 60 + start.getMinutes();
      const endMin   = end.getHours() * 60 + end.getMinutes();
      return { ...r, day_index: di, start_min: startMin, end_min: Math.max(startMin + 30, endMin) };
    });
    res.json({ monday: fromStr, sunday: toStr, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/resources — Resource Panel feed for the new board. Returns
// people, vehicles, equipment in one call so the panel doesn't need to
// re-request when the user flips tabs. Each item carries enough meta
// for inline filtering (licence, tcp_level, availability).
router.get('/api/resources', (req, res) => {
  try {
    const db = getDb();
    const date = req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

    // Bookings on this date and the crew already on them.
    const assignedIds = db.prepare(`SELECT DISTINCT bc.crew_member_id FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id WHERE DATE(b.start_datetime) = ? AND b.status NOT IN ('cancelled','complete','late_cancellation')`).all(date).map(r => r.crew_member_id);

    // PEOPLE — all active crew members + the employee join for status.
    const people = db.prepare(`
      SELECT cm.id, cm.full_name, cm.role, cm.portal_role, cm.phone, cm.employee_id,
        cm.tc_ticket_expiry, cm.white_card_expiry, cm.licence_expiry, cm.licence_type,
        cm.tcp_level, cm.first_aid, cm.company, cm.employment_type,
        COALESCE(e.employment_status, 'active') AS employment_status,
        e.address, e.suburb, e.state, e.postcode,
        e.blocked_from_allocation
      FROM crew_members cm
      LEFT JOIN employees e ON e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL
      WHERE cm.active = 1
        AND COALESCE(e.employment_status, 'active') IN ('active', 'reserved', 'on_leave')
      ORDER BY cm.full_name
    `).all().map(p => {
      const warnings = [];
      if (p.blocked_from_allocation) warnings.push('blocked');
      if (p.licence_expiry && p.licence_expiry < today) warnings.push('licence_expired');
      if (p.tc_ticket_expiry && p.tc_ticket_expiry < today) warnings.push('tc_expired');
      if (p.white_card_expiry && p.white_card_expiry < today) warnings.push('whitecard_expired');
      if (p.employment_status === 'on_leave') warnings.push('on_leave');
      const assignedToday = assignedIds.includes(p.id);
      return { ...p, warnings, assigned_today: assignedToday };
    });

    // VEHICLES — primary source is the Fleet register; equipment-vehicle
    // rows are also included so legacy assets keep showing up while the
    // fleet is being populated. Each item carries `source` so the panel
    // can render a Fleet/Equipment badge.
    let vehicles = [];
    try {
      const fleetRows = db.prepare(`
        SELECT id, asset_id AS asset_number, rego AS licence_plate,
               COALESCE(NULLIF(TRIM(make || ' ' || model), ''), asset_id) AS name,
               vehicle_type AS category, status
        FROM vehicles
        WHERE status IN ('Active','Spare')
        ORDER BY asset_id
      `).all().map(r => ({ ...r, source: 'fleet' }));
      vehicles = vehicles.concat(fleetRows);
    } catch (e) { /* fleet migration may not have run on a legacy DB */ }
    try {
      // Skip equipment rows that have already been reconciled against a
      // Fleet vehicle (migration 237). The fleet row is the source of
      // truth; the equipment row is kept inactive purely for history.
      const eqRows = db.prepare(`
        SELECT id, name, category, asset_number, licence_plate, current_condition
        FROM equipment
        WHERE active = 1
          AND (fleet_vehicle_id IS NULL)
          AND (
            category = 'vehicle'
            OR LOWER(name) LIKE '%ute%' OR LOWER(name) LIKE '%truck%' OR LOWER(name) LIKE '%vms%'
          )
        ORDER BY name
      `).all().map(r => ({ ...r, source: 'equipment' }));
      vehicles = vehicles.concat(eqRows);
    } catch (e) {}

    // EQUIPMENT — non-vehicle assets.
    let equipment = [];
    try {
      equipment = db.prepare(`
        SELECT id, name, category, asset_number, current_condition
        FROM equipment
        WHERE active = 1
          AND category NOT IN ('vehicle')
          AND LOWER(name) NOT LIKE '%ute%' AND LOWER(name) NOT LIKE '%truck%'
        ORDER BY category, name
      `).all();
    } catch (e) {}

    res.json({ date, people, vehicles, equipment });
  } catch (err) {
    console.error('[api/resources]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /bookings/map — Operations map view. MUST be declared above the
// `/:id` route below or Express matches `/map` against `:id = "map"`,
// fails the booking lookup, and flashes "Booking not found".
// Plots every non-cancelled booking with coordinates from the last day
// through the configurable upcoming window, with pins linking back to
// the detail page.
router.get('/map', (req, res) => {
  const db = getDb();
  const days = Math.max(1, Math.min(30, parseInt(req.query.days, 10) || 7));
  const since = new Date(); since.setDate(since.getDate() - 1);
  const until = new Date(); until.setDate(until.getDate() + days);
  const rows = db.prepare(`
    SELECT id, booking_number, title, status, start_datetime, end_datetime,
           site_address, suburb, latitude, longitude
    FROM bookings
    WHERE deleted_at IS NULL
      AND status NOT IN ('cancelled','late_cancellation')
      AND latitude IS NOT NULL AND longitude IS NOT NULL
      AND start_datetime BETWEEN ? AND ?
    ORDER BY start_datetime ASC
  `).all(since.toISOString().slice(0, 19).replace('T', ' '), until.toISOString().slice(0, 19).replace('T', ' '));

  const markers = rows.map(r => ({
    lat: r.latitude,
    lng: r.longitude,
    label: (r.booking_number || '#' + r.id) + ' · ' + (r.title || '')
         + ' · ' + new Date(r.start_datetime).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
         + (r.suburb ? ' · ' + r.suburb : ''),
    href: '/bookings/' + r.id,
  }));

  res.render('bookings/map', {
    title: 'Bookings Map',
    currentPage: 'bookings-map',
    markers, rows, days,
    user: req.session.user,
  });
});

// GET /:id — Detail (JSON or show page)
router.get('/:id', (req, res) => {
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  // Bail early on garbage ids — anything non-integer goes 404 cleanly
  // instead of crashing a downstream query.
  if (!/^\d+$/.test(String(req.params.id))) {
    if (wantsJson) return res.status(404).json({ error: 'Booking not found' });
    req.flash('error', 'Booking not found.'); return res.redirect('/bookings');
  }
  let db, booking;
  try {
    db = getDb();
    booking = loadBookingDetail(db, req.params.id);
  } catch (err) {
    console.error('[GET /bookings/:id] loadBookingDetail threw:', err.message, err.stack);
    if (wantsJson) return res.status(500).json({ error: 'Server error: ' + err.message });
    req.flash('error', 'Failed to load booking: ' + err.message); return res.redirect('/bookings');
  }
  if (!booking) { if (wantsJson) return res.status(404).json({ error: 'Booking not found' }); req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  // Resolve requester/planner names (used by both JSON and HTML paths)
  let requesterName = '', plannerName = '';
  if (booking.requester_id) { const r = db.prepare("SELECT full_name FROM crew_members WHERE id = ?").get(booking.requester_id); if (r) requesterName = r.full_name; }
  if (booking.planner_id) { const p = db.prepare("SELECT full_name FROM crew_members WHERE id = ?").get(booking.planner_id); if (p) plannerName = p.full_name; }
  // Parse site contacts JSON → resolve names
  let siteContactNames = [];
  let siteContactIds = [];
  try {
    siteContactIds = JSON.parse(booking.site_contacts || '[]');
    if (siteContactIds.length) { siteContactNames = siteContactIds.map(id => { const c = db.prepare("SELECT full_name FROM client_contacts WHERE id = ?").get(id); return c ? c.full_name : null; }).filter(Boolean); }
  } catch (e) {}
  // Parse booking tags
  let tagsList = [];
  try { tagsList = JSON.parse(booking.booking_tags || '[]'); } catch (e) {}

  if (wantsJson) {
    try {
      const t = transformBooking(db, booking);
      return res.json({ ...t, booking_number: booking.booking_number, description: booking.description, requirements_text: booking.requirements_text, order_number: booking.order_number, billing_code: booking.billing_code, client_contact: booking.client_contact, is_emergency: booking.is_emergency, is_callout: booking.is_callout, billable: booking.billable, invoiced: booking.invoiced, site_address: booking.site_address, suburb: booking.suburb, state: booking.state, postcode: booking.postcode, crew: booking.crew, allNotes: booking.notes, allVehicles: booking.vehicles, dockets: booking.dockets, documents: booking.documents, activity: booking.activity, requirements: booking.requirements, equipment: booking.equipment, job: booking.job, client: booking.client,
        requester_name: requesterName, planner_name: plannerName, requester_id: booking.requester_id, planner_id: booking.planner_id,
        site_contact_names: siteContactNames, site_contact_ids: siteContactIds, tags_list: tagsList,
        location_context: booking.location_context || '', worksite_location: booking.worksite_location || '', works_direction: booking.works_direction || '',
        chainage_from: booking.chainage_from || '', chainage_to: booking.chainage_to || '', has_mobile_works: booking.has_mobile_works || 0,
        location_notes: booking.location_notes || '', marker_is_accurate: booking.marker_is_accurate || 0,
        depot_meeting_time: booking.depot_meeting_time || '', straight_to_site_time: booking.straight_to_site_time || '',
        booking_type: booking.booking_type || 'regular', is_booking_pool: booking.is_booking_pool || 0,
        title: booking.title || '', job_id: booking.job_id, client_id: booking.client_id, supervisor_id: booking.supervisor_id,
        internal_notes: booking.internal_notes || '', start_datetime: booking.start_datetime, end_datetime: booking.end_datetime
      });
    } catch (err) {
      console.error('[GET /bookings/:id JSON] failed:', err.message, err.stack);
      return res.status(500).json({ error: 'Failed to assemble response: ' + err.message });
    }
  }

  // Available crew for the picker — joined to employees so the UI can
  // split into Active + Reserved sections. Reserved workers are
  // accepted-but-not-yet-working; allocator can still pick them, just
  // from a separate group. Skip anyone inactive/terminated.
  const allCrew = db.prepare(`
    SELECT cm.id, cm.full_name, cm.role, cm.employee_id,
      COALESCE(e.employment_status, 'active') AS employment_status
    FROM crew_members cm
    LEFT JOIN employees e ON e.linked_crew_member_id = cm.id AND e.deleted_at IS NULL
    WHERE cm.active = 1
      AND COALESCE(e.employment_status, 'active') IN ('active', 'reserved', 'on_leave')
    ORDER BY
      CASE COALESCE(e.employment_status, 'active')
        WHEN 'active' THEN 0 WHEN 'reserved' THEN 1 ELSE 2 END,
      cm.full_name
  `).all();

  // Per-worker Job-Pack completion grid: for every crew member on this
  // booking, which of the five Job-Pack checklists have they filed against
  // any of THEIR allocations on this booking. We resolve "the worker's
  // allocations on this booking" via crew_allocations.booking_id (set when
  // the booking flow generates an allocation per crew row).
  const JP_TYPES = ['vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'];
  let jobPackGrid = [];
  try {
    const allocations = db.prepare(`
      SELECT id, crew_member_id FROM crew_allocations WHERE booking_id = ? AND status != 'cancelled'
    `).all(booking.id);
    const allocByCrew = {};
    for (const a of allocations) (allocByCrew[a.crew_member_id] = allocByCrew[a.crew_member_id] || []).push(a.id);

    const crewIds = (booking.crew || []).map(c => c.crew_member_id);
    if (crewIds.length) {
      const subs = db.prepare(`
        SELECT id, crew_member_id, form_type, allocation_id, submitted_at
        FROM safety_forms
        WHERE crew_member_id IN (${crewIds.map(() => '?').join(',')})
          AND form_type IN (${JP_TYPES.map(() => '?').join(',')})
          AND (allocation_id IS NULL OR allocation_id IN (${
            allocations.length ? allocations.map(() => '?').join(',') : 'SELECT NULL'
          }))
      `).all(...crewIds, ...JP_TYPES, ...allocations.map(a => a.id));
      const byCrew = {};
      for (const s of subs) (byCrew[s.crew_member_id] = byCrew[s.crew_member_id] || []).push(s);

      // Also pull the docket signed for each (worker, allocation) pair.
      const dockets = allocations.length ? db.prepare(`
        SELECT id, crew_member_id, allocation_id, signed_at
        FROM docket_signatures
        WHERE allocation_id IN (${allocations.map(() => '?').join(',')})
      `).all(...allocations.map(a => a.id)) : [];
      const docketByCrew = {};
      for (const d of dockets) docketByCrew[d.crew_member_id] = d;

      jobPackGrid = (booking.crew || []).map(c => {
        const submissions = byCrew[c.crew_member_id] || [];
        const formStatus = {};
        for (const t of JP_TYPES) {
          const hit = submissions.find(s => s.form_type === t);
          formStatus[t] = hit ? { id: hit.id, submitted_at: hit.submitted_at } : null;
        }
        return {
          crew_member_id: c.crew_member_id,
          name: c.full_name || ('#' + c.crew_member_id),
          role: c.role_on_site || c.crew_role || '',
          forms: formStatus,
          docket: docketByCrew[c.crew_member_id] || null,
          submitted_count: JP_TYPES.filter(t => formStatus[t]).length,
        };
      });
    }
  } catch (e) {
    console.error('[bookings.show] job-pack grid error:', e.message);
  }

  res.render('bookings/show', {
    title: 'Booking ' + booking.booking_number,
    booking: { ...booking, supervisor: booking.supervisor_name, requester_name: requesterName, planner_name: plannerName, site_contact_names: siteContactNames, tags_list: tagsList,
      project: { name: booking.title || (booking.job ? booking.job.job_name : ''), client: booking.client ? booking.client.company_name : (booking.job ? booking.job.client : ''), address: booking.site_address || (booking.job ? booking.job.site_address : ''), orderNumber: booking.order_number, billingCode: booking.billing_code },
      startDateTime: booking.start_datetime, endDateTime: booking.end_datetime,
      personnel: booking.crew.map(c => ({ id: c.crew_member_id, name: c.full_name || 'Unknown', role: c.role_on_site || '', confirmed: c.status === 'confirmed', bcStatus: c.status })),
      allVehicles: booking.vehicles,
      dockets: booking.dockets || [],
      documents: booking.documents || [],
      activity: booking.activity || [],
      requirements: booking.requirements || [],
      equipment: booking.equipment || [] },
    allCrew,
    // Exclude equipment rows already reconciled against the Fleet
    // register — they show up via allFleet instead. Falls back to the
    // unfiltered query if the column doesn't exist yet (legacy DB).
    allEquipment: (() => { try {
      try {
        return getDb().prepare("SELECT id, name as asset_name, category FROM equipment WHERE active = 1 AND fleet_vehicle_id IS NULL ORDER BY name").all();
      } catch (e) {
        return getDb().prepare("SELECT id, name as asset_name, category FROM equipment WHERE active = 1 ORDER BY name").all();
      }
    } catch(e) { return []; } })(),
    // Active Fleet vehicles available for the "Add vehicle" picker. Retired
    // / Verify rows are excluded so allocators don't accidentally pick a
    // duplicate-VIN sheet that's flagged for reconciliation.
    allFleet: (() => { try { return getDb().prepare(`
      SELECT id, asset_id, rego, COALESCE(NULLIF(TRIM(make || ' ' || model), ''), asset_id) AS label, vehicle_type, status
      FROM vehicles WHERE status IN ('Active','Spare') ORDER BY asset_id
    `).all(); } catch(e) { return []; } })(),
    user: req.session.user,
    jobPackGrid,
    jobPackTypes: JP_TYPES,
    shiftTasks: (() => {
      try {
        return db.prepare(`
          SELECT st.*, cm.full_name AS assignee_name, cm.portal_role AS assignee_portal_role,
                 u.full_name AS created_by_name
          FROM shift_tasks st
          JOIN crew_members cm ON st.crew_member_id = cm.id
          LEFT JOIN users u ON st.created_by_user_id = u.id
          WHERE st.booking_id = ?
          ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
                   CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                   st.due_at ASC, st.created_at ASC
        `).all(booking.id);
      } catch (e) { return []; }
    })(),
  });
});

// GET /:id/edit
router.get('/:id/edit', (req, res) => {
  const db = getDb(); const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  if (booking.start_datetime) { const p = booking.start_datetime.split('T'); booking.start_date = p[0]; booking.start_time = (p[1] || '').substring(0, 5); }
  if (booking.end_datetime) { const p = booking.end_datetime.split('T'); booking.end_date = p[0]; booking.end_time = (p[1] || '').substring(0, 5); }
  // Parse JSON fields for the form
  try { booking.site_contacts_arr = JSON.parse(booking.site_contacts || '[]'); } catch (e) { booking.site_contacts_arr = []; }
  try { booking.booking_tags_str = JSON.parse(booking.booking_tags || '[]').join(', '); } catch (e) { booking.booking_tags_str = ''; }
  // Load requirements for the grid
  let requirements = []; try { requirements = db.prepare("SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id = ?").all(req.params.id); } catch (e) {}
  booking.requirements = requirements;
  const jobs = db.prepare("SELECT id, job_number, job_name, client FROM jobs WHERE status NOT IN ('closed','completed') ORDER BY job_name").all();
  let clients = []; try { clients = db.prepare("SELECT id, company_name FROM clients ORDER BY company_name").all(); } catch (e) {}
  const supervisors = db.prepare("SELECT id, full_name FROM crew_members WHERE active = 1 ORDER BY full_name").all();
  let contacts = []; try { contacts = db.prepare("SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name").all(); } catch (e) {}
  let crewForSelect = []; try { crewForSelect = db.prepare("SELECT id, full_name, role, portal_role FROM crew_members WHERE active = 1 ORDER BY full_name").all(); } catch (e) {}
  // Existing booking-level documents — feeds the Site Documents card on
  // the edit page so allocators can review / delete / upload without
  // bouncing back to the booking detail page.
  let bookingDocuments = [];
  try {
    bookingDocuments = db.prepare(`
      SELECT bd.id, bd.document_type, bd.title, bd.original_name, bd.file_size, bd.created_at,
             u.full_name AS uploader_name
      FROM booking_documents bd LEFT JOIN users u ON bd.uploaded_by_id = u.id
      WHERE bd.booking_id = ? ORDER BY bd.created_at DESC
    `).all(req.params.id);
  } catch (e) { /* legacy DB without booking_documents */ }
  res.render('bookings/form', {
    title: 'Edit Booking ' + booking.booking_number,
    booking, jobs, clients, supervisors, contacts, crewForSelect,
    depots: getDepots(), user: req.session.user,
    bookingDocuments,
  });
});

// POST /:id — Update
router.post('/:id', (req, res) => {
  const db = getDb(); const existing = db.prepare("SELECT id, booking_number FROM bookings WHERE id = ?").get(req.params.id);
  if (!existing) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  const b = req.body;
  if (!b.title || !b.start_date || !b.start_time || !b.end_date || !b.end_time) { req.flash('error', 'Title and schedule are required.'); return res.redirect('/bookings/' + req.params.id + '/edit'); }
  b.depot_meeting_time = normaliseTimeStr(b.depot_meeting_time);
  b.straight_to_site_time = normaliseTimeStr(b.straight_to_site_time);
  const siteContacts = Array.isArray(b.site_contacts) ? JSON.stringify(b.site_contacts) : (b.site_contacts ? JSON.stringify([b.site_contacts]) : '[]');
  const bookingTags = b.booking_tags ? JSON.stringify(b.booking_tags.split(',').map(t => t.trim()).filter(Boolean)) : '[]';
  db.prepare(`UPDATE bookings SET job_id=?, client_id=?, title=?, description=?, status=?, depot=?, start_datetime=?, end_datetime=?, site_address=?, suburb=?, state=?, postcode=?, order_number=?, billing_code=?, client_contact=?, supervisor_id=?, requirements_text=?, is_emergency=?, is_callout=?, billable=?, notes=?,
    site_contacts=?, depot_meeting_time=?, straight_to_site_time=?, booking_tags=?, latitude=?, longitude=?, marker_is_accurate=?, location_notes=?, worksite_location=?, works_direction=?, chainage_from=?, chainage_to=?, has_mobile_works=?, booking_type=?, is_booking_pool=?, requester_id=?, planner_id=?, location_context=?,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.job_id || null, b.client_id || null, b.title, b.description || '', b.status || 'unconfirmed', b.depot || '', b.start_date + 'T' + b.start_time + ':00', b.end_date + 'T' + b.end_time + ':00', b.site_address || '', b.suburb || '', b.state || '', b.postcode || '', b.order_number || '', b.billing_code || '', b.client_contact || '', b.supervisor_id || null, b.requirements_text || '', b.is_emergency ? 1 : 0, b.is_callout ? 1 : 0, b.billable ? 1 : 0, b.notes || '',
      siteContacts, b.depot_meeting_time || '', b.straight_to_site_time || '', bookingTags,
      b.latitude ? parseFloat(b.latitude) : null, b.longitude ? parseFloat(b.longitude) : null,
      b.marker_is_accurate ? 1 : 0, b.location_notes || '', b.worksite_location || '', b.works_direction || '',
      b.chainage_from || '', b.chainage_to || '', b.has_mobile_works ? 1 : 0,
      b.booking_type || 'regular', b.is_booking_pool ? 1 : 0,
      b.requester_id || null, b.planner_id || null, b.location_context || '',
      req.params.id);

  // Update requirements grid — delete existing, re-insert from form
  db.prepare("DELETE FROM booking_requirements WHERE booking_id = ?").run(req.params.id);
  const reqTypes = Array.isArray(b.req_resource_type) ? b.req_resource_type : (b.req_resource_type ? [b.req_resource_type] : []);
  const reqQtys = Array.isArray(b.req_quantity) ? b.req_quantity : (b.req_quantity ? [b.req_quantity] : []);
  const insertReq = db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)");
  for (let i = 0; i < reqTypes.length; i++) {
    if (reqTypes[i] && reqQtys[i] && parseInt(reqQtys[i]) > 0) {
      insertReq.run(req.params.id, reqTypes[i], parseInt(reqQtys[i]));
    }
  }
  syncTCCrewVehicles(db, req.params.id);

  // Update crew assignments — but ONLY when the form actually contained a
  // crew picker. Without the explicit `crew_ids_present` flag we leave the
  // existing booking_crew rows alone, because absence of crew_ids[] on a
  // POST is ambiguous: it could mean "no crew picker on the form" (full
  // edit page) OR "user removed every crew chip on the slide-in panel".
  // The slide-in form sets crew_ids_present=1 unconditionally, the full
  // edit page does not include a crew picker so the flag stays absent.
  // Result: editing details on the full edit page no longer accidentally
  // wipes the crew, AND clearing every chip on the slide-in still works.
  const crewPickerSubmitted = b.crew_ids_present === '1' || b.crew_ids_present === 1 || b.crew_ids_present === true;
  if (crewPickerSubmitted) {
    const crewIds = Array.isArray(b.crew_ids) ? b.crew_ids : (b.crew_ids ? [b.crew_ids] : []);
    db.prepare("DELETE FROM booking_crew WHERE booking_id = ?").run(req.params.id);
    db.prepare("DELETE FROM crew_allocations WHERE booking_id = ?").run(req.params.id);
    if (crewIds.length > 0) {
      const insertCrew = db.prepare("INSERT OR IGNORE INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')");
      const insertAlloc = db.prepare("INSERT OR IGNORE INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id, allocated_by_id) VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?)");
      const updAllocDate = (b.start_date + 'T' + b.start_time + ':00').substring(0, 10);
      const updAllocStart = b.start_time || '06:00';
      const updAllocEnd = b.end_time || '15:00';
      const VALID_SITE_ROLES = ['traffic_controller','team_leader','supervisor'];
      function pickSiteRole(cid, fallback) {
        const raw = b['crew_role_' + cid];
        if (raw && VALID_SITE_ROLES.includes(raw)) return raw;
        if (fallback && VALID_SITE_ROLES.includes(fallback)) return fallback;
        return 'traffic_controller';
      }
      crewIds.forEach(cid => {
        if (!cid) return;
        // Reject any id that isn't a real, active crew member to stop
        // browser autofill or stale form state assigning shifts to people
        // who aren't on roster.
        const member = db.prepare("SELECT id, role, portal_role, active FROM crew_members WHERE id = ?").get(cid);
        if (!member || !member.active) {
          console.warn('[bookings.update] ignoring crew_id', cid, 'on booking', req.params.id, '— no matching active crew_member');
          return;
        }
        const siteRole = pickSiteRole(cid, member.portal_role);
        insertCrew.run(req.params.id, cid, siteRole);
        if (b.job_id) {
          try { insertAlloc.run(b.job_id, cid, updAllocDate, updAllocStart, updAllocEnd, siteRole, req.params.id, req.session.user.id); } catch (e) {}
        }
      });
    }
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Updated booking ${existing.booking_number}`, req });
  req.flash('success', `Booking ${existing.booking_number} updated.`); res.redirect('/bookings/' + req.params.id);

  // Background geocode — only re-runs if address text might have
  // changed (lat/lng cleared) or marker_is_accurate is false. The
  // helper is conservative: if a user-pinned marker is set, it
  // leaves the coords alone.
  setImmediate(() => { geocodeBookingIfNeeded(req.params.id).catch(() => {}); });
});

// POST /:id/geocode — Force re-geocode of a single booking. Useful
// after the address fields change without an actual save (e.g. when
// importing) or to manually refresh stale coordinates. Returns JSON
// so the booking-detail page can surface the result without a redirect.
router.post('/:id/geocode', async (req, res) => {
  try {
    const result = await geocodeBookingIfNeeded(req.params.id, { force: true });
    if (result) {
      logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Re-geocoded → ${result.lat}, ${result.lng} (${result.city || ''})`, req });
      return res.json({ ok: true, lat: result.lat, lng: result.lng, city: result.city || '' });
    }
    res.json({ ok: false, error: 'Could not geocode address.' });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /:id/status
router.post('/:id/status', (req, res) => {
  const db = getDb(); const newStatus = req.body.status;
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!VALID_STATUSES.includes(newStatus)) { if (isJson) return res.status(400).json({ error: 'Invalid status' }); req.flash('error', 'Invalid status.'); return res.redirect('back'); }
  const existing = db.prepare("SELECT id, booking_number, status FROM bookings WHERE id = ?").get(req.params.id);
  if (!existing) { if (isJson) return res.status(404).json({ error: 'Not found' }); req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  db.prepare("UPDATE bookings SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(newStatus, req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Status: ${existing.status} → ${newStatus} on ${existing.booking_number}`, req });
  if (isJson) return res.json({ ok: true, status: newStatus });
  req.flash('success', `Status updated to ${newStatus.replace(/_/g, ' ')}.`); res.redirect('/bookings/' + req.params.id);
});

// POST /:id/delete — Soft delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const booking = db.prepare("SELECT id, booking_number FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) { if (isJson) return res.status(404).json({ error: 'Not found' }); req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  db.prepare("UPDATE bookings SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'booking', entityId: req.params.id, details: `Soft-deleted ${booking.booking_number}`, req });
  if (isJson) return res.json({ ok: true });
  req.flash('success', `Booking ${booking.booking_number} deleted.`); res.redirect('/bookings');
});

// POST /:id/undelete — Restore soft-deleted booking
router.post('/:id/undelete', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const booking = db.prepare("SELECT id, booking_number FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) { if (isJson) return res.status(404).json({ error: 'Not found' }); req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  db.prepare("UPDATE bookings SET deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Restored ${booking.booking_number}`, req });
  if (isJson) return res.json({ ok: true });
  req.flash('success', `Booking ${booking.booking_number} restored.`); res.redirect('/bookings');
});

// Crew management
router.post('/:id/crew', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) {
    if (isJson) return res.status(404).json({ error: 'Booking not found' });
    req.flash('error', 'Booking not found.'); return res.redirect('/bookings');
  }
  const { crew_member_id, role_on_site } = req.body;
  if (!crew_member_id) {
    if (isJson) return res.status(400).json({ error: 'Select a crew member' });
    req.flash('error', 'Select a crew member.'); return res.redirect('/bookings/' + req.params.id);
  }
  if (db.prepare("SELECT id FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(req.params.id, crew_member_id)) {
    if (isJson) return res.status(409).json({ error: 'Already assigned' });
    req.flash('error', 'Already assigned.'); return res.redirect('/bookings/' + req.params.id);
  }

  // Conflict detection — warn if crew member has overlapping bookings on same date
  const thisBooking = db.prepare("SELECT start_datetime, end_datetime, booking_number FROM bookings WHERE id=?").get(req.params.id);
  if (thisBooking && thisBooking.start_datetime) {
    const bookingDate = thisBooking.start_datetime.substring(0, 10);
    const conflicts = db.prepare(`
      SELECT b.id, b.booking_number, b.start_datetime, b.end_datetime
      FROM booking_crew bc
      JOIN bookings b ON b.id = bc.booking_id
      WHERE bc.crew_member_id = ? AND b.id != ? AND DATE(b.start_datetime) = ?
        AND b.status NOT IN ('cancelled','complete','late_cancellation','finalised')
    `).all(crew_member_id, req.params.id, bookingDate);
    if (conflicts.length > 0) {
      const conflictNums = conflicts.map(c => c.booking_number || `#${c.id}`).join(', ');
      req.flash('warning', `Conflict: this crew member is also assigned to ${conflictNums} on the same date.`);
    }
  }

  // Auto-assign to the booking's first vehicle so new crew render "in the
  // ute" by default. The planner can drag them out via the bookings board
  // if they're actually not riding in it.
  const defaultVehicle = db.prepare("SELECT id FROM booking_vehicles WHERE booking_id = ? ORDER BY id LIMIT 1").get(req.params.id);
  const defaultVehicleId = defaultVehicle ? defaultVehicle.id : null;
  db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status, assigned_vehicle_id) VALUES (?, ?, ?, 'assigned', ?)")
    .run(req.params.id, crew_member_id, role_on_site || '', defaultVehicleId);

  // Auto-create crew_allocation so the worker sees this in their portal
  if (thisBooking && thisBooking.start_datetime) {
    const allocDate = thisBooking.start_datetime.substring(0, 10);
    const startTime = thisBooking.start_datetime.substring(11, 16) || '06:00';
    const endTime = thisBooking.end_datetime ? thisBooking.end_datetime.substring(11, 16) : '15:00';
    const booking = db.prepare("SELECT job_id FROM bookings WHERE id=?").get(req.params.id);
    if (booking && booking.job_id) {
      // Check if allocation already exists
      const existing = db.prepare("SELECT id FROM crew_allocations WHERE booking_id=? AND crew_member_id=?").get(req.params.id, crew_member_id);
      if (!existing) {
        try {
          db.prepare(`INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id, allocated_by_id)
            VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?)`).run(
            booking.job_id, crew_member_id, allocDate, startTime, endTime, role_on_site || '', req.params.id, req.session.user.id);
        } catch (e) { console.error('Auto-create allocation error:', e.message); }
      }
    }
  }

  if (isJson) {
    const cm = db.prepare("SELECT cm.id, cm.full_name, cm.role, COALESCE(e.employment_status,'active') AS employment_status FROM crew_members cm LEFT JOIN employees e ON e.linked_crew_member_id = cm.id WHERE cm.id = ?").get(crew_member_id);
    return res.json({ ok: true, crew: cm });
  }
  req.flash('success', 'Crew member added — they can now see this shift in their portal.'); res.redirect('/bookings/' + req.params.id);
});

// Remove crew from booking + delete matching allocation
// POST /:id/crew/:crewId/flag — Toggle a per-shift flag on a booking_crew
// row. Supports: tl (Team Leader), fa (First Aid), sts (Straight-to-Site),
// nb (Non-Billable). Driver is handled separately via the vehicles route
// (it lives on booking_vehicles, not booking_crew). Returns the new value
// so the popover can update its toggle state without a reload.
router.post('/:id/crew/:crewId/flag', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const FLAG_COLS = { tl: 'is_team_leader', fa: 'is_first_aid', sts: 'straight_to_site', nb: 'non_billable' };
  const flag = String(req.body.flag || '').toLowerCase();
  const col = FLAG_COLS[flag];
  if (!col) {
    if (isJson) return res.status(400).json({ error: 'Unknown flag' });
    req.flash('error', 'Unknown flag.'); return res.redirect('/bookings/' + req.params.id);
  }
  const row = db.prepare("SELECT id, " + col + " AS val FROM booking_crew WHERE id = ? AND booking_id = ?").get(req.params.crewId, req.params.id);
  if (!row) {
    if (isJson) return res.status(404).json({ error: 'Crew row not found' });
    req.flash('error', 'Crew row not found.'); return res.redirect('/bookings/' + req.params.id);
  }
  const next = row.val ? 0 : 1;
  db.prepare("UPDATE booking_crew SET " + col + " = ? WHERE id = ?").run(next, req.params.crewId);
  if (isJson) return res.json({ ok: true, flag: flag, value: next });
  res.redirect('/bookings/' + req.params.id);
});

// POST /:id/crew/:crewId/assign-vehicle — Set (or clear with empty)
// booking_crew.assigned_vehicle_id. Used by the bookings-board drag-drop
// when a worker is dropped onto a vehicle slot (assign) or into the
// crew block's "unassigned" zone (clear).
router.post('/:id/crew/:crewId/assign-vehicle', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const row = db.prepare("SELECT id, crew_member_id, assigned_vehicle_id FROM booking_crew WHERE id = ? AND booking_id = ?").get(req.params.crewId, req.params.id);
  if (!row) {
    if (isJson) return res.status(404).json({ error: 'Crew row not found' });
    req.flash('error', 'Crew row not found.'); return res.redirect('/bookings/' + req.params.id);
  }
  const raw = req.body.vehicle_id;
  let vehicleId = null;
  if (raw !== undefined && raw !== '' && raw !== null && raw !== '0') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Verify the vehicle belongs to this booking.
      const ok = db.prepare("SELECT 1 FROM booking_vehicles WHERE id = ? AND booking_id = ?").get(parsed, req.params.id);
      if (!ok) {
        if (isJson) return res.status(400).json({ error: "Vehicle isn't on this booking" });
        req.flash('error', 'Vehicle is not on this booking.'); return res.redirect('/bookings/' + req.params.id);
      }
      vehicleId = parsed;
    }
  }
  db.prepare("UPDATE booking_crew SET assigned_vehicle_id = ? WHERE id = ?").run(vehicleId, req.params.crewId);

  // If the worker just left a vehicle they were driving, clear the
  // driver pointer on that vehicle so the data doesn't drift —
  // booking_vehicles.crew_member_id should always point at someone
  // who's actually IN the vehicle.
  if (row.assigned_vehicle_id != null && row.assigned_vehicle_id !== vehicleId) {
    db.prepare("UPDATE booking_vehicles SET crew_member_id = NULL WHERE id = ? AND crew_member_id = ?")
      .run(row.assigned_vehicle_id, row.crew_member_id);
  }

  if (isJson) return res.json({ ok: true, assigned_vehicle_id: vehicleId });
  res.redirect('/bookings/' + req.params.id);
});

// POST /:id/crew/:crewId/driver — Mark this crew member as the driver
// of the booking's first vehicle (the planner can refine vehicle choice
// later from the booking detail). If they're already the driver, the
// flag clears. Driver lives on booking_vehicles.crew_member_id.
router.post('/:id/crew/:crewId/driver', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const crew = db.prepare("SELECT crew_member_id FROM booking_crew WHERE id = ? AND booking_id = ?").get(req.params.crewId, req.params.id);
  if (!crew) {
    if (isJson) return res.status(404).json({ error: 'Crew row not found' });
    req.flash('error', 'Crew row not found.'); return res.redirect('/bookings/' + req.params.id);
  }
  // Find a vehicle on this booking (the first one) to attach the driver to.
  const veh = db.prepare("SELECT id, crew_member_id FROM booking_vehicles WHERE booking_id = ? ORDER BY id LIMIT 1").get(req.params.id);
  if (!veh) {
    if (isJson) return res.status(400).json({ error: 'No vehicle on this booking to drive.' });
    req.flash('error', 'Add a vehicle first, then assign the driver.'); return res.redirect('/bookings/' + req.params.id);
  }
  const isCurrent = veh.crew_member_id == crew.crew_member_id;
  db.prepare("UPDATE booking_vehicles SET crew_member_id = ? WHERE id = ?").run(isCurrent ? null : crew.crew_member_id, veh.id);
  if (isJson) return res.json({ ok: true, value: isCurrent ? 0 : 1 });
  res.redirect('/bookings/' + req.params.id);
});

router.post('/:id/crew/:crewId/remove', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  db.prepare("DELETE FROM booking_crew WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  db.prepare("DELETE FROM crew_allocations WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  // Also clear them as driver on any vehicles on this booking
  db.prepare("UPDATE booking_vehicles SET crew_member_id = NULL WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  if (isJson) return res.json({ ok: true });
  req.flash('success', 'Removed from booking and worker portal.');
  res.redirect('/bookings/' + req.params.id);
});

// Confirm crew assignment
router.post('/:id/crew/:crewId/confirm', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  db.prepare("UPDATE booking_crew SET status='confirmed', confirmed_at=CURRENT_TIMESTAMP WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  db.prepare("UPDATE crew_allocations SET status='confirmed', confirmed_at=CURRENT_TIMESTAMP WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  if (isJson) return res.json({ ok: true });
  req.flash('success', 'Confirmed.');
  res.redirect('/bookings/' + req.params.id);
});

// Notes
router.post('/:id/notes', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) { if (isJson) return res.status(404).json({ error: 'Not found' }); req.flash('error', 'Not found.'); return res.redirect('/bookings'); }
  const { content, is_private } = req.body;
  if (!content || !content.trim()) { if (isJson) return res.status(400).json({ error: 'Content required' }); req.flash('error', 'Content required.'); return res.redirect('/bookings/' + req.params.id); }
  const result = db.prepare("INSERT INTO booking_notes (booking_id, user_id, content, is_private) VALUES (?, ?, ?, ?)").run(req.params.id, req.session.user.id, content.trim(), is_private ? 1 : 0);
  if (isJson) return res.json({ ok: true, id: result.lastInsertRowid, author_name: req.session.user.full_name, content: content.trim(), created_at: new Date().toISOString() });
  req.flash('success', 'Note added.'); res.redirect('/bookings/' + req.params.id);
});
router.post('/:id/notes/:noteId/delete', (req, res) => { getDb().prepare("DELETE FROM booking_notes WHERE id=? AND booking_id=?").run(req.params.noteId, req.params.id); req.flash('success', 'Deleted.'); res.redirect('/bookings/' + req.params.id); });

// Vehicles
// POST /:id/vehicles/:vehicleId/driver — assign or clear the driver
router.post('/:id/vehicles/:vehicleId/driver', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const cid = req.body.crew_member_id || null;
  if (cid) {
    // Driver must be on this booking — block stray assignments.
    const ok = db.prepare("SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(req.params.id, cid);
    if (!ok) {
      if (isJson) return res.status(400).json({ error: "Driver isn't on the booking crew" });
      req.flash('error', "Driver isn't on the booking crew.");
      return res.redirect('/bookings/' + req.params.id);
    }
  }
  db.prepare("UPDATE booking_vehicles SET crew_member_id = ? WHERE id = ? AND booking_id = ?")
    .run(cid, req.params.vehicleId, req.params.id);
  if (isJson) {
    const driver = cid ? db.prepare("SELECT id, full_name FROM crew_members WHERE id = ?").get(cid) : null;
    return res.json({ ok: true, driver });
  }
  req.flash('success', cid ? 'Driver assigned.' : 'Driver cleared.');
  res.redirect('/bookings/' + req.params.id);
});

router.post('/:id/vehicles', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) {
    if (isJson) return res.status(404).json({ error: 'Booking not found' });
    req.flash('error', 'Not found.'); return res.redirect('/bookings');
  }
  // Resource Panel drag / picker: either a fleet_vehicle_id (Fleet
  // register, preferred for utes/trucks) or an equipment_id (the legacy
  // equipment register, still used for VMS / lighting that lives there).
  let vehicle_name = req.body.vehicle_name || '';
  let registration = req.body.registration || '';
  let fleet_vehicle_id = parseInt(req.body.fleet_vehicle_id, 10);
  if (!Number.isFinite(fleet_vehicle_id) || fleet_vehicle_id <= 0) fleet_vehicle_id = null;
  if (fleet_vehicle_id) {
    try {
      const fv = db.prepare("SELECT asset_id, rego, make, model FROM vehicles WHERE id = ?").get(fleet_vehicle_id);
      if (fv) {
        if (!vehicle_name) vehicle_name = [fv.make, fv.model].filter(Boolean).join(' ') || fv.asset_id;
        if (!registration && fv.rego) registration = fv.rego;
      } else {
        fleet_vehicle_id = null; // bogus id — ignore the link
      }
    } catch (e) { fleet_vehicle_id = null; }
  }
  const equipment_id = parseInt(req.body.equipment_id, 10);
  if (!fleet_vehicle_id && equipment_id) {
    try {
      const eq = db.prepare("SELECT name, licence_plate FROM equipment WHERE id = ?").get(equipment_id);
      if (eq) { if (!vehicle_name) vehicle_name = eq.name; if (!registration && eq.licence_plate) registration = eq.licence_plate; }
    } catch (e) {}
  }
  if (!vehicle_name && !registration) {
    if (isJson) return res.status(400).json({ error: 'Name or rego required' });
    req.flash('error', 'Name or rego required.'); return res.redirect('/bookings/' + req.params.id);
  }
  // If there's an empty placeholder (no name & no rego, vehicle_role=ute),
  // upgrade it rather than appending another row — keeps the ute count
  // matching the requirement.
  let upgraded = false;
  if (req.body.upgrade_placeholder !== '0') {
    const placeholder = db.prepare("SELECT id FROM booking_vehicles WHERE booking_id = ? AND (vehicle_name IS NULL OR vehicle_name = '') AND (registration IS NULL OR registration = '') ORDER BY id LIMIT 1").get(req.params.id);
    if (placeholder) {
      db.prepare("UPDATE booking_vehicles SET vehicle_name = ?, registration = ?, vehicle_role = COALESCE(NULLIF(?, ''), vehicle_role), fleet_vehicle_id = ? WHERE id = ?")
        .run(vehicle_name, registration, req.body.vehicle_role || '', fleet_vehicle_id, placeholder.id);
      upgraded = placeholder.id;
    }
  }
  let driverId = null;
  if (req.body.crew_member_id) {
    const ok = db.prepare("SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(req.params.id, req.body.crew_member_id);
    if (ok) driverId = req.body.crew_member_id;
  }
  let newId = upgraded;
  if (!upgraded) {
    const r = db.prepare(`
      INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, vehicle_role, crew_member_id, fleet_vehicle_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.params.id, vehicle_name, registration, req.body.vehicle_role || '', driverId, fleet_vehicle_id);
    newId = r.lastInsertRowid;
  }
  if (isJson) return res.json({ ok: true, id: newId, upgraded: !!upgraded });
  req.flash('success', upgraded ? 'Vehicle assigned.' : 'Vehicle added.');
  res.redirect('/bookings/' + req.params.id);
});
router.post('/:id/vehicles/:vehicleId/remove', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  db.prepare("DELETE FROM booking_vehicles WHERE id=? AND booking_id=?").run(req.params.vehicleId, req.params.id);
  if (isJson) return res.json({ ok: true });
  req.flash('success', 'Removed.'); res.redirect('/bookings/' + req.params.id);
});

// ===========================================================================
// DOCKETS
// ===========================================================================

function generateDocketNumber(db) {
  const last = db.prepare("SELECT docket_number FROM booking_dockets ORDER BY id DESC LIMIT 1").get();
  let n = 1;
  if (last && last.docket_number) { const num = parseInt(last.docket_number.replace('DK-', ''), 10); if (!isNaN(num)) n = num + 1; }
  return 'DK-' + String(n).padStart(4, '0');
}

// POST /:id/dockets — Create new docket
router.post('/:id/dockets', (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }

  const docketNumber = generateDocketNumber(db);
  const result = db.prepare(`
    INSERT INTO booking_dockets (booking_id, docket_number, status, site_address, created_by_id)
    VALUES (?, ?, 'draft', ?, ?)
  `).run(req.params.id, docketNumber, booking.site_address || '', req.session.user.id);

  // Auto-add all booking crew as time entries
  const crew = db.prepare("SELECT bc.crew_member_id FROM booking_crew bc WHERE bc.booking_id = ?").all(req.params.id);
  const insertTime = db.prepare("INSERT INTO docket_time_entries (docket_id, crew_member_id, start_on_site, finish_on_site) VALUES (?, ?, ?, ?)");
  crew.forEach(c => {
    insertTime.run(result.lastInsertRowid, c.crew_member_id, booking.start_datetime, booking.end_datetime);
  });

  req.flash('success', `Docket ${docketNumber} created.`);
  res.redirect('/bookings/' + req.params.id + '/dockets/' + result.lastInsertRowid);
});

// GET /:id/dockets/:docketId — View/edit docket
router.get('/:id/dockets/:docketId', (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }

  const docket = db.prepare("SELECT * FROM booking_dockets WHERE id = ? AND booking_id = ?").get(req.params.docketId, req.params.id);
  if (!docket) { req.flash('error', 'Docket not found.'); return res.redirect('/bookings/' + req.params.id); }

  const timeEntries = db.prepare(`
    SELECT te.*, cm.full_name, cm.role as crew_role, cm.employee_id
    FROM docket_time_entries te
    LEFT JOIN crew_members cm ON cm.id = te.crew_member_id
    WHERE te.docket_id = ?
    ORDER BY cm.full_name
  `).all(docket.id);

  // Compute totals
  timeEntries.forEach(te => {
    if (te.start_on_site && te.finish_on_site) {
      const start = new Date(te.start_on_site);
      const end = new Date(te.finish_on_site);
      const diffHours = (end - start) / (1000 * 60 * 60);
      te.total_hours = Math.max(0, diffHours - (te.first_break || 0)).toFixed(2);
    }
  });

  const allCrew = db.prepare("SELECT id, full_name, role, employee_id FROM crew_members WHERE active = 1 ORDER BY full_name").all();

  res.render('bookings/docket', {
    title: 'Docket ' + docket.docket_number,
    booking, docket, timeEntries, allCrew,
    user: req.session.user,
  });
});

// POST /:id/dockets/:docketId — Update docket details
router.post('/:id/dockets/:docketId', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    UPDATE booking_dockets SET physical_docket_number=?, client_billing_ref=?, bill_from=?,
      site_address=?, notes=?, private_notes=?, client_feedback=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND booking_id=?
  `).run(b.physical_docket_number || '', b.client_billing_ref || '', b.bill_from || '',
    b.site_address || '', b.notes || '', b.private_notes || '', b.client_feedback || '',
    req.params.docketId, req.params.id);
  req.flash('success', 'Docket updated.');
  res.redirect('/bookings/' + req.params.id + '/dockets/' + req.params.docketId);
});

// POST /:id/dockets/:docketId/time — Add time entry
router.post('/:id/dockets/:docketId/time', (req, res) => {
  const db = getDb();
  const b = req.body;
  if (!b.crew_member_id) { req.flash('error', 'Select a crew member.'); return res.redirect('/bookings/' + req.params.id + '/dockets/' + req.params.docketId); }
  db.prepare("INSERT INTO docket_time_entries (docket_id, crew_member_id, start_on_site, finish_on_site) VALUES (?, ?, ?, ?)")
    .run(req.params.docketId, b.crew_member_id, b.start_on_site || null, b.finish_on_site || null);
  req.flash('success', 'Crew member added to docket.');
  res.redirect('/bookings/' + req.params.id + '/dockets/' + req.params.docketId);
});

// POST /:id/dockets/:docketId/time/:timeId — Update time entry
router.post('/:id/dockets/:docketId/time/:timeId', (req, res) => {
  const db = getDb();
  const b = req.body;
  db.prepare(`
    UPDATE docket_time_entries SET start_on_site=?, finish_on_site=?, first_break=?, first_break_at=?, travel=?, lafha=?, notes=?
    WHERE id=? AND docket_id=?
  `).run(b.start_on_site || null, b.finish_on_site || null, parseFloat(b.first_break) || 0,
    b.first_break_at || '', parseFloat(b.travel) || 0, b.lafha ? 1 : 0, b.notes || '',
    req.params.timeId, req.params.docketId);
  req.flash('success', 'Time entry updated.');
  res.redirect('/bookings/' + req.params.id + '/dockets/' + req.params.docketId);
});

// POST /:id/dockets/:docketId/time/:timeId/remove — Remove time entry
router.post('/:id/dockets/:docketId/time/:timeId/remove', (req, res) => {
  getDb().prepare("DELETE FROM docket_time_entries WHERE id=? AND docket_id=?").run(req.params.timeId, req.params.docketId);
  req.flash('success', 'Removed.');
  res.redirect('/bookings/' + req.params.id + '/dockets/' + req.params.docketId);
});

// POST /:id/dockets/:docketId/sign — Save signature
router.post('/:id/dockets/:docketId/sign', (req, res) => {
  const db = getDb();
  const { type, signature, name } = req.body;
  if (!signature) return res.status(400).json({ error: 'No signature data' });

  if (type === 'worker') {
    db.prepare("UPDATE booking_dockets SET worker_signature=?, worker_signed_name=?, worker_signed_at=CURRENT_TIMESTAMP, status='pending_signoff', updated_at=CURRENT_TIMESTAMP WHERE id=? AND booking_id=?")
      .run(signature, name || '', req.params.docketId, req.params.id);
  } else if (type === 'client') {
    db.prepare("UPDATE booking_dockets SET client_signature=?, client_signed_name=?, client_signed_at=CURRENT_TIMESTAMP, status='signed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND booking_id=?")
      .run(signature, name || '', req.params.docketId, req.params.id);
  }
  res.json({ ok: true });
});

// POST /:id/dockets/:docketId/delete — Delete docket
router.post('/:id/dockets/:docketId/delete', (req, res) => {
  getDb().prepare("DELETE FROM booking_dockets WHERE id=? AND booking_id=?").run(req.params.docketId, req.params.id);
  req.flash('success', 'Docket deleted.');
  res.redirect('/bookings/' + req.params.id);
});

// ===========================================================================
// DOCUMENTS
// ===========================================================================

// POST /:id/documents — Upload document
router.post('/:id/documents', uploadDoc.single('file'), (req, res) => {
  const db = getDb();
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  if (!req.file) { req.flash('error', 'No file selected.'); return res.redirect('/bookings/' + req.params.id); }
  const b = req.body;
  db.prepare(`
    INSERT INTO booking_documents (booking_id, document_type, title, description, filename, original_name, file_path, file_size, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, b.document_type || 'other', b.title || req.file.originalname, b.description || '',
    req.file.filename, req.file.originalname, req.file.path, req.file.size, req.session.user.id);
  logActivity({ user: req.session.user, action: 'create', entityType: 'booking_document', entityId: req.params.id, details: `Uploaded ${req.file.originalname}`, req });
  req.flash('success', 'Document uploaded.');
  res.redirect('/bookings/' + req.params.id);
});

// GET /:id/documents/:docId/download — Download document
router.get('/:id/documents/:docId/download', (req, res) => {
  const doc = getDb().prepare("SELECT * FROM booking_documents WHERE id=? AND booking_id=?").get(req.params.docId, req.params.id);
  if (!doc || !fs.existsSync(doc.file_path)) { req.flash('error', 'File not found.'); return res.redirect('/bookings/' + req.params.id); }
  res.download(doc.file_path, doc.original_name);
});

// POST /:id/documents/:docId/delete — Delete document
router.post('/:id/documents/:docId/delete', (req, res) => {
  const db = getDb();
  const doc = db.prepare("SELECT * FROM booking_documents WHERE id=? AND booking_id=?").get(req.params.docId, req.params.id);
  if (doc && doc.file_path && fs.existsSync(doc.file_path)) { try { fs.unlinkSync(doc.file_path); } catch(e) {} }
  db.prepare("DELETE FROM booking_documents WHERE id=? AND booking_id=?").run(req.params.docId, req.params.id);
  req.flash('success', 'Document deleted.');
  res.redirect('/bookings/' + req.params.id);
});

// ===========================================================================
// REQUIREMENTS (resource quantities)
// ===========================================================================
router.post('/:id/requirements', (req, res) => {
  const db = getDb();
  const { resource_type, quantity_required } = req.body;
  if (!resource_type) { req.flash('error', 'Select a resource type.'); return res.redirect('/bookings/' + req.params.id); }
  db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)")
    .run(req.params.id, resource_type, parseInt(quantity_required) || 1);
  syncTCCrewVehicles(db, req.params.id);
  req.flash('success', 'Requirement added.');
  res.redirect('/bookings/' + req.params.id);
});

router.post('/:id/requirements/:reqId/delete', (req, res) => {
  getDb().prepare("DELETE FROM booking_requirements WHERE id=? AND booking_id=?").run(req.params.reqId, req.params.id);
  req.flash('success', 'Requirement removed.');
  res.redirect('/bookings/' + req.params.id);
});

// ===========================================================================
// EQUIPMENT assignments
// ===========================================================================
router.post('/:id/equipment', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const b = req.body;
  let newId = null;
  if (b.equipment_id) {
    const eq = db.prepare("SELECT * FROM equipment WHERE id = ?").get(b.equipment_id);
    if (eq) {
      const r = db.prepare("INSERT INTO booking_equipment (booking_id, equipment_id, equipment_name, equipment_type, quantity) VALUES (?, ?, ?, ?, ?)")
        .run(req.params.id, eq.id, eq.name || eq.asset_name || '', eq.category || '', parseInt(b.quantity) || 1);
      newId = r.lastInsertRowid;
    }
  } else if (b.equipment_name) {
    const r = db.prepare("INSERT INTO booking_equipment (booking_id, equipment_name, equipment_type, quantity) VALUES (?, ?, ?, ?)")
      .run(req.params.id, b.equipment_name, b.equipment_type || '', parseInt(b.quantity) || 1);
    newId = r.lastInsertRowid;
  }
  if (isJson) return res.json({ ok: true, id: newId });
  req.flash('success', 'Equipment added.');
  res.redirect('/bookings/' + req.params.id);
});

router.post('/:id/equipment/:eqId/remove', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  db.prepare("DELETE FROM booking_equipment WHERE id=? AND booking_id=?").run(req.params.eqId, req.params.id);
  if (isJson) return res.json({ ok: true });
  req.flash('success', 'Equipment removed.');
  res.redirect('/bookings/' + req.params.id);
});

// Move booking to new date (drag-and-drop from calendar)
router.post('/:id/move', (req, res) => {
  const db = getDb();
  const booking = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  if (!booking) return res.status(404).json({ error: 'Not found' });

  const newDate = req.body.new_date;
  if (!newDate) return res.status(400).json({ error: 'Missing new_date' });

  // Keep the same times, just change the date
  const oldStartTime = booking.start_datetime ? booking.start_datetime.split('T')[1] : '06:00:00';
  const oldEndTime = booking.end_datetime ? booking.end_datetime.split('T')[1] : '14:30:00';

  db.prepare("UPDATE bookings SET start_datetime = ?, end_datetime = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(newDate + 'T' + oldStartTime, newDate + 'T' + oldEndTime, req.params.id);

  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Moved booking ${booking.booking_number} to ${newDate}`, req });
  res.json({ ok: true });
});

// Clone
router.post('/:id/clone', (req, res) => {
  const db = getDb(); const source = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!source) { if (isJson) return res.status(404).json({ error: 'Not found' }); req.flash('error', 'Not found.'); return res.redirect('/bookings'); }
  const bookingNumber = generateBookingNumber(db);
  function addDay(dt) { if (!dt) return dt; const d = new Date(dt); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${(dt.split('T')[1] || '00:00:00')}`; }
  const result = db.prepare(`INSERT INTO bookings (booking_number, job_id, client_id, title, description, status, depot, start_datetime, end_datetime, site_address, suburb, state, postcode, order_number, billing_code, client_contact, supervisor_id, requirements_text, is_emergency, is_callout, billable, invoiced, notes, created_by_id,
    site_contacts, depot_meeting_time, straight_to_site_time, booking_tags, latitude, longitude, marker_is_accurate, location_notes, worksite_location, works_direction, chainage_from, chainage_to, has_mobile_works, booking_type, is_booking_pool, requester_id, planner_id, location_context)
    VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    bookingNumber, source.job_id, source.client_id, source.title, source.description, source.depot, addDay(source.start_datetime), addDay(source.end_datetime),
    source.site_address, source.suburb, source.state, source.postcode, source.order_number, source.billing_code, source.client_contact, source.supervisor_id,
    source.requirements_text, source.is_emergency, source.is_callout, source.billable, source.notes, req.session.user.id,
    source.site_contacts || '[]', source.depot_meeting_time || '', source.straight_to_site_time || '', source.booking_tags || '[]',
    source.latitude, source.longitude, source.marker_is_accurate || 0, source.location_notes || '', source.worksite_location || '', source.works_direction || '',
    source.chainage_from || '', source.chainage_to || '', source.has_mobile_works || 0, source.booking_type || 'regular', source.is_booking_pool || 0,
    source.requester_id, source.planner_id, source.location_context || '');
  const newId = result.lastInsertRowid;
  for (const c of db.prepare("SELECT crew_member_id, role_on_site FROM booking_crew WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')").run(newId, c.crew_member_id, c.role_on_site);
  for (const v of db.prepare("SELECT vehicle_name, registration, notes FROM booking_vehicles WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, notes) VALUES (?, ?, ?, ?)").run(newId, v.vehicle_name, v.registration, v.notes);
  try { for (const r of db.prepare("SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)").run(newId, r.resource_type, r.quantity_required); } catch(e) {}
  logActivity({ user: req.session.user, action: 'create', entityType: 'booking', entityId: newId, details: `Cloned ${source.booking_number} → ${bookingNumber}`, req });
  if (isJson) return res.json({ ok: true, id: newId, booking_number: bookingNumber });
  req.flash('success', `Cloned as ${bookingNumber}.`); res.redirect('/bookings/' + newId);
});

// =============================================
// Shift Tasks (Operations)
// Allocators add per-crew tasks to a booking. Workers see them on their
// shift detail page; TLs / Supervisors see the whole crew's tasks.
// =============================================

// POST /:id/tasks — create
router.post('/:id/tasks', (req, res) => {
  const db = getDb();
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) {
    req.flash('error', 'Booking not found.');
    return res.redirect('/bookings');
  }
  const { crew_member_id, title, description, priority, due_at } = req.body;
  if (!crew_member_id || !title || !title.trim()) {
    req.flash('error', 'Title and assignee are required.');
    return res.redirect('/bookings/' + req.params.id);
  }
  // Assignee must be on this booking — block cross-booking task drops.
  const ok = db.prepare("SELECT 1 FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(req.params.id, crew_member_id);
  if (!ok) {
    req.flash('error', "Worker isn't on this booking.");
    return res.redirect('/bookings/' + req.params.id);
  }
  // Use the matching crew_allocations row (if one exists) so the task
  // survives if the booking gets unbound from a worker later.
  const alloc = db.prepare("SELECT id FROM crew_allocations WHERE booking_id=? AND crew_member_id=? LIMIT 1").get(req.params.id, crew_member_id);
  db.prepare(`
    INSERT INTO shift_tasks (allocation_id, booking_id, crew_member_id, title, description, priority, due_at, created_by_user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    alloc ? alloc.id : null,
    req.params.id,
    crew_member_id,
    title.trim(),
    (description || '').trim(),
    ['low','normal','high'].includes(priority) ? priority : 'normal',
    due_at || null,
    req.session.user.id
  );
  req.flash('success', 'Task added.');
  res.redirect('/bookings/' + req.params.id + '#tasks');
});

// POST /:id/tasks/:taskId/delete
router.post('/:id/tasks/:taskId/delete', (req, res) => {
  getDb().prepare("DELETE FROM shift_tasks WHERE id=? AND booking_id=?").run(req.params.taskId, req.params.id);
  req.flash('success', 'Task removed.');
  res.redirect('/bookings/' + req.params.id + '#tasks');
});

// POST /:id/tasks/:taskId/status — toggle status (admin override)
router.post('/:id/tasks/:taskId/status', (req, res) => {
  const status = ['pending','done','cancelled'].includes(req.body.status) ? req.body.status : 'pending';
  const completedAt = status === 'done' ? "datetime('now')" : 'NULL';
  getDb().prepare(`
    UPDATE shift_tasks
    SET status = ?, completed_at = ${completedAt}, updated_at = datetime('now')
    WHERE id = ? AND booking_id = ?
  `).run(status, req.params.taskId, req.params.id);
  res.redirect('/bookings/' + req.params.id + '#tasks');
});

module.exports = router;
