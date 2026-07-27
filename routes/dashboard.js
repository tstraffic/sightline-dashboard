const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canAccess } = require('../middleware/auth');
const {
  getNeedsYouNow,
  getTodayOps,
  getDayMarkers,
  getChartData,
  getMyTasks,
  getMyPlans,
} = require('./helpers/dashboard-queries');
const { todaysBirthdays } = require('../lib/birthdays');
const { sydneyToday, sydneyWallClock } = require('../lib/sydney');
const { getSydneyOutlook } = require('../services/homeContext');

// "HH:MM" → minutes since midnight. Booking datetimes are Sydney wall-clock
// strings, so this is all the arithmetic the day-bar needs.
function hmToMin(hm) {
  return parseInt(hm.slice(0, 2), 10) * 60 + parseInt(hm.slice(3, 5), 10);
}

// Booking ids whose on-site window overlaps any wet window. A booking that
// runs past midnight counts as ending 24:00 for today's overlap test.
function findWetBookings(bookings, outlook, today) {
  if (!outlook || !outlook.wetWindows.length) return new Set();
  const wet = new Set();
  for (const b of bookings) {
    const start = hmToMin(b.start_datetime.slice(11, 16));
    const endsToday = (b.end_datetime || '').slice(0, 10) === today;
    const end = endsToday ? hmToMin(b.end_datetime.slice(11, 16)) : 24 * 60;
    for (const w of outlook.wetWindows) {
      if (start < w.toHour * 60 && end > w.fromHour * 60) { wet.add(b.id); break; }
    }
  }
  return wet;
}

// The "shape of the day" headline — rule-based, no free text generation.
// Priority: a weather turn beats everything (crews work outdoors), then the
// board's worst fact, then the all-clear. Returns segments, never HTML.
function composeThesis({ outlook, needs, todayOps, wetCount, nowHm }) {
  const attn = needs.top.concat(needs.overflow);
  const attnCount = attn.length;
  const topCritical = attn.find(r => r.tone === 'critical');
  const crews = todayOps ? todayOps.crewAssignedToday : 0;

  let headline;
  if (outlook && outlook.wetWindows.length) {
    const now = hmToMin(nowHm);
    const active = outlook.wetWindows.find(w => now >= w.fromHour * 60 && now < w.toHour * 60);
    const ahead = outlook.wetWindows.find(w => w.fromHour * 60 > now);
    if (active) {
      headline = [
        { text: 'Wet on the ground now', em: true },
        { text: `, clearing after ${active.to}.` },
      ];
    } else if (ahead) {
      const toLabel = ahead.toHour >= 17 ? 'knock-off' : ahead.to;
      headline = [
        { text: `Dry until ${ahead.from}, then ` },
        { text: `rain through ${toLabel}`, em: true },
        { text: '.' },
      ];
    } else {
      headline = [
        { text: 'Rain’s done for the day', em: true },
        { text: ', dry through knock-off.' },
      ];
    }
  } else if (topCritical) {
    headline = [
      { text: 'Clear skies — ' },
      { text: `${topCritical.count} ${topCritical.label}`, em: true },
      { text: ' is the pressure today.' },
    ];
  } else if (attnCount > 0) {
    headline = [
      { text: crews > 0 ? 'Steady day on the road. ' : 'The road is quiet. ' },
      { text: `${attnCount} thing${attnCount === 1 ? '' : 's'} need${attnCount === 1 ? 's' : ''} you`, em: true },
      { text: ' before knock-off.' },
    ];
  } else {
    headline = [
      { text: 'Board’s clear. ' },
      { text: crews > 0 ? `${crews} crew${crews === 1 ? '' : 's'} out, nothing waiting on you` : 'Nothing waiting on you', em: true },
      { text: '.' },
    ];
  }

  // Sub-line: live state first, then the sharpest board fact.
  const bits = [];
  if (todayOps) {
    bits.push(`${crews} crew${crews === 1 ? '' : 's'} out`);
    if (wetCount > 0) bits.push(`${wetCount} booking${wetCount === 1 ? '' : 's'} sit${wetCount === 1 ? 's' : ''} in the wet window`);
  }
  // Skip the top attention fact when it IS the wet-window row we already
  // stated — the sub-line must never say the same thing twice.
  const topAttn = attn.find(r => r.key !== 'wet_window');
  if (topCritical) {
    bits.push(`${topCritical.count} ${topCritical.label}${topCritical.detail ? ` (${topCritical.detail})` : ''}`);
  } else if (topAttn) {
    bits.push(`${topAttn.count} ${topAttn.label}`);
  } else if (!bits.length) {
    bits.push('nothing is overdue');
  }
  const sub = bits.join(' · ');
  return { headline, sub };
}

router.get('/', async (req, res) => {
  const db = getDb();
  const user = req.session.user;
  // Sydney calendar day, NOT UTC — the server runs UTC, so toISOString()
  // reads yesterday from ~10am AEST/AEDT onward.
  const today = sydneyToday();
  const nowHm = sydneyWallClock().slice(11, 16);

  // Weather outlook — null on any failure (or DISABLE_WEATHER); every
  // weather element on the page hides itself when null.
  let outlook = null;
  try { outlook = await getSydneyOutlook(); }
  catch (e) { console.error('[dashboard] weather outlook failed:', e.message); }

  // Band 2 data first — the wet-window overlap feeds the attention board.
  const todayOps = (canAccess(user, 'bookings') || canAccess(user, 'allocations'))
    ? getTodayOps(db, today)
    : null;
  const wetBookings = todayOps ? findWetBookings(todayOps.todaysBookings, outlook, today) : new Set();

  // Band 1 — "Needs you now", plus the weather-driven row when it applies.
  const extraRows = [];
  if (wetBookings.size > 0) {
    extraRows.push({
      key: 'wet_window',
      href: '/bookings',
      tone: 'warn',
      priority: 22,
      count: wetBookings.size,
      label: wetBookings.size === 1 ? 'booking in the wet window' : 'bookings in the wet window',
      detail: outlook.wetWindows.map(w => `${w.from}–${w.to}`).join(', '),
    });
  }
  const needs = getNeedsYouNow(db, user, today, extraRows);

  // Day-bar deadline markers (timed + end-of-day cluster).
  const markers = getDayMarkers(db, user, today);

  const { jobStatusDist } = getChartData(db);
  const myTasks = getMyTasks(db, user, today);
  const myPlans = getMyPlans(db, user.id, today);

  // "Pick up an unassigned one (N)" affordance under My tasks.
  let unassignedTasks = 0;
  try {
    unassignedTasks = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE owner_id IS NULL AND status != 'complete' AND deleted_at IS NULL").get().c;
  } catch (e) { /* ignore */ }

  const thesis = composeThesis({ outlook, needs, todayOps, wetCount: wetBookings.size, nowHm });

  // Today's birthdays — banner above everything. Non-fatal on legacy DBs.
  let birthdaysToday = [];
  try { birthdaysToday = todaysBirthdays(db); }
  catch (e) { console.error('[dashboard] birthdays lookup failed:', e.message); }

  // Onboarding checklist
  let onboarding = null;
  try {
    const prefs = JSON.parse(db.prepare('SELECT preferences FROM users WHERE id = ?').get(user.id)?.preferences || '{}');
    if (!prefs.onboarding_dismissed) {
      const isAdmin = user.role === 'admin';
      const checks = [];
      checks.push({ key: 'profile', label: 'Update your profile', link: '/profile', done: !!user.email });
      if (isAdmin) {
        const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
        const jobCount = db.prepare("SELECT COUNT(*) as c FROM jobs").get().c;
        const crewCount = db.prepare("SELECT COUNT(*) as c FROM crew_members").get().c;
        checks.push({ key: 'users', label: 'Add a team member', link: '/admin/users', done: userCount > 1 });
        checks.push({ key: 'job', label: 'Create first job', link: '/jobs/new', done: jobCount > 0 });
        checks.push({ key: 'crew', label: 'Add crew member', link: '/crew/new', done: crewCount > 0 });
        checks.push({ key: 'settings', label: 'Configure dropdowns', link: '/settings', done: false });
      }
      checks.push({ key: 'notifications', label: 'Enable push notifications', link: '/profile', done: false });
      const allDone = checks.every(c => c.done);
      if (!allDone) onboarding = checks;
    }
  } catch (e) { /* preferences column may not exist yet */ }

  res.render('dashboard', {
    title: 'Today',
    user,
    today,
    nowHm,
    thesis,
    outlook,
    markers,
    wetBookings: [...wetBookings],
    onboarding,
    birthdaysToday,
    needs,
    myTasks,
    myPlans,
    unassignedTasks,
    todayOps,
    jobStatusDist,
  });
});

module.exports = router;
