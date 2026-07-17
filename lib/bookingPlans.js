// lib/bookingPlans.js
// Plans & Approvals inherited by a booking from its linked job — TGS, ROL and
// TMP/CTMP sub-plans from the Compliance module — plus the per-booking crew
// visibility that decides whether each plan travels to the worker app.
//
// Visibility model: approved plans default to crew-visible, everything else
// defaults hidden (drafts shouldn't reach the field). An explicit row in
// booking_plan_visibility overrides the default either way, so the admin's
// choice sticks even when the plan's status later changes.

/**
 * All TGS / ROL / TMP sub-plans for the booking's linked job, each with its
 * attached files, ROL shift windows (date-matched against the booking), and
 * the resolved `visible_to_crew` flag. Returns null when the booking has no
 * job or no plans.
 */
function getJobPlansForBooking(db, booking) {
  if (!booking || !booking.job_id) return null;
  try {
    const bookingDate = String(booking.start_datetime || '').substring(0, 10);
    const rows = db.prepare(`
      SELECT c.id, c.item_type, c.title, c.status, c.reference_number, c.plan_number,
             c.file_link, c.expiry_date, c.approved_date,
             c.rol_actual_number, c.rol_file_path, c.rol_file_original_name,
             c.rol_summary_from, c.rol_summary_to, c.rol_time_window, c.rol_stage,
             v.visible_to_crew AS visibility_override
      FROM compliance c
      LEFT JOIN booking_plan_visibility v ON v.compliance_id = c.id AND v.booking_id = @bookingId
      WHERE c.item_type IN ('traffic_guidance', 'road_occupancy', 'tmp_approval')
        AND (c.job_id = @jobId
             OR c.parent_id IN (SELECT id FROM compliance WHERE job_id = @jobId))
      ORDER BY c.item_type, c.created_at DESC
    `).all({ jobId: booking.job_id, bookingId: booking.id });
    const docsStmt = db.prepare(
      'SELECT id, original_name, file_path, file_size FROM compliance_documents WHERE compliance_id = ? ORDER BY created_at DESC'
    );
    const shiftsStmt = db.prepare(
      'SELECT start_date, start_time, end_date, end_time FROM compliance_rol_shifts WHERE compliance_id = ? ORDER BY start_date, start_time'
    );
    const KIND = { traffic_guidance: 'tgs', road_occupancy: 'rol', tmp_approval: 'tmp' };
    const plans = rows.map(r => {
      const docs = (() => { try { return docsStmt.all(r.id); } catch (e) { return []; } })();
      let shifts = [];
      if (r.item_type === 'road_occupancy') {
        try {
          shifts = shiftsStmt.all(r.id).map(s => ({
            ...s,
            // A shift covers the booking when its date range spans the
            // booking's start date (single-day rows have no end_date).
            matchesDate: !!bookingDate && s.start_date <= bookingDate
              && bookingDate <= (s.end_date || s.start_date),
          }));
        } catch (e) {}
      }
      const visible_to_crew = r.visibility_override != null
        ? !!r.visibility_override
        : r.status === 'approved';
      // Anything a worker/admin can actually open: attached files, the plan
      // link, or the issued-ROL file.
      const openable = docs.length > 0 || !!r.file_link || !!r.rol_file_path;
      return { ...r, kind: KIND[r.item_type], docs, shifts, visible_to_crew, openable };
    });
    const tgs = plans.filter(p => p.kind === 'tgs');
    const rol = plans.filter(p => p.kind === 'rol');
    const tmp = plans.filter(p => p.kind === 'tmp');
    if (!plans.length) return null;
    return { tgs, rol, tmp, all: plans, bookingDate };
  } catch (e) {
    console.error('[bookingPlans] lookup error:', e.message);
    return null;
  }
}

/** Set (or clear back to default) a plan's crew visibility for one booking. */
function setPlanVisibility(db, bookingId, complianceId, visible) {
  db.prepare(`
    INSERT INTO booking_plan_visibility (booking_id, compliance_id, visible_to_crew, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(booking_id, compliance_id) DO UPDATE SET
      visible_to_crew = excluded.visible_to_crew, updated_at = CURRENT_TIMESTAMP
  `).run(bookingId, complianceId, visible ? 1 : 0);
}

module.exports = { getJobPlansForBooking, setPlanVisibility };
