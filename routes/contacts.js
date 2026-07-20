const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// ============================================
// CONTACTS LIST
// ============================================
router.get('/', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('cc.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.contact_type) { where.push('cc.contact_type = ?'); params.push(req.query.contact_type); }
  if (req.query.search) {
    where.push("(cc.full_name LIKE ? OR cc.company LIKE ? OR cc.email LIKE ?)");
    const s = `%${req.query.search}%`;
    params.push(s, s, s);
  }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const contacts = db.prepare(`
    SELECT cc.*, j.job_number, j.client, cl2.company_name as linked_company_name,
      (SELECT COUNT(*) FROM communication_log cl WHERE cl.contact_id = cc.id) as comms_count,
      (SELECT MAX(cl3.comm_date) FROM communication_log cl3 WHERE cl3.contact_id = cc.id) as last_contact_date
    FROM client_contacts cc
    LEFT JOIN jobs j ON cc.job_id = j.id
    LEFT JOIN clients cl2 ON cc.company_id = cl2.id
    ${whereClause}
    ORDER BY cc.company, cc.full_name
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('contacts/index', {
    title: 'Client Contacts',
    currentPage: 'contacts',
    contacts,
    jobs,
    filters: req.query
  });
});

// ============================================
// NEW CONTACT FORM
// ============================================
router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs ORDER BY job_number DESC").all();
  const companies = db.prepare("SELECT id, company_name, company_type FROM clients WHERE active = 1 ORDER BY company_name").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('contacts/form', {
    title: 'New Contact',
    currentPage: 'contacts',
    contact: null,
    jobs,
    companies,
    users,
    preselectedJobId: req.query.job_id || '',
    preselectedCompanyId: req.query.company_id || ''
  });
});

// ============================================
// CREATE CONTACT
// ============================================
router.post('/', (req, res) => {
  const db = getDb();
  const { job_id, company_id, contact_type, company, full_name, position, phone, mobile, email, notes, is_primary,
    relationship_strength, influence_level, buying_role, preferred_comm_method, referred_by, contact_owner_id } = req.body;
  const result = db.prepare(`
    INSERT INTO client_contacts (job_id, company_id, contact_type, company, full_name, position, phone, mobile, email, notes, is_primary,
      relationship_strength, influence_level, buying_role, preferred_comm_method, referred_by, contact_owner_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(job_id || null, company_id || null, contact_type, company, full_name, position || '', phone || '', mobile || '', email || '', notes || '', is_primary ? 1 : 0,
    relationship_strength || '', influence_level || '', buying_role || '', preferred_comm_method || '', referred_by || '', contact_owner_id || null);

  logActivity({
    user: req.session.user,
    action: 'create',
    entityType: 'contact',
    entityId: result.lastInsertRowid,
    entityLabel: `${full_name} (${company})`,
    jobId: job_id ? parseInt(job_id) : null,
    ip: req.ip
  });

  req.flash('success', `Contact ${full_name} added.`);
  req.session.save(() => res.redirect('/contacts'));
});

// ============================================
// QUICK-CREATE CONTACT (JSON) — used by the booking form's
// "+ Add contact" button. Creates a contact tied to a client
// company and returns it so the caller can select it inline.
// ============================================
router.post('/api/quick-create', (req, res) => {
  try {
    const db = getDb();
    const company_id = parseInt(req.body.company_id, 10);
    const full_name = (req.body.full_name || '').trim();
    const position = (req.body.position || '').trim();
    const phone = (req.body.phone || '').trim();
    const email = (req.body.email || '').trim();

    if (!company_id) return res.status(400).json({ error: 'Select a client before adding a contact.' });
    if (!full_name) return res.status(400).json({ error: 'Contact name is required.' });

    const company = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(company_id);
    if (!company) return res.status(400).json({ error: 'That client no longer exists.' });

    const result = db.prepare(`
      INSERT INTO client_contacts (company_id, contact_type, company, full_name, position, phone, email)
      VALUES (?, 'client', ?, ?, ?, ?, ?)
    `).run(company_id, company.company_name, full_name, position, phone, email);

    const id = result.lastInsertRowid;

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'contact',
      entityId: id,
      entityLabel: `${full_name} (${company.company_name})`,
      ip: req.ip
    });

    res.json({ success: true, contact: { id, full_name, position, phone, email, company_id } });
  } catch (err) {
    console.error('Contact quick-create error:', err);
    res.status(500).json({ error: 'Failed to save contact: ' + err.message });
  }
});

// ============================================
// CONTACTS FOR A CLIENT (JSON) — used by the booking forms to populate
// the site-contacts picker once a client is chosen.
// ============================================
router.get('/api/by-client/:companyId', (req, res) => {
  try {
    const db = getDb();
    const companyId = parseInt(req.params.companyId, 10);
    if (!companyId) return res.json({ contacts: [] });
    const contacts = db.prepare(`
      SELECT id, full_name, position, phone, email
      FROM client_contacts WHERE company_id = ? ORDER BY full_name
    `).all(companyId);
    res.json({ contacts });
  } catch (err) {
    console.error('contacts by-client error:', err);
    res.status(500).json({ error: 'Failed to load contacts.' });
  }
});

// ============================================
// COMMUNICATION LOG (must be before /:id routes)
// ============================================
router.get('/comms', (req, res) => {
  const db = getDb();
  let where = [];
  let params = [];
  if (req.query.job_id) { where.push('cl.job_id = ?'); params.push(req.query.job_id); }
  if (req.query.comm_type) { where.push('cl.comm_type = ?'); params.push(req.query.comm_type); }
  if (req.query.follow_up === '1') { where.push('cl.follow_up_required = 1 AND cl.follow_up_done = 0'); }

  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const comms = db.prepare(`
    SELECT cl.*, j.job_number, j.client,
           cc.full_name as contact_name, cc.company as contact_company,
           u.full_name as logged_by_name
    FROM communication_log cl
    JOIN jobs j ON cl.job_id = j.id
    LEFT JOIN client_contacts cc ON cl.contact_id = cc.id
    JOIN users u ON cl.logged_by_id = u.id
    ${whereClause}
    ORDER BY cl.comm_date DESC
    LIMIT 100
  `).all(...params);

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();

  res.render('contacts/comms-log', {
    title: 'Communication Log',
    currentPage: 'contacts',
    comms,
    jobs,
    filters: req.query
  });
});

// ============================================
// NEW COMMUNICATION ENTRY
// ============================================
router.get('/comms/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won') ORDER BY job_number").all();
  const contacts = db.prepare('SELECT id, full_name, company FROM client_contacts ORDER BY company, full_name').all();
  res.render('contacts/comms-form', {
    title: 'Log Communication',
    currentPage: 'contacts',
    comm: null,
    jobs,
    contacts,
    preselectedJobId: req.query.job_id || ''
  });
});

// ============================================
// CREATE COMMUNICATION
// ============================================
router.post('/comms', (req, res) => {
  const db = getDb();
  const { job_id, contact_id, comm_type, direction, subject, summary, follow_up_required, follow_up_date, comm_date } = req.body;
  const job = db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(job_id);

  const result = db.prepare(`
    INSERT INTO communication_log (job_id, contact_id, comm_type, direction, subject, summary, follow_up_required, follow_up_date, logged_by_id, comm_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job_id,
    contact_id || null,
    comm_type,
    direction || 'outgoing',
    subject,
    summary,
    follow_up_required ? 1 : 0,
    follow_up_date || null,
    req.session.user.id,
    comm_date
  );

  logActivity({
    user: req.session.user,
    action: 'create',
    entityType: 'communication',
    entityId: result.lastInsertRowid,
    entityLabel: subject.substring(0, 50),
    jobId: parseInt(job_id),
    jobNumber: job ? job.job_number : '',
    ip: req.ip
  });

  req.flash('success', 'Communication logged.');
  req.session.save(() => res.redirect('/contacts/comms'));
});

// ============================================
// MARK FOLLOW-UP DONE
// ============================================
router.post('/comms/:id/follow-up-done', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE communication_log SET follow_up_done = 1 WHERE id = ?').run(req.params.id);
  req.flash('success', 'Follow-up marked as done.');
  req.session.save(() => res.redirect(req.get('Referer') || '/contacts/comms'));
});

// ============================================
// DELETE COMMUNICATION
// ============================================
router.post('/comms/:id/delete', (req, res) => {
  const db = getDb();
  const comm = db.prepare('SELECT * FROM communication_log WHERE id = ?').get(req.params.id);
  if (!comm) { req.flash('error', 'Communication not found.'); return req.session.save(() => res.redirect('/contacts/comms')); }

  db.prepare('DELETE FROM communication_log WHERE id = ?').run(req.params.id);
  logActivity({ user: req.session.user, action: 'delete', entityType: 'communication', entityId: parseInt(req.params.id), entityLabel: comm.subject ? comm.subject.substring(0, 50) : '', ip: req.ip });
  req.flash('success', 'Communication entry deleted.');
  req.session.save(() => res.redirect('/contacts/comms'));
});

// ============================================
// CONTACT DETAIL PAGE
// ============================================
router.get('/:id', (req, res, next) => {
  // Skip if this looks like an edit route (handled below)
  if (req.params.id === 'comms' || req.params.id === 'new') return next('route');
  const db = getDb();
  const contact = db.prepare(`
    SELECT cc.*, c.company_name, c.id as account_id
    FROM client_contacts cc
    LEFT JOIN clients c ON cc.company_id = c.id
    ${/* fallback to old company text matching */''}
    WHERE cc.id = ?
  `).get(req.params.id);

  if (!contact) {
    req.flash('error', 'Contact not found.');
    return req.session.save(() => res.redirect('/contacts'));
  }

  // Linked account (try company_id first, then text match)
  let company = null;
  if (contact.company_id) {
    company = db.prepare('SELECT * FROM clients WHERE id = ?').get(contact.company_id);
  } else if (contact.company) {
    company = db.prepare('SELECT * FROM clients WHERE company_name = ?').get(contact.company);
  }

  // Opportunities linked to this contact
  const opportunities = db.prepare(`
    SELECT o.*, c.company_name as client_name, u.full_name as owner_name
    FROM opportunities o
    LEFT JOIN clients c ON o.client_id = c.id
    LEFT JOIN users u ON o.owner_id = u.id
    WHERE o.contact_id = ?
    ORDER BY CASE o.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'won' THEN 2 ELSE 3 END, o.updated_at DESC
  `).all(req.params.id);

  // CRM Activities for this contact
  const activities = db.prepare(`
    SELECT ca.*, c.company_name as client_name, u.full_name as owner_name,
      o.title as opp_title, o.opportunity_number
    FROM crm_activities ca
    LEFT JOIN clients c ON ca.client_id = c.id
    LEFT JOIN users u ON ca.owner_id = u.id
    LEFT JOIN opportunities o ON ca.opportunity_id = o.id
    WHERE ca.contact_id = ?
    ORDER BY ca.activity_date DESC
    LIMIT 50
  `).all(req.params.id);

  // Users list (for owner display etc.)
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  // Owner user
  let ownerUser = null;
  if (contact.contact_owner_id) {
    ownerUser = users.find(u => u.id === contact.contact_owner_id) || null;
  }

  res.render('contacts/show', {
    title: contact.full_name || contact.name || 'Contact Detail',
    currentPage: 'contacts',
    contact,
    company,
    opportunities,
    activities,
    users,
    ownerUser,
  });
});

// ============================================
// EDIT CONTACT
// ============================================
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT * FROM client_contacts WHERE id = ?').get(req.params.id);
  if (!contact) {
    req.flash('error', 'Contact not found.');
    return req.session.save(() => res.redirect('/contacts'));
  }
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs ORDER BY job_number DESC").all();
  const companies = db.prepare("SELECT id, company_name, company_type FROM clients WHERE active = 1 ORDER BY company_name").all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  // Activity log
  const activityLog = db.prepare(`
    SELECT al.*, u.full_name as user_name FROM activity_log al
    LEFT JOIN users u ON al.user_id = u.id
    WHERE al.entity_type = 'contact' AND al.entity_id = ?
    ORDER BY al.created_at DESC LIMIT 20
  `).all(req.params.id);

  res.render('contacts/form', {
    title: `Edit ${contact.full_name}`,
    currentPage: 'contacts',
    contact,
    jobs,
    companies,
    users,
    preselectedJobId: '',
    preselectedCompanyId: '',
    activityLog
  });
});

// ============================================
// UPDATE CONTACT
// ============================================
router.post('/:id', (req, res) => {
  const db = getDb();
  const { job_id, company_id, contact_type, company, full_name, position, phone, mobile, email, notes, is_primary,
    relationship_strength, influence_level, buying_role, preferred_comm_method, referred_by, contact_owner_id } = req.body;
  db.prepare(`
    UPDATE client_contacts SET job_id=?, company_id=?, contact_type=?, company=?, full_name=?, position=?, phone=?, mobile=?, email=?, notes=?, is_primary=?,
      relationship_strength=?, influence_level=?, buying_role=?, preferred_comm_method=?, referred_by=?, contact_owner_id=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(job_id || null, company_id || null, contact_type, company, full_name, position || '', phone || '', mobile || '', email || '', notes || '', is_primary ? 1 : 0,
    relationship_strength || '', influence_level || '', buying_role || '', preferred_comm_method || '', referred_by || '', contact_owner_id || null, req.params.id);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'contact',
    entityId: parseInt(req.params.id),
    entityLabel: full_name,
    ip: req.ip
  });

  req.flash('success', 'Contact updated.');
  req.session.save(() => res.redirect('/contacts'));
});

// ============================================
// DELETE CONTACT
// ============================================
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const contact = db.prepare('SELECT full_name FROM client_contacts WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM client_contacts WHERE id = ?').run(req.params.id);

  logActivity({
    user: req.session.user,
    action: 'delete',
    entityType: 'contact',
    entityId: parseInt(req.params.id),
    entityLabel: contact ? contact.full_name : '',
    ip: req.ip
  });

  req.flash('success', 'Contact deleted.');
  req.session.save(() => res.redirect('/contacts'));
});

module.exports = router;
