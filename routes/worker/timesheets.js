const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');

// GET /w/timesheets — My Timesheets
router.get('/timesheets', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Get recent timesheets for this worker
  const timesheets = db.prepare(`
    SELECT t.*, j.job_number, j.job_name, j.client
    FROM timesheets t
    LEFT JOIN jobs j ON t.job_id = j.id
    WHERE t.crew_member_id = ?
    ORDER BY t.work_date DESC
    LIMIT 50
  `).all(worker.id);

  // Calculate stats — anchor on Sydney calendar so the "this week" total
  // doesn't snap to the wrong week every Sydney evening (Railway = UTC).
  const thisWeekStart = new Date(sydneyToday() + 'T00:00:00');
  thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay() + 1);
  const thisWeekStr = sydneyToday(thisWeekStart);

  const weekHours = timesheets
    .filter(t => t.work_date >= thisWeekStr)
    .reduce((sum, t) => sum + (t.total_hours || 0), 0);

  const pendingCount = timesheets.filter(t => !t.approved).length;
  const approvedCount = timesheets.filter(t => t.approved).length;

  res.render('worker/timesheets', {
    title: 'My Timesheets',
    currentPage: 'more',
    timesheets,
    weekHours: weekHours.toFixed(1),
    pendingCount,
    approvedCount,
  });
});

// GET /w/timesheets/new — Submit timesheet form
router.get('/timesheets/new', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const today = sydneyToday();

  // Get recent allocations to pre-populate
  const recentAllocations = db.prepare(`
    SELECT ca.*, j.job_number, j.job_name, j.client
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date <= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date DESC LIMIT 10
  `).all(worker.id, today);

  // Get clock events for today to auto-fill
  const todayClocks = db.prepare(`
    SELECT * FROM clock_events WHERE crew_member_id = ? AND DATE(event_time) = ? ORDER BY event_time ASC
  `).all(worker.id, today);

  res.render('worker/timesheet-form', {
    title: 'Submit Timesheet',
    currentPage: 'more',
    recentAllocations,
    todayClocks,
    today,
  });
});

// POST /w/timesheets — Submit timesheet
router.post('/timesheets', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { job_id, work_date, start_time, end_time, break_minutes, shift_type, role_on_site, notes } = req.body;

  if (!job_id || !work_date || !start_time || !end_time) {
    req.flash('error', 'Please fill in all required fields.');
    return req.session.save(() => res.redirect('/w/timesheets/new'));
  }

  // Calculate total hours
  const start = new Date(`${work_date}T${start_time}`);
  const end = new Date(`${work_date}T${end_time}`);
  let totalMinutes = (end - start) / 60000;
  if (totalMinutes < 0) totalMinutes += 24 * 60; // overnight shift
  totalMinutes -= parseInt(break_minutes || 0);
  const totalHours = Math.round(totalMinutes / 60 * 100) / 100;

  db.prepare(`
    INSERT INTO timesheets (job_id, crew_member_id, work_date, start_time, end_time, break_minutes, total_hours, shift_type, role_on_site, notes, submitted_by_id, self_submitted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(job_id, worker.id, work_date, start_time, end_time, break_minutes || 0, totalHours, shift_type || 'day', role_on_site || null, notes || null, worker.id);

  req.flash('success', 'Timesheet submitted successfully.');
  req.session.save(() => res.redirect('/w/timesheets'));
});

module.exports = router;
