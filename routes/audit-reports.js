// routes/audit-reports.js — cross-audit analytics dashboard.
// Mounted at /audits/reports (BEFORE /audits so the show route doesn't capture
// "reports" as an :id). Read-only aggregation over site_audits +
// audit_question_tags + corrective_actions.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); }

router.get('/', (req, res) => {
  const db = getDb();
  const to = (req.query.to || new Date().toISOString().slice(0, 10));
  const from = (req.query.from || isoDaysAgo(182)); // ~6 months
  const range = [from, to];

  const kpi = db.prepare(`
    SELECT COUNT(*) AS total,
           ROUND(AVG(COALESCE(score_weighted_percent, score_percent)), 0) AS avg_score,
           SUM(CASE WHEN overall_finding='fail' THEN 1 ELSE 0 END) AS fails,
           SUM(CASE WHEN critical_fail=1 THEN 1 ELSE 0 END) AS critical_fails
    FROM site_audits WHERE substr(audit_datetime,1,10) BETWEEN ? AND ?
  `).get(...range) || {};
  kpi.open_actions = db.prepare("SELECT COUNT(*) c FROM corrective_actions WHERE status NOT IN ('completed','cancelled')").get().c;

  const byIndividual = db.prepare(`
    SELECT COALESCE(cm.full_name, t.worker_name_snapshot, 'Crew #' || t.crew_member_id) AS name,
           t.employee_id, COUNT(*) AS tags,
           SUM(CASE WHEN t.risk_level IN ('High','Critical') THEN 1 ELSE 0 END) AS high
    FROM audit_question_tags t
    JOIN site_audits a ON a.id = t.audit_id
    LEFT JOIN crew_members cm ON cm.id = t.crew_member_id
    WHERE substr(a.audit_datetime,1,10) BETWEEN ? AND ?
    GROUP BY t.crew_member_id, t.worker_name_snapshot
    ORDER BY tags DESC, high DESC LIMIT 25
  `).all(...range);

  const byClient = db.prepare(`
    SELECT COALESCE(NULLIF(a.client,''), j.client, '—') AS client, COUNT(*) AS audits,
           ROUND(AVG(COALESCE(a.score_weighted_percent, a.score_percent)), 0) AS avg_score,
           SUM(CASE WHEN a.overall_finding='fail' THEN 1 ELSE 0 END) AS fails
    FROM site_audits a LEFT JOIN jobs j ON j.id = a.job_id
    WHERE substr(a.audit_datetime,1,10) BETWEEN ? AND ?
    GROUP BY COALESCE(NULLIF(a.client,''), j.client, '—') ORDER BY audits DESC LIMIT 25
  `).all(...range);

  const byQuestion = db.prepare(`
    SELECT CASE WHEN instr(ca.source_question_key,'#')>0 THEN substr(ca.source_question_key,1,instr(ca.source_question_key,'#')-1) ELSE ca.source_question_key END AS qkey,
           COUNT(*) AS cnt
    FROM corrective_actions ca JOIN site_audits a ON a.id = ca.source_audit_id
    WHERE ca.source_type='audit' AND ca.source_question_key <> '' AND substr(a.audit_datetime,1,10) BETWEEN ? AND ?
    GROUP BY qkey ORDER BY cnt DESC LIMIT 20
  `).all(...range);

  const trend = db.prepare(`
    SELECT substr(audit_datetime,1,7) AS month, COUNT(*) AS audits,
           ROUND(AVG(COALESCE(score_weighted_percent, score_percent)), 0) AS avg_score,
           SUM(CASE WHEN overall_finding='fail' THEN 1 ELSE 0 END) AS fails
    FROM site_audits
    WHERE audit_datetime <> '' AND substr(audit_datetime,1,10) BETWEEN ? AND ?
    GROUP BY month ORDER BY month
  `).all(...range);

  res.render('audits/reports/index', {
    title: 'Audit Reports', currentPage: 'audit-reports',
    from, to, kpi, byIndividual, byClient, byQuestion, trend, user: req.session.user,
  });
});

module.exports = router;
