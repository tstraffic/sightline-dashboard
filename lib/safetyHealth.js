// Safety Health composite score (Safety Today dashboard).
//
// A single 0-100 headline that weighs *everything* safety-related, so staff get
// one answer to "where do we stand right now?". It is a weighted mean of six
// factor sub-scores. Each sub-score is 0-100, OR null when there's nothing to
// measure yet (an empty register, no active docs, etc.). The composite
// RENORMALISES across whichever factors ARE present — exactly the technique the
// per-worker engagement score in lib/safetyMetrics.js already uses — so a module
// that hasn't been rolled out yet doesn't drag the headline into a misleading
// low number. The caption then names what was vs wasn't measured.
//
// Weights live here in one object so HSEQ can tune them without hunting through
// queries:
//   Engagement 30 · Job Packs 20 · Incidents 20 · Docs 15 · Audits 10 · Flags 5
//
// SCOPE: pass { jobId, bookingId, parentJobId } to narrow every factor to one
// job/booking. Engagement is workforce-wide and does not scope, so a scoped
// roll-up omits it (the renormalise handles the missing 30%).

'use strict';

const { getDb } = require('../db/database');
const { aggregateStats, WEIGHTS: ENGAGEMENT_WEIGHTS } = require('./safetyMetrics');

const WEIGHTS = {
  engagement: 0.30,
  jobPacks:   0.20,
  incidents:  0.20,
  docs:       0.15,
  audits:     0.10,
  flags:      0.05,
};

// Per-allocation Job-Pack forms (one expected per worker per shift). We use this
// honest subset for the rolling field-compliance factor rather than the
// per-booking vehicle checks, so we don't penalise non-driver crew.
const JOBPACK_PER_ALLOC = ['risk_toolbox', 'tc_prestart', 'team_leader'];

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

// Resolve the job id to filter job-keyed tables by: explicit job, or a booking's
// parent job (so a booking view still reflects the job's audits/incidents/docs).
function effectiveJobId(scope) {
  if (!scope) return null;
  return scope.jobId || scope.parentJobId || null;
}

// ── Factor: worker engagement (workforce-wide; null when scoped) ──
function engagementFactor(since, scope) {
  if (scope && (scope.jobId || scope.bookingId)) return null;
  const s = aggregateStats(since);
  const parts = [];
  if (s.swms.rate      != null) parts.push({ rate: s.swms.rate,      w: ENGAGEMENT_WEIGHTS.swms });
  if (s.quizzes.rate   != null) parts.push({ rate: s.quizzes.rate,   w: ENGAGEMENT_WEIGHTS.quiz });
  if (s.toolboxes.rate != null) parts.push({ rate: s.toolboxes.rate, w: ENGAGEMENT_WEIGHTS.toolbox });
  if (s.updates.rate   != null) parts.push({ rate: s.updates.rate,   w: ENGAGEMENT_WEIGHTS.update });
  if (!parts.length) return null;
  const totalW = parts.reduce((a, p) => a + p.w, 0);
  return clamp(parts.reduce((a, p) => a + p.rate * p.w, 0) / totalW);
}

// ── Factor: rolling field compliance (Job-Pack per-allocation forms) ──
// required = confirmed/completed allocations in range/scope; completed =
// per-allocation form submissions matched by crew+date. null when no shifts.
function jobPacksFactor(db, since, scope) {
  const where = ["ca.status IN ('confirmed','completed')"];
  const params = [];
  if (since) { where.push('date(ca.allocation_date) >= date(?)'); params.push(since); }
  const jid = effectiveJobId(scope);
  if (scope && scope.bookingId) { where.push('ca.booking_id = ?'); params.push(scope.bookingId); }
  else if (jid) { where.push('ca.job_id = ?'); params.push(jid); }

  const allocs = db.prepare(`SELECT COUNT(*) AS c FROM crew_allocations ca WHERE ${where.join(' AND ')}`).get(...params).c;
  if (!allocs) return null;
  const required = allocs * JOBPACK_PER_ALLOC.length;

  // Completed: per-allocation forms submitted in the same window/scope, matched
  // on crew + date against the in-scope allocations (mirrors checklistRegister's
  // deliberate non-binding to a specific allocation row).
  const fWhere = [`sf.form_type IN (${JOBPACK_PER_ALLOC.map(() => '?').join(',')})`];
  const fParams = [...JOBPACK_PER_ALLOC];
  fWhere.push(`EXISTS (SELECT 1 FROM crew_allocations ca WHERE ${where.join(' AND ')}
       AND ca.crew_member_id = sf.crew_member_id
       AND date(ca.allocation_date) = date(sf.submitted_at))`);
  const completed = db.prepare(
    `SELECT COUNT(*) AS c FROM safety_forms sf WHERE ${fWhere.join(' AND ')}`
  ).get(...fParams, ...params).c;

  return clamp((Math.min(completed, required) / required) * 100);
}

// ── Factor: incidents & corrective actions (severity-weighted penalty) ──
function incidentsFactor(db, scope) {
  const jid = effectiveJobId(scope);
  const iWhere = ["i.investigation_status IN ('reported','investigating')"];
  const iParams = [];
  if (jid) { iWhere.push('i.job_id = ?'); iParams.push(jid); }
  const sev = db.prepare(`
    SELECT
      SUM(CASE WHEN i.severity = 'critical' THEN 1 ELSE 0 END) AS crit,
      SUM(CASE WHEN i.severity = 'high'     THEN 1 ELSE 0 END) AS high,
      SUM(CASE WHEN i.severity IN ('medium','low') THEN 1 ELSE 0 END) AS med
    FROM incidents i WHERE ${iWhere.join(' AND ')}
  `).get(...iParams);

  const caWhere = ["ca.status != 'completed'", "ca.status != 'cancelled'", "ca.due_date < date('now')"];
  const caParams = [];
  if (jid) { caWhere.push('ca.job_id = ?'); caParams.push(jid); }
  const overdueActions = db.prepare(
    `SELECT COUNT(*) AS c FROM corrective_actions ca WHERE ${caWhere.join(' AND ')}`
  ).get(...caParams).c;

  // Total ever-existing incidents/actions in scope — if there are none at all,
  // there's genuinely nothing to score, so return null (degrade gracefully).
  const totWhere = jid ? 'WHERE job_id = ?' : '';
  const anyIncidents = db.prepare(`SELECT COUNT(*) AS c FROM incidents ${totWhere}`).get(...(jid ? [jid] : [])).c;
  const anyActions   = db.prepare(`SELECT COUNT(*) AS c FROM corrective_actions ${totWhere}`).get(...(jid ? [jid] : [])).c;
  if (!anyIncidents && !anyActions) return null;

  const penalty = (sev.crit || 0) * 20 + (sev.high || 0) * 10 + (sev.med || 0) * 3 + overdueActions * 8;
  return clamp(100 - penalty);
}

// ── Factor: document currency (SWMS + SOP + RA in-date) ──
// expiring-within-30d counted as half-credit. null when nothing active.
function docsFactor(db, scope) {
  const jid = effectiveJobId(scope);
  let active = 0, inDate = 0, expiring = 0;
  for (const table of ['swms', 'sop_register', 'risk_assessments']) {
    const where = ["status = 'active'"];
    const params = [];
    if (jid) { where.push('job_id = ?'); params.push(jid); }
    const row = db.prepare(`
      SELECT
        COUNT(*) AS active,
        SUM(CASE WHEN expiry_date IS NULL OR expiry_date >= date('now') THEN 1 ELSE 0 END) AS in_date,
        SUM(CASE WHEN expiry_date IS NOT NULL AND expiry_date >= date('now') AND expiry_date <= date('now','+30 days') THEN 1 ELSE 0 END) AS expiring
      FROM ${table} WHERE ${where.join(' AND ')}
    `).get(...params);
    active += row.active || 0; inDate += row.in_date || 0; expiring += row.expiring || 0;
  }
  if (!active) return null;
  // in_date already includes the expiring ones; dock half a point for each
  // expiring doc to reward staying ahead of renewals.
  const score = (inDate - expiring * 0.5) / active * 100;
  return clamp(score);
}

// ── Factor: audit performance (avg score − fails − drafts awaiting sign-off) ──
function auditsFactor(db, scope) {
  const jid = effectiveJobId(scope);
  const where = ["status IN ('submitted','signed_off')", 'score_max > 0'];
  const params = [];
  if (jid) { where.push('job_id = ?'); params.push(jid); }
  const scored = db.prepare(`
    SELECT AVG(COALESCE(score_weighted_percent, score_percent)) AS avg_score, COUNT(*) AS n,
      SUM(CASE WHEN overall_finding = 'fail' THEN 1 ELSE 0 END) AS fails
    FROM site_audits WHERE ${where.join(' AND ')}
  `).get(...params);
  if (!scored || !scored.n) return null;
  const draftWhere = ["status = 'draft'"];
  const draftParams = [];
  if (jid) { draftWhere.push('job_id = ?'); draftParams.push(jid); }
  const drafts = db.prepare(`SELECT COUNT(*) AS c FROM site_audits WHERE ${draftWhere.join(' AND ')}`).get(...draftParams).c;
  return clamp((scored.avg_score || 0) - (scored.fails || 0) * 10 - drafts * 3);
}

// ── Factor: safety comments / flags resolved ──
function flagsFactor(db, since, scope) {
  const jid = effectiveJobId(scope);
  const where = ['1=1'];
  const params = [];
  if (since) { where.push('created_at >= ?'); params.push(since); }
  if (jid) { where.push('job_id = ?'); params.push(jid); }
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed
    FROM safety_comments WHERE ${where.join(' AND ')}
  `).get(...params);
  if (!row || !row.total) return null;
  return clamp((row.closed / row.total) * 100);
}

function bandFor(score) {
  if (score == null) return 'none';
  if (score >= 80) return 'green';
  if (score >= 60) return 'amber';
  return 'red';
}

// Main entry. Returns the composite + the per-factor breakdown for the caption.
function safetyHealth(db, since, scope) {
  db = db || getDb();
  const raw = {
    engagement: engagementFactor(since, scope),
    jobPacks:   jobPacksFactor(db, since, scope),
    incidents:  incidentsFactor(db, scope),
    docs:       docsFactor(db, scope),
    audits:     auditsFactor(db, scope),
    flags:      flagsFactor(db, since, scope),
  };
  const labels = {
    engagement: 'Engagement', jobPacks: 'Job Packs', incidents: 'Incidents',
    docs: 'Document currency', audits: 'Audits', flags: 'Safety flags',
  };

  const factors = Object.keys(WEIGHTS).map(key => ({
    key, label: labels[key], weight: WEIGHTS[key],
    score: raw[key], measured: raw[key] != null,
  }));

  const present = factors.filter(f => f.measured);
  let score = null;
  if (present.length) {
    const totalW = present.reduce((a, f) => a + f.weight, 0);
    score = clamp(present.reduce((a, f) => a + f.score * f.weight, 0) / totalW);
  }

  return {
    score,
    band: bandFor(score),
    factors,
    measuredCount: present.length,
    totalFactors: factors.length,
  };
}

module.exports = { safetyHealth, WEIGHTS };
