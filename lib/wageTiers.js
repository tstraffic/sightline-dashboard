// Wage tier resolution + stamping.
//
//   The FY26 Internal Wage Panel (wage_tier_presets) is the canonical
//   source for what a worker on a given (tier, payment_type) gets paid.
//   This module is the thin layer that:
//
//     1. Resolves the preset row for a (tier, payment_type) pair.
//     2. Maps the panel's PDF-shape columns onto the older employee
//        rate_* columns the existing pay-run engine still reads.
//     3. Stamps an employee's rate_* columns from a preset on approve
//        / re-stamp.
//
//   Mapping rules (Cash / ABN map straight across; TFN folds 7 penalty
//   columns into the 4 existing buckets — the dominant case wins, with
//   OT/DT derived from base. A later refactor of lib/payroll.js can
//   read the full 7-column PDF shape directly).

'use strict';

const TIER_META = {
  1: { role_label: 'Trainee TC',         award_mapping: 'CW1(a)',             qualifications: 'RIIWHS205 only, first 90 days' },
  2: { role_label: 'Traffic Controller', award_mapping: 'CW1(c)',             qualifications: 'RIIWHS205 + 90+ days experience' },
  3: { role_label: 'Advanced TC / TMA',  award_mapping: 'CW2 / CW3',          qualifications: 'RIIWHS302 + MR/HR licence' },
  4: { role_label: 'Team Leader',        award_mapping: 'CW3 + Leading Hand', qualifications: 'Small crew leadership' },
  5: { role_label: 'Senior Team Leader', award_mapping: 'CW4 + Leading Hand', qualifications: 'Multi-crew leadership' },
  6: { role_label: 'Site Supervisor',    award_mapping: 'CW5 + Leading Hand', qualifications: 'Full project oversight' },
};

const PAYMENT_TYPES = ['cash', 'abn', 'tfn'];

function tierMeta(tier) {
  const t = parseInt(tier, 10);
  return TIER_META[t] || null;
}

// Latest active preset for a given (tier, payment_type), honouring
// effective_from. Returns null if no row matches — the caller should
// flash an error so the admin can rerun the seed migration.
function getPreset(db, tier, paymentType) {
  const t = parseInt(tier, 10);
  const pt = String(paymentType || '').toLowerCase();
  if (!t || t < 1 || t > 6 || !PAYMENT_TYPES.includes(pt)) return null;
  return db.prepare(`
    SELECT * FROM wage_tier_presets
    WHERE tier = ? AND payment_type = ? AND active = 1
    ORDER BY effective_from DESC
    LIMIT 1
  `).get(t, pt) || null;
}

// All active presets, grouped { cash: [...], abn: [...], tfn: [...] } in
// tier order. Handy for the admin Wage Tiers page + the modal preview.
function listActivePresets(db) {
  const rows = db.prepare(`
    SELECT * FROM wage_tier_presets
    WHERE active = 1
    ORDER BY payment_type, tier ASC
  `).all();
  const grouped = { cash: [], abn: [], tfn: [] };
  for (const r of rows) {
    if (grouped[r.payment_type]) grouped[r.payment_type].push(r);
  }
  return grouped;
}

// Global allowance lookup by code. Used so TFN gets the right meal +
// fares values straight from the award_allowances table without the
// admin having to mirror them per-tier.
function getAllowance(db, code) {
  return db.prepare('SELECT * FROM award_allowances WHERE code = ? AND active = 1').get(code) || null;
}

function r2(n) {
  const v = parseFloat(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 100) / 100;
}

const NIGHT_PATTERNS = ['occasional', 'permanent', 'continuous_5plus'];

// Pick the right TFN night rate from a preset based on the worker's
// roster pattern. Defaults to Night<5 (occasional) — per the FY26
// panel's note that "most T&S night shifts attract the Night <5 rate".
function pickTfnNightRate(preset, nightPattern) {
  const np = NIGHT_PATTERNS.includes(nightPattern) ? nightPattern : 'occasional';
  if (np === 'permanent')        return r2(preset.rate_night_perm);
  if (np === 'continuous_5plus') return r2(preset.rate_night_5plus);
  return r2(preset.rate_night);
}

// Map a wage_tier_presets row + payment_type to the rate_* columns the
// existing pay-run engine reads from employees.
//
//   * Cash — Day & Night only; OT/DT/weekend/PH all zero (the engine
//            already special-cases Cash and stuffs everything into the
//            normal buckets).
//   * ABN  — Day, Sat (= weekend single rate), Night (= Night/Sun/PH).
//            No OT, no weekend_short split.
//   * TFN  — base (= Day), Sat≤2h (= weekend_short, first-2h rule),
//            Sat>2h (= weekend, dominant), PH (= public_holiday),
//            Night<5/Perm/5+ (= night, picked by night_pattern). OT/DT
//            derived from base × 1.5 / × 2.0 (BCG casual ordinary OT).
//
// Returns an object keyed by employees.rate_* columns. Allowances row
// is optional — when supplied it overrides the Cash/ABN per-shift
// travel from the preset and seeds the TFN fares/meal from the global
// table.
function mapPresetToEmployeeRates(preset, paymentType, allowances, opts) {
  if (!preset) return null;
  const pt = String(paymentType || '').toLowerCase();
  const fares = allowances && allowances.fares ? r2(allowances.fares) : 0;
  const meal  = allowances && allowances.meal  ? r2(allowances.meal)  : 0;
  const base = r2(preset.rate_day);
  const nightPattern = (opts && opts.nightPattern) || 'occasional';

  if (pt === 'cash') {
    return {
      rate_day: r2(preset.rate_day),
      rate_ot: 0, rate_dt: 0,
      rate_night: r2(preset.rate_night),
      rate_night_ot: 0, rate_night_dt: 0,
      rate_night_5plus: 0,
      rate_weekend: 0,
      rate_weekend_short: 0,
      rate_public_holiday: 0,
      // Cash now carries BOTH travel + meal as per-tier presets (migration 295).
      rate_meal: r2(preset.meal_allowance),
      rate_fares_daily: r2(preset.travel_allowance),
    };
  }

  if (pt === 'abn') {
    return {
      rate_day: r2(preset.rate_day),
      rate_ot: 0, rate_dt: 0,
      rate_night: r2(preset.rate_night),
      rate_night_ot: 0, rate_night_dt: 0,
      rate_night_5plus: 0,
      rate_weekend: r2(preset.rate_sat_long),
      rate_weekend_short: 0, // ABN doesn't split Sat per the panel
      rate_public_holiday: r2(preset.rate_sun),
      // ABN meal preset (defaults 0 → no behaviour change unless set).
      rate_meal: r2(preset.meal_allowance),
      rate_fares_daily: r2(preset.travel_allowance),
    };
  }

  if (pt === 'tfn') {
    // rate_night_5plus is only populated when the worker's pattern is
    // 'occasional' — that's when auto-detection can promote a shift
    // from rate_night ($50.77 Night<5) to the lower 5+ rate ($40.61).
    // For 'permanent' the rate_night is already $44.97, and for
    // 'continuous_5plus' it's already $40.61, so there's nothing to
    // promote — leaving rate_night_5plus at 0 keeps the engine's
    // detector idle.
    const np = NIGHT_PATTERNS.includes(nightPattern) ? nightPattern : 'occasional';
    return {
      rate_day: base,
      // BCG casual OT: ordinary × 1.5 / × 2.0. base already includes the
      // 25% casual loading + industry allowance from the panel.
      rate_ot: r2(base * 1.5),
      rate_dt: r2(base * 2.0),
      rate_night: pickTfnNightRate(preset, nightPattern),
      rate_night_ot: 0, rate_night_dt: 0,
      rate_night_5plus: np === 'occasional' ? r2(preset.rate_night_5plus) : 0,
      rate_weekend: r2(preset.rate_sat_long),           // Sat >2h
      rate_weekend_short: r2(preset.rate_sat_short),    // Sat ≤2h (1.5×)
      rate_public_holiday: r2(preset.rate_public_holiday),
      rate_meal: meal,
      rate_fares_daily: fares,
    };
  }

  return null;
}

// Stamp the rate_* columns on an employee row from the matching preset.
// Returns { ok, rates, preset } — `rates` is the resolved rate map,
// `preset` is the source row (for audit). When the preset is missing
// the function leaves the row untouched and reports ok:false.
//
// opts.nightPattern overrides the worker's stored night_pattern (used
// when the admin is changing pattern + tier in the same form submit).
//
// opts.force re-stamps even when the worker's rates were hand-overridden.
// Without it, a worker carrying rates_overridden=1 is left untouched and
// the function reports { ok:false, overridden:true } so the caller can
// confirm before clobbering manual values. A successful stamp clears the
// override flag (the rates once again match the tier preset).
function stampEmployeeRates(db, employeeId, tier, paymentType, opts) {
  const eid = parseInt(employeeId, 10);
  if (!eid) return { ok: false, error: 'no employee id' };
  const preset = getPreset(db, tier, paymentType);
  if (!preset) return { ok: false, error: 'no preset for (tier, payment_type)' };

  // Guard hand-overridden rates unless the caller forces a re-stamp.
  const force = !!(opts && opts.force);
  if (!force) {
    try {
      const cur = db.prepare('SELECT rates_overridden FROM employees WHERE id = ?').get(eid);
      if (cur && cur.rates_overridden) return { ok: false, overridden: true, error: 'rates overridden' };
    } catch (e) { /* column missing on stale deploy — proceed */ }
  }

  // Pull global allowances for TFN rate_meal / rate_fares_daily (no
  // effect for Cash/ABN — see mapPresetToEmployeeRates).
  const fares = getAllowance(db, 'fares_daily');
  const meal  = getAllowance(db, 'meal');
  const allowances = {
    fares: fares ? fares.amount : 0,
    meal:  meal  ? meal.amount  : 0,
  };

  // Honour an explicit nightPattern in opts; otherwise read the column
  // off the employee row (legacy rows without it default to occasional).
  let nightPattern = (opts && opts.nightPattern) || null;
  if (!nightPattern) {
    try {
      const row = db.prepare('SELECT night_pattern FROM employees WHERE id = ?').get(eid);
      nightPattern = row && row.night_pattern ? row.night_pattern : 'occasional';
    } catch (e) { nightPattern = 'occasional'; }
  }

  const rates = mapPresetToEmployeeRates(preset, paymentType, allowances, { nightPattern });
  if (!rates) return { ok: false, error: 'rate map failed' };

  // Only set columns that actually exist on this deploy.
  const empCols = new Set(db.prepare("PRAGMA table_info(employees)").all().map(c => c.name));
  const sets = [];
  const params = [];
  for (const [col, val] of Object.entries(rates)) {
    if (empCols.has(col)) {
      sets.push(`${col} = ?`);
      params.push(val);
    }
  }
  // Also persist tier + payment_type so future re-stamps are deterministic.
  if (empCols.has('tier')) {
    sets.push('tier = ?');
    params.push(parseInt(tier, 10));
  }
  if (empCols.has('payment_type')) {
    sets.push('payment_type = ?');
    params.push(String(paymentType).toLowerCase());
  }
  if (empCols.has('night_pattern')) {
    sets.push('night_pattern = ?');
    params.push(NIGHT_PATTERNS.includes(nightPattern) ? nightPattern : 'occasional');
  }
  // A fresh stamp means the rates again match the tier preset → clear the
  // override guard so the worker tracks future panel changes.
  if (empCols.has('rates_overridden')) sets.push('rates_overridden = 0');
  if (empCols.has('updated_at')) sets.push('updated_at = CURRENT_TIMESTAMP');

  if (!sets.length) return { ok: false, error: 'no writable columns' };

  db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...params, eid);
  return { ok: true, rates, preset };
}

// True when a set of submitted rate_* values diverges from the canonical
// preset for (row.tier, row.payment_type, row.night_pattern). Shared by the
// Worker-Rates grid and the roster-profile rate editor so both decide
// employees.rates_overridden the same way. No tier / no preset → false
// (nothing to diverge from). `row` only needs the rate keys it wants checked.
function ratesDivergeFromPreset(db, row) {
  try {
    const tier = parseInt(row.tier, 10);
    const pt = String(row.payment_type || '').toLowerCase();
    if (!(tier >= 1 && tier <= 6) || !PAYMENT_TYPES.includes(pt)) return false;
    const preset = getPreset(db, tier, pt);
    if (!preset) return false;
    const np = NIGHT_PATTERNS.includes(String(row.night_pattern || '').toLowerCase())
      ? String(row.night_pattern).toLowerCase() : 'occasional';
    const fares = getAllowance(db, 'fares_daily');
    const meal = getAllowance(db, 'meal');
    const expected = mapPresetToEmployeeRates(preset, pt, {
      fares: fares ? fares.amount : 0,
      meal: meal ? meal.amount : 0,
    }, { nightPattern: np });
    if (!expected) return false;
    for (const [k, v] of Object.entries(expected)) {
      if (row[k] === undefined || row[k] === null || row[k] === '') continue;
      if (Math.abs((parseFloat(row[k]) || 0) - (parseFloat(v) || 0)) > 0.005) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

module.exports = {
  TIER_META,
  PAYMENT_TYPES,
  NIGHT_PATTERNS,
  tierMeta,
  getPreset,
  listActivePresets,
  getAllowance,
  mapPresetToEmployeeRates,
  pickTfnNightRate,
  stampEmployeeRates,
  ratesDivergeFromPreset,
};
