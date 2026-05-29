// Seek applicant tracker — replaces the monthly Excel tracker admin used to
// keep for inbound Seek applicants. Lives under /induction/admin/recruitment
// so it sits inside the existing Registry form area as another tab.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { convertSeekApplicantToCrew } = require('../lib/seekApplicantConverter');
const { sydneyToday } = require('../lib/sydney');

// Status / dropdown vocab — kept in code (not DB) so the UI never gets out of
// sync with the tracker's expected values.
const STATUSES = ['New', 'Contacted', 'Induction Scheduled', 'Inducted', 'Hired', 'Not Suitable', 'Withdrew', 'No Show'];
const CALLED_OPTS = ['', 'Yes', 'No'];
const INTERESTED_OPTS = ['', 'Yes', 'No', 'Maybe', 'No Answer', 'Callback'];
const BOOKED_OPTS = ['', 'Yes', 'No'];

// Weekly target band for the green/yellow/red call-target indicator.
const WEEKLY_TARGET_MIN = 5;
const WEEKLY_TARGET_MAX = 10;

// Return Mon-Sun week ranges that overlap the given month. Always returns at
// least 4 ranges, up to 6 depending on how the month falls. Each range is
// { label, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } (inclusive end).
function weeksForMonth(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0)); // last day of month
  // Move to the Monday on/before the 1st.
  const startDow = first.getUTCDay(); // 0=Sun, 1=Mon
  const offsetToMon = startDow === 0 ? -6 : 1 - startDow;
  const cursor = new Date(first);
  cursor.setUTCDate(cursor.getUTCDate() + offsetToMon);

  const out = [];
  let n = 1;
  while (cursor <= last) {
    const ws = new Date(cursor);
    const we = new Date(cursor); we.setUTCDate(we.getUTCDate() + 6);
    out.push({
      n,
      label: `Wk ${n}`,
      range: `${shortDate(ws)} – ${shortDate(we)}`,
      start: iso(ws),
      end: iso(we),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    n++;
    if (n > 6) break;
  }
  return out;
}
function iso(d) { return d.toISOString().slice(0, 10); }
function shortDate(d) {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// GET /induction/admin/recruitment — main page, filtered to one month
router.get('/', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  // last day of the month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Pull every applicant whose date_applied OR date_called OR induction_date
  // falls in the month. That matches how the spreadsheet treats a month — if
  // any activity happened that month, the person shows up.
  const applicants = db.prepare(`
    SELECT * FROM seek_applicants
    WHERE (date_applied   BETWEEN ? AND ?)
       OR (date_called    BETWEEN ? AND ?)
       OR (induction_date BETWEEN ? AND ?)
    ORDER BY COALESCE(date_applied, date_called, induction_date) ASC, id ASC
  `).all(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

  // Monthly summary
  const stats = {
    total:      applicants.length,
    called:     applicants.filter(a => (a.called || '').toLowerCase() === 'yes').length,
    interested: applicants.filter(a => (a.interested || '').toLowerCase() === 'yes').length,
    booked:     applicants.filter(a => (a.induction_booked || '').toLowerCase() === 'yes').length,
    hired:      applicants.filter(a => (a.status || '').toLowerCase() === 'hired').length,
  };

  // Weekly call counts — count by date_called falling in each week.
  const weeks = weeksForMonth(year, month).map(w => {
    const count = applicants.filter(a => a.date_called && a.date_called >= w.start && a.date_called <= w.end).length;
    let band = 'under'; // under = <5, on = 5-10, over = >10
    if (count >= WEEKLY_TARGET_MIN && count <= WEEKLY_TARGET_MAX) band = 'on';
    else if (count > WEEKLY_TARGET_MAX) band = 'over';
    return { ...w, count, band };
  });

  // Mirror the calendar's reminder pump so the user gets 72h/24h/today
  // notifications + backfill for existing recruits even when they spend
  // most of their time on the recruitment list rather than the calendar.
  try { pumpInductionReminders(db, req.session.user, sydneyToday()); }
  catch (e) { /* notifications table may not exist on stale deploy */ }

  res.render('induction/admin/recruitment', {
    title: 'Recruitment',
    currentPage: 'induction',
    applicants,
    stats,
    weeks,
    year,
    month,
    statuses: STATUSES,
    calledOpts: CALLED_OPTS,
    interestedOpts: INTERESTED_OPTS,
    bookedOpts: BOOKED_OPTS,
    targetMin: WEEKLY_TARGET_MIN,
    targetMax: WEEKLY_TARGET_MAX,
  });
});

// GET /induction/admin/recruitment/calendar — full-month induction calendar. Pulls
// every applicant whose induction_date sits in a windowed range around
// the chosen month so the leading/trailing week padding cells still
// surface their bookings (the grid renders Mon-Sun rows that overflow
// either side of the actual month).
router.get('/calendar', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year  = parseInt(req.query.year,  10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

  // Calendar grid: anchor to the Monday on/before the 1st of the month
  // and run forward 6 weeks (42 cells) so the layout is always a clean
  // rectangle. Some months span 5 visible weeks; we keep 6 for stable
  // height — empty trailing cells get a muted style.
  const first = new Date(Date.UTC(year, month - 1, 1));
  const startDow = first.getUTCDay();           // 0 = Sun
  const offsetToMon = startDow === 0 ? -6 : 1 - startDow;
  const gridStart = new Date(first); gridStart.setUTCDate(gridStart.getUTCDate() + offsetToMon);
  const gridEnd   = new Date(gridStart); gridEnd.setUTCDate(gridEnd.getUTCDate() + 41);
  const gridStartIso = iso(gridStart);
  const gridEndIso   = iso(gridEnd);

  const applicants = db.prepare(`
    SELECT id, applicant_name, phone, email, status, notes, induction_date,
           called, interested, induction_booked
    FROM seek_applicants
    WHERE induction_date IS NOT NULL
      AND induction_date BETWEEN ? AND ?
    ORDER BY induction_date ASC, applicant_name ASC
  `).all(gridStartIso, gridEndIso);

  // Bucket applicants by date so the view doesn't have to filter the
  // full list per cell (cheap, but pre-grouping keeps the EJS clean).
  const byDate = {};
  applicants.forEach(a => {
    (byDate[a.induction_date] = byDate[a.induction_date] || []).push(a);
  });

  // Build the 6x7 grid of day cells.
  const cells = [];
  // Today in Sydney — induction_date is a local-DATE column, so day
  // boundaries should follow operations time, not the server's UTC.
  const todayIso = sydneyToday();
  const cursor = new Date(gridStart);
  for (let i = 0; i < 42; i++) {
    const dIso = iso(cursor);
    cells.push({
      iso: dIso,
      day: cursor.getUTCDate(),
      inMonth: cursor.getUTCMonth() === (month - 1),
      isToday: dIso === todayIso,
      weekday: cursor.getUTCDay(),  // 0=Sun … 6=Sat
      applicants: byDate[dIso] || [],
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  // Upcoming-this-week sidebar — next 14 days starting today, only
  // dates that actually have inductions.
  const inFourteen = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14));
  const upcoming = db.prepare(`
    SELECT id, applicant_name, phone, email, induction_date, status
    FROM seek_applicants
    WHERE induction_date IS NOT NULL
      AND induction_date BETWEEN ? AND ?
    ORDER BY induction_date ASC, applicant_name ASC
  `).all(todayIso, iso(inFourteen));

  // Page-load reminder pump — idempotently emits 72h / 24h / today
  // notifications for the user, plus a backfill "scheduled" entry for
  // any upcoming induction they haven't been notified about yet (so
  // recruits already on the books before the calendar shipped still
  // appear in their bell).
  try { pumpInductionReminders(db, req.session.user, todayIso); }
  catch (e) { /* notifications table may not exist on stale deploy */ }

  // Prev / next month for the nav arrows.
  const prevDate = new Date(Date.UTC(year, month - 2, 1));
  const nextDate = new Date(Date.UTC(year, month, 1));

  res.render('induction/admin/calendar', {
    title: 'Induction calendar',
    currentPage: 'induction',
    year, month,
    monthLabel: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    cells, upcoming,
    prevYear: prevDate.getUTCFullYear(), prevMonth: prevDate.getUTCMonth() + 1,
    nextYear: nextDate.getUTCFullYear(), nextMonth: nextDate.getUTCMonth() + 1,
    todayIso,
  });
});

// Reminder pump for induction notifications. Runs on every visit to
// the recruitment list and calendar pages and inserts the
// notifications below, idempotently per (user, applicant, type):
//
//   induction_scheduled — backfill once for any upcoming induction
//   induction_72h       — fires when the induction is 3+ days away
//                         and the deadline is within sight (1-3 days)
//   induction_24h       — fires the day before the induction
//   induction_today     — fires the day of the induction
//
// Idempotency is enforced by the row's `link` field, which we build
// to include the applicant id and the reminder kind. The notifications
// table has no native unique key for our purposes, so we look up the
// existing row before inserting.
//
// No cron yet — same-day / next-day reminders depend on the user
// opening a recruitment page that day, which is the typical workflow.
// When a job runner lands later this same function can move to a
// scheduled tick.
function pumpInductionReminders(db, user, todayIso) {
  if (!user) return;
  // Date helpers in plain UTC — induction_date is a DATE-only column,
  // so day-grain math is correct.
  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const today      = todayIso;
  const oneDayOut  = addDays(today, 1);
  const threeOut   = addDays(today, 3);
  const horizon    = addDays(today, 30);

  // Every upcoming induction within the next 30 days. Past dates are
  // skipped — no point pinging the user about something that already
  // happened.
  const upcoming = db.prepare(`
    SELECT id, applicant_name, phone, induction_date
    FROM seek_applicants
    WHERE induction_date IS NOT NULL
      AND induction_date BETWEEN ? AND ?
  `).all(today, horizon);
  if (!upcoming.length) return;

  const exists = db.prepare(
    'SELECT 1 FROM notifications WHERE user_id = ? AND type = ? AND link = ? LIMIT 1'
  );
  const insert = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link)
    VALUES (?, ?, ?, ?, ?)
  `);

  function calLink(dIso, applicantId) {
    return `/induction/admin/recruitment/calendar?year=${dIso.slice(0,4)}&month=${parseInt(dIso.slice(5,7),10)}&id=${applicantId}`;
  }
  function niceDate(dIso) {
    return new Date(dIso + 'T00:00:00Z').toLocaleDateString('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
    });
  }
  function maybeInsert(type, title, applicant, link) {
    if (exists.get(user.id, type, link)) return;
    insert.run(
      user.id, type, title,
      `${applicant.applicant_name}${applicant.phone ? ' · ' + applicant.phone : ''} — ${niceDate(applicant.induction_date)}`,
      link
    );
  }

  for (const a of upcoming) {
    const link = calLink(a.induction_date, a.id);
    // Backfill once-per-applicant "scheduled" notification so existing
    // recruits that pre-date the calendar tab still appear in the bell.
    maybeInsert('induction_scheduled', 'Induction scheduled', a, link);

    // 72-hour-out: induction lands within the next 3 days (1..3 inclusive).
    if (a.induction_date >= oneDayOut && a.induction_date <= threeOut) {
      maybeInsert('induction_72h', 'Induction in 3 days', a, link);
    }
    // 24-hour-out: induction is exactly tomorrow.
    if (a.induction_date === oneDayOut) {
      maybeInsert('induction_24h', 'Induction tomorrow', a, link);
    }
    // Day-of.
    if (a.induction_date === today) {
      maybeInsert('induction_today', 'Induction today', a, link);
    }
  }
}

// POST /induction/admin/recruitment — create a new applicant.
router.post('/', (req, res) => {
  const db = getDb();
  const name = (req.body.applicant_name || '').toString().trim().slice(0, 200);
  if (!name) { req.flash('error', 'Applicant name is required.'); return res.redirect(backUrl(req)); }
  db.prepare(`
    INSERT INTO seek_applicants (applicant_name, phone, email, date_applied, status, notes, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    (req.body.phone || '').toString().trim().slice(0, 60),
    (req.body.email || '').toString().trim().slice(0, 200),
    (req.body.date_applied || null) || null,
    STATUSES.includes(req.body.status) ? req.body.status : 'New',
    (req.body.notes || '').toString().slice(0, 2000),
    req.session.user.id,
  );
  req.flash('success', `Added ${name}.`);
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id — partial update. Only the fields
// actually present in the body get touched, so the row-inline status drops
// don't blow away the name/phone/notes.
router.post('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id, status, linked_crew_member_id FROM seek_applicants WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Applicant not found.'); return res.redirect(backUrl(req)); }

  const sets = [];
  const params = [];
  const allowText = {
    applicant_name: { max: 200 },
    phone: { max: 60 },
    email: { max: 200 },
    notes: { max: 2000 },
  };
  for (const [k, opts] of Object.entries(allowText)) {
    if (typeof req.body[k] !== 'undefined') {
      sets.push(`${k} = ?`);
      params.push((req.body[k] || '').toString().slice(0, opts.max));
    }
  }
  const allowDate = ['date_applied', 'date_called', 'induction_date'];
  // Detect a change to induction_date so we can surface a notification.
  // Done before the UPDATE so we can compare incoming vs current value.
  let inductionDateChange = null;
  if (typeof req.body.induction_date !== 'undefined') {
    const incoming = req.body.induction_date || null;
    const current = db.prepare('SELECT induction_date, applicant_name FROM seek_applicants WHERE id = ?').get(row.id);
    if (current && incoming && incoming !== current.induction_date) {
      inductionDateChange = { newDate: incoming, name: current.applicant_name };
    }
  }
  for (const k of allowDate) {
    if (typeof req.body[k] !== 'undefined') {
      sets.push(`${k} = ?`);
      params.push(req.body[k] || null);
    }
  }
  // induction_time is a free-text HH:MM (24-hour); validate loosely so we don't
  // wipe a saved time on a partial submit. Stored as '' when cleared.
  if (typeof req.body.induction_time !== 'undefined') {
    const t = String(req.body.induction_time || '').trim();
    const ok = t === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
    if (ok) { sets.push('induction_time = ?'); params.push(t); }
  }
  if (typeof req.body.called !== 'undefined' && CALLED_OPTS.includes(req.body.called)) {
    sets.push('called = ?'); params.push(req.body.called);
  }
  if (typeof req.body.interested !== 'undefined' && INTERESTED_OPTS.includes(req.body.interested)) {
    sets.push('interested = ?'); params.push(req.body.interested);
  }
  if (typeof req.body.induction_booked !== 'undefined' && BOOKED_OPTS.includes(req.body.induction_booked)) {
    sets.push('induction_booked = ?'); params.push(req.body.induction_booked);
  }
  if (typeof req.body.status !== 'undefined' && STATUSES.includes(req.body.status)) {
    sets.push('status = ?'); params.push(req.body.status);
  }

  if (!sets.length) return res.redirect(backUrl(req));
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(row.id);
  db.prepare(`UPDATE seek_applicants SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Drop an in-app notification for the user who set the induction date
  // so it appears in their bell + on the calendar. Wrapped in try/catch
  // because the notifications table may be missing on a stale deploy.
  if (inductionDateChange && req.session && req.session.user) {
    try {
      const isoDate = inductionDateChange.newDate;
      const niceDate = new Date(isoDate + 'T00:00:00Z').toLocaleDateString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
      });
      const link = `/induction/admin/recruitment/calendar?year=${isoDate.slice(0,4)}&month=${parseInt(isoDate.slice(5,7),10)}&id=${row.id}`;
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, message, link)
        VALUES (?, 'induction_scheduled', ?, ?, ?)
      `).run(
        req.session.user.id,
        'Induction scheduled',
        `${inductionDateChange.name} — ${niceDate}`,
        link
      );
    } catch (e) { /* table missing — non-fatal */ }
  }

  // Auto-convert to crew_member on transition to "Hired" (idempotent — skips
  // if already linked). Without this, Hired applicants never appear on the
  // roster, which is the bug we're fixing.
  let converted = null;
  const newStatus = (req.body.status || '').toString();
  const becameHired = newStatus === 'Hired' && (row.status || '').toLowerCase() !== 'hired';
  if ((newStatus === 'Hired') && !row.linked_crew_member_id) {
    try {
      const applicant = db.prepare('SELECT * FROM seek_applicants WHERE id = ?').get(row.id);
      converted = convertSeekApplicantToCrew(db, applicant);
      if (!req.xhr) {
        req.flash('success', `${applicant.applicant_name} added to roster as ${converted.employeeCode}.`);
      }
    } catch (e) {
      console.error('Recruitment Hired → crew conversion failed:', e);
      if (!req.xhr) {
        req.flash('error', `Marked Hired but failed to add to roster: ${e.message}`);
      }
    }
  }

  // AJAX inline-edit returns JSON so the page doesn't have to reload on every
  // dropdown change.
  if ((req.headers.accept || '').includes('application/json') || req.xhr) {
    return res.json({ ok: true, converted, becameHired });
  }
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id/delete — remove a row.
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM seek_applicants WHERE id = ?').run(req.params.id);
  req.flash('success', 'Applicant removed.');
  res.redirect(backUrl(req));
});

// GET /induction/admin/recruitment/export.csv — backup the current month as
// a CSV that opens straight in Excel. Keeps the user's "I want my spreadsheet"
// muscle memory working.
router.get('/export.csv', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const rows = db.prepare(`
    SELECT * FROM seek_applicants
    WHERE (date_applied BETWEEN ? AND ?)
       OR (date_called  BETWEEN ? AND ?)
       OR (induction_date BETWEEN ? AND ?)
    ORDER BY COALESCE(date_applied, date_called, induction_date) ASC, id ASC
  `).all(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

  const headers = ['#','Applicant Name','Phone','Email','Date Applied','Date Called','Called?','Interested?','Induction Booked?','Induction Date','Induction Time','Status','Notes'];
  const lines = [headers.join(',')];
  rows.forEach((r, i) => {
    const cells = [
      i + 1,
      r.applicant_name, r.phone, r.email,
      r.date_applied || '', r.date_called || '', r.called || '',
      r.interested || '', r.induction_booked || '',
      r.induction_date || '', r.induction_time || '', r.status || '', r.notes || '',
    ].map(csvCell);
    lines.push(cells.join(','));
  });

  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(' ', '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Seek_Applicants_${monthLabel}.csv"`);
  res.send(lines.join('\r\n'));
});

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function backUrl(req) {
  const y = req.body.year || req.query.year;
  const m = req.body.month || req.query.month;
  const qp = [];
  if (y) qp.push('year=' + encodeURIComponent(y));
  if (m) qp.push('month=' + encodeURIComponent(m));
  return '/induction/admin/recruitment' + (qp.length ? '?' + qp.join('&') : '');
}

module.exports = router;
