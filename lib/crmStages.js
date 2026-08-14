/**
 * Sightline CRM stage logic (brief §3.2–3.3, §6.3).
 *
 * The stage LIST is data (app_settings category 'opportunity_stages',
 * editable at /settings, default probability in each row's metadata JSON).
 * The GATES are code, keyed on the two stage keys the brief hard-requires:
 * 'proposal_sent' and 'won'. Renaming labels/adding stages at /settings is
 * safe; the 'won' and 'lost' keys must never be renamed — opportunity
 * status derivation depends on them (routes/opportunities.js).
 */
const STAGE_CATEGORY = 'opportunity_stages';

// Stage rows with parsed metadata, active first, in display order.
function getStages(db) {
  const rows = db.prepare(`
    SELECT key, label, color, display_order, is_active, metadata
    FROM app_settings
    WHERE category = ? AND is_active = 1
    ORDER BY display_order, id
  `).all(STAGE_CATEGORY);
  return rows.map(r => {
    let meta = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch (e) { /* tolerate bad JSON */ }
    return { ...r, probability: Number.isFinite(meta.probability) ? meta.probability : null };
  });
}

// Default probability for a stage key, or null if the stage carries none.
function defaultProbability(db, stageKey) {
  const stage = getStages(db).find(s => s.key === stageKey);
  return stage ? stage.probability : null;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// Latest non-superseded proposal for an opportunity (null-safe before the
// proposals migration lands).
function currentProposal(db, opportunityId) {
  if (!tableExists(db, 'proposals')) return null;
  return db.prepare(`
    SELECT * FROM proposals
    WHERE opportunity_id = ? AND status NOT IN ('superseded','withdrawn')
    ORDER BY revision DESC LIMIT 1
  `).get(opportunityId) || null;
}

/**
 * Validate a stage transition per brief §6.3.
 * @param {object} db        better-sqlite3 connection
 * @param {object} opp       current opportunities row
 * @param {string} newStage  target stage key
 * @param {object} [payload] pending form values (may override opp fields)
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateStageTransition(db, opp, newStage, payload = {}) {
  const errors = [];
  const val = (field) => payload[field] !== undefined && payload[field] !== '' ? payload[field] : opp[field];

  if (newStage === 'proposal_sent') {
    const proposal = currentProposal(db, opp.id);
    if (!proposal) {
      errors.push('A proposal must be created for this opportunity first.');
    } else if (proposal.status === 'draft' || !proposal.sent_date) {
      errors.push(`Proposal ${proposal.proposal_ref} has not been marked as sent.`);
    }
    if (!(parseFloat(val('estimated_value')) > 0)) errors.push('An expected value is required.');
    if (!val('owner_id')) errors.push('A relationship owner is required.');
    if (!val('next_step_due_date') && !(proposal && proposal.follow_up_date)) {
      errors.push('A follow-up date is required (set a next action or a proposal follow-up date).');
    }
  }

  if (newStage === 'won') {
    const proposal = currentProposal(db, opp.id);
    if (!(parseFloat(val('estimated_value')) > 0)) errors.push('A final value is required.');
    if (proposal && proposal.status !== 'accepted') {
      errors.push(`Proposal ${proposal.proposal_ref} must be marked accepted before the opportunity is won.`);
    }
    if (!proposal) errors.push('An accepted proposal is required before the opportunity is won.');
    if (!val('expected_start_date')) errors.push('An expected start date is required.');
    if (!val('owner_id')) errors.push('A relationship owner is required.');
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { STAGE_CATEGORY, getStages, defaultProbability, currentProposal, validateStageTransition };
