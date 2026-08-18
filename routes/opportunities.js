const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateOpportunityRef, generateProjectNumber, generateServicePackageRef } = require('../lib/refNumbers');
const { defaultProbability, validateStageTransition } = require('../lib/crmStages');
const { sydneyToday } = require('../lib/sydney');

// Comma-join a multi-select body value (service_streams checkboxes).
function joinMulti(v) {
  return Array.isArray(v) ? v.join(',') : (v || '');
}

// Keep the linked referral's outcome in step with the opportunity (§3.1:
// referrals carry won/lost outcome for attribution reporting).
function syncReferralOutcome(db, opp, newStatus) {
  if (!opp.referral_id) return;
  const outcome = newStatus === 'won' ? 'won' : newStatus === 'lost' ? 'lost' : 'open';
  db.prepare('UPDATE referrals SET outcome = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(outcome, opp.referral_id);
}

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
      currentPage: 'opportunities',
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
      currentPage: 'opportunities',
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
    // OPP-YY#### — Sydney-year-scoped sequence (brief §2.4).
    const opportunityNumber = generateOpportunityRef();

    const stage = b.stage || 'lead';
    const stageDefault = defaultProbability(db, stage);
    const estimatedValue = parseFloat(b.estimated_value) || 0;
    // Probability defaults from the stage (§3.2); a manual override must
    // carry a recorded reason.
    let probability = b.probability !== undefined && b.probability !== '' ? parseInt(b.probability) : (stageDefault !== null ? stageDefault : 10);
    if (isNaN(probability)) probability = stageDefault !== null ? stageDefault : 10;
    const overrideReason = (stageDefault !== null && probability !== stageDefault) ? (b.probability_override_reason || '') : '';
    if (stageDefault !== null && probability !== stageDefault && !overrideReason) {
      req.flash('error', `Probability ${probability}% differs from the ${stage} stage default (${stageDefault}%) — an override reason is required.`);
      return req.session.save(() => res.redirect('/opportunities/new'));
    }
    const weightedValue = estimatedValue * probability / 100;

    // Referral capture: a referring organisation/contact spawns a referrals
    // row up-front so attribution survives the whole lifecycle.
    let referralId = null;
    if (b.referring_client_id || b.referring_contact_id) {
      referralId = db.prepare(`
        INSERT INTO referrals (referring_client_id, referring_contact_id, referred_client_id, referred_contact_id,
          referral_date, owner_id, channel, notes, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        b.referring_client_id || null, b.referring_contact_id || null,
        b.client_id || null, b.contact_id || null,
        sydneyToday(), b.owner_id || (req.session.user ? req.session.user.id : null),
        b.referral_channel || 'client_referral', '', req.session.user ? req.session.user.id : null
      ).lastInsertRowid;
    }

    const result = db.prepare(`
      INSERT INTO opportunities (
        opportunity_number, title, client_id, contact_id, owner_id,
        service_type, stage, probability, estimated_value, weighted_value,
        expected_close_date, source, region, notes, next_step, next_step_due_date,
        status, created_by_id,
        end_client, site_name, site_address, lga, client_sector, service_streams,
        referral_id, commercial_owner_id, received_date, expected_start_date,
        scope_summary, key_assumptions, capacity_flag, conflict_flag, risk_notes,
        probability_override_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opportunityNumber,
      b.title,
      b.client_id || null,
      b.contact_id || null,
      b.owner_id || null,
      b.service_type || '',
      stage,
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
      req.session.user ? req.session.user.id : null,
      b.end_client || '', b.site_name || '', b.site_address || '', b.lga || '',
      b.client_sector || '', joinMulti(b.service_streams),
      referralId, b.commercial_owner_id || null,
      b.received_date || sydneyToday(), b.expected_start_date || null,
      b.scope_summary || '', b.key_assumptions || '',
      b.capacity_flag ? 1 : 0, b.conflict_flag ? 1 : 0, b.risk_notes || '',
      overrideReason
    );

    if (referralId) {
      db.prepare('UPDATE referrals SET opportunity_id = ? WHERE id = ?').run(result.lastInsertRowid, referralId);
    }

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
        co.full_name as commercial_owner_name,
        cc.full_name as contact_name,
        cc.email as contact_email,
        cc.phone as contact_phone,
        cb.full_name as created_by_name
      FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id
      LEFT JOIN users u ON o.owner_id = u.id
      LEFT JOIN users co ON o.commercial_owner_id = co.id
      LEFT JOIN client_contacts cc ON o.contact_id = cc.id
      LEFT JOIN users cb ON o.created_by_id = cb.id
      WHERE o.id = ?
    `).get(req.params.id);

    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }

    // Linked referral (for the Referred By panel)
    const referral = opportunity.referral_id ? db.prepare(`
      SELECT r.*, rc.company_name AS referring_company, rcc.full_name AS referring_contact
      FROM referrals r
      LEFT JOIN clients rc ON r.referring_client_id = rc.id
      LEFT JOIN client_contacts rcc ON r.referring_contact_id = rcc.id
      WHERE r.id = ?
    `).get(opportunity.referral_id) : null;

    // Proposal revisions for this opportunity
    const proposals = db.prepare(`
      SELECT p.*, u.full_name AS prepared_by_name
      FROM proposals p LEFT JOIN users u ON p.prepared_by_id = u.id
      WHERE p.opportunity_id = ? ORDER BY p.revision DESC
    `).all(opportunity.id);

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
      currentPage: 'opportunities',
      opportunity,
      activities,
      relatedJob,
      referral,
      proposals,
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
      currentPage: 'opportunities',
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

    const newStage = b.stage || current.stage;

    // Stage gating (brief §6.3) — enforced on the edit path too, not just
    // the kanban, so a form save can't sidestep the Proposal Sent/Won gates.
    if (newStage !== current.stage) {
      const gate = validateStageTransition(db, current, newStage, b);
      if (!gate.ok) {
        req.flash('error', `Cannot move to ${newStage.replace(/_/g, ' ')}: ` + gate.errors.join(' '));
        return req.session.save(() => res.redirect('/opportunities/' + req.params.id + '/edit'));
      }
    }

    const estimatedValue = parseFloat(b.estimated_value) || 0;
    const stageDefault = defaultProbability(db, newStage);
    let probability = b.probability !== undefined && b.probability !== '' ? parseInt(b.probability) : (stageDefault !== null ? stageDefault : current.probability);
    if (isNaN(probability)) probability = current.probability;
    let overrideReason = current.probability_override_reason || '';
    if (stageDefault !== null && probability !== stageDefault) {
      overrideReason = b.probability_override_reason || overrideReason;
      if (!overrideReason) {
        req.flash('error', `Probability ${probability}% differs from the ${newStage} stage default (${stageDefault}%) — an override reason is required.`);
        return req.session.save(() => res.redirect('/opportunities/' + req.params.id + '/edit'));
      }
    } else if (stageDefault !== null && probability === stageDefault) {
      overrideReason = '';
    }
    const weightedValue = estimatedValue * probability / 100;

    // Stage drives status; the standalone status select can still park an
    // opportunity on hold or reopen it.
    let newStatus = b.status || 'open';
    if (newStage === 'won') newStatus = 'won';
    else if (newStage === 'lost') newStatus = 'lost';
    const todayStr = sydneyToday();
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
        won_date = ?, lost_date = ?,
        end_client = ?, site_name = ?, site_address = ?, lga = ?, client_sector = ?,
        service_streams = ?, commercial_owner_id = ?, received_date = ?, expected_start_date = ?,
        scope_summary = ?, key_assumptions = ?, capacity_flag = ?, conflict_flag = ?, risk_notes = ?,
        won_reason = ?, competitor = ?, probability_override_reason = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      b.title,
      b.client_id || null,
      b.contact_id || null,
      b.owner_id || null,
      b.service_type || '',
      newStage,
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
      b.end_client || '', b.site_name || '', b.site_address || '', b.lga || '',
      b.client_sector || '', joinMulti(b.service_streams),
      b.commercial_owner_id || null, b.received_date || current.received_date,
      b.expected_start_date || null,
      b.scope_summary || '', b.key_assumptions || '',
      b.capacity_flag ? 1 : 0, b.conflict_flag ? 1 : 0, b.risk_notes || '',
      b.won_reason || current.won_reason || '', b.competitor || current.competitor || '',
      overrideReason,
      req.params.id
    );

    syncReferralOutcome(db, current, newStatus);

    // If stage changed, log a CRM activity automatically
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

    // Stage gating (brief §6.3) — a blocked move returns 422 so the board
    // can toast the reasons and snap the card back.
    if (stage && stage !== opportunity.stage) {
      const gate = validateStageTransition(db, opportunity, stage, req.body);
      if (!gate.ok) {
        return res.status(422).json({ success: false, error: gate.errors.join(' '), errors: gate.errors });
      }
    }

    // Probability follows the target stage's default (§3.2) unless the
    // caller sends an explicit value (manual override path lives on the
    // edit form, where the reason is captured).
    const stageDefault = stage ? defaultProbability(db, stage) : null;
    let newProbability = probability !== undefined && probability !== '' ? parseInt(probability)
      : (stageDefault !== null ? stageDefault : opportunity.probability);
    if (isNaN(newProbability)) newProbability = opportunity.probability;
    const clearOverride = stageDefault !== null && newProbability === stageDefault;
    const weightedValue = opportunity.estimated_value * newProbability / 100;
    const todayStr = sydneyToday();

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
        won_date = ?, lost_date = ?,
        probability_override_reason = CASE WHEN ? THEN '' ELSE probability_override_reason END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(stage, newProbability, weightedValue, newStatus, wonDate, lostDate, clearOverride ? 1 : 0, req.params.id);

    syncReferralOutcome(db, opportunity, newStatus);

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

// ============================================================
// Won-to-project conversion (brief §3.4) — a CONTROLLED two-step flow:
// GET renders a review page (validation checklist + engagement details +
// package confirmation); POST re-validates and executes in ONE transaction.
// Non-negotiable rule: no CRM history is discarded — activities, proposals
// and referrals keep their opportunity FKs; the project links back via
// jobs.opportunity_id/proposal_id and opportunities.related_job_id.
// ============================================================

function conversionContext(db, oppId) {
  const opportunity = db.prepare(`
    SELECT o.*, c.company_name AS client_name
    FROM opportunities o
    LEFT JOIN clients c ON o.client_id = c.id
    WHERE o.id = ?
  `).get(oppId);
  if (!opportunity) return null;
  const acceptedProposal = db.prepare(`
    SELECT * FROM proposals WHERE opportunity_id = ? AND status = 'accepted' ORDER BY revision DESC LIMIT 1
  `).get(oppId);
  const proposalPackages = acceptedProposal
    ? db.prepare('SELECT * FROM proposal_service_packages WHERE proposal_id = ? ORDER BY display_order, id').all(acceptedProposal.id)
    : [];
  const contacts = opportunity.client_id
    ? db.prepare('SELECT id, full_name FROM client_contacts WHERE company_id = ? ORDER BY full_name').all(opportunity.client_id)
    : [];
  return { opportunity, acceptedProposal, proposalPackages, contacts };
}

function validateConversion(opportunity, acceptedProposal, b) {
  const errors = [];
  if (opportunity.status !== 'won') errors.push('The opportunity must be Won before conversion (move it to Won on the pipeline first).');
  if (opportunity.related_job_id) errors.push('This opportunity has already been converted.');
  if (!acceptedProposal) errors.push('An accepted proposal is required.');
  if (!opportunity.client_id) errors.push('The opportunity must be linked to a client organisation.');
  const fee = parseFloat(b && b.final_fee !== undefined ? b.final_fee : (acceptedProposal ? acceptedProposal.fee : opportunity.estimated_value));
  if (!(fee > 0)) errors.push('A final fee greater than $0 is required.');
  const start = (b && b.start_date) || opportunity.expected_start_date;
  if (!start) errors.push('An expected start date is required.');
  const director = b && b.project_manager_id;
  if (b && !director) errors.push('A Project Director is required.');
  return { errors, fee, start };
}

// Step 1 — review page.
router.get('/:id/convert', (req, res, next) => {
  try {
    const db = getDb();
    const ctx = conversionContext(db, req.params.id);
    if (!ctx) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }
    if (ctx.opportunity.related_job_id) {
      req.flash('error', 'This opportunity has already been converted.');
      return req.session.save(() => res.redirect('/opportunities/' + req.params.id));
    }
    const { errors } = validateConversion(ctx.opportunity, ctx.acceptedProposal, null);
    const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
    res.render('opportunities/convert', {
      title: 'Convert ' + ctx.opportunity.opportunity_number,
      currentPage: 'opportunities',
      opportunity: ctx.opportunity,
      acceptedProposal: ctx.acceptedProposal,
      proposalPackages: ctx.proposalPackages,
      contacts: ctx.contacts,
      users,
      gateErrors: errors,
    });
  } catch (err) { next(err); }
});

// Step 2 — execute.
router.post('/:id/convert', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const ctx = conversionContext(db, req.params.id);
    if (!ctx) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }
    const { opportunity, acceptedProposal, proposalPackages } = ctx;

    // 1. Re-validate server-side — any failure means ZERO writes.
    const { errors, fee, start } = validateConversion(opportunity, acceptedProposal, b);
    const includeIdx = [].concat(b.pkg_include || []).map(Number);
    const streams = [].concat(b.pkg_stream || []);
    if (!includeIdx.length || !streams.length) errors.push('At least one service package must be confirmed.');
    if (errors.length) {
      req.flash('error', 'Conversion blocked: ' + errors.join(' '));
      return req.session.save(() => res.redirect('/opportunities/' + req.params.id + '/convert'));
    }

    const scopes = [].concat(b.pkg_scope || []);
    const fees = [].concat(b.pkg_fee || []);
    const hours = [].concat(b.pkg_hours || []);
    const owners = [].concat(b.pkg_owner || []);
    const internalDues = [].concat(b.pkg_internal_due || []);
    const clientDues = [].concat(b.pkg_client_due || []);
    const pkgProposalIds = [].concat(b.pkg_proposal_package_id || []);

    const userId = req.session.user ? req.session.user.id : null;
    let newJobId, jobNumber;

    const convert = db.transaction(() => {
      // 2. ST-YY#### — collision-proof via ref_sequences.
      jobNumber = generateProjectNumber();

      // 3. Project record — copy the agreed commercial and site facts.
      const confirmedStreams = includeIdx.map(i => streams[i]).filter(Boolean);
      const streamsCsv = [...new Set(confirmedStreams)].join(',');
      const jobName = b.project_name || opportunity.site_name || opportunity.title;
      const jobResult = db.prepare(`
        INSERT INTO jobs (
          job_number, job_name, project_name, client, client_id, end_client,
          site_address, suburb, lga, status, stage, health, priority,
          start_date, client_deadline, contract_value, estimated_hours,
          project_manager_id, commercial_lead_id, technical_lead_id, checker_id,
          service_streams, notes, sharepoint_url, po_reference, po_status,
          opportunity_id, proposal_id, created_by_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'won', 'prestart', 'green', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        jobNumber, `${jobNumber} — ${jobName}`, jobName,
        opportunity.client_name || '', opportunity.client_id,
        b.end_client || opportunity.end_client || '',
        b.site_address || opportunity.site_address || '', b.suburb || '',
        b.lga || opportunity.lga || '',
        b.priority || 'normal',
        start, b.client_deadline || null,
        fee,
        includeIdx.reduce((sum, i) => sum + (parseFloat(hours[i]) || 0), 0) || null,
        b.project_manager_id,
        b.commercial_lead_id || null, b.technical_lead_id || null, b.checker_id || null,
        streamsCsv,
        opportunity.scope_summary || '',
        b.sharepoint_url || '', b.po_reference || '', b.po_reference ? 'received' : '',
        opportunity.id, acceptedProposal.id, userId
      );
      newJobId = jobResult.lastInsertRowid;

      // 4. Budget row — always exists for converted projects (register LEFT JOINs it).
      db.prepare('INSERT INTO job_budgets (job_id, contract_value) VALUES (?, ?)').run(newJobId, fee);

      // 5. Service packages from the confirmed rows.
      const insPkg = db.prepare(`
        INSERT INTO service_packages (package_ref, job_id, service_stream, scope, owner_id,
          fee_allocation, budget_hours, internal_due_date, client_due_date, proposal_package_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      includeIdx.forEach(i => {
        if (!streams[i]) return;
        insPkg.run(
          generateServicePackageRef(jobNumber, streams[i]), newJobId, streams[i],
          scopes[i] || '', owners[i] || null,
          parseFloat(fees[i]) || 0, parseFloat(hours[i]) || 0,
          internalDues[i] || null, clientDues[i] || null,
          pkgProposalIds[i] || null
        );
      });

      // 6. Canonical link back — nothing on the CRM side is deleted or moved.
      db.prepare('UPDATE opportunities SET related_job_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newJobId, opportunity.id);

      // 7. Client lifecycle transition + first engagement stamp.
      if (opportunity.client_id) {
        const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(opportunity.client_id);
        if (client) {
          const priorWon = db.prepare('SELECT COUNT(*) AS c FROM jobs WHERE client_id = ? AND id != ?').get(client.id, newJobId).c;
          const newStatus = priorWon > 0 ? 'repeat'
            : (['prospect', 'new_client'].includes(client.repeat_client_status) ? 'active_first_time' : client.repeat_client_status);
          db.prepare(`
            UPDATE clients SET repeat_client_status = ?,
              first_engagement_date = COALESCE(first_engagement_date, ?),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(newStatus, sydneyToday(), client.id);
        }
      }

      // 8. Referral attribution.
      if (opportunity.referral_id) {
        db.prepare("UPDATE referrals SET outcome = 'won', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(opportunity.referral_id);
      }

      // 9. Kickoff controls: a kickoff task for the director + CRM history entry.
      db.prepare(`
        INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, created_by)
        VALUES (?, 'management', ?, ?, ?, ?, 'not_started', 'high', 'one_off', ?)
      `).run(
        newJobId, `Project kickoff — ${jobNumber}`,
        `Confirm client inputs, standards, responsibilities, programme and QA requirements (lifecycle step 6). Converted from ${opportunity.opportunity_number}.`,
        b.project_manager_id, start, userId
      );
      db.prepare(`
        INSERT INTO crm_activities (activity_type, subject, notes, client_id, contact_id, opportunity_id,
          owner_id, activity_date, is_completed, created_by_id)
        VALUES ('follow_up', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
      `).run(
        `Converted to project ${jobNumber}`,
        `Fee $${fee.toLocaleString('en-AU')} · accepted proposal ${acceptedProposal.proposal_ref}`,
        opportunity.client_id, b.primary_contact_id || opportunity.contact_id || null, opportunity.id,
        userId, userId
      );
    });
    convert();

    logActivity({
      user: req.session.user, action: 'create', entityType: 'job',
      entityId: newJobId, entityLabel: jobNumber, jobId: newJobId, jobNumber,
      details: `Converted from opportunity ${opportunity.opportunity_number} (proposal ${acceptedProposal.proposal_ref})`,
      ip: req.ip,
    });
    logActivity({
      user: req.session.user, action: 'update', entityType: 'opportunity',
      entityId: parseInt(req.params.id), entityLabel: opportunity.opportunity_number,
      details: `Converted to project ${jobNumber}`, ip: req.ip,
    });

    req.flash('success', `Project ${jobNumber} created — CRM history preserved and linked.`);
    req.session.save(() => res.redirect('/jobs/' + newJobId));
  } catch (err) {
    console.error('Conversion error:', err);
    req.flash('error', 'Conversion failed (no changes were saved): ' + err.message);
    req.session.save(() => res.redirect('/opportunities/' + req.params.id + '/convert'));
  }
});

module.exports = router;
