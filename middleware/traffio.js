// Traffio integration — import jobs, bookings (→ allocations), and crew
const { getDb } = require('../db/database');
const axios = require('axios');
const {
  getIntegrationConfig,
  updateSyncStatus,
  startSyncLog,
  completeSyncLog,
  getInternalRef,
  setExternalRef,
} = require('./integrations');
const { logActivity } = require('./audit');

// ---- API Client ----

function getTraffioClient() {
  const ic = getIntegrationConfig('traffio');
  if (!ic.enabled) throw new Error('Traffio integration is not enabled');
  if (!ic.config.api_url || !ic.config.api_key) {
    throw new Error('Traffio API URL and API Key are required');
  }

  return axios.create({
    baseURL: ic.config.api_url.replace(/\/+$/, ''),
    headers: {
      'Authorization': `Bearer ${ic.config.api_key}`,
      'Accept': 'application/json',
    },
    timeout: 30000,
  });
}

// ---- Field helpers (tolerant of Traffio field-name drift) ----

/** First non-empty value among candidate keys, else fallback. */
function pick(obj, keys, fallback) {
  if (!obj) return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
}

// Traffio's numeric booking_status_id, mapped onto the dashboard's bookings
// status CHECK values (migration 89). Legend confirmed via the live API
// reference endpoint GET /v1_booking/booking_status. 11 (Part Invoiced) and
// 12 (Invoiced) have no booking-status equivalent here — invoice state is
// tracked by the invoices module — so they collapse to 'finalised'.
const TRAFFIO_STATUS_BY_ID = {
  '1': 'unconfirmed', '2': 'confirmed', '3': 'locked', '4': 'conflict',
  '5': 'green_to_go', '6': 'cancelled', '7': 'complete', '8': 'client_booking',
  '9': 'finalised', '10': 'late_cancellation', '11': 'finalised', '12': 'finalised',
};

/** Map a Traffio booking status (numeric id, or string) onto an allowed bookings status. */
function mapBookingStatus(raw) {
  if (raw == null || raw === '') return 'confirmed';
  const idKey = String(raw).trim();
  if (TRAFFIO_STATUS_BY_ID[idKey]) return TRAFFIO_STATUS_BY_ID[idKey];
  const s = idKey.toLowerCase().replace(/\s+/g, '_');
  const allowed = {
    confirmed: 'confirmed', unconfirmed: 'unconfirmed', pending: 'unconfirmed',
    cancelled: 'cancelled', canceled: 'cancelled', complete: 'complete',
    completed: 'complete', in_progress: 'in_progress', on_hold: 'on_hold',
    green_to_go: 'green_to_go', locked: 'locked', conflict: 'conflict',
    finalised: 'finalised', finalized: 'finalised', client_booking: 'client_booking',
    late_cancellation: 'late_cancellation',
  };
  return allowed[s] || 'confirmed';
}

/** Derive start/end datetimes ("YYYY-MM-DD HH:mm:ss") from a Traffio booking. */
function deriveDateTimes(payload) {
  let start = pick(payload, ['booking_start_time', 'start_datetime', 'starts_at', 'start_at', 'start']);
  let end = pick(payload, ['approx_booking_end_time', 'end_datetime', 'ends_at', 'end_at', 'end']);
  const date = pick(payload, ['date', 'booking_date', 'shift_date']);
  if (!start && date) start = `${date} ${pick(payload, ['start_time'], '06:00:00')}`;
  if (!end && date) end = `${date} ${pick(payload, ['end_time'], '14:30:00')}`;
  return { start: start || null, end: end || start || null };
}

/** Human-readable one-liner for the reconciliation queue. */
function summarizeBooking(payload) {
  const ref = pick(payload, ['job_number', 'booking_id', 'reference', 'number', 'id'], '?');
  const title = pick(payload, ['booking_title', 'title', 'name'], '');
  const site = pick(payload, ['booking_address', 'site_address', 'address', 'location'], '');
  const date = pick(payload, ['booking_start_time', 'date', 'start_datetime', 'starts_at'], '');
  return [`Job ${ref}`, title, site, date].filter(Boolean).join(' · ');
}

/**
 * Confident job match for a Traffio booking, or null. Strict on purpose:
 * an existing external_ref mapping (keyed on Traffio's project_id — recorded
 * once a booking for that project is reconciled), or an exact job_number /
 * client_project_number. Anything looser goes to the reconciliation queue.
 */
function findConfidentJobId(db, payload) {
  const projectId = pick(payload, ['project_id', 'job_id', 'jobId']);
  if (projectId != null) {
    const ref = getInternalRef('traffio', 'job', String(projectId));
    if (ref) return ref.internal_id;
  }
  const jobRef = pick(payload, ['job_number', 'parent_job_number', 'job_reference', 'reference', 'project_number']);
  if (jobRef) {
    const row = db.prepare('SELECT id FROM jobs WHERE job_number = ? OR client_project_number = ?')
      .get(String(jobRef), String(jobRef));
    if (row) return row.id;
  }
  return null;
}

/** Queue an ambiguous Traffio record for human reconciliation (idempotent; never resurrects a discarded/confirmed row). */
function queueImport(db, recordType, payload) {
  const externalId = String(pick(payload, ['id', 'booking_id', 'docket_id'], ''));
  if (!externalId) return;
  const eventDate = pick(payload, ['booking_start_time', 'date', 'start_datetime', 'starts_at'], null);
  db.prepare(`
    INSERT INTO traffio_imports (record_type, traffio_external_id, proposed_json, summary, event_date)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(record_type, traffio_external_id) DO UPDATE SET
      proposed_json = excluded.proposed_json,
      summary = excluded.summary,
      event_date = excluded.event_date,
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
  `).run(recordType, externalId, JSON.stringify(payload), summarizeBooking(payload), eventDate);
}

/**
 * Upsert a `bookings` row from a Traffio booking payload, linked to jobId
 * (may be null on update — existing job_id is preserved). Records the
 * external_ref mapping and resolves any matching pending reconciliation row.
 * Used by both the confident sync path and the reconciliation confirm route.
 * Returns the local booking id. Throws if no start datetime can be derived.
 */
function upsertBookingFromTraffio(db, payload, jobId, userId) {
  const externalId = String(pick(payload, ['booking_id', 'id'], ''));
  const { start, end } = deriveDateTimes(payload);
  const isDeleted = payload.is_deleted === true || payload.is_deleted === 1 || payload.is_deleted === '1';
  const status = isDeleted ? 'cancelled' : mapBookingStatus(pick(payload, ['booking_status_id', 'booking_status', 'status', 'state']));
  const title = pick(payload, ['booking_title', 'title', 'name', 'description'], `Traffio booking ${externalId}`);
  const siteAddress = pick(payload, ['booking_address', 'site_address', 'address', 'location'], '');
  const suburb = pick(payload, ['suburb'], '');
  const state = pick(payload, ['state'], '');
  const postcode = pick(payload, ['postcode', 'post_code'], '');
  const billingCode = pick(payload, ['client_billing_code', 'client_order_number', 'billing_code', 'order_number', 'po_number'], '');
  const lat = pick(payload, ['booking_lat', 'latitude', 'lat']);
  const lng = pick(payload, ['booking_lng', 'longitude', 'lng']);

  // client_id: prefer the linked job's client, else a mapped Traffio client
  let clientId = null;
  if (jobId) {
    const j = db.prepare('SELECT client_id FROM jobs WHERE id = ?').get(jobId);
    if (j) clientId = j.client_id;
  }
  if (!clientId) {
    const tClient = pick(payload, ['client_id', 'customer_id']);
    if (tClient != null) {
      const cr = getInternalRef('traffio', 'client', String(tClient));
      if (cr) clientId = cr.internal_id;
    }
  }

  const existing = externalId ? getInternalRef('traffio', 'booking', externalId) : null;
  let bookingId;
  if (existing) {
    db.prepare(`
      UPDATE bookings SET
        job_id = COALESCE(?, job_id),
        client_id = COALESCE(?, client_id),
        title = ?,
        status = ?,
        start_datetime = COALESCE(?, start_datetime),
        end_datetime = COALESCE(?, end_datetime),
        site_address = COALESCE(NULLIF(?, ''), site_address),
        suburb = COALESCE(NULLIF(?, ''), suburb),
        state = COALESCE(NULLIF(?, ''), state),
        postcode = COALESCE(NULLIF(?, ''), postcode),
        billing_code = COALESCE(NULLIF(?, ''), billing_code),
        latitude = COALESCE(?, latitude),
        longitude = COALESCE(?, longitude),
        source = 'traffio',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(jobId || null, clientId || null, title, status, start, end,
      siteAddress, suburb, state, postcode, billingCode,
      lat != null ? Number(lat) : null, lng != null ? Number(lng) : null, existing.internal_id);
    bookingId = existing.internal_id;
  } else {
    if (!start) throw new Error('no start datetime');
    const result = db.prepare(`
      INSERT INTO bookings (booking_number, job_id, client_id, title, status, start_datetime, end_datetime,
        site_address, suburb, state, postcode, billing_code, latitude, longitude, billable, source, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'traffio', ?)
    `).run(`TRF-B-${externalId}`, jobId || null, clientId || null, title, status, start, end || start,
      siteAddress, suburb, state, postcode, billingCode,
      lat != null ? Number(lat) : null, lng != null ? Number(lng) : null, userId || null);
    bookingId = result.lastInsertRowid;
  }

  if (externalId) setExternalRef('traffio', 'booking', bookingId, externalId, payload);

  // Teach confident matching: map this Traffio project to the chosen job so
  // future bookings for the same project auto-link instead of queueing.
  if (jobId) {
    const projectId = pick(payload, ['project_id', 'job_id', 'jobId']);
    if (projectId != null && !getInternalRef('traffio', 'job', String(projectId))) {
      setExternalRef('traffio', 'job', jobId, String(projectId), { source: 'booking_reconcile' });
    }
  }

  // Resolve any pending reconciliation row for this Traffio booking
  db.prepare(`
    UPDATE traffio_imports SET status = 'confirmed', resulting_booking_id = ?,
      matched_job_id = COALESCE(matched_job_id, ?), updated_at = CURRENT_TIMESTAMP
    WHERE record_type = 'booking' AND traffio_external_id = ? AND status = 'pending'
  `).run(bookingId, jobId || null, externalId);

  return bookingId;
}

// ---- Sync Jobs ----

async function syncTraffioJobs(triggeredBy) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'job', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    const response = await client.get('/api/v1/jobs');
    const traffioJobs = response.data.data || response.data || [];

    for (const tj of traffioJobs) {
      stats.processed++;
      try {
        const externalId = String(tj.id || tj.job_id);

        // Check if we already have this mapped
        const existing = getInternalRef('traffio', 'job', externalId);

        if (existing) {
          // Update existing job
          db.prepare(`
            UPDATE jobs SET
              client = COALESCE(?, client),
              site_address = COALESCE(?, site_address),
              suburb = COALESCE(?, suburb),
              client_project_number = COALESCE(?, client_project_number),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            tj.client_name || null,
            tj.site_address || tj.address || null,
            tj.suburb || null,
            tj.reference || tj.job_number || null,
            existing.internal_id
          );
          setExternalRef('traffio', 'job', existing.internal_id, externalId, tj);
          stats.updated++;
        } else {
          // Try to match by client_project_number or job_number
          const matchByRef = db.prepare(`
            SELECT id FROM jobs WHERE client_project_number = ? OR job_number = ?
          `).get(tj.reference || '', tj.job_number || '');

          if (matchByRef) {
            setExternalRef('traffio', 'job', matchByRef.id, externalId, tj);
            stats.updated++;
          } else {
            // Create new job
            const jobNumber = tj.job_number || tj.reference || `TRF-${externalId}`;
            const result = db.prepare(`
              INSERT INTO jobs (job_number, job_name, client, site_address, suburb, status, stage, start_date, client_project_number)
              VALUES (?, ?, ?, ?, ?, 'active', 'delivery', ?, ?)
            `).run(
              jobNumber,
              tj.name || tj.job_name || jobNumber,
              tj.client_name || tj.client || 'Unknown Client',
              tj.site_address || tj.address || '',
              tj.suburb || '',
              tj.start_date || new Date().toISOString().split('T')[0],
              tj.reference || ''
            );
            setExternalRef('traffio', 'job', result.lastInsertRowid, externalId, tj);
            stats.created++;
          }
        }
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Job ${tj.id}: ${err.message}\n`;
      }
    }

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Sync People → crew_members ----

// Map a Traffio resource/role name onto the crew_members.role CHECK set.
function mapCrewRole(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('leading') || s.includes('team leader')) return 'leading_hand';
  if (s.includes('supervisor')) return 'supervisor';
  if (s.includes('pilot')) return 'pilot_vehicle';
  if (s.includes('spotter')) return 'spotter';
  if (s.includes('labour')) return 'labourer';
  return 'traffic_controller'; // most Traffio field people are TCs
}

// Resolve a Traffio person_id to a local crew_members id (via external_ref).
function resolveCrewId(db, personId) {
  if (personId == null || personId === '') return null;
  const r = getInternalRef('traffio', 'crew', String(personId));
  return r ? r.internal_id : null;
}

// ---- date/time helpers for "YYYY-MM-DD HH:mm:ss" Traffio stamps ----
function datePart(dt) { const s = String(dt || ''); return s.split(/[ T]/)[0] || null; }
function timePart(dt) { const p = String(dt || '').split(/[ T]/)[1] || ''; return p.slice(0, 5) || null; }
function nightOrDay(timeStr) { const h = parseInt(String(timeStr || '').slice(0, 2), 10); return (isFinite(h) && (h < 6 || h >= 18)) ? 'night' : 'day'; }
const isTruthy = (v) => v === '1' || v === 1 || v === true || String(v).toUpperCase() === 'YES';

async function syncTraffioCrew(triggeredBy) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'crew', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    const response = await client.get('/v1_person/person');
    const people = Array.isArray(response.data) ? response.data : (response.data.data || []);

    for (const p of people) {
      stats.processed++;
      try {
        const externalId = String(pick(p, ['person_id'], ''));
        if (!externalId) { stats.failed++; continue; }
        const fullName = [pick(p, ['preferred_name']) || pick(p, ['first_name'], ''), pick(p, ['last_name'], '')]
          .filter(Boolean).join(' ').trim() || `Person ${externalId}`;
        const employeeId = pick(p, ['employee_reference'], null) || `TRF-P-${externalId}`;
        const role = mapCrewRole(pick(p, ['resource_name', 'person_category_title', 'person_job_title']));
        const phone = pick(p, ['mobile'], '');
        const email = pick(p, ['email'], '');
        const licType = pick(p, ['driver_licence_type_name'], '');
        const licExpiry = pick(p, ['person_driver_licence_expiry_date'], null);
        const active = isTruthy(p.is_deleted) ? 0 : 1;

        // Resolve existing: external_ref first, then by employee_reference, else create.
        let crewId = null;
        const ref = getInternalRef('traffio', 'crew', externalId);
        if (ref) crewId = ref.internal_id;
        if (!crewId && pick(p, ['employee_reference'], null)) {
          const m = db.prepare('SELECT id FROM crew_members WHERE employee_id = ?').get(String(p.employee_reference));
          if (m) crewId = m.id;
        }

        if (crewId) {
          db.prepare(`UPDATE crew_members SET full_name=?, phone=COALESCE(NULLIF(?,''),phone),
            email=COALESCE(NULLIF(?,''),email), role=?, licence_type=COALESCE(NULLIF(?,''),licence_type),
            licence_expiry=COALESCE(?,licence_expiry), active=? WHERE id=?`)
            .run(fullName, phone, email, role, licType, licExpiry, active, crewId);
          stats.updated++;
        } else {
          const result = db.prepare(`INSERT INTO crew_members (full_name, employee_id, role, phone, email, licence_type, licence_expiry, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(fullName, employeeId, role, phone, email, licType, licExpiry, active);
          crewId = result.lastInsertRowid;
          stats.created++;
        }
        setExternalRef('traffio', 'crew', crewId, externalId, p);
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Person ${p.person_id}: ${err.message}\n`;
      }
    }

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Sync Bookings → bookings table (with reconciliation gate) ----

// A Traffio "booking" is a job/shift at a site. Confident job matches upsert a
// `bookings` row directly; ambiguous ones are parked in `traffio_imports` for a
// human to map to an existing job (or create one) before a booking is created.
async function syncTraffioBookings(triggeredBy, fromDate, toDate) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'booking', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, queued: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    // Traffio wants "YYYY-MM-DD HH:mm:ss"; pad date-only inputs to a full day.
    const pad = (d, end) => d ? (d.length <= 10 ? `${d} ${end ? '23:59:59' : '00:00:00'}` : d) : null;
    const params = {};
    const df = pad(fromDate, false);
    const dt = pad(toDate, true);
    if (df) params.date_from = df;
    if (dt) params.date_to = dt;

    const response = await client.get('/v1_booking/booking', { params });
    const bookings = Array.isArray(response.data) ? response.data : (response.data.data || []);

    const systemUser = db.prepare("SELECT id FROM users WHERE role = 'management' LIMIT 1").get();
    const userId = systemUser ? systemUser.id : 1;

    for (const b of bookings) {
      stats.processed++;
      try {
        const externalId = String(b.id || b.booking_id || '');
        const existing = externalId ? getInternalRef('traffio', 'booking', externalId) : null;

        if (existing) {
          // Already mapped — refresh it (preserve its existing job link if no confident match)
          upsertBookingFromTraffio(db, b, findConfidentJobId(db, b), userId);
          stats.updated++;
        } else {
          const jobId = findConfidentJobId(db, b);
          if (jobId) {
            const newId = upsertBookingFromTraffio(db, b, jobId, userId);
            logActivity({
              action: 'create', entityType: 'booking', entityId: newId,
              entityLabel: summarizeBooking(b), jobId,
              details: 'Imported from Traffio',
            });
            stats.created++;
          } else {
            queueImport(db, 'booking', b);
            stats.queued++;
          }
        }
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Booking ${b.id}: ${err.message}\n`;
      }
    }

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Sync Works Dockets (billable hours, for invoicing) ----

// Imports signed works dockets + their per-person worked hours into the
// traffio_dockets / traffio_docket_persons staging tables. Dockets carry their
// own client + hours, so this is independent of booking reconciliation. The
// invoicing module assembles drafts from the signed, not-yet-invoiced rows.
async function syncTraffioDockets(triggeredBy, fromDate, toDate) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'docket', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };
  const truthy = (v) => v === '1' || v === 1 || v === true;
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  try {
    const client = getTraffioClient();
    const pad = (d, end) => d ? (d.length <= 10 ? `${d} ${end ? '23:59:59' : '00:00:00'}` : d) : null;
    const params = {};
    const df = pad(fromDate, false);
    const dt = pad(toDate, true);
    if (df) params.date_from = df;
    if (dt) params.date_to = dt;

    // 1) Dockets
    const dRes = await client.get('/v1_works_docket/works_docket', { params });
    const dockets = Array.isArray(dRes.data) ? dRes.data : (dRes.data.data || []);
    const upsertDocket = db.prepare(`
      INSERT INTO traffio_dockets (works_docket_id, works_docket_number, physical_number, booking_id, job_number,
        project_id, traffio_client_id, client_name, local_client_id, address, billing_reference,
        booking_start_time, approx_booking_end_time, signed_off, signed_off_at, signed_off_by_name,
        is_deleted, raw_json, last_modified, synced_at)
      VALUES (@wid,@num,@phys,@bid,@job,@proj,@cid,@cname,@lcid,@addr,@bill,@start,@end,@signed,@signedat,@signedby,@del,@raw,@lm,CURRENT_TIMESTAMP)
      ON CONFLICT(works_docket_id) DO UPDATE SET
        works_docket_number=excluded.works_docket_number, physical_number=excluded.physical_number,
        booking_id=excluded.booking_id, job_number=excluded.job_number, project_id=excluded.project_id,
        traffio_client_id=excluded.traffio_client_id, client_name=excluded.client_name,
        local_client_id=COALESCE(traffio_dockets.local_client_id, excluded.local_client_id),
        address=excluded.address, billing_reference=excluded.billing_reference,
        booking_start_time=excluded.booking_start_time, approx_booking_end_time=excluded.approx_booking_end_time,
        signed_off=excluded.signed_off, signed_off_at=excluded.signed_off_at, signed_off_by_name=excluded.signed_off_by_name,
        is_deleted=excluded.is_deleted, raw_json=excluded.raw_json, last_modified=excluded.last_modified,
        synced_at=CURRENT_TIMESTAMP
    `);
    for (const d of dockets) {
      stats.processed++;
      try {
        const tClientId = pick(d, ['client_id'], null);
        let localClientId = null;
        if (tClientId != null) {
          const cr = getInternalRef('traffio', 'client', String(tClientId));
          if (cr) localClientId = cr.internal_id;
        }
        if (!localClientId) {
          const cname = pick(d, ['client_name'], '');
          if (cname) { const c = db.prepare('SELECT id FROM clients WHERE company_name = ?').get(cname); if (c) localClientId = c.id; }
        }
        upsertDocket.run({
          wid: String(pick(d, ['works_docket_id'], '')),
          num: pick(d, ['works_docket_number'], null),
          phys: pick(d, ['works_docket_physical_number'], null),
          bid: pick(d, ['booking_id'], null) != null ? String(pick(d, ['booking_id'])) : null,
          job: pick(d, ['job_number'], null),
          proj: pick(d, ['project_id'], null) != null ? String(pick(d, ['project_id'])) : null,
          cid: tClientId != null ? String(tClientId) : null,
          cname: pick(d, ['client_name'], null),
          lcid: localClientId,
          addr: pick(d, ['works_docket_address'], null),
          bill: pick(d, ['works_docket_client_billing_reference'], null),
          start: pick(d, ['booking_start_time'], null),
          end: pick(d, ['approx_booking_end_time'], null),
          signed: truthy(d.signed_off) ? 1 : 0,
          signedat: pick(d, ['signed_off_at'], null),
          signedby: pick(d, ['signed_off_by_name'], null),
          del: truthy(d.is_deleted) ? 1 : 0,
          raw: JSON.stringify(d),
          lm: pick(d, ['last_modified'], null),
        });
        stats.created++;
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Docket ${d.works_docket_id}: ${err.message}\n`;
      }
    }

    // 2) Per-person worked hours
    const pRes = await client.get('/v1_works_docket/works_docket_person', { params });
    const persons = Array.isArray(pRes.data) ? pRes.data : (pRes.data.data || []);
    const upsertPerson = db.prepare(`
      INSERT INTO traffio_docket_persons (works_docket_id, person_id, first_name, last_name, resource_name,
        item_classification_name, time_on, time_off, total_hours, break_time, travel_time,
        lafha, general_allowance, rain_allowance, is_deleted, raw_json)
      VALUES (@wid,@pid,@fn,@ln,@res,@cls,@on,@off,@hrs,@brk,@trv,@laf,@gen,@rain,@del,@raw)
      ON CONFLICT(works_docket_id, person_id) DO UPDATE SET
        first_name=excluded.first_name, last_name=excluded.last_name, resource_name=excluded.resource_name,
        item_classification_name=excluded.item_classification_name, time_on=excluded.time_on, time_off=excluded.time_off,
        total_hours=excluded.total_hours, break_time=excluded.break_time, travel_time=excluded.travel_time,
        lafha=excluded.lafha, general_allowance=excluded.general_allowance, rain_allowance=excluded.rain_allowance,
        is_deleted=excluded.is_deleted, raw_json=excluded.raw_json
    `);
    for (const p of persons) {
      try {
        upsertPerson.run({
          wid: String(pick(p, ['works_docket_id'], '')),
          pid: pick(p, ['person_id'], null) != null ? String(pick(p, ['person_id'])) : null,
          fn: pick(p, ['first_name'], null), ln: pick(p, ['last_name'], null),
          res: pick(p, ['resource_name'], null), cls: pick(p, ['item_classification_name'], null),
          on: pick(p, ['works_docket_time_on'], null), off: pick(p, ['works_docket_time_off'], null),
          hrs: num(pick(p, ['total_hours'], 0)),
          brk: num(pick(p, ['works_docket_person_break_time'], 0)),
          trv: num(pick(p, ['works_docket_person_travel_time'], 0)),
          laf: pick(p, ['works_docket_person_lafha'], null),
          gen: pick(p, ['works_docket_person_general_allowance'], null),
          rain: pick(p, ['works_docket_person_rain_allowance'], null),
          del: truthy(p.is_deleted) ? 1 : 0,
          raw: JSON.stringify(p),
        });
      } catch (err) {
        stats.errorDetails += `Person ${p.person_id}@${p.works_docket_id}: ${err.message}\n`;
      }
    }
    stats.updated = persons.length; // person-line rows imported

    updateSyncStatus('traffio', 'success');
  } catch (err) {
    stats.errorDetails = err.message;
    updateSyncStatus('traffio', 'error', err.message);
  }

  completeSyncLog(logId, stats);
  return stats;
}

// ---- Sync Booking Crew → crew_allocations (dashboard: Crew Today / Gaps / Unconfirmed) ----
// Only creates allocations for bookings already synced locally WITH a job (job_id
// is NOT NULL on crew_allocations). Unmatched/queued bookings are skipped until
// reconciled — coverage grows as the reconciliation queue is worked.
async function syncTraffioBookingCrew(triggeredBy, fromDate, toDate) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'allocation', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, errorDetails: '' };
  try {
    const client = getTraffioClient();
    const pad = (d, end) => d ? (d.length <= 10 ? `${d} ${end ? '23:59:59' : '00:00:00'}` : d) : null;
    const params = {};
    if (fromDate) params.date_from = pad(fromDate, false);
    if (toDate) params.date_to = pad(toDate, true);
    const res = await client.get('/v1_booking/booking_person', { params });
    const rows = Array.isArray(res.data) ? res.data : (res.data.data || []);
    const sysUser = db.prepare("SELECT id FROM users WHERE role IN ('management','admin') ORDER BY id LIMIT 1").get();
    const allocBy = sysUser ? sysUser.id : 1;

    for (const bp of rows) {
      stats.processed++;
      try {
        if (isTruthy(bp.is_deleted)) { stats.skipped++; continue; }
        const bookingExtId = String(pick(bp, ['booking_id'], ''));
        const bookingRef = bookingExtId ? getInternalRef('traffio', 'booking', bookingExtId) : null;
        if (!bookingRef) { stats.skipped++; continue; }            // booking not synced locally yet
        const booking = db.prepare('SELECT id, job_id FROM bookings WHERE id = ?').get(bookingRef.internal_id);
        if (!booking || !booking.job_id) { stats.skipped++; continue; } // allocation needs a job
        const crewId = resolveCrewId(db, pick(bp, ['person_id']));
        if (!crewId) { stats.skipped++; continue; }

        const allocDate = datePart(pick(bp, ['start_time'])) || datePart(pick(bp, ['booking_start_time']));
        if (!allocDate) { stats.skipped++; continue; }
        const startT = timePart(pick(bp, ['start_time'])) || '06:00';
        const endT = timePart(pick(bp, ['end_time'])) || '14:30';
        const shift = nightOrDay(startT);
        const status = isTruthy(pick(bp, ['confirmed'])) ? 'confirmed' : 'allocated';
        const role = isTruthy(bp.is_team_leader) ? 'leading_hand' : (isTruthy(bp.is_spotter) ? 'spotter' : '');

        const extKey = `${bookingExtId}:${pick(bp, ['person_id'], '')}`;
        const existing = getInternalRef('traffio', 'allocation', extKey);
        if (existing) {
          db.prepare(`UPDATE crew_allocations SET job_id=?, crew_member_id=?, allocation_date=?, start_time=?, end_time=?, shift_type=?, role_on_site=?, status=? WHERE id=?`)
            .run(booking.job_id, crewId, allocDate, startT, endT, shift, role, status, existing.internal_id);
          stats.updated++;
        } else {
          const r = db.prepare(`INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, shift_type, role_on_site, status, allocated_by_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(booking.job_id, crewId, allocDate, startT, endT, shift, role, status, allocBy);
          setExternalRef('traffio', 'allocation', r.lastInsertRowid, extKey, bp);
          stats.created++;
        }
      } catch (err) { stats.failed++; stats.errorDetails += `BP ${bp.booking_id}/${bp.person_id}: ${err.message}\n`; }
    }
    updateSyncStatus('traffio', 'success');
  } catch (err) { stats.errorDetails = err.message; updateSyncStatus('traffio', 'error', err.message); }
  completeSyncLog(logId, stats);
  return stats;
}

// ---- Project staged docket hours → timesheets (dashboard: Hours 7d / Pending Timesheets) ----
// Uses traffio_docket_persons (already imported by syncTraffioDockets); no API call.
// Needs a resolvable local job (timesheets.job_id is NOT NULL).
function syncTimesheetsFromDockets(triggeredBy) {
  const db = getDb();
  const logId = startSyncLog('traffio', 'import', 'timesheet', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, errorDetails: '' };
  try {
    const sysUser = db.prepare("SELECT id FROM users WHERE role IN ('management','admin') ORDER BY id LIMIT 1").get();
    const subBy = sysUser ? sysUser.id : 1;
    const rows = db.prepare(`
      SELECT p.works_docket_id, p.person_id, p.time_on, p.time_off, p.total_hours, p.break_time,
             d.job_number, d.project_id
      FROM traffio_docket_persons p
      JOIN traffio_dockets d ON d.works_docket_id = p.works_docket_id
      WHERE p.is_deleted = 0 AND d.is_deleted = 0 AND d.signed_off = 1
    `).all();
    for (const r of rows) {
      stats.processed++;
      try {
        const crewId = resolveCrewId(db, r.person_id);
        if (!crewId) { stats.skipped++; continue; }
        let jobId = null;
        if (r.project_id) { const jr = getInternalRef('traffio', 'job', String(r.project_id)); if (jr) jobId = jr.internal_id; }
        if (!jobId && r.job_number) { const j = db.prepare('SELECT id FROM jobs WHERE job_number=? OR client_project_number=?').get(String(r.job_number), String(r.job_number)); if (j) jobId = j.id; }
        if (!jobId) { stats.skipped++; continue; }
        const workDate = datePart(r.time_on); if (!workDate) { stats.skipped++; continue; }
        const startT = timePart(r.time_on) || '06:00';
        const endT = timePart(r.time_off) || startT;
        const shift = nightOrDay(startT);
        const hours = Number(r.total_hours) || 0;
        const breakMin = Math.round((Number(r.break_time) || 0) * 60);

        const extKey = `${r.works_docket_id}:${r.person_id}`;
        const existing = getInternalRef('traffio', 'timesheet', extKey);
        if (existing) {
          db.prepare(`UPDATE timesheets SET job_id=?, crew_member_id=?, work_date=?, start_time=?, end_time=?, break_minutes=?, total_hours=?, shift_type=? WHERE id=?`)
            .run(jobId, crewId, workDate, startT, endT, breakMin, hours, shift, existing.internal_id);
          stats.updated++;
        } else {
          const ins = db.prepare(`INSERT INTO timesheets (job_id, crew_member_id, work_date, start_time, end_time, break_minutes, total_hours, shift_type, approved, submitted_by_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`).run(jobId, crewId, workDate, startT, endT, breakMin, hours, shift, subBy);
          setExternalRef('traffio', 'timesheet', ins.lastInsertRowid, extKey, { works_docket_id: r.works_docket_id, person_id: r.person_id });
          stats.created++;
        }
      } catch (err) { stats.failed++; stats.errorDetails += `TS ${r.works_docket_id}/${r.person_id}: ${err.message}\n`; }
    }
    updateSyncStatus('traffio', 'success');
  } catch (err) { stats.errorDetails = err.message; updateSyncStatus('traffio', 'error', err.message); }
  completeSyncLog(logId, stats);
  return stats;
}

// ---- Mirror staged Traffio dockets → native booking_dockets + docket_time_entries ----
// The booking "Dockets" tab (views/bookings/show.ejs) reads the dashboard's own
// booking_dockets, NOT the traffio_dockets staging tables that feed invoicing — so a
// reconciled booking showed "Dockets (0)" even when Traffio had a signed docket for it.
// This mirrors each staged docket (and its per-person worked hours) into the native
// tables so they render natively, read-only. Only dockets whose Traffio booking resolves
// to a local booking are mirrored (booking_dockets.booking_id is NOT NULL); the rest are
// skipped until the booking is reconciled. Reads the staging tables already populated by
// syncTraffioDockets — no API call. Idempotent via external_refs.
function mirrorTraffioDocketsToBookings(triggeredBy) {
  const db = getDb();
  const logId = startSyncLog('traffio', 'import', 'booking_docket', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, errorDetails: '' };
  try {
    const sysUser = db.prepare("SELECT id FROM users WHERE role IN ('management','admin') ORDER BY id LIMIT 1").get();
    const createdBy = sysUser ? sysUser.id : 1;
    const dockets = db.prepare(`
      SELECT works_docket_id, works_docket_number, physical_number, booking_id,
             address, billing_reference, signed_off
      FROM traffio_dockets WHERE is_deleted = 0
    `).all();
    const insDocket = db.prepare(`
      INSERT INTO booking_dockets (booking_id, docket_number, status, physical_docket_number,
        client_billing_ref, site_address, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const updDocket = db.prepare(`
      UPDATE booking_dockets SET status=?, physical_docket_number=?, client_billing_ref=?,
        site_address=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `);
    const personsFor = db.prepare(`
      SELECT person_id, time_on, time_off, total_hours, break_time, travel_time, lafha
      FROM traffio_docket_persons WHERE works_docket_id = ? AND is_deleted = 0
    `);
    const insTime = db.prepare(`
      INSERT INTO docket_time_entries (docket_id, crew_member_id, start_on_site, finish_on_site,
        first_break, travel, lafha, total_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updTime = db.prepare(`
      UPDATE docket_time_entries SET docket_id=?, crew_member_id=?, start_on_site=?, finish_on_site=?,
        first_break=?, travel=?, lafha=?, total_hours=? WHERE id=?
    `);

    for (const d of dockets) {
      stats.processed++;
      try {
        if (d.booking_id == null) { stats.skipped++; continue; }
        const bRef = getInternalRef('traffio', 'booking', String(d.booking_id));
        if (!bRef) { stats.skipped++; continue; }                 // booking not reconciled locally yet
        const localBookingId = bRef.internal_id;
        const status = isTruthy(d.signed_off) ? 'signed' : 'draft';
        const physical = d.physical_number != null ? String(d.physical_number) : '';

        const existing = getInternalRef('traffio', 'booking_docket', String(d.works_docket_id));
        let docketId;
        if (existing) {
          docketId = existing.internal_id;
          updDocket.run(status, physical, d.billing_reference || '', d.address || '', docketId);
          stats.updated++;
        } else {
          const docketNumber = `TRAF-${d.works_docket_id}`;
          const r = insDocket.run(localBookingId, docketNumber, status, physical,
            d.billing_reference || '', d.address || '', createdBy);
          docketId = r.lastInsertRowid;
          setExternalRef('traffio', 'booking_docket', docketId, String(d.works_docket_id), { works_docket_id: d.works_docket_id });
          stats.created++;
        }

        // Per-person worked hours → docket_time_entries (crew_member_id NOT NULL → skip unresolved)
        for (const p of personsFor.all(d.works_docket_id)) {
          const crewId = resolveCrewId(db, p.person_id);
          if (!crewId) continue;
          const firstBreak = Number(p.break_time) || 0;
          const travel = Number(p.travel_time) || 0;
          const lafha = isTruthy(p.lafha) ? 1 : 0;
          const hours = Number(p.total_hours) || 0;
          const extKey = `${d.works_docket_id}:${p.person_id}`;
          const exTime = getInternalRef('traffio', 'docket_time', extKey);
          if (exTime) {
            updTime.run(docketId, crewId, p.time_on, p.time_off, firstBreak, travel, lafha, hours, exTime.internal_id);
          } else {
            const tr = insTime.run(docketId, crewId, p.time_on, p.time_off, firstBreak, travel, lafha, hours);
            setExternalRef('traffio', 'docket_time', tr.lastInsertRowid, extKey, { works_docket_id: d.works_docket_id, person_id: p.person_id });
          }
        }
      } catch (err) { stats.failed++; stats.errorDetails += `Mirror docket ${d.works_docket_id}: ${err.message}\n`; }
    }
    updateSyncStatus('traffio', 'success');
  } catch (err) { stats.errorDetails = err.message; updateSyncStatus('traffio', 'error', err.message); }
  completeSyncLog(logId, stats);
  return stats;
}

// Map a Traffio form name onto the dashboard's safety_forms.form_type values.
function mapFormType(name) {
  const s = String(name || '').toLowerCase();
  if (s.includes('vehicle pre')) return 'vehicle_prestart';
  if (s.includes('post shift') || s.includes('post-shift')) return 'post_shift_vehicle';
  if (s.includes('risk') || s.includes('toolbox')) return 'risk_toolbox';
  if (s.includes('prestart declaration') || (s.includes('traffic controller') && s.includes('prestart'))) return 'tc_prestart';
  if (s.includes('team leader')) return 'team_leader';
  return null;
}

// ---- Sync completed Form submissions → safety_forms (dashboard: Checklist Register) ----
async function syncTraffioForms(triggeredBy, fromDate, toDate) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'form', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, errorDetails: '' };
  try {
    const client = getTraffioClient();
    const pad = (d, end) => d ? (d.length <= 10 ? `${d} ${end ? '23:59:59' : '00:00:00'}` : d) : null;
    const params = {};
    if (fromDate) params.date_from = pad(fromDate, false);
    if (toDate) params.date_to = pad(toDate, true);
    const res = await client.get('/v1_form/form_submission', { params });
    const rows = Array.isArray(res.data) ? res.data : (res.data.data || []);
    for (const f of rows) {
      stats.processed++;
      try {
        if (isTruthy(f.is_deleted)) { stats.skipped++; continue; }
        // A form counts as done when a submission exists with a submitted time
        // (Traffio's "Open" state — author + timestamp). The form_submission_is_complete
        // flag is an internal validation marker that's ~always 0 in practice.
        const submittedAt = pick(f, ['form_submission_submitted_time'], null);
        if (!submittedAt) { stats.skipped++; continue; }
        const formType = mapFormType(pick(f, ['form_name']));
        if (!formType) { stats.skipped++; continue; }                                 // not a register form
        // Form submissions identify the submitter via created_by (= person_id),
        // not the (empty) person_id field.
        const crewId = resolveCrewId(db, pick(f, ['created_by', 'person_id']));
        if (!crewId) { stats.skipped++; continue; }                                   // crew_member_id NOT NULL
        let jobId = null;
        const bExt = pick(f, ['booking_id'], null);
        if (bExt != null) {
          const br = getInternalRef('traffio', 'booking', String(bExt));
          if (br) { const b = db.prepare('SELECT job_id FROM bookings WHERE id=?').get(br.internal_id); if (b) jobId = b.job_id; }
        }
        const extId = String(pick(f, ['form_submission_id'], ''));
        const existing = getInternalRef('traffio', 'form_submission', extId);
        if (existing) {
          db.prepare(`UPDATE safety_forms SET crew_member_id=?, form_type=?, job_id=?, submitted_at=COALESCE(?,submitted_at) WHERE id=?`)
            .run(crewId, formType, jobId, submittedAt, existing.internal_id);
          stats.updated++;
        } else {
          const ins = db.prepare(`INSERT INTO safety_forms (crew_member_id, form_type, job_id, status, submitted_at, data)
            VALUES (?, ?, ?, 'submitted', COALESCE(?, datetime('now')), ?)`)
            .run(crewId, formType, jobId, submittedAt, JSON.stringify({ source: 'traffio', form_submission_id: extId, form_name: pick(f, ['form_name'], ''), author: pick(f, ['author'], '') }));
          setExternalRef('traffio', 'form_submission', ins.lastInsertRowid, extId, { form_submission_id: extId });
          stats.created++;
        }
      } catch (err) { stats.failed++; stats.errorDetails += `Form ${f.form_submission_id}: ${err.message}\n`; }
    }
    updateSyncStatus('traffio', 'success');
  } catch (err) { stats.errorDetails = err.message; updateSyncStatus('traffio', 'error', err.message); }
  completeSyncLog(logId, stats);
  return stats;
}

// ---- Test Connection ----

async function testTraffioConnection() {
  const client = getTraffioClient();
  const today = new Date().toISOString().split('T')[0];
  const response = await client.get('/v1_booking/booking', {
    params: { date_from: `${today} 00:00:00`, date_to: `${today} 23:59:59` },
  });
  const rows = Array.isArray(response.data) ? response.data : (response.data.data || []);
  return { status: response.status, data: { bookings_today: rows.length } };
}

module.exports = {
  syncTraffioJobs,
  syncTraffioCrew,
  syncTraffioBookings,
  syncTraffioDockets,
  syncTraffioBookingCrew,
  syncTimesheetsFromDockets,
  mirrorTraffioDocketsToBookings,
  syncTraffioForms,
  testTraffioConnection,
  // Reconciliation helpers (used by routes/traffio-imports.js)
  upsertBookingFromTraffio,
  findConfidentJobId,
  summarizeBooking,
};
