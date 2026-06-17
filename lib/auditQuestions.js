// Traffic Control Site Safety Audit — question catalog + scoring engine.
//
// Two scoring models live here:
//   • LEGACY (flat): computeScore(responses) with no metadata — Yes=1, No=0,
//     N/A excluded, every question equal. Preserved verbatim so existing
//     audits and any caller that doesn't pass template metadata keep working.
//   • WEIGHTED (v2): computeScore(responses, { questions, onSiteCount }) —
//     risk-weighted, per-person fractional, critical-item auto-fail, with an
//     auto-suggested Finding. Used by the redesigned, template-driven form.
//
// The legacy AUDIT_SECTIONS array remains the seed source for the DB template
// (lib/auditTemplateSeed.js) and the fallback question set when no published
// template is available.

const { RISK_WEIGHTS } = require('./auditTemplateSeed');

const AUDIT_SECTIONS = [
  { key: '1', title: 'Pre-start Documentation', items: [
    'Current approved TGS / TCP / TMP / CTMP available on site',
    'Plan matches actual work activity being undertaken',
    'SWMS / risk assessment available and relevant to task',
    'Relevant permits / approvals in place',
    'Road Occupancy Licence or client approval in place where required',
    "Crew briefed on today's staging and traffic control arrangement",
    'Pre-start / toolbox completed',
    'Emergency contacts available',
  ] },
  { key: '2', title: 'Competency and Authorisation', items: [
    'Traffic controllers hold the required current tickets / competencies',
    'Implementers / supervisors are competent for the traffic setup in use',
    'Workers understand their assigned positions and responsibilities',
    'Traffic controllers are formally appointed where directing traffic is required',
    'Suitable supervision is present on site',
  ] },
  { key: '3', title: 'PPE and Worker Presentation', items: [
    'Hi-vis clothing compliant and in good condition',
    'Hard hats worn where required',
    'Safety boots worn',
    'Radios / communication devices available and functioning',
    'Stop-slow bats / lights in good condition where used',
    'PPE suitable for weather and site conditions',
    'Workers appear fit for work and not fatigued',
    'Night wands available where required',
    'Sunglasses for day works / clear safety glasses for night works',
    'Gloves available and worn where required',
  ] },
  { key: '4', title: 'Site Setup Against Plan', items: [
    'Traffic control layout matches approved drawing',
    'Signs installed in correct sequence',
    'Signs installed at correct spacing',
    'Signs are facing approaching traffic correctly',
    'Signs are clean, visible, and not damaged',
    'Covers used correctly on irrelevant signs',
    'Tapers are correct length and shape',
    'Cones / bollards / delineation installed correctly',
    'Barriers installed where shown on plan',
    'Plant access / work zone separation is maintained',
    'Pedestrian path is maintained or detour provided',
    'Cyclist management addressed where relevant',
    'Side streets / driveways managed correctly',
    'Speed zoning implemented as approved',
    'Temporary traffic signals / portable lights operating correctly if used',
    'Arrow boards / VMS / lighting towers positioned correctly if used',
    'Changes to setup formally assessed and authorised',
  ] },
  { key: '5', title: 'Safety of the Work Zone', items: [
    'Work area clearly separated from live traffic',
    'Adequate buffer / safety space maintained',
    'No exposed hazards within pedestrian or traffic path',
    'Materials and equipment stored safely',
    'No trip hazards in pedestrian route',
    'Plant movements controlled and visible',
    'Reversing controls in place where required',
    'Access/egress for workers and vehicles is safe',
    'Public protected from moving plant and site activities',
  ] },
  { key: '6', title: 'Traffic Controller Operations', items: [
    'Controllers positioned safely and visibly',
    'Controllers have clear sight distance to approaching traffic',
    'No controller standing in an unsafe location',
    'Traffic released in a controlled and coordinated manner',
    'Queue lengths monitored',
    'Radios functioning between controllers',
    'Heavy vehicles / oversized vehicles managed safely',
    'Emergency vehicles can be accommodated',
    'No distraction from phones or non-work activity',
  ] },
  { key: '7', title: 'Vehicle and Equipment Checks', items: [
    'Traffic vehicles parked legally and safely',
    'Flashing lights working where fitted',
    'Utes / TMA / trucks positioned as per plan',
    'TMA used where required and in correct location',
    'Arrow board functioning and displaying correct mode',
    'VMS message correct and legible if used',
    'Portable lighting adequate for night works',
  ] },
  { key: '8', title: 'Pedestrian and Public Interface', items: [
    'Safe pedestrian route maintained',
    'Disability access considered and maintained where possible',
    'Footpaths not blocked without approved diversion',
    'Temporary crossings safe and clear',
    'Nearby residents / businesses access maintained or controlled',
    'Bus stops / school zones / public interfaces managed appropriately',
  ] },
  { key: '9', title: 'Environmental and Site Conditions', items: [
    'Weather conditions considered in control setup',
    'Wind has not affected signs or delineation',
    'Dust, mud, water, or debris not impacting road users',
    'Lighting adequate for dawn, dusk, or night works',
  ] },
];

// The 6 scoring areas shown on the audit summary. score_group on each template
// question maps to these labels; legacy sections map via sectionKeys.
const SCORE_GROUPS = [
  { label: 'Documentation',            sectionKeys: ['1'] },
  { label: 'Setup compliance',         sectionKeys: ['4'] },
  { label: 'Worker competency / PPE',  sectionKeys: ['2', '3'] },
  { label: 'Traffic operations',       sectionKeys: ['6'] },
  { label: 'Public safety',            sectionKeys: ['5', '8', '9'] },
  { label: 'Equipment / vehicles',     sectionKeys: ['7'] },
];
const GROUP_LABELS = SCORE_GROUPS.map(g => g.label);

// Risk weighting (super-linear so a Critical 'No' dominates). Single source in
// auditTemplateSeed.js; surfaced here for callers + the client recalc().
const WEIGHTS = RISK_WEIGHTS;

// Finding thresholds — tune with STMS.
const FINDING_THRESHOLDS = { failBelow: 75, passAtOrAbove: 95 };

function itemKey(sectionKey, idx) {
  return `${sectionKey}.${idx + 1}`;
}

// Normalise legacy response shape ({ checked, na }) to a state string.
function normaliseState(r) {
  if (!r) return '';
  if (r.state) return r.state;
  if (r.na) return 'na';
  if (r.checked) return 'yes';
  return '';
}

function weightFor(band) {
  return WEIGHTS[band] != null ? WEIGHTS[band] : WEIGHTS.Medium;
}

/**
 * Derive the suggested overall finding.
 * criticalFail always wins. openActions = unresolved 'No's + tagged exceptions.
 */
function deriveFinding({ percent, openActions, criticalFail }) {
  if (criticalFail) return 'fail';
  if (percent < FINDING_THRESHOLDS.failBelow) return 'fail';
  if (openActions > 0 || percent < FINDING_THRESHOLDS.passAtOrAbove) return 'pass_with_actions';
  return 'pass';
}

// ── LEGACY flat scorer (unchanged behaviour) ─────────────────────────────
function computeScoreFlat(responses) {
  responses = responses || {};
  const groups = SCORE_GROUPS.map(g => {
    let score = 0, max = 0;
    for (const secKey of g.sectionKeys) {
      const section = AUDIT_SECTIONS.find(s => s.key === secKey);
      if (!section) continue;
      section.items.forEach((_, idx) => {
        const state = normaliseState(responses[itemKey(secKey, idx)]);
        if (state === 'na' || state === '') return;
        max++;
        if (state === 'yes') score++;
      });
    }
    return { label: g.label, score, max, percent: max ? Math.round((score / max) * 100) : 0 };
  });
  const total = groups.reduce((a, g) => a + g.score, 0);
  const max = groups.reduce((a, g) => a + g.max, 0);
  const percent = max ? Math.round((total / max) * 100) : 0;
  return { groups, total, max, percent, weighted: false };
}

// ── WEIGHTED v2 scorer (template-driven) ─────────────────────────────────
// opts.questions: [{ key, score_group, scoring_mode|scope, is_critical, risk_band }]
// opts.onSiteCount: default crew size for per_person items
function computeScoreWeighted(responses, questions, onSiteCount) {
  responses = responses || {};
  const groupMap = {};
  GROUP_LABELS.forEach(l => { groupMap[l] = { label: l, score: 0, max: 0, weightedScore: 0, weightedMax: 0 }; });

  let openActions = 0;
  let criticalFail = false;
  const criticalFailKeys = [];

  for (const q of questions) {
    const label = GROUP_LABELS.includes(q.score_group) ? q.score_group : GROUP_LABELS[0];
    const g = groupMap[label];
    const r = responses[q.key] || {};
    const scope = q.scoring_mode || q.scope || 'site_level';
    const state = normaliseState(r);
    const isCritical = !!q.is_critical;
    const overridden = !!r.critical_override; // auditor lifted the auto-fail with a justification

    if (scope === 'per_person') {
      const onSite = Number(r.on_site_count != null ? r.on_site_count : onSiteCount) || 0;
      // N/A or no crew → excluded from scoring entirely (like a flat N/A)
      if (state === 'na' || onSite <= 0) continue;
      const exceptions = Array.isArray(r.exceptions) ? r.exceptions : [];
      const compliant = Math.max(0, onSite - exceptions.length);
      const frac = onSite > 0 ? compliant / onSite : 1;
      const wq = weightFor(q.risk_band);
      g.weightedMax += wq;
      g.weightedScore += wq * frac;
      g.max += 1;
      g.score += frac;
      openActions += exceptions.length;
      if (isCritical && !overridden && exceptions.some(e => e.risk_level === 'Critical')) {
        criticalFail = true; criticalFailKeys.push(q.key);
      }
    } else {
      // site-level
      if (state === 'na' || state === '') continue; // excluded (N/A may carry na_reason)
      const band = state === 'no' ? (r.risk_level || q.risk_band) : q.risk_band;
      const wq = weightFor(band);
      g.weightedMax += wq;
      g.max += 1;
      if (state === 'yes') { g.weightedScore += wq; g.score += 1; }
      else { // 'no'
        openActions += 1;
        if (isCritical && !overridden) { criticalFail = true; criticalFailKeys.push(q.key); }
      }
    }
  }

  const groups = GROUP_LABELS.map(l => {
    const g = groupMap[l];
    return {
      label: l,
      score: Math.round(g.score * 10) / 10,
      max: g.max,
      weightedScore: Math.round(g.weightedScore * 100) / 100,
      weightedMax: g.weightedMax,
      percent: g.weightedMax ? Math.round((g.weightedScore / g.weightedMax) * 100) : 0,
    };
  }).filter(g => g.max > 0);

  const weightedScore = groups.reduce((a, g) => a + g.weightedScore, 0);
  const weightedMax = groups.reduce((a, g) => a + g.weightedMax, 0);
  const weightedPercent = weightedMax ? Math.round((weightedScore / weightedMax) * 100) : 0;
  // flat totals kept for the legacy header counters / columns
  const total = Math.round(groups.reduce((a, g) => a + g.score, 0));
  const max = groups.reduce((a, g) => a + g.max, 0);

  const suggestedFinding = deriveFinding({ percent: weightedPercent, openActions, criticalFail });

  return {
    groups, total, max,
    percent: weightedPercent, weightedPercent,
    weightedScore: Math.round(weightedScore * 100) / 100, weightedMax,
    criticalFail, criticalFailKeys, openActions, suggestedFinding,
    weighted: true,
  };
}

/**
 * Unified entry point. Pass opts.questions (with metadata) for the weighted
 * model; omit it for the legacy flat model.
 */
function computeScore(responses, opts = {}) {
  if (opts && Array.isArray(opts.questions) && opts.questions.length) {
    return computeScoreWeighted(responses, opts.questions, opts.onSiteCount);
  }
  return computeScoreFlat(responses);
}

module.exports = {
  AUDIT_SECTIONS, SCORE_GROUPS, GROUP_LABELS, WEIGHTS, FINDING_THRESHOLDS,
  itemKey, normaliseState, weightFor, deriveFinding, computeScore,
};
