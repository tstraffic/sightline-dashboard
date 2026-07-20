const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { getVapidPublicKey, saveSubscription, removeSubscription, sendPushToUser } = require('../services/pushNotification');

// ============================================
// LIST NOTIFICATIONS FOR CURRENT USER
// ============================================
router.get('/', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;

  const filter = req.query.filter || 'all';
  let whereExtra = '';
  if (filter === 'unread') whereExtra = ' AND n.is_read = 0';
  if (filter === 'read') whereExtra = ' AND n.is_read = 1';

  const notifications = db.prepare(`
    SELECT n.*, j.job_number
    FROM notifications n
    LEFT JOIN jobs j ON n.job_id = j.id
    WHERE n.user_id = ?${whereExtra}
    ORDER BY n.created_at DESC
    LIMIT 100
  `).all(userId);

  const unreadCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).count;
  const totalCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ?').get(userId).count;

  // Group by type for stats
  const typeCounts = {};
  notifications.forEach(n => {
    typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
  });

  res.render('notifications/index', {
    title: 'Notifications',
    currentPage: 'notifications',
    notifications,
    unreadCount,
    totalCount,
    typeCounts,
    filter
  });
});

// ============================================
// RECENT NOTIFICATIONS (JSON API for popup)
// ============================================
router.get('/recent', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const notifications = db.prepare(`
    SELECT n.id, n.type, n.title, n.message, n.link, n.is_read, n.created_at, j.job_number
    FROM notifications n
    LEFT JOIN jobs j ON n.job_id = j.id
    WHERE n.user_id = ?
    ORDER BY n.is_read ASC, n.created_at DESC
    LIMIT 15
  `).all(userId);
  const unreadCount = db.prepare('SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).count;
  res.json({ notifications, unreadCount });
});

// ============================================
// MARK SINGLE NOTIFICATION AS READ
// ============================================
router.post('/:id/read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.session.user.id);
  // If there is a link, redirect there
  const notif = db.prepare('SELECT link FROM notifications WHERE id = ? AND user_id = ?').get(req.params.id, req.session.user.id);
  if (notif && notif.link) return res.redirect(notif.link);
  res.redirect('/notifications');
});

// ============================================
// MARK ALL AS READ
// ============================================
router.post('/mark-all-read', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0').run(req.session.user.id);
  req.flash('success', 'All notifications marked as read.');
  req.session.save(() => res.redirect('/notifications'));
});

// ============================================
// CLEAR OLD NOTIFICATIONS (30+ days)
// ============================================
router.post('/clear-old', (req, res) => {
  const db = getDb();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  db.prepare('DELETE FROM notifications WHERE user_id = ? AND created_at < ?').run(req.session.user.id, thirtyDaysAgo);
  req.flash('success', 'Old notifications cleared.');
  req.session.save(() => res.redirect('/notifications'));
});

// ============================================
// PUSH NOTIFICATION: GET VAPID PUBLIC KEY
// ============================================
router.get('/push/vapid-key', (req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(500).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

// ============================================
// PUSH NOTIFICATION: SUBSCRIBE
// ============================================
router.post('/push/subscribe', (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    saveSubscription(req.session.user.id, subscription);
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] Subscribe error:', err.message);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// ============================================
// PUSH NOTIFICATION: UNSUBSCRIBE
// ============================================
router.post('/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) removeSubscription(endpoint);
    res.json({ success: true });
  } catch (err) {
    console.error('[Push] Unsubscribe error:', err.message);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// ============================================
// PUSH NOTIFICATION: SEND TEST
// ============================================
router.post('/push/test', (req, res) => {
  try {
    const userId = req.session.user.id;
    const db = getDb();
    const subCount = db.prepare('SELECT COUNT(*) as cnt FROM push_subscriptions WHERE user_id = ?').get(userId);

    if (!subCount || subCount.cnt === 0) {
      return res.json({ success: false, error: 'No push subscriptions found for your account. Make sure you clicked "Enable" on the notification prompt.' });
    }

    sendPushToUser(userId, {
      title: 'T&S Test Notification',
      body: 'Push notifications are working! You will receive alerts for tasks, deadlines, and updates.',
      url: '/profile',
      type: 'test'
    });

    res.json({ success: true, devices: subCount.cnt });
  } catch (err) {
    console.error('[Push] Test push error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
