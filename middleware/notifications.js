const { getDb } = require('../db/database');
const { sendTeamsNotification } = require('./integrations');
const { sendEmail } = require('../services/email');
const { notificationEmail, dailyDigestEmail } = require('../services/emailTemplates');
const notifPrefs = require('../lib/notificationPrefs');
const { sendPushForNotifications, sendPushToUser } = require('../services/pushNotification');
const { todaysBirthdays, localIso: bdayLocalIso } = require('../lib/birthdays');

/**
 * Middleware that attaches unread notification count to res.locals for the header bell icon.
 */
function notificationCountMiddleware(req, res, next) {
  if (!req.session || !req.session.user) return next();

  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(req.session.user.id);
    res.locals.unreadNotifications = count ? count.count : 0;
  } catch (err) {
    res.locals.unreadNotifications = 0;
  }

  next();
}

/**
 * Create a notification for one or more users and fire a Web Push to each.
 * Used for event-driven notifications (e.g. a plan being submitted) rather
 * than the periodic generateNotifications() sweep.
 *
 * @param {object} db           - better-sqlite3 handle
 * @param {Array<number>} userIds - recipient user ids (deduped, falsy dropped)
 * @param {object} opts         - { type, title, message, link, jobId }
 * @returns {number} count of notification rows inserted
 */
function notifyUsers(db, userIds, opts = {}) {
  const { type = 'general', title = '', message = '', link = '', jobId = null } = opts;
  if (!db || !title) return 0;

  // Dedupe + drop falsy ids (e.g. a null submitter excluded by the caller)
  const recipients = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (recipients.length === 0) return 0;

  const insert = db.prepare(
    'INSERT INTO notifications (user_id, type, title, message, link, job_id) VALUES (?, ?, ?, ?, ?, ?)'
  );

  let inserted = 0;
  for (const userId of recipients) {
    try {
      insert.run(userId, type, title, message, link, jobId);
      inserted++;
      // Fire-and-forget push; failures are swallowed inside sendPushToUser
      Promise.resolve(sendPushToUser(userId, {
        title,
        body: message,
        url: link || '/notifications',
        type
      })).catch(() => {});
    } catch (err) {
      console.error('[notifyUsers] failed for user', userId, ':', err.message);
    }
  }
  return inserted;
}

/**
 * Generate automatic notifications (call periodically or on server start).
 * Checks for overdue tasks, expiring compliance, missing updates, etc.
 * Uses de-duplication to avoid sending the same notification within 24 hours.
 */
function generateNotifications() {
  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const last7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const next3 = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];
    const next14 = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    const next30 = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];

    // Helper: create notification if one with the same user+type+title does not already exist within 24hrs
    const insertIfNew = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link, job_id)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications
        WHERE user_id = ? AND type = ? AND title = ? AND created_at > datetime('now', '-1 day')
      )
    `);

    // Track newly created notification IDs for email sending
    const newNotificationIds = [];
    const _prefsCache = {};
    function _userPrefs(uid) {
      if (!(uid in _prefsCache)) _prefsCache[uid] = notifPrefs.getUserPrefs(db, uid);
      return _prefsCache[uid];
    }

    function insertAndTrack(userId, type, title, message, link, jobId) {
      // Respect the recipient's in-app preference for this category — if they've
      // switched it off, don't create the notification at all.
      if (!notifPrefs.wantsInApp(_userPrefs(userId), type)) return { changes: 0 };
      const result = insertIfNew.run(userId, type, title, message, link, jobId, userId, type, title);
      if (result.changes > 0) {
        newNotificationIds.push({ userId, type, title, message, link });
      }
      return result;
    }

    // Admin/management recipients for org-wide alerts (ticket expiry, equipment
    // inspections, inductions, over-budget). Referenced by several blocks below;
    // its definition had gone missing, which threw and aborted the whole engine.
    const mgmtUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(role) IN ('admin','management')").all();

    // 0. Upcoming task deadlines --> notify task owner (due today, tomorrow, or in 3 days)
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const in3days = new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

    // Admin-division tasks only notify owners who are admin/management —
    // these are private items and shouldn't leak to ops/planning/etc. inboxes.
    const upcomingTasks = db.prepare(`
      SELECT t.id, t.title, t.due_date, t.owner_id, t.job_id, j.job_number
      FROM tasks t LEFT JOIN jobs j ON t.job_id = j.id
      WHERE t.status NOT IN ('complete') AND t.deleted_at IS NULL AND t.owner_id IS NOT NULL
      AND t.due_date IN (?, ?, ?)
      AND (t.division != 'admin' OR EXISTS (
        SELECT 1 FROM users u WHERE u.id = t.owner_id AND LOWER(u.role) IN ('admin','management')
      ))
    `).all(today, tomorrow, in3days);

    for (const t of upcomingTasks) {
      const daysUntil = Math.round((new Date(t.due_date) - new Date(today)) / 86400000);
      const urgency = daysUntil === 0 ? 'due today' : daysUntil === 1 ? 'due tomorrow' : 'due in 3 days';
      const title = 'Deadline ' + urgency + ': ' + t.title;
      insertAndTrack(t.owner_id, 'deadline_reminder', title, 'Task "' + t.title + '"' + (t.job_number ? ' on ' + t.job_number : '') + ' is ' + urgency + '.', '/tasks/' + t.id + '/edit', t.job_id);
    }

    // 1. Overdue tasks --> notify task owner
    const overdueTasks = db.prepare(`
      SELECT t.id, t.title, t.owner_id, t.job_id, j.job_number
      FROM tasks t JOIN jobs j ON t.job_id = j.id
      WHERE t.due_date < ? AND t.status != 'complete' AND t.deleted_at IS NULL
      AND t.owner_id IS NOT NULL
      AND (t.division != 'admin' OR EXISTS (
        SELECT 1 FROM users u WHERE u.id = t.owner_id AND LOWER(u.role) IN ('admin','management')
      ))
    `).all(today);

    for (const t of overdueTasks) {
      const title = 'Overdue Task: ' + t.title;
      insertAndTrack(t.owner_id, 'overdue_task', title, 'Task "' + t.title + '" on ' + t.job_number + ' is overdue.', '/jobs/' + t.job_id + '#tasks', t.job_id);
    }

    // 2. Expiring compliance --> notify internal approver or PM
    const expiringCompliance = db.prepare(`
      SELECT c.id, c.title, c.job_id, c.internal_approver_id, j.job_number, j.project_manager_id
      FROM compliance c JOIN jobs j ON c.job_id = j.id
      WHERE c.due_date BETWEEN ? AND ? AND c.status NOT IN ('approved', 'expired')
    `).all(today, next14);

    for (const c of expiringCompliance) {
      const userId = c.internal_approver_id || c.project_manager_id;
      if (!userId) continue;
      const title = 'Compliance Due: ' + c.title;
      insertAndTrack(userId, 'expiring_compliance', title, c.title + ' on ' + c.job_number + ' is due soon.', '/jobs/' + c.job_id + '#compliance', c.job_id);
    }

    // 2b. Sub-plan expiry within 7 days. Each approved/submitted sub-plan
    // with an expiry_date in the next week pings whoever owns the parent
    // Plan (internal_approver, falling back to PM). The link drops the
    // user straight onto the parent's edit page so they can extend / re-
    // submit / chase the authority.
    const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    const expiringSubPlans = db.prepare(`
      SELECT sub.id, sub.parent_id, sub.reference_number, sub.expiry_date,
             sub.item_type, sub.extension_required,
             p.title as parent_title, p.internal_approver_id as parent_approver_id,
             j.id as job_id, j.job_number, j.project_manager_id
      FROM compliance sub
      JOIN compliance p ON sub.parent_id = p.id
      LEFT JOIN jobs j ON p.job_id = j.id
      WHERE sub.expiry_date IS NOT NULL
        AND sub.expiry_date BETWEEN ? AND ?
        AND sub.status IN ('submitted', 'approved')
    `).all(today, next7);

    for (const s of expiringSubPlans) {
      const userId = s.parent_approver_id || s.project_manager_id;
      if (!userId) continue;
      const days = Math.max(0, Math.round((new Date(s.expiry_date) - new Date(today)) / 86400000));
      const isROL = s.item_type === 'rol' || s.item_type === 'road_occupancy';
      const extHint = isROL && !s.extension_required ? ' Extension may be needed.' : '';
      const title = `Sub-plan expiring: ${s.reference_number}`;
      const message = `${s.reference_number} (${s.parent_title}) expires in ${days} day${days === 1 ? '' : 's'}.${extHint}`;
      insertAndTrack(userId, 'expiring_compliance', title, message, '/compliance/' + s.parent_id + '/edit#sub-' + s.id, s.job_id);
    }

    // 2c. SWMS expiring within 30 days. Templates renew every 3 months,
    // job-linked SWMS every 6 months — cycle is encoded on the row's
    // existing expiry_date, so we just watch for rows in the 30-day
    // window. Reminders fan out to admin / operations / safety inboxes.
    // last_reminded_at on the SWMS row is bumped after dispatch so we
    // don't re-send the same reminder daily.
    try {
      const swmsAvailable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='swms'").get();
      if (swmsAvailable) {
        const swmsCols = db.prepare("PRAGMA table_info(swms)").all().map(c => c.name);
        const hasReminder = swmsCols.includes('last_reminded_at');
        const expiringSwms = db.prepare(`
          SELECT s.id, s.title, s.kind, s.expiry_date, s.job_id, s.last_reminded_at,
            j.job_number
          FROM swms s
          LEFT JOIN jobs j ON j.id = s.job_id
          WHERE s.expiry_date IS NOT NULL
            AND s.expiry_date <= date('now','+30 days')
            AND s.status != 'archived'
            ${hasReminder ? "AND (s.last_reminded_at IS NULL OR s.last_reminded_at < datetime('now','-7 days'))" : ''}
        `).all();
        if (expiringSwms.length > 0) {
          const recipients = db.prepare(`
            SELECT id FROM users
            WHERE active = 1 AND LOWER(role) IN ('admin','management','operations','safety')
          `).all();
          const stampReminded = hasReminder
            ? db.prepare("UPDATE swms SET last_reminded_at = CURRENT_TIMESTAMP WHERE id = ?")
            : null;
          for (const s of expiringSwms) {
            const days = Math.round((new Date(s.expiry_date) - new Date(today)) / 86400000);
            const isOverdue = days < 0;
            const phrase = isOverdue ? `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue` :
                           days === 0 ? 'expires today' :
                           `expires in ${days} day${days === 1 ? '' : 's'}`;
            const title = `SWMS ${isOverdue ? 'overdue' : 'expiring'}: ${s.title}`;
            const cycleNote = s.kind === 'template' ? '3-month review' : '6-month renewal';
            const msg = `${s.title} (${cycleNote})${s.job_number ? ' — ' + s.job_number : ''} ${phrase}.`;
            for (const u of recipients) {
              insertAndTrack(u.id, 'swms_expiring', title, msg, '/swms/' + s.id, s.job_id);
            }
            if (stampReminded) stampReminded.run(s.id);
          }
        }
      }
    } catch (e) {
      console.error('SWMS expiry reminder error:', e.message);
    }

    // 2c-bis. SOP register expiring within 30 days. Mirrors the SWMS block
    // exactly — templates 3mo, job-linked 6mo, same recipient roles, same
    // de-dupe via last_reminded_at.
    try {
      const sopAvailable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sop_register'").get();
      if (sopAvailable) {
        const sopCols = db.prepare("PRAGMA table_info(sop_register)").all().map(c => c.name);
        const hasReminder = sopCols.includes('last_reminded_at');
        const expiringSop = db.prepare(`
          SELECT s.id, s.title, s.kind, s.expiry_date, s.job_id, s.last_reminded_at,
            j.job_number
          FROM sop_register s
          LEFT JOIN jobs j ON j.id = s.job_id
          WHERE s.expiry_date IS NOT NULL
            AND s.expiry_date <= date('now','+30 days')
            AND s.status != 'archived'
            ${hasReminder ? "AND (s.last_reminded_at IS NULL OR s.last_reminded_at < datetime('now','-7 days'))" : ''}
        `).all();
        if (expiringSop.length > 0) {
          const recipients = db.prepare(`
            SELECT id FROM users
            WHERE active = 1 AND LOWER(role) IN ('admin','management','operations','safety')
          `).all();
          const stampReminded = hasReminder
            ? db.prepare("UPDATE sop_register SET last_reminded_at = CURRENT_TIMESTAMP WHERE id = ?")
            : null;
          for (const s of expiringSop) {
            const days = Math.round((new Date(s.expiry_date) - new Date(today)) / 86400000);
            const isOverdue = days < 0;
            const phrase = isOverdue ? `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue` :
                           days === 0 ? 'expires today' :
                           `expires in ${days} day${days === 1 ? '' : 's'}`;
            const title = `SOP ${isOverdue ? 'overdue' : 'expiring'}: ${s.title}`;
            const cycleNote = s.kind === 'template' ? '3-month review' : '6-month renewal';
            const msg = `${s.title} (${cycleNote})${s.job_number ? ' — ' + s.job_number : ''} ${phrase}.`;
            for (const u of recipients) {
              insertAndTrack(u.id, 'sop_expiring', title, msg, '/sop-register/' + s.id, s.job_id);
            }
            if (stampReminded) stampReminded.run(s.id);
          }
        }
      }
    } catch (e) {
      console.error('SOP expiry reminder error:', e.message);
    }

    // 2d. Risk Assessments expiring within 30 days. Same cadence + recipient
    // set as SWMS — templates 3mo, job-linked 6mo. Mirrors the swms_expiring
    // notifier above so the two modules stay in lockstep.
    try {
      const raAvailable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='risk_assessments'").get();
      if (raAvailable) {
        const raCols = db.prepare("PRAGMA table_info(risk_assessments)").all().map(c => c.name);
        const hasReminder = raCols.includes('last_reminded_at');
        const expiringRA = db.prepare(`
          SELECT r.id, r.title, r.kind, r.expiry_date, r.job_id, r.last_reminded_at,
            j.job_number
          FROM risk_assessments r
          LEFT JOIN jobs j ON j.id = r.job_id
          WHERE r.expiry_date IS NOT NULL
            AND r.expiry_date <= date('now','+30 days')
            AND r.status != 'archived'
            ${hasReminder ? "AND (r.last_reminded_at IS NULL OR r.last_reminded_at < datetime('now','-7 days'))" : ''}
        `).all();
        if (expiringRA.length > 0) {
          const recipients = db.prepare(`
            SELECT id FROM users
            WHERE active = 1 AND LOWER(role) IN ('admin','management','operations','safety')
          `).all();
          const stampReminded = hasReminder
            ? db.prepare("UPDATE risk_assessments SET last_reminded_at = CURRENT_TIMESTAMP WHERE id = ?")
            : null;
          for (const r of expiringRA) {
            const days = Math.round((new Date(r.expiry_date) - new Date(today)) / 86400000);
            const isOverdue = days < 0;
            const phrase = isOverdue ? `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue` :
                           days === 0 ? 'expires today' :
                           `expires in ${days} day${days === 1 ? '' : 's'}`;
            const title = `Risk Assessment ${isOverdue ? 'overdue' : 'expiring'}: ${r.title}`;
            const cycleNote = r.kind === 'template' ? '3-month review' : '6-month renewal';
            const msg = `${r.title} (${cycleNote})${r.job_number ? ' — ' + r.job_number : ''} ${phrase}.`;
            for (const u of recipients) {
              insertAndTrack(u.id, 'risk_assessment_expiring', title, msg, '/risk-assessments/' + r.id, r.job_id);
            }
            if (stampReminded) stampReminded.run(r.id);
          }
        }
      }
    } catch (e) {
      console.error('Risk Assessment expiry reminder error:', e.message);
    }

    // 3. Missing updates --> notify PM (no update in 7+ days)
    const missingUpdates = db.prepare(`
      SELECT j.id, j.job_number, j.project_manager_id
      FROM jobs j
      WHERE j.status = 'active' AND j.project_manager_id IS NOT NULL
      AND (j.last_update_date IS NULL OR j.last_update_date < ?)
    `).all(last7);

    for (const j of missingUpdates) {
      const title = 'Missing Update: ' + j.job_number;
      insertAndTrack(j.project_manager_id, 'missing_update', title, j.job_number + ' has no update in the last 7 days.', '/jobs/' + j.id + '#diary', j.id);
    }

    // 4. Overdue corrective actions (incident- AND audit-sourced).
    // LEFT JOINs so audit NCs (no parent incident / no job) still surface.
    const overdueCA = db.prepare(`
      SELECT ca.id, ca.description, ca.assigned_to_id, ca.job_id, ca.incident_id, ca.source_type, ca.source_audit_id,
             j.job_number, i.incident_number
      FROM corrective_actions ca
      LEFT JOIN incidents i ON ca.incident_id = i.id
      LEFT JOIN jobs j ON ca.job_id = j.id
      WHERE ca.due_date < ? AND ca.status NOT IN ('completed', 'cancelled')
      AND ca.assigned_to_id IS NOT NULL
    `).all(today);

    for (const ca of overdueCA) {
      const ref = ca.incident_number || (ca.source_type === 'audit' && ca.source_audit_id ? ('Audit #' + ca.source_audit_id) : ('Action #' + ca.id));
      const title = 'Corrective Action Overdue: ' + ref;
      const msg = 'Action for ' + ref + ' is overdue.';
      const link = ca.incident_number ? ('/incidents/' + ca.incident_id)
        : (ca.source_audit_id ? ('/audits/' + ca.source_audit_id) : '/actions');
      const result = insertAndTrack(ca.assigned_to_id, 'corrective_action_due', title, msg, link, ca.job_id);
      if (result.changes > 0) sendTeamsNotification(title, msg, link).catch(() => {});
    }

    // 4b. Repeat offenders — workers crossing the per-person audit-tag threshold
    try {
      const cfg = db.prepare('SELECT threshold_count, window_days, min_risk_level, enabled FROM audit_repeat_offender_config WHERE id = 1').get()
        || { threshold_count: 3, window_days: 90, enabled: 1 };
      if (cfg.enabled) {
        const offenders = db.prepare(`
          SELECT t.crew_member_id, COALESCE(cm.full_name, t.worker_name_snapshot) AS name, COUNT(*) AS hits
          FROM audit_question_tags t
          JOIN site_audits a ON a.id = t.audit_id
          LEFT JOIN crew_members cm ON cm.id = t.crew_member_id
          WHERE t.crew_member_id IS NOT NULL AND a.audit_datetime >= date('now', ?)
          GROUP BY t.crew_member_id
          HAVING COUNT(*) >= ?
        `).all('-' + (cfg.window_days || 90) + ' days', cfg.threshold_count || 3);
        for (const o of offenders) {
          const emp = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ? ORDER BY id LIMIT 1').get(o.crew_member_id);
          if (emp) {
            try { db.prepare('UPDATE employees SET repeat_offender_flagged_at = CURRENT_TIMESTAMP, repeat_offender_count = ? WHERE id = ?').run(o.hits, emp.id); } catch (e) {}
          }
          const title = 'Repeat issue: ' + (o.name || ('Crew #' + o.crew_member_id));
          const msg = (o.name || 'A worker') + ' has ' + o.hits + ' audit non-conformances in the last ' + (cfg.window_days || 90) + ' days — review and consider training.';
          const link = emp ? ('/hr/employees/' + emp.id) : '/audits/reports';
          for (const u of mgmtUsers) insertAndTrack(u.id, 'repeat_offender', title, msg, link, null);
        }
      }
    } catch (e) { console.error('[notifications] repeat-offender sweep error:', e.message); }

    // 5. Follow-ups due
    const followUps = db.prepare(`
      SELECT cl.id, cl.subject, cl.logged_by_id, cl.job_id, j.job_number
      FROM communication_log cl
      JOIN jobs j ON cl.job_id = j.id
      WHERE cl.follow_up_required = 1 AND cl.follow_up_done = 0
      AND cl.follow_up_date <= ?
      AND cl.logged_by_id IS NOT NULL
    `).all(today);

    for (const f of followUps) {
      const title = 'Follow-up Due: ' + f.subject;
      insertAndTrack(f.logged_by_id, 'follow_up_due', title, 'Follow-up for "' + f.subject + '" on ' + f.job_number + ' is due.', '/contacts/comms?job_id=' + f.job_id, f.job_id);
    }

    // 6. Equipment overdue return
    const overdueEquip = db.prepare(`
      SELECT ea.id, ea.equipment_id, ea.job_id, ea.assigned_by_id, e.asset_number, e.name, j.job_number
      FROM equipment_assignments ea
      JOIN equipment e ON ea.equipment_id = e.id
      JOIN jobs j ON ea.job_id = j.id
      WHERE ea.expected_return_date < ? AND ea.actual_return_date IS NULL
      AND ea.assigned_by_id IS NOT NULL
    `).all(today);

    for (const eq of overdueEquip) {
      const title = 'Equipment Overdue: ' + eq.asset_number;
      const msg = eq.asset_number + ' (' + eq.name + ') overdue for return from ' + eq.job_number + '.';
      const link = '/equipment/' + eq.equipment_id;
      const result = insertAndTrack(eq.assigned_by_id, 'equipment_overdue', title, msg, link, eq.job_id);
      if (result.changes > 0) sendTeamsNotification(title, msg, link).catch(() => {});
    }

    // (Defects feature retired — no notifier needed.)

    // 8. Ticket Expiry --> notify management (30-day warning for crew member tickets)
    const expiringTickets = db.prepare(`
      SELECT cm.id, cm.full_name, cm.tc_ticket_expiry, cm.ti_ticket_expiry, cm.white_card_expiry, cm.first_aid_expiry, cm.medical_expiry
      FROM crew_members cm
      WHERE cm.active = 1
      AND (
        (cm.tc_ticket_expiry IS NOT NULL AND cm.tc_ticket_expiry BETWEEN ? AND ?)
        OR (cm.ti_ticket_expiry IS NOT NULL AND cm.ti_ticket_expiry BETWEEN ? AND ?)
        OR (cm.white_card_expiry IS NOT NULL AND cm.white_card_expiry BETWEEN ? AND ?)
        OR (cm.first_aid_expiry IS NOT NULL AND cm.first_aid_expiry BETWEEN ? AND ?)
        OR (cm.medical_expiry IS NOT NULL AND cm.medical_expiry BETWEEN ? AND ?)
      )
    `).all(today, next30, today, next30, today, next30, today, next30, today, next30);

    for (const cm of expiringTickets) {
      const expiring = [];
      if (cm.tc_ticket_expiry && cm.tc_ticket_expiry >= today && cm.tc_ticket_expiry <= next30) expiring.push('TC Ticket');
      if (cm.ti_ticket_expiry && cm.ti_ticket_expiry >= today && cm.ti_ticket_expiry <= next30) expiring.push('TI Ticket');
      if (cm.white_card_expiry && cm.white_card_expiry >= today && cm.white_card_expiry <= next30) expiring.push('White Card');
      if (cm.first_aid_expiry && cm.first_aid_expiry >= today && cm.first_aid_expiry <= next30) expiring.push('First Aid');
      if (cm.medical_expiry && cm.medical_expiry >= today && cm.medical_expiry <= next30) expiring.push('Medical');
      const ticketList = expiring.join(', ');
      for (const u of mgmtUsers) {
        const title = 'Ticket Expiry: ' + cm.full_name;
        insertAndTrack(u.id, 'ticket_expiry', title, cm.full_name + ' has expiring tickets: ' + ticketList + '.', '/crew/' + cm.id, null);
      }
    }

    // 9. ROL Pending --> notify PM
    const rolPending = db.prepare(`
      SELECT tp.id, tp.plan_number, tp.job_id, j.job_number, j.project_manager_id
      FROM traffic_plans tp
      JOIN jobs j ON tp.job_id = j.id
      WHERE tp.rol_required = 1 AND (tp.rol_submitted IS NULL OR tp.rol_submitted = 0)
      AND tp.status NOT IN ('approved','rejected','expired')
      AND j.project_manager_id IS NOT NULL
    `).all();

    for (const rp of rolPending) {
      const title = 'ROL Pending: ' + rp.plan_number;
      insertAndTrack(rp.project_manager_id, 'rol_pending', title, 'ROL not yet submitted for plan ' + rp.plan_number + ' on ' + rp.job_number + '.', '/jobs/' + rp.job_id + '#traffic-plans', rp.job_id);
    }

    // 10. Equipment Inspection Due --> notify management (14-day warning)
    const equipInspectionDue = db.prepare(`
      SELECT e.id, e.asset_number, e.name, e.next_inspection_date
      FROM equipment e
      WHERE e.active = 1 AND e.next_inspection_date BETWEEN ? AND ?
    `).all(today, next14);

    for (const e of equipInspectionDue) {
      for (const u of mgmtUsers) {
        const title = 'Inspection Due: ' + e.asset_number;
        insertAndTrack(u.id, 'equipment_inspection_due', title, e.asset_number + ' (' + e.name + ') inspection due by ' + e.next_inspection_date + '.', '/equipment/' + e.id, null);
      }
    }

    // 11. Induction Overdue — disabled per office request. The
    //     7/3/1-day upcoming-induction reminders in
    //     services/inductionReminders.js still fire; this just stops
    //     the perpetual "X has a pending induction" pings once the
    //     date is in the past.

    // 12. Over-budget jobs --> notify management
    const overBudgetJobs = db.prepare(`
      SELECT j.id, j.job_number, j.project_manager_id, b.contract_value,
        COALESCE((SELECT SUM(amount) FROM cost_entries WHERE job_id = j.id), 0) as total_spent
      FROM jobs j
      JOIN job_budgets b ON j.id = b.job_id
      WHERE j.status = 'active'
      AND COALESCE((SELECT SUM(amount) FROM cost_entries WHERE job_id = j.id), 0) > b.contract_value
      AND b.contract_value > 0
    `).all();

    for (const ob of overBudgetJobs) {
      let teamsNotified = false;
      for (const u of mgmtUsers) {
        const title = 'Over Budget: ' + ob.job_number;
        const msg = ob.job_number + ' has exceeded its contract value. Spent: $' + Math.round(ob.total_spent) + ' / Contract: $' + Math.round(ob.contract_value) + '.';
        const link = '/budgets/job/' + ob.id;
        const result = insertAndTrack(u.id, 'over_budget', title, msg, link, ob.id);
        if (result.changes > 0 && !teamsNotified) {
          sendTeamsNotification(title, msg, link).catch(() => {});
          teamsNotified = true;
        }
      }
    }

    // 13. Birthdays today — notify admin/management/ops/HR users once per
    // birthday person per day. insertIfNew's 24h dedupe means re-running
    // the engine every 15 min won't spam; the title+type combo keys the
    // dedupe per birthday person.
    try {
      const bdays = todaysBirthdays(db);
      if (bdays.length > 0) {
        const bdayRecipients = db.prepare(`
          SELECT id FROM users
          WHERE active = 1 AND LOWER(role) IN ('admin','management','operations','hr')
        `).all();
        for (const b of bdays) {
          const turning = (b.turning && b.turning > 0 && b.turning < 110) ? ` turns ${b.turning} today.` : ' has a birthday today.';
          const title = `🎂 Birthday today: ${b.full_name}`;
          const msg = `${b.full_name}${turning} Drop them a wish — the crew is also wishing them on the worker portal.`;
          const link = `/crew/${b.crew_member_id}`;
          for (const u of bdayRecipients) {
            insertAndTrack(u.id, 'birthday_today', title, msg, link, null);
          }
        }
      }
    } catch (e) { console.error('[notifications] birthday step failed:', e.message); }

    // Plans Module reminders (spec §7 + §8). Council Application keys off the
    // Job Date; ROL keys off the Job Date or the approved works-start. Both
    // fire at 7 and 2 days out to the responsible person, deduped over 24h.
    try {
      const next7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      const next2 = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
      const planRows = db.prepare(`
        SELECT tp.id, tp.plan_number, tp.plan_types, tp.job_date, tp.rol_summary_from, tp.status,
               j.id AS job_id, j.job_number, j.planning_owner_id, j.ops_supervisor_id, j.created_by_id
        FROM traffic_plans tp JOIN jobs j ON tp.job_id = j.id
        WHERE tp.status NOT IN ('rejected','expired')
          AND (tp.plan_types LIKE '%Council Application%' OR tp.plan_types LIKE '%ROL%')
          AND (tp.job_date IN (?, ?) OR tp.rol_summary_from IN (?, ?))
      `).all(next7, next2, next7, next2);

      for (const p of planRows) {
        const types = (p.plan_types || '').split(',');
        const isCouncil = types.includes('Council Application');
        const refDate = (p.job_date === next7 || p.job_date === next2) ? p.job_date : p.rol_summary_from;
        if (refDate !== next7 && refDate !== next2) continue;
        const daysOut = refDate === next2 ? 2 : 7;
        const recipient = isCouncil
          ? (p.planning_owner_id || p.created_by_id)
          : (p.ops_supervisor_id || p.planning_owner_id || p.created_by_id);
        if (!recipient) continue;
        const label = isCouncil ? 'Council Application' : 'ROL';
        const title = `${label} reminder (${daysOut} day${daysOut === 1 ? '' : 's'}): ${p.plan_number}`;
        const message = `${label} ${p.plan_number} on ${p.job_number} — ${daysOut} days until ${isCouncil ? 'job date' : 'works start'} (${refDate}).`;
        // 'deadline_reminder' is an allowed notifications.type (the table has a
        // CHECK enum); the plan-specific title keeps the 24h dedup distinct.
        insertAndTrack(recipient, 'deadline_reminder', title, message, `/plans/${p.id}`, p.job_id);
      }
    } catch (e) { console.error('[notifications] plan reminder step failed:', e.message); }

    // Compliance ("Plans & Approvals") council/ROL reminders (spec §7/§8):
    // Council Permit + ROL sub-plans with a Job Date 7 or 2 days out notify
    // the sub-plan owner (falling back to the parent owner / job owners).
    try {
      const next7c = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
      const next2c = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];
      const rows = db.prepare(`
        SELECT c.id, c.reference_number, c.item_type, c.job_date, c.assigned_to_id, c.parent_id, c.job_id,
               p.assigned_to_id AS parent_owner_id, j.job_number, j.planning_owner_id, j.ops_supervisor_id
        FROM compliance c
        LEFT JOIN compliance p ON c.parent_id = p.id
        LEFT JOIN jobs j ON c.job_id = j.id
        WHERE c.parent_id IS NOT NULL
          AND c.item_type IN ('council_permit','rol','road_occupancy')
          AND c.status NOT IN ('rejected','expired')
          AND c.job_date IN (?, ?)
      `).all(next7c, next2c);
      for (const c of rows) {
        const daysOut = c.job_date === next2c ? 2 : 7;
        const isCouncil = c.item_type === 'council_permit';
        const recipient = c.assigned_to_id || c.parent_owner_id || (isCouncil ? c.planning_owner_id : c.ops_supervisor_id) || c.planning_owner_id;
        if (!recipient) continue;
        const label = isCouncil ? 'Council Permit' : 'ROL';
        const title = `${label} reminder (${daysOut} day${daysOut === 1 ? '' : 's'}): ${c.reference_number}`;
        const message = `${label} ${c.reference_number}${c.job_number ? ' on ' + c.job_number : ''} — ${daysOut} days until job date (${c.job_date}).`;
        insertAndTrack(recipient, 'deadline_reminder', title, message, `/compliance/${c.parent_id}/edit#sub-${c.id}`, c.job_id);
      }
    } catch (e) { console.error('[notifications] compliance plan reminder step failed:', e.message); }

    // ROL application chase: a ROL application is valid 14 days from the
    // applied-for date. If it isn't approved by day 10, chase the Planning
    // team — a reminder notification AND a one-off Planning task (so it lands
    // on the tasks board, not just the bell). Fires across the day 10→14
    // window each daily sweep; the notification 24h-dedupe + the task
    // existence check keep it from piling up.
    try {
      const rolChase = db.prepare(`
        SELECT c.id, c.reference_number, c.rol_actual_number, c.rol_applied_date, c.assigned_to_id,
               c.parent_id, c.job_id, c.title,
               p.assigned_to_id AS parent_owner_id, j.job_number, j.planning_owner_id
        FROM compliance c
        LEFT JOIN compliance p ON c.parent_id = p.id
        LEFT JOIN jobs j ON c.job_id = j.id
        WHERE c.parent_id IS NOT NULL
          AND c.item_type IN ('rol','road_occupancy')
          AND c.rol_applied_date IS NOT NULL
          AND c.status NOT IN ('approved','rejected','expired')
          AND COALESCE(c.rol_stage,'none') != 'approved'
          AND date('now','localtime') >= date(c.rol_applied_date, '+10 days')
          AND date('now','localtime') <= date(c.rol_applied_date, '+14 days')
      `).all();
      // Planning-team fallback owner: a planning-role user, else any admin.
      const planningUser = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(role) = 'planning' ORDER BY id LIMIT 1").get();
      const adminUser = db.prepare("SELECT id FROM users WHERE active = 1 AND LOWER(role) IN ('admin','management') ORDER BY id LIMIT 1").get();
      const findTask = db.prepare("SELECT id FROM tasks WHERE compliance_id = ? AND title = ? AND deleted_at IS NULL");
      const insTask = db.prepare(`
        INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, notes, created_by, compliance_id)
        VALUES (?, 'planning', ?, ?, ?, ?, 'not_started', 'high', 'one_off', ?, NULL, ?)
      `);
      for (const c of rolChase) {
        const expiry = new Date(Date.parse(c.rol_applied_date + 'T00:00:00Z') + 14 * 86400000).toISOString().split('T')[0];
        const ref = c.rol_actual_number || c.reference_number || ('ROL #' + c.id);
        const recipient = c.planning_owner_id || c.assigned_to_id || c.parent_owner_id || (planningUser && planningUser.id) || (adminUser && adminUser.id);
        if (recipient) {
          const title = `ROL approval overdue — chase ${ref}`;
          const message = `ROL ${ref}${c.job_number ? ' on ' + c.job_number : ''} still not approved. The application expires ${expiry} (14 days from ${c.rol_applied_date}). Chase the authority now.`;
          insertAndTrack(recipient, 'deadline_reminder', title, message, `/compliance/${c.parent_id}/edit#sub-${c.id}`, c.job_id);
        }
        // Planning task — one per ROL sub-plan (dedup by compliance_id + title).
        const taskTitle = `Chase ROL approval — ${ref}`;
        const owner = c.assigned_to_id || c.planning_owner_id || (planningUser && planningUser.id) || (adminUser && adminUser.id);
        if (owner && !findTask.get(c.id, taskTitle)) {
          try {
            insTask.run(
              c.job_id || null, taskTitle,
              `ROL application not approved by day 10. Expires ${expiry}. Chase the authority and mark the ROL approved once granted.`,
              owner, expiry, `Plan: /compliance/${c.parent_id}/edit#sub-${c.id}`, c.id
            );
          } catch (te) { console.error('[notifications] ROL chase task insert failed:', te.message); }
        }
      }
    } catch (e) { console.error('[notifications] ROL chase step failed:', e.message); }

    // Send immediate email notifications for newly created notifications
    sendImmediateEmails(db, newNotificationIds);

    // Send push notifications to subscribed devices
    sendPushForNotifications(db, newNotificationIds);

  } catch (err) {
    console.error('Notification generation error:', err.message);
  }
}

/**
 * Send immediate email notifications to users with email_notifications_enabled and frequency = 'immediate'
 */
function sendImmediateEmails(db, newNotifications) {
  if (newNotifications.length === 0) return;

  try {
    // Build a lookup of user email preferences
    const users = db.prepare("SELECT id, full_name, email, email_notifications_enabled, notification_frequency, notification_prefs FROM users WHERE active = 1 AND email IS NOT NULL AND email != ''").all();
    const userMap = {};
    for (const u of users) userMap[u.id] = u;

    for (const n of newNotifications) {
      const user = userMap[n.userId];
      if (!user) continue;
      if (!user.email_notifications_enabled) continue;
      if (user.notification_frequency !== 'immediate') continue;
      // Per-category email preference (master switch already checked above).
      if (!notifPrefs.wantsEmail(user.notification_prefs, n.type)) continue;

      const html = notificationEmail(user.full_name, n.title, n.message, n.link);
      sendEmail(user.email, n.title, html).catch(() => {});

      // Mark email as sent
      try {
        db.prepare("UPDATE notifications SET email_sent_at = CURRENT_TIMESTAMP WHERE user_id = ? AND title = ? AND email_sent_at IS NULL AND created_at > datetime('now', '-1 hour')").run(n.userId, n.title);
      } catch (e) { /* ignore */ }
    }
  } catch (err) {
    console.error('Email notification error:', err.message);
  }
}

/**
 * Send daily digest emails to users with notification_frequency = 'daily'
 */
function sendDailyDigests() {
  try {
    const db = getDb();
    const users = db.prepare(`
      SELECT id, full_name, email, notification_prefs FROM users
      WHERE active = 1 AND email IS NOT NULL AND email != ''
      AND email_notifications_enabled = 1 AND notification_frequency = 'daily'
    `).all();

    for (const user of users) {
      const all = db.prepare(`
        SELECT type, title, message, link FROM notifications
        WHERE user_id = ? AND is_read = 0 AND email_sent_at IS NULL
        AND created_at > datetime('now', '-1 day')
        ORDER BY created_at DESC
      `).all(user.id);
      // Drop categories the user doesn't want emailed — they still show in-app.
      const notifications = all.filter(function (n) { return notifPrefs.wantsEmail(user.notification_prefs, n.type); });

      const markSent = db.prepare(`
        UPDATE notifications SET email_sent_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND is_read = 0 AND email_sent_at IS NULL
        AND created_at > datetime('now', '-1 day')
      `);

      if (notifications.length === 0) {
        // Stamp the batch so we don't reconsider these rows every run.
        markSent.run(user.id);
        continue;
      }

      const html = dailyDigestEmail(user.full_name, notifications);
      sendEmail(user.email, `Atomis: ${notifications.length} new notification${notifications.length === 1 ? '' : 's'}`, html).catch(() => {});
      markSent.run(user.id);
    }
  } catch (err) {
    console.error('Daily digest error:', err.message);
  }
}

/**
 * Generate weekly job summaries from site diary entries.
 * Runs once per week (Monday 7:15-7:29 AM window).
 * For each active job with diary entries in the past 7 days, creates a summary
 * and notifies Taj and Saadat.
 */
function generateWeeklySummaries() {
  try {
    const db = getDb();
    const today = new Date().toISOString().split('T')[0];
    const last7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

    // Check if we already ran this week (prevent duplicate runs)
    const lastRun = db.prepare("SELECT value FROM system_config WHERE key = 'last_weekly_summary_date'").get();
    if (lastRun && lastRun.value === today) return;

    // Get all active jobs with diary entries in the past 7 days
    const jobsWithEntries = db.prepare(`
      SELECT j.id, j.job_number, j.client, j.project_name, j.site_address, j.suburb,
        u_pm.full_name as pm_name
      FROM jobs j
      LEFT JOIN users u_pm ON j.project_manager_id = u_pm.id
      WHERE j.status = 'active'
      AND j.id IN (SELECT DISTINCT job_id FROM site_diary_entries WHERE entry_date >= ?)
      ORDER BY j.job_number
    `).all(last7);

    if (jobsWithEntries.length === 0) {
      // Mark as run even if no entries
      db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('last_weekly_summary_date', ?)").run(today);
      return;
    }

    // Build summary for each job
    const summaries = [];
    for (const job of jobsWithEntries) {
      const entries = db.prepare(`
        SELECT sd.entry_date, sd.task, sd.outcomes, sd.issues, sd.comments,
          u.full_name as created_by_name
        FROM site_diary_entries sd
        LEFT JOIN users u ON sd.created_by_id = u.id
        WHERE sd.job_id = ? AND sd.entry_date >= ?
        ORDER BY sd.entry_date DESC
      `).all(job.id, last7);

      const entryCount = entries.length;
      const categories = [...new Set(entries.map(e => e.task).filter(Boolean))];
      const issues = entries.map(e => e.issues).filter(Boolean);
      const outcomes = entries.map(e => e.outcomes).filter(Boolean);

      // Build a concise summary
      let summary = `${job.job_number} — ${job.project_name || job.client}`;
      summary += ` | ${entryCount} diary entr${entryCount === 1 ? 'y' : 'ies'} this week`;
      if (categories.length > 0) summary += ` | Categories: ${categories.slice(0, 5).join(', ')}`;
      if (issues.length > 0) summary += ` | ⚠ ${issues.length} issue${issues.length !== 1 ? 's' : ''} reported`;

      summaries.push({ job, entryCount, categories, issues, outcomes, summary });
    }

    // Build the combined notification message
    const totalEntries = summaries.reduce((sum, s) => sum + s.entryCount, 0);
    const jobsWithIssues = summaries.filter(s => s.issues.length > 0);

    const title = `Weekly Summary: ${summaries.length} job${summaries.length !== 1 ? 's' : ''} active this week`;

    let message = `${totalEntries} diary entries across ${summaries.length} jobs.`;
    if (jobsWithIssues.length > 0) {
      message += ` Issues flagged on: ${jobsWithIssues.map(s => s.job.job_number).join(', ')}.`;
    }
    // Add per-job summary lines (max 10)
    message += '\n\n' + summaries.slice(0, 10).map(s => s.summary).join('\n');
    if (summaries.length > 10) message += `\n... and ${summaries.length - 10} more jobs`;

    // Recipient list: configurable via system_config.weekly_summary_recipients
    // (comma-separated usernames). Falls back to all active admin users so a
    // fresh white-label deployment doesn't silently send to nobody — and so
    // the old T&S-specific "taj, saadat" hardcode is no longer baked in.
    // Set the key explicitly from /settings to override the admin-fallback.
    let notifyUsers;
    const cfgRow = db.prepare("SELECT value FROM system_config WHERE key = 'weekly_summary_recipients'").get();
    const cfgList = cfgRow && cfgRow.value
      ? String(cfgRow.value).split(',').map(s => s.trim()).filter(Boolean)
      : [];
    if (cfgList.length > 0) {
      const placeholders = cfgList.map(() => '?').join(',');
      notifyUsers = db.prepare(
        `SELECT id, full_name, email FROM users WHERE username IN (${placeholders}) AND active = 1`
      ).all(...cfgList);
    } else {
      notifyUsers = db.prepare("SELECT id, full_name, email FROM users WHERE role = 'admin' AND active = 1").all();
    }

    const insertNotif = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link, job_id)
      VALUES (?, 'weekly_summary', ?, ?, '/dashboard', NULL)
    `);

    for (const user of notifyUsers) {
      try {
        insertNotif.run(user.id, title, message);
        // Send email immediately
        if (user.email) {
          const html = notificationEmail(user.full_name, title, message.replace(/\n/g, '<br>'), '/dashboard');
          sendEmail(user.email, title, html).catch(() => {});
        }
        // Send push notification
        sendPushForNotifications(db, [{ userId: user.id, title, message: message.split('\n')[0], link: '/dashboard' }]);
      } catch (e) {
        console.error(`[WeeklySummary] Error notifying ${user.full_name}:`, e.message);
      }
    }

    // Mark as run
    db.prepare("INSERT OR REPLACE INTO system_config (key, value) VALUES ('last_weekly_summary_date', ?)").run(today);

    console.log(`[WeeklySummary] Generated for ${summaries.length} jobs, notified ${notifyUsers.length} users.`);
  } catch (err) {
    console.error('[WeeklySummary] Error:', err.message);
  }
}

module.exports = { notificationCountMiddleware, generateNotifications, sendDailyDigests, generateWeeklySummaries, notifyUsers };
