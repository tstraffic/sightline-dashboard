const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// GET / — List all checklist templates
router.get('/', (req, res) => {
  const db = getDb();
  const templates = db.prepare(`
    SELECT ct.*, u.full_name as creator_name,
      (SELECT COUNT(*) FROM checklist_template_items WHERE template_id = ct.id) as item_count
    FROM checklist_templates ct
    LEFT JOIN users u ON ct.created_by_id = u.id
    ORDER BY ct.sort_order ASC, ct.name ASC
  `).all();

  // Split into the three buckets the worker actually experiences:
  //   1. On-shift checklists — opened from a shift's Forms tab (the Job-Pack
  //      5 system templates + anything flagged "show on every shift").
  //   2. Always-available forms — the worker portal Forms tab (incidents,
  //      purchase orders, etc.). Live as soon as visible + published.
  //   3. Hidden & archived — drafts not yet visible to workers, and
  //      archived templates.
  const JOB_PACK = ['vehicle_prestart', 'risk_toolbox', 'tc_prestart', 'team_leader', 'post_shift_vehicle'];
  const groups = [
    { key: 'shift', title: 'On-shift checklists', desc: 'Filled in from a shift\'s Forms tab — the Job-Pack 5 plus anything marked "Show on every shift".', items: [] },
    { key: 'forms', title: 'Always-available forms', desc: 'The worker portal Forms tab — incidents, reports and requests workers can submit any time.', items: [] },
    { key: 'hidden', title: 'Hidden & archived', desc: 'Not visible to workers — drafts in progress and retired templates.', items: [] },
  ];
  templates.forEach(t => {
    if (t.status === 'archived' || !t.worker_visible) groups[2].items.push(t);
    else if (JOB_PACK.includes(t.system_key) || t.show_on_shift) groups[0].items.push(t);
    else groups[1].items.push(t);
  });

  res.render('checklists/index', {
    title: 'Forms & Checklists',
    currentPage: 'checklists',
    groups,
    user: req.session.user
  });
});

// GET /new — Create new template form
router.get('/new', (req, res) => {
  res.render('checklists/new', {
    title: 'New Checklist Template',
    currentPage: 'checklists',
    user: req.session.user
  });
});

// POST / — Save new template
router.post('/', (req, res) => {
  const db = getDb();
  const { name, description } = req.body;
  if (!name || !name.trim()) { req.flash('error', 'Template name is required.'); return req.session.save(() => res.redirect('/checklists/new')); }

  const result = db.prepare(`
    INSERT INTO checklist_templates (name, description, status, created_by_id)
    VALUES (?, ?, 'active', ?)
  `).run(name.trim(), description || '', req.session.user.id);

  logActivity({ user: req.session.user, action: 'create', entityType: 'checklist_template', entityId: result.lastInsertRowid, entityLabel: name.trim(), ip: req.ip });
  req.flash('success', `Template "${name.trim()}" created. Now add your questions.`);
  req.session.save(() => res.redirect(`/checklists/${result.lastInsertRowid}`));
});

// GET /:id — View/edit template + items
router.get('/:id', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!template) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/checklists')); }

  const items = db.prepare('SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY item_order ASC, id ASC').all(template.id);

  // Revision history + dirty state — "dirty" means the draft items have
  // changed since the last published snapshot, so the admin needs to
  // hit Publish for workers to see the change.
  let revisions = [];
  let dirty = false;
  let responseCount = 0;
  try {
    revisions = db.prepare(`
      SELECT r.*, u.full_name AS publisher_name
      FROM checklist_template_revisions r
      LEFT JOIN users u ON u.id = r.published_by_id
      WHERE r.template_id = ?
      ORDER BY r.revision_number DESC
    `).all(template.id);
    if (revisions.length > 0) {
      const latest = revisions[0];
      const liveItems = JSON.parse(latest.items_json || '[]');
      const draftSig = JSON.stringify(items.map(i => [i.item_order, i.section, i.question, i.response_type, i.required]));
      const liveSig  = JSON.stringify((liveItems || []).map(i => [i.item_order, i.section, i.question, i.response_type, i.required]));
      dirty = (draftSig !== liveSig)
        || (latest.name !== template.name)
        || ((latest.description || '') !== (template.description || ''))
        || (!!latest.require_signature !== !!template.require_signature)
        || (!!latest.require_photo !== !!template.require_photo);
    } else {
      dirty = items.length > 0; // never published — dirty as soon as there's content
    }
    responseCount = db.prepare('SELECT COUNT(*) AS c FROM custom_checklist_responses WHERE template_id = ?').get(template.id).c;
  } catch (e) { /* legacy DB before mig 150 */ }

  res.render('checklists/show', {
    title: `Template: ${template.name}`,
    currentPage: 'checklists',
    template, items, revisions, dirty, responseCount,
    elementTypes: ELEMENT_TYPES,
    user: req.session.user
  });
});

// POST /:id/visibility — toggle worker_visible + signature/photo flags.
router.post('/:id/visibility', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT id, name FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!tpl) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/checklists')); }
  const visible = req.body.worker_visible === '1' || req.body.worker_visible === 'on' ? 1 : 0;
  const sig = req.body.require_signature === '1' || req.body.require_signature === 'on' ? 1 : 0;
  const photo = req.body.require_photo === '1' || req.body.require_photo === 'on' ? 1 : 0;
  const onShift = req.body.show_on_shift === '1' || req.body.show_on_shift === 'on' ? 1 : 0;
  db.prepare(`UPDATE checklist_templates SET worker_visible = ?, require_signature = ?, require_photo = ?, show_on_shift = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(visible, sig, photo, onShift, req.params.id);
  logActivity({ user: req.session.user, action: 'update', entityType: 'checklist_template', entityId: tpl.id, entityLabel: tpl.name, details: `Visibility: worker_visible=${visible}, sig=${sig}, photo=${photo}, show_on_shift=${onShift}`, ip: req.ip });
  req.flash('success', visible ? 'Template will be visible to workers once published.' : 'Template hidden from workers.');
  req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
});

// POST /:id/publish — snapshot current draft as a new revision so workers
// can fill it in. Workers always see the latest published revision.
router.post('/:id/publish', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!tpl) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/checklists')); }
  const items = db.prepare('SELECT * FROM checklist_template_items WHERE template_id = ? ORDER BY item_order ASC, id ASC').all(tpl.id);
  if (items.length === 0) { req.flash('error', 'Add at least one question before publishing.'); return req.session.save(() => res.redirect(`/checklists/${tpl.id}`)); }

  const next = (db.prepare('SELECT MAX(revision_number) AS m FROM checklist_template_revisions WHERE template_id = ?').get(tpl.id).m || 0) + 1;
  db.prepare(`
    INSERT INTO checklist_template_revisions (template_id, revision_number, name, description, require_signature, require_photo, items_json, published_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(tpl.id, next, tpl.name, tpl.description || '',
         tpl.require_signature ? 1 : 0, tpl.require_photo ? 1 : 0,
         JSON.stringify(items), req.session.user.id);
  db.prepare(`UPDATE checklist_templates SET published_revision = ?, published_at = datetime('now'), published_by_id = ? WHERE id = ?`)
    .run(next, req.session.user.id, tpl.id);

  logActivity({ user: req.session.user, action: 'publish', entityType: 'checklist_template', entityId: tpl.id, entityLabel: tpl.name, details: `Published revision ${next} (${items.length} questions)`, ip: req.ip });
  req.flash('success', `Revision ${next} published. Workers can now fill in the latest version.`);
  req.session.save(() => res.redirect(`/checklists/${tpl.id}`));
});

// POST /:id — Update template details
router.post('/:id', (req, res) => {
  const db = getDb();
  const { name, description } = req.body;
  db.prepare('UPDATE checklist_templates SET name = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(name || '', description || '', req.params.id);
  req.flash('success', 'Template updated.');
  req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
});

// Allow-list of element types. Grouped here for the show view's
// Display / Inputs / Special picker; each entry knows its category +
// human label so the EJS doesn't have to repeat itself.
const ELEMENT_TYPES = {
  // Display — read-only blocks the worker can see but doesn't fill in
  heading:        { category: 'display', label: 'Heading' },
  information:    { category: 'display', label: 'Information' },
  hyperlink:      { category: 'display', label: 'Hyperlink' },
  media:          { category: 'display', label: 'Media' },
  // Inputs — the worker fills these in
  text:           { category: 'input',   label: 'Question' },
  textarea:       { category: 'input',   label: 'Long question' },
  number:         { category: 'input',   label: 'Number' },
  datetime:       { category: 'input',   label: 'Date / Time' },
  measurement:    { category: 'input',   label: 'Measurement' },
  // Special — richer worker inputs
  checklist:      { category: 'special', label: 'Checklist (OK / Yes / Pass)' },
  ok_notok_na:    { category: 'special', label: 'OK / Not OK / N/A' },
  yes_no_na:      { category: 'special', label: 'Yes / No / N/A' },
  pass_fail:      { category: 'special', label: 'Pass / Fail' },
  multiple_choice:{ category: 'special', label: 'Multiple choice' },
  radio:          { category: 'special', label: 'Single choice' },
  checkbox:       { category: 'special', label: 'Multi-select' },
  media_upload:   { category: 'special', label: 'Media upload' },
  signature:      { category: 'special', label: 'Signature' },
};
const VALID_TYPES = Object.keys(ELEMENT_TYPES);

// Pull element-specific config fields off the body and serialise to
// options_json so each element can carry the bits it needs (URL for
// hyperlink, unit for measurement, options for multiple choice, etc.).
function buildOptionsJson(body, rType) {
  const opts = {};
  if (rType === 'hyperlink' || rType === 'media') {
    if (body.opt_url) opts.url = String(body.opt_url).trim();
    if (body.opt_alt) opts.alt = String(body.opt_alt).trim();
  }
  if (rType === 'measurement') {
    if (body.opt_unit) opts.unit = String(body.opt_unit).trim();
  }
  if (rType === 'checklist') {
    const scheme = body.opt_scheme;
    opts.scheme = ['ok_notok_na','yes_no_na','pass_fail'].includes(scheme) ? scheme : 'ok_notok_na';
  }
  if (rType === 'multiple_choice') {
    const raw = String(body.opt_options || '').trim();
    opts.options = raw ? raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : [];
    opts.multi   = body.opt_multi === '1' || body.opt_multi === 'on';
  }
  if (rType === 'information') {
    if (body.opt_body) opts.body = String(body.opt_body);
  }
  return Object.keys(opts).length > 0 ? JSON.stringify(opts) : null;
}

// POST /:id/items — Add item
router.post('/:id/items', (req, res) => {
  const db = getDb();
  const { question, response_type, section, required } = req.body;

  const rType = VALID_TYPES.includes(response_type) ? response_type : 'text';
  // Display elements (heading/info/hyperlink/media) don't need a
  // "question" — but every row needs SOME label string. For those we
  // accept the question field as the heading/link text/alt; for inputs
  // it's still required as the question text.
  const isDisplay = ELEMENT_TYPES[rType] && ELEMENT_TYPES[rType].category === 'display';
  if (!question || !question.trim()) {
    if (!isDisplay || rType === 'heading' || rType === 'hyperlink') {
      req.flash('error', 'Title / question text is required.');
      return req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
    }
  }

  const optionsJson = buildOptionsJson(req.body, rType);
  const itemKey = (req.body.item_key || '').trim() || null;

  const maxOrder = db.prepare('SELECT MAX(item_order) as mx FROM checklist_template_items WHERE template_id = ?').get(req.params.id);
  const nextOrder = (maxOrder && maxOrder.mx != null) ? maxOrder.mx + 1 : 0;

  db.prepare(`
    INSERT INTO checklist_template_items (template_id, item_order, section, item_key, question, response_type, required, options_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, nextOrder, section || '', itemKey, (question || '').trim(), rType, required ? 1 : 0, optionsJson);

  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  req.flash('success', `${ELEMENT_TYPES[rType].label} added.`);
  req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
});

// POST /:id/items/bulk — Apply a single change (response_type / required /
// section) to a set of items in one transaction. Lets admin retype a
// pile of questions (e.g. flip 22 vehicle inspection rows from
// yes_no_na to ok_notok_na) without touching each one.
//
// MUST be declared BEFORE the /:id/items/:itemId catch-all below — if
// the routes were the other way round Express would match /items/bulk
// against /items/:itemId with itemId="bulk", run an UPDATE WHERE
// id = 'bulk' (matches nothing), and silently do nothing.
router.post('/:id/items/bulk', (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.map(n => parseInt(n, 10)).filter(n => !isNaN(n));
  if (ids.length === 0) {
    req.flash('error', 'Pick at least one question.');
    return req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
  }

  const newType = req.body.response_type && VALID_TYPES.includes(req.body.response_type) ? req.body.response_type : null;
  const newReq  = req.body.required === '1' ? 1 : req.body.required === '0' ? 0 : null;
  const newSec  = (req.body.section || '').trim();
  const setSec  = newSec.length > 0;

  if (!newType && newReq === null && !setSec) {
    req.flash('error', 'Pick at least one field to change.');
    return req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
  }

  const setParts = [];
  const setVals  = [];
  if (newType)         { setParts.push('response_type = ?'); setVals.push(newType); }
  if (newReq !== null) { setParts.push('required = ?');      setVals.push(newReq); }
  if (setSec)          { setParts.push('section = ?');       setVals.push(newSec); }

  // One UPDATE per id keeps the WHERE bound + parameterised cleanly.
  const upd = db.prepare(`
    UPDATE checklist_template_items
    SET ${setParts.join(', ')}
    WHERE id = ? AND template_id = ?
  `);
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const r = upd.run(...setVals, id, req.params.id);
      if (r.changes > 0) n++;
    }
  });
  tx();

  if (n > 0) {
    db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    const bits = [];
    if (newType)         bits.push(`type → ${newType}`);
    if (newReq !== null) bits.push(`required → ${newReq ? 'yes' : 'no'}`);
    if (setSec)          bits.push(`section → ${newSec}`);
    logActivity({ user: req.session.user, action: 'update', entityType: 'checklist_template_items', entityId: req.params.id, details: `Bulk update ${n} items: ${bits.join('; ')}`, ip: req.ip });
  }
  req.flash('success', `Updated ${n} question${n === 1 ? '' : 's'}.`);
  req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
});

// POST /:id/items/:itemId — Update a single item. Declared after /items/bulk
// so /items/bulk doesn't get hijacked by this catch-all route.
router.post('/:id/items/:itemId', (req, res) => {
  const db = getDb();
  const { question, response_type, section, required } = req.body;
  const rType = VALID_TYPES.includes(response_type) ? response_type : 'text';
  const optionsJson = buildOptionsJson(req.body, rType);

  db.prepare('UPDATE checklist_template_items SET question = ?, response_type = ?, section = ?, required = ?, options_json = ? WHERE id = ? AND template_id = ?')
    .run(question || '', rType, section || '', required ? 1 : 0, optionsJson, req.params.itemId, req.params.id);

  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  req.flash('success', 'Element updated.');
  req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
});

// POST /:id/items/:itemId/delete — Remove item
router.post('/:id/items/:itemId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM checklist_template_items WHERE id = ? AND template_id = ?').run(req.params.itemId, req.params.id);
  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  req.flash('success', 'Question removed.');
  req.session.save(() => res.redirect(`/checklists/${req.params.id}`));
});

// POST /:id/reorder — Reorder items (AJAX). Accepts either:
//   { order: [id, id, ...] }                          — legacy, order only
//   { items: [{ id, section }, { id, section }, ...] } — new, order + section
// The richer form lets the drag-and-drop UI move items between sections
// in the same gesture (dropping a row under a different section header
// updates both item_order AND section in one transaction).
router.post('/:id/reorder', express.json(), (req, res) => {
  const db = getDb();
  const items = Array.isArray(req.body.items) ? req.body.items : null;
  const order = Array.isArray(req.body.order) ? req.body.order : null;
  if (!items && !order) return res.json({ success: false });

  const stmtBoth = db.prepare('UPDATE checklist_template_items SET item_order = ?, section = ? WHERE id = ? AND template_id = ?');
  const stmtOrd  = db.prepare('UPDATE checklist_template_items SET item_order = ? WHERE id = ? AND template_id = ?');
  const tx = db.transaction(() => {
    if (items) {
      items.forEach((it, idx) => {
        const id = parseInt(it && it.id, 10);
        if (isNaN(id)) return;
        stmtBoth.run(idx, (it.section || ''), id, req.params.id);
      });
    } else {
      order.forEach((id, idx) => { stmtOrd.run(idx, id, req.params.id); });
    }
  });
  tx();
  db.prepare('UPDATE checklist_templates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// POST /:id/archive — Toggle archive/active. System templates can't be
// archived because the worker portal Job-Pack flow depends on them
// resolving to a published revision.
router.post('/:id/archive', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT status, system_key FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!template) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/checklists')); }
  if (template.system_key) {
    req.flash('error', 'System templates can\'t be archived — they power the worker portal Job-Pack.');
    return req.session.save(() => res.redirect('/checklists'));
  }

  const newStatus = template.status === 'archived' ? 'active' : 'archived';
  db.prepare('UPDATE checklist_templates SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);
  req.flash('success', `Template ${newStatus === 'archived' ? 'archived' : 'reactivated'}.`);
  req.session.save(() => res.redirect('/checklists'));
});

// ============================================================
// Responses — what workers actually submitted against a template.
// Answers are rendered against the revision the worker filled in
// (not the current draft), so edits never reinterpret old data.
// ============================================================

// GET /:id/responses — list a template's submissions
router.get('/:id/responses', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!template) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/checklists')); }
  let responses = [];
  try {
    responses = db.prepare(`
      SELECT r.id, r.revision_number, r.submitted_at, r.allocation_id, r.booking_id,
             r.signature_data IS NOT NULL AND r.signature_data != '' AS has_signature,
             cm.full_name AS worker_name,
             b.booking_number,
             (SELECT COUNT(*) FROM custom_checklist_response_photos p WHERE p.response_id = r.id) AS photo_count
      FROM custom_checklist_responses r
      LEFT JOIN crew_members cm ON cm.id = r.crew_member_id
      LEFT JOIN bookings b ON b.id = r.booking_id
      WHERE r.template_id = ?
      ORDER BY r.submitted_at DESC
      LIMIT 500
    `).all(template.id);
  } catch (e) { /* photos table predates migration 265 */ }
  res.render('checklists/responses', {
    title: `Responses: ${template.name}`,
    currentPage: 'checklists',
    template, responses,
    user: req.session.user,
  });
});

// GET /:id/responses/:responseId — one submission, answers matched to the
// questions of the revision it was filled against.
router.get('/:id/responses/:responseId', (req, res) => {
  const db = getDb();
  const template = db.prepare('SELECT * FROM checklist_templates WHERE id = ?').get(req.params.id);
  if (!template) { req.flash('error', 'Template not found.'); return req.session.save(() => res.redirect('/checklists')); }
  const response = db.prepare(`
    SELECT r.*, cm.full_name AS worker_name, b.booking_number
    FROM custom_checklist_responses r
    LEFT JOIN crew_members cm ON cm.id = r.crew_member_id
    LEFT JOIN bookings b ON b.id = r.booking_id
    WHERE r.id = ? AND r.template_id = ?
  `).get(req.params.responseId, template.id);
  if (!response) { req.flash('error', 'Response not found.'); return req.session.save(() => res.redirect(`/checklists/${template.id}/responses`)); }

  const rev = db.prepare('SELECT * FROM checklist_template_revisions WHERE template_id = ? AND revision_number = ?')
    .get(template.id, response.revision_number);
  let items = [];
  try { items = JSON.parse((rev && rev.items_json) || '[]'); } catch (e) { items = []; }
  let answers = {};
  try { answers = JSON.parse(response.answers_json || '{}'); } catch (e) { answers = {}; }
  let photos = [];
  try { photos = db.prepare('SELECT * FROM custom_checklist_response_photos WHERE response_id = ?').all(response.id); } catch (e) {}

  // Group by section, attaching each item's answer + photos.
  const sections = [];
  const byKey = {};
  items.forEach(it => {
    const a = answers[String(it.id)];
    const row = {
      ...it,
      answer: Array.isArray(a) ? a.join(', ') : a,
      photos: photos.filter(p => String(p.item_id) === String(it.id)),
    };
    const key = it.section || '';
    if (!byKey[key]) { byKey[key] = { name: key, items: [] }; sections.push(byKey[key]); }
    byKey[key].items.push(row);
  });

  res.render('checklists/response-detail', {
    title: `${template.name} — ${response.worker_name || 'response'}`,
    currentPage: 'checklists',
    template, response, sections,
    user: req.session.user,
  });
});

// GET /response-photos/:photoId — stream a response photo (admin side).
router.get('/response-photos/:photoId', (req, res) => {
  const db = getDb();
  const path = require('path');
  const fs = require('fs');
  let photo = null;
  try { photo = db.prepare('SELECT * FROM custom_checklist_response_photos WHERE id = ?').get(req.params.photoId); } catch (e) {}
  if (!photo) return res.status(404).send('Not found');
  const abs = path.join(__dirname, '..', photo.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('Not found');
  res.type(photo.mime_type || 'image/jpeg');
  fs.createReadStream(abs).pipe(res);
});

module.exports = router;
