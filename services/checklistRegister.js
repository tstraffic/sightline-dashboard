// Checklist Register: aggregates submitted safety_forms against expected
// counts derived from bookings + crew_allocations, broken down by week and
// month. Replaces the manual spreadsheet the office was keeping.
//
// Required-count heuristics (matched to the spreadsheet the office kept):
//   - Vehicle Pre-Start         → 1 per booking (per ute) for the week
//   - Post-Shift Vehicle        → 1 per booking
//   - Risk Assessment & Toolbox → 1 per allocation (each worker)
//   - TC Prestart Declaration   → 1 per allocation
//   - Team Leader Checklist     → 1 per allocation
//
// "Required" is computed from bookings whose start_datetime falls inside the
// window AND have status NOT IN ('cancelled','late_cancellation') so
// cancelled work doesn't bloat the denominator.
//
// "Completed" counts safety_forms.submitted_at inside the window, filtered to
// the right form_type. We don't bind to a specific allocation so that a
// crew member who completes a form against the right shift but with a tiny
// timestamp drift still counts.

const FORM_TYPES = [
  { key: 'vehicle_prestart',   label: 'Vehicle Pre-start',           per: 'booking' },
  { key: 'risk_toolbox',       label: 'Risk Assessment & Toolbox',   per: 'allocation' },
  { key: 'tc_prestart',        label: 'TC Pre-start Declaration',    per: 'allocation' },
  { key: 'team_leader',        label: 'Team Leader Checklist',       per: 'allocation' },
  { key: 'post_shift_vehicle', label: 'Post-shift Vehicle Checklist', per: 'booking' },
];

// Format a Date to YYYY-MM-DD in Australia/Sydney local calendar — matters for
// the office's idea of which day a shift "belongs to" (we don't want
// midnight-AEST shifts to slide into the wrong week).
function ymd(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

const { sydneyOffsetForDate } = require('../lib/sydney');

// safety_forms.submitted_at is stored as UTC ('YYYY-MM-DD HH:MM:SS' via
// datetime('now')), but every window here is bounded by Sydney-local dates.
// Comparing date(submitted_at) — the UTC day — against those bounds shoved
// any form submitted 00:00–~10:00 Sydney into the previous day's window.
// Convert the Sydney-midnight bound to its UTC instant instead (DST-safe via
// sydneyOffsetForDate).
function utcBound(sydneyYmd) {
  return new Date(sydneyYmd + 'T00:00:00' + sydneyOffsetForDate(sydneyYmd))
    .toISOString().replace('T', ' ').slice(0, 19);
}

// Monday-anchored ISO-ish week: returns { start, end } as Date objects
// covering the Monday→Sunday containing `d`.
function weekRangeFor(d) {
  const x = new Date(d.getTime());
  const day = (x.getDay() + 6) % 7; // 0=Mon..6=Sun
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - day);
  const start = new Date(x);
  const end = new Date(x);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

// Counts bookings AND allocations whose booked start falls inside [from, to)
// and aren't cancelled. Returns { bookings, allocations }.
function countWindow(db, from, to) {
  const fromS = ymd(from);
  const toS = ymd(to);
  const b = db.prepare(`
    SELECT COUNT(*) AS c FROM bookings
    WHERE date(start_datetime) >= date(?) AND date(start_datetime) < date(?)
      AND (deleted_at IS NULL)
      AND status NOT IN ('cancelled','late_cancellation')
  `).get(fromS, toS).c;
  // Only allocations the worker accepted/worked count toward expected
  // checklists. Pending requests, declines and cancellations don't ever
  // produce a Job-Pack — so counting them would unfairly drag the
  // compliance % down for shifts the worker never actually started.
  const a = db.prepare(`
    SELECT COUNT(*) AS c FROM crew_allocations ca
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE date(ca.allocation_date) >= date(?) AND date(ca.allocation_date) < date(?)
      AND ca.status IN ('confirmed','completed')
      AND (b.id IS NULL OR (b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')))
  `).get(fromS, toS).c;
  return { bookings: b, allocations: a };
}

// Counts safety_forms submitted inside [from, to) per form_type.
// Bounds are UTC instants of Sydney midnight (see utcBound); datetime()
// normalises stored values so 'YYYY-MM-DD HH:MM:SS' and ISO-T both compare.
function countCompletions(db, from, to) {
  const rows = db.prepare(`
    SELECT form_type, COUNT(*) AS c FROM safety_forms
    WHERE datetime(submitted_at) >= datetime(?) AND datetime(submitted_at) < datetime(?)
    GROUP BY form_type
  `).all(utcBound(ymd(from)), utcBound(ymd(to)));
  const out = {};
  for (const r of rows) out[r.form_type] = r.c;
  return out;
}

// Required count for a given form_type given a {bookings, allocations} window.
function requiredFor(form, window) {
  return form.per === 'booking' ? window.bookings : window.allocations;
}

// Roll up one window into the spreadsheet shape:
//   [{ key, label, required, completed, completion_pct }]
function computeWindow(db, from, to) {
  const w = countWindow(db, from, to);
  const c = countCompletions(db, from, to);
  return FORM_TYPES.map(form => {
    const required = requiredFor(form, w);
    const completed = c[form.key] || 0;
    const pct = required > 0 ? Math.round((Math.min(completed, required) / required) * 100) : 0;
    return {
      key: form.key,
      label: form.label,
      required,
      completed,
      completion_pct: pct,
      // Surface the over-completion case (rare but possible — e.g. a worker
      // re-submits because the first save failed) so the office can spot it.
      over: completed > required,
    };
  });
}

// Public API ---------------------------------------------------------------

// Whole register for a given calendar month: month total + each ISO-ish week.
function registerForMonth(db, year, monthIdx /* 0-11 */) {
  const monthStart = new Date(year, monthIdx, 1);
  const monthEnd = new Date(year, monthIdx + 1, 1);

  const total = computeWindow(db, monthStart, monthEnd);

  // Walk Monday→Monday until we leave the month. A "week" anchored to the
  // last Monday of the prior month still belongs in this month if its body
  // falls inside the month, but for the office's spreadsheet they only want
  // weeks whose start falls in this month — which is what we mirror here.
  const weeks = [];
  let cursor = weekRangeFor(monthStart).start;
  // If the week of the 1st starts in the previous month, slide forward one
  // week so Week 1 is the first Monday on or after the 1st (matches the
  // sample spreadsheet: "Week 1" of January started on Mon 5 Jan, not 29 Dec).
  if (cursor < monthStart) cursor.setDate(cursor.getDate() + 7);
  let n = 1;
  while (cursor < monthEnd) {
    const next = new Date(cursor);
    next.setDate(next.getDate() + 7);
    const winStart = cursor;
    const winEnd = next > monthEnd ? monthEnd : next;
    weeks.push({
      n,
      start: ymd(winStart),
      end: ymd(new Date(winEnd.getTime() - 86400000)),
      rows: computeWindow(db, winStart, winEnd),
    });
    cursor = next;
    n++;
  }

  return { year, monthIdx, total, weeks };
}

// Compact summary of the current month for the dashboard widget.
function dashboardSummary(db) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthRows = computeWindow(db, monthStart, monthEnd);

  // Last calendar week (Mon→Sun ending most recently)
  const today = new Date(); today.setHours(0,0,0,0);
  const thisWeek = weekRangeFor(today);
  const lastWeekStart = new Date(thisWeek.start); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = thisWeek.start;
  const lastWeekRows = computeWindow(db, lastWeekStart, lastWeekEnd);

  return {
    monthLabel: now.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', month: 'long', year: 'numeric' }),
    month: monthRows,
    lastWeekRange: ymd(lastWeekStart) + ' → ' + ymd(new Date(lastWeekEnd.getTime() - 86400000)),
    lastWeek: lastWeekRows,
  };
}

// Per-worker breakdown for a window. For each crew member with at least one
// non-cancelled allocation in [from, to), how many of each form_type did they
// submit vs how many they were "expected" to file.
//
// Expected counts per worker:
//   - per='allocation' forms (Risk, TC Prestart, Team Leader): one expected
//     submission for every allocation the worker had in the window.
//   - per='booking' forms (Vehicle Pre-Start, Post-Shift Vehicle): one
//     expected submission for every distinct booking_id the worker was on
//     (not every allocation — a worker doing two slots on one booking still
//     drives one ute, fills out one pre-start). Allocations without a
//     booking_id fall back to the allocation count.
function workerBreakdown(db, from, to) {
  const fromS = ymd(from);
  const toS = ymd(to);

  // 1. Worker → allocation count + distinct booking count in the window.
  const allocRows = db.prepare(`
    SELECT ca.crew_member_id AS id, cm.full_name AS name,
      COUNT(*) AS allocations,
      COUNT(DISTINCT COALESCE(ca.booking_id, -ca.id)) AS bookings
    FROM crew_allocations ca
    LEFT JOIN crew_members cm ON ca.crew_member_id = cm.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE date(ca.allocation_date) >= date(?) AND date(ca.allocation_date) < date(?)
      AND ca.status IN ('confirmed','completed')
      AND (b.id IS NULL OR (b.deleted_at IS NULL AND b.status NOT IN ('cancelled','late_cancellation')))
    GROUP BY ca.crew_member_id, cm.full_name
  `).all(fromS, toS);

  // 2. Worker → form_type → submitted count. Same UTC-instant bounds as
  // countCompletions — submitted_at is UTC, the window is Sydney-local.
  const subRows = db.prepare(`
    SELECT crew_member_id, form_type, COUNT(*) AS c
    FROM safety_forms
    WHERE datetime(submitted_at) >= datetime(?) AND datetime(submitted_at) < datetime(?)
    GROUP BY crew_member_id, form_type
  `).all(utcBound(fromS), utcBound(toS));
  const subBy = {};
  for (const r of subRows) {
    (subBy[r.crew_member_id] = subBy[r.crew_member_id] || {})[r.form_type] = r.c;
  }

  return allocRows.map(w => {
    const forms = FORM_TYPES.map(form => {
      const expected = form.per === 'booking' ? w.bookings : w.allocations;
      const submitted = (subBy[w.id] && subBy[w.id][form.key]) || 0;
      const pct = expected > 0 ? Math.round((Math.min(submitted, expected) / expected) * 100) : 0;
      return { key: form.key, label: form.label, expected, submitted, pct };
    });
    // Overall = capped sum / sum of expected, weighted by expected.
    const totalExpected = forms.reduce((a, f) => a + f.expected, 0);
    const totalSubmitted = forms.reduce((a, f) => a + Math.min(f.submitted, f.expected), 0);
    const overall = totalExpected > 0 ? Math.round((totalSubmitted / totalExpected) * 100) : 0;
    return {
      id: w.id,
      name: w.name || '#' + w.id,
      allocations: w.allocations,
      bookings: w.bookings,
      forms,
      overall,
    };
  }).sort((a, b) => b.overall - a.overall || b.allocations - a.allocations);
}

// Auto-generate spreadsheet-style "Notes" for each form type given a worker
// breakdown — highest / lowest completion + names of anyone who missed every
// expected submission. Returns { [form_type]: 'note string' }.
function notesFromBreakdown(workers) {
  const notes = {};
  for (const form of FORM_TYPES) {
    const eligible = workers.filter(w => w.forms.find(f => f.key === form.key && f.expected > 0));
    if (!eligible.length) { notes[form.key] = ''; continue; }
    const ranked = eligible.map(w => {
      const f = w.forms.find(x => x.key === form.key);
      return { name: w.name, pct: f.pct, expected: f.expected, submitted: f.submitted };
    }).sort((a, b) => b.pct - a.pct || b.submitted - a.submitted);
    const top = ranked.filter(r => r.pct === ranked[0].pct).slice(0, 3).map(r => r.name);
    const bottom = ranked.filter(r => r.pct === ranked[ranked.length - 1].pct && r.pct < ranked[0].pct).slice(0, 3).map(r => r.name);
    const missed = ranked.filter(r => r.submitted === 0).slice(0, 5).map(r => r.name);

    const parts = [];
    if (ranked[0].pct === 100 && ranked[ranked.length - 1].pct === 100) {
      parts.push('All workers at 100%.');
    } else {
      if (top.length) parts.push('Highest: ' + top.join(', ') + '.');
      if (bottom.length) parts.push('Lowest: ' + bottom.join(', ') + '.');
    }
    if (missed.length && missed.length < eligible.length) parts.push('Missing: ' + missed.join(', ') + '.');
    notes[form.key] = parts.join(' ');
  }
  return notes;
}

module.exports = { FORM_TYPES, registerForMonth, dashboardSummary, workerBreakdown, notesFromBreakdown };
