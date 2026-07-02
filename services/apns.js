/**
 * APNs (Apple Push Notification service) sender — native push for the iOS
 * worker app (Capacitor shell). Complements services/pushNotification.js:
 * web-push covers browsers/PWA installs; this covers the native app, where
 * WKWebView has no service-worker push.
 *
 * Dependency-free: raw HTTP/2 via node:http2 and ES256 provider-token auth
 * via node:crypto, so nothing new ships to Railway.
 *
 * Env vars (all required for sending; service no-ops silently otherwise):
 *   APNS_TEAM_ID     — Apple Developer Team ID (10 chars)
 *   APNS_KEY_ID      — Key ID of the .p8 APNs auth key (10 chars)
 *   APNS_KEY         — contents of the .p8 file (PEM). "\n" escapes allowed.
 *                      Or set APNS_KEY_BASE64 with the base64 of the file.
 *   APNS_BUNDLE_ID   — app bundle id (default: au.com.atomis.crew)
 *   APNS_ENV         — 'production' (default) or 'sandbox' (Xcode dev builds)
 */
const http2 = require('http2');
const crypto = require('crypto');

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

function getConfig() {
  let key = process.env.APNS_KEY || '';
  if (!key && process.env.APNS_KEY_BASE64) {
    try { key = Buffer.from(process.env.APNS_KEY_BASE64, 'base64').toString('utf8'); } catch (e) { /* ignore */ }
  }
  key = key.replace(/\\n/g, '\n').trim();
  const teamId = (process.env.APNS_TEAM_ID || '').trim();
  const keyId = (process.env.APNS_KEY_ID || '').trim();
  if (!key || !teamId || !keyId) return null;
  return {
    key,
    teamId,
    keyId,
    bundleId: (process.env.APNS_BUNDLE_ID || 'au.com.atomis.crew').trim(),
    host: APNS_HOSTS[(process.env.APNS_ENV || 'production').trim()] || APNS_HOSTS.production,
  };
}

function isApnsConfigured() {
  return getConfig() !== null;
}

// --- Provider token (JWT, ES256). Apple accepts tokens 20-60 min old; we
// cache for 50 and re-sign after that.
let cachedToken = null;
let cachedTokenAt = 0;

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function getProviderToken(cfg) {
  const now = Date.now();
  if (cachedToken && now - cachedTokenAt < 50 * 60 * 1000) return cachedToken;

  const header = base64url(JSON.stringify({ alg: 'ES256', kid: cfg.keyId }));
  const claims = base64url(JSON.stringify({ iss: cfg.teamId, iat: Math.floor(now / 1000) }));
  const signingInput = header + '.' + claims;
  // APNs requires the raw (r||s) IEEE-P1363 signature form, not ASN.1/DER.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: cfg.key,
    dsaEncoding: 'ieee-p1363',
  });
  cachedToken = signingInput + '.' + base64url(signature);
  cachedTokenAt = now;
  return cachedToken;
}

/**
 * Send one notification to one device token.
 * Resolves { ok, status, reason } — never rejects; callers decide on cleanup.
 * reason 'Unregistered' / 'BadDeviceToken' / 'ExpiredToken' => delete the token.
 */
function sendToDevice(deviceToken, payload) {
  const cfg = getConfig();
  if (!cfg) return Promise.resolve({ ok: false, status: 0, reason: 'apns-not-configured' });

  // Map the web-push payload shape ({title, body, url, type, category})
  // onto an APNs payload. `url` rides along as custom data — the Capacitor
  // shell reads it on notification tap and navigates the webview.
  const body = JSON.stringify({
    aps: {
      alert: { title: payload.title || 'Atomis', body: payload.body || '' },
      sound: 'default',
      'thread-id': payload.category || payload.type || 'general',
    },
    url: payload.url || '/w/home',
    type: payload.type || 'general',
  });

  return new Promise((resolve) => {
    let client;
    try {
      client = http2.connect(cfg.host);
    } catch (e) {
      return resolve({ ok: false, status: 0, reason: e.message });
    }
    const finish = (result) => { try { client.close(); } catch (e) { /* ignore */ } resolve(result); };
    client.on('error', (err) => finish({ ok: false, status: 0, reason: err.message }));

    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + deviceToken,
      'authorization': 'bearer ' + getProviderToken(cfg),
      'apns-topic': cfg.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });
    req.setTimeout(10000, () => { req.close(); finish({ ok: false, status: 0, reason: 'timeout' }); });

    let status = 0;
    let data = '';
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (status === 200) return finish({ ok: true, status, reason: null });
      let reason = 'HTTP ' + status;
      try { reason = JSON.parse(data).reason || reason; } catch (e) { /* ignore */ }
      finish({ ok: false, status, reason });
    });
    req.on('error', (err) => finish({ ok: false, status: 0, reason: err.message }));
    req.end(body);
  });
}

// Token responses that mean "this device token is dead — stop storing it".
const DEAD_TOKEN_REASONS = new Set(['Unregistered', 'BadDeviceToken', 'ExpiredToken', 'DeviceTokenNotForTopic']);

function isDeadTokenReason(reason) {
  return DEAD_TOKEN_REASONS.has(reason);
}

module.exports = { isApnsConfigured, sendToDevice, isDeadTokenReason };
