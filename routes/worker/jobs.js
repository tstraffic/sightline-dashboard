const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday, TZ: SYD_TZ } = require('../../lib/sydney');
const { resolveShift, getCurrentDocket } = require('../../lib/shiftDocket');
const { maybePromoteToGreenToGo } = require('../../lib/bookingLifecycle');
const bookingNotify = require('../../services/bookingNotify');
const { syncBookingReturnTasks, syncBookingTaskGroups, createTeamTask } = require('../../services/returnTasks');
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
const { getBookingVehicleGroups, buildShiftForms } = require('../../lib/shiftForms');


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
  const VISIBLE_BOOKING_STATUSES = ['locked','confirmed','green_to_go','in_progress','complete','on_hold']; // locked: workers are push-notified to accept while locked, so the shift must be visible

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
      AND ca.allocation_date >= date(?, '-7 days')
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
        AND DATE(b.start_datetime) >= date(?, '-7 days')
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

  // Split into three: shifts whose date has passed but aren't finished yet
  // (no docket signed → status still allocated/confirmed) surface as
  // "To finish" so they never silently drop into Past; then future requests
  // (allocated) and future confirmed. The upcoming query already limits the
  // past tail to 7 days, so only recently-worked shifts show here.
  const toFinish = upcoming.filter(a => a.allocation_date < today);
  const future = upcoming.filter(a => a.allocation_date >= today);
  const requests = future.filter(a => a.status === 'allocated');
  const confirmed = future.filter(a => a.status === 'confirmed');

  // Finished from crew_allocations — a shift is only "past" once its docket is
  // signed (completeShift → status 'completed') or it was declined. Un-docketed
  // shifts within the last 7 days stay in "To finish"; older ones fall here.
  const finished = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number) AS job_number,
      COALESCE(j.job_name,   b.title)          AS job_name,
      COALESCE(j.client,     b.title)          AS client,
      COALESCE(j.site_address, b.site_address) AS site_address,
      COALESCE(j.suburb,     b.suburb)         AS suburb,
      j.notes as job_notes, COALESCE(j.project_name, b.title) AS project_name,
      j.client_project_number, COALESCE(j.state, b.state) AS state,
      u.full_name as supervisor_name,
      CASE WHEN ca.job_id IS NULL AND ca.booking_id IS NOT NULL
           THEN 'booking' ELSE 'allocation' END AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    LEFT JOIN users u    ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ?
      AND ca.status != 'cancelled'
      AND (ca.status IN ('completed', 'declined') OR ca.allocation_date < date(?, '-7 days'))
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
      AND (ca.status IN ('completed','declined','confirmed') OR ca.allocation_date < date(?, '-7 days'))
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
    toFinish,
    toFinishByDate: groupByDate(toFinish),
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

  // Booking-backed shifts live on the booking page — it carries everything
  // this page has (details, docs, forms + docket) PLUS shift tasks and the
  // crew/vehicle groups. Without this, job-linked bookings landed here and
  // the worker "lost" the Tasks tab.
  if (allocation && allocation.booking_id) {
    const TAB_MAP = { info: 'details', docs: 'docs', forms: 'forms', docket: 'forms', tasks: 'tasks' };
    return res.redirect('/w/booking-shift/' + allocation.booking_id + '?tab=' + (TAB_MAP[tab] || 'details'));
  }

  if (!allocation) {
    req.flash('error', 'Job not found or you do not have access.');
    return req.session.save(() => res.redirect('/w/jobs'));
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

      // Final traffic plans on the job — what the office pushed via the job
      // page's "Push to Final Plans". These live in traffic_plans, not
      // job_documents, so the crew could never open them even though the
      // booking counted them as part of the site pack.
      const finalPlans = allocation.job_id ? db.prepare(`
        SELECT id, plan_number, plan_type, file_original_name, file_path, marked_final_at
        FROM traffic_plans WHERE job_id = ? AND is_final = 1 AND COALESCE(file_path, '') != ''
      `).all(allocation.job_id).map(d => ({
        id: d.id, source: 'final', doc_type: (d.plan_type || 'plan').toLowerCase(),
        title: d.plan_number || 'Final plan',
        original_name: d.file_original_name, mime_type: null,
        size_bytes: null, uploaded_at: d.marked_final_at,
        download_url: `/w/final-plans/${d.id}`,
      })) : [];

  let bookingLevel = [];
  if (allocation.booking_id) {
    bookingLevel = db.prepare(`
      SELECT id, document_type, title, original_name, file_size, created_at
      FROM booking_documents WHERE booking_id = ? AND COALESCE(visible_to_crew, 1) = 1
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
  const jobDocuments = [...jobLevel, ...finalPlans, ...bookingLevel].sort((a, b) => {
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
  // Docs hidden from crew never leave the admin side, even by direct URL.
  if (doc.visible_to_crew != null && !doc.visible_to_crew) return res.status(404).send('Not found');

  const linked = db.prepare(`
    SELECT 1 FROM crew_allocations
    WHERE crew_member_id = ? AND booking_id = ? AND status != 'cancelled' LIMIT 1
  `).get(worker.id, doc.booking_id);
  if (!linked) return res.status(403).send('Forbidden');

  // Stored paths come in every historical shape (absolute, app-relative, and
  // pre-migration-319 rows pointing at the old ephemeral uploads/ dir whose
  // file now lives under data/uploads/). Try each candidate.
  const appRoot = path.join(__dirname, '..', '..');
  const candidates = path.isAbsolute(doc.file_path)
    ? [doc.file_path, doc.file_path.replace(path.join(appRoot, 'uploads'), path.join(appRoot, 'data', 'uploads'))]
    : [path.join(appRoot, doc.file_path),
       path.join(appRoot, 'data', doc.file_path),
       path.join(appRoot, doc.file_path.replace(/^data\//, ''))];
  const abs = candidates.find(c => { try { return fs.existsSync(c); } catch (e) { return false; } });
  if (!abs) return res.status(404).send('File missing');

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

// GET /w/doc/:source/:id — In-app document viewer. Renders a full-screen
// page that embeds the document (PDF in an iframe, image inline, anything
// else falls back to a download link) with a Back button — so workers read
// site docs without bouncing out to a new browser tab. `source` is 'job' or
// 'booking'; access is re-validated against the underlying stream route.
router.get('/doc/:source/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const source = req.params.source === 'job' ? 'job' : (req.params.source === 'plan' ? 'plan' : 'booking');
  let doc = null, jobId = null, bookingId = null, fileUrl = null;

  if (source === 'job') {
    doc = db.prepare(`SELECT jd.*, j.id AS jid FROM job_documents jd JOIN jobs j ON jd.job_id = j.id WHERE jd.id = ? AND jd.archived_at IS NULL`).get(req.params.id);
    if (doc) { jobId = doc.jid; fileUrl = '/w/job-documents/' + doc.id; }
  } else if (source === 'plan') {
    // A compliance-plan file (TGS / TMP / ROL) inherited from the linked
    // job. Resolve the owning job through the plan (or its parent plan).
    doc = db.prepare(`
      SELECT cd.*, COALESCE(c.job_id, pc.job_id) AS jid
      FROM compliance_documents cd
      JOIN compliance c ON c.id = cd.compliance_id
      LEFT JOIN compliance pc ON pc.id = c.parent_id
      WHERE cd.id = ?
    `).get(req.params.id);
    if (doc) { jobId = doc.jid; fileUrl = doc.file_path; }
  } else {
    doc = db.prepare(`SELECT * FROM booking_documents WHERE id = ?`).get(req.params.id);
    if (doc) { bookingId = doc.booking_id; fileUrl = '/w/booking-documents/' + doc.id; }
  }
  if (!doc) { req.flash('error', 'Document not found.'); return req.session.save(() => res.redirect('/w/jobs')); }

  const linked = bookingId
    ? db.prepare(`SELECT 1 FROM crew_allocations WHERE crew_member_id = ? AND booking_id = ? AND status != 'cancelled' LIMIT 1`).get(worker.id, bookingId)
    : db.prepare(`
        SELECT 1 FROM crew_allocations WHERE crew_member_id = @cm AND job_id = @job AND status != 'cancelled'
        UNION
        SELECT 1 FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id
        WHERE bc.crew_member_id = @cm AND b.job_id = @job AND bc.status != 'declined'
        LIMIT 1
      `).get({ cm: worker.id, job: jobId });
  if (!linked) { req.flash('error', 'You don’t have access to that document.'); return req.session.save(() => res.redirect('/w/jobs')); }

  const name = doc.original_name || doc.title || 'Document';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const kind = ext === 'pdf' ? 'pdf'
    : ['png','jpg','jpeg','gif','webp','heic'].includes(ext) ? 'image'
    : 'other';
  // Sanitise the back target — only allow internal worker paths.
  let back = typeof req.query.back === 'string' && req.query.back.startsWith('/w/') ? req.query.back : '/w/jobs';

  res.render('worker/doc-view', {
    title: doc.title || name,
    layout: 'worker/layout-bare',
    fileUrl,
    docName: doc.title || name,
    kind, back,
  });
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
    WHERE crew_member_id = @cm AND job_id = @job AND status != 'cancelled'
    UNION
    SELECT 1 FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id
    WHERE bc.crew_member_id = @cm AND b.job_id = @job AND bc.status != 'declined'
    LIMIT 1
  `).get({ cm: worker.id, job: doc.jid });
  if (!linked) return res.status(403).send('Forbidden');

  const abs = path.isAbsolute(doc.file_path) ? doc.file_path : path.join(__dirname, '..', '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', doc.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(doc.original_name || doc.title || 'document.pdf').replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

// GET /w/final-plans/:id — Stream a job's FINAL traffic plan to the worker.
// These live in traffic_plans (not job_documents), which is why the crew
// previously had no way to open a plan the office had pushed to Final Plans
// even though the booking counted it in the site pack.
router.get('/final-plans/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const path = require('path');
  const fs = require('fs');

  const plan = db.prepare(`
    SELECT id, job_id, plan_number, file_path, file_original_name
    FROM traffic_plans WHERE id = ? AND is_final = 1
  `).get(req.params.id);
  if (!plan || !plan.file_path) return res.status(404).send('Not found');

  const linked = db.prepare(`
    SELECT 1 FROM crew_allocations
    WHERE crew_member_id = @cm AND job_id = @job AND status != 'cancelled'
    UNION
    SELECT 1 FROM booking_crew bc JOIN bookings b ON b.id = bc.booking_id
    WHERE bc.crew_member_id = @cm AND b.job_id = @job AND bc.status != 'declined'
    LIMIT 1
  `).get({ cm: worker.id, job: plan.job_id });
  if (!linked) return res.status(403).send('Forbidden');

  // Plan files are stored relative to the app root (public/ served
  // statically); resolve both shapes defensively.
  const rel = plan.file_path.replace(/^\/+/, '');
  const candidates = [
    path.isAbsolute(plan.file_path) ? plan.file_path : null,
    path.join(__dirname, '..', '..', rel),
    path.join(__dirname, '..', '..', 'public', rel),
  ].filter(Boolean);
  const abs = candidates.find(p2 => { try { return fs.existsSync(p2); } catch (e) { return false; } });
  if (!abs) return res.status(404).send('File missing');

  const name = plan.file_original_name || (plan.plan_number || 'plan') + '.pdf';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${name.replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

// POST /w/jobs/:id/respond — Accept or decline an allocation
router.post('/jobs/:id/respond', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { action } = req.body;

  if (!action || !['accept', 'decline'].includes(action)) {
    req.flash('error', 'Invalid action.');
    return req.session.save(() => res.redirect('/w/jobs/' + req.params.id));
  }

  // Verify allocation belongs to this worker and is in 'allocated' status
  const allocation = db.prepare(`
    SELECT id, status FROM crew_allocations
    WHERE id = ? AND crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Allocation not found.');
    return req.session.save(() => res.redirect('/w/jobs'));
  }

  if (allocation.status !== 'allocated') {
    req.flash('error', 'This shift has already been ' + allocation.status + '.');
    return req.session.save(() => res.redirect('/w/jobs/' + req.params.id));
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

  req.session.save(() => res.redirect('/w/jobs/' + req.params.id));
});

// GET /w/booking-shift/:bookingId — Booking detail (for booking_crew-based shifts)
router.get('/booking-shift/:bookingId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const tab = req.query.tab || 'details';

  // Get booking details
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.bookingId);
  if (!booking) { req.flash('error', 'Booking not found.'); return req.session.save(() => res.redirect('/w/jobs')); }
  // Cancelled/deleted bookings must not render via deep link (push
  // notifications and old links otherwise resurrect ghost shifts).
  if (booking.deleted_at || ['cancelled', 'late_cancellation'].includes(booking.status)) {
    req.flash('error', 'That shift has been cancelled.');
    return req.session.save(() => res.redirect('/w/jobs'));
  }

  // Verify this worker is assigned to this booking
  const myAssignment = db.prepare('SELECT * FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(booking.id, worker.id);
  if (!myAssignment) { req.flash('error', 'You are not assigned to this booking.'); return req.session.save(() => res.redirect('/w/jobs')); }

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
      // Final traffic plans on the job — what the office pushed via the job
      // page's "Push to Final Plans". These live in traffic_plans, not
      // job_documents, so the crew could never open them even though the
      // booking counted them as part of the site pack.
      const finalPlans = booking.job_id ? db.prepare(`
        SELECT id, plan_number, plan_type, file_original_name, file_path, marked_final_at
        FROM traffic_plans WHERE job_id = ? AND is_final = 1 AND COALESCE(file_path, '') != ''
      `).all(booking.job_id).map(d => ({
        id: d.id, source: 'final', doc_type: (d.plan_type || 'plan').toLowerCase(),
        title: d.plan_number || 'Final plan',
        original_name: d.file_original_name, mime_type: null,
        size_bytes: null, uploaded_at: d.marked_final_at,
        download_url: `/w/final-plans/${d.id}`,
      })) : [];

      const bookingLevel = db.prepare(`
        SELECT id, document_type, title, original_name, file_size, created_at
        FROM booking_documents WHERE booking_id = ? AND COALESCE(visible_to_crew, 1) = 1
      `).all(booking.id).map(d => ({
        id: d.id, source: 'booking', doc_type: d.document_type, title: d.title,
        original_name: d.original_name, mime_type: null,
        size_bytes: d.file_size, uploaded_at: d.created_at,
        download_url: `/w/booking-documents/${d.id}`,
      }));
      // Plans & Approvals from the linked job (TGS / TMP / ROL) that the
      // office marked crew-visible for this booking. Each attached file
      // becomes a doc row; a plan with only an external link becomes a
      // link row (external_url) so the crew can still open it.
      let planLevel = [];
      try {
        const { getJobPlansForBooking } = require('../../lib/bookingPlans');
        const jp = getJobPlansForBooking(db, booking);
        const KIND_LABEL = { tgs: 'TGS', tmp: 'TMP', rol: 'ROL' };
        ((jp && jp.all) || []).filter(p => p.visible_to_crew).forEach(p => {
          const planName = (p.kind === 'rol' ? (p.rol_actual_number || p.reference_number) : (p.plan_number || p.reference_number)) || (KIND_LABEL[p.kind] + ' #' + p.id);
          (p.docs || []).forEach(d => {
            planLevel.push({
              id: d.id, source: 'plan', doc_type: p.kind, title: planName + (p.title ? ' — ' + p.title : ''),
              original_name: d.original_name, mime_type: null,
              size_bytes: d.file_size, uploaded_at: p.approved_date || '',
              download_url: d.file_path,
            });
          });
          if (!p.docs.length && (p.file_link || p.rol_file_path)) {
            planLevel.push({
              id: p.id, source: 'plan', doc_type: p.kind, title: planName + (p.title ? ' — ' + p.title : ''),
              original_name: planName, mime_type: null, size_bytes: null,
              uploaded_at: p.approved_date || '', external_url: p.rol_file_path || p.file_link,
            });
          }
        });
      } catch (e) { console.error('[booking-shift] plan fetch:', e.message); }
      const DOC_PRIORITY = { tgs:1, tmp:2, ctmp:2, rol_day:3, rol_night:4, rol:3, stage_plan:5, swms:6, permit:7, other:8, photo:9, invoice:10 };
      jobDocuments = [...planLevel, ...jobLevel, ...finalPlans, ...bookingLevel].sort((a, b) => {
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
        CASE WHEN st.booking_id IS NULL AND st.allocation_id IS NULL THEN 1 ELSE 0 END AS is_general,
        CASE WHEN be.hire_unit_id IS NOT NULL THEN 1 ELSE 0 END AS is_hired
      FROM shift_tasks st JOIN crew_members cm ON st.crew_member_id = cm.id
      LEFT JOIN booking_equipment be ON be.id = st.booking_equipment_id
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
        // Grouped tasks (team / equipment return) collapse to one row, and
        // groups the viewer is IN are skipped — they already see those
        // under "My tasks" with the TEAM badge.
        teamTasks = db.prepare(`
          SELECT st.*, cm.full_name AS assignee_name, cm.portal_role AS assignee_portal_role,
            CASE WHEN st.booking_id IS NULL AND st.allocation_id IS NULL THEN 1 ELSE 0 END AS is_general,
            COUNT(*) AS group_size
          FROM shift_tasks st JOIN crew_members cm ON st.crew_member_id = cm.id
          WHERE st.crew_member_id IN (${placeholders})
            AND (
              st.booking_id = ?
              OR (st.booking_id IS NULL AND st.allocation_id IS NULL)
            )
            AND (st.group_key IS NULL OR NOT EXISTS (
              SELECT 1 FROM shift_tasks mine
              WHERE mine.group_key = st.group_key AND mine.crew_member_id = ?
            ))
          GROUP BY COALESCE(st.group_key, 'id:' || st.id)
          ORDER BY CASE st.status WHEN 'pending' THEN 0 ELSE 1 END,
                   CASE st.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                   st.due_at ASC, st.created_at ASC
        `).all(...crewIds, booking.id, worker.id);
      }
    }
  } catch (e) { console.error('[booking-shift] tasks fetch error:', e.message); }

  // Crew-aware + vehicle-aware Job-Pack completion. vehicleGroups feeds both
  // the People tab and the Forms tab's per-ute checklist cards.
  const vehicleGroups = getBookingVehicleGroups(db, booking.id, worker.id);
  const shiftForms = allocation ? buildShiftForms(db, booking, worker, vehicleGroups) : null;

  res.render('worker/booking-detail', {
    title: booking.title || booking.booking_number,
    currentPage: 'shifts',
    tab,
    booking,
    crew,
    myStatus: myAssignment.status,
    startDay, startDate, startTime, endTime,
    allocation, formStatus, docket, jobDocuments,
    shiftForms,
    shiftTemplates: allocation ? getShiftTemplates(db, worker.id, allocation.id) : [],
    vehicleGroups,
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
    return req.session.save(() => res.redirect('/w/booking-shift/' + req.params.id));
  }

  const bc = db.prepare("SELECT * FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?").get(req.params.id, worker.id);
  if (!bc) { req.flash('error', 'Assignment not found.'); return req.session.save(() => res.redirect('/w/jobs')); }

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
    // A declined worker isn't bringing gear back — drop them from any
    // return-to-depot task groups on this shift.
    try { syncBookingTaskGroups(db, parseInt(req.params.id, 10)); } catch (e) { console.error('[worker respond] task-group sync failed:', e.message); }
    req.flash('success', 'Shift declined.');
  }

  req.session.save(() => res.redirect('/w/booking-shift/' + req.params.id));
  } catch (err) {
    console.error('Booking respond error:', err.message);
    req.flash('error', 'Error: ' + err.message);
    req.session.save(() => res.redirect('/w/jobs'));
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
    return req.session.save(() => res.redirect('back'));
  }
  if (t.group_key || t.booking_equipment_id) {
    // Grouped task (equipment return or whole-crew Team task) — one crew
    // member's tick moves the WHOLE group. group_key is the fan-out key;
    // booking_equipment_id is the legacy fallback for pre-322 rows.
    const key = t.group_key ? 'group_key' : 'booking_equipment_id';
    const val = t.group_key || t.booking_equipment_id;
    if (undo) {
      db.prepare(`UPDATE shift_tasks SET status = 'pending', completed_at = NULL, updated_at = datetime('now') WHERE ${key} = ?`).run(val);
      // Reopening an equipment-return task retracts its condition report
      // (and the faulty follow-up task, if the office hasn't started it).
      if (t.booking_equipment_id) {
        try { require('../../services/equipmentReports').undoReturnReport(db, t.booking_equipment_id); } catch (e) {}
      }
      req.flash('success', 'Task reopened for the whole crew.');
    } else {
      // Equipment-return completion carries the condition/destination
      // report from the bottom sheet. Validate before completing —
      // a return without a report leaves the location trail blind.
      if (t.kind === 'equipment_return' && t.booking_equipment_id) {
        const { recordReturnReport } = require('../../services/equipmentReports');
        const result = recordReturnReport(db, {
          bookingId: t.booking_id,
          bookingEquipmentId: t.booking_equipment_id,
          condition: req.body.condition,
          destination: req.body.destination,
          note: req.body.note,
          reportedByCrewId: worker.id,
        });
        if (!result) {
          req.flash('error', 'Tell us the gear\'s condition and where it went to finish this task.');
          if (t.booking_id) return req.session.save(() => res.redirect('/w/booking-shift/' + t.booking_id + '?tab=tasks'));
          return req.session.save(() => res.redirect('/w/home'));
        }
      }
      db.prepare(`UPDATE shift_tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE ${key} = ? AND status = 'pending'`).run(val);
      req.flash('success', 'Task marked done for the whole crew.');
    }
  } else if (undo) {
    db.prepare("UPDATE shift_tasks SET status = 'pending', completed_at = NULL, updated_at = datetime('now') WHERE id = ?").run(taskId);
    req.flash('success', 'Task reopened.');
  } else {
    db.prepare("UPDATE shift_tasks SET status = 'done', completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(taskId);
    req.flash('success', 'Task marked done.');
  }
  // Try to send the worker back to the shift detail.
  if (t.booking_id) return req.session.save(() => res.redirect('/w/booking-shift/' + t.booking_id + '?tab=tasks'));
  if (t.allocation_id) return req.session.save(() => res.redirect('/w/jobs/' + t.allocation_id + '?tab=tasks'));
  req.session.save(() => res.redirect('/w/home'));
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
    return req.session.save(() => res.redirect('back'));
  }
  const { crew_member_id, booking_id, allocation_id, title, priority, scope } = req.body;
  if (!crew_member_id || !title || !title.trim()) {
    req.flash('error', 'Title and assignee are required.');
    return req.session.save(() => res.redirect('back'));
  }
  const isGeneral = scope === 'general';
  // Whole-team task: fans one row per active crew member, completes as
  // one. Branched BEFORE the booking_crew guard ('team' isn't a crew id);
  // needs a shift roster, so general scope is rejected.
  if (crew_member_id === 'team') {
    if (isGeneral || !booking_id) {
      req.flash('error', 'Team tasks need a shift — for a general task pick one person.');
      return req.session.save(() => res.redirect('back'));
    }
    const group = createTeamTask(db, parseInt(booking_id, 10), {
      title: title.trim(),
      priority: ['low','normal','high'].includes(priority) ? priority : 'normal',
      createdByCrewId: worker.id,
    });
    if (!group) {
      req.flash('error', 'No crew on this shift yet.');
      return req.session.save(() => res.redirect('back'));
    }
    try {
      const bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id = ?').get(booking_id) || {};
      const date = bk.start_datetime ? new Date(String(bk.start_datetime).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
      bookingNotify.notifyTaskAssigned(group.crewIds.filter(id => String(id) !== String(worker.id)), {
        title: title.trim(),
        url: '/w/booking-shift/' + booking_id + '?tab=tasks',
        shift_label: [date, bk.title || bk.booking_number].filter(Boolean).join(' '),
      });
    } catch (e) { console.error('[worker tasks] team notify failed:', e.message); }
    req.flash('success', 'Team task added — first to finish ticks it off for everyone.');
    return req.session.save(() => res.redirect('/w/booking-shift/' + booking_id + '?tab=tasks'));
  }
  let bookingScope = null;
  let allocScope = null;
  if (!isGeneral) {
    if (!booking_id) {
      req.flash('error', 'Pick a shift or mark the task as general.');
      return req.session.save(() => res.redirect('back'));
    }
    // Assignee must be on this booking too (no cross-booking task drops).
    const ok = db.prepare('SELECT 1 FROM booking_crew WHERE booking_id = ? AND crew_member_id = ?').get(booking_id, crew_member_id);
    if (!ok) {
      req.flash('error', "That worker isn't on this shift.");
      return req.session.save(() => res.redirect('back'));
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
  if (bookingScope) return req.session.save(() => res.redirect('/w/booking-shift/' + bookingScope + '?tab=tasks'));
  return req.session.save(() => res.redirect('/w/home'));
});

module.exports = router;
