// Integration helpers — shared utilities for all providers
const { getDb } = require('../db/database');
const axios = require('axios');

// ---- Config Helpers ----

/** Get parsed integration config for a provider */
function getIntegrationConfig(provider) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM integration_config WHERE provider = ?').get(provider);
  if (!row) return { enabled: false, config: {} };
  let config = {};
  try { config = JSON.parse(row.config_json || '{}'); } catch (e) { /* invalid JSON */ }
  return {
    id: row.id,
    provider: row.provider,
    enabled: !!row.enabled,
    config,
    last_sync_at: row.last_sync_at,
    sync_status: row.sync_status,
    error_message: row.error_message,
  };
}

/** Save integration config (merges with existing) */
function saveIntegrationConfig(provider, configObj, enabled) {
  const db = getDb();
  const existing = getIntegrationConfig(provider);
  const merged = { ...existing.config, ...configObj };
  db.prepare(`
    UPDATE integration_config
    SET config_json = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP
    WHERE provider = ?
  `).run(JSON.stringify(merged), enabled ? 1 : 0, provider);
}

/** Update sync status on integration_config */
function updateSyncStatus(provider, status, errorMessage) {
  const db = getDb();
  const updates = { sync_status: status, updated_at: 'CURRENT_TIMESTAMP' };
  if (status === 'success' || status === 'error') {
    db.prepare(`
      UPDATE integration_config
      SET sync_status = ?, error_message = ?, last_sync_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE provider = ?
    `).run(status, errorMessage || '', provider);
  } else {
    db.prepare(`
      UPDATE integration_config
      SET sync_status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE provider = ?
    `).run(status, errorMessage || '', provider);
  }
}

// ---- Sync Log ----

/** Start a sync log entry, returns the log id */
function startSyncLog(provider, direction, entityType, triggeredBy) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO sync_log (provider, direction, entity_type, triggered_by)
    VALUES (?, ?, ?, ?)
  `).run(provider, direction, entityType, triggeredBy || 'manual');
  return result.lastInsertRowid;
}

/** Complete a sync log entry with stats */
function completeSyncLog(logId, stats) {
  const db = getDb();
  db.prepare(`
    UPDATE sync_log
    SET records_processed = ?, records_created = ?, records_updated = ?,
        records_failed = ?, error_details = ?, completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    stats.processed || 0,
    stats.created || 0,
    stats.updated || 0,
    stats.failed || 0,
    stats.errorDetails || '',
    logId
  );
}

/** Get recent sync log entries */
function getRecentSyncLogs(limit) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sync_log ORDER BY started_at DESC LIMIT ?
  `).all(limit || 20);
}

// ---- External References ----

/** Get external ref for an internal entity */
function getExternalRef(provider, entityType, internalId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM external_refs WHERE provider = ? AND entity_type = ? AND internal_id = ?
  `).get(provider, entityType, internalId);
}

/** Get internal entity by external ref */
function getInternalRef(provider, entityType, externalId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM external_refs WHERE provider = ? AND entity_type = ? AND external_id = ?
  `).get(provider, entityType, externalId);
}

/** Set/update external ref mapping */
function setExternalRef(provider, entityType, internalId, externalId, data) {
  const db = getDb();
  db.prepare(`
    INSERT INTO external_refs (provider, entity_type, internal_id, external_id, external_data, last_synced_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider, entity_type, internal_id)
    DO UPDATE SET external_id = excluded.external_id, external_data = excluded.external_data, last_synced_at = CURRENT_TIMESTAMP
  `).run(provider, entityType, internalId, externalId, JSON.stringify(data || {}));
}

// ---- Microsoft Teams Webhook ----

/**
 * Send a notification to a Microsoft Teams channel via incoming webhook.
 * Non-blocking — errors are logged but don't throw.
 */
async function sendTeamsNotification(title, message, link) {
  try {
    const ic = getIntegrationConfig('teams');
    if (!ic.enabled || !ic.config.webhook_url) return;

    const card = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: title,
      themeColor: '6366f1',
      title: title,
      text: message,
    };

    if (link) {
      card.potentialAction = [{
        '@type': 'OpenUri',
        name: 'View in Dashboard',
        targets: [{ os: 'default', uri: link }]
      }];
    }

    await axios.post(ic.config.webhook_url, card, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    });
  } catch (err) {
    console.error('Teams webhook error:', err.message);
  }
}

/**
 * Send a test Teams notification (used from admin settings page).
 */
async function testTeamsWebhook(webhookUrl) {
  const card = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    summary: 'Atomis — Test Notification',
    themeColor: '6366f1',
    title: '✅ Atomis Connected',
    text: 'This is a test notification from Atomis. If you can see this, the Teams integration is working correctly.',
  };

  const response = await axios.post(webhookUrl, card, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 10000,
  });
  return response.status;
}

module.exports = {
  getIntegrationConfig,
  saveIntegrationConfig,
  updateSyncStatus,
  startSyncLog,
  completeSyncLog,
  getRecentSyncLogs,
  getExternalRef,
  getInternalRef,
  setExternalRef,
  sendTeamsNotification,
  testTeamsWebhook,
};
