// Worker push notifications for booking lifecycle events.
//
// Fire-and-forget by design: every helper swallows errors and runs the sends
// off the request path (setImmediate), so a push hiccup can never break a
// booking save. Workers can mute the whole category ('bookings') from
// /w/profile/notifications — sendPushToCrew honours that.

const { sendPushToCrew } = require('./pushNotification');

// Workers must not hear about a shift until the allocator has committed it.
// A booking is only "notifiable" once it reaches 'confirmed' or any later
// lifecycle state. Before that (client_booking / unconfirmed / on_hold) the
// shift is still being worked up, so assignment/reschedule/removal pushes are
// suppressed. Callers gate on this so the policy lives in one place.
const NOTIFIABLE_STATUSES = new Set([
  'confirmed', 'locked', 'conflict', 'green_to_go', 'in_progress', 'complete', 'finalised',
]);
function isNotifiable(status) {
  return NOTIFIABLE_STATUSES.has(String(status || ''));
}

function fmtDate(dt) {
  const s = String(dt || '').slice(0, 10);
  if (!s) return '';
  try { return new Date(s + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }); }
  catch (e) { return s; }
}
function fmtTime(dt) {
  const m = String(dt || '').match(/T(\d{2}:\d{2})/);
  return m ? m[1] : '';
}
function shiftLabel(booking) {
  const bits = [fmtDate(booking.start_datetime)];
  const t = fmtTime(booking.start_datetime);
  if (t) bits.push(t);
  const what = booking.title || booking.booking_number || 'shift';
  return bits.filter(Boolean).join(' ') + ' — ' + what;
}

function fanOut(crewIds, payload) {
  const ids = (Array.isArray(crewIds) ? crewIds : [crewIds]).map(n => parseInt(n, 10)).filter(n => n > 0);
  if (!ids.length) return;
  setImmediate(async () => {
    for (const id of ids) {
      try { await sendPushToCrew(id, payload); }
      catch (e) { console.error('[bookingNotify] push failed for crew', id, ':', e.message); }
    }
  });
}

function notifyAssigned(crewIds, booking) {
  fanOut(crewIds, {
    title: 'New shift assigned',
    body: shiftLabel(booking) + '. Open the app to accept.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_assigned',
  });
}

function notifyRemoved(crewIds, booking) {
  fanOut(crewIds, {
    title: 'Shift assignment removed',
    body: 'You’ve been taken off ' + shiftLabel(booking) + '.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_removed',
  });
}

// All crew accepted — the shift is locked in (booking auto-advanced to
// green_to_go). A reassuring "you're all set" ping to the whole crew.
function notifyGreenToGo(crewIds, booking) {
  fanOut(crewIds, {
    title: 'Shift good to go ✅',
    body: shiftLabel(booking) + ' — all crew confirmed. You’re all set.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_green_to_go',
  });
}

// Docket submitted → shift complete. Doubles as the prompt for crew to
// deactivate their ROL (a worker responsibility) on the myROL site.
function notifyDocketSubmitted(crewIds, booking) {
  fanOut(crewIds, {
    title: 'Docket submitted — shift complete',
    body: 'Nice work on ' + shiftLabel(booking) + '. If this shift had an ROL, deactivate it now at myrol.transport.nsw.gov.au.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_docket_submitted',
  });
}

// A task was assigned to a worker. Fires whenever the task is created
// against them — admin shift-task page, booking detail, or a TL on site.
// `url` deep-links to the shift's Tasks tab when the task is shift-bound,
// otherwise the worker home (general tasks live on the home dashboard).
function notifyTaskAssigned(crewIds, task) {
  const where = task && task.shift_label ? ' on ' + task.shift_label : '';
  fanOut(crewIds, {
    title: 'New task assigned',
    body: (task && task.title ? '“' + task.title + '”' : 'A task') + where + '. Open the app to view it.',
    url: (task && task.url) || '/w/home',
    category: 'bookings', type: 'task_assigned',
  });
}

// Shift notes changed after the crew could already see the shift — e.g. the
// office edits "About this job" / Location notes. `changed` is a list of
// human labels of what was updated.
function notifyShiftNotesUpdated(crewIds, booking, changed) {
  const what = (changed && changed.length) ? changed.join(' and ') : 'details';
  fanOut(crewIds, {
    title: 'Shift details updated',
    body: what + ' updated for ' + shiftLabel(booking) + '. Open the app to read the latest.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_notes_updated',
  });
}

function notifyCancelled(crewIds, booking) {
  fanOut(crewIds, {
    title: 'Shift cancelled',
    body: shiftLabel(booking) + ' has been cancelled. You don’t need to attend.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_cancelled',
  });
}

function notifyRescheduled(crewIds, booking, oldStart) {
  const from = fmtDate(oldStart);
  const fromT = fmtTime(oldStart);
  fanOut(crewIds, {
    title: 'Shift time changed',
    body: (booking.title || booking.booking_number || 'Your shift') +
      ' moved' + (from ? ' from ' + from + (fromT ? ' ' + fromT : '') : '') +
      ' to ' + fmtDate(booking.start_datetime) + (fmtTime(booking.start_datetime) ? ' ' + fmtTime(booking.start_datetime) : '') + '.',
    url: '/w/jobs',
    category: 'bookings', type: 'booking_rescheduled',
  });
}

/** Crew on a booking who haven't declined — the audience for cancel/move. */
function activeCrewIds(db, bookingId) {
  try {
    return db.prepare("SELECT DISTINCT crew_member_id FROM booking_crew WHERE booking_id = ? AND status != 'declined'")
      .all(bookingId).map(r => r.crew_member_id);
  } catch (e) { return []; }
}

module.exports = { notifyAssigned, notifyRemoved, notifyCancelled, notifyRescheduled, notifyGreenToGo, notifyDocketSubmitted, notifyTaskAssigned, notifyShiftNotesUpdated, activeCrewIds, isNotifiable };
