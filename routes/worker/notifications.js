/**
 * Worker portal: push notification subscription endpoints.
 *
 * Mirrors /notifications/push/* on the admin side, but keys subscriptions
 * by crew_member_id so workers (who don't have a `users` row) can be
 * pushed to. Used for 24-hour shift reminders.
 */
const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const {
  getVapidPublicKey,
  saveWorkerSubscription,
  removeWorkerSubscription,
  saveWorkerDeviceToken,
  removeWorkerDeviceToken,
  sendPushToCrew,
} = require('../../services/pushNotification');

router.get('/notifications/push/vapid-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(500).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

router.post('/notifications/push/subscribe', (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    saveWorkerSubscription(req.session.worker.id, subscription);
    res.json({ success: true });
  } catch (err) {
    console.error('[WorkerPush] Subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

router.post('/notifications/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) removeWorkerSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

/**
 * Native app (Capacitor iOS shell): register / remove an APNs device token.
 * The shell JS calls this after PushNotifications.register() resolves.
 */
router.post('/notifications/push/device-token', (req, res) => {
  try {
    const { token, platform } = req.body || {};
    if (!token || typeof token !== 'string' || token.length > 512) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    saveWorkerDeviceToken(req.session.worker.id, token, platform === 'android' ? 'android' : 'ios');
    res.json({ success: true });
  } catch (err) {
    console.error('[WorkerPush] Device token save error:', err.message);
    res.status(500).json({ error: 'Failed to save device token' });
  }
});

router.post('/notifications/push/device-token/remove', (req, res) => {
  try {
    const { token } = req.body || {};
    if (token) removeWorkerDeviceToken(token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove device token' });
  }
});

router.post('/notifications/push/test', async (req, res) => {
  try {
    const crewId = req.session.worker.id;
    const db = getDb();
    const subCount = db.prepare('SELECT COUNT(*) AS c FROM worker_push_subscriptions WHERE crew_member_id = ?').get(crewId);
    const tokenCount = db.prepare('SELECT COUNT(*) AS c FROM worker_device_tokens WHERE crew_member_id = ?').get(crewId);
    const totalDevices = (subCount ? subCount.c : 0) + (tokenCount ? tokenCount.c : 0);
    if (totalDevices === 0) {
      return res.json({ success: false, error: 'No push subscriptions found. Enable notifications first.' });
    }
    if (!getVapidPublicKey() && (!tokenCount || tokenCount.c === 0)) {
      return res.json({ success: false, error: 'Server is missing VAPID keys. Contact the office.' });
    }
    let result;
    try {
      result = await sendPushToCrew(crewId, {
        title: 'T&S Test Notification',
        body: 'Push notifications are working. You will be notified 24 hours before each shift.',
        url: '/w/home',
        type: 'test',
      });
    } catch (sendErr) {
      console.error('[WorkerPush test] sendPushToCrew threw:', sendErr.message, sendErr.stack);
      return res.status(500).json({ success: false, error: 'Push send failed: ' + (sendErr.message || 'unknown') });
    }
    if (!result || result.sent === 0) {
      const reason = (result && (result.lastError || result.reason)) || 'no devices reached';
      return res.json({ success: false, error: 'Push not delivered: ' + reason });
    }
    res.json({ success: true, devices: totalDevices, delivered: result.sent, failed: result.failed });
  } catch (err) {
    console.error('[WorkerPush test] handler error:', err.message, err.stack);
    res.status(500).json({ success: false, error: 'Failed to send test: ' + (err.message || 'unknown') });
  }
});

module.exports = router;
