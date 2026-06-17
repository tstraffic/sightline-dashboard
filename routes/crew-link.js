// routes/crew-link.js — admin tool to link crew_members to their HR employee
// profiles (employees.linked_crew_member_id). This is the bridge per-person
// audit tagging relies on; unlinked crew can't be tagged into HR Reviews.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { linkCoverageReport } = require('../lib/auditCrew');

function load(db) {
  const coverage = linkCoverageReport(db);
  const unlinkedCrew = db.prepare(`
    SELECT cm.id, cm.full_name, cm.employee_id AS code, cm.role
    FROM crew_members cm
    WHERE cm.active = 1 AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.linked_crew_member_id = cm.id)
    ORDER BY cm.full_name
  `).all();
  const freeEmployees = db.prepare("SELECT id, full_name, employee_code FROM employees WHERE active = 1 AND linked_crew_member_id IS NULL ORDER BY full_name").all();
  const byName = {};
  freeEmployees.forEach(e => { byName[(e.full_name || '').toLowerCase()] = e; });
  unlinkedCrew.forEach(c => { c.suggest = byName[(c.full_name || '').toLowerCase()] || null; });
  return { coverage, unlinkedCrew, freeEmployees };
}

router.get('/', (req, res) => {
  const db = getDb();
  const data = load(db);
  res.render('crew-link/index', { title: 'Crew ↔ HR Linking', currentPage: 'crew-link', ...data, user: req.session.user });
});

// Link one crew member to a chosen employee
router.post('/:crewId/link', (req, res) => {
  const db = getDb();
  const crewId = parseInt(req.params.crewId, 10);
  const employeeId = parseInt(req.body.employee_id, 10);
  if (crewId && employeeId) {
    db.transaction(() => {
      db.prepare('UPDATE employees SET linked_crew_member_id = NULL WHERE linked_crew_member_id = ?').run(crewId); // clear any stale link
      db.prepare('UPDATE employees SET linked_crew_member_id = ? WHERE id = ?').run(crewId, employeeId);
    })();
    req.flash('success', 'Linked.');
  }
  res.redirect('/crew-link');
});

router.post('/:crewId/unlink', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE employees SET linked_crew_member_id = NULL WHERE linked_crew_member_id = ?').run(parseInt(req.params.crewId, 10));
  req.flash('success', 'Unlinked.');
  res.redirect('/crew-link');
});

// Bulk: link every unlinked crew member that has an exact-name free employee
router.post('/auto-link', (req, res) => {
  const db = getDb();
  const { unlinkedCrew } = load(db);
  let n = 0;
  const upd = db.prepare('UPDATE employees SET linked_crew_member_id = ? WHERE id = ?');
  db.transaction(() => {
    for (const c of unlinkedCrew) { if (c.suggest) { upd.run(c.id, c.suggest.id); n++; } }
  })();
  req.flash('success', n + ' crew member(s) auto-linked by exact name match.');
  res.redirect('/crew-link');
});

module.exports = router;
