const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { requireRole } = require('../middleware/auth');
const { TERMINAL_STATUSES, syncAllocationsToBooking, cascadeCancel, cascadeRestore, diffCrew, autoAdvanceOngoing } = require('../lib/bookingLifecycle');
const { getDocketCrew } = require('../lib/shiftDocket');
const { getConfig } = require('../middleware/settings');
const bookingNotify = require('../services/bookingNotify');

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
// 1 ute (1 ute per package, regardless of crew size N). Standalone
// "Traffic Controller" add-on rows carry NO ute. After requirements are
// saved we reconcile the ute-role placeholder rows so the count follows
// the crew packages: add blank placeholders when we're short, and drop
// surplus *placeholder* rows when we're over. A ute is PROTECTED (never
// deleted) when it has a driver (crew_member_id), a fleet vehicle
// (fleet_vehicle_id), or a typed name/rego — those are real allocations
// the office set up by hand. Surplus protected utes are simply kept.
function syncTCCrewVehicles(db, bookingId) {
  try {
    const reqs = db.prepare("SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id = ?").all(bookingId);
    let target = 0;
    for (const r of reqs) {
      // Match "Nx TC Crew" — 1 ute per package, multiplied by qty. The
      // crew size N is irrelevant to ute count. Standalone "Traffic
      // Controller" rows don't match here, so they add no ute.
      const m = /^(\d+)x TC Crew$/.exec(r.resource_type || '');
      if (m) target += (parseInt(r.quantity_required) || 0);
    }
    const utes = db.prepare("SELECT id, vehicle_name, registration, crew_member_id, fleet_vehicle_id FROM booking_vehicles WHERE booking_id = ? AND vehicle_role = 'ute' ORDER BY id").all(bookingId);
    const isProtected = (v) => !!(v.crew_member_id || v.fleet_vehicle_id ||
      (v.vehicle_name && String(v.vehicle_name).trim()) ||
      (v.registration && String(v.registration).trim()));
    const current = utes.length;
    if (current < target) {
      const ins = db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, vehicle_role) VALUES (?, '', '', 'ute')");
      for (let i = 0; i < target - current; i++) ins.run(bookingId);
    } else if (current > target) {
      // Remove only surplus UNPROTECTED placeholders, newest first.
      const removable = utes.filter(v => !isProtected(v)).map(v => v.id).reverse();
      const del = db.prepare("DELETE FROM booking_vehicles WHERE id = ?");
      let toRemove = current - target;
      for (const id of removable) {
        if (toRemove <= 0) break;
        del.run(id); toRemove--;
      }
    }
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
      WHERE bc2.crew_member_id = ? AND bc2.booking_id != ? AND b.status NOT IN ('cancelled','complete','late_cancellation','finalised') AND b.deleted_at IS NULL
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

  const shiftDockets = loadShiftDockets(db, bookingId, crew);

  return { ...row, supervisor_name: supervisorName, internal_notes: row.notes || '', crew, notes, vehicles, dockets, shiftDockets, documents, activity, requirements, equipment: equipmentList, job: jobInfo, client: clientInfo };
}

/**
 * Worker-signed shift dockets for a booking, with crew lines and version chain.
 * Returns:
 *   {
 *     current: { id, signed_at, signer_name, version, ... crew: [{ name, start_on_site, ... }] } | null,
 *     history: [ same shape, ordered newest first, status='superseded' ],
 *     drift: { added: [{crew_member_id, name, role}], removed: [{crew_member_id, name}] }   // booking_crew vs current docket
 *   }
 */
function loadShiftDockets(db, bookingId, bookingCrewRows) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT ds.*, cm.full_name AS signer_name
      FROM docket_signatures ds
      LEFT JOIN crew_members cm ON cm.id = COALESCE(ds.signed_by_crew_id, ds.crew_member_id)
      WHERE ds.booking_id = ?
      ORDER BY COALESCE(ds.version, 1) DESC, ds.id DESC
    `).all(bookingId);
  } catch (e) { return { current: null, history: [], drift: { added: [], removed: [] } }; }

  if (!rows.length) return { current: null, history: [], drift: { added: [], removed: [] } };

  const decorate = (d) => ({
    ...d,
    crew: getDocketCrew(db, d),
  });

  const current = rows.find(r => (r.status || 'current') === 'current') || null;
  const history = rows.filter(r => (r.status || 'current') !== 'current').map(decorate);
  const currentDecorated = current ? decorate(current) : null;

  // Drift: who is on the booking now vs who is on the current docket?
  // Booking_crew is the source of truth for "should be on the docket".
  let added = [], removed = [];
  if (currentDecorated) {
    const onDocket = new Set(currentDecorated.crew.map(c => c.crew_member_id));
    const onBooking = new Set((bookingCrewRows || []).map(c => c.crew_member_id));
    added = (bookingCrewRows || [])
      .filter(c => !onDocket.has(c.crew_member_id))
      .map(c => ({ crew_member_id: c.crew_member_id, name: c.full_name || ('#' + c.crew_member_id), role: c.role_on_site || '' }));
    removed = currentDecorated.crew
      .filter(c => c.crew_member_id && !onBooking.has(c.crew_member_id))
      .map(c => ({ crew_member_id: c.crew_member_id, name: c.name }));
  }

  return { current: currentDecorated, history, drift: { added, removed } };
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
  let contacts = []; try { contacts = db.prepare("SELECT id, full_name, position, phone, mobile, email, company_id FROM client_contacts ORDER BY full_name").all(); } catch (e) {}
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
    let contacts = []; try { contacts = db.prepare("SELECT id, full_name, position, phone, mobile, email, company_id FROM client_contacts ORDER BY full_name").all(); } catch (e) {}
    let crewForSelect = []; try { crewForSelect = db.prepare("SELECT id, full_name, role, portal_role FROM crew_members WHERE active = 1 ORDER BY full_name").all(); } catch (e) {}
    res.render('bookings/form', { title: 'New Booking', booking: null, jobs, clients, supervisors, contacts, crewForSelect, depots: getDepots(), hireableItems: HIREABLE_ITEMS, hireCompanies: getHireCompanies(db), locationContexts: getLocationContexts(db), hireItems: {}, mobileLegs: [], user: req.session.user });
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
  if ((b.end_date + 'T' + b.end_time) <= (b.start_date + 'T' + b.start_time)) { req.flash('error', 'Finish must be after the start — check the dates/times.'); return res.redirect('/bookings/new'); }
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
  try { persistBookingHireItems(db, bookingId, b, req.session.user.id); } catch (e) { console.error('[bookings create] hire items failed:', e.message); }
  try { persistBookingMobileLegs(db, bookingId, b); } catch (e) { console.error('[bookings create] mobile legs failed:', e.message); }
  try { persistMeetingPoint(db, bookingId, b); } catch (e) {}

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

// Standalone people add-ons that should render as assignable (vehicle-less)
// crew slots — resource_type label → short role label. Without this, e.g. a
// "Traffic Controller" or "Spotter" requirement never showed a slot to drop
// people onto (only "Nx TC Crew" did).
const PEOPLE_ADDON_ROLES = {
  'Traffic Controller': 'TC',
  'Spotter': 'Spotter',
  'Hoist Operator': 'Hoist',
  'Labour': 'Labour',
  'Trainee': 'Trainee',
  'Security': 'Security',
};

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
  // Standalone people add-ons → vehicle-less blocks so they show open slots
  // the planner can assign people to. One block per requirement, sized to qty.
  for (const r of (requirementRows || [])) {
    const role = PEOPLE_ADDON_ROLES[String(r.resource_type || '').trim()];
    if (!role) continue;
    const n = Math.max(0, parseInt(r.quantity_required, 10) || 0);
    if (!n) continue;
    blocks.push({
      ordinal: blocks.length + 1,
      size: n,
      role,
      worker_slots: Array.from({ length: n }, () => ({ filled: false })),
      vehicle_slot: null,
      no_vehicle: true,
      addons: [],
    });
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
    if (blk.no_vehicle) continue; // people add-on block — no vehicle slot
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
    if (blk.vehicle_slot && blk.vehicle_slot.vehicle_id) blockByVehicle.set(blk.vehicle_slot.vehicle_id, blk);
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
  // Flip any live shift to "Ongoing" before we render the board.
  try { autoAdvanceOngoing(db); } catch (e) {}
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
          AND b.status NOT IN ('cancelled','late_cancellation','complete','finalised') AND b.deleted_at IS NULL
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
    hireableItems: HIREABLE_ITEMS,
    hireCompanies: getHireCompanies(db),
    locationContexts: getLocationContexts(db),
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

// Overview "Booking Requirements" stepper field → booking_requirements
// resource_type label. Mirrors the grid in views/bookings/board.ejs exactly
// (crew_size_1..5 + the addon_* fields), so the slide-over editor can both
// SAVE the steppers into booking_requirements and PREFILL them back when a
// booking is reopened. Keep this list in sync with that EJS array.
const QUICK_REQ_FIELDS = [
  ['crew_size_1', '1x TC Crew'],
  ['crew_size_2', '2x TC Crew'],
  ['crew_size_3', '3x TC Crew'],
  ['crew_size_4', '4x TC Crew'],
  ['crew_size_5', '5x TC Crew'],
  ['addon_arrow', 'Arrow Board'],
  ['addon_hoist', 'Hoist Operator'],
  ['addon_labour', 'Labour'],
  ['addon_light_tower', 'Light Tower'],
  ['addon_permit', 'Permit'],
  ['addon_pod_truck', 'Pod Truck'],
  ['addon_portaboom', 'Portaboom'],
  ['addon_security', 'Security'],
  ['addon_speed_advisory', 'Speed Advisory Sign'],
  ['addon_spotter', 'Spotter'],
  ['addon_tma_dry', 'TMA (dry hire)'],
  ['addon_tma_wet', 'TMA (wet hire)'],
  ['addon_tmp', 'TMP'],
  ['addon_tmp_tm', 'TMP with Traffic Management'],
  ['addon_tc', 'Traffic Controller'],
  ['addon_tgs', 'Traffic Guidance Scheme'],
  ['addon_trainee', 'Trainee'],
  ['addon_vms_board', 'VMS Board'],
  ['addon_vms_ute', 'VMS Ute'],
  ['addon_vehicle', 'Vehicle'],
];
const QUICK_REQ_LABEL_TO_FIELD = QUICK_REQ_FIELDS.reduce((m, [f, l]) => { m[l] = f; return m; }, {});

// Equipment add-ons that can be hired in from an external supplier — the
// physical gear subset of QUICK_REQ_FIELDS (not people / permits / plans).
// item_key matches the stepper field name so it's stable across the
// delete-and-reinsert of booking_requirements.
const HIREABLE_ITEMS = [
  ['addon_arrow', 'Arrow Board'],
  ['addon_light_tower', 'Light Tower'],
  ['addon_pod_truck', 'Pod Truck'],
  ['addon_portaboom', 'Portaboom'],
  ['addon_speed_advisory', 'Speed Advisory Sign'],
  ['addon_tma_dry', 'TMA (dry hire)'],
  ['addon_tma_wet', 'TMA (wet hire)'],
  ['addon_vms_board', 'VMS Board'],
  ['addon_vms_ute', 'VMS Ute'],
  ['addon_vehicle', 'Vehicle'],
];
const HIREABLE_KEYS = new Set(HIREABLE_ITEMS.map(([k]) => k));

// Pick-lists for the booking forms.
function getHireCompanies(db) {
  try { return db.prepare("SELECT id, name FROM hire_companies WHERE active = 1 ORDER BY name").all(); } catch (e) { return []; }
}
function getLocationContexts(db) {
  try { return db.prepare("SELECT label FROM location_contexts WHERE active = 1 ORDER BY label").all().map(r => r.label); } catch (e) { return []; }
}

// Mobile-works location legs — parallel arrays from the form
// (mobile_leg_start_time[], mobile_leg_address[], mobile_leg_notes[]).
// Delete-then-reinsert. Only writes legs that have at least an address or a
// time. Skips entirely when the form didn't carry the legs at all (so a
// partial POST never wipes existing legs).
function arrify(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }
function persistBookingMobileLegs(db, bookingId, b) {
  var addrs = arrify(b.mobile_leg_address);
  var times = arrify(b.mobile_leg_start_time);
  var notes = arrify(b.mobile_leg_notes);
  // Presence of the mobile-works flag OR any legs field means the block was
  // on the submitted form.
  var hasBlock = b.mobile_works !== undefined || b.has_mobile_works !== undefined
    || b.mobile_leg_address !== undefined || b.mobile_leg_start_time !== undefined;
  if (!hasBlock) return;
  var del = db.prepare('DELETE FROM booking_mobile_legs WHERE booking_id = ?');
  var ins = db.prepare('INSERT INTO booking_mobile_legs (booking_id, seq, start_time, address, notes) VALUES (?, ?, ?, ?, ?)');
  db.transaction(function () {
    del.run(bookingId);
    var n = Math.max(addrs.length, times.length, notes.length);
    var seq = 0;
    for (var i = 0; i < n; i++) {
      var addr = (addrs[i] || '').trim();
      var time = (times[i] || '').trim();
      var note = (notes[i] || '').trim();
      if (!addr && !time && !note) continue;
      ins.run(bookingId, seq++, time, addr, note);
    }
  })();
}
function getMobileLegs(db, bookingId) {
  try { return db.prepare('SELECT seq, start_time, address, notes FROM booking_mobile_legs WHERE booking_id = ? ORDER BY seq, id').all(bookingId); } catch (e) { return []; }
}

// Optional crew meeting point (a map pin distinct from the site pin) + note.
// Only writes when the form actually carried the fields.
function persistMeetingPoint(db, bookingId, b) {
  if (b.meeting_point_latitude === undefined && b.meeting_point_longitude === undefined && b.meeting_point_note === undefined) return;
  var lat = b.meeting_point_latitude ? parseFloat(b.meeting_point_latitude) : null;
  var lng = b.meeting_point_longitude ? parseFloat(b.meeting_point_longitude) : null;
  try {
    db.prepare("UPDATE bookings SET meeting_point_latitude = ?, meeting_point_longitude = ?, meeting_point_note = ? WHERE id = ?")
      .run(isFinite(lat) ? lat : null, isFinite(lng) ? lng : null, b.meeting_point_note || '', bookingId);
  } catch (e) { console.error('[bookings] meeting point save failed:', e.message); }
}

// Resolve a supplier from posted fields: prefer an explicit hire_company_id,
// else a typed company name (find-or-create in hire_companies). Returns
// { hire_company_id, company_name } or null when nothing supplied.
function resolveHireCompany(db, idVal, nameVal, userId) {
  const id = idVal ? parseInt(idVal, 10) : null;
  const name = (nameVal || '').trim();
  if (id) {
    const row = db.prepare('SELECT id, name FROM hire_companies WHERE id = ?').get(id);
    if (row) return { hire_company_id: row.id, company_name: row.name };
  }
  if (name) {
    const ex = db.prepare('SELECT id, name FROM hire_companies WHERE LOWER(name) = LOWER(?)').get(name);
    if (ex) return { hire_company_id: ex.id, company_name: ex.name };
    try {
      const ins = db.prepare("INSERT INTO hire_companies (name, created_by_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(name, userId || null);
      return { hire_company_id: Number(ins.lastInsertRowid), company_name: name };
    } catch (e) { return { hire_company_id: null, company_name: name }; }
  }
  return null;
}

// Persist hired-item → supplier rows for a booking (delete-then-reinsert).
// Per hireable item toggled on (hired_<key>=1), reads supplier from
// supplier_id_<key> / supplier_name_<key>. Only call when the requirements
// grid was actually submitted so partial POSTs never wipe existing rows.
function persistBookingHireItems(db, bookingId, b, userId) {
  const del = db.prepare('DELETE FROM booking_hire_items WHERE booking_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO booking_hire_items (booking_id, item_key, item_label, hire_company_id, company_name) VALUES (?, ?, ?, ?, ?)');
  db.transaction(() => {
    del.run(bookingId);
    for (const [key, label] of HIREABLE_ITEMS) {
      const raw = b['hired_' + key];
      const hired = raw === '1' || raw === 'on' || raw === 'true';
      if (!hired) continue;
      const sup = resolveHireCompany(db, b['supplier_id_' + key], b['supplier_name_' + key], userId);
      ins.run(bookingId, key, label, sup ? sup.hire_company_id : null, sup ? sup.company_name : '');
    }
  })();
}

// GET /api/projects?client_id= — client-scoped project (job) list for the
// dependent Project dropdown. Empty list when no client. Mirrors the query
// in routes/clients.js.
router.get('/api/projects', (req, res) => {
  const db = getDb();
  const clientId = parseInt(req.query.client_id, 10);
  if (!clientId) return res.json({ ok: true, projects: [] });
  let projects = [];
  try {
    projects = db.prepare(`
      SELECT id, job_number, job_name FROM jobs
      WHERE client_id = ? AND status NOT IN ('closed','completed','cancelled')
      ORDER BY job_name
    `).all(clientId);
  } catch (e) { /* jobs table shape */ }
  res.json({ ok: true, projects });
});

// GET /api/location-contexts — the reusable label pick-list.
router.get('/api/location-contexts', (req, res) => {
  const db = getDb();
  let items = [];
  try { items = db.prepare('SELECT label FROM location_contexts WHERE active = 1 ORDER BY label').all().map(r => r.label); } catch (e) {}
  res.json({ ok: true, items });
});

// POST /api/location-contexts — add a new reusable label (inline add).
router.post('/api/location-contexts', (req, res) => {
  const db = getDb();
  const label = (req.body.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Label required' });
  try { db.prepare('INSERT OR IGNORE INTO location_contexts (label) VALUES (?)').run(label); }
  catch (e) { return res.status(500).json({ error: 'Could not save' }); }
  const items = db.prepare('SELECT label FROM location_contexts WHERE active = 1 ORDER BY label').all().map(r => r.label);
  res.json({ ok: true, items, added: label });
});

// GET /api/:id/edit-data — JSON snapshot of a booking's editable fields,
// shaped to populate the Quick Book form (date / start_time / end_time split
// out from the start_datetime / end_datetime stored on the row, etc.) so the
// editor overlay can open in edit mode pre-filled. Returns 404 when missing.
router.get('/api/:id/edit-data', (req, res) => {
  const db = getDb();
  const b = db.prepare(`
    SELECT b.id, b.booking_number, b.job_id, b.client_id, b.title, b.depot, b.status,
      b.start_datetime, b.end_datetime,
      b.site_address, b.suburb, b.state, b.postcode,
      b.latitude, b.longitude,
      b.order_number, b.billing_code, b.client_contact,
      b.supervisor_id, b.is_emergency, b.is_callout, b.booking_type,
      b.requester_id, b.planner_id, b.location_context, b.location_notes,
      b.notes, b.requirements_text, b.description,
      b.depot_meeting_time, b.straight_to_site_time, b.site_contacts,
      b.booking_tags,
      c.company_name AS client_name,
      j.job_name AS site_label
    FROM bookings b
    LEFT JOIN clients c ON c.id = b.client_id
    LEFT JOIN jobs    j ON j.id = b.job_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  // Split the stored datetimes back into the date/time pairs the form uses.
  const startDate = (b.start_datetime || '').slice(0, 10);
  const startTime = (b.start_datetime || '').slice(11, 16);
  const endDate   = (b.end_datetime || '').slice(0, 10);
  const endTime   = (b.end_datetime || '').slice(11, 16);
  let siteContacts = [];
  try { siteContacts = JSON.parse(b.site_contacts || '[]'); } catch (e) {}
  // Booking Requirements steppers — map current booking_requirements rows back
  // to the grid's field names so the overlay can prefill the steppers with
  // their real saved quantities instead of the template defaults.
  const requirements = {};
  try {
    db.prepare('SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id = ?')
      .all(b.id)
      .forEach(r => {
        const field = QUICK_REQ_LABEL_TO_FIELD[r.resource_type];
        if (field) requirements[field] = r.quantity_required;
      });
  } catch (e) {}
  // Hired-item → supplier rows, keyed by item_key for easy prefill.
  const hireItems = {};
  try {
    db.prepare('SELECT item_key, hire_company_id, company_name FROM booking_hire_items WHERE booking_id = ?')
      .all(b.id)
      .forEach(r => { hireItems[r.item_key] = { hire_company_id: r.hire_company_id, company_name: r.company_name }; });
  } catch (e) {}
  // Mobile-works legs (one row per stop) for the slide-over to prefill.
  let mobileLegs = [];
  try { mobileLegs = getMobileLegs(db, b.id); } catch (e) {}
  // Meeting-point pin + note (columns added in migration 307).
  let meetingPoint = { latitude: '', longitude: '', note: '' };
  try {
    const mp = db.prepare('SELECT meeting_point_latitude AS latitude, meeting_point_longitude AS longitude, meeting_point_note AS note FROM bookings WHERE id = ?').get(b.id);
    if (mp) meetingPoint = { latitude: mp.latitude || '', longitude: mp.longitude || '', note: mp.note || '' };
  } catch (e) {}
  // Mobile-works flag lives on the bookings row.
  let hasMobileWorks = false;
  try { const mw = db.prepare('SELECT has_mobile_works FROM bookings WHERE id = ?').get(b.id); hasMobileWorks = !!(mw && mw.has_mobile_works); } catch (e) {}
  res.json({
    ok: true,
    requirements,
    hireItems,
    mobileLegs,
    meetingPoint,
    hasMobileWorks,
    booking: {
      id: b.id, booking_number: b.booking_number,
      client_id: b.client_id, client_name: b.client_name || '',
      job_id: b.job_id, site_label: b.site_label || '',
      title: b.title || '',
      depot: b.depot || '',
      status: b.status || 'unconfirmed',
      start_date: startDate, start_time: startTime,
      end_date: endDate, end_time: endTime,
      site_address: b.site_address || '',
      suburb: b.suburb || '', state: b.state || '', postcode: b.postcode || '',
      latitude: b.latitude || '', longitude: b.longitude || '',
      order_number: b.order_number || '', billing_code: b.billing_code || '',
      client_contact: b.client_contact || '',
      supervisor_id: b.supervisor_id || '',
      is_emergency: !!b.is_emergency, is_callout: !!b.is_callout,
      booking_type: b.booking_type || 'regular',
      requester_id: b.requester_id || '', planner_id: b.planner_id || '',
      location_context: b.location_context || '', location_notes: b.location_notes || '',
      notes: b.notes || '', requirements_text: b.requirements_text || '',
      description: b.description || '',
      depot_meeting_time: b.depot_meeting_time || '',
      straight_to_site_time: b.straight_to_site_time || '',
      site_contacts: siteContacts,
      booking_tags: b.booking_tags || '',
    },
  });
});

// POST /:id/quick-update — slide-over edit endpoint. Same field shape as the
// /quick create handler so the overlay's Overview form can save edits without
// having to switch to the full edit page's wider field set. Touches only the
// fields the Quick Book form actually carries; everything else is left alone.
router.post('/:id/quick-update', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const existing = db.prepare('SELECT id FROM bookings WHERE id = ?').get(req.params.id);
  if (!existing) {
    if (isJson) return res.status(404).json({ error: 'Booking not found' });
    req.flash('error', 'Booking not found.'); return res.redirect('/bookings');
  }
  const b = req.body;
  const missing = [];
  if (!b.client_name && !b.client_id) missing.push('client');
  if (!b.site_address) missing.push('site address');
  if (!b.start_date) missing.push('date');
  if (!b.start_time) missing.push('start time');
  if (missing.length) {
    const msg = 'Missing: ' + missing.join(', ');
    if (isJson) return res.status(400).json({ error: msg });
    req.flash('error', msg); return res.redirect('/bookings/' + req.params.id);
  }
  const startTime = b.start_time;
  const endTime = b.end_time || '14:30';
  let endDate = b.start_date;
  if (endTime <= startTime) {
    const d = new Date(b.start_date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  // Resolve / auto-create client + project from typed names, mirroring /quick.
  let clientId = b.client_id ? parseInt(b.client_id, 10) : null;
  if (!clientId && b.client_name) {
    const ex = db.prepare("SELECT id FROM clients WHERE LOWER(company_name) = LOWER(?)").get(b.client_name.trim());
    if (ex) clientId = ex.id;
    else { try { clientId = db.prepare("INSERT INTO clients (company_name, created_at) VALUES (?, CURRENT_TIMESTAMP)").run(b.client_name.trim()).lastInsertRowid; } catch (e) {} }
  }
  let jobId = b.job_id ? parseInt(b.job_id, 10) : null;
  if (!jobId && b.site_label) {
    const pr = db.prepare("SELECT id FROM jobs WHERE LOWER(job_name) = LOWER(?) LIMIT 1").get(b.site_label.trim());
    if (pr) jobId = pr.id;
    else if (clientId) { try { jobId = db.prepare("INSERT INTO jobs (job_name, client_id, status, created_at) VALUES (?, ?, 'active', CURRENT_TIMESTAMP)").run(b.site_label.trim(), clientId).lastInsertRowid; } catch (e) {} }
  }
  const lat = b.latitude ? parseFloat(b.latitude) : null;
  const lng = b.longitude ? parseFloat(b.longitude) : null;
  const siteContactsJson = Array.isArray(b.site_contacts)
    ? JSON.stringify(b.site_contacts.map(String).filter(Boolean))
    : (b.site_contacts && /^\d+$/.test(String(b.site_contacts).trim()) ? JSON.stringify([String(b.site_contacts).trim()]) : '[]');

  const title = (b.title && b.title.trim()) || (b.site_label && b.site_label.trim()) || 'Booking';
  try {
    db.prepare(`
      UPDATE bookings SET
        job_id = ?, client_id = ?, title = ?, depot = ?,
        start_datetime = ?, end_datetime = ?,
        site_address = ?, suburb = ?, state = ?, postcode = ?,
        latitude = ?, longitude = ?, marker_is_accurate = ?,
        site_contacts = ?,
        order_number = COALESCE(?, order_number),
        billing_code = COALESCE(?, billing_code),
        is_emergency = ?, is_callout = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      jobId, clientId, title, b.depot || '',
      b.start_date + 'T' + startTime + ':00',
      endDate + 'T' + endTime + ':00',
      b.site_address || b.site_label || '',
      b.suburb || '', b.state || '', b.postcode || '',
      lat, lng, lat ? 1 : 0,
      siteContactsJson,
      b.order_number || null, b.billing_code || null,
      b.is_emergency ? 1 : 0, b.is_callout ? 1 : 0,
      req.params.id
    );
  } catch (err) {
    console.error('[bookings/quick-update] UPDATE failed:', err.message);
    if (isJson) return res.status(500).json({ error: 'Could not save booking: ' + err.message });
    req.flash('error', 'Could not save booking: ' + err.message);
    return res.redirect('/bookings/' + req.params.id);
  }
  // Booking Requirements steppers → rebuild booking_requirements. Only do
  // this when the form actually carried the grid (the steppers always post,
  // even at 0, so presence of any crew_size_*/addon_* key means the grid was
  // there). Mirrors the full edit page's delete-then-reinsert; skips writing
  // when the grid wasn't submitted so we never wipe requirements from a
  // partial POST.
  const gridPresent = QUICK_REQ_FIELDS.some(([f]) => b[f] !== undefined);
  if (gridPresent) {
    try {
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM booking_requirements WHERE booking_id = ?').run(req.params.id);
        const insReq = db.prepare('INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)');
        for (const [field, label] of QUICK_REQ_FIELDS) {
          const qty = parseInt(b[field], 10);
          if (Number.isFinite(qty) && qty > 0) insReq.run(req.params.id, label, qty);
        }
      });
      tx();
      // Keep ute placeholders in step with the TC-Crew requirement rows.
      try { syncTCCrewVehicles(db, parseInt(req.params.id, 10)); } catch (e) { console.error('syncTCCrewVehicles:', e.message); }
    } catch (e) { console.error('[bookings/quick-update] requirements rebuild failed:', e.message); }
    // Hired-item suppliers ride with the grid.
    try { persistBookingHireItems(db, parseInt(req.params.id, 10), b, req.session.user.id); } catch (e) { console.error('[bookings/quick-update] hire items failed:', e.message); }
  }

  // Fields the base quick-update statement doesn't cover but the slide-over
  // now carries: description + mobile-works flag (only when submitted).
  try {
    const bid = parseInt(req.params.id, 10);
    if (b.description !== undefined) db.prepare('UPDATE bookings SET description = ? WHERE id = ?').run(b.description || '', bid);
    if (b.mobile_works !== undefined || b.has_mobile_works !== undefined) {
      db.prepare('UPDATE bookings SET has_mobile_works = ? WHERE id = ?').run((b.mobile_works || b.has_mobile_works) ? 1 : 0, bid);
    }
  } catch (e) { console.error('[bookings/quick-update] extra fields failed:', e.message); }
  try { persistBookingMobileLegs(db, parseInt(req.params.id, 10), b); } catch (e) { console.error('[bookings/quick-update] mobile legs failed:', e.message); }
  try { persistMeetingPoint(db, parseInt(req.params.id, 10), b); } catch (e) {}

  // Move crew allocations along with any date/time change.
  try { syncAllocationsToBooking(db, parseInt(req.params.id, 10)); } catch (e) {}
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Quick-edited booking #${req.params.id}`, req });
  if (isJson) return res.json({ ok: true, id: parseInt(req.params.id, 10) });
  req.flash('success', 'Booking saved.');
  return res.redirect('/bookings/' + req.params.id);
});

// GET /api/places — address autocomplete via Geoapify.
//
// AU-biased, returns up to 8 suggestions shaped { label, lat, lng,
// site_address, suburb, state, postcode, formatted } so the slide-over's
// address picker can populate its hidden fields straight from the result.
//
// Key resolution chain (matches services/bookingGeocode.getGoogleKey):
//   1. GEOAPIFY_API_KEY env var (preferred — easy to rotate per-env)
//   2. system_config 'geoapify_api_key' row
//   3. Hard-coded operational key handed over with the brief — last resort
//      so a fresh container still autocompletes before env wiring is done.
function getGeoapifyKey() {
  return process.env.GEOAPIFY_API_KEY
      || getConfig('geoapify_api_key', '')
      || '4bdbe7bd52a944579817e5a60a4cbdd0';
}
router.get('/api/places', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  const key = getGeoapifyKey();
  if (!key) return res.json({ results: [], error: 'No Geoapify key configured' });
  // Optional country bias: client passes ?cc=au (derived from the browser's
  // timezone / language). We use bias= (a preference) instead of filter= (a
  // restriction) so workers can still find an interstate or overseas address
  // when they need to — typing keeps working past the bias.
  const cc = String(req.query.cc || '').trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 2);
  const biasParam = cc ? ('&bias=countrycode:' + cc) : '';
  try {
    const url = 'https://api.geoapify.com/v1/geocode/autocomplete'
      + '?text=' + encodeURIComponent(q)
      + biasParam
      + '&apiKey=' + encodeURIComponent(key);
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error('[bookings/places] geoapify error', resp.status);
      return res.json({ results: [], error: 'Geoapify HTTP ' + resp.status });
    }
    const json = await resp.json();
    const features = Array.isArray(json.features) ? json.features : [];
    const results = features.slice(0, 8).map(f => {
      const p = f.properties || {};
      const geom = f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
      // GeoJSON has [lon, lat]; properties.lon/.lat are also populated.
      const lng = (typeof p.lon === 'number') ? p.lon : (geom ? geom[0] : null);
      const lat = (typeof p.lat === 'number') ? p.lat : (geom ? geom[1] : null);
      const street = [p.housenumber, p.street].filter(Boolean).join(' ').trim();
      const stateRaw = String(p.state_code || p.state || '').trim();
      const stateMatch = stateRaw.match(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/i);
      const stateNorm = stateMatch ? stateMatch[1].toUpperCase() : stateRaw;
      return {
        label: p.formatted || p.address_line1 || p.name || '',
        formatted: p.formatted || '',
        lat: lat,
        lng: lng,
        site_address: street || p.address_line1 || p.name || '',
        suburb: p.suburb || p.city || p.town || p.village || p.county || '',
        state: stateNorm,
        postcode: p.postcode || '',
      };
    });
    res.json({ results });
  } catch (e) {
    console.error('[bookings/places] failed', e.message);
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
  // Overnight shift: an end time at/before the start rolls to the next day
  // (18:00 → 02:00 means finish tomorrow, not 16 hours earlier).
  let endDate = b.start_date;
  if (endTime <= startTime) {
    const d = new Date(b.start_date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
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
  // Site contacts — the create form posts contact ids (one per ticked
  // contact). Store as a JSON array of ids, same shape the edit form uses.
  const siteContactsJson = Array.isArray(b.site_contacts)
    ? JSON.stringify(b.site_contacts.map(String).filter(Boolean))
    : (b.site_contacts && /^\d+$/.test(String(b.site_contacts).trim()) ? JSON.stringify([String(b.site_contacts).trim()]) : '[]');
  let result;
  try {
    result = db.prepare(`
      INSERT INTO bookings (booking_number, job_id, client_id, title, status, depot,
        start_datetime, end_datetime, site_address, suburb, state, postcode,
        latitude, longitude, marker_is_accurate,
        created_by_id, booking_type, is_booking_pool, site_contacts)
      VALUES (?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'regular', 0, ?)
    `).run(
      bookingNumber, jobId, clientId, title, b.depot || '',
      b.start_date + 'T' + startTime + ':00',
      endDate + 'T' + endTime + ':00',
      b.site_address || b.site_label || '',
      b.suburb || '', b.state || '', b.postcode || '',
      lat, lng, lat ? 1 : 0,
      req.session.user.id, siteContactsJson
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
  // No default crew package — nothing is pre-ticked. If the user picked
  // nothing the booking starts with zero crew requirements (and zero
  // utes); they add packages in the Resources tab. (Previously we forced
  // a "2x TC Crew" here, which left two requirements ticked when the user
  // then chose a different size.)
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
  try { persistBookingHireItems(db, newId, b, req.session.user.id); } catch (e) { console.error('[bookings/quick] hire items failed:', e.message); }
  try { persistBookingMobileLegs(db, newId, b); } catch (e) { console.error('[bookings/quick] mobile legs failed:', e.message); }
  try { persistMeetingPoint(db, newId, b); } catch (e) {}

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
    const assignedIds = db.prepare(`SELECT DISTINCT bc.crew_member_id FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id WHERE DATE(b.start_datetime) = ? AND b.status NOT IN ('cancelled','complete','late_cancellation','finalised') AND b.deleted_at IS NULL`).all(date).map(r => r.crew_member_id);
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
    const assignedIds = db.prepare(`SELECT DISTINCT bc.crew_member_id FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id WHERE DATE(b.start_datetime) = ? AND b.status NOT IN ('cancelled','complete','late_cancellation','finalised') AND b.deleted_at IS NULL`).all(date).map(r => r.crew_member_id);

    // PEOPLE — driven by the HR roster (employees), not the raw crew_members
    // table. crew_members carries a lot of legacy / orphaned / duplicate rows
    // (225 vs. the roster's 113), so querying it directly showed "149 active"
    // when the roster only has 37. The roster is the source of truth for who
    // is a current worker, so we start FROM employees and INNER JOIN the
    // linked crew_member (needed for its id + portal/ticket data to allocate).
    // That makes the panel's active count match the roster's Active tab.
    // Reserved + on-leave come through too so the client-side "Show Reserves"
    // / "Show On-Leave" toggles can reveal them; everything else is excluded.
    const people = db.prepare(`
      SELECT cm.id, cm.full_name, cm.role, cm.portal_role, cm.phone, cm.employee_id,
        cm.tc_ticket_expiry, cm.white_card_expiry, cm.licence_expiry, cm.licence_type,
        cm.tcp_level, cm.first_aid, cm.company, cm.employment_type,
        e.employment_status AS employment_status,
        e.address, e.suburb, e.state, e.postcode,
        e.blocked_from_allocation
      FROM employees e
      JOIN crew_members cm ON cm.id = e.linked_crew_member_id
      WHERE e.deleted_at IS NULL
        AND e.employment_status IN ('active', 'reserved', 'on_leave')
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
    // Reflect a live shift as "Ongoing" before loading the booking.
    try { autoAdvanceOngoing(db); } catch (e) {}
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
  // Parse site contacts JSON → resolve names/details in one batched query
  // (was N+1: one SELECT per id — slow on major projects with many contacts).
  let siteContactNames = [];
  let siteContactIds = [];
  let siteContactDetails = [];
  try {
    siteContactIds = JSON.parse(booking.site_contacts || '[]');
    if (siteContactIds.length) {
      const placeholders = siteContactIds.map(() => '?').join(',');
      const rows = db.prepare(`SELECT id, full_name, position, phone FROM client_contacts WHERE id IN (${placeholders})`).all(...siteContactIds);
      const byId = {};
      rows.forEach(r => { byId[String(r.id)] = r; });
      // Preserve the stored order.
      siteContactDetails = siteContactIds.map(id => byId[String(id)]).filter(Boolean);
      siteContactNames = siteContactDetails.map(c => c.full_name);
    }
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

  // Available crew for the picker — driven by the HR roster (employees), not
  // raw crew_members, so it matches the roster's active set instead of the
  // larger legacy crew_members list. INNER JOIN the linked crew_member for
  // its id (needed to allocate). Active first, then reserved, then on-leave.
  const allCrew = db.prepare(`
    SELECT cm.id, cm.full_name, cm.role, cm.employee_id,
      e.employment_status AS employment_status
    FROM employees e
    JOIN crew_members cm ON cm.id = e.linked_crew_member_id
    WHERE e.deleted_at IS NULL
      AND e.employment_status IN ('active', 'reserved', 'on_leave')
    ORDER BY
      CASE e.employment_status
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

      // One docket per shift now: find the current shift docket for this
      // booking; every crew member it covers shares it.
      const shiftDocket = db.prepare(`
        SELECT id, signed_at FROM docket_signatures
        WHERE booking_id = ? AND COALESCE(status,'current') = 'current'
        ORDER BY id DESC LIMIT 1
      `).get(booking.id);
      let docketCrewIds = new Set();
      if (shiftDocket) {
        docketCrewIds = new Set(db.prepare('SELECT crew_member_id FROM docket_crew WHERE docket_id = ?').all(shiftDocket.id).map(r => r.crew_member_id));
      }

      jobPackGrid = (booking.crew || []).map(c => {
        const submissions = byCrew[c.crew_member_id] || [];
        const formStatus = {};
        for (const t of JP_TYPES) {
          const hit = submissions.find(s => s.form_type === t);
          formStatus[t] = hit ? { id: hit.id, submitted_at: hit.submitted_at } : null;
        }
        // Covered if on the docket's crew lines (or, for legacy dockets with no
        // lines, treat all crew as covered).
        const covered = shiftDocket && (docketCrewIds.size === 0 || docketCrewIds.has(c.crew_member_id));
        return {
          crew_member_id: c.crew_member_id,
          name: c.full_name || ('#' + c.crew_member_id),
          role: c.role_on_site || c.crew_role || '',
          forms: formStatus,
          docket: covered ? shiftDocket : null,
          submitted_count: JP_TYPES.filter(t => formStatus[t]).length,
        };
      });
    }
  } catch (e) {
    console.error('[bookings.show] job-pack grid error:', e.message);
  }

  // Scoped Safety roll-up for the Forms tab (reuses the Safety Today helpers).
  let safetyRollup = null;
  try {
    safetyRollup = require('./helpers/safety-today-queries').buildScopedRollup(db, { bookingId: booking.id });
  } catch (e) {
    console.error('[bookings.show] safety rollup error:', e.message);
  }

  let hireSuppliers = [];
  try { hireSuppliers = db.prepare('SELECT item_key, item_label, company_name FROM booking_hire_items WHERE booking_id = ? ORDER BY item_label').all(booking.id); } catch (e) {}
  let mobileLegs = [];
  try { mobileLegs = getMobileLegs(db, booking.id); } catch (e) {}
  res.render('bookings/show', {
    title: 'Booking ' + booking.booking_number,
    hireSuppliers, mobileLegs,
    booking: { ...booking, supervisor: booking.supervisor_name, requester_name: requesterName, planner_name: plannerName, site_contact_names: siteContactNames, site_contact_details: siteContactDetails, tags_list: tagsList,
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
    safetyRollup,
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
  let contacts = []; try { contacts = db.prepare("SELECT id, full_name, position, phone, mobile, email, company_id FROM client_contacts ORDER BY full_name").all(); } catch (e) {}
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
  const hireItems = {};
  try {
    db.prepare('SELECT item_key, hire_company_id, company_name FROM booking_hire_items WHERE booking_id = ?')
      .all(req.params.id)
      .forEach(r => { hireItems[r.item_key] = { hire_company_id: r.hire_company_id, company_name: r.company_name }; });
  } catch (e) {}
  let mobileLegs = [];
  try { mobileLegs = getMobileLegs(db, booking.id); } catch (e) {}
  res.render('bookings/form', {
    title: 'Edit Booking ' + booking.booking_number,
    booking, jobs, clients, supervisors, contacts, crewForSelect,
    depots: getDepots(), user: req.session.user,
    bookingDocuments, mobileLegs,
    hireableItems: HIREABLE_ITEMS, hireCompanies: getHireCompanies(db),
    locationContexts: getLocationContexts(db), hireItems,
  });
});

// POST /:id — Update
router.post('/:id', (req, res) => {
  const db = getDb(); const existing = db.prepare("SELECT id, booking_number, start_datetime, description, location_notes FROM bookings WHERE id = ?").get(req.params.id);
  if (!existing) { req.flash('error', 'Booking not found.'); return res.redirect('/bookings'); }
  const b = req.body;
  if (!b.title || !b.start_date || !b.start_time || !b.end_date || !b.end_time) { req.flash('error', 'Title and schedule are required.'); return res.redirect('/bookings/' + req.params.id + '/edit'); }
  if ((b.end_date + 'T' + b.end_time) <= (b.start_date + 'T' + b.start_time)) { req.flash('error', 'Finish must be after the start — check the dates/times.'); return res.redirect('/bookings/' + req.params.id + '/edit'); }
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
  try { persistBookingHireItems(db, parseInt(req.params.id, 10), b, req.session.user.id); } catch (e) { console.error('[bookings update] hire items failed:', e.message); }
  try { persistBookingMobileLegs(db, parseInt(req.params.id, 10), b); } catch (e) { console.error('[bookings update] mobile legs failed:', e.message); }
  try { persistMeetingPoint(db, parseInt(req.params.id, 10), b); } catch (e) {}

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
    const rawIds = Array.isArray(b.crew_ids) ? b.crew_ids : (b.crew_ids ? [b.crew_ids] : []);
    const VALID_SITE_ROLES = ['traffic_controller','team_leader','supervisor'];
    // Reject any id that isn't a real, active crew member to stop browser
    // autofill or stale form state assigning shifts to people not on roster.
    const validIds = [];
    const roleById = {};
    rawIds.forEach(cid => {
      if (!cid) return;
      const member = db.prepare("SELECT id, portal_role, active FROM crew_members WHERE id = ?").get(cid);
      if (!member || !member.active) {
        console.warn('[bookings.update] ignoring crew_id', cid, 'on booking', req.params.id, '— no matching active crew_member');
        return;
      }
      const raw = b['crew_role_' + cid];
      roleById[member.id] = (raw && VALID_SITE_ROLES.includes(raw)) ? raw
        : (member.portal_role && VALID_SITE_ROLES.includes(member.portal_role)) ? member.portal_role
        : 'traffic_controller';
      validIds.push(member.id);
    });
    // Diff against current crew — keeps existing rows (and their
    // confirmed/declined statuses) instead of wiping + re-adding everyone.
    const diff = diffCrew(db, parseInt(req.params.id, 10), validIds, cid => roleById[cid], { userId: req.session.user.id });
    const bkNow = db.prepare('SELECT booking_number, title, start_datetime, status FROM bookings WHERE id=?').get(req.params.id);
    // Only ping crew once the booking is confirmed — a worker assigned to an
    // unconfirmed booking hears nothing until the allocator commits it.
    if (bkNow && bookingNotify.isNotifiable(bkNow.status)) {
      if (diff.added.length) bookingNotify.notifyAssigned(diff.added, bkNow);
      if (diff.removed.length) bookingNotify.notifyRemoved(diff.removed, bkNow);
    }
  }

  // Date/time changes must follow through to the worker portal — move the
  // booking's crew_allocations to the new schedule (statuses preserved).
  syncAllocationsToBooking(db, parseInt(req.params.id, 10));
  const newStartDt = b.start_date + 'T' + b.start_time + ':00';
  if (existing.start_datetime && existing.start_datetime !== newStartDt) {
    const bkAfter = db.prepare('SELECT booking_number, title, start_datetime, status FROM bookings WHERE id=?').get(req.params.id);
    // Don't announce a time change for a shift the crew were never told about.
    if (bkAfter && bookingNotify.isNotifiable(bkAfter.status)) bookingNotify.notifyRescheduled(bookingNotify.activeCrewIds(db, parseInt(req.params.id, 10)), bkAfter, existing.start_datetime);
  }

  // Worker-facing notes changed? Tell the crew their shift info was updated
  // — only the fields they actually see (About this job + Location notes),
  // and only once the booking is confirmed so they'd already have it.
  const newDesc = (b.description || '').trim();
  const newLoc  = (b.location_notes || '').trim();
  const notesChanged = [];
  if (newDesc !== (existing.description || '').trim()) notesChanged.push('About this job');
  if (newLoc  !== (existing.location_notes || '').trim()) notesChanged.push('Location notes');
  if (notesChanged.length) {
    const bkNotes = db.prepare('SELECT booking_number, title, start_datetime, status FROM bookings WHERE id=?').get(req.params.id);
    if (bkNotes && bookingNotify.isNotifiable(bkNotes.status)) {
      bookingNotify.notifyShiftNotesUpdated(bookingNotify.activeCrewIds(db, parseInt(req.params.id, 10)), bkNotes, notesChanged);
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
  // Cancellation cascades to the crew's allocations so the shift drops off
  // worker views; un-cancelling brings them back (confirmed stays confirmed).
  const CANCEL_LIKE = ['cancelled', 'late_cancellation'];
  if (CANCEL_LIKE.includes(newStatus) && !CANCEL_LIKE.includes(existing.status)) {
    const crewIds = bookingNotify.activeCrewIds(db, parseInt(req.params.id, 10));
    cascadeCancel(db, parseInt(req.params.id, 10));
    const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id=?').get(req.params.id);
    // Only tell crew a shift is cancelled if they'd already been told it was on
    // (i.e. it had reached confirmed). Cancelling an unconfirmed booking is silent.
    if (bk && bookingNotify.isNotifiable(existing.status)) bookingNotify.notifyCancelled(crewIds, bk);
  } else if (CANCEL_LIKE.includes(existing.status) && !CANCEL_LIKE.includes(newStatus)) {
    cascadeRestore(db, parseInt(req.params.id, 10));
  } else if (!bookingNotify.isNotifiable(existing.status) && bookingNotify.isNotifiable(newStatus)) {
    // The allocator just committed the booking (e.g. unconfirmed → confirmed).
    // This is the moment crew should hear about their shift — push the
    // assignment notice to everyone currently on it who hasn't declined.
    const crewIds = bookingNotify.activeCrewIds(db, parseInt(req.params.id, 10));
    const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id=?').get(req.params.id);
    if (bk && crewIds.length) bookingNotify.notifyAssigned(crewIds, bk);
  }
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
  // A deleted booking's shifts must drop off the worker portal too — and
  // the crew should hear about it (a delete is a cancellation to them).
  const delCrewIds = bookingNotify.activeCrewIds(db, parseInt(req.params.id, 10));
  const delStatus = (db.prepare('SELECT status FROM bookings WHERE id=?').get(req.params.id) || {}).status;
  cascadeCancel(db, parseInt(req.params.id, 10));
  const delBk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id=?').get(req.params.id);
  // Deleting a booking is a cancellation to the crew — but only worth a push
  // if they'd been told the shift was on (confirmed or later).
  if (delBk && bookingNotify.isNotifiable(delStatus)) bookingNotify.notifyCancelled(delCrewIds, delBk);
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
  // Revive the crew's allocations that the delete cancelled.
  cascadeRestore(db, parseInt(req.params.id, 10));
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
  // Idempotent: if they're already on THIS booking, treat the add as a
  // harmless no-op rather than an error. The slide-over can re-fire the
  // same POST (e.g. a double-click or a re-wired listener) and we don't
  // want a wall of "Already assigned" toasts. Return the crew row so the
  // UI can render the chip as assigned.
  const already = db.prepare("SELECT id FROM booking_crew WHERE booking_id=? AND crew_member_id=?").get(req.params.id, crew_member_id);
  if (already) {
    if (isJson) {
      const cm = db.prepare("SELECT cm.id, cm.full_name, cm.role, COALESCE(e.employment_status,'active') AS employment_status FROM crew_members cm LEFT JOIN employees e ON e.linked_crew_member_id = cm.id WHERE cm.id = ?").get(crew_member_id);
      return res.json({ ok: true, crew: cm, alreadyAssigned: true });
    }
    req.flash('info', 'Already on this booking.'); return res.redirect('/bookings/' + req.params.id);
  }

  // Conflict detection — warn if crew member has overlapping bookings on same
  // date. Returned in the JSON response too so the board can toast it (the
  // flash was invisible to AJAX callers).
  let conflictWarning = null;
  const thisBooking = db.prepare("SELECT start_datetime, end_datetime, booking_number, status FROM bookings WHERE id=?").get(req.params.id);
  if (thisBooking && thisBooking.start_datetime) {
    const bookingDate = thisBooking.start_datetime.substring(0, 10);
    const conflicts = db.prepare(`
      SELECT b.id, b.booking_number, b.start_datetime, b.end_datetime
      FROM booking_crew bc
      JOIN bookings b ON b.id = bc.booking_id
      WHERE bc.crew_member_id = ? AND b.id != ? AND DATE(b.start_datetime) = ?
        AND b.deleted_at IS NULL
        AND b.status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})
    `).all(crew_member_id, req.params.id, bookingDate, ...TERMINAL_STATUSES);
    if (conflicts.length > 0) {
      const conflictNums = conflicts.map(c => c.booking_number || `#${c.id}`).join(', ');
      conflictWarning = `Also assigned to ${conflictNums} on the same date.`;
      req.flash('warning', `Conflict: this crew member is ${conflictWarning.toLowerCase()}`);
    }
  }

  // Deploy new crew OUTSIDE the ute by default (assigned_vehicle_id = NULL) —
  // they render as standalone traffic controllers. The planner explicitly
  // drags a worker onto a ute slot to put them in it. (Previously we auto-
  // assigned the first vehicle, forcing everyone "into the ute" on add.)
  // INSERT OR IGNORE + the unique index (migration 298) makes the add
  // atomically idempotent even under a race. `inserted` is false if the
  // row was already there (we'll skip the notification below).
  const insertResult = db.prepare("INSERT OR IGNORE INTO booking_crew (booking_id, crew_member_id, role_on_site, status, assigned_vehicle_id) VALUES (?, ?, ?, 'assigned', NULL)")
    .run(req.params.id, crew_member_id, role_on_site || '');
  const inserted = insertResult.changes > 0;

  // Auto-create crew_allocation so the worker sees this in their portal.
  // job_id is nullable (migration 141) so ad-hoc bookings without a job
  // still get an allocation — previously these silently never appeared in
  // the worker portal until the worker happened to open the booking page.
  if (thisBooking && thisBooking.start_datetime) {
    const allocDate = thisBooking.start_datetime.substring(0, 10);
    const startTime = thisBooking.start_datetime.substring(11, 16) || '06:00';
    const endTime = thisBooking.end_datetime ? thisBooking.end_datetime.substring(11, 16) : '15:00';
    const booking = db.prepare("SELECT job_id FROM bookings WHERE id=?").get(req.params.id);
    try {
      db.prepare(`INSERT OR IGNORE INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id, allocated_by_id)
        VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?)`).run(
        (booking && booking.job_id) || null, crew_member_id, allocDate, startTime, endTime, role_on_site || '', req.params.id, req.session.user.id);
    } catch (e) { console.error('Auto-create allocation error:', e.message); }
  }

  // Tell the worker they've been put on a shift — but only if the booking is
  // confirmed. On an unconfirmed booking the assignment stays silent; the crew
  // get pushed when the allocator flips it to confirmed (see /:id/status).
  if (inserted && thisBooking && bookingNotify.isNotifiable(thisBooking.status)) {
    bookingNotify.notifyAssigned([crew_member_id], {
      booking_number: thisBooking.booking_number,
      title: (db.prepare('SELECT title FROM bookings WHERE id=?').get(req.params.id) || {}).title,
      start_datetime: thisBooking.start_datetime,
    });
  }

  // Audit trail — who put whom on the shift.
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id,
    details: `Added crew #${crew_member_id} to ${thisBooking ? thisBooking.booking_number : 'booking'}`, req });

  if (isJson) {
    const cm = db.prepare("SELECT cm.id, cm.full_name, cm.role, COALESCE(e.employment_status,'active') AS employment_status FROM crew_members cm LEFT JOIN employees e ON e.linked_crew_member_id = cm.id WHERE cm.id = ?").get(crew_member_id);
    return res.json({ ok: true, crew: cm, warning: conflictWarning });
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
  const removed = db.prepare("DELETE FROM booking_crew WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  db.prepare("DELETE FROM crew_allocations WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  // Also clear them as driver on any vehicles on this booking
  db.prepare("UPDATE booking_vehicles SET crew_member_id = NULL WHERE booking_id=? AND crew_member_id=?").run(req.params.id, req.params.crewId);
  if (removed.changes > 0) {
    const bk = db.prepare('SELECT booking_number, title, start_datetime, status FROM bookings WHERE id=?').get(req.params.id);
    // Only notify a removal if the crew had already been told they were on it.
    if (bk && bookingNotify.isNotifiable(bk.status)) bookingNotify.notifyRemoved([req.params.crewId], bk);
    logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id,
      details: `Removed crew #${req.params.crewId} from ${bk ? bk.booking_number : 'booking'}`, req });
  }
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
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id,
    details: `Confirmed crew #${req.params.crewId} on booking`, req });
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
  // Vehicle double-booking warning — same fleet vehicle or rego on another
  // live booking the same day. Crew get this check; vehicles never did.
  let vehicleWarning = null;
  try {
    const bk = db.prepare('SELECT start_datetime FROM bookings WHERE id=?').get(req.params.id);
    if (bk && bk.start_datetime && (fleet_vehicle_id || registration)) {
      const clash = db.prepare(`
        SELECT DISTINCT b.booking_number, b.id
        FROM booking_vehicles bv JOIN bookings b ON b.id = bv.booking_id
        WHERE b.id != ? AND DATE(b.start_datetime) = DATE(?)
          AND b.deleted_at IS NULL
          AND b.status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(',')})
          AND ((? IS NOT NULL AND bv.fleet_vehicle_id = ?)
               OR (? != '' AND bv.registration != '' AND UPPER(bv.registration) = UPPER(?)))
      `).all(req.params.id, bk.start_datetime, ...TERMINAL_STATUSES,
             fleet_vehicle_id, fleet_vehicle_id, registration || '', registration || '');
      if (clash.length) {
        vehicleWarning = 'This vehicle is also on ' + clash.map(c => c.booking_number || ('#' + c.id)).join(', ') + ' the same day.';
        req.flash('warning', vehicleWarning);
      }
    }
  } catch (e) { /* warning only — never block the add */ }
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id,
    details: `Added vehicle ${vehicle_name || registration} to booking`, req });
  if (isJson) return res.json({ ok: true, id: newId, upgraded: !!upgraded, warning: vehicleWarning });
  req.flash('success', upgraded ? 'Vehicle assigned.' : 'Vehicle added.');
  res.redirect('/bookings/' + req.params.id);
});
// POST /:id/vehicles/:vehicleId — edit an existing vehicle row in place.
// Lets a blank "(unnamed vehicle)" placeholder be upgraded to a real ute
// (fleet vehicle or typed name/rego) without deleting + re-adding, so the
// reconcile in syncTCCrewVehicles then treats it as protected.
router.post('/:id/vehicles/:vehicleId', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  const row = db.prepare("SELECT * FROM booking_vehicles WHERE id=? AND booking_id=?").get(req.params.vehicleId, req.params.id);
  if (!row) {
    if (isJson) return res.status(404).json({ error: 'Vehicle not found' });
    req.flash('error', 'Not found.'); return res.redirect('/bookings/' + req.params.id);
  }
  let vehicle_name = req.body.vehicle_name != null ? req.body.vehicle_name : row.vehicle_name;
  let registration = req.body.registration != null ? req.body.registration : row.registration;
  let vehicle_role = req.body.vehicle_role || row.vehicle_role || 'ute';
  let fleet_vehicle_id = parseInt(req.body.fleet_vehicle_id, 10);
  if (!Number.isFinite(fleet_vehicle_id) || fleet_vehicle_id <= 0) {
    // empty string explicitly clears the link; absent keeps the existing one
    fleet_vehicle_id = (req.body.fleet_vehicle_id === '' ) ? null
      : (req.body.fleet_vehicle_id === undefined ? row.fleet_vehicle_id : null);
  }
  if (fleet_vehicle_id) {
    try {
      const fv = db.prepare("SELECT asset_id, rego, make, model FROM vehicles WHERE id = ?").get(fleet_vehicle_id);
      if (fv) {
        if (!vehicle_name) vehicle_name = [fv.make, fv.model].filter(Boolean).join(' ') || fv.asset_id;
        if (!registration && fv.rego) registration = fv.rego;
      } else { fleet_vehicle_id = null; }
    } catch (e) { fleet_vehicle_id = null; }
  }
  db.prepare("UPDATE booking_vehicles SET vehicle_name=?, registration=?, vehicle_role=?, fleet_vehicle_id=? WHERE id=?")
    .run(vehicle_name || '', registration || '', vehicle_role, fleet_vehicle_id, row.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id,
    details: `Edited vehicle #${req.params.vehicleId} on booking`, req });
  if (isJson) return res.json({ ok: true, id: row.id, vehicle_name: vehicle_name || '', registration: registration || '', vehicle_role, fleet_vehicle_id });
  req.flash('success', 'Vehicle updated.'); res.redirect('/bookings/' + req.params.id);
});
router.post('/:id/vehicles/:vehicleId/remove', (req, res) => {
  const db = getDb();
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  db.prepare("DELETE FROM booking_vehicles WHERE id=? AND booking_id=?").run(req.params.vehicleId, req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id,
    details: `Removed vehicle #${req.params.vehicleId} from booking`, req });
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
// GET /:id/documents.json — booking's attached documents, for the slide-over
// Req. Plans / Req. Permits panes to list + attach inline. Returns every doc;
// the client filters by type (Plans vs Permits).
router.get('/:id/documents.json', (req, res) => {
  const db = getDb();
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) return res.status(404).json({ error: 'Booking not found' });
  let docs = [];
  try {
    docs = db.prepare(`
      SELECT bd.id, bd.document_type, bd.title, bd.original_name, bd.file_size, bd.created_at,
             u.full_name AS uploader_name
      FROM booking_documents bd LEFT JOIN users u ON u.id = bd.uploaded_by_id
      WHERE bd.booking_id = ? ORDER BY bd.created_at DESC
    `).all(req.params.id);
  } catch (e) {}
  res.json({ ok: true, documents: docs });
});

router.post('/:id/documents', uploadDoc.single('file'), (req, res) => {
  const db = getDb();
  const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!db.prepare("SELECT id FROM bookings WHERE id=?").get(req.params.id)) {
    if (wantsJson) return res.status(404).json({ error: 'Booking not found' });
    req.flash('error', 'Booking not found.'); return res.redirect('/bookings');
  }
  if (!req.file) {
    if (wantsJson) return res.status(400).json({ error: 'No file selected' });
    req.flash('error', 'No file selected.'); return res.redirect('/bookings/' + req.params.id);
  }
  const b = req.body;
  const info = db.prepare(`
    INSERT INTO booking_documents (booking_id, document_type, title, description, filename, original_name, file_path, file_size, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, b.document_type || 'other', b.title || req.file.originalname, b.description || '',
    req.file.filename, req.file.originalname, req.file.path, req.file.size, req.session.user.id);
  logActivity({ user: req.session.user, action: 'create', entityType: 'booking_document', entityId: req.params.id, details: `Uploaded ${req.file.originalname}`, req });
  if (wantsJson) return res.json({ ok: true, id: info.lastInsertRowid, document_type: b.document_type || 'other', original_name: req.file.originalname });
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

// POST /:id/documents/:docId/type — relabel a document's type in place.
router.post('/:id/documents/:docId/type', (req, res) => {
  const db = getDb();
  const VALID = ['tgs','tmp','ctmp','rol','rol_day','rol_night','stage_plan','swms','permit','invoice','photo','other'];
  const type = VALID.includes(req.body.document_type) ? req.body.document_type : 'other';
  db.prepare("UPDATE booking_documents SET document_type=? WHERE id=? AND booking_id=?").run(type, req.params.docId, req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'booking_document', entityId: req.params.id, details: `Document #${req.params.docId} type → ${type}`, req });
  req.flash('success', 'Document type updated.');
  res.redirect('/bookings/' + req.params.id + '#documents');
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

  // Drag the crew's allocations to the new date with the booking, otherwise
  // workers keep seeing the shift on the old day. Then tell them it moved.
  syncAllocationsToBooking(db, parseInt(req.params.id, 10));
  const movedBk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id=?').get(req.params.id);
  // Suppress the "shift moved" push on bookings the crew were never told about.
  if (movedBk && booking.start_datetime !== movedBk.start_datetime && bookingNotify.isNotifiable(booking.status)) {
    bookingNotify.notifyRescheduled(bookingNotify.activeCrewIds(db, parseInt(req.params.id, 10)), movedBk, booking.start_datetime);
  }

  logActivity({ user: req.session.user, action: 'update', entityType: 'booking', entityId: req.params.id, details: `Moved booking ${booking.booking_number} to ${newDate}`, req });
  res.json({ ok: true });
});

// Clone
router.post('/:id/clone', (req, res) => {
  const db = getDb(); const source = db.prepare("SELECT * FROM bookings WHERE id = ?").get(req.params.id);
  const isJson = req.headers.accept && req.headers.accept.includes('application/json');
  if (!source) { if (isJson) return res.status(404).json({ error: 'Not found' }); req.flash('error', 'Not found.'); return res.redirect('/bookings'); }
  const bookingNumber = generateBookingNumber(db);
  // Default to including crew for backward-compat; the UI passes an explicit
  // choice (setup-only avoids double-booking workers on the clone).
  const includeCrew = !(req.body && (req.body.include_crew === '0' || req.body.include_crew === false || req.body.include_crew === 'false'));
  function addDay(dt) { if (!dt) return dt; const d = new Date(dt); d.setDate(d.getDate() + 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${(dt.split('T')[1] || '00:00:00')}`; }
  const result = db.prepare(`INSERT INTO bookings (booking_number, job_id, client_id, title, description, status, depot, start_datetime, end_datetime, site_address, suburb, state, postcode, order_number, billing_code, client_contact, supervisor_id, requirements_text, is_emergency, is_callout, billable, invoiced, notes, created_by_id,
    site_contacts, depot_meeting_time, straight_to_site_time, booking_tags, latitude, longitude, marker_is_accurate, location_notes, worksite_location, works_direction, chainage_from, chainage_to, has_mobile_works, booking_type, is_booking_pool, requester_id, planner_id, location_context,
    meeting_point_latitude, meeting_point_longitude, meeting_point_note)
    VALUES (?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?)`).run(
    bookingNumber, source.job_id, source.client_id, source.title, source.description, source.depot, addDay(source.start_datetime), addDay(source.end_datetime),
    source.site_address, source.suburb, source.state, source.postcode, source.order_number, source.billing_code, source.client_contact, source.supervisor_id,
    source.requirements_text, source.is_emergency, source.is_callout, source.billable, source.notes, req.session.user.id,
    source.site_contacts || '[]', source.depot_meeting_time || '', source.straight_to_site_time || '', source.booking_tags || '[]',
    source.latitude, source.longitude, source.marker_is_accurate || 0, source.location_notes || '', source.worksite_location || '', source.works_direction || '',
    source.chainage_from || '', source.chainage_to || '', source.has_mobile_works || 0, source.booking_type || 'regular', source.is_booking_pool || 0,
    source.requester_id, source.planner_id, source.location_context || '',
    source.meeting_point_latitude != null ? source.meeting_point_latitude : null,
    source.meeting_point_longitude != null ? source.meeting_point_longitude : null,
    source.meeting_point_note || '');
  const newId = result.lastInsertRowid;
  const newStart = addDay(source.start_datetime) || '';
  if (includeCrew) for (const c of db.prepare("SELECT crew_member_id, role_on_site FROM booking_crew WHERE booking_id=?").all(source.id)) {
    db.prepare("INSERT INTO booking_crew (booking_id, crew_member_id, role_on_site, status) VALUES (?, ?, ?, 'assigned')").run(newId, c.crew_member_id, c.role_on_site);
    // Allocation too — without it the cloned shift never appears in the
    // worker portal until the worker happens to open the booking page.
    try {
      db.prepare(`INSERT OR IGNORE INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status, booking_id, allocated_by_id)
        VALUES (?, ?, ?, ?, ?, ?, 'allocated', ?, ?)`)
        .run(source.job_id || null, c.crew_member_id, newStart.slice(0, 10), newStart.slice(11, 16) || '06:00',
             (addDay(source.end_datetime) || '').slice(11, 16) || '14:30', c.role_on_site || '', newId, req.session.user.id);
    } catch (e) { /* legacy schema */ }
  }
  for (const v of db.prepare("SELECT vehicle_name, registration, notes, vehicle_role, fleet_vehicle_id FROM booking_vehicles WHERE booking_id=?").all(source.id)) {
    try { db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, notes, vehicle_role, fleet_vehicle_id) VALUES (?, ?, ?, ?, ?, ?)").run(newId, v.vehicle_name, v.registration, v.notes, v.vehicle_role || '', v.fleet_vehicle_id || null); }
    catch (e) { db.prepare("INSERT INTO booking_vehicles (booking_id, vehicle_name, registration, notes) VALUES (?, ?, ?, ?)").run(newId, v.vehicle_name, v.registration, v.notes); }
  }
  try { for (const r of db.prepare("SELECT resource_type, quantity_required FROM booking_requirements WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_requirements (booking_id, resource_type, quantity_required) VALUES (?, ?, ?)").run(newId, r.resource_type, r.quantity_required); } catch(e) {}
  // Equipment + shift tasks were silently dropped by clone before — copy
  // them too (tasks reset to pending; equipment as-is).
  try { for (const eq of db.prepare("SELECT equipment_id, equipment_name, equipment_type, quantity, notes FROM booking_equipment WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_equipment (booking_id, equipment_id, equipment_name, equipment_type, quantity, notes) VALUES (?, ?, ?, ?, ?, ?)").run(newId, eq.equipment_id, eq.equipment_name, eq.equipment_type, eq.quantity, eq.notes); } catch(e) {}
  try { for (const t of db.prepare("SELECT title, description, crew_member_id, priority, due_at FROM shift_tasks WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO shift_tasks (booking_id, title, description, crew_member_id, priority, due_at, status, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)").run(newId, t.title, t.description, t.crew_member_id, t.priority, t.due_at, req.session.user.id); } catch(e) {}
  // Hired-item suppliers + mobile-works legs (previously dropped by clone).
  try { for (const h of db.prepare("SELECT item_key, item_label, hire_company_id, company_name FROM booking_hire_items WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_hire_items (booking_id, item_key, item_label, hire_company_id, company_name) VALUES (?, ?, ?, ?, ?)").run(newId, h.item_key, h.item_label, h.hire_company_id, h.company_name); } catch(e) {}
  try { for (const lg of db.prepare("SELECT seq, start_time, address, notes FROM booking_mobile_legs WHERE booking_id=?").all(source.id)) db.prepare("INSERT INTO booking_mobile_legs (booking_id, seq, start_time, address, notes) VALUES (?, ?, ?, ?, ?)").run(newId, lg.seq, lg.start_time, lg.address, lg.notes); } catch(e) {}
  logActivity({ user: req.session.user, action: 'create', entityType: 'booking', entityId: newId, details: `Cloned ${source.booking_number} → ${bookingNumber}${includeCrew ? '' : ' (setup only)'}`, req });
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
  // Tell the worker the task landed on them.
  try {
    const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id = ?').get(req.params.id) || {};
    const date = bk.start_datetime ? new Date(String(bk.start_datetime).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
    bookingNotify.notifyTaskAssigned([crew_member_id], {
      title: title.trim(),
      url: '/w/booking-shift/' + req.params.id + '?tab=tasks',
      shift_label: [date, bk.title || bk.booking_number].filter(Boolean).join(' '),
    });
  } catch (e) { console.error('[bookings] task-assigned notify failed:', e.message); }
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
