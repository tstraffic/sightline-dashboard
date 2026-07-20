// Admin: per-role permission overrides
//
// Surfaces the PERMISSIONS map as a matrix (modules x roles) so an admin
// can toggle individual cells without redeploying. Writes land in the
// role_permissions table (migration 253); canAccess() consults that
// table before falling back to the hardcoded defaults.
//
// Admin column is read-only — admin always has access; locking admin
// out by accident would brick the system.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireRole, PERMISSIONS, refreshRolePermissionOverrides } = require('../middleware/auth');
const { logActivity } = require('../middleware/audit');

router.use(requireRole('admin'));

// Roles surfaced in the matrix. Admin is locked-on, so it's shown but the
// checkbox is disabled. Sales is retired but kept in the list so an admin
// can still un-restrict legacy sales-role users if needed.
const ROLES = ['admin', 'operations', 'planning', 'safety', 'hr', 'finance', 'management', 'marketing', 'accounts'];

// Human-friendly section grouping for the UI. Keys must match keys in
// PERMISSIONS exactly; modules not listed here drop into "Other".
const MODULE_GROUPS = [
  { label: 'Core', items: ['dashboard', 'notes', 'jobs', 'projects', 'clients', 'notifications', 'tenders', 'quoting'] },
  { label: 'Operations', items: ['tasks', 'incidents', 'contacts', 'timesheets', 'crew', 'allocations', 'traffio_imports', 'schedule', 'equipment', 'fleet', 'defects', 'documents', 'bookings', 'reports', 'exports'] },
  { label: 'Planning', items: ['compliance', 'plans', 'updates', 'planning_plans', 'planning_diary', 'planning_chat'] },
  { label: 'Operations job tabs', items: ['ops_final_plans', 'ops_tasks', 'ops_timesheets', 'ops_incidents', 'ops_flag'] },
  { label: 'Safety', items: ['audits', 'checklists', 'swms', 'sop_register', 'safety_updates', 'toolbox_talks', 'safety_comments', 'safety_quizzes', 'safety_workshops', 'safety_reports', 'risk_assessments', 'voc', 'voc_admin'] },
  { label: 'Induction', items: ['induction'] },
  { label: 'HR', items: ['hr_dashboard', 'hr_employees', 'leave_approvals', 'hr_documents', 'hr_competencies', 'hr_reports', 'hr_settings', 'hr_compliance_view'] },
  { label: 'Finance', items: ['finance', 'payroll', 'invoicing', 'payslips', 'abergeldie_payments', 'budgets'] },
  { label: 'Marketing & CRM', items: ['crm', 'marketing'] },
  { label: 'Admin tools', items: ['admin', 'activity', 'settings'] },
];

function buildMatrix(db) {
  const overrides = db.prepare('SELECT role, permission, allowed FROM role_permissions').all();
  const overrideMap = new Map(); // key = `${role}::${permission}` -> boolean
  overrides.forEach(o => overrideMap.set(`${o.role}::${o.permission}`, !!o.allowed));

  // Collect every permission key, retaining group order; modules not in a
  // group are appended to "Other".
  const seen = new Set();
  const groups = MODULE_GROUPS.map(g => ({
    label: g.label,
    items: g.items.filter(k => {
      if (!PERMISSIONS[k]) return false;
      seen.add(k);
      return true;
    }),
  })).filter(g => g.items.length);
  const other = Object.keys(PERMISSIONS).filter(k => !seen.has(k));
  if (other.length) groups.push({ label: 'Other', items: other });

  // Effective state per (role, module): override wins; otherwise default map.
  function effective(role, module) {
    const key = `${role}::${module}`;
    if (overrideMap.has(key)) return overrideMap.get(key);
    const defaults = PERMISSIONS[module] || [];
    return defaults.includes(role);
  }
  function isOverridden(role, module) {
    return overrideMap.has(`${role}::${module}`);
  }

  return { groups, effective, isOverridden };
}

// GET /admin/permissions — matrix view
router.get('/permissions', (req, res) => {
  const db = getDb();
  const { groups, effective, isOverridden } = buildMatrix(db);
  res.render('admin/permissions', {
    title: 'Role Permissions',
    currentPage: 'admin-permissions',
    roles: ROLES,
    groups,
    effective,
    isOverridden,
    permissionsMap: PERMISSIONS,
  });
});

// POST /admin/permissions — save. Body shape: cells[role][module] = '1' for
// checked. A cell that matches the hardcoded default is removed from the
// override table; only "deviating" cells persist. Admin column is ignored.
router.post('/permissions', (req, res) => {
  const db = getDb();
  const cells = req.body.cells && typeof req.body.cells === 'object' ? req.body.cells : {};

  const upsert = db.prepare(`
    INSERT INTO role_permissions (role, permission, allowed, updated_at, updated_by_id)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(role, permission) DO UPDATE SET allowed = excluded.allowed, updated_at = CURRENT_TIMESTAMP, updated_by_id = excluded.updated_by_id
  `);
  const deleteRow = db.prepare('DELETE FROM role_permissions WHERE role = ? AND permission = ?');

  let writes = 0, deletes = 0;
  const tx = db.transaction(() => {
    for (const role of ROLES) {
      if (role === 'admin') continue; // admin always-on
      const roleCells = cells[role] && typeof cells[role] === 'object' ? cells[role] : {};
      for (const module of Object.keys(PERMISSIONS)) {
        const checked = !!roleCells[module];
        const defaultAllowed = PERMISSIONS[module].includes(role);
        if (checked === defaultAllowed) {
          // Matches the hardcoded default — drop any override row so we don't
          // accumulate dead rows.
          const r = deleteRow.run(role, module);
          if (r.changes) deletes++;
        } else {
          upsert.run(role, module, checked ? 1 : 0, req.session.user.id);
          writes++;
        }
      }
    }
  });
  tx();

  refreshRolePermissionOverrides();
  logActivity({ user: req.session.user, action: 'update', entityType: 'role_permissions', entityId: 0, entityLabel: `Saved role permissions (${writes} overrides, ${deletes} reverted to default)`, req });
  req.flash('success', `Saved · ${writes} override${writes === 1 ? '' : 's'} active, ${deletes} reverted to default.`);
  req.session.save(() => res.redirect('/admin/permissions'));
});

// POST /admin/permissions/reset — wipe all overrides, back to PERMISSIONS map
router.post('/permissions/reset', (req, res) => {
  const db = getDb();
  const r = db.prepare('DELETE FROM role_permissions').run();
  refreshRolePermissionOverrides();
  logActivity({ user: req.session.user, action: 'delete', entityType: 'role_permissions', entityId: 0, entityLabel: `Reset all role permissions (${r.changes} overrides removed)`, req });
  req.flash('success', `Reset · ${r.changes} override${r.changes === 1 ? '' : 's'} cleared.`);
  req.session.save(() => res.redirect('/admin/permissions'));
});

module.exports = router;
