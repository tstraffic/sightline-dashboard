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
        (booking_id, crew_member_id, title, description, priority, booking_equipment_id)
      VALUES (?, ?, ?, 'Automatic return-to-depot task', 'normal', ?)
    `);
    for (const cid of targets) {
      if (pendingSet.has(cid)) continue;
      const r = ins.run(bookingId, cid, title, bookingEquipmentId);
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

module.exports = { syncEquipmentReturnTask, syncBookingReturnTasks };
