// lib/shiftForms.js
// Shared between the worker portal (shift Forms tab) and the admin booking
// page (Forms section): who is in which vehicle on a booking, and the
// crew-aware / vehicle-aware Job-Pack completion model.

function getBookingVehicleGroups(db, bookingId, currentCrewId) {
  try {
    const vehicles = db.prepare(`
      SELECT bv.id, bv.vehicle_name, bv.registration, bv.crew_member_id AS driver_id,
             fv.asset_id AS fleet_asset_id, fv.rego AS fleet_rego
      FROM booking_vehicles bv
      LEFT JOIN vehicles fv ON fv.id = bv.fleet_vehicle_id
      WHERE bv.booking_id = ?
      ORDER BY bv.id
    `).all(bookingId);
    if (!vehicles.length) return null;
    const crew = db.prepare(`
      SELECT bc.id AS booking_crew_id, bc.crew_member_id, bc.assigned_vehicle_id, bc.role_on_site, bc.status,
             cm.full_name, cm.phone, cm.portal_role
      FROM booking_crew bc
      JOIN crew_members cm ON cm.id = bc.crew_member_id
      WHERE bc.booking_id = ? AND bc.status != 'declined'
      ORDER BY CASE cm.portal_role WHEN 'supervisor' THEN 0 WHEN 'team_leader' THEN 1 ELSE 2 END, cm.full_name
    `).all(bookingId);

    // Which vehicle is each crew member SHOWN in on the bookings board?
    //
    // assigned_vehicle_id is only set once a planner deliberately pins
    // someone; the board seats everyone else by derivation at render time
    // (routes/bookings.js deriveCrewBlocks). Reading the stored column alone
    // meant a crew member the planner can plainly see sitting in a ute was
    // told "On site — not in a vehicle" in the portal. Use the board's own
    // placement so the two surfaces always agree, and fall back to the
    // stored column if that lookup is ever unavailable.
    let displayed = null;
    try {
      const { snapshotDisplayedVehicles } = require('../routes/bookings');
      if (typeof snapshotDisplayedVehicles === 'function') displayed = snapshotDisplayedVehicles(db, bookingId);
    } catch (e) { /* fall back to the stored column below */ }
    const vehicleFor = (c) => {
      if (displayed && displayed.has(c.booking_crew_id)) return displayed.get(c.booking_crew_id);
      return c.assigned_vehicle_id || null;
    };
    const decorate = (c, v) => ({
      ...c,
      is_driver: !!v && c.crew_member_id === v.driver_id,
      is_you: !!currentCrewId && c.crew_member_id === currentCrewId,
    });
    // Gear hitched to each vehicle (trailers, portabooms…) so the crew can
    // see what rides which ute before they leave the depot.
    let gearByVehicle = new Map();
    try {
      db.prepare(`
        SELECT id, equipment_name, quantity, attached_vehicle_id, hire_unit_id, supplier_name
        FROM booking_equipment
        WHERE booking_id = ? AND attached_vehicle_id IS NOT NULL
      `).all(bookingId).forEach(g => {
        if (!gearByVehicle.has(g.attached_vehicle_id)) gearByVehicle.set(g.attached_vehicle_id, []);
        gearByVehicle.get(g.attached_vehicle_id).push({
          id: g.id, name: g.equipment_name || 'Gear',
          quantity: g.quantity || 1, hired: !!g.hire_unit_id, supplier: g.supplier_name || '',
        });
      });
    } catch (e) { /* legacy DB without booking_equipment */ }
    const groups = vehicles.map(v => ({
      vehicle: {
        id: v.id,
        name: v.vehicle_name || v.fleet_asset_id || 'Vehicle',
        rego: v.registration || v.fleet_rego || '',
        driver_id: v.driver_id || null,
      },
      gear: gearByVehicle.get(v.id) || [],
      members: crew.filter(c => vehicleFor(c) === v.id).map(c => decorate(c, v)),
    }));
    const onFoot = crew
      .filter(c => { const vid = vehicleFor(c); return !vid || !vehicles.some(v => v.id === vid); })
      .map(c => decorate(c, null));
    return { groups, onFoot };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Crew-aware + vehicle-aware Job-Pack completion for a booking shift.
//
// The five checklists carry different completion semantics:
//   - risk_toolbox, team_leader  — ONE copy per shift: any crew member's
//     submitted copy completes it for everyone (they ran it with the crew);
//     the tab shows who filed it and lets anyone add their own on top.
//   - tc_prestart                — per person: everyone signs their own.
//   - vehicle_prestart,
//     post_shift_vehicle         — per VEHICLE: each booking ute has its own
//     pre-start and post-shift, owed by its driver
//     (booking_vehicles.crew_member_id).
//
// Reads resolve submissions via the booking's allocations (a submission's
// allocation_id is by construction one of them) OR sf.booking_id — the
// latter alone would miss legacy rows (only team_leader wrote it before
// migration 330 landed). Only status='submitted' counts: team-shared
// team_leader DRAFTS used to read as "Submitted", which also (wrongly)
// satisfied the docket gate.
function buildShiftForms(db, booking, worker, vehicleGroups) {
  try {
    const allocRows = db.prepare(
      "SELECT id, crew_member_id FROM crew_allocations WHERE booking_id = ? AND status != 'cancelled'"
    ).all(booking.id);
    const allocIds = allocRows.map(a => a.id);

    const crew = db.prepare(`
      SELECT bc.crew_member_id, cm.full_name
      FROM booking_crew bc JOIN crew_members cm ON cm.id = bc.crew_member_id
      WHERE bc.booking_id = ? AND bc.status != 'declined'
    `).all(booking.id);
    const nameOf = new Map(crew.map(c => [c.crew_member_id, c.full_name]));

    const JP = ['vehicle_prestart', 'risk_toolbox', 'tc_prestart', 'team_leader', 'post_shift_vehicle'];
    const allocPh = allocIds.map(() => '?').join(',');
    const subs = db.prepare(`
      SELECT sf.id, sf.crew_member_id, sf.form_type, sf.submitted_at, sf.vehicle_id, sf.data,
             cm.full_name AS by_name
      FROM safety_forms sf JOIN crew_members cm ON cm.id = sf.crew_member_id
      WHERE sf.form_type IN (${JP.map(() => '?').join(',')})
        AND sf.status = 'submitted'
        AND (${allocIds.length ? `sf.allocation_id IN (${allocPh}) OR ` : ''}sf.booking_id = ?)
      ORDER BY sf.submitted_at DESC
    `).all(...JP, ...allocIds, booking.id);

    const copy = (s) => ({
      id: s.id, crew_member_id: s.crew_member_id, by_name: s.by_name,
      submitted_at: s.submitted_at, mine: s.crew_member_id === worker.id,
    });

    // Shift-level: every submitted copy, newest first.
    const shiftOnce = {};
    for (const t of ['risk_toolbox', 'team_leader']) {
      shiftOnce[t] = { copies: subs.filter(s => s.form_type === t).map(copy), draft: null };
    }
    // Surface an in-progress team draft (team_leader supports shared drafts).
    try {
      const drafts = db.prepare(`
        SELECT sf.form_type, cm.full_name AS started_by_name
        FROM safety_forms sf
        LEFT JOIN crew_members cm ON cm.id = COALESCE(sf.draft_started_by_id, sf.crew_member_id)
        WHERE sf.status = 'draft' AND sf.shift_key = ? AND sf.form_type IN ('risk_toolbox','team_leader')
      `).all('b:' + booking.id);
      for (const d of drafts) {
        if (shiftOnce[d.form_type] && !shiftOnce[d.form_type].copies.length) {
          shiftOnce[d.form_type].draft = { started_by_name: d.started_by_name || 'a teammate' };
        }
      }
    } catch (e) { /* draft surfacing is best-effort */ }

    // Per person: my copy + crew tally. Denominator is the live crew;
    // numerator counts distinct CURRENT crew members who signed.
    const tcSubs = subs.filter(s => s.form_type === 'tc_prestart');
    const tcSigned = new Set(tcSubs.filter(s => nameOf.has(s.crew_member_id)).map(s => s.crew_member_id));
    const tc = {
      mine: tcSubs.filter(s => s.mine).map(copy)[0] || null,
      done: tcSigned.size,
      total: crew.length,
      // Per-person breakdown — the office needs to see WHO hasn't signed,
      // not just the tally. sub is the crew member's latest submitted copy.
      rows: crew.map(c => ({
        crew_member_id: c.crew_member_id,
        name: c.full_name,
        sub: tcSubs.filter(s => s.crew_member_id === c.crew_member_id).map(copy)[0] || null,
      })),
    };

    // Per vehicle. vehicle_id (mig 330) is authoritative; legacy rows match
    // by normalised typed name/rego. First vehicle claims a legacy sub.
    const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    let vehicles = null;
    if (vehicleGroups && vehicleGroups.groups && vehicleGroups.groups.length) {
      const claimed = new Set();
      const vSubs = subs.filter(s => s.form_type === 'vehicle_prestart' || s.form_type === 'post_shift_vehicle')
        .map(s => {
          let typed = '';
          try { typed = norm((JSON.parse(s.data || '{}') || {}).vehicle); } catch (e) {}
          return { ...s, typed };
        });
      vehicles = vehicleGroups.groups.map(g => {
        const match = (type) => {
          for (const s of vSubs) {
            if (s.form_type !== type || claimed.has(s.id)) continue;
            const byId = s.vehicle_id != null && s.vehicle_id === g.vehicle.id;
            const byName = s.vehicle_id == null && s.typed &&
              (s.typed === norm(g.vehicle.name) || s.typed === norm(g.vehicle.rego));
            if (byId || byName) { claimed.add(s.id); return copy(s); }
          }
          return null;
        };
        const driverId = g.vehicle.driver_id;
        return {
          vehicle_id: g.vehicle.id,
          name: g.vehicle.name,
          rego: g.vehicle.rego,
          driver: driverId ? {
            id: driverId,
            name: nameOf.get(driverId) || 'former crew member',
            is_you: driverId === worker.id,
          } : null,
          prestart: match('vehicle_prestart'),
          postshift: match('post_shift_vehicle'),
        };
      });
    }

    return { shiftOnce, tc, vehicles };
  } catch (e) {
    console.error('[shiftForms] buildShiftForms failed:', e.message);
    return null;
  }
}

// Lean batch variant for the bookings BOARD: one summary per booking so a
// day's worth of cards costs four queries total, not four per card.
// Shape per booking id:
//   { rat: bool, tl: bool, tc: { done, total }, veh: { done, total } }
// veh counts utes whose Pre-Start AND Post-Shift are both submitted.
function buildBoardFormsSummary(db, bookingIds) {
  const out = {};
  const ids = (bookingIds || []).filter(Boolean);
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  try {
    const allocs = db.prepare(
      `SELECT id, booking_id FROM crew_allocations WHERE booking_id IN (${ph}) AND status != 'cancelled'`
    ).all(...ids);
    const allocBooking = new Map(allocs.map(a => [a.id, a.booking_id]));

    const crew = db.prepare(
      `SELECT booking_id, crew_member_id FROM booking_crew WHERE booking_id IN (${ph}) AND status != 'declined'`
    ).all(...ids);
    const vehicles = db.prepare(
      `SELECT id, booking_id, vehicle_name, registration FROM booking_vehicles WHERE booking_id IN (${ph})`
    ).all(...ids);

    const allocIds = allocs.map(a => a.id);
    const aph = allocIds.map(() => '?').join(',');
    const subs = db.prepare(`
      SELECT form_type, crew_member_id, vehicle_id, data, allocation_id, booking_id
      FROM safety_forms
      WHERE status = 'submitted'
        AND form_type IN ('vehicle_prestart','risk_toolbox','tc_prestart','team_leader','post_shift_vehicle')
        AND (booking_id IN (${ph})${allocIds.length ? ` OR allocation_id IN (${aph})` : ''})
    `).all(...ids, ...allocIds);

    const norm = (x) => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const id of ids) {
      const myCrew = new Set(crew.filter(c => c.booking_id === id).map(c => c.crew_member_id));
      const myVeh = vehicles.filter(v => v.booking_id === id);
      const mySubs = subs.filter(sf => (sf.booking_id || allocBooking.get(sf.allocation_id)) === id);
      const tcSigned = new Set(
        mySubs.filter(sf => sf.form_type === 'tc_prestart' && myCrew.has(sf.crew_member_id)).map(sf => sf.crew_member_id)
      );
      const vSubs = mySubs
        .filter(sf => sf.form_type === 'vehicle_prestart' || sf.form_type === 'post_shift_vehicle')
        .map(sf => {
          let typed = '';
          try { typed = norm((JSON.parse(sf.data || '{}') || {}).vehicle); } catch (e) {}
          return { type: sf.form_type, vehicle_id: sf.vehicle_id, typed };
        });
      let vehDone = 0;
      for (const v of myVeh) {
        const has = (type) => vSubs.some(sf => sf.type === type &&
          (sf.vehicle_id === v.id || (sf.vehicle_id == null && sf.typed &&
            (sf.typed === norm(v.vehicle_name) || sf.typed === norm(v.registration)))));
        if (has('vehicle_prestart') && has('post_shift_vehicle')) vehDone++;
      }
      out[id] = {
        rat: mySubs.some(sf => sf.form_type === 'risk_toolbox'),
        tl: mySubs.some(sf => sf.form_type === 'team_leader'),
        tc: { done: tcSigned.size, total: myCrew.size },
        veh: { done: vehDone, total: myVeh.length },
      };
    }
  } catch (e) {
    console.error('[shiftForms] buildBoardFormsSummary failed:', e.message);
  }
  return out;
}

module.exports = { getBookingVehicleGroups, buildShiftForms, buildBoardFormsSummary };
