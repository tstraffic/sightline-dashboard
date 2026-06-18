const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { requireRole, requirePermission } = require('../middleware/auth');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { normalizePhone, normalizeEmail } = require('../lib/crewDedup');
const { workerInviteEmail } = require('../services/emailTemplates');
const {
  getComplianceStatus,
  getComplianceStatusBatch,
  getBatchFatigue,
} = require('../middleware/compliance');

// GET / — Workforce Roster
router.get('/', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const filter = req.query.filter || 'all'; // all | active | blocked | fatigued | expiring
  const roleFilter = req.query.role || '';
  const search = (req.query.search || '').trim().toLowerCase();

  // Fetch all crew (active + inactive)
  let crew = db.prepare(`
    SELECT * FROM crew_members ORDER BY active DESC, full_name ASC
  `).all();

  // Batch: active allocation counts per crew member (today or future, not cancelled)
  const allocCountRows = db.prepare(`
    SELECT crew_member_id, COUNT(*) as cnt
    FROM crew_allocations
    WHERE allocation_date >= ? AND status != 'cancelled'
    GROUP BY crew_member_id
  `).all(today);
  const allocCountMap = {};
  allocCountRows.forEach(r => { allocCountMap[r.crew_member_id] = r.cnt; });

  // Batch: last worked date per crew member (from timesheets)
  const lastWorkedRows = db.prepare(`
    SELECT crew_member_id, MAX(work_date) as last_worked
    FROM timesheets
    GROUP BY crew_member_id
  `).all();
  const lastWorkedMap = {};
  lastWorkedRows.forEach(r => { lastWorkedMap[r.crew_member_id] = r.last_worked; });

  // Batch fatigue lookup for performance
  const fatigueMap = getBatchFatigue(today);

  // Compute nearest expiry from all date fields
  function getNearestExpiry(m) {
    const fields = [
      { label: 'Licence', date: m.licence_expiry },
      { label: 'White Card', date: m.white_card_expiry },
      { label: 'Medical', date: m.medical_expiry },
      { label: 'TC Ticket', date: m.tc_ticket_expiry },
      { label: 'TI Ticket', date: m.ti_ticket_expiry },
      { label: 'First Aid', date: m.first_aid_expiry },
    ];
    let nearest = null;
    for (const f of fields) {
      if (f.date && (!nearest || f.date < nearest.date)) {
        nearest = { label: f.label, date: f.date };
      }
    }
    return nearest;
  }

  // Compute compliance status for each + enrich with extra data.
  // A crew member is "pending onboarding" if they have no PIN set (so
  // they can't log into the worker portal yet) OR if their employee_id
  // still carries the VOC-PENDING-* placeholder we drop in when the
  // Quick Cert flow auto-creates a row for an unknown name. HR uses
  // this to find rows that need finishing.
  const crewWithStatus = crew.map(m => {
    const nearestExpiry = getNearestExpiry(m);
    const pendingOnboarding = m.active && (
      !m.pin_hash ||
      (m.employee_id && /^VOC-PENDING-/.test(m.employee_id))
    );
    return {
      ...m,
      compliance: getComplianceStatusBatch(m, fatigueMap, today),
      activeJobs: allocCountMap[m.id] || 0,
      lastWorked: lastWorkedMap[m.id] || null,
      nearestExpiry,
      pendingOnboarding,
      // Specific quick-cert flag — useful for a tighter sub-filter and
      // for showing a distinct chip in the view.
      vocQuickCreated: !!(m.employee_id && /^VOC-PENDING-/.test(m.employee_id)),
    };
  });

  // 30-day expiry window for "expiring" filter
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
  const expiryThreshold = thirtyDaysOut.toISOString().split('T')[0];

  // Apply filters
  let filtered = crewWithStatus;
  if (filter === 'active') {
    filtered = filtered.filter(c => c.active);
  } else if (filter === 'blocked') {
    filtered = filtered.filter(c => c.active && !c.compliance.canAllocate);
  } else if (filter === 'fatigued') {
    filtered = filtered.filter(c => c.compliance.fatigueBlocked);
  } else if (filter === 'expiring') {
    filtered = filtered.filter(c => c.active && c.nearestExpiry && c.nearestExpiry.date <= expiryThreshold);
  } else if (filter === 'pending_onboarding') {
    filtered = filtered.filter(c => c.pendingOnboarding);
  }

  // Apply role filter
  if (roleFilter) {
    filtered = filtered.filter(c => c.role === roleFilter);
  }

  // Apply search
  if (search) {
    filtered = filtered.filter(c =>
      c.full_name.toLowerCase().includes(search) ||
      (c.employee_id || '').toLowerCase().includes(search) ||
      (c.role || '').toLowerCase().includes(search) ||
      (c.company || '').toLowerCase().includes(search)
    );
  }

  // Sorting
  const allowedSorts = ['full_name', 'employee_id', 'role', 'licence_expiry'];
  const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'full_name';
  const order = req.query.order === 'desc' ? 'desc' : 'asc';
  filtered.sort((a, b) => {
    let valA = a[sort] || '';
    let valB = b[sort] || '';
    if (typeof valA === 'string') valA = valA.toLowerCase();
    if (typeof valB === 'string') valB = valB.toLowerCase();
    if (valA < valB) return order === 'asc' ? -1 : 1;
    if (valA > valB) return order === 'asc' ? 1 : -1;
    return 0;
  });

  // Stats
  const totalActive = crewWithStatus.filter(c => c.active).length;
  const allocatable = crewWithStatus.filter(c => c.active && c.compliance.canAllocate).length;
  const complianceIssues = crewWithStatus.filter(c => c.active && (!c.compliance.allTicketsValid || !c.compliance.licenceValid || !c.compliance.inductionComplete)).length;
  const fatigueBlocked = crewWithStatus.filter(c => c.compliance.fatigueBlocked).length;
  const expiringSoon = crewWithStatus.filter(c => c.active && c.nearestExpiry && c.nearestExpiry.date <= expiryThreshold).length;
  const pendingOnboardingCount = crewWithStatus.filter(c => c.pendingOnboarding).length;

  res.render('crew/index', {
    title: 'Workforce',
    currentPage: 'crew',
    crew: filtered,
    filter,
    roleFilter,
    search: req.query.search || '',
    stats: { totalActive, allocatable, complianceIssues, fatigueBlocked, expiringSoon, pendingOnboardingCount },
    today,
    sort,
    order,
  });
});

// GET /new — Add Crew Member form
router.get('/new', (req, res) => {
  res.render('crew/form', { title: 'Add Crew Member', currentPage: 'crew', editMember: null });
});

// POST / — Create Crew Member
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const result = db.prepare(`
      INSERT INTO crew_members (full_name, employee_id, role, tcp_level, phone, email, company, employment_type, hourly_rate, licence_type, licence_expiry, white_card, white_card_expiry, induction_date, medical_expiry, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.full_name, b.employee_id || null, b.role, b.tcp_level || '', b.phone || '', b.email || '',
      b.company || '', b.employment_type || 'employee', parseFloat(b.hourly_rate) || 0,
      b.licence_type || '', b.licence_expiry || null, b.white_card || '', b.white_card_expiry || null,
      b.induction_date || null, b.medical_expiry || null, b.active ? 1 : 0
    );
    logActivity({ user: req.session.user, action: 'create', entityType: 'crew_member', entityId: result.lastInsertRowid, entityLabel: b.full_name, details: 'Added crew member', ip: req.ip });
    req.flash('success', b.full_name + ' added to workforce.');
    res.redirect('/crew/' + result.lastInsertRowid);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', 'Employee ID "' + b.employee_id + '" already exists.');
    } else {
      req.flash('error', 'Failed to add crew member: ' + err.message);
    }
    res.redirect('/crew/new');
  }
});

// GET /duplicates — find active crew that share a normalised phone or email
// (the classic "added via recruitment AND via induction form" double-up).
// MUST be declared before the /:id routes so it isn't captured by GET /:id.
router.get('/duplicates', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, full_name, employee_id, phone, email, status, induction_status, induction_date,
      (pin_hash IS NOT NULL) AS has_pin,
      (SELECT COUNT(*) FROM crew_allocations ca WHERE ca.crew_member_id = crew_members.id) AS allocations
    FROM crew_members WHERE active = 1
  `).all();

  // Group by normalised phone, then by email. A member can only land in one
  // group (phone wins) so the same row isn't shown twice.
  const groups = new Map(); // key -> { key, reason, members[] }
  const placed = new Set();
  function addTo(key, reason, m) {
    if (!groups.has(key)) groups.set(key, { key, reason, members: [] });
    groups.get(key).members.push(m);
    placed.add(m.id);
  }
  rows.forEach(m => {
    const np = normalizePhone(m.phone);
    if (np.length >= 8) addTo('p:' + np, 'phone', m);
  });
  rows.forEach(m => {
    if (placed.has(m.id)) return;
    const e = normalizeEmail(m.email);
    if (e) addTo('e:' + e, 'email', m);
  });

  const dupes = Array.from(groups.values())
    .filter(g => g.members.length > 1)
    // Suggest keeping the most-established record: has PIN, then most
    // allocations, then inducted, then lowest id (oldest).
    .map(g => {
      g.members.sort((a, b) =>
        (b.has_pin - a.has_pin) || (b.allocations - a.allocations) ||
        ((b.induction_status === 'completed') - (a.induction_status === 'completed')) || (a.id - b.id));
      g.suggestedKeepId = g.members[0].id;
      return g;
    })
    .sort((a, b) => a.members[0].full_name.localeCompare(b.members[0].full_name));

  res.render('crew/duplicates', { title: 'Duplicate crew', currentPage: 'crew', dupes });
});

// POST /duplicates/resolve — keep one member per group, deactivate the rest.
router.post('/duplicates/resolve', (req, res) => {
  const db = getDb();
  // Body: keep_<key> = crewId for each resolved group, and groups[] listing the
  // member ids that belonged to that group (so we know which to deactivate).
  const keepIds = [];
  const deactivateIds = [];
  Object.keys(req.body).forEach(k => {
    if (!k.startsWith('keep_')) return;
    const keepId = parseInt(req.body[k], 10);
    if (!keepId) return;
    keepIds.push(keepId);
    const memberField = req.body['members_' + k.slice(5)];
    const ids = String(memberField || '').split(',').map(n => parseInt(n, 10)).filter(Boolean);
    ids.forEach(id => { if (id !== keepId) deactivateIds.push(id); });
  });

  let n = 0;
  const deact = db.prepare("UPDATE crew_members SET active = 0, status = 'inactive' WHERE id = ?");
  const deactEmp = db.prepare('UPDATE employees SET active = 0 WHERE linked_crew_member_id = ?');
  const tx = db.transaction(() => {
    deactivateIds.forEach(id => {
      deact.run(id);
      try { deactEmp.run(id); } catch (e) { /* employees table optional link */ }
      n++;
    });
  });
  tx();
  try { logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityLabel: `Deactivated ${n} duplicate crew row(s)`, ip: req.ip }); } catch (e) {}
  req.flash('success', `Resolved duplicates — deactivated ${n} record(s).`);
  res.redirect('/crew/duplicates');
});

// POST /:id/deactivate — Single-row deactivate, redirects back to
// Referer so it can be called inline from the "Duplicate crew names
// detected" banner on /voc-assessments/quick (or anywhere else that
// surfaces a stranded crew row). Flips active=0 + also unsets the
// linked HR employee row if any (mirror of /hr/roster/delete) so the
// directions stay consistent. Logged for audit because this is the
// path most often used to clean up duplicates / placeholders.
router.post('/:id/deactivate', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  if (!id) { req.flash('error', 'No crew member specified.'); return res.redirect('back'); }
  const m = db.prepare('SELECT id, full_name, employee_id, active FROM crew_members WHERE id = ?').get(id);
  if (!m) { req.flash('error', 'Crew member not found.'); return res.redirect('back'); }
  if (!m.active) {
    req.flash('success', `${m.full_name} is already deactivated.`);
    return res.redirect(req.get('referer') || '/crew');
  }
  try {
    db.prepare('UPDATE crew_members SET active = 0 WHERE id = ?').run(id);
    // Mirror the cascade direction used by /hr/roster/delete — if this
    // crew row had a linked HR employee, soft-delete it too so the HR
    // view doesn't show a "live" employee whose operational row is
    // gone.
    const emp = db.prepare('SELECT id FROM employees WHERE linked_crew_member_id = ? AND active = 1').get(id);
    if (emp) {
      db.prepare(`UPDATE employees SET active = 0, deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(emp.id);
    }
    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'crew_member',
      entityId: id,
      entityLabel: m.full_name + (m.employee_id ? ' (' + m.employee_id + ')' : ''),
      details: 'Deactivated (single-row, e.g. duplicate cleanup)',
      ip: req.ip,
    });
    req.flash('success', `${m.full_name} deactivated.` + (emp ? ' Linked HR employee row also removed.' : ''));
  } catch (err) {
    console.error('[crew] single-row deactivate error:', err);
    req.flash('error', 'Failed to deactivate: ' + err.message);
  }
  res.redirect(req.get('referer') || '/crew');
});

// POST /bulk — Bulk actions on crew members
router.post('/bulk', (req, res) => {
  const db = getDb();
  const ids = (req.body.ids || '').split(',').map(Number).filter(n => n > 0);
  const action = req.body.action;
  if (ids.length === 0) return res.redirect('/crew');

  if (action === 'deactivate') {
    const stmt = db.prepare('UPDATE crew_members SET active = 0 WHERE id = ?');
    ids.forEach(id => stmt.run(id));
    logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityLabel: `Bulk deactivated ${ids.length} crew members`, ip: req.ip });
    req.flash('success', ids.length + ' crew member(s) deactivated.');
  }
  res.redirect('/crew');
});

// GET /:id/edit — Edit Crew Member form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const editMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!editMember) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  res.render('crew/form', { title: 'Edit ' + editMember.full_name, currentPage: 'crew', editMember });
});

// POST /:id — Update Crew Member
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  try {
    db.prepare(`
      UPDATE crew_members SET full_name=?, employee_id=?, role=?, tcp_level=?, phone=?, email=?, company=?, employment_type=?, hourly_rate=?, licence_type=?, licence_expiry=?, white_card=?, white_card_expiry=?, induction_date=?, medical_expiry=?, active=? WHERE id=?
    `).run(
      b.full_name, b.employee_id || null, b.role, b.tcp_level || '', b.phone || '', b.email || '',
      b.company || '', b.employment_type || 'employee', parseFloat(b.hourly_rate) || 0,
      b.licence_type || '', b.licence_expiry || null, b.white_card || '', b.white_card_expiry || null,
      b.induction_date || null, b.medical_expiry || null, b.active ? 1 : 0, req.params.id
    );

    // Mirror name + contact onto the linked employees row so the HR
    // profile + payroll stay in sync. Both tables hold full_name and
    // both feed different views; divergence shows up as "I changed
    // it but it didn't propagate".
    try {
      db.prepare(`
        UPDATE employees
        SET full_name = ?, email = ?, phone = ?, updated_at = CURRENT_TIMESTAMP
        WHERE linked_crew_member_id = ? AND deleted_at IS NULL
      `).run(b.full_name, b.email || '', b.phone || '', req.params.id);
    } catch (e) { /* column drift ok */ }
    logActivity({ user: req.session.user, action: 'update', entityType: 'crew_member', entityId: member.id, entityLabel: b.full_name, details: 'Updated crew member details', ip: req.ip });
    req.flash('success', b.full_name + ' updated.');
    res.redirect('/crew/' + member.id);
  } catch (err) {
    req.flash('error', 'Failed to update: ' + err.message);
    res.redirect('/crew/' + member.id + '/edit');
  }
});

// GET /:id — Worker Profile
router.get('/:id', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);

  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  const compliance = getComplianceStatus(member, today);

  // Upcoming allocations
  const upcomingShifts = db.prepare(`
    SELECT ca.*, j.job_number, j.client, j.suburb
    FROM crew_allocations ca
    JOIN jobs j ON ca.job_id = j.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date >= ? AND ca.status != 'cancelled'
    ORDER BY ca.allocation_date ASC, ca.start_time ASC
    LIMIT 30
  `).all(member.id, today);

  // Recent timesheets
  const recentTimesheets = db.prepare(`
    SELECT t.*, j.job_number, j.client,
      u.full_name as approved_by_name
    FROM timesheets t
    JOIN jobs j ON t.job_id = j.id
    LEFT JOIN users u ON t.approved_by_id = u.id
    WHERE t.crew_member_id = ?
    ORDER BY t.work_date DESC
    LIMIT 20
  `).all(member.id);

  // Linked incidents (structured + free-text search)
  const linkedIncidents = db.prepare(`
    SELECT DISTINCT i.id, i.incident_number, i.incident_date, i.incident_type,
      i.severity, i.title, i.investigation_status,
      icm.involvement_type
    FROM incidents i
    LEFT JOIN incident_crew_members icm ON icm.incident_id = i.id AND icm.crew_member_id = ?
    WHERE icm.id IS NOT NULL
    OR i.persons_involved LIKE ? OR i.witnesses LIKE ?
    ORDER BY i.incident_date DESC
    LIMIT 20
  `).all(member.id, '%' + member.full_name + '%', '%' + member.full_name + '%');

  // Supervisor who approved (if any)
  let approvedBy = null;
  if (member.supervisor_approved_by_id) {
    approvedBy = db.prepare('SELECT full_name FROM users WHERE id = ?').get(member.supervisor_approved_by_id);
  }

  const activities = db.prepare(`
    SELECT al.*, u.full_name as user_name
    FROM activity_log al LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'crew_member' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(req.params.id);

  // Granted SWMS competencies (job-linked SWMS this crew member can access).
  const swmsGrants = db.prepare(`
    SELECT g.id, g.granted_at, g.source, g.notes,
           s.id AS swms_id, s.title, s.status, s.expiry_date, s.kind,
           j.job_number, j.client,
           u.full_name AS granted_by_name
    FROM crew_swms_grants g
    JOIN swms s ON s.id = g.swms_id
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = g.granted_by_id
    WHERE g.crew_member_id = ?
    ORDER BY g.granted_at DESC
  `).all(member.id);

  // Pending access requests + recent history.
  const pendingSwmsRequests = db.prepare(`
    SELECT r.*, s.title, s.kind, j.job_number, j.client
    FROM crew_swms_access_requests r
    JOIN swms s ON s.id = r.swms_id
    LEFT JOIN jobs j ON j.id = s.job_id
    WHERE r.crew_member_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC
  `).all(member.id);

  const decidedSwmsRequests = db.prepare(`
    SELECT r.*, s.title, s.kind, j.job_number, j.client,
      u.full_name AS decided_by_name
    FROM crew_swms_access_requests r
    JOIN swms s ON s.id = r.swms_id
    LEFT JOIN jobs j ON j.id = s.job_id
    LEFT JOIN users u ON u.id = r.decided_by_id
    WHERE r.crew_member_id = ? AND r.status <> 'pending'
    ORDER BY r.decided_at DESC
    LIMIT 10
  `).all(member.id);

  // Job-linked SWMS available to attach manually (excludes ones already granted).
  const availableJobSwms = db.prepare(`
    SELECT s.id, s.title, s.status, j.job_number, j.client
    FROM swms s
    LEFT JOIN jobs j ON j.id = s.job_id
    WHERE s.kind = 'job' AND s.status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM crew_swms_grants g
        WHERE g.swms_id = s.id AND g.crew_member_id = ?
      )
    ORDER BY j.job_number DESC, s.title
  `).all(member.id);

  res.render('crew/show', {
    title: member.full_name + ' — Worker Profile',
    currentPage: 'crew',
    member,
    compliance,
    upcomingShifts,
    recentTimesheets,
    linkedIncidents,
    activities,
    approvedBy: approvedBy ? approvedBy.full_name : null,
    today,
    swmsGrants,
    pendingSwmsRequests,
    decidedSwmsRequests,
    availableJobSwms,
  });
});

// POST /:id/swms-requests/:requestId/approve — admin confirms the worker's
// induction; creates a crew_swms_grants row (idempotent) + marks the request approved.
router.post('/:id/swms-requests/:requestId/approve', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  const request = db.prepare('SELECT * FROM crew_swms_access_requests WHERE id = ? AND crew_member_id = ?').get(req.params.requestId, member.id);
  if (!request) { req.flash('error', 'Request not found.'); return res.redirect('/crew/' + member.id); }
  if (request.status !== 'pending') { req.flash('error', 'Request already decided.'); return res.redirect('/crew/' + member.id); }
  const decisionNote = String(req.body.decision_note || '').trim().slice(0, 500);
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO crew_swms_grants
          (crew_member_id, swms_id, granted_by_id, source, notes)
        VALUES (?, ?, ?, 'request_approved', ?)
      `).run(member.id, request.swms_id, req.session.user.id, decisionNote);
      db.prepare(`
        UPDATE crew_swms_access_requests
        SET status = 'approved', decided_by_id = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?
        WHERE id = ?
      `).run(req.session.user.id, decisionNote, request.id);
    });
    tx();
    const swmsRow = db.prepare('SELECT title FROM swms WHERE id = ?').get(request.swms_id);
    logActivity({ user: req.session.user, action: 'approve', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Approved SWMS access: ' + (swmsRow && swmsRow.title || '#' + request.swms_id), ip: req.ip });
    req.flash('success', 'Access granted. ' + member.full_name + ' can now view this SWMS.');
  } catch (e) {
    console.error('[crew] swms request approve error:', e.message);
    req.flash('error', 'Could not approve request.');
  }
  return res.redirect('/crew/' + member.id + '#swms-requests');
});

// POST /:id/swms-requests/:requestId/reject — decline with an optional note.
router.post('/:id/swms-requests/:requestId/reject', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  const request = db.prepare('SELECT * FROM crew_swms_access_requests WHERE id = ? AND crew_member_id = ?').get(req.params.requestId, member.id);
  if (!request) { req.flash('error', 'Request not found.'); return res.redirect('/crew/' + member.id); }
  if (request.status !== 'pending') { req.flash('error', 'Request already decided.'); return res.redirect('/crew/' + member.id); }
  const decisionNote = String(req.body.decision_note || '').trim().slice(0, 500);
  try {
    db.prepare(`
      UPDATE crew_swms_access_requests
      SET status = 'rejected', decided_by_id = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?
      WHERE id = ?
    `).run(req.session.user.id, decisionNote, request.id);
    logActivity({ user: req.session.user, action: 'reject', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Rejected SWMS access request #' + request.id, ip: req.ip });
    req.flash('success', 'Request rejected.');
  } catch (e) {
    console.error('[crew] swms request reject error:', e.message);
    req.flash('error', 'Could not reject request.');
  }
  return res.redirect('/crew/' + member.id + '#swms-requests');
});

// POST /:id/swms-grants — admin manually attaches a job-linked SWMS to a
// crew member's competencies (i.e. unlocks the worker portal view without
// a self-service request).
router.post('/:id/swms-grants', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  const swmsId = parseInt(req.body.swms_id, 10) || 0;
  if (!swmsId) { req.flash('error', 'Pick a SWMS to attach.'); return res.redirect('/crew/' + member.id); }
  const swms = db.prepare("SELECT id, title, kind, status FROM swms WHERE id = ?").get(swmsId);
  if (!swms) { req.flash('error', 'SWMS not found.'); return res.redirect('/crew/' + member.id); }
  if (swms.kind !== 'job') { req.flash('error', 'Only job-linked SWMS are grantable as competencies.'); return res.redirect('/crew/' + member.id); }
  const notes = String(req.body.notes || '').trim().slice(0, 500);
  try {
    db.prepare(`
      INSERT OR IGNORE INTO crew_swms_grants
        (crew_member_id, swms_id, granted_by_id, source, notes)
      VALUES (?, ?, ?, 'manual', ?)
    `).run(member.id, swmsId, req.session.user.id, notes);
    // Also auto-close any pending request for the same SWMS, since access
    // is now granted out-of-band.
    db.prepare(`
      UPDATE crew_swms_access_requests
      SET status = 'approved', decided_by_id = ?, decided_at = CURRENT_TIMESTAMP, decision_note = COALESCE(NULLIF(decision_note,''), 'Granted manually')
      WHERE crew_member_id = ? AND swms_id = ? AND status = 'pending'
    `).run(req.session.user.id, member.id, swmsId);
    logActivity({ user: req.session.user, action: 'create', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Granted SWMS competency: ' + swms.title, ip: req.ip });
    req.flash('success', 'SWMS attached as a competency.');
  } catch (e) {
    console.error('[crew] swms grant error:', e.message);
    req.flash('error', 'Could not attach SWMS.');
  }
  return res.redirect('/crew/' + member.id + '#swms-competencies');
});

// POST /:id/swms-grants/:grantId/delete — revoke a granted SWMS competency.
router.post('/:id/swms-grants/:grantId/delete', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }
  const grant = db.prepare(`
    SELECT g.id, s.title FROM crew_swms_grants g
    JOIN swms s ON s.id = g.swms_id
    WHERE g.id = ? AND g.crew_member_id = ?
  `).get(req.params.grantId, member.id);
  if (!grant) { req.flash('error', 'Grant not found.'); return res.redirect('/crew/' + member.id); }
  try {
    db.prepare('DELETE FROM crew_swms_grants WHERE id = ?').run(grant.id);
    logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Revoked SWMS competency: ' + grant.title, ip: req.ip });
    req.flash('success', 'SWMS competency revoked.');
  } catch (e) {
    console.error('[crew] swms grant revoke error:', e.message);
    req.flash('error', 'Could not revoke grant.');
  }
  return res.redirect('/crew/' + member.id + '#swms-competencies');
});

// POST /:id/delete — Delete Crew Member
router.post('/:id/delete', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return res.redirect('/crew'); }

  // Check for linked records
  const allocations = db.prepare('SELECT COUNT(*) as count FROM crew_allocations WHERE crew_member_id = ?').get(req.params.id).count;
  const timesheets = db.prepare('SELECT COUNT(*) as count FROM timesheets WHERE crew_member_id = ?').get(req.params.id).count;
  if (allocations > 0 || timesheets > 0) {
    req.flash('error', `Cannot delete ${member.full_name} — they have ${allocations} allocation(s) and ${timesheets} timesheet(s). Deactivate instead.`);
    return res.redirect('/crew/' + member.id);
  }

  db.prepare('DELETE FROM crew_members WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Deleted crew member', ip: req.ip });
  req.flash('success', member.full_name + ' deleted.');
  res.redirect('/crew');
});

// POST /:id/supervisor-approve — Toggle supervisor approval
router.post('/:id/supervisor-approve', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  const newStatus = member.supervisor_approved ? 0 : 1;
  if (newStatus) {
    db.prepare(`
      UPDATE crew_members SET supervisor_approved = 1, supervisor_approved_by_id = ?, supervisor_approved_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.session.user.id, member.id);
  } else {
    db.prepare(`
      UPDATE crew_members SET supervisor_approved = 0, supervisor_approved_by_id = NULL, supervisor_approved_at = NULL WHERE id = ?
    `).run(member.id);
  }

  logActivity({
    user: req.session.user,
    action: newStatus ? 'approve' : 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: newStatus ? 'Supervisor approved crew member' : 'Revoked supervisor approval',
    ip: req.ip,
  });

  req.flash('success', newStatus ? member.full_name + ' approved' : 'Approval revoked for ' + member.full_name);
  res.redirect('/crew/' + member.id);
});

// POST /:id/set-pin — Set or reset worker portal PIN
router.post('/:id/set-pin', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  const { pin } = req.body;

  // Validate PIN: 4-6 digits
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return res.redirect('/crew/' + member.id);
  }

  // Hash and save
  const pinHash = bcrypt.hashSync(pin, 12);
  db.prepare(`
    UPDATE crew_members SET pin_hash = ?, pin_set_at = CURRENT_TIMESTAMP, pin_set_by_id = ? WHERE id = ?
  `).run(pinHash, req.session.user.id, member.id);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: 'Set worker portal PIN',
    ip: req.ip,
  });

  req.flash('success', 'Portal PIN set for ' + member.full_name);
  res.redirect('/crew/' + member.id);
});

// POST /:id/send-invite — Send email invitation for worker portal
router.post('/:id/send-invite', requireRole('admin', 'operations'), async (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  if (!member.email || !member.employee_id) {
    req.flash('error', 'Crew member needs both an email and Employee ID to receive an invite.');
    return res.redirect('/crew/' + member.id);
  }

  const { token } = createInvitation({ type: 'crew_member', targetId: member.id, email: member.email, createdById: req.session.user.id });
  const setupUrl = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`) + '/w/setup/' + token;
  await sendEmail(member.email, 'Set up your Atomis Crew PIN', workerInviteEmail(member.full_name, setupUrl, TOKEN_EXPIRY_HOURS));

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: 'Sent worker portal email invitation',
    ip: req.ip,
  });

  req.flash('success', `Invitation email sent to ${member.email}`);
  res.redirect('/crew/' + member.id);
});

// POST /:id/clear-pin — Remove worker portal PIN
router.post('/:id/clear-pin', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return res.redirect('/crew');
  }

  db.prepare(`
    UPDATE crew_members SET pin_hash = NULL, pin_set_at = NULL, pin_set_by_id = NULL WHERE id = ?
  `).run(member.id);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'crew_member',
    entityId: member.id,
    entityLabel: member.full_name,
    details: 'Cleared worker portal PIN',
    ip: req.ip,
  });

  req.flash('success', 'Portal PIN cleared for ' + member.full_name);
  res.redirect('/crew/' + member.id);
});

module.exports = router;
