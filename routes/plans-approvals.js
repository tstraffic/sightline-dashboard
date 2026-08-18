// Plans & Approvals hub — the single Delivery workspace entry. One overview
// of everything a project must clear before it's done: deliverables, QA,
// authority approvals, variations, client inputs, correspondence and time.
// COUNT-only queries; every card deep-links into its register tab.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { sydneyToday } = require('../lib/sydney');

// Pure calendar maths on YYYY-MM-DD strings (same helpers as routes/time.js).
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(ymd) {
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay(); // 0=Sun
  return addDays(ymd, -((dow + 6) % 7));
}

router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const today = sydneyToday();
    const safe = (fn, dflt) => { try { return fn(); } catch (e) { return dflt; } };

    // Deliverables due within 3 days or overdue (unresolved only).
    const deliverables = safe(() => db.prepare(`
      SELECT COUNT(*) AS c,
        SUM(CASE WHEN COALESCE(d.internal_due_date, d.external_due_date) < ? THEN 1 ELSE 0 END) AS overdue
      FROM deliverables d JOIN jobs j ON d.job_id = j.id
      WHERE d.status NOT IN ('issued','closed','superseded')
        AND j.status NOT IN ('closed','cancelled')
        AND (
          (d.internal_due_date IS NOT NULL AND d.internal_due_date <= date(?, '+3 days')) OR
          (d.external_due_date IS NOT NULL AND d.external_due_date <= date(?, '+3 days'))
        )
    `).get(today, today, today), { c: 0, overdue: 0 });

    // Deliverables sitting in QA (prepared/checked, waiting on someone).
    const qaWaiting = safe(() => db.prepare(`
      SELECT COUNT(*) AS c FROM deliverables d JOIN jobs j ON d.job_id = j.id
      WHERE d.status = 'in_qa' AND j.status NOT IN ('closed','cancelled')
    `).get().c, 0);

    // Approvals needing attention: awaiting info, past their requested
    // decision date, or approved and expiring within 30 days.
    const approvals = safe(() => db.prepare(`
      SELECT
        SUM(CASE WHEN a.status = 'info_requested' THEN 1 ELSE 0 END) AS info,
        SUM(CASE WHEN a.status = 'submitted' AND a.requested_date IS NOT NULL AND a.requested_date < ? THEN 1 ELSE 0 END) AS past,
        SUM(CASE WHEN a.status = 'approved' AND a.expiry_date IS NOT NULL AND a.expiry_date <= date(?, '+30 days') THEN 1 ELSE 0 END) AS expiring
      FROM approvals a JOIN jobs j ON a.job_id = j.id
      WHERE j.status NOT IN ('closed','cancelled')
    `).get(today, today), { info: 0, past: 0, expiring: 0 });
    const approvalsCount = (approvals.info || 0) + (approvals.past || 0) + (approvals.expiring || 0);

    // Variations sitting submitted — money undecided.
    const variations = safe(() => db.prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(v.additional_fee), 0) AS value
      FROM variations v JOIN jobs j ON v.job_id = j.id
      WHERE v.approval_status = 'submitted' AND j.status NOT IN ('closed','cancelled')
    `).get(), { c: 0, value: 0 });

    // Client inputs past their needed-by date — delivery risk.
    const inputs = safe(() => db.prepare(`
      SELECT COUNT(*) AS c FROM client_inputs ci JOIN jobs j ON ci.job_id = j.id
      WHERE ci.status IN ('requested','inadequate') AND ci.needed_by IS NOT NULL
        AND ci.needed_by < ? AND j.status NOT IN ('closed','cancelled')
    `).get(today).c, 0);

    // Open correspondence, and how much of it demands an action.
    const correspondence = safe(() => db.prepare(`
      SELECT COUNT(*) AS c,
        SUM(CASE WHEN co.action_required != '' THEN 1 ELSE 0 END) AS action_required
      FROM correspondence co JOIN jobs j ON co.job_id = j.id
      WHERE co.status = 'open' AND j.status NOT IN ('closed','cancelled')
    `).get(), { c: 0, action_required: 0 });

    // Packages queued for invoicing and not yet invoiced.
    const invoiceReady = safe(() => db.prepare(`
      SELECT COUNT(*) AS c, COALESCE(SUM(fee_allocation), 0) AS value
      FROM service_packages
      WHERE COALESCE(ready_for_invoice, 0) = 1 AND COALESCE(invoiced, 0) = 0
    `).get(), { c: 0, value: 0 });

    // My hours this Sydney week (Mon–Sun).
    const weekStart = mondayOf(today);
    const weekEnd = addDays(weekStart, 6);
    const myTime = safe(() => db.prepare(`
      SELECT COALESCE(SUM(hours), 0) AS hours,
        COALESCE(SUM(CASE WHEN billable = 1 THEN hours ELSE 0 END), 0) AS billable
      FROM time_entries WHERE user_id = ? AND entry_date BETWEEN ? AND ?
    `).get(req.session.user.id, weekStart, weekEnd), { hours: 0, billable: 0 });

    res.render('plans-approvals/index', {
      title: 'Plans & Approvals',
      currentPage: 'plans-approvals',
      deliverables, qaWaiting, approvals, approvalsCount,
      variations, inputs, correspondence, invoiceReady, myTime,
    });
  } catch (err) { next(err); }
});

module.exports = router;
