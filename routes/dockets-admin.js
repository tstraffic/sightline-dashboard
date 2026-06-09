// Admin review of shift dockets (docket_signatures + docket_crew). Workers
// fill them at /w/dockets/shift/...; this is the office-side register + detail.
//
// One docket covers a whole shift's crew. A submitted docket is locked on the
// worker side; the office "adjusts" it here, which clones it into a NEW current
// docket and marks the original 'superseded' (kept, read-only, for audit).

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { getDocketCrew, calcHours } = require('../lib/shiftDocket');

// GET /dockets — register. Defaults to current dockets; ?show=superseded|all.
router.get('/', (req, res) => {
  const db = getDb();
  const since = (req.query.since || '').trim();
  const search = (req.query.q || '').trim();
  const docketType = (req.query.docket_type || '').trim();
  const noClient = req.query.no_client === '1';
  const show = (req.query.show || 'current').trim(); // current | superseded | all

  const where = ['1=1'];
  const params = [];
  if (show === 'superseded') where.push("COALESCE(ds.status,'current') = 'superseded'");
  else if (show !== 'all')   where.push("COALESCE(ds.status,'current') = 'current'");
  if (since)      { where.push("date(ds.signed_at) >= date(?)"); params.push(since); }
  if (docketType) { where.push("ds.docket_type = ?"); params.push(docketType); }
  if (noClient)   { where.push("ds.no_client_on_site = 1"); }
  if (search) {
    where.push("(signer.full_name LIKE ? OR COALESCE(sj.job_number, j.job_number, b.booking_number) LIKE ? OR COALESCE(sj.client, j.client, b.title) LIKE ? OR ds.client_name LIKE ?)");
    const s = '%' + search + '%';
    params.push(s, s, s, s);
  }

  const rows = db.prepare(`
    SELECT ds.id, ds.signed_at, ds.docket_type, ds.client_name, ds.no_client_on_site,
      ds.total_hours, COALESCE(ds.status,'current') AS status, ds.version, ds.source,
      ds.signature_data IS NOT NULL  AS has_worker_sig,
      ds.client_signature IS NOT NULL AS has_client_sig,
      ds.crew_member_id,
      COALESCE(ds.shift_date, ca.allocation_date) AS allocation_date,
      COALESCE(sj.id, j.id) AS job_id,
      COALESCE(sj.job_number, j.job_number, b.booking_number) AS job_number,
      COALESCE(sj.client, j.client, b.title) AS job_client,
      signer.full_name AS crew_name,
      (SELECT COUNT(*) FROM docket_crew dc WHERE dc.docket_id = ds.id) AS crew_count,
      (SELECT ROUND(SUM(dc.total_hours),2) FROM docket_crew dc WHERE dc.docket_id = ds.id) AS man_hours
    FROM docket_signatures ds
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs sj           ON ds.shift_job_id = sj.id
    LEFT JOIN jobs j            ON ca.job_id = j.id
    LEFT JOIN bookings b        ON ds.booking_id = b.id
    LEFT JOIN crew_members signer ON COALESCE(ds.signed_by_crew_id, ds.crew_member_id) = signer.id
    WHERE ${where.join(' AND ')}
    ORDER BY ds.signed_at DESC
    LIMIT 200
  `).all(...params);

  const counts = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN no_client_on_site = 1 THEN 1 ELSE 0 END) AS no_client
    FROM docket_signatures
    WHERE date(signed_at) >= date('now','-30 day') AND COALESCE(status,'current') = 'current'
  `).get();

  res.render('dockets-admin/index', {
    title: 'Signed Dockets', rows, counts, search, since, docketType, noClient, show,
  });
});

// Load a docket header with joins + its crew lines + version-chain neighbours.
function loadDocket(db, id) {
  const docket = db.prepare(`
    SELECT ds.*,
      signer.full_name AS crew_name, signer.employee_id AS employee_code, signer.phone AS crew_phone,
      COALESCE(ds.shift_date, ca.allocation_date) AS allocation_date,
      ca.start_time AS shift_start, ca.end_time AS shift_end, ca.role_on_site,
      COALESCE(sj.id, j.id) AS job_id,
      COALESCE(sj.job_number, j.job_number, b.booking_number) AS job_number,
      COALESCE(sj.client, j.client, b.title) AS job_client,
      COALESCE(sj.job_name, j.job_name) AS job_name,
      COALESCE(sj.site_address, j.site_address, b.site_address) AS site_address
    FROM docket_signatures ds
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs sj            ON ds.shift_job_id = sj.id
    LEFT JOIN jobs j             ON ca.job_id = j.id
    LEFT JOIN bookings b         ON ds.booking_id = b.id
    LEFT JOIN crew_members signer ON COALESCE(ds.signed_by_crew_id, ds.crew_member_id) = signer.id
    WHERE ds.id = ?
  `).get(id);
  return docket;
}

// GET /dockets/:id/edit — admin edit form for an adjustment docket.
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Docket not found.'); return res.redirect('/dockets'); }
  const status = docket.status || 'current';
  if (status !== 'current' || docket.source !== 'admin') {
    req.flash('error', 'Only an adjustment docket can be edited. Use "Adjust" to create one.');
    return res.redirect('/dockets/' + docket.id);
  }
  res.render('dockets-admin/edit', {
    title: 'Adjust docket', docket, crewLines: getDocketCrew(db, docket),
  });
});

// POST /dockets/:id — save edits to an adjustment docket.
router.post('/:id', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Docket not found.'); return res.redirect('/dockets'); }
  if ((docket.status || 'current') !== 'current' || docket.source !== 'admin') {
    req.flash('error', 'This docket cannot be edited.');
    return res.redirect('/dockets/' + docket.id);
  }

  const b = req.body;
  const noClient = b.no_client_on_site === '1' || b.no_client_on_site === 'on';
  const crewInput = b.crew || {};

  const tx = db.transaction(() => {
    let total = 0;
    // docket_crew rows are keyed by crew_member_id within this docket.
    const rowsForDocket = db.prepare('SELECT id, crew_member_id FROM docket_crew WHERE docket_id=?').all(docket.id);
    const updById = db.prepare(`
      UPDATE docket_crew SET start_on_site=?, finish_on_site=?, break_minutes=?, travel_hours=?, total_hours=? WHERE id=?
    `);
    for (const r of rowsForDocket) {
      const inp = crewInput['cm' + r.crew_member_id] || {};
      const start = (inp.start_on_site || '').trim();
      const finish = (inp.finish_on_site || '').trim();
      const brk = parseInt(inp.break_minutes, 10) || 0;
      const trav = parseFloat(inp.travel_hours) || 0;
      const th = calcHours(start, finish, brk, trav);
      total += th;
      updById.run(start, finish, brk, trav, th, r.id);
    }
    db.prepare(`
      UPDATE docket_signatures
      SET client_name=?, no_client_on_site=?, no_client_reason=?, notes=?, total_hours=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      noClient ? null : (b.client_name || null),
      noClient ? 1 : 0,
      noClient ? (b.no_client_reason || '').trim() : '',
      b.notes || null,
      Math.round(total * 100) / 100,
      docket.id
    );
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update', entityType: 'docket', entityId: docket.id,
    entityLabel: 'Docket #' + docket.id, details: 'Edited adjustment docket', ip: req.ip,
  });
  req.flash('success', 'Docket updated.');
  res.redirect('/dockets/' + docket.id);
});

// POST /dockets/:id/adjust — clone into a new current docket, supersede original.
router.post('/:id/adjust', (req, res) => {
  const db = getDb();
  const orig = db.prepare('SELECT * FROM docket_signatures WHERE id = ?').get(req.params.id);
  if (!orig) { req.flash('error', 'Docket not found.'); return res.redirect('/dockets'); }
  if ((orig.status || 'current') !== 'current') {
    req.flash('error', 'Only the current docket can be adjusted.');
    return res.redirect('/dockets/' + orig.id);
  }

  let newId;
  const tx = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO docket_signatures (
        allocation_id, crew_member_id, signed_by_crew_id, docket_type, client_name, signature_data,
        client_signature, client_signed_name, client_signed_at, notes,
        start_on_site, finish_on_site, break_minutes, travel_hours, total_hours,
        no_client_on_site, no_client_reason, signed_at,
        status, version, source, created_by_user_id, parent_docket_id,
        booking_id, shift_job_id, shift_date, updated_at
      )
      SELECT
        allocation_id, crew_member_id, signed_by_crew_id, docket_type, client_name, signature_data,
        client_signature, client_signed_name, client_signed_at, notes,
        start_on_site, finish_on_site, break_minutes, travel_hours, total_hours,
        no_client_on_site, no_client_reason, signed_at,
        'current', COALESCE(version,1) + 1, 'admin', ?, id,
        booking_id, shift_job_id, shift_date, datetime('now')
      FROM docket_signatures WHERE id = ?
    `).run(req.session.user ? req.session.user.id : null, orig.id);
    newId = r.lastInsertRowid;

    // Copy crew lines (or synthesise one from the legacy header).
    const srcLines = db.prepare('SELECT * FROM docket_crew WHERE docket_id = ?').all(orig.id);
    const ins = db.prepare(`
      INSERT INTO docket_crew (docket_id, crew_member_id, allocation_id, booking_crew_id, name_snapshot, role_snapshot,
        start_on_site, finish_on_site, break_minutes, travel_hours, total_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (srcLines.length) {
      for (const l of srcLines) ins.run(newId, l.crew_member_id, l.allocation_id, l.booking_crew_id, l.name_snapshot, l.role_snapshot, l.start_on_site, l.finish_on_site, l.break_minutes, l.travel_hours, l.total_hours);
    } else {
      const cm = orig.crew_member_id ? db.prepare('SELECT full_name FROM crew_members WHERE id=?').get(orig.crew_member_id) : null;
      ins.run(newId, orig.crew_member_id, orig.allocation_id, null, cm ? cm.full_name : '', '', orig.start_on_site, orig.finish_on_site, orig.break_minutes, orig.travel_hours, orig.total_hours);
    }

    db.prepare("UPDATE docket_signatures SET status='superseded', superseded_by_id=?, updated_at=datetime('now') WHERE id=?").run(newId, orig.id);
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update', entityType: 'docket', entityId: newId,
    entityLabel: 'Docket #' + newId, details: 'Adjustment of docket #' + orig.id + ' (superseded)', ip: req.ip,
  });
  req.flash('success', 'Adjustment created — edit the new docket. The original is kept as superseded.');
  res.redirect('/dockets/' + newId + '/edit');
});

// GET /dockets/:id — detail
router.get('/:id', (req, res) => {
  const db = getDb();
  const docket = loadDocket(db, req.params.id);
  if (!docket) { req.flash('error', 'Docket not found.'); return res.redirect('/dockets'); }

  const crewLines = getDocketCrew(db, docket);
  const parent = docket.parent_docket_id ? db.prepare('SELECT id, version FROM docket_signatures WHERE id=?').get(docket.parent_docket_id) : null;
  const child = docket.superseded_by_id ? db.prepare('SELECT id, version FROM docket_signatures WHERE id=?').get(docket.superseded_by_id) : null;

  let companionForms = [];
  if (docket.allocation_id) {
    companionForms = db.prepare(`
      SELECT id, form_type, submitted_at FROM safety_forms
      WHERE crew_member_id = ? AND allocation_id = ?
        AND form_type IN ('vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle')
      ORDER BY submitted_at ASC
    `).all(docket.crew_member_id, docket.allocation_id);
  }

  res.render('dockets-admin/show', {
    title: 'Docket — ' + (docket.crew_name || ('#' + docket.crew_member_id)),
    docket, crewLines, companionForms, parent, child,
  });
});

module.exports = router;
