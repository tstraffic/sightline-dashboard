// Per-user notification preferences.
//
// Each user chooses, per category, whether a notification is shown in-app
// (and pushed) and whether it is emailed. Preferences live as JSON in
// users.notification_prefs, keyed by category:
//   { "<catKey>": { "inApp": bool, "email": bool }, ... }
// A missing category (or channel) falls back to the category default below.
//
// A raw notification `type` (e.g. 'overdue_task') maps to a category via
// TYPE_TO_CATEGORY. Unknown types land in 'other': shown in-app, and emailed
// only when the user's master email switch (email_notifications_enabled) is on.

const CATEGORIES = [
  { key: 'task_assigned',      label: 'Task assigned to me',      desc: 'When someone assigns you a task or subtask',                       types: ['task_assigned'],                                                                                                                inApp: true, email: false },
  { key: 'task_deadline',      label: 'Task due & overdue',       desc: 'Reminders as your tasks approach or pass their due date',          types: ['deadline_reminder', 'overdue_task'],                                                                                            inApp: true, email: true },
  { key: 'plans',              label: 'Plans & approvals',        desc: 'Council permits, ROL, CTMP and other job plans coming due or pending review', types: ['expiring_compliance', 'rol_pending'],                                                                             inApp: true, email: true },
  { key: 'safety_docs',        label: 'Safety documents & tickets', desc: 'SWMS, SOPs, risk assessments & ticket expiry',                  types: ['swms_expiring', 'sop_expiring', 'risk_assessment_expiring', 'ticket_expiry', 'cert_expiry'],                                    inApp: true, email: true },
  { key: 'inductions',         label: 'Upcoming inductions',      desc: 'Booked inductions coming up (7, 3 and 1 days out, and on the day) plus overdue ones', types: ['induction_reminder', 'induction_overdue'],                                                        inApp: true, email: false },
  { key: 'corrective_actions', label: 'Corrective actions',       desc: 'Incident and audit corrective actions coming due',                 types: ['corrective_action_due', 'follow_up_due'],                                                                                       inApp: true, email: true },
  { key: 'equipment',          label: 'Equipment',                desc: 'Vehicle & equipment inspections due or overdue',                   types: ['equipment_inspection_due', 'equipment_overdue'],                                                                                inApp: true, email: false },
  { key: 'budget',             label: 'Budget alerts',            desc: 'Jobs tracking over budget',                                        types: ['over_budget'],                                                                                                                  inApp: true, email: true },
  { key: 'projects',           label: 'Project updates',          desc: 'Jobs with no site update for a while',                             types: ['missing_update'],                                                                                                               inApp: true, email: false },
  { key: 'team',               label: 'Team & birthdays',         desc: 'Birthdays and crew reminders',                                     types: ['birthday_today', 'repeat_offender'],                                                                                            inApp: true, email: false },
  { key: 'crm',                label: 'CRM follow-ups & pipeline', desc: 'Client/opportunity follow-ups due, stale opportunities, proposals awaiting response, won-but-unconverted alerts', types: ['crm_follow_up_due', 'opportunity_stale', 'proposal_follow_up_due', 'won_unconverted'], inApp: true, email: true },
  { key: 'delivery',           label: 'Delivery due dates & QA',  desc: 'Deliverables due, QA waiting on you, authority approvals due or expiring, client inputs overdue, correspondence due', types: ['deliverable_due', 'qa_pending', 'approval_due', 'approval_expiring', 'client_input_overdue', 'correspondence_due'], inApp: true, email: true },
  { key: 'invoicing',          label: 'Invoicing & variations',   desc: 'Work ready to invoice and variations awaiting a decision', types: ['invoice_ready', 'variation_pending'], inApp: true, email: true },
];

const TYPE_TO_CATEGORY = {};
CATEGORIES.forEach(function (c) { c.types.forEach(function (t) { TYPE_TO_CATEGORY[t] = c.key; }); });

const DEFAULTS = {};
CATEGORIES.forEach(function (c) { DEFAULTS[c.key] = { inApp: c.inApp, email: c.email }; });

function categoryOf(type) { return TYPE_TO_CATEGORY[type] || 'other'; }

function parsePrefs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { var o = JSON.parse(raw); return (o && typeof o === 'object') ? o : {}; }
  catch (e) { return {}; }
}

function resolve(prefs, catKey, channel) {
  prefs = parsePrefs(prefs);
  var stored = prefs[catKey];
  if (stored && typeof stored[channel] === 'boolean') return stored[channel];
  if (DEFAULTS[catKey]) return DEFAULTS[catKey][channel];
  return true; // 'other' / unknown — in-app on; email deferred to master switch
}

function wantsInApp(prefs, type) { return resolve(prefs, categoryOf(type), 'inApp'); }
function wantsEmail(prefs, type) { return resolve(prefs, categoryOf(type), 'email'); }

function getUserPrefs(db, userId) {
  try {
    var row = db.prepare('SELECT notification_prefs FROM users WHERE id = ?').get(userId);
    return parsePrefs(row && row.notification_prefs);
  } catch (e) { return {}; }
}

// Build a prefs object from posted form fields pref_<cat>_inapp / pref_<cat>_email.
function prefsFromForm(body) {
  var out = {};
  CATEGORIES.forEach(function (c) {
    out[c.key] = {
      inApp: body['pref_' + c.key + '_inapp'] === 'on',
      email: body['pref_' + c.key + '_email'] === 'on',
    };
  });
  return out;
}

// Category rows with the user's effective (stored-or-default) values, for the
// settings grid.
function effective(prefs) {
  prefs = parsePrefs(prefs);
  return CATEGORIES.map(function (c) {
    var s = prefs[c.key] || {};
    return {
      key: c.key, label: c.label, desc: c.desc,
      inApp: typeof s.inApp === 'boolean' ? s.inApp : c.inApp,
      email: typeof s.email === 'boolean' ? s.email : c.email,
    };
  });
}

module.exports = {
  CATEGORIES, categoryOf, parsePrefs, wantsInApp, wantsEmail,
  getUserPrefs, prefsFromForm, effective,
};
