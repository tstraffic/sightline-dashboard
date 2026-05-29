const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { logActivity } = require('../../middleware/audit');

// Singleton row id — enforced by CHECK (id = 1) on the table.
const SETTINGS_ID = 1;

function loadSettings(db) {
  const row = db.prepare('SELECT * FROM quoting_settings WHERE id = ?').get(SETTINGS_ID);
  if (!row) {
    // Defensive: migration 238 inserts this on apply, but if it's missing
    // (manual delete, partial restore) re-create with defaults so the page
    // still renders rather than throwing.
    db.prepare(`
      INSERT INTO quoting_settings (id, gst_rate, margin_healthy_threshold, margin_watch_threshold,
        quote_number_format, default_validity_days)
      VALUES (?, 0.10, 25.0, 15.0, 'TS-QTE-{YYYY}-{NNN}', 30)
    `).run(SETTINGS_ID);
    return db.prepare('SELECT * FROM quoting_settings WHERE id = ?').get(SETTINGS_ID);
  }
  return row;
}

// Coerce the inclusions/exclusions textarea (one item per line) into a clean
// JSON-encoded array. Empty lines and whitespace are trimmed out.
function linesToJsonArray(input) {
  if (typeof input !== 'string') return '[]';
  const items = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return JSON.stringify(items);
}

function toNumberOr(value, fallback) {
  if (value === '' || value === undefined || value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

router.get('/', (req, res) => {
  const db = getDb();
  const settings = loadSettings(db);

  // Pretty-print arrays back as line-per-item textareas
  const inclusionsText = JSON.parse(settings.company_inclusions_defaults_json || '[]').join('\n');
  const exclusionsText = JSON.parse(settings.company_exclusions_defaults_json || '[]').join('\n');

  res.render('quoting/settings', {
    title: 'Quoting Settings',
    currentPage: 'quoting',
    settings,
    inclusionsText,
    exclusionsText,
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const before = loadSettings(db);
  const b = req.body;

  const update = {
    default_tc_cost_rate:         toNumberOr(b.default_tc_cost_rate, null),
    default_tl_cost_rate:         toNumberOr(b.default_tl_cost_rate, null),
    default_supervisor_cost_rate: toNumberOr(b.default_supervisor_cost_rate, null),
    gst_rate:                     toNumberOr(b.gst_rate, before.gst_rate),
    margin_healthy_threshold:     toNumberOr(b.margin_healthy_threshold, before.margin_healthy_threshold),
    margin_watch_threshold:       toNumberOr(b.margin_watch_threshold, before.margin_watch_threshold),
    quote_number_format:          (b.quote_number_format || '').trim() || before.quote_number_format,
    default_validity_days:        Math.max(1, parseInt(b.default_validity_days, 10) || before.default_validity_days),
    default_within_50km:          b.default_within_50km === 'on' || b.default_within_50km === '1' ? 1 : 0,
    tma_non_ts_vehicle_surcharge_pct: toNumberOr(b.tma_non_ts_vehicle_surcharge_pct, before.tma_non_ts_vehicle_surcharge_pct),
    company_inclusions_defaults_json: linesToJsonArray(b.inclusions_text),
    company_exclusions_defaults_json: linesToJsonArray(b.exclusions_text),
    company_terms_default:        b.terms_default || '',
  };

  // Validation: healthy must be > watch, both > 0
  if (update.margin_healthy_threshold <= update.margin_watch_threshold) {
    req.flash('error', 'Healthy margin threshold must be greater than the watch threshold.');
    return res.redirect('/rate-cards/settings');
  }

  db.prepare(`
    UPDATE quoting_settings SET
      default_tc_cost_rate = ?,
      default_tl_cost_rate = ?,
      default_supervisor_cost_rate = ?,
      gst_rate = ?,
      margin_healthy_threshold = ?,
      margin_watch_threshold = ?,
      quote_number_format = ?,
      default_validity_days = ?,
      default_within_50km = ?,
      tma_non_ts_vehicle_surcharge_pct = ?,
      company_inclusions_defaults_json = ?,
      company_exclusions_defaults_json = ?,
      company_terms_default = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    update.default_tc_cost_rate, update.default_tl_cost_rate, update.default_supervisor_cost_rate,
    update.gst_rate, update.margin_healthy_threshold, update.margin_watch_threshold,
    update.quote_number_format, update.default_validity_days,
    update.default_within_50km, update.tma_non_ts_vehicle_surcharge_pct,
    update.company_inclusions_defaults_json, update.company_exclusions_defaults_json,
    update.company_terms_default,
    SETTINGS_ID
  );

  // Diff for audit log — only the fields that changed
  const changes = [];
  for (const k of Object.keys(update)) {
    if (String(before[k] ?? '') !== String(update[k] ?? '')) {
      changes.push(k);
    }
  }
  if (changes.length > 0) {
    logActivity({
      user: req.session.user,
      action: 'update',
      entityType: 'quoting_settings',
      entityId: SETTINGS_ID,
      entityLabel: 'Quoting Settings',
      details: `Updated: ${changes.join(', ')}`,
      ip: req.ip,
    });
  }

  req.flash('success', changes.length > 0 ? `Updated ${changes.length} setting(s).` : 'No changes made.');
  res.redirect('/rate-cards/settings');
});

module.exports = router;
