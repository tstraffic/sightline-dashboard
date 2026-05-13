// Today-briefing enrichment for /w/home.
//
// The home page already builds `todaysShifts` from crew_allocations + booking
// fallback. This helper takes those shift rows and annotates each with the
// pieces a field worker actually needs at 6am:
//
//   - mapsUrl       — Google Maps deeplink, opens the native maps app
//                     (no new browser tab, stays inside the PWA shell).
//   - countdownLabel — "Starts in 2h 14m" / "Started 15m ago" / "Finished".
//   - crewCount      — number of *other* crew on this shift, for "you + N".
//   - supervisorUserId — for the one-tap "Message supervisor" DM link, via
//                        /w/chat/dm/:userId. Only set when the job has an
//                        ops_supervisor_id; booking-only shifts get null.
//
// All synchronous DB queries (better-sqlite3). Pure function, no side effects.

'use strict';

function buildMapsUrl(siteAddress, suburb) {
  var parts = [];
  if (siteAddress) parts.push(String(siteAddress).trim());
  if (suburb) parts.push(String(suburb).trim());
  if (!parts.length) return null;
  var q = parts.join(', ');
  return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(q);
}

// Build a "starts in N" / "started N ago" label from the shift's start_time
// + end_time (both HH:MM strings on `today`). `now` is a Date in worker
// local time — caller passes one anchored on Sydney midnight + minutesSinceMidnight.
function buildCountdown(startTime, endTime, minsNow) {
  if (!startTime) return null;
  var sm = parseHHMM(startTime);
  var em = parseHHMM(endTime);
  if (sm == null) return null;
  var delta = sm - minsNow;
  if (delta > 0) return { kind: 'before', minutes: delta, label: formatDelta(delta, 'in') };
  if (em != null && minsNow >= em) return { kind: 'after', minutes: minsNow - em, label: 'Shift finished' };
  return { kind: 'on', minutes: minsNow - sm, label: formatDelta(minsNow - sm, 'ago') };
}

function parseHHMM(s) {
  if (!s || typeof s !== 'string') return null;
  var m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function formatDelta(mins, suffix) {
  if (mins < 1) return suffix === 'in' ? 'Starting now' : 'Just started';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  var pieces;
  if (h === 0) pieces = m + 'm';
  else if (m === 0) pieces = h + 'h';
  else pieces = h + 'h ' + m + 'm';
  return (suffix === 'in' ? 'Starts in ' : 'Started ') + pieces + (suffix === 'in' ? '' : ' ago');
}

function sydneyMinutesNow(now) {
  // now is the JS Date the caller passes. Convert to Sydney-local HH:MM.
  // Use Intl to avoid timezone offset arithmetic.
  try {
    var parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now || new Date());
    var h = 0, m = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'hour') h = parseInt(parts[i].value, 10);
      if (parts[i].type === 'minute') m = parseInt(parts[i].value, 10);
    }
    return h * 60 + m;
  } catch (e) {
    var d = now || new Date();
    return d.getHours() * 60 + d.getMinutes();
  }
}

// Count *other* crew on the same allocation_date for a given job_id or
// booking_id (whichever the shift came from), excluding the current worker.
function countOtherCrew(db, shift, workerId, today) {
  try {
    if (shift.job_id) {
      var byJob = db.prepare(`
        SELECT COUNT(*) AS c FROM crew_allocations
        WHERE job_id = ? AND allocation_date = ?
          AND status != 'cancelled'
          AND crew_member_id != ?
      `).get(shift.job_id, today, workerId);
      return (byJob && byJob.c) || 0;
    }
    if (shift.booking_id) {
      // Mix of crew_allocations (most precise) and booking_crew fallback.
      var byAlloc = db.prepare(`
        SELECT COUNT(*) AS c FROM crew_allocations
        WHERE booking_id = ? AND allocation_date = ?
          AND status != 'cancelled'
          AND crew_member_id != ?
      `).get(shift.booking_id, today, workerId);
      if (byAlloc && byAlloc.c) return byAlloc.c;
      var byBc = db.prepare(`
        SELECT COUNT(*) AS c FROM booking_crew
        WHERE booking_id = ?
          AND status IN ('assigned','confirmed')
          AND crew_member_id != ?
      `).get(shift.booking_id, workerId);
      return (byBc && byBc.c) || 0;
    }
  } catch (e) { /* booking_crew may not exist on legacy DBs */ }
  return 0;
}

// Look up the user id of the job's ops supervisor. Used to deeplink into
// /w/chat/dm/:userId from the briefing card. Returns null for booking-only
// shifts (no job, no supervisor row to point at).
function lookupSupervisorUserId(db, shift) {
  if (!shift.job_id) return null;
  try {
    var row = db.prepare('SELECT ops_supervisor_id FROM jobs WHERE id = ?').get(shift.job_id);
    return row && row.ops_supervisor_id ? row.ops_supervisor_id : null;
  } catch (e) { return null; }
}

// Public API: takes the array of todaysShifts already built by the home
// route and returns a new array with each shift annotated. Original objects
// are mutated for convenience (the home route doesn't keep a pristine copy).
function enrichTodaysShifts(db, shifts, opts) {
  if (!Array.isArray(shifts) || !shifts.length) return shifts;
  var workerId = opts.workerId;
  var today = opts.today;
  var minsNow = sydneyMinutesNow(opts.now);
  for (var i = 0; i < shifts.length; i++) {
    var s = shifts[i];
    s.mapsUrl = buildMapsUrl(s.site_address, s.suburb);
    s.countdown = buildCountdown(s.start_time, s.end_time, minsNow);
    s.crewCount = countOtherCrew(db, s, workerId, today);
    s.supervisorUserId = lookupSupervisorUserId(db, s);
  }
  return shifts;
}

module.exports = {
  enrichTodaysShifts,
  buildMapsUrl,
  buildCountdown,
};
