const express = require('express');
const router = express.Router();
const pathLib = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { canViewAccounts } = require('../middleware/auth');
const { recalculateJobHealth, HEALTH_CALC_SQL } = require('../middleware/jobHealth');
const { ensureThreadForEntity, addMembersToThread, postSystemMessage, getThreadForEntity } = require('../lib/chat');
const { generateJobNumber } = require('../lib/jobNumbers');
const { hideAdminTasksSql } = require('../lib/taskVisibility');
const { parseSelectedMonths, createMonthlyJobs, takenMonthsFor } = require('../lib/recurringJobs');

// Multer for diary attachments
const diaryStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = pathLib.join(__dirname, '..', 'data', 'uploads', 'diary', req.params.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + pathLib.extname(file.originalname));
  }
});
const diaryUpload = multer({ storage: diaryStorage, limits: { fileSize: 25 * 1024 * 1024 } });

// The jobs register lives at /projects — the sidebar, both department hubs
// and every "Jobs" link point there. This route used to render a SECOND,
// differently-styled register (views/jobs/index.ejs, now deleted): same rows,
// its own stat strip and flat table, reachable only from the edit-form
// breadcrumb, so editing a job and pressing "Jobs" landed you on a register
// that looked nothing like the one you came from. Query params carry over so
// old filter links keep working. /jobs/:id and the rest of this router stay
// as-is — plenty of deep links point at them.
router.get('/', (req, res) => {
  const qs = req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?')[1] : '';
  res.redirect('/projects' + qs);
});

// Inline status change
router.post('/:id/status', (req, res) => {
  const db = getDb();
  const { status } = req.body;
  const validStatuses = ['tender', 'won', 'prestart', 'active', 'on_hold', 'completed', 'closed'];
  if (!validStatuses.includes(status)) {
    req.flash('error', 'Invalid status');
    return req.session.save(() => res.redirect('/jobs'));
  }
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, req.params.id);
  req.session.save(() => res.redirect('/jobs'));
});

// Close out a job — sets status = 'closed', drops it off priority, and returns to the detail page
router.post('/:id/close', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) { req.flash('error', 'Job not found'); return req.session.save(() => res.redirect('/jobs')); }
  db.prepare("UPDATE jobs SET status = 'closed', priority = 'normal' WHERE id = ?").run(job.id);
  req.flash('success', `${job.job_number} closed out.`);
  req.session.save(() => res.redirect(`/jobs/${job.id}`));
});

// Reopen a closed job — sets status = 'active' and returns to the detail page
router.post('/:id/reopen', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) { req.flash('error', 'Job not found'); return req.session.save(() => res.redirect('/jobs')); }
  db.prepare("UPDATE jobs SET status = 'active' WHERE id = ?").run(job.id);
  req.flash('success', `${job.job_number} reopened.`);
  req.session.save(() => res.redirect(`/jobs/${job.id}`));
});

// New job form
router.get('/new', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  res.render('jobs/form', { title: 'Create New Job', job: null, users, clients, user: req.session.user });
});

// Create job
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  // Resolve client name from client_id first — used by both monthly-
  // package and single-job branches.
  let clientName = b.client || '';
  if (b.client_id) {
    const cl = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (cl) clientName = cl.company_name;
  }

  // Monthly package mode — mint one job per ticked month (split) or
  // a single multi-month job (combined). Defers to the shared helper.
  const isMonthly = !!b.monthly_package;
  const patternName = (b.recurring_pattern_name || 'Packages').toString().trim().slice(0, 80);
  const selectedMonths = isMonthly ? parseSelectedMonths(b.monthly_months) : [];
  const monthlyYear = parseInt(b.monthly_year, 10) || new Date().getFullYear();
  if (isMonthly && selectedMonths.length) {
    const mode = (b.monthly_mode === 'combined') ? 'combined' : 'split';
    try {
      const created = createMonthlyJobs({
        db, clientName, clientId: b.client_id || null, body: b, patternName,
        selectedMonths, monthlyYear, mode,
        createdById: req.session.user && req.session.user.id,
      });
      const monthsLbl = selectedMonths.map(m => m.name).join(', ');
      req.flash('success', `Created ${created.length} monthly job(s) — ${monthsLbl} ${monthlyYear} (${patternName}).`);
      return req.session.save(() => res.redirect('/jobs'));
    } catch (err) {
      console.error('[Jobs] monthly CREATE ERROR:', err.message);
      req.flash('error', 'Failed to create monthly jobs: ' + err.message);
      return req.session.save(() => res.redirect('/jobs'));
    }
  }

  // Single-job create (original flow)
  const jobNumber = generateJobNumber();
  const jobName = `${jobNumber} | ${clientName} | ${b.suburb} | ${b.start_date}`;

  // Clamp the enum-ish fields to the values the jobs-table CHECK constraints
  // actually allow. These dropdowns are populated from editable system
  // settings (settingsOptions.job_status / job_stage), so an admin adding a
  // status whose key isn't in the schema CHECK would otherwise make every
  // INSERT throw — the job silently failed to create. Anything unrecognised
  // falls back to a safe in-constraint default so the job always saves.
  const ALLOWED_STATUS = ['tender', 'won', 'prestart', 'active', 'on_hold', 'completed', 'closed'];
  const ALLOWED_STAGE = ['tender', 'prestart', 'delivery', 'closeout'];
  const ALLOWED_HEALTH = ['green', 'amber', 'red'];
  const ALLOWED_ACCTS = ['na', 'on_track', 'overdue', 'disputed'];
  const safeStatus = ALLOWED_STATUS.includes(b.status) ? b.status : 'tender';
  const safeStage = ALLOWED_STAGE.includes(b.stage) ? b.stage : 'tender';
  const safeHealth = ALLOWED_HEALTH.includes(b.health) ? b.health : 'green';
  const safeAccts = ALLOWED_ACCTS.includes(b.accounts_status) ? b.accounts_status : 'na';

  try {
    db.prepare(`
      INSERT INTO jobs (job_number, job_name, client, client_id, site_address, suburb, status, stage, percent_complete, start_date, end_date, project_manager_id, ops_supervisor_id, planning_owner_id, marketing_owner_id, accounts_owner_id, health, accounts_status, division_tags, notes,
        client_project_number, project_name, principal_contractor, traffic_supervisor_id,
        contract_value, estimated_hours, crew_size, vehicles, rol_required, tmp_required, tgs_required, spa_required, council_approval, bus_approval, sharepoint_url, state, required_tcp_level, priority, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobNumber, jobName, clientName, b.client_id || null, b.site_address || '', b.suburb || '',
      safeStatus, safeStage, parseInt(b.percent_complete) || 0,
      // start_date is NOT NULL — never bind null (would throw). Fall back to
      // today if the field somehow arrives empty.
      b.start_date || new Date().toISOString().slice(0, 10), b.end_date || null,
      b.project_manager_id || null, b.ops_supervisor_id || null,
      b.planning_owner_id || null, b.marketing_owner_id || null, b.accounts_owner_id || null,
      safeHealth, safeAccts,
      b.division_tags || '', b.notes || '',
      b.client_project_number || '', b.project_name || '', b.principal_contractor || '', b.traffic_supervisor_id || null,
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0, parseInt(b.vehicles) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.tgs_required ? 1 : 0, b.spa_required ? 1 : 0, b.council_approval ? 1 : 0, b.bus_approval ? 1 : 0,
      b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      b.priority || 'normal',
      req.session.user.id
    );
    // Auto-create budget record for this job
    const newJobId = db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(jobNumber);
    if (newJobId) {
      try {
        db.prepare('INSERT OR IGNORE INTO job_budgets (job_id, contract_value, updated_by_id) VALUES (?, ?, ?)').run(newJobId.id, parseFloat(b.contract_value) || 0, req.session.user.id);
      } catch(e) { /* budget may already exist */ }

      // Auto-create chat thread for this job
      const threadId = ensureThreadForEntity('job', newJobId.id, `Job ${jobNumber}`, req.session.user.id);
      const memberIds = [...new Set([req.session.user.id,
        b.project_manager_id ? parseInt(b.project_manager_id) : null,
        b.ops_supervisor_id ? parseInt(b.ops_supervisor_id) : null,
        b.planning_owner_id ? parseInt(b.planning_owner_id) : null,
        b.marketing_owner_id ? parseInt(b.marketing_owner_id) : null,
        b.accounts_owner_id ? parseInt(b.accounts_owner_id) : null
      ].filter(Boolean))];
      addMembersToThread(threadId, memberIds, 'member', true);
      postSystemMessage(threadId, `Thread created for job ${b.job_number}`);
    }

    req.flash('success', `Job ${jobNumber} created successfully.`);
    // Land on the new job's detail page (not the long /jobs list) so the
    // planner sees their just-created job straight away rather than having
    // to hunt for it in a status-sorted register.
    req.session.save(() => res.redirect(newJobId ? ('/jobs/' + newJobId.id) : '/jobs'));
  } catch (err) {
    console.error('[Jobs] CREATE ERROR:', err.message);
    if (err.message.includes('UNIQUE')) {
      req.flash('error', `Job number ${jobNumber} already exists. Please try again.`);
    } else {
      req.flash('error', 'Failed to create job: ' + err.message);
    }
    req.session.save(() => res.redirect('/jobs'));
  }
});

// API: Get unlinked compliance items (must be before /:id routes)
router.get('/api/compliance/unlinked', (req, res) => {
  const db = getDb();
  const jobId = req.query.job_id;
  const items = db.prepare(`
    SELECT id, title, item_type, item_types FROM compliance
    WHERE job_id IS NULL OR job_id != ?
    ORDER BY title LIMIT 100
  `).all(jobId || 0);
  res.json(items);
});

// Job detail page
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
    req.flash('error', 'Job not found.');
    return req.session.save(() => res.redirect('/jobs'));
  }

  // Tender link (if this job is rolled up under a tender)
  job.tender = null;
  if (job.tender_id) {
    try {
      job.tender = db.prepare("SELECT id, tender_number, title, status FROM tenders WHERE id = ?").get(job.tender_id);
    } catch (e) { /* tenders table may not exist on stale deploy */ }
  }

  // Auto-calculate health from live data
  job.health = recalculateJobHealth(db, job.id);

  // Job's Tasks tab = ops work only. Planning-division tasks (including
  // legacy auto-tasks from Plans & Approvals that pre-date the compliance_id
  // column) live under Traffic Plans instead.
  const tasks = db.prepare(`
    SELECT t.*, u.full_name as owner_name FROM tasks t
    LEFT JOIN users u ON t.owner_id = u.id
    WHERE t.job_id = ? AND t.deleted_at IS NULL AND t.compliance_id IS NULL AND t.division != 'planning'${hideAdminTasksSql(req.session.user)}
    ORDER BY CASE t.status WHEN 'blocked' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'not_started' THEN 3 ELSE 4 END, t.due_date ASC
  `).all(job.id);
  // Enrich tasks with all owners from junction table
  try {
    const ownerQuery = db.prepare('SELECT u.id, u.full_name FROM task_owners tow JOIN users u ON tow.user_id = u.id WHERE tow.task_id = ? ORDER BY u.full_name');
    tasks.forEach(t => {
      t.owners = ownerQuery.all(t.id);
      if (t.owners.length === 0 && t.owner_name) t.owners = [{ id: t.owner_id, full_name: t.owner_name }];
    });
  } catch(e) { tasks.forEach(t => { t.owners = t.owner_name ? [{ id: t.owner_id, full_name: t.owner_name }] : []; }); }

  const complianceItems = db.prepare(`
    SELECT c.*, u.full_name as approver_name FROM compliance c
    LEFT JOIN users u ON c.internal_approver_id = u.id
    WHERE c.job_id = ? ORDER BY c.due_date ASC
  `).all(job.id);

  // Pre-bucket sub-plans by parent so the Plans tab can render parent rows
  // with an expandable sub-plan list — same shape as the /compliance register.
  // Children may live under a parent that isn't job-scoped (or vice versa),
  // so pull sub-plans by parent_id IN (...) rather than relying on c.job_id.
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
  const accountsDocs = canViewAccounts(req.session.user)
    ? db.prepare("SELECT * FROM documents WHERE job_id = ? AND library = 'accounts' ORDER BY category, original_name").all(job.id)
    : [];

  // Incidents for this job
  const incidents = db.prepare(`
    SELECT i.*, u.full_name as reported_by_name FROM incidents i
    LEFT JOIN users u ON i.reported_by_id = u.id
    WHERE i.job_id = ? ORDER BY i.incident_date DESC
  `).all(job.id);

  // Contacts for this job
  const contacts = db.prepare(`
    SELECT * FROM client_contacts WHERE job_id = ? ORDER BY is_primary DESC, full_name ASC
  `).all(job.id);

  // Timesheets for this job (recent)
  const timesheets = db.prepare(`
    SELECT ts.*, cm.full_name as crew_name, u.full_name as approved_by_name
    FROM timesheets ts
    LEFT JOIN crew_members cm ON ts.crew_member_id = cm.id
    LEFT JOIN users u ON ts.approved_by_id = u.id
    WHERE ts.job_id = ? ORDER BY ts.work_date DESC LIMIT 50
  `).all(job.id);

  // Budget for this job
  let budget = db.prepare(`SELECT * FROM job_budgets WHERE job_id = ?`).get(job.id);
  // Auto-create budget if none exists
  if (!budget) {
    try {
      db.prepare('INSERT INTO job_budgets (job_id, contract_value, updated_by_id) VALUES (?, ?, ?)').run(job.id, job.contract_value || 0, req.session.user.id);
      budget = db.prepare(`SELECT * FROM job_budgets WHERE job_id = ?`).get(job.id);
    } catch(e) { /* ignore */ }
  }
  const costEntries = db.prepare(`
    SELECT ce.*, u.full_name as entered_by_name FROM cost_entries ce
    LEFT JOIN users u ON ce.entered_by_id = u.id
    WHERE ce.job_id = ? ORDER BY ce.entry_date DESC LIMIT 30
  `).all(job.id);
  const totalSpend = db.prepare(`SELECT COALESCE(SUM(amount), 0) as total FROM cost_entries WHERE job_id = ?`).get(job.id).total;

  // Compliance costs for this job (council fees + plan costs)
  const complianceCosts = db.prepare(`SELECT COALESCE(SUM(costs), 0) + COALESCE(SUM(council_fee_amount), 0) as total FROM compliance WHERE job_id = ?`).get(job.id).total;

  // Equipment maintenance costs for equipment assigned to this job
  const equipmentCosts = db.prepare(`
    SELECT COALESCE(SUM(em.cost), 0) as total FROM equipment_maintenance em
    INNER JOIN equipment_assignments ea ON em.equipment_id = ea.equipment_id
    WHERE ea.job_id = ?
  `).get(job.id).total;

  // Equipment assigned to this job
  const equipmentAssignments = db.prepare(`
    SELECT ea.*, e.name as equipment_name, e.asset_number, e.category, e.current_condition as equipment_condition,
      u.full_name as assigned_by_name
    FROM equipment_assignments ea
    LEFT JOIN equipment e ON ea.equipment_id = e.id
    LEFT JOIN users u ON ea.assigned_by_id = u.id
    WHERE ea.job_id = ? ORDER BY ea.assigned_date DESC
  `).all(job.id);

  // Hire dockets linked to this job
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
  } catch (e) { /* column/table may be older — ignore */ }

  // Traffic plans for this job
  const trafficPlans = db.prepare(`
    SELECT tp.*, u.full_name as created_by_name FROM traffic_plans tp
    LEFT JOIN users u ON tp.created_by_id = u.id
    WHERE tp.job_id = ? ORDER BY tp.created_at DESC
  `).all(job.id);

  // Site diary entries for this job
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

  // TGS plans for the diary TGS Link dropdown
  const tgsPlans = db.prepare(`SELECT id, plan_number FROM traffic_plans WHERE job_id = ? ORDER BY plan_number`).all(job.id);

  // Compliance TGS items for diary linking
  const complianceTgsItems = db.prepare(`SELECT id, title, item_type, item_types FROM compliance WHERE job_id = ? AND (item_type = 'traffic_guidance' OR item_types LIKE '%traffic_guidance%') ORDER BY title`).all(job.id);

  // Users list for representative dropdown
  const allUsers = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  // Diary attachments (bulk fetch for all entries)
  let diaryAttachments = [];
  try { diaryAttachments = db.prepare('SELECT * FROM site_diary_attachments WHERE diary_entry_id IN (SELECT id FROM site_diary_entries WHERE job_id = ?)').all(job.id); } catch(e) { /* table may not exist yet */ }

  // Lazy-create chat thread for pre-existing jobs
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

  // Chat members
  let chatMembers = [];
  try { chatMembers = db.prepare('SELECT u.id, u.full_name, u.role FROM chat_thread_members ctm JOIN users u ON ctm.user_id = u.id WHERE ctm.thread_id = ? AND u.active = 1 ORDER BY u.full_name').all(chatThreadId); } catch(e) {}

  // job.id coerced to int up front and reused by every job-scoped lookup
  // below. CAST(job_id) on top of parseInt covers legacy rows whose
  // job_id was stored as text.
  const jobIdInt = parseInt(job.id, 10);

  // Final plans = approved compliance items + traffic_plans marked as final (for operations view)
  // Each query lives in its own try/catch so a hiccup in the compliance
  // lookup doesn't silently nuke finalTrafficPlans (the bug behind
  // "Push to Final Plans" uploads not appearing on the Final Plans tab).
  let finalPlans = [];
  let finalPlanDocs = [];
  let finalTrafficPlans = [];
  try {
    finalPlans = db.prepare(`
      SELECT c.*, u.full_name as approver_name, d.full_name as designer_name
      FROM compliance c
      LEFT JOIN users u ON c.internal_approver_id = u.id
      LEFT JOIN users d ON c.assigned_to_id = d.id
      WHERE CAST(c.job_id AS INTEGER) = ? AND c.status IN ('approved','submitted')
      ORDER BY c.title
    `).all(jobIdInt);
  } catch (e) {
    console.error('[Jobs] finalPlans (compliance) query failed for job', job.id, ':', e.message);
  }
  try {
    if (finalPlans.length > 0) {
      finalPlanDocs = db.prepare(`
        SELECT cd.*, u.full_name as uploaded_by_name
        FROM compliance_documents cd
        LEFT JOIN users u ON cd.uploaded_by_id = u.id
        WHERE cd.compliance_id IN (SELECT id FROM compliance WHERE CAST(job_id AS INTEGER) = ? AND status IN ('approved','submitted'))
        ORDER BY cd.created_at DESC
      `).all(jobIdInt);
    }
  } catch (e) {
    console.error('[Jobs] finalPlanDocs query failed for job', job.id, ':', e.message);
  }
  // Reuse the trafficPlans dataset (which is what the Traffic Plans tab
  // shows) and filter by is_final in JS. This guarantees the two tabs
  // never disagree — if Traffic Plans renders a row with the FINAL
  // badge, Final Plans is guaranteed to surface the same row.
  // is_final is INTEGER 0/1 normally but historic rows can be '1'/true
  // so we coerce broadly.
  try {
    const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true';
    finalTrafficPlans = (trafficPlans || [])
      .filter(t => isTruthy(t.is_final))
      .map(t => ({ ...t, marked_final_by_name: null }));
    if (finalTrafficPlans.length > 0) {
      // Hydrate marked_final_by_name in one round-trip rather than
      // running the JOIN inline above.
      const ids = [...new Set(finalTrafficPlans.map(t => t.marked_final_by).filter(Boolean))];
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const userMap = {};
        for (const u of db.prepare(`SELECT id, full_name FROM users WHERE id IN (${placeholders})`).all(...ids)) {
          userMap[u.id] = u.full_name;
        }
        finalTrafficPlans = finalTrafficPlans.map(t => ({ ...t, marked_final_by_name: userMap[t.marked_final_by] || null }));
      }
      finalTrafficPlans.sort((a, b) => {
        const am = a.marked_final_at || '';
        const bm = b.marked_final_at || '';
        return bm.localeCompare(am);
      });
    }
  } catch (e) {
    console.error('[Jobs] finalTrafficPlans filter failed for job', job.id, ':', e.message);
  }

  // Plan flags for this job
  let planFlags = [];
  try { planFlags = db.prepare('SELECT pf.*, u.full_name as flagged_by_name, tp.plan_number FROM plan_flags pf LEFT JOIN users u ON pf.flagged_by = u.id LEFT JOIN traffic_plans tp ON pf.plan_id = tp.id WHERE pf.job_id = ? ORDER BY pf.created_at DESC').all(job.id); } catch(e) {}

  // Plan revisions for plans in this job
  let planRevisions = [];
  try { planRevisions = db.prepare('SELECT pr.*, u.full_name as created_by_name FROM plan_revisions pr LEFT JOIN users u ON pr.created_by = u.id WHERE pr.plan_id IN (SELECT id FROM traffic_plans WHERE job_id = ?) ORDER BY pr.created_at DESC').all(job.id); } catch(e) {}

  // View mode: planning, operations, or all (admin toggle)
  const viewMode = req.query.view || '';

  // SWMS + Risk Assessments attached to this job — feed the Safety tab.
  // Schema-aware probes so a pre-migration deploy doesn't crash here;
  // the tab just shows empty if either table doesn't exist yet.
  // jobIdInt is reused from the Final Plans block above.
  // Pull every job-kind SWMS / RA and filter by job_id in JS using
  // string-coerced equality. This is bulletproof against any storage
  // weirdness (job_id stored as text, with whitespace, etc.) where
  // a SQL = comparison was silently missing rows. The SWMS register
  // page works using SQL = ? so we know the data is reachable; the
  // job-detail Safety tab now matches via JS coercion to remove the
  // last shred of doubt.
  const matchesJob = (rowJobId) => {
    if (rowJobId == null) return false;
    return String(rowJobId).trim() === String(jobIdInt);
  };

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
    console.error('[Jobs] SWMS Safety tab query failed for job', job.id, ':', e.message);
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
    console.error('[Jobs] Risk Assessments Safety tab query failed for job', job.id, ':', e.message);
  }

  // Site audits attached to this job — also surface under the Safety tab.
  // Same storage-coercion gotcha as SWMS / RA above: job_id may be stored
  // as TEXT on legacy rows so SQL `= ?` can silently miss matches. Filter
  // in JS with String() coercion to be bulletproof.
  let auditsForJob = [];
  try {
    const rows = db.prepare(`
      SELECT a.id, a.job_id, a.audit_datetime, a.auditor_name, a.overall_result, a.overall_finding,
        a.score_total, a.score_max, a.score_percent, a.status,
        u.full_name AS auditor_user_name
      FROM site_audits a
      LEFT JOIN users u ON u.id = a.auditor_id
      WHERE a.job_id IS NOT NULL
      ORDER BY COALESCE(a.audit_datetime, a.created_at) DESC, a.id DESC
    `).all();
    auditsForJob = rows.filter(r => matchesJob(r.job_id));
  } catch (e) {
    console.error('[Jobs] Site Audits Safety tab query failed for job', job.id, ':', e.message);
  }

  // Scoped Safety roll-up for the #safety tab (reuses the Safety Today helpers).
  let safetyRollup = null;
  try {
    safetyRollup = require('./helpers/safety-today-queries').buildScopedRollup(db, { jobId: job.id });
  } catch (e) {
    console.error('[Jobs] safety rollup failed for job', job.id, ':', e.message);
  }

  // Sightline: service packages + CRM back-links for this project.
  let servicePackages = [];
  let crmLinks = null;
  let jobDeliverables = [];
  let jobApprovals = [];
  let jobVariations = [];
  try {
    servicePackages = db.prepare(`
      SELECT sp.*, u.full_name AS owner_name FROM service_packages sp
      LEFT JOIN users u ON sp.owner_id = u.id
      WHERE sp.job_id = ? ORDER BY sp.package_ref
    `).all(job.id);
    crmLinks = {
      opportunity: job.opportunity_id ? db.prepare('SELECT id, opportunity_number, title FROM opportunities WHERE id = ?').get(job.opportunity_id) : null,
      proposal: job.proposal_id ? db.prepare('SELECT id, proposal_ref, fee, acceptance_reference FROM proposals WHERE id = ?').get(job.proposal_id) : null,
    };
    jobDeliverables = db.prepare(`
      SELECT d.*,
        (SELECT r.revision_label FROM deliverable_revisions r WHERE r.deliverable_id = d.id ORDER BY r.id DESC LIMIT 1) AS current_revision
      FROM deliverables d WHERE d.job_id = ? ORDER BY d.deliverable_ref
    `).all(job.id);
    jobApprovals = db.prepare(`
      SELECT a.*, u.full_name AS responsible_name FROM approvals a
      LEFT JOIN users u ON a.responsible_id = u.id
      WHERE a.job_id = ? ORDER BY a.approval_ref
    `).all(job.id);
    jobVariations = db.prepare(`
      SELECT * FROM variations WHERE job_id = ?
      ORDER BY CASE approval_status WHEN 'submitted' THEN 0 WHEN 'draft' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, variation_ref
    `).all(job.id);
  } catch (e) {
    console.error('[Jobs] service packages/CRM links failed for job', job.id, ':', e.message);
  }

  res.render('jobs/show', {
    title: job.job_number,
    job, tasks, complianceItems, subPlansByParent, deliveryDocs, accountsDocs,
    incidents, contacts, timesheets, budget, costEntries, totalSpend,
    complianceCosts, equipmentCosts,
    equipmentAssignments, hireDockets, trafficPlans, chatThreadId, diaryEntries, tgsPlans,
    complianceTgsItems, allUsers, diaryAttachments, chatMembers,
    finalPlans, finalPlanDocs, finalTrafficPlans, planFlags, planRevisions, viewMode,
    swmsForJob, riskAssessmentsForJob, auditsForJob, safetyRollup,
    servicePackages, crmLinks, jobDeliverables, jobApprovals, jobVariations,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// Edit job form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) { req.flash('error', 'Job not found.'); return req.session.save(() => res.redirect('/jobs')); }
  const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  res.render('jobs/form', { title: 'Edit Job', job, users, clients, user: req.session.user });
});

// Update job
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const existing = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(req.params.id);
  if (!existing) { req.flash('error', 'Job not found.'); return req.session.save(() => res.redirect('/jobs')); }
  let clientName = b.client || '';
  if (b.client_id) {
    const cl = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(b.client_id);
    if (cl) clientName = cl.company_name;
  }
  const jobName = `${existing.job_number} | ${clientName} | ${b.suburb} | ${b.start_date}`;

  try {
    const isMonthly = !!b.recurring_monthly;
    const patternName = (b.recurring_pattern_name || 'Packages').toString().trim().slice(0, 80);
    db.prepare(`
      UPDATE jobs SET job_name=?, client=?, client_id=?, site_address=?, suburb=?, status=?, stage=?, percent_complete=?, start_date=?, end_date=?,
        project_manager_id=?, ops_supervisor_id=?, planning_owner_id=?, marketing_owner_id=?, accounts_owner_id=?,
        health=?, accounts_status=?, division_tags=?, notes=?,
        client_project_number=?, project_name=?, principal_contractor=?, traffic_supervisor_id=?,
        contract_value=?, estimated_hours=?, crew_size=?, vehicles=?, rol_required=?, tmp_required=?, tgs_required=?, spa_required=?, council_approval=?, bus_approval=?,
        sharepoint_url=?, state=?,
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
      parseFloat(b.contract_value) || 0, parseFloat(b.estimated_hours) || 0, parseInt(b.crew_size) || 0, parseInt(b.vehicles) || 0,
      b.rol_required ? 1 : 0, b.tmp_required ? 1 : 0, b.tgs_required ? 1 : 0, b.spa_required ? 1 : 0, b.council_approval ? 1 : 0, b.bus_approval ? 1 : 0,
      b.sharepoint_url || '', b.state || '',
      b.required_tcp_level || '',
      b.priority || 'normal',
      isMonthly ? 1 : 0, patternName,
      req.params.id
    );
    // Archive chat thread when job is completed/closed
    if (['completed', 'closed'].includes(b.status)) {
      const threadId = getThreadForEntity('job', parseInt(req.params.id));
      if (threadId) {
        db.prepare("UPDATE chat_threads SET status = 'archived' WHERE id = ?").run(threadId);
        postSystemMessage(threadId, `Thread archived — job ${b.status}`);
      }
    }

    // If the user picked extra months on the edit form, mint sibling
    // jobs for any that don't already exist (same client + pattern +
    // year). Re-saving with the same months is a no-op.
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

    require('../lib/sightlineJobFields').applySightlineJobFields(db, req.params.id, b);

    if (mintedCount > 0) req.flash('success', `Job updated · added ${mintedCount} new monthly job(s).`);
    else req.flash('success', 'Job updated successfully.');
    req.session.save(() => res.redirect(`/jobs/${req.params.id}`));
  } catch (err) {
    console.error('[Jobs] UPDATE ERROR:', err && err.stack || err);
    req.flash('error', 'Failed to update job: ' + err.message);
    // Stay on edit so the user can retry without losing their other changes.
    req.session.save(() => res.redirect(`/jobs/${req.params.id}/edit`));
  }
});

// Deleting a job is handled by POST /projects/:id/delete — the one path that
// checks for attached shifts/forms/dockets/timesheets/costs first and clears
// every job reference in a transaction. This route was a bare
// `DELETE FROM jobs`, which throws "FOREIGN KEY constraint failed" the moment
// a job has a booking (foreign_keys = ON), so it forwards rather than
// duplicating that logic.
router.post('/:id/delete', (req, res) => {
  res.redirect(307, '/projects/' + req.params.id + '/delete');
});

// Add member to job chat
router.post('/:id/chat/add-member', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.body.user_id);
  if (!userId) { req.flash('error', 'No user selected.'); return req.session.save(() => res.redirect(`/projects/${req.params.id}#chat`)); }
  const chatThreadId = getThreadForEntity('job', parseInt(req.params.id));
  if (chatThreadId) {
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
    addMembersToThread(chatThreadId, [userId], 'member', false);
    req.flash('success', `${user ? user.full_name : 'User'} added to chat.`);
  } else {
    req.flash('error', 'Chat thread not found.');
  }
  req.session.save(() => res.redirect(`/projects/${req.params.id}#chat`));
});

// Link an existing compliance item to this job
router.post('/:id/link-compliance', (req, res) => {
  const db = getDb();
  const complianceId = req.body.compliance_id;
  if (complianceId) {
    try {
      db.prepare('UPDATE compliance SET job_id = ? WHERE id = ?').run(req.params.id, complianceId);
      req.flash('success', 'Item linked to this job.');
    } catch(e) {
      req.flash('error', 'Failed to link item: ' + e.message);
    }
  }
  const hash = req.body.redirect_hash || 'compliance';
  req.session.save(() => res.redirect(`/projects/${req.params.id}#${hash}`));
});

// Unlink a compliance item from this job
router.post('/:id/unlink-compliance', (req, res) => {
  const db = getDb();
  const complianceId = req.body.compliance_id;
  if (complianceId) {
    db.prepare('UPDATE compliance SET job_id = NULL WHERE id = ? AND job_id = ?').run(complianceId, req.params.id);
    req.flash('success', 'Item unlinked from this job.');
  }
  const hash = req.body.redirect_hash || 'compliance';
  req.session.save(() => res.redirect(`/projects/${req.params.id}#${hash}`));
});

// Compliance Document Upload was removed here: it wrote library='compliance',
// which the documents table's CHECK(library IN ('delivery','accounts')) has
// always rejected, so the upload could never succeed and the matching
// delete/serve routes could never find a row. Nothing linked any of them.
// Plan documents live in the Compliance module (/compliance) instead.

// =============================================
// Site Diary CRUD
// =============================================

// Create diary entry
router.post('/:id/diary', diaryUpload.array('attachments', 5), (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO site_diary_entries (job_id, entry_date, task, representative, representative_id, client_representative, outcomes, issues, comments, stage, tgs_number, tgs_scope, tgs_plan_id, compliance_item_id, equipment_assignment_id, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id, b.entry_date, b.task || '', b.representative || '', b.representative_id || null,
      b.client_representative || '',
      b.outcomes || '', b.issues || '', b.comments || '', b.stage || '',
      b.tgs_number || '', b.tgs_scope || '', b.tgs_plan_id || null,
      b.compliance_item_id || null, b.equipment_assignment_id || null,
      req.session.user.id
    );
    // Save file attachments
    const entryId = result.lastInsertRowid;
    if (req.files && req.files.length > 0) {
      const ins = db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, file_path, original_name) VALUES (?, ?, ?)');
      req.files.forEach(f => ins.run(entryId, '/data/uploads/diary/' + req.params.id + '/' + f.filename, f.originalname));
    }
    if (b.sharepoint_link && b.sharepoint_link.trim()) {
      db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, sharepoint_link) VALUES (?, ?)').run(entryId, b.sharepoint_link.trim());
    }
    // Update job's last_update_date so "missing weekly update" stays accurate
    try { db.prepare('UPDATE jobs SET last_update_date = ? WHERE id = ?').run(new Date().toISOString().split('T')[0], req.params.id); } catch (e) { /* ignore */ }
    req.flash('success', 'Diary entry added.');
  } catch (err) {
    console.error('[Diary] CREATE ERROR:', err.message);
    req.flash('error', 'Failed to add diary entry: ' + err.message);
  }
  req.session.save(() => res.redirect(`/jobs/${req.params.id}#diary`));
});

// Update diary entry
router.post('/:id/diary/:entryId', diaryUpload.array('attachments', 5), (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    db.prepare(`
      UPDATE site_diary_entries SET entry_date=?, task=?, representative=?, representative_id=?, client_representative=?, outcomes=?, issues=?, comments=?, stage=?, tgs_number=?, tgs_scope=?, tgs_plan_id=?, compliance_item_id=?, equipment_assignment_id=?, updated_at=CURRENT_TIMESTAMP
      WHERE id = ? AND job_id = ?
    `).run(
      b.entry_date, b.task || '', b.representative || '', b.representative_id || null,
      b.client_representative || '',
      b.outcomes || '', b.issues || '', b.comments || '', b.stage || '',
      b.tgs_number || '', b.tgs_scope || '', b.tgs_plan_id || null,
      b.compliance_item_id || null, b.equipment_assignment_id || null,
      req.params.entryId, req.params.id
    );
    // Save new attachments
    if (req.files && req.files.length > 0) {
      const ins = db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, file_path, original_name) VALUES (?, ?, ?)');
      req.files.forEach(f => ins.run(req.params.entryId, '/data/uploads/diary/' + req.params.id + '/' + f.filename, f.originalname));
    }
    if (b.sharepoint_link && b.sharepoint_link.trim()) {
      db.prepare('INSERT INTO site_diary_attachments (diary_entry_id, sharepoint_link) VALUES (?, ?)').run(req.params.entryId, b.sharepoint_link.trim());
    }
    req.flash('success', 'Diary entry updated.');
  } catch (err) {
    console.error('[Diary] UPDATE ERROR:', err.message);
    req.flash('error', 'Failed to update diary entry: ' + err.message);
  }
  req.session.save(() => res.redirect(`/jobs/${req.params.id}#diary`));
});

// Delete diary entry
router.post('/:id/diary/:entryId/delete', (req, res) => {
  const db = getDb();
  try {
    db.prepare('DELETE FROM site_diary_entries WHERE id = ? AND job_id = ?').run(req.params.entryId, req.params.id);
    req.flash('success', 'Diary entry deleted.');
  } catch (err) {
    req.flash('error', 'Failed to delete diary entry: ' + err.message);
  }
  req.session.save(() => res.redirect(`/jobs/${req.params.id}#diary`));
});

// =============================================
// Job-Pack Site Documents (TGS / TMP / ROL / Stage Plan / SWMS / Permit)
// Surfaced on the worker portal under each shift's DOCS tab.
// =============================================

const JOB_DOC_DIR = pathLib.join(__dirname, '..', 'data', 'uploads', 'job-docs');
const jobDocStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = pathLib.join(JOB_DOC_DIR, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = (pathLib.extname(file.originalname || '.pdf') || '.pdf').toLowerCase();
    cb(null, `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const jobDocUpload = multer({
  storage: jobDocStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // Site-document pack is almost always PDFs but allow common image/doc
    // formats so allocators don't have to re-export.
    const allowed = /\.(pdf|doc|docx|png|jpg|jpeg|tiff)$/i;
    cb(null, allowed.test(pathLib.extname(file.originalname || '')));
  },
});
const ALLOWED_DOC_TYPES = new Set(['tgs','tmp','rol_day','rol_night','stage_plan','swms','permit','other']);

// GET /jobs/:id/documents — admin list + upload form (very small standalone
// page; the existing job/project show pages link here from a sidebar).
router.get('/:id/documents', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT id, job_number, job_name, client FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) {
    req.flash('error', 'Job not found.');
    return req.session.save(() => res.redirect('/jobs'));
  }
  const docs = db.prepare(`
    SELECT jd.*, u.full_name AS uploaded_by_name
    FROM job_documents jd
    LEFT JOIN users u ON jd.uploaded_by_id = u.id
    WHERE jd.job_id = ? AND jd.archived_at IS NULL
    ORDER BY uploaded_at DESC
  `).all(job.id);
  res.render('job-documents', {
    title: 'Site Documents — ' + (job.job_number || job.job_name),
    job,
    docs,
  });
});

// POST /jobs/:id/documents — upload one or more files
router.post('/:id/documents', jobDocUpload.array('files', 10), (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT id FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.redirect('/jobs');
  const docType = ALLOWED_DOC_TYPES.has(req.body.doc_type) ? req.body.doc_type : 'other';
  const title = (req.body.title || '').trim();
  const files = req.files || [];
  if (!files.length) {
    req.flash('error', 'Pick at least one file to upload.');
    return req.session.save(() => res.redirect(`/jobs/${job.id}/documents`));
  }
  const ins = db.prepare(`
    INSERT INTO job_documents (job_id, doc_type, title, file_path, original_name, mime_type, size_bytes, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const f of files) {
    const relPath = pathLib.relative(pathLib.join(__dirname, '..'), f.path);
    // If multiple files share one upload, fall back to the file's original name
    // for the title; otherwise honour the typed title.
    const useTitle = files.length === 1 && title ? title : (f.originalname || 'Document');
    ins.run(job.id, docType, useTitle, relPath, f.originalname || null, f.mimetype || null, f.size || 0, req.session.user.id);
  }
  req.flash('success', `${files.length} document(s) uploaded.`);
  req.session.save(() => res.redirect(`/jobs/${job.id}/documents`));
});

// POST /jobs/:id/documents/:docId/archive — soft-archive (workers stop seeing it)
router.post('/:id/documents/:docId/archive', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE job_documents SET archived_at = datetime(\'now\') WHERE id = ? AND job_id = ?').run(req.params.docId, req.params.id);
  req.flash('success', 'Document archived.');
  req.session.save(() => res.redirect(`/jobs/${req.params.id}/documents`));
});

// GET /jobs/:id/documents/:docId/download — open / download the file
router.get('/:id/documents/:docId/download', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM job_documents WHERE id = ? AND job_id = ?').get(req.params.docId, req.params.id);
  if (!doc) return res.status(404).send('Not found');
  const abs = pathLib.isAbsolute(doc.file_path) ? doc.file_path : pathLib.join(__dirname, '..', doc.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('File missing');
  res.setHeader('Content-Type', doc.mime_type || 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(doc.original_name || doc.title || 'document').replace(/[^\w. -]/g, '_')}"`);
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
