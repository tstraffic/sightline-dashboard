const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
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
  testTraffioConnection,
} = require('../middleware/traffio');

// GET /admin/integrations — Settings page
router.get('/', (req, res) => {
  const providers = ['traffio', 'quickbooks', 'employment_hero', 'teams', 'sharepoint'];
  const configs = {};
  for (const p of providers) {
    configs[p] = getIntegrationConfig(p);
  }
  const syncLogs = getRecentSyncLogs(25);

  res.render('admin/integrations', {
    title: 'Integrations',
    currentPage: 'integrations',
    configs,
    syncLogs,
  });
});

// POST /admin/integrations/:provider — Save config
router.post('/:provider', (req, res) => {
  const { provider } = req.params;
  const validProviders = ['traffio', 'quickbooks', 'employment_hero', 'teams', 'sharepoint'];
  if (!validProviders.includes(provider)) {
    req.flash('error', 'Invalid provider');
    return res.redirect('/admin/integrations');
  }

  const enabled = req.body.enabled === '1' || req.body.enabled === 'on';
  const configObj = {};

  // Provider-specific config fields
  switch (provider) {
    case 'traffio':
      configObj.api_url = (req.body.api_url || '').trim();
      configObj.api_key = (req.body.api_key || '').trim();
      configObj.auto_sync = req.body.auto_sync === '1' || req.body.auto_sync === 'on';
      break;
    case 'quickbooks':
      configObj.client_id = (req.body.client_id || '').trim();
      configObj.client_secret = (req.body.client_secret || '').trim();
      configObj.realm_id = (req.body.realm_id || '').trim();
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
      case 'quickbooks':
        req.flash('error', 'QuickBooks Online integration is not yet active — coming soon');
        break;
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
