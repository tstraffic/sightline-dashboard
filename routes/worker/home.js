const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { getComplianceStatus } = require('../../middleware/compliance');
const {
  buildGreetingSubtext, buildSmartCards, buildStreaks, buildTodayTimeline,
  loadPreferences, getWeather, geocodeAddress, localIso,
} = require('../../services/homeContext');
const { enrichTodaysShifts } = require('../../services/todayBriefing');
const { todaysBirthdays, messagesForBirthday, hasMessaged } = require('../../lib/birthdays');

// GET /w/home — Worker home screen (dynamic, contextual)
router.get('/home', async (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  // Anchor everything on Sydney local date — Railway runs UTC so a raw
  // `new Date()` lands on the previous calendar day every Sydney evening,
  // putting the week strip and "today" highlight on the wrong day.
  const today = localIso(new Date());
  const todayDate = new Date(today + 'T00:00:00');

  // ---- Kick off parallel work where it helps ----
  // Synchronous DB queries first (SQLite is sync) — all very fast
  // Booking statuses worth showing on home (everything except cancelled).
  const VISIBLE_BOOKING_STATUSES = ['unconfirmed','confirmed','green_to_go','in_progress','completed','on_hold'];

  // Tag the source like /w/jobs does so the home card's "Open shift" /
  // "Fill docket" buttons route correctly: booking-only allocations
  // (job_id NULL) need /w/booking-shift/:bookingId to pick up the full
  // detail set. Hardcoding source='allocation' here was sending those
  // shifts to /w/jobs/:id which only LEFT JOINs jobs and so showed
  // blanks for everything sourced from the booking.
  const todaysShifts = db.prepare(`
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
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
    ORDER BY ca.start_time ASC
  `).all(worker.id, today);

  // Fallback: if the worker is on a booking via booking_crew but no
  // crew_allocations row was generated, surface it on home anyway. We
  // shape the row to look like an allocation so downstream code (timeline,
  // weather lookup, on-shift detection) keeps working without a branch.
  let todaysFromBooking = [];
  try {
    todaysFromBooking = db.prepare(`
      SELECT bc.id, bc.booking_id, bc.role_on_site,
        CASE WHEN bc.status = 'assigned' THEN 'allocated' ELSE bc.status END AS status,
        b.booking_number AS job_number, b.title AS job_name, b.title AS client,
        b.site_address, b.suburb, b.status AS job_status,
        DATE(b.start_datetime) AS allocation_date,
        SUBSTR(b.start_datetime, 12, 5) AS start_time,
        SUBSTR(b.end_datetime, 12, 5) AS end_time,
        b.title AS project_name,
        '' AS supervisor_name,
        'booking' AS source
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) = ?
        AND bc.status IN ('assigned','confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
      ORDER BY b.start_datetime ASC
    `).all(worker.id, today, ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* booking_crew may not exist on legacy DBs */ }
  todaysShifts.push(...todaysFromBooking);

  const inTwoWeeks = new Date(todayDate); inTwoWeeks.setDate(inTwoWeeks.getDate() + 14);
  const upcomingShifts = db.prepare(`
    SELECT ca.allocation_date, ca.start_time, ca.end_time, ca.shift_type, ca.status,
           j.id as job_id, j.job_number, j.client, j.site_address, j.suburb
    FROM crew_allocations ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date > ?
      AND ca.allocation_date <= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC LIMIT 5
  `).all(worker.id, today, localIso(inTwoWeeks));

  // Same fallback for upcoming.
  let upcomingFromBooking = [];
  try {
    upcomingFromBooking = db.prepare(`
      SELECT
        DATE(b.start_datetime) AS allocation_date,
        SUBSTR(b.start_datetime, 12, 5) AS start_time,
        SUBSTR(b.end_datetime, 12, 5) AS end_time,
        '' AS shift_type,
        CASE WHEN bc.status = 'assigned' THEN 'allocated' ELSE bc.status END AS status,
        NULL AS job_id, b.booking_number AS job_number, b.title AS client,
        b.site_address, b.suburb
      FROM booking_crew bc
      JOIN bookings b ON bc.booking_id = b.id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) > ? AND DATE(b.start_datetime) <= ?
        AND bc.status IN ('assigned','confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${VISIBLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
      ORDER BY b.start_datetime ASC LIMIT 5
    `).all(worker.id, today, localIso(inTwoWeeks), ...VISIBLE_BOOKING_STATUSES);
  } catch (e) { /* table missing */ }
  upcomingShifts.push(...upcomingFromBooking);
  upcomingShifts.sort((a, b) => (a.allocation_date + (a.start_time || '')).localeCompare(b.allocation_date + (b.start_time || '')));

  // Week strip
  const weekStart = new Date(todayDate);
  const dow = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - dow);
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart); d.setDate(d.getDate() + i);
    weekDays.push({
      iso: localIso(d), dayLetter: ['M','T','W','T','F','S','S'][i], dayNum: d.getDate(),
      isToday: localIso(d) === today, isPast: localIso(d) < today,
    });
  }
  const weekAlloc = db.prepare(`
    SELECT allocation_date, shift_type, status FROM crew_allocations
    WHERE crew_member_id = ? AND allocation_date BETWEEN ? AND ? AND status != 'cancelled'
  `).all(worker.id, weekDays[0].iso, weekDays[6].iso);
  const weekLeave = db.prepare(`
    SELECT start_date, end_date, status FROM employee_leave
    WHERE crew_member_id = ? AND status != 'cancelled' AND NOT (end_date < ? OR start_date > ?)
  `).all(worker.id, weekDays[0].iso, weekDays[6].iso);
  weekDays.forEach(d => {
    const a = weekAlloc.find(x => x.allocation_date === d.iso);
    if (a) { d.kind = 'shift'; d.shiftType = a.shift_type; }
    const l = weekLeave.find(x => x.start_date <= d.iso && x.end_date >= d.iso);
    if (l && !a) { d.kind = 'leave'; d.leaveStatus = l.status; }
  });

  // Stats
  const last7 = new Date(todayDate); last7.setDate(last7.getDate() - 6);
  const hoursRow = db.prepare(`SELECT COALESCE(SUM(total_hours), 0) as hrs FROM timesheets
    WHERE crew_member_id = ? AND work_date BETWEEN ? AND ?`).get(worker.id, weekDays[0].iso, weekDays[6].iso);
  const daysWorkedRow = db.prepare(`SELECT COUNT(DISTINCT DATE(event_time)) as c FROM clock_events
    WHERE crew_member_id = ? AND event_type = 'clock_in' AND DATE(event_time) BETWEEN ? AND ?`).get(worker.id, localIso(last7), today);
  const pendingLeaveCount = db.prepare(`SELECT COUNT(*) as c FROM employee_leave
    WHERE crew_member_id = ? AND status = 'pending'`).get(worker.id).c;
  const stats = {
    hoursThisWeek: Number((hoursRow.hrs || 0).toFixed(1)),
    daysWorked: daysWorkedRow.c || 0,
    upcomingShifts: upcomingShifts.length,
    pendingLeave: pendingLeaveCount,
  };

  // Current shift status
  const lastClock = db.prepare(`SELECT event_type, event_time FROM clock_events
    WHERE crew_member_id = ? ORDER BY event_time DESC LIMIT 1`).get(worker.id);
  const onShift = lastClock && lastClock.event_type === 'clock_in';

  // Recent activity
  const recentClocks = db.prepare(`
    SELECT 'clock' as kind, event_type as subtype, event_time as at
    FROM clock_events WHERE crew_member_id = ? ORDER BY event_time DESC LIMIT 5
  `).all(worker.id);

  // Member + employee
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(worker.id);
  let employee = db.prepare('SELECT * FROM employees WHERE linked_crew_member_id = ?').get(worker.id);
  if (!employee && member) employee = db.prepare('SELECT * FROM employees WHERE employee_code = ?').get(member.employee_id);

  const compliance = member ? getComplianceStatus(member, today) : null;

  // Safety counts: unread Safety Updates + SWMS / SOP rows that need ack
  // against their current version + outstanding quizzes (published, deadline
  // not passed, worker hasn't passed). The widget on the home screen renders
  // silent when all are zero. Wrapped so a missing migration on an old DB
  // doesn't 500 the home screen.
  let safetyCounts = { unread: 0, swmsNeedsAck: 0, sopNeedsAck: 0, quizzesOutstanding: 0 };
  try {
    safetyCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM safety_updates u
          WHERE u.status='published'
            AND (u.expires_at IS NULL OR u.expires_at > datetime('now'))
            AND NOT EXISTS (SELECT 1 FROM safety_update_reads r
                            WHERE r.safety_update_id=u.id AND r.crew_member_id=?)) AS unread,
        (SELECT COUNT(*) FROM swms s
          WHERE s.status='active'
            AND s.kind='template'   /* only generic SWMS — job-linked SWMS
                                       require an access grant and aren't a
                                       universal acknowledgement obligation. */
            AND NOT EXISTS (SELECT 1 FROM swms_acknowledgements a
                            WHERE a.swms_id=s.id AND a.crew_member_id=?
                              AND a.version_token=s.version_token)) AS swmsNeedsAck,
        (SELECT COUNT(*) FROM sop_register s
          WHERE s.status='active'
            AND NOT EXISTS (SELECT 1 FROM sop_register_acknowledgements a
                            WHERE a.sop_id=s.id AND a.crew_member_id=?
                              AND a.version_token=s.version_token)) AS sopNeedsAck,
        (SELECT COUNT(*) FROM safety_quizzes q
          WHERE q.status='published'
            AND (q.deadline_at IS NULL OR q.deadline_at > datetime('now'))
            AND NOT EXISTS (SELECT 1 FROM safety_quiz_attempts a
                            WHERE a.quiz_id=q.id AND a.crew_member_id=?
                              AND a.status='submitted' AND a.passed=1)) AS quizzesOutstanding
    `).get(worker.id, worker.id, worker.id, worker.id) || safetyCounts;
  } catch (e) { /* tables may not exist on stale databases */ }

  // Greeting + subtext
  // Greeting hour is in Sydney too — todayDate is anchored to midnight,
  // so use a fresh Sydney-local hour instead of getHours() which would
  // always be 00.
  const hour = parseInt(new Date().toLocaleString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }), 10);
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = worker.full_name.split(' ')[0];
  const subtext = buildGreetingSubtext(db, worker, member, employee, todaysShifts);

  // Smart cards + streaks (both persist rows)
  const cards = buildSmartCards(db, worker, member, employee);
  const streaks = buildStreaks(db, worker);

  // Preferences
  const prefs = loadPreferences(db, worker);

  // Today timeline
  const timeline = buildTodayTimeline(todaysShifts);

  // Weather — pick the most relevant location for the worker:
  //   1. Today's first shift site (in-progress or upcoming today)
  //   2. The NEXT CONFIRMED upcoming shift site (skipping unconfirmed/declined)
  //   3. The next upcoming shift site (any status)
  //   4. The depot (fallback)
  // If geocoding the chosen site fails (rural address, typo, etc.) we
  // automatically fall through to the depot so the card still renders —
  // workers were getting a blank space instead of weather when the lookup
  // failed silently.
  let weather = null;
  let weatherSource = null; // 'shift' | 'depot'
  try {
    const nextConfirmed = upcomingShifts.find(s => s.status === 'confirmed');
    const shiftForWeather = todaysShifts[0] || nextConfirmed || upcomingShifts[0];
    // Depot weather: skip the geocoder for the default depot and use the
    // exact coords of 9 Epic Pl, Villawood NSW 2163. The geocoder
    // sometimes resolves "Villawood NSW" to the broader suburb centroid
    // (or worse, drifts to a same-named locality), and the office wants
    // the reading to reflect the actual yard. Both can be overridden per
    // deployment via env vars.
    const depotLat = parseFloat(process.env.DEPOT_LAT || '-33.879');
    const depotLng = parseFloat(process.env.DEPOT_LNG || '150.965');
    const depotCity = (process.env.DEPOT_CITY || 'Villawood').trim();

    async function tryFetch(q) {
      if (!q) return null;
      const geo = await geocodeAddress(q);
      if (!geo) return null;
      const w = await getWeather(geo.lat, geo.lng);
      if (!w) return null;
      w.city = geo.city || '';
      return w;
    }

    if (shiftForWeather) {
      const shiftQ = [shiftForWeather.suburb, shiftForWeather.site_address].filter(Boolean).join(', ');
      weather = await tryFetch(shiftQ);
      if (weather) {
        weatherSource = 'shift';
        weather.forShift = shiftForWeather;
      }
    }
    if (!weather) {
      const w = await getWeather(depotLat, depotLng);
      if (w) {
        w.city = depotCity;
        weather = w;
        weatherSource = 'depot';
      }
    }
    if (weather) weather.source = weatherSource;
  } catch (e) { console.warn('[home] weather fetch failed:', e.message); }

  // Job-Pack completion nudge: how many of the 5 checklists has this worker
  // filed for shifts on the LAST 7 DAYS, vs how many were expected? Drives
  // the "Your Job-Pack completion this week" card on home. Same data shape
  // as the office Checklist Register so the office and the worker see the
  // same compliance numbers.
  let jobPackNudge = null;
  try {
    const JP = ['vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle'];
    const fromS = localIso(new Date(Date.now() - 7 * 86400000));
    // Only count shifts the worker actually accepted/worked. Skip
    // anything still pending acceptance, declined, cancelled, or where
    // the parent booking was cancelled — none of those are expected to
    // have Job-Pack checklists filed against them, so they shouldn't
    // pull the worker's compliance percentage down.
    const allocations = db.prepare(`
      SELECT ca.id, ca.booking_id
      FROM crew_allocations ca
      LEFT JOIN bookings b ON ca.booking_id = b.id
      WHERE ca.crew_member_id = ?
        AND ca.status IN ('confirmed','completed')
        AND date(ca.allocation_date) >= date(?)
        AND (b.id IS NULL OR (
          b.deleted_at IS NULL
          AND b.status NOT IN ('cancelled','late_cancellation')
        ))
    `).all(member.id, fromS);
    const distinctBookings = new Set(allocations.map(a => a.booking_id).filter(Boolean));
    const allocCount = allocations.length;
    const bookingCount = distinctBookings.size || allocCount; // fallback when no booking_id
    const expected = {
      vehicle_prestart: bookingCount,
      risk_toolbox: allocCount,
      tc_prestart: allocCount,
      team_leader: allocCount,
      post_shift_vehicle: bookingCount,
    };
    const subRows = db.prepare(`
      SELECT form_type, COUNT(*) AS c FROM safety_forms
      WHERE crew_member_id = ? AND form_type IN (${JP.map(()=>'?').join(',')})
        AND date(submitted_at) >= date(?)
      GROUP BY form_type
    `).all(member.id, ...JP, fromS);
    const submitted = {};
    for (const r of subRows) submitted[r.form_type] = r.c;

    let totalExpected = 0, totalSubmitted = 0;
    const breakdown = JP.map(t => {
      const exp = expected[t] || 0;
      const sub = submitted[t] || 0;
      totalExpected += exp;
      totalSubmitted += Math.min(sub, exp);
      return { key: t, expected: exp, submitted: sub };
    });
    if (totalExpected > 0) {
      jobPackNudge = {
        pct: Math.round(totalSubmitted / totalExpected * 100),
        submitted: totalSubmitted,
        expected: totalExpected,
        // Pick the most-missed checklist to call out by name in the card.
        worstKey: breakdown.filter(b => b.expected > 0).sort((a, b) => (a.submitted / Math.max(a.expected,1)) - (b.submitted / Math.max(b.expected,1)))[0].key,
      };
    }
  } catch (e) { console.error('[home] jobpack nudge failed:', e.message); }

  // Today's birthdays — surface a card on the worker's home so they can
  // wish coworkers. Two flavours:
  //   - meIsBirthdayPerson: the logged-in worker's DOB is today → show
  //     the celebratory pop-up + messages wall on their own home.
  //   - otherBirthdays: anyone else with a birthday today → small
  //     "wish them" card linking to /w/birthday/:id.
  let birthdaysAll = [];
  try { birthdaysAll = todaysBirthdays(db); }
  catch (e) { console.error('[worker home] birthdays lookup failed:', e.message); }
  const myBirthdayRow = birthdaysAll.find(b => b.crew_member_id === worker.id);
  const otherBirthdays = birthdaysAll.filter(b => b.crew_member_id !== worker.id);
  // Pre-compute "have I already wished this person?" so the home card can
  // switch its CTA from "Wish them" to "View messages" without a second
  // round-trip when the user lands on the wish page.
  for (const b of otherBirthdays) {
    try { b.alreadyWished = hasMessaged(db, worker.id, b.crew_member_id, today); }
    catch (e) { b.alreadyWished = false; }
  }
  // For the birthday person themselves: load every wish they've received
  // today so the pop-up + wall renders the actual messages, not a count.
  let myBirthdayMessages = [];
  if (myBirthdayRow) {
    try { myBirthdayMessages = messagesForBirthday(db, worker.id, today); }
    catch (e) { console.error('[worker home] birthday messages load failed:', e.message); }
  }

  // Annotate today's shifts with the briefing-card extras: Google Maps
  // deeplink, countdown label, crew count, supervisor user id (for the
  // one-tap "Message" link). Mutates each row; safe — todaysShifts is
  // only used by the home view from here on.
  try {
    enrichTodaysShifts(db, todaysShifts, { workerId: worker.id, today, now: new Date() });
  } catch (e) { console.error('[home] briefing enrich failed:', e.message); }

  res.render('worker/home', {
    title: 'Home', currentPage: 'home',
    greeting, firstName, subtext,
    todaysShifts, upcomingShifts, weekDays, stats, onShift,
    recentClocks, compliance, member, employee, today,
    cards, streaks, prefs, timeline, weather, jobPackNudge,
    safetyCounts,
    myBirthdayRow, otherBirthdays, myBirthdayMessages,
  });
});

// POST /w/home/cards/:id/dismiss — dismiss a smart card
router.post('/home/cards/:id/dismiss', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE home_cards SET dismissed_at = datetime('now') WHERE id = ? AND crew_member_id = ?")
    .run(req.params.id, req.session.worker.id);
  if ((req.headers.accept || '').includes('application/json')) return res.json({ ok: true });
  res.redirect('/w/home');
});

// POST /w/home/cards/:id/act — mark a card as acted on (when CTA clicked)
router.post('/home/cards/:id/act', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE home_cards SET acted_at = datetime('now') WHERE id = ? AND crew_member_id = ?")
    .run(req.params.id, req.session.worker.id);
  res.json({ ok: true });
});

// POST /w/home/preferences — save Customise Home settings
router.post('/home/preferences', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const sectionOrder = Array.isArray(req.body.section_order) ? req.body.section_order : (req.body.section_order ? [].concat(req.body.section_order) : null);
  const hiddenSections = Array.isArray(req.body.hidden_sections) ? req.body.hidden_sections : (req.body.hidden_sections ? [].concat(req.body.hidden_sections) : []);
  const fabActions = Array.isArray(req.body.fab_actions) ? req.body.fab_actions : (req.body.fab_actions ? [].concat(req.body.fab_actions) : null);

  db.prepare(`
    INSERT INTO home_preferences (crew_member_id, section_order, hidden_sections, fab_actions, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(crew_member_id) DO UPDATE SET
      section_order = excluded.section_order,
      hidden_sections = excluded.hidden_sections,
      fab_actions = excluded.fab_actions,
      updated_at = excluded.updated_at
  `).run(
    worker.id,
    JSON.stringify(sectionOrder || []),
    JSON.stringify(hiddenSections || []),
    JSON.stringify(fabActions || [])
  );

  req.flash('success', 'Home preferences saved.');
  res.redirect('/w/home/customise');
});

// GET /w/home/customise — Customise Home settings page
// GET /w/contacts — read-only directory of T&S office contacts the
// crew can call/email when something goes wrong on a shift. Backed by
// system_config.management_contacts (edited from /hr/management-contacts).
router.get('/contacts', (req, res) => {
  const { getContacts } = require('../../services/management-contacts');
  res.render('worker/contacts', {
    title: 'Contacts',
    currentPage: 'more',
    contacts: getContacts(),
  });
});

router.get('/home/customise', (req, res) => {
  const db = getDb();
  const prefs = loadPreferences(db, req.session.worker);
  res.render('worker/home-customise', {
    title: 'Customise Home', currentPage: 'more',
    prefs,
    flash_success: req.flash('success'),
  });
});

// GET /w/weather.json — live weather for the worker's depot or next site.
// Polled by views/worker/partials/weather-card.ejs every few minutes so
// the temp / conditions stay current without a full page reload.
// Same fetch order as the home render: today's shift → next confirmed
// upcoming → next upcoming → depot. Cached server-side (15min) inside
// getWeather() so polling doesn't hammer Open-Meteo.
router.get('/weather.json', async (req, res) => {
  try {
    const db = getDb();
    const worker = req.session.worker;
    if (!worker) return res.status(401).json({ error: 'unauthorised' });
    const today = localIso(new Date());

    const todays = db.prepare(`
      SELECT ca.allocation_date, b.suburb, b.site_address
      FROM crew_allocations ca
      LEFT JOIN bookings b ON b.id = ca.booking_id
      WHERE ca.crew_member_id = ?
        AND ca.allocation_date = ?
        AND ca.status NOT IN ('cancelled','declined')
      ORDER BY ca.allocation_date LIMIT 1
    `).get(worker.crew_member_id, today);
    const upcoming = db.prepare(`
      SELECT ca.status, b.suburb, b.site_address
      FROM crew_allocations ca
      LEFT JOIN bookings b ON b.id = ca.booking_id
      WHERE ca.crew_member_id = ?
        AND ca.allocation_date > ?
        AND ca.status NOT IN ('cancelled','declined')
      ORDER BY ca.allocation_date LIMIT 5
    `).all(worker.crew_member_id, today);

    const nextConfirmed = upcoming.find(s => s.status === 'confirmed');
    const shiftForWeather = todays || nextConfirmed || upcoming[0];
    const depotLat = parseFloat(process.env.DEPOT_LAT || '-33.879');
    const depotLng = parseFloat(process.env.DEPOT_LNG || '150.965');
    const depotCity = (process.env.DEPOT_CITY || 'Villawood').trim();

    let weather = null;
    let source = null;
    if (shiftForWeather) {
      const q = [shiftForWeather.suburb, shiftForWeather.site_address].filter(Boolean).join(', ');
      if (q) {
        const geo = await geocodeAddress(q);
        if (geo) {
          weather = await getWeather(geo.lat, geo.lng);
          if (weather) { weather.city = geo.city || ''; source = 'shift'; }
        }
      }
    }
    if (!weather) {
      weather = await getWeather(depotLat, depotLng);
      if (weather) { weather.city = depotCity; source = 'depot'; }
    }
    if (!weather) return res.json({ ok: false });
    weather.source = source;
    weather.fetched_at = Date.now();
    res.json({ ok: true, weather });
  } catch (e) {
    console.warn('[worker/weather.json] failed:', e.message);
    res.json({ ok: false });
  }
});

module.exports = router;
