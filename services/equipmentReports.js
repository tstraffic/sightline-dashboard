// Equipment condition/location reports — the worker's answer to the
// return-task completion sheet ("working or faulty, and where did it go").
//
// One report per gear item per completion cycle (return-task groups are
// never resurrected once settled, so undo/redo stays clean). Faulty
// reports auto-create a HIGH-priority office task in the admin `tasks`
// register so someone owns the follow-up (chase the supplier, book the
// repair); the task id rides on the report so undo can retract an
// untouched task.
const { sydneyToday } = require('../lib/sydney');

const CONDITIONS = ['working', 'faulty'];
const DESTINATIONS = ['home', 'depot', 'supplier', 'site'];
const DEST_LABEL = { home: 'home with the worker', depot: 'the depot', supplier: 'back to the supplier', site: 'left on site' };

// Record the worker's return report for one gear item. Returns
// { reportId, officeTaskId } or null when validation fails.
function recordReturnReport(db, { bookingId, bookingEquipmentId, condition, destination, note, reportedByCrewId }) {
  if (!CONDITIONS.includes(condition) || !DESTINATIONS.includes(destination)) return null;
  const gear = db.prepare('SELECT * FROM booking_equipment WHERE id = ?').get(bookingEquipmentId);
  if (!gear) return null;

  let officeTaskId = null;
  let reportId = null;
  const tx = db.transaction(() => {
    if (condition === 'faulty') {
      try {
        const bk = db.prepare('SELECT booking_number, title FROM bookings WHERE id = ?').get(bookingId) || {};
        const crew = db.prepare('SELECT full_name FROM crew_members WHERE id = ?').get(reportedByCrewId) || {};
        const due = (() => {
          const d = new Date(sydneyToday() + 'T00:00:00');
          d.setDate(d.getDate() + 2);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        })();
        const title = 'Faulty gear: ' + (gear.equipment_name || 'equipment')
          + (bk.booking_number ? ' — ' + bk.booking_number : '');
        const description = 'Reported faulty by ' + (crew.full_name || 'crew') + ' after shift '
          + (bk.booking_number || ('#' + bookingId)) + '. Destination: ' + DEST_LABEL[destination] + '.'
          + (gear.supplier_name ? ' Hired from ' + gear.supplier_name + '.' : '')
          + (note ? ' Worker note: ' + note : '')
          + ' See /bookings/' + bookingId + '.';
        const ins = db.prepare(`
          INSERT INTO tasks (division, title, description, due_date, status, priority, task_type, created_by)
          VALUES ('ops', ?, ?, ?, 'not_started', 'high', 'one_off', NULL)
        `).run(title, description, due);
        officeTaskId = ins.lastInsertRowid;
      } catch (e) { console.error('[equipmentReports] office task insert failed:', e.message); }
    }
    // Snapshots (name/supplier) are mandatory: booking_equipment rows are
    // deletable and hired units have no register row to fall back on.
    reportId = db.prepare(`
      INSERT INTO equipment_condition_reports
        (booking_id, booking_equipment_id, equipment_id, hire_unit_id, supplier_name,
         equipment_name, reported_by_crew_id, condition, destination, note, office_task_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bookingId, bookingEquipmentId, gear.equipment_id || null, gear.hire_unit_id || null,
      gear.supplier_name || '', gear.equipment_name || '', reportedByCrewId || null,
      condition, destination, (note || '').slice(0, 500), officeTaskId
    ).lastInsertRowid;
  });
  try { tx(); } catch (e) {
    console.error('[equipmentReports] record failed:', e.message);
    return null;
  }
  return { reportId, officeTaskId };
}

// Retract the report when the worker undoes the return task. The linked
// office task is deleted only while still not_started — once the office
// has touched it, the paper trail stays.
function undoReturnReport(db, bookingEquipmentId) {
  try {
    const reports = db.prepare(
      'SELECT id, office_task_id FROM equipment_condition_reports WHERE booking_equipment_id = ?'
    ).all(bookingEquipmentId);
    const tx = db.transaction(() => {
      for (const r of reports) {
        if (r.office_task_id) {
          try {
            db.prepare("DELETE FROM tasks WHERE id = ? AND status = 'not_started'").run(r.office_task_id);
          } catch (e) { /* task may have dependents — leave it */ }
        }
        db.prepare('DELETE FROM equipment_condition_reports WHERE id = ?').run(r.id);
      }
    });
    tx();
  } catch (e) { console.error('[equipmentReports] undo failed:', e.message); }
}

module.exports = { recordReturnReport, undoReturnReport, CONDITIONS, DESTINATIONS };
