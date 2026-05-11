// Seek applicant tracker — replaces the monthly Excel tracker admin used to
// keep for inbound Seek applicants. Lives under /induction/admin/recruitment
// so it sits inside the existing Registry form area as another tab.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// Status / dropdown vocab — kept in code (not DB) so the UI never gets out of
// sync with the tracker's expected values.
const STATUSES = ['New', 'Contacted', 'Induction Scheduled', 'Inducted', 'Hired', 'Not Suitable', 'Withdrew', 'No Show'];
const CALLED_OPTS = ['', 'Yes', 'No'];
const INTERESTED_OPTS = ['', 'Yes', 'No', 'Maybe', 'No Answer', 'Callback'];
const BOOKED_OPTS = ['', 'Yes', 'No'];

// Weekly target band for the green/yellow/red call-target indicator.
const WEEKLY_TARGET_MIN = 5;
const WEEKLY_TARGET_MAX = 10;

// Return Mon-Sun week ranges that overlap the given month. Always returns at
// least 4 ranges, up to 6 depending on how the month falls. Each range is
// { label, start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } (inclusive end).
function weeksForMonth(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = new Date(Date.UTC(year, month, 0)); // last day of month
  // Move to the Monday on/before the 1st.
  const startDow = first.getUTCDay(); // 0=Sun, 1=Mon
  const offsetToMon = startDow === 0 ? -6 : 1 - startDow;
  const cursor = new Date(first);
  cursor.setUTCDate(cursor.getUTCDate() + offsetToMon);

  const out = [];
  let n = 1;
  while (cursor <= last) {
    const ws = new Date(cursor);
    const we = new Date(cursor); we.setUTCDate(we.getUTCDate() + 6);
    out.push({
      n,
      label: `Wk ${n}`,
      range: `${shortDate(ws)} – ${shortDate(we)}`,
      start: iso(ws),
      end: iso(we),
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
    n++;
    if (n > 6) break;
  }
  return out;
}
function iso(d) { return d.toISOString().slice(0, 10); }
function shortDate(d) {
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// GET /induction/admin/recruitment — main page, filtered to one month
router.get('/', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  // last day of the month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  // Pull every applicant whose date_applied OR date_called OR induction_date
  // falls in the month. That matches how the spreadsheet treats a month — if
  // any activity happened that month, the person shows up.
  const applicants = db.prepare(`
    SELECT * FROM seek_applicants
    WHERE (date_applied   BETWEEN ? AND ?)
       OR (date_called    BETWEEN ? AND ?)
       OR (induction_date BETWEEN ? AND ?)
    ORDER BY COALESCE(date_applied, date_called, induction_date) ASC, id ASC
  `).all(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

  // Monthly summary
  const stats = {
    total:      applicants.length,
    called:     applicants.filter(a => (a.called || '').toLowerCase() === 'yes').length,
    interested: applicants.filter(a => (a.interested || '').toLowerCase() === 'yes').length,
    booked:     applicants.filter(a => (a.induction_booked || '').toLowerCase() === 'yes').length,
    hired:      applicants.filter(a => (a.status || '').toLowerCase() === 'hired').length,
  };

  // Weekly call counts — count by date_called falling in each week.
  const weeks = weeksForMonth(year, month).map(w => {
    const count = applicants.filter(a => a.date_called && a.date_called >= w.start && a.date_called <= w.end).length;
    let band = 'under'; // under = <5, on = 5-10, over = >10
    if (count >= WEEKLY_TARGET_MIN && count <= WEEKLY_TARGET_MAX) band = 'on';
    else if (count > WEEKLY_TARGET_MAX) band = 'over';
    return { ...w, count, band };
  });

  res.render('induction/admin/recruitment', {
    title: 'Recruitment',
    currentPage: 'induction',
    applicants,
    stats,
    weeks,
    year,
    month,
    statuses: STATUSES,
    calledOpts: CALLED_OPTS,
    interestedOpts: INTERESTED_OPTS,
    bookedOpts: BOOKED_OPTS,
    targetMin: WEEKLY_TARGET_MIN,
    targetMax: WEEKLY_TARGET_MAX,
  });
});

// POST /induction/admin/recruitment — create a new applicant.
router.post('/', (req, res) => {
  const db = getDb();
  const name = (req.body.applicant_name || '').toString().trim().slice(0, 200);
  if (!name) { req.flash('error', 'Applicant name is required.'); return res.redirect(backUrl(req)); }
  db.prepare(`
    INSERT INTO seek_applicants (applicant_name, phone, email, date_applied, status, notes, created_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    name,
    (req.body.phone || '').toString().trim().slice(0, 60),
    (req.body.email || '').toString().trim().slice(0, 200),
    (req.body.date_applied || null) || null,
    STATUSES.includes(req.body.status) ? req.body.status : 'New',
    (req.body.notes || '').toString().slice(0, 2000),
    req.session.user.id,
  );
  req.flash('success', `Added ${name}.`);
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id — partial update. Only the fields
// actually present in the body get touched, so the row-inline status drops
// don't blow away the name/phone/notes.
router.post('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id FROM seek_applicants WHERE id = ?').get(req.params.id);
  if (!row) { req.flash('error', 'Applicant not found.'); return res.redirect(backUrl(req)); }

  const sets = [];
  const params = [];
  const allowText = {
    applicant_name: { max: 200 },
    phone: { max: 60 },
    email: { max: 200 },
    notes: { max: 2000 },
  };
  for (const [k, opts] of Object.entries(allowText)) {
    if (typeof req.body[k] !== 'undefined') {
      sets.push(`${k} = ?`);
      params.push((req.body[k] || '').toString().slice(0, opts.max));
    }
  }
  const allowDate = ['date_applied', 'date_called', 'induction_date'];
  for (const k of allowDate) {
    if (typeof req.body[k] !== 'undefined') {
      sets.push(`${k} = ?`);
      params.push(req.body[k] || null);
    }
  }
  if (typeof req.body.called !== 'undefined' && CALLED_OPTS.includes(req.body.called)) {
    sets.push('called = ?'); params.push(req.body.called);
  }
  if (typeof req.body.interested !== 'undefined' && INTERESTED_OPTS.includes(req.body.interested)) {
    sets.push('interested = ?'); params.push(req.body.interested);
  }
  if (typeof req.body.induction_booked !== 'undefined' && BOOKED_OPTS.includes(req.body.induction_booked)) {
    sets.push('induction_booked = ?'); params.push(req.body.induction_booked);
  }
  if (typeof req.body.status !== 'undefined' && STATUSES.includes(req.body.status)) {
    sets.push('status = ?'); params.push(req.body.status);
  }

  if (!sets.length) return res.redirect(backUrl(req));
  sets.push("updated_at = CURRENT_TIMESTAMP");
  params.push(row.id);
  db.prepare(`UPDATE seek_applicants SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  // AJAX inline-edit returns JSON so the page doesn't have to reload on every
  // dropdown change.
  if ((req.headers.accept || '').includes('application/json') || req.xhr) {
    return res.json({ ok: true });
  }
  res.redirect(backUrl(req));
});

// POST /induction/admin/recruitment/:id/delete — remove a row.
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM seek_applicants WHERE id = ?').run(req.params.id);
  req.flash('success', 'Applicant removed.');
  res.redirect(backUrl(req));
});

// GET /induction/admin/recruitment/export.csv — backup the current month as
// a CSV that opens straight in Excel. Keeps the user's "I want my spreadsheet"
// muscle memory working.
router.get('/export.csv', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const rows = db.prepare(`
    SELECT * FROM seek_applicants
    WHERE (date_applied BETWEEN ? AND ?)
       OR (date_called  BETWEEN ? AND ?)
       OR (induction_date BETWEEN ? AND ?)
    ORDER BY COALESCE(date_applied, date_called, induction_date) ASC, id ASC
  `).all(monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd);

  const headers = ['#','Applicant Name','Phone','Email','Date Applied','Date Called','Called?','Interested?','Induction Booked?','Induction Date','Status','Notes'];
  const lines = [headers.join(',')];
  rows.forEach((r, i) => {
    const cells = [
      i + 1,
      r.applicant_name, r.phone, r.email,
      r.date_applied || '', r.date_called || '', r.called || '',
      r.interested || '', r.induction_booked || '',
      r.induction_date || '', r.status || '', r.notes || '',
    ].map(csvCell);
    lines.push(cells.join(','));
  });

  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(' ', '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Seek_Applicants_${monthLabel}.csv"`);
  res.send(lines.join('\r\n'));
});

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function backUrl(req) {
  const y = req.body.year || req.query.year;
  const m = req.body.month || req.query.month;
  const qp = [];
  if (y) qp.push('year=' + encodeURIComponent(y));
  if (m) qp.push('month=' + encodeURIComponent(m));
  return '/induction/admin/recruitment' + (qp.length ? '?' + qp.join('&') : '');
}

module.exports = router;
