// lib/reviews.js
// Shared employee-review write helpers. Extracted verbatim from the inline
// INSERT in routes/hr.js POST /hr/employees/:id/reviews so that BOTH the HR
// module and the safety-audit per-person tagging write-back use one path.
//
// Backs the employee_reviews table (migration 231):
//   kind       'note' | 'review'        ("Quick note" vs "Performance review")
//   visibility 'internal' | 'worker'    ("Internal-only" vs "Share-to-worker")
// Both are coerced here to match the CHECK constraints.

function coerceKind(kind) {
  return kind === 'review' ? 'review' : 'note';
}

function coerceVisibility(visibility) {
  return visibility === 'worker' ? 'worker' : 'internal';
}

/**
 * Insert an employee review/note. Returns the new row id.
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 */
function createEmployeeReview(db, {
  employeeId,
  kind = 'note',
  title = '',
  summary = '',
  reviewDate = null,
  heldBy = '',
  visibility = 'internal',
  sections = [],
  peerComments = [],
  createdById = null,
} = {}) {
  const k = coerceKind(kind);
  const vis = coerceVisibility(visibility);
  const t = (title || '').trim() || (k === 'review' ? 'Performance review' : 'Note');
  const info = db.prepare(`
    INSERT INTO employee_reviews
      (employee_id, kind, title, summary, review_date, held_by, visibility,
       sections_json, peer_comments_json, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    employeeId, k, t, (summary || '').trim(), (reviewDate || null), (heldBy || '').trim(), vis,
    JSON.stringify(sections || []), JSON.stringify(peerComments || []),
    createdById
  );
  return info.lastInsertRowid;
}

/**
 * Idempotent re-sync target — update an existing review in place (used by the
 * audit write-back when a tag already has a linked review, so editing &
 * re-submitting an audit mutates the same review rather than duplicating it).
 * Only the fields provided are changed; others are left untouched.
 */
function updateEmployeeReview(db, reviewId, {
  kind,
  title,
  summary,
  visibility,
  sections,
  peerComments,
} = {}) {
  const sets = [];
  const params = [];
  if (kind !== undefined) { sets.push('kind = ?'); params.push(coerceKind(kind)); }
  if (title !== undefined) { sets.push('title = ?'); params.push((title || '').trim()); }
  if (summary !== undefined) { sets.push('summary = ?'); params.push((summary || '').trim()); }
  if (visibility !== undefined) { sets.push('visibility = ?'); params.push(coerceVisibility(visibility)); }
  if (sections !== undefined) { sets.push('sections_json = ?'); params.push(JSON.stringify(sections || [])); }
  if (peerComments !== undefined) { sets.push('peer_comments_json = ?'); params.push(JSON.stringify(peerComments || [])); }
  if (!sets.length) return;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  params.push(reviewId);
  db.prepare(`UPDATE employee_reviews SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

module.exports = { createEmployeeReview, updateEmployeeReview };
