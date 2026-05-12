// Safety reporting metrics (Phase 3b).
//
// Pure aggregation over the existing Safety tables (SWMS acks, Update reads,
// Toolbox attendance, Quiz attempts, Comments / flags). No new schema —
// everything is derived. All queries are scoped to active crew_members so
// inactive employees don't drag the rates down.
//
// The composite "engagement score" is a weighted average of four sub-rates:
//   - SWMS acknowledgement (current version)        40%
//   - Quiz pass rate (over published quizzes)       25%
//   - Toolbox coverage (attended or caught up)      20%
//   - Update read rate                              15%
//
// Weights reflect compliance criticality: an un-acked SWMS is a real audit
// finding, an unread bulletin is engagement signal. Tweak if HSEQ wants
// different weights — the formula is intentionally in one place.

'use strict';

const { getDb } = require('../db/database');

const WEIGHTS = { swms: 0.40, quiz: 0.25, toolbox: 0.20, update: 0.15 };
const DISENGAGED_THRESHOLD = 60; // score below this lights the amber chip

function rangeWhere(since) {
  // SQLite date comparison works fine on ISO strings.
  return since ? ` AND created_at >= '${since}'` : '';
}

function fmtPct(num, denom) {
  if (!denom) return null;
  return Math.round((num / denom) * 100);
}

// Per-worker counts of each numerator + denominator. One row per active
// crew member. The page renders these directly; the CSV export streams
// the same shape.
function workerScores(since) {
  const db = getDb();
  const sinceClause = since ? since : null;
  // SQLite doesn't support parameter binding inside subselect comparisons
  // cleanly here, so we whitelist `since` to YYYY-MM-DD before reaching this
  // function. The route layer guards that.
  const rows = db.prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id,
      -- SWMS denominators: every active SWMS row
      (SELECT COUNT(*) FROM swms WHERE status = 'active') AS swms_total,
      (SELECT COUNT(*) FROM swms s
        WHERE s.status = 'active'
          AND EXISTS (
            SELECT 1 FROM swms_acknowledgements a
            WHERE a.swms_id = s.id AND a.crew_member_id = cm.id
              AND a.version_token = s.version_token
          )) AS swms_acked,
      -- Updates denominators: published, not expired
      (SELECT COUNT(*) FROM safety_updates
        WHERE status = 'published'
          AND (expires_at IS NULL OR expires_at > datetime('now'))
          ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS updates_total,
      (SELECT COUNT(*) FROM safety_updates u
        WHERE u.status = 'published'
          AND (u.expires_at IS NULL OR u.expires_at > datetime('now'))
          ${sinceClause ? `AND u.created_at >= '${sinceClause}'` : ''}
          AND EXISTS (
            SELECT 1 FROM safety_update_reads r
            WHERE r.safety_update_id = u.id AND r.crew_member_id = cm.id
          )) AS updates_read,
      -- Toolboxes
      (SELECT COUNT(*) FROM toolbox_talks
        WHERE status = 'published'
          ${sinceClause ? `AND held_at >= '${sinceClause}'` : ''}
      ) AS toolbox_total,
      (SELECT COUNT(*) FROM toolbox_talks t
        WHERE t.status = 'published'
          ${sinceClause ? `AND t.held_at >= '${sinceClause}'` : ''}
          AND EXISTS (
            SELECT 1 FROM toolbox_attendance a
            WHERE a.toolbox_id = t.id AND a.crew_member_id = cm.id
          )) AS toolbox_covered,
      -- Quizzes: denominator = published quizzes that are still live
      (SELECT COUNT(*) FROM safety_quizzes
        WHERE status = 'published'
          AND (deadline_at IS NULL OR deadline_at > datetime('now'))
          ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS quiz_total,
      (SELECT COUNT(*) FROM safety_quizzes q
        WHERE q.status = 'published'
          AND (q.deadline_at IS NULL OR q.deadline_at > datetime('now'))
          ${sinceClause ? `AND q.created_at >= '${sinceClause}'` : ''}
          AND EXISTS (
            SELECT 1 FROM safety_quiz_attempts a
            WHERE a.quiz_id = q.id AND a.crew_member_id = cm.id
              AND a.status = 'submitted' AND a.passed = 1
          )) AS quiz_passed
    FROM crew_members cm
    WHERE cm.active = 1
    ORDER BY cm.full_name
  `).all();

  // Compute per-worker sub-rates + composite. Null when there's nothing to
  // measure in a slice (don't penalise a worker for empty denominators).
  return rows.map(r => {
    const swmsRate = fmtPct(r.swms_acked, r.swms_total);
    const updRate  = fmtPct(r.updates_read, r.updates_total);
    const tbRate   = fmtPct(r.toolbox_covered, r.toolbox_total);
    const qzRate   = fmtPct(r.quiz_passed, r.quiz_total);
    // Composite ignores categories with no denominator so a worker on a new
    // site without toolboxes yet doesn't get penalised. Weights are
    // renormalised across whichever categories ARE present.
    const parts = [];
    if (swmsRate != null) parts.push({ rate: swmsRate, w: WEIGHTS.swms });
    if (qzRate  != null) parts.push({ rate: qzRate,  w: WEIGHTS.quiz });
    if (tbRate  != null) parts.push({ rate: tbRate,  w: WEIGHTS.toolbox });
    if (updRate != null) parts.push({ rate: updRate, w: WEIGHTS.update });
    let composite = null;
    if (parts.length) {
      const totalW = parts.reduce((a, p) => a + p.w, 0);
      composite = Math.round(parts.reduce((a, p) => a + p.rate * p.w, 0) / totalW);
    }
    return {
      id: r.id, full_name: r.full_name, employee_id: r.employee_id,
      swms: { acked: r.swms_acked, total: r.swms_total, rate: swmsRate },
      updates: { read: r.updates_read, total: r.updates_total, rate: updRate },
      toolboxes: { covered: r.toolbox_covered, total: r.toolbox_total, rate: tbRate },
      quizzes: { passed: r.quiz_passed, total: r.quiz_total, rate: qzRate },
      composite,
      disengaged: composite != null && composite < DISENGAGED_THRESHOLD,
    };
  });
}

// Aggregate stat cards for the top of the dashboard.
function aggregateStats(since) {
  const db = getDb();
  const sinceClause = since ? since : null;
  const totalCrew = db.prepare('SELECT COUNT(*) AS c FROM crew_members WHERE active = 1').get().c;

  const swms = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM swms WHERE status = 'active') AS total_swms,
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) * (SELECT COUNT(*) FROM swms WHERE status = 'active') AS denom,
      (SELECT COUNT(*) FROM swms s
        JOIN crew_members cm ON cm.active = 1
        JOIN swms_acknowledgements a ON a.swms_id = s.id AND a.crew_member_id = cm.id AND a.version_token = s.version_token
        WHERE s.status = 'active') AS acked_pairs
  `).get();
  const swmsRate = fmtPct(swms.acked_pairs, swms.denom);

  const updates = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM safety_updates
        WHERE status = 'published' AND (expires_at IS NULL OR expires_at > datetime('now'))
          ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS total_updates,
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) *
      (SELECT COUNT(*) FROM safety_updates
        WHERE status = 'published' AND (expires_at IS NULL OR expires_at > datetime('now'))
          ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS denom,
      (SELECT COUNT(*) FROM safety_updates u
        JOIN crew_members cm ON cm.active = 1
        JOIN safety_update_reads r ON r.safety_update_id = u.id AND r.crew_member_id = cm.id
        WHERE u.status = 'published' AND (u.expires_at IS NULL OR u.expires_at > datetime('now'))
          ${sinceClause ? `AND u.created_at >= '${sinceClause}'` : ''}
      ) AS read_pairs
  `).get();
  const updRate = fmtPct(updates.read_pairs, updates.denom);

  const toolboxes = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM toolbox_talks
        WHERE status = 'published' ${sinceClause ? `AND held_at >= '${sinceClause}'` : ''}
      ) AS total_tb,
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) *
      (SELECT COUNT(*) FROM toolbox_talks
        WHERE status = 'published' ${sinceClause ? `AND held_at >= '${sinceClause}'` : ''}
      ) AS denom,
      (SELECT COUNT(*) FROM toolbox_talks t
        JOIN crew_members cm ON cm.active = 1
        JOIN toolbox_attendance a ON a.toolbox_id = t.id AND a.crew_member_id = cm.id
        WHERE t.status = 'published'
          ${sinceClause ? `AND t.held_at >= '${sinceClause}'` : ''}
      ) AS cover_pairs
  `).get();
  const tbRate = fmtPct(toolboxes.cover_pairs, toolboxes.denom);

  const quizzes = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM safety_quizzes
        WHERE status = 'published'
          AND (deadline_at IS NULL OR deadline_at > datetime('now'))
          ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS total_qz,
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) *
      (SELECT COUNT(*) FROM safety_quizzes
        WHERE status = 'published'
          AND (deadline_at IS NULL OR deadline_at > datetime('now'))
          ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS denom,
      (SELECT COUNT(DISTINCT q.id || ':' || a.crew_member_id) FROM safety_quizzes q
        JOIN safety_quiz_attempts a ON a.quiz_id = q.id AND a.status = 'submitted' AND a.passed = 1
        JOIN crew_members cm ON cm.id = a.crew_member_id AND cm.active = 1
        WHERE q.status = 'published'
          AND (q.deadline_at IS NULL OR q.deadline_at > datetime('now'))
          ${sinceClause ? `AND q.created_at >= '${sinceClause}'` : ''}
      ) AS pass_pairs
  `).get();
  const qzRate = fmtPct(quizzes.pass_pairs, quizzes.denom);

  const flags = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM safety_comments
        WHERE status != 'closed' ${sinceClause ? `AND created_at >= '${sinceClause}'` : ''}
      ) AS open_count,
      (SELECT COUNT(*) FROM safety_comments
        ${sinceClause ? `WHERE created_at >= '${sinceClause}'` : ''}
      ) AS total_count
  `).get();

  return {
    totalCrew,
    swms: { rate: swmsRate, total: swms.total_swms, acked: swms.acked_pairs, denom: swms.denom },
    updates: { rate: updRate, total: updates.total_updates, read: updates.read_pairs, denom: updates.denom },
    toolboxes: { rate: tbRate, total: toolboxes.total_tb, covered: toolboxes.cover_pairs, denom: toolboxes.denom },
    quizzes: { rate: qzRate, total: quizzes.total_qz, passed: quizzes.pass_pairs, denom: quizzes.denom },
    flags: { open: flags.open_count, total: flags.total_count },
  };
}

// Trend-style insights for the bottom of the dashboard.
function trendingInsights(since) {
  const db = getDb();
  const sinceClause = since ? `AND c.created_at >= '${since}'` : '';

  const topCategories = db.prepare(`
    SELECT category, COUNT(*) AS n
    FROM safety_comments c
    WHERE 1=1 ${sinceClause}
    GROUP BY category
    ORDER BY n DESC
    LIMIT 5
  `).all();

  // Most-wrong quiz questions: wrong_count + total answered for context.
  const wrongQuestions = db.prepare(`
    SELECT q.id, q.question_text, q.quiz_id, qz.title AS quiz_title,
      SUM(CASE WHEN a.is_correct = 0 THEN 1 ELSE 0 END) AS wrong_count,
      COUNT(a.id) AS answered_count
    FROM safety_quiz_answers a
    JOIN safety_quiz_questions q ON q.id = a.question_id
    JOIN safety_quizzes qz ON qz.id = q.quiz_id
    JOIN safety_quiz_attempts at ON at.id = a.attempt_id AND at.status = 'submitted'
    GROUP BY q.id
    HAVING wrong_count > 0
    ORDER BY wrong_count DESC, answered_count DESC
    LIMIT 8
  `).all();

  // SWMS with the lowest acknowledgement rate.
  const swmsLaggers = db.prepare(`
    SELECT s.id, s.title,
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) AS total_crew,
      (SELECT COUNT(*) FROM swms_acknowledgements a
        WHERE a.swms_id = s.id AND a.version_token = s.version_token
          AND EXISTS (SELECT 1 FROM crew_members cm WHERE cm.id = a.crew_member_id AND cm.active = 1)
      ) AS acked
    FROM swms s
    WHERE s.status = 'active'
    ORDER BY acked ASC, s.title
    LIMIT 5
  `).all().map(r => ({
    id: r.id, title: r.title, acked: r.acked, total: r.total_crew,
    rate: fmtPct(r.acked, r.total_crew),
  }));

  return { topCategories, wrongQuestions, swmsLaggers };
}

module.exports = {
  workerScores, aggregateStats, trendingInsights,
  WEIGHTS, DISENGAGED_THRESHOLD,
};
