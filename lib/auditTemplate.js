// lib/auditTemplate.js
// Runtime loader for the DB-backed versioned audit template. Resolves the
// version an audit should use, loads its sections + questions filtered by the
// audit's work_type / time_of_day, and adapts them for the form view and the
// scoring engine. Falls back to the legacy AUDIT_SECTIONS catalogue if no
// template has been seeded (so the form never breaks).

const { AUDIT_SECTIONS, SCORE_GROUPS, itemKey, WEIGHTS } = require('./auditQuestions');
const { TEMPLATE_CODE } = require('./auditTemplateSeed');

const DEFAULT_SCORE_GROUP_FOR_SECTION = (() => {
  const map = {};
  for (const g of SCORE_GROUPS) for (const k of g.sectionKeys) map[k] = g.label;
  return map;
})();

/**
 * The version a NEW audit should pin: the latest PUBLISHED version of the
 * primary template, else the latest version of any status (so a freshly seeded
 * draft is usable, behind a DRAFT banner). Returns null if no template exists.
 */
function getActiveTemplateVersion(db) {
  const tpl = db.prepare('SELECT id FROM audit_templates WHERE code = ?').get(TEMPLATE_CODE)
    || db.prepare('SELECT id FROM audit_templates ORDER BY id LIMIT 1').get();
  if (!tpl) return null;
  return db.prepare(`
    SELECT id, template_id, version_number, status
    FROM audit_template_versions
    WHERE template_id = ?
    ORDER BY (status = 'published') DESC, version_number DESC
    LIMIT 1
  `).get(tpl.id) || null;
}

function getVersionById(db, versionId) {
  if (!versionId) return null;
  return db.prepare('SELECT id, template_id, version_number, status FROM audit_template_versions WHERE id = ?').get(versionId) || null;
}

/**
 * Load the section/question tree for a version, filtered to the given context.
 * @param {object} opts { workType, timeOfDay, includeAll }
 * @returns sections: [{ key, title, score_group, questions: [{ key, text,
 *          scoring_mode, is_critical, risk_band, risk_weight, nsw_reference,
 *          competency_check_type }] }]
 */
function loadSections(db, versionId, { workType = null, timeOfDay = null, includeAll = false } = {}) {
  const sections = db.prepare(
    'SELECT id, section_key, title, score_group, sort_order FROM audit_template_sections WHERE template_version_id = ? ORDER BY sort_order, id'
  ).all(versionId);

  const filterByContext = !includeAll && workType && timeOfDay;
  const qStmt = filterByContext
    ? db.prepare(`
        SELECT * FROM audit_template_questions q
        WHERE q.section_id = ?
          AND (q.applies_all = 1 OR EXISTS (
            SELECT 1 FROM audit_question_applicability a
            WHERE a.question_id = q.id AND a.work_type = ? AND a.time_of_day = ?))
        ORDER BY q.sort_order, q.id`)
    : db.prepare('SELECT * FROM audit_template_questions q WHERE q.section_id = ? ORDER BY q.sort_order, q.id');

  return sections.map(s => {
    const rows = filterByContext ? qStmt.all(s.id, workType, timeOfDay) : qStmt.all(s.id);
    return {
      key: s.section_key,
      title: s.title,
      score_group: s.score_group,
      questions: rows.map(q => ({
        key: q.question_key,
        text: q.text,
        scoring_mode: q.scoring_mode,
        is_critical: !!q.is_critical,
        risk_band: q.risk_band,
        risk_weight: q.risk_weight,
        nsw_reference: q.nsw_reference || '',
        competency_check_type: q.competency_check_type || '',
      })),
    };
  });
}

// Legacy fallback shaped like loadSections() output (all site-level, Medium).
function legacySections() {
  return AUDIT_SECTIONS.map(s => ({
    key: s.key,
    title: s.title,
    score_group: DEFAULT_SCORE_GROUP_FOR_SECTION[s.key] || 'Documentation',
    questions: s.items.map((text, idx) => ({
      key: itemKey(s.key, idx),
      text,
      scoring_mode: 'site_level',
      is_critical: false,
      risk_band: 'Medium',
      risk_weight: WEIGHTS.Medium,
      nsw_reference: '',
      competency_check_type: '',
    })),
  }));
}

/** Flatten sections → the metadata array computeScore() expects in opts.questions. */
function toScoringQuestions(sections) {
  const out = [];
  for (const s of sections) {
    for (const q of s.questions) {
      out.push({
        key: q.key,
        score_group: s.score_group,
        scoring_mode: q.scoring_mode,
        is_critical: q.is_critical,
        risk_band: q.risk_band,
      });
    }
  }
  return out;
}

/**
 * One-stop resolver for a route: given an audit's pinned version (or the active
 * one) and its work context, return { version, sections, scoringQuestions,
 * isDraft, isLegacy }.
 */
function resolveForAudit(db, { versionId = null, workType = null, timeOfDay = null, includeAll = false } = {}) {
  let version = versionId ? getVersionById(db, versionId) : getActiveTemplateVersion(db);
  if (!version) {
    const sections = legacySections();
    return { version: null, sections, scoringQuestions: toScoringQuestions(sections), isDraft: false, isLegacy: true };
  }
  const sections = loadSections(db, version.id, { workType, timeOfDay, includeAll });
  return {
    version,
    sections,
    scoringQuestions: toScoringQuestions(sections),
    isDraft: version.status !== 'published',
    isLegacy: false,
  };
}

module.exports = {
  getActiveTemplateVersion, getVersionById, loadSections, legacySections,
  toScoringQuestions, resolveForAudit,
};
