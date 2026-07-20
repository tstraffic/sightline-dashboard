const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// ============================================================
// GET / — BDM Dashboard
// ============================================================
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const userId = req.session.user.id;

    // Dashboard filters
    const view = req.query.view || 'my'; // 'my' or 'team'
    const filterOwnerId = req.query.owner_id || (view === 'my' ? userId : null);
    const period = req.query.period || 'month'; // week, month, quarter

    // Compute date boundaries based on period
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    let periodStart, periodEnd;
    if (period === 'week') {
      const todayDate2 = new Date(today + 'T00:00:00');
      const dow = todayDate2.getDay();
      const monOffset = dow === 0 ? -6 : 1 - dow;
      const mon = new Date(todayDate2);
      mon.setDate(todayDate2.getDate() + monOffset);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      periodStart = mon.toISOString().slice(0, 10);
      periodEnd = sun.toISOString().slice(0, 10);
    } else if (period === 'quarter') {
      const qMonth = Math.floor(now.getMonth() / 3) * 3;
      periodStart = new Date(now.getFullYear(), qMonth, 1).toISOString().slice(0, 10);
      periodEnd = new Date(now.getFullYear(), qMonth + 3, 0).toISOString().slice(0, 10);
    } else {
      periodStart = monthStart;
      periodEnd = monthEnd;
    }

    // Current week boundary (Monday) - always needed
    const todayDate = new Date(today + 'T00:00:00');
    const dayOfWeek = todayDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(todayDate);
    monday.setDate(todayDate.getDate() + mondayOffset);
    const weekStart = monday.toISOString().slice(0, 10);

    // Owner filter clause for pipeline queries
    const ownerFilter = filterOwnerId ? ' AND owner_id = ?' : '';
    const ownerParams = filterOwnerId ? [filterOwnerId] : [];

    // --- Pipeline Summary ---
    const pipelineSummary = db.prepare(`
      SELECT
        COUNT(*) as total_open,
        COALESCE(SUM(estimated_value), 0) as total_value,
        COALESCE(SUM(weighted_value), 0) as weighted_value
      FROM opportunities WHERE status = 'open'${ownerFilter}
    `).get(...ownerParams);

    const opportunitiesByStage = db.prepare(`
      SELECT stage, COUNT(*) as count, COALESCE(SUM(estimated_value), 0) as value
      FROM opportunities WHERE status = 'open'${ownerFilter}
      GROUP BY stage ORDER BY count DESC
    `).all(...ownerParams);

    const closingThisMonth = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(estimated_value), 0) as value
      FROM opportunities
      WHERE status = 'open' AND expected_close_date BETWEEN ? AND ?${ownerFilter}
    `).get(periodStart, periodEnd, ...ownerParams);

    const wonThisMonth = db.prepare(`
      SELECT COUNT(*) as count, COALESCE(SUM(estimated_value), 0) as value
      FROM opportunities
      WHERE status = 'won' AND updated_at >= ?${ownerFilter}
    `).get(periodStart, ...ownerParams);

    const lostThisMonth = db.prepare(`
      SELECT COUNT(*) as count
      FROM opportunities
      WHERE status = 'lost' AND updated_at >= ?${ownerFilter}
    `).get(periodStart, ...ownerParams);

    // --- Activity Summary ---
    const actOwnerFilter = filterOwnerId ? ' AND owner_id = ?' : '';
    const actOwnerParams = filterOwnerId ? [filterOwnerId] : [];

    const activitiesThisWeek = db.prepare(`
      SELECT activity_type, COUNT(*) as count
      FROM crm_activities
      WHERE activity_date >= ?${actOwnerFilter}
      GROUP BY activity_type
    `).all(weekStart, ...actOwnerParams);

    const followUpsDueToday = db.prepare(`
      SELECT COUNT(*) as count
      FROM crm_activities
      WHERE DATE(next_step_due_date) = ? AND is_completed = 0${actOwnerFilter}
    `).get(today, ...actOwnerParams);

    const overdueFollowUps = db.prepare(`
      SELECT COUNT(*) as count
      FROM crm_activities
      WHERE DATE(next_step_due_date) < ? AND is_completed = 0${actOwnerFilter}
    `).get(today, ...actOwnerParams);

    // Users for filter dropdown
    const dashboardUsers = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

    // --- Account Health ---
    const activeClients = db.prepare(`
      SELECT COUNT(*) as count FROM clients
      WHERE active = 1 AND company_type IN ('client', 'active_client')
    `).get();

    const prospects = db.prepare(`
      SELECT COUNT(*) as count FROM clients
      WHERE company_type IN ('lead', 'prospect')
    `).get();

    const sixtyDaysAgo = new Date(todayDate);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const sixtyDaysAgoStr = sixtyDaysAgo.toISOString().slice(0, 10);

    const dormantAccounts = db.prepare(`
      SELECT COUNT(*) as count FROM clients
      WHERE active = 1 AND (last_contacted_date < ? OR last_contacted_date IS NULL)
    `).get(sixtyDaysAgoStr);

    const accountsWithoutOwner = db.prepare(`
      SELECT COUNT(*) as count FROM clients
      WHERE account_owner_id IS NULL AND active = 1
    `).get();

    // --- My Actions ---
    const myTodayActivities = db.prepare(`
      SELECT ca.*, c.company_name as client_name, cc.full_name as contact_name
      FROM crm_activities ca
      LEFT JOIN clients c ON ca.client_id = c.id
      LEFT JOIN client_contacts cc ON ca.contact_id = cc.id
      WHERE ca.owner_id = ? AND DATE(ca.activity_date) = ?
      ORDER BY ca.activity_date ASC
    `).all(userId, today);

    const myOverdueFollowUps = db.prepare(`
      SELECT ca.*, c.company_name as client_name, cc.full_name as contact_name
      FROM crm_activities ca
      LEFT JOIN clients c ON ca.client_id = c.id
      LEFT JOIN client_contacts cc ON ca.contact_id = cc.id
      WHERE ca.owner_id = ? AND DATE(ca.next_step_due_date) < ? AND ca.is_completed = 0
      ORDER BY ca.next_step_due_date ASC
    `).all(userId, today);

    const myOppsNoNextStep = db.prepare(`
      SELECT o.*, c.company_name as client_name
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      WHERE o.owner_id = ? AND o.status = 'open' AND (o.next_step IS NULL OR o.next_step = '')
      ORDER BY o.expected_close_date ASC
    `).all(userId);

    // --- Recent Activity Feed ---
    const recentActivities = db.prepare(`
      SELECT ca.*,
        c.company_name as client_name,
        cc.full_name as contact_name,
        u.full_name as owner_name
      FROM crm_activities ca
      LEFT JOIN clients c ON ca.client_id = c.id
      LEFT JOIN client_contacts cc ON ca.contact_id = cc.id
      LEFT JOIN users u ON ca.owner_id = u.id
      ORDER BY ca.created_at DESC
      LIMIT 15
    `).all();

    // --- Conversion Tracking ---
    const leadsCreatedThisMonth = db.prepare(`
      SELECT COUNT(*) as count FROM clients
      WHERE created_at >= ? AND company_type IN ('lead', 'prospect')
    `).get(monthStart);

    const oppsCreatedThisMonth = db.prepare(`
      SELECT COUNT(*) as count FROM opportunities
      WHERE created_at >= ?
    `).get(monthStart);

    // Build activity summary from weekly data
    const callsThisWeek = activitiesThisWeek.find(a => a.activity_type === 'call');
    const emailsThisWeek = activitiesThisWeek.find(a => a.activity_type === 'email');
    const meetingsThisWeek = activitiesThisWeek.find(a => a.activity_type === 'meeting');

    res.render('crm/dashboard', {
      title: 'BDM Dashboard',
      currentPage: 'crm-dashboard',
      today,
      pipeline: {
        open_count: pipelineSummary.total_open,
        total_value: pipelineSummary.total_value,
        weighted_value: pipelineSummary.weighted_value,
        closing_this_month: closingThisMonth.count,
        won_value: wonThisMonth.value,
        lost_this_month: lostThisMonth.count,
      },
      opportunitiesByStage,
      myActions: {
        overdue_followups: myOverdueFollowUps,
        today_activities: myTodayActivities,
        no_next_step: myOppsNoNextStep,
      },
      recentActivities,
      activitySummary: {
        this_week_calls: callsThisWeek ? callsThisWeek.count : 0,
        this_week_emails: emailsThisWeek ? emailsThisWeek.count : 0,
        this_week_meetings: meetingsThisWeek ? meetingsThisWeek.count : 0,
        followups_due_today: followUpsDueToday.count,
        overdue_followups: overdueFollowUps.count,
      },
      accountHealth: {
        active_clients: activeClients.count,
        prospects: prospects.count,
        dormant_count: dormantAccounts.count,
        without_owner: accountsWithoutOwner.count,
      },
      conversion: {
        leads_this_month: leadsCreatedThisMonth.count,
        opps_this_month: oppsCreatedThisMonth.count,
        won_this_month: wonThisMonth.count,
        won_value: wonThisMonth.value,
      },
      filters: { view, owner_id: filterOwnerId, period },
      dashboardUsers,
    });
  } catch (err) {
    console.error('CRM Dashboard error:', err);
    next(err);
  }
});

// ============================================================
// GET /accounts — Accounts List
// ============================================================
router.get('/accounts', (req, res, next) => {
  try {
    const db = getDb();
    const { search, owner, type, status, priority, dormant, no_action } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    let query = `
      SELECT c.*,
        u_owner.full_name as owner_name,
        u_bdm.full_name as bdm_name,
        (SELECT COUNT(*) FROM opportunities o WHERE o.client_id = c.id AND o.status = 'open') as open_opps,
        (SELECT SUM(estimated_value) FROM opportunities o WHERE o.client_id = c.id AND o.status = 'open') as pipeline_value,
        (SELECT COUNT(*) FROM crm_activities ca WHERE ca.client_id = c.id) as activity_count
      FROM clients c
      LEFT JOIN users u_owner ON c.account_owner_id = u_owner.id
      LEFT JOIN users u_bdm ON c.bdm_owner_id = u_bdm.id
      WHERE 1=1
    `;
    const params = [];

    if (search) {
      query += ` AND (c.company_name LIKE ? OR c.primary_contact_name LIKE ? OR c.primary_contact_email LIKE ? OR c.abn LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    if (owner) {
      query += ` AND c.account_owner_id = ?`;
      params.push(owner);
    }
    if (type && ['lead', 'prospect', 'client', 'active_client', 'inactive_client', 'partner', 'contractor', 'subcontractor', 'supplier'].includes(type)) {
      query += ` AND c.company_type = ?`;
      params.push(type);
    }
    if (status === 'active') {
      query += ` AND c.active = 1`;
    } else if (status === 'inactive') {
      query += ` AND c.active = 0`;
    }
    if (priority) {
      query += ` AND c.priority = ?`;
      params.push(priority);
    }
    if (dormant === 'on' || dormant === '1') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);
      query += ` AND (c.last_contacted_date < ? OR c.last_contacted_date IS NULL)`;
      params.push(thirtyDaysAgoStr);
    }
    if (no_action === 'on' || no_action === '1') {
      query += ` AND c.next_action_date IS NULL`;
    }

    query += ` ORDER BY c.company_name ASC`;
    const accounts = db.prepare(query).all(...params);

    // Stats
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN company_type IN ('lead') THEN 1 ELSE 0 END) as leads,
        SUM(CASE WHEN company_type IN ('prospect') THEN 1 ELSE 0 END) as prospects,
        SUM(CASE WHEN company_type IN ('client', 'active_client') THEN 1 ELSE 0 END) as active_clients,
        SUM(CASE WHEN active = 1 AND (last_contacted_date < DATE('now', '-30 days') OR last_contacted_date IS NULL) THEN 1 ELSE 0 END) as dormant
      FROM clients
    `).get();

    // Users for owner filter dropdown
    const users = db.prepare(`SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name ASC`).all();

    res.render('crm/accounts', {
      title: 'Accounts',
      currentPage: 'crm-accounts',
      accounts,
      stats,
      users,
      filters: { search, owner, type, status, priority, dormant, no_action },
    });
  } catch (err) {
    console.error('CRM Accounts error:', err);
    next(err);
  }
});

// ============================================================
// GET /activities — Activity Log
// ============================================================
router.get('/activities', (req, res, next) => {
  try {
    const db = getDb();
    const { owner, activity_type, from, to, client_id, status, search } = req.query;
    const today = new Date().toISOString().slice(0, 10);

    let query = `
      SELECT ca.*,
        c.company_name as client_name,
        cc.full_name as contact_name,
        o.title as opportunity_title, o.opportunity_number,
        u.full_name as owner_name
      FROM crm_activities ca
      LEFT JOIN clients c ON ca.client_id = c.id
      LEFT JOIN client_contacts cc ON ca.contact_id = cc.id
      LEFT JOIN opportunities o ON ca.opportunity_id = o.id
      LEFT JOIN users u ON ca.owner_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (owner) {
      query += ` AND ca.owner_id = ?`;
      params.push(owner);
    }
    if (activity_type) {
      query += ` AND ca.activity_type = ?`;
      params.push(activity_type);
    }
    if (from) {
      query += ` AND DATE(ca.activity_date) >= ?`;
      params.push(from);
    }
    if (to) {
      query += ` AND DATE(ca.activity_date) <= ?`;
      params.push(to);
    }
    if (client_id) {
      query += ` AND ca.client_id = ?`;
      params.push(client_id);
    }
    if (status === 'completed') {
      query += ` AND ca.is_completed = 1`;
    } else if (status === 'overdue') {
      query += ` AND ca.is_completed = 0 AND DATE(ca.next_step_due_date) < ?`;
      params.push(today);
    } else if (status === 'pending') {
      query += ` AND ca.is_completed = 0`;
    }
    if (search) {
      query += ` AND (ca.subject LIKE ? OR ca.notes LIKE ? OR c.company_name LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s);
    }

    query += ` ORDER BY ca.activity_date DESC, ca.created_at DESC`;
    const activities = db.prepare(query).all(...params);

    // Users and clients for filter dropdowns
    const users = db.prepare(`SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name ASC`).all();
    const clients = db.prepare(`SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name ASC`).all();

    res.render('crm/activities', {
      title: 'CRM Activities',
      currentPage: 'crm-activities',
      activities,
      users,
      clients,
      filters: { owner, activity_type, from, to, client_id, status, search },
    });
  } catch (err) {
    console.error('CRM Activities error:', err);
    next(err);
  }
});

// ============================================================
// GET /activities/new — Log Activity Form
// ============================================================
router.get('/activities/new', (req, res, next) => {
  try {
    const db = getDb();

    const clients = db.prepare(`SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name ASC`).all();
    const contacts = db.prepare(`
      SELECT cc.id, cc.full_name, cc.position, c.company_name
      FROM client_contacts cc
      LEFT JOIN clients c ON cc.company_id = c.id
      ORDER BY cc.full_name ASC
    `).all();
    const opportunities = db.prepare(`
      SELECT id, title, opportunity_number, client_id
      FROM opportunities WHERE status = 'open'
      ORDER BY title ASC
    `).all();
    const users = db.prepare(`SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name ASC`).all();

    res.render('crm/activity-form', {
      title: 'Log Activity',
      currentPage: 'crm-activities',
      activity: null,
      clients,
      contacts,
      opportunities,
      users,
      prefill: req.query,
    });
  } catch (err) {
    console.error('CRM Activity Form error:', err);
    next(err);
  }
});

// ============================================================
// POST /activities — Create Activity
// ============================================================
router.post('/activities', (req, res) => {
  const db = getDb();
  const b = req.body;

  try {
    const result = db.prepare(`
      INSERT INTO crm_activities (activity_type, subject, notes, outcome, client_id, contact_id,
        opportunity_id, job_id, owner_id, activity_date, next_step, next_step_due_date,
        location, is_completed, reminder, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.activity_type || 'note',
      b.subject || '',
      b.notes || '',
      b.outcome || '',
      b.client_id || null,
      b.contact_id || null,
      b.opportunity_id || null,
      b.job_id || null,
      b.owner_id || req.session.user.id,
      b.activity_date || new Date().toISOString().slice(0, 10),
      b.next_step || '',
      b.next_step_due_date || null,
      b.location || '',
      b.is_completed ? 1 : 0,
      b.reminder || null,
      req.session.user.id
    );

    // Update client's last_contacted_date
    if (b.client_id) {
      db.prepare(`
        UPDATE clients SET last_contacted_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(b.activity_date || new Date().toISOString().slice(0, 10), b.client_id);
    }

    // Update contact's last_contact_date if contact_id provided
    if (b.contact_id) {
      try {
        db.prepare(`UPDATE client_contacts SET last_contact_date = ? WHERE id = ?`)
          .run(b.activity_date || new Date().toISOString().slice(0, 10), b.contact_id);
      } catch (e) {
        // last_contact_date column may not exist yet; ignore gracefully
        console.warn('Could not update contact last_contact_date:', e.message);
      }
    }

    // Update opportunity's last_activity_at if opportunity_id provided
    if (b.opportunity_id) {
      try {
        db.prepare(`UPDATE opportunities SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(b.opportunity_id);
      } catch (e) {
        console.warn('Could not update opportunity last_activity_at:', e.message);
      }
    }

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'crm_activity',
      entityId: result.lastInsertRowid,
      entityLabel: b.subject || b.activity_type,
      ip: req.ip
    });

    req.flash('success', 'Activity logged successfully.');

    // Redirect back to referrer if available, otherwise activities list
    const referer = req.get('Referer') || '';
    if (referer.includes('/crm/')) {
      return req.session.save(() => res.redirect(referer));
    }
    req.session.save(() => res.redirect('/crm/activities'));
  } catch (err) {
    console.error('Create CRM Activity error:', err);
    req.flash('error', 'Failed to log activity: ' + err.message);
    req.session.save(() => res.redirect('/crm/activities/new'));
  }
});

// ============================================================
// POST /activities/:id/complete — Mark Activity Complete
// ============================================================
router.post('/activities/:id/complete', (req, res) => {
  const db = getDb();

  try {
    db.prepare(`UPDATE crm_activities SET is_completed = 1 WHERE id = ?`).run(req.params.id);

    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'crm_activity',
      entityId: parseInt(req.params.id),
      entityLabel: 'Marked complete',
      ip: req.ip
    });

    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ success: true });
    }

    req.flash('success', 'Activity marked as complete.');
    req.session.save(() => res.redirect('back'));
  } catch (err) {
    console.error('Complete CRM Activity error:', err);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ success: false, error: err.message });
    }
    req.flash('error', 'Failed to complete activity: ' + err.message);
    req.session.save(() => res.redirect('back'));
  }
});

// ============================================================
// POST /activities/:id/create-task — Create Task from Activity
// ============================================================
router.post('/activities/:id/create-task', (req, res) => {
  const db = getDb();

  try {
    const activity = db.prepare(`
      SELECT ca.*, c.company_name as client_name
      FROM crm_activities ca
      LEFT JOIN clients c ON ca.client_id = c.id
      WHERE ca.id = ?
    `).get(req.params.id);

    if (!activity) {
      req.flash('error', 'Activity not found.');
      return req.session.save(() => res.redirect('/crm/activities'));
    }

    // Determine job_id: use activity's job_id, or find first active job for client
    let jobId = activity.job_id || null;
    if (!jobId && activity.client_id) {
      const activeJob = db.prepare(`
        SELECT id FROM jobs
        WHERE client_id = ? AND status IN ('active', 'on_hold', 'won')
        ORDER BY start_date DESC LIMIT 1
      `).get(activity.client_id);
      if (activeJob) {
        jobId = activeJob.id;
      }
    }

    if (!jobId) {
      req.flash('error', 'Cannot create task: no linked job found. Please associate a job with the client first.');
      return req.session.save(() => res.redirect('/crm/activities'));
    }

    // Build task details
    const today = new Date().toISOString().slice(0, 10);
    const sevenDaysLater = new Date();
    sevenDaysLater.setDate(sevenDaysLater.getDate() + 7);
    const defaultDue = sevenDaysLater.toISOString().slice(0, 10);

    const taskTitle = (activity.subject || 'CRM Activity') + ' (CRM Follow-up)';
    let taskDescription = '';
    if (activity.notes) taskDescription += activity.notes;
    if (activity.next_step) taskDescription += (taskDescription ? '\n\nNext Step: ' : 'Next Step: ') + activity.next_step;
    if (activity.client_name) taskDescription += (taskDescription ? '\n\nClient: ' : 'Client: ') + activity.client_name;

    const dueDate = activity.next_step_due_date || defaultDue;

    const result = db.prepare(`
      INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, notes)
      VALUES (?, 'ops', ?, ?, ?, ?, 'not_started', 'medium', 'one_off', ?)
    `).run(
      jobId,
      taskTitle,
      taskDescription,
      activity.owner_id || req.session.user.id,
      dueDate,
      'Created from CRM activity #' + activity.id
    );

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'task',
      entityId: result.lastInsertRowid,
      entityLabel: taskTitle,
      details: 'Created from CRM activity #' + activity.id,
      ip: req.ip
    });

    req.flash('success', `Task "${taskTitle}" created successfully.`);
    req.session.save(() => res.redirect('/tasks?tab=not_started'));
  } catch (err) {
    console.error('Create Task from Activity error:', err);
    req.flash('error', 'Failed to create task: ' + err.message);
    req.session.save(() => res.redirect('/crm/activities'));
  }
});

// ============================================================
// GET /reports — CRM Reports
// ============================================================
router.get('/reports', (req, res, next) => {
  try {
    const db = getDb();

    // Resolve stage labels from settings
    const allStages = res.locals.settingsOptions && res.locals.settingsOptions.opportunity_stages
      ? res.locals.settingsOptions.opportunity_stages : [];
    const stageMap = {};
    allStages.forEach(s => { stageMap[s.key] = s.label || s.key; });

    // Pipeline by stage
    const pipelineByStage = db.prepare(`
      SELECT stage,
        COUNT(*) as count,
        COALESCE(SUM(estimated_value), 0) as value,
        COALESCE(SUM(weighted_value), 0) as weighted_value
      FROM opportunities WHERE status = 'open'
      GROUP BY stage
      ORDER BY value DESC
    `).all().map(row => ({
      ...row,
      stage_label: stageMap[row.stage] || (row.stage || '').replace(/_/g, ' ')
    }));

    // Win/loss by month (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const sixMonthsAgoStr = sixMonthsAgo.toISOString().slice(0, 10);

    const winLoss = db.prepare(`
      SELECT
        SUBSTR(updated_at, 1, 7) as month,
        SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as won_count,
        SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost_count,
        COALESCE(SUM(CASE WHEN status = 'won' THEN estimated_value ELSE 0 END), 0) as won_value,
        COALESCE(SUM(CASE WHEN status = 'lost' THEN estimated_value ELSE 0 END), 0) as lost_value
      FROM opportunities
      WHERE status IN ('won', 'lost') AND updated_at >= ?
      GROUP BY SUBSTR(updated_at, 1, 7)
      ORDER BY month ASC
    `).all(sixMonthsAgoStr);

    // Activity by owner
    const activityByOwner = db.prepare(`
      SELECT u.full_name as owner_name, ca.owner_id,
        COUNT(*) as total,
        SUM(CASE WHEN ca.activity_type = 'call' THEN 1 ELSE 0 END) as calls,
        SUM(CASE WHEN ca.activity_type = 'email' THEN 1 ELSE 0 END) as emails,
        SUM(CASE WHEN ca.activity_type = 'meeting' THEN 1 ELSE 0 END) as meetings,
        SUM(CASE WHEN ca.activity_type = 'site_visit' THEN 1 ELSE 0 END) as site_visits
      FROM crm_activities ca
      LEFT JOIN users u ON ca.owner_id = u.id
      WHERE ca.owner_id IS NOT NULL
      GROUP BY ca.owner_id
      ORDER BY total DESC
    `).all();

    // Top accounts by pipeline value
    const topAccounts = db.prepare(`
      SELECT c.id, c.company_name, c.company_type, c.priority,
        COUNT(o.id) as open_opps,
        COALESCE(SUM(o.estimated_value), 0) as pipeline_value,
        COALESCE(SUM(o.weighted_value), 0) as weighted_value
      FROM clients c
      JOIN opportunities o ON o.client_id = c.id AND o.status = 'open'
      GROUP BY c.id
      ORDER BY pipeline_value DESC
      LIMIT 10
    `).all();

    // Dormant accounts (no contact in 30+ days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().slice(0, 10);

    const dormantAccounts = db.prepare(`
      SELECT c.id, c.company_name, c.company_type, c.last_contacted_date as last_contact_date,
        u.full_name as owner_name,
        CASE WHEN c.last_contacted_date IS NULL THEN NULL ELSE CAST(julianday('now') - julianday(c.last_contacted_date) AS INTEGER) END as days_since_contact
      FROM clients c
      LEFT JOIN users u ON c.account_owner_id = u.id
      WHERE c.active = 1 AND (c.last_contacted_date < ? OR c.last_contacted_date IS NULL)
      ORDER BY c.last_contacted_date IS NULL DESC, c.last_contacted_date ASC
    `).all(thirtyDaysAgoStr);

    // Pipeline by owner
    const pipelineByOwner = db.prepare(`
      SELECT u.full_name as owner_name, COUNT(*) as count,
        COALESCE(SUM(o.estimated_value), 0) as value,
        COALESCE(SUM(o.weighted_value), 0) as weighted
      FROM opportunities o
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.status = 'open'
      GROUP BY o.owner_id
      ORDER BY value DESC
    `).all();

    // Stale opportunities (no activity in 14+ days)
    const staleOpportunities = db.prepare(`
      SELECT o.*, c.company_name as client_name, u.full_name as owner_name,
        (SELECT MAX(ca.activity_date) FROM crm_activities ca WHERE ca.opportunity_id = o.id) as last_activity_date
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.status = 'open'
      AND (SELECT MAX(ca.activity_date) FROM crm_activities ca WHERE ca.opportunity_id = o.id) < DATE('now', '-14 days')
      OR (o.status = 'open' AND NOT EXISTS (SELECT 1 FROM crm_activities ca WHERE ca.opportunity_id = o.id))
      ORDER BY o.expected_close_date ASC
    `).all();

    // Follow-ups overdue
    const overdueFollowUps = db.prepare(`
      SELECT ca.*, c.company_name as client_name, u.full_name as owner_name,
        cc.full_name as contact_name
      FROM crm_activities ca
      LEFT JOIN clients c ON ca.client_id = c.id
      LEFT JOIN users u ON ca.owner_id = u.id
      LEFT JOIN client_contacts cc ON ca.contact_id = cc.id
      WHERE ca.is_completed = 0 AND DATE(ca.next_step_due_date) < DATE('now')
      ORDER BY ca.next_step_due_date ASC
      LIMIT 50
    `).all();

    // Opportunities without next step
    const oppsNoNextStep = db.prepare(`
      SELECT o.*, c.company_name as client_name, u.full_name as owner_name
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.status = 'open' AND (o.next_step IS NULL OR o.next_step = '')
      ORDER BY o.expected_close_date ASC
    `).all();

    // Meetings by owner (this month)
    const meetingsByOwner = db.prepare(`
      SELECT u.full_name as owner_name, COUNT(*) as count
      FROM crm_meetings m
      LEFT JOIN users u ON m.owner_id = u.id
      WHERE m.meeting_date >= DATE('now', 'start of month')
      GROUP BY m.owner_id
      ORDER BY count DESC
    `).all();

    // Activity trends — last 8 weeks
    const activityTrends = db.prepare(`
      SELECT
        CAST(strftime('%W', activity_date) AS INTEGER) as week_num,
        MIN(activity_date) as week_start,
        COUNT(*) as count
      FROM crm_activities
      WHERE activity_date >= DATE('now', '-56 days')
      GROUP BY strftime('%W', activity_date)
      ORDER BY week_num ASC
      LIMIT 8
    `).all();

    res.render('crm/reports', {
      title: 'CRM Reports',
      currentPage: 'crm-reports',
      pipelineByStage,
      winLoss,
      activityByOwner,
      topAccounts,
      dormantAccounts,
      pipelineByOwner,
      staleOpportunities,
      overdueFollowUps,
      oppsNoNextStep,
      meetingsByOwner,
      activityTrends,
    });
  } catch (err) {
    console.error('CRM Reports error:', err);
    next(err);
  }
});

// ============================================================
// GET /meetings — Meetings List
// ============================================================
router.get('/meetings', (req, res, next) => {
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const todayDate = new Date(today + 'T00:00:00');
    const dayOfWeek = todayDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(todayDate);
    monday.setDate(todayDate.getDate() + mondayOffset);
    const weekStart = monday.toISOString().slice(0, 10);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const weekEnd = sunday.toISOString().slice(0, 10);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    // Build query filters
    let where = [];
    let params = [];

    if (req.query.search) {
      where.push("(m.title LIKE ? OR c.company_name LIKE ?)");
      params.push('%' + req.query.search + '%', '%' + req.query.search + '%');
    }
    if (req.query.owner_id) {
      where.push('m.owner_id = ?');
      params.push(req.query.owner_id);
    }
    if (req.query.account_id) {
      where.push('m.account_id = ?');
      params.push(req.query.account_id);
    }
    if (req.query.from) {
      where.push('DATE(m.meeting_date) >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push('DATE(m.meeting_date) <= ?');
      params.push(req.query.to);
    }

    // View tab filter
    const view = req.query.view || 'upcoming';
    if (view === 'today') {
      where.push('DATE(m.meeting_date) = ?');
      params.push(today);
    } else if (view === 'this_week') {
      where.push('DATE(m.meeting_date) >= ? AND DATE(m.meeting_date) <= ?');
      params.push(weekStart, weekEnd);
    } else if (view === 'upcoming') {
      where.push('DATE(m.meeting_date) >= ?');
      params.push(today);
    } else if (view === 'past') {
      where.push('DATE(m.meeting_date) < ?');
      params.push(today);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

    const meetings = db.prepare(`
      SELECT m.*,
        c.company_name as account_name,
        u.full_name as owner_name,
        o.title as opportunity_title, o.opportunity_number
      FROM crm_meetings m
      LEFT JOIN clients c ON m.account_id = c.id
      LEFT JOIN users u ON m.owner_id = u.id
      LEFT JOIN opportunities o ON m.opportunity_id = o.id
      ${whereClause}
      ORDER BY ${view === 'past' ? 'm.meeting_date DESC' : 'm.meeting_date ASC'}
      LIMIT 100
    `).all(...params);

    // Stats
    const todayMeetings = db.prepare(`SELECT COUNT(*) as count FROM crm_meetings WHERE DATE(meeting_date) = ?`).get(today);
    const weekMeetings = db.prepare(`SELECT COUNT(*) as count FROM crm_meetings WHERE DATE(meeting_date) >= ? AND DATE(meeting_date) <= ?`).get(weekStart, weekEnd);
    const monthMeetings = db.prepare(`SELECT COUNT(*) as count FROM crm_meetings WHERE DATE(meeting_date) >= ? AND DATE(meeting_date) <= ?`).get(monthStart, monthEnd);
    const overdueFollowups = db.prepare(`SELECT COUNT(*) as count FROM crm_meetings WHERE outcome != '' AND follow_up_actions != '' AND next_meeting_date < ? AND next_meeting_date IS NOT NULL`).get(today);

    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
    const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();

    res.render('crm/meetings', {
      title: 'Meetings',
      currentPage: 'crm-meetings',
      meetings,
      stats: {
        today: todayMeetings.count,
        this_week: weekMeetings.count,
        this_month: monthMeetings.count,
        overdue_followups: overdueFollowups.count,
      },
      users,
      clients,
      filters: req.query,
      todayStr: today,
    });
  } catch (err) {
    console.error('Meetings list error:', err);
    next(err);
  }
});

// ============================================================
// GET /meetings/new — New Meeting Form
// ============================================================
router.get('/meetings/new', (req, res, next) => {
  try {
    const db = getDb();
    const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
    const opportunities = db.prepare("SELECT id, opportunity_number, title, client_id FROM opportunities WHERE status = 'open' ORDER BY title").all();
    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

    res.render('crm/meeting-form', {
      title: 'Schedule Meeting',
      currentPage: 'crm-meetings',
      meeting: null,
      clients,
      opportunities,
      users,
      query: req.query,
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /meetings — Create Meeting
// ============================================================
router.post('/meetings', (req, res, next) => {
  try {
    const db = getDb();
    const { title, meeting_date, duration_minutes, location_type, location_text,
            account_id, opportunity_id, owner_id, purpose, attendees, notes } = req.body;

    const result = db.prepare(`
      INSERT INTO crm_meetings (title, meeting_date, duration_minutes, location_type, location_text,
        account_id, opportunity_id, owner_id, purpose, attendees, notes, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      title, meeting_date, duration_minutes || null, location_type || '', location_text || '',
      account_id || null, opportunity_id || null, owner_id || null,
      purpose || '', attendees || '', notes || '', req.session.user.id
    );

    // Auto-create CRM activity for timeline
    const actResult = db.prepare(`
      INSERT INTO crm_activities (activity_type, subject, notes, client_id, contact_id, opportunity_id,
        owner_id, activity_date, location, created_by_id)
      VALUES ('meeting', ?, ?, ?, NULL, ?, ?, ?, ?, ?)
    `).run(
      title, purpose || notes || '', account_id || null, opportunity_id || null,
      owner_id || req.session.user.id, meeting_date, location_text || '',
      req.session.user.id
    );

    // Link activity to meeting
    db.prepare('UPDATE crm_meetings SET activity_id = ? WHERE id = ?').run(actResult.lastInsertRowid, result.lastInsertRowid);

    // Update account last_contacted_date
    if (account_id) {
      db.prepare('UPDATE clients SET last_contacted_date = ? WHERE id = ?').run(meeting_date ? meeting_date.slice(0, 10) : new Date().toISOString().slice(0, 10), account_id);
    }

    logActivity(req, { action: 'create', entity: 'crm_meeting', entityId: result.lastInsertRowid, entityLabel: title });

    req.flash('success', 'Meeting scheduled.');
    req.session.save(() => res.redirect('/crm/meetings'));
  } catch (err) {
    console.error('Create meeting error:', err);
    next(err);
  }
});

// ============================================================
// GET /meetings/:id/edit — Edit Meeting
// ============================================================
router.get('/meetings/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const meeting = db.prepare('SELECT * FROM crm_meetings WHERE id = ?').get(req.params.id);
    if (!meeting) { req.flash('error', 'Meeting not found.'); return req.session.save(() => res.redirect('/crm/meetings')); }

    const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
    const opportunities = db.prepare("SELECT id, opportunity_number, title, client_id FROM opportunities WHERE status = 'open' ORDER BY title").all();
    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

    res.render('crm/meeting-form', {
      title: 'Edit Meeting',
      currentPage: 'crm-meetings',
      meeting,
      clients,
      opportunities,
      users,
      query: {},
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST /meetings/:id — Update Meeting
// ============================================================
router.post('/meetings/:id', (req, res, next) => {
  try {
    const db = getDb();
    const { title, meeting_date, duration_minutes, location_type, location_text,
            account_id, opportunity_id, owner_id, purpose, attendees, notes,
            outcome, follow_up_actions, next_meeting_date } = req.body;

    db.prepare(`
      UPDATE crm_meetings SET
        title = ?, meeting_date = ?, duration_minutes = ?, location_type = ?, location_text = ?,
        account_id = ?, opportunity_id = ?, owner_id = ?, purpose = ?, attendees = ?, notes = ?,
        outcome = ?, follow_up_actions = ?, next_meeting_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, meeting_date, duration_minutes || null, location_type || '', location_text || '',
      account_id || null, opportunity_id || null, owner_id || null,
      purpose || '', attendees || '', notes || '',
      outcome || '', follow_up_actions || '', next_meeting_date || null,
      req.params.id
    );

    logActivity(req, { action: 'update', entity: 'crm_meeting', entityId: req.params.id, entityLabel: title });

    req.flash('success', 'Meeting updated.');
    req.session.save(() => res.redirect('/crm/meetings'));
  } catch (err) {
    console.error('Update meeting error:', err);
    next(err);
  }
});

module.exports = router;
