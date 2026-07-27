// lib/bookingDocs.js
// Documents a booking inherits from its linked job, from ALL THREE job-side
// sources:
//   - job_documents: TGS / TMP / ROL / stage plans uploaded by allocators on
//     the job itself (/jobs/:id/documents, migration 139)
//   - compliance: TGS / ROL / TMP sub-plans from Plans & Approvals (already
//     handled in detail by lib/bookingPlans; counted here for totals)
//   - traffic_plans marked final: what the job page's "Final Plans" tab
//     shows. The job drag-drop uploader with "Push to Final Plans" writes
//     ONLY here (routes/plans.js /plans/quick-upload), so plans uploaded
//     that way were invisible to every booking surface — the allocator saw
//     "0 documents" on a booking whose job visibly had the pack.
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

/**
 * Active (non-archived) job-level documents for a job, plus the job's final
 * traffic plans (what the job page's "Final Plans" tab lists). [] when no
 * job. Final plans are shaped like job_documents rows so callers and views
 * need no special-casing; `source` distinguishes them.
 */
function getJobDocumentsForJob(db, jobId) {
  if (!jobId) return [];
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT jd.id, jd.job_id, jd.doc_type, jd.title, jd.original_name, jd.mime_type,
             jd.size_bytes, jd.uploaded_at, u.full_name AS uploader_name,
             'job_document' AS source
      FROM job_documents jd LEFT JOIN users u ON u.id = jd.uploaded_by_id
      WHERE jd.job_id = ? AND jd.archived_at IS NULL
      ORDER BY jd.uploaded_at DESC
    `).all(jobId);
  } catch (e) { /* legacy DB without job_documents */ }
  try {
    const finals = db.prepare(`
      SELECT tp.id, tp.job_id,
             COALESCE(NULLIF(tp.plan_type, ''), 'plan') AS doc_type,
             COALESCE(NULLIF(tp.plan_number, ''), 'Final plan') AS title,
             tp.file_original_name AS original_name,
             '' AS mime_type, NULL AS size_bytes,
             COALESCE(tp.marked_final_at, tp.updated_at, tp.created_at) AS uploaded_at,
             u.full_name AS uploader_name,
             'final_plan' AS source
      FROM traffic_plans tp LEFT JOIN users u ON u.id = tp.created_by_id
      WHERE tp.job_id = ? AND tp.is_final = 1
      ORDER BY uploaded_at DESC
    `).all(jobId);
    rows = rows.concat(finals);
  } catch (e) { /* legacy DB without traffic_plans / is_final */ }
  return rows;
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
  try { n += db.prepare('SELECT COUNT(*) AS c FROM traffic_plans WHERE job_id = ? AND is_final = 1').get(jobId).c; } catch (e) {}
  return n;
}

module.exports = { getJobDocumentsForJob, countJobLinkedDocs };
