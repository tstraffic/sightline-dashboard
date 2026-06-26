// Hire docket config — equipment type catalog, per-type required photo checklists,
// standard accessory presets, and the categorised attachment sections.
//
// Kept as code (not a DB table) because the list is code-owned: adding a new
// equipment type means updating the checklist/presets too, which should go
// through code review, not a settings screen.

const FUEL_LEVELS = ['empty', '1_4', '1_2', '3_4', 'full', 'na'];
const FUEL_LABELS = { empty: 'Empty', '1_4': '1/4', '1_2': '1/2', '3_4': '3/4', full: 'Full', na: 'N/A' };
// Battery-powered gear reuses the same underlying column values but crews
// read percentages more fluently than fuel fractions.
const BATTERY_LABELS = { empty: '0%', '1_4': '25%', '1_2': '50%', '3_4': '75%', full: '100%', na: 'N/A' };

// Map equipment types to the kind of charge they carry. Drives which label
// set ("Fuel level" vs "Battery charge") the gauge shows on the form.
const POWER_KINDS = {
  fuel: { label: 'Fuel level', labels: FUEL_LABELS },
  battery: { label: 'Battery charge', labels: BATTERY_LABELS },
  mixed: { label: 'Fuel / battery level', labels: FUEL_LABELS },
};
// Sensible defaults per type — VMS, arrow boards, light towers etc are
// solar+battery; excavators + generators burn fuel; trailers are mixed
// because some have onboard batteries for accessories.
const TYPE_POWER_KIND = {
  trailer: 'mixed',
  traffic_lights_trailer: 'battery',
  vms_board: 'battery',
  arrow_board: 'battery',
  generator: 'fuel',
  light_tower: 'mixed', // has a diesel genset but controls run off battery
  variable_sign: 'battery',
  mobile_crash_cushion: 'fuel',
  excavator: 'fuel',
  skid_steer: 'fuel',
  water_cart: 'fuel',
  telehandler: 'fuel',
  scissor_lift: 'battery',
  other: 'mixed',
};

const STATUSES = ['open', 'picked_up', 'returned', 'closed'];

const OFFHIRE_METHODS = ['email', 'phone', 'portal', 'in_person'];
const OFFHIRE_METHOD_LABELS = { email: 'Email', phone: 'Phone', portal: 'Portal', in_person: 'In person' };

// Standard photo shots most equipment needs, reused across many types.
const GENERIC_PHOTOS = [
  { key: 'front', label: 'Front' },
  { key: 'rear', label: 'Rear' },
  { key: 'left_side', label: 'Left side' },
  { key: 'right_side', label: 'Right side' },
  { key: 'serial_plate', label: 'Serial / data plate' },
];

const EQUIPMENT_TYPES = [
  {
    value: 'trailer',
    label: 'Trailer (general)',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'coupling', label: 'Coupling + safety chains' },
      { key: 'chassis_under', label: 'Chassis / underside' },
      { key: 'tyres', label: 'Tyres + wheels' },
      { key: 'wiring', label: 'Wiring / harness' },
      { key: 'load_area', label: 'Load area' },
      { key: 'reg_plate', label: 'Rego plate' },
    ],
    accessoryPresets: ['Jockey wheel', 'Safety chains', 'Spare tyre', 'Wheel nut key', 'Trailer plug adapter'],
  },
  {
    value: 'traffic_lights_trailer',
    label: 'Traffic-lights trailer',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'coupling', label: 'Coupling + safety chains' },
      { key: 'light_head', label: 'Signal heads (both)' },
      { key: 'controller', label: 'Controller box' },
      { key: 'solar_battery', label: 'Solar panel / battery' },
      { key: 'tyres', label: 'Tyres + wheels' },
      { key: 'reg_plate', label: 'Rego plate' },
    ],
    accessoryPresets: ['Remote controller', 'Manual', 'Charging lead', 'Battery isolator key', 'Safety cones', 'Jockey wheel'],
  },
  {
    value: 'portaboom',
    label: 'Portaboom',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'boom_arm', label: 'Boom arm' },
      { key: 'signal_heads', label: 'Signal heads' },
      { key: 'controller', label: 'Controller box' },
      { key: 'solar_battery', label: 'Solar panel / battery' },
      { key: 'coupling', label: 'Coupling + safety chains' },
      { key: 'tyres', label: 'Tyres + wheels' },
    ],
    accessoryPresets: ['Remote controller', 'Manual', 'Charging lead', 'Battery isolator key', 'Safety cones'],
  },
  {
    value: 'vms_board',
    label: 'VMS board',
    photoChecklist: [
      { key: 'front_display', label: 'Front display' },
      { key: 'rear', label: 'Rear' },
      { key: 'solar_panels', label: 'Solar panels' },
      { key: 'controller', label: 'Controller box' },
      { key: 'battery_box', label: 'Battery box' },
      { key: 'cables', label: 'Cables / connections' },
      { key: 'serial_plate', label: 'Serial plate' },
      { key: 'coupling', label: 'Coupling (if trailer-mounted)' },
    ],
    accessoryPresets: ['Remote / programmer', 'Manual', 'Tilt pole', 'Battery isolator key'],
  },
  {
    value: 'arrow_board',
    label: 'Arrow board',
    photoChecklist: [
      { key: 'front_display', label: 'Front display' },
      { key: 'rear', label: 'Rear' },
      { key: 'solar_panels', label: 'Solar panels' },
      { key: 'controller', label: 'Controller' },
      { key: 'battery_box', label: 'Battery box' },
      { key: 'coupling', label: 'Coupling (if trailer-mounted)' },
      { key: 'serial_plate', label: 'Serial plate' },
    ],
    accessoryPresets: ['Remote', 'Manual', 'Charging lead'],
  },
  {
    value: 'generator',
    label: 'Generator',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'control_panel', label: 'Control panel' },
      { key: 'fuel_gauge', label: 'Fuel gauge' },
      { key: 'hour_meter', label: 'Hour meter' },
      { key: 'outlets', label: 'Outlets / connections' },
      { key: 'intake_exhaust', label: 'Intake + exhaust' },
    ],
    accessoryPresets: ['Fuel cap key', 'Manual', 'Earth stake', 'Output leads', 'Grease gun'],
  },
  {
    value: 'light_tower',
    label: 'Light tower',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'mast_up', label: 'Mast raised' },
      { key: 'mast_down', label: 'Mast stowed' },
      { key: 'lamps', label: 'Lamps / LED heads' },
      { key: 'generator', label: 'Generator compartment' },
      { key: 'outriggers', label: 'Outriggers / feet' },
      { key: 'hour_meter', label: 'Hour meter' },
    ],
    accessoryPresets: ['Manual', 'Crank handle', 'Outrigger pins', 'Fuel cap key'],
  },
  {
    value: 'variable_sign',
    label: 'Variable message sign',
    photoChecklist: [
      { key: 'front_display', label: 'Front display' },
      { key: 'rear', label: 'Rear' },
      { key: 'solar_panels', label: 'Solar panels' },
      { key: 'controller', label: 'Controller' },
      { key: 'serial_plate', label: 'Serial plate' },
      { key: 'coupling', label: 'Coupling' },
    ],
    accessoryPresets: ['Remote', 'Manual'],
  },
  {
    value: 'mobile_crash_cushion',
    label: 'Truck-mounted attenuator (TMA / MCC)',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'impact_face', label: 'Impact face' },
      { key: 'arrow_board', label: 'Arrow board (if fitted)' },
      { key: 'truck_coupling', label: 'Truck coupling' },
      { key: 'controls', label: 'In-cab controls' },
      { key: 'cert_plate', label: 'Certification plate' },
    ],
    accessoryPresets: ['Manual', 'Cert certificate', 'Remote / controller'],
  },
  {
    value: 'excavator',
    label: 'Excavator',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'bucket', label: 'Bucket + teeth' },
      { key: 'tracks', label: 'Tracks / undercarriage' },
      { key: 'cabin', label: 'Cabin interior' },
      { key: 'hour_meter', label: 'Hour meter' },
      { key: 'engine_bay', label: 'Engine bay' },
      { key: 'hoses', label: 'Hydraulic hoses' },
    ],
    accessoryPresets: ['Keys', 'Manual', 'Grease gun', 'Tool box', 'Safety lanyard'],
  },
  {
    value: 'skid_steer',
    label: 'Skid-steer / loader',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'bucket_attachment', label: 'Bucket / attachment' },
      { key: 'tyres', label: 'Tyres / tracks' },
      { key: 'cabin', label: 'Cabin interior' },
      { key: 'hour_meter', label: 'Hour meter' },
      { key: 'engine_bay', label: 'Engine bay' },
    ],
    accessoryPresets: ['Keys', 'Manual', 'Tool box'],
  },
  {
    value: 'water_cart',
    label: 'Water cart',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'tank', label: 'Water tank' },
      { key: 'sprayers', label: 'Sprayers / rear bar' },
      { key: 'pump', label: 'Pump' },
      { key: 'hoses', label: 'Hoses + fittings' },
      { key: 'hour_meter', label: 'Hour meter' },
    ],
    accessoryPresets: ['Keys', 'Manual', 'Fill hose', 'Camlock fittings', 'Cones'],
  },
  {
    value: 'telehandler',
    label: 'Telehandler',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'forks_attachment', label: 'Forks / attachment' },
      { key: 'boom', label: 'Boom (fully extended)' },
      { key: 'tyres', label: 'Tyres' },
      { key: 'cabin', label: 'Cabin interior' },
      { key: 'hour_meter', label: 'Hour meter' },
    ],
    accessoryPresets: ['Keys', 'Manual', 'Load chart', 'Sling / shackles'],
  },
  {
    value: 'scissor_lift',
    label: 'Scissor lift',
    photoChecklist: [
      ...GENERIC_PHOTOS,
      { key: 'platform', label: 'Platform deck' },
      { key: 'scissor_mechanism', label: 'Scissor mechanism' },
      { key: 'controls_upper', label: 'Upper controls' },
      { key: 'controls_lower', label: 'Lower controls' },
      { key: 'hour_meter', label: 'Hour meter' },
    ],
    accessoryPresets: ['Keys', 'Manual', 'Harness anchor points'],
  },
  {
    value: 'other',
    label: 'Other (specify in notes)',
    photoChecklist: [...GENERIC_PHOTOS],
    accessoryPresets: [],
  },
];

// Docket-level attachments — six categories fixed by the PDF spec.
// `expectedByDefault` drives the "MISSING" badge on a fresh docket.
const ATTACHMENT_CATEGORIES = [
  { key: 'hire_agreement', label: 'Signed hire agreement', expectedByDefault: true },
  { key: 'pickup_docket', label: 'Pick-up docket', expectedByDefault: true },
  { key: 'return_docket', label: 'Return docket', expectedByDefault: true },
  { key: 'condition_report', label: 'Supplier condition report', expectedByDefault: false },
  { key: 'damage_incident', label: 'Damage / incident report', expectedByDefault: false },
  { key: 'other', label: 'Other documents', expectedByDefault: false },
];
const ATTACHMENT_CATEGORY_KEYS = ATTACHMENT_CATEGORIES.map(c => c.key);

// Signature slots (canvas targets). Each maps 1:1 to a *_signature_path column.
const DOCKET_SIGNATURE_SLOTS = new Set([
  'pickup',                // our rep
  'pickup_supplier_rep',
  'dropoff',               // our rep
  'dropoff_supplier_rep',
]);
const ITEM_SIGNATURE_SLOTS = new Set(['pickup', 'dropoff']); // per-item sign-off

function getEquipmentType(value) {
  return EQUIPMENT_TYPES.find(t => t.value === value) || null;
}

// Resolve the power-kind config (label + per-level labels) for a given type.
// Unknown or empty type falls back to the mixed/fuel default.
function getPowerKind(typeValue) {
  const kind = TYPE_POWER_KIND[typeValue] || 'mixed';
  return POWER_KINDS[kind] || POWER_KINDS.mixed;
}

module.exports = {
  EQUIPMENT_TYPES,
  ATTACHMENT_CATEGORIES,
  ATTACHMENT_CATEGORY_KEYS,
  DOCKET_SIGNATURE_SLOTS,
  ITEM_SIGNATURE_SLOTS,
  FUEL_LEVELS,
  FUEL_LABELS,
  BATTERY_LABELS,
  POWER_KINDS,
  TYPE_POWER_KIND,
  STATUSES,
  OFFHIRE_METHODS,
  OFFHIRE_METHOD_LABELS,
  getEquipmentType,
  getPowerKind,
};
