const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');

// JSON API - search companies (for autocomplete/dropdowns) — MUST be before /:id
router.get('/api/search.json', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  const type = req.query.type || '';
  let query = `
    SELECT id, company_name, abn, primary_contact_name, primary_contact_phone, company_type
    FROM clients WHERE active = 1 AND (company_name LIKE ? OR abn LIKE ?)
  `;
  const params = [`%${q}%`, `%${q}%`];
  if (type && ['client', 'subcontractor', 'supplier'].includes(type)) {
    query += ` AND company_type = ?`;
    params.push(type);
  }
  query += ` ORDER BY company_name ASC LIMIT 20`;
  const clients = db.prepare(query).all(...params);
  res.json(clients);
});

// List all companies
router.get('/', (req, res) => {
  const db = getDb();
  const { search, status, type } = req.query;
  let query = `
    SELECT c.*,
      (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id AND j.status IN ('active','on_hold','won')) as active_jobs,
      (SELECT COUNT(*) FROM jobs j WHERE j.client_id = c.id) as total_jobs,
      (SELECT COUNT(*) FROM client_contacts cc WHERE cc.company_id = c.id) as contact_count
    FROM clients c WHERE 1=1
  `;
  const params = [];

  if (type && ['client', 'subcontractor', 'supplier'].includes(type)) {
    query += ` AND c.company_type = ?`;
    params.push(type);
  }
  if (search) {
    query += ` AND (c.company_name LIKE ? OR c.abn LIKE ? OR c.primary_contact_name LIKE ? OR c.primary_contact_email LIKE ? OR c.trade_specialty LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  if (status === 'active') {
    query += ` AND c.active = 1`;
  } else if (status === 'inactive') {
    query += ` AND c.active = 0`;
  }

  query += ` ORDER BY c.company_name ASC`;
  const companies = db.prepare(query).all(...params);

  // Stats per type
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN company_type = 'client' THEN 1 ELSE 0 END) as clients,
      SUM(CASE WHEN company_type = 'subcontractor' THEN 1 ELSE 0 END) as subcontractors,
      SUM(CASE WHEN company_type = 'supplier' THEN 1 ELSE 0 END) as suppliers,
      SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) as active_count
    FROM clients
  `).get();

  res.render('clients/index', {
    title: 'Company Directory',
    currentPage: 'clients',
    companies,
    stats,
    filters: { search, status, type },
  });
});

// New company form
router.get('/new', (req, res) => {
  const db = getDb();
  const preselectedType = req.query.type || 'client';
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('clients/form', {
    title: 'Add New Company',
    currentPage: 'clients',
    company: null,
    preselectedType,
    users,
  });
});

// Create company
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const companyType = b.company_type || 'client';

  try {
    const result = db.prepare(`
      INSERT INTO clients (company_name, abn, primary_contact_name, primary_contact_phone, primary_contact_email,
        address, billing_address, payment_terms, notes, company_type, trade_specialty, insurance_expiry,
        insurance_policy, product_categories, account_number, website, approved, rating,
        account_owner_id, bdm_owner_id, lead_source, estimated_annual_value, service_interests,
        target_regions, priority, prequal_status, vendor_status, contract_status, industry_segment,
        next_action_date, next_action_note, phone, email_general, suburb, state, postcode,
        client_category, onboarding_stage, tender_panel_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.company_name, b.abn || '', b.primary_contact_name || '', b.primary_contact_phone || '',
      b.primary_contact_email || '', b.address || '', b.billing_address || '',
      b.payment_terms || '', b.notes || '', companyType,
      b.trade_specialty || '', b.insurance_expiry || null,
      b.insurance_policy || '', b.product_categories || '', b.account_number || '',
      b.website || '', b.approved ? 1 : (companyType === 'client' ? 1 : 0), parseInt(b.rating) || 0,
      b.account_owner_id || null, b.bdm_owner_id || null, b.lead_source || '',
      parseFloat(b.estimated_annual_value) || 0, b.service_interests || '',
      b.target_regions || '', b.priority || 'normal', b.prequal_status || 'none',
      b.vendor_status || 'none', b.contract_status || '', b.industry_segment || '',
      b.next_action_date || null, b.next_action_note || '',
      b.phone || '', b.email_general || '', b.suburb || '', b.state || '', b.postcode || '',
      b.client_category || '', b.onboarding_stage || '', b.tender_panel_status || ''
    );

    const typeLabel = companyType.charAt(0).toUpperCase() + companyType.slice(1);
    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'company',
      entityId: result.lastInsertRowid,
      entityLabel: `${b.company_name} (${typeLabel})`,
      ip: req.ip
    });

    req.flash('success', `${typeLabel} "${b.company_name}" created successfully.`);

    // If request wants JSON (from inline create on allocations board)
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      const newClient = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
      return res.json({ success: true, client: newClient });
    }

    req.session.save(() => res.redirect('/clients/' + result.lastInsertRowid));
  } catch (err) {
    req.flash('error', 'Failed to create company: ' + err.message);
    req.session.save(() => res.redirect('/clients/new?type=' + companyType));
  }
});

// Bulk delete companies
router.post('/delete', (req, res) => {
  const db = getDb();
  let ids = req.body.ids;
  if (!ids) { req.flash('error', 'No companies selected.'); return req.session.save(() => res.redirect('/clients')); }
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (ids.length === 0) { req.flash('error', 'No valid companies selected.'); return req.session.save(() => res.redirect('/clients')); }

  const placeholders = ids.map(() => '?').join(',');

  // Check for linked jobs
  const linkedJobs = db.prepare(`SELECT client_id, COUNT(*) as c FROM jobs WHERE client_id IN (${placeholders}) GROUP BY client_id`).all(...ids);
  const blockedIds = linkedJobs.filter(j => j.c > 0).map(j => j.client_id);
  const deletableIds = ids.filter(id => !blockedIds.includes(id));

  if (deletableIds.length === 0) {
    req.flash('error', 'Cannot delete — all selected companies have linked projects. Deactivate instead.');
    return req.session.save(() => res.redirect('/clients'));
  }

  const delPlaceholders = deletableIds.map(() => '?').join(',');

  // Delete related records
  try { db.prepare(`DELETE FROM client_contacts WHERE company_id IN (${delPlaceholders})`).run(...deletableIds); } catch (e) { /* ignore */ }

  const result = db.prepare(`DELETE FROM clients WHERE id IN (${delPlaceholders})`).run(...deletableIds);
  const count = result.changes;

  if (blockedIds.length > 0) {
    req.flash('success', `Deleted ${count} company${count !== 1 ? 'ies' : 'y'}. ${blockedIds.length} skipped (have linked projects).`);
  } else {
    req.flash('success', `Deleted ${count} company${count !== 1 ? 'ies' : 'y'}.`);
  }
  req.session.save(() => res.redirect('/clients'));
});

// Company detail page
router.get('/:id', (req, res, next) => {
  try {
  const db = getDb();
  const client = db.prepare(`
    SELECT c.*,
      u_owner.full_name as owner_name,
      u_bdm.full_name as bdm_name
    FROM clients c
    LEFT JOIN users u_owner ON c.account_owner_id = u_owner.id
    LEFT JOIN users u_bdm ON c.bdm_owner_id = u_bdm.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!client) {
    req.flash('error', 'Company not found.');
    return req.session.save(() => res.redirect('/clients'));
  }

  // Projects linked to this company (via client_id)
  const projects = db.prepare(`
    SELECT j.*, u.full_name as pm_name
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.client_id = ? AND j.parent_project_id IS NULL
    ORDER BY j.start_date DESC
  `).all(client.id);

  const recentShifts = db.prepare(`
    SELECT j.*, u.full_name as pm_name,
      (SELECT COUNT(*) FROM crew_allocations ca WHERE ca.job_id = j.id AND ca.status IN ('allocated','confirmed')) as crew_count
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.client_id = ? AND j.parent_project_id IS NOT NULL
    ORDER BY j.start_date DESC LIMIT 20
  `).all(client.id);

  // Contacts linked to this company directly (via company_id) or via job
  const contacts = db.prepare(`
    SELECT cc.* FROM client_contacts cc
    WHERE cc.company_id = ?
    UNION
    SELECT cc.* FROM client_contacts cc
    JOIN jobs j ON cc.job_id = j.id
    WHERE j.client_id = ? AND cc.company_id IS NULL
    ORDER BY is_primary DESC, full_name ASC
  `).all(client.id, client.id);

  // Recent communications related to this company's jobs
  const comms = db.prepare(`
    SELECT cl.*, u.full_name as logged_by_name, cc.full_name as contact_name
    FROM communication_log cl
    LEFT JOIN users u ON cl.logged_by_id = u.id
    LEFT JOIN client_contacts cc ON cl.contact_id = cc.id
    JOIN jobs j ON cl.job_id = j.id
    WHERE j.client_id = ?
    ORDER BY cl.comm_date DESC
    LIMIT 10
  `).all(client.id);

  // CRM: Open opportunities for this account
  const opportunities = db.prepare(`
    SELECT o.*, u.full_name as owner_name
    FROM opportunities o
    LEFT JOIN users u ON o.owner_id = u.id
    WHERE o.client_id = ?
    ORDER BY CASE o.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'won' THEN 2 ELSE 3 END, o.expected_close_date ASC
  `).all(client.id);

  // CRM: Recent activities for this account
  const crmActivities = db.prepare(`
    SELECT ca.*, u.full_name as owner_name, cc.full_name as contact_name,
      o.opportunity_number, o.title as opp_title
    FROM crm_activities ca
    LEFT JOIN users u ON ca.owner_id = u.id
    LEFT JOIN client_contacts cc ON ca.contact_id = cc.id
    LEFT JOIN opportunities o ON ca.opportunity_id = o.id
    WHERE ca.client_id = ?
    ORDER BY ca.activity_date DESC
    LIMIT 20
  `).all(client.id);

  // CRM: Pipeline summary for this account
  const pipelineSummary = db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'open' THEN 1 END) as open_count,
      COALESCE(SUM(CASE WHEN status = 'open' THEN estimated_value ELSE 0 END), 0) as open_value,
      COUNT(CASE WHEN status = 'won' THEN 1 END) as won_count,
      COALESCE(SUM(CASE WHEN status = 'won' THEN estimated_value ELSE 0 END), 0) as won_value
    FROM opportunities WHERE client_id = ?
  `).get(client.id);

  // CRM: Meetings for this account
  const meetings = db.prepare(`
    SELECT m.*, u.full_name as owner_name, o.title as opp_title, o.opportunity_number
    FROM crm_meetings m
    LEFT JOIN users u ON m.owner_id = u.id
    LEFT JOIN opportunities o ON m.opportunity_id = o.id
    WHERE m.account_id = ?
    ORDER BY m.meeting_date DESC
    LIMIT 20
  `).all(client.id);

  // Jobs linked to this client
  const accountJobs = db.prepare(`
    SELECT j.id, j.job_number, j.job_name, j.status, j.start_date, j.end_date,
      j.contract_value, u.full_name as pm_name
    FROM jobs j
    LEFT JOIN users u ON j.project_manager_id = u.id
    WHERE j.client_id = ?
    ORDER BY j.start_date DESC
    LIMIT 30
  `).all(client.id);

  // Enhanced contacts with CRM fields
  const accountContacts = db.prepare(`
    SELECT cc.*, u.full_name as owner_name
    FROM client_contacts cc
    LEFT JOIN users u ON cc.contact_owner_id = u.id
    WHERE cc.company_id = ?
    ORDER BY cc.is_primary DESC, cc.full_name ASC
  `).all(client.id);

  // Build timeline events from activities + stage changes
  const timelineEvents = crmActivities.map(a => ({
    type: a.activity_type === 'meeting' ? 'meeting' : 'activity',
    date: a.activity_date || a.created_at,
    icon_type: a.activity_type,
    title: a.subject,
    description: a.notes || a.outcome || '',
    user_name: a.owner_name || '',
    meta: { contact_name: a.contact_name, opp_title: a.opp_title },
  }));

  // Users for owner dropdowns
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  res.render('clients/show', {
    title: client.company_name,
    currentPage: 'clients',
    company: client,
    projects,
    recentShifts,
    contacts,
    comms,
    opportunities,
    crmActivities,
    pipelineSummary,
    meetings,
    accountJobs,
    accountContacts,
    timelineEvents,
    users,
  });
  } catch (err) {
    console.error('Client detail error:', err);
    next(err);
  }
});

// Edit company form
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) {
    req.flash('error', 'Company not found.');
    return req.session.save(() => res.redirect('/clients'));
  }
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  res.render('clients/form', {
    title: 'Edit ' + client.company_name,
    currentPage: 'clients',
    company: client,
    preselectedType: client.company_type || 'client',
    users,
  });
});

// Update company
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  const companyType = b.company_type || 'client';
  try {
    db.prepare(`
      UPDATE clients SET company_name=?, abn=?, primary_contact_name=?, primary_contact_phone=?,
        primary_contact_email=?, address=?, billing_address=?, payment_terms=?, notes=?,
        active=?, company_type=?, trade_specialty=?, insurance_expiry=?, insurance_policy=?,
        product_categories=?, account_number=?, website=?, approved=?, rating=?,
        account_owner_id=?, bdm_owner_id=?, lead_source=?, estimated_annual_value=?,
        service_interests=?, target_regions=?, priority=?, prequal_status=?, vendor_status=?,
        contract_status=?, industry_segment=?, next_action_date=?, next_action_note=?,
        phone=?, email_general=?, suburb=?, state=?, postcode=?,
        client_category=?, onboarding_stage=?, tender_panel_status=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.company_name, b.abn || '', b.primary_contact_name || '', b.primary_contact_phone || '',
      b.primary_contact_email || '', b.address || '', b.billing_address || '',
      b.payment_terms || '', b.notes || '', b.active ? 1 : 0,
      companyType, b.trade_specialty || '', b.insurance_expiry || null,
      b.insurance_policy || '', b.product_categories || '', b.account_number || '',
      b.website || '', b.approved ? 1 : (companyType === 'client' ? 1 : 0), parseInt(b.rating) || 0,
      b.account_owner_id || null, b.bdm_owner_id || null, b.lead_source || '',
      parseFloat(b.estimated_annual_value) || 0, b.service_interests || '',
      b.target_regions || '', b.priority || 'normal', b.prequal_status || 'none',
      b.vendor_status || 'none', b.contract_status || '', b.industry_segment || '',
      b.next_action_date || null, b.next_action_note || '',
      b.phone || '', b.email_general || '', b.suburb || '', b.state || '', b.postcode || '',
      b.client_category || '', b.onboarding_stage || '', b.tender_panel_status || '',
      req.params.id
    );

    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'company',
      entityId: parseInt(req.params.id),
      entityLabel: b.company_name,
      ip: req.ip
    });

    req.flash('success', 'Company updated successfully.');
    req.session.save(() => res.redirect('/clients/' + req.params.id));
  } catch (err) {
    req.flash('error', 'Failed to update company: ' + err.message);
    req.session.save(() => res.redirect('/clients/' + req.params.id + '/edit'));
  }
});

// Delete company
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const company = db.prepare('SELECT company_name, company_type FROM clients WHERE id = ?').get(req.params.id);
  // Only allow delete if no jobs are linked
  const jobCount = db.prepare('SELECT COUNT(*) as count FROM jobs WHERE client_id = ?').get(req.params.id).count;
  if (jobCount > 0) {
    req.flash('error', 'Cannot delete company with linked projects/shifts. Deactivate instead.');
    return req.session.save(() => res.redirect('/clients/' + req.params.id));
  }

  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);

  logActivity({
    user: req.session.user,
    action: 'delete',
    entityType: 'company',
    entityId: parseInt(req.params.id),
    entityLabel: company ? company.company_name : '',
    ip: req.ip
  });

  req.flash('success', 'Company deleted.');
  req.session.save(() => res.redirect('/clients'));
});

module.exports = router;
