// lib/auditTemplateSeed.js
// ─────────────────────────────────────────────────────────────────────────
// NSW-aligned Traffic Control Site Safety Audit — DRAFT template content.
//
// ⚠️  DRAFT WORDING. Every question string below is a strong baseline only and
// MUST be confirmed against the CURRENT TfNSW TCAWS (Traffic Control at Work
// Sites) Technical Manual by the STMS / RTO before the template version is
// PUBLISHED. The seed installs this as a `draft` version; the audit form shows
// a DRAFT banner until an authorised user publishes it.
//
// This file is the single source of truth that migration 294 reads to populate
// audit_templates / audit_template_sections / audit_template_questions /
// audit_question_applicability. Re-seeding is idempotent.
//
// Per-question metadata:
//   mode  'site_level' (one Yes/No for the whole crew) | 'per_person' (taggable)
//   crit  true → a 'No' forces an automatic Fail regardless of score
//   band  Low | Medium | High | Critical  (drives risk_weight via RISK_WEIGHTS)
//   wt    restrict to these work types (omit = all four)
//   tod   restrict to these times of day (omit = day+night)
//   nsw   TfNSW / AS reference or 'NSW GAP' for the newly-added checks
//   comp  competency_check_type — when set, the question is auto-evaluated from
//         employee_competencies rather than answered by hand
// ─────────────────────────────────────────────────────────────────────────

const TEMPLATE_CODE = 'TCAWS_SITE_AUDIT';
const TEMPLATE_NAME = 'Traffic Control Site Safety Audit';

// Risk band → numeric weight. Super-linear so a Critical 'No' dominates the
// score. Shared with the scoring engine (lib/auditQuestions.js). Tune with STMS.
const RISK_WEIGHTS = { Low: 1, Medium: 3, High: 7, Critical: 15 };

const WORK_TYPES = ['static', 'mobile', 'shoulder', 'intersection'];
const TIMES = ['day', 'night'];

// Compact question builder
function q(code, text, opts = {}) {
  const band = opts.band || (opts.crit ? 'Critical' : 'Medium');
  return {
    code,
    text,
    scoring_mode: opts.pp ? 'per_person' : 'site_level',
    is_critical: opts.crit ? 1 : 0,
    risk_band: band,
    risk_weight: RISK_WEIGHTS[band],
    nsw_reference: opts.nsw || '',
    competency_check_type: opts.comp || '',
    work_types: opts.wt || null, // null = all
    times: opts.tod || null,     // null = all
  };
}

// score_group must match the 6 SCORE_GROUPS labels in lib/auditQuestions.js
const SEED = {
  templateCode: TEMPLATE_CODE,
  templateName: TEMPLATE_NAME,
  version: 1,
  sections: [
    {
      key: 'S1', title: 'Pre-start Documentation', score_group: 'Documentation',
      questions: [
        q('S1.Q1', 'Current APPROVED TGS / TCP / TMP / CTMP available on site', { crit: true, nsw: 'TCAWS — TGS approval' }),
        q('S1.Q2', 'TGS prepared by an accredited TGS Designer (accreditation sighted / recorded)', { crit: true, nsw: 'NSW GAP — TfNSW accreditation' }),
        q('S1.Q3', 'Setup implemented by an accredited Implementer / Team Leader', { crit: true, nsw: 'NSW GAP — TfNSW accreditation' }),
        q('S1.Q4', 'Plan matches actual work activity being undertaken', { crit: true }),
        q('S1.Q5', 'SWMS / risk assessment available and relevant to task', { band: 'High', nsw: 'WHS Reg 2017 — HRCW SWMS' }),
        q('S1.Q6', 'All workers have signed onto the SWMS', { pp: true, band: 'High', nsw: 'NSW GAP — HRCW sign-on' }),
        q('S1.Q7', 'Road Occupancy Licence / road authority / client approval in place where required', { band: 'High', nsw: 'ROL' }),
        q('S1.Q8', 'Relevant permits / approvals in place', { band: 'Medium' }),
        q('S1.Q9', "Crew briefed on today's staging and traffic control arrangement", { band: 'Medium' }),
        q('S1.Q10', 'Pre-start / toolbox completed', { band: 'Medium' }),
        q('S1.Q11', 'Any on-site change to the TGS recorded and re-approved before implementation', { crit: true, nsw: 'NSW GAP — TGS amendment' }),
      ],
    },
    {
      key: 'S2', title: 'Competency and Authorisation', score_group: 'Worker competency / PPE',
      questions: [
        q('S2.Q1', 'Traffic controllers hold current required tickets / competencies', { pp: true, crit: true, comp: 'tc_ticket', nsw: 'TfNSW training scheme' }),
        q('S2.Q2', 'Implementers / supervisors are competent for the traffic setup in use', { pp: true, crit: true, comp: 'implementer_ticket' }),
        q('S2.Q3', 'Workers understand their assigned positions and responsibilities', { pp: true, band: 'Medium' }),
        q('S2.Q4', 'Traffic controllers formally appointed where directing traffic is required', { pp: true, band: 'High', wt: ['static', 'intersection'] }),
        q('S2.Q5', 'Suitable supervision is present on site', { band: 'High' }),
      ],
    },
    {
      key: 'S3', title: 'PPE and Worker Presentation', score_group: 'Worker competency / PPE',
      questions: [
        q('S3.Q1', 'Hi-vis clothing compliant and in good condition', { pp: true, crit: true }),
        q('S3.Q2', 'Hard hats worn where required', { pp: true, band: 'High' }),
        q('S3.Q3', 'Safety boots worn', { pp: true, band: 'Medium' }),
        q('S3.Q4', 'Radios / communication devices available and functioning', { pp: true, band: 'Medium' }),
        q('S3.Q5', 'Stop-slow bats / lights in good condition where used', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S3.Q6', 'PPE suitable for weather and site conditions', { pp: true, band: 'Medium' }),
        q('S3.Q7', 'Night wands available where required', { band: 'Medium', tod: ['night'] }),
        q('S3.Q8', 'Sunglasses for day works / clear safety glasses for night works', { pp: true, band: 'Low' }),
        q('S3.Q9', 'Gloves available and worn where required', { pp: true, band: 'Low' }),
      ],
    },
    {
      key: 'S4', title: 'Fit for Work and Fatigue', score_group: 'Worker competency / PPE',
      questions: [
        q('S4.Q1', 'Workers appear fit for work and not impaired', { pp: true, crit: true }),
        q('S4.Q2', 'Shift length within maximum hours / fatigue managed (especially night works)', { pp: true, crit: true, nsw: 'NSW GAP — fatigue' }),
        q('S4.Q3', 'Adequate breaks / rotation for controllers in position', { pp: true, band: 'High' }),
      ],
    },
    {
      key: 'S5', title: 'Site Setup Against Plan', score_group: 'Setup compliance',
      questions: [
        q('S5.Q1', 'Traffic control layout matches approved drawing', { crit: true }),
        q('S5.Q2', 'Work area clearly separated from live traffic', { crit: true }),
        q('S5.Q3', 'Adequate buffer / safety space maintained', { crit: true }),
        q('S5.Q4', 'Signs installed in correct sequence', { band: 'High', wt: ['static', 'shoulder', 'intersection'] }),
        q('S5.Q5', 'Signs installed at correct spacing', { band: 'High', wt: ['static', 'shoulder', 'intersection'] }),
        q('S5.Q6', 'Signs are facing approaching traffic correctly', { band: 'Medium' }),
        q('S5.Q7', 'Signs are clean, visible, and not damaged', { band: 'Medium' }),
        q('S5.Q8', 'Covers used correctly on irrelevant signs', { band: 'Low', wt: ['static', 'intersection'] }),
        q('S5.Q9', 'Tapers are correct length and shape', { band: 'High', wt: ['static', 'shoulder'] }),
        q('S5.Q10', 'Cones / bollards / delineation installed correctly', { band: 'Medium' }),
        q('S5.Q11', 'Barriers installed where shown on plan', { band: 'High', wt: ['static', 'shoulder'] }),
        q('S5.Q12', 'Speed zoning implemented as approved', { band: 'High' }),
        q('S5.Q13', 'Temporary traffic signals / portable lights operating correctly if used', { band: 'High', wt: ['static', 'intersection'] }),
        q('S5.Q14', 'Arrow boards / VMS / lighting towers positioned correctly if used', { band: 'Medium' }),
        q('S5.Q15', 'Side streets / driveways managed correctly', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S5.Q16', 'Plant access / work zone separation is maintained', { band: 'High' }),
      ],
    },
    {
      key: 'S6', title: 'Safety of the Work Zone', score_group: 'Setup compliance',
      questions: [
        q('S6.Q1', 'No exposed hazards within pedestrian or traffic path', { band: 'High' }),
        q('S6.Q2', 'Materials and equipment stored safely', { band: 'Medium' }),
        q('S6.Q3', 'No trip hazards in pedestrian route', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S6.Q4', 'Plant movements controlled and visible', { band: 'High' }),
        q('S6.Q5', 'Reversing controls in place where required', { band: 'High' }),
        q('S6.Q6', 'Access / egress for workers and vehicles is safe', { band: 'High' }),
        q('S6.Q7', 'Public protected from moving plant and site activities', { band: 'High' }),
      ],
    },
    {
      key: 'S7', title: 'Traffic Controller Operations', score_group: 'Traffic operations',
      questions: [
        q('S7.Q1', 'Controllers positioned safely and visibly', { pp: true, crit: true, wt: ['static', 'intersection'] }),
        q('S7.Q2', 'No controller standing in an unsafe location', { pp: true, crit: true, wt: ['static', 'intersection'] }),
        q('S7.Q3', 'Controllers have clear sight distance to approaching traffic', { pp: true, band: 'High', wt: ['static', 'intersection'] }),
        q('S7.Q4', 'Traffic released in a controlled and coordinated manner', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S7.Q5', 'Queue lengths monitored', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S7.Q6', 'Radios functioning between controllers', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S7.Q7', 'Heavy vehicles / oversized vehicles managed safely', { band: 'Medium' }),
        q('S7.Q8', 'Emergency vehicles can be accommodated', { band: 'High' }),
        q('S7.Q9', 'No distraction from phones or non-work activity', { pp: true, band: 'High', wt: ['static', 'intersection'] }),
      ],
    },
    {
      key: 'S8', title: 'Vehicle and Equipment Checks', score_group: 'Equipment / vehicles',
      questions: [
        q('S8.Q1', 'Traffic vehicles parked legally and safely', { band: 'Medium' }),
        q('S8.Q2', 'Flashing lights working where fitted', { band: 'Medium' }),
        q('S8.Q3', 'Utes / TMA / trucks positioned as per plan', { band: 'High', wt: ['mobile', 'shoulder'] }),
        q('S8.Q4', 'TMA used where required and in correct location', { crit: true, wt: ['mobile', 'shoulder'] }),
        q('S8.Q5', 'Arrow board functioning and displaying correct mode', { band: 'Medium', wt: ['mobile', 'shoulder'] }),
        q('S8.Q6', 'VMS message correct and legible if used', { band: 'Medium' }),
        q('S8.Q7', 'Portable lighting adequate for night works', { band: 'High', tod: ['night'] }),
      ],
    },
    {
      key: 'S9', title: 'Pedestrian, Cyclist and Public Interface', score_group: 'Public safety',
      questions: [
        q('S9.Q1', 'Safe pedestrian route maintained', { band: 'High', wt: ['static', 'intersection'] }),
        q('S9.Q2', 'Disability access considered and maintained where possible', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S9.Q3', 'Footpaths not blocked without approved diversion', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S9.Q4', 'Temporary crossings safe and clear', { band: 'Medium', wt: ['static', 'intersection'] }),
        q('S9.Q5', 'Cyclist management addressed where relevant', { band: 'Medium', wt: ['static', 'shoulder', 'intersection'] }),
        q('S9.Q6', 'Nearby residents / businesses access maintained or controlled', { band: 'Low', wt: ['static'] }),
        q('S9.Q7', 'Bus stops / school zones / public interfaces managed appropriately', { band: 'Medium', wt: ['static', 'intersection'] }),
      ],
    },
    {
      key: 'S10', title: 'Emergency and Incident Readiness', score_group: 'Public safety',
      questions: [
        q('S10.Q1', 'Emergency response plan available on site', { crit: true, nsw: 'NSW GAP — re-instated' }),
        q('S10.Q2', 'Emergency contacts (including road authority / police) available', { band: 'High' }),
        q('S10.Q3', 'First-aid kit on site and accessible; first-aider identified', { band: 'High', comp: 'first_aid' }),
        q('S10.Q4', 'Spill kit / environmental response materials available where required', { band: 'Medium' }),
        q('S10.Q5', 'Site access point / RV for emergency services identified', { band: 'Medium' }),
        q('S10.Q6', 'Incident reporting process understood by crew', { band: 'Medium' }),
      ],
    },
    {
      key: 'S11', title: 'Environmental and Site Conditions', score_group: 'Public safety',
      questions: [
        q('S11.Q1', 'Weather conditions considered in control setup', { band: 'Medium' }),
        q('S11.Q2', 'Wind has not affected signs or delineation', { band: 'Medium' }),
        q('S11.Q3', 'Dust, mud, water, or debris not impacting road users', { band: 'Medium' }),
        q('S11.Q4', 'Lighting adequate for dawn, dusk, or night works', { band: 'High', tod: ['night'] }),
      ],
    },
  ],
};

/**
 * Idempotently seed the DRAFT v1 template into the DB. Safe to call on every
 * boot — does nothing once version 1 exists with questions.
 * @returns {{templateId:number, versionId:number, seeded:boolean}}
 */
function seedTemplate(db, { createdById = null } = {}) {
  // Template row
  let tpl = db.prepare('SELECT id FROM audit_templates WHERE code = ?').get(SEED.templateCode);
  if (!tpl) {
    const info = db.prepare(
      'INSERT INTO audit_templates (code, name, description, created_by_id) VALUES (?, ?, ?, ?)'
    ).run(SEED.templateCode, SEED.templateName, 'NSW TCAWS-aligned site safety audit (DRAFT — confirm wording with STMS/RTO).', createdById);
    tpl = { id: info.lastInsertRowid };
  }

  // Version 1 (draft)
  let ver = db.prepare('SELECT id FROM audit_template_versions WHERE template_id = ? AND version_number = ?')
    .get(tpl.id, SEED.version);
  if (!ver) {
    const info = db.prepare(
      "INSERT INTO audit_template_versions (template_id, version_number, status, notes, created_by_id) VALUES (?, ?, 'draft', ?, ?)"
    ).run(tpl.id, SEED.version, 'Initial NSW-aligned draft — pending STMS/RTO wording confirmation before publish.', createdById);
    ver = { id: info.lastInsertRowid };
  }

  // If the version already has questions, treat as fully seeded.
  const existing = db.prepare('SELECT COUNT(*) c FROM audit_template_questions WHERE template_version_id = ?').get(ver.id).c;
  if (existing > 0) return { templateId: tpl.id, versionId: ver.id, seeded: false };

  const insSection = db.prepare(
    'INSERT INTO audit_template_sections (template_version_id, section_key, title, score_group, sort_order) VALUES (?, ?, ?, ?, ?)'
  );
  const insQuestion = db.prepare(`
    INSERT INTO audit_template_questions
      (template_version_id, section_id, question_key, text, scoring_mode, risk_weight, risk_band, is_critical, nsw_reference, competency_check_type, applies_all, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insApplic = db.prepare(
    'INSERT OR IGNORE INTO audit_question_applicability (question_id, work_type, time_of_day) VALUES (?, ?, ?)'
  );

  const tx = db.transaction(() => {
    SEED.sections.forEach((sec, si) => {
      const secInfo = insSection.run(ver.id, sec.key, sec.title, sec.score_group, si);
      const sectionId = secInfo.lastInsertRowid;
      sec.questions.forEach((qq, qi) => {
        const restricted = qq.work_types || qq.times;
        const appliesAll = restricted ? 0 : 1;
        const qInfo = insQuestion.run(
          ver.id, sectionId, qq.code, qq.text, qq.scoring_mode, qq.risk_weight, qq.risk_band,
          qq.is_critical, qq.nsw_reference, qq.competency_check_type, appliesAll, qi
        );
        if (!appliesAll) {
          const wts = qq.work_types || WORK_TYPES;
          const tods = qq.times || TIMES;
          for (const wt of wts) for (const tod of tods) insApplic.run(qInfo.lastInsertRowid, wt, tod);
        }
      });
    });
  });
  tx();

  return { templateId: tpl.id, versionId: ver.id, seeded: true };
}

module.exports = { SEED, RISK_WEIGHTS, WORK_TYPES, TIMES, TEMPLATE_CODE, seedTemplate };
