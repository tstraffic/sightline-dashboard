// Optional seed for the Quoting module — pre-loads the TfNSW Pneumatic
// Tube Count rate card (12 items × 1 standard variant) plus an example
// draft quote with 33 sites grouped into 3 screenlines.
//
// NOT auto-run. The codebase intentionally disables demo data seeding
// (see schema.js seedDemoData → no-op). Run this manually when you want
// the TfNSW example loaded for testing or regression-checking the Site
// Matrix grand total against the source Excel.
//
//   node db/seeds/quoting-tfnsw-example.js
//
// Idempotent: skips entirely if a rate card with the canonical name
// already exists, so it's safe to re-run.
//
// Cost values are placeholders flagged in the brief — review with
// payroll before relying on margin numbers in production.

const PLACEHOLDER_TC_HOURLY = 55.00;   // TBD — confirm with payroll
const PLACEHOLDER_TL_HOURLY = 65.00;   // TBD
const PLACEHOLDER_POD_VEHICLE = 40.00; // TBD — pod truck running cost / hr

const RATE_CARD = {
  name: 'TfNSW Pneumatic Tube Count Rates 2025',
  description: 'Unit rates for TfNSW pneumatic tube count installation and retrieval projects.',
  effective_from: '2025-01-01',
  effective_to: null,
};

// [category, code, name, unit, has_hours, is_addon, min_booking,
//  pricing_status, cost_method, sell_rate, unit_cost, crew_composition,
//  vehicle_cost_per_hour, notes, sort_order]
const RATE_ITEMS = [
  // Planning & Compliance
  ['planning_compliance', 'TGS_PREP', 'TGS Preparation', 'per_shift', 0, 0, null, 'priced', 'fixed', 120.00, 50.00, null, null, 'TcAWS v6.1 compliant — per shift attended', 10],
  ['planning_compliance', 'ROL_APP',  'ROL Application & Coordination', 'per_shift', 0, 0, null, 'priced', 'fixed', 100.00, 40.00, null, null, 'Road Occupancy Licence admin — per shift', 20],

  // Traffic Control Labour — computed_crew (TC + TL counts)
  ['tc_labour', 'TC_CREW_2',     '2 TC Crew',           'per_hour', 1, 0, 4.0, 'priced', 'computed_crew', 150.95, null, { tc_count: 1, tl_count: 1, supervisor_count: 0 }, null,                     'Installation & retrieval — 2 controller crew (1 TL + 1 TC)', 30],
  ['tc_labour', 'TC_CREW_3',     '3 TC Crew',           'per_hour', 1, 0, 4.0, 'priced', 'computed_crew', 219.50, null, { tc_count: 2, tl_count: 1, supervisor_count: 0 }, null,                     'Installation & retrieval — 3 controller crew (1 TL + 2 TCs)', 40],
  ['tc_labour', 'TC_CREW_4',     '4 TC Crew',           'per_hour', 1, 0, 4.0, 'priced', 'computed_crew', 286.15, null, { tc_count: 3, tl_count: 1, supervisor_count: 0 }, null,                     'Installation & retrieval — 4 controller crew (1 TL + 3 TCs)', 50],
  ['tc_labour', 'TC_POD_TRUCK_3','3 TC Pod Truck Crew', 'per_hour', 1, 0, 4.0, 'priced', 'computed_crew', 244.00, null, { tc_count: 2, tl_count: 1, supervisor_count: 0 }, PLACEHOLDER_POD_VEHICLE,  'Installation & retrieval — 3 TC crew with pod truck (labour + vehicle)', 60],
  ['tc_labour', 'TC_ADDITIONAL', 'Additional TC',       'per_hour', 1, 1, 4.0, 'priced', 'computed_crew',  67.50, null, { tc_count: 1, tl_count: 0, supervisor_count: 0 }, null,                     'Additional individual traffic controller — adds to existing crew line', 70],

  // Equipment & Vehicles
  ['equipment_vehicles', 'SITE_EST',     'Site Establishment',                 'per_site',  0, 0, null, 'priced', 'fixed',  85.00, 30.00, null, null, 'Per site mobilisation fee', 80],
  ['equipment_vehicles', 'PORTABOOM_2X', '2× Portaboom Gates + Trailer',       'per_shift', 0, 0, null, 'priced', 'fixed', 285.00, 50.00, null, null, 'Boom gate assembly per shift', 90],
  ['equipment_vehicles', 'VMS_DRIVER',   'Extra VMS + Driver',                 'per_hour',  1, 1, null, 'priced', 'fixed',  91.50, 45.00, null, null, 'Variable Message Sign vehicle with driver', 100],
  ['equipment_vehicles', 'TMA',          'TMA (Truck-Mounted Attenuator)',     'per_shift', 0, 0, 6.0,  'poa',    'fixed',  null,  80.00, null, null, 'If required — confirm per site', 110],
  ['equipment_vehicles', 'ARROW_BOARD',  'Arrow Board',                        'per_shift', 0, 0, null, 'poa',    'fixed',  null,  30.00, null, null, 'If required — confirm per site', 120],
];

const EXAMPLE_QUOTE = {
  quote_number: 'TS-QTE-EXAMPLE-TFNSW',
  client_name_snapshot: 'Transport for NSW',
  project_name: 'Pneumatic Tube Count Project',
  project_description: 'Traffic management for pneumatic tube count installation and retrieval across 33 sites in 3 screenlines (Screenline 10, Screenline 14, Screenline 19) in Sydney metropolitan area.',
};

const SCREENLINES = [
  { name: 'Screenline 10', sort_order: 10 },
  { name: 'Screenline 14', sort_order: 20 },
  { name: 'Screenline 19', sort_order: 30 },
];

// [group_index, site_code, site_name, road_classification, sort_order]
const SITES = [
  // Screenline 10 (20 sites)
  [0, 'SC10_01', 'Underwood Road, Homebush',                 'regional',  10],
  [0, 'SC10_04', 'Great Western Hwy, Flemington',            'state',     20],
  [0, 'SC10_05', 'Arthur St, Strathfield',                   'regional',  30],
  [0, 'SC10_06', 'Hume Hwy, Strathfield',                    'state',     40],
  [0, 'SC10_07', 'Juno Pde, Greenacre',                      'state',     50],
  [0, 'SC10_08', 'Punchbowl Rd, Wiley Park (2 counters)',    'state',     60],
  [0, 'SC10_09', 'Lakemba St, Wiley Park',                   'regional',  70],
  [0, 'SC10_10', 'The Boulevarde, Lakemba',                  'local',     80],
  [0, 'SC10_11', 'Canterbury Rd, Roselands (2 counters)',    'state',     90],
  [0, 'SC10_12', 'Moorefields Rd, Roselands',                'regional', 100],
  [0, 'SC10_15', 'Tooronga Tce, Beverly Hills',              'regional', 110],
  [0, 'SC10_16', 'Morgan St, Beverly Hills',                 'local',    120],
  [0, 'SC10_17', 'Stoney Creek Rd, Beverly Hills (2 ctrs)',  'state',    130],
  [0, 'SC10_18', 'Forest Rd, Hurstville',                    'state',    140],
  [0, 'SC10_19', 'Woniora Rd, Penshurst',                    'regional', 150],
  [0, 'SC10_20', 'Hillcrest Ave, Hurstville',                'regional', 160],
  [0, 'SC10_21', 'Connells Point Rd, South Hurstville',      'local',    170],
  [0, 'SC10_22', 'Blakesley Rd, Blakehurst',                 'local',    180],
  [0, 'SC10_23', 'Terry St, Blakehurst',                     'local',    190],
  [0, 'SC10_24', 'Princes Hwy, Blakehurst',                  'state',    200],

  // Screenline 14 (7 sites)
  [1, 'SC14_06', 'Cleveland St, Randwick',                   'state',    210],
  [1, 'SC14_07', 'Dacey Ave, Randwick (2 counters)',         'state',    220],
  [1, 'SC14_08', 'Todman Ave, Randwick',                     'regional', 230],
  [1, 'SC14_09', 'Gardeners Rd, Eastlakes (2 counters)',     'state',    240],
  [1, 'SC14_10', 'Wentworth Ave, Mascot',                    'state',    250],
  [1, 'SC14_11', 'Botany Rd, Botany (2 counters)',           'state',    260],
  [1, 'SC14_12', 'Foreshore Rd, Botany (2 counters)',        'state',    270],

  // Screenline 19 (4 sites)
  [2, 'SC19_01', 'Heathcote Rd',                             'state',    280],
  [2, 'SC19_02', 'Alfords Point Rd (2 counters)',            'state',    290],
  [2, 'SC19_03', 'Princes Hwy, Blakehurst (2 counters)',     'state',    300],
  [2, 'SC19_04', 'Rocky Point Rd (2 counters)',              'state',    310],
];

function seedTfNSWExample(db) {
  const existing = db.prepare('SELECT id FROM rate_cards WHERE name = ?').get(RATE_CARD.name);
  if (existing) {
    console.log(`[seed] TfNSW rate card already exists (id=${existing.id}). Skipping.`);
    return existing.id;
  }

  const tx = db.transaction(() => {
    // Ensure default cost rates are populated on quoting_settings so the
    // computed_crew items have something to resolve against.
    db.prepare(`
      UPDATE quoting_settings
         SET default_tc_cost_rate = COALESCE(default_tc_cost_rate, ?),
             default_tl_cost_rate = COALESCE(default_tl_cost_rate, ?)
       WHERE id = 1
    `).run(PLACEHOLDER_TC_HOURLY, PLACEHOLDER_TL_HOURLY);

    const cardId = db.prepare(`
      INSERT INTO rate_cards (name, description, effective_from, effective_to, is_default, purpose, source)
      VALUES (?, ?, ?, ?, 1, 'quoting', 'manual')
    `).run(RATE_CARD.name, RATE_CARD.description, RATE_CARD.effective_from, RATE_CARD.effective_to).lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO rate_card_items
        (rate_card_id, category, code, name, unit, has_hours_input, is_addon,
         min_booking_hours, pricing_status, cost_method, crew_composition_json,
         vehicle_cost_per_hour, notes, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVariant = db.prepare(`
      INSERT INTO rate_card_item_variants
        (rate_card_item_id, shift_type, hour_bracket, rate, unit_cost)
      VALUES (?, 'standard', 'standard', ?, ?)
    `);

    const insertedItemIds = [];
    for (const it of RATE_ITEMS) {
      const [category, code, name, unit, hasHours, isAddon, minBooking, pricingStatus,
             costMethod, sellRate, unitCost, crew, vehicleCost, notes, sortOrder] = it;
      const itemId = insertItem.run(
        cardId, category, code, name, unit, hasHours, isAddon,
        minBooking, pricingStatus, costMethod,
        crew ? JSON.stringify(crew) : null,
        vehicleCost, notes, sortOrder
      ).lastInsertRowid;
      insertVariant.run(itemId, sellRate, unitCost);
      insertedItemIds.push({ id: itemId, sort_order: sortOrder });
    }

    const settings = db.prepare('SELECT company_inclusions_defaults_json, company_exclusions_defaults_json, company_terms_default FROM quoting_settings WHERE id = 1').get();
    const validUntil = new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];

    const quoteId = db.prepare(`
      INSERT INTO quotes
        (quote_number, client_name_snapshot, project_name, project_description,
         rate_card_id, quote_date, valid_until_date, status, version,
         inclusions_json, exclusions_json, terms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?)
    `).run(
      EXAMPLE_QUOTE.quote_number, EXAMPLE_QUOTE.client_name_snapshot,
      EXAMPLE_QUOTE.project_name, EXAMPLE_QUOTE.project_description,
      cardId, today, validUntil,
      settings.company_inclusions_defaults_json,
      settings.company_exclusions_defaults_json,
      settings.company_terms_default
    ).lastInsertRowid;

    // Populate the per-quote column list (Site Matrix grid columns).
    // All 12 rate items are columns by default; users hide/reorder/add-custom later.
    const insertQRI = db.prepare(`
      INSERT INTO quote_rate_items (quote_id, rate_card_item_id, sort_order)
      VALUES (?, ?, ?)
    `);
    for (const { id, sort_order } of insertedItemIds) {
      insertQRI.run(quoteId, id, sort_order);
    }

    const groupIds = [];
    const insertGroup = db.prepare('INSERT INTO quote_groups (quote_id, name, sort_order) VALUES (?, ?, ?)');
    for (const g of SCREENLINES) {
      groupIds.push(insertGroup.run(quoteId, g.name, g.sort_order).lastInsertRowid);
    }

    const insertSite = db.prepare(`
      INSERT INTO quote_sites
        (quote_id, group_id, site_code, site_name, road_name, road_classification, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [groupIdx, siteCode, siteName, roadClass, sortOrder] of SITES) {
      insertSite.run(quoteId, groupIds[groupIdx], siteCode, siteName, siteName, roadClass, sortOrder);
    }

    return { cardId, quoteId, itemCount: RATE_ITEMS.length, siteCount: SITES.length };
  });

  const result = tx();
  console.log(`[seed] Inserted TfNSW rate card #${result.cardId} (${result.itemCount} items) + example quote #${result.quoteId} (${result.siteCount} sites, 3 screenlines).`);
  return result.cardId;
}

module.exports = { seedTfNSWExample };

if (require.main === module) {
  const { getDb } = require('../database');
  const { initializeDatabase } = require('../schema');
  initializeDatabase();
  const db = getDb();
  try {
    seedTfNSWExample(db);
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
}
