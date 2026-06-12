// Worker push notifications for booking lifecycle events.
//
// Fire-and-forget by design: every helper swallows errors and runs the sends
// off the request path (setImmediate), so a push hiccup can never break a
// booking save. Workers can mute the whole category ('bookings') from
// /w/profile/notifications — sendPushToCrew honours that.

const { sendPushToCrew } = require('./pushNotification');

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

module.exports = { notifyAssigned, notifyRemoved, notifyCancelled, notifyRescheduled, activeCrewIds };
