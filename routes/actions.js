// routes/actions.js — central cross-audit / cross-incident open-actions register.
// Every corrective action (whether sourced from an audit "No", a per-person tag,
// or an incident) lands here so open items aren't trapped inside one record.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { closeAuditAction } = require('../lib/auditActions');
const { sydneyToday } = require('../lib/sydney');

router.get('/', (req, res) => {
  const db = getDb();
  const today = sydneyToday();
  const f = req.query || {};

  let where = '1=1';
  const params = [];
  // Default to the open register; allow ?status=all or a specific status
  if (f.status === 'all') { /* no status filter */ }
  else if (f.status) { where += ' AND ca.status = ?'; params.push(f.status); }
  else { where += " AND ca.status NOT IN ('completed','cancelled')"; }
  if (f.source) { where += ' AND ca.source_type = ?'; params.push(f.source); }
  if (f.risk) { where += ' AND ca.risk_level = ?'; params.push(f.risk); }
  if (f.job_id) { where += ' AND ca.job_id = ?'; params.push(f.job_id); }
  if (f.owner_id) { where += ' AND ca.assigned_to_id = ?'; params.push(f.owner_id); }
  if (f.overdue === '1') { where += " AND ca.due_date IS NOT NULL AND ca.due_date < ? AND ca.status NOT IN ('completed','cancelled')"; params.push(today); }

  const actions = db.prepare(`
    SELECT ca.*, j.job_number, sa.id AS audit_id, sa.project_site AS audit_site,
           i.incident_number, u.full_name AS assigned_name,
           emp.full_name AS involved_emp_name, cm.full_name AS involved_crew_name
    FROM corrective_actions ca
    LEFT JOIN jobs j ON ca.job_id = j.id
    LEFT JOIN site_audits sa ON ca.source_audit_id = sa.id
    LEFT JOIN incidents i ON ca.incident_id = i.id
    LEFT JOIN users u ON ca.assigned_to_id = u.id
    LEFT JOIN employees emp ON ca.involved_employee_id = emp.id
    LEFT JOIN crew_members cm ON ca.involved_crew_member_id = cm.id
    WHERE ${where}
    ORDER BY (ca.status NOT IN ('completed','cancelled')) DESC,
             CASE ca.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             (ca.due_date IS NULL), ca.due_date ASC, ca.id DESC
  `).all(...params);

  const allOpen = db.prepare("SELECT priority, due_date, source_type FROM corrective_actions WHERE status NOT IN ('completed','cancelled')").all();
  const stats = {
    open: allOpen.length,
    overdue: allOpen.filter(a => a.due_date && a.due_date < today).length,
    critical: allOpen.filter(a => a.priority === 'critical').length,
    fromAudits: allOpen.filter(a => a.source_type === 'audit').length,
  };
  const jobs = db.prepare("SELECT id, job_number FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('actions/index', {
    title: 'Open Actions', currentPage: 'actions',
    actions, stats, jobs, filters: f, today, user: req.session.user,
  });
});

router.post('/:id/close', (req, res) => {
  const db = getDb();
  closeAuditAction(db, req.params.id, { closedById: req.session.user.id, verificationNote: (req.body.verification || '').trim() });
  req.flash('success', 'Action closed.');
  res.redirect(req.body.return_to || '/actions');
});

router.post('/:id/reopen', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE corrective_actions SET status='open', completed_date=NULL, closed_at=NULL, closed_by_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.params.id);
  req.flash('success', 'Action re-opened.');
  res.redirect(req.body.return_to || '/actions');
});

module.exports = router;
