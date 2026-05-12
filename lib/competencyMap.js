// Maps employee_documents.document_type → employee_competencies fields.
//
// The office uploads licence / ticket files into employee_documents from
// multiple entry points (induction approval, manual HR upload). For some
// document types the file alone isn't enough — compliance tracking,
// expiry alerts and the worker wallet's certifications list all read from
// employee_competencies, so we mirror those uploads into a competency row
// using this map.
//
// Add a new entry here to start auto-creating competencies for a new
// document_type without touching the calling routes.
const DOC_TYPE_TO_COMPETENCY = {
  white_card:  { type: 'white_card',     name: 'SafeWork NSW White Card' },
  tc_licence:  { type: 'traffic_ticket', name: 'Traffic Control and IMP Licenses' },
};

// Insert (or backfill) the competency row that mirrors an employee_documents
// upload. Idempotent — if a competency of the same type already exists for
// the employee, it's left in place and only the missing pieces
// (linked_document_id, issue_date, expiry_date) are filled in from the new
// document. Returns the competency row id, or null if no mapping applies.
function ensureCompetencyForDoc(db, opts) {
  const map = DOC_TYPE_TO_COMPETENCY[opts.documentType];
  if (!map) return null;

  const existing = db.prepare(
    'SELECT id FROM employee_competencies WHERE employee_id = ? AND competency_type = ?'
  ).get(opts.employeeId, map.type);

  if (existing) {
    db.prepare(`
      UPDATE employee_competencies
      SET linked_document_id = COALESCE(linked_document_id, ?),
          issue_date         = COALESCE(issue_date, ?),
          expiry_date        = COALESCE(expiry_date, ?),
          updated_at         = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(opts.documentId || null, opts.issueDate || null, opts.expiryDate || null, existing.id);
    return existing.id;
  }

  const r = db.prepare(`
    INSERT INTO employee_competencies (employee_id, competency_type, competency_name, competency_level,
      issue_date, expiry_date, status, mandatory_for_role, linked_document_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'valid', 1, ?, ?)
  `).run(
    opts.employeeId, map.type, map.name, opts.level || '',
    opts.issueDate || null, opts.expiryDate || null,
    opts.documentId || null, opts.source || ''
  );
  return r.lastInsertRowid;
}

module.exports = { DOC_TYPE_TO_COMPETENCY, ensureCompetencyForDoc };
