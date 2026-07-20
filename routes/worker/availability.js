const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { sydneyToday } = require('../../lib/sydney');

// GET /w/availability — Show availability calendar/form
router.get('/availability', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Get next 14 days, anchored on Sydney calendar so the strip starts
  // from "today in Sydney", not "today in UTC".
  const days = [];
  const today = new Date(sydneyToday() + 'T00:00:00');

  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const dateStr = sydneyToday(d);
    days.push({
      date: dateStr,
      dayName: d.toLocaleDateString('en-AU', { weekday: 'short' }),
      dayNum: d.getDate(),
      monthName: d.toLocaleDateString('en-AU', { month: 'short' }),
      isToday: i === 0,
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
    });
  }

  // Get existing availability records for these dates
  const startDate = days[0].date;
  const endDate = days[days.length - 1].date;

  const records = db.prepare(`
    SELECT * FROM worker_availability
    WHERE crew_member_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(worker.id, startDate, endDate);

  // Map records by date
  const availabilityMap = {};
  records.forEach(r => {
    availabilityMap[r.date] = r;
  });

  // Get allocations for these dates (to show scheduled shifts)
  const allocations = db.prepare(`
    SELECT ca.allocation_date, ca.start_time, ca.end_time, j.job_number, j.client
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date >= ? AND ca.allocation_date <= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC
  `).all(worker.id, startDate, endDate);

  const allocationMap = {};
  allocations.forEach(a => {
    if (!allocationMap[a.allocation_date]) allocationMap[a.allocation_date] = [];
    allocationMap[a.allocation_date].push(a);
  });

  res.render('worker/availability', {
    title: 'Availability',
    currentPage: 'clock',
    days,
    availabilityMap,
    allocationMap,
  });
});

// POST /w/availability — Submit/update availability for a date
router.post('/availability', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { date, status, start_time, end_time, notes } = req.body;

  // Validate date
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: 'Invalid date' });
    }
    req.flash('error', 'Invalid date.');
    return req.session.save(() => res.redirect('/w/availability'));
  }

  // Validate status
  if (!['available', 'unavailable', 'partial'].includes(status)) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    req.flash('error', 'Invalid status.');
    return req.session.save(() => res.redirect('/w/availability'));
  }

  // Don't allow setting availability for past dates
  const today = sydneyToday();
  if (date < today) {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(400).json({ error: 'Cannot set availability for past dates' });
    }
    req.flash('error', 'Cannot set availability for past dates.');
    return req.session.save(() => res.redirect('/w/availability'));
  }

  // Upsert: insert or update on conflict
  db.prepare(`
    INSERT INTO worker_availability (crew_member_id, date, status, start_time, end_time, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(crew_member_id, date) DO UPDATE SET
      status = excluded.status,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(
    worker.id,
    date,
    status,
    status === 'partial' ? (start_time || null) : null,
    status === 'partial' ? (end_time || null) : null,
    notes || null
  );

  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return res.json({ success: true, message: 'Availability updated' });
  }
  req.flash('success', 'Availability updated.');
  req.session.save(() => res.redirect('/w/availability'));
});

// DELETE /w/availability/:id — Remove availability entry
router.delete('/availability/:id', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;

  // Ensure record belongs to this worker
  const record = db.prepare('SELECT * FROM worker_availability WHERE id = ? AND crew_member_id = ?')
    .get(req.params.id, worker.id);

  if (!record) {
    return res.status(404).json({ error: 'Record not found' });
  }

  db.prepare('DELETE FROM worker_availability WHERE id = ?').run(req.params.id);
  return res.json({ success: true, message: 'Availability removed' });
});

// POST /w/availability/delete — Remove availability entry (form fallback)
router.post('/availability/delete', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { id } = req.body;

  const record = db.prepare('SELECT * FROM worker_availability WHERE id = ? AND crew_member_id = ?')
    .get(id, worker.id);

  if (!record) {
    req.flash('error', 'Record not found.');
    return req.session.save(() => res.redirect('/w/availability'));
  }

  db.prepare('DELETE FROM worker_availability WHERE id = ?').run(id);
  req.flash('success', 'Availability removed.');
  req.session.save(() => res.redirect('/w/availability'));
});

// GET /w/availability/api — JSON API for calendar data
router.get('/availability/api', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required' });
  }

  const records = db.prepare(`
    SELECT * FROM worker_availability
    WHERE crew_member_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `).all(worker.id, start, end);

  res.json({ success: true, data: records });
});


module.exports = router;
