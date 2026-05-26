// One-time seed of the Fleet Maintenance & Compliance module from the
// original T_S_Fleet_Register.xlsx workbook. Runs on first apply of
// migration 235 and skips if the vehicles table already has rows.
//
// Data-quality flags from the original workbook (duplicate VINs, Fleet
// ID clashes, the 'Corrolla' tab named Hilux, etc.) are preserved in
// each vehicle's `notes` column so office staff can reconcile them
// in-app instead of silently merging duplicates.

// [asset_id, fleet_id, rego, make, model, year, vin, vehicle_type,
//  toll_tag, status, notes]
const VEHICLES = [
  ['TSTC001',    'TSTC001',            'ETR 82V',  'Toyota', 'Hilux',      2022, 'MR0CX3CBX04332688', 'Light Vehicle', '11701356', 'Active', 'VIN duplicated on 4 other sheets — verify against rego papers.'],
  ['TSTC002',    'TSTC002',            'YLS 85F',  'Toyota', 'Hilux',      2022, 'MR0CX3CB204334676', 'Light Vehicle', '11793374', 'Active', ''],
  ['TSTC003',    'TSTC003',            'ERU 83U',  'Toyota', 'Hilux',      2021, 'MR0CX3CB304328000', 'Light Vehicle', '11701360', 'Active', 'Same rego ERU 83U as the TSTC004 sheet but different odometer — one rego/ID is wrong.'],
  ['TSTC004',    'TSTC003 (labelled)', 'ERU 83U',  'Toyota', 'Hilux',      2021, 'MR0CX3CB304328000', 'Light Vehicle', '11701360', 'Verify', 'High-km vehicle (124,341 km). Shares rego/ID with TSTC003 sheet — confirm true rego, VIN & Fleet ID.'],
  ['TSTC005',    'TSTC005',            'EUT 88J',  'Toyota', 'Hilux',      2022, 'MR0CX3CB804336092', 'Light Vehicle', '5019454',  'Active', 'First two services have no date — backfill from invoices.'],
  ['TSTC006',    'TSTC006',            'EUT 88K',  'Toyota', 'Hilux',      2022, 'MR0CX3CB504336082', 'Light Vehicle', '5019441',  'Active', ''],
  ['TSTC007',    'TSTC007',            'YOV 37G',  'Isuzu',  'D-MAX',      2023, 'MPATFR40JPT002189', 'Light Vehicle', '11794355', 'Active', 'Service log incomplete — obtain full history. Future-dated entry needs correcting.'],
  ['TSTC POD1',  'DDV001',             'CG56MC',   'Isuzu',  'NPR400 MWB', 2016, 'JAANPR75HF7106878', 'Heavy Vehicle', '11793374', 'Active', 'Pantech / POD truck — heavy vehicle inspection (Brown Slip) regime applies.'],
  ['TSTC POD 2', 'DDV002',             'CF94HW',   'Isuzu',  'NPR300 MWB', 2016, 'JAANPR75HF7107158', 'Heavy Vehicle', '',         'Active', 'Pantech / POD truck — heavy vehicle inspection (Brown Slip) regime applies.'],
  ['HILUX R1',   'ROGUE 1',            'ETR 82V',  'Toyota', 'Hilux',      2022, 'MR0CX3CBX04332688', 'Light Vehicle', '',         'Verify', 'Identical service rows to HILUX R2 sheet & rego clashes with TSTC001 — likely a duplicate sheet.'],
  ['Corrolla',   'ROGUE 2',            'ETR 82V',  'Toyota', 'Hilux',      2022, 'MR0CX3CBX04332688', 'Light Vehicle', '',         'Verify', "Tab named 'Corrolla' but model entered as Hilux; rego clashes with TSTC001 — confirm actual vehicle."],
  ['HILUX R2',   'ROGUE 2',            'ETR 82V',  'Toyota', 'Hilux',      2022, 'MR0CX3CBX04332688', 'Light Vehicle', '',         'Verify', 'Identical to HILUX R1 sheet — likely a duplicate; confirm and retire one.'],
  ['TSTC00X',    'TSTC004',            'CM 13 BW', 'Toyota', 'Hilux',      2017, 'MR0CX3CBX04332688', 'Light Vehicle', '',         'Verify', 'Fleet ID TSTC004 clashes with the TSTC004 sheet; VIN duplicated — verify against rego papers.'],
];

// [asset_id, service_date|null, odometer|null, work_performed,
//  service_type, performed_by, cost|null, invoice|null, notes]
const SERVICES = [
  ['TSTC001', '2020-06-18', 8755,  'Oil change, replace oil filter',                                                            'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     ''],
  ['TSTC001', '2021-03-26', 17339, 'Oil change, replace oil filter; general inspection & tyre rotation',                        'Oil Change / Minor',    'Mansours Petroleum',  260,    '',     ''],
  ['TSTC001', '2021-06-07', 20611, 'Oil change, replace oil filter, air filter',                                                'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     ''],
  ['TSTC001', '2025-07-02', null,  'Battery update — dual battery system DC/DC',                                                'Battery / Electrical',  'Hani Auto Electrical',1200,   '',     ''],
  ['TSTC001', '2025-08-01', 48756, 'Full service',                                                                              'Major Service',         'Mansours Petroleum',  null,   '',     'Cost missing — backfill from invoice.'],
  ['TSTC001', '2025-10-01', null,  'New fire extinguisher',                                                                     'Safety Equipment',      '',                    22,     '',     'Fire extinguisher expiry to be set.'],
  ['TSTC001', '2026-04-28', 62000, 'New rotors, new brake pads, minor service',                                                 'Brakes',                '',                    null,   '',     'Cost missing — backfill from invoice.'],

  ['TSTC002', '2022-11-15', 8564,  'Oil change, replace oil filter',                                                            'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     ''],
  ['TSTC002', '2023-05-04', 19724, 'Oil change, replace oil filter; general inspection & tyre rotation',                        'Oil Change / Minor',    'Mansours Petroleum',  260,    '',     ''],
  ['TSTC002', '2024-03-04', 31523, 'Oil change, replace oil filter, air filter; amend dual battery',                            'Battery / Electrical',  'Mansours Petroleum',  670,    '',     ''],
  ['TSTC002', '2025-01-10', 50980, 'Minor service — oil & filter, top up all levels, air & cabin filters',                      'Minor Service',         'Mansours Petroleum',  264,    '52554',''],
  ['TSTC002', '2025-04-01', 55000, '3 x tyre change & wheel alignment',                                                         'Tyres',                 'Safadi Tyres',        450,    '',     '$135/tyre & $45 wheel alignment.'],
  ['TSTC002', '2025-07-02', null,  'Battery update — dual battery system DC/DC',                                                'Battery / Electrical',  'Hani Auto Electrical',1200,   '',     ''],
  ['TSTC002', '2025-08-05', 62744, 'Minor service — oil & filter, top up all levels, air & cabin filters',                      'Minor Service',         'Mansours Petroleum',  null,   '',     'Cost missing — backfill from invoice.'],

  ['TSTC003', '2022-11-15', 13010, 'Oil change, replace oil filter',                                                            'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     ''],
  ['TSTC003', '2023-10-09', 24791, 'Oil change, replace oil filter; general inspection & tyre rotation',                        'Oil Change / Minor',    'Mansours Petroleum',  260,    '',     ''],
  ['TSTC003', '2024-07-20', 35031, 'Oil change, replace oil filter, air filter; tail lights replaced',                          'Oil Change / Minor',    'Mansours Petroleum',  425,    '',     ''],
  ['TSTC003', '2025-01-28', 43118, 'Service (work performed not recorded)',                                                     'Other',                 'Mansours Petroleum',  null,   '',     'Work description & cost missing — backfill from invoice.'],
  ['TSTC003', '2025-01-29', null,  'Front bumper replacement',                                                                  'Repairs / Accident',    'Totally Smashed',     390,    '',     'Back charge — Rabz.'],
  ['TSTC003', '2025-03-13', null,  '4 x tyre change',                                                                           'Tyres',                 'Safadi Tyres',        540,    '',     '$135/tyre. Rotate tyres every 6 months.'],
  ['TSTC003', '2025-04-02', null,  'Battery update — dual battery system DC/DC',                                                'Battery / Electrical',  'Hani Auto Electrical',1200,   '',     ''],

  ['TSTC004', '2025-03-03', 124341,'Major service — oil & filter, top up all levels, air & cabin filters',                      'Major Service',         'Mansours Petroleum',  319,    '52588',''],
  ['TSTC004', '2025-03-04', 124341,'Blue slip inspection',                                                                      'Inspection / Slip',     'Mansours Petroleum',  135,    '52588',''],
  ['TSTC004', '2025-03-12', 124341,'Dual battery set up & beacons',                                                             'Battery / Electrical',  'Hani Auto Electrical',1200,   '',     ''],

  ['TSTC005', null,         null,  'Oil change, replace oil filter',                                                            'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     'Service date missing — backfill from invoice.'],
  ['TSTC005', null,         null,  'Oil change, replace oil filter; general inspection & tyre rotation',                        'Oil Change / Minor',    'Mansours Petroleum',  260,    '',     'Service date missing — backfill from invoice.'],
  ['TSTC005', '2023-10-14', 32298, 'Minor service',                                                                             'Minor Service',         'Mansours Petroleum',  160,    '',     ''],
  ['TSTC005', '2024-03-11', 42221, 'Oil change, replace oil filter, air & cabin filters, tyre rotation, inspect drive belts',   'Oil Change / Minor',    'Mansours Petroleum',  550,    '',     ''],
  ['TSTC005', '2025-01-10', 52109, 'Minor service — oil & filter, top up all levels, air & cabin filters',                      'Minor Service',         'Mansours Petroleum',  264,    '52555',''],
  ['TSTC005', '2025-07-02', null,  'Battery update — dual battery system DC/DC',                                                'Battery / Electrical',  'Hani Auto Electrical',1200,   '',     ''],

  ['TSTC006', '2020-06-18', 8755,  'Oil change, replace oil filter',                                                            'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     ''],
  ['TSTC006', '2023-04-20', 14438, 'Oil change, replace oil filter; general inspection & tyre rotation',                        'Oil Change / Minor',    'Mansours Petroleum',  260,    '',     ''],
  ['TSTC006', '2023-11-03', 22597, 'Minor service',                                                                             'Minor Service',         'Mansours Petroleum',  160,    '',     ''],
  ['TSTC006', '2024-07-13', 34120, 'Oil change, replace oil filter, brake pads, air & cabin filters, tyre rotation, inspect drive belts', 'Brakes',     'Mansours Petroleum',  740,    '',     ''],
  ['TSTC006', '2025-03-11', null,  '2 x new front tyres, 1 x new spare tyre',                                                   'Tyres',                 'Safadi Tyres',        330,    '',     'Rotate tyres every 6 months.'],
  ['TSTC006', '2025-07-02', null,  'Battery leak update',                                                                       'Battery / Electrical',  'Hani Auto Electrical',350,    '',     ''],
  ['TSTC006', '2025-10-16', null,  'Tow bar attached',                                                                          'Repairs / Accident',    'Carasel',             1080,   '',     ''],
  ['TSTC006', '2025-10-01', 54000, 'Major service',                                                                             'Major Service',         'Mansours Petroleum',  286,    '',     ''],
  ['TSTC006', '2025-10-01', null,  'New fire extinguisher',                                                                     'Safety Equipment',      '',                    22,     '',     'Fire extinguisher expiry to be set.'],

  ['TSTC007', '2024-11-16', 11268, 'Oil change, replace oil filter',                                                            'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     'Obtain full service log.'],
  ['TSTC007', '2026-11-02', 47272, 'Minor service — oil & oil filter (5W-30 7.5L), replace air filter',                         'Minor Service',         '',                    350,    '',     'Date 02/11/2026 is in the future — likely a typo, verify.'],

  ['TSTC POD1',  '2026-03-02', 245769, 'Brake test & service; air filter; diesel fuel filter; windscreen wipers; minor truck service (15W-40 10L); oil filter; tyre pressures & fluids; grease tailshafts; water separator; Brown Slip', 'Inspection / Slip', 'Mansours Petroleum', 998, '', ''],
  ['TSTC POD 2', '2026-03-10', 245769, 'Brake test & service; air filter; diesel fuel filter; windscreen wipers; minor truck service (15W-40 10L); oil filter; tyre pressures & fluids; grease tailshafts; water separator; Brown Slip', 'Inspection / Slip', 'Mansours Petroleum', 908, '', 'Odometer same as POD1 — verify reading.'],

  ['HILUX R1', '2020-06-18', 8755,  'Oil change, replace oil filter',                                                           'Oil Change / Minor',    'Mansours Petroleum',  74.89,  '',     ''],
  ['HILUX R1', '2021-03-26', 17339, 'Oil change, replace oil filter; general inspection & tyre rotation',                       'Oil Change / Minor',    'Mansours Petroleum',  80.23,  '',     ''],
  ['HILUX R1', '2021-06-07', 20611, 'A/C discharge hose broken; recall fix — replace wiper rod arm',                            'Repairs / Accident',    'Mansours Petroleum',  0,      '',     ''],

  ['Corrolla', '2025-01-09', 160188,'Major service',                                                                            'Major Service',         'Mansours Petroleum',  418,    '',     "Odometer was recorded as '160 188' — confirm 160,188 km."],

  ['HILUX R2', '2020-06-18', 8755,  'Oil change, replace oil filter',                                                           'Oil Change / Minor',    'Mansours Petroleum',  74.89,  '',     ''],
  ['HILUX R2', '2021-03-26', 17339, 'Oil change, replace oil filter; general inspection & tyre rotation',                       'Oil Change / Minor',    'Mansours Petroleum',  80.23,  '',     ''],
  ['HILUX R2', '2021-06-07', 20611, 'A/C discharge hose broken; recall fix — replace wiper rod arm',                            'Repairs / Accident',    'Mansours Petroleum',  0,      '',     ''],

  ['TSTC00X', '2022-07-05', 136587, 'Oil change, replace oil filter',                                                           'Oil Change / Minor',    'Mansours Petroleum',  121,    '',     ''],
  ['TSTC00X', '2022-03-26', 149486, 'Major service',                                                                            'Major Service',         'Mansours Petroleum',  950,    '',     'Date sits before the previous entry but km is higher — date error, verify.'],
  ['TSTC00X', '2023-02-07', 161723, 'Oil change, replace oil filter, air filter',                                               'Oil Change / Minor',    'Mansours Petroleum',  160,    '',     ''],
  ['TSTC00X', '2023-10-15', 175213, 'Minor service, cabin filter, brake pads',                                                  'Brakes',                'Mansours Petroleum',  890,    '',     ''],
  ['TSTC00X', '2024-07-08', 183277, 'Minor service, cabin filter',                                                              'Minor Service',         'Mansours Petroleum',  160,    '',     ''],
];

function seedFleet(db) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM vehicles').get().c;
  if (existing > 0) {
    console.log(`  Fleet seed skipped — ${existing} vehicle(s) already in DB.`);
    return;
  }

  const insertVehicle = db.prepare(`
    INSERT INTO vehicles (asset_id, fleet_id, rego, make, model, year, vin, vehicle_type, toll_tag, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertService = db.prepare(`
    INSERT INTO service_records (vehicle_id, service_date, odometer_km, work_performed, service_type, performed_by, cost, invoice_number, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const findVehicleId = db.prepare('SELECT id FROM vehicles WHERE asset_id = ?');

  const seedTx = db.transaction(() => {
    for (const v of VEHICLES) {
      insertVehicle.run(...v);
    }
    for (const s of SERVICES) {
      const [assetId, date, odo, work, type, by, cost, invoice, notes] = s;
      const row = findVehicleId.get(assetId);
      if (!row) {
        console.warn(`  Fleet seed: no vehicle row for asset_id "${assetId}" — service record skipped.`);
        continue;
      }
      insertService.run(row.id, date, odo, work, type, by, cost, invoice, notes);
    }
  });

  seedTx();
  const vCount = db.prepare('SELECT COUNT(*) AS c FROM vehicles').get().c;
  const sCount = db.prepare('SELECT COUNT(*) AS c FROM service_records').get().c;
  const total = db.prepare('SELECT COALESCE(SUM(cost),0) AS t FROM service_records').get().t;
  console.log(`  Fleet seed: ${vCount} vehicles, ${sCount} service records, total spend $${Number(total).toFixed(2)}`);
}

module.exports = { seedFleet };
