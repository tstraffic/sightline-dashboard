// Safety Today — aggregation helpers.
//
// Mirrors routes/helpers/dashboard-queries.js: one function per logical group,
// prepared statements, returns plain objects the view renders directly. Reuses
// each register's own KPI SQL so the dashboard numbers match the registers.
//
// SCOPE: every function takes an optional `scope = { jobId, bookingId,
// parentJobId }`. Job-keyed tables (incidents, audits, swms/sop/ra, compliance,
// corrective_actions, safety_comments) filter on the effective job id —
// the explicit job, or a booking's parent job so a booking view still shows the
// job's audits/incidents/docs. safety_forms / crew_allocations also filter on
// booking_id directly. Workforce-wide engagement metrics don't scope.

'use strict';

const { aggregateStats, trendingInsights, workerScores } = require('../../lib/safetyMetrics');
const { safetyHealth } = require('../../lib/safetyHealth');
const { FORM_TYPES } = require('../../services/checklistRegister');
const { getConfig } = require('../../middleware/settings');

// ── scope helpers ──────────────────────────────────────────────────────────
function effJobId(scope) {
  if (!scope) return null;
  return scope.jobId || scope.parentJobId || null;
}

// Turn ?job_id / ?booking_id into a resolved scope (or null when unscoped).
function resolveScope(db, query) {
  const jobId = query && /^\d+$/.test(String(query.job_id || '')) ? parseInt(query.job_id, 10) : null;
  const bookingId = query && /^\d+$/.test(String(query.booking_id || '')) ? parseInt(query.booking_id, 10) : null;

  if (bookingId) {
    const b = db.prepare('SELECT id, booking_number, title, job_id, start_datetime FROM bookings WHERE id = ?').get(bookingId);
    if (!b) return null;
    let parentJobId = b.job_id || null;
    let jobNumber = null;
    if (parentJobId) {
      const j = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(parentJobId);
      jobNumber = j ? j.job_number : null;
    }
    return {
      kind: 'booking', bookingId, jobId: null, parentJobId,
      label: (b.booking_number || b.title || ('Booking #' + b.id)) + (jobNumber ? ' · Job ' + jobNumber : ''),
    };
  }
  if (jobId) {
    const j = db.prepare('SELECT id, job_number, client, project_name FROM jobs WHERE id = ?').get(jobId);
    if (!j) return null;
    return {
      kind: 'job', jobId, bookingId: null, parentJobId: jobId,
      label: 'Job ' + (j.job_number || ('#' + j.id)) + (j.client ? ' · ' + j.client : ''),
    };
  }
  return null;
}

// Append the active scope to a register deep-link. safety-forms can filter by
// booking; everything else filters by the effective job id.
function scopeSuffix(base, scope) {
  if (!scope) return base;
  const join = base.includes('?') ? '&' : '?';
  if (base.startsWith('/safety-forms') && scope.bookingId) return base + join + 'booking_id=' + scope.bookingId;
  const jid = effJobId(scope);
  return jid ? base + join + 'job_id=' + jid : base;
}

function jobAnd(col, scope, params) {
  const jid = effJobId(scope);
  if (!jid) return '';
  params.push(jid);
  return ` AND ${col} = ?`;
}

// ── KPI tiles ────────────────────────────────────────────────────────────────
function getSafetyKpis(db, since, scope) {
  const scoped = !!(scope && (scope.jobId || scope.bookingId));

  // Incidents + corrective actions
  let p = [];
  const inc = db.prepare(`
    SELECT
      SUM(CASE WHEN investigation_status IN ('reported','investigating') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN severity IN ('critical','high') AND investigation_status IN ('reported','investigating') THEN 1 ELSE 0 END) AS critical_high
    FROM incidents WHERE 1=1${jobAnd('job_id', scope, p)}
  `).get(...p);

  p = [];
  const openActions = db.prepare(
    `SELECT COUNT(*) AS c FROM corrective_actions WHERE status NOT IN ('completed','cancelled')${jobAnd('job_id', scope, p)}`
  ).get(...p).c;

  p = [];
  const overdueActions = db.prepare(
    `SELECT COUNT(*) AS c FROM corrective_actions WHERE status NOT IN ('completed','cancelled') AND due_date < date('now')${jobAnd('job_id', scope, p)}`
  ).get(...p).c;

  // Document currency (swms only for the "SWMS expiring" tile; all three for "expired")
  p = [];
  const swmsExpiring = db.prepare(
    `SELECT COUNT(*) AS c FROM swms WHERE status <> 'archived' AND expiry_date IS NOT NULL AND expiry_date BETWEEN date('now') AND date('now','+30 days')${jobAnd('job_id', scope, p)}`
  ).get(...p).c;

  let expiredDocs = 0;
  for (const t of ['swms', 'sop_register', 'risk_assessments']) {
    const pp = [];
    expiredDocs += db.prepare(
      `SELECT COUNT(*) AS c FROM ${t} WHERE status <> 'archived' AND expiry_date IS NOT NULL AND expiry_date < date('now')${jobAnd('job_id', scope, pp)}`
    ).get(...pp).c;
  }

  // Audits
  p = [];
  const auditsDraft = db.prepare(
    `SELECT COUNT(*) AS c FROM site_audits WHERE status = 'draft'${jobAnd('job_id', scope, p)}`
  ).get(...p).c;
  p = [];
  const avgRow = db.prepare(
    `SELECT AVG(COALESCE(score_weighted_percent, score_percent)) AS avg_score
     FROM site_audits WHERE status IN ('submitted','signed_off') AND score_max > 0${jobAnd('job_id', scope, p)}`
  ).get(...p);
  const avgAuditScore = avgRow && avgRow.avg_score != null ? Math.round(avgRow.avg_score) : null;

  // Safety comments (flags)
  p = [];
  let commentsWhere = "status <> 'closed'";
  if (since) { commentsWhere += ' AND created_at >= ?'; p.push(since); }
  const openComments = db.prepare(
    `SELECT COUNT(*) AS c FROM safety_comments WHERE ${commentsWhere}${jobAnd('job_id', scope, p)}`
  ).get(...p).c;

  // VOC pending marking — VOC has no job link, so omit when scoped.
  const vocPending = scoped ? null
    : db.prepare("SELECT COUNT(*) AS c FROM voc_assessments WHERE marking_complete = 0").get().c;

  // Workforce-wide engagement rates (don't scope) — shown only on the org view.
  const stats = aggregateStats(since);
  const toolboxCoverage = scoped ? null : stats.toolboxes.rate;
  const swmsAck = scoped ? null : stats.swms.rate;

  return {
    openIncidents: inc.open || 0,
    criticalHigh: inc.critical_high || 0,
    openActions, overdueActions,
    swmsExpiring, expiredDocs,
    auditsDraft, avgAuditScore,
    toolboxCoverage, swmsAck,
    openComments, vocPending,
  };
}

// ── Today's / scoped Job-Pack completion ─────────────────────────────────────
// Shift unit = (booking, date) or a booking-less allocation. A unit is complete
// when every per-allocation form is in for each worker AND each per-booking
// vehicle form has at least one submission by the unit's crew that day.
function getJobPacks(db, scope) {
  const perAlloc = FORM_TYPES.filter(f => f.per === 'allocation');
  const perBooking = FORM_TYPES.filter(f => f.per === 'booking');

  const where = ["ca.status IN ('confirmed','completed')"];
  const params = [];
  if (scope && scope.bookingId) { where.push('ca.booking_id = ?'); params.push(scope.bookingId); }
  else if (scope && effJobId(scope)) { where.push('ca.job_id = ?'); params.push(effJobId(scope)); }
  else { where.push("date(ca.allocation_date) = date('now')"); }

  const allocs = db.prepare(`
    SELECT ca.id, ca.crew_member_id, ca.booking_id, ca.allocation_date, ca.job_id,
      cm.full_name AS crew_name, j.job_number, b.booking_number, b.title AS booking_title
    FROM crew_allocations ca
    LEFT JOIN crew_members cm ON cm.id = ca.crew_member_id
    LEFT JOIN jobs j ON j.id = ca.job_id
    LEFT JOIN bookings b ON b.id = ca.booking_id
    WHERE ${where.join(' AND ')}
    ORDER BY ca.allocation_date DESC, ca.booking_id
  `).all(...params);

  if (!allocs.length) return { complete: 0, total: 0, outstanding: [], allocations: 0 };

  const units = new Map();
  for (const a of allocs) {
    const key = (a.booking_id ? 'b' + a.booking_id : 'a' + a.id) + ':' + a.allocation_date;
    if (!units.has(key)) units.set(key, {
      date: a.allocation_date, booking_id: a.booking_id, job_id: a.job_id,
      label: a.booking_number || a.booking_title || (a.job_number ? 'Job ' + a.job_number : 'Shift'),
      crewIds: new Set(), workers: [],
    });
    const u = units.get(key);
    if (!u.crewIds.has(a.crew_member_id)) u.workers.push(a.crew_name || ('#' + a.crew_member_id));
    u.crewIds.add(a.crew_member_id);
  }

  const outstanding = [];
  let complete = 0;
  for (const u of units.values()) {
    const crewIds = [...u.crewIds];
    const ph = crewIds.map(() => '?').join(',');
    const missing = [];
    for (const f of perAlloc) {
      const got = db.prepare(
        `SELECT COUNT(DISTINCT crew_member_id) AS c FROM safety_forms
         WHERE form_type = ? AND date(submitted_at) = date(?) AND crew_member_id IN (${ph})`
      ).get(f.key, u.date, ...crewIds).c;
      if (got < crewIds.length) missing.push(f.label);
    }
    for (const f of perBooking) {
      const got = db.prepare(
        `SELECT COUNT(*) AS c FROM safety_forms
         WHERE form_type = ? AND date(submitted_at) = date(?) AND crew_member_id IN (${ph})`
      ).get(f.key, u.date, ...crewIds).c;
      if (got < 1) missing.push(f.label);
    }
    if (!missing.length) complete++;
    else outstanding.push({
      label: u.label, date: u.date, booking_id: u.booking_id, job_id: u.job_id,
      crew: u.workers.slice(0, 3).join(', '), missing,
    });
  }

  return { complete, total: units.size, outstanding, allocations: allocs.length };
}

// ── Fatigue / shift-hours watch ──────────────────────────────────────────────
function shiftHours(start, end) {
  const p = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? (+m[1] + (+m[2]) / 60) : null; };
  const s = p(start), e = p(end);
  if (s == null || e == null) return null;
  let h = e - s;
  if (h < 0) h += 24; // overnight wrap
  return h;
}

function getFatigueWatch(db, scope) {
  const maxDays = getConfig('fatigue_max_days', 5);
  const where = [
    "ca.status IN ('allocated','confirmed','completed')",
    "date(ca.allocation_date) >= date('now')",
    "date(ca.allocation_date) <= date('now','+1 day')",
  ];
  const params = [];
  if (scope && scope.bookingId) { where.push('ca.booking_id = ?'); params.push(scope.bookingId); }
  else if (scope && effJobId(scope)) { where.push('ca.job_id = ?'); params.push(effJobId(scope)); }

  const rows = db.prepare(`
    SELECT ca.crew_member_id, ca.allocation_date, ca.start_time, ca.end_time, ca.shift_type,
      cm.full_name AS crew_name, j.job_number
    FROM crew_allocations ca
    LEFT JOIN crew_members cm ON cm.id = ca.crew_member_id
    LEFT JOIN jobs j ON j.id = ca.job_id
    WHERE ${where.join(' AND ')}
    ORDER BY ca.allocation_date
  `).all(...params);

  const byCrew = new Map();
  for (const r of rows) {
    const reasons = [];
    const hours = shiftHours(r.start_time, r.end_time);
    if (hours != null && hours > 12) reasons.push(hours.toFixed(1) + 'h shift');
    if (r.shift_type === 'night') reasons.push('night work');
    const dw = db.prepare(`
      SELECT COUNT(DISTINCT d.work_day) AS c FROM (
        SELECT allocation_date AS work_day FROM crew_allocations
          WHERE crew_member_id = ? AND status IN ('allocated','confirmed','completed')
          AND allocation_date BETWEEN date('now','-6 days') AND date('now')
        UNION
        SELECT work_date AS work_day FROM timesheets
          WHERE crew_member_id = ? AND work_date BETWEEN date('now','-6 days') AND date('now')
      ) d
    `).get(r.crew_member_id, r.crew_member_id).c;
    if (dw >= maxDays) reasons.push(dw + ' days in 7');
    if (reasons.length && !byCrew.has(r.crew_member_id)) {
      byCrew.set(r.crew_member_id, {
        crew: r.crew_name || ('#' + r.crew_member_id),
        job_number: r.job_number, date: r.allocation_date,
        shift_type: r.shift_type, reasons,
      });
    }
  }
  const list = [...byCrew.values()];
  return { count: list.length, list };
}

// ── "Needs attention" ranked queue ───────────────────────────────────────────
// The route passes the already-computed kpis/jobPacks/fatigue so we don't
// re-query. Lower rank = more urgent; sorted ascending, capped.
function getAttentionQueue(db, since, scope, ctx) {
  const { kpis, jobPacks, fatigue } = ctx;
  const scoped = !!(scope && (scope.jobId || scope.bookingId));
  const items = [];

  if (kpis.overdueActions > 0) items.push({
    rank: 1, tag: 'Action', tone: 'r',
    what: kpis.overdueActions + ' overdue corrective action' + (kpis.overdueActions > 1 ? 's' : ''),
    meta: 'past due date — close out or reassign', link: scopeSuffix('/actions', scope), action: 'Resolve →',
  });

  // Individual open critical/high incidents (most actionable rows first)
  const ip = [];
  const incRows = db.prepare(`
    SELECT id, incident_number, title, severity, investigation_status,
      CAST(julianday('now') - julianday(incident_date) AS INT) AS age_days
    FROM incidents
    WHERE severity IN ('critical','high') AND investigation_status IN ('reported','investigating')${jobAnd('job_id', scope, ip)}
    ORDER BY (severity='critical') DESC, incident_date ASC LIMIT 4
  `).all(...ip);
  for (const i of incRows) items.push({
    rank: 2, tag: 'Incident', tone: 'r',
    what: (i.incident_number ? i.incident_number + ' · ' : '') + (i.title || 'Incident'),
    meta: i.severity.toUpperCase() + ' · ' + (i.investigation_status) + (i.age_days != null ? ' · open ' + i.age_days + 'd' : ''),
    link: '/incidents/' + i.id, action: 'Investigate →',
  });

  if (jobPacks && jobPacks.outstanding.length > 0) items.push({
    rank: 3, tag: 'Job Pack', tone: 'r',
    what: jobPacks.outstanding.length + ' shift' + (jobPacks.outstanding.length > 1 ? 's' : '') + ' with "still required" items',
    meta: jobPacks.outstanding.slice(0, 2).map(o => o.label + ' — ' + o.missing.join(', ')).join(' · '),
    link: scopeSuffix('/safety-forms?scope=jobpack', scope), action: 'Chase before EOS →',
  });

  if (fatigue && fatigue.count > 0) items.push({
    rank: 4, tag: 'Fatigue', tone: 'a',
    what: fatigue.count + ' worker' + (fatigue.count > 1 ? 's' : '') + ' over shift-hours threshold',
    meta: fatigue.list.slice(0, 2).map(f => f.crew + ' (' + f.reasons.join(', ') + ')').join(' · '),
    link: '/safety-today#fatigue', action: 'Review →',
  });

  if (kpis.expiredDocs > 0) items.push({
    rank: 3, tag: 'Docs', tone: 'r',
    what: kpis.expiredDocs + ' expired SWMS / SOP / RA',
    meta: 'out of date — renew before next use', link: scopeSuffix('/swms', scope), action: 'Renew →',
  });
  if (kpis.swmsExpiring > 0) items.push({
    rank: 5, tag: 'Docs', tone: 'a',
    what: kpis.swmsExpiring + ' SWMS expiring within 30 days',
    meta: 'schedule a review', link: scopeSuffix('/swms', scope), action: 'View →',
  });

  if (kpis.auditsDraft > 0) items.push({
    rank: 6, tag: 'Audit', tone: 'a',
    what: kpis.auditsDraft + ' audit' + (kpis.auditsDraft > 1 ? 's' : '') + ' awaiting sign-off',
    meta: 'sitting in draft', link: scopeSuffix('/audits?status=draft', scope), action: 'Sign off →',
  });

  if (kpis.vocPending > 0) items.push({
    rank: 7, tag: 'VOC', tone: 'b',
    what: kpis.vocPending + ' VOC' + (kpis.vocPending > 1 ? 's' : '') + ' pending marking',
    meta: 'theory / practical to be marked', link: '/voc-assessments', action: 'Mark now →',
  });

  if (kpis.openComments > 0) items.push({
    rank: 7, tag: 'Flag', tone: 'b',
    what: kpis.openComments + ' open safety comment' + (kpis.openComments > 1 ? 's' : ''),
    meta: 'from the worker portal', link: scopeSuffix('/safety-comments?status=submitted', scope), action: 'Respond →',
  });

  // Org-only signals (engagement + setup nudges)
  if (!scoped) {
    if (kpis.swmsAck != null && kpis.swmsAck < 60) items.push({
      rank: 8, tag: 'Engagement', tone: 'a',
      what: 'SWMS acknowledgement at ' + kpis.swmsAck + '%',
      meta: 'workers yet to sign current SWMS', link: '/safety-reports', action: 'Chase →',
    });
    if (kpis.toolboxCoverage != null && kpis.toolboxCoverage < 50) items.push({
      rank: 8, tag: 'Toolbox', tone: 'a',
      what: 'Toolbox coverage at ' + kpis.toolboxCoverage + '%',
      meta: 'low attendance across the workforce', link: '/toolbox-talks', action: 'Follow up →',
    });
    // Setup nudges for empty registers
    const emptyChecks = [
      { t: 'risk_assessments', label: 'Risk Assessments register empty', link: '/risk-assessments', sql: 'SELECT COUNT(*) AS c FROM risk_assessments' },
      { t: 'safety_quizzes', label: 'No safety quizzes published', link: '/safety-quizzes', sql: "SELECT COUNT(*) AS c FROM safety_quizzes WHERE status='published'" },
      { t: 'safety_updates', label: 'No safety updates published', link: '/safety-updates', sql: "SELECT COUNT(*) AS c FROM safety_updates WHERE status='published'" },
    ];
    for (const e of emptyChecks) {
      let n = 0;
      try { n = db.prepare(e.sql).get().c; } catch (err) { n = 1; }
      if (n === 0) items.push({
        rank: 9, tag: 'Setup', tone: 'b', what: e.label,
        meta: 'not set up yet', link: e.link, action: 'Add one →',
      });
    }
  }

  items.sort((a, b) => a.rank - b.rank);
  return { items: items.slice(0, 12), total: items.length };
}

// ── 13-card register grid ────────────────────────────────────────────────────
function getRegisterGrid(db, since, scope, kpis) {
  const jid = effJobId(scope);
  const jc = jid ? ' WHERE job_id = ?' : '';
  const jp = jid ? [jid] : [];
  const one = (sql, params = []) => { try { return db.prepare(sql).get(...params); } catch (e) { return {}; } };

  const auditsTotal = one(`SELECT COUNT(*) AS c FROM site_audits${jc}`, jp).c || 0;
  const swmsActive = one(`SELECT COUNT(*) AS c FROM swms WHERE status='active'${jid ? ' AND job_id = ?' : ''}`, jp).c || 0;
  const sopActive = one(`SELECT COUNT(*) AS c FROM sop_register WHERE status='active'${jid ? ' AND job_id = ?' : ''}`, jp).c || 0;
  const raTotal = one(`SELECT COUNT(*) AS c FROM risk_assessments${jc}`, jp).c || 0;
  const formsCount = one(`SELECT COUNT(*) AS c FROM safety_forms WHERE date(submitted_at) >= date('now','-30 day')${jid ? ' AND job_id = ?' : ''}`, jp).c || 0;
  const tbPublished = one("SELECT COUNT(*) AS c FROM toolbox_talks WHERE status='published'").c || 0;
  const updatesPublished = one("SELECT COUNT(*) AS c FROM safety_updates WHERE status='published'").c || 0;
  const quizzesPublished = one("SELECT COUNT(*) AS c FROM safety_quizzes WHERE status='published'").c || 0;
  const vocTotal = one('SELECT COUNT(*) AS c FROM voc_assessments').c || 0;

  return [
    { key: 'audits', name: 'Site Audits', link: scopeSuffix('/audits', scope), stat: auditsTotal, sub: kpis.auditsDraft + ' awaiting sign-off' },
    { key: 'incidents', name: 'Incidents', link: scopeSuffix('/incidents', scope), stat: kpis.openIncidents, statTone: kpis.openIncidents ? 'red' : null, sub: kpis.criticalHigh + ' critical/high' },
    { key: 'forms', name: 'Forms & Checklists', link: scopeSuffix('/safety-forms', scope), stat: formsCount, sub: 'last 30 days' },
    { key: 'swms', name: 'SWMS', link: scopeSuffix('/swms', scope), stat: swmsActive, sub: kpis.swmsExpiring + ' expiring' },
    { key: 'sop', name: 'SOP', link: scopeSuffix('/sop-register', scope), stat: sopActive, sub: 'active' },
    { key: 'updates', name: 'Safety Updates', link: '/safety-updates', stat: updatesPublished, empty: updatesPublished === 0, note: 'No bulletins — publish one →' },
    { key: 'toolbox', name: 'Toolbox Talks', link: '/toolbox-talks', stat: tbPublished, sub: 'published' },
    { key: 'comments', name: 'Safety Comments', link: scopeSuffix('/safety-comments', scope), stat: kpis.openComments, sub: 'open' },
    { key: 'quizzes', name: 'Safety Quizzes', link: '/safety-quizzes', stat: quizzesPublished, empty: quizzesPublished === 0, note: 'No quizzes — create one →' },
    { key: 'workshops', name: 'Workshops', link: '/safety-workshops', empty: true, note: 'Soft launch →' },
    { key: 'reports', name: 'Safety Reports', link: '/safety-reports', empty: true, note: 'Engagement report →' },
    { key: 'risk', name: 'Risk Assessments', link: scopeSuffix('/risk-assessments', scope), stat: raTotal, empty: raTotal === 0, note: 'Register empty — add a template →' },
    { key: 'voc', name: 'VOCs', link: '/voc-assessments', stat: vocTotal, sub: (kpis.vocPending || 0) + ' pending' },
  ];
}

// ── Compact bundle for the embeddable _rollup.ejs partial (job/booking pages) ──
function buildScopedRollup(db, scope, since) {
  const kpis = getSafetyKpis(db, since || null, scope);
  const jobPacks = getJobPacks(db, scope);
  const fatigue = getFatigueWatch(db, scope);
  const health = safetyHealth(db, since || null, scope);
  const queue = getAttentionQueue(db, since || null, scope, { kpis, jobPacks, fatigue });
  return { scope, health, kpis, jobPacks, fatigue, queue };
}

module.exports = {
  resolveScope, scopeSuffix, effJobId,
  getSafetyKpis, getJobPacks, getFatigueWatch, getAttentionQueue, getRegisterGrid,
  buildScopedRollup,
};
