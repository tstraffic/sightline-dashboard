// SOP version + acknowledgement text.
// Bumping CURRENT_VERSION makes every existing acknowledgement "stale" so
// workers are re-prompted to sign on next portal login (gate added later).
const CURRENT_VERSION = 'v1-2026-05';

const ACKNOWLEDGEMENT_TEXT = `By signing below I confirm that:

• I have reviewed T&S Traffic Control's Standard Operating Procedures (SOPs).
• I have been adequately educated on traffic management procedures, PPE requirements and site safety.
• I understand and will comply with all SOPs, supervisor directions and client site rules whenever I perform work on behalf of T&S Traffic Control.
• I will report any unsafe condition, near miss or incident immediately.

I agree this electronic signature is legally binding under the Electronic Transactions Act 1999 (Cth).`;

function currentVersion() { return CURRENT_VERSION; }
function ackText() { return ACKNOWLEDGEMENT_TEXT; }

// Active SOP/SWMS sections in display order, each with its ordered list of
// files. The mobile sign page renders every file inline for a section, then
// requires a single per-section acknowledgement before moving on.
//
// Each row in the returned array is one section:
//   { id, title, description, display_order, sop_slug,
//     files: [{ id, original_name, mime_type, pageRenders, page_renders_dir, ... }] }
//
// For the section's "primary" exposure (legacy callers that still expect a
// single file on the section), original_name / mime_type / pageRenders fall
// through from the first file so older templates keep rendering.
function activeDocuments(db) {
  // description column is optional (added in migration 182). Use COALESCE so
  // older deploys without the column still work without a try/catch wrapper.
  // sop_document_files is added by migration 209. Detect it so a half-applied
  // deploy doesn't blow up the worker sign page.
  const hasFilesTable = !!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sop_document_files'"
  ).get();

  const sections = db.prepare(`
    SELECT id, title, filename, original_name, file_path, file_size, mime_type,
           display_order, created_at, page_renders, sop_slug,
           COALESCE(description, '') as description
    FROM sop_documents
    WHERE active = 1
    ORDER BY display_order ASC, id ASC
  `).all();

  const parseRenders = (raw) => {
    if (!raw) return [];
    try { return JSON.parse(raw) || []; } catch (e) { return []; }
  };

  // Build a "synthetic file" from the parent row's columns. Used as a
  // fallback when the files table doesn't exist yet, or when a section
  // somehow has no child files but the parent still has a file_path
  // (defensive — should not happen after migration 209 backfill).
  const syntheticFile = (s) => (s.filename ? [{
    id: null,
    sop_document_id: s.id,
    filename: s.filename,
    original_name: s.original_name,
    file_path: s.file_path,
    file_size: s.file_size,
    mime_type: s.mime_type,
    pageRenders: parseRenders(s.page_renders),
    page_renders_dir: String(s.id),
    display_order: 0,
  }] : []);

  let filesByDoc = new Map();
  if (hasFilesTable) {
    const rows = db.prepare(`
      SELECT id, sop_document_id, filename, original_name, file_path, file_size,
             mime_type, page_renders, page_renders_dir, display_order
      FROM sop_document_files
      ORDER BY sop_document_id ASC, display_order ASC, id ASC
    `).all();
    for (const r of rows) {
      const list = filesByDoc.get(r.sop_document_id) || [];
      list.push({ ...r, pageRenders: parseRenders(r.page_renders) });
      filesByDoc.set(r.sop_document_id, list);
    }
  }

  return sections.map(s => {
    const files = (filesByDoc.get(s.id) && filesByDoc.get(s.id).length)
      ? filesByDoc.get(s.id)
      : syntheticFile(s);
    const first = files[0] || null;
    return {
      ...s,
      files,
      // Back-compat shims so older templates that look at the parent row's
      // single file still see something sensible.
      pageRenders: first ? first.pageRenders : [],
      original_name: first ? first.original_name : s.original_name,
      mime_type: first ? first.mime_type : s.mime_type,
    };
  });
}

module.exports = { currentVersion, ackText, activeDocuments };
