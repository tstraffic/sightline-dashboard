const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { getConfig, reloadSettings } = require('../middleware/settings');
const {
  getIntegrationConfig,
  saveIntegrationConfig,
  getRecentSyncLogs,
  testTeamsWebhook,
} = require('../middleware/integrations');
const {
  syncTraffioJobs,
  syncTraffioCrew,
  syncTraffioBookings,
  syncTraffioDockets,
  syncTraffioBookingCrew,
  syncTimesheetsFromDockets,
  mirrorTraffioDocketsToBookings,
  syncTraffioForms,
  testTraffioConnection,
} = require('../middleware/traffio');
const {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  testQboConnection,
} = require('../middleware/quickbooks');
const crypto = require('crypto');

// GET /admin/integrations — Settings page
router.get('/', (req, res) => {
  const providers = ['traffio', 'quickbooks', 'employment_hero', 'teams', 'sharepoint'];
  const configs = {};
  for (const p of providers) {
    configs[p] = getIntegrationConfig(p);
  }
  const syncLogs = getRecentSyncLogs(25);

  // Google Maps API key — read from system_config so the value persists
  // across deploys. If an env var is set, it WINS over the DB and we
  // disable the input to prevent accidental drift between the two.
  const envOverride = !!(process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY);
  const googleMapsKey = envOverride
    ? (process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_GEOCODING_API_KEY)
    : getConfig('google_maps_api_key', '');

  // Geoapify API key — drives the booking address autocomplete picker.
  // Same env-wins-over-DB pattern as Google Maps above.
  const geoapifyEnvOverride = !!process.env.GEOAPIFY_API_KEY;
  const geoapifyKey = geoapifyEnvOverride
    ? process.env.GEOAPIFY_API_KEY
    : getConfig('geoapify_api_key', '');

  res.render('admin/integrations', {
    title: 'Integrations',
    currentPage: 'integrations',
    configs,
    syncLogs,
    googleMapsKey,
    googleMapsEnvOverride: envOverride,
    geoapifyKey,
    geoapifyEnvOverride,
  });
});

// GET /admin/integrations/quickbooks/connect — kick off the Intuit OAuth flow.
// Random state goes in the session and is checked on callback (CSRF guard).
router.get('/quickbooks/connect', (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.qboOauthState = state;
    res.redirect(buildAuthorizeUrl(state));
  } catch (err) {
    req.flash('error', `Could not start QuickBooks connect: ${err.message}`);
    res.redirect('/admin/integrations');
  }
});

// GET /admin/integrations/quickbooks/callback — Intuit redirects here with
// ?code=&realmId=&state=. Validate state, swap the code for tokens, link the
// company. (This exact URI is registered on the Intuit app — don't move it.)
router.get('/quickbooks/callback', async (req, res) => {
  const { code, realmId, state, error } = req.query;
  const expected = req.session.qboOauthState;
  delete req.session.qboOauthState;

  if (error) {
    req.flash('error', `QuickBooks authorisation declined: ${error}`);
    return res.redirect('/admin/integrations');
  }
  if (!state || state !== expected) {
    req.flash('error', 'QuickBooks connect failed: state mismatch — try again.');
    return res.redirect('/admin/integrations');
  }
  if (!code || !realmId) {
    req.flash('error', 'QuickBooks connect failed: missing code or company id.');
    return res.redirect('/admin/integrations');
  }

  try {
    await exchangeCodeForTokens(String(code), String(realmId));
    const info = await testQboConnection();
    logActivity({
      user: req.session.user, action: 'update', entityType: 'integration',
      entityLabel: 'quickbooks', details: `Connected QuickBooks company ${info.companyName || realmId}`,
      ip: req.ip,
    });
    req.flash('success', `Connected to QuickBooks${info.companyName ? ` — ${info.companyName}` : ''} (realm ${realmId}).`);
  } catch (err) {
    req.flash('error', `QuickBooks connect failed: ${err.message}`);
  }
  res.redirect('/admin/integrations');
});

// POST /admin/integrations/google-maps — Save Google Maps API key into
// system_config. The key drives both /bookings address geocoding and
// the worker site map. Empty value clears the row.
router.post('/google-maps', (req, res) => {
  const db = getDb();
  const raw = (req.body.api_key || '').trim();

  db.prepare(`
    INSERT INTO system_config (config_key, config_value, config_type, description, updated_at, updated_by_id)
    VALUES ('google_maps_api_key', ?, 'string', 'Google Maps API key for Geocoding + Maps JS', CURRENT_TIMESTAMP, ?)
    ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP, updated_by_id = excluded.updated_by_id
  `).run(raw, req.session.user.id);

  reloadSettings();

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'integration',
    entityLabel: 'google_maps',
    details: raw ? 'Google Maps API key updated' : 'Google Maps API key cleared',
    ip: req.ip,
  });
  req.flash('success', raw ? 'Google Maps key saved.' : 'Google Maps key cleared.');
  res.redirect('/admin/integrations');
});

// POST /admin/integrations/geoapify — Save the Geoapify autocomplete key.
// Mirrors the Google Maps handler exactly: upsert into system_config,
// reload the in-process cache, log it. Empty value clears the row.
router.post('/geoapify', (req, res) => {
  const db = getDb();
  const raw = (req.body.api_key || '').trim();

  db.prepare(`
    INSERT INTO system_config (config_key, config_value, config_type, description, updated_at, updated_by_id)
    VALUES ('geoapify_api_key', ?, 'string', 'Geoapify autocomplete key for booking address picker', CURRENT_TIMESTAMP, ?)
    ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP, updated_by_id = excluded.updated_by_id
  `).run(raw, req.session.user.id);

  reloadSettings();

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'integration',
    entityLabel: 'geoapify',
    details: raw ? 'Geoapify API key updated' : 'Geoapify API key cleared',
    ip: req.ip,
  });
  req.flash('success', raw ? 'Geoapify key saved.' : 'Geoapify key cleared.');
  res.redirect('/admin/integrations');
});

// POST /admin/integrations/:provider — Save config
router.post('/:provider', (req, res) => {
  const { provider } = req.params;
  const validProviders = ['traffio', 'quickbooks', 'employment_hero', 'teams', 'sharepoint'];
  if (!validProviders.includes(provider)) {
    req.flash('error', 'Invalid provider');
    return res.redirect('/admin/integrations');
  }

  // Checkbox fields are paired with a hidden `value="0"` input so a value is
  // always sent. When the box is ticked the browser submits BOTH, which
  // express (extended) parses into an array like ['0','1'] — so a plain
  // `=== '1'` check never matched and the toggle never saved. Treat the
  // field as on if any submitted value is truthy.
  const checkboxOn = (v) => {
    const vals = Array.isArray(v) ? v : [v];
    return vals.some((x) => x === '1' || x === 'on' || x === 'true');
  };

  const enabled = checkboxOn(req.body.enabled);
  const configObj = {};

  // Provider-specific config fields
  switch (provider) {
    case 'traffio':
      configObj.api_url = (req.body.api_url || '').trim();
      configObj.api_key = (req.body.api_key || '').trim();
      configObj.auto_sync = checkboxOn(req.body.auto_sync);
      break;
    case 'quickbooks':
      configObj.client_id = (req.body.client_id || '').trim();
      configObj.client_secret = (req.body.client_secret || '').trim();
      configObj.environment = req.body.environment === 'production' ? 'production' : 'sandbox';
      // realm_id + tokens are set by the OAuth callback, not this form —
      // saveIntegrationConfig merges, so they survive a settings save.
      break;
    case 'employment_hero':
      configObj.api_url = (req.body.api_url || '').trim();
      configObj.api_key = (req.body.api_key || '').trim();
      configObj.org_id = (req.body.org_id || '').trim();
      break;
    case 'teams':
      configObj.webhook_url = (req.body.webhook_url || '').trim();
      break;
    case 'sharepoint':
      configObj.site_url = (req.body.site_url || '').trim();
      break;
  }

  saveIntegrationConfig(provider, configObj, enabled);

  logActivity({
    user: req.session.user,
    action: 'update',
    entityType: 'integration',
    entityLabel: provider,
    details: `Updated ${provider} integration settings (enabled: ${enabled})`,
    ip: req.ip,
  });

  req.flash('success', `${provider.replace('_', ' ')} settings saved`);
  res.redirect('/admin/integrations');
});

// POST /admin/integrations/:provider/test — Test connection
router.post('/:provider/test', async (req, res) => {
  const { provider } = req.params;

  try {
    switch (provider) {
      case 'traffio': {
        const result = await testTraffioConnection();
        req.flash('success', `Traffio connection successful (status: ${result.status})`);
        break;
      }
      case 'teams': {
        const webhookUrl = req.body.webhook_url || getIntegrationConfig('teams').config.webhook_url;
        if (!webhookUrl) {
          req.flash('error', 'No Teams webhook URL configured');
          return res.redirect('/admin/integrations');
        }
        await testTeamsWebhook(webhookUrl);
        req.flash('success', 'Test message sent to Teams channel successfully');
        break;
      }
      case 'quickbooks': {
        const info = await testQboConnection();
        req.flash('success', `QuickBooks connection successful — ${info.companyName || 'company'} (${info.country || '?'})`);
        break;
      }
      case 'employment_hero':
        req.flash('error', 'Employment Hero integration is not yet active — coming soon');
        break;
      default:
        req.flash('error', 'Test not available for this provider');
    }
  } catch (err) {
    req.flash('error', `Connection test failed: ${err.message}`);
  }

  res.redirect('/admin/integrations');
});

// POST /admin/integrations/:provider/sync — Manual sync trigger
router.post('/:provider/sync', async (req, res) => {
  const { provider } = req.params;

  try {
    if (provider !== 'traffio') {
      req.flash('error', `Sync is only available for Traffio at this time`);
      return res.redirect('/admin/integrations');
    }

    const syncType = req.body.sync_type || 'all';
    const results = [];

    if (syncType === 'all' || syncType === 'jobs') {
      const jobStats = await syncTraffioJobs('manual');
      results.push(`Jobs: ${jobStats.created} created, ${jobStats.updated} updated, ${jobStats.failed} failed`);
    }
    if (syncType === 'all' || syncType === 'crew') {
      const crewStats = await syncTraffioCrew('manual');
      results.push(`Crew: ${crewStats.created} created, ${crewStats.updated} updated, ${crewStats.failed} failed`);
    }
    if (syncType === 'all' || syncType === 'bookings') {
      const fromDate = req.body.from_date || '';
      const toDate = req.body.to_date || '';
      const bookingStats = await syncTraffioBookings('manual', fromDate, toDate);
      results.push(`Bookings: ${bookingStats.created} created, ${bookingStats.updated} updated, ${bookingStats.queued} queued for review, ${bookingStats.failed} failed`);
    }
    if (syncType === 'all' || syncType === 'dockets') {
      const fromDate = req.body.from_date || '';
      const toDate = req.body.to_date || '';
      const docketStats = await syncTraffioDockets('manual', fromDate, toDate);
      results.push(`Dockets: ${docketStats.created} dockets, ${docketStats.updated} person-lines, ${docketStats.failed} failed`);
      const mirrorStats = mirrorTraffioDocketsToBookings('manual');
      results.push(`Booking dockets: ${mirrorStats.created} created, ${mirrorStats.updated} updated, ${mirrorStats.skipped} skipped (no local booking)`);
    }
    if (syncType === 'all' || syncType === 'booking_crew') {
      const s = await syncTraffioBookingCrew('manual', req.body.from_date || '', req.body.to_date || '');
      results.push(`Crew allocations: ${s.created} created, ${s.updated} updated, ${s.skipped} skipped (no local job/crew), ${s.failed} failed`);
    }
    if (syncType === 'all' || syncType === 'timesheets') {
      const s = syncTimesheetsFromDockets('manual');
      results.push(`Timesheets: ${s.created} created, ${s.updated} updated, ${s.skipped} skipped, ${s.failed} failed`);
    }
    if (syncType === 'all' || syncType === 'forms') {
      const s = await syncTraffioForms('manual', req.body.from_date || '', req.body.to_date || '');
      results.push(`Forms: ${s.created} created, ${s.updated} updated, ${s.skipped} skipped, ${s.failed} failed`);
    }

    logActivity({
      user: req.session.user,
      action: 'create',
      entityType: 'sync',
      entityLabel: `traffio-${syncType}`,
      details: results.join('; '),
      ip: req.ip,
    });

    req.flash('success', `Traffio sync complete — ${results.join(' | ')}`);
  } catch (err) {
    req.flash('error', `Sync failed: ${err.message}`);
  }

  res.redirect('/admin/integrations');
});

module.exports = router;
