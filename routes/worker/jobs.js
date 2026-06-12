const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday, TZ: SYD_TZ } = require('../../lib/sydney');
const { resolveShift, getCurrentDocket } = require('../../lib/shiftDocket');
const { maybePromoteToGreenToGo } = require('../../lib/bookingLifecycle');
const bookingNotify = require('../../services/bookingNotify');
const { logActivity } = require('../../middleware/audit');

// Shared by every worker accept path: if this acceptance was the last one
// outstanding, advance the booking to green_to_go and notify the whole crew.
// Safe to call after any single confirm — it's a no-op until everyone's in.
function promoteAndNotifyGTG(db, bookingId, req, worker) {
  if (!bookingId) return;
  try {
    if (maybePromoteToGreenToGo(db, bookingId)) {
      const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id = ?').get(bookingId);
      const crewIds = bookingNotify.activeCrewIds(db, bookingId);
      if (bk && crewIds.length) bookingNotify.notifyGreenToGo(crewIds, bk);
      try { logActivity({ user: null, action: 'update', entityType: 'booking', entityId: bookingId, details: `Auto: ${bk ? bk.booking_number : 'booking'} → green_to_go (all crew confirmed; last: ${worker && worker.full_name})`, ip: req && req.ip }); } catch (e) {}
    }
  } catch (e) { console.error('[GTG] promote failed for booking', bookingId, ':', e.message); }
}

// Admin-built form templates flagged to appear on every shift's Forms tab
// (checklist_templates.show_on_shift, migration 265), with this worker's
// per-shift completion status. Returns [] until the migration has run.
function getShiftTemplates(db, crewMemberId, allocationId) {
  try {
    return db.prepare(`
      SELECT t.id, t.name, t.description,
        (SELECT COUNT(*) FROM custom_checklist_responses r
          WHERE r.template_id = t.id AND r.crew_member_id = ? AND r.allocation_id = ?) AS done_count
      FROM checklist_templates t
      WHERE t.show_on_shift = 1 AND t.worker_visible = 1 AND t.status = 'active'
        AND t.published_revision IS NOT NULL AND t.published_revision > 0
      ORDER BY t.sort_order ASC, t.name ASC
    `).all(crewMemberId, allocationId);
  } catch (e) { return []; }
}

// Vehicles on a booking with the crew grouped under each one — who's
// riding in what (booking_crew.assigned_vehicle_id), who's driving
// (booking_vehicles.crew_member_id), and who's on site without a vehicle.
// Returns null when the booking has no vehicles so views can skip the
// whole block.
function getBookingVehicleGroups(db, bookingId, currentCrewId) {
  try {
    const vehicles = db.prepare(`
      SELECT bv.id, bv.vehicle_name, bv.registration, bv.crew_member_id AS driver_id,
             fv.asset_id AS fleet_asset_id, fv.rego AS fleet_rego
      FROM booking_vehicles bv
      LEFT JOIN vehicles fv ON fv.id = bv.fleet_vehicle_id
      WHERE bv.booking_id = ?
      ORDER BY bv.id
    `).all(bookingId);
    if (!vehicles.length) return null;
    const crew = db.prepare(`
      SELECT bc.crew_member_id, bc.assigned_vehicle_id, bc.role_on_site, bc.status,
             cm.full_name, cm.phone, cm.portal_role
      FROM booking_crew bc
      JOIN crew_members cm ON cm.id = bc.crew_member_id
      WHERE bc.booking_id = ? AND bc.status != 'declined'
      ORDER BY CASE cm.portal_role WHEN 'supervisor' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END, cm.full_name
    `).all(bookingId);
    const decorate = (c, v) => ({
      ...c,
      is_driver: !!v && c.crew_member_id === v.driver_id,
      is_you: !!currentCrewId && c.crew_member_id === currentCrewId,
    });
    const groups = vehicles.map(v => ({
      vehicle: {
        id: v.id,
        name: v.vehicle_name || v.fleet_asset_id || 'Vehicle',
        rego: v.registration || v.fleet_rego || '',
      },
      members: crew.filter(c => c.assigned_vehicle_id === v.id).map(c => decorate(c, v)),
    }));
    const onFoot = crew
      .filter(c => !c.assigned_vehicle_id || !vehicles.some(v => v.id === c.assigned_vehicle_id))
      .map(c => decorate(c, null));
    return { groups, onFoot };
  } catch (e) { return null; }
}

// Worker-facing sign/view URL for the shift an allocation belongs to.
function docketUrlForAllocation(db, allocationId) {
  const shift = resolveShift(db, { allocationId });
  if (!shift) return '/w/dockets/sign/' + allocationId;
  return shift.type === 'booking'
    ? '/w/dockets/shift/' + shift.bookingId
    : '/w/dockets/shift/job/' + shift.jobId + '/' + shift.shiftDate;
}

// GET /w/shifts — Alias, redirect to /w/jobs (preserving query params)
router.get('/shifts', (req, res) => {
  const qs = req.originalUrl.split('?')[1];
  res.redirect('/w/jobs' + (qs ? '?' + qs : ''));
});

// GET /w/shifts/:id — Alias, redirect to /w/jobs/:id
router.get('/shifts/:id', (req, res) => {
  res.redirect('/w/jobs/' + req.params.id);
});

// GET /w/jobs — My Shifts (all upcoming + finished)
router.get('/jobs', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = sydneyToday();
  const tab = req.query.tab || 'upcoming';

  // Reconcile any drift between booking_crew and crew_allocations for
  // this worker — a previous bug in the /w/booking-shift/:id/respond
  // handler updated booking_crew but not the lazy-bound allocation, so
  // existing accepted shifts can be stuck in Requests forever. Fix on
  // read so the user sees the correct state without us having to ship
  // a one-off migration.
  try {
    db.prepare(`
      UPDATE crew_allocations
      SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP)
      WHERE crew_member_id = ?
        AND status = 'allocated'
        AND booking_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM booking_crew bc
           WHERE bc.booking_id = crew_allocations.booking_id
             AND bc.crew_member_id = crew_allocations.crew_member_id
             AND bc.status = 'confirmed'
        )
    `).run(worker.id);
    db.prepare(`
      UPDATE crew_allocations
      SET status = 'declined'
      WHERE crew_member_id = ?
        AND status IN ('allocated','confirmed')
        AND booking_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM booking_crew bc
           WHERE bc.booking_id = crew_allocations.booking_id
             AND bc.crew_member_id = crew_allocations.crew_member_id
             AND bc.status = 'declined'
        )
    `).run(worker.id);
  } catch (e) { /* legacy DB without booking_crew — skip */ }

  // The bookings table CHECK uses these literal status values:
  //   'unconfirmed','confirmed','green_to_go','in_progress','completed',
  //   'cancelled','late_cancellation','on_hold'
  // Crew don't see a shift until the ALLOCATOR confirms the booking, so
  // 'unconfirmed' is deliberately excluded — a pre-confirmation booking never
  // surfaces in the portal. Once confirmed it appears as a request the worker
  // can accept/decline (that accept/decline drives allocation status, which is
  // separate from booking status).
  const VISIBLE_BOOKING_STATUSES = ['confirmed','green_to_go','in_progress','complete','on_hold'];

  // Upcoming from crew_allocations. Falls back to booking columns when the
  // allocation isn't linked to a job (ad-hoc bookings post-migration 142),
  // so the worker UI never shows a row with NULL client/job_number. The
  // 'source' column flips to 'booking' when there's no job + a booking,
  // which routes the click to /w/booking-shift/:bookingId where the
  // booking-only flow lives.
  const allocUpcoming = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number) AS job_number,
      COALESCE(j.job_name, b.title)            AS job_name,
      COALESCE(j.client, b.title)              AS client,
      COALESCE(j.site_address, b.site_address) AS site_address,
      COALESCE(j.suburb, b.suburb)             AS suburb,
      COALESCE(j.notes, b.notes)               AS job_notes,
      COALESCE(j.project_name, b.title)        AS project_name,
      COALESCE(j.client_project_number, '')    AS client_project_number,
      COALESCE(j.state, b.state)               AS state,
      u.full_name AS supervisor_name,
      CASE WHEN ca.job_id IS NULL AND ca.booking_id IS NOT NULL THEN 'booking' ELSE 'allocation' END AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.crew_member_id = ?
      AND ca.allocation_date >= ?
      AND ca.status IN ('allocated', 'confirmed')
      AND (ca.booking_id IS NULL OR (
        b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND b.deleted_at IS NULL))
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);

  // Upcoming from booking_crew (bookings without job allocations — fallback)
  let bookingUpcoming = [];
  try {
    bookingUpcoming = db.prepare(`
      SELECT bc.id, bc.booking_id, bc.status, bc.role_on_site,
        b.booking_number as job_number, b.title as job_name, b.title as client,
        b.site_address, b.suburb, b.notes as job_notes, b.title as project_name,
        '' as client_project_number, b.state,
        DATE(b.start_datetime) as allocation_date,
        SUBSTR(b.start_datetime, 12, 5) as start_time,
        SUBSTR(b.end_datetime, 12, 5) as end_time,
        '' as supervisor_name, 'booking' as source
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) >= ?
        AND bc.status IN ('assigned', 'confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
      ORDER BY b.start_datetime ASC
    `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* booking_crew may not have matching columns */ }

  // Merge and deduplicate
  const upcoming = [...allocUpcoming, ...bookingUpcoming.map(b => ({
    ...b, status: b.status === 'assigned' ? 'allocated' : b.status
  }))].sort((a, b) => (a.allocation_date + a.start_time).localeCompare(b.allocation_date + b.start_time));

  // Split upcoming into requests (allocated) and confirmed
  const requests = upcoming.filter(a => a.status === 'allocated');
  const confirmed = upcoming.filter(a => a.status === 'confirmed');

  // Finished from crew_allocations
  const finished = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb,
      j.notes as job_notes, j.project_name, j.client_project_number, j.state,
      u.full_name as supervisor_name
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ?
      AND ca.status != 'cancelled'
      AND (ca.status IN ('completed', 'declined') OR ca.allocation_date < ?)
    ORDER BY ca.allocation_date DESC, ca.start_time DESC
    LIMIT 20
  `).all(worker.id, today);

  // Helper: group allocations by date
  function groupByDate(list) {
    const groups = {};
    list.forEach(a => {
      if (!groups[a.allocation_date]) groups[a.allocation_date] = [];
      groups[a.allocation_date].push(a);
    });
    return groups;
  }

  // === Week pagination for the calendar strip ===
  // ?week=YYYY-MM-DD anchors the visible week. Without it we land on the
  // current week. Mon → Sun layout (en-AU convention).
  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Anchor on Sydney local date, not the server's UTC clock — Railway is
  // UTC so `new Date()` lands on the previous calendar day for several
  // hours every Sydney evening, which would put the strip on the wrong week.
  const anchor = req.query.week
    ? new Date(req.query.week + 'T00:00:00')
    : new Date(sydneyToday() + 'T00:00:00');
  if (isNaN(anchor.getTime())) anchor.setTime(Date.now());
  const dow = (anchor.getDay() + 6) % 7;
  const monday = new Date(anchor); monday.setDate(monday.getDate() - dow); monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const prev = new Date(monday); prev.setDate(prev.getDate() - 7);
  const next = new Date(monday); next.setDate(next.getDate() + 7);
  const weekStartIso = isoDate(monday);
  const weekEndIso   = isoDate(sunday);

  // Filter confirmed shifts down to the visible week — Requests stay
  // unfiltered (always visible across all weeks) so workers don't miss
  // a pending acceptance by flipping forward.
  // The list also pulls in past shifts that fall inside the visible week
  // (drawn from `finished`) so navigating backward shows what the worker
  // actually worked, not an empty week. The Past tab still renders the
  // raw chronological all-time list — these two surfaces stay in sync
  // because both are sourced from crew_allocations.
  const confirmedFromUpcoming = confirmed.filter(s =>
    s.allocation_date >= weekStartIso && s.allocation_date <= weekEndIso
  );
  // Refetch any shifts in the visible week that landed in the "finished"
  // bucket (status completed/declined OR allocation_date < today).
  // The earlier finished query has LIMIT 20 so older weeks could miss
  // rows — pull a dedicated set for the visible window with no limit.
  const finishedThisWeek = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number) AS job_number,
      COALESCE(j.job_name,   b.title)          AS job_name,
      COALESCE(j.client,     b.title)          AS client,
      COALESCE(j.site_address, b.site_address) AS site_address,
      COALESCE(j.suburb,     b.suburb)         AS suburb,
      j.project_name, j.state,
      u.full_name AS supervisor_name,
      CASE WHEN ca.job_id IS NULL AND ca.booking_id IS NOT NULL
           THEN 'booking' ELSE 'allocation' END AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    LEFT JOIN users u    ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ?
      AND ca.status != 'cancelled'
      AND (ca.status IN ('completed','declined','confirmed') OR ca.allocation_date < ?)
      AND ca.allocation_date BETWEEN ? AND ?
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id, today, weekStartIso, weekEndIso);

  // Merge upcoming-confirmed + finished-this-week, dedup by allocation id.
  const seen = new Set();
  const confirmedThisWeek = [];
  [...confirmedFromUpcoming, ...finishedThisWeek].forEach(s => {
    const k = s.id || `${s.allocation_date}-${s.start_time}-${s.booking_id || ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    confirmedThisWeek.push(s);
  });
  confirmedThisWeek.sort((a, b) =>
    (a.allocation_date + (a.start_time || '')).localeCompare(b.allocation_date + (b.start_time || ''))
  );

  // Day-by-day count for the strip indicators.
  const countsByDate = {};
  confirmedThisWeek.forEach(s => { countsByDate[s.allocation_date] = (countsByDate[s.allocation_date] || 0) + 1; });
  // Requests that fall inside the visible week add to the dot too — so a
  // pending shift on Wed shows up as "something happening Wed".
  requests.forEach(s => {
    if (s.allocation_date >= weekStartIso && s.allocation_date <= weekEndIso) {
      countsByDate[s.allocation_date] = (countsByDate[s.allocation_date] || 0) + 1;
    }
  });

  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const iso = isoDate(d);
    weekDays.push({
      iso,
      letter: ['MON','TUE','WED','THU','FRI','SAT','SUN'][i],
      day: d.getDate(),
      isToday: iso === today,
      isPast: iso < today,
      count: countsByDate[iso] || 0,
    });
  }

  const startMon = monday.toLocaleDateString('en-AU', { month: 'short' });
  const endMon   = sunday.toLocaleDateString('en-AU', { month: 'short' });
  const monthLabel = (startMon === endMon ? startMon : startMon + ' / ' + endMon) + ' ' + sunday.getFullYear();

  // Sydney wall-clock HH:MM — the view uses it to badge today's shifts
  // that are running right now.
  const nowTime = new Date().toLocaleTimeString('en-AU', { timeZone: SYD_TZ, hour: '2-digit', minute: '2-digit', hour12: false });

  res.render('worker/jobs', {
    title: 'My Shifts',
    currentPage: 'shifts',
    tab,
    today,
    nowTime,
    requests,
    confirmed,
    finished,
    requestsByDate: groupByDate(requests),
    confirmedByDate: groupByDate(confirmedThisWeek),
    finishedByDate: groupByDate(finished),
    // Week-strip metadata
    weekDays,
    weekStartIso,
    weekEndIso,
    monthLabel,
    prevWeek: isoDate(prev),
    nextWeek: isoDate(next),
    isThisWeek: weekStartIso <= today && today <= weekEndIso,
  });
});

// GET /w/jobs/:id — Job detail (allocation detail)
router.get('/jobs/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const tab = req.query.tab || 'info';

  // Get this allocation (must belong to this worker). LEFT JOIN both
  // jobs AND bookings — for ad-hoc bookings (job_id NULL post-mig 142)
  // we COALESCE the booking columns into the same field names the
  // EJS expects, so the detail page renders the same data set whether
  // the worker arrived via /w/jobs/:allocId or /w/booking-shift/:id.
  const allocation = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number)        AS job_number,
      COALESCE(j.job_name,   b.title)                 AS job_name,
      COALESCE(j.client,     b.title)                 AS client,
      COALESCE(j.site_address, b.site_address)        AS site_address,
      COALESCE(j.suburb,     b.suburb)                AS suburb,
      COALESCE(j.status,     b.status)                AS job_status,
      j.notes                                         AS job_notes,
      b.description                                   AS booking_description,
      b.location_notes                                AS booking_location_notes,
      b.requirements_text                             AS booking_requirements,
      COALESCE(j.start_date, DATE(b.start_datetime))  AS job_start,
      COALESCE(j.end_date,   DATE(b.end_datetime))    AS job_end,
      COALESCE(j.project_name, b.title)               AS project_name,
      COALESCE(j.client_project_number, '')           AS client_project_number,
      COALESCE(j.state,      b.state)                 AS state,
      j.crew_size                                     AS crew_size,
      u.full_name AS supervisor_name, u.email AS supervisor_email
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    LEFT JOIN users u    ON j.ops_supervisor_id = u.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Job not found or you do not have access.');
    return res.redirect('/w/jobs');
  }

  // Get other crew on the same job & date
  // Pull cm.portal_role too so the view can render a "Team Leader" /
  // "Supervisor" badge next to the crew member's name. Higher tiers float
  // to the top of the crew list so workers see who's the lead at a glance.
  // Falls back to a date+time match instead of job_id when this is a
  // booking-only allocation (job_id NULL post-migration 142).
  const otherCrew = allocation.job_id
    ? db.prepare(`
        SELECT ca.role_on_site, ca.shift_type, ca.start_time, ca.end_time, ca.status,
          cm.full_name, cm.phone, cm.role as crew_role, cm.portal_role
        FROM crew_allocations ca
        JOIN crew_members cm ON ca.crew_member_id = cm.id
        WHERE ca.job_id = ? AND ca.allocation_date = ? AND ca.crew_member_id != ? AND ca.status != 'cancelled'
        ORDER BY
          CASE cm.portal_role WHEN 'supervisor' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END,
          cm.full_name ASC
      `).all(allocation.job_id, allocation.allocation_date, worker.id)
    : (allocation.booking_id
        ? db.prepare(`
            SELECT ca.role_on_site, ca.shift_type, ca.start_time, ca.end_time, ca.status,
              cm.full_name, cm.phone, cm.role as crew_role, cm.portal_role
            FROM crew_allocations ca
            JOIN crew_members cm ON ca.crew_member_id = cm.id
            WHERE ca.booking_id = ? AND ca.crew_member_id != ? AND ca.status != 'cancelled'
            ORDER BY
              CASE cm.portal_role WHEN 'supervisor' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END,
              cm.full_name ASC
          `).all(allocation.booking_id, worker.id)
        : []);

  // Get supervisor phone
  let supervisorPhone = '';
  if (allocation.supervisor_name) {
    const supCrew = db.prepare("SELECT phone FROM crew_members WHERE full_name = ? AND phone != ''").get(allocation.supervisor_name);
    if (supCrew) supervisorPhone = supCrew.phone;
  }

  // Get safety forms for this allocation
  const forms = db.prepare(`
    SELECT id, form_type, status, submitted_at, created_at
    FROM safety_forms
    WHERE crew_member_id = ? AND allocation_id = ?
    ORDER BY created_at DESC
  `).all(worker.id, allocation.id);

  // Also check for forms linked by job_id on same date (some may not have allocation_id)
  const formsByJob = db.prepare(`
    SELECT id, form_type, status, submitted_at, created_at
    FROM safety_forms
    WHERE crew_member_id = ? AND job_id = ? AND allocation_id IS NULL
      AND date(created_at) = ?
    ORDER BY created_at DESC
  `).all(worker.id, allocation.job_id, allocation.allocation_date);

  const allForms = [...forms, ...formsByJob];

  // Build form completion status — legacy forms + the five Traffio Job-Pack
  // checklists. allForms already contains every safety_forms row this worker
  // has filed against this allocation (or against the same job/date when no
  // allocation_id was set), so a simple .find() per form_type tells us if it's
  // done. The detail page uses these flags to show emerald check vs amber pill.
  const formStatus = {
    prestart: allForms.find(f => f.form_type === 'prestart') || null,
    take5: allForms.find(f => f.form_type === 'take5') || null,
    hazard: allForms.filter(f => f.form_type === 'hazard'),
    incident: allForms.filter(f => f.form_type === 'incident'),
    equipment: allForms.find(f => f.form_type === 'equipment') || null,
    vehicle_prestart: allForms.find(f => f.form_type === 'vehicle_prestart') || null,
    risk_toolbox:    allForms.find(f => f.form_type === 'risk_toolbox') || null,
    tc_prestart:     allForms.find(f => f.form_type === 'tc_prestart') || null,
    team_leader:     allForms.find(f => f.form_type === 'team_leader') || null,
    post_shift_vehicle: allForms.find(f => f.form_type === 'post_shift_vehicle') || null,
  };

  // Admin-built templates flagged "show on shift" — appear on the Forms tab
  // after the Job-Pack 5, with per-shift completion status.
  const shiftTemplates = getShiftTemplates(db, worker.id, allocation.id);

  // Documents the worker should see on the DOCS tab — drawn from two places:
  //
  //   1. job_documents (admin uploads via /jobs/:id/documents) — scoped to a
  //      job, visible to every shift/booking on it.
  //   2. booking_documents (allocator uploads in the booking detail page when
  //      they put the crew on a shift) — scoped to a single booking, visible
  //      only to the workers allocated to that booking.
  //
  // Both shapes are different tables with different columns, so we normalise
  // them into a single { id, source, doc_type, title, original_name,
  // size_bytes, mime_type, uploaded_at, download_url } shape before sending to
  // the view. The download URL points at the right per-source streamer below.
  const jobLevel = db.prepare(`
    SELECT id, doc_type, title, original_name, mime_type, size_bytes, uploaded_at
    FROM job_documents
    WHERE job_id = ? AND archived_at IS NULL
  `).all(allocation.job_id).map(d => ({
    id: d.id, source: 'job', doc_type: d.doc_type, title: d.title,
    original_name: d.original_name, mime_type: d.mime_type,
    size_bytes: d.size_bytes, uploaded_at: d.uploaded_at,
    download_url: `/w/job-documents/${d.id}`,
  }));

  let bookingLevel = [];
  if (allocation.booking_id) {
    bookingLevel = db.prepare(`
      SELECT id, document_type, title, original_name, file_size, created_at
      FROM booking_documents WHERE booking_id = ?
    `).all(allocation.booking_id).map(d => ({
      id: d.id, source: 'booking', doc_type: d.document_type, title: d.title,
      original_name: d.original_name, mime_type: null,
      size_bytes: d.file_size, uploaded_at: d.created_at,
      download_url: `/w/booking-documents/${d.id}`,
    }));
  }

  // Sort by doc_type priority then most-recent first. Booking docs sit
  // alongside job docs — same priority weights, same chip in the view.
  const DOC_PRIORITY = { tgs:1, tmp:2, ctmp:2, rol_day:3, rol_night:4, rol:3, stage_plan:5, swms:6, permit:7, other:8, photo:9, invoice:10 };
  const jobDocuments = [...jobLevel, ...bookingLevel].sort((a, b) => {
    const pa = DOC_PRIORITY[a.doc_type] || 99;
    const pb = DOC_PRIORITY[b.doc_type] || 99;
    if (pa !== pb) return pa - pb;
    return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
  });

  // Docket is per-shift now: load the current shift docket (covers the whole
  // crew) for the shift this allocation belongs to.
  const _shift = resolveShift(db, { allocationId: allocation.id });
  const docket = _shift ? getCurrentDocket(db, _shift) : null;
  const docketSignUrl = docketUrlForAllocation(db, allocation.id);

  res.render('worker/job-detail', {
    title: allocation.job_name || allocation.job_number,
    currentPage: 'shifts',
    tab,
    allocation,
    docketSignUrl,
    otherCrew,
    supervisorPhone,
    formStatus,
    shiftTemplates,
    vehicleGroups: allocation.booking_id ? getBookingVehicleGroups(db, allocation.booking_id, worker.id) : null,
    docket,
    jobDocuments,
  });
});

// GET /w/booking-documents/:id — Stream a booking-level document. Auth check:
// the worker must have a non-cancelled allocation on the same booking. We
// don't expose the doc to anyone whose shift was reassigned away.
router.get('/booking-documents/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const path = require('path');
  const fs = require('fs');

  const doc = db.prepare(`
    SELECT bd.* FROM booking_documents bd WHERE bd.id = ?
  `).get(req.params.id);
  if (!doc) return res.status(404).send('Not found');

  const linked = db.prepare(`
    SELECT 1 FROM crew_allocations
    WHERE crew_member_id = ? AND booking_id = ? AND status != 'cancelled' LIMIT 1
  `).get(worker.id, doc.booking_id);
  if (!linked) return res.status(403).send('Forbidden');

  const abs = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');

  // booking_documents has no mime_type column — guess from extension to keep
  // PDFs inline and other formats downloadable.
  const ext = (path.extname(doc.original_name || '').toLowerCase() || '');
  const mt = ext === '.pdf' ? 'application/pdf'
           : (ext === '.png' || ext === '.jpg' || ext === '.jpeg') ? `image/${ext.slice(1).replace('jpg','jpeg')}`
           : 'application/octet-stream';
  res.setHeader('Content-Type', mt);
  res.setHeader('Content-Disposition', `inline; filename="${(doc.original_name || doc.title || 'document').replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

// GET /w/job-documents/:id — Stream an admin-uploaded job document to the
// worker. Permission check: the worker must have an allocation on the same
// job (current or past) before we'll serve the file.
router.get('/job-documents/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const path = require('path');
  const fs = require('fs');

  const doc = db.prepare(`
    SELECT jd.*, j.id AS jid
    FROM job_documents jd
    JOIN jobs j ON jd.job_id = j.id
    WHERE jd.id = ? AND jd.archived_at IS NULL
  `).get(req.params.id);
  if (!doc) return res.status(404).send('Not found');

  const linked = db.prepare(`
    SELECT 1 FROM crew_allocations
    WHERE crew_member_id = ? AND job_id = ? AND status != 'cancelled' LIMIT 1
  `).get(worker.id, doc.jid);
  if (!linked) return res.status(403).send('Forbidden');

  const abs = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', doc.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(doc.original_name || doc.title || 'document.pdf').replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

// POST /w/jobs/:id/respond — Accept or decline an allocation
router.post('/jobs/:id/respond', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return res.redirect('/w/jobs/' + req.params.id);
  }

  // Verify allocation belongs to this worker and is in 'allocated' status
  const allocation = db.prepare(`
    SELECT id, status FROM crew_allocations
    WHERE id = ? AND crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return res.redirect('/w/jobs');
  }

  if (allocation.status !== 'allocated') {
    req.flash('error', 'This shift has already been ' + allocation.status + '.');
    return res.redirect('/w/jobs/' + req.params.id);
  }

  // Get full allocation details for booking sync
  const fullAlloc = db.prepare('SELECT * FROM crew_allocations WHERE id = ?').get(allocation.id);

  if (action === 'accept') {
    db.prepare(`
      UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(allocation.id);

    // Sync to booking_crew if linked
    if (fullAlloc && fullAlloc.booking_id) {
      db.prepare("UPDATE booking_crew SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND crew_member_id = ?")
        .run(fullAlloc.booking_id, worker.id);

      // All crew accepted? → auto-advance the booking to green_to_go and tell
      // the whole crew it's locked in.
      promoteAndNotifyGTG(db, fullAlloc.booking_id, req, worker);
    }

    req.flash('success', 'Shift accepted!');
  } else {
    db.prepare(`
      UPDATE crew_allocations SET status = 'declined'
      WHERE id = ?
    `).run(allocation.id);

    // Sync to booking_crew if linked
    if (fullAlloc && fullAlloc.booking_id) {
      db.prepare("UPDATE booking_crew SET status = 'declined' WHERE booking_id = ? AND crew_member_id = ?")
        .run(fullAlloc.booking_id, worker.id);
    }

    req.flash('success', 'Shift declined.');
  }

  res.redirect('/w/jobs/' + req.params.id);
});

// GET /w/booking-shift/:bookingId — Booking detail (for booking_crew-based shifts)
router.get('/booking-shift/:bookingId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const tab = req.query.tab || 'details';

  // Get booking details
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.bookingId);
  if (!booking) { req.flash('error', 'Booking not found.'); return res.redirect('/w/jobs'); }

  // Verify this worker is assigned to this booking
  const myAssignment = db.prepare('SELECT * FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(booking.id, worker.id);
  if (!myAssignment) { req.flash('error', 'You are not assigned to this booking.'); return res.redirect('/w/jobs'); }

  // Lazy-bind a crew_allocations row to this booking_crew assignment so the
  // Job-Pack form flow (which keys off allocation_id) works for every shift,
  // including ad-hoc bookings without a job_id. Migration 141 made
  // crew_allocations.job_id nullable so this works for both.
  let allocation = db.prepare(`
    SELECT * FROM crew_allocations
    WHERE booking_id = ? AND crew_member_id = ? LIMIT 1
  `).get(booking.id, worker.id);
  if (!allocation) {
    try {
      const allocStatus = myAssignment.status === 'confirmed' ? 'confirmed' : 'allocated';
      const startTimeFromDt = booking.start_datetime ? booking.start_datetime.substring(11, 16) : '';
      const endTimeFromDt   = booking.end_datetime   ? booking.end_datetime.substring(11, 16)   : '';
      const allocDate       = booking.start_datetime ? booking.start_datetime.substring(0, 10)  : sydneyToday();
      const allocBy = booking.created_by_id || (req.session.user && req.session.user.id) || null;
      // OR IGNORE + re-select: two devices (or a double-tap) racing to
      // lazy-create can't produce duplicates — the unique index on
      // (booking_id, crew_member_id) makes the second insert a no-op and
      // the re-select picks up whichever row won.
      db.prepare(`
        INSERT OR IGNORE INTO crew_allocations
          (job_id, crew_member_id, allocation_date, start_time, end_time,
           role_on_site, status, allocated_by_id, booking_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(booking.job_id || null, worker.id, allocDate, startTimeFromDt, endTimeFromDt,
             myAssignment.role_on_site || '', allocStatus, allocBy, booking.id);
      allocation = db.prepare('SELECT * FROM crew_allocations WHERE booking_id = ? AND crew_member_id = ? LIMIT 1').get(booking.id, worker.id);
    } catch (e) {
      console.error('[booking-shift] failed to lazy-bind allocation:', e.message);
    }
  }

  // Get all crew on this booking
  const crew = db.prepare(`
    SELECT bc.*, cm.full_name, cm.phone, cm.role, cm.portal_role
    FROM booking_crew bc
    JOIN crew_members cm ON bc.crew_member_id = cm.id
    WHERE bc.booking_id = ?
    ORDER BY cm.full_name
  `).all(booking.id);

  // Get client name from client_id if available
  let clientName = '';
  if (booking.client_id) {
    try { const client = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(booking.client_id); if (client) clientName = client.company_name; } catch (e) {}
  }
  booking.client_name = clientName || booking.client_contact || '';

  // Format dates
  const startDt = booking.start_datetime ? new Date(booking.start_datetime) : new Date();
  const startDay = startDt.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long' });
  const startDate = startDt.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'long', year: 'numeric' });
  const startTime = booking.start_datetime ? booking.start_datetime.substring(11, 16) : '';
  const endTime = booking.end_datetime ? booking.end_datetime.substring(11, 16) : '';

  // Job-Pack completion + docket status — only when we have an allocation
  // to hang submissions off (so a booking with no job_id stays informational).
  const JP_TYPES = ['vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'];
  let formStatus = {}, docket = null, jobDocuments = [];
  if (allocation) {
    const subs = db.prepare(`
      SELECT id, form_type, submitted_at FROM safety_forms
      WHERE crew_member_id = ? AND allocation_id = ?
        AND form_type IN (${JP_TYPES.map(()=>'?').join(',')})
    `).all(worker.id, allocation.id, ...JP_TYPES);
    for (const t of JP_TYPES) {
      const hit = subs.find(s => s.form_type === t);
      formStatus[t] = hit ? { id: hit.id, submitted_at: hit.submitted_at } : null;
    }
    const _shiftD = resolveShift(db, { allocationId: allocation.id });
    docket = _shiftD ? getCurrentDocket(db, _shiftD) : null;

    // Site documents — same shape as the allocation detail page so the view
    // can reuse the rendering. Job-level docs + booking-level docs merged
    // and sorted by doc-type priority.
    try {
      const jobLevel = booking.job_id ? db.prepare(`
        SELECT id, doc_type, title, original_name, mime_type, size_bytes, uploaded_at
        FROM job_documents WHERE job_id = ? AND archived_at IS NULL
      `).all(booking.job_id).map(d => ({
        id: d.id, source: 'job', doc_type: d.doc_type, title: d.title,
        original_name: d.original_name, mime_type: d.mime_type,
        size_bytes: d.size_bytes, uploaded_at: d.uploaded_at,
        download_url: `/w/job-documents/${d.id}`,
      })) : [];
      const bookingLevel = db.prepare(`
        SELECT id, document_type, title, original_name, file_size, created_at
        FROM booking_documents WHERE booking_id = ?
      `).all(booking.id).map(d => ({
        id: d.id, source: 'booking', doc_type: d.document_type, title: d.title,
        original_name: d.original_name, mime_type: null,
        size_bytes: d.file_size, uploaded_at: d.created_at,
        download_url: `/w/booking-documents/${d.id}`,
      }));
      const DOC_PRIORITY = { tgs:1, tmp:2, ctmp:2, rol_day:3, rol_night:4, rol:3, stage_plan:5, swms:6, permit:7, other:8, photo:9, invoice:10 };
      jobDocuments = [...jobLevel, ...bookingLevel].sort((a, b) => {
        const pa = DOC_PRIORITY[a.doc_type] || 99;
        const pb = DOC_PRIORITY[b.doc_type] || 99;
        if (pa !== pb) return pa - pb;
        return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
      });
    } catch (e) { console.error('[booking-shift] doc fetch:', e.message); }
  }

  // Shift tasks — own + (when TL/Supervisor) every task for the rest of
  // the crew on this shift. Tasks come in two flavours:
  //   - shift-bound: booking_id (or allocation_id) matches this shift
  //   - general:     no booking_id / allocation_id; standing tasks the
  //                  worker carries across shifts
  // The worker sees both buckets on every shift detail; TLs+Supervisors
  // see both buckets for every crew member on the shift.
  let myTasks = [], teamTasks = [];
  try {
    const me = db.prepare('SELECT portal_role FROM crew_members WHERE id = ?').get(worker.id);
    const isTL = !!(me && (me.portal_role === 'team_leader' || me.portal_role === 'supervisor'));
    myTasks = db.prepare(`
      SELECT st.*, cm.full_name AS assignee_name,
        CASE WHEN st.booking_id IS NULL AND st.allocation_id IS NULL THEN 1 ELSE 0 END AS is_general
      FROM shift_tasks st JOIN crew_members cm ON st.crew_member_id = cm.id
      WHERE st.crew_member_id = ?
        AND (
          st.allocation_id = ?
          OR st.booking_id = ?
          OR (st.booking_id IS NULL AND st.allocation_id IS NULL)
        )
      ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
               CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               st.due_at ASC, st.created_at ASC
    `).all(worker.id, allocation ? allocation.id : null, booking.id);
    if (isTL) {
      // Crew on this booking (so TL+Supervisor only see tasks for the
      // people they're working alongside, not the entire roster).
      const crewIds = db.prepare("SELECT crew_member_id FROM booking_crew WHERE booking_id = ? AND crew_member_id != ?").all(booking.id, worker.id).map(r => r.crew_member_id);
      if (crewIds.length) {
        const placeholders = crewIds.map(() => '?').join(',');
        teamTasks = db.prepare(`
          SELECT st.*, cm.full_name AS assignee_name, cm.portal_role AS assignee_portal_role,
            CASE WHEN st.booking_id IS NULL AND st.allocation_id IS NULL THEN 1 ELSE 0 END AS is_general
          FROM shift_tasks st JOIN crew_members cm ON st.crew_member_id = cm.id
          WHERE st.crew_member_id IN (${placeholders})
            AND (
              st.booking_id = ?
              OR (st.booking_id IS NULL AND st.allocation_id IS NULL)
            )
          ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
                   CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                   st.due_at ASC, st.created_at ASC
        `).all(...crewIds, booking.id);
      }
    }
  } catch (e) { console.error('[booking-shift] tasks fetch error:', e.message); }

  res.render('worker/booking-detail', {
    title: booking.title || booking.booking_number,
    currentPage: 'shifts',
    tab,
    booking,
    crew,
    myStatus: myAssignment.status,
    startDay, startDate, startTime, endTime,
    allocation, formStatus, docket, jobDocuments,
    shiftTemplates: allocation ? getShiftTemplates(db, worker.id, allocation.id) : [],
    vehicleGroups: getBookingVehicleGroups(db, booking.id, worker.id),
    docketSignUrl: '/w/dockets/shift/' + booking.id,
    myTasks, teamTasks,
  });
});

// POST /w/bookings/:id/respond — Accept or decline a booking_crew assignment (no allocation)
router.post('/bookings/:id/respond', (req, res) => {
  try {
  const db = getDb();
  const worker = req.session.worker;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return res.redirect('/w/booking-shift/' + req.params.id);
  }

  const bc = db.prepare("SELECT * FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?").get(req.params.id, worker.id);
  if (!bc) { req.flash('error', 'Assignment not found.'); return res.redirect('/w/jobs'); }

  if (action === 'accept') {
    db.prepare("UPDATE booking_crew SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND crew_member_id = ?")
      .run(req.params.id, worker.id);
    // Mirror the confirmation onto the lazy-bound crew_allocations row so
    // the worker shifts list (which filters on ca.status) flips this shift
    // out of "Requests" and into "Confirmed" immediately.
    db.prepare("UPDATE crew_allocations SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND crew_member_id = ? AND status = 'allocated'")
      .run(req.params.id, worker.id);

    // All crew accepted? → auto-advance the booking to green_to_go + notify.
    promoteAndNotifyGTG(db, parseInt(req.params.id, 10), req, worker);
    req.flash('success', 'Shift accepted!');
  } else {
    db.prepare("UPDATE booking_crew SET status = 'declined' WHERE booking_id = ? AND crew_member_id = ?")
      .run(req.params.id, worker.id);
    db.prepare("UPDATE crew_allocations SET status = 'declined' WHERE booking_id = ? AND crew_member_id = ? AND status IN ('allocated','confirmed')")
      .run(req.params.id, worker.id);
    req.flash('success', 'Shift declined.');
  }

  res.redirect('/w/booking-shift/' + req.params.id);
  } catch (err) {
    console.error('Booking respond error:', err.message);
    req.flash('error', 'Error: ' + err.message);
    res.redirect('/w/jobs');
  }
});

// POST /w/shift-tasks/:id/done — Mark a task done. Auth: must be the
// assignee. Toggling back to pending uses the same endpoint with
// ?undo=1 so the worker can undo a misclick without bouncing through
// admin.
router.post('/shift-tasks/:id/done', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const taskId = req.params.id;
  const undo = req.body.undo === '1' || req.query.undo === '1';
  const t = db.prepare('SELECT * FROM shift_tasks WHERE id = ?').get(taskId);
  if (!t || t.crew_member_id !== worker.id) {
    req.flash('error', 'Task not found or not yours.');
    return res.redirect('back');
  }
  if (undo) {
    db.prepare("UPDATE shift_tasks SET status = 'pending', completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(taskId);
    req.flash('success', 'Task reopened.');
  } else {
    db.prepare("UPDATE shift_tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
    req.flash('success', 'Task marked done.');
  }
  // Try to send the worker back to the shift detail.
  if (t.booking_id) return res.redirect('/w/booking-shift/' + t.booking_id + '?tab=tasks');
  if (t.allocation_id) return res.redirect('/w/jobs/' + t.allocation_id + '?tab=tasks');
  res.redirect('/w/home');
});

// POST /w/shift-tasks (TL+ only) — create a quick task for a teammate
// from the worker portal. Two scopes:
//   - shift-bound: booking_id set (the task lives against this shift)
//   - general:     scope=general (booking_id ignored, task is standing
//                  work the assignee carries across shifts)
router.post('/shift-tasks', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const me = db.prepare('SELECT portal_role FROM crew_members WHERE id = ?').get(worker.id);
  const isTL = !!(me && (me.portal_role === 'team_leader' || me.portal_role === 'supervisor'));
  if (!isTL) {
    req.flash('error', 'Team Leader access only.');
    return res.redirect('back');
  }
  const { crew_member_id, booking_id, allocation_id, title, priority, scope } = req.body;
  if (!crew_member_id || !title || !title.trim()) {
    req.flash('error', 'Title and assignee are required.');
    return res.redirect('back');
  }
  const isGeneral = scope === 'general';
  let bookingScope = null;
  let allocScope = null;
  if (!isGeneral) {
    if (!booking_id) {
      req.flash('error', 'Pick a shift or mark the task as general.');
      return res.redirect('back');
    }
    // Assignee must be on this booking too (no cross-booking task drops).
    const ok = db.prepare('SELECT 1 FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(booking_id, crew_member_id);
    if (!ok) {
      req.flash('error', "That worker isn't on this shift.");
      return res.redirect('back');
    }
    bookingScope = booking_id;
    allocScope = allocation_id || null;
  }
  db.prepare(`
    INSERT INTO shift_tasks (allocation_id, booking_id, crew_member_id, title, priority, created_by_crew_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(allocScope, bookingScope, crew_member_id, title.trim(),
         ['low','normal','high'].includes(priority) ? priority : 'normal', worker.id);
  // Notify the assignee (no point pinging yourself for a task you just made).
  if (String(crew_member_id) !== String(worker.id)) {
    try {
      let meta = { title: title.trim(), url: '/w/home', shift_label: '' };
      if (bookingScope) {
        const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id = ?').get(bookingScope) || {};
        const date = bk.start_datetime ? new Date(String(bk.start_datetime).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        meta = { title: title.trim(), url: '/w/booking-shift/' + bookingScope + '?tab=tasks', shift_label: [date, bk.title || bk.booking_number].filter(Boolean).join(' ') };
      }
      bookingNotify.notifyTaskAssigned([crew_member_id], meta);
    } catch (e) { console.error('[worker tasks] task-assigned notify failed:', e.message); }
  }
  req.flash('success', isGeneral ? 'General task added.' : 'Shift task added.');
  if (bookingScope) return res.redirect('/w/booking-shift/' + bookingScope + '?tab=tasks');
  return res.redirect('/w/home');
});

module.exports = router;
