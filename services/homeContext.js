// Dynamic home page context: greeting subtext, cards, streaks, weather.
// Pure data assembly — no HTML. View consumes whatever this returns.

const https = require('https');
const { WORKER_VISIBLE_STATUSES } = require('../lib/bookingLifecycle');

// A booking-linked shift only surfaces to crew once the allocator has
// committed the booking. Canonical list from lib/bookingLifecycle —
// the old local copy omitted 'locked', so a worker push-notified to
// accept a locked shift found no "shift tomorrow" card and a hero that
// said they were off. Allocations with no booking (pure job rosters)
// are unaffected.
const NOTIFIABLE_BOOKING_STATUSES = WORKER_VISIBLE_STATUSES;

// Date in Sydney timezone (YYYY-MM-DD). Railway containers run on UTC so
// using the JS Date getters lands on the previous day for several hours
// every Sydney evening. Everything worker-facing keys off this.
function localIso(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
}

// Priority order per spec (lower = higher priority)
const CARD_PRIORITY = {
  compliance_expiring: 10,
  compliance_overdue: 5,
  induction_overdue: 8,
  doc_acknowledge: 12,
  new_payslip: 20,
  allowance_approved: 25,
  shift_tomorrow: 30,
  roster_published: 35,
  swap_response: 28,
  kudos_received: 40,
  milestone_hit: 42,
  mood_checkin: 50,
  eap_reminder: 60,
};

// =========================================================
// Greeting subtext — priority-ordered rules
// =========================================================
function buildGreetingSubtext(db, worker, member, employee, todaysShifts) {
  const today = localIso(new Date());

  // 1. Cert expiring ≤14 days
  if (employee) {
    const soon = db.prepare(`
      SELECT competency_name, expiry_date FROM employee_competencies
      WHERE employee_id = ? AND expiry_date IS NOT NULL
        AND expiry_date <= date(?, '+14 days') AND expiry_date >= date(?)
      ORDER BY expiry_date ASC LIMIT 1
    `).get(employee.id, today, today);
    if (soon) {
      const days = Math.max(0, Math.round((new Date(soon.expiry_date) - new Date(today)) / 86400000));
      return { kind: 'compliance', text: `Your ${soon.competency_name} expires in ${days} day${days === 1 ? '' : 's'}` };
    }
  }

  // 2. Shift starting in <2hrs
  const imminentShift = (todaysShifts || []).find(s => {
    if (!s.start_time) return false;
    const [h, m] = s.start_time.split(':').map(Number);
    const start = new Date(); start.setHours(h, m || 0, 0, 0);
    const diffMin = (start - new Date()) / 60000;
    return diffMin > -1 && diffMin <= 120;
  });
  if (imminentShift) {
    return { kind: 'shift', text: `Your shift at ${imminentShift.suburb || imminentShift.client} starts at ${formatTime(imminentShift.start_time)}` };
  }

  // 3. Unviewed payslip
  if (employee) {
    try {
      const unviewed = db.prepare(`
        SELECT id, net_pay, pay_date FROM payslips
        WHERE employee_id = ? AND viewed_at IS NULL
        ORDER BY pay_date DESC LIMIT 1
      `).get(employee.id);
      if (unviewed) {
        const amount = Number(unviewed.net_pay || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return { kind: 'payslip', text: `New payslip ready — $${amount} net` };
      }
    } catch (e) { /* table may not exist on older deploys */ }
  }

  // 4. Pending leave
  const pendingLeave = db.prepare(`
    SELECT COUNT(*) as c FROM employee_leave WHERE crew_member_id = ? AND status = 'pending'
  `).get(worker.id).c;
  if (pendingLeave > 0) {
    return { kind: 'leave', text: `You have ${pendingLeave} leave request${pendingLeave === 1 ? '' : 's'} awaiting approval` };
  }

  // 5. Birthday today
  if (employee && employee.date_of_birth) {
    const dob = new Date(employee.date_of_birth);
    const now = new Date();
    if (dob.getMonth() === now.getMonth() && dob.getDate() === now.getDate()) {
      const first = (worker.full_name || '').split(' ')[0];
      return { kind: 'birthday', text: `Happy birthday, ${first} 🎂` };
    }
  }

  // 6. Work anniversary
  if (employee && employee.start_date) {
    const start = new Date(employee.start_date);
    const now = new Date();
    if (start.getMonth() === now.getMonth() && start.getDate() === now.getDate() && now > start) {
      const years = now.getFullYear() - start.getFullYear();
      if (years >= 1) return { kind: 'anniversary', text: `${years} year${years === 1 ? '' : 's'} with Sightline today 🎉` };
    }
  }

  // 7. Default based on shift status
  if (todaysShifts && todaysShifts.length > 0) return { kind: 'default', text: `You're scheduled on ${todaysShifts[0].client}` };

  // 8. Off today — give them the next shift if one is scheduled,
  //    instead of a dead-end "you're off" message.
  try {
    // LEFT JOIN + COALESCE like the home shift list — an INNER JOIN on jobs
    // silently dropped allocations for job-less bookings (job_id NULL), so
    // the hero said "no upcoming shifts" while the list showed one.
    const next = db.prepare(`
      SELECT a.allocation_date, a.start_time,
             COALESCE(j.client, b.title, b.booking_number) AS client
      FROM crew_allocations a
      LEFT JOIN jobs j ON j.id = a.job_id
      LEFT JOIN bookings b ON b.id = a.booking_id
      WHERE a.crew_member_id = ?
        AND a.allocation_date > ?
        AND (a.status IS NULL OR a.status != 'cancelled')
        AND (a.booking_id IS NULL OR b.status IN (${NOTIFIABLE_BOOKING_STATUSES.map(() => '?').join(',')}))
      ORDER BY a.allocation_date ASC, a.start_time ASC
      LIMIT 1
    `).get(worker.id, today, ...NOTIFIABLE_BOOKING_STATUSES);
    if (next) {
      const d = new Date(next.allocation_date + 'T00:00:00');
      const when = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      const time = next.start_time ? ` at ${formatTime(next.start_time)}` : '';
      return { kind: 'default', text: `You're off today. Next shift: ${next.client} — ${when}${time}` };
    }
  } catch (e) { /* table/col shape shift on older deploys */ }

  // 8b. Booking-sourced shifts with no crew_allocations row (the same
  // fallback the home shift list uses) — without this the hero said
  // "no upcoming shifts" while the Coming-up card right below showed one.
  try {
    const nextBk = db.prepare(`
      SELECT DATE(b.start_datetime) AS allocation_date,
             SUBSTR(b.start_datetime, 12, 5) AS start_time,
             b.title AS client
      FROM booking_crew bc
      JOIN bookings b ON b.id = bc.booking_id
      WHERE bc.crew_member_id = ?
        AND DATE(b.start_datetime) > ?
        AND bc.status IN ('assigned','confirmed')
        AND b.deleted_at IS NULL
        AND b.status IN (${NOTIFIABLE_BOOKING_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM crew_allocations ca WHERE ca.booking_id = bc.booking_id AND ca.crew_member_id = bc.crew_member_id)
      ORDER BY b.start_datetime ASC LIMIT 1
    `).get(worker.id, today, ...NOTIFIABLE_BOOKING_STATUSES);
    if (nextBk) {
      const d = new Date(nextBk.allocation_date + 'T00:00:00');
      const when = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      const time = nextBk.start_time ? ` at ${formatTime(nextBk.start_time)}` : '';
      return { kind: 'default', text: `You're off today. Next shift: ${nextBk.client} — ${when}${time}` };
    }
  } catch (e) { /* booking_crew may not exist on legacy DBs */ }

  return { kind: 'default', text: "You're off today. No upcoming shifts scheduled." };
}

function formatTime(t) {
  if (!t) return '';
  const [hStr, m] = String(t).split(':');
  let h = parseInt(hStr, 10);
  const am = h < 12;
  h = h % 12; if (h === 0) h = 12;
  return h + ((m && m !== '00') ? ':' + m : '') + (am ? 'am' : 'pm');
}

// =========================================================
// Cards — derive from data, merge with persisted dismissals
// =========================================================
function buildSmartCards(db, worker, member, employee) {
  const today = localIso(new Date());
  const derived = [];

  // Compliance cards (per-cert expiring)
  if (employee) {
    const expiringCerts = db.prepare(`
      SELECT id, competency_name, expiry_date FROM employee_competencies
      WHERE employee_id = ? AND expiry_date IS NOT NULL
        AND expiry_date <= date(?, '+30 days')
      ORDER BY expiry_date ASC LIMIT 3
    `).all(employee.id, today);
    for (const c of expiringCerts) {
      const days = Math.round((new Date(c.expiry_date) - new Date(today)) / 86400000);
      const overdue = days < 0;
      derived.push({
        card_key: `cert_${c.id}`,
        card_type: overdue ? 'compliance_overdue' : 'compliance_expiring',
        priority: overdue ? 5 : CARD_PRIORITY.compliance_expiring,
        payload: {
          icon: 'shield',
          tone: overdue ? 'red' : 'amber',
          title: overdue ? `${c.competency_name} has expired` : `${c.competency_name} expires soon`,
          body: overdue ? `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago — renew ASAP` : `${days} day${days === 1 ? '' : 's'} left · renew now`,
          cta: 'Renew',
          link: '/w/hr/certs',
        }
      });
    }

    // Induction overdue
    if (employee.induction_status && employee.induction_status !== 'completed') {
      derived.push({
        card_key: 'induction_overdue',
        card_type: 'induction_overdue',
        priority: CARD_PRIORITY.induction_overdue,
        payload: {
          icon: 'document',
          tone: 'amber',
          title: 'Induction still open',
          body: 'Finish your induction to stay allocatable',
          cta: 'Open',
          link: '/induction',
        }
      });
    }
  }

  // Shift tomorrow — pulls from crew_allocations and falls back through
  // jobs → bookings so booking-only shifts (no job_id) still show a real
  // place name in the card instead of "null".
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomIso = localIso(tomorrow);
  const tomorrowShift = db.prepare(`
    SELECT ca.start_time, ca.end_time, ca.shift_type,
           COALESCE(NULLIF(j.suburb, ''),       NULLIF(b.suburb, ''))       AS suburb,
           COALESCE(NULLIF(j.site_address, ''), NULLIF(b.site_address, '')) AS site_address,
           COALESCE(NULLIF(j.client, ''),       NULLIF(b.title, ''))        AS client
    FROM crew_allocations ca
    LEFT JOIN jobs j     ON ca.job_id = j.id
    LEFT JOIN bookings b ON ca.booking_id = b.id
    WHERE ca.crew_member_id = ? AND ca.allocation_date = ? AND ca.status != 'cancelled'
      AND (ca.booking_id IS NULL OR b.status IN (${NOTIFIABLE_BOOKING_STATUSES.map(() => '?').join(',')}))
    ORDER BY ca.start_time ASC LIMIT 1
  `).get(worker.id, tomIso, ...NOTIFIABLE_BOOKING_STATUSES);
  if (tomorrowShift) {
    // Title: prefer suburb, then street address, then client name. Body:
    // skip the "with X" tail entirely if we have nothing meaningful — an
    // empty suffix beats a literal "null".
    const place = tomorrowShift.suburb || tomorrowShift.site_address || tomorrowShift.client || 'your shift';
    const tail  = tomorrowShift.client && tomorrowShift.client !== place ? ` with ${tomorrowShift.client}` : '';
    derived.push({
      card_key: `shift_${tomIso}`,
      card_type: 'shift_tomorrow',
      priority: CARD_PRIORITY.shift_tomorrow,
      payload: {
        icon: 'calendar',
        tone: 'blue',
        title: `Shift tomorrow at ${place}`,
        body: `${formatTime(tomorrowShift.start_time)}–${formatTime(tomorrowShift.end_time)}${tail}`,
        cta: 'Details',
        link: '/w/shifts',
      }
    });
  }

  // Unviewed payslips — one card per new one
  if (employee) {
    try {
      const unviewed = db.prepare(`
        SELECT id, net_pay, pay_date FROM payslips
        WHERE employee_id = ? AND viewed_at IS NULL
        ORDER BY pay_date DESC LIMIT 2
      `).all(employee.id);
      for (const p of unviewed) {
        const amount = Number(p.net_pay || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const dStr = new Date(p.pay_date + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
        derived.push({
          card_key: `payslip_${p.id}`,
          card_type: 'new_payslip',
          priority: 20, // CARD_PRIORITY.new_payslip
          payload: {
            icon: 'cash',
            tone: 'emerald',
            title: `Payslip ready — ${dStr}`,
            body: `$${amount} net in your account`,
            cta: 'View',
            link: '/w/hr/payslips',
          }
        });
      }
    } catch (e) { /* table may not exist yet */ }
  }

  // Pending leave acknowledgment card
  const pendingLeaveRow = db.prepare(`
    SELECT id, start_date FROM employee_leave WHERE crew_member_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1
  `).get(worker.id);
  if (pendingLeaveRow) {
    derived.push({
      card_key: `leave_${pendingLeaveRow.id}`,
      card_type: 'leave_pending',
      priority: 45,
      payload: {
        icon: 'plane',
        tone: 'indigo',
        title: 'Leave awaiting approval',
        body: `Submitted for ${new Date(pendingLeaveRow.start_date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`,
        cta: 'View',
        link: '/w/hr/leave',
      }
    });
  }

  // Leave DECISION card. The pending card above used to just vanish once
  // the office decided, so a worker never learned the outcome in the app.
  // Grouped by request_group_id (migration 343) so a Mon-Fri block is one
  // card, and the rejection reason (employee_leave.notes) is carried
  // through — a bare "declined" with no reason is worse than useless.
  try {
    const decided = db.prepare(`
      SELECT request_group_id AS gid, status,
             MIN(start_date) AS start_date, MAX(end_date) AS end_date,
             COUNT(*) AS day_count, MAX(notes) AS decision_note,
             MAX(approved_at) AS approved_at
      FROM employee_leave
      WHERE crew_member_id = ?
        AND status IN ('approved','rejected')
        AND approved_at IS NOT NULL
        AND approved_at >= datetime('now', '-14 days')
      GROUP BY request_group_id, status
      ORDER BY MAX(approved_at) DESC
      LIMIT 1
    `).get(worker.id);
    if (decided && decided.gid) {
      const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      const when = decided.start_date === decided.end_date
        ? fmt(decided.start_date)
        : `${fmt(decided.start_date)} – ${fmt(decided.end_date)} (${decided.day_count} days)`;
      const ok = decided.status === 'approved';
      derived.push({
        card_key: `leave_decision_${decided.gid}`,
        card_type: ok ? 'leave_approved' : 'leave_rejected',
        priority: 44,
        payload: {
          icon: 'plane',
          tone: ok ? 'emerald' : 'red',
          title: ok ? 'Leave approved' : 'Leave not approved',
          body: ok
            ? `${when} — you're all set.`
            : `${when}${decided.decision_note ? ' — ' + decided.decision_note : ' — speak to your supervisor.'}`,
          cta: 'View',
          link: '/w/hr/leave',
        }
      });
    }
  } catch (e) { /* pre-migration-343 deploy: no request_group_id column */ }

  // Prune stale "shift_<iso>" cards — the buildSmartCards run for
  // tomorrow's shift writes a card keyed by tomorrow's ISO date. Once
  // that date passes (or the next day's run swaps in a new key), the
  // old card sticks around in the For-You feed reading "Shift tomorrow"
  // even though that shift is now today's shift. Wipe any shift_* keys
  // whose date is before today so they don't accumulate.
  try {
    const today = localIso(new Date());
    // Use <= so the card generated yesterday (key = today's iso) gets
    // wiped — at that point the shift is no longer "tomorrow", it's
    // either today or in the past, and the Today timeline covers it.
    db.prepare(`
      DELETE FROM home_cards
      WHERE crew_member_id = ?
        AND card_type = 'shift_tomorrow'
        AND card_key <= ?
    `).run(worker.id, 'shift_' + today);
  } catch (e) { /* ignore */ }

  // Prune "leave awaiting approval" cards whose request has since been
  // decided. Cards are upserted and never expire on their own, so without
  // this the worker keeps seeing "Leave awaiting approval" sitting right
  // next to the "Leave approved / not approved" card for the same request.
  try {
    db.prepare(`
      DELETE FROM home_cards
      WHERE crew_member_id = ?
        AND card_type = 'leave_pending'
        AND CAST(REPLACE(card_key, 'leave_', '') AS INTEGER) IN (
          SELECT id FROM employee_leave WHERE crew_member_id = ? AND status != 'pending'
        )
    `).run(worker.id, worker.id);
  } catch (e) { /* ignore */ }

  // Upsert derived cards — keep existing dismissals/acks
  const upsert = db.prepare(`
    INSERT INTO home_cards (crew_member_id, card_type, card_key, priority, payload, shown_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(crew_member_id, card_key) DO UPDATE SET
      card_type = excluded.card_type,
      priority = excluded.priority,
      payload = excluded.payload,
      shown_at = COALESCE(home_cards.shown_at, excluded.shown_at)
  `);
  const tx = db.transaction(() => {
    for (const c of derived) {
      upsert.run(worker.id, c.card_type, c.card_key, c.priority, JSON.stringify(c.payload));
    }
  });
  try { tx(); } catch (e) { /* ignore — table may not be there yet */ }

  // Fetch active cards (not dismissed, not acted), ordered by priority
  const rows = db.prepare(`
    SELECT * FROM home_cards
    WHERE crew_member_id = ? AND dismissed_at IS NULL AND acted_at IS NULL
    ORDER BY priority ASC, id DESC LIMIT 5
  `).all(worker.id);

  return rows.map(r => ({
    id: r.id, card_type: r.card_type, card_key: r.card_key, priority: r.priority,
    payload: JSON.parse(r.payload || '{}'),
  }));
}

// =========================================================
// Streaks — compute current/best from existing data
// =========================================================
function buildStreaks(db, worker) {
  const out = {};

  // Shift streak: consecutive calendar days with at least one clock_in
  const recent = db.prepare(`
    SELECT DISTINCT DATE(event_time) as d FROM clock_events
    WHERE crew_member_id = ? AND event_type = 'clock_in'
    ORDER BY d DESC LIMIT 90
  `).all(worker.id).map(r => r.d);
  let streak = 0;
  if (recent.length > 0) {
    const today = localIso(new Date());
    const yesterday = localIso(new Date(Date.now() - 86400000));
    let cursor = recent.includes(today) ? new Date(today) : recent.includes(yesterday) ? new Date(yesterday) : null;
    while (cursor) {
      const iso = localIso(cursor);
      if (recent.includes(iso)) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
      } else break;
    }
  }
  out.shift_streak = { label: 'Shift streak', current: streak, unit: 'days', tone: 'emerald', iconKey: 'fire' };

  // Incident-free days (personal) — days since induction (no direct crew↔incident link)
  let incidentFree = 0;
  try {
    const member = db.prepare('SELECT induction_date FROM crew_members WHERE id = ?').get(worker.id);
    if (member && member.induction_date) {
      incidentFree = Math.max(0, Math.floor((new Date() - new Date(member.induction_date)) / 86400000));
    }
  } catch (e) { /* ignore */ }
  out.incident_free = { label: 'Incident-free', current: incidentFree, unit: 'days', tone: 'blue', iconKey: 'shield' };

  // Forms-on-time streak — count safety_forms submissions in last 30 days (table may not exist)
  let formsStreak = 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as c FROM safety_forms WHERE crew_member_id = ? AND submitted_at >= date('now', '-30 days')`).get(worker.id);
    formsStreak = row ? row.c : 0;
  } catch (e) { /* table may not exist */ }
  out.forms_streak = { label: 'Forms this month', current: formsStreak, unit: '', tone: 'purple', iconKey: 'check' };

  // Hours → next milestone (1000hr club)
  const hoursRow = db.prepare(`
    SELECT COALESCE(SUM(total_hours), 0) as hrs FROM timesheets WHERE crew_member_id = ?
  `).get(worker.id);
  const totalHrs = Math.round(hoursRow.hrs || 0);
  const milestones = [100, 250, 500, 1000, 2500, 5000];
  const nextMs = milestones.find(m => totalHrs < m) || (totalHrs + 1000);
  out.hours_milestone = {
    label: `Next milestone: ${nextMs}h`, current: totalHrs, unit: `/ ${nextMs}`,
    tone: 'amber', iconKey: 'trophy',
    progress: Math.min(100, Math.round((totalHrs / nextMs) * 100))
  };

  // Persist into streaks table (best_count tracked)
  const persist = db.prepare(`
    INSERT INTO streaks (crew_member_id, streak_type, current_count, best_count, last_incremented_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(crew_member_id, streak_type) DO UPDATE SET
      current_count = excluded.current_count,
      best_count = CASE WHEN excluded.current_count > streaks.best_count THEN excluded.current_count ELSE streaks.best_count END,
      last_incremented_at = excluded.last_incremented_at
  `);
  try {
    persist.run(worker.id, 'shift_streak', streak, streak);
    persist.run(worker.id, 'incident_free', incidentFree, incidentFree);
    persist.run(worker.id, 'hours_milestone', totalHrs, totalHrs);
  } catch (e) { /* ignore */ }

  return out;
}

// =========================================================
// Weather — Open-Meteo (free, no API key)
// https://open-meteo.com/en/docs  +  https://open-meteo.com/en/docs/geocoding-api
// =========================================================
const weatherCache = new Map(); // key → { expires, data }

function fetchJson(url, timeoutMs = 3500) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// WMO weather codes → friendly label + emoji + kind. `kind` is one of
// sunny / partly-cloudy / cloudy / rainy / stormy / snow / fog / night.
// The caller folds is_day into the result: clear / partly-cloudy /
// cloudy at night collapse to `night`, but rainy/stormy/snow/fog keep
// their precipitation kind so the worker still sees the conditions
// that matter on shift.
// Full table: https://open-meteo.com/en/docs#weathervariables
function describeWmo(code) {
  const map = {
    0:  ['Clear sky',         '☀️',  'sunny'],
    1:  ['Mostly sunny',      '🌤️', 'sunny'],
    2:  ['Partly cloudy',     '⛅',  'partly-cloudy'],
    3:  ['Overcast',          '☁️',  'cloudy'],
    45: ['Fog',               '🌫️', 'fog'],
    48: ['Fog',               '🌫️', 'fog'],
    51: ['Light drizzle',     '🌦️', 'rainy'],
    53: ['Drizzle',           '🌦️', 'rainy'],
    55: ['Heavy drizzle',     '🌧️', 'rainy'],
    56: ['Freezing drizzle',  '🌧️', 'rainy'],
    57: ['Freezing drizzle',  '🌧️', 'rainy'],
    61: ['Light rain',        '🌦️', 'rainy'],
    63: ['Rain',              '🌧️', 'rainy'],
    65: ['Heavy rain',        '🌧️', 'rainy'],
    66: ['Freezing rain',     '🌧️', 'rainy'],
    67: ['Freezing rain',     '🌧️', 'rainy'],
    71: ['Light snow',        '🌨️', 'snow'],
    73: ['Snow',              '🌨️', 'snow'],
    75: ['Heavy snow',        '❄️',  'snow'],
    77: ['Snow grains',       '❄️',  'snow'],
    80: ['Light showers',     '🌦️', 'rainy'],
    81: ['Showers',           '🌧️', 'rainy'],
    82: ['Heavy showers',     '⛈️', 'stormy'],
    85: ['Snow showers',      '🌨️', 'snow'],
    86: ['Snow showers',      '🌨️', 'snow'],
    95: ['Thunderstorm',         '⛈️', 'stormy'],
    96: ['Thunderstorm w/ hail', '⛈️', 'stormy'],
    99: ['Thunderstorm w/ hail', '⛈️', 'stormy'],
  };
  return map[code] || ['—', '🌡️', 'cloudy'];
}

async function getWeather(lat, lng) {
  if (lat == null || lng == null) return null;
  const cacheKey = `wx:${(+lat).toFixed(2)}:${(+lng).toFixed(2)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation,relative_humidity_2m,is_day` +
    `&daily=precipitation_probability_max,uv_index_max,temperature_2m_max,temperature_2m_min` +
    `&timezone=Australia%2FSydney`;
  const j = await fetchJson(url);
  if (!j || !j.current) return null;
  let [desc, emoji, kind] = describeWmo(j.current.weather_code);
  // Open-Meteo returns is_day=1 for day, 0 for night (based on lat/lng +
  // local time). At night, "clear sky" should read as moonlit, not sunny —
  // but precipitation kinds (rainy/stormy/snow/fog) keep their kind so the
  // worker still sees the conditions on shift.
  const isDay = j.current.is_day;
  if (isDay === 0 && (kind === 'sunny' || kind === 'partly-cloudy' || kind === 'cloudy')) {
    kind = 'night';
    if (j.current.weather_code === 0 || j.current.weather_code === 1) {
      desc = 'Clear night';
      emoji = '🌙';
    } else if (j.current.weather_code === 2) {
      desc = 'Partly cloudy night';
      emoji = '☁️';
    }
  }
  const out = {
    temp: Math.round(j.current.temperature_2m),
    feels_like: Math.round(j.current.apparent_temperature),
    description: desc,
    condition: desc,
    emoji,
    kind,
    is_day: isDay === undefined ? 1 : isDay,
    wind_kmh: Math.round(j.current.wind_speed_10m || 0),
    rain_chance: (j.daily && j.daily.precipitation_probability_max) ? (j.daily.precipitation_probability_max[0] || 0) : 0,
    uv: (j.daily && j.daily.uv_index_max) ? Math.round((j.daily.uv_index_max[0] || 0) * 10) / 10 : null,
    hi: (j.daily && j.daily.temperature_2m_max) ? Math.round(j.daily.temperature_2m_max[0]) : null,
    lo: (j.daily && j.daily.temperature_2m_min) ? Math.round(j.daily.temperature_2m_min[0]) : null,
    humidity: j.current.relative_humidity_2m != null ? Math.round(j.current.relative_humidity_2m) : null,
    icon: '', // kept for back-compat with any view that used OpenWeatherMap icon URL
  };
  // 15-minute cache: 1h was too coarse — a sunny midday reading was
  // still showing at 9pm in rain. 15min keeps API load low while still
  // catching condition changes within a typical shift gap.
  weatherCache.set(cacheKey, { expires: Date.now() + 15 * 60 * 1000, data: out });
  return out;
}

// Strip Australian state suffixes and postcodes — Open-Meteo's geocoder expects
// just the locality name and returns zero results for things like "Villawood NSW".
function normaliseAuQuery(q) {
  return String(q || '')
    .replace(/\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/gi, '')
    .replace(/\b\d{4}\b/g, '')  // postcodes
    .replace(/,\s*,/g, ',')
    .replace(/^,|,$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Geocode a suburb/address using Open-Meteo's free geocoding API.
// Falls back through comma-separated parts so we still match on just the suburb
// when a full address doesn't geocode cleanly.
async function geocodeAddress(q) {
  if (!q) return null;
  const cacheKey = `geo:${q}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const cleaned = normaliseAuQuery(q);
  const candidates = [cleaned];
  // If the cleaned query has multiple parts, try each suffix from the right (usually suburb)
  const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
  for (let i = 1; i < parts.length; i++) candidates.push(parts.slice(i).join(', '));
  if (parts.length) candidates.push(parts[parts.length - 1]);

  for (const cand of candidates) {
    if (!cand) continue;
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cand)}&country=AU&count=1&language=en&format=json`;
    const j = await fetchJson(url);
    if (j && Array.isArray(j.results) && j.results[0]) {
      const r = j.results[0];
      const out = { lat: r.latitude, lng: r.longitude, city: r.name };
      weatherCache.set(cacheKey, { expires: Date.now() + 24 * 3600 * 1000, data: out });
      return out;
    }
  }
  return null;
}

// =========================================================
// Today timeline blocks — shift start/end, scheduled forms, pay
// =========================================================
function buildTodayTimeline(todaysShifts) {
  if (!todaysShifts || todaysShifts.length === 0) return null;
  const s = todaysShifts[0];
  const [sh, sm] = (s.start_time || '06:00').split(':').map(Number);
  const [eh, em] = (s.end_time || '18:00').split(':').map(Number);
  const startMin = (sh || 0) * 60 + (sm || 0);
  // Overnight shift (end on the next calendar day): unwrap before the
  // midpoint maths, or a 22:00–06:00 shift got its "Scheduled break" at
  // 14:00 — eight hours before it starts.
  let endMin = (eh || 0) * 60 + (em || 0);
  if (endMin <= startMin) endMin += 24 * 60;

  const blocks = [];
  // Labels say what actually happens — there is no clock-on flow in the
  // portal, the shift bookends are the pre-start and the docket.
  blocks.push({ kind: 'shift_start', label: 'Shift start', at: s.start_time, icon: 'play' });
  // Pre-start form 15 min before
  blocks.push({ kind: 'prestart', label: 'Pre-start check', at: minutesToTime(Math.max(0, startMin - 15)), icon: 'check' });
  // Break — mid-shift
  const midMin = Math.round((startMin + endMin) / 2);
  blocks.push({ kind: 'break', label: 'Scheduled break', at: minutesToTime(midMin % (24 * 60)), icon: 'coffee' });
  blocks.push({ kind: 'shift_end', label: 'Shift finish', at: s.end_time, icon: 'stop' });

  return {
    startMin, endMin,
    shiftLabel: `${s.client} — ${s.suburb || ''}`,
    blocks,
  };
}

function minutesToTime(m) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// =========================================================
// Preferences
// =========================================================
function loadPreferences(db, worker) {
  try {
    const row = db.prepare('SELECT * FROM home_preferences WHERE crew_member_id = ?').get(worker.id);
    if (!row) return { section_order: null, hidden_sections: [], fab_actions: null };
    return {
      section_order: safeParse(row.section_order, null),
      hidden_sections: safeParse(row.hidden_sections, []),
      fab_actions: safeParse(row.fab_actions, null),
    };
  } catch (e) { return { section_order: null, hidden_sections: [], fab_actions: null }; }
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// =========================================================
// Sydney day outlook — hourly forecast powering the admin
// dashboard's control-room console (day-bar rain band, wet
// windows, hourly strip). Same Open-Meteo + cache machinery
// as getWeather above; separate call because it needs the
// HOURLY series, not just current conditions.
// =========================================================
const SYDNEY_LAT = -33.8688;
const SYDNEY_LNG = 151.2093;
// An hour with precipitation probability at or above this is "wet" —
// contiguous wet hours merge into wetWindows for the day-bar overlay
// and the crews-in-the-wet-window warning.
const WET_PROB = 60;

async function getSydneyOutlook() {
  if (process.env.DISABLE_WEATHER) return null; // hermetic e2e runs
  const cacheKey = 'wx-outlook:sydney';
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.data;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${SYDNEY_LAT}&longitude=${SYDNEY_LNG}` +
    `&current=temperature_2m,weather_code,wind_speed_10m,is_day` +
    `&hourly=precipitation_probability,temperature_2m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&timezone=Australia%2FSydney&forecast_days=2`;
  const j = await fetchJson(url);
  if (!j || !j.current || !j.hourly || !Array.isArray(j.hourly.time)) return null;

  // Today's hours only (Open-Meteo returns local ISO strings because we
  // pass timezone=Australia/Sydney). Keep the full day; consumers slice.
  const todayIso = j.hourly.time.length ? j.hourly.time[0].slice(0, 10) : '';
  const hours = [];
  for (let i = 0; i < j.hourly.time.length; i++) {
    const t = j.hourly.time[i];
    if (t.slice(0, 10) !== todayIso) break;
    const [, , hkind] = describeWmo(j.hourly.weather_code[i]);
    hours.push({
      hm: t.slice(11, 16),
      hour: parseInt(t.slice(11, 13), 10),
      temp: Math.round(j.hourly.temperature_2m[i]),
      precipProb: j.hourly.precipitation_probability[i] == null ? 0 : j.hourly.precipitation_probability[i],
      kind: hkind,
    });
  }

  // Merge contiguous wet hours into windows. A window's `to` is the END of
  // its last wet hour (hh+1:00) — rain at 14:00–16:00 prob spans to 17:00.
  const wetWindows = [];
  let cur = null;
  for (const h of hours) {
    if (h.precipProb >= WET_PROB) {
      if (!cur) cur = { fromHour: h.hour, toHour: h.hour + 1, maxProb: h.precipProb };
      else { cur.toHour = h.hour + 1; cur.maxProb = Math.max(cur.maxProb, h.precipProb); }
    } else if (cur) { wetWindows.push(cur); cur = null; }
  }
  if (cur) wetWindows.push(cur);
  for (const w of wetWindows) {
    w.from = String(w.fromHour).padStart(2, '0') + ':00';
    w.to = String(Math.min(w.toHour, 24)).padStart(2, '0') + ':00';
  }

  const [desc, emoji, kind] = describeWmo(j.current.weather_code);
  const out = {
    current: {
      temp: Math.round(j.current.temperature_2m),
      desc,
      emoji,
      kind,
      windKmh: Math.round(j.current.wind_speed_10m || 0),
      isDay: j.current.is_day !== 0,
    },
    hours,
    hi: j.daily && j.daily.temperature_2m_max ? Math.round(j.daily.temperature_2m_max[0]) : null,
    lo: j.daily && j.daily.temperature_2m_min ? Math.round(j.daily.temperature_2m_min[0]) : null,
    wetWindows,
    wetProb: WET_PROB,
  };
  weatherCache.set(cacheKey, { expires: Date.now() + 15 * 60 * 1000, data: out });
  return out;
}

module.exports = {
  buildGreetingSubtext,
  buildSmartCards,
  buildStreaks,
  buildTodayTimeline,
  loadPreferences,
  getWeather,
  getSydneyOutlook,
  geocodeAddress,
  formatTime,
  localIso,
};
