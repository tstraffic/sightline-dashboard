/**
 * Deliverable status projection (brief §5.3/§5.6) — clones the
 * lib/planStatus.js sync shape.
 *
 * A deliverable's status is a CACHED PROJECTION of its current revision
 * (current = MAX(id); revision labels like A/B/0/1 don't sort) plus the
 * issue register:
 *   - manual terminal states ('closed' | 'superseded') are never overridden
 *   - a document_issues row against the current revision  → 'issued'
 *   - else the revision's QA state maps: draft → draft,
 *     prepared|checked → in_qa, approved → approved
 *   - no revisions at all → 'draft'
 *
 * Creating a new revision supersedes all priors and drops the deliverable
 * back to 'draft' — the issue register still shows what the old revision
 * was issued as, which is exactly the §5.5 audit requirement.
 */

const DELIVERABLE_STATUSES = ['draft', 'in_qa', 'approved', 'issued', 'superseded', 'closed'];
const REVISION_STATUSES = ['draft', 'prepared', 'checked', 'approved', 'superseded'];

function mapRevisionToDeliverableStatus(rev) {
  if (!rev) return 'draft';
  if (rev.status === 'prepared' || rev.status === 'checked') return 'in_qa';
  if (rev.status === 'approved') return 'approved';
  return 'draft';
}

/**
 * Recompute + persist the deliverable's cached status. Returns the new
 * status, or null when the deliverable doesn't exist. Safe inside the
 * caller's transaction (shared connection).
 */
function syncDeliverableStatus(db, deliverableId) {
  const deliverable = db.prepare('SELECT id, status FROM deliverables WHERE id = ?').get(deliverableId);
  if (!deliverable) return null;
  // Manual terminal states stick until explicitly reopened.
  if (deliverable.status === 'closed' || deliverable.status === 'superseded') return deliverable.status;

  const currentRev = db.prepare(
    'SELECT * FROM deliverable_revisions WHERE deliverable_id = ? ORDER BY id DESC LIMIT 1'
  ).get(deliverableId);

  let status;
  if (currentRev && db.prepare('SELECT 1 FROM document_issues WHERE revision_id = ?').get(currentRev.id)) {
    status = 'issued';
  } else {
    status = mapRevisionToDeliverableStatus(currentRev);
  }
  db.prepare('UPDATE deliverables SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, deliverableId);
  return status;
}

/**
 * Suggest the next revision label: A→B, 0→1, Rev C→Rev D style is NOT
 * attempted (labels are free text; only bare letters and bare integers
 * get a suggestion — engineers flip A/B/C → 0/1/2 at For Construction).
 */
function suggestNextRevisionLabel(lastLabel) {
  if (!lastLabel) return 'A';
  const s = String(lastLabel).trim();
  if (/^[A-Y]$/i.test(s)) return String.fromCharCode(s.toUpperCase().charCodeAt(0) + 1);
  if (/^\d+$/.test(s)) return String(parseInt(s, 10) + 1);
  return '';
}

module.exports = {
  DELIVERABLE_STATUSES,
  REVISION_STATUSES,
  mapRevisionToDeliverableStatus,
  syncDeliverableStatus,
  suggestNextRevisionLabel,
};
