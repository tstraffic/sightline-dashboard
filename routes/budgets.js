const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');
const { jobHasVariations } = require('../lib/wip');

// Apply role restriction to all routes
router.use(requireRole('admin', 'finance'));

// LIST - All jobs with budget overview
router.get('/', (req, res) => {
  const db = getDb();

  const budgets = db.prepare(`
    SELECT j.id as job_id, j.job_number, j.client, j.status,
      b.id as budget_id, b.contract_value, b.variations_approved,
      (b.budget_labour + b.budget_materials + b.budget_subcontractors + b.budget_equipment + b.budget_other + COALESCE(b.budget_contingency, 0)) as total_budget,
      COALESCE((SELECT SUM(amount) FROM cost_entries ce WHERE ce.job_id = j.id), 0) as total_spent
    FROM jobs j
    LEFT JOIN job_budgets b ON j.id = b.job_id
    WHERE j.status IN ('active', 'on_hold', 'won', 'completed')
    ORDER BY j.job_number DESC
  `).all();

  // Calculate totals
  const totalContract = budgets.reduce((s, b) => s + (b.contract_value || 0), 0);
  const totalSpent = budgets.reduce((s, b) => s + (b.total_spent || 0), 0);
  const totalBudget = budgets.reduce((s, b) => s + (b.total_budget || 0), 0);
  const overBudgetCount = budgets.filter(b => b.contract_value > 0 && b.total_spent > b.contract_value).length;
  const overallMargin = totalContract > 0 ? ((totalContract - totalSpent) / totalContract * 100) : 0;

  res.render('budgets/index', {
    title: 'Budget & Cost Tracking',
    currentPage: 'budgets',
    budgets,
    totals: { contract: totalContract, spent: totalSpent, budget: totalBudget, overBudgetCount, overallMargin }
  });
});

// JOB BUDGET DETAIL
router.get('/job/:jobId', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) { req.flash('error', 'Job not found.'); return req.session.save(() => res.redirect('/budgets')); }

  let budget = db.prepare('SELECT * FROM job_budgets WHERE job_id = ?').get(req.params.jobId);

  // Auto-create budget record if none exists
  if (!budget) {
    db.prepare('INSERT INTO job_budgets (job_id, updated_by_id) VALUES (?, ?)').run(req.params.jobId, req.session.user.id);
    budget = db.prepare('SELECT * FROM job_budgets WHERE job_id = ?').get(req.params.jobId);
  }

  const costEntries = db.prepare(`
    SELECT ce.*, u.full_name as entered_by_name
    FROM cost_entries ce
    JOIN users u ON ce.entered_by_id = u.id
    WHERE ce.job_id = ?
    ORDER BY ce.entry_date DESC
  `).all(req.params.jobId);

  // Calculate spent per category
  const spentByCategory = {};
  ['labour', 'materials', 'subcontractors', 'equipment', 'other'].forEach(cat => {
    spentByCategory[cat] = costEntries.filter(e => e.category === cat).reduce((s, e) => s + e.amount, 0);
  });

  const totalBudget = budget.budget_labour + budget.budget_materials + budget.budget_subcontractors + budget.budget_equipment + budget.budget_other + (budget.budget_contingency || 0);
  const totalSpent = Object.values(spentByCategory).reduce((s, v) => s + v, 0);
  const margin = budget.contract_value > 0 ? ((budget.contract_value - totalSpent) / budget.contract_value * 100) : 0;

  res.render('budgets/job-detail', {
    title: `Budget - ${job.job_number}`,
    currentPage: 'budgets',
    job,
    budget,
    costEntries,
    spentByCategory,
    totalBudget,
    totalSpent,
    margin: margin.toFixed(1),
    hasVariations: jobHasVariations(db, req.params.jobId)
  });
});

// UPDATE BUDGET
router.post('/job/:jobId', (req, res) => {
  const db = getDb();
  const { contract_value, budget_labour, budget_materials, budget_subcontractors, budget_equipment, budget_other, budget_contingency, variations_approved, notes,
    invoiced_to_date, paid_to_date } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(req.params.jobId);

  // Once variation rows exist, variations_approved is a projection owned by
  // the variation register (lib/wip.js syncVariationTotals) — the manual
  // field is ignored so a stale form can't overwrite the synced total.
  const keepVariations = jobHasVariations(db, req.params.jobId);
  db.prepare(`
    UPDATE job_budgets SET contract_value=?, budget_labour=?, budget_materials=?, budget_subcontractors=?, budget_equipment=?, budget_other=?, budget_contingency=?,
      variations_approved = CASE WHEN ? THEN variations_approved ELSE ? END, notes=?,
      invoiced_to_date=?, paid_to_date=?,
      updated_by_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE job_id = ?
  `).run(
    parseFloat(contract_value) || 0, parseFloat(budget_labour) || 0, parseFloat(budget_materials) || 0,
    parseFloat(budget_subcontractors) || 0, parseFloat(budget_equipment) || 0, parseFloat(budget_other) || 0,
    parseFloat(budget_contingency) || 0, keepVariations ? 1 : 0, parseFloat(variations_approved) || 0, notes || '',
    parseFloat(invoiced_to_date) || 0, parseFloat(paid_to_date) || 0,
    req.session.user.id, req.params.jobId
  );

  logActivity({ user: req.session.user, action: 'update', entityType: 'budget', entityLabel: job ? job.job_number : '', jobId: parseInt(req.params.jobId), jobNumber: job ? job.job_number : '', ip: req.ip });
  req.flash('success', 'Budget updated.');
  req.session.save(() => res.redirect(`/budgets/job/${req.params.jobId}`));
});

// ADD COST ENTRY
router.post('/job/:jobId/costs', (req, res) => {
  const db = getDb();
  const budget = db.prepare('SELECT id FROM job_budgets WHERE job_id = ?').get(req.params.jobId);
  if (!budget) { req.flash('error', 'Budget not found. Set up budget first.'); return req.session.save(() => res.redirect(`/budgets/job/${req.params.jobId}`)); }

  const { category, description, amount, entry_date, invoice_ref, supplier, receipt_url } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(req.params.jobId);

  db.prepare(`
    INSERT INTO cost_entries (job_id, budget_id, category, description, amount, entry_date, invoice_ref, supplier, receipt_url, entered_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.jobId, budget.id, category, description, parseFloat(amount) || 0, entry_date, invoice_ref || '', supplier || '', receipt_url || '', req.session.user.id);

  logActivity({ user: req.session.user, action: 'create', entityType: 'cost_entry', entityLabel: `$${amount} - ${description.substring(0, 40)}`, jobId: parseInt(req.params.jobId), jobNumber: job ? job.job_number : '', ip: req.ip });
  req.flash('success', 'Cost entry added.');
  req.session.save(() => res.redirect(`/budgets/job/${req.params.jobId}`));
});

// DELETE COST ENTRY
router.post('/job/:jobId/costs/:costId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM cost_entries WHERE id = ?').run(req.params.costId);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'cost_entry', entityId: parseInt(req.params.costId), jobId: parseInt(req.params.jobId), ip: req.ip });
  req.flash('success', 'Cost entry deleted.');
  req.session.save(() => res.redirect(`/budgets/job/${req.params.jobId}`));
});

module.exports = router;
