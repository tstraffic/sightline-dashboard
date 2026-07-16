// Automatic "return to depot" tasks for gear on a shift.
//
// When the allocator drags equipment onto a booking and says yes to the
// popup, booking_equipment.return_task flips to 1 and this module keeps a
// group of shift_tasks rows (one per assignee, keyed by
// shift_tasks.booking_equipment_id) in step with who should bring the gear
// back:
//   - hitched to a ute with a driver  -> that driver
//   - hitched to a ute, no driver     -> everyone riding that ute
//   - not hitched / ute has no riders -> the whole crew
// Completing ANY row in a group completes the group (the worker portal's
// done route fans out by booking_equipment_id). Done/cancelled rows are
// never deleted or resurrected — a non-pending row in the group means the
// gear came back and the task is history.
const bookingNotify = require('./bookingNotify');

function targetCrewIds(db, bookingId, gear) {
  const activeCrew = db.prepare(`
    SELECT crew_member_id, assigned_vehicle_id FROM booking_crew
    WHERE booking_id = ? AND status != 'declined'
  `).all(bookingId);
  if (gear.attached_vehicle_id) {
    const veh = db.prepare('SELECT id, crew_member_id FROM booking_vehicles WHERE id = ? AND booking_id = ?')
      .get(gear.attached_vehicle_id, bookingId);
    if (veh) {
      if (veh.crew_member_id && activeCrew.some(c => c.crew_member_id === veh.crew_member_id)) {
        return [veh.crew_member_id];
      }
      const riders = activeCrew.filter(c => c.assigned_vehicle_id === veh.id).map(c => c.crew_member_id);
      if (riders.length) return riders;
    }
  }
  return activeCrew.map(c => c.crew_member_id);
}

// Reconcile one gear item's return-task group against current state.
// Idempotent: safe to call from any allocation-changing endpoint.
function syncEquipmentReturnTask(db, bookingId, bookingEquipmentId) {
  const notifyIds = [];
  let title = '';
  const tx = db.transaction(() => {
    const gear = db.prepare('SELECT * FROM booking_equipment WHERE id = ? AND booking_id = ?')
      .get(bookingEquipmentId, bookingId);
    if (!gear || !gear.return_task) {
      db.prepare("DELETE FROM shift_tasks WHERE booking_equipment_id = ? AND status = 'pending'")
        .run(bookingEquipmentId);
      return;
    }
    const group = db.prepare('SELECT id, crew_member_id, status, title FROM shift_tasks WHERE booking_equipment_id = ?')
      .all(bookingEquipmentId);
    // Gear already returned (or task cancelled) — leave history alone.
    if (group.some(t => t.status !== 'pending')) return;

    const booking = db.prepare('SELECT depot FROM bookings WHERE id = ?').get(bookingId) || {};
    title = 'Return ' + (gear.equipment_name || 'equipment') + ' to '
      + (booking.depot ? booking.depot + ' depot' : 'the depot');

    const targets = targetCrewIds(db, bookingId, gear);
    const targetSet = new Set(targets);
    const pendingSet = new Set(group.map(t => t.crew_member_id));
    const sameMembers = targetSet.size === pendingSet.size && targets.every(id => pendingSet.has(id));
    if (sameMembers && group.every(t => t.title === title)) return;

    for (const t of group) {
      if (!targetSet.has(t.crew_member_id)) db.prepare('DELETE FROM shift_tasks WHERE id = ?').run(t.id);
      else if (t.title !== title) db.prepare("UPDATE shift_tasks SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, t.id);
    }
    // allocation_id stays NULL on purpose: crew_allocations rows cascade-
    // delete their shift_tasks when a worker is removed, which would erase
    // the done-row "gear came back" memory. Worker queries match on
    // booking_id, so nothing is lost.
    const ins = db.prepare(`
      INSERT OR IGNORE INTO shift_tasks
        (booking_id, crew_member_id, title, description, priority, booking_equipment_id, kind, group_key)
      VALUES (?, ?, ?, 'Automatic return-to-depot task', 'normal', ?, 'equipment_return', ?)
    `);
    for (const cid of targets) {
      if (pendingSet.has(cid)) continue;
      const r = ins.run(bookingId, cid, title, bookingEquipmentId, 'beq:' + bookingEquipmentId);
      if (r.changes > 0) notifyIds.push(cid);
    }
  });
  tx();
  if (notifyIds.length) {
    try {
      const bk = db.prepare('SELECT status, booking_number, title, start_datetime FROM bookings WHERE id = ?').get(bookingId) || {};
      if (bookingNotify.isNotifiable(bk.status)) {
        const date = bk.start_datetime ? new Date(String(bk.start_datetime).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
        bookingNotify.notifyTaskAssigned(notifyIds, {
          title,
          url: '/w/booking-shift/' + bookingId + '?tab=tasks',
          shift_label: [date, bk.title || bk.booking_number].filter(Boolean).join(' '),
        });
      }
    } catch (e) { console.error('[returnTasks] notify failed:', e.message); }
  }
}

// Re-sync every opted-in gear item on a booking (crew/driver/seat changed).
function syncBookingReturnTasks(db, bookingId) {
  try {
    const rows = db.prepare('SELECT id FROM booking_equipment WHERE booking_id = ? AND return_task = 1').all(bookingId);
    for (const r of rows) syncEquipmentReturnTask(db, bookingId, r.id);
  } catch (e) { console.error('[returnTasks] booking sync failed:', e.message); }
}

// Re-fan every whole-crew Team task ('team:%' groups) on a booking against
// the current roster: insert pending rows for members who joined, delete
// pending rows for members who left. Same history rule as return tasks —
// any non-pending row means the group is settled and gets left alone.
function syncTeamTasks(db, bookingId) {
  try {
    const tx = db.transaction(() => {
      const groups = db.prepare(`
        SELECT group_key FROM shift_tasks
        WHERE booking_id = ? AND group_key LIKE 'team:%'
        GROUP BY group_key
        HAVING SUM(CASE WHEN status != 'pending' THEN 1 ELSE 0 END) = 0
      `).all(bookingId).map(r => r.group_key);
      if (!groups.length) return;
      const crew = db.prepare(
        "SELECT crew_member_id FROM booking_crew WHERE booking_id = ? AND status != 'declined'"
      ).all(bookingId).map(r => r.crew_member_id);
      const crewSet = new Set(crew);
      const ins = db.prepare(`
        INSERT OR IGNORE INTO shift_tasks
          (booking_id, crew_member_id, title, description, priority, due_at,
           created_by_user_id, created_by_crew_id, kind, group_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'general', ?)
      `);
      for (const gk of groups) {
        const rows = db.prepare('SELECT * FROM shift_tasks WHERE group_key = ?').all(gk);
        const proto = rows[0];
        const members = new Set(rows.map(r => r.crew_member_id));
        for (const r of rows) {
          if (!crewSet.has(r.crew_member_id)) db.prepare('DELETE FROM shift_tasks WHERE id = ?').run(r.id);
        }
        for (const cid of crew) {
          if (!members.has(cid)) {
            ins.run(bookingId, cid, proto.title, proto.description, proto.priority,
              proto.due_at, proto.created_by_user_id, proto.created_by_crew_id, gk);
          }
        }
      }
    });
    tx();
  } catch (e) { console.error('[returnTasks] team sync failed:', e.message); }
}

// One call for allocation-changing endpoints: keeps both grouped kinds
// (equipment returns + whole-crew team tasks) in step with the roster.
function syncBookingTaskGroups(db, bookingId) {
  syncBookingReturnTasks(db, bookingId);
  syncTeamTasks(db, bookingId);
}

// Create a whole-crew Team task: one shift_tasks row per active crew
// member sharing a fresh 'team:' group key. allocation_id stays NULL
// (cascade-safety — see syncEquipmentReturnTask). Returns the group key
// and the crew fanned to, or null when the booking has no active crew.
function createTeamTask(db, bookingId, { title, description, priority, dueAt, createdByUserId, createdByCrewId }) {
  const crew = db.prepare(
    "SELECT crew_member_id FROM booking_crew WHERE booking_id = ? AND status != 'declined'"
  ).all(bookingId).map(r => r.crew_member_id);
  if (!crew.length) return null;
  const groupKey = 'team:' + bookingId + ':' + require('crypto').randomBytes(4).toString('hex');
  const ins = db.prepare(`
    INSERT OR IGNORE INTO shift_tasks
      (booking_id, crew_member_id, title, description, priority, due_at,
       created_by_user_id, created_by_crew_id, kind, group_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'general', ?)
  `);
  const tx = db.transaction(() => {
    for (const cid of crew) {
      ins.run(bookingId, cid, title, description || '', priority || 'normal',
        dueAt || null, createdByUserId || null, createdByCrewId || null, groupKey);
    }
  });
  tx();
  return { groupKey, crewIds: crew };
}

module.exports = { syncEquipmentReturnTask, syncBookingReturnTasks, syncTeamTasks, syncBookingTaskGroups, createTeamTask };
