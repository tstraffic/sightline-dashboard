// Single source of truth for the Recruitment pipeline stage model.
//
// Replaces the old flat tracker's redundant booleans (called / interested /
// induction_booked) + free-text status with ONE ordered stage. Each forward
// stage implies all earlier ones — a BOOKED candidate has, by definition, been
// called and is interested, so we never store those as separate facts.
//
// Used by routes/recruitment.js (board + list + counts), the induction
// calendar view, and services/inductionReminders.js so the pipeline can't
// drift between where it's written and where it's read.

// Ordered forward pipeline. Index = progression; "at or beyond" comparisons
// use this order.
const FORWARD_STAGES = ['NEW', 'CALLED', 'INTERESTED', 'BOOKED', 'INDUCTED', 'HIRED'];

// Terminal / dead-end states reachable from anywhere. Not part of the forward
// order — they sit in the collapsed "Closed" column.
const TERMINAL_STAGES = ['NO_SHOW', 'DECLINED'];

const ALL_STAGES = [...FORWARD_STAGES, ...TERMINAL_STAGES];

// Human labels for board columns / pills.
const STAGE_LABELS = {
  NEW:        'New',
  CALLED:     'Called',
  INTERESTED: 'Interested',
  BOOKED:     'Booked',
  INDUCTED:   'Inducted',
  HIRED:      'Hired',
  NO_SHOW:    'No Show',
  DECLINED:   'Declined',
};

function isTerminal(stage) {
  return TERMINAL_STAGES.includes(stage);
}

// Position in the forward pipeline. Terminal stages return -1 (they're off the
// linear track), unknown stages normalise to NEW (0).
function stageIndex(stage) {
  const i = FORWARD_STAGES.indexOf(stage);
  if (i !== -1) return i;
  if (isTerminal(stage)) return -1;
  return 0; // unknown → treat as NEW
}

// "Is this candidate at `target` stage or further along the forward pipeline?"
// Terminal candidates are never "at or beyond" a forward stage — they've left
// the active funnel.
function isAtOrBeyond(stage, target) {
  if (isTerminal(stage)) return false;
  return stageIndex(stage) >= stageIndex(target);
}

function normalizeStage(stage) {
  const s = String(stage || '').toUpperCase().trim();
  return ALL_STAGES.includes(s) ? s : 'NEW';
}

// Derived booleans — display-only. Presence of a date OR having reached the
// stage both count, so migrated rows with a date but a lower stage still read
// correctly (and vice versa).
function derive(a) {
  const stage = normalizeStage(a.stage);
  const onCalendar = !!a.induction_date && !isTerminal(stage);
  return {
    stage,
    wasCalled:   !!a.date_called   || isAtOrBeyond(stage, 'CALLED'),
    isInterested: isAtOrBeyond(stage, 'INTERESTED'),
    isBooked:    !!a.induction_date || isAtOrBeyond(stage, 'BOOKED'),
    isOnCalendar: onCalendar,
    // Booked (or further) but no induction date = a broken handoff worth
    // surfacing, not hiding. Terminal stages are excluded.
    needsScheduling: isAtOrBeyond(stage, 'BOOKED') && !a.induction_date,
  };
}

// SQL CASE expression that maps a legacy row (status + the three booleans +
// dates) to a single stage. Evaluated top-down, first match wins — mirrors the
// migration spec. Kept here so the one-off migration and any future backfill
// agree on the mapping.
const LEGACY_TO_STAGE_SQL = `
  CASE
    WHEN LOWER(COALESCE(status,'')) = 'hired'                              THEN 'HIRED'
    WHEN LOWER(COALESCE(status,'')) = 'inducted'                          THEN 'INDUCTED'
    WHEN LOWER(COALESCE(status,'')) = 'no show'                           THEN 'NO_SHOW'
    WHEN LOWER(COALESCE(status,'')) IN ('not suitable','withdrew')        THEN 'DECLINED'
    WHEN LOWER(COALESCE(induction_booked,'')) = 'yes'
         OR induction_date IS NOT NULL
         OR LOWER(COALESCE(status,'')) = 'induction scheduled'            THEN 'BOOKED'
    WHEN LOWER(COALESCE(interested,'')) = 'yes'                           THEN 'INTERESTED'
    WHEN LOWER(COALESCE(called,'')) = 'yes'
         OR date_called IS NOT NULL
         OR LOWER(COALESCE(status,'')) = 'contacted'                      THEN 'CALLED'
    ELSE 'NEW'
  END
`;

module.exports = {
  FORWARD_STAGES,
  TERMINAL_STAGES,
  ALL_STAGES,
  STAGE_LABELS,
  isTerminal,
  stageIndex,
  isAtOrBeyond,
  normalizeStage,
  derive,
  LEGACY_TO_STAGE_SQL,
};
