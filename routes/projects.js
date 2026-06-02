const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');
const { recalculateJobHealth, HEALTH_CALC_SQL } = require('../middleware/jobHealth');
const { logActivity } = require('../middleware/audit');
const { ensureThreadForEntity, addMembersToThread, postSystemMessage, getThreadForEntity } = require('../lib/chat');
const { generateJobNumber } = require('../lib/jobNumbers');
const { MONTH_NAMES, monthlyJobName, combinedMonthsJobName, firstOfMonth, parseSelectedMonths, createMonthlyJobs, takenMonthsFor } = require('../lib/recurringJobs');

// List all projects (top-level jobs only, parent_project_id IS NULL)
router.get('/', (req, res) => {
  const db = getDb();
  const { status, search, suburb } = req.query;
  let query = `SELECT j.*, u.full_name as pm_name, bm.budget_contract, bm.total_spent as budget_spent,
    (SELECT COUNT(*) FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL) as pending_tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.job_id = j.id AND t.status != 'complete' AND t.deleted_at IS NULL AND t.due_date < date('now')) as overdue_tasks,
    (SELECT COUNT(*) FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved')) as pending_plans,
    (SELECT COUNT(*) FROM compliance c WHERE c.job_id = j.id AND c.status NOT IN ('approved','expired','submitted') AND c.due_date IS NOT NULL AND c.due_date < date('now')) as overdue_compliance,
    ${HEALTH_CALC_SQL} as calculated_health
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    LEFT JOIN (SELECT b.job_id, b.contract_value as budget_contract, COALESCE((SELECT SUM(amount) FROM cost_entries ce WHERE ce.job_id = b.job_id), 0) as total_spent FROM job_budgets b) bm ON j.id = bm.job_id
    WHERE (j.parent_project_id IS NULL)`;
  const params = [];

  if (status && status !== 'all') {
    query += ` AND j.status = ?`;
    params.push(status);
  }
  if (search) {
    query += ` AND (j.job_number LIKE ? OR j.client LIKE ? OR j.suburb LIKE ? OR j.job_name LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (suburb && suburb !== 'all') {
    query += ` AND j.suburb = ?`;
    params.push(suburb);
  }
  query += ` ORDER BY CASE j.priority WHEN 'high' THEN 0 ELSE 1 END, CASE j.status WHEN 'active' THEN 1 WHEN 'on_hold' THEN 2 WHEN 'won' THEN 3 WHEN 'tender' THEN 4 WHEN 'prestart' THEN 5 WHEN 'completed' THEN 6 ELSE 7 END, j.start_date DESC`;

  const jobs = db.prepare(query).all(...params);
  // Use auto-calculated health instead of stale DB value
  jobs.forEach(j => { if (j.calculated_health) j.health = j.calculated_health; });
  const suburbs = db.prepare('SELECT DISTINCT suburb FROM jobs WHERE parent_project_id IS NULL ORDER BY suburb').all().map(r => r.suburb);

  // Group jobs by client
  const clientGroupsMap = {};
  jobs.forEach(job => {
    const key = job.client || 'Unassigned';
    if (!clientGroupsMap[key]) {
      clientGroupsMap[key] = { name: key, clientId: job.client_id || 0, jobs: [], activeCount: 0, totalCount: 0, pendingTasks: 0, pendingPlans: 0, overdueTasks: 0, overdueCompliance: 0, hasHighPriority: false };
    }
    clientGroupsMap[key].jobs.push(job);
    clientGroupsMap[key].totalCount++;
    if (job.status === 'active') clientGroupsMap[key].activeCount++;
    clientGroupsMap[key].pendingTasks += (job.pending_tasks || 0);
    clientGroupsMap[key].pendingPlans += (job.pending_plans || 0);
    clientGroupsMap[key].overdueTasks += (job.overdue_tasks || 0);
    clientGroupsMap[key].overdueCompliance += (job.overdue_compliance || 0);
    if (job.priority === 'high') clientGroupsMap[key].hasHighPriority = true;
  });
  const clientGroups = Object.values(clientGroupsMap).sort((a, b) => {
    if (a.hasHighPriority && !b.hasHighPriority) return -1;
    if (!a.hasHighPriority && b.hasHighPriority) return 1;
    return a.name.localeCompare(b.name);
  });

  res.render('projects/index', {
    title: 'Project Register',
    jobs, suburbs, filters: { status, search, suburb },
    clientGroups,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// New project form
router.get('/new', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const preselectedClientId = req.query.client_id || null;
  res.render('projects/form', { title: 'Create New Project', job: null, users, clients, preselectedClientId, user: req.session.user });
});

// Create project (or — if monthly_package is on — a job per selected month)
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  // Resolve client name from client_id if provided
  let clientName = b.client || '';
  if (b.client_id) {
    const client = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (client) clientName = client.company_name;
  }

  // ── Monthly package mode ─────────────────────────────────────
  // If the planner ticked "Monthly package job" and picked one or
  // more months, we mint one job per selected month named
  // "<Month> - <pattern>", with start_date set to the 1st of that
  // month and end_date to the last day. Year is the current year
  // unless the form passes one; the planner can always edit later.
  const isMonthly = !!b.monthly_package;
  const patternName = (b.recurring_pattern_name || 'Packages').toString().trim().slice(0, 80);
  const selectedMonths = isMonthly ? parseSelectedMonths(b.monthly_months) : [];
  const monthlyYear = parseInt(b.monthly_year, 10) || new Date().getFullYear();

  if (isMonthly && selectedMonths.length) {
    // "split" (default) — one job per month, named "<Month> - <pattern>".
    // "combined"        — one job for the whole selection, named with a
    //                     range or "Multiple months - <pattern>".
    const mode = (b.monthly_mode === 'combined') ? 'combined' : 'split';
    try {
      const created = createMonthlyJobs({
        db, clientName, clientId: b.client_id || null, body: b, patternName,
        selectedMonths, monthlyYear, mode,
        createdById: req.session.user && req.session.user.id,
      });
      const monthsLbl = selectedMonths.map(m => m.name).join(', ');
      req.flash('success', `Created ${created.length} monthly job(s) — ${monthsLbl} ${monthlyYear} (${patternName}).`);
      return res.redirect('/projects');
    } catch (err) {
      req.flash('error', 'Failed to create monthly jobs: ' + err.message);
      return res.redirect('/projects/new');
    }
  }

  // ── Single project (the original create flow) ────────────────
  const jobNumber = generateJobNumber();
  const jobName = `${jobNumber} | ${clientName} | ${b.suburb} | ${b.start_date}`;

  try {
    db.prepare(`
      INSERT INTO jobs (job_number, job_name, client, client_id, site_address, suburb, status, stage, percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id, planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status, division_tags, notes,
        client_project_number, project_name, principal_contractor, traffic_supervisor_id,
        contract_value, estimated_hours, crew_size, rol_required, tmp_required, sharepoint_url, state, required_tcp_level, priority,
        recurring_monthly, recurring_pattern_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobNumber, jobName, clientName, b.client_id || null, b.site_address, b.suburb,
      b.status || 'tender', b.stage || 'tender', parseInt(b.percent_complete) || 0,
      b.start_date, b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health || 'green', b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      b.priority || 'normal',
      0, ''
    );
    req.flash('success', `Project ${jobNumber} created successfully.`);

    // JSON response for inline create (e.g. compliance form)
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      const newJob = db.prepare('SELECT id, job_number, client FROM jobs WHERE job_number = ?').get(jobNumber);
      return res.json({ success: true, job: newJob });
    }

    res.redirect('/projects');
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', 'Job number collision — please try again.');
    } else {
      req.flash('error', 'Failed to create project: ' + err.message);
    }
    res.redirect('/projects/new');
  }
});

// Project detail page
router.get('/:id', (req, res) => {
  const db = getDb();
  const job = db.prepare(`
    SELECT j.*,
      pm.full_name as pm_name, ops.full_name as ops_name,
      pl.full_name as planning_name, mk.full_name as marketing_name,
      ac.full_name as accounts_name, ts.full_name as traffic_supervisor_name
    FROM jobs j
    LEFT JOIN users pm ON j.project_manager_id = pm.id
    LEFT JOIN users ops ON j.ops_supervisor_id = ops.id
    LEFT JOIN users pl ON j.planning_owner_id = pl.id
    LEFT JOIN users mk ON j.marketing_owner_id = mk.id
    LEFT JOIN users ac ON j.accounts_owner_id = ac.id
    LEFT JOIN users ts ON j.traffic_supervisor_id = ts.id
    WHERE j.id = ?
  `).get(req.params.id);

  if (!job) {
    req.flash('error', 'Project not found.');
    return res.redirect('/projects');
  }

  // Auto-calculate health from live data
  job.health = recalculateJobHealth(db, job.id);

  // Tasks tab = ops work only. Planning-division tasks and compliance-linked
  // tasks (auto-created from Plans & Approvals) live under Traffic Plans.
  // Matches the filter in routes/jobs.js so /projects/:id and /jobs/:id agree.
  const tasks = db.prepare(`
    SELECT t.*, u.full_name as owner_name FROM tasks t
    LEFT JOIN users u ON t.owner_id = u.id
    WHERE t.job_id = ? AND t.deleted_at IS NULL AND t.compliance_id IS NULL AND t.division != 'planning'
    ORDER BY CASE t.status WHEN 'blocked' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'not_started' THEN 3 ELSE 4 END, t.due_date ASC
  `).all(job.id);

  const complianceItems = db.prepare(`
    SELECT c.*, u.full_name as approver_name FROM compliance c
    LEFT JOIN users u ON c.internal_approver_id = u.id
    WHERE c.job_id = ? ORDER BY c.due_date ASC
  `).all(job.id);

  // Pre-bucket sub-plans by parent so the Plans tab renders parent rows
  // with an expandable sub-plan list — mirrors what /jobs/:id does.
  const parentIdsForJob = complianceItems
    .filter(c => c.parent_id == null && c.plan_number != null)
    .map(c => c.id);
  const subPlansByParent = {};
  if (parentIdsForJob.length > 0) {
    const ph = parentIdsForJob.map(() => '?').join(',');
    const subs = db.prepare(`
      SELECT c.id, c.parent_id, c.item_type, c.reference_number, c.title, c.description,
             c.status, c.submitted_date, c.expiry_date, c.due_date, c.designer,
             c.assigned_to_id, u.full_name AS owner_name
      FROM compliance c LEFT JOIN users u ON c.assigned_to_id = u.id
      WHERE c.parent_id IN (${ph}) ORDER BY c.item_type, c.reference_number
    `).all(...parentIdsForJob);
    subs.forEach(s => {
      (subPlansByParent[s.parent_id] = subPlansByParent[s.parent_id] || []).push(s);
    });
  }

  const deliveryDocs = db.prepare("SELECT * FROM documents WHERE job_id = ? AND library = 'delivery' ORDER BY category, original_name").all(job.id);
  const complianceDocs = db.prepare("SELECT d.*, u.full_name as uploaded_by_name FROM documents d LEFT JOIN users u ON d.uploaded_by_id = u.id WHERE d.job_id = ? AND d.library = 'compliance' ORDER BY d.category, d.created_at DESC").all(job.id);
  const accountsDocs = canViewAccounts(req.session.user)
    ? db.prepare("SELECT * FROM documents WHERE job_id = ? AND library = 'accounts' ORDER BY category, original_name").all(job.id)
    : [];

  const incidents = db.prepare(`
    SELECT i.*, u.full_name as reported_by_name FROM incidents i
    LEFT JOIN users u ON i.reported_by_id = u.id
    WHERE i.job_id = ? ORDER BY i.incident_date DESC
  `).all(job.id);

  const contacts = db.prepare(`
    SELECT * FROM client_contacts WHERE job_id = ? ORDER BY is_primary DESC, full_name ASC
  `).all(job.id);

  const timesheets = db.prepare(`
    SELECT ts.*, cm.full_name as crew_name, u.full_name as approved_by_name
    FROM timesheets ts
    LEFT JOIN crew_members cm ON ts.crew_member_id = cm.id
    LEFT JOIN users u ON ts.approved_by_id = u.id
    WHERE ts.job_id = ? ORDER BY ts.work_date DESC LIMIT 50
  `).all(job.id);

  let budget = db.prepare(`SELECT * FROM job_budgets WHERE job_id = ?`).get(job.id);
  if (!budget) {
    try {
      db.prepare('INSERT INTO job_budgets (job_id, contract_value, updated_by_id) VALUES (?, ?, ?)').run(job.id, job.contract_value || 0, req.session.user.id);
      budget = db.prepare(`SELECT * FROM job_budgets WHERE job_id = ?`).get(job.id);
    } catch(e) {}
  }
  const costEntries = db.prepare(`
    SELECT ce.*, u.full_name as entered_by_name FROM cost_entries ce
    LEFT JOIN users u ON ce.entered_by_id = u.id
    WHERE ce.job_id = ? ORDER BY ce.entry_date DESC LIMIT 30
  `).all(job.id);
  const totalSpend = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM cost_entries WHERE job_id = ?`).get(job.id).total;

  // Compliance cost totals
  const complianceCosts = db.prepare(`SELECT COALESCE(SUM(costs), 0) as total FROM compliance WHERE job_id = ?`).get(job.id).total;
  const equipmentCosts = 0;

  const equipmentAssignments = db.prepare(`
    SELECT ea.*, e.name as equipment_name, e.asset_number, e.category, e.current_condition as equipment_condition,
      u.full_name as assigned_by_name
    FROM equipment_assignments ea
    LEFT JOIN equipment e ON ea.equipment_id = e.id
    LEFT JOIN users u ON ea.assigned_by_id = u.id
    WHERE ea.job_id = ? ORDER BY ea.assigned_date DESC
  `).all(job.id);

  // Hire dockets linked to this job — so the project page surfaces hired gear
  // alongside the owned-equipment assignments above.
  let hireDockets = [];
  try {
    hireDockets = db.prepare(`
      SELECT hd.id, hd.docket_number, hd.supplier_name, hd.status, hd.date_prepared,
        hd.hire_period, hd.hire_end_date,
        (SELECT COUNT(*) FROM hire_docket_items hdi WHERE hdi.docket_id = hd.id) as item_count,
        CASE WHEN hd.status = 'picked_up' AND hd.hire_end_date IS NOT NULL AND hd.hire_end_date < date('now')
             THEN 1 ELSE 0 END as is_overdue
      FROM hire_dockets hd
      WHERE hd.job_id = ? AND hd.deleted_at IS NULL
      ORDER BY hd.created_at DESC
    `).all(job.id);
  } catch (e) { /* table or column may be older — ignore */ }

  const trafficPlans = db.prepare(`
    SELECT tp.*, u.full_name as created_by_name FROM traffic_plans tp
    LEFT JOIN users u ON tp.created_by_id = u.id
    WHERE tp.job_id = ? ORDER BY tp.created_at DESC
  `).all(job.id);

  // Site diary entries
  const diaryEntries = db.prepare(`
    SELECT sd.*, u.full_name as created_by_name,
      tp.plan_number as tgs_plan_number,
      rep.full_name as representative_name,
      comp.title as compliance_item_title,
      eq.name as linked_equipment_name, eq.asset_number as linked_asset_number
    FROM site_diary_entries sd
    LEFT JOIN users u ON sd.created_by_id = u.id
    LEFT JOIN traffic_plans tp ON sd.tgs_plan_id = tp.id
    LEFT JOIN users rep ON sd.representative_id = rep.id
    LEFT JOIN compliance comp ON sd.compliance_item_id = comp.id
    LEFT JOIN equipment_assignments eqa ON sd.equipment_assignment_id = eqa.id
    LEFT JOIN equipment eq ON eqa.equipment_id = eq.id
    WHERE sd.job_id = ? ORDER BY sd.entry_date DESC
  `).all(job.id);

  const tgsPlans = db.prepare(`SELECT id, plan_number FROM traffic_plans WHERE job_id = ? ORDER BY plan_number`).all(job.id);
  const complianceTgsItems = db.prepare(`SELECT id, title, item_type, item_types FROM compliance WHERE job_id = ? AND (item_type = 'traffic_guidance' OR item_types LIKE '%traffic_guidance%') ORDER BY title`).all(job.id);
  const allUsers = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  let diaryAttachments = [];
  try { diaryAttachments = db.prepare('SELECT * FROM site_diary_attachments WHERE diary_entry_id IN (SELECT id FROM site_diary_entries WHERE job_id = ?)').all(job.id); } catch(e) {}

  // Chat thread
  let chatThreadId = getThreadForEntity('job', job.id);
  if (!chatThreadId) {
    chatThreadId = ensureThreadForEntity('job', job.id, `Job ${job.job_number}`, req.session.user.id);
    const memberIds = [...new Set([req.session.user.id,
      job.project_manager_id, job.ops_supervisor_id,
      job.planning_owner_id, job.marketing_owner_id, job.accounts_owner_id
    ].filter(Boolean))];
    addMembersToThread(chatThreadId, memberIds, 'member', true);
    postSystemMessage(chatThreadId, `Thread created for job ${job.job_number}`);
  }
  let chatMembers = [];
  try { chatMembers = db.prepare('SELECT u.id, u.full_name, u.role FROM chat_thread_members ctm JOIN users u ON ctm.user_id = u.id WHERE ctm.thread_id = ? AND u.active = 1 ORDER BY u.full_name').all(chatThreadId); } catch(e) {}

  // Activity log
  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE (al.entity_type = 'job' AND al.entity_id = ?)
      OR (al.entity_type IN ('task','incident','compliance','equipment_assignment','timesheet','traffic_plan','project_update') AND al.job_id = ?)
    ORDER BY al.created_at DESC LIMIT 30
  `).all(job.id, job.id);

  // Final plans = approved/submitted compliance items + documents (for operations view)
  let finalPlans = [];
  let finalPlanDocs = [];
  try {
    finalPlans = db.prepare(`
      SELECT c.*, u.full_name as approver_name, d.full_name as designer_name
      FROM compliance c LEFT JOIN users u ON c.internal_approver_id = u.id LEFT JOIN users d ON c.assigned_to_id = d.id
      WHERE c.job_id = ? AND c.status IN ('approved','submitted') ORDER BY c.title
    `).all(job.id);
    if (finalPlans.length > 0) {
      finalPlanDocs = db.prepare(`
        SELECT cd.*, u.full_name as uploaded_by_name FROM compliance_documents cd LEFT JOIN users u ON cd.uploaded_by_id = u.id
        WHERE cd.compliance_id IN (SELECT id FROM compliance WHERE job_id = ? AND status IN ('approved','submitted')) ORDER BY cd.created_at DESC
      `).all(job.id);
    }
  } catch(e) {}

  // Plan flags and revisions
  let planFlags = [];
  try { planFlags = db.prepare('SELECT pf.*, u.full_name as flagged_by_name, tp.plan_number FROM plan_flags pf LEFT JOIN users u ON pf.flagged_by = u.id LEFT JOIN traffic_plans tp ON pf.plan_id = tp.id WHERE pf.job_id = ? ORDER BY pf.created_at DESC').all(job.id); } catch(e) {}
  let planRevisions = [];
  try { planRevisions = db.prepare('SELECT pr.*, u.full_name as created_by_name FROM plan_revisions pr LEFT JOIN users u ON pr.created_by = u.id WHERE pr.plan_id IN (SELECT id FROM traffic_plans WHERE job_id = ?) ORDER BY pr.created_at DESC').all(job.id); } catch(e) {}

  // /projects/:id and /jobs/:id render the same template (jobs/show) but
  // were diverging — the projects route never queried Final Plans (FINAL
  // traffic_plans) or Safety (SWMS / RAs), so those tabs rendered empty
  // even when the data existed. Mirroring the jobs.js queries here so
  // the two URLs are interchangeable. JS-side filter against
  // String(jobIdInt) is the same pattern that fixed jobs.js — bulletproof
  // against any text-vs-int storage weirdness.
  const jobIdInt = parseInt(job.id, 10);
  const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true';
  let finalTrafficPlans = (trafficPlans || [])
    .filter(t => isTruthy(t.is_final))
    .map(t => ({ ...t, marked_final_by_name: null }));
  if (finalTrafficPlans.length > 0) {
    const ids = [...new Set(finalTrafficPlans.map(t => t.marked_final_by).filter(Boolean))];
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const userMap = {};
      for (const u of db.prepare(`SELECT id, full_name FROM users WHERE id IN (${placeholders})`).all(...ids)) {
        userMap[u.id] = u.full_name;
      }
      finalTrafficPlans = finalTrafficPlans.map(t => ({ ...t, marked_final_by_name: userMap[t.marked_final_by] || null }));
    }
    finalTrafficPlans.sort((a, b) => (b.marked_final_at || '').localeCompare(a.marked_final_at || ''));
  }

  const matchesJob = (rowJobId) => rowJobId != null && String(rowJobId).trim() === String(jobIdInt);
  let swmsForJob = [];
  try {
    const rows = db.prepare(`
      SELECT s.*, u.full_name AS owner_name
      FROM swms s
      LEFT JOIN users u ON u.id = s.owner_id
      WHERE COALESCE(s.kind, 'job') = 'job' AND s.job_id IS NOT NULL
      ORDER BY s.created_at DESC
    `).all();
    swmsForJob = rows.filter(r => matchesJob(r.job_id));
  } catch (e) {
    console.error('[Projects] SWMS Safety tab query failed for job', job.id, ':', e.message);
  }

  let riskAssessmentsForJob = [];
  try {
    const rows = db.prepare(`
      SELECT r.*, u.full_name AS owner_name
      FROM risk_assessments r
      LEFT JOIN users u ON u.id = r.owner_id
      WHERE COALESCE(r.kind, 'job') = 'job' AND r.job_id IS NOT NULL
      ORDER BY r.created_at DESC
    `).all();
    riskAssessmentsForJob = rows.filter(r => matchesJob(r.job_id));
  } catch (e) {
    console.error('[Projects] Risk Assessments Safety tab query failed for job', job.id, ':', e.message);
  }

  // Site audits attached to this job — also surface under the Safety tab.
  let auditsForJob = [];
  try {
    auditsForJob = db.prepare(`
      SELECT a.id, a.audit_datetime, a.auditor_name, a.overall_result, a.overall_finding,
        a.score_total, a.score_max, a.score_percent, a.status
      FROM audits a
      WHERE a.job_id = ?
      ORDER BY a.audit_datetime DESC
    `).all(jobIdInt);
  } catch (e) {
    console.error('[Projects] Audits Safety tab query failed for job', job.id, ':', e.message);
  }

  const viewMode = req.query.view || '';

  res.render('jobs/show', {
    title: job.job_number,
    job, tasks, complianceItems, subPlansByParent, complianceDocs, deliveryDocs, accountsDocs,
    incidents, contacts, timesheets, budget, costEntries, totalSpend,
    complianceCosts, equipmentCosts,
    equipmentAssignments, hireDockets, trafficPlans, chatThreadId, diaryEntries, tgsPlans,
    complianceTgsItems, allUsers, diaryAttachments, chatMembers, activities,
    finalPlans, finalPlanDocs, finalTrafficPlans, planFlags, planRevisions, viewMode,
    swmsForJob, riskAssessmentsForJob, auditsForJob,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// Edit project form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) { req.flash('error', 'Project not found.'); return res.redirect('/projects'); }
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  res.render('projects/form', { title: 'Edit Project', job, users, clients, preselectedClientId: null, user: req.session.user });
});

// Update project
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;

  // Preserve existing job_number — don't let users change it
  const existing = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) { req.flash('error', 'Project not found.'); return res.redirect('/projects'); }
  const jobNumber = existing.job_number;

  // Resolve client name from client_id
  let clientName = b.client || '';
  if (b.client_id) {
    const client = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (client) clientName = client.company_name;
  }
  const jobName = `${jobNumber} | ${clientName} | ${b.suburb} | ${b.start_date}`;

  try {
    const isMonthly = !!b.recurring_monthly;
    const patternName = (b.recurring_pattern_name || 'Packages').toString().trim().slice(0, 80);
    db.prepare(`
      UPDATE jobs SET job_name=?, client=?, client_id=?, site_address=?, suburb=?, status=?, stage=?, percent_complete=?, start_date=?, end_date=?,
        project_manager_id=?, ops_supervisor_id=?, planning_owner_id=?, marketing_owner_id=?, accounts_owner_id=?,
        health=?, accounts_status=?, division_tags=?, notes=?,
        client_project_number=?, project_name=?, principal_contractor=?, traffic_supervisor_id=?,
        contract_value=?, estimated_hours=?, crew_size=?, rol_required=?, tmp_required=?, sharepoint_url=?, state=?,
        required_tcp_level=?, priority=?,
        recurring_monthly=?, recurring_pattern_name=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      jobName, clientName, b.client_id || null, b.site_address, b.suburb,
      b.status, b.stage, parseInt(b.percent_complete) || 0,
      b.start_date, b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      b.health, b.accounts_status || 'na',
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      b.priority || 'normal',
      isMonthly ? 1 : 0, patternName,
      req.params.id
    );

    // If the user also picked months on the edit form, mint sibling
    // jobs for those months. Skip months where a sibling already
    // exists for the same client + pattern + year so the operation
    // is safely repeatable.
    const selectedMonths = isMonthly ? parseSelectedMonths(b.monthly_months) : [];
    let mintedCount = 0;
    if (isMonthly && selectedMonths.length) {
      const year = parseInt(b.monthly_year, 10) || new Date().getFullYear();
      const clientIdInt = b.client_id ? (parseInt(b.client_id, 10) || null) : null;
      const taken = takenMonthsFor(db, clientIdInt, patternName, year);
      const monthsToMint = selectedMonths.filter(m => !taken.has(m.index));
      if (monthsToMint.length) {
        const mode = (b.monthly_mode === 'combined') ? 'combined' : 'split';
        const minted = createMonthlyJobs({
          db, clientName, clientId: clientIdInt, body: b, patternName,
          selectedMonths: monthsToMint, monthlyYear: year, mode,
          createdById: req.session.user && req.session.user.id,
        });
        mintedCount = minted.length;
      }
    }

    if (mintedCount > 0) {
      req.flash('success', `Project updated · added ${mintedCount} new monthly job(s).`);
    } else {
      req.flash('success', 'Project updated successfully.');
    }
    res.redirect(`/projects/${req.params.id}`);
  } catch (err) {
    req.flash('error', 'Failed to update project: ' + err.message);
    res.redirect(`/projects/${req.params.id}/edit`);
  }
});

// Delete project (cascades to related records)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) { req.flash('error', 'Project not found.'); return res.redirect('/projects'); }

  // Cascade delete all linked records (try/catch each in case table doesn't exist)
  const linkedTables = [
    'tasks', 'project_updates', 'crew_allocations', 'timesheets',
    'incidents', 'corrective_actions', 'client_contacts', 'communication_log',
    'equipment_assignments', 'job_budgets', 'cost_entries', 'documents',
    'traffic_plans', 'compliance', 'notifications'
  ];
  for (const table of linkedTables) {
    try { db.prepare(`DELETE FROM ${table} WHERE job_id = ?`).run(req.params.id); } catch (e) { /* table may not exist */ }
  }
  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);

  logActivity({ user: req.session.user, action: 'delete', entityType: 'project', entityId: job.id, entityLabel: `${job.job_number} - ${job.client}`, details: 'Deleted project and all associated data', ip: req.ip });
  req.flash('success', `Project ${job.job_number} deleted.`);
  res.redirect('/projects');
});

module.exports = router;
