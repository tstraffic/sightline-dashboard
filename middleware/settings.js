/**
 * Settings Registry
 * Loads app_settings and system_config from DB into in-memory cache.
 * Provides helpers for routes/views and Express middleware.
 */
const { getDb } = require('../db/database');

// In-memory caches
let _optionsCache = null;   // { category: [{key, label, color, icon, isActive}] }
let _configCache = null;    // { key: value }
let _cacheTime = 0;

const CACHE_TTL = 60_000; // 1 minute TTL (or manual invalidation)

/**
 * Category metadata — human-readable names and grouping
 */
const CATEGORY_META = {
  job_status:         { label: 'Job Statuses',        group: 'Jobs',      icon: 'briefcase' },
  job_stage:          { label: 'Job Stages',           group: 'Jobs',      icon: 'layers' },
  job_health:         { label: 'Job Health',           group: 'Jobs',      icon: 'heart' },
  accounts_status:    { label: 'Accounts Status',      group: 'Jobs',      icon: 'dollar' },
  tcp_level:          { label: 'TC Levels',            group: 'Jobs',      icon: 'shield' },
  crew_role:          { label: 'Crew Roles',           group: 'Workforce', icon: 'users' },
  employment_type:    { label: 'Employment Types',     group: 'Workforce', icon: 'id-card' },
  shift_type:         { label: 'Shift Types',          group: 'Workforce', icon: 'clock' },
  allocation_status:  { label: 'Allocation Status',    group: 'Workforce', icon: 'calendar' },
  incident_type:      { label: 'Incident Types',       group: 'Safety',    icon: 'alert' },
  incident_severity:  { label: 'Incident Severity',    group: 'Safety',    icon: 'zap' },
  defect_severity:    { label: 'Defect Severity',      group: 'Safety',    icon: 'alert-circle' },
  defect_status:      { label: 'Defect Status',        group: 'Safety',    icon: 'tool' },
  compliance_status:  { label: 'Compliance Status',    group: 'Safety',    icon: 'shield' },
  task_status:        { label: 'Task Status',          group: 'Planning',  icon: 'check-square' },
  task_priority:      { label: 'Task Priority',        group: 'Planning',  icon: 'flag' },
  task_type:          { label: 'Task Types',           group: 'Planning',  icon: 'repeat' },
  plan_type:          { label: 'Traffic Plan Types',   group: 'Planning',  icon: 'map' },
  plan_status:        { label: 'Traffic Plan Status',  group: 'Planning',  icon: 'clipboard' },
  equipment_category: { label: 'Equipment Categories', group: 'Assets',    icon: 'truck' },
  state:              { label: 'Australian States',    group: 'General',   icon: 'globe' },
  // CRM categories
  opportunity_stages: { label: 'Opportunity Stages',   group: 'CRM',       icon: 'layers' },
  activity_types:     { label: 'Activity Types',       group: 'CRM',       icon: 'calendar' },
  lead_sources:       { label: 'Lead Sources',         group: 'CRM',       icon: 'target' },
  loss_reasons:       { label: 'Loss Reasons',         group: 'CRM',       icon: 'x-circle' },
  service_categories: { label: 'Service Categories',   group: 'CRM',       icon: 'briefcase' },
  priority_levels:    { label: 'Priority Levels',      group: 'CRM',       icon: 'flag' },
  industry_segments:  { label: 'Client Sectors',       group: 'CRM',       icon: 'globe' },
  client_categories:  { label: 'Client Categories',    group: 'CRM',       icon: 'users' },
  contact_types:      { label: 'Contact Types',        group: 'CRM',       icon: 'user' },
  won_reasons:        { label: 'Won Reasons',          group: 'CRM',       icon: 'check-circle' },
  service_streams:    { label: 'Service Streams',      group: 'CRM',       icon: 'layers' },
  repeat_client_status: { label: 'Repeat Client Status', group: 'CRM',     icon: 'refresh' },
  referral_channels:  { label: 'Referral Channels',    group: 'CRM',       icon: 'share' },
  approval_types:     { label: 'Approval Types',       group: 'Planning',  icon: 'shield' },
  contact_statuses:   { label: 'Contact Statuses',     group: 'CRM',       icon: 'user' },
  // HR categories
  hr_employment_types:    { label: 'Employment Types',    group: 'HR',  icon: 'briefcase' },
  hr_employment_statuses: { label: 'Employment Statuses', group: 'HR',  icon: 'activity' },
  hr_divisions:           { label: 'Divisions',           group: 'HR',  icon: 'grid' },
  hr_document_types:      { label: 'Document Types',      group: 'HR',  icon: 'file-text' },
  hr_competency_types:    { label: 'Competency Types',    group: 'HR',  icon: 'award' },
  hr_ppe_statuses:        { label: 'PPE Statuses',        group: 'HR',  icon: 'shield' },
  hr_block_reasons:       { label: 'Block Reasons',       group: 'HR',  icon: 'alert-circle' },
};

/**
 * Load all settings from database into cache
 */
function loadSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM app_settings ORDER BY category, display_order, label').all();

  const options = {};
  for (const row of rows) {
    if (!options[row.category]) options[row.category] = [];
    options[row.category].push({
      id: row.id,
      key: row.key,
      label: row.label,
      color: row.color,
      icon: row.icon,
      isActive: row.is_active === 1,
      displayOrder: row.display_order,
      metadata: row.metadata,
    });
  }
  _optionsCache = options;
  _cacheTime = Date.now();
  return options;
}

/**
 * Load all system config from database into cache
 */
function loadConfig() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM system_config').all();

  const config = {};
  for (const row of rows) {
    let value = row.config_value;
    if (row.config_type === 'number') value = parseFloat(value) || 0;
    else if (row.config_type === 'boolean') value = value === 'true' || value === '1';
    config[row.config_key] = value;
  }
  _configCache = config;
  return config;
}

/**
 * Get all options (active only by default) for a category
 */
function getOptions(category, includeInactive = false) {
  if (!_optionsCache || Date.now() - _cacheTime > CACHE_TTL) loadSettings();
  const items = _optionsCache[category] || [];
  return includeInactive ? items : items.filter(i => i.isActive);
}

/**
 * Get all options for all categories (active only)
 */
function getAllOptions() {
  if (!_optionsCache || Date.now() - _cacheTime > CACHE_TTL) loadSettings();
  const result = {};
  for (const [cat, items] of Object.entries(_optionsCache)) {
    result[cat] = items.filter(i => i.isActive);
  }
  return result;
}

/**
 * Get a single system config value
 */
function getConfig(key, defaultValue = '') {
  if (!_configCache) loadConfig();
  return _configCache[key] !== undefined ? _configCache[key] : defaultValue;
}

/**
 * Get all system config values
 */
function getAllConfig() {
  if (!_configCache) loadConfig();
  return { ..._configCache };
}

/**
 * Invalidate caches (call after any write)
 */
function reloadSettings() {
  loadSettings();
  loadConfig();
}

/**
 * Express middleware — attaches settings to res.locals for all views
 */
function settingsMiddleware(req, res, next) {
  res.locals.settingsOptions = getAllOptions();
  res.locals.systemConfig = getAllConfig();
  res.locals.categoryMeta = CATEGORY_META;
  next();
}

module.exports = {
  getOptions,
  getAllOptions,
  getConfig,
  getAllConfig,
  reloadSettings,
  settingsMiddleware,
  CATEGORY_META,
};
