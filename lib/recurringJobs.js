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

const { generateJobNumber } = require('./jobNumbers');

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

// Insert one or more jobs for a monthly-package selection. Shared by
// POST /projects, POST /jobs, and the edit-flow "add months". Returns
// the array of new {jobNumber, projectName, startIso}.
//
// opts = {
//   db,                       — better-sqlite3 handle
//   clientName, clientId,     — applied to every new row
//   body,                     — req.body, used for shared columns
//   patternName,              — "Packages" by default
//   selectedMonths,           — [{ index, name }, ...]
//   monthlyYear,              — number
//   mode,                     — 'split' (default) | 'combined'
//   createdById,              — optional req.session.user.id
// }
function createMonthlyJobs(opts) {
  const { db, clientName, clientId, body, patternName, selectedMonths, monthlyYear, mode, createdById } = opts;
  const b = body || {};
  // Detect optional columns once so we don't crash on older schemas
  // (e.g. legacy DBs without created_by_id on jobs).
  const jobsCols = new Set(db.prepare("PRAGMA table_info(jobs)").all().map(c => c.name));
  const hasCreatedBy = jobsCols.has('created_by_id');

  const colList = [
    'job_number','job_name','project_name','client','client_id','site_address','suburb',
    'status','stage','percent_complete','start_date','end_date',
    'project_manager_id','ops_supervisor_id','planning_owner_id','marketing_owner_id','accounts_owner_id',
    'health','accounts_status','division_tags','notes',
    'client_project_number','principal_contractor','traffic_supervisor_id',
    'contract_value','estimated_hours','crew_size','rol_required','tmp_required',
    'sharepoint_url','state','required_tcp_level','priority',
    'recurring_monthly','recurring_pattern_name',
  ];
  if (hasCreatedBy) colList.push('created_by_id');
  const placeholders = colList.map(() => '?').join(', ');
  const insertStmt = db.prepare(`INSERT INTO jobs (${colList.join(', ')}) VALUES (${placeholders})`);

  function rowValues(jobNumber, projectName, startIso, endIso) {
    const v = [
      jobNumber,
      `${jobNumber} | ${clientName || ''} | ${b.suburb || ''} | ${startIso}`,
      projectName,
      clientName || '', clientId || null, b.site_address || '', b.suburb || '',
      b.status || 'tender', b.stage || 'tender', 0,
      startIso, endIso,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health || 'green', b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0,
      b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      b.priority || 'normal',
      1, patternName,
    ];
    if (hasCreatedBy) v.push(createdById || null);
    return v;
  }

  const out = [];
  const tx = db.transaction(() => {
    if (mode === 'combined') {
      const sorted = selectedMonths.slice().sort((a, b) => a.index - b.index);
      const first = sorted[0], last = sorted[sorted.length - 1];
      const startIso = firstOfMonth(monthlyYear, first.index);
      const endIso   = new Date(Date.UTC(monthlyYear, last.index + 1, 0)).toISOString().slice(0, 10);
      const projectName = combinedMonthsJobName(sorted, patternName);
      const jobNumber = generateJobNumber();
      insertStmt.run(...rowValues(jobNumber, projectName, startIso, endIso));
      out.push({ jobNumber, projectName, startIso });
    } else {
      for (const m of selectedMonths) {
        const jobNumber = generateJobNumber();
        const startIso = firstOfMonth(monthlyYear, m.index);
        const endIso   = new Date(Date.UTC(monthlyYear, m.index + 1, 0)).toISOString().slice(0, 10);
        const projectName = monthlyJobName(m.name, patternName);
        insertStmt.run(...rowValues(jobNumber, projectName, startIso, endIso));
        out.push({ jobNumber, projectName, startIso });
      }
    }
  });
  tx();
  return out;
}

// Look up which months already have a sibling job for the given client +
// pattern + year. Returns a Set<monthIndex 0-11>. Used by edit flows to
// skip months that already exist so re-saving is idempotent.
function takenMonthsFor(db, clientId, patternName, year) {
  const clientIdInt = clientId ? (parseInt(clientId, 10) || null) : null;
  const patternLower = (patternName || '').toLowerCase();
  const rows = clientIdInt
    ? db.prepare(`
        SELECT start_date FROM jobs
        WHERE recurring_monthly = 1
          AND client_id = ?
          AND LOWER(IFNULL(recurring_pattern_name, '')) = ?
          AND start_date LIKE ?
      `).all(clientIdInt, patternLower, year + '-%')
    : db.prepare(`
        SELECT start_date FROM jobs
        WHERE recurring_monthly = 1
          AND client_id IS NULL
          AND LOWER(IFNULL(recurring_pattern_name, '')) = ?
          AND start_date LIKE ?
      `).all(patternLower, year + '-%');
  const out = new Set();
  for (const r of rows) {
    const mm = parseInt((r.start_date || '').slice(5, 7), 10);
    if (Number.isFinite(mm) && mm >= 1 && mm <= 12) out.add(mm - 1);
  }
  return out;
}

module.exports = { MONTH_NAMES, MONTH_SHORT, monthlyJobName, combinedMonthsJobName, firstOfMonth, parseSelectedMonths, createMonthlyJobs, takenMonthsFor };

