const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateJobNumber } = require('../lib/jobNumbers');

// JSON API - search opportunities (for autocomplete/dropdowns) — MUST be before /:id
router.get('/api/search.json', (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  const s = `%${q}%`;
  const opportunities = db.prepare(`
    SELECT o.id, o.opportunity_number, o.title, o.status,
      c.company_name as client_name
    FROM opportunities o
    LEFT JOIN clients c ON o.client_id = c.id
    WHERE o.opportunity_number LIKE ? OR o.title LIKE ? OR c.company_name LIKE ?
    ORDER BY o.updated_at DESC
    LIMIT 20
  `).all(s, s, s);
  res.json(opportunities);
});

// List opportunities with filters
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { owner, stage, status, client_id, search, sort, stale, no_next_step } = req.query;

    let query = `
      SELECT o.*,
        c.company_name as client_name,
        u.full_name as owner_name,
        cc.full_name as contact_name,
        (SELECT MAX(ca.activity_date) FROM crm_activities ca WHERE ca.opportunity_id = o.id) as last_activity_date
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      LEFT JOIN client_contacts cc ON o.contact_id = cc.id
      WHERE 1=1
    `;
    const params = [];

    if (owner) {
      query += ` AND o.owner_id = ?`;
      params.push(owner);
    }
    if (stage) {
      query += ` AND o.stage = ?`;
      params.push(stage);
    }
    if (status && status !== 'all') {
      query += ` AND o.status = ?`;
      params.push(status);
    }
    if (client_id) {
      query += ` AND o.client_id = ?`;
      params.push(client_id);
    }
    if (search) {
      query += ` AND (o.opportunity_number LIKE ? OR o.title LIKE ? OR c.company_name LIKE ? OR o.notes LIKE ?)`;
      const term = `%${search}%`;
      params.push(term, term, term, term);
    }
    // Stale filter: no activity in 14+ days
    if (stale === '1') {
      query += ` AND o.status = 'open' AND (
        (SELECT MAX(ca.activity_date) FROM crm_activities ca WHERE ca.opportunity_id = o.id) < DATE('now', '-14 days')
        OR NOT EXISTS (SELECT 1 FROM crm_activities ca WHERE ca.opportunity_id = o.id)
      )`;
    }
    // No next step filter
    if (no_next_step === '1') {
      query += ` AND o.status = 'open' AND (o.next_step IS NULL OR o.next_step = '')`;
    }

    // Sorting
    switch (sort) {
      case 'value_desc':
        query += ` ORDER BY o.estimated_value DESC`;
        break;
      case 'value_asc':
        query += ` ORDER BY o.estimated_value ASC`;
        break;
      case 'close_date':
        query += ` ORDER BY o.expected_close_date ASC`;
        break;
      case 'created':
        query += ` ORDER BY o.created_at DESC`;
        break;
      case 'updated':
        query += ` ORDER BY o.updated_at DESC`;
        break;
      default:
        query += ` ORDER BY o.updated_at DESC`;
    }

    const opportunities = db.prepare(query).all(...params);

    // Stat cards
    const stats = db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'open' THEN 1 END) as total_open,
        COALESCE(SUM(CASE WHEN status = 'open' THEN estimated_value ELSE 0 END), 0) as pipeline_value,
        COALESCE(SUM(CASE WHEN status = 'open' THEN weighted_value ELSE 0 END), 0) as weighted_pipeline,
        COUNT(CASE WHEN status = 'won' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now') THEN 1 END) as won_this_month,
        COUNT(CASE WHEN status = 'lost' AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now') THEN 1 END) as lost_this_month
      FROM opportunities
    `).get();

    // Get users for owner filter dropdown
    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

    res.render('opportunities/index', {
      title: 'Opportunities',
      currentPage: 'pipeline',
      opportunities,
      stats,
      users,
      filters: { owner, stage, status, client_id, search, sort, stale, no_next_step },
    });
  } catch (err) {
    console.error('Opportunities list error:', err);
    next(err);
  }
});

// Pipeline (kanban) view
router.get('/pipeline', (req, res, next) => {
  try {
    const db = getDb();

    // Fetch all open opportunities with joins
    const opportunities = db.prepare(`
      SELECT o.*,
        c.company_name as client_name,
        u.full_name as owner_name
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      WHERE o.status = 'open'
      ORDER BY o.updated_at DESC
    `).all();

    // Get stage definitions from settingsOptions (passed to template)
    // Filter out won/lost/on_hold for pipeline columns
    const allStages = res.locals.settingsOptions.opportunity_stages || [];
    const pipelineStages = allStages.filter(s => !['won', 'lost', 'on_hold'].includes(s.key));

    // Group opportunities by stage
    const grouped = {};
    for (const stage of pipelineStages) {
      grouped[stage.key] = [];
    }
    for (const opp of opportunities) {
      if (grouped[opp.stage]) {
        grouped[opp.stage].push(opp);
      }
    }

    res.render('opportunities/pipeline', {
      title: 'Sales Pipeline',
      currentPage: 'pipeline',
      pipelineStages,
      grouped,
      opportunities,
    });
  } catch (err) {
    console.error('Pipeline view error:', err);
    next(err);
  }
});

// New opportunity form
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
    const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
    const contacts = db.prepare('SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name').all();

    res.render('opportunities/form', {
      title: 'New Opportunity',
      currentPage: 'pipeline',
      opportunity: null,
      clients,
      users,
      contacts,
    });
  } catch (err) {
    console.error('New opportunity form error:', err);
    next(err);
  }
});

// Create opportunity
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  try {
    // Auto-generate opportunity_number: OPP-001, OPP-002, etc.
    const maxRow = db.prepare(`
      SELECT opportunity_number FROM opportunities
      WHERE opportunity_number LIKE 'OPP-%'
      ORDER BY CAST(SUBSTR(opportunity_number, 5) AS INTEGER) DESC
      LIMIT 1
    `).get();
    let nextNum = 1;
    if (maxRow && maxRow.opportunity_number) {
      const parsed = parseInt(maxRow.opportunity_number.replace('OPP-', ''), 10);
      if (!isNaN(parsed)) nextNum = parsed + 1;
    }
    const opportunityNumber = 'OPP-' + String(nextNum).padStart(3, '0');

    const estimatedValue = parseFloat(b.estimated_value) || 0;
    const probability = parseInt(b.probability) || 10;
    const weightedValue = estimatedValue * probability / 100;

    const result = db.prepare(`
      INSERT INTO opportunities (
        opportunity_number, title, client_id, contact_id, owner_id,
        service_type, stage, probability, estimated_value, weighted_value,
        expected_close_date, source, region, notes, next_step, next_step_due_date,
        status, created_by_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opportunityNumber,
      b.title,
      b.client_id || null,
      b.contact_id || null,
      b.owner_id || null,
      b.service_type || '',
      b.stage || 'new_lead',
      probability,
      estimatedValue,
      weightedValue,
      b.expected_close_date || null,
      b.source || '',
      b.region || '',
      b.notes || '',
      b.next_step || '',
      b.next_step_due_date || null,
      b.status || 'open',
      req.session.user ? req.session.user.id : null
    );

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'opportunity',
      entityId: result.lastInsertRowid,
      entityLabel: `${opportunityNumber} - ${b.title}`,
      ip: req.ip
    });

    req.flash('success', `Opportunity "${opportunityNumber}" created successfully.`);

    // Support JSON response for XHR
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      const newOpp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(result.lastInsertRowid);
      return res.json({ success: true, opportunity: newOpp });
    }

    req.session.save(() => res.redirect('/opportunities/' + result.lastInsertRowid));
  } catch (err) {
    req.flash('error', 'Failed to create opportunity: ' + err.message);
    req.session.save(() => res.redirect('/opportunities/new'));
  }
});

// Opportunity detail page
router.get('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const opportunity = db.prepare(`
      SELECT o.*,
        c.company_name as client_name,
        u.full_name as owner_name,
        cc.full_name as contact_name,
        cc.email as contact_email,
        cc.phone as contact_phone,
        cb.full_name as created_by_name
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      LEFT JOIN client_contacts cc ON o.contact_id = cc.id
      LEFT JOIN users cb ON o.created_by_id = cb.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }

    // CRM activities linked to this opportunity
    const activities = db.prepare(`
      SELECT a.*,
        u.full_name as owner_name,
        cc.full_name as contact_name
      FROM crm_activities a
      LEFT JOIN users u ON a.owner_id = u.id
      LEFT JOIN client_contacts cc ON a.contact_id = cc.id
      WHERE a.opportunity_id = ?
      ORDER BY a.activity_date DESC, a.created_at DESC
    `).all(opportunity.id);

    // Related job if linked
    let relatedJob = null;
    if (opportunity.related_job_id) {
      relatedJob = db.prepare(`
        SELECT id, job_number, job_name, status, stage, start_date, end_date, contract_value
        FROM jobs WHERE id = ?
      `).get(opportunity.related_job_id);
    }

    res.render('opportunities/show', {
      title: opportunity.opportunity_number + ' - ' + opportunity.title,
      currentPage: 'pipeline',
      opportunity,
      activities,
      relatedJob,
    });
  } catch (err) {
    console.error('Opportunity detail error:', err);
    next(err);
  }
});

// Edit opportunity form
router.get('/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }

    const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
    const users = db.prepare('SELECT id, full_name, role FROM users WHERE active = 1 ORDER BY full_name').all();
    const contacts = db.prepare('SELECT id, full_name, company_id FROM client_contacts ORDER BY full_name').all();

    res.render('opportunities/form', {
      title: 'Edit ' + opportunity.opportunity_number,
      currentPage: 'pipeline',
      opportunity,
      clients,
      users,
      contacts,
    });
  } catch (err) {
    console.error('Edit opportunity form error:', err);
    next(err);
  }
});

// Update opportunity
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;

  try {
    // Fetch current opportunity to detect stage change
    const current = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
    if (!current) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }

    const estimatedValue = parseFloat(b.estimated_value) || 0;
    const probability = parseInt(b.probability) || 10;
    const weightedValue = estimatedValue * probability / 100;

    // Determine won/lost dates
    const newStatus = b.status || 'open';
    const todayStr = new Date().toISOString().slice(0, 10);
    let wonDate = current.won_date || null;
    let lostDate = current.lost_date || null;
    if (newStatus === 'won' && current.status !== 'won') wonDate = todayStr;
    if (newStatus === 'lost' && current.status !== 'lost') lostDate = todayStr;
    if (newStatus === 'open') { wonDate = null; lostDate = null; }

    db.prepare(`
      UPDATE opportunities SET
        title = ?, client_id = ?, contact_id = ?, owner_id = ?,
        service_type = ?, stage = ?, probability = ?, estimated_value = ?, weighted_value = ?,
        expected_close_date = ?, source = ?, region = ?, notes = ?,
        next_step = ?, next_step_due_date = ?, status = ?, loss_reason = ?,
        won_date = ?, lost_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.title,
      b.client_id || null,
      b.contact_id || null,
      b.owner_id || null,
      b.service_type || '',
      b.stage || current.stage,
      probability,
      estimatedValue,
      weightedValue,
      b.expected_close_date || null,
      b.source || '',
      b.region || '',
      b.notes || '',
      b.next_step || '',
      b.next_step_due_date || null,
      newStatus,
      b.loss_reason || '',
      wonDate, lostDate,
      req.params.id
    );

    // If stage changed, log a CRM activity automatically
    const newStage = b.stage || current.stage;
    if (newStage !== current.stage) {
      db.prepare(`
        INSERT INTO crm_activities (
          activity_type, subject, notes, outcome,
          client_id, contact_id, opportunity_id, owner_id,
          activity_date, is_completed, created_by_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
      `).run(
        'follow_up',
        `Stage changed from ${current.stage} to ${newStage}`,
        `Opportunity stage updated automatically.`,
        '',
        current.client_id || null,
        current.contact_id || null,
        current.id,
        req.session.user ? req.session.user.id : null,
        req.session.user ? req.session.user.id : null
      );
    }

    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'opportunity',
      entityId: parseInt(req.params.id),
      entityLabel: current.opportunity_number + ' - ' + b.title,
      ip: req.ip
    });

    req.flash('success', 'Opportunity updated successfully.');
    req.session.save(() => res.redirect('/opportunities/' + req.params.id));
  } catch (err) {
    req.flash('error', 'Failed to update opportunity: ' + err.message);
    req.session.save(() => res.redirect('/opportunities/' + req.params.id + '/edit'));
  }
});

// Delete opportunity (only if no related job)
router.post('/:id/delete', (req, res) => {
  const db = getDb();

  try {
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }

    if (opportunity.related_job_id) {
      req.flash('error', 'Cannot delete opportunity with a linked job. Remove the job link first.');
      return req.session.save(() => res.redirect('/opportunities/' + req.params.id));
    }

    // Delete linked CRM activities first
    db.prepare('DELETE FROM crm_activities WHERE opportunity_id = ?').run(req.params.id);

    // Delete the opportunity
    db.prepare('DELETE FROM opportunities WHERE id = ?').run(req.params.id);

    logActivity({
      user: req.session.user,
      action: 'delete',
      entityType: 'opportunity',
      entityId: parseInt(req.params.id),
      entityLabel: opportunity.opportunity_number + ' - ' + opportunity.title,
      ip: req.ip
    });

    req.flash('success', 'Opportunity deleted.');
    req.session.save(() => res.redirect('/opportunities'));
  } catch (err) {
    req.flash('error', 'Failed to delete opportunity: ' + err.message);
    req.session.save(() => res.redirect('/opportunities/' + req.params.id));
  }
});

// AJAX endpoint for kanban drag-and-drop stage change
router.post('/:id/stage', (req, res) => {
  const db = getDb();

  try {
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
    if (!opportunity) {
      return res.status(404).json({ success: false, error: 'Opportunity not found' });
    }

    const { stage, probability } = req.body;
    const newProbability = probability !== undefined ? parseInt(probability) : opportunity.probability;
    const weightedValue = opportunity.estimated_value * newProbability / 100;
    const todayStr = new Date().toISOString().slice(0, 10);

    // Determine status and won/lost dates from stage
    let newStatus = opportunity.status;
    let wonDate = opportunity.won_date || null;
    let lostDate = opportunity.lost_date || null;
    if (stage === 'won') { newStatus = 'won'; wonDate = wonDate || todayStr; }
    else if (stage === 'lost') { newStatus = 'lost'; lostDate = lostDate || todayStr; }
    else if (stage === 'on_hold') { newStatus = 'on_hold'; }
    else if (['won', 'lost', 'on_hold'].includes(opportunity.status)) { newStatus = 'open'; wonDate = null; lostDate = null; }

    db.prepare(`
      UPDATE opportunities SET
        stage = ?, probability = ?, weighted_value = ?, status = ?,
        won_date = ?, lost_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(stage, newProbability, weightedValue, newStatus, wonDate, lostDate, req.params.id);

    // Log stage change as CRM activity if stage actually changed
    if (stage && stage !== opportunity.stage) {
      db.prepare(`
        INSERT INTO crm_activities (
          activity_type, subject, notes, outcome,
          client_id, contact_id, opportunity_id, owner_id,
          activity_date, is_completed, created_by_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
      `).run(
        'follow_up',
        `Stage changed from ${opportunity.stage} to ${stage}`,
        'Stage updated via pipeline board.',
        '',
        opportunity.client_id || null,
        opportunity.contact_id || null,
        opportunity.id,
        req.session.user ? req.session.user.id : null,
        req.session.user ? req.session.user.id : null
      );
    }

    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'opportunity',
      entityId: parseInt(req.params.id),
      entityLabel: opportunity.opportunity_number,
      details: `Stage changed to ${stage}`,
      ip: req.ip
    });

    const updated = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(req.params.id);
    res.json({ success: true, opportunity: updated });
  } catch (err) {
    console.error('Stage update error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Convert won opportunity to job
router.post('/:id/convert', (req, res) => {
  const db = getDb();

  try {
    const opportunity = db.prepare(`
      SELECT o.*, c.company_name as client_name
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }

    // Set status to won if not already
    if (opportunity.status !== 'won') {
      db.prepare(`
        UPDATE opportunities SET status = 'won', stage = 'won', updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(opportunity.id);
    }

    // Auto-generate J-XXXX job number via shared sequence
    const jobNumber = generateJobNumber();

    const clientName = opportunity.client_name || '';
    const today = new Date().toISOString().split('T')[0];
    const jobName = `${jobNumber} | ${clientName} | ${opportunity.title}`;

    const jobResult = db.prepare(`
      INSERT INTO jobs (
        job_number, job_name, client, client_id, site_address, suburb,
        status, stage, start_date, contract_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      jobNumber,
      jobName,
      clientName,
      opportunity.client_id || null,
      '',
      '',
      'won',
      'prestart',
      today,
      opportunity.estimated_value || 0
    );

    const newJobId = jobResult.lastInsertRowid;

    // Link opportunity to the new job
    db.prepare(`
      UPDATE opportunities SET related_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(newJobId, opportunity.id);

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'job',
      entityId: newJobId,
      entityLabel: jobNumber,
      details: `Converted from opportunity ${opportunity.opportunity_number}`,
      ip: req.ip
    });

    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'opportunity',
      entityId: parseInt(req.params.id),
      entityLabel: opportunity.opportunity_number,
      details: `Converted to job ${jobNumber}`,
      ip: req.ip
    });

    req.flash('success', `Opportunity converted to job ${jobNumber} successfully.`);
    req.session.save(() => res.redirect('/jobs/' + newJobId));
  } catch (err) {
    req.flash('error', 'Failed to convert opportunity: ' + err.message);
    req.session.save(() => res.redirect('/opportunities/' + req.params.id));
  }
});

module.exports = router;
