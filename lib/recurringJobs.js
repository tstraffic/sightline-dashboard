// Monthly package jobs.
//
// Some clients book the same shape of work each month — Labour
// Connect's "May - Packages" pattern is the motivating case. The
// "Monthly package" toggle on the project form lets the planner
// pick a pattern name (e.g. "Packages") and tick the months they
// want jobs created for. POST /projects then mints one job per
// selected month, all sharing the same client / suburb / PM /
// stage, named "<Month> - <pattern>" with start_date set to the
// 1st of that month.
//
// All siblings carry recurring_monthly = 1 + the same
// recurring_pattern_name so they're easy to recognise on the
// register (a ♻ badge in the UI).

'use strict';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Build the per-month name: "<Month> - <pattern>".
// e.g. monthlyJobName('May', 'Packages') → "May - Packages"
function monthlyJobName(monthName, pattern) {
  const safe = (pattern || '').toString().trim() || 'Packages';
  return monthName + ' - ' + safe;
}

// Build the multi-month name for the "combined" mode (a single job
// that spans multiple selected months). Tries to be readable:
//   1 month            → "May - Packages"
//   contiguous range   → "May–July - Packages"
//   ≤ 3 non-contiguous → "May, Jul, Sep - Packages"
//   > 3 non-contiguous → "Multiple months - Packages"
function combinedMonthsJobName(monthList, pattern) {
  const safe = (pattern || '').toString().trim() || 'Packages';
  if (!monthList || !monthList.length) return safe;
  if (monthList.length === 1) return monthList[0].name + ' - ' + safe;

  // Detect contiguous run.
  const sorted = monthList.slice().sort((a, b) => a.index - b.index);
  let contiguous = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].index !== sorted[i - 1].index + 1) { contiguous = false; break; }
  }
  if (contiguous) return sorted[0].name + '–' + sorted[sorted.length - 1].name + ' - ' + safe;
  if (sorted.length <= 3) return sorted.map(m => m.name.slice(0, 3)).join(', ') + ' - ' + safe;
  return 'Multiple months - ' + safe;
}

// First of the named month for the given year, as YYYY-MM-DD.
function firstOfMonth(year, monthIndex0) {
  const m = String(monthIndex0 + 1).padStart(2, '0');
  return year + '-' + m + '-01';
}

// Normalise whatever the form sent for months_selected into a sorted
// array of {index, name}. Accepts month names ("May") or short codes
// ("May" or "may") — duplicates dropped, unknowns ignored.
function parseSelectedMonths(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    if (!v) continue;
    const s = String(v).trim();
    let idx = MONTH_NAMES.findIndex(n => n.toLowerCase() === s.toLowerCase());
    if (idx < 0) idx = MONTH_SHORT.findIndex(n => n.toLowerCase() === s.toLowerCase());
    if (idx < 0) continue;
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push({ index: idx, name: MONTH_NAMES[idx] });
  }
  return out.sort((a, b) => a.index - b.index);
}

module.exports = { MONTH_NAMES, MONTH_SHORT, monthlyJobName, combinedMonthsJobName, firstOfMonth, parseSelectedMonths };

