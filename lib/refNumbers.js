/**
 * Centralised Sightline reference generation (brief §2.4).
 *
 * Formats:
 *   Organisation     ORG-000123           global sequence
 *   Contact          CON-000456           global sequence
 *   Opportunity      OPP-260187           year-scoped sequence (YY + 4 digits)
 *   Project          ST-260041            year-scoped sequence (YY + 4 digits)
 *   Proposal         PROP-260187-02       opportunity number + revision
 *   Service package  ST-260041-DEV-01     project number + stream + sequence
 *
 * Sequences live in ref_sequences (scope TEXT PK, last_number INTEGER),
 * one row per scope; year-scoped formats use a per-year scope
 * ('opp:26') so the counter resets naturally each January.
 *
 * Self-healing (same contract as lib/jobNumbers.js): if the sequence has
 * fallen out of sync with the target table (DB import/restore, rolled-back
 * transaction that consumed a bump), we keep bumping until we land on an
 * unused number, bounded so a corrupted sequence can't spin forever.
 * Every target column carries a UNIQUE (or partial unique) index as the
 * final backstop.
 *
 * All statements run on the shared better-sqlite3 connection, so calls
 * participate in the caller's transaction.
 */
const { getDb } = require('../db/database');
const { sydneyToday } = require('./sydney');

// Two-digit Sydney year — OPP/ST numbers must roll over on AEST midnight
// Jan 1, not UTC (the container clock is UTC on Railway).
function sydneyYY(date) {
  return sydneyToday(date).slice(2, 4);
}

/**
 * Allocate the next reference for a scope.
 * @param {string} scope        ref_sequences key, e.g. 'org' or 'opp:26'
 * @param {(n:number)=>string} format   number -> candidate string
 * @param {(candidate:string)=>boolean} exists  true if candidate is taken
 */
function nextRef(scope, format, exists) {
  const db = getDb();
  db.prepare('INSERT OR IGNORE INTO ref_sequences (scope, last_number) VALUES (?, 0)').run(scope);
  const bump = db.prepare('UPDATE ref_sequences SET last_number = last_number + 1 WHERE scope = ?');
  const peek = db.prepare('SELECT last_number FROM ref_sequences WHERE scope = ?');

  for (let i = 0; i < 10000; i++) {
    bump.run(scope);
    const candidate = format(peek.get(scope).last_number);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a free reference for scope "${scope}" after 10000 attempts — check ref_sequences`);
}

// ORG-000123
function generateOrgRef() {
  const db = getDb();
  const used = db.prepare('SELECT 1 FROM clients WHERE org_ref = ?');
  return nextRef('org', n => 'ORG-' + String(n).padStart(6, '0'), c => !!used.get(c));
}

// CON-000456
function generateContactRef() {
  const db = getDb();
  const used = db.prepare('SELECT 1 FROM client_contacts WHERE contact_ref = ?');
  return nextRef('contact', n => 'CON-' + String(n).padStart(6, '0'), c => !!used.get(c));
}

// OPP-260187
function generateOpportunityRef(date) {
  const db = getDb();
  const yy = sydneyYY(date);
  const used = db.prepare('SELECT 1 FROM opportunities WHERE opportunity_number = ?');
  return nextRef('opp:' + yy, n => 'OPP-' + yy + String(n).padStart(4, '0'), c => !!used.get(c));
}

// ST-260041
function generateProjectNumber(date) {
  const db = getDb();
  const yy = sydneyYY(date);
  const used = db.prepare('SELECT 1 FROM jobs WHERE job_number = ?');
  return nextRef('project:' + yy, n => 'ST-' + yy + String(n).padStart(4, '0'), c => !!used.get(c));
}

/**
 * PROP-260187-02 — no sequence table: the revision is MAX(revision)+1 for
 * the opportunity, and the ref embeds the opportunity's own number
 * (sans 'OPP-' prefix). proposals.proposal_ref UNIQUE backstops races.
 * @param {{id:number, opportunity_number:string}} opportunity
 * @returns {{ref:string, revision:number}}
 */
function generateProposalRef(opportunity) {
  const db = getDb();
  const base = String(opportunity.opportunity_number || '').replace(/^OPP-/, '');
  const row = db.prepare('SELECT MAX(revision) AS maxRev FROM proposals WHERE opportunity_id = ?').get(opportunity.id);
  let rev = (row && Number.isFinite(row.maxRev) ? row.maxRev : 0) + 1;
  const used = db.prepare('SELECT 1 FROM proposals WHERE proposal_ref = ?');
  for (let i = 0; i < 1000; i++) {
    const candidate = `PROP-${base}-${String(rev).padStart(2, '0')}`;
    if (!used.get(candidate)) return { ref: candidate, revision: rev };
    rev++;
  }
  throw new Error(`Could not allocate a proposal ref for opportunity ${opportunity.opportunity_number}`);
}

/**
 * Generic per-(job, prefix) child allocator: {jobNumber}-{PREFIX}-{NN...}.
 * Max existing suffix + 1, scanned from the target table; the column's
 * UNIQUE index backstops races.
 */
function nextChildRef(table, column, jobNumber, prefixKey, pad) {
  const db = getDb();
  const prefix = `${jobNumber}-${prefixKey}-`;
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(${column}, ?) AS INTEGER)) AS maxSeq
    FROM ${table}
    WHERE ${column} LIKE ? AND SUBSTR(${column}, ?) GLOB '[0-9]*'
  `).get(prefix.length + 1, prefix + '%', prefix.length + 1);
  let seq = (row && Number.isFinite(row.maxSeq) ? row.maxSeq : 0) + 1;
  const used = db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`);
  for (let i = 0; i < 1000; i++) {
    const candidate = prefix + String(seq).padStart(pad, '0');
    if (!used.get(candidate)) return candidate;
    seq++;
  }
  throw new Error(`Could not allocate a ref under ${prefix}`);
}

/**
 * ST-260041-DEV-01 — sequence scoped to (job, stream): max existing suffix
 * for that pair + 1. service_packages.package_ref UNIQUE backstops.
 * @param {string} jobNumber   e.g. 'ST-260041'
 * @param {string} stream      'DEV' | 'PAS' | 'MOD' | 'CON' | 'APR'
 */
function generateServicePackageRef(jobNumber, stream) {
  return nextChildRef('service_packages', 'package_ref', jobNumber, String(stream || '').toUpperCase(), 2);
}

// Deliverable doc types map 1:1 to the §4.2 ref prefixes — deliberately
// hardcoded (a data-driven vocabulary would invite prefix drift).
const DOC_TYPES = {
  report: 'RPT',
  drawing: 'DRG',
  letter: 'LTR',
  calculation: 'CAL',
  model: 'MOD',
};

// ST-260041-RPT-001
function generateDeliverableRef(jobNumber, docType) {
  const prefixKey = DOC_TYPES[docType];
  if (!prefixKey) throw new Error(`Unknown deliverable type "${docType}"`);
  return nextChildRef('deliverables', 'deliverable_ref', jobNumber, prefixKey, 3);
}

// ST-260041-APR-001
function generateApprovalRef(jobNumber) {
  return nextChildRef('approvals', 'approval_ref', jobNumber, 'APR', 3);
}

// ST-260041-VAR-01
function generateVariationRef(jobNumber) {
  return nextChildRef('variations', 'variation_ref', jobNumber, 'VAR', 2);
}

// ST-260041-COR-001
function generateCorrespondenceRef(jobNumber) {
  return nextChildRef('correspondence', 'corr_ref', jobNumber, 'COR', 3);
}

module.exports = {
  nextRef,
  generateOrgRef,
  generateContactRef,
  generateOpportunityRef,
  generateProjectNumber,
  generateProposalRef,
  generateServicePackageRef,
  DOC_TYPES,
  generateDeliverableRef,
  generateApprovalRef,
  generateVariationRef,
  generateCorrespondenceRef,
};
