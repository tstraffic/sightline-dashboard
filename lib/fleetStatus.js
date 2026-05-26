// Compliance status helper for the fleet module.
//
// Status is derived against the current date — never stored. Each due-date
// field on `vehicles` is classified into one of four buckets so the views
// can render colour-coded badges with consistent wording.
//
// `kind` controls the label used for past dates:
//   'expiry'  → "Expired" (registration / CTP / fire extinguisher)
//   'due'     → "Overdue" (inspection / next service)

const ONE_DAY = 24 * 60 * 60 * 1000;

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

// Returns { label, tone, daysUntil } where tone ∈ {ok, warn, bad, muted}.
function statusFor(dateStr, today = todayISO(), kind = 'expiry') {
  if (!dateStr) return { label: 'No data', tone: 'muted', daysUntil: null };
  const days = Math.ceil((new Date(dateStr) - new Date(today)) / ONE_DAY);
  if (days < 0)  return { label: kind === 'due' ? 'Overdue' : 'Expired', tone: 'bad',  daysUntil: days };
  if (days <= 30) return { label: 'Due soon', tone: 'warn', daysUntil: days };
  return { label: 'OK', tone: 'ok', daysUntil: days };
}

// Convenience: build the four standard badges for a vehicle row.
function badgesFor(vehicle, today = todayISO()) {
  return {
    registration:  statusFor(vehicle.registration_expiry,      today, 'expiry'),
    inspection:    statusFor(vehicle.inspection_due,           today, 'due'),
    service:       statusFor(vehicle.next_service_date,        today, 'due'),
    fireExt:       statusFor(vehicle.fire_extinguisher_expiry, today, 'expiry'),
    ctp:           statusFor(vehicle.ctp_expiry,               today, 'expiry'),
    insurance:     statusFor(vehicle.insurance_renewal,        today, 'expiry'),
  };
}

// Returns true if any of the four headline items needs action.
function needsAction(vehicle, today = todayISO()) {
  const b = badgesFor(vehicle, today);
  return ['registration','inspection','service','fireExt']
    .some(k => b[k].tone === 'bad' || b[k].tone === 'warn');
}

// Tailwind class set keyed by tone — used by EJS partials.
const TONE_CLASSES = {
  ok:    'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20',
  warn:  'bg-amber-50 text-amber-700 ring-1 ring-amber-600/20',
  bad:   'bg-red-50 text-red-700 ring-1 ring-red-600/20',
  muted: 'bg-gray-50 text-gray-400 ring-1 ring-gray-200',
};

module.exports = { statusFor, badgesFor, needsAction, TONE_CLASSES, todayISO };
