// Payroll helpers — Traffio CSV parsing + bucket-based categorization for the
// Cash / TFN / ABN payroll page.
//
// Each pay_run_line stores `buckets_json`, an object keyed by bucket name with:
//   { hours: [Mon..Sun], total_hours, rate, total_wages }
//
// Bucket keys: day_normal, day_ot, day_dt, night_normal, night_ot, night_dt,
//              weekend, public_holiday
//
// Categorization rules (per-shift, NOT per-day cumulative):
//   * Saturday/Sunday → weekend (single rate, no OT split)
//   * Public holiday  → public_holiday (TFN only — ABN/Cash treat PH as regular)
//   * Weekday → day vs night by shift start time (>=18 or <06 = night)
//     - TFN: ≤8h normal, 8-10h OT, >10h DT
//     - ABN: ≤8h normal, >8h OT (no DT)
//     - Cash: all hours go to normal (no OT, no weekend rate)
//
// Allowances auto-computed for TFN only:
//   * travel_allowance = distinct_work_dates × rate_fares_daily (employee or classification)
//   * meal_allowance   = count_of_shifts_>=10h × rate_meal      (employee or classification)
//   * other_allowance  = manual entry, never auto

'use strict';

// ----------------------------------------------------------------------------
// CSV parser — handles fully-quoted Traffio export with embedded commas.
// ----------------------------------------------------------------------------
function parseCsv(text) {
  if (!text || typeof text !== 'string') return { headers: [], rows: [] };
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const records = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(field); field = '';
      if (!(row.length === 1 && row[0] === '')) records.push(row);
      row = []; i++; continue;
    }
    field += ch; i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) records.push(row);
  }

  if (records.length === 0) return { headers: [], rows: [] };
  const headers = records[0].map(h => (h || '').trim());
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const rec = records[r];
    if (rec.every(v => !v || !String(v).trim())) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = (rec[c] !== undefined ? rec[c] : '');
    rows.push(obj);
  }
  return { headers, rows };
}

function dowMonFirst(isoDate) {
  if (!isoDate) return -1;
  const d = new Date(isoDate + 'T00:00:00');
  if (isNaN(d.getTime())) return -1;
  return (d.getDay() + 6) % 7;
}

function isNightShift(timeOn) {
  if (!timeOn) return false;
  const m = String(timeOn).match(/^(\d{1,2}):/);
  if (!m) return false;
  const hr = parseInt(m[1], 10);
  if (isNaN(hr)) return false;
  return hr >= 18 || hr < 6;
}

// Decimal start hour (e.g. "06:45" -> 6.75). Defaults to 6 (day) when unparseable.
function parseStartHour(timeOn) {
  const m = String(timeOn || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 6;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!isFinite(h)) return 6;
  return h + (isFinite(min) ? min / 60 : 0);
}

// Split a single weekday shift's worked hours into chronological day/night
// segments by clock time. Office rules:
//   * Day rate applies 06:00–18:00; night rate applies 18:00–06:00.
//   * A shift starting in the 04:00–06:00 window has its pre-6am slice (≤2h)
//     at night, the balance at day; a later crossing of 18:00 flips back to night.
//   * A shift starting before 04:00 OR at/after 18:00 is a full night shift
//     (a genuine night worker isn't downgraded to day rate after 6am).
//   * A day shift that runs past 18:00 flips the post-6pm hours to night.
// Returns [{ hours, night }] summing to `hours`.
function splitDayNightSegments(timeOn, hours) {
  const h = toNum(hours);
  if (h <= 0) return [];
  const startHour = parseStartHour(timeOn);

  // Full night shift: before 4am or at/after 6pm.
  if (startHour < 4 || startHour >= 18) {
    return [{ hours: round2(h), night: true }];
  }

  const segs = [];
  let remaining = h;

  // Early-morning night slice, capped by the 06:00 boundary (≤2h since start≥4).
  if (startHour < 6) {
    const nightLead = Math.min(remaining, 6 - startHour);
    if (nightLead > 0) {
      segs.push({ hours: round2(nightLead), night: true });
      remaining = round2(remaining - nightLead);
    }
  }

  // Daytime hours until 18:00.
  if (remaining > 0) {
    const dayStart = Math.max(startHour, 6);
    const dayWindow = Math.max(0, 18 - dayStart);
    const dayHours = Math.min(remaining, dayWindow);
    if (dayHours > 0) {
      segs.push({ hours: round2(dayHours), night: false });
      remaining = round2(remaining - dayHours);
    }
  }

  // Anything past 18:00 is night again.
  if (remaining > 0) {
    segs.push({ hours: round2(remaining), night: true });
  }

  return segs;
}

// OT/DT tier bands (cumulative shift hours) per payment type. The rate-by-clock
// (day vs night) is orthogonal — these bands only decide normal/ot/dt.
function tierBands(paymentType) {
  if (paymentType === 'tfn') {
    return [{ upTo: 8, tier: 'normal' }, { upTo: 10, tier: 'ot' }, { upTo: Infinity, tier: 'dt' }];
  }
  if (paymentType === 'abn') {
    return [{ upTo: 8, tier: 'normal' }, { upTo: Infinity, tier: 'ot' }];
  }
  // cash / unclassified — no overtime split
  return [{ upTo: Infinity, tier: 'normal' }];
}

// Resolve a (day|night, tier) pair to a bucket key, falling back toward the
// normal bucket when the worker has no rate set for the OT/DT tier — there's
// no point banishing hours to a $0 column.
function resolveTierBucket(prefix, tier, rates) {
  const r = rates || {};
  if (tier === 'normal') return `${prefix}_normal`;
  if (tier === 'ot') {
    return toNum(r[`${prefix}_ot`]) > 0 ? `${prefix}_ot` : `${prefix}_normal`;
  }
  // dt → dt, else ot, else normal
  if (toNum(r[`${prefix}_dt`]) > 0) return `${prefix}_dt`;
  if (toNum(r[`${prefix}_ot`]) > 0) return `${prefix}_ot`;
  return `${prefix}_normal`;
}

function normalizeShift(row) {
  if (!row) return null;
  const isDeleted = String(row.is_deleted || '').trim() === '1';
  const excluded = String(row.person_exclude_from_payrun || '').trim() === '1';
  if (isDeleted || excluded) return null;

  const hours = parseFloat(row.hours_worked);
  if (!isFinite(hours) || hours <= 0) return null;

  const fullName = (row.full_name || '').trim() ||
                   ((row.first_name || '') + ' ' + (row.last_name || '')).trim();
  if (!fullName) return null;

  const dateIso = String(row.time_on_date || '').trim();
  const timeOn = String(row.time_on_time || '').trim();
  const dow = dowMonFirst(dateIso);
  if (dow < 0) return null;

  return {
    person_id: String(row.person_id || '').trim(),
    full_name: fullName,
    first_name: (row.first_name || '').trim(),
    last_name: (row.last_name || '').trim(),
    employee_reference: (row.employee_reference || '').trim(),
    is_subcontractor: String(row.person_is_sub_contractor || '').trim() === '1',
    booking_id: (row.booking_id || '').trim(),
    job_number: (row.job_number || '').trim(),
    client_name: (row.client_name || '').trim(),
    project_name: (row.project_name || '').trim(),
    booking_address: (row.booking_address || '').trim(),
    date: dateIso,
    time_on: timeOn,
    time_off: (row.time_off_time || '').trim(),
    hours,
    dow,
    night: isNightShift(timeOn),
    notes: (row.works_docket_notes || '').trim(),
  };
}

// ----------------------------------------------------------------------------
// Aggregate shifts by worker. Sorted alphabetically.
// ----------------------------------------------------------------------------
function aggregateByWorker(shifts) {
  const map = new Map();
  for (const s of shifts) {
    if (!s) continue;
    const key = s.person_id ? `pid:${s.person_id}` : `name:${s.full_name.toLowerCase()}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        person_id: s.person_id || '',
        full_name: s.full_name,
        first_name: s.first_name,
        last_name: s.last_name,
        employee_reference: s.employee_reference,
        is_subcontractor: !!s.is_subcontractor,
        shifts: [],
      };
      map.set(key, agg);
    }
    agg.shifts.push({
      booking_id: s.booking_id,
      job_number: s.job_number,
      date: s.date,
      time_on: s.time_on,
      time_off: s.time_off,
      hours: s.hours,
      dow: s.dow,
      night: s.night,
      client_name: s.client_name,
      project_name: s.project_name,
      booking_address: s.booking_address,
      notes: s.notes,
    });
  }
  const list = Array.from(map.values());
  list.sort((a, b) => a.full_name.localeCompare(b.full_name, 'en-AU', { sensitivity: 'base' }));
  return list;
}

function inferPeriod(shifts) {
  const dates = shifts.map(s => s.date).filter(Boolean).sort();
  if (dates.length === 0) {
    const today = formatLocalDate(new Date());
    return { period_start: today, period_end: today, dates: [] };
  }
  const earliest = dates[0];
  const d = new Date(earliest + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const start = formatLocalDate(d);
  d.setDate(d.getDate() + 6);
  const end = formatLocalDate(d);
  return { period_start: start, period_end: end, dates };
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ----------------------------------------------------------------------------
// Match a worker to an employee row.
// ----------------------------------------------------------------------------
function matchEmployee(db, agg) {
  if (agg.employee_reference) {
    const r = db.prepare(
      'SELECT * FROM employees WHERE employee_code = ? AND active = 1 LIMIT 1'
    ).get(agg.employee_reference);
    if (r) return r;
  }
  const lower = agg.full_name.toLowerCase();
  let r = db.prepare(
    'SELECT * FROM employees WHERE LOWER(full_name) = ? AND active = 1 LIMIT 1'
  ).get(lower);
  if (r) return r;
  if (agg.first_name && agg.last_name) {
    r = db.prepare(
      'SELECT * FROM employees WHERE LOWER(first_name) = ? AND LOWER(last_name) = ? AND active = 1 LIMIT 1'
    ).get(agg.first_name.toLowerCase(), agg.last_name.toLowerCase());
    if (r) return r;
  }
  return null;
}

function fetchClassification(db, classificationId) {
  if (!classificationId) return null;
  return db.prepare(
    'SELECT * FROM award_classifications WHERE id = ? AND active = 1 LIMIT 1'
  ).get(classificationId);
}

// ----------------------------------------------------------------------------
// Bucket categorization — the heart of the new model.
// ----------------------------------------------------------------------------
// Bucket order matters — it's what the pay-run UI iterates and the
// XLSX export reads. weekend_short sits in front of weekend so the
// 1.5× Sat rate is before the 2× Sat rate. night_5plus sits between
// night_dt and the weekend buckets so the night cluster reads
// "Night / Night OT / Night DT / Night 5+" left-to-right.
const BUCKETS = ['day_normal', 'day_ot', 'day_dt', 'night_normal', 'night_ot', 'night_dt', 'night_5plus', 'weekend_short', 'weekend', 'public_holiday'];

const BUCKET_LABELS = {
  day_normal:     'Day',
  day_ot:         'Day OT',
  day_dt:         'Day DT',
  night_normal:   'Night',
  night_ot:       'Night OT',
  night_dt:       'Night DT',
  night_5plus:    'Night 5+',
  weekend_short:  'Sat ≤2h',
  weekend:        'Sat >2h / Sun',
  public_holiday: 'Public Hol.',
};

const BUCKET_RATE_FIELDS = {
  day_normal:     { employee: 'rate_day',            classification: 'rate_day' },
  day_ot:         { employee: 'rate_ot',             classification: 'rate_day_ot' },
  day_dt:         { employee: 'rate_dt',             classification: 'rate_day_dt' },
  night_normal:   { employee: 'rate_night',          classification: 'rate_night' },
  night_ot:       { employee: 'rate_night_ot',       classification: 'rate_night_ot' },
  night_dt:       { employee: 'rate_night_dt',       classification: 'rate_night_dt' },
  night_5plus:    { employee: 'rate_night_5plus',    classification: 'rate_night' },
  weekend_short:  { employee: 'rate_weekend_short',  classification: 'rate_weekend' },
  weekend:        { employee: 'rate_weekend',        classification: 'rate_weekend' },
  public_holiday: { employee: 'rate_public_holiday', classification: 'rate_public_holiday' },
};

function emptyBucket(rate) {
  return { hours: [0, 0, 0, 0, 0, 0, 0], total_hours: 0, rate: round2(rate || 0), total_wages: 0 };
}
function emptyBuckets(rates = {}) {
  const o = {};
  for (const k of BUCKETS) o[k] = emptyBucket(rates[k]);
  return o;
}

// Resolve every bucket rate from {classification, employee} — classification wins
// when its value is > 0, otherwise fall back to the employee rate.
function resolveRates(employee, classification) {
  const out = {};
  for (const k of BUCKETS) {
    const fields = BUCKET_RATE_FIELDS[k];
    const cls = classification && toNum(classification[fields.classification]);
    const emp = employee && toNum(employee[fields.employee]);
    out[k] = cls > 0 ? cls : (emp > 0 ? emp : 0);
  }
  // Allowance rates
  const cmeal = classification && toNum(classification.rate_meal);
  const emeal = employee && toNum(employee.rate_meal);
  out.meal = cmeal > 0 ? cmeal : (emeal > 0 ? emeal : 0);
  const cfares = classification && toNum(classification.rate_fares_daily);
  const efares = employee && toNum(employee.rate_fares_daily);
  out.fares = cfares > 0 ? cfares : (efares > 0 ? efares : 0);
  // Per-worker allowance blocks zero the rate so it drops out of pay
  // everywhere (auto-allowances and any downstream total). The stored rate is
  // untouched — unblocking restores it. Hidden from the worker app separately.
  if (employee && employee.block_meal_allowance) out.meal = 0;
  if (employee && employee.block_travel_allowance) out.fares = 0;
  return out;
}

// Split a single shift's hours into bucket entries based on payment_type +
// whether the shift falls on a weekend / public holiday.
// Split a single shift into one or more bucket entries. ABN/TFN normally
// peel off OT/DT slices when a shift exceeds 8h/10h, but if the worker's
// matching OT/DT rate is unset (0 or missing) we keep the hours in the
// normal bucket — there's no point banishing hours to a $0 column. The
// resolved `rates` object is passed in so this decision is per-worker.
function splitShift(shift, paymentType, isPH, rates) {
  const hours = toNum(shift.hours);
  if (hours <= 0) return [];
  const dow = shift.dow;
  const isWeekend = dow >= 5; // Mon=0..Sun=6, so Sat=5 + Sun=6
  const r = rates || {};

  // TFN gets PH treatment (ABN/Cash do not — PH treated as regular weekday/weekend)
  if (paymentType === 'tfn' && isPH) {
    return [{ bucket: 'public_holiday', dow, hours }];
  }

  // TFN/ABN weekend
  //
  // BCG rule for casuals on Saturday: first 2 hours (or anything before
  // 12pm) attract a 1.5× loading, the balance attracts 2×. We split the
  // shift's hours between weekend_short (1.5×) and weekend (2×). The
  // 12pm check lives in the shift's time_on — if the worker started at
  // or after midday, every hour is "long".
  //
  // Sunday is flat 2× under the award, so it all goes into weekend
  // (which sits on the rate_weekend value = Sat>2h dominant rate; for
  // TFN tier presets these are equal, so no behavioural change).
  //
  // ABN/Cash keep a single Saturday rate — weekend_short stays 0 for
  // them and the rate resolver leaves rate_weekend_short empty. So we
  // only split when the worker actually has a non-zero short rate.
  if ((paymentType === 'tfn' || paymentType === 'abn') && isWeekend) {
    const isSat = dow === 5;
    const shortRate = toNum(r.weekend_short);
    if (isSat && shortRate > 0) {
      // Determine how many hours qualify as "short" (≤2h or before 12pm).
      // start hour drives the after-noon override: shifts starting at
      // 12pm+ skip the 1.5× entirely.
      const startHour = (() => {
        const m = String(shift.time_on || '').match(/^(\d{1,2}):/);
        const h = m ? parseInt(m[1], 10) : NaN;
        return isFinite(h) ? h : 0;
      })();
      if (startHour >= 12) {
        return [{ bucket: 'weekend', dow, hours }];
      }
      // Cap "short" at 2h, but never more than the shift itself, and
      // never push past 12pm — if the shift starts at 11am, the short
      // window closes after 1 hour.
      const hoursUntilNoon = Math.max(0, 12 - startHour);
      const shortHours = Math.min(hours, 2, hoursUntilNoon);
      const longHours  = round2(hours - shortHours);
      if (longHours <= 0) {
        return [{ bucket: 'weekend_short', dow, hours: shortHours }];
      }
      if (shortHours <= 0) {
        return [{ bucket: 'weekend', dow, hours }];
      }
      return [
        { bucket: 'weekend_short', dow, hours: shortHours },
        { bucket: 'weekend',       dow, hours: longHours },
      ];
    }
    return [{ bucket: 'weekend', dow, hours }];
  }

  // Weekday — split the shift into day/night segments by clock time, then
  // layer OT/DT bands by CUMULATIVE shift hours across both. Each resulting
  // piece is `${day|night}_${tier}`; the day vs night rate follows where the
  // hour sits on the clock, the tier follows how deep into the shift it is.
  const segments = splitDayNightSegments(shift.time_on, hours);

  // TFN Night 5+ — when annotateNightRuns has tagged this shift as part of a
  // 5+ Mon–Fri night run, its NIGHT hours go to the flat night_5plus bucket
  // (no OT/DT split). Any day-classified hours still follow the normal day
  // bands. Lower flat 5+ rate already accounts for losing the OT premium.
  const is5plus = paymentType === 'tfn'
    && shift._night_run_type === '5plus'
    && toNum(r.night_5plus) > 0;

  const bands = tierBands(paymentType);
  const out = [];
  let cum = 0; // hours accumulated so far across the whole shift

  for (const seg of segments) {
    const prefix = seg.night ? 'night' : 'day';
    let segRemaining = seg.hours;
    while (segRemaining > 0.0001) {
      const band = bands.find(b => cum < b.upTo) || bands[bands.length - 1];
      const room = band.upTo === Infinity ? segRemaining : round2(band.upTo - cum);
      const take = round2(Math.min(segRemaining, room));
      if (take <= 0) break;
      const bucket = (seg.night && is5plus)
        ? 'night_5plus'
        : resolveTierBucket(prefix, band.tier, r);
      out.push({ bucket, dow, hours: take });
      cum = round2(cum + take);
      segRemaining = round2(segRemaining - take);
    }
  }

  // Merge same-bucket pieces (e.g. two day_normal slices) so the buckets
  // object stays compact.
  const merged = new Map();
  for (const p of out) {
    const prev = merged.get(p.bucket);
    if (prev) prev.hours = round2(prev.hours + p.hours);
    else merged.set(p.bucket, { bucket: p.bucket, dow, hours: p.hours });
  }
  return Array.from(merged.values());
}

// Annotate each shift with `night_run_type` ('lt5' | '5plus') based on
// consecutive Mon–Fri night shifts. A run of 5+ consecutive nights
// (calendar days, no gaps) inside Mon–Fri promotes every shift in that
// run to '5plus'. Weekend nights (Sat/Sun) break the run and aren't
// counted as part of it — the PDF specifies "5+ in a row Mon–Fri".
//
// Only relevant when the worker has a non-zero rate_night_5plus —
// callers without a 5+ rate get no annotation (every shift falls into
// the normal night buckets). Mutates each shift in place by adding a
// non-enumerable `_night_run_type` field so the existing shifts_json
// payload doesn't change shape.
function annotateNightRuns(shifts, rates) {
  if (!Array.isArray(shifts) || shifts.length === 0) return;
  const fiveRate = rates && toNum(rates.night_5plus);
  if (!fiveRate || fiveRate <= 0) return;

  // Sort a copy by ISO date so we can scan consecutive calendar days.
  const indexed = shifts
    .map((s, i) => ({ s, i, ts: s && s.date ? Date.parse(s.date + 'T00:00:00') : NaN }))
    .filter(x => isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);

  // Walk runs of consecutive day-prev+1 nights on Mon–Fri.
  let runStart = 0;
  while (runStart < indexed.length) {
    let runEnd = runStart;
    const isCandidate = (x) => {
      const s = x.s;
      return !!s.night && (typeof s.dow === 'number' ? s.dow <= 4 : true);
    };
    if (!isCandidate(indexed[runStart])) { runStart++; continue; }
    // Extend the run while the next shift is the next calendar day AND
    // also a Mon–Fri night.
    while (runEnd + 1 < indexed.length) {
      const dayMs = 86400000;
      const next = indexed[runEnd + 1];
      const prev = indexed[runEnd];
      if (next.ts - prev.ts !== dayMs) break;
      if (!isCandidate(next)) break;
      runEnd++;
    }
    const runLen = runEnd - runStart + 1;
    if (runLen >= 5) {
      for (let k = runStart; k <= runEnd; k++) {
        Object.defineProperty(indexed[k].s, '_night_run_type', {
          value: '5plus', writable: true, enumerable: false, configurable: true,
        });
      }
    }
    runStart = runEnd + 1;
  }
}

// Build a fully-populated buckets object from a list of shifts. Hours bucketed
// per Mon..Sun, totals + wages computed for each non-empty bucket.
function buildBuckets(shifts, paymentType, rates, isPH) {
  const buckets = emptyBuckets(rates);
  // Pre-scan TFN shifts for 5+ Mon–Fri night runs so splitShift can
  // emit night_5plus for the shifts inside them. Other payment types
  // ignore the annotation (they don't read it).
  if (paymentType === 'tfn') annotateNightRuns(shifts, rates);
  for (const s of shifts || []) {
    const ph = typeof isPH === 'function' ? !!isPH(s.date) : false;
    const splits = splitShift(s, paymentType, ph, rates);
    for (const sp of splits) {
      const b = buckets[sp.bucket];
      if (!b) continue;
      b.hours[sp.dow] = round2(toNum(b.hours[sp.dow]) + sp.hours);
      b.total_hours = round2(toNum(b.total_hours) + sp.hours);
    }
  }
  for (const k of BUCKETS) {
    const b = buckets[k];
    b.total_wages = round2(toNum(b.total_hours) * toNum(b.rate));
  }
  return buckets;
}

function totalsFromBuckets(buckets) {
  let totalHours = 0, totalWages = 0;
  for (const k of BUCKETS) {
    if (buckets && buckets[k]) {
      totalHours += toNum(buckets[k].total_hours);
      totalWages += toNum(buckets[k].total_wages);
    }
  }
  return { total_hours: round2(totalHours), total_wages: round2(totalWages) };
}

// Auto-compute meal + fares allowances for any classified worker. Returns 0/0
// only for unclassified workers. Cash and ABN now also pull travel/meal rates
// from the worker rates page if set (defaults; per-line override still works).
// Also returns the rate × count breakdown so the UI can expose the calculation.
function computeAutoAllowances(shifts, paymentType, rates) {
  if (!['cash', 'tfn', 'abn'].includes(paymentType)) {
    return {
      travel: 0, meal: 0,
      travelRate: 0, travelCount: 0,
      mealRate: 0,   mealCount: 0,
    };
  }
  // Meal allowance triggers at 9.5h (office rule), not the old 10h cutoff.
  const dates = new Set();
  let longCount = 0;
  for (const s of shifts || []) {
    if (s.date) dates.add(s.date);
    if (toNum(s.hours) >= 9.5) longCount++;
  }
  const travelRate = toNum(rates.fares);
  const mealRate   = toNum(rates.meal);
  return {
    travel: round2(dates.size * travelRate),
    meal:   round2(longCount  * mealRate),
    travelRate,
    travelCount: dates.size,
    mealRate,
    mealCount: longCount,
  };
}

// ----------------------------------------------------------------------------
// Build a pay_run_line ready for INSERT.
// ----------------------------------------------------------------------------
function buildLine({ pay_run_id, agg, employee, classification, isPH }) {
  let pt = (employee && employee.payment_type) ? String(employee.payment_type).toLowerCase() : '';
  if (!pt && agg.is_subcontractor) pt = 'abn';
  if (!['cash', 'tfn', 'abn'].includes(pt)) pt = '';

  const rates = resolveRates(employee, classification);
  const buckets = buildBuckets(agg.shifts, pt, rates, isPH);
  const { total_hours, total_wages } = totalsFromBuckets(buckets);
  const auto = computeAutoAllowances(agg.shifts, pt, rates);
  const totalAllow = round2(auto.travel + auto.meal); // other = 0 on import
  const grand = round2(total_wages + totalAllow);

  return {
    pay_run_id,
    employee_id: employee ? employee.id : null,
    person_id: agg.person_id || '',
    full_name: agg.full_name,
    payment_type: pt,
    bsb: employee ? (employee.payroll_bsb || '') : '',
    acc_number: employee ? (employee.payroll_account || '') : '',
    buckets_json: JSON.stringify(buckets),
    // legacy mirror columns (kept so old callers don't blow up)
    day_hours_json:    JSON.stringify(buckets.day_normal.hours),
    night_hours_json:  JSON.stringify(buckets.night_normal.hours),
    total_day_hours:   buckets.day_normal.total_hours,
    total_night_hours: buckets.night_normal.total_hours,
    total_hours,
    rate_day:           buckets.day_normal.rate,
    rate_night:         buckets.night_normal.rate,
    total_day_wages:    buckets.day_normal.total_wages,
    total_night_wages:  buckets.night_normal.total_wages,
    total_wages,
    travel_allowance: auto.travel,
    meal_allowance:   auto.meal,
    other_allowance:  0,
    travel_rate:      auto.travelRate,
    travel_count:     auto.travelCount,
    meal_rate:        auto.mealRate,
    meal_count:       auto.mealCount,
    total_allowance:  totalAllow,
    total_deductions: 0,
    grand_total:      grand,
    paid: 0, paid_ref: '', paid_at: null, notes: '',
    shifts_json: JSON.stringify(agg.shifts),
    sort_order: 0,
  };
}

// Recompute totals + buckets when hours/rates/allowances are edited inline.
//   - If editedBuckets is supplied, use it directly (manual edit took place).
//   - Otherwise re-categorize from shifts_json using current payment_type +
//     resolved rates.  Allowances are taken from the merged line (so manual
//     edits to travel/meal/other persist).
function recomputeLine(line, { isPH } = {}) {
  let buckets = null;
  if (line.buckets_json) {
    try { buckets = JSON.parse(line.buckets_json); } catch (e) { buckets = null; }
  }

  // If no buckets present, materialize from shifts_json
  if (!buckets || typeof buckets !== 'object') {
    const shifts = safeParseJson(line.shifts_json, []);
    const rates = {
      day_normal: line.rate_day, day_ot: 0, day_dt: 0,
      night_normal: line.rate_night, night_ot: 0, night_dt: 0,
      weekend: 0, public_holiday: 0,
    };
    buckets = buildBuckets(shifts, line.payment_type || '', rates, isPH);
  }

  // Force-fix bucket shape + recompute totals from current rate × hours
  for (const k of BUCKETS) {
    if (!buckets[k]) buckets[k] = emptyBucket(0);
    if (!Array.isArray(buckets[k].hours) || buckets[k].hours.length !== 7) {
      buckets[k].hours = [0, 0, 0, 0, 0, 0, 0];
    }
    buckets[k].hours = buckets[k].hours.map(toNum).map(round2);
    buckets[k].total_hours = round2(buckets[k].hours.reduce((a, b) => a + toNum(b), 0));
    buckets[k].rate = round2(toNum(buckets[k].rate));
    buckets[k].total_wages = round2(buckets[k].total_hours * buckets[k].rate);
  }

  const { total_hours, total_wages } = totalsFromBuckets(buckets);
  const totalAllowance = round2(toNum(line.travel_allowance) + toNum(line.meal_allowance) + toNum(line.other_allowance));
  const totalDeductions = round2(toNum(line.total_deductions));
  const grand = round2(total_wages + totalAllowance - totalDeductions);

  return {
    buckets_json: JSON.stringify(buckets),
    // legacy mirror columns
    day_hours_json:    JSON.stringify(buckets.day_normal.hours),
    night_hours_json:  JSON.stringify(buckets.night_normal.hours),
    total_day_hours:   buckets.day_normal.total_hours,
    total_night_hours: buckets.night_normal.total_hours,
    total_day_wages:   buckets.day_normal.total_wages,
    total_night_wages: buckets.night_normal.total_wages,
    total_hours,
    total_wages,
    rate_day:   buckets.day_normal.rate,
    rate_night: buckets.night_normal.rate,
    total_allowance: totalAllowance,
    total_deductions: totalDeductions,
    grand_total: grand,
  };
}

// Re-categorize from shifts_json using employee/classification rates.
//   Used when payment_type changes, or when the user clicks "Refresh from shifts".
function recategorizeFromShifts(line, { paymentType, employee, classification, isPH }) {
  const shifts = safeParseJson(line.shifts_json, []);
  const rates = resolveRates(employee, classification);
  const pt = ['cash', 'tfn', 'abn'].includes(paymentType) ? paymentType : '';
  const buckets = buildBuckets(shifts, pt, rates, isPH);
  const auto = computeAutoAllowances(shifts, pt, rates);
  return { buckets, auto };
}

function safeParseJson(s, fallback) {
  try { const v = JSON.parse(s); return v == null ? fallback : v; } catch (e) { return fallback; }
}

function round2(n) { const v = parseFloat(n); if (!isFinite(v)) return 0; return Math.round(v * 100) / 100; }
function toNum(n) { const v = parseFloat(n); return isFinite(v) ? v : 0; }
function sum(arr) { let t = 0; for (const v of (arr || [])) t += toNum(v); return t; }

// ----------------------------------------------------------------------------
// Australian PAYG withholding — approximate weekly tax for a TFT-claimed
// resident. Based on ATO 2024-25 Schedule 1 simple bracket approximation
// plus 2% Medicare levy. Use as a guide on payslip displays — actual
// withholding can vary with offsets, HELP, second-job declarations, etc.
// ----------------------------------------------------------------------------
function payAsYouGoWeekly(grossWeekly) {
  const g = toNum(grossWeekly);
  if (g <= 0) return 0;
  const annual = g * 52;
  // Income tax (TFT claimed)
  let tax = 0;
  if (annual > 190000) tax += (annual - 190000) * 0.45;
  if (annual > 135000) tax += (Math.min(annual, 190000) - 135000) * 0.37;
  if (annual > 45000)  tax += (Math.min(annual, 135000) -  45000) * 0.30;
  if (annual > 18200)  tax += (Math.min(annual,  45000) -  18200) * 0.16;
  // Medicare levy — 2% above the low-income threshold (~$26,000)
  if (annual > 26000) tax += annual * 0.02;
  // Convert annual tax → weekly, round to whole dollar (ATO convention)
  return Math.round(tax / 52);
}

// Tax over an arbitrary period: convert to weekly first.
function payAsYouGo(grossPerPeriod, weeksInPeriod) {
  const w = parseFloat(weeksInPeriod) || 1;
  return round2(payAsYouGoWeekly(toNum(grossPerPeriod) / w) * w);
}

// Detect 5+ consecutive Mon–Fri night runs in a list of shifts and
// return the matched runs as date ranges. Doesn't mutate the input
// (annotateNightRuns is the in-place mutator used by the pay-run
// engine; this is the read-only form for UI surfaces like the worker
// dashboard "Night 5+ active" callout).
//
// Each shift needs at minimum: { date, dow, night }. dow uses the
// Mon=0..Sun=6 convention; if absent, derived from `date`. Returns
// an array of { start_date, end_date, length } sorted earliest first.
function findNightRuns(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) return [];
  const indexed = shifts
    .map(s => {
      const ts = s && s.date ? Date.parse(s.date + 'T00:00:00') : NaN;
      const dow = (typeof s.dow === 'number') ? s.dow : dowMonFirst(s && s.date);
      return { s, ts, dow };
    })
    .filter(x => isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts);

  const runs = [];
  let i = 0;
  while (i < indexed.length) {
    const isCandidate = (x) => !!x.s.night && x.dow <= 4;
    if (!isCandidate(indexed[i])) { i++; continue; }
    let j = i;
    const dayMs = 86400000;
    while (j + 1 < indexed.length
           && indexed[j + 1].ts - indexed[j].ts === dayMs
           && isCandidate(indexed[j + 1])) {
      j++;
    }
    const len = j - i + 1;
    if (len >= 5) {
      runs.push({
        start_date: indexed[i].s.date,
        end_date:   indexed[j].s.date,
        length:     len,
      });
    }
    i = j + 1;
  }
  return runs;
}

module.exports = {
  parseCsv,
  dowMonFirst,
  isNightShift,
  normalizeShift,
  aggregateByWorker,
  inferPeriod,
  matchEmployee,
  fetchClassification,
  buildBuckets,
  buildLine,
  recomputeLine,
  recategorizeFromShifts,
  computeAutoAllowances,
  payAsYouGoWeekly,
  payAsYouGo,
  resolveRates,
  totalsFromBuckets,
  emptyBucket,
  emptyBuckets,
  splitShift,
  splitDayNightSegments,
  parseStartHour,
  annotateNightRuns,
  findNightRuns,
  formatLocalDate,
  safeParseJson,
  BUCKETS,
  BUCKET_LABELS,
  BUCKET_RATE_FIELDS,
  round2,
  toNum,
  sum,
};
