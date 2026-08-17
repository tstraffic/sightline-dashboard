/**
 * Delivery-side money & hours projections (Phase 2).
 *
 * Two Phase-1 columns become projections once their source rows exist:
 *   - job_budgets.variations_approved = SUM(approved variation fees)
 *     (the manual budget-form field is disabled when variation rows exist)
 *   - jobs.actual_hours = SUM(time_entries.hours)
 *     (the manual job-form field is disabled when time entries exist)
 * Each sync is called by EVERY write path of its source module so the
 * invariant has a single owner.
 *
 * getJobWip / getCloseoutBlockers are added with their commits (Time & WIP,
 * closeout gating).
 */
const { getConfig } = require('../middleware/settings');

// job_budgets.variations_approved ← SUM(approved fees). Ensures the budget
// row exists (converted projects always have one; manual jobs may not).
function syncVariationTotals(db, jobId) {
  const total = db.prepare(
    "SELECT COALESCE(SUM(additional_fee), 0) AS v FROM variations WHERE job_id = ? AND approval_status = 'approved'"
  ).get(jobId).v;
  const existing = db.prepare('SELECT id FROM job_budgets WHERE job_id = ?').get(jobId);
  if (existing) {
    db.prepare('UPDATE job_budgets SET variations_approved = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?').run(total, jobId);
  } else {
    db.prepare('INSERT INTO job_budgets (job_id, variations_approved) VALUES (?, ?)').run(jobId, total);
  }
  return total;
}

// True when the budget form must render variations_approved read-only.
function jobHasVariations(db, jobId) {
  return !!db.prepare('SELECT 1 FROM variations WHERE job_id = ? LIMIT 1').get(jobId);
}

// jobs.actual_hours ← SUM(time_entries.hours). Owned by routes/time.js.
function syncJobActualHours(db, jobId) {
  const total = db.prepare('SELECT COALESCE(SUM(hours), 0) AS h FROM time_entries WHERE job_id = ?').get(jobId).h;
  db.prepare('UPDATE jobs SET actual_hours = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(total, jobId);
  return total;
}

function jobHasTimeEntries(db, jobId) {
  try {
    return !!db.prepare('SELECT 1 FROM time_entries WHERE job_id = ? LIMIT 1').get(jobId);
  } catch (e) { return false; } // table lands with the Time & WIP commit
}

/**
 * WIP rollup for a project (brief §5.9): budget vs actual hours, WIP $
 * (Σ hours × snapshotted charge_rate), cost $ (Σ hours × snapshotted
 * cost_rate), contract total incl. variations, effective recovery and
 * estimated margin. Cost/margin figures only when canSeeCost.
 */
function getJobWip(db, jobId, { canSeeCost = false } = {}) {
  const job = db.prepare('SELECT estimated_hours, contract_value FROM jobs WHERE id = ?').get(jobId);
  if (!job) return null;
  const budget = db.prepare('SELECT variations_approved FROM job_budgets WHERE job_id = ?').get(jobId) || { variations_approved: 0 };
  const defaultCharge = parseFloat(getConfig('default_charge_rate', 180)) || 180;
  const defaultCost = parseFloat(getConfig('internal_hourly_rate', 40)) || 40;

  let totals = { hours: 0, wip: 0, cost: 0 };
  let byPackage = [];
  let byActivity = [];
  try {
    totals = db.prepare(`
      SELECT COALESCE(SUM(hours), 0) AS hours,
        COALESCE(SUM(hours * COALESCE(charge_rate, ?)), 0) AS wip,
        COALESCE(SUM(hours * COALESCE(cost_rate, ?)), 0) AS cost
      FROM time_entries WHERE job_id = ?
    `).get(defaultCharge, defaultCost, jobId);
    byPackage = db.prepare(`
      SELECT COALESCE(sp.package_ref, '(no package)') AS label,
        COALESCE(SUM(te.hours), 0) AS hours,
        COALESCE(SUM(te.hours * COALESCE(te.charge_rate, ?)), 0) AS wip
      FROM time_entries te LEFT JOIN service_packages sp ON te.service_package_id = sp.id
      WHERE te.job_id = ? GROUP BY label ORDER BY hours DESC
    `).all(defaultCharge, jobId);
    byActivity = db.prepare(`
      SELECT te.activity_code AS code, COALESCE(a.label, te.activity_code) AS label,
        COALESCE(SUM(te.hours), 0) AS hours
      FROM time_entries te
      LEFT JOIN app_settings a ON a.category = 'time_activity_codes' AND a.key = te.activity_code
      WHERE te.job_id = ? GROUP BY te.activity_code ORDER BY te.activity_code
    `).all(jobId);
  } catch (e) { /* time_entries lands with the Time & WIP commit */ }

  const budgetHours = job.estimated_hours || 0;
  const contractTotal = (job.contract_value || 0) + (budget.variations_approved || 0);
  const out = {
    budgetHours,
    actualHours: totals.hours,
    remainingHours: budgetHours ? Math.max(0, budgetHours - totals.hours) : null,
    consumedPct: budgetHours ? Math.round(totals.hours / budgetHours * 100) : null,
    wipValue: totals.wip,
    contractTotal,
    variationsApproved: budget.variations_approved || 0,
    effectiveRecovery: contractTotal > 0 ? totals.wip / contractTotal : null,
    byPackage,
    byActivity,
  };
  if (canSeeCost) {
    out.costValue = totals.cost;
    out.estMargin = contractTotal - totals.cost;
    out.estMarginPct = contractTotal > 0 ? Math.round((contractTotal - totals.cost) / contractTotal * 100) : null;
  }
  return out;
}

/**
 * Closeout gate (brief §6.3) — a project cannot complete closeout while
 * delivery, decisions, inputs or money remain unresolved, unless an
 * authorised exception is recorded. Returns named blocker rows
 * {type, label, count, href}; empty array = clear to close.
 * Every probe is try/caught so a missing table never breaks closing.
 */
function getCloseoutBlockers(db, jobId) {
  const blockers = [];
  const probe = (type, label, href, sql, ...params) => {
    try {
      const count = db.prepare(sql).get(...params).c;
      if (count > 0) blockers.push({ type, label, count, href });
    } catch (e) { /* table lands with its module's migration */ }
  };
  probe('deliverables', 'Unresolved deliverables (not issued or closed)', `/deliverables?job_id=${jobId}`,
    "SELECT COUNT(*) AS c FROM deliverables WHERE job_id = ? AND status NOT IN ('issued','closed','superseded')", jobId);
  probe('approvals', 'Approvals still open with an authority', `/approvals?job_id=${jobId}`,
    "SELECT COUNT(*) AS c FROM approvals WHERE job_id = ? AND status IN ('not_submitted','submitted','info_requested')", jobId);
  probe('variations', 'Variations awaiting a decision', `/variations?job_id=${jobId}`,
    "SELECT COUNT(*) AS c FROM variations WHERE job_id = ? AND approval_status = 'submitted'", jobId);
  probe('client_inputs', 'Client inputs outstanding', `/client-inputs?job_id=${jobId}`,
    "SELECT COUNT(*) AS c FROM client_inputs WHERE job_id = ? AND status IN ('requested','inadequate')", jobId);
  probe('correspondence', 'Open correspondence with actions required', `/correspondence?job_id=${jobId}`,
    "SELECT COUNT(*) AS c FROM correspondence WHERE job_id = ? AND status = 'open' AND action_required != ''", jobId);
  probe('tasks', 'Open tasks', `/tasks?job_id=${jobId}&owner=all`,
    "SELECT COUNT(*) AS c FROM tasks WHERE job_id = ? AND status != 'complete' AND deleted_at IS NULL", jobId);
  // Invoicing position is the manual Xero field on the job (§7.2).
  try {
    const job = db.prepare('SELECT invoice_status FROM jobs WHERE id = ?').get(jobId);
    if (job && !['invoiced', 'paid'].includes(job.invoice_status || '')) {
      blockers.push({
        type: 'invoicing', count: 1, href: `/budgets/job/${jobId}`,
        label: `Invoicing incomplete (status: ${job.invoice_status ? job.invoice_status.replace(/_/g, ' ') : 'not set'})`,
      });
    }
  } catch (e) { /* ignore */ }
  // Unbilled WIP: time on the clock while packages sit neither queued nor invoiced.
  try {
    if (jobHasTimeEntries(db, jobId)) {
      const unbilled = db.prepare(
        'SELECT COUNT(*) AS c FROM service_packages WHERE job_id = ? AND COALESCE(ready_for_invoice, 0) = 0 AND COALESCE(invoiced, 0) = 0'
      ).get(jobId).c;
      if (unbilled > 0) blockers.push({ type: 'wip', label: 'Time logged but packages neither queued for invoice nor invoiced', count: unbilled, href: `/service-packages?job_id=${jobId}&invoice_state=pending` });
    }
  } catch (e) { /* ignore */ }
  return blockers;
}

module.exports = { syncVariationTotals, jobHasVariations, syncJobActualHours, jobHasTimeEntries, getJobWip, getCloseoutBlockers };
