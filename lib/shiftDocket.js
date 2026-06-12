// Shift docket helpers — the "one docket per shift" model.
//
// A docket is now a per-SHIFT record (header in docket_signatures) that covers
// the whole crew, with one line per crew member in docket_crew. A "shift" is:
//   - a BOOKING (crew come from booking_crew), or
//   - a JOB + date (crew come from crew_allocations for that job_id/date).
//
// These helpers are shared by the worker sign flow and the admin register so
// the shift-resolution / locking / completion logic lives in exactly one place.

/**
 * Overnight-safe hours calculation. Mirrors the inline JS the docket form used.
 * @returns {number} total hours, 2dp, never negative.
 */
function calcHours(start, finish, breakMinutes, travelHours) {
  if (!start || !finish) return 0;
  const [sh, sm] = String(start).split(':').map(Number);
  const [fh, fm] = String(finish).split(':').map(Number);
  if ([sh, sm, fh, fm].some(n => Number.isNaN(n))) return 0;
  const startMin = sh * 60 + sm;
  const finishMin = fh * 60 + fm;
  const workedMin = finishMin > startMin ? finishMin - startMin : (1440 - startMin) + finishMin;
  const breakMin = parseInt(breakMinutes, 10) || 0;
  const travel = parseFloat(travelHours) || 0;
  const total = Math.max(0, (workedMin - breakMin) / 60) + travel;
  return Math.round(total * 100) / 100;
}

/**
 * Resolve a shift from a booking id or an allocation id into a normalised
 * descriptor with its crew list. Returns null if nothing matches.
 *
 * @param {object} db better-sqlite3 handle
 * @param {{bookingId?:number, allocationId?:number}} opts
 * @returns {null | {
 *   type:'booking'|'job', bookingId:number|null, jobId:number|null,
 *   shiftDate:string, startTime:string, endTime:string,
 *   site:{number:string,name:string,client:string,address:string,suburb:string},
 *   crew: Array<{crew_member_id:number, allocation_id:number|null,
 *                booking_crew_id:number|null, name:string, role:string,
 *                is_team_leader:number}>
 * }}
 */
function resolveShift(db, { bookingId, allocationId, jobId: jobIdArg, date } = {}) {
  let bId = bookingId ? parseInt(bookingId, 10) : null;
  let jobId = jobIdArg ? parseInt(jobIdArg, 10) : null;
  let shiftDate = date || null;
  let startTime = '';
  let endTime = '';

  if (!bId && !jobId && allocationId) {
    const alloc = db.prepare('SELECT * FROM crew_allocations WHERE id = ?').get(allocationId);
    if (!alloc) return null;
    if (alloc.booking_id) {
      bId = alloc.booking_id;
    } else {
      jobId = alloc.job_id;
      shiftDate = alloc.allocation_date;
      startTime = alloc.start_time || '';
      endTime = alloc.end_time || '';
    }
  }

  // ---- Booking shift -------------------------------------------------------
  if (bId) {
    const b = db.prepare(`
      SELECT b.*, j.job_number, j.job_name, j.client AS job_client
      FROM bookings b LEFT JOIN jobs j ON b.job_id = j.id
      WHERE b.id = ?
    `).get(bId);
    if (!b) return null;
    shiftDate = (b.start_datetime || '').slice(0, 10);
    startTime = (b.start_datetime || '').slice(11, 16);
    endTime = (b.end_datetime || '').slice(11, 16);

    const crew = db.prepare(`
      SELECT bc.id AS booking_crew_id, bc.crew_member_id, bc.role_on_site,
             bc.is_team_leader, cm.full_name,
             ca.id AS allocation_id
      FROM booking_crew bc
      JOIN crew_members cm ON cm.id = bc.crew_member_id
      LEFT JOIN crew_allocations ca
             ON ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id
      WHERE bc.booking_id = ? AND bc.status != 'declined'
      ORDER BY bc.is_team_leader DESC, cm.full_name
    `).all(bId);

    return {
      type: 'booking',
      bookingId: bId,
      jobId: b.job_id || null,
      shiftDate,
      startTime,
      endTime,
      site: {
        number: b.job_number || b.booking_number || '',
        name: b.job_name || b.title || '',
        client: b.job_client || b.title || '',
        address: b.site_address || '',
        suburb: b.suburb || '',
      },
      crew: crew.map(c => ({
        crew_member_id: c.crew_member_id,
        allocation_id: c.allocation_id || null,
        booking_crew_id: c.booking_crew_id,
        name: c.full_name,
        role: c.role_on_site || '',
        is_team_leader: c.is_team_leader ? 1 : 0,
      })),
    };
  }

  // ---- Job shift (no booking) ---------------------------------------------
  if (jobId && shiftDate) {
    const j = db.prepare('SELECT id, job_number, job_name, client, site_address, suburb FROM jobs WHERE id = ?').get(jobId);
    const crew = db.prepare(`
      SELECT ca.id AS allocation_id, ca.crew_member_id, ca.role_on_site, ca.start_time, ca.end_time,
             cm.full_name
      FROM crew_allocations ca
      JOIN crew_members cm ON cm.id = ca.crew_member_id
      WHERE ca.job_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
      ORDER BY cm.full_name
    `).all(jobId, shiftDate);
    if (!j && !crew.length) return null;

    return {
      type: 'job',
      bookingId: null,
      jobId,
      shiftDate,
      startTime,
      endTime,
      site: {
        number: j ? (j.job_number || '') : '',
        name: j ? (j.job_name || '') : '',
        client: j ? (j.client || '') : '',
        address: j ? (j.site_address || '') : '',
        suburb: j ? (j.suburb || '') : '',
      },
      crew: crew.map(c => ({
        crew_member_id: c.crew_member_id,
        allocation_id: c.allocation_id,
        booking_crew_id: null,
        name: c.full_name,
        role: c.role_on_site || '',
        is_team_leader: 0,
      })),
    };
  }

  return null;
}

/**
 * The current (non-superseded) shift docket header for a shift, or null.
 * Only matches dockets created in the new shift model (booking_id / shift_job_id
 * populated). Legacy per-person rows are historical and don't lock a shift.
 */
function getCurrentDocket(db, shift) {
  if (!shift) return null;
  if (shift.type === 'booking') {
    return db.prepare(`
      SELECT * FROM docket_signatures
      WHERE booking_id = ? AND COALESCE(status,'current') = 'current'
      ORDER BY id DESC LIMIT 1
    `).get(shift.bookingId);
  }
  return db.prepare(`
    SELECT * FROM docket_signatures
    WHERE shift_job_id = ? AND shift_date = ? AND booking_id IS NULL
      AND COALESCE(status,'current') = 'current'
    ORDER BY id DESC LIMIT 1
  `).get(shift.jobId, shift.shiftDate);
}

/**
 * Crew lines for a docket. Falls back to a single synthetic line built from the
 * header (legacy per-person dockets that predate docket_crew).
 */
function getDocketCrew(db, header) {
  const rows = db.prepare(`
    SELECT dc.*, cm.full_name AS cm_name
    FROM docket_crew dc LEFT JOIN crew_members cm ON cm.id = dc.crew_member_id
    WHERE dc.docket_id = ? ORDER BY dc.id
  `).all(header.id);
  if (rows.length) {
    return rows.map(r => ({
      crew_member_id: r.crew_member_id,
      name: r.name_snapshot || r.cm_name || ('#' + r.crew_member_id),
      role: r.role_snapshot || '',
      start_on_site: r.start_on_site,
      finish_on_site: r.finish_on_site,
      break_minutes: r.break_minutes,
      travel_hours: r.travel_hours,
      total_hours: r.total_hours,
    }));
  }
  // Legacy fallback: one line from the header itself.
  const cm = header.crew_member_id
    ? db.prepare('SELECT full_name FROM crew_members WHERE id = ?').get(header.crew_member_id)
    : null;
  return [{
    crew_member_id: header.crew_member_id,
    name: cm ? cm.full_name : (header.crew_member_id ? '#' + header.crew_member_id : '—'),
    role: '',
    start_on_site: header.start_on_site,
    finish_on_site: header.finish_on_site,
    break_minutes: header.break_minutes,
    travel_hours: header.travel_hours,
    total_hours: header.total_hours,
  }];
}

// Booking statuses we won't override when auto-completing — the canonical
// list lives in lib/bookingLifecycle; re-exported here for back-compat.
const { TERMINAL_STATUSES: BOOKING_TERMINAL } = require('./bookingLifecycle');

/**
 * Mark a whole shift complete: every crew allocation -> 'completed', booking_crew
 * -> 'completed', and the booking -> 'complete' (unless already terminal). For a
 * job-only shift we complete the allocations and leave the job status alone.
 * Caller should wrap this in a transaction together with the docket insert.
 */
function completeShift(db, shift) {
  if (!shift) return;
  if (shift.type === 'booking') {
    db.prepare(`
      UPDATE crew_allocations SET status = 'completed'
      WHERE booking_id = ? AND status NOT IN ('cancelled','declined')
    `).run(shift.bookingId);
    db.prepare(`
      UPDATE booking_crew SET status = 'completed'
      WHERE booking_id = ? AND status != 'declined'
    `).run(shift.bookingId);
    db.prepare(`
      UPDATE bookings SET status = 'complete', updated_at = datetime('now')
      WHERE id = ? AND status NOT IN (${BOOKING_TERMINAL.map(() => '?').join(',')})
    `).run(shift.bookingId, ...BOOKING_TERMINAL);
  } else if (shift.jobId && shift.shiftDate) {
    db.prepare(`
      UPDATE crew_allocations SET status = 'completed'
      WHERE job_id = ? AND allocation_date = ? AND status NOT IN ('cancelled','declined')
    `).run(shift.jobId, shift.shiftDate);
  }
}

module.exports = { calcHours, resolveShift, getCurrentDocket, getDocketCrew, completeShift, BOOKING_TERMINAL };
