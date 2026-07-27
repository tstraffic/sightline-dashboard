const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canAccess } = require('../middleware/auth');
const {
  getNeedsYouNow,
  getTodayOps,
  getChartData,
  getMyTasks,
  getMyPlans,
} = require('./helpers/dashboard-queries');
const { todaysBirthdays } = require('../lib/birthdays');
const { sydneyToday } = require('../lib/sydney');

router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  // Sydney calendar day, NOT UTC — the server runs UTC, so toISOString()
  // reads yesterday from ~10am AEST/AEDT onward and every "today" number on
  // the dashboard was wrong for most of the Sydney working day.
  const today = sydneyToday();

  // Band 1 — "Needs you now". Rows are permission-gated and zero-hidden
  // inside the helper; a failed builder is skipped, never a 500.
  const needs = getNeedsYouNow(db, user, today);

  // Band 2 — today's live operations, only for roles that work the schedule.
  const todayOps = (canAccess(user, 'bookings') || canAccess(user, 'allocations'))
    ? getTodayOps(db, today)
    : null;

  // Band 3 — one trend.
  const { jobStatusDist } = getChartData(db);

  // "Your work" — personal queues.
  const myTasks = getMyTasks(db, user, today);
  const myPlans = getMyPlans(db, user.id, today);

  // Today's birthdays — banner above everything when at least one active
  // crew member's DOB is today (Sydney). Non-fatal on legacy DBs.
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
    onboarding,
    birthdaysToday,
    needs,
    myTasks,
    myPlans,
    todayOps,
    jobStatusDist,
  });
});

module.exports = router;
