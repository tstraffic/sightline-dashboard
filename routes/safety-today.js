// /safety-today — Safety command-centre dashboard.
//
// Read-only aggregation layer over every safety module, modelled on the Today
// dashboard (/dashboard) and Safety Reports (/safety-reports). Rolls the 13
// registers up into one screen: a Safety Health gauge, KPI strip, ranked
// attention queue, checklist bars and insight tabs. Every number deep-links
// into the underlying register.
//
// Optional ?job_id / ?booking_id scopes the whole page to one job/booking; the
// same scoped roll-up is embedded on the job and booking detail pages via
// buildScopedRollup() in routes/helpers/safety-today-queries.js.
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { aggregateStats, trendingInsights, workerScores } = require('../lib/safetyMetrics');
const { safetyHealth } = require('../lib/safetyHealth');
const { dashboardSummary, FORM_TYPES } = require('../services/checklistRegister');
const {
  resolveScope, scopeSuffix, effJobId,
  getSafetyKpis, getJobPacks, getFatigueWatch, getAttentionQueue, getRegisterGrid,
} = require('./helpers/safety-today-queries');

// Field-activity lists for the Field tab (scope-aware).
function getFieldActivity(db, since, scope) {
  const jid = effJobId(scope);
  const incParams = [];
  let incWhere = '1=1';
  if (jid) { incWhere += ' AND job_id = ?'; incParams.push(jid); }
  const recentIncidents = db.prepare(`
    SELECT id, incident_number, title, severity, investigation_status, incident_date
    FROM incidents WHERE ${incWhere} ORDER BY incident_date DESC, id DESC LIMIT 6
  `).all(...incParams);

  const labelByType = {};
  FORM_TYPES.forEach(f => { labelByType[f.key] = f.label; });
  const feedParams = [];
  let feedWhere = "date(submitted_at) >= date('now','-30 day')";
  if (since) { feedWhere = 'date(submitted_at) >= date(?)'; feedParams.push(since); }
  if (jid) { feedWhere += ' AND job_id = ?'; feedParams.push(jid); }
  const rows = db.prepare(`
    SELECT form_type, COUNT(*) AS count FROM safety_forms
    WHERE ${feedWhere} GROUP BY form_type ORDER BY count DESC
  `).all(...feedParams);
  const jobPackFeed = rows
    .filter(r => labelByType[r.form_type])
    .map(r => ({ label: labelByType[r.form_type], count: r.count }));

  return { recentIncidents, jobPackFeed };
}

const RANGES = {
  today: { days: 0,  label: 'Today' },
  '7':   { days: 7,  label: '7 days' },
  '30':  { days: 30, label: '30 days' },
  '90':  { days: 90, label: '90 days' },
};

function rangeSinceISO(rangeKey) {
  const r = RANGES[rangeKey];
  if (!r || r.days == null) return null;
  const d = new Date();
  d.setDate(d.getDate() - r.days);
  return d.toISOString().slice(0, 10); // whitelisted YYYY-MM-DD
}

router.get('/', (req, res) => {
  const db = getDb();
  const rangeKey = RANGES[req.query.range] ? req.query.range : '30';
  const since = rangeSinceISO(rangeKey);
  const scope = resolveScope(db, req.query);

  const health = safetyHealth(db, since, scope);
  const kpis = getSafetyKpis(db, since, scope);
  const jobPacks = getJobPacks(db, scope);
  const fatigue = getFatigueWatch(db, scope);
  const queue = getAttentionQueue(db, since, scope, { kpis, jobPacks, fatigue });
  const grid = getRegisterGrid(db, since, scope, kpis);

  // Checklist bars: month rollup (org-wide widget, same as Today). Engagement
  // insight lists reuse the Safety Reports calculations verbatim.
  const checklist = (() => { try { return dashboardSummary(db); } catch (e) { return null; } })();
  const laggers = workerScores(since)
    .filter(w => w.composite != null)
    .sort((a, b) => a.composite - b.composite)
    .slice(0, 5);
  const engagement = { stats: aggregateStats(since), laggers, insights: trendingInsights(since) };
  const field = getFieldActivity(db, since, scope);

  res.render('safety-today/index', {
    title: 'Safety Today',
    currentPage: 'safety-today',
    user: req.session.user,
    health, kpis, queue, jobPacks, fatigue, checklist, engagement, grid, field,
    ranges: RANGES, rangeKey, scope,
    sfx: (base) => scopeSuffix(base, scope),
  });
});

module.exports = router;
