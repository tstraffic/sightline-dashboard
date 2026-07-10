// Equipment / Hire — the "Hired" register (month-to-month) + the "Rates" tab
// (a fresh per-company rate database that auto-applies when raising a hire).
// Mounted at /equipment/hire, BEFORE /equipment so the catch-all GET /:id in
// routes/equipment.js doesn't swallow these paths.
const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { EQUIPMENT_TYPES, getEquipmentType, getPowerKind } = require('../lib/hireDocketConfig');

const RATE_UNITS = ['hour', 'day', 'week', 'month'];

// ---- date helpers (UTC; hire dates are plain DATE columns) ----
function monthBounds(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    daysInMonth: lastDay,
  };
}
function daysInclusive(aIso, bIso) {
  return Math.round((Date.parse(bIso + 'T00:00:00Z') - Date.parse(aIso + 'T00:00:00Z')) / 86400000) + 1;
}
// Cost of a hire attributable to the selected month, prorated by overlap days.
// Returns null for hourly rates (hours/day unknown — can't infer a month cost).
function monthlyCostFor(hire, bounds) {
  const hStart = hire.start_date || bounds.start;
  const hEnd = hire.end_date || bounds.end;        // open-ended → through end of month
  const from = hStart > bounds.start ? hStart : bounds.start;
  const to = hEnd < bounds.end ? hEnd : bounds.end;
  if (from > to) return 0;
  const overlap = daysInclusive(from, to);
  let daily;
  if (hire.rate_unit === 'day') daily = hire.rate;
  else if (hire.rate_unit === 'week') daily = hire.rate / 7;
  else if (hire.rate_unit === 'month') daily = hire.rate / bounds.daysInMonth;
  else return null; // hour
  return daily * overlap * (hire.quantity || 1);
}
function typeLabel(value) {
  const t = getEquipmentType(value);
  return t ? t.label : (value || '—');
}
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

// ---- per-unit helpers (equipment_hire_units, migration 315) ----
// Parse the form's unit_numbers[] into a clean array of trimmed strings.
function parseUnitNumbers(raw) {
  const arr = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
  return arr.map(s => String(s).trim().slice(0, 80));
}
// Bring a hire's unit rows in line with quantity + typed numbers. Returned
// units are history — never touched; only the unreturned pool is resized and
// renumbered. Returns the (possibly clamped) effective quantity.
function syncUnits(db, hireId, quantity, numbers) {
  const returned = db.prepare('SELECT COUNT(*) AS n FROM equipment_hire_units WHERE hire_id = ? AND returned_at IS NOT NULL').get(hireId).n;
  const qty = Math.max(returned || 0, Math.min(500, Math.max(1, quantity || 1)));
  const open = db.prepare('SELECT id FROM equipment_hire_units WHERE hire_id = ? AND returned_at IS NULL ORDER BY id').all(hireId);
  const want = qty - returned;
  // shrink extras / grow missing
  for (let i = open.length - 1; i >= want; i--) {
    db.prepare('DELETE FROM equipment_hire_units WHERE id = ?').run(open[i].id);
  }
  for (let i = open.length; i < want; i++) {
    db.prepare('INSERT INTO equipment_hire_units (hire_id) VALUES (?)').run(hireId);
  }
  // apply numbers to the (fresh) unreturned set, in order
  const rows = db.prepare('SELECT id FROM equipment_hire_units WHERE hire_id = ? AND returned_at IS NULL ORDER BY id').all(hireId);
  const upd = db.prepare('UPDATE equipment_hire_units SET unit_number = ? WHERE id = ?');
  rows.forEach((r, i) => upd.run(numbers[i] || '', r.id));
  return qty;
}
function unitsFor(db, hireId) {
  return db.prepare('SELECT * FROM equipment_hire_units WHERE hire_id = ? ORDER BY returned_at IS NOT NULL, id').all(hireId);
}

// ---------- HIRED REGISTER (month-scoped) ----------
router.get('/', (req, res) => {
  const db = getDb();
  const now = new Date();
  const year = parseInt(req.query.year, 10) || now.getFullYear();
  const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
  const bounds = monthBounds(year, month);

  // Hires whose period overlaps the selected month (open-ended = still on hire).
  const rows = db.prepare(`
    SELECT h.*, c.name AS company_current_name,
      (SELECT COUNT(*) FROM equipment_hire_units u WHERE u.hire_id = h.id) AS units_total,
      (SELECT COUNT(*) FROM equipment_hire_units u WHERE u.hire_id = h.id AND u.returned_at IS NOT NULL) AS units_returned,
      (SELECT GROUP_CONCAT(NULLIF(u.unit_number, ''), ', ') FROM equipment_hire_units u WHERE u.hire_id = h.id AND u.returned_at IS NULL) AS out_numbers
    FROM equipment_hires h
    LEFT JOIN hire_companies c ON c.id = h.company_id
    WHERE h.status != 'cancelled'
      AND (h.start_date IS NULL OR h.start_date <= ?)
      AND (h.end_date IS NULL OR h.end_date >= ?)
    ORDER BY COALESCE(h.start_date, '0000') DESC, h.id DESC
  `).all(bounds.end, bounds.start);

  const hires = rows.map(h => {
    const cost = monthlyCostFor(h, bounds);
    return {
      ...h,
      company_label: h.company_current_name || h.company_name || '—',
      type_label: typeLabel(h.equipment_type),
      month_cost: cost,
      units_out: (h.units_total || 0) - (h.units_returned || 0),
    };
  });

  const totalMonthCost = hires.reduce((s, h) => s + (h.month_cost || 0), 0);
  const onHireCount = hires.filter(h => h.status === 'on_hire').length;

  // Per-company rollup for the summary.
  const byCompany = {};
  hires.forEach(h => {
    const k = h.company_label;
    byCompany[k] = byCompany[k] || { name: k, count: 0, cost: 0 };
    byCompany[k].count += 1;
    byCompany[k].cost += (h.month_cost || 0);
  });

  res.render('equipment/hire/index', {
    title: 'Equipment / Hire — Hired',
    currentPage: 'equipment',
    tabActive: 'hired',
    hires,
    year, month,
    stats: { total: hires.length, onHire: onHireCount, monthCost: totalMonthCost },
    byCompany: Object.values(byCompany).sort((a, b) => b.cost - a.cost),
    equipmentTypes: EQUIPMENT_TYPES,
    rateUnits: RATE_UNITS,
    monthLabel: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  });
});

// ---------- RATE LOOKUP (auto-apply) ----------
// GET /equipment/hire/rate-lookup?company_id=&equipment_type=&rate_unit=
router.get('/rate-lookup', (req, res) => {
  const db = getDb();
  const companyId = parseInt(req.query.company_id, 10);
  const type = String(req.query.equipment_type || '');
  if (!companyId || !type) return res.json({ found: false });
  const rows = db.prepare(
    'SELECT rate, rate_unit FROM equipment_hire_rates WHERE company_id = ? AND equipment_type = ?'
  ).all(companyId, type);
  if (!rows.length) return res.json({ found: false });
  const byUnit = {};
  rows.forEach(r => { byUnit[r.rate_unit] = r.rate; });
  const wanted = String(req.query.rate_unit || '');
  let rate_unit = wanted && byUnit[wanted] != null ? wanted : (byUnit.day != null ? 'day' : rows[0].rate_unit);
  res.json({ found: true, rates: byUnit, rate: byUnit[rate_unit], rate_unit });
});

// ---------- RATES TAB (companies + per-type rate matrix) ----------
router.get('/rates', (req, res) => {
  const db = getDb();
  const companies = db.prepare('SELECT * FROM hire_companies ORDER BY active DESC, name').all();
  const selectedId = parseInt(req.query.company, 10) || (companies[0] ? companies[0].id : null);
  const selected = selectedId ? companies.find(c => c.id === selectedId) || null : null;

  // Build a {equipment_type: {unit: rate}} map for the selected company.
  let rateMap = {};
  if (selected) {
    db.prepare('SELECT equipment_type, rate_unit, rate FROM equipment_hire_rates WHERE company_id = ?')
      .all(selected.id)
      .forEach(r => { (rateMap[r.equipment_type] = rateMap[r.equipment_type] || {})[r.rate_unit] = r.rate; });
  }

  res.render('equipment/hire/rates', {
    title: 'Equipment / Hire — Rates',
    currentPage: 'equipment',
    tabActive: 'rates',
    companies,
    selected,
    rateMap,
    equipmentTypes: EQUIPMENT_TYPES,
    rateUnits: RATE_UNITS,
  });
});

// Add / edit a hire company.
router.post('/rates/companies', (req, res) => {
  const db = getDb();
  const b = req.body;
  const name = (b.name || '').toString().trim().slice(0, 200);
  if (!name) { req.flash('error', 'Company name is required.'); return res.redirect('/equipment/hire/rates'); }
  if (b.id) {
    db.prepare(`UPDATE hire_companies SET name=?, contact_person=?, phone=?, email=?, notes=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(name, b.contact_person || '', b.phone || '', b.email || '', b.notes || '', b.active === '0' ? 0 : 1, b.id);
    return res.redirect('/equipment/hire/rates?company=' + encodeURIComponent(b.id));
  }
  const r = db.prepare(`INSERT INTO hire_companies (name, contact_person, phone, email, notes, created_by_id) VALUES (?,?,?,?,?,?)`)
    .run(name, b.contact_person || '', b.phone || '', b.email || '', b.notes || '', req.session.user.id);
  req.flash('success', `Added ${name}.`);
  res.redirect('/equipment/hire/rates?company=' + r.lastInsertRowid);
});

router.post('/rates/companies/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM hire_companies WHERE id = ?').run(req.params.id); // CASCADE clears its rates
  req.flash('success', 'Company removed.');
  res.redirect('/equipment/hire/rates');
});

// Upsert the per-type rate matrix for a company. Fields: r_<type>_<unit>.
router.post('/rates/companies/:id/rates', (req, res) => {
  const db = getDb();
  const companyId = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT 1 FROM hire_companies WHERE id = ?').get(companyId)) {
    req.flash('error', 'Company not found.'); return res.redirect('/equipment/hire/rates');
  }
  const upsert = db.prepare(`
    INSERT INTO equipment_hire_rates (company_id, equipment_type, rate_unit, rate, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(company_id, equipment_type, rate_unit)
    DO UPDATE SET rate = excluded.rate, updated_at = CURRENT_TIMESTAMP
  `);
  const del = db.prepare('DELETE FROM equipment_hire_rates WHERE company_id=? AND equipment_type=? AND rate_unit=?');
  const tx = db.transaction(() => {
    for (const t of EQUIPMENT_TYPES) {
      for (const unit of RATE_UNITS) {
        const raw = req.body[`r_${t.value}_${unit}`];
        if (typeof raw === 'undefined') continue;
        const v = String(raw).trim();
        if (v === '') { del.run(companyId, t.value, unit); continue; }
        const num = parseFloat(v);
        if (!isNaN(num) && num >= 0) upsert.run(companyId, t.value, unit, num);
      }
    }
  });
  tx();
  req.flash('success', 'Rates saved.');
  res.redirect('/equipment/hire/rates?company=' + companyId);
});

// ---------- HIRE CRUD ----------
function companiesForForm(db) {
  return db.prepare('SELECT id, name FROM hire_companies WHERE active = 1 ORDER BY name').all();
}

router.get('/new', (req, res) => {
  const db = getDb();
  res.render('equipment/hire/form', {
    title: 'New Hire',
    currentPage: 'equipment',
    tabActive: 'hired',
    hire: null,
    companies: companiesForForm(db),
    equipmentTypes: EQUIPMENT_TYPES,
    rateUnits: RATE_UNITS,
    year: parseInt(req.query.year, 10) || undefined,
    month: parseInt(req.query.month, 10) || undefined,
  });
});

function applyHireBody(b) {
  const company_id = parseInt(b.company_id, 10) || null;
  let rate = parseFloat(b.rate);
  if (isNaN(rate)) rate = 0;
  const rate_unit = RATE_UNITS.includes(b.rate_unit) ? b.rate_unit : 'day';
  const status = ['on_hire', 'off_hired', 'cancelled'].includes(b.status) ? b.status : 'on_hire';
  const type = b.equipment_type || '';
  const power = type ? (getPowerKind(type).label || '') : '';
  return {
    equipment_type: type,
    description: (b.description || '').toString().slice(0, 500),
    company_id,
    company_name: (b.company_name || '').toString().slice(0, 200),
    reference: (b.reference || '').toString().slice(0, 120),
    quantity: parseInt(b.quantity, 10) || 1,
    start_date: b.start_date || null,
    end_date: b.end_date || null,
    rate,
    rate_unit,
    status,
    hire_docket_id: parseInt(b.hire_docket_id, 10) || null,
    power_kind: power,
    registration: (b.registration || '').toString().slice(0, 60),
    notes: (b.notes || '').toString().slice(0, 2000),
  };
}

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const h = applyHireBody(b);
  // Snapshot company name if a saved company was chosen and no name typed.
  if (h.company_id && !h.company_name) {
    const c = db.prepare('SELECT name FROM hire_companies WHERE id = ?').get(h.company_id);
    if (c) h.company_name = c.name;
  }
  // Server-side rate auto-apply fallback: blank rate + saved company + type.
  if ((!h.rate || h.rate === 0) && h.company_id && h.equipment_type) {
    const r = db.prepare('SELECT rate FROM equipment_hire_rates WHERE company_id=? AND equipment_type=? AND rate_unit=?')
      .get(h.company_id, h.equipment_type, h.rate_unit);
    if (r) h.rate = r.rate;
  }
  const result = db.prepare(`
    INSERT INTO equipment_hires
      (equipment_type, description, company_id, company_name, reference, quantity, start_date, end_date,
       rate, rate_unit, status, hire_docket_id, power_kind, registration, notes, created_by_id)
    VALUES (@equipment_type,@description,@company_id,@company_name,@reference,@quantity,@start_date,@end_date,
       @rate,@rate_unit,@status,@hire_docket_id,@power_kind,@registration,@notes,@created_by_id)
  `).run({ ...h, created_by_id: req.session.user.id });
  // One unit row per item on hire, carrying its number (if typed) — the
  // return flow confirms these numbers one by one.
  syncUnits(db, result.lastInsertRowid, h.quantity, parseUnitNumbers(b['unit_numbers[]'] || b.unit_numbers));
  try { logActivity({ user: req.session.user, action: 'create', entityType: 'equipment_hire', entityId: result.lastInsertRowid, entityLabel: `${h.company_name} — ${typeLabel(h.equipment_type)}`, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Hire added — ' + h.quantity + ' unit' + (h.quantity === 1 ? '' : 's') + ' on hire.');
  res.redirect(redirectToMonth(h.start_date));
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const hire = db.prepare('SELECT * FROM equipment_hires WHERE id = ?').get(req.params.id);
  if (!hire) { req.flash('error', 'Hire not found.'); return res.redirect('/equipment/hire'); }
  res.render('equipment/hire/form', {
    title: 'Edit Hire',
    currentPage: 'equipment',
    tabActive: 'hired',
    hire,
    units: unitsFor(db, hire.id),
    companies: companiesForForm(db),
    equipmentTypes: EQUIPMENT_TYPES,
    rateUnits: RATE_UNITS,
  });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const exists = db.prepare('SELECT id FROM equipment_hires WHERE id = ?').get(req.params.id);
  if (!exists) { req.flash('error', 'Hire not found.'); return res.redirect('/equipment/hire'); }
  const h = applyHireBody(req.body);
  if (h.company_id && !h.company_name) {
    const c = db.prepare('SELECT name FROM hire_companies WHERE id = ?').get(h.company_id);
    if (c) h.company_name = c.name;
  }
  // Keep unit rows in step with quantity + typed numbers (returned units are
  // untouched history; quantity can't drop below what's already returned).
  h.quantity = syncUnits(db, parseInt(req.params.id, 10), h.quantity, parseUnitNumbers(req.body['unit_numbers[]'] || req.body.unit_numbers));
  // Manual status flips reconcile the units so the counts never lie:
  //   → off_hired: everything still out is marked returned today.
  //   → on_hire when everything was returned: the units go back on hire.
  if (h.status === 'off_hired') {
    db.prepare(`UPDATE equipment_hire_units SET returned_at = ?, returned_by = ? WHERE hire_id = ? AND returned_at IS NULL`)
      .run(h.end_date || todayISO(), (req.session.user && req.session.user.full_name) || '', req.params.id);
  } else if (h.status === 'on_hire') {
    const out = db.prepare('SELECT COUNT(*) AS n FROM equipment_hire_units WHERE hire_id = ? AND returned_at IS NULL').get(req.params.id).n;
    if (out === 0) db.prepare("UPDATE equipment_hire_units SET returned_at = NULL, returned_by = '', return_note = '' WHERE hire_id = ?").run(req.params.id);
  }
  db.prepare(`
    UPDATE equipment_hires SET
      equipment_type=@equipment_type, description=@description, company_id=@company_id, company_name=@company_name,
      reference=@reference, quantity=@quantity, start_date=@start_date, end_date=@end_date, rate=@rate, rate_unit=@rate_unit,
      status=@status, hire_docket_id=@hire_docket_id, power_kind=@power_kind, registration=@registration, notes=@notes,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=@id
  `).run({ ...h, id: req.params.id });
  try { logActivity({ user: req.session.user, action: 'update', entityType: 'equipment_hire', entityId: parseInt(req.params.id), entityLabel: `${h.company_name} — ${typeLabel(h.equipment_type)}`, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Hire updated.');
  res.redirect(redirectToMonth(h.start_date));
});

// ---------- RETURN / OFF-HIRE FLOW ----------
// The return page lists every unit still out; the yard confirms the actual
// numbers coming back (tick them, or type the numbers to auto-match). Partial
// returns leave the hire on_hire with the remainder; returning the last unit
// off-hires the whole record automatically.
router.get('/:id/return', (req, res) => {
  const db = getDb();
  const hire = db.prepare(`
    SELECT h.*, c.name AS company_current_name FROM equipment_hires h
    LEFT JOIN hire_companies c ON c.id = h.company_id WHERE h.id = ?
  `).get(req.params.id);
  if (!hire) { req.flash('error', 'Hire not found.'); return res.redirect('/equipment/hire'); }
  const units = unitsFor(db, hire.id);
  res.render('equipment/hire/return', {
    title: 'Return — ' + typeLabel(hire.equipment_type),
    currentPage: 'equipment',
    tabActive: 'hired',
    hire: { ...hire, company_label: hire.company_current_name || hire.company_name || '—', type_label: typeLabel(hire.equipment_type) },
    outstanding: units.filter(u => !u.returned_at),
    returned: units.filter(u => u.returned_at),
    today: todayISO(),
  });
});

router.post('/:id/return', (req, res) => {
  const db = getDb();
  const hire = db.prepare('SELECT * FROM equipment_hires WHERE id = ?').get(req.params.id);
  if (!hire) { req.flash('error', 'Hire not found.'); return res.redirect('/equipment/hire'); }
  const b = req.body;
  const returnDate = /^\d{4}-\d{2}-\d{2}$/.test(b.return_date || '') ? b.return_date : todayISO();
  const note = String(b.return_note || '').trim().slice(0, 500);
  const by = (req.session.user && req.session.user.full_name) || '';
  // Checked units arrive as unit_<id> fields.
  const ids = Object.keys(b)
    .filter(k => /^unit_\d+$/.test(k))
    .map(k => parseInt(k.slice(5), 10));
  if (!ids.length) { req.flash('error', 'Tick the unit numbers that came back.'); return res.redirect('/equipment/hire/' + hire.id + '/return'); }

  const mark = db.prepare(`
    UPDATE equipment_hire_units SET returned_at = ?, returned_by = ?, return_note = ?
    WHERE id = ? AND hire_id = ? AND returned_at IS NULL
  `);
  let marked = 0;
  const tx = db.transaction(() => {
    for (const id of ids) marked += mark.run(returnDate, by, note, id, hire.id).changes;
    const out = db.prepare('SELECT COUNT(*) AS n FROM equipment_hire_units WHERE hire_id = ? AND returned_at IS NULL').get(hire.id).n;
    if (out === 0) {
      db.prepare("UPDATE equipment_hires SET status = 'off_hired', end_date = COALESCE(end_date, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(returnDate, hire.id);
    }
    return out;
  });
  const outstanding = tx();
  try { logActivity({ user: req.session.user, action: 'update', entityType: 'equipment_hire', entityId: hire.id, entityLabel: `returned ${marked} unit(s)${outstanding ? `, ${outstanding} still out` : ' — off-hired'}`, ip: req.ip }); } catch (e) {}
  req.flash('success', outstanding
    ? `${marked} unit${marked === 1 ? '' : 's'} returned — ${outstanding} still on hire.`
    : `All units returned — hire off-hired as of ${returnDate}.`);
  res.redirect(outstanding ? '/equipment/hire/' + hire.id + '/return' : redirectToMonth(hire.start_date));
});

// Undo a mistaken return: the unit goes back on hire (and so does the hire).
router.post('/:id/units/:unitId/unreturn', (req, res) => {
  const db = getDb();
  const unit = db.prepare('SELECT * FROM equipment_hire_units WHERE id = ? AND hire_id = ?').get(req.params.unitId, req.params.id);
  if (!unit) { req.flash('error', 'Unit not found.'); return res.redirect('/equipment/hire'); }
  db.prepare("UPDATE equipment_hire_units SET returned_at = NULL, returned_by = '', return_note = '' WHERE id = ?").run(unit.id);
  // Re-opening an off-hired hire also clears the (auto-set) end date so the
  // hire reads as ongoing again and stays visible in the current month.
  db.prepare("UPDATE equipment_hires SET status = 'on_hire', end_date = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'off_hired'").run(req.params.id);
  req.flash('success', 'Return undone — unit is back on hire.');
  res.redirect('/equipment/hire/' + req.params.id + '/return');
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM equipment_hires WHERE id = ?').run(req.params.id);
  req.flash('success', 'Hire removed.');
  res.redirect('/equipment/hire');
});

// Redirect back to the month a hire's start_date falls in (so the user lands
// on the month they just edited), else the current month.
function redirectToMonth(startIso) {
  if (startIso && /^\d{4}-\d{2}/.test(startIso)) {
    return `/equipment/hire?year=${startIso.slice(0, 4)}&month=${parseInt(startIso.slice(5, 7), 10)}`;
  }
  return '/equipment/hire';
}

module.exports = router;
