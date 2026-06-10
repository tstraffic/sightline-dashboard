const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { logActivity } = require('../../middleware/audit');

// ────────────────────────────────────────────────────────────────────
// Constants — kept in sync with the CHECK constraints in migration 238.
// If you change these, also update the corresponding lists in
// views/quoting/rate-cards/edit.ejs.
// ────────────────────────────────────────────────────────────────────
const CATEGORIES = [
  { key: 'planning_compliance',  label: 'Planning & Compliance',  defaultUnit: 'per_shift',       defaultCostMethod: 'fixed' },
  { key: 'tc_labour',            label: 'Traffic Control Labour', defaultUnit: 'per_hour',        defaultCostMethod: 'computed_crew' },
  { key: 'equipment_vehicles',   label: 'Equipment & Vehicles',   defaultUnit: 'per_shift',       defaultCostMethod: 'fixed' },
  { key: 'provisioning',         label: 'Provisioning',           defaultUnit: 'per_application', defaultCostMethod: 'fixed' },
  { key: 'allowances_misc',      label: 'Allowances & Misc',      defaultUnit: 'per_shift',       defaultCostMethod: 'fixed' },
];
const UNITS = ['per_shift','per_hour','per_site','per_day','per_week','per_km','per_application','per_plan','per_delivery','per_spa','fixed'];

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

// Read the standard (shift_type='standard', hour_bracket='standard')
// variant for an item. If missing, return zeroes so the editor doesn't
// crash on legacy rows.
function getStandardVariant(db, itemId) {
  return db.prepare(`
    SELECT rate, unit_cost FROM rate_card_item_variants
    WHERE rate_card_item_id = ? AND shift_type = 'standard' AND hour_bracket = 'standard'
  `).get(itemId) || { rate: null, unit_cost: null };
}

// Insert or update the standard variant. Uses INSERT...ON CONFLICT against
// the (item_id, shift_type, hour_bracket) UNIQUE constraint from mig 238.
function upsertStandardVariant(db, itemId, rate, unitCost) {
  db.prepare(`
    INSERT INTO rate_card_item_variants
      (rate_card_item_id, shift_type, hour_bracket, rate, unit_cost)
    VALUES (?, 'standard', 'standard', ?, ?)
    ON CONFLICT(rate_card_item_id, shift_type, hour_bracket)
    DO UPDATE SET rate = excluded.rate, unit_cost = excluded.unit_cost
  `).run(itemId, rate, unitCost);
}

function toNumberOr(v, fallback) {
  if (v === '' || v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Parse + validate the crew_composition JSON the user submits as raw text.
// Returns either a serialized JSON string or null if blank/invalid.
function parseCrewComposition(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const clean = {
      tc_count:         Math.max(0, parseInt(parsed.tc_count, 10) || 0),
      tl_count:         Math.max(0, parseInt(parsed.tl_count, 10) || 0),
      supervisor_count: Math.max(0, parseInt(parsed.supervisor_count, 10) || 0),
    };
    return JSON.stringify(clean);
  } catch { return null; }
}

// Truthy form-value coercion (checkboxes submit 'on' when checked, omit when unchecked)
function isCheckboxOn(v) {
  return v === 'on' || v === '1' || v === 'true' || v === true;
}

// Enforce only one default rate card per company. When setting is_default=1
// on a card, clear is_default on every other card in the same transaction.
function setDefaultExclusive(db, cardId) {
  db.prepare('UPDATE rate_cards SET is_default = 0 WHERE id != ?').run(cardId);
  db.prepare('UPDATE rate_cards SET is_default = 1 WHERE id = ?').run(cardId);
}

// ────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  const filter = {
    purpose: req.query.purpose || 'all',
    active:  req.query.active  || 'active',
  };

  const where = [];
  const params = [];
  if (filter.purpose !== 'all') { where.push('rc.purpose = ?'); params.push(filter.purpose); }
  if (filter.active === 'active')  { where.push('rc.is_active = 1'); }
  if (filter.active === 'inactive'){ where.push('rc.is_active = 0'); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const cards = db.prepare(`
    SELECT rc.*,
           (SELECT COUNT(*) FROM rate_card_items i WHERE i.rate_card_id = rc.id AND i.is_active = 1) AS item_count,
           c.company_name AS client_name
    FROM rate_cards rc
    LEFT JOIN clients c ON c.id = rc.client_id
    ${whereSql}
    ORDER BY rc.is_default DESC, rc.updated_at DESC
  `).all(...params);

  res.render('quoting/rate-cards/index', {
    title: 'Rate Cards',
    currentPage: 'quoting',
    cards,
    filter,
  });
});

// ────────────────────────────────────────────────────────────────────
// New / Create
// ────────────────────────────────────────────────────────────────────

router.get('/new', (req, res) => {
  const db = getDb();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  res.render('quoting/rate-cards/new', {
    title: 'New Rate Card',
    currentPage: 'quoting',
    clients,
    form: { name: '', description: '', client_id: '', effective_from: '', effective_to: '',
            is_default: false, purpose: 'quoting' },
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const name = (b.name || '').trim();
  if (!name) {
    req.flash('error', 'Name is required.');
    return res.redirect('/rate-cards/new');
  }

  const purpose = (b.purpose === 'reference') ? 'reference' : 'quoting';
  const clientId = b.client_id ? parseInt(b.client_id, 10) || null : null;
  const isDefault = isCheckboxOn(b.is_default) ? 1 : 0;

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO rate_cards (name, description, client_id, effective_from, effective_to,
        is_default, purpose, source, is_active, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 1, ?)
    `).run(
      name,
      (b.description || '').trim(),
      clientId,
      b.effective_from || null,
      b.effective_to || null,
      isDefault,
      purpose,
      req.session.user?.id || null,
    );
    if (isDefault) setDefaultExclusive(db, info.lastInsertRowid);
    return info.lastInsertRowid;
  });

  const newId = tx();
  logActivity({
    user: req.session.user, action: 'create',
    entityType: 'rate_card', entityId: newId, entityLabel: name,
    details: `Created ${purpose} rate card "${name}"`,
    ip: req.ip,
  });

  req.flash('success', `Rate card "${name}" created.`);
  res.redirect(`/rate-cards/${newId}`);
});

// ────────────────────────────────────────────────────────────────────
// Editor (header + items list)
// ────────────────────────────────────────────────────────────────────

router.get('/:id', (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return next();
  const db = getDb();

  const card = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
  if (!card) {
    req.flash('error', 'Rate card not found.');
    return res.redirect('/rate-cards');
  }

  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const items = db.prepare(`
    SELECT i.*, v.rate AS standard_rate, v.unit_cost AS standard_unit_cost
    FROM rate_card_items i
    LEFT JOIN rate_card_item_variants v
      ON v.rate_card_item_id = i.id
     AND v.shift_type = 'standard' AND v.hour_bracket = 'standard'
    WHERE i.rate_card_id = ?
    ORDER BY i.category, i.sort_order, i.id
  `).all(id);

  // Group items by category for the template
  const itemsByCategory = {};
  for (const c of CATEGORIES) itemsByCategory[c.key] = [];
  for (const it of items) {
    if (itemsByCategory[it.category]) itemsByCategory[it.category].push(it);
  }

  // Traffio invoice billing rates (day/night/OT labour, travel/meal, ute) —
  // the compact panel that feeds /finance/invoicing pricing.
  let billingRates = null;
  try { billingRates = require('../../middleware/invoicing').getBillingRates(db, id); } catch (e) { /* panel hidden */ }

  // Engine v2: the client's billing profile (rule switches) + the coded
  // activity × band rate matrix (CREW_3, TMA_DRIVER, …).
  let billingProfile = null;
  let activities = [];
  try {
    billingProfile = require('../../middleware/invoicing').getBillingProfile(db, card.client_id);
    activities = db.prepare(`
      SELECT i.id, i.code, i.name, i.category FROM rate_card_items i
      WHERE i.rate_card_id = ? AND i.is_active = 1 AND COALESCE(i.code,'') != ''
      ORDER BY i.category, i.code
    `).all(id);
    const varFor = db.prepare(`
      SELECT rate FROM rate_card_item_variants WHERE rate_card_item_id = ? AND shift_type = ? AND hour_bracket = ?
    `);
    for (const a of activities) {
      a.bands = {};
      for (const [band, [shift, bracket]] of Object.entries(BAND_SLOTS)) {
        const v = varFor.get(a.id, shift, bracket);
        a.bands[band] = v && v.rate != null ? v.rate : '';
      }
    }
  } catch (e) { /* engine-v2 tables missing on stale deploy — panels hidden */ }

  res.render('quoting/rate-cards/edit', {
    title: card.name + ' — Rate Card',
    currentPage: 'quoting',
    card,
    clients,
    itemsByCategory,
    categories: CATEGORIES,
    units: UNITS,
    billingRates,
    billingProfile,
    activities,
    bandKeys: Object.keys(BAND_SLOTS),
  });
});

// Engine v2: band → canonical (shift_type, hour_bracket) variant slot. The
// matrix reads and writes these exact slots; the invoicing resolver's
// fallback chains start from them.
const BAND_SLOTS = {
  NT: ['weekday', '0_to_8'],
  OT: ['weekday', '8_to_10'],
  DT: ['weekday', '10_plus'],
  WE: ['weekend', 'standard'],
  PH: ['public_holiday', 'standard'],
  FLAT: ['standard', 'standard'],
};

// Save the client billing profile (rule switches) — keyed by the card's
// client; a card with no client edits the DEFAULT profile.
router.post('/:id/billing-profile', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const card = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
  if (!card) { req.flash('error', 'Rate card not found.'); return res.redirect('/rate-cards'); }

  const b = req.body;
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
  const mode = ['tc_hours', 'per_hour_banded', 'flat_day_rate', 'per_crew_day'].includes(b.billing_mode) ? b.billing_mode : 'tc_hours';
  const wkMode = ['flat_rate', 'multiplier', 'sat_sun_split', 'same_as_weekday'].includes(b.weekend_mode) ? b.weekend_mode : 'same_as_weekday';
  const phMode = ['flat_rate', 'multiplier', 'sat_sun_split', 'same_as_weekday'].includes(b.public_holiday_mode) ? b.public_holiday_mode : 'same_as_weekday';

  try {
    db.prepare(`
      INSERT INTO client_billing_profile (client_id, billing_mode, nt_threshold_hours, ot_threshold_hours,
        weekend_mode, public_holiday_mode, minimum_shift_hours, rounding_increment_minutes,
        crew_grouping_enabled, bill_vehicles, bill_equipment, require_signoff_to_bill, break_billing, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(client_id) DO UPDATE SET
        billing_mode=excluded.billing_mode, nt_threshold_hours=excluded.nt_threshold_hours,
        ot_threshold_hours=excluded.ot_threshold_hours, weekend_mode=excluded.weekend_mode,
        public_holiday_mode=excluded.public_holiday_mode, minimum_shift_hours=excluded.minimum_shift_hours,
        rounding_increment_minutes=excluded.rounding_increment_minutes,
        crew_grouping_enabled=excluded.crew_grouping_enabled, bill_vehicles=excluded.bill_vehicles,
        bill_equipment=excluded.bill_equipment, require_signoff_to_bill=excluded.require_signoff_to_bill,
        break_billing=excluded.break_billing, updated_at=CURRENT_TIMESTAMP
    `).run(
      card.client_id || null, mode,
      num(b.nt_threshold_hours) != null ? num(b.nt_threshold_hours) : 8,
      num(b.ot_threshold_hours),
      wkMode, phMode,
      num(b.minimum_shift_hours),
      num(b.rounding_increment_minutes) != null ? Math.round(num(b.rounding_increment_minutes)) : null,
      isCheckboxOn(b.crew_grouping_enabled) ? 1 : 0,
      isCheckboxOn(b.bill_vehicles) ? 1 : 0,
      isCheckboxOn(b.bill_equipment) ? 1 : 0,
      isCheckboxOn(b.require_signoff_to_bill) ? 1 : 0,
      b.break_billing === 'paid' ? 'paid' : 'unpaid'
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'rate_card', entityId: id,
      entityLabel: card.name, details: `Updated billing profile (${card.client_id ? 'client ' + card.client_id : 'DEFAULT'}): mode ${mode}`, ip: req.ip,
    });
    req.flash('success', `Billing profile saved (${mode}).`);
  } catch (err) {
    req.flash('error', 'Could not save billing profile: ' + err.message);
  }
  res.redirect('/rate-cards/' + id + '#billing-profile');
});

// Save the activity × band matrix. Inputs are named rate_<itemId>_<BAND>;
// the add-row uses new_code / new_name / new_category / new_<BAND>.
router.post('/:id/activity-rates', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const card = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
  if (!card) { req.flash('error', 'Rate card not found.'); return res.redirect('/rate-cards'); }
  const b = req.body;
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };

  try {
    const upVar = db.prepare(`
      INSERT INTO rate_card_item_variants (rate_card_item_id, shift_type, hour_bracket, rate)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(rate_card_item_id, shift_type, hour_bracket) DO UPDATE SET rate = excluded.rate
    `);
    const delVar = db.prepare('DELETE FROM rate_card_item_variants WHERE rate_card_item_id = ? AND shift_type = ? AND hour_bracket = ?');
    const tx = db.transaction(() => {
      const items = db.prepare(`SELECT id FROM rate_card_items WHERE rate_card_id = ? AND is_active = 1 AND COALESCE(code,'') != ''`).all(id);
      for (const it of items) {
        for (const [band, [shift, bracket]] of Object.entries(BAND_SLOTS)) {
          const key = `rate_${it.id}_${band}`;
          if (!(key in b)) continue;
          const rate = num(b[key]);
          if (rate == null) delVar.run(it.id, shift, bracket);
          else upVar.run(it.id, shift, bracket, rate);
        }
      }
      // New activity row
      const code = (b.new_code || '').trim().toUpperCase().replace(/\s+/g, '_');
      if (code) {
        const name = (b.new_name || '').trim() || code.replace(/_/g, ' ');
        const category = ['tc_labour', 'equipment_vehicles', 'allowances_misc', 'planning_compliance', 'provisioning'].includes(b.new_category) ? b.new_category : 'tc_labour';
        const unit = category === 'tc_labour' || category === 'equipment_vehicles' ? 'per_hour' : 'per_shift';
        const r = db.prepare(`
          INSERT INTO rate_card_items (rate_card_id, category, code, name, unit, cost_method)
          VALUES (?, ?, ?, ?, ?, 'fixed')
        `).run(id, category, code, name, unit);
        for (const [band, [shift, bracket]] of Object.entries(BAND_SLOTS)) {
          const rate = num(b[`new_${band}`]);
          if (rate != null) upVar.run(r.lastInsertRowid, shift, bracket, rate);
        }
      }
    });
    tx();
    logActivity({
      user: req.session.user, action: 'update', entityType: 'rate_card', entityId: id,
      entityLabel: card.name, details: 'Updated activity band rates', ip: req.ip,
    });
    req.flash('success', 'Activity rates saved.');
  } catch (err) {
    req.flash('error', 'Could not save activity rates: ' + err.message);
  }
  res.redirect('/rate-cards/' + id + '#activities');
});

// Save the Traffio invoice billing rates panel — upserts the TC-labour
// variant matrix, ute item and travel/meal allowances the invoicing
// assembler resolves rates from.
router.post('/:id/billing-rates', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const card = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
  if (!card) { req.flash('error', 'Rate card not found.'); return res.redirect('/rate-cards'); }
  try {
    require('../../middleware/invoicing').saveBillingRates(db, id, req.body);
    logActivity({
      user: req.session.user, action: 'update',
      entityType: 'rate_card', entityId: id, entityLabel: card.name,
      details: 'Updated invoice billing rates', ip: req.ip,
    });
    req.flash('success', 'Invoice billing rates saved — drafts for this client can now price automatically.');
  } catch (err) {
    req.flash('error', 'Could not save billing rates: ' + err.message);
  }
  res.redirect('/rate-cards/' + id + '#billing-rates');
});

// Update card header (name, dates, default, purpose, description, client)
router.post('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const before = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
  if (!before) { req.flash('error', 'Rate card not found.'); return res.redirect('/rate-cards'); }
  const b = req.body;

  const name = (b.name || '').trim() || before.name;
  const purpose = (b.purpose === 'reference') ? 'reference' : 'quoting';
  const clientId = b.client_id ? parseInt(b.client_id, 10) || null : null;
  const isDefault = isCheckboxOn(b.is_default) ? 1 : 0;
  const isActive = isCheckboxOn(b.is_active) ? 1 : 0;

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE rate_cards SET
        name = ?, description = ?, client_id = ?,
        effective_from = ?, effective_to = ?,
        is_default = ?, purpose = ?, is_active = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name, (b.description || '').trim(), clientId,
      b.effective_from || null, b.effective_to || null,
      isDefault, purpose, isActive, id,
    );
    if (isDefault) setDefaultExclusive(db, id);
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update',
    entityType: 'rate_card', entityId: id, entityLabel: name,
    details: `Updated rate card header`,
    ip: req.ip,
  });

  req.flash('success', 'Rate card updated.');
  res.redirect(`/rate-cards/${id}`);
});

// Delete card (cascade deletes items + variants + allowances via FK)
router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const card = db.prepare('SELECT * FROM rate_cards WHERE id = ?').get(id);
  if (!card) { req.flash('error', 'Rate card not found.'); return res.redirect('/rate-cards'); }

  // Refuse to delete a card that has live quotes referencing it — would
  // null out their rate_card_id and lose the link. User should set
  // is_active = 0 instead.
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM quotes WHERE rate_card_id = ?').get(id).c;
  if (inUse > 0) {
    req.flash('error', `Cannot delete — ${inUse} quote(s) reference this rate card. Set it to inactive instead.`);
    return res.redirect(`/rate-cards/${id}`);
  }

  db.prepare('DELETE FROM rate_cards WHERE id = ?').run(id);
  logActivity({
    user: req.session.user, action: 'delete',
    entityType: 'rate_card', entityId: id, entityLabel: card.name,
    details: `Deleted rate card "${card.name}"`,
    ip: req.ip,
  });
  req.flash('success', `Deleted rate card "${card.name}".`);
  res.redirect('/rate-cards');
});

// ────────────────────────────────────────────────────────────────────
// Items — nested under a card
// ────────────────────────────────────────────────────────────────────

// Add new item to a category. Sets the standard variant in the same
// transaction so the item never exists without a price row.
router.post('/:id/items', (req, res) => {
  const cardId = parseInt(req.params.id, 10);
  const db = getDb();
  const card = db.prepare('SELECT id FROM rate_cards WHERE id = ?').get(cardId);
  if (!card) { req.flash('error', 'Rate card not found.'); return res.redirect('/rate-cards'); }
  const b = req.body;

  const category = CATEGORIES.find(c => c.key === b.category)?.key;
  if (!category) { req.flash('error', 'Invalid category.'); return res.redirect(`/rate-cards/${cardId}`); }
  const name = (b.name || '').trim();
  if (!name) { req.flash('error', 'Item name is required.'); return res.redirect(`/rate-cards/${cardId}`); }

  const unit = UNITS.includes(b.unit) ? b.unit : 'per_shift';
  const costMethod = (b.cost_method === 'computed_crew') ? 'computed_crew' : 'fixed';
  const pricingStatus = (b.pricing_status === 'poa') ? 'poa' : 'priced';

  const sellRate = toNumberOr(b.standard_rate, null);
  const unitCost = toNumberOr(b.standard_unit_cost, null);

  const tx = db.transaction(() => {
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM rate_card_items WHERE rate_card_id = ? AND category = ?').get(cardId, category).m;
    const info = db.prepare(`
      INSERT INTO rate_card_items (rate_card_id, category, code, name, description, unit,
        has_hours_input, is_addon, min_booking_hours, pricing_status, cost_method,
        crew_composition_json, vehicle_cost_per_hour, notes, sort_order, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      cardId, category, (b.code || '').trim() || null, name, (b.description || '').trim(),
      unit,
      isCheckboxOn(b.has_hours_input) ? 1 : 0,
      isCheckboxOn(b.is_addon) ? 1 : 0,
      toNumberOr(b.min_booking_hours, null),
      pricingStatus, costMethod,
      parseCrewComposition(b.crew_composition_json),
      toNumberOr(b.vehicle_cost_per_hour, null),
      (b.notes || '').trim(),
      maxSort + 10,
    );
    upsertStandardVariant(db, info.lastInsertRowid, sellRate, unitCost);
    return info.lastInsertRowid;
  });

  const itemId = tx();
  logActivity({
    user: req.session.user, action: 'create',
    entityType: 'rate_card_item', entityId: itemId, entityLabel: name,
    details: `Added "${name}" to rate card #${cardId}`,
    ip: req.ip,
  });

  req.flash('success', `Added "${name}".`);
  res.redirect(`/rate-cards/${cardId}#cat-${category}`);
});

// Update one item (sell rate + cost + flags)
router.post('/:id/items/:itemId', (req, res) => {
  const cardId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const db = getDb();
  const item = db.prepare('SELECT * FROM rate_card_items WHERE id = ? AND rate_card_id = ?').get(itemId, cardId);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect(`/rate-cards/${cardId}`); }
  const b = req.body;

  const unit = UNITS.includes(b.unit) ? b.unit : item.unit;
  const costMethod = (b.cost_method === 'computed_crew') ? 'computed_crew' : 'fixed';
  const pricingStatus = (b.pricing_status === 'poa') ? 'poa' : 'priced';

  const sellRate = toNumberOr(b.standard_rate, null);
  const unitCost = toNumberOr(b.standard_unit_cost, null);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE rate_card_items SET
        name = ?, code = ?, description = ?, unit = ?,
        has_hours_input = ?, is_addon = ?, min_booking_hours = ?,
        pricing_status = ?, cost_method = ?,
        crew_composition_json = ?, vehicle_cost_per_hour = ?,
        notes = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      (b.name || '').trim() || item.name,
      (b.code || '').trim() || null,
      (b.description || '').trim(),
      unit,
      isCheckboxOn(b.has_hours_input) ? 1 : 0,
      isCheckboxOn(b.is_addon) ? 1 : 0,
      toNumberOr(b.min_booking_hours, null),
      pricingStatus, costMethod,
      parseCrewComposition(b.crew_composition_json),
      toNumberOr(b.vehicle_cost_per_hour, null),
      (b.notes || '').trim(),
      isCheckboxOn(b.is_active) ? 1 : 0,
      itemId,
    );
    upsertStandardVariant(db, itemId, sellRate, unitCost);
  });
  tx();

  logActivity({
    user: req.session.user, action: 'update',
    entityType: 'rate_card_item', entityId: itemId, entityLabel: item.name,
    details: `Updated item on rate card #${cardId}`,
    ip: req.ip,
  });

  req.flash('success', `Updated "${item.name}".`);
  res.redirect(`/rate-cards/${cardId}#item-${itemId}`);
});

// Delete one item (variants cascade via FK)
router.post('/:id/items/:itemId/delete', (req, res) => {
  const cardId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const db = getDb();
  const item = db.prepare('SELECT * FROM rate_card_items WHERE id = ? AND rate_card_id = ?').get(itemId, cardId);
  if (!item) { req.flash('error', 'Item not found.'); return res.redirect(`/rate-cards/${cardId}`); }

  // Refuse if a quote already references this item — would null out
  // historical quote_line_items.rate_card_item_id (still safe because of
  // snapshotting, but the link is useful for traceability).
  const inUse = db.prepare('SELECT COUNT(*) AS c FROM quote_line_items WHERE rate_card_item_id = ?').get(itemId).c;
  if (inUse > 0) {
    req.flash('error', `Cannot delete — ${inUse} quote line(s) reference this item. Deactivate it on the card instead.`);
    return res.redirect(`/rate-cards/${cardId}#item-${itemId}`);
  }

  db.prepare('DELETE FROM rate_card_items WHERE id = ?').run(itemId);
  logActivity({
    user: req.session.user, action: 'delete',
    entityType: 'rate_card_item', entityId: itemId, entityLabel: item.name,
    details: `Deleted item "${item.name}" from rate card #${cardId}`,
    ip: req.ip,
  });

  req.flash('success', `Deleted "${item.name}".`);
  res.redirect(`/rate-cards/${cardId}#cat-${item.category}`);
});

module.exports = router;
