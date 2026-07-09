// Recruitment pipeline — single-stage candidate tracker. Replaces the old flat
// tracker (redundant Yes/No dropdowns) with one ordered stage per candidate:
// NEW → CALLED → INTERESTED → BOOKED → INDUCTED → HIRED, plus terminal
// NO_SHOW / DECLINED. What a card shows, which filters apply, and what lands on
// the induction calendar all derive from that stage. Lives under
// /induction/admin/recruitment inside the Hiring area.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { sydneyToday } = require('../lib/sydney');
const { sendEmail } = require('../services/email');
const { inductionConfirmationEmail } = require('../services/emailTemplates');

// Public induction form the confirmation email points applicants to.
const INDUCTION_FORM_URL = (process.env.APP_BASE_URL || 'https://tstc.up.railway.app').replace(/\/$/, '') + '/induction';

// Send (or re-send) the induction booking confirmation to an applicant. Builds
// the "on <date> at <time>" clause from the applicant's stored induction
// date/time, sends via the shared mailer, and stamps induction_email_sent_at
// on success. Returns one of: 'sent' | 'failed' | 'no_email' | 'no_date'.
// Used by both the booking flow and the manual re-send button.
async function sendInductionConfirmation(db, applicant, replyTo) {
  if (!applicant.email || !/@/.test(applicant.email)) return 'no_email';
  if (!applicant.induction_date) return 'no_date';
  const dateStr = new Date(applicant.induction_date + 'T00:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  let timeStr = '';
  const m = String(applicant.induction_time || '').match(/^(\d{1,2}):(\d{2})/);
  if (m) {
    let h = parseInt(m[1], 10); const min = m[2];
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12; if (h === 0) h = 12;
    timeStr = h + ':' + min + ' ' + ampm;
  }
  const whenText = 'on ' + dateStr + (timeStr ? ' at ' + timeStr : '');
  try {
    const result = await sendEmail(applicant.email, 'Induction Confirmation — T&S Traffic Control',
      inductionConfirmationEmail(whenText, INDUCTION_FORM_URL), { replyTo });
    if (result) {
      try { db.prepare('UPDATE seek_applicants SET induction_email_sent_at = CURRENT_TIMESTAMP WHERE id = ?').run(applicant.id); } catch (e) { /* column missing on stale deploy */ }
      return 'sent';
    }
    console.warn('[recruitment] induction confirmation email not sent for applicant', applicant.id, '(email service not configured or rejected)');
    return 'failed';
  } catch (e) {
    console.error('[recruitment] induction confirmation email error:', e.message);
    return 'failed';
  }
}
// Human "on <date> at <time>" for notifications/flash. Mirrors the email's
// wording so what the admin is told matches what the applicant received.
function inductionWhenText(isoDateRaw, timeRaw) {
  const iso = String(isoDateRaw || '').slice(0, 10);
  if (!iso) return '';
  const niceDate = new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  let timeStr = '';
  const m = String(timeRaw || '').match(/^(\d{1,2}):(\d{2})/);
  if (m) { let h = parseInt(m[1], 10); const min = m[2]; const ap = h >= 12 ? 'pm' : 'am'; h = h % 12 || 12; timeStr = ' at ' + h + ':' + min + ' ' + ap; }
  return niceDate + timeStr;
}

// Record a bell notification for the acting user about an induction email that
// just went out (or didn't), so a re-email is never silent. `outcome` is the
// sendInductionConfirmation return; `reEmail` distinguishes a resend from the
// first confirmation.
function notifyInductionEmail(db, userId, applicant, outcome, reEmail) {
  if (!userId) return;
  const when = inductionWhenText(applicant.induction_date, applicant.induction_time);
  const name = applicant.applicant_name || 'Applicant';
  let title, message;
  if (outcome === 'sent') {
    title = reEmail ? 'Induction re-emailed' : 'Induction confirmation emailed';
    message = `${name} — ${when}${reEmail ? ' (re-sent)' : ''}`;
  } else if (outcome === 'failed') {
    title = 'Induction email failed';
    message = `${name} — ${when}. The confirmation didn't send; try Re-send.`;
  } else if (outcome === 'no_email') {
    title = 'Induction time changed — no email on file';
    message = `${name} — ${when}. No email address, so nothing was sent.`;
  } else { return; }
  const iso = String(applicant.induction_date || '').slice(0, 10);
  const link = iso
    ? `/induction/admin/recruitment/calendar?year=${iso.slice(0,4)}&month=${parseInt(iso.slice(5,7),10)}&id=${applicant.id}`
    : '/induction/admin/recruitment';
  try {
    // 'general' is the whitelisted catch-all type (the notifications.type CHECK
    // constraint rejects anything off its list — an induction-specific type
    // would silently fail to insert). The title carries the meaning.
    db.prepare(`INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'general', ?, ?, ?)`)
      .run(userId, title, message, link);
  } catch (e) { /* notifications table missing — non-fatal */ }
}

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
router.post('/:id', async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id, stage, date_called, induction_date, induction_time, applicant_name, email, linked_crew_member_id, induction_email_sent_at FROM seek_applicants WHERE id = ?').get(req.params.id);
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

  // Detect a booking change before the UPDATE so we can re-send the applicant
  // a confirmation and surface a notification. Fires whenever the induction
  // DATE *or* TIME is set or changed — so a reschedule (new date) and a
  // time-only tweak both trigger a fresh email. Dates are compared by their
  // YYYY-MM-DD part so a stored timestamp vs a plain date can't cause a false
  // "no change". Unrelated edits (notes, phone) don't trigger an email.
  let inductionDateChange = null;
  {
    const dateProvided = typeof req.body.induction_date !== 'undefined';
    const timeProvided = typeof req.body.induction_time !== 'undefined';
    const incomingDate = dateProvided ? (req.body.induction_date || null) : row.induction_date;
    const incomingTime = timeProvided ? String(req.body.induction_time || '').trim() : (row.induction_time || '');
    const dpart = (d) => (d ? String(d).slice(0, 10) : '');
    const dateChanged = dateProvided && dpart(incomingDate) !== dpart(row.induction_date);
    const timeChanged = timeProvided && incomingTime !== (row.induction_time || '');
    if (incomingDate && (dateChanged || timeChanged)) {
      inductionDateChange = {
        newDate: incomingDate, name: row.applicant_name,
        timeOnly: !dateChanged && timeChanged,
        wasEmailed: !!row.induction_email_sent_at, // prior confirmation → this is a RE-email
      };
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

  // Reaching CALLED or beyond — or booking someone (setting an induction
  // date) — implies the call happened. If there's no date_called yet (e.g.
  // dragged straight to Interested/Booked, or booked while the stage was set
  // separately), stamp today so the Weekly Calls counter reflects it. Skipped
  // for terminal stages and when this request explicitly sets date_called.
  const reachedCalled = newStage && isAtOrBeyond(newStage, 'CALLED');
  const beingBooked = inductionDateChange != null; // induction date newly set/changed
  if ((reachedCalled || beingBooked) && !row.date_called
      && typeof req.body.date_called === 'undefined') {
    sets.push('date_called = ?'); params.push(sydneyToday());
  }

  if (!sets.length) {
    if (wantsJson(req)) return res.json({ ok: true, noop: true });
    return res.redirect(backUrl(req));
  }
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(row.id);
  db.prepare(`UPDATE seek_applicants SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // Email the applicant a booking confirmation when an induction date is set
  // (or changed) and we have an email to send to. Awaited so we can report the
  // real outcome and stamp `induction_email_sent_at` for a durable record.
  //   inductionEmailed: 'sent' | 'failed' | 'no_email' | null (no booking change)
  let inductionEmailed = null;
  const wasReEmail = !!(inductionDateChange && inductionDateChange.wasEmailed);
  if (inductionDateChange) {
    // Read back the freshly-persisted date/time so the email matches the row.
    const fresh = db.prepare('SELECT id, applicant_name, email, induction_date, induction_time FROM seek_applicants WHERE id = ?').get(row.id);
    const replyTo = (req.session.user && req.session.user.email) || undefined;
    inductionEmailed = await sendInductionConfirmation(db, fresh, replyTo);

    // Tell the acting user what happened — a bell notification (durable, shows
    // regardless of which edit surface was used) that reflects the ACTUAL
    // email outcome and calls out a re-email vs the first confirmation. Also a
    // flash so the plain list-form edit (a full-page POST) says it inline.
    if (req.session && req.session.user) {
      notifyInductionEmail(db, req.session.user.id, fresh, inductionEmailed, wasReEmail);
    }
    if (!wantsJson(req)) {
      const when = inductionWhenText(fresh.induction_date, fresh.induction_time);
      if (inductionEmailed === 'sent') req.flash('success', `${fresh.applicant_name} ${wasReEmail ? 're-emailed' : 'emailed'} their induction confirmation — ${when}.`);
      else if (inductionEmailed === 'failed') req.flash('error', `Induction time saved, but the confirmation email to ${fresh.applicant_name} didn't send — use Re-send.`);
      else if (inductionEmailed === 'no_email') req.flash('warning', `Induction time saved for ${fresh.applicant_name}, but there's no email on file so nothing was sent.`);
    }
  }

  // NOTE: marking a candidate "Hired" deliberately does NOT create a roster
  // record. Adding someone to the roster is the induction-form approval's job
  // (routes/induction-admin.js) — auto-creating here as well produced duplicate
  // crew/employee profiles. Hired is just the final pipeline stage.

  if (wantsJson(req)) {
    return res.json({ ok: true, stage: newStage, inductionEmailed, reEmail: wasReEmail });
  }
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id/resend-confirmation — manually re-send
// the induction confirmation email to an applicant (e.g. it failed, they lost
// it, or the date changed). Uses the applicant's stored date/time.
router.post('/:id/resend-confirmation', async (req, res) => {
  const db = getDb();
  const a = db.prepare('SELECT id, applicant_name, email, induction_date, induction_time, induction_email_sent_at FROM seek_applicants WHERE id = ?').get(req.params.id);
  if (!a) return res.status(404).json({ ok: false, status: 'not_found', error: 'Applicant not found.' });
  const replyTo = (req.session.user && req.session.user.email) || undefined;
  const wasReEmail = !!a.induction_email_sent_at; // already emailed once → this is a re-send
  const status = await sendInductionConfirmation(db, a, replyTo);
  // Log a bell notification so a manual re-send is surfaced the same way an
  // auto re-email on a time change is.
  if (req.session && req.session.user) notifyInductionEmail(db, req.session.user.id, a, status, wasReEmail);
  res.json({ ok: status === 'sent', status, reEmail: wasReEmail });
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
