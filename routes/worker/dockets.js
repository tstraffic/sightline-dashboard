const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');
const { resolveShift, getCurrentDocket, getDocketCrew, completeShift, calcHours, generateDocketNumber } = require('../../lib/shiftDocket');
const bookingNotify = require('../../services/bookingNotify');
const { logActivity } = require('../../middleware/audit');

// Build the worker-facing sign URL for a resolved shift.
function shiftUrl(shift) {
  if (!shift) return '/w/dockets';
  return shift.type === 'booking'
    ? '/w/dockets/shift/' + shift.bookingId
    : '/w/dockets/shift/job/' + shift.jobId + '/' + shift.shiftDate;
}

// GET /w/dockets — My Dockets
router.get('/dockets', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Past dockets — LEFT JOIN jobs so booking-only allocations still show.
  // For those rows we COALESCE the booking title/number into client/job_number
  // so the UI doesn't render blanks.
  // Recent shift dockets this worker is part of — as the signer, the legacy
  // owner, or a named crew member. Only 'current' (non-superseded) headers.
  const dockets = db.prepare(`
    SELECT ds.*,
           COALESCE(ds.shift_date, ca.allocation_date) AS allocation_date,
           COALESCE(j.job_number, b.booking_number) AS job_number,
           COALESCE(j.client, b.title) AS client,
           (SELECT COUNT(*) FROM docket_crew dc WHERE dc.docket_id = ds.id) AS crew_count
    FROM docket_signatures ds
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN bookings b ON COALESCE(ds.booking_id, ca.booking_id) = b.id
    LEFT JOIN jobs j ON COALESCE(ds.shift_job_id, ca.job_id) = j.id
    WHERE COALESCE(ds.status,'current') = 'current'
      AND (ds.signed_by_crew_id = ? OR ds.crew_member_id = ?
           OR EXISTS (SELECT 1 FROM docket_crew dc WHERE dc.docket_id = ds.id AND dc.crew_member_id = ?))
    ORDER BY ds.signed_at DESC LIMIT 30
  `).all(worker.id, worker.id, worker.id);

  const today = sydneyToday();

  // Today's allocations (job-bound or booking-bound). LEFT JOIN jobs so a
  // booking-only allocation (job_id IS NULL) still surfaces, with COALESCE
  // pulling the booking's title / number / address / suburb in.
  const todaysShifts = db.prepare(`
    SELECT ca.id, ca.allocation_date, ca.start_time, ca.end_time, ca.status,
           ca.booking_id, ca.job_id,
           COALESCE(j.job_number, b.booking_number) AS job_number,
           COALESCE(j.client, b.title)             AS client,
           COALESCE(j.site_address, b.site_address) AS site_address,
           COALESCE(j.suburb, b.suburb)             AS suburb,
           'allocation' AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
      AND (ca.booking_id IS NULL OR (b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')))
  `).all(worker.id, today);

  // Booking-only fallback: workers assigned to a booking via booking_crew
  // who haven't yet hit /w/booking-shift/:id (which lazy-creates the alloc
  // row) won't have a crew_allocations row. Surface those here so they can
  // see "needs signing" — clicking the row routes to /w/booking-shift/...
  // which creates the alloc and then they can sign the docket from there.
  // Excludes 'unconfirmed' — crew don't see a shift until the allocator
  // confirms the booking (matches routes/worker/jobs.js).
  const VISIBLE_BOOKING_STATUSES = ['confirmed','green_to_go','in_progress','complete','on_hold'];
  let bookingFallback = [];
  try {
    bookingFallback = db.prepare(`
      SELECT
        bc.id AS bc_id,
        bc.booking_id,
        b.booking_number AS job_number,
        b.title AS client,
        b.site_address, b.suburb,
        DATE(b.start_datetime) AS allocation_date,
        SUBSTR(b.start_datetime, 12, 5) AS start_time,
        SUBSTR(b.end_datetime, 12, 5) AS end_time,
        bc.status,
        'booking' AS source
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) = ?
        AND bc.status IN ('assigned','confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
    `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* booking_crew may not exist on legacy DBs */ }

  const allTodayShifts = todaysShifts.concat(bookingFallback);

  // One docket per shift now: resolve each of today's shifts to its shift key,
  // attach the sign URL, and mark it signed if a current shift docket exists.
  // De-dupe so multiple allocations on the same booking collapse to one row.
  const seenKeys = new Set();
  const decorated = [];
  for (const s of allTodayShifts) {
    const shift = s.booking_id
      ? resolveShift(db, { bookingId: s.booking_id })
      : resolveShift(db, { allocationId: s.id });
    const key = shift
      ? (shift.type === 'booking' ? 'b' + shift.bookingId : 'j' + shift.jobId + '|' + shift.shiftDate)
      : 'a' + s.id;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const current = shift ? getCurrentDocket(db, shift) : null;
    decorated.push({ ...s, href: shift ? shiftUrl(shift) : ('/w/dockets/sign/' + s.id), signed: !!current });
  }
  const unsignedShifts = decorated.filter(s => !s.signed);
  const signedShifts   = decorated.filter(s => s.signed);

  res.render('worker/dockets', {
    title: 'Dockets',
    currentPage: 'forms',
    dockets,
    todaysShifts: decorated,
    unsignedShifts,
    signedShifts,
    today,
  });
});

// ===========================================================================
// Shift dockets — one docket per shift, covering the whole crew.
// ===========================================================================

// Required checklists a signing worker must have submitted on this shift
// before they can sign the docket. The submit handler enforces this; we
// also surface it as a banner on the sign page so the worker doesn't try
// to sign and lose their entered data to a redirect.
const REQUIRED_FORMS = [
  { key: 'risk_toolbox', label: 'Risk Assessment & Toolbox', url: '/w/forms/risk-assessment' },
  { key: 'team_leader',  label: 'Team Leader Checklist',     url: '/w/forms/team-leader' },
];

function computeMissingRequiredForms(db, workerId, signerAlloc) {
  if (!signerAlloc) return [];
  const submitted = new Set(
    db.prepare(`
      SELECT DISTINCT form_type FROM safety_forms
      WHERE crew_member_id = ? AND allocation_id = ? AND form_type IN ('risk_toolbox','team_leader')
    `).all(workerId, signerAlloc.id).map(r => r.form_type)
  );
  return REQUIRED_FORMS
    .filter(f => !submitted.has(f.key))
    .map(f => ({ ...f, href: f.url + '?allocationId=' + signerAlloc.id }));
}

// Render the sign page (editable form) or, if already signed, a read-only
// locked view. One docket per shift can't be re-done from the portal.
function renderShiftSign(req, res, shift) {
  const db = getDb();
  const current = getCurrentDocket(db, shift);
  // Back link is origin-aware. Default is the Dockets list — backing out of a
  // docket used to dump booking-shift workers into the Job-Pack (forms) tab,
  // which was disorienting when they'd arrived from the Dockets list. Only
  // when the docket was opened FROM the Job-Pack tab (?from=forms) do we
  // return there.
  let backUrl = '/w/dockets';
  let backLabel = 'Dockets';
  if (req.query.from === 'forms' && shift.type === 'booking') {
    backUrl = '/w/booking-shift/' + shift.bookingId + '?tab=forms';
    backLabel = 'Forms';
  }

  if (current) {
    const signer = current.signed_by_crew_id || current.crew_member_id
      ? db.prepare('SELECT full_name FROM crew_members WHERE id = ?').get(current.signed_by_crew_id || current.crew_member_id)
      : null;
    return res.render('worker/docket-sign', {
      title: 'Docket', currentPage: 'forms', shift, backUrl, backLabel,
      locked: true,
      signActionUrl: shiftUrl(shift),
      prefillStart: '', prefillFinish: '', prefillBreakMinutes: 30,
      missingRequiredForms: [],
      lockedDocket: {
        signed_at: current.signed_at,
        signed_by_name: signer ? signer.full_name : '',
        client_name: current.client_name,
        client_signed_name: current.client_signed_name,
        no_client_on_site: current.no_client_on_site,
        no_client_reason: current.no_client_reason,
        signature_data: current.signature_data,
        client_signature: current.client_signature,
        notes: current.notes,
        crew: getDocketCrew(db, current),
      },
    });
  }

  const worker = req.session.worker;
  const signerAlloc = getSignerAllocation(db, worker.id, shift);
  const missingRequiredForms = computeMissingRequiredForms(db, worker.id, signerAlloc);

  res.render('worker/docket-sign', {
    title: 'Sign Docket', currentPage: 'forms', shift, backUrl, backLabel,
    locked: false, lockedDocket: null,
    signActionUrl: shiftUrl(shift),
    prefillStart: shift.startTime || '', prefillFinish: shift.endTime || '', prefillBreakMinutes: 30,
    missingRequiredForms,
  });
}

// The signing worker's own allocation for this shift (used for Job-Pack gating).
function getSignerAllocation(db, workerId, shift) {
  if (shift.type === 'booking') {
    return db.prepare('SELECT * FROM crew_allocations WHERE booking_id = ? AND crew_member_id = ?').get(shift.bookingId, workerId);
  }
  return db.prepare('SELECT * FROM crew_allocations WHERE job_id = ? AND allocation_date = ? AND crew_member_id = ?').get(shift.jobId, shift.shiftDate, workerId);
}

function submitShiftDocket(req, res, shift) {
  const db = getDb();
  const worker = req.session.worker;
  const backRedirect = shiftUrl(shift);

  // Lock: never allow a second docket for the same shift from the portal.
  if (getCurrentDocket(db, shift)) {
    req.flash('error', 'This shift docket has already been signed.');
    return req.session.save(() => res.redirect(backRedirect));
  }

  const b = req.body;
  const noClient = b.no_client_on_site === '1' || b.no_client_on_site === 'on' || b.no_client_on_site === true;
  const crewInput = b.crew || {};

  // Build per-crew lines from the SHIFT crew (server-side source of truth),
  // reading hours from the submitted form. Each crew member needs start+finish.
  const lines = [];
  const missingCrew = [];
  for (const c of shift.crew) {
    const row = crewInput['cm' + c.crew_member_id] || {};
    const start = (row.start_on_site || '').trim();
    const finish = (row.finish_on_site || '').trim();
    if (!start || !finish) { missingCrew.push(c.name); continue; }
    const breakMin = parseInt(row.break_minutes, 10) || 0;
    const travel = parseFloat(row.travel_hours) || 0;
    lines.push({
      crew_member_id: c.crew_member_id, allocation_id: c.allocation_id, booking_crew_id: c.booking_crew_id,
      name: c.name, role: c.role,
      start_on_site: start, finish_on_site: finish, break_minutes: breakMin, travel_hours: travel,
      total_hours: calcHours(start, finish, breakMin, travel),
    });
  }

  const missing = [];
  if (!shift.crew.length) missing.push('crew on this shift');
  if (missingCrew.length) missing.push('start/finish for ' + missingCrew.join(', '));
  if (!b.signature_data) missing.push('your signature');
  if (!noClient && !b.client_signature) missing.push('client signature (or tick "no client on site")');
  if (missing.length) {
    req.flash('error', 'Missing: ' + missing.join('; ') + '.');
    return req.session.save(() => res.redirect(backRedirect));
  }

  // Job-Pack gating — preserve the existing "required: risk_toolbox +
  // team_leader" rule, evaluated against the signing worker's allocation when
  // one exists (booking shifts may not have lazily created it). Same helper
  // is used by renderShiftSign to surface the requirement BEFORE the worker
  // tries to sign, so this branch should only fire if they bypassed the UI.
  const signerAlloc = getSignerAllocation(db, worker.id, shift);
  const missingForms = computeMissingRequiredForms(db, worker.id, signerAlloc);
  if (missingForms.length) {
    req.flash('error',
      "Docket not signed — finish these checklists first: " +
      missingForms.map(f => f.label).join(' and ') +
      ". You'll find them in this shift's Forms tab.");
    return req.session.save(() => res.redirect(backRedirect));
  }

  const finalClientSig = noClient ? null : (b.client_signature || null);
  const finalClientName = noClient ? null : (b.client_signed_name || null);
  const finalClientSignedAt = noClient ? null : (b.client_signature ? new Date().toISOString() : null);
  const totalHours = Math.round(lines.reduce((s, l) => s + l.total_hours, 0) * 100) / 100;
  const first = lines[0] || {};

  const tx = db.transaction(() => {
    const docketNumber = generateDocketNumber(db);
    const header = db.prepare(`
      INSERT INTO docket_signatures (
        allocation_id, crew_member_id, signed_by_crew_id, docket_type, docket_number, client_name, signature_data,
        client_signature, client_signed_name, client_signed_at, notes,
        start_on_site, finish_on_site, break_minutes, travel_hours, total_hours,
        no_client_on_site, no_client_reason,
        status, version, source, booking_id, shift_job_id, shift_date, updated_at
      ) VALUES (?, ?, ?, 'daily_docket', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', 1, 'worker', ?, ?, ?, datetime('now'))
    `).run(
      signerAlloc ? signerAlloc.id : null,
      worker.id, worker.id,
      docketNumber,
      b.client_name || null, b.signature_data || null,
      finalClientSig, finalClientName, finalClientSignedAt, b.notes || null,
      first.start_on_site || null, first.finish_on_site || null,
      first.break_minutes || 0, first.travel_hours || 0, totalHours,
      noClient ? 1 : 0, noClient ? (b.no_client_reason || '').trim() : '',
      shift.bookingId, shift.jobId, shift.shiftDate
    );
    const docketId = header.lastInsertRowid;
    const insLine = db.prepare(`
      INSERT INTO docket_crew (docket_id, crew_member_id, allocation_id, booking_crew_id, name_snapshot, role_snapshot,
        start_on_site, finish_on_site, break_minutes, travel_hours, total_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of lines) insLine.run(docketId, l.crew_member_id, l.allocation_id, l.booking_crew_id, l.name, l.role, l.start_on_site, l.finish_on_site, l.break_minutes, l.travel_hours, l.total_hours);
    completeShift(db, shift);
  });
  tx();

  // Audit trail for the multi-table completion (allocations + booking_crew
  // + booking -> complete) that signing just triggered.
  try {
    logActivity({
      user: null, action: 'complete', entityType: 'booking',
      entityId: shift.bookingId || null,
      details: `Shift docket signed by ${worker.full_name} — shift auto-completed (${shift.type === 'booking' ? 'booking ' + shift.bookingId : 'job ' + shift.jobId + ' ' + shift.shiftDate})`,
      ip: req.ip,
    });
  } catch (e) {}

  // Tell the crew the shift is done — and nudge them to deactivate their ROL
  // on myROL (their responsibility). Works for booking and job-based shifts.
  try {
    let crewIds = [];
    let bk = null;
    if (shift.type === 'booking' && shift.bookingId) {
      crewIds = bookingNotify.activeCrewIds(db, parseInt(shift.bookingId, 10));
      bk = db.prepare('SELECT booking_number, title, start_datetime FROM bookings WHERE id = ?').get(shift.bookingId);
    } else if (shift.jobId && shift.shiftDate) {
      crewIds = db.prepare("SELECT DISTINCT crew_member_id FROM crew_allocations WHERE job_id = ? AND allocation_date = ? AND status NOT IN ('cancelled','declined')")
        .all(shift.jobId, shift.shiftDate).map(r => r.crew_member_id);
      const job = db.prepare('SELECT job_name, job_number FROM jobs WHERE id = ?').get(shift.jobId) || {};
      bk = { booking_number: job.job_number, title: job.job_name, start_datetime: shift.shiftDate + 'T00:00:00' };
    }
    if (crewIds.length && bk) bookingNotify.notifyDocketSubmitted(crewIds, bk);
  } catch (e) { console.error('[dockets] docket-submitted notify failed:', e.message); }

  req.flash('success', 'Docket signed — shift marked complete.');
  req.session.save(() => res.redirect(backRedirect));
}

// Legacy per-person links resolve to the shift docket and redirect.
router.get('/dockets/sign/:allocationId', (req, res) => {
  const shift = resolveShift(getDb(), { allocationId: req.params.allocationId });
  if (!shift) { req.flash('error', 'Shift not found.'); return req.session.save(() => res.redirect('/w/dockets')); }
  req.session.save(() => res.redirect(shiftUrl(shift)));
});
router.post('/dockets/sign/:allocationId', (req, res) => {
  const shift = resolveShift(getDb(), { allocationId: req.params.allocationId });
  if (!shift) { req.flash('error', 'Shift not found.'); return req.session.save(() => res.redirect('/w/dockets')); }
  submitShiftDocket(req, res, shift);
});

// Job + date shift (no booking) — registered before the booking route.
router.get('/dockets/shift/job/:jobId/:date', (req, res) => {
  const shift = resolveShift(getDb(), { jobId: req.params.jobId, date: req.params.date });
  if (!shift) { req.flash('error', 'Shift not found.'); return req.session.save(() => res.redirect('/w/dockets')); }
  renderShiftSign(req, res, shift);
});
router.post('/dockets/shift/job/:jobId/:date', (req, res) => {
  const shift = resolveShift(getDb(), { jobId: req.params.jobId, date: req.params.date });
  if (!shift) { req.flash('error', 'Shift not found.'); return req.session.save(() => res.redirect('/w/dockets')); }
  submitShiftDocket(req, res, shift);
});

// Booking shift.
router.get('/dockets/shift/:bookingId', (req, res) => {
  const shift = resolveShift(getDb(), { bookingId: req.params.bookingId });
  if (!shift) { req.flash('error', 'Shift not found.'); return req.session.save(() => res.redirect('/w/dockets')); }
  renderShiftSign(req, res, shift);
});
router.post('/dockets/shift/:bookingId', (req, res) => {
  const shift = resolveShift(getDb(), { bookingId: req.params.bookingId });
  if (!shift) { req.flash('error', 'Shift not found.'); return req.session.save(() => res.redirect('/w/dockets')); }
  submitShiftDocket(req, res, shift);
});

module.exports = router;
