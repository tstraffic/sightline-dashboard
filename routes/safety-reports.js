// /safety-reports — Safety compliance + engagement dashboards (Phase 3b).
//
// Read-only — no mutations. Date-range filter applies to all metrics that
// have a "created within range" interpretation (SWMS is always current-
// version, no date filter applies to it).
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { workerScores, aggregateStats, trendingInsights, DISENGAGED_THRESHOLD } = require('../lib/safetyMetrics');

const RANGES = {
  '30':  { days: 30,  label: 'Last 30 days' },
  '90':  { days: 90,  label: 'Last 90 days' },
  '180': { days: 180, label: 'Last 6 months' },
  '365': { days: 365, label: 'Last year' },
  'all': { days: null, label: 'All time' },
};

function rangeSinceISO(rangeKey) {
  const r = RANGES[rangeKey];
  if (!r || r.days == null) return null;
  const d = new Date(); d.setDate(d.getDate() - r.days);
  // Whitelisted YYYY-MM-DD so safetyMetrics can inline it safely.
  return d.toISOString().slice(0, 10);
}

// GET /safety-reports — dashboard
router.get('/', (req, res) => {
  const rangeKey = RANGES[req.query.range] ? req.query.range : '90';
  const since = rangeSinceISO(rangeKey);
  const stats = aggregateStats(since);
  const workers = workerScores(since);
  const insights = trendingInsights(since);
  // Sort workers by composite ascending so the office sees disengaged people
  // first. Workers with null composite (nothing measurable yet) drop to the
  // bottom rather than getting flagged as "0%".
  workers.sort((a, b) => {
    if (a.composite == null && b.composite == null) return a.full_name.localeCompare(b.full_name);
    if (a.composite == null) return 1;
    if (b.composite == null) return -1;
    return a.composite - b.composite;
  });
  res.render('safety-reports/index', {
    title: 'Safety Reports', currentPage: 'safety-reports',
    stats, workers, insights,
    ranges: RANGES, rangeKey, disengagedThreshold: DISENGAGED_THRESHOLD,
  });
});

// GET /safety-reports/workers.csv — engagement table export
router.get('/workers.csv', (req, res) => {
  const rangeKey = RANGES[req.query.range] ? req.query.range : '90';
  const since = rangeSinceISO(rangeKey);
  const workers = workerScores(since);
  const headers = [
    'employee_id', 'full_name', 'composite_score',
    'swms_acked', 'swms_total', 'swms_rate',
    'quizzes_passed', 'quizzes_total', 'quiz_rate',
    'toolboxes_covered', 'toolboxes_total', 'toolbox_rate',
    'updates_read', 'updates_total', 'update_rate',
  ];
  const escape = v => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = workers.map(w => [
    w.employee_id || '', w.full_name, w.composite == null ? '' : w.composite,
    w.swms.acked, w.swms.total, w.swms.rate == null ? '' : w.swms.rate,
    w.quizzes.passed, w.quizzes.total, w.quizzes.rate == null ? '' : w.quizzes.rate,
    w.toolboxes.covered, w.toolboxes.total, w.toolboxes.rate == null ? '' : w.toolboxes.rate,
    w.updates.read, w.updates.total, w.updates.rate == null ? '' : w.updates.rate,
  ].map(escape).join(','));
  const csv = headers.join(',') + '\n' + rows.join('\n') + '\n';
  const fname = 'safety-engagement-' + rangeKey + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + fname + '"');
  res.send(csv);
});

// GET /safety-reports/workers/:crewId — per-worker drill-down. Lists every
// SWMS / update / toolbox / quiz alongside this worker's status.
router.get('/workers/:crewId', (req, res) => {
  const db = getDb();
  const crew = db.prepare('SELECT id, full_name, employee_id, active FROM crew_members WHERE id = ?').get(req.params.crewId);
  if (!crew) { req.flash('error', 'Worker not found.'); return res.redirect('/safety-reports'); }
  const rangeKey = RANGES[req.query.range] ? req.query.range : '90';
  const since = rangeSinceISO(rangeKey);

  // Composite row for the hero strip.
  const allWorkers = workerScores(since);
  const me = allWorkers.find(w => w.id === crew.id) || null;

  const sinceClause = since ? since : null;
  const swmsList = db.prepare(`
    SELECT s.id, s.title, s.kind, s.version_token,
      (SELECT signed_at FROM swms_acknowledgements a WHERE a.swms_id = s.id AND a.crew_member_id = ? AND a.version_token = s.version_token) AS acked_at
    FROM swms s
    WHERE s.status = 'active'
    ORDER BY (acked_at IS NULL) DESC, s.title
  `).all(crew.id);

  const updatesList = db.prepare(`
    SELECT u.id, u.title, u.category, u.published_at,
      (SELECT read_at FROM safety_update_reads r WHERE r.safety_update_id = u.id AND r.crew_member_id = ?) AS read_at
    FROM safety_updates u
    WHERE u.status = 'published'
      AND (u.expires_at IS NULL OR u.expires_at > datetime('now'))
      ${sinceClause ? `AND u.created_at >= '${sinceClause}'` : ''}
    ORDER BY u.published_at DESC
  `).all(crew.id);

  const tbList = db.prepare(`
    SELECT t.id, t.title, t.held_at,
      (SELECT status FROM toolbox_attendance a WHERE a.toolbox_id = t.id AND a.crew_member_id = ?) AS att_status,
      (SELECT recorded_at FROM toolbox_attendance a WHERE a.toolbox_id = t.id AND a.crew_member_id = ?) AS att_at
    FROM toolbox_talks t
    WHERE t.status = 'published'
      ${sinceClause ? `AND t.held_at >= '${sinceClause}'` : ''}
    ORDER BY t.held_at DESC
  `).all(crew.id, crew.id);

  const quizList = db.prepare(`
    SELECT q.id, q.title, q.pass_mark,
      (SELECT score_pct FROM safety_quiz_attempts a
        WHERE a.quiz_id = q.id AND a.crew_member_id = ?
        ORDER BY a.attempt_number DESC LIMIT 1) AS latest_score,
      (SELECT passed FROM safety_quiz_attempts a
        WHERE a.quiz_id = q.id AND a.crew_member_id = ?
        ORDER BY a.attempt_number DESC LIMIT 1) AS latest_passed,
      (SELECT status FROM safety_quiz_attempts a
        WHERE a.quiz_id = q.id AND a.crew_member_id = ?
        ORDER BY a.attempt_number DESC LIMIT 1) AS latest_status
    FROM safety_quizzes q
    WHERE q.status = 'published'
      AND (q.deadline_at IS NULL OR q.deadline_at > datetime('now'))
      ${sinceClause ? `AND q.created_at >= '${sinceClause}'` : ''}
    ORDER BY q.published_at DESC
  `).all(crew.id, crew.id, crew.id);

  // Comments — exclude anonymous (the engagement page is identity-bound;
  // a worker's anonymous flags don't show up under their own name here).
  const commentsList = db.prepare(`
    SELECT id, category, body, status, created_at
    FROM safety_comments
    WHERE crew_member_id = ? AND is_anonymous = 0
      ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
    ORDER BY created_at DESC
    LIMIT 50
  `).all(crew.id);

  res.render('safety-reports/worker', {
    title: crew.full_name + ' — Safety report', currentPage: 'safety-reports',
    crew, me, swmsList, updatesList, tbList, quizList, commentsList,
    ranges: RANGES, rangeKey, disengagedThreshold: DISENGAGED_THRESHOLD,
  });
});

module.exports = router;
