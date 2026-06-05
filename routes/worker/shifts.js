const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { geocodeQuery } = require('../../services/bookingGeocode');

// GET /w/shifts — Week-paginated shift list (Mon → Sun).
// `?week=YYYY-MM-DD` jumps to the week containing that ISO date. Without
// it we land on the current week. Always-on "Requests" (allocated /
// unconfirmed) render regardless of week so the worker can't miss
// pending acceptances by flipping forward.
router.get('/shifts', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  function isoDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  const anchor = req.query.week ? new Date(req.query.week + 'T00:00:00') : new Date();
  if (isNaN(anchor.getTime())) anchor.setTime(Date.now());
  const dow = (anchor.getDay() + 6) % 7;
  const monday = new Date(anchor); monday.setDate(monday.getDate() - dow); monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);  sunday.setDate(monday.getDate() + 6);
  const prev = new Date(monday); prev.setDate(prev.getDate() - 7);
  const next = new Date(monday); next.setDate(next.getDate() + 7);

  const weekStartIso = isoDate(monday);
  const weekEndIso   = isoDate(sunday);
  const todayIso     = isoDate(new Date());

  const VISIBLE_BOOKING_STATUSES = ['unconfirmed','confirmed','green_to_go','in_progress','completed','on_hold'];

  // Allocations for this week — LEFT JOIN both jobs and bookings so
  // booking-only allocations (post mig 142) still render full data.
  const allocRows = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number) AS job_number,
      COALESCE(j.job_name,   b.title)          AS job_name,
      COALESCE(j.client,     b.title)          AS client,
      COALESCE(j.site_address, b.site_address) AS site_address,
      COALESCE(j.suburb,     b.suburb)         AS suburb,
      j.status AS job_status,
      u.full_name AS supervisor_name,
      CASE WHEN ca.job_id IS NULL AND ca.booking_id IS NOT NULL
           THEN 'booking' ELSE 'allocation' END AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    LEFT JOIN users u    ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ?
      AND ca.allocation_date BETWEEN ? AND ?
      AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id, weekStartIso, weekEndIso);

  // Booking_crew fallback for bookings without an allocation row yet.
  let bookingRows = [];
  try {
    bookingRows = db.prepare(`
      SELECT bc.id, bc.booking_id, bc.role_on_site,
        CASE WHEN bc.status = 'assigned' THEN 'allocated' ELSE bc.status END AS status,
        b.booking_number AS job_number, b.title AS job_name, b.title AS client,
        b.site_address, b.suburb,
        DATE(b.start_datetime) AS allocation_date,
        SUBSTR(b.start_datetime, 12, 5) AS start_time,
        SUBSTR(b.end_datetime, 12, 5) AS end_time,
        '' AS supervisor_name, 'booking' AS source
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) BETWEEN ? AND ?
        AND bc.status IN ('assigned','confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
      ORDER BY b.start_datetime ASC
    `).all(worker.id, weekStartIso, weekEndIso, ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* legacy DB */ }

  const weekShifts = [...allocRows, ...bookingRows]
    .sort((a, b) => (a.allocation_date + (a.start_time || '')).localeCompare(b.allocation_date + (b.start_time || '')));

  // Always-on requests (allocated/unconfirmed) — surface no matter
  // which week the worker is viewing.
  const allRequests = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number) AS job_number,
      COALESCE(j.client,     b.title)          AS client,
      COALESCE(j.suburb,     b.suburb)         AS suburb,
      CASE WHEN ca.job_id IS NULL AND ca.booking_id IS NOT NULL
           THEN 'booking' ELSE 'allocation' END AS source
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.crew_member_id = ?
      AND ca.allocation_date >= date('now','-1 day')
      AND ca.status = 'allocated'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
  `).all(worker.id);

  // Mon-Sun strip with shift count per day.
  const countsByDate = {};
  weekShifts.forEach(s => { countsByDate[s.allocation_date] = (countsByDate[s.allocation_date] || 0) + 1; });
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    const iso = isoDate(d);
    weekDays.push({
      iso,
      letter: ['MON','TUE','WED','THU','FRI','SAT','SUN'][i],
      day: d.getDate(),
      isToday: iso === todayIso,
      isPast: iso < todayIso,
      count: countsByDate[iso] || 0,
    });
  }

  const groupedByDate = {};
  weekShifts.forEach(s => {
    if (!groupedByDate[s.allocation_date]) groupedByDate[s.allocation_date] = [];
    groupedByDate[s.allocation_date].push(s);
  });

  const startMon = monday.toLocaleDateString('en-AU', { month: 'short' });
  const endMon   = sunday.toLocaleDateString('en-AU', { month: 'short' });
  const monthLabel = (startMon === endMon ? startMon : startMon + ' / ' + endMon) + ' ' + sunday.getFullYear();

  res.render('worker/shifts', {
    title: 'My Shifts',
    currentPage: 'shifts',
    weekDays,
    weekStartIso,
    weekEndIso,
    monthLabel,
    prevWeek: isoDate(prev),
    nextWeek: isoDate(next),
    thisWeek: isoDate(new Date()),
    weekShifts,
    groupedByDate,
    requests: allRequests,
    today: todayIso,
    isThisWeek: weekStartIso <= todayIso && todayIso <= weekEndIso,
  });
});

// GET /w/shifts/:id — Shift detail
router.get('/shifts/:id', async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // LEFT JOIN bookings so booking-only allocations (no job_id) still
  // resolve, and so we can pick up the booking's lat/lng for the
  // Site Map card without a second query.
  const allocation = db.prepare(`
    SELECT ca.*,
      COALESCE(j.job_number, b.booking_number)   AS job_number,
      COALESCE(j.job_name,   b.title)            AS job_name,
      COALESCE(j.client,     b.title)            AS client,
      COALESCE(j.site_address, b.site_address)   AS site_address,
      COALESCE(j.suburb,     b.suburb)           AS suburb,
      j.status     AS job_status,
      j.notes      AS job_notes,
      j.start_date AS job_start,
      j.end_date   AS job_end,
      b.latitude   AS booking_lat,
      b.longitude  AS booking_lng,
      b.state      AS booking_state,
      b.postcode   AS booking_postcode,
      u.full_name  AS supervisor_name,
      u.email      AS supervisor_email
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id     = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    LEFT JOIN users u    ON j.ops_supervisor_id = u.id
    WHERE ca.id = ? AND ca.crew_member_id = ?
  `).get(req.params.id, worker.id);

  if (!allocation) {
    req.flash('error', 'Shift not found or access denied.');
    return res.redirect('/w/shifts');
  }

  const otherCrew = db.prepare(`
    SELECT ca.role_on_site, ca.shift_type, ca.start_time, ca.end_time, ca.status,
      cm.full_name, cm.phone, cm.role as crew_role
    FROM crew_allocations ca
    JOIN crew_members cm ON ca.crew_member_id = cm.id
    WHERE ca.job_id = ? AND ca.allocation_date = ? AND ca.crew_member_id != ? AND ca.status != 'cancelled'
    ORDER BY cm.full_name ASC
  `).all(allocation.job_id, allocation.allocation_date, worker.id);

  // Check clock status for this allocation
  const lastClock = db.prepare(`
    SELECT * FROM clock_events WHERE crew_member_id = ? AND allocation_id = ? ORDER BY event_time DESC LIMIT 1
  `).get(worker.id, allocation.id);

  // Site Map data — prefer the booking's stored coords (already geocoded
  // by services/bookingGeocode); fall back to a live geocode of the
  // address text so workers still see a pin even on alloc-only shifts.
  let siteMap = null;
  if (allocation.booking_lat != null && allocation.booking_lng != null) {
    siteMap = { lat: allocation.booking_lat, lng: allocation.booking_lng, source: 'booking' };
  } else if (allocation.site_address) {
    try {
      const parts = [allocation.site_address, allocation.suburb, allocation.booking_state, allocation.booking_postcode, 'Australia']
        .map(s => (s == null ? '' : String(s).trim()))
        .filter(Boolean);
      const geo = await geocodeQuery(parts.join(', '));
      if (geo && geo.lat != null && geo.lng != null) {
        siteMap = { lat: geo.lat, lng: geo.lng, source: geo.source || 'live' };
      }
    } catch (e) { /* best-effort; map just won't render */ }
  }
  const siteAddressFull = [allocation.site_address, allocation.suburb, allocation.booking_state, allocation.booking_postcode]
    .filter(Boolean).join(', ');

  res.render('worker/shift-detail', {
    title: allocation.job_name || allocation.job_number,
    currentPage: 'shifts',
    allocation,
    otherCrew,
    lastClock: lastClock || null,
    siteMap,
    siteAddressFull,
  });
});

// POST /w/shifts/:id/confirm — Worker confirms attendance
router.post('/shifts/:id/confirm', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(req.params.id, worker.id);
  if (!allocation) {
    req.flash('error', 'Shift not found.');
    return res.redirect('/w/shifts');
  }

  db.prepare('UPDATE crew_allocations SET status = ?, confirmed_at = CURRENT_TIMESTAMP WHERE id = ?').run('confirmed', req.params.id);
  // Keep booking_crew in sync if this alloc was sourced from a booking
  // (mirrors routes/worker/jobs.js:560).
  if (allocation.booking_id) {
    db.prepare("UPDATE booking_crew SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE booking_id = ? AND crew_member_id = ?")
      .run(allocation.booking_id, worker.id);
  }
  req.flash('success', 'Shift confirmed.');
  res.redirect('/w/shifts/' + req.params.id);
});

// POST /w/shifts/:id/decline — Worker declines a shift.
//
// A parallel decline endpoint already lives in routes/worker/jobs.js:522
// at POST /w/jobs/:id/respond (action=decline) for the job-detail flow.
// This route exists so the shift-detail view (which posts to /w/shifts/...)
// has UX parity with confirm. Status flow mirrors the existing decline:
// crew_allocations.status = 'declined' AND booking_crew sync if linked.
router.post('/shifts/:id/decline', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const allocation = db.prepare('SELECT * FROM crew_allocations WHERE id = ? AND crew_member_id = ?').get(req.params.id, worker.id);
  if (!allocation) {
    req.flash('error', 'Shift not found.');
    return res.redirect('/w/shifts');
  }
  if (allocation.status === 'declined') {
    req.flash('info', 'You already declined this shift.');
    return res.redirect('/w/shifts/' + req.params.id);
  }
  if (allocation.status === 'completed' || allocation.status === 'cancelled') {
    req.flash('error', `Shift is already ${allocation.status} and cannot be declined.`);
    return res.redirect('/w/shifts/' + req.params.id);
  }

  db.prepare("UPDATE crew_allocations SET status = 'declined' WHERE id = ?").run(req.params.id);
  if (allocation.booking_id) {
    db.prepare("UPDATE booking_crew SET status = 'declined' WHERE booking_id = ? AND crew_member_id = ?")
      .run(allocation.booking_id, worker.id);
  }
  req.flash('success', 'Shift declined.');
  res.redirect('/w/shifts/' + req.params.id);
});

module.exports = router;
