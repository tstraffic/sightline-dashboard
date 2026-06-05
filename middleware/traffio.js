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

/** Map a Traffio booking status onto a value allowed by the bookings CHECK. */
function mapBookingStatus(raw) {
  const s = String(raw || '').toLowerCase().replace(/\s+/g, '_');
  const allowed = {
    confirmed: 'confirmed', unconfirmed: 'unconfirmed', pending: 'unconfirmed',
    cancelled: 'cancelled', canceled: 'cancelled', complete: 'complete',
    completed: 'complete', in_progress: 'in_progress', on_hold: 'on_hold',
    green_to_go: 'green_to_go',
  };
  return allowed[s] || 'confirmed';
}

/** Derive ISO-ish start/end datetimes from a Traffio booking payload. */
function deriveDateTimes(payload) {
  let start = pick(payload, ['start_datetime', 'starts_at', 'start_at', 'start']);
  let end = pick(payload, ['end_datetime', 'ends_at', 'end_at', 'end']);
  const date = pick(payload, ['date', 'booking_date', 'shift_date']);
  if (!start && date) start = `${date}T${pick(payload, ['start_time'], '06:00')}`;
  if (!end && date) end = `${date}T${pick(payload, ['end_time'], '14:30')}`;
  return { start: start || null, end: end || start || null };
}

/** Human-readable one-liner for the reconciliation queue. */
function summarizeBooking(payload) {
  const ref = pick(payload, ['reference', 'booking_number', 'number', 'id'], '?');
  const client = pick(payload, ['client_name', 'client', 'customer_name'], '');
  const site = pick(payload, ['site_address', 'address', 'location'], '');
  const date = pick(payload, ['date', 'start_datetime', 'starts_at', 'booking_date'], '');
  return [`Ref ${ref}`, client, site, date].filter(Boolean).join(' · ');
}

/**
 * Confident job match for a Traffio booking, or null. Strict on purpose:
 * an existing external_ref mapping, or an exact job_number / client_project_number.
 * Anything looser goes to the reconciliation queue rather than guessing.
 */
function findConfidentJobId(db, payload) {
  const traffioJobId = pick(payload, ['job_id', 'jobId', 'project_id']);
  if (traffioJobId != null) {
    const ref = getInternalRef('traffio', 'job', String(traffioJobId));
    if (ref) return ref.internal_id;
  }
  const jobRef = pick(payload, ['job_reference', 'job_number', 'reference', 'project_number']);
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
  db.prepare(`
    INSERT INTO traffio_imports (record_type, traffio_external_id, proposed_json, summary)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(record_type, traffio_external_id) DO UPDATE SET
      proposed_json = excluded.proposed_json,
      summary = excluded.summary,
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'pending'
  `).run(recordType, externalId, JSON.stringify(payload), summarizeBooking(payload));
}

/**
 * Upsert a `bookings` row from a Traffio booking payload, linked to jobId
 * (may be null on update — existing job_id is preserved). Records the
 * external_ref mapping and resolves any matching pending reconciliation row.
 * Used by both the confident sync path and the reconciliation confirm route.
 * Returns the local booking id. Throws if no start datetime can be derived.
 */
function upsertBookingFromTraffio(db, payload, jobId, userId) {
  const externalId = String(pick(payload, ['id', 'booking_id'], ''));
  const { start, end } = deriveDateTimes(payload);
  const status = mapBookingStatus(pick(payload, ['status', 'state']));
  const title = pick(payload, ['title', 'name', 'description'], `Traffio booking ${externalId}`);
  const siteAddress = pick(payload, ['site_address', 'address', 'location'], '');
  const suburb = pick(payload, ['suburb'], '');
  const state = pick(payload, ['state'], '');
  const postcode = pick(payload, ['postcode', 'post_code'], '');
  const billingCode = pick(payload, ['billing_code', 'order_number', 'po_number'], '');

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
        source = 'traffio',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(jobId || null, clientId || null, title, status, start, end,
      siteAddress, suburb, state, postcode, billingCode, existing.internal_id);
    bookingId = existing.internal_id;
  } else {
    if (!start) throw new Error('no start datetime');
    const result = db.prepare(`
      INSERT INTO bookings (booking_number, job_id, client_id, title, status, start_datetime, end_datetime,
        site_address, suburb, state, postcode, billing_code, billable, source, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'traffio', ?)
    `).run(`TRF-B-${externalId}`, jobId || null, clientId || null, title, status, start, end || start,
      siteAddress, suburb, state, postcode, billingCode, userId || null);
    bookingId = result.lastInsertRowid;
  }

  if (externalId) setExternalRef('traffio', 'booking', bookingId, externalId, payload);

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

// ---- Sync Crew / Workers ----

async function syncTraffioCrew(triggeredBy) {
  const db = getDb();
  updateSyncStatus('traffio', 'syncing');
  const logId = startSyncLog('traffio', 'import', 'crew', triggeredBy);
  const stats = { processed: 0, created: 0, updated: 0, failed: 0, errorDetails: '' };

  try {
    const client = getTraffioClient();
    const response = await client.get('/api/v1/workers');
    const workers = response.data.data || response.data || [];

    for (const w of workers) {
      stats.processed++;
      try {
        const externalId = String(w.id || w.worker_id);
        const employeeId = w.employee_id || w.payroll_id || externalId;

        // Try to find by employee_id first
        const existing = db.prepare('SELECT id FROM crew_members WHERE employee_id = ?').get(employeeId);

        if (existing) {
          db.prepare(`
            UPDATE crew_members SET
              full_name = COALESCE(?, full_name),
              phone = COALESCE(?, phone),
              email = COALESCE(?, email),
              role = COALESCE(?, role),
              licence_type = COALESCE(?, licence_type),
              licence_expiry = COALESCE(?, licence_expiry)
            WHERE id = ?
          `).run(
            w.name || w.full_name || null,
            w.phone || w.mobile || null,
            w.email || null,
            w.role || w.position || null,
            w.licence_type || w.license_class || null,
            w.licence_expiry || w.license_expiry || null,
            existing.id
          );
          setExternalRef('traffio', 'crew', existing.id, externalId, w);
          stats.updated++;
        } else {
          const result = db.prepare(`
            INSERT INTO crew_members (full_name, employee_id, role, phone, email, licence_type, licence_expiry, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)
          `).run(
            w.name || w.full_name || 'Unknown',
            employeeId,
            w.role || w.position || 'TC',
            w.phone || w.mobile || '',
            w.email || '',
            w.licence_type || w.license_class || '',
            w.licence_expiry || w.license_expiry || null
          );
          setExternalRef('traffio', 'crew', result.lastInsertRowid, externalId, w);
          stats.created++;
        }
      } catch (err) {
        stats.failed++;
        stats.errorDetails += `Worker ${w.id}: ${err.message}\n`;
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
    const params = {};
    if (fromDate) params.from_date = fromDate;
    if (toDate) params.to_date = toDate;

    const response = await client.get('/api/v1/bookings', { params });
    const bookings = response.data.data || response.data || [];

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

// ---- Test Connection ----

async function testTraffioConnection() {
  const client = getTraffioClient();
  const response = await client.get('/api/v1/ping');
  return { status: response.status, data: response.data };
}

module.exports = {
  syncTraffioJobs,
  syncTraffioCrew,
  syncTraffioBookings,
  testTraffioConnection,
  // Reconciliation helpers (used by routes/traffio-imports.js)
  upsertBookingFromTraffio,
  findConfidentJobId,
  summarizeBooking,
};
