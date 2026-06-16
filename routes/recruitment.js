// Recruitment pipeline — single-stage candidate tracker. Replaces the old flat
// tracker (redundant Yes/No dropdowns) with one ordered stage per candidate:
// NEW → CALLED → INTERESTED → BOOKED → INDUCTED → HIRED, plus terminal
// NO_SHOW / DECLINED. What a card shows, which filters apply, and what lands on
// the induction calendar all derive from that stage. Lives under
// /induction/admin/recruitment inside the Hiring area.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { convertSeekApplicantToCrew } = require('../lib/seekApplicantConverter');
const { sydneyToday } = require('../lib/sydney');
const {
  FORWARD_STAGES, TERMINAL_STAGES, ALL_STAGES, STAGE_LABELS,
  isTerminal, isAtOrBeyond, normalizeStage, derive,
} = require('../lib/recruitmentStages');

// Weekly target band for the green/yellow/red call-target indicator.
const WEEKLY_TARGET_MIN = 5;
const WEEKLY_TARGET_MAX = 10;

// Return Mon-Sun week ranges that overlap the given month.
function weeksForMonth(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0)); // last day of month
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

// GET /induction/admin/recruitment — pipeline board, scoped to one month.
//
// Period filter: the board, summary cards, and applicant list are scoped by
// `date_applied` falling in the selected month — that's the reproducible
// "who applied this period" definition (spec §6). The Weekly Calls strip is
// deliberately NOT scoped this way: it counts every call logged in the month's
// weeks (by date_called), regardless of when the person applied, so logging a
// call always shows up against the weekly target.
router.get('/', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const rows = db.prepare(`
    SELECT * FROM seek_applicants
    WHERE date_applied BETWEEN ? AND ?
    ORDER BY COALESCE(date_applied, date_called, induction_date) ASC, id ASC
  `).all(monthStart, monthEnd);

  // Attach derived flags so the view doesn't re-implement the stage logic.
  const applicants = rows.map(a => ({ ...a, ...derive(a) }));

  // Group by stage for the board. Terminal stages collapse into one "Closed"
  // bucket rendered as a single column.
  const byStage = {};
  ALL_STAGES.forEach(s => { byStage[s] = []; });
  applicants.forEach(a => { (byStage[a.stage] = byStage[a.stage] || []).push(a); });
  const closed = TERMINAL_STAGES.reduce((acc, s) => acc.concat(byStage[s] || []), []);

  // Summary counts use the derived "at this stage or beyond" rule, so "Called"
  // counts everyone at CALLED or later — not just people literally parked in
  // the Called column.
  const stats = {
    total:      applicants.length,
    called:     applicants.filter(a => isAtOrBeyond(a.stage, 'CALLED')).length,
    interested: applicants.filter(a => isAtOrBeyond(a.stage, 'INTERESTED')).length,
    booked:     applicants.filter(a => isAtOrBeyond(a.stage, 'BOOKED')).length,
    hired:      applicants.filter(a => a.stage === 'HIRED').length,
  };

  // Weekly call counts — independent of the period scope. Count every call
  // logged (date_called) in each week's range.
  const weekDefs = weeksForMonth(year, month);
  const weeks = weekDefs.map(w => {
    const count = db.prepare(
      'SELECT COUNT(*) AS c FROM seek_applicants WHERE date_called BETWEEN ? AND ?'
    ).get(w.start, w.end).c;
    let band = 'under';
    if (count >= WEEKLY_TARGET_MIN && count <= WEEKLY_TARGET_MAX) band = 'on';
    else if (count > WEEKLY_TARGET_MAX) band = 'over';
    return { ...w, count, band };
  });

  // Mirror the calendar's reminder pump so the user gets reminders even when
  // they live on the board rather than the calendar.
  try { pumpInductionReminders(db, req.session.user, sydneyToday()); }
  catch (e) { /* notifications table may not exist on stale deploy */ }

  res.render('induction/admin/recruitment', {
    title: 'Recruitment',
    currentPage: 'induction',
    applicants,
    byStage,
    closed,
    stats,
    weeks,
    year,
    month,
    today: sydneyToday(),
    forwardStages: FORWARD_STAGES,
    terminalStages: TERMINAL_STAGES,
    stageLabels: STAGE_LABELS,
    targetMin: WEEKLY_TARGET_MIN,
    targetMax: WEEKLY_TARGET_MAX,
  });
});

// GET /induction/admin/recruitment/calendar — full-month induction calendar.
// Reads induction_date directly (the calendar is a derived view, there's no
// separate event store). Terminal-stage candidates are excluded: a No Show /
// Declined keeps its induction_date for the record but drops off the calendar.
router.get('/calendar', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year  = parseInt(req.query.year,  10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);

  const first = new Date(Date.UTC(year, month - 1, 1));
  const startDow = first.getUTCDay();
  const offsetToMon = startDow === 0 ? -6 : 1 - startDow;
  const gridStart = new Date(first); gridStart.setUTCDate(gridStart.getUTCDate() + offsetToMon);
  const gridEnd   = new Date(gridStart); gridEnd.setUTCDate(gridEnd.getUTCDate() + 41);
  const gridStartIso = iso(gridStart);
  const gridEndIso   = iso(gridEnd);

  const applicants = db.prepare(`
    SELECT id, applicant_name, phone, email, stage, notes, induction_date, induction_time
    FROM seek_applicants
    WHERE induction_date IS NOT NULL
      AND induction_date BETWEEN ? AND ?
      AND stage NOT IN ('NO_SHOW','DECLINED')
    ORDER BY induction_date ASC,
             CASE WHEN induction_time IS NULL OR induction_time = '' THEN 1 ELSE 0 END,
             induction_time ASC,
             applicant_name ASC
  `).all(gridStartIso, gridEndIso);

  const byDate = {};
  applicants.forEach(a => {
    (byDate[a.induction_date] = byDate[a.induction_date] || []).push(a);
  });

  const cells = [];
  const todayIso = sydneyToday();
  const cursor = new Date(gridStart);
  for (let i = 0; i < 42; i++) {
    const dIso = iso(cursor);
    cells.push({
      iso: dIso,
      day: cursor.getUTCDate(),
      inMonth: cursor.getUTCMonth() === (month - 1),
      isToday: dIso === todayIso,
      weekday: cursor.getUTCDay(),
      applicants: byDate[dIso] || [],
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const inFourteen = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 14));
  const upcoming = db.prepare(`
    SELECT id, applicant_name, phone, email, induction_date, induction_time, stage
    FROM seek_applicants
    WHERE induction_date IS NOT NULL
      AND induction_date BETWEEN ? AND ?
      AND stage NOT IN ('NO_SHOW','DECLINED')
    ORDER BY induction_date ASC,
             CASE WHEN induction_time IS NULL OR induction_time = '' THEN 1 ELSE 0 END,
             induction_time ASC,
             applicant_name ASC
  `).all(todayIso, iso(inFourteen));

  try { pumpInductionReminders(db, req.session.user, todayIso); }
  catch (e) { /* notifications table may not exist on stale deploy */ }

  const prevDate = new Date(Date.UTC(year, month - 2, 1));
  const nextDate = new Date(Date.UTC(year, month, 1));

  res.render('induction/admin/calendar', {
    title: 'Induction calendar',
    currentPage: 'induction',
    year, month,
    monthLabel: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    cells, upcoming,
    stageLabels: STAGE_LABELS,
    prevYear: prevDate.getUTCFullYear(), prevMonth: prevDate.getUTCMonth() + 1,
    nextYear: nextDate.getUTCFullYear(), nextMonth: nextDate.getUTCMonth() + 1,
    todayIso,
  });
});

// Reminder pump for induction notifications. Unchanged in behaviour; reads
// induction_date and skips terminal-stage candidates.
function pumpInductionReminders(db, user, todayIso) {
  if (!user) return;
  function addDays(isoStr, n) {
    const d = new Date(isoStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const today      = todayIso;
  const oneDayOut  = addDays(today, 1);
  const threeOut   = addDays(today, 3);
  const horizon    = addDays(today, 30);

  const upcoming = db.prepare(`
    SELECT id, applicant_name, phone, induction_date
    FROM seek_applicants
    WHERE induction_date IS NOT NULL
      AND induction_date BETWEEN ? AND ?
      AND stage NOT IN ('NO_SHOW','DECLINED')
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
    maybeInsert('induction_scheduled', 'Induction scheduled', a, link);
    if (a.induction_date >= oneDayOut && a.induction_date <= threeOut) {
      maybeInsert('induction_72h', 'Induction in 3 days', a, link);
    }
    if (a.induction_date === oneDayOut) {
      maybeInsert('induction_24h', 'Induction tomorrow', a, link);
    }
    if (a.induction_date === today) {
      maybeInsert('induction_today', 'Induction today', a, link);
    }
  }
}

// POST /induction/admin/recruitment — create a new applicant. Starts at NEW;
// date_applied defaults to today.
router.post('/', (req, res) => {
  const db = getDb();
  const name = (req.body.applicant_name || '').toString().trim().slice(0, 200);
  if (!name) { req.flash('error', 'Applicant name is required.'); return res.redirect(backUrl(req)); }
  db.prepare(`
    INSERT INTO seek_applicants (applicant_name, phone, email, date_applied, stage, notes, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    (req.body.phone || '').toString().trim().slice(0, 60),
    (req.body.email || '').toString().trim().slice(0, 200),
    (req.body.date_applied || '').toString().trim() || sydneyToday(),
    'NEW',
    (req.body.notes || '').toString().slice(0, 2000),
    req.session.user.id,
  );
  req.flash('success', `Added ${name}.`);
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id — partial update. Only the fields
// present in the body get touched. Handles stage moves (drag-and-drop) without
// destroying earlier dates.
router.post('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id, stage, induction_date, applicant_name, linked_crew_member_id FROM seek_applicants WHERE id = ?').get(req.params.id);
  if (!row) {
    if (wantsJson(req)) return res.status(404).json({ ok: false, error: 'Applicant not found.' });
    req.flash('error', 'Applicant not found.'); return res.redirect(backUrl(req));
  }

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

  // Detect an induction_date change before the UPDATE so we can surface a
  // notification for newly-set dates.
  let inductionDateChange = null;
  if (typeof req.body.induction_date !== 'undefined') {
    const incoming = req.body.induction_date || null;
    if (incoming && incoming !== row.induction_date) {
      inductionDateChange = { newDate: incoming, name: row.applicant_name };
    }
  }
  for (const k of ['date_applied', 'date_called', 'induction_date']) {
    if (typeof req.body[k] !== 'undefined') {
      sets.push(`${k} = ?`);
      params.push(req.body[k] || null);
    }
  }
  // induction_time: free-text HH:MM (24-hour), '' clears it.
  if (typeof req.body.induction_time !== 'undefined') {
    const t = String(req.body.induction_time || '').trim();
    const ok = t === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(t);
    if (ok) { sets.push('induction_time = ?'); params.push(t); }
  }

  // Stage move. Guard against booking a candidate with no induction date —
  // a BOOKED candidate must have a booking. The client prompts for one and
  // sends it alongside the stage, but we enforce it server-side too.
  let newStage = null;
  if (typeof req.body.stage !== 'undefined') {
    const candidate = normalizeStage(req.body.stage);
    if (ALL_STAGES.includes(candidate)) {
      const incomingDate = (typeof req.body.induction_date !== 'undefined')
        ? (req.body.induction_date || null) : row.induction_date;
      if (candidate === 'BOOKED' && !incomingDate) {
        if (wantsJson(req)) {
          return res.status(422).json({ ok: false, error: 'needs_induction_date', message: 'Set an induction date before booking.' });
        }
        req.flash('error', 'Set an induction date before booking.');
        return res.redirect(backUrl(req));
      }
      sets.push('stage = ?'); params.push(candidate);
      newStage = candidate;
    }
  }

  if (!sets.length) {
    if (wantsJson(req)) return res.json({ ok: true, noop: true });
    return res.redirect(backUrl(req));
  }
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(row.id);
  db.prepare(`UPDATE seek_applicants SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Notify the user who set a new induction date.
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

  // Auto-convert to crew_member when the candidate reaches HIRED (idempotent —
  // skips if already linked).
  let converted = null;
  const becameHired = newStage === 'HIRED' && row.stage !== 'HIRED';
  if (newStage === 'HIRED' && !row.linked_crew_member_id) {
    try {
      const applicant = db.prepare('SELECT * FROM seek_applicants WHERE id = ?').get(row.id);
      converted = convertSeekApplicantToCrew(db, applicant);
      if (!wantsJson(req)) {
        req.flash('success', `${applicant.applicant_name} added to roster as ${converted.employeeCode}.`);
      }
    } catch (e) {
      console.error('Recruitment Hired → crew conversion failed:', e);
      if (!wantsJson(req)) {
        req.flash('error', `Marked Hired but failed to add to roster: ${e.message}`);
      }
    }
  }

  if (wantsJson(req)) {
    return res.json({ ok: true, converted, becameHired, stage: newStage });
  }
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id/delete — remove a row. Deleting also
// removes the candidate from the calendar, since the calendar derives from this
// row's induction_date — no orphan events possible.
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM seek_applicants WHERE id = ?').run(req.params.id);
  if (wantsJson(req)) return res.json({ ok: true });
  req.flash('success', 'Applicant removed.');
  res.redirect(backUrl(req));
});

// GET /induction/admin/recruitment/export.csv — current month as CSV.
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
    WHERE date_applied BETWEEN ? AND ?
    ORDER BY COALESCE(date_applied, date_called, induction_date) ASC, id ASC
  `).all(monthStart, monthEnd);

  const headers = ['#','Applicant Name','Phone','Email','Date Applied','Date Called','Induction Date','Induction Time','Stage','Notes'];
  const lines = [headers.join(',')];
  rows.forEach((r, i) => {
    const cells = [
      i + 1,
      r.applicant_name, r.phone, r.email,
      r.date_applied || '', r.date_called || '',
      r.induction_date || '', r.induction_time || '',
      STAGE_LABELS[normalizeStage(r.stage)] || r.stage || '', r.notes || '',
    ].map(csvCell);
    lines.push(cells.join(','));
  });

  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(' ', '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Hiring_Pipeline_${monthLabel}.csv"`);
  res.send(lines.join('\r\n'));
});

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function wantsJson(req) {
  return (req.headers.accept || '').includes('application/json') || req.xhr;
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
