const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { logActivity } = require('../../middleware/audit');
const { canViewInternalCost } = require('../../middleware/auth');

const STATUSES = ['draft','sent','accepted','rejected','expired','superseded'];
const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent', accepted: 'Accepted',
  rejected: 'Rejected', expired: 'Expired', superseded: 'Superseded',
};
// Statuses that lock the quote against header edits and deletion. Status
// transitions themselves live in PR #7; until then the only way to leave
// 'draft' is via direct DB poke (which the verification flow uses).
const LOCKED_STATUSES = new Set(['sent','accepted','rejected','expired','superseded']);

const ROAD_CLASSIFICATIONS = ['state','regional','local','arterial','other'];

function isCheckboxOn(v) { return v === 'on' || v === '1' || v === 'true' || v === true; }
function linesToJsonArray(input) {
  if (typeof input !== 'string') return '[]';
  return JSON.stringify(input.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
}
function toNumberOr(v, fallback) {
  if (v === '' || v === undefined || v === null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
// Round to 2 dp without floating-point noise.
function round2(n) { return Math.round(n * 100) / 100; }

// ────────────────────────────────────────────────────────────────────
// Cost resolution
//   Returns a per-unit cost (per-hour for has_hours_input items, per
//   unit otherwise). The caller multiplies by qty × effectiveHours to
//   get the line_cost.
//
//   Precedence:
//     1. Per-line unit_cost_override — overrides everything.
//     2. cost_method='fixed'         — returns the snapshotted unit_cost.
//     3. cost_method='computed_crew' — derives from the crew composition
//        snapshot using the current quoting_settings cost rates, plus
//        the snapshotted vehicle cost.
//
//   The settings cost rates are NOT snapshotted — labour cost reality
//   shifts over time, and an unsent quote should reflect today's costs.
//   Once a quote is locked the matrix can't change, but recompute is
//   only triggered by edits so locked quotes preserve their numbers.
// ────────────────────────────────────────────────────────────────────
function resolveLineCost(line, settings) {
  if (line.unit_cost_override != null) return Number(line.unit_cost_override) || 0;
  if (line.cost_method_snapshot === 'computed_crew') {
    let comp = {};
    try { comp = JSON.parse(line.crew_composition_snapshot_json || '{}') || {}; } catch { comp = {}; }
    const tc  = (Number(comp.tc_count) || 0)         * (Number(settings?.default_tc_cost_rate) || 0);
    const tl  = (Number(comp.tl_count) || 0)         * (Number(settings?.default_tl_cost_rate) || 0);
    const sup = (Number(comp.supervisor_count) || 0) * (Number(settings?.default_supervisor_cost_rate) || 0);
    const veh = Number(line.vehicle_cost_snapshot) || 0;
    return round2(tc + tl + sup + veh);
  }
  return Number(line.unit_cost_snapshot) || 0;
}

function describeCostDerivation(line, settings) {
  if (line.unit_cost_override != null) {
    return `Manual override: $${Number(line.unit_cost_override).toFixed(2)}`;
  }
  if (line.cost_method_snapshot === 'computed_crew') {
    let comp = {};
    try { comp = JSON.parse(line.crew_composition_snapshot_json || '{}') || {}; } catch { comp = {}; }
    const parts = [];
    if (comp.tc_count)         parts.push(`${comp.tc_count} TC @ $${Number(settings?.default_tc_cost_rate || 0).toFixed(2)}/hr`);
    if (comp.tl_count)         parts.push(`${comp.tl_count} TL @ $${Number(settings?.default_tl_cost_rate || 0).toFixed(2)}/hr`);
    if (comp.supervisor_count) parts.push(`${comp.supervisor_count} Supervisor @ $${Number(settings?.default_supervisor_cost_rate || 0).toFixed(2)}/hr`);
    if (Number(line.vehicle_cost_snapshot) > 0) parts.push(`vehicle @ $${Number(line.vehicle_cost_snapshot).toFixed(2)}/hr`);
    const total = resolveLineCost(line, settings);
    return (parts.length ? parts.join(' + ') : 'No crew composition set') + ` = $${total.toFixed(2)}`;
  }
  return `Fixed: $${(Number(line.unit_cost_snapshot) || 0).toFixed(2)}`;
}

// ────────────────────────────────────────────────────────────────────
// Recompute totals — runs after every cell mutation.
//   Pass 1: per line — resolve cost, recompute line_cost / line_margin
//           / line_margin_pct. Skip if no cost data needs touching (the
//           cost columns are populated even for non-privileged users so
//           that toggling visibility doesn't require a backfill pass).
//   Pass 2: roll lines up to site (subtotal, total_cost, total_margin)
//   Pass 3: roll sites up to quote (subtotal, total_cost, total_margin)
//   Pass 4: apply GST.
//
//   Returns the full set of recomputed totals so the cell-save endpoint
//   can reply in one round-trip.
// ────────────────────────────────────────────────────────────────────
function recomputeQuoteTotals(db, quoteId) {
  const settings = db.prepare('SELECT * FROM quoting_settings WHERE id = 1').get() || {};

  // Pass 1: re-resolve cost on every line in this quote.
  const lines = db.prepare(`
    SELECT qli.* FROM quote_line_items qli
    JOIN quote_sites qs ON qs.id = qli.quote_site_id
    WHERE qs.quote_id = ?
  `).all(quoteId);
  const updateLine = db.prepare(`
    UPDATE quote_line_items SET
      line_cost = ?, line_margin = ?, line_margin_pct = ?
    WHERE id = ?
  `);
  for (const l of lines) {
    const effectiveHours = l.has_hours_snapshot ? (l.hours ?? 0) : 1;
    const unitCost = resolveLineCost(l, settings);
    const lineCost = round2(l.qty * effectiveHours * unitCost);
    const lineRev = Number(l.line_revenue) || 0;
    const lineMargin = round2(lineRev - lineCost);
    const lineMarginPct = lineRev > 0 ? round2((lineMargin / lineRev) * 100) : 0;
    updateLine.run(lineCost, lineMargin, lineMarginPct, l.id);
  }

  // Pass 2: roll into site totals.
  const siteRows = db.prepare(`
    SELECT qs.id AS site_id,
           COALESCE(SUM(qli.line_revenue), 0) AS subtotal,
           COALESCE(SUM(qli.line_cost), 0) AS cost
    FROM quote_sites qs
    LEFT JOIN quote_line_items qli ON qli.quote_site_id = qs.id
    WHERE qs.quote_id = ?
    GROUP BY qs.id
  `).all(quoteId);
  const updateSite = db.prepare(`
    UPDATE quote_sites SET
      subtotal_ex_gst = ?, total_cost = ?,
      total_margin = ?, total_margin_pct = ?
    WHERE id = ?
  `);
  const siteSubtotals = {};
  const siteCosts = {};
  const siteMargins = {};
  const siteMarginPcts = {};
  let quoteSubtotal = 0;
  let quoteCost = 0;
  for (const r of siteRows) {
    const sub  = round2(r.subtotal || 0);
    const cost = round2(r.cost || 0);
    const margin = round2(sub - cost);
    const marginPct = sub > 0 ? round2((margin / sub) * 100) : 0;
    updateSite.run(sub, cost, margin, marginPct, r.site_id);
    siteSubtotals[r.site_id] = sub;
    siteCosts[r.site_id] = cost;
    siteMargins[r.site_id] = margin;
    siteMarginPcts[r.site_id] = marginPct;
    quoteSubtotal += sub;
    quoteCost += cost;
  }
  quoteSubtotal = round2(quoteSubtotal);
  quoteCost = round2(quoteCost);
  const quoteMargin = round2(quoteSubtotal - quoteCost);
  const quoteMarginPct = quoteSubtotal > 0 ? round2((quoteMargin / quoteSubtotal) * 100) : 0;

  const gstRate = settings.gst_rate ?? 0.10;
  const gst = round2(quoteSubtotal * gstRate);
  const total = round2(quoteSubtotal + gst);
  db.prepare(`
    UPDATE quotes SET
      subtotal_ex_gst = ?, gst = ?, total_inc_gst = ?,
      total_cost = ?, total_margin = ?, total_margin_pct = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(quoteSubtotal, gst, total, quoteCost, quoteMargin, quoteMarginPct, quoteId);

  return {
    quoteSubtotal, gst, total,
    quoteCost, quoteMargin, quoteMarginPct,
    siteSubtotals, siteCosts, siteMargins, siteMarginPcts,
  };
}

// ────────────────────────────────────────────────────────────────────
// Quote number generation
//   Reads `quote_number_format` from quoting_settings (default
//   'TS-QTE-{YYYY}-{NNN}'), scans existing quote_numbers in the current
//   year for the highest {NNN} suffix, and increments. Pad to 3 digits;
//   if the sequence rolls past 999 it still works, just wider.
// ────────────────────────────────────────────────────────────────────
function nextQuoteNumber(db) {
  const settings = db.prepare('SELECT quote_number_format FROM quoting_settings WHERE id = 1').get();
  const format = settings?.quote_number_format || 'TS-QTE-{YYYY}-{NNN}';
  const year = new Date().getFullYear();
  const likePattern = format.replace('{YYYY}', String(year)).replace('{NNN}', '%');
  const existing = db.prepare('SELECT quote_number FROM quotes WHERE quote_number LIKE ?').all(likePattern);
  let max = 0;
  for (const r of existing) {
    const m = r.quote_number.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const next = max + 1;
  return format.replace('{YYYY}', String(year)).replace('{NNN}', String(next).padStart(3, '0'));
}

// ────────────────────────────────────────────────────────────────────
// List
// ────────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const db = getDb();
  const filter = {
    status:        req.query.status || 'all',
    client_id:     req.query.client_id || '',
    prepared_by:   req.query.prepared_by || '',
    search:        (req.query.search || '').trim(),
  };

  const where = [];
  const params = [];
  if (filter.status !== 'all') { where.push('q.status = ?'); params.push(filter.status); }
  if (filter.client_id)         { where.push('q.client_id = ?'); params.push(parseInt(filter.client_id, 10) || 0); }
  if (filter.prepared_by)       { where.push('q.prepared_by_user_id = ?'); params.push(parseInt(filter.prepared_by, 10) || 0); }
  if (filter.search) {
    where.push('(q.quote_number LIKE ? OR q.project_name LIKE ? OR q.client_name_snapshot LIKE ?)');
    const pat = `%${filter.search}%`;
    params.push(pat, pat, pat);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const quotes = db.prepare(`
    SELECT q.*, c.company_name AS client_name, u.full_name AS prepared_by_name
    FROM quotes q
    LEFT JOIN clients c ON c.id = q.client_id
    LEFT JOIN users u ON u.id = q.prepared_by_user_id
    ${whereSql}
    ORDER BY q.quote_date DESC, q.id DESC
  `).all(...params);

  // Status counts for the filter pills
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  for (const r of db.prepare('SELECT status, COUNT(*) AS c FROM quotes GROUP BY status').all()) {
    counts[r.status] = r.c;
  }
  counts.all = db.prepare('SELECT COUNT(*) AS c FROM quotes').get().c;

  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const preparers = db.prepare(`
    SELECT DISTINCT u.id, u.full_name
    FROM users u JOIN quotes q ON q.prepared_by_user_id = u.id
    ORDER BY u.full_name
  `).all();

  res.render('quoting/quotes/index', {
    title: 'Quotes',
    currentPage: 'quotes',
    quotes, filter, counts, clients, preparers,
    statuses: STATUSES, statusLabels: STATUS_LABELS,
  });
});

// ────────────────────────────────────────────────────────────────────
// New / Create
// ────────────────────────────────────────────────────────────────────

router.get('/new', (req, res) => {
  const db = getDb();
  const settings = db.prepare('SELECT * FROM quoting_settings WHERE id = 1').get();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const rateCards = db.prepare(`
    SELECT id, name, is_default, client_id
    FROM rate_cards WHERE is_active = 1 AND purpose = 'quoting'
    ORDER BY is_default DESC, name
  `).all();

  const validity = settings?.default_validity_days || 30;
  const today = new Date();
  const validUntil = new Date(Date.now() + validity * 86400000);

  res.render('quoting/quotes/new', {
    title: 'New Quote',
    currentPage: 'quotes',
    clients, rateCards, settings,
    form: {
      client_id: '',
      client_name_freetext: '',
      project_name: '',
      project_description: '',
      rate_card_id: rateCards.find(c => c.is_default)?.id || (rateCards[0]?.id || ''),
      quote_date: today.toISOString().slice(0, 10),
      valid_until_date: validUntil.toISOString().slice(0, 10),
      internal_notes: '',
    },
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  const projectName = (b.project_name || '').trim();
  if (!projectName) {
    req.flash('error', 'Project name is required.');
    return req.session.save(() => res.redirect('/quotes/new'));
  }

  const settings = db.prepare('SELECT * FROM quoting_settings WHERE id = 1').get();
  const clientId = b.client_id ? parseInt(b.client_id, 10) || null : null;
  // Snapshot client name from the picked client; fall back to whatever
  // the user typed in the free-text field when no client is selected.
  let clientNameSnap = '';
  if (clientId) {
    const c = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(clientId);
    clientNameSnap = c?.company_name || '';
  } else {
    clientNameSnap = (b.client_name_freetext || '').trim();
  }

  const rateCardId = b.rate_card_id ? parseInt(b.rate_card_id, 10) || null : null;

  const tx = db.transaction(() => {
    const quoteNumber = nextQuoteNumber(db);
    const info = db.prepare(`
      INSERT INTO quotes (
        quote_number, client_id, client_name_snapshot,
        project_name, project_description,
        prepared_by_user_id, rate_card_id,
        quote_date, valid_until_date,
        status, version,
        inclusions_json, exclusions_json, terms,
        internal_notes, within_50km
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?)
    `).run(
      quoteNumber, clientId, clientNameSnap,
      projectName, (b.project_description || '').trim(),
      req.session.user?.id || null, rateCardId,
      b.quote_date || new Date().toISOString().slice(0, 10),
      b.valid_until_date || null,
      // Pre-fill inclusions/exclusions/terms from settings defaults
      settings?.company_inclusions_defaults_json || '[]',
      settings?.company_exclusions_defaults_json || '[]',
      settings?.company_terms_default || '',
      (b.internal_notes || '').trim(),
      settings?.default_within_50km ?? 1,
    );
    const quoteId = info.lastInsertRowid;

    // Populate quote_rate_items (Site Matrix column list) from the
    // chosen rate card's active items. Each row gets a (quote_id,
    // rate_card_item_id) UNIQUE link so adding more later won't dupe.
    if (rateCardId) {
      const items = db.prepare(`
        SELECT id, sort_order
        FROM rate_card_items
        WHERE rate_card_id = ? AND is_active = 1
        ORDER BY category, sort_order, id
      `).all(rateCardId);
      const insertQRI = db.prepare(`
        INSERT INTO quote_rate_items (quote_id, rate_card_item_id, sort_order)
        VALUES (?, ?, ?)
      `);
      for (const it of items) {
        insertQRI.run(quoteId, it.id, it.sort_order);
      }
    }
    return { quoteId, quoteNumber };
  });

  const result = tx();
  logActivity({
    user: req.session.user, action: 'create',
    entityType: 'quote', entityId: result.quoteId, entityLabel: result.quoteNumber,
    details: `Created quote "${result.quoteNumber}" — ${projectName}`,
    ip: req.ip,
  });

  req.flash('success', `Quote ${result.quoteNumber} created.`);
  req.session.save(() => res.redirect(`/quotes/${result.quoteId}`));
});

// ────────────────────────────────────────────────────────────────────
// Show / Edit header
// ────────────────────────────────────────────────────────────────────

router.get('/:id', (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return next();
  const db = getDb();

  const quote = db.prepare(`
    SELECT q.*, c.company_name AS client_name, u.full_name AS prepared_by_name,
           rc.name AS rate_card_name
    FROM quotes q
    LEFT JOIN clients c ON c.id = q.client_id
    LEFT JOIN users u ON u.id = q.prepared_by_user_id
    LEFT JOIN rate_cards rc ON rc.id = q.rate_card_id
    WHERE q.id = ?
  `).get(id);
  if (!quote) {
    req.flash('error', 'Quote not found.');
    return req.session.save(() => res.redirect('/quotes'));
  }

  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const inclusions = JSON.parse(quote.inclusions_json || '[]').join('\n');
  const exclusions = JSON.parse(quote.exclusions_json || '[]').join('\n');

  // ── Site Matrix data ──
  // Columns: visible quote_rate_items joined to their rate_card_item +
  // standard variant. Items without a rate_card_item_id (future custom
  // columns) carry their own custom_* fields; the view detects and
  // renders both shapes.
  const columns = db.prepare(`
    SELECT qri.id AS qri_id, qri.sort_order, qri.is_hidden,
           qri.rate_card_item_id,
           qri.custom_name, qri.custom_unit, qri.custom_rate, qri.custom_unit_cost,
           qri.custom_has_hours_input, qri.custom_category,
           i.name AS rc_name, i.unit AS rc_unit, i.has_hours_input AS rc_has_hours,
           i.category AS rc_category, i.pricing_status,
           v.rate AS standard_rate
    FROM quote_rate_items qri
    LEFT JOIN rate_card_items i ON i.id = qri.rate_card_item_id
    LEFT JOIN rate_card_item_variants v
      ON v.rate_card_item_id = i.id
     AND v.shift_type = 'standard' AND v.hour_bracket = 'standard'
    WHERE qri.quote_id = ? AND qri.is_hidden = 0
    ORDER BY qri.sort_order, qri.id
  `).all(id).map(c => ({
    qri_id: c.qri_id,
    rate_card_item_id: c.rate_card_item_id,
    name:       c.rc_name        || c.custom_name        || '(unnamed)',
    unit:       c.rc_unit        || c.custom_unit        || 'fixed',
    has_hours:  (c.rc_has_hours ?? c.custom_has_hours_input) ? 1 : 0,
    category:   c.rc_category    || c.custom_category    || 'allowances_misc',
    rate:       c.standard_rate  ?? c.custom_rate        ?? null,
    pricing_status: c.pricing_status || (c.custom_rate == null ? 'poa' : 'priced'),
  }));

  const groups = db.prepare('SELECT * FROM quote_groups WHERE quote_id = ? ORDER BY sort_order, id').all(id);
  const sites  = db.prepare('SELECT * FROM quote_sites WHERE quote_id = ? ORDER BY sort_order, id').all(id);
  const lines  = db.prepare(`
    SELECT qli.* FROM quote_line_items qli
    JOIN quote_sites qs ON qs.id = qli.quote_site_id
    WHERE qs.quote_id = ?
  `).all(id);

  const canSeeCost = canViewInternalCost(req.session.user);
  const settings = db.prepare('SELECT * FROM quoting_settings WHERE id = 1').get() || {};

  // cellMap[siteId][rateCardItemId] = { qty, hours, line_revenue, … }
  // Cost + margin fields are populated only when the viewer can see
  // internal cost — non-privileged users get no margin data in the HTML.
  const cellMap = {};
  for (const l of lines) {
    if (!cellMap[l.quote_site_id]) cellMap[l.quote_site_id] = {};
    const entry = {
      id: l.id, qty: l.qty, hours: l.hours, line_revenue: l.line_revenue,
    };
    if (canSeeCost) {
      entry.line_cost = l.line_cost;
      entry.line_margin = l.line_margin;
      entry.line_margin_pct = l.line_margin_pct;
      entry.unit_cost_override = l.unit_cost_override;
      entry.cost_derivation = describeCostDerivation(l, settings);
    }
    cellMap[l.quote_site_id][l.rate_card_item_id] = entry;
  }

  // Column totals (sum line_revenue + line_cost by rate_card_item_id)
  const columnTotalsRows = db.prepare(`
    SELECT rate_card_item_id,
           COALESCE(SUM(line_revenue), 0) AS total,
           COALESCE(SUM(line_cost), 0) AS cost
    FROM quote_line_items
    WHERE quote_site_id IN (SELECT id FROM quote_sites WHERE quote_id = ?)
    GROUP BY rate_card_item_id
  `).all(id);
  const columnTotals = Object.fromEntries(columnTotalsRows.map(r => [r.rate_card_item_id, r.total]));
  const columnCosts = canSeeCost
    ? Object.fromEntries(columnTotalsRows.map(r => [r.rate_card_item_id, r.cost]))
    : {};

  // Group sites by group_id (null = ungrouped)
  const sitesByGroup = { __ungrouped: [] };
  for (const g of groups) sitesByGroup[g.id] = [];
  for (const s of sites) {
    const key = s.group_id || '__ungrouped';
    if (sitesByGroup[key]) sitesByGroup[key].push(s);
    else sitesByGroup['__ungrouped'].push(s);
  }

  res.render('quoting/quotes/show', {
    title: `${quote.quote_number} — ${quote.project_name || 'Quote'}`,
    currentPage: 'quotes',
    quote, clients,
    inclusions, exclusions,
    columns, groups, sites, sitesByGroup, cellMap, columnTotals, columnCosts,
    columnCount: columns.length, siteCount: sites.length,
    roadClassifications: ROAD_CLASSIFICATIONS,
    isLocked: LOCKED_STATUSES.has(quote.status),
    statusLabels: STATUS_LABELS,
    canSeeCost,
    marginHealthy: Number(settings.margin_healthy_threshold) || 25,
    marginWatch:   Number(settings.margin_watch_threshold)   || 15,
  });
});

router.post('/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const before = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!before) { req.flash('error', 'Quote not found.'); return req.session.save(() => res.redirect('/quotes')); }
  if (LOCKED_STATUSES.has(before.status)) {
    req.flash('error', `Quote is ${before.status} — header is locked. Create a revision instead.`);
    return req.session.save(() => res.redirect(`/quotes/${id}`));
  }

  const b = req.body;
  const clientId = b.client_id ? parseInt(b.client_id, 10) || null : null;
  let clientNameSnap = before.client_name_snapshot;
  if (clientId) {
    const c = db.prepare('SELECT company_name FROM clients WHERE id = ?').get(clientId);
    if (c) clientNameSnap = c.company_name;
  } else if (typeof b.client_name_freetext === 'string') {
    clientNameSnap = b.client_name_freetext.trim();
  }

  db.prepare(`
    UPDATE quotes SET
      client_id = ?, client_name_snapshot = ?,
      project_name = ?, project_description = ?,
      quote_date = ?, valid_until_date = ?,
      inclusions_json = ?, exclusions_json = ?, terms = ?,
      internal_notes = ?, within_50km = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    clientId, clientNameSnap,
    (b.project_name || '').trim() || before.project_name,
    (b.project_description || '').trim(),
    b.quote_date || before.quote_date,
    b.valid_until_date || null,
    linesToJsonArray(b.inclusions_text),
    linesToJsonArray(b.exclusions_text),
    b.terms || '',
    (b.internal_notes || '').trim(),
    isCheckboxOn(b.within_50km) ? 1 : 0,
    id,
  );

  logActivity({
    user: req.session.user, action: 'update',
    entityType: 'quote', entityId: id, entityLabel: before.quote_number,
    details: `Updated quote header`,
    ip: req.ip,
  });

  req.flash('success', 'Quote updated.');
  req.session.save(() => res.redirect(`/quotes/${id}`));
});

// ────────────────────────────────────────────────────────────────────
// Site Matrix — groups, sites, cells
//
// All matrix mutations require the quote to be in 'draft' status. Once a
// quote moves to sent/accepted/rejected/expired/superseded, the matrix
// is read-only (snapshots are locked). The locked check happens at the
// top of each handler so direct API hits can't bypass the UI.
// ────────────────────────────────────────────────────────────────────

function requireDraftQuote(req, res, db) {
  const id = parseInt(req.params.id, 10);
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!q) {
    if (req.accepts('json') && !req.accepts('html')) return { error: { status: 404, body: { error: 'Quote not found' } } };
    req.flash('error', 'Quote not found.');
    req.session.save(() => res.redirect('/quotes'));
    return { error: true };
  }
  if (LOCKED_STATUSES.has(q.status)) {
    if (req.accepts('json') && !req.accepts('html')) return { error: { status: 403, body: { error: `Quote is ${q.status}; matrix is read-only.` } } };
    req.flash('error', `Quote is ${q.status}; create a revision to edit.`);
    req.session.save(() => res.redirect(`/quotes/${id}`));
    return { error: true };
  }
  return { quote: q };
}

// ── Groups ──

router.post('/:id/groups', (req, res) => {
  const db = getDb();
  const guard = requireDraftQuote(req, res, db);
  if (guard.error) { if (guard.error.status) res.status(guard.error.status).json(guard.error.body); return; }

  const name = (req.body.name || '').trim();
  if (!name) { req.flash('error', 'Group name is required.'); return req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`)); }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM quote_groups WHERE quote_id = ?').get(guard.quote.id).m;
  const info = db.prepare('INSERT INTO quote_groups (quote_id, name, sort_order) VALUES (?, ?, ?)').run(guard.quote.id, name, maxSort + 10);

  logActivity({
    user: req.session.user, action: 'create',
    entityType: 'quote_group', entityId: info.lastInsertRowid, entityLabel: name,
    details: `Added group "${name}" to quote ${guard.quote.quote_number}`, ip: req.ip,
  });
  req.flash('success', `Added group "${name}".`);
  req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`));
});

router.post('/:id/groups/:groupId/delete', (req, res) => {
  const db = getDb();
  const guard = requireDraftQuote(req, res, db);
  if (guard.error) { if (guard.error.status) res.status(guard.error.status).json(guard.error.body); return; }

  const groupId = parseInt(req.params.groupId, 10);
  const g = db.prepare('SELECT * FROM quote_groups WHERE id = ? AND quote_id = ?').get(groupId, guard.quote.id);
  if (!g) { req.flash('error', 'Group not found.'); return req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`)); }

  // ON DELETE SET NULL on quote_sites.group_id makes the sites become
  // ungrouped automatically, preserving their line items.
  db.prepare('DELETE FROM quote_groups WHERE id = ?').run(groupId);

  logActivity({
    user: req.session.user, action: 'delete',
    entityType: 'quote_group', entityId: groupId, entityLabel: g.name,
    details: `Deleted group "${g.name}" from quote ${guard.quote.quote_number}`, ip: req.ip,
  });
  req.flash('success', `Deleted group "${g.name}". Its sites are now ungrouped.`);
  req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`));
});

// ── Sites ──

router.post('/:id/sites', (req, res) => {
  const db = getDb();
  const guard = requireDraftQuote(req, res, db);
  if (guard.error) { if (guard.error.status) res.status(guard.error.status).json(guard.error.body); return; }

  const b = req.body;
  const name = (b.site_name || '').trim();
  if (!name) { req.flash('error', 'Site name is required.'); return req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`)); }

  const groupId = b.group_id ? parseInt(b.group_id, 10) || null : null;
  // Sanity: if a group_id is passed, confirm it belongs to this quote.
  if (groupId) {
    const ok = db.prepare('SELECT id FROM quote_groups WHERE id = ? AND quote_id = ?').get(groupId, guard.quote.id);
    if (!ok) { req.flash('error', 'Selected group does not belong to this quote.'); return req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`)); }
  }
  const roadClass = ROAD_CLASSIFICATIONS.includes(b.road_classification) ? b.road_classification : null;
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM quote_sites WHERE quote_id = ?').get(guard.quote.id).m;

  db.prepare(`
    INSERT INTO quote_sites (quote_id, group_id, site_code, site_name, road_name, road_classification, notes, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    guard.quote.id, groupId,
    (b.site_code || '').trim() || null,
    name,
    (b.road_name || '').trim() || '',
    roadClass,
    (b.notes || '').trim() || '',
    maxSort + 10,
  );

  logActivity({
    user: req.session.user, action: 'create',
    entityType: 'quote_site', entityLabel: name,
    details: `Added site "${name}" to quote ${guard.quote.quote_number}`, ip: req.ip,
  });
  req.flash('success', `Added site "${name}".`);
  req.session.save(() => res.redirect(`/quotes/${guard.quote.id}#site-bottom`));
});

router.post('/:id/sites/:siteId/delete', (req, res) => {
  const db = getDb();
  const guard = requireDraftQuote(req, res, db);
  if (guard.error) { if (guard.error.status) res.status(guard.error.status).json(guard.error.body); return; }

  const siteId = parseInt(req.params.siteId, 10);
  const s = db.prepare('SELECT * FROM quote_sites WHERE id = ? AND quote_id = ?').get(siteId, guard.quote.id);
  if (!s) { req.flash('error', 'Site not found.'); return req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`)); }

  // ON DELETE CASCADE cleans up quote_line_items for this site.
  db.prepare('DELETE FROM quote_sites WHERE id = ?').run(siteId);
  recomputeQuoteTotals(db, guard.quote.id);

  logActivity({
    user: req.session.user, action: 'delete',
    entityType: 'quote_site', entityId: siteId, entityLabel: s.site_name,
    details: `Deleted site "${s.site_name}" from quote ${guard.quote.quote_number}`, ip: req.ip,
  });
  req.flash('success', `Deleted site "${s.site_name}".`);
  req.session.save(() => res.redirect(`/quotes/${guard.quote.id}`));
});

// ── Cell save (JSON) ──
//   The Site Matrix grid debounces input events client-side and POSTs
//   one cell at a time here. Server is the source of truth for line
//   revenue + recomputed totals; client patches DOM from the response.
//
//   This endpoint is JSON-only — bypassing requireDraftQuote (which
//   does content-negotiation against Accept and gets confused by the
//   default fetch */* header) so the locked-quote response is always
//   JSON the client can parse.
router.post('/:id/cells', express.json(), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  if (LOCKED_STATUSES.has(q.status)) {
    return res.status(403).json({ error: `Quote is ${q.status}; matrix is read-only.` });
  }
  const guard = { quote: q };

  const siteId = parseInt(req.body.site_id, 10);
  const itemId = parseInt(req.body.rate_card_item_id, 10);
  const qty = toNumberOr(req.body.qty, 0);
  const hours = (req.body.hours === '' || req.body.hours == null) ? null : toNumberOr(req.body.hours, null);

  const site = db.prepare('SELECT * FROM quote_sites WHERE id = ? AND quote_id = ?').get(siteId, guard.quote.id);
  if (!site) return res.status(400).json({ error: 'Site does not belong to this quote' });

  const item = db.prepare(`
    SELECT i.*, v.rate AS standard_rate, v.unit_cost AS standard_unit_cost
    FROM rate_card_items i
    LEFT JOIN rate_card_item_variants v
      ON v.rate_card_item_id = i.id
     AND v.shift_type = 'standard' AND v.hour_bracket = 'standard'
    WHERE i.id = ?
  `).get(itemId);
  if (!item) return res.status(400).json({ error: 'Rate card item not found' });

  const rate = item.standard_rate ?? 0;
  const effectiveHours = item.has_hours_input ? (hours ?? 0) : 1;
  const lineRevenue = round2(qty * effectiveHours * rate);

  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM quote_line_items WHERE quote_site_id = ? AND rate_card_item_id = ?').get(siteId, itemId);

    if (qty === 0 && (hours === null || hours === 0)) {
      // Treat empty/zero cell as "no line" — keeps the table tidy.
      if (existing) db.prepare('DELETE FROM quote_line_items WHERE id = ?').run(existing.id);
    } else if (existing) {
      db.prepare(`
        UPDATE quote_line_items SET
          qty = ?, hours = ?,
          rate_snapshot = ?, has_hours_snapshot = ?,
          unit_cost_snapshot = ?,
          line_revenue = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        qty, hours, rate, item.has_hours_input ? 1 : 0,
        item.standard_unit_cost ?? 0,
        lineRevenue,
        existing.id,
      );
    } else {
      db.prepare(`
        INSERT INTO quote_line_items (
          quote_site_id, rate_card_item_id, rate_card_item_variant_id,
          item_name_snapshot, unit_snapshot, category_snapshot,
          shift_type, hour_bracket,
          rate_snapshot, has_hours_snapshot,
          qty, hours,
          cost_method_snapshot, unit_cost_snapshot,
          crew_composition_snapshot_json, vehicle_cost_snapshot,
          line_revenue, line_cost, line_margin, line_margin_pct
        ) VALUES (?, ?, NULL, ?, ?, ?, 'standard', 'standard', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
      `).run(
        siteId, itemId,
        item.name, item.unit, item.category,
        rate, item.has_hours_input ? 1 : 0,
        qty, hours,
        item.cost_method, item.standard_unit_cost ?? 0,
        item.crew_composition_json, item.vehicle_cost_per_hour,
        lineRevenue,
      );
    }
    return recomputeQuoteTotals(db, guard.quote.id);
  });

  const totals = tx();
  // Column total for THIS rate item (for the footer cell update).
  const colTotals = db.prepare(`
    SELECT COALESCE(SUM(line_revenue), 0) AS revenue,
           COALESCE(SUM(line_cost), 0) AS cost
    FROM quote_line_items
    WHERE rate_card_item_id = ?
      AND quote_site_id IN (SELECT id FROM quote_sites WHERE quote_id = ?)
  `).get(itemId, guard.quote.id);

  // Fetch the freshly-recomputed line so margin fields reflect the
  // values that just landed in the DB.
  const savedLine = db.prepare(`
    SELECT id, line_revenue, line_cost, line_margin, line_margin_pct, unit_cost_override
    FROM quote_line_items
    WHERE quote_site_id = ? AND rate_card_item_id = ?
  `).get(siteId, itemId);

  const canSeeCost = canViewInternalCost(req.session.user);
  const response = {
    ok: true,
    line: { line_revenue: lineRevenue, qty, hours },
    site_subtotal: totals.siteSubtotals[siteId] || 0,
    column_total: round2(colTotals.revenue),
    quote_subtotal: totals.quoteSubtotal,
    quote_gst: totals.gst,
    quote_total: totals.total,
  };
  if (canSeeCost) {
    // When the cell was just cleared (qty=0), the row is gone — emit
    // zeroed fields so the client can blank out the chip rather than
    // leaving stale margin text in place.
    const lineCost = savedLine ? {
      id: savedLine.id,
      line_revenue: savedLine.line_revenue,
      line_cost: savedLine.line_cost,
      line_margin: savedLine.line_margin,
      line_margin_pct: savedLine.line_margin_pct,
      unit_cost_override: savedLine.unit_cost_override,
    } : {
      id: null, line_revenue: 0,
      line_cost: 0, line_margin: 0, line_margin_pct: 0,
      unit_cost_override: null,
    };
    response.cost = {
      line: lineCost,
      site: {
        cost: totals.siteCosts[siteId] || 0,
        margin: totals.siteMargins[siteId] || 0,
        margin_pct: totals.siteMarginPcts[siteId] || 0,
      },
      column: {
        cost: round2(colTotals.cost),
      },
      quote: {
        cost: totals.quoteCost,
        margin: totals.quoteMargin,
        margin_pct: totals.quoteMarginPct,
      },
    };
  }
  res.json(response);
});

// ── Per-line cost override ──
//   Sets / clears quote_line_items.unit_cost_override and re-runs the
//   full recompute pass so site + quote rollups stay consistent.
//   Cost-only data: gated behind canViewInternalCost. A non-privileged
//   user receives 403 even on direct API hits.
router.post('/:id/lines/override', express.json(), (req, res) => {
  if (!canViewInternalCost(req.session.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!q) return res.status(404).json({ error: 'Quote not found' });
  if (LOCKED_STATUSES.has(q.status)) {
    return res.status(403).json({ error: `Quote is ${q.status}; matrix is read-only.` });
  }

  const siteId = parseInt(req.body.site_id, 10);
  const itemId = parseInt(req.body.rate_card_item_id, 10);
  // null / empty / missing clears the override; any finite number sets it.
  let override = req.body.unit_cost_override;
  if (override === '' || override === null || override === undefined) {
    override = null;
  } else {
    const n = Number(override);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid override value' });
    override = n;
  }

  const line = db.prepare(`
    SELECT qli.* FROM quote_line_items qli
    JOIN quote_sites qs ON qs.id = qli.quote_site_id
    WHERE qs.quote_id = ? AND qli.quote_site_id = ? AND qli.rate_card_item_id = ?
  `).get(id, siteId, itemId);
  if (!line) return res.status(404).json({ error: 'Line not found — set a qty first.' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE quote_line_items SET unit_cost_override = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(override, line.id);
    return recomputeQuoteTotals(db, id);
  });
  const totals = tx();

  logActivity({
    user: req.session.user, action: 'update',
    entityType: 'quote_line_item', entityId: line.id, entityLabel: line.item_name_snapshot,
    details: override == null
      ? `Cleared cost override on "${line.item_name_snapshot}" (${q.quote_number})`
      : `Set cost override $${override.toFixed(2)} on "${line.item_name_snapshot}" (${q.quote_number})`,
    ip: req.ip,
  });

  const saved = db.prepare(`
    SELECT id, line_cost, line_margin, line_margin_pct, unit_cost_override
    FROM quote_line_items WHERE id = ?
  `).get(line.id);
  const colCost = db.prepare(`
    SELECT COALESCE(SUM(line_cost), 0) AS c
    FROM quote_line_items
    WHERE rate_card_item_id = ?
      AND quote_site_id IN (SELECT id FROM quote_sites WHERE quote_id = ?)
  `).get(itemId, id).c;

  res.json({
    ok: true,
    cost: {
      line: saved,
      site: {
        cost: totals.siteCosts[siteId] || 0,
        margin: totals.siteMargins[siteId] || 0,
        margin_pct: totals.siteMarginPcts[siteId] || 0,
      },
      column: { cost: round2(colCost) },
      quote: {
        cost: totals.quoteCost,
        margin: totals.quoteMargin,
        margin_pct: totals.quoteMarginPct,
      },
    },
  });
});

router.post('/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const db = getDb();
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!q) { req.flash('error', 'Quote not found.'); return req.session.save(() => res.redirect('/quotes')); }
  if (LOCKED_STATUSES.has(q.status)) {
    req.flash('error', `Cannot delete a ${q.status} quote. Mark it superseded instead.`);
    return req.session.save(() => res.redirect(`/quotes/${id}`));
  }

  db.prepare('DELETE FROM quotes WHERE id = ?').run(id);
  logActivity({
    user: req.session.user, action: 'delete',
    entityType: 'quote', entityId: id, entityLabel: q.quote_number,
    details: `Deleted draft quote "${q.quote_number}"`,
    ip: req.ip,
  });
  req.flash('success', `Deleted ${q.quote_number}.`);
  req.session.save(() => res.redirect('/quotes'));
});

module.exports = router;
