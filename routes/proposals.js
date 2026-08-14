// Proposals (brief §3.1) — the controlled commercial offer linked to an
// opportunity. PROP-{opp#}-{rev} with a supersession chain; status is
// app-enforced: draft | sent | accepted | declined | superseded | withdrawn.
// Lifecycle endpoints: /send (starts the follow-up clock and advances the
// opportunity to Proposal Sent), /revise (clone as rev+1, supersede),
// /accept, /decline.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateProposalRef } = require('../lib/refNumbers');
const { defaultProbability } = require('../lib/crmStages');
const { sydneyToday } = require('../lib/sydney');

const STATUS_OPEN = ['draft', 'sent'];

function loadProposal(db, id) {
  return db.prepare(`
    SELECT p.*,
      o.opportunity_number, o.title AS opp_title, o.stage AS opp_stage, o.status AS opp_status,
      c.company_name AS client_name,
      cc.full_name AS contact_name,
      up.full_name AS prepared_by_name,
      ua.full_name AS approved_by_name
    FROM proposals p
    JOIN opportunities o ON p.opportunity_id = o.id
    LEFT JOIN clients c ON p.client_id = c.id
    LEFT JOIN client_contacts cc ON p.contact_id = cc.id
    LEFT JOIN users up ON p.prepared_by_id = up.id
    LEFT JOIN users ua ON p.approved_by_id = ua.id
    WHERE p.id = ?
  `).get(id);
}

function loadPackages(db, proposalId) {
  return db.prepare('SELECT * FROM proposal_service_packages WHERE proposal_id = ? ORDER BY display_order, id').all(proposalId);
}

// Replace a proposal's package rows from parallel form arrays.
function savePackages(db, proposalId, b) {
  db.prepare('DELETE FROM proposal_service_packages WHERE proposal_id = ?').run(proposalId);
  const streams = [].concat(b.pkg_stream || []);
  const scopes = [].concat(b.pkg_scope || []);
  const fees = [].concat(b.pkg_fee || []);
  const hours = [].concat(b.pkg_hours || []);
  const ins = db.prepare(`
    INSERT INTO proposal_service_packages (proposal_id, service_stream, scope, fee_allocation, budget_hours, display_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let order = 0;
  streams.forEach((stream, i) => {
    if (!stream) return;
    ins.run(proposalId, stream, scopes[i] || '', parseFloat(fees[i]) || 0, parseFloat(hours[i]) || 0, order++);
  });
}

// Register
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { status, search } = req.query;
    let where = [];
    const params = [];
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (search) {
      where.push('(p.proposal_ref LIKE ? OR o.title LIKE ? OR c.company_name LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s);
    }
    const proposals = db.prepare(`
      SELECT p.*, o.opportunity_number, o.title AS opp_title, c.company_name AS client_name,
        u.full_name AS prepared_by_name
      FROM proposals p
      JOIN opportunities o ON p.opportunity_id = o.id
      LEFT JOIN clients c ON p.client_id = c.id
      LEFT JOIN users u ON p.prepared_by_id = u.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.updated_at DESC
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
        COALESCE(SUM(CASE WHEN status = 'sent' THEN fee ELSE 0 END), 0) AS awaiting_value
      FROM proposals
    `).get();

    res.render('proposals/index', {
      title: 'Proposals',
      currentPage: 'proposals',
      proposals,
      stats,
      filters: { status, search },
    });
  } catch (err) { next(err); }
});

// New proposal — always born from an opportunity.
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    const oppId = req.query.opportunity_id;
    if (!oppId) {
      req.flash('error', 'Start a proposal from its opportunity (brief §3.1 — proposals belong to opportunities).');
      return req.session.save(() => res.redirect('/opportunities'));
    }
    const opportunity = db.prepare(`
      SELECT o.*, c.company_name AS client_name FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id WHERE o.id = ?
    `).get(oppId);
    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }
    res.render('proposals/form', {
      title: 'New Proposal — ' + opportunity.opportunity_number,
      currentPage: 'proposals',
      proposal: null,
      packages: [],
      opportunity,
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      contacts: db.prepare('SELECT id, full_name FROM client_contacts WHERE company_id = ? OR ? IS NULL ORDER BY full_name').all(opportunity.client_id, opportunity.client_id),
    });
  } catch (err) { next(err); }
});

// Create
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(b.opportunity_id);
    if (!opportunity) {
      req.flash('error', 'Opportunity not found.');
      return req.session.save(() => res.redirect('/opportunities'));
    }
    const { ref, revision } = generateProposalRef(opportunity);
    const create = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO proposals (proposal_ref, opportunity_id, revision, client_id, contact_id,
          issue_date, prepared_by_id, approved_by_id, scope, deliverables, assumptions, exclusions,
          programme, fee, payment_terms, validity_days, expected_start_date, sharepoint_url,
          status, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
      `).run(
        ref, opportunity.id, revision, opportunity.client_id || null, b.contact_id || opportunity.contact_id || null,
        b.issue_date || sydneyToday(), b.prepared_by_id || (req.session.user ? req.session.user.id : null),
        b.approved_by_id || null, b.scope || '', b.deliverables || '', b.assumptions || '', b.exclusions || '',
        b.programme || '', parseFloat(b.fee) || 0, b.payment_terms || '', parseInt(b.validity_days) || 30,
        b.expected_start_date || opportunity.expected_start_date || null, b.sharepoint_url || '',
        req.session.user ? req.session.user.id : null
      );
      savePackages(db, result.lastInsertRowid, b);
      return result.lastInsertRowid;
    });
    const id = create();
    logActivity({
      user: req.session.user, action: 'create', entityType: 'proposal',
      entityId: id, entityLabel: ref, ip: req.ip,
    });
    req.flash('success', `Proposal ${ref} created as a draft.`);
    req.session.save(() => res.redirect('/proposals/' + id));
  } catch (err) {
    req.flash('error', 'Failed to create proposal: ' + err.message);
    req.session.save(() => res.redirect(b.opportunity_id ? '/proposals/new?opportunity_id=' + b.opportunity_id : '/proposals'));
  }
});

// Detail
router.get('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const proposal = loadProposal(db, req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    const packages = loadPackages(db, proposal.id);
    const revisions = db.prepare(`
      SELECT id, proposal_ref, revision, status, sent_date, fee FROM proposals
      WHERE opportunity_id = ? ORDER BY revision DESC
    `).all(proposal.opportunity_id);
    const trail = db.prepare(`
      SELECT al.*, u.full_name AS user_name FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE al.entity_type = 'proposal' AND al.entity_id = ?
      ORDER BY al.created_at DESC LIMIT 20
    `).all(proposal.id);
    res.render('proposals/show', {
      title: proposal.proposal_ref,
      currentPage: 'proposals',
      proposal,
      packages,
      revisions,
      trail,
    });
  } catch (err) { next(err); }
});

// Edit form — drafts only (issued documents are revised, not edited).
router.get('/:id/edit', (req, res, next) => {
  try {
    const db = getDb();
    const proposal = loadProposal(db, req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    if (proposal.status !== 'draft') {
      req.flash('error', `${proposal.proposal_ref} is ${proposal.status} — create a revision instead of editing an issued proposal.`);
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    const opportunity = db.prepare(`
      SELECT o.*, c.company_name AS client_name FROM opportunities o
      LEFT JOIN clients c ON o.client_id = c.id WHERE o.id = ?
    `).get(proposal.opportunity_id);
    res.render('proposals/form', {
      title: 'Edit ' + proposal.proposal_ref,
      currentPage: 'proposals',
      proposal,
      packages: loadPackages(db, proposal.id),
      opportunity,
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      contacts: db.prepare('SELECT id, full_name FROM client_contacts WHERE company_id = ? OR ? IS NULL ORDER BY full_name').all(opportunity.client_id, opportunity.client_id),
    });
  } catch (err) { next(err); }
});

// Update — drafts only.
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    if (proposal.status !== 'draft') {
      req.flash('error', 'Issued proposals cannot be edited — create a revision.');
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    const update = db.transaction(() => {
      db.prepare(`
        UPDATE proposals SET contact_id=?, issue_date=?, prepared_by_id=?, approved_by_id=?,
          scope=?, deliverables=?, assumptions=?, exclusions=?, programme=?, fee=?,
          payment_terms=?, validity_days=?, expected_start_date=?, sharepoint_url=?,
          updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).run(
        b.contact_id || null, b.issue_date || null, b.prepared_by_id || null, b.approved_by_id || null,
        b.scope || '', b.deliverables || '', b.assumptions || '', b.exclusions || '', b.programme || '',
        parseFloat(b.fee) || 0, b.payment_terms || '', parseInt(b.validity_days) || 30,
        b.expected_start_date || null, b.sharepoint_url || '', req.params.id
      );
      savePackages(db, proposal.id, b);
    });
    update();
    logActivity({
      user: req.session.user, action: 'update', entityType: 'proposal',
      entityId: proposal.id, entityLabel: proposal.proposal_ref, ip: req.ip,
    });
    req.flash('success', 'Proposal updated.');
    req.session.save(() => res.redirect('/proposals/' + proposal.id));
  } catch (err) {
    req.flash('error', 'Failed to update proposal: ' + err.message);
    req.session.save(() => res.redirect('/proposals/' + req.params.id + '/edit'));
  }
});

// Mark sent — starts the follow-up clock (§3.6) and advances the
// opportunity to Proposal Sent so the §6.3 gate holds by construction.
router.post('/:id/send', (req, res) => {
  const db = getDb();
  try {
    const proposal = loadProposal(db, req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    if (proposal.status !== 'draft') {
      req.flash('error', `${proposal.proposal_ref} is already ${proposal.status}.`);
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    const followUp = req.body.follow_up_date;
    if (!followUp) {
      req.flash('error', 'A follow-up date is required when marking a proposal sent (brief §3.6).');
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    if (!(proposal.fee > 0)) {
      req.flash('error', 'A fee is required before the proposal can be sent.');
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    const today = sydneyToday();
    const send = db.transaction(() => {
      db.prepare(`
        UPDATE proposals SET status='sent', sent_date=?, follow_up_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(today, followUp, proposal.id);
      // Dated follow-up action on the opportunity (§3.6).
      db.prepare(`
        INSERT INTO crm_activities (activity_type, subject, notes, client_id, contact_id, opportunity_id,
          owner_id, activity_date, next_step, next_step_due_date, is_completed, created_by_id)
        VALUES ('proposal_sent', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, 0, ?)
      `).run(
        `Proposal ${proposal.proposal_ref} sent`,
        `Fee $${(proposal.fee || 0).toLocaleString('en-AU')} · follow up by ${followUp}`,
        proposal.client_id || null, proposal.contact_id || null, proposal.opportunity_id,
        req.session.user ? req.session.user.id : null,
        `Follow up proposal ${proposal.proposal_ref}`, followUp,
        req.session.user ? req.session.user.id : null
      );
      // Advance the opportunity to Proposal Sent (stage default probability).
      const opp = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(proposal.opportunity_id);
      if (opp && opp.status === 'open' && opp.stage !== 'proposal_sent') {
        const prob = defaultProbability(db, 'proposal_sent');
        const probability = prob !== null ? prob : opp.probability;
        db.prepare(`
          UPDATE opportunities SET stage='proposal_sent', probability=?, weighted_value=?,
            next_step=?, next_step_due_date=?, probability_override_reason='', updated_at=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(probability, (opp.estimated_value || 0) * probability / 100,
          `Follow up proposal ${proposal.proposal_ref}`, followUp, opp.id);
      }
    });
    send();
    logActivity({
      user: req.session.user, action: 'update', entityType: 'proposal',
      entityId: proposal.id, entityLabel: proposal.proposal_ref,
      details: `Marked sent, follow-up ${followUp}`, ip: req.ip,
    });
    req.flash('success', `${proposal.proposal_ref} marked sent — follow-up set for ${followUp}.`);
    req.session.save(() => res.redirect('/proposals/' + proposal.id));
  } catch (err) {
    req.flash('error', 'Failed to mark sent: ' + err.message);
    req.session.save(() => res.redirect('/proposals/' + req.params.id));
  }
});

// Revise — clone as revision+1, supersede this one.
router.post('/:id/revise', (req, res) => {
  const db = getDb();
  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    const opportunity = db.prepare('SELECT * FROM opportunities WHERE id = ?').get(proposal.opportunity_id);
    const { ref, revision } = generateProposalRef(opportunity);
    const revise = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO proposals (proposal_ref, opportunity_id, revision, client_id, contact_id,
          issue_date, prepared_by_id, approved_by_id, scope, deliverables, assumptions, exclusions,
          programme, fee, payment_terms, validity_days, expected_start_date, sharepoint_url,
          status, supersedes_id, created_by_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(
        ref, proposal.opportunity_id, revision, proposal.client_id, proposal.contact_id,
        sydneyToday(), req.session.user ? req.session.user.id : proposal.prepared_by_id, proposal.approved_by_id,
        proposal.scope, proposal.deliverables, proposal.assumptions, proposal.exclusions,
        proposal.programme, proposal.fee, proposal.payment_terms, proposal.validity_days,
        proposal.expected_start_date, proposal.sharepoint_url,
        proposal.id, req.session.user ? req.session.user.id : null
      );
      const newId = result.lastInsertRowid;
      const copy = db.prepare(`
        INSERT INTO proposal_service_packages (proposal_id, service_stream, scope, fee_allocation, budget_hours, display_order)
        SELECT ?, service_stream, scope, fee_allocation, budget_hours, display_order
        FROM proposal_service_packages WHERE proposal_id = ?
      `);
      copy.run(newId, proposal.id);
      if (STATUS_OPEN.includes(proposal.status)) {
        db.prepare("UPDATE proposals SET status='superseded', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(proposal.id);
      }
      return newId;
    });
    const newId = revise();
    logActivity({
      user: req.session.user, action: 'create', entityType: 'proposal',
      entityId: newId, entityLabel: ref, details: `Revision of ${proposal.proposal_ref}`, ip: req.ip,
    });
    req.flash('success', `Revision ${ref} created as a draft${STATUS_OPEN.includes(proposal.status) ? ` — ${proposal.proposal_ref} superseded` : ''}.`);
    req.session.save(() => res.redirect('/proposals/' + newId + '/edit'));
  } catch (err) {
    req.flash('error', 'Failed to revise proposal: ' + err.message);
    req.session.save(() => res.redirect('/proposals/' + req.params.id));
  }
});

// Accept / decline — the client's decision on a sent proposal.
router.post('/:id/accept', (req, res) => decide(req, res, 'accepted'));
router.post('/:id/decline', (req, res) => decide(req, res, 'declined'));

function decide(req, res, outcome) {
  const db = getDb();
  try {
    const proposal = loadProposal(db, req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    if (proposal.status !== 'sent') {
      req.flash('error', `Only a sent proposal can be ${outcome} — ${proposal.proposal_ref} is ${proposal.status}.`);
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    db.prepare(`
      UPDATE proposals SET status=?, client_response=?, acceptance_reference=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).run(outcome, req.body.client_response || '', outcome === 'accepted' ? (req.body.acceptance_reference || '') : '', proposal.id);
    db.prepare(`
      INSERT INTO crm_activities (activity_type, subject, notes, client_id, contact_id, opportunity_id,
        owner_id, activity_date, is_completed, created_by_id)
      VALUES ('follow_up', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 1, ?)
    `).run(
      `Proposal ${proposal.proposal_ref} ${outcome}`,
      req.body.client_response || '',
      proposal.client_id || null, proposal.contact_id || null, proposal.opportunity_id,
      req.session.user ? req.session.user.id : null,
      req.session.user ? req.session.user.id : null
    );
    logActivity({
      user: req.session.user, action: outcome === 'accepted' ? 'approve' : 'reject',
      entityType: 'proposal', entityId: proposal.id, entityLabel: proposal.proposal_ref,
      details: req.body.acceptance_reference ? `Reference: ${req.body.acceptance_reference}` : '', ip: req.ip,
    });
    req.flash('success', `${proposal.proposal_ref} marked ${outcome}.`);
    req.session.save(() => res.redirect(outcome === 'accepted' ? '/opportunities/' + proposal.opportunity_id : '/proposals/' + proposal.id));
  } catch (err) {
    req.flash('error', `Failed to mark ${outcome}: ` + err.message);
    req.session.save(() => res.redirect('/proposals/' + req.params.id));
  }
}

// Delete — drafts only.
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  try {
    const proposal = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
    if (!proposal) {
      req.flash('error', 'Proposal not found.');
      return req.session.save(() => res.redirect('/proposals'));
    }
    if (proposal.status !== 'draft') {
      req.flash('error', 'Only draft proposals can be deleted — issued documents stay in the record.');
      return req.session.save(() => res.redirect('/proposals/' + proposal.id));
    }
    db.prepare('DELETE FROM proposal_service_packages WHERE proposal_id = ?').run(proposal.id);
    db.prepare('UPDATE proposals SET supersedes_id = NULL WHERE supersedes_id = ?').run(proposal.id);
    db.prepare('DELETE FROM proposals WHERE id = ?').run(proposal.id);
    logActivity({
      user: req.session.user, action: 'delete', entityType: 'proposal',
      entityId: parseInt(req.params.id), entityLabel: proposal.proposal_ref, ip: req.ip,
    });
    req.flash('success', `${proposal.proposal_ref} deleted.`);
    req.session.save(() => res.redirect('/proposals'));
  } catch (err) {
    req.flash('error', 'Failed to delete proposal: ' + err.message);
    req.session.save(() => res.redirect('/proposals/' + req.params.id));
  }
});

module.exports = router;
