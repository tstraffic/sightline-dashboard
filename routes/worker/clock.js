const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');

// Helper: get current clock status for a worker
function getClockStatus(db, crewMemberId) {
  const today = sydneyToday();

  // Get the last clock event for today
  const lastEvent = db.prepare(`
    SELECT * FROM clock_events
    WHERE crew_member_id = ? AND date(event_time) = ?
    ORDER BY event_time DESC LIMIT 1
  `).get(crewMemberId, today);

  // Determine current status
  let status = 'clocked_out'; // default
  let clockInTime = null;
  let breakStartTime = null;
  let currentAllocationId = null;

  if (lastEvent) {
    if (lastEvent.event_type === 'clock_in' || lastEvent.event_type === 'break_end') {
      status = 'clocked_in';
    } else if (lastEvent.event_type === 'break_start') {
      status = 'on_break';
    } else if (lastEvent.event_type === 'clock_out') {
      status = 'clocked_out';
    }
    currentAllocationId = lastEvent.allocation_id;
  }

  // Get the clock-in time if currently clocked in
  if (status === 'clocked_in' || status === 'on_break') {
    const clockIn = db.prepare(`
      SELECT event_time FROM clock_events
      WHERE crew_member_id = ? AND date(event_time) = ? AND event_type = 'clock_in'
      ORDER BY event_time DESC LIMIT 1
    `).get(crewMemberId, today);
    if (clockIn) clockInTime = clockIn.event_time;
  }

  if (status === 'on_break') {
    const breakStart = db.prepare(`
      SELECT event_time FROM clock_events
      WHERE crew_member_id = ? AND date(event_time) = ? AND event_type = 'break_start'
      ORDER BY event_time DESC LIMIT 1
    `).get(crewMemberId, today);
    if (breakStart) breakStartTime = breakStart.event_time;
  }

  return { status, lastEvent, clockInTime, breakStartTime, currentAllocationId };
}

// Helper: calculate total hours worked today (excluding breaks)
function getTodayTotalHours(db, crewMemberId) {
  const today = sydneyToday();
  const events = db.prepare(`
    SELECT event_type, event_time FROM clock_events
    WHERE crew_member_id = ? AND date(event_time) = ?
    ORDER BY event_time ASC
  `).all(crewMemberId, today);

  let totalMs = 0;
  let lastClockIn = null;
  let lastBreakStart = null;
  let breakMs = 0;

  for (const evt of events) {
    const t = new Date(evt.event_time + 'Z').getTime();
    if (evt.event_type === 'clock_in') {
      lastClockIn = t;
      breakMs = 0;
    } else if (evt.event_type === 'break_start') {
      lastBreakStart = t;
    } else if (evt.event_type === 'break_end' && lastBreakStart) {
      breakMs += (t - lastBreakStart);
      lastBreakStart = null;
    } else if (evt.event_type === 'clock_out' && lastClockIn) {
      let workMs = t - lastClockIn - breakMs;
      totalMs += Math.max(0, workMs);
      lastClockIn = null;
      breakMs = 0;
    }
  }

  // If still clocked in, add time from last clock_in to now
  if (lastClockIn) {
    const now = Date.now();
    let currentBreak = 0;
    if (lastBreakStart) {
      currentBreak = now - lastBreakStart;
    }
    totalMs += Math.max(0, now - lastClockIn - breakMs - currentBreak);
  }

  return totalMs;
}

// GET /w/clock — Retired. T&S crews don't run a clock in/out flow; the
// pre-start toolbox + the docket are the source of truth for attendance
// and hours. The page used to live here; we redirect to /w/jobs so any
// older link or PWA shortcut still lands somewhere useful.
router.get('/clock', (req, res) => {
  return res.redirect(301, '/w/jobs');
});

// (Original handler retained below for reference — never runs.)
router.get('/_clock_legacy', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = sydneyToday();

  const clockStatus = getClockStatus(db, worker.id);

  // Get today's allocated shifts
  const todaysShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client, j.site_address, j.suburb,
      u.full_name as supervisor_name
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN users u ON j.ops_supervisor_id = u.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.start_time ASC
  `).all(worker.id, today);

  // Get today's clock events
  const todayEvents = db.prepare(`
    SELECT * FROM clock_events
    WHERE crew_member_id = ? AND date(event_time) = ?
    ORDER BY event_time ASC
  `).all(worker.id, today);

  const totalMs = getTodayTotalHours(db, worker.id);
  const totalHours = Math.floor(totalMs / 3600000);
  const totalMinutes = Math.floor((totalMs % 3600000) / 60000);

  res.render('worker/clock', {
    title: 'Clock',
    currentPage: 'clock',
    clockStatus,
    todaysShifts,
    todayEvents,
    totalHours,
    totalMinutes,
    totalMs,
    today,
  });
});

// POST /w/clock/in — Clock in
router.post('/clock/in', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { latitude, longitude, accuracy, allocation_id, notes } = req.body;

  // Check not already clocked in
  const current = getClockStatus(db, worker.id);
  if (current.status === 'clocked_in' || current.status === 'on_break') {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: 'Already clocked in' });
    }
    req.flash('error', 'You are already clocked in.');
    return req.session.save(() => res.redirect('/w/clock'));
  }

  const allocId = allocation_id ? parseInt(allocation_id) : null;

  db.prepare(`
    INSERT INTO clock_events (crew_member_id, allocation_id, event_type, latitude, longitude, accuracy, notes)
    VALUES (?, ?, 'clock_in', ?, ?, ?, ?)
  `).run(worker.id, allocId, latitude || null, longitude || null, accuracy || null, notes || null);

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ success: true, message: 'Clocked in successfully' });
  }
  req.flash('success', 'Clocked in successfully!');
  req.session.save(() => res.redirect('/w/clock'));
});

// POST /w/clock/out — Clock out
router.post('/clock/out', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { latitude, longitude, accuracy, notes } = req.body;

  const current = getClockStatus(db, worker.id);
  if (current.status === 'clocked_out') {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: 'Not clocked in' });
    }
    req.flash('error', 'You are not clocked in.');
    return req.session.save(() => res.redirect('/w/clock'));
  }

  // If on break, end break first
  if (current.status === 'on_break') {
    db.prepare(`
      INSERT INTO clock_events (crew_member_id, allocation_id, event_type, latitude, longitude, accuracy)
      VALUES (?, ?, 'break_end', ?, ?, ?)
    `).run(worker.id, current.currentAllocationId, latitude || null, longitude || null, accuracy || null);
  }

  db.prepare(`
    INSERT INTO clock_events (crew_member_id, allocation_id, event_type, latitude, longitude, accuracy, notes)
    VALUES (?, ?, 'clock_out', ?, ?, ?, ?)
  `).run(worker.id, current.currentAllocationId, latitude || null, longitude || null, accuracy || null, notes || null);

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ success: true, message: 'Clocked out successfully' });
  }
  req.flash('success', 'Clocked out successfully!');
  req.session.save(() => res.redirect('/w/clock'));
});

// POST /w/clock/break — Start or end break
router.post('/clock/break', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { latitude, longitude, accuracy } = req.body;

  const current = getClockStatus(db, worker.id);

  if (current.status === 'clocked_out') {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: 'Not clocked in' });
    }
    req.flash('error', 'You must be clocked in to take a break.');
    return req.session.save(() => res.redirect('/w/clock'));
  }

  const eventType = current.status === 'on_break' ? 'break_end' : 'break_start';
  const message = current.status === 'on_break' ? 'Break ended' : 'Break started';

  db.prepare(`
    INSERT INTO clock_events (crew_member_id, allocation_id, event_type, latitude, longitude, accuracy)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(worker.id, current.currentAllocationId, eventType, latitude || null, longitude || null, accuracy || null);

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ success: true, message });
  }
  req.flash('success', message);
  req.session.save(() => res.redirect('/w/clock'));
});

// GET /w/clock/history — Recent clock events (last 7 days)
router.get('/clock/history', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  const sevenDaysAgoStr = sydneyToday(new Date(Date.now() - 7 * 86400000));

  const events = db.prepare(`
    SELECT ce.*, ca.allocation_date, j.job_number, j.job_name, j.client
    FROM clock_events ce
    LEFT JOIN crew_allocations ca ON ce.allocation_id = ca.id
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ce.crew_member_id = ? AND date(ce.event_time) >= ?
    ORDER BY ce.event_time DESC
  `).all(worker.id, sevenDaysAgoStr);

  // Group by date
  const groupedByDate = {};
  events.forEach(e => {
    const date = e.event_time.split('T')[0].split(' ')[0];
    if (!groupedByDate[date]) groupedByDate[date] = [];
    groupedByDate[date].push(e);
  });

  // Calculate daily totals
  const dailyTotals = {};
  for (const [date, dayEvents] of Object.entries(groupedByDate)) {
    let totalMs = 0;
    let lastClockIn = null;
    let breakMs = 0;
    let lastBreakStart = null;

    // Sort ascending for calculation
    const sorted = [...dayEvents].sort((a, b) => a.event_time.localeCompare(b.event_time));
    for (const evt of sorted) {
      const t = new Date(evt.event_time + (evt.event_time.includes('Z') ? '' : 'Z')).getTime();
      if (evt.event_type === 'clock_in') {
        lastClockIn = t;
        breakMs = 0;
      } else if (evt.event_type === 'break_start') {
        lastBreakStart = t;
      } else if (evt.event_type === 'break_end' && lastBreakStart) {
        breakMs += (t - lastBreakStart);
        lastBreakStart = null;
      } else if (evt.event_type === 'clock_out' && lastClockIn) {
        totalMs += Math.max(0, t - lastClockIn - breakMs);
        lastClockIn = null;
        breakMs = 0;
      }
    }
    const hours = Math.floor(totalMs / 3600000);
    const mins = Math.floor((totalMs % 3600000) / 60000);
    dailyTotals[date] = { hours, mins, totalMs };
  }

  res.render('worker/clock-history', {
    title: 'Clock History',
    currentPage: 'clock',
    groupedByDate,
    dailyTotals,
  });
});

module.exports = router;
