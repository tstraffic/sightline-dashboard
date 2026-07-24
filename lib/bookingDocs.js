// lib/bookingDocs.js
// Documents a booking inherits from its linked job, from BOTH job-side
// sources:
//   - job_documents: TGS / TMP / ROL / stage plans uploaded by allocators on
//     the job itself (/jobs/:id/documents, migration 139)
//   - compliance: TGS / ROL / TMP sub-plans from Plans & Approvals (already
//     handled in detail by lib/bookingPlans; counted here for totals)
//
// The dashboard's "booking starting soon with no site docs" nudge has always
// treated a job_documents row as coverage — every booking surface that shows
// a document count should agree with it, or allocators see "0 documents" on
// bookings whose job already carries the full pack.

// Compliance TGS/ROL/TMP sub-plans linked to a job — same scope rule as
// lib/bookingPlans.getJobPlansForBooking (direct job link, or sub-plan of a
// parent linked to the job).
const COMPLIANCE_PLAN_COUNT_SQL = `
  SELECT COUNT(*) AS c FROM compliance c
  WHERE c.item_type IN ('traffic_guidance', 'road_occupancy', 'tmp_approval')
    AND (c.job_id = ? OR c.parent_id IN (SELECT id FROM compliance WHERE job_id = ?))
`;

/** Active (non-archived) job-level documents for a job. [] when no job. */
function getJobDocumentsForJob(db, jobId) {
  if (!jobId) return [];
  try {
    return db.prepare(`
      SELECT jd.id, jd.job_id, jd.doc_type, jd.title, jd.original_name, jd.mime_type,
             jd.size_bytes, jd.uploaded_at, u.full_name AS uploader_name
      FROM job_documents jd LEFT JOIN users u ON u.id = jd.uploaded_by_id
      WHERE jd.job_id = ? AND jd.archived_at IS NULL
      ORDER BY jd.uploaded_at DESC
    `).all(jobId);
  } catch (e) { return []; /* legacy DB without job_documents */ }
}

/**
 * Total documents a booking's job contributes: job_documents + compliance
 * TGS/ROL/TMP sub-plans. Cheap (two COUNTs) — safe on list pages.
 */
function countJobLinkedDocs(db, jobId) {
  if (!jobId) return 0;
  let n = 0;
  try { n += db.prepare('SELECT COUNT(*) AS c FROM job_documents WHERE job_id = ? AND archived_at IS NULL').get(jobId).c; } catch (e) {}
  try { n += db.prepare(COMPLIANCE_PLAN_COUNT_SQL).get(jobId, jobId).c; } catch (e) {}
  return n;
}

module.exports = { getJobDocumentsForJob, countJobLinkedDocs };
