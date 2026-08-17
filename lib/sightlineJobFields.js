// Sightline project-register fields (brief §5.1) — a secondary UPDATE run
// by both job update handlers (routes/jobs.js and routes/projects.js render
// the same form). Gated on the form's sightline_fields flag so the hidden
// T&S booking/import paths that also POST job updates never blank these
// columns by omission.
function applySightlineJobFields(db, jobId, b) {
  if (!b || b.sightline_fields !== '1') return;
  const streams = Array.isArray(b.service_streams) ? b.service_streams.join(',') : (b.service_streams || '');
  // Once the job has time entries, actual_hours is a projection owned by
  // routes/time.js (lib/wip.js syncJobActualHours) — the manual form value
  // is ignored so a stale form can't overwrite the synced total. The job
  // form renders the field disabled in that case.
  const { jobHasTimeEntries } = require('./wip');
  const keepActualHours = jobHasTimeEntries(db, jobId);
  db.prepare(`
    UPDATE jobs SET
      end_client = ?, lga = ?, project_type = ?, service_streams = ?,
      commercial_lead_id = ?, technical_lead_id = ?, checker_id = ?,
      internal_qa_date = ?, client_deadline = ?,
      actual_hours = CASE WHEN ? THEN actual_hours ELSE ? END,
      po_reference = ?, po_status = ?, invoice_status = ?, xero_reference = ?,
      current_action = ?, blocker = ?, next_action_date = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    b.end_client || '', b.lga || '', b.project_type || '', streams,
    b.commercial_lead_id || null, b.technical_lead_id || null, b.checker_id || null,
    b.internal_qa_date || null, b.client_deadline || null,
    keepActualHours ? 1 : 0, parseFloat(b.actual_hours) || 0,
    b.po_reference || '', b.po_status || '', b.invoice_status || '', b.xero_reference || '',
    b.current_action || '', b.blocker || '', b.next_action_date || null,
    jobId
  );
}

module.exports = { applySightlineJobFields };
