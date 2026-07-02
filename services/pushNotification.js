/**
 * Web Push Notification Service
 * Uses the Web Push protocol (VAPID) to send push notifications to subscribed browsers/devices.
 */
const webpush = require('web-push');
const { getDb } = require('../db/database');
const apns = require('./apns');

let vapidConfigured = false;

/**
 * Initialize VAPID keys — call once on server startup.
 * Uses env vars VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY if set,
 * otherwise auto-generates and stores in system_config DB table.
 */
function initVapid() {
  try {
    const db = getDb();
    let publicKey = process.env.VAPID_PUBLIC_KEY || '';
    let privateKey = process.env.VAPID_PRIVATE_KEY || '';
    const contactEmail = process.env.VAPID_EMAIL || process.env.SMTP_FROM_EMAIL || 'admin@tstc.com.au';

    // Try loading from DB if not in env
    if (!publicKey || !privateKey) {
      try {
        const pubRow = db.prepare("SELECT config_value FROM system_config WHERE config_key = 'vapid_public_key'").get();
        const privRow = db.prepare("SELECT config_value FROM system_config WHERE config_key = 'vapid_private_key'").get();
        if (pubRow && privRow) {
          publicKey = pubRow.config_value;
          privateKey = privRow.config_value;
        }
      } catch (e) { /* system_config may not exist yet */ }
    }

    // Generate new keys if we still don't have any
    if (!publicKey || !privateKey) {
      console.log('[Push] Generating new VAPID keys...');
      const keys = webpush.generateVAPIDKeys();
      publicKey = keys.publicKey;
      privateKey = keys.privateKey;

      // Save to DB for persistence across restarts
      try {
        db.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('vapid_public_key', ?)").run(publicKey);
        db.prepare("INSERT OR REPLACE INTO system_config (config_key, config_value) VALUES ('vapid_private_key', ?)").run(privateKey);
        console.log('[Push] VAPID keys saved to database.');
      } catch (e) {
        console.warn('[Push] Could not save VAPID keys to DB:', e.message);
      }
    }

    webpush.setVapidDetails('mailto:' + contactEmail, publicKey, privateKey);
    vapidConfigured = true;
    console.log('[Push] VAPID configured. Public key:', publicKey.substring(0, 20) + '...');
    return publicKey;
  } catch (err) {
    console.error('[Push] VAPID init error:', err.message);
    return null;
  }
}

/**
 * Get the VAPID public key (needed by the browser to subscribe)
 */
function getVapidPublicKey() {
  const db = getDb();
  const pubKey = process.env.VAPID_PUBLIC_KEY || '';
  if (pubKey) return pubKey;
  try {
    const row = db.prepare("SELECT config_value FROM system_config WHERE config_key = 'vapid_public_key'").get();
    return row ? row.config_value : null;
  } catch (e) {
    return null;
  }
}

/**
 * Save a push subscription for a user
 */
function saveSubscription(userId, subscription) {
  const db = getDb();
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys ? subscription.keys.p256dh : '';
  const auth = subscription.keys ? subscription.keys.auth : '';

  // Upsert — same endpoint = update keys
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=?, p256dh=?, auth=?, updated_at=CURRENT_TIMESTAMP
  `).run(userId, endpoint, p256dh, auth, userId, p256dh, auth);
}

/**
 * Remove a push subscription
 */
function removeSubscription(endpoint) {
  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/**
 * Send a push notification to a specific user (all their subscribed devices)
 */
async function sendPushToUser(userId, payload) {
  if (!vapidConfigured) {
    console.log('[Push] VAPID not configured, skipping push for user', userId);
    return;
  }

  const db = getDb();
  const subscriptions = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);

  if (subscriptions.length === 0) {
    console.log('[Push] No subscriptions for user', userId);
    return;
  }

  const payloadStr = JSON.stringify(payload);
  console.log('[Push] Sending to user', userId, '(' + subscriptions.length + ' device(s)):', payload.title);

  const results = [];
  for (const sub of subscriptions) {
    const pushSub = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };

    results.push(
      webpush.sendNotification(pushSub, payloadStr)
        .then(() => {
          console.log('[Push] Sent to user', userId, 'device:', sub.endpoint.substring(0, 50));
        })
        .catch(err => {
          // 410 Gone or 404 = subscription expired, remove it
          if (err.statusCode === 410 || err.statusCode === 404) {
            console.log('[Push] Removing expired subscription:', sub.endpoint.substring(0, 50));
            removeSubscription(sub.endpoint);
          } else {
            console.error('[Push] Send error for user', userId, ':', err.statusCode || err.message);
          }
        })
    );
  }

  return Promise.allSettled(results);
}

/**
 * Send push notifications for newly created notification records.
 * Called from the notification generation engine.
 */
function sendPushForNotifications(db, newNotifications) {
  if (!vapidConfigured || newNotifications.length === 0) return;

  for (const n of newNotifications) {
    sendPushToUser(n.userId, {
      title: n.title,
      body: n.message,
      url: n.link || '/notifications',
      type: n.type || 'general'
    });
  }
}

/**
 * Worker push: save a subscription for a crew_member (worker portal)
 */
function saveWorkerSubscription(crewMemberId, subscription) {
  const db = getDb();
  const endpoint = subscription.endpoint;
  const p256dh = subscription.keys ? subscription.keys.p256dh : '';
  const auth = subscription.keys ? subscription.keys.auth : '';
  db.prepare(`
    INSERT INTO worker_push_subscriptions (crew_member_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET crew_member_id=?, p256dh=?, auth=?, updated_at=CURRENT_TIMESTAMP
  `).run(crewMemberId, endpoint, p256dh, auth, crewMemberId, p256dh, auth);
}

function removeWorkerSubscription(endpoint) {
  const db = getDb();
  db.prepare('DELETE FROM worker_push_subscriptions WHERE endpoint = ?').run(endpoint);
}

/**
 * Native app (Capacitor/iOS) device tokens — parallel channel to web-push.
 */
function saveWorkerDeviceToken(crewMemberId, token, platform) {
  const db = getDb();
  db.prepare(`
    INSERT INTO worker_device_tokens (crew_member_id, platform, token)
    VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET crew_member_id=excluded.crew_member_id, platform=excluded.platform, updated_at=CURRENT_TIMESTAMP
  `).run(crewMemberId, platform || 'ios', token);
}

function removeWorkerDeviceToken(token) {
  const db = getDb();
  db.prepare('DELETE FROM worker_device_tokens WHERE token = ?').run(token);
}

/**
 * Send to a crew member's native app devices via APNs. Same payload shape as
 * web-push. No-ops (with a reason) when APNS_* env vars aren't set.
 */
async function sendNativeToCrew(crewMemberId, payload) {
  if (!apns.isApnsConfigured()) return { sent: 0, failed: 0, reason: 'apns-not-configured' };
  const db = getDb();
  const tokens = db.prepare("SELECT token FROM worker_device_tokens WHERE crew_member_id = ? AND platform = 'ios'").all(crewMemberId);
  if (tokens.length === 0) return { sent: 0, failed: 0, reason: 'no-device-tokens' };
  let sent = 0, failed = 0, lastError = null;
  for (const t of tokens) {
    const result = await apns.sendToDevice(t.token, payload);
    if (result.ok) { sent++; continue; }
    failed++;
    lastError = result.reason;
    if (apns.isDeadTokenReason(result.reason)) {
      removeWorkerDeviceToken(t.token);
    } else {
      console.error('[Push] APNs error crew', crewMemberId, ':', result.status, result.reason);
    }
  }
  return { sent, failed, lastError };
}

/**
 * Worker-side per-category opt-in/out. Returns true unless the worker has
 * explicitly disabled this category in worker_notification_prefs. A category
 * of null/undefined is always allowed (back-compat with old call sites that
 * haven't been migrated yet).
 */
function isWorkerCategoryEnabled(db, crewMemberId, category) {
  if (!category) return true;
  try {
    const row = db.prepare(
      "SELECT enabled FROM worker_notification_prefs WHERE crew_member_id = ? AND category = ? AND channel = 'push'"
    ).get(crewMemberId, category);
    if (!row) return true; // default-on
    return row.enabled === 1;
  } catch (e) { return true; }
}

/**
 * Send a push notification to a crew member (all their subscribed devices).
 * Pass `payload.category` to honour worker_notification_prefs (per-category
 * mute toggles). If not set, the push always fires (back-compat).
 */
async function sendPushToCrew(crewMemberId, payload) {
  const db = getDb();
  if (!isWorkerCategoryEnabled(db, crewMemberId, payload && payload.category)) {
    return { sent: 0, failed: 0, reason: 'category-muted' };
  }

  let sent = 0, failed = 0, lastError = null;

  // Channel 1: web-push (browser / installed PWA)
  if (vapidConfigured) {
    const subs = db.prepare('SELECT * FROM worker_push_subscriptions WHERE crew_member_id = ?').all(crewMemberId);
    if (subs.length > 0) {
      const payloadStr = JSON.stringify(payload);
      console.log('[Push] -> crew', crewMemberId, '(' + subs.length + ' device(s)):', payload.title);
      for (const sub of subs) {
        const pushSub = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
        try {
          await webpush.sendNotification(pushSub, payloadStr);
          sent++;
        } catch (err) {
          failed++;
          lastError = err.statusCode ? `HTTP ${err.statusCode} ${err.body || ''}`.trim() : err.message;
          if (err.statusCode === 410 || err.statusCode === 404) {
            removeWorkerSubscription(sub.endpoint);
          } else {
            console.error('[Push] Crew send error', crewMemberId, ':', err.statusCode || err.message, err.body || '');
          }
        }
      }
    }
  }

  // Channel 2: native app (APNs). Category prefs already honoured above.
  try {
    const native = await sendNativeToCrew(crewMemberId, payload);
    sent += native.sent;
    failed += native.failed;
    if (native.lastError) lastError = native.lastError;
  } catch (e) {
    console.error('[Push] APNs channel error crew', crewMemberId, ':', e.message);
  }

  if (sent === 0 && failed === 0) return { sent, failed, reason: 'no-subscriptions' };
  return { sent, failed, lastError };
}

/**
 * Fan-out a push to every crew member that has at least one active
 * subscription. Used by Safety publish flows (new bulletin, new SWMS
 * version) where the audience is "all workers". Sequential iteration is
 * fine at low-hundreds scale; switch to batched Promise.allSettled if
 * the crew count climbs above ~500.
 */
async function sendPushToAllActiveCrew(payload) {
  const db = getDb();
  // Union of web-push subscribers and native-app devices — a crew member may
  // have either or both; sendPushToCrew handles each channel's availability.
  const rows = db.prepare(`
    SELECT crew_member_id FROM worker_push_subscriptions
    UNION
    SELECT crew_member_id FROM worker_device_tokens
  `).all();
  for (const r of rows) {
    try { await sendPushToCrew(r.crew_member_id, payload); /* category honoured inside */ }
    catch (e) { console.error('[Push] fan-out crew', r.crew_member_id, e.message); }
  }
}

/**
 * Read + write worker notification prefs (used by /w/profile/notifications).
 */
function getWorkerNotificationPrefs(crewMemberId) {
  const db = getDb();
  const rows = db.prepare("SELECT category, channel, enabled FROM worker_notification_prefs WHERE crew_member_id = ?").all(crewMemberId);
  const map = {};
  for (const r of rows) map[r.category + ':' + r.channel] = r.enabled === 1;
  return map;
}

function setWorkerNotificationPref(crewMemberId, category, channel, enabled) {
  const db = getDb();
  db.prepare(`
    INSERT INTO worker_notification_prefs (crew_member_id, category, channel, enabled, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(crew_member_id, category, channel) DO UPDATE SET
      enabled = excluded.enabled, updated_at = excluded.updated_at
  `).run(crewMemberId, category, channel || 'push', enabled ? 1 : 0);
}

module.exports = {
  initVapid,
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  sendPushToUser,
  sendPushForNotifications,
  saveWorkerSubscription,
  removeWorkerSubscription,
  saveWorkerDeviceToken,
  removeWorkerDeviceToken,
  sendNativeToCrew,
  sendPushToCrew,
  sendPushToAllActiveCrew,
  isWorkerCategoryEnabled,
  getWorkerNotificationPrefs,
  setWorkerNotificationPref,
};
