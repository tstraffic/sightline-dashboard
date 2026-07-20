const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { requireRole, requirePermission } = require('../middleware/auth');
const { createInvitation, TOKEN_EXPIRY_HOURS } = require('../services/invitations');
const { sendEmail } = require('../services/email');
const { workerInviteEmail } = require('../services/emailTemplates');
const {
  getComplianceStatus,
  getComplianceStatusBatch,
  getBatchFatigue,
} = require('../middleware/compliance');

// GET / — the Workforce listing is retired: the Roster tab (/hr/roster) is
// the single place that lists every employee and links to their profiles.
// Individual worker profiles (/crew/:id) remain for deep links (booking board
// "Profile", HR employee pages, vehicle audits, …).
router.get('/', (req, res) => {
  res.redirect('/hr/roster');
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
    req.session.save(() => res.redirect('/crew/' + result.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      req.flash('error', 'Employee ID "' + b.employee_id + '" already exists.');
    } else {
      req.flash('error', 'Failed to add crew member: ' + err.message);
    }
    req.session.save(() => res.redirect('/crew/new'));
  }
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
  if (!id) { req.flash('error', 'No crew member specified.'); return req.session.save(() => res.redirect('back')); }
  const m = db.prepare('SELECT id, full_name, employee_id, active FROM crew_members WHERE id = ?').get(id);
  if (!m) { req.flash('error', 'Crew member not found.'); return req.session.save(() => res.redirect('back')); }
  if (!m.active) {
    req.flash('success', `${m.full_name} is already deactivated.`);
    return req.session.save(() => res.redirect(req.get('referer') || '/crew'));
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
  req.session.save(() => res.redirect(req.get('referer') || '/crew'));
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
  req.session.save(() => res.redirect('/crew'));
});

// GET /:id/edit — Edit Crew Member form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const editMember = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!editMember) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }
  res.render('crew/form', { title: 'Edit ' + editMember.full_name, currentPage: 'crew', editMember });
});

// POST /:id — Update Crew Member
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }
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
    req.session.save(() => res.redirect('/crew/' + member.id));
  } catch (err) {
    req.flash('error', 'Failed to update: ' + err.message);
    req.session.save(() => res.redirect('/crew/' + member.id + '/edit'));
  }
});

// GET /:id — Worker Profile
router.get('/:id', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);

  if (!member) {
    req.flash('error', 'Crew member not found');
    return req.session.save(() => res.redirect('/crew'));
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

  // Safety flags — site audits this person was on where the audit went bad
  // (failed / critical / follow-up required). Same adverse-outcome logic the
  // Safety Reports pages use; a clean audit is not a flag.
  let flaggedAudits = [];
  try {
    flaggedAudits = db.prepare(`
      SELECT sa.id, sa.audit_datetime, sa.project_site, sa.overall_result,
             sa.score_percent, sa.critical_fail, sa.follow_up_required,
             ac.role_on_site
      FROM audit_crew ac
      JOIN site_audits sa ON sa.id = ac.audit_id
      WHERE ac.crew_member_id = ?
        AND (sa.critical_fail = 1
             OR sa.follow_up_required = 1
             OR LOWER(COALESCE(sa.overall_result, '')) LIKE '%fail%'
             OR LOWER(COALESCE(sa.overall_finding, '')) LIKE '%fail%')
      ORDER BY sa.audit_datetime DESC
      LIMIT 20
    `).all(member.id);
  } catch (e) { console.error('[crew.show] flagged audits error:', e.message); }

  // Vehicle damage accountability — defects assigned to this person
  // (mirror of /vehicle-audits/accountability, scoped to one worker).
  let vehicleDefects = [];
  try {
    vehicleDefects = db.prepare(`
      SELECT d.id, d.item_label, d.severity, d.status, d.cost_estimate,
             d.created_at, d.resolved_date, v.asset_id, va.audit_date
      FROM vehicle_defects d
      JOIN vehicles v ON v.id = d.vehicle_id
      LEFT JOIN vehicle_audits va ON va.id = d.audit_id
      WHERE d.assigned_to = ?
      ORDER BY d.created_at DESC
      LIMIT 20
    `).all(member.id);
  } catch (e) { console.error('[crew.show] vehicle defects error:', e.message); }

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

  // Optional return target so "back" goes where the user came from (e.g. the
  // HR employee profile) instead of always the Workforce list. Internal paths
  // only (must start with a single "/") to avoid open-redirects.
  const rawFrom = (req.query.from || '').toString();
  // Default back target is the Roster tab — the single listing of everyone.
  const backUrl = /^\/[^/]/.test(rawFrom) ? rawFrom : '/hr/roster';
  const backLabel = backUrl.startsWith('/hr/roster') ? 'Roster'
    : (backUrl.startsWith('/hr/employees') ? 'Employee Profile'
    : (backUrl.startsWith('/bookings') ? 'Bookings' : 'Back'));

  res.render('crew/show', {
    title: member.full_name + ' — Worker Profile',
    currentPage: 'crew',
    member,
    backUrl,
    backLabel,
    compliance,
    upcomingShifts,
    recentTimesheets,
    linkedIncidents,
    flaggedAudits,
    vehicleDefects,
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
  if (!member) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }
  const request = db.prepare('SELECT * FROM crew_swms_access_requests WHERE id = ? AND crew_member_id = ?').get(req.params.requestId, member.id);
  if (!request) { req.flash('error', 'Request not found.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
  if (request.status !== 'pending') { req.flash('error', 'Request already decided.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
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
  return req.session.save(() => res.redirect('/crew/' + member.id + '#swms-requests'));
});

// POST /:id/swms-requests/:requestId/reject — decline with an optional note.
router.post('/:id/swms-requests/:requestId/reject', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }
  const request = db.prepare('SELECT * FROM crew_swms_access_requests WHERE id = ? AND crew_member_id = ?').get(req.params.requestId, member.id);
  if (!request) { req.flash('error', 'Request not found.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
  if (request.status !== 'pending') { req.flash('error', 'Request already decided.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
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
  return req.session.save(() => res.redirect('/crew/' + member.id + '#swms-requests'));
});

// POST /:id/swms-grants — admin manually attaches a job-linked SWMS to a
// crew member's competencies (i.e. unlocks the worker portal view without
// a self-service request).
router.post('/:id/swms-grants', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }
  const swmsId = parseInt(req.body.swms_id, 10) || 0;
  if (!swmsId) { req.flash('error', 'Pick a SWMS to attach.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
  const swms = db.prepare("SELECT id, title, kind, status FROM swms WHERE id = ?").get(swmsId);
  if (!swms) { req.flash('error', 'SWMS not found.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
  if (swms.kind !== 'job') { req.flash('error', 'Only job-linked SWMS are grantable as competencies.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
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
  return req.session.save(() => res.redirect('/crew/' + member.id + '#swms-competencies'));
});

// POST /:id/swms-grants/:grantId/delete — revoke a granted SWMS competency.
router.post('/:id/swms-grants/:grantId/delete', requirePermission('swms'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }
  const grant = db.prepare(`
    SELECT g.id, s.title FROM crew_swms_grants g
    JOIN swms s ON s.id = g.swms_id
    WHERE g.id = ? AND g.crew_member_id = ?
  `).get(req.params.grantId, member.id);
  if (!grant) { req.flash('error', 'Grant not found.'); return req.session.save(() => res.redirect('/crew/' + member.id)); }
  try {
    db.prepare('DELETE FROM crew_swms_grants WHERE id = ?').run(grant.id);
    logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Revoked SWMS competency: ' + grant.title, ip: req.ip });
    req.flash('success', 'SWMS competency revoked.');
  } catch (e) {
    console.error('[crew] swms grant revoke error:', e.message);
    req.flash('error', 'Could not revoke grant.');
  }
  return req.session.save(() => res.redirect('/crew/' + member.id + '#swms-competencies'));
});

// POST /:id/delete — Delete Crew Member
router.post('/:id/delete', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) { req.flash('error', 'Crew member not found'); return req.session.save(() => res.redirect('/crew')); }

  // Check for linked records
  const allocations = db.prepare('SELECT COUNT(*) as count FROM crew_allocations WHERE crew_member_id = ?').get(req.params.id).count;
  const timesheets = db.prepare('SELECT COUNT(*) as count FROM timesheets WHERE crew_member_id = ?').get(req.params.id).count;
  if (allocations > 0 || timesheets > 0) {
    req.flash('error', `Cannot delete ${member.full_name} — they have ${allocations} allocation(s) and ${timesheets} timesheet(s). Deactivate instead.`);
    return req.session.save(() => res.redirect('/crew/' + member.id));
  }

  db.prepare('DELETE FROM crew_members WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'crew_member', entityId: member.id, entityLabel: member.full_name, details: 'Deleted crew member', ip: req.ip });
  req.flash('success', member.full_name + ' deleted.');
  req.session.save(() => res.redirect('/crew'));
});

// POST /:id/supervisor-approve — Toggle supervisor approval
router.post('/:id/supervisor-approve', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return req.session.save(() => res.redirect('/crew'));
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
  req.session.save(() => res.redirect('/crew/' + member.id));
});

// POST /:id/set-pin — Set or reset worker portal PIN
router.post('/:id/set-pin', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return req.session.save(() => res.redirect('/crew'));
  }

  const { pin } = req.body;

  // Validate PIN: 4-6 digits
  if (!pin || !/^\d{4,6}$/.test(pin)) {
    req.flash('error', 'PIN must be 4-6 digits.');
    return req.session.save(() => res.redirect('/crew/' + member.id));
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
  req.session.save(() => res.redirect('/crew/' + member.id));
});

// POST /:id/send-invite — Send email invitation for worker portal
router.post('/:id/send-invite', requireRole('admin', 'operations'), async (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return req.session.save(() => res.redirect('/crew'));
  }

  if (!member.email || !member.employee_id) {
    req.flash('error', 'Crew member needs both an email and Employee ID to receive an invite.');
    return req.session.save(() => res.redirect('/crew/' + member.id));
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
  req.session.save(() => res.redirect('/crew/' + member.id));
});

// POST /:id/clear-pin — Remove worker portal PIN
router.post('/:id/clear-pin', requireRole('admin', 'operations'), (req, res) => {
  const db = getDb();
  const member = db.prepare('SELECT * FROM crew_members WHERE id = ?').get(req.params.id);
  if (!member) {
    req.flash('error', 'Crew member not found');
    return req.session.save(() => res.redirect('/crew'));
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
  req.session.save(() => res.redirect('/crew/' + member.id));
});

module.exports = router;
