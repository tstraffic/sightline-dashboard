// VOC Templates admin — edit the theory questions + practical checklist
// + default validity period per equipment item. Gated to admin-only via
// requirePermission('voc_admin') at the mount point in server.js.
//
// Templates are seeded empty by Migration 213; admins fill them via the
// edit form. The voc_assessments flow renders the current template
// content at the moment a new assessment is created (snapshot-on-submit
// happens via responses_json, not by referencing the live template).

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s || '[]'); } catch (e) { return fallback; }
}

router.get('/', (req, res) => {
  const db = getDb();
  const templates = db.prepare(`
    SELECT id, item_key, name, sort_order, default_validity_months,
      theory_questions_json, practical_checklist_json, active, updated_at
    FROM voc_templates
    ORDER BY sort_order ASC, id ASC
  `).all().map(t => {
    const theory = safeJsonParse(t.theory_questions_json, []);
    const practical = safeJsonParse(t.practical_checklist_json, []);
    return {
      ...t,
      theory_count: Array.isArray(theory) ? theory.length : 0,
      practical_count: Array.isArray(practical)
        ? practical.reduce((n, s) => n + (Array.isArray(s.items) ? s.items.length : 0), 0)
        : 0,
    };
  });
  res.render('voc-templates/index', {
    title: 'VOC Templates',
    templates,
    user: req.session.user,
    currentPage: 'voc-templates',
  });
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM voc_templates WHERE id = ?').get(req.params.id);
  if (!tpl) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/voc-templates')); }
  res.render('voc-templates/form', {
    title: `Edit ${tpl.name}`,
    template: tpl,
    theory: safeJsonParse(tpl.theory_questions_json, []),
    practical: safeJsonParse(tpl.practical_checklist_json, []),
    user: req.session.user,
    currentPage: 'voc-templates',
  });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT id FROM voc_templates WHERE id = ?').get(req.params.id);
  if (!tpl) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/voc-templates')); }
  const b = req.body;

  const arr = (v) => v == null ? [] : (Array.isArray(v) ? v : [v]);
  // Theory: parallel array of question strings, drop blanks.
  const theory = arr(b.theory_q).map(s => (s || '').trim()).filter(Boolean);

  // Practical: parallel arrays for section heading + per-section items.
  // The form ships items as `prac_item_<sectionIdx>` parallel arrays,
  // and `prac_section[]` for headings. Walk by index, drop blanks.
  const sectionHeadings = arr(b.prac_section).map(s => (s || '').trim());
  const practical = [];
  sectionHeadings.forEach((heading, idx) => {
    const items = arr(b['prac_item_' + idx]).map(s => (s || '').trim()).filter(Boolean);
    if (!heading.trim() && items.length === 0) return;
    practical.push({ section: heading || ('Section ' + String.fromCharCode(65 + idx)), items });
  });

  let validity = parseInt(b.default_validity_months, 10);
  if (!Number.isFinite(validity) || validity <= 0 || validity > 120) validity = 24;

  try {
    db.prepare(`
      UPDATE voc_templates
      SET theory_questions_json = ?, practical_checklist_json = ?,
          default_validity_months = ?, updated_at = CURRENT_TIMESTAMP, updated_by_id = ?
      WHERE id = ?
    `).run(JSON.stringify(theory), JSON.stringify(practical), validity,
           req.session.user.id, req.params.id);
    req.flash('success', 'Template saved.');
  } catch (err) {
    console.error('[voc-templates] update error:', err);
    req.flash('error', 'Failed to save: ' + err.message);
  }
  req.session.save(() => res.redirect(`/voc-templates/${req.params.id}/edit`));
});

module.exports = router;
