const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { sendTaskAssignmentEmail, sendTaskStatusEmail } = require('../middleware/email');
const { sendPushToUser } = require('../services/pushNotification');
const notifPrefs = require('../lib/notificationPrefs');
const { autoLogDiary, logStatusChange } = require('../lib/diary');
const { isAdminRole, hideAdminTasksSql } = require('../lib/taskVisibility');
const { closeCasFromTask } = require('../lib/correctiveActions');

/**
 * Check if current user can modify a task.
 * Allowed: any task owner (via task_owners table), admin role, management role.
 */
function canModifyTask(task, user) {
  if (!user) return false;
  const role = (user.role || '').toLowerCase();
  // Admin and management can always modify
  if (role === 'admin' || role === 'management') return true;
  // Primary owner
  if (task.owner_id && String(task.owner_id) === String(user.id)) return true;
  // Check task_owners junction table
  try {
    const db = getDb();
    const isOwner = db.prepare('SELECT 1 FROM task_owners WHERE task_id = ? AND user_id = ?').get(task.id, user.id);
    if (isOwner) return true;
  } catch (e) { /* table may not exist yet */ }
  return false;
}

/**
 * Check if current user can VIEW a task (read-only access counts).
 * Superset of canModifyTask: also lets watchers (people @mentioned on the
 * task or manually added by an owner) open the detail page and comment.
 */
function canViewTask(task, user) {
  if (canModifyTask(task, user)) return true;
  if (!user) return false;
  try {
    const db = getDb();
    const isWatcher = db.prepare('SELECT 1 FROM task_watchers WHERE task_id = ? AND user_id = ?').get(task.id, user.id);
    if (isWatcher) return true;
  } catch (e) { /* table may not exist yet */ }
  return false;
}

/** Helper: sync task_owners junction table for a task */
function syncTaskOwners(db, taskId, ownerIds) {
  db.prepare('DELETE FROM task_owners WHERE task_id = ?').run(taskId);
  const ins = db.prepare('INSERT OR IGNORE INTO task_owners (task_id, user_id) VALUES (?, ?)');
  for (const uid of ownerIds) {
    if (uid) ins.run(taskId, uid);
  }
}

/** Helper: get all owner names for a task */
function getTaskOwnerNames(db, taskId) {
  try {
    return db.prepare('SELECT u.id, u.full_name FROM task_owners tow JOIN users u ON tow.user_id = u.id WHERE tow.task_id = ? ORDER BY u.full_name').all(taskId);
  } catch (e) { return []; }
}

// GET / — Main tasks view with tabs, counts, and filters
router.get('/', (req, res) => {
  const db = getDb();
  const { tab, owner, priority, division, job_id, task_type, view, scope } = req.query;
  const today = new Date().toISOString().split('T')[0];
  const activeView = view || 'all';
  // scope='assigned_by_me' shows tasks the current user created (typically ones they
  // delegated to other people). Takes precedence over the owner filter.
  const assignedByMe = scope === 'assigned_by_me';

  // Build WHERE clause for tab filter
  let baseWhere = '1=1';
  const params = [];

  if (tab === 'not_started') { baseWhere += " AND t.status = 'not_started'"; }
  else if (tab === 'in_progress') { baseWhere += " AND t.status = 'in_progress'"; }
  else if (tab === 'blocked') { baseWhere += " AND t.status = 'blocked'"; }
  else if (tab === 'completed') { baseWhere += " AND t.status = 'complete'"; }
  else { baseWhere += " AND t.status != 'complete'"; } // Hide completed by default

  // View-based date filtering
  if (activeView === 'today') {
    baseWhere += ' AND t.due_date = ?';
    params.push(today);
  } else if (activeView === 'week') {
    const todayDate = new Date(today + 'T00:00:00');
    const dayOfWeek = todayDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(todayDate); monday.setDate(todayDate.getDate() + mondayOffset);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    baseWhere += ' AND t.due_date BETWEEN ? AND ?';
    params.push(monday.toISOString().split('T')[0], sunday.toISOString().split('T')[0]);
  }

  // Additional filters — admin/management defaults to all tasks, others default to their own
  const userRole = (req.session.user.role || '').toLowerCase();
  const isAdminRole = ['admin', 'management'].includes(userRole);
  const isPlanningRole = userRole === 'planning';
  if (assignedByMe) {
    // "Assigned by me" overrides the owner filter entirely — scope is by creator
    baseWhere += ' AND t.created_by = ?';
    params.push(req.session.user.id);
  }
  else if (owner === 'all' || (!owner && isAdminRole)) { /* show all tasks */ }
  else if (!owner && isPlanningRole) {
    // Planning sees: their own tasks + planning division tasks + compliance-linked
    // tasks + anything they're watching (so @mentions don't go to a dead end).
    baseWhere += " AND (t.owner_id = ? OR t.id IN (SELECT task_id FROM task_owners WHERE user_id = ?) OR t.id IN (SELECT task_id FROM task_watchers WHERE user_id = ?) OR t.division = 'planning' OR t.compliance_id IS NOT NULL)";
    params.push(req.session.user.id, req.session.user.id, req.session.user.id);
  }
  else if (owner === 'me' || (!owner && !isAdminRole)) {
    // Own tasks, co-owned tasks, plus tasks the user is watching (@mention recipients).
    baseWhere += ' AND (t.owner_id = ? OR t.id IN (SELECT task_id FROM task_owners WHERE user_id = ?) OR t.id IN (SELECT task_id FROM task_watchers WHERE user_id = ?))';
    params.push(req.session.user.id, req.session.user.id, req.session.user.id);
  }
  else if (owner) {
    baseWhere += ' AND (t.owner_id = ? OR t.id IN (SELECT task_id FROM task_owners WHERE user_id = ?) OR t.id IN (SELECT task_id FROM task_watchers WHERE user_id = ?))';
    params.push(owner, owner, owner);
  }
  if (priority && priority !== 'all') { baseWhere += ' AND t.priority = ?'; params.push(priority); }
  if (division && division !== 'all') { baseWhere += ' AND t.division = ?'; params.push(division); }
  if (job_id) { baseWhere += ' AND t.job_id = ?'; params.push(job_id); }
  if (task_type && task_type !== 'all') { baseWhere += ' AND t.task_type = ?'; params.push(task_type); }
  // Hide soft-deleted tasks from all default listings
  baseWhere += ' AND t.deleted_at IS NULL';
  // Admin-division tasks are private to the admin team
  baseWhere += hideAdminTasksSql(req.session.user);

  // Fetch tasks
  const tasks = db.prepare(`
    SELECT t.*, j.job_number, j.client, u.full_name as owner_name, cb.full_name as created_by_name
    FROM tasks t
    LEFT JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.owner_id = u.id
    LEFT JOIN users cb ON t.created_by = cb.id
    WHERE ${baseWhere}
    ORDER BY
      CASE WHEN t.status != 'complete' AND t.due_date < ? THEN 0 ELSE 1 END,
      t.due_date ASC,
      CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
  `).all(...params, today);

  // Enrich each task with all owner names from task_owners
  const ownerQuery = db.prepare('SELECT u.id, u.full_name FROM task_owners tow JOIN users u ON tow.user_id = u.id WHERE tow.task_id = ? ORDER BY u.full_name');
  tasks.forEach(t => {
    t.owners = ownerQuery.all(t.id);
    // Fallback: if no task_owners rows but owner_id exists, use the JOIN'd owner_name
    if (t.owners.length === 0 && t.owner_name) {
      t.owners = [{ id: t.owner_id, full_name: t.owner_name }];
    }
  });

  // Attach each task's checklist (subtasks) so the cards can show + tick them
  // off inline. Table may not exist pre-migration — degrade to empty lists.
  try {
    const subStmt = db.prepare('SELECT id, title, completed FROM subtasks WHERE task_id = ? ORDER BY sort_order ASC, id ASC');
    tasks.forEach(t => { t.subtasks = subStmt.all(t.id); });
  } catch (e) { tasks.forEach(t => { t.subtasks = []; }); }

  // Status counts (ignoring tab filter but respecting view + other filters)
  let countWhere = '1=1';
  const countParams = [];
  if (activeView === 'today') {
    countWhere += ' AND t.due_date = ?'; countParams.push(today);
  } else if (activeView === 'week') {
    const todayDate2 = new Date(today + 'T00:00:00');
    const dow2 = todayDate2.getDay();
    const mOff2 = dow2 === 0 ? -6 : 1 - dow2;
    const mon2 = new Date(todayDate2); mon2.setDate(todayDate2.getDate() + mOff2);
    const sun2 = new Date(mon2); sun2.setDate(mon2.getDate() + 6);
    countWhere += ' AND t.due_date BETWEEN ? AND ?';
    countParams.push(mon2.toISOString().split('T')[0], sun2.toISOString().split('T')[0]);
  }
  if (assignedByMe) {
    countWhere += ' AND t.created_by = ?';
    countParams.push(req.session.user.id);
  }
  else if (owner === 'all' || (!owner && isAdminRole)) { /* count all */ }
  else if (owner === 'me' || (!owner && !isAdminRole)) {
    countWhere += ' AND (t.owner_id = ? OR t.id IN (SELECT task_id FROM task_owners WHERE user_id = ?) OR t.id IN (SELECT task_id FROM task_watchers WHERE user_id = ?))';
    countParams.push(req.session.user.id, req.session.user.id, req.session.user.id);
  }
  else if (owner) {
    countWhere += ' AND (t.owner_id = ? OR t.id IN (SELECT task_id FROM task_owners WHERE user_id = ?) OR t.id IN (SELECT task_id FROM task_watchers WHERE user_id = ?))';
    countParams.push(owner, owner, owner);
  }
  if (priority && priority !== 'all') { countWhere += ' AND t.priority = ?'; countParams.push(priority); }
  if (division && division !== 'all') { countWhere += ' AND t.division = ?'; countParams.push(division); }
  if (job_id) { countWhere += ' AND t.job_id = ?'; countParams.push(job_id); }
  if (task_type && task_type !== 'all') { countWhere += ' AND t.task_type = ?'; countParams.push(task_type); }
  countWhere += ' AND t.deleted_at IS NULL';
  countWhere += hideAdminTasksSql(req.session.user);

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN t.status = 'not_started' THEN 1 ELSE 0 END) as not_started,
      SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) as blocked,
      SUM(CASE WHEN t.status = 'complete' THEN 1 ELSE 0 END) as complete,
      SUM(CASE WHEN t.status != 'complete' AND t.due_date < '${today}' THEN 1 ELSE 0 END) as overdue
    FROM tasks t WHERE ${countWhere}
  `).get(...countParams);

  // Reference data
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 AND username != 'admin' ORDER BY full_name").all();

  // Count deleted (respecting admin-division visibility) for the "View Deleted" link
  let deletedCount = 0;
  try {
    const delWhere = '1=1' + hideAdminTasksSql(req.session.user);
    deletedCount = db.prepare(`SELECT COUNT(*) as c FROM tasks t WHERE t.deleted_at IS NOT NULL AND ${delWhere}`).get().c;
  } catch (e) { /* deleted_at column may not exist pre-migration */ }

  res.render('tasks/index', {
    title: 'Tasks & Actions',
    tasks,
    jobs,
    users,
    counts: counts || { total: 0, not_started: 0, in_progress: 0, blocked: 0, complete: 0, overdue: 0 },
    deletedCount,
    today,
    filters: req.query,
    activeView,
    user: req.session.user,
  });
});

// GET /deleted — List soft-deleted tasks
router.get('/deleted', (req, res) => {
  const db = getDb();
  // Respect admin-division privacy rule just like the main index
  let where = 't.deleted_at IS NOT NULL';
  where += hideAdminTasksSql(req.session.user);

  const tasks = db.prepare(`
    SELECT t.*, j.job_number, j.client,
           u.full_name as owner_name,
           cb.full_name as created_by_name,
           db.full_name as deleted_by_name
    FROM tasks t
    LEFT JOIN jobs j  ON t.job_id = j.id
    LEFT JOIN users u  ON t.owner_id = u.id
    LEFT JOIN users cb ON t.created_by = cb.id
    LEFT JOIN users db ON t.deleted_by = db.id
    WHERE ${where}
    ORDER BY t.deleted_at DESC
  `).all();

  res.render('tasks/deleted', {
    title: 'Deleted Tasks',
    tasks,
    user: req.session.user,
  });
});

// POST /:id/restore — Restore a soft-deleted task (owner + admin/management only)
router.post('/:id/restore', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) {
    req.flash('error', 'Task not found.');
    return req.session.save(() => res.redirect('/tasks/deleted'));
  }
  if (!task.deleted_at) {
    req.flash('error', 'Task is not deleted.');
    return req.session.save(() => res.redirect('/tasks/deleted'));
  }
  if (!canModifyTask(task, req.session.user)) {
    req.flash('error', 'You can only restore your own tasks.');
    return req.session.save(() => res.redirect('/tasks/deleted'));
  }

  db.prepare('UPDATE tasks SET deleted_at = NULL, deleted_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);

  if (task.job_id) {
    autoLogDiary(db, {
      jobId: task.job_id,
      category: 'Task Updated',
      summary: `[${req.session.user ? req.session.user.full_name : 'System'}] Task restored: "${task.title}".`,
      userId: req.session.user ? req.session.user.id : null
    });
  }

  req.flash('success', 'Task restored.');
  req.session.save(() => res.redirect('/tasks/deleted'));
});

// POST /:id/purge — Permanently delete a soft-deleted task (admin/management only)
router.post('/:id/purge', (req, res) => {
  const db = getDb();
  const role = (req.session.user.role || '').toLowerCase();
  if (!['admin', 'management'].includes(role)) {
    req.flash('error', 'Only admin/management can permanently delete tasks.');
    return req.session.save(() => res.redirect('/tasks/deleted'));
  }
  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!task) {
    req.flash('error', 'Deleted task not found.');
    return req.session.save(() => res.redirect('/tasks/deleted'));
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  req.flash('success', 'Task permanently deleted.');
  req.session.save(() => res.redirect('/tasks/deleted'));
});

// GET /new — Create form
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 AND username != 'admin' ORDER BY full_name").all();
  let tenders = [];
  try { tenders = db.prepare("SELECT id, tender_number, title, status FROM tenders WHERE status IN ('open','submitted','won') ORDER BY id DESC").all(); } catch (e) {}
  res.render('tasks/form', { title: 'New Task', task: null, jobs, users, tenders, user: req.session.user,
    prefillJobId: req.query.job_id || '', prefillTenderId: req.query.tender_id || '' });
});

// POST / — Create task
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const jobId = b.job_id || null;
    // Only admins/management can file a task under the admin division; for anyone
    // else, silently downgrade to 'ops' rather than creating a task they can't see.
    let division = b.division || 'ops';
    if (division === 'admin' && !isAdminRole(req.session.user)) division = 'ops';
    // Handle multiple owners: owner_id can be string or array
    const ownerIds = Array.isArray(b.owner_id) ? b.owner_id.filter(Boolean) : (b.owner_id ? [b.owner_id] : []);
    const primaryOwnerId = ownerIds[0] || null;

    const tenderId = b.tender_id ? (parseInt(b.tender_id, 10) || null) : null;
    const result = db.prepare(`
      INSERT INTO tasks (job_id, tender_id, division, title, description, owner_id, due_date, status, priority, task_type, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(jobId, tenderId, division, b.title, b.description || '', primaryOwnerId, b.due_date,
      b.status || 'not_started', b.priority || 'medium', b.task_type || 'one_off', b.notes || '', req.session.user.id);

    const newTaskId = result.lastInsertRowid;

    // Sync all owners to task_owners table
    syncTaskOwners(db, newTaskId, ownerIds);

    // Checklist items — saved as subtasks so they share the existing tick-off /
    // assign / progress UI on the task. Titles + assignees arrive as parallel
    // arrays from the create form (one of each per row); empty rows are skipped.
    try {
      const titles = Array.isArray(b.checklist_title) ? b.checklist_title : (b.checklist_title ? [b.checklist_title] : []);
      const assignees = Array.isArray(b.checklist_assignee) ? b.checklist_assignee : (b.checklist_assignee ? [b.checklist_assignee] : []);
      const insSub = db.prepare('INSERT INTO subtasks (task_id, title, sort_order, assigned_to_id) VALUES (?, ?, ?, ?)');
      let order = 0;
      titles.forEach((rawTitle, i) => {
        const title = (rawTitle || '').trim();
        if (!title) return; // skip blank rows
        order += 1;
        const assigneeId = assignees[i] ? (parseInt(assignees[i], 10) || null) : null;
        const r = insSub.run(newTaskId, title, order, assigneeId);
        if (assigneeId) {
          notifySubtaskAssigned(db, newTaskId, { id: r.lastInsertRowid, title }, assigneeId, req);
        }
      });
    } catch (e) { console.error('[Tasks] Checklist insert error on create:', e.message); }

    // Send email/push notification to all assigned owners (fire-and-forget)
    const assignedByName = req.session.user ? req.session.user.full_name : '';
    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const job = jobId ? db.prepare('SELECT job_number, client FROM jobs WHERE id = ?').get(jobId) : null;
    const jobLabel = job ? `${job.job_number} - ${job.client}` : 'General';
    ownerIds.forEach(oid => {
      try {
        const ownerUser = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(oid);
        const taskData = { id: newTaskId, title: b.title, description: b.description || '', due_date: b.due_date, priority: b.priority || 'medium', task_type: b.task_type || 'one_off' };
        // "Task assigned" emails are opt-IN (off by default) so the inbox isn't
        // flooded on every new task — the due-date reminder is the default email.
        // The in-app/push alert still fires unless the owner turned that off too.
        const oPrefs = notifPrefs.getUserPrefs(db, oid);
        if (notifPrefs.wantsEmail(oPrefs, 'task_assigned')) {
          sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, assignedByName, baseUrl).catch(e => console.error('[Tasks] Email async error:', e.message));
        }
        if (notifPrefs.wantsInApp(oPrefs, 'task_assigned')) {
          sendPushToUser(oid, {
            title: 'New Task Assigned',
            body: `${b.title} — assigned by ${assignedByName}`,
            url: '/tasks/' + newTaskId + '/edit',
            type: 'task_assignment'
          });
        }
      } catch (emailErr) {
        console.error('[Tasks] Email send error on create:', emailErr.message);
      }
    });

    // Auto-log to site diary when task is linked to a project on creation
    if (jobId) {
      try {
        const ownerNames = ownerIds.map(oid => (db.prepare('SELECT full_name FROM users WHERE id = ?').get(oid) || {}).full_name).filter(Boolean);
        autoLogDiary(db, {
          jobId,
          category: 'Task Created',
          summary: `[${req.session.user ? req.session.user.full_name : 'System'}] New task created: "${b.title}"${ownerNames.length ? ' — assigned to ' + ownerNames.join(', ') : ''}${b.due_date ? ' (due ' + b.due_date + ')' : ''} [${(b.priority || 'medium').toUpperCase()}].`,
          userId: req.session.user ? req.session.user.id : null
        });
      } catch (e) { console.error('[Tasks] Diary log error on create:', e.message); }
    }

    req.flash('success', 'Task created.');
    req.session.save(() => res.redirect(b.return_to || '/tasks'));
  } catch (err) {
    console.error('[Tasks] Create error:', err.message, err.stack);
    req.flash('error', 'Failed to create task: ' + err.message);
    req.session.save(() => res.redirect('/tasks/new'));
  }
});

// POST /bulk — Bulk actions on tasks (with ownership check)
router.post('/bulk', (req, res) => {
  const db = getDb();
  const ids = (req.body.ids || '').split(',').map(Number).filter(n => n > 0);
  const action = req.body.action;
  if (ids.length === 0) return res.redirect('/tasks');

  // Verify ownership on each task — only owner or admin/management can bulk-act
  const allowedIds = [];
  ids.forEach(id => {
    const task = db.prepare('SELECT id, owner_id FROM tasks WHERE id = ?').get(id);
    if (task && canModifyTask(task, req.session.user)) allowedIds.push(id);
  });

  if (allowedIds.length === 0) {
    req.flash('error', 'You can only modify tasks assigned to you.');
    return req.session.save(() => res.redirect('/tasks'));
  }

  if (action === 'complete') {
    const stmt = db.prepare("UPDATE tasks SET status = 'complete', completed_date = date('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    allowedIds.forEach(id => {
      const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      stmt.run(id);
      // Cascade-close any corrective action wired to this task so the
      // incident page mirrors the task list.
      closeCasFromTask(db, id, req.session.user, 'Closed via linked task.');
      // Auto-log to site diary
      if (t && t.job_id) {
        logStatusChange(db, {
          jobId: t.job_id, entityType: 'task',
          entityLabel: `Task: ${t.title}`,
          oldStatus: t.status || 'not_started', newStatus: 'complete',
          userId: req.session.user ? req.session.user.id : null,
          userName: req.session.user ? req.session.user.full_name : 'System'
        });
      }
    });
    req.flash('success', allowedIds.length + ' task(s) marked complete.');
  } else if (action === 'delete') {
    const delStmt = db.prepare('UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL');
    const userId = req.session.user ? req.session.user.id : null;
    allowedIds.forEach(id => {
      const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      delStmt.run(userId, id);
      // Auto-log to site diary
      if (t && t.job_id) {
        autoLogDiary(db, {
          jobId: t.job_id,
          category: 'Task Deleted',
          summary: `[${req.session.user ? req.session.user.full_name : 'System'}] Task deleted: "${t.title}".`,
          userId: req.session.user ? req.session.user.id : null
        });
      }
    });
    req.flash('success', allowedIds.length + ' task(s) deleted.');
  }
  req.session.save(() => res.redirect('/tasks'));
});

// GET /:id/edit — Edit form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const task = db.prepare(`
    SELECT t.*, cb.full_name as created_by_name
    FROM tasks t LEFT JOIN users cb ON t.created_by = cb.id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!task) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect('/tasks')); }

  // Soft-deleted tasks are not editable — redirect to the deleted list so the
  // user can restore if needed.
  if (task.deleted_at) {
    req.flash('error', 'This task has been deleted. Restore it to edit.');
    return req.session.save(() => res.redirect('/tasks/deleted'));
  }

  // Watchers (people @mentioned on the task or manually added by an owner)
  // get read-only access. canModifyTask remains the writable gate.
  const editable = canModifyTask(task, req.session.user);
  const viewable = editable || canViewTask(task, req.session.user);

  // Admin-division tasks are private to the admin team — hide from everyone
  // else UNLESS they've been explicitly invited via a mention/manual watcher.
  // Return the same "not found" message so non-admins can't probe for task existence.
  if (task.division === 'admin' && !isAdminRole(req.session.user) && !viewable) {
    req.flash('error', 'Task not found.');
    return req.session.save(() => res.redirect('/tasks'));
  }
  if (!viewable && !isAdminRole(req.session.user)) {
    req.flash('error', 'You don\'t have access to this task.');
    return req.session.save(() => res.redirect('/tasks'));
  }

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 AND username != 'admin' ORDER BY full_name").all();
  let tenders = [];
  try { tenders = db.prepare("SELECT id, tender_number, title, status FROM tenders ORDER BY id DESC").all(); } catch (e) {}

  // Load subtasks (with assignee name)
  let subtasks = [];
  try {
    subtasks = db.prepare(`
      SELECT s.*, u.full_name AS assignee_name
      FROM subtasks s
      LEFT JOIN users u ON u.id = s.assigned_to_id
      WHERE s.task_id = ?
      ORDER BY s.sort_order ASC
    `).all(req.params.id);
  } catch (e) { /* table may not exist yet */ }

  // Load comments with user names + the list of users mentioned on each
  // comment, so the view can render @-pills + an "x, y mentioned" footer.
  let comments = [];
  try {
    comments = db.prepare(`
      SELECT tc.*, u.full_name as user_name FROM task_comments tc
      JOIN users u ON tc.user_id = u.id
      WHERE tc.task_id = ? ORDER BY tc.created_at DESC
    `).all(req.params.id);
    if (comments.length) {
      const ids = comments.map(c => c.id);
      let mentionRows = [];
      try {
        mentionRows = db.prepare(`
          SELECT tcm.comment_id, mu.id, mu.full_name
          FROM task_comment_mentions tcm
          JOIN users mu ON mu.id = tcm.mentioned_user_id
          WHERE tcm.comment_id IN (${ids.map(() => '?').join(',')})
        `).all(...ids);
      } catch (e) { mentionRows = []; }
      const byComment = new Map();
      for (const r of mentionRows) {
        const arr = byComment.get(r.comment_id) || [];
        arr.push({ id: r.id, full_name: r.full_name });
        byComment.set(r.comment_id, arr);
      }
      for (const c of comments) c.mentions = byComment.get(c.id) || [];
    }
  } catch (e) { /* table may not exist yet */ }

  // Load watchers for the "Watching" section + an "add watcher" picker.
  let watchers = [];
  try {
    watchers = db.prepare(`
      SELECT tw.user_id, tw.source, tw.added_at, u.full_name, u.role
      FROM task_watchers tw
      JOIN users u ON u.id = tw.user_id
      WHERE tw.task_id = ?
      ORDER BY u.full_name
    `).all(req.params.id);
  } catch (e) { /* table may not exist yet */ }

  // Load dependencies (tasks this task depends on)
  let dependencies = [];
  try {
    dependencies = db.prepare(`
      SELECT td.id as dep_id, td.depends_on_id, t.title, t.status, t.due_date
      FROM task_dependencies td
      JOIN tasks t ON td.depends_on_id = t.id
      WHERE td.task_id = ? ORDER BY t.due_date ASC
    `).all(req.params.id);
  } catch (e) { /* table may not exist yet */ }

  // Load tasks that depend on this task (dependents)
  let dependents = [];
  try {
    dependents = db.prepare(`
      SELECT td.id as dep_id, td.task_id, t.title, t.status, t.due_date
      FROM task_dependencies td
      JOIN tasks t ON td.task_id = t.id
      WHERE td.depends_on_id = ? ORDER BY t.due_date ASC
    `).all(req.params.id);
  } catch (e) { /* table may not exist yet */ }

  // All tasks (for dependency picker), excluding current task + deleted tasks
  const allTasks = db.prepare('SELECT id, title, status, due_date FROM tasks WHERE id != ? AND deleted_at IS NULL ORDER BY title').all(req.params.id);

  // Activity log
  const activityLog = db.prepare(`
    SELECT al.*, u.full_name as user_name FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'task' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(req.params.id);

  // Linked compliance item (if auto-created from Plans & Approvals)
  let linkedCompliance = null;
  try {
    if (task.compliance_id) {
      linkedCompliance = db.prepare('SELECT id, title, reference_number, status, item_types FROM compliance WHERE id = ?').get(task.compliance_id);
    }
  } catch (e) { /* compliance_id column may not exist yet */ }

  // Load task owners from junction table
  const taskOwners = getTaskOwnerNames(db, req.params.id);
  // Fallback: if no task_owners rows, use primary owner_id
  if (taskOwners.length === 0 && task.owner_id) {
    const primaryOwner = db.prepare('SELECT id, full_name FROM users WHERE id = ?').get(task.owner_id);
    if (primaryOwner) taskOwners.push(primaryOwner);
  }
  task.owners = taskOwners;

  res.render('tasks/form', { title: 'Edit Task', task, jobs, users, tenders, user: req.session.user, prefillJobId: '', prefillTenderId: '', editable, viewable, subtasks, comments, watchers, dependencies, dependents, allTasks, activityLog, linkedCompliance });
});

// POST /:id — Update task
router.post('/:id', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;

    // Check ownership before allowing update
    const existingTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!existingTask) {
      req.flash('error', 'Task not found.');
      return req.session.save(() => res.redirect('/tasks'));
    }
    if (existingTask.deleted_at) {
      req.flash('error', 'Cannot edit a deleted task. Restore it first.');
      return req.session.save(() => res.redirect('/tasks/deleted'));
    }
    // Admin-division tasks are admin-only, even for writes — present as "not found"
    // so non-admins can't confirm the task exists via a crafted POST.
    if (existingTask.division === 'admin' && !isAdminRole(req.session.user)) {
      req.flash('error', 'Task not found.');
      return req.session.save(() => res.redirect('/tasks'));
    }
    if (!canModifyTask(existingTask, req.session.user)) {
      req.flash('error', 'You can only edit tasks assigned to you.');
      return req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
    }

    // Handle multiple owners
    const newOwnerIds = Array.isArray(b.owner_id) ? b.owner_id.filter(Boolean) : (b.owner_id ? [b.owner_id] : []);
    const primaryOwnerId = newOwnerIds[0] || null;
    const oldOwnerIds = getTaskOwnerNames(db, req.params.id).map(o => String(o.id));
    const ownersChanged = JSON.stringify(newOwnerIds.sort()) !== JSON.stringify(oldOwnerIds.sort());

    const updateJobId = b.job_id || null;
    const updateTenderId = b.tender_id ? (parseInt(b.tender_id, 10) || null) : null;
    // Only admins/management can park a task in the admin division (private).
    let division = b.division || 'ops';
    if (division === 'admin' && !isAdminRole(req.session.user)) division = existingTask.division || 'ops';
    const completedDate = b.status === 'complete' ? new Date().toISOString().split('T')[0] : null;
    db.prepare(`
      UPDATE tasks SET job_id=?, tender_id=?, division=?, title=?, description=?, owner_id=?, due_date=?,
      status=?, priority=?, task_type=?, notes=?, completed_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(updateJobId, updateTenderId, division, b.title, b.description || '', primaryOwnerId, b.due_date,
      b.status, b.priority, b.task_type || 'one_off', b.notes || '', completedDate, req.params.id);

    // Sync task_owners junction table
    syncTaskOwners(db, parseInt(req.params.id), newOwnerIds);

    // Notify newly added owners (fire-and-forget)
    if (ownersChanged) {
      const addedOwnerIds = newOwnerIds.filter(id => !oldOwnerIds.includes(String(id)));
      const assignedByName = req.session.user ? req.session.user.full_name : '';
      const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
      const job = updateJobId ? db.prepare('SELECT job_number, client FROM jobs WHERE id = ?').get(updateJobId) : null;
      const jobLabel = job ? `${job.job_number} - ${job.client}` : 'General';
      addedOwnerIds.forEach(oid => {
        try {
          const ownerUser = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(oid);
          const taskData = { id: req.params.id, title: b.title, description: b.description || '', due_date: b.due_date, priority: b.priority || 'medium', task_type: b.task_type || 'one_off' };
          // Opt-in email (see create handler); push still fires unless disabled.
          const oPrefs = notifPrefs.getUserPrefs(db, oid);
          if (notifPrefs.wantsEmail(oPrefs, 'task_assigned')) {
            sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, assignedByName, baseUrl).catch(e => console.error('[Tasks] Email async error:', e.message));
          }
          if (notifPrefs.wantsInApp(oPrefs, 'task_assigned')) {
            sendPushToUser(oid, {
              title: 'Task Assigned to You',
              body: `${b.title} — assigned by ${assignedByName}`,
              url: '/tasks/' + req.params.id + '/edit',
              type: 'task_assignment'
            });
          }
        } catch (emailErr) {
          console.error('[Tasks] Email send error on reassign:', emailErr.message);
        }
      });
    }
    const ownerChanged = ownersChanged;

    // Auto-log to site diary
    const jobChanged = String(existingTask.job_id || '') !== String(updateJobId || '');
    // Case: task newly linked to a project (was unlinked or linked to a different job)
    if (jobChanged && updateJobId) {
      try {
        autoLogDiary(db, {
          jobId: updateJobId,
          category: 'Task Updated',
          summary: `[${req.session.user ? req.session.user.full_name : 'System'}] Task linked to project: "${b.title}"${b.due_date ? ' (due ' + b.due_date + ')' : ''}.`,
          userId: req.session.user ? req.session.user.id : null
        });
      } catch (e) { console.error('[Tasks] Diary log error on link:', e.message); }
    }

    if (existingTask.job_id || b.job_id) {
      const changes = [];
      if (existingTask.status !== b.status) changes.push(`Status: ${(existingTask.status || '').replace(/_/g, ' ')} → ${(b.status || '').replace(/_/g, ' ')}`);
      if (ownerChanged) {
        const newOwnerNames = newOwnerIds.map(oid => (db.prepare('SELECT full_name FROM users WHERE id = ?').get(oid) || {}).full_name).filter(Boolean);
        changes.push(`Owners: ${newOwnerNames.length ? newOwnerNames.join(', ') : 'unassigned'}`);
      }
      if (existingTask.priority !== b.priority) changes.push(`Priority: ${b.priority}`);
      if (existingTask.title !== b.title) changes.push(`Title renamed to "${b.title}"`);
      if (existingTask.due_date !== b.due_date) changes.push(`Due date: ${b.due_date || 'removed'}`);
      if (changes.length > 0) {
        autoLogDiary(db, {
          jobId: b.job_id || existingTask.job_id,
          category: 'Task Updated',
          summary: `[${req.session.user ? req.session.user.full_name : 'System'}] Task updated: ${b.title}. ${changes.join('. ')}.`,
          userId: req.session.user ? req.session.user.id : null
        });
      }
    }

    req.flash('success', 'Task updated.');
    req.session.save(() => res.redirect(b.return_to || '/tasks'));
  } catch (err) {
    console.error('[Tasks] Update error:', err.message, err.stack);
    req.flash('error', 'Failed to update task: ' + err.message);
    req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
  }
});

// POST /:id/status — Quick inline status change (owner + admin/management only)
router.post('/:id/status', (req, res) => {
  try {
    const db = getDb();
    const newStatus = req.body.status;
    const validStatuses = ['not_started', 'in_progress', 'blocked', 'complete'];
    if (!validStatuses.includes(newStatus)) {
      req.flash('error', 'Invalid status.');
      return req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
    }

    // Check ownership
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
    if (!task) {
      req.flash('error', 'Task not found.');
      return req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
    }
    if (!canModifyTask(task, req.session.user)) {
      req.flash('error', 'You can only update status on your own tasks.');
      return req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
    }

    const today = new Date().toISOString().split('T')[0];
    const completedDate = newStatus === 'complete' ? today : null;
    db.prepare('UPDATE tasks SET status = ?, completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newStatus, completedDate, req.params.id);

    // Cascade close to the linked corrective action (if any) so the
    // incident page reflects the task closure.
    if (newStatus === 'complete') {
      closeCasFromTask(db, req.params.id, req.session.user, 'Closed via linked task.');
    }

    // Send status change email to task owner (fire-and-forget)
    try {
      if (task.owner_id) {
        const ownerUser = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(task.owner_id);
        const changedByName = req.session.user ? req.session.user.full_name : '';
        const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
        sendTaskStatusEmail(task, ownerUser, newStatus, changedByName, baseUrl).catch(e => console.error('[Tasks] Email async error:', e.message));
        // Push notification for status change
        const statusLabel = newStatus.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        sendPushToUser(task.owner_id, {
          title: 'Task Status: ' + statusLabel,
          body: `"${task.title}" marked as ${statusLabel} by ${changedByName}`,
          url: '/tasks/' + req.params.id + '/edit',
          type: 'task_status'
        });
      }
    } catch (emailErr) {
      console.error('[Tasks] Email send error on status change:', emailErr.message);
    }

    // Auto-log to site diary + notify
    if (task.job_id && task.status !== newStatus) {
      logStatusChange(db, {
        jobId: task.job_id, entityType: 'task',
        entityLabel: `Task: ${task.title}`,
        oldStatus: task.status, newStatus,
        userId: req.session.user ? req.session.user.id : null,
        userName: req.session.user ? req.session.user.full_name : 'System'
      });
    }

    req.flash('success', 'Status updated.');
    req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
  } catch (err) {
    console.error('[Tasks] Status change error:', err.message, err.stack);
    req.flash('error', 'Failed to update status.');
    req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
  }
});

// POST /:id/complete — Quick complete (owner + admin/management only)
router.post('/:id/complete', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (task && !canModifyTask(task, req.session.user)) {
    req.flash('error', 'You can only complete your own tasks.');
    return req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
  }
  const today = new Date().toISOString().split('T')[0];
  db.prepare("UPDATE tasks SET status = 'complete', completed_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(today, req.params.id);

  // Mirror the close onto any linked corrective action.
  closeCasFromTask(db, req.params.id, req.session.user, 'Closed via linked task.');

  // Auto-log to site diary + notify
  if (task && task.job_id) {
    logStatusChange(db, {
      jobId: task.job_id, entityType: 'task',
      entityLabel: `Task: ${task.title}`,
      oldStatus: task.status || 'not_started', newStatus: 'complete',
      userId: req.session.user ? req.session.user.id : null,
      userName: req.session.user ? req.session.user.full_name : 'System'
    });
  }

  req.flash('success', 'Task completed.');
  req.session.save(() => res.redirect(req.headers.referer || '/tasks'));
});

// POST /:id/delete — Soft-delete task (owner + admin/management only)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (task && !canModifyTask(task, req.session.user)) {
    req.flash('error', 'You can only delete your own tasks.');
    return req.session.save(() => res.redirect(req.body.return_to || '/tasks'));
  }
  const userId = req.session.user ? req.session.user.id : null;
  db.prepare('UPDATE tasks SET deleted_at = CURRENT_TIMESTAMP, deleted_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL').run(userId, req.params.id);

  // Auto-log to site diary
  if (task && task.job_id) {
    autoLogDiary(db, {
      jobId: task.job_id,
      category: 'Task Deleted',
      summary: `[${req.session.user ? req.session.user.full_name : 'System'}] Task deleted: "${task.title}".`,
      userId: req.session.user ? req.session.user.id : null
    });
  }

  req.flash('success', 'Task deleted. View it from the Deleted Tasks page.');
  req.session.save(() => res.redirect(req.body.return_to || '/tasks'));
});

// POST /:id/renotify — Re-send notification to assigned user
router.post('/:id/renotify', (req, res) => {
  try {
    const db = getDb();
    const task = db.prepare(`
      SELECT t.*, j.job_number, j.client, u.full_name as owner_name, u.email as owner_email
      FROM tasks t
      LEFT JOIN jobs j ON t.job_id = j.id
      LEFT JOIN users u ON t.owner_id = u.id
      WHERE t.id = ?
    `).get(req.params.id);

    if (!task || !task.owner_id) {
      req.flash('error', 'Task not found or no one assigned.');
      return req.session.save(() => res.redirect(req.headers.referer || '/dashboard'));
    }

    const senderName = req.session.user.full_name;
    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;

    // Push notification
    sendPushToUser(task.owner_id, {
      title: 'Task Reminder',
      body: `"${task.title}" — reminder from ${senderName}`,
      url: '/tasks/' + task.id + '/edit',
      type: 'task_reminder'
    });

    // Email reminder
    const jobLabel = task.job_number ? `${task.job_number} - ${task.client}` : 'General';
    const ownerUser = { id: task.owner_id, full_name: task.owner_name, email: task.owner_email };
    const taskData = { id: task.id, title: task.title, description: task.description || '', due_date: task.due_date, priority: task.priority, task_type: task.task_type };
    sendTaskAssignmentEmail(taskData, ownerUser, jobLabel, senderName + ' (reminder)', baseUrl).catch(e => console.error('[Tasks] Renotify email error:', e.message));

    req.flash('success', `Reminder sent to ${task.owner_name}.`);
    req.session.save(() => res.redirect(req.headers.referer || '/dashboard'));
  } catch (err) {
    console.error('[Tasks] Renotify error:', err.message);
    req.flash('error', 'Failed to send reminder.');
    req.session.save(() => res.redirect(req.headers.referer || '/dashboard'));
  }
});

// =============================================
// Comments
// =============================================

// POST /:id/comments — Add a comment, optionally with @mentions.
//
// Notifications fan-out (de-duplicated, excluding the commenter):
//   - primary owner (tasks.owner_id)
//   - co-owners (task_owners junction)
//   - everyone who has previously commented on this task
//   - everyone @mentioned in THIS comment (also gets bumped to a watcher row
//     so they can open the task even if they aren't an owner)
// All recipients get an in-app notification row (bell icon) and a push.
router.post('/:id/comments', (req, res) => {
  const db = getDb();
  const taskId = parseInt(req.params.id, 10);
  const { comment } = req.body;
  if (!comment || !comment.trim()) return res.redirect('/tasks/' + taskId + '/edit');

  const task = db.prepare(`
    SELECT t.id, t.title, t.owner_id, t.job_id, t.division
    FROM tasks t WHERE t.id = ?
  `).get(taskId);
  if (!task) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect('/tasks')); }
  // Anyone with view rights can comment (owners, co-owners, watchers, admin).
  if (!canViewTask(task, req.session.user)) {
    req.flash('error', 'You can\'t comment on this task.');
    return req.session.save(() => res.redirect('/tasks'));
  }

  const body = comment.trim();
  const commenterId = req.session.user.id;
  const commenterName = req.session.user.full_name || 'Someone';

  // mentioned_user_ids[] comes from the hidden picker field (chat-style).
  // Accept both array and CSV string forms so a simple form still works.
  let mentionedIds = [];
  const raw = req.body.mentioned_user_ids;
  if (Array.isArray(raw)) mentionedIds = raw;
  else if (typeof raw === 'string' && raw.trim()) mentionedIds = raw.split(',');
  mentionedIds = mentionedIds.map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  mentionedIds = Array.from(new Set(mentionedIds));

  // Insert the comment first so we have its id for mention rows.
  const ins = db.prepare('INSERT INTO task_comments (task_id, user_id, comment) VALUES (?, ?, ?)').run(taskId, commenterId, body);
  const commentId = Number(ins.lastInsertRowid);

  // Persist mention rows + promote each mentioned user to a watcher.
  // INSERT OR IGNORE on both — duplicate mentions or repeat watchers are
  // expected and shouldn't error.
  let validMentioned = [];
  if (mentionedIds.length > 0) {
    try {
      const valid = db.prepare(`SELECT id FROM users WHERE active = 1 AND id IN (${mentionedIds.map(() => '?').join(',')})`).all(...mentionedIds);
      validMentioned = valid.map(r => r.id);
      const mentionIns = db.prepare('INSERT OR IGNORE INTO task_comment_mentions (comment_id, mentioned_user_id) VALUES (?, ?)');
      const watcherIns = db.prepare("INSERT OR IGNORE INTO task_watchers (task_id, user_id, source, added_by_id) VALUES (?, ?, 'mention', ?)");
      for (const uid of validMentioned) {
        mentionIns.run(commentId, uid);
        watcherIns.run(taskId, uid, commenterId);
      }
    } catch (e) { console.error('[Tasks] mention insert error:', e.message); }
  }

  // Audit trail (same as before — keep the legacy hook so existing reports work).
  try {
    const { logActivity } = require('../middleware/audit');
    logActivity({ user: req.session.user, action: 'update', entityType: 'task', entityId: taskId, entityLabel: task.title, details: 'Added comment', ip: req.ip });
  } catch (e) {}

  // Build the recipient set: owners + previous commenters + mentioned users, minus self.
  const recipients = new Map(); // userId -> { isMentioned }
  function add(uid, isMentioned) {
    const n = parseInt(uid, 10);
    if (!Number.isFinite(n) || n === commenterId) return;
    const existing = recipients.get(n);
    if (!existing) recipients.set(n, { isMentioned: !!isMentioned });
    else if (isMentioned) existing.isMentioned = true;
  }
  if (task.owner_id) add(task.owner_id, false);
  try {
    db.prepare('SELECT user_id FROM task_owners WHERE task_id = ?').all(taskId).forEach(r => add(r.user_id, false));
  } catch (e) {}
  try {
    db.prepare('SELECT DISTINCT user_id FROM task_comments WHERE task_id = ?').all(taskId).forEach(r => add(r.user_id, false));
  } catch (e) {}
  // Watchers follow progress too — both mention-sourced and manually added.
  try {
    db.prepare('SELECT user_id FROM task_watchers WHERE task_id = ?').all(taskId).forEach(r => add(r.user_id, false));
  } catch (e) {}
  for (const uid of validMentioned) add(uid, true);

  // Insert in-app notifications + send push for each recipient.
  // Admin-division tasks are private to admin/management — don't leak details
  // to ops/planning recipients (the only way they'd be on this list is via
  // a mention, which is explicit consent, so we still let them through but
  // keep the title generic).
  const preview = body.length > 80 ? body.substring(0, 80) + '…' : body;
  const insertNotif = db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, link, job_id)
    VALUES (?, 'general', ?, ?, ?, ?)
  `);
  const link = '/tasks/' + taskId + '/edit';
  for (const [userId, meta] of recipients) {
    const title = meta.isMentioned
      ? `${commenterName} mentioned you on "${task.title}"`
      : `New comment on "${task.title}"`;
    const message = `${commenterName}: ${preview}`;
    try { insertNotif.run(userId, title, message, link, task.job_id || null); } catch (e) { console.error('[Tasks] notif insert error:', e.message); }
    try {
      sendPushToUser(userId, {
        title,
        body: preview,
        url: link,
        type: meta.isMentioned ? 'task_mention' : 'task_comment',
      }).catch(e => console.error('[Tasks] push error:', e.message));
    } catch (e) { /* sendPushToUser shouldn't throw, but defensive */ }
  }

  res.redirect('/tasks/' + taskId + '/edit');
});

// POST /:id/watchers — manually add a watcher (owners + admin only).
router.post('/:id/watchers', (req, res) => {
  const db = getDb();
  const taskId = parseInt(req.params.id, 10);
  const task = db.prepare('SELECT id, owner_id, title FROM tasks WHERE id = ?').get(taskId);
  if (!task) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect('/tasks')); }
  if (!canModifyTask(task, req.session.user)) {
    req.flash('error', 'Only task owners can manage watchers.');
    return req.session.save(() => res.redirect('/tasks/' + taskId + '/edit'));
  }
  const userId = parseInt(req.body.user_id, 10);
  if (!userId) { req.flash('error', 'Pick a user to add.'); return req.session.save(() => res.redirect('/tasks/' + taskId + '/edit')); }
  const u = db.prepare('SELECT id, full_name FROM users WHERE id = ? AND active = 1').get(userId);
  if (!u) { req.flash('error', 'User not found.'); return req.session.save(() => res.redirect('/tasks/' + taskId + '/edit')); }
  try {
    db.prepare("INSERT OR IGNORE INTO task_watchers (task_id, user_id, source, added_by_id) VALUES (?, ?, 'manual', ?)").run(taskId, userId, req.session.user.id);
    // Friendly heads-up so the new watcher knows they were added.
    try {
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, message, link, job_id)
        VALUES (?, 'general', ?, ?, ?, NULL)
      `).run(userId, `${req.session.user.full_name} added you as a watcher`, `You can now follow "${task.title}".`, '/tasks/' + taskId + '/edit');
      sendPushToUser(userId, {
        title: 'Watching: ' + task.title,
        body: `${req.session.user.full_name} added you as a watcher.`,
        url: '/tasks/' + taskId + '/edit',
        type: 'task_watcher_added',
      }).catch(e => console.error('[Tasks] watcher push error:', e.message));
    } catch (e) {}
    req.flash('success', `${u.full_name} is now watching this task.`);
  } catch (e) {
    console.error('[Tasks] watcher add error:', e.message);
    req.flash('error', 'Could not add watcher.');
  }
  req.session.save(() => res.redirect('/tasks/' + taskId + '/edit'));
});

// POST /:id/watchers/:userId/remove — drop a watcher (owners + admin, OR self).
router.post('/:id/watchers/:userId/remove', (req, res) => {
  const db = getDb();
  const taskId = parseInt(req.params.id, 10);
  const userId = parseInt(req.params.userId, 10);
  const task = db.prepare('SELECT id, owner_id FROM tasks WHERE id = ?').get(taskId);
  if (!task) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect('/tasks')); }
  const isSelf = req.session.user && req.session.user.id === userId;
  if (!isSelf && !canModifyTask(task, req.session.user)) {
    req.flash('error', 'You can\'t change watchers on this task.');
    return req.session.save(() => res.redirect('/tasks/' + taskId + '/edit'));
  }
  try {
    db.prepare('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?').run(taskId, userId);
    req.flash('success', isSelf ? 'You stopped watching this task.' : 'Watcher removed.');
  } catch (e) {
    console.error('[Tasks] watcher remove error:', e.message);
    req.flash('error', 'Could not remove watcher.');
  }
  // Self-remove may revoke view rights — bounce to /tasks rather than the now-forbidden page.
  req.session.save(() => res.redirect(isSelf ? '/tasks' : '/tasks/' + taskId + '/edit'));
});

// GET /api/mention-search?q= — search active office users for the @mention picker.
// Returns id + full_name + role. Excludes the requester themselves.
router.get('/api/mention-search', (req, res) => {
  const db = getDb();
  const q = String(req.query.q || '').trim().toLowerCase();
  const me = req.session.user ? req.session.user.id : 0;
  let rows = [];
  try {
    if (q) {
      rows = db.prepare(`
        SELECT id, full_name, role FROM users
        WHERE active = 1 AND id != ? AND LOWER(full_name) LIKE ?
        ORDER BY full_name LIMIT 8
      `).all(me, '%' + q + '%');
    } else {
      rows = db.prepare(`
        SELECT id, full_name, role FROM users
        WHERE active = 1 AND id != ?
        ORDER BY full_name LIMIT 8
      `).all(me);
    }
  } catch (e) { rows = []; }
  res.json({ users: rows });
});

// =============================================
// Subtasks
// =============================================

// Send the same kind of "you've been assigned" notification we send for tasks,
// but worded as a subtask. URL points back to the parent task page where the
// subtask is shown.
function notifySubtaskAssigned(db, parentTaskId, subtask, assigneeId, req) {
  try {
    if (!assigneeId) return;
    const parent = db.prepare(`
      SELECT t.*, j.job_number, j.client
      FROM tasks t
      LEFT JOIN jobs j ON j.id = t.job_id
      WHERE t.id = ?
    `).get(parentTaskId);
    if (!parent) return;
    const assignee = db.prepare('SELECT id, full_name, email FROM users WHERE id = ?').get(assigneeId);
    if (!assignee) return;
    const assignedByName = req.session.user ? req.session.user.full_name : '';
    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const jobLabel = parent.job_number ? `${parent.job_number} - ${parent.client}` : 'General';

    // Reuse the existing assignment email — synthesise a task object so the
    // recipient sees the subtask title clearly and gets the parent task URL.
    const taskData = {
      id: parent.id,
      title: `Subtask: ${subtask.title} (on "${parent.title}")`,
      description: parent.description || '',
      due_date: parent.due_date,
      priority: parent.priority,
      task_type: 'subtask'
    };
    // Same opt-in email / default push policy as task assignment.
    const aPrefs = notifPrefs.getUserPrefs(db, assigneeId);
    if (notifPrefs.wantsEmail(aPrefs, 'task_assigned')) {
      sendTaskAssignmentEmail(taskData, assignee, jobLabel, assignedByName, baseUrl)
        .catch(e => console.error('[Subtasks] Email error:', e.message));
    }
    if (notifPrefs.wantsInApp(aPrefs, 'task_assigned')) {
      sendPushToUser(assigneeId, {
        title: 'Subtask Assigned',
        body: `${subtask.title} — part of "${parent.title}"${assignedByName ? ' · assigned by ' + assignedByName : ''}`,
        url: '/tasks/' + parent.id + '/edit',
        type: 'task_assignment'
      });
    }
  } catch (e) {
    console.error('[Subtasks] Notify error:', e.message);
  }
}

// POST /:id/subtasks — Add a subtask (optionally assigned to a user)
router.post('/:id/subtasks', (req, res) => {
  const db = getDb();
  const { title } = req.body;
  if (!title || !title.trim()) return res.redirect('/tasks/' + req.params.id + '/edit');
  const assignedToId = req.body.assigned_to_id ? (parseInt(req.body.assigned_to_id, 10) || null) : null;
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM subtasks WHERE task_id = ?').get(req.params.id).m;
  const r = db.prepare('INSERT INTO subtasks (task_id, title, sort_order, assigned_to_id) VALUES (?, ?, ?, ?)')
    .run(req.params.id, title.trim(), maxOrder + 1, assignedToId);
  if (assignedToId) {
    notifySubtaskAssigned(db, req.params.id, { id: r.lastInsertRowid, title: title.trim() }, assignedToId, req);
  }
  res.redirect('/tasks/' + req.params.id + '/edit');
});

// POST /:id/subtasks/:sid/assign — Change a subtask's assignee
router.post('/:id/subtasks/:sid/assign', (req, res) => {
  const db = getDb();
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ? AND task_id = ?').get(req.params.sid, req.params.id);
  if (!subtask) return res.redirect('/tasks/' + req.params.id + '/edit');
  const newAssigneeId = req.body.assigned_to_id ? (parseInt(req.body.assigned_to_id, 10) || null) : null;
  db.prepare('UPDATE subtasks SET assigned_to_id = ? WHERE id = ?').run(newAssigneeId, subtask.id);
  // Only notify if the assignee actually changed to a non-null user (avoids
  // re-notifying on unrelated edits or when clearing the field).
  if (newAssigneeId && newAssigneeId !== subtask.assigned_to_id) {
    notifySubtaskAssigned(db, req.params.id, subtask, newAssigneeId, req);
  }
  res.redirect('/tasks/' + req.params.id + '/edit');
});

// POST /:id/subtasks/:sid/toggle — Toggle subtask completion.
// Responds with JSON for AJAX callers (the inline checklist on the task cards)
// and falls back to a redirect for the plain-form usage on the edit page.
router.post('/:id/subtasks/:sid/toggle', (req, res) => {
  const db = getDb();
  const wantsJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
  const subtask = db.prepare('SELECT * FROM subtasks WHERE id = ? AND task_id = ?').get(req.params.sid, req.params.id);
  const task = subtask ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id) : null;

  if (!subtask || !task) {
    if (wantsJson) return res.status(404).json({ error: 'Checklist item not found.' });
    return res.redirect('/tasks/' + req.params.id + '/edit');
  }
  // Ticking an item is a modification — gate it the same as the task itself.
  if (!canModifyTask(task, req.session.user)) {
    if (wantsJson) return res.status(403).json({ error: 'You can only update your own tasks.' });
    req.flash('error', 'You can only update your own tasks.');
    return req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
  }

  const nowCompleted = subtask.completed ? 0 : 1;
  if (nowCompleted) {
    db.prepare("UPDATE subtasks SET completed = 1, completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(req.params.sid);
  } else {
    db.prepare('UPDATE subtasks SET completed = 0, completed_at = NULL WHERE id = ?').run(req.params.sid);
  }

  if (wantsJson) {
    const agg = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(completed), 0) AS done FROM subtasks WHERE task_id = ?').get(req.params.id);
    return res.json({ ok: true, id: Number(req.params.sid), completed: !!nowCompleted, total: agg.total, done: agg.done });
  }
  req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
});

// POST /:id/subtasks/:sid/delete — Delete a subtask
router.post('/:id/subtasks/:sid/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM subtasks WHERE id = ? AND task_id = ?').run(req.params.sid, req.params.id);
  res.redirect('/tasks/' + req.params.id + '/edit');
});

// =============================================
// Task Dependencies
// =============================================

// POST /:id/dependencies — Add a dependency
router.post('/:id/dependencies', (req, res) => {
  const db = getDb();
  const { depends_on_id } = req.body;
  if (!depends_on_id) return res.redirect('/tasks/' + req.params.id + '/edit');
  // Prevent self-dependency
  if (String(depends_on_id) === String(req.params.id)) {
    req.flash('error', 'A task cannot depend on itself.');
    return req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
  }
  // Prevent circular dependencies (check if depends_on_id already depends on this task)
  const circular = db.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?').get(depends_on_id, req.params.id);
  if (circular) {
    req.flash('error', 'Cannot add dependency — it would create a circular reference.');
    return req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
  }
  try {
    db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)').run(req.params.id, depends_on_id);
  } catch (e) {
    // UNIQUE constraint — dependency already exists
    req.flash('error', 'This dependency already exists.');
  }
  req.session.save(() => res.redirect('/tasks/' + req.params.id + '/edit'));
});

// POST /:id/dependencies/:did/delete — Remove a dependency
router.post('/:id/dependencies/:did/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM task_dependencies WHERE id = ? AND task_id = ?').run(req.params.did, req.params.id);
  res.redirect('/tasks/' + req.params.id + '/edit');
});

module.exports = router;
