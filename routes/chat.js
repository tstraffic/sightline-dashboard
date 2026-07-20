const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { requireThreadMember } = require('../middleware/chat');
const { logActivity } = require('../middleware/audit');

// In-memory typing indicator store (resets on restart, intentionally ephemeral)
const typingUsers = new Map(); // threadId -> Map(userId -> { name, timestamp })

// ============================================
// Multer config for chat image uploads
// ============================================
const chatStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const threadId = req.body.thread_id || 'general';
    const dir = path.join(__dirname, '..', 'public', 'uploads', 'chat', `thread_${threadId}`);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, uniqueSuffix + ext);
  }
});

const chatUpload = multer({
  storage: chatStorage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const docTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain', 'text/csv'];
    const audioTypes = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
    cb(null, imageTypes.includes(file.mimetype) || docTypes.includes(file.mimetype) || audioTypes.includes(file.mimetype));
  }
});

// ============================================
// HTML: Messages Inbox Page
// ============================================
router.get('/', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const userRole = req.session.user.role;
  const isAdmin = ['admin', 'management'].includes(userRole);
  const canStartThread = true; // Everyone can create DMs, groups, channels

  // Filters
  const tab = req.query.tab || 'all';
  const filterType = req.query.type || '';
  const filterStatus = req.query.status || '';
  const filterSearch = req.query.search || '';

  // Base query for threads
  let baseQuery, baseParams;
  if (isAdmin) {
    baseQuery = `
      SELECT ct.*,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL) as message_count,
        (SELECT m.body FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_at,
        (SELECT u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_sender,
        (SELECT m.message_type FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_type,
        (SELECT COUNT(m.id) FROM chat_thread_members ctm2 JOIN messages m ON m.thread_id = ctm2.thread_id AND m.id > COALESCE(ctm2.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm2.user_id OR m.sender_id IS NULL) WHERE ctm2.thread_id = ct.id AND ctm2.user_id = ?) as unread_count,
        (SELECT COUNT(*) FROM chat_thread_members WHERE thread_id = ct.id) as member_count
      FROM chat_threads ct
      WHERE ct.status = 'active'`;
    baseParams = [userId];
  } else {
    baseQuery = `
      SELECT ct.*,
        (SELECT COUNT(*) FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL) as message_count,
        (SELECT m.body FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_at,
        (SELECT u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_sender,
        (SELECT m.message_type FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_type,
        (SELECT COUNT(m.id) FROM messages m WHERE m.thread_id = ct.id AND m.id > COALESCE(ctm.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)) as unread_count,
        (SELECT COUNT(*) FROM chat_thread_members WHERE thread_id = ct.id) as member_count
      FROM chat_thread_members ctm
      JOIN chat_threads ct ON ct.id = ctm.thread_id
      WHERE ctm.user_id = ? AND ct.status = 'active'`;
    baseParams = [userId];
  }

  // Apply tab filter
  if (tab === 'direct') {
    baseQuery += ` AND ct.thread_type IN ('dm','group')`;
  } else if (tab === 'threads') {
    baseQuery += ` AND ct.thread_type IN ('job','incident','compliance')`;
  } else if (tab === 'channels') {
    baseQuery += ` AND ct.thread_type IN ('channel','announcement')`;
  }

  // Apply filters
  if (filterType) {
    baseQuery += ` AND ct.thread_type = ?`;
    baseParams.push(filterType);
  }
  if (filterSearch) {
    baseQuery += ` AND ct.title LIKE ?`;
    baseParams.push(`%${filterSearch}%`);
  }

  baseQuery += ` ORDER BY last_message_at DESC NULLS LAST, ct.created_at DESC`;
  const threads = db.prepare(baseQuery).all(...baseParams);

  // Filter unread client-side (SQLite HAVING on subquery is complex)
  const filteredThreads = filterStatus === 'unread' ? threads.filter(t => t.unread_count > 0) : threads;

  // Compute stats from all threads (unfiltered)
  let allThreads;
  if (isAdmin) {
    allThreads = db.prepare(`
      SELECT ct.thread_type,
        (SELECT COUNT(m.id) FROM chat_thread_members ctm2 JOIN messages m ON m.thread_id = ctm2.thread_id AND m.id > COALESCE(ctm2.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm2.user_id OR m.sender_id IS NULL) WHERE ctm2.thread_id = ct.id AND ctm2.user_id = ?) as unread_count
      FROM chat_threads ct WHERE ct.status = 'active'
    `).all(userId);
  } else {
    allThreads = db.prepare(`
      SELECT ct.thread_type,
        (SELECT COUNT(m.id) FROM messages m WHERE m.thread_id = ct.id AND m.id > COALESCE(ctm.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)) as unread_count
      FROM chat_thread_members ctm
      JOIN chat_threads ct ON ct.id = ctm.thread_id
      WHERE ctm.user_id = ? AND ct.status = 'active'
    `).all(userId);
  }

  const stats = {
    unread: allThreads.filter(t => t.unread_count > 0).length,
    dms: allThreads.filter(t => t.thread_type === 'dm' || t.thread_type === 'group').length,
    threads: allThreads.filter(t => ['job','incident','compliance'].includes(t.thread_type)).length,
    channels: allThreads.filter(t => ['channel','announcement'].includes(t.thread_type)).length,
    total: allThreads.length,
  };

  // For DM threads, resolve the "other user" name for display
  for (const t of filteredThreads) {
    if (t.thread_type === 'dm') {
      const otherUser = db.prepare(`
        SELECT u.id, u.full_name, u.role FROM chat_thread_members ctm
        JOIN users u ON ctm.user_id = u.id
        WHERE ctm.thread_id = ? AND ctm.user_id != ?
        LIMIT 1
      `).get(t.id, userId);
      t.dm_user = otherUser || null;
    }
  }

  res.render('chat/inbox', {
    title: 'Operational Communications',
    currentPage: 'chat',
    threads: filteredThreads,
    stats,
    tab,
    filters: { type: filterType, status: filterStatus, search: filterSearch },
    canStartThread,
    user: req.session.user
  });
});

// ============================================
// API: Get threads for current user (JSON)
// ============================================
router.get('/api/threads', (req, res) => {
  const db = getDb();
  const userId = req.session.user.id;
  const isManagement = req.session.user.role === 'management';

  let threads;
  if (isManagement) {
    threads = db.prepare(`
      SELECT ct.id, ct.thread_type, ct.title, ct.status,
        (SELECT COUNT(m.id) FROM chat_thread_members ctm2 JOIN messages m ON m.thread_id = ctm2.thread_id AND m.id > COALESCE(ctm2.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm2.user_id OR m.sender_id IS NULL) WHERE ctm2.thread_id = ct.id AND ctm2.user_id = ?) as unread_count
      FROM chat_threads ct WHERE ct.status = 'active'
    `).all(userId);
  } else {
    threads = db.prepare(`
      SELECT ct.id, ct.thread_type, ct.title, ct.status,
        (SELECT COUNT(m.id) FROM messages m WHERE m.thread_id = ct.id AND m.id > COALESCE(ctm.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)) as unread_count
      FROM chat_thread_members ctm
      JOIN chat_threads ct ON ct.id = ctm.thread_id
      WHERE ctm.user_id = ? AND ct.status = 'active'
    `).all(userId);
  }

  const totalUnread = threads.reduce((sum, t) => sum + (t.unread_count || 0), 0);
  res.json({ threads, totalUnread });
});

// ============================================
// API: Get messages for a thread (JSON, polling)
// ============================================
router.get('/api/threads/:threadId/messages', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;
  const after = parseInt(req.query.after) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);

  const messages = db.prepare(`
    SELECT m.id, m.thread_id, m.sender_id, m.body, m.message_type,
      m.reply_to_message_id, m.created_at, m.edited_at, m.deleted_at,
      u.full_name as sender_name, u.role as sender_role,
      rm.body as reply_to_body, ru.full_name as reply_to_sender_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN messages rm ON m.reply_to_message_id = rm.id
    LEFT JOIN users ru ON rm.sender_id = ru.id
    WHERE m.thread_id = ? AND m.id > ? AND m.deleted_at IS NULL
    ORDER BY m.id ASC
    LIMIT ?
  `).all(threadId, after, limit);

  // Load attachments for image/file messages
  const msgIds = messages.filter(m => m.message_type === 'image' || m.message_type === 'file').map(m => m.id);
  let attachments = {};
  if (msgIds.length > 0) {
    const rows = db.prepare(`
      SELECT * FROM message_attachments WHERE message_id IN (${msgIds.map(() => '?').join(',')})
    `).all(...msgIds);
    for (const a of rows) {
      if (!attachments[a.message_id]) attachments[a.message_id] = [];
      attachments[a.message_id].push(a);
    }
  }

  // Attach attachments to messages
  for (const msg of messages) {
    msg.attachments = attachments[msg.id] || [];
  }

  res.json({ messages });
});

// ============================================
// API: Send a message (JSON)
// ============================================
router.post('/api/threads/:threadId/messages', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;
  const userId = req.session.user.id;
  const { body, message_type, reply_to_message_id, mentioned_user_ids, attachment } = req.body;

  if (!body && message_type !== 'image') {
    return res.status(400).json({ error: 'Message body is required.' });
  }

  const type = message_type || 'text';

  const result = db.prepare(`
    INSERT INTO messages (thread_id, sender_id, body, message_type, reply_to_message_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(threadId, userId, body || '', type, reply_to_message_id || null);

  const messageId = Number(result.lastInsertRowid);

  // Handle attachment if provided (for image messages)
  if (attachment && attachment.file_url) {
    db.prepare(`
      INSERT INTO message_attachments (message_id, file_url, thumbnail_url, mime_type, file_size, original_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(messageId, attachment.file_url, attachment.thumbnail_url || '', attachment.mime_type || 'image/jpeg', attachment.file_size || 0, attachment.original_name || 'image');
  }

  // Handle mentions
  if (mentioned_user_ids && Array.isArray(mentioned_user_ids) && mentioned_user_ids.length > 0) {
    const mentionStmt = db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, mentioned_user_id) VALUES (?, ?)');
    const thread = db.prepare('SELECT title, related_entity_type, related_entity_id FROM chat_threads WHERE id = ?').get(threadId);
    const sender = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);

    for (const mentionedId of mentioned_user_ids) {
      mentionStmt.run(messageId, mentionedId);
      // Create notification for mentioned user
      if (mentionedId !== userId) {
        const entityLink = thread.related_entity_type === 'job'
          ? `/jobs/${thread.related_entity_id}#chat`
          : thread.related_entity_type === 'incident'
            ? `/incidents/${thread.related_entity_id}#chat`
            : `/compliance/${thread.related_entity_id}`;

        db.prepare(`
          INSERT INTO notifications (user_id, type, title, message, link, job_id)
          VALUES (?, 'general', ?, ?, ?, NULL)
        `).run(
          mentionedId,
          `Mentioned by ${sender.full_name}`,
          `${sender.full_name} mentioned you in ${thread.title}`,
          entityLink
        );
      }
    }
  }

  // Update thread timestamp
  db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);

  // In-app notifications for all thread members (so bell icon shows new messages)
  try {
    const thread = db.prepare('SELECT title, thread_type, related_entity_type, related_entity_id, channel_slug FROM chat_threads WHERE id = ?').get(threadId);
    const members = db.prepare('SELECT user_id FROM chat_thread_members WHERE thread_id = ? AND user_id != ? AND muted_at IS NULL').all(threadId, userId);
    const senderName = req.session.user ? req.session.user.full_name : (req.session.worker ? req.session.worker.full_name : 'Someone');
    const preview = body ? (body.length > 80 ? body.substring(0, 80) + '...' : body) : (type === 'image' ? 'Sent an image' : 'Sent a file');

    // Build link
    let chatLink = '/chat';
    if (thread.thread_type === 'dm') chatLink = `/chat/dm/${userId}`;
    else if (thread.thread_type === 'channel' || thread.thread_type === 'announcement' || thread.thread_type === 'group') chatLink = `/chat/channel/${threadId}`;
    else if (thread.related_entity_type === 'job') chatLink = `/jobs/${thread.related_entity_id}#chat`;

    const notifTitle = thread.thread_type === 'dm' ? `Message from ${senderName}` : `${thread.title}`;
    const notifMessage = thread.thread_type === 'dm' ? preview : `${senderName}: ${preview}`;

    // Skip already-mentioned users (they got a notification above)
    const mentionedSet = new Set((mentioned_user_ids || []).map(Number));

    const insertNotif = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link)
      SELECT ?, 'chat_message', ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM notifications WHERE user_id = ? AND type = 'chat_message' AND title = ? AND created_at > datetime('now', '-2 minutes')
      )
    `);
    for (const member of members) {
      if (mentionedSet.has(member.user_id)) continue;
      try { insertNotif.run(member.user_id, notifTitle, notifMessage, chatLink, member.user_id, notifTitle); } catch(e) {
        console.error('[Chat Notif] Error inserting notification for user', member.user_id, ':', e.message);
      }
    }
  } catch(e) {
    console.error('[Chat Notif] Error in notification block:', e.message || e);
  }

  // Audit log
  logActivity({
    user: req.session.user,
    action: 'create',
    entityType: 'message',
    entityId: messageId,
    entityLabel: body ? body.substring(0, 80) : '[image]',
    details: `Thread: ${threadId}, Type: ${type}`,
    ip: req.ip
  });

  // Push notifications to thread members (async, non-blocking)
  try {
    const { sendPushToUser } = require('../services/pushNotification');
    const thread = db.prepare('SELECT title, thread_type, related_entity_type, related_entity_id, channel_slug FROM chat_threads WHERE id = ?').get(threadId);
    const members = db.prepare('SELECT user_id FROM chat_thread_members WHERE thread_id = ? AND user_id != ? AND muted_at IS NULL').all(threadId, userId);
    const senderName = req.session.user ? req.session.user.full_name : (req.session.worker ? req.session.worker.full_name : 'Someone');
    const preview = body ? (body.length > 60 ? body.substring(0, 60) + '...' : body) : (type === 'image' ? 'Sent an image' : 'Sent a file');

    // Build deep link URL based on thread type
    let pushUrl = '/chat';
    if (thread.thread_type === 'dm') {
      pushUrl = `/chat/dm/${userId}`;
    } else if (thread.thread_type === 'channel' || thread.thread_type === 'announcement' || thread.thread_type === 'group') {
      pushUrl = `/chat/channel/${threadId}`;
    } else if (thread.related_entity_type === 'job') {
      pushUrl = `/jobs/${thread.related_entity_id}#chat`;
    } else if (thread.related_entity_type === 'incident') {
      pushUrl = `/incidents/${thread.related_entity_id}#chat`;
    }

    // Build push title based on thread type
    let pushTitle;
    if (thread.thread_type === 'dm') {
      pushTitle = senderName;
    } else {
      pushTitle = thread.title;
    }

    for (const member of members) {
      sendPushToUser(member.user_id, {
        title: pushTitle,
        body: thread.thread_type === 'dm' ? preview : `${senderName}: ${preview}`,
        url: pushUrl,
        type: 'chat'
      }).catch(err => {
        console.error('[Chat Push] Error sending to user', member.user_id, ':', err.message || err);
      });
    }

    // Announcement channels fan out to the WORKER push subscriptions too —
    // chat_thread_members only stores admin user_ids, so workers never appear
    // in the loop above. Deep-link to the worker-side channel view so the
    // push opens inside the worker portal (admin shell would 403 them).
    if (thread.thread_type === 'announcement') {
      const { sendPushToAllActiveCrew } = require('../services/pushNotification');
      sendPushToAllActiveCrew({
        title: thread.title || 'Announcement',
        body: `${senderName}: ${preview}`,
        url: `/w/chat/channel/${threadId}`,
        type: 'announcement',
        category: 'announcement',
      }).catch(err => {
        console.error('[Chat Push] Announcement fan-out failed:', err.message || err);
      });
    }
  } catch (e) {
    console.error('[Chat Push] Error in push notification block:', e.message || e);
  }

  // Return the created message with sender info
  const message = db.prepare(`
    SELECT m.id, m.thread_id, m.sender_id, m.body, m.message_type,
      m.reply_to_message_id, m.created_at, m.edited_at,
      u.full_name as sender_name, u.role as sender_role
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.id = ?
  `).get(messageId);

  message.attachments = [];
  if (attachment && attachment.file_url) {
    message.attachments = db.prepare('SELECT * FROM message_attachments WHERE message_id = ?').all(messageId);
  }

  res.json({ message });
});

// ============================================
// API: Soft-delete own message (JSON)
// ============================================
router.post('/api/threads/:threadId/messages/:msgId/delete', requireThreadMember, (req, res) => {
  const db = getDb();
  const msgId = req.params.msgId;
  const userId = req.session.user.id;

  const msg = db.prepare('SELECT sender_id FROM messages WHERE id = ? AND thread_id = ?').get(msgId, req.params.threadId);
  if (!msg) return res.status(404).json({ error: 'Message not found.' });
  if (msg.sender_id !== userId && req.session.user.role !== 'management') {
    return res.status(403).json({ error: 'You can only delete your own messages.' });
  }

  db.prepare('UPDATE messages SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(msgId);

  logActivity({
    user: req.session.user,
    action: 'delete',
    entityType: 'message',
    entityId: parseInt(msgId),
    entityLabel: 'Soft-deleted message',
    details: `Thread: ${req.params.threadId}`,
    ip: req.ip
  });

  res.json({ success: true });
});

// ============================================
// API: Mark thread as read (JSON)
// ============================================
router.post('/api/threads/:threadId/read', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;
  const userId = req.session.user.id;

  // Get the latest message ID in the thread
  const latest = db.prepare(
    'SELECT MAX(id) as max_id FROM messages WHERE thread_id = ? AND deleted_at IS NULL'
  ).get(threadId);

  if (latest && latest.max_id) {
    // Ensure membership row exists for management users
    const member = db.prepare('SELECT id FROM chat_thread_members WHERE thread_id = ? AND user_id = ?').get(threadId, userId);
    if (!member) {
      db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)').run(threadId, userId, 'member');
    }
    db.prepare(
      'UPDATE chat_thread_members SET last_read_message_id = ? WHERE thread_id = ? AND user_id = ?'
    ).run(latest.max_id, threadId, userId);
  }

  res.json({ success: true });
});

// ============================================
// API: Get thread members (for @mention autocomplete)
// ============================================
router.get('/api/threads/:threadId/members', requireThreadMember, (req, res) => {
  const db = getDb();
  const threadId = req.params.threadId;

  const members = db.prepare(`
    SELECT u.id, u.full_name, u.role, ctm.role_in_thread
    FROM chat_thread_members ctm
    JOIN users u ON ctm.user_id = u.id
    WHERE ctm.thread_id = ? AND u.active = 1
    ORDER BY u.full_name
  `).all(threadId);

  res.json({ members });
});

// ============================================
// API: Upload file (image or document) (JSON)
// ============================================
router.post('/api/upload', chatUpload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded or invalid file type. Allowed: images, PDF, Word, Excel, CSV, TXT.' });
  }

  // Verify thread membership (admin/management can access all)
  const threadId = req.body.thread_id;
  if (threadId && threadId !== 'general') {
    const db = getDb();
    const userRole = (req.session.user.role || '').toLowerCase();
    const isAdmin = ['admin', 'management'].includes(userRole);
    if (!isAdmin) {
      const member = db.prepare('SELECT 1 FROM chat_thread_members WHERE thread_id = ? AND user_id = ?').get(threadId, req.session.user.id);
      if (!member) {
        // Clean up uploaded file
        try { fs.unlinkSync(req.file.path); } catch (e) {}
        return res.status(403).json({ error: 'Not a member of this thread.' });
      }
    }
  }

  const threadDir = path.basename(req.file.destination);
  const fileUrl = `/uploads/chat/${threadDir}/${req.file.filename}`;
  const isImage = req.file.mimetype.startsWith('image/');

  // Generate thumbnail only for images
  if (isImage) {
    try {
      const sharp = require('sharp');
      const thumbFilename = 'thumb_' + req.file.filename;
      const thumbPath = path.join(req.file.destination, thumbFilename);
      await sharp(req.file.path)
        .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toFile(thumbPath);

      return res.json({
        file_url: fileUrl,
        thumbnail_url: `/uploads/chat/${threadDir}/${thumbFilename}`,
        mime_type: req.file.mimetype,
        file_size: req.file.size,
        original_name: req.file.originalname
      });
    } catch (err) {
      console.error('Image processing error:', err);
      // Fall through to generic response
    }
  }

  // Non-image files or image thumbnail failure
  res.json({
    file_url: fileUrl,
    thumbnail_url: '',
    mime_type: req.file.mimetype,
    file_size: req.file.size,
    original_name: req.file.originalname
  });
});

// ============================================
// API: Get unread count (lightweight, for badge polling)
// ============================================
router.get('/api/unread-count', (req, res) => {
  const { getTotalUnreadCount } = require('../lib/chat');
  const count = getTotalUnreadCount(req.session.user.id);
  res.json({ count });
});

// ============================================
// HTML: DM Conversation View
// ============================================
router.get('/dm/:userId', (req, res) => {
  const db = getDb();
  const { findOrCreateDM } = require('../lib/chat');
  const otherUserId = parseInt(req.params.userId);
  const currentUserId = req.session.user.id;

  if (otherUserId === currentUserId) {
    req.flash('error', 'Cannot message yourself.');
    return req.session.save(() => res.redirect('/chat'));
  }

  const otherUser = db.prepare('SELECT id, full_name, role FROM users WHERE id = ? AND active = 1').get(otherUserId);
  if (!otherUser) {
    req.flash('error', 'User not found.');
    return req.session.save(() => res.redirect('/chat'));
  }

  const chatThreadId = findOrCreateDM(currentUserId, otherUserId);

  res.render('chat/conversation', {
    title: `Chat with ${otherUser.full_name}`,
    currentPage: 'chat',
    chatThreadId,
    threadTitle: otherUser.full_name,
    threadSubtitle: otherUser.role,
    threadType: 'dm',
    canPost: true,
    backUrl: '/chat?tab=direct',
    user: req.session.user
  });
});

// ============================================
// HTML: Channel Conversation View
// ============================================
router.get('/channel/:id', requireThreadMember, (req, res) => {
  const db = getDb();
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ? AND thread_type IN (?, ?)').get(req.params.id, 'channel', 'announcement');
  if (!thread) {
    req.flash('error', 'Channel not found.');
    return req.session.save(() => res.redirect('/chat'));
  }

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_thread_members WHERE thread_id = ?').get(thread.id).c;
  const canPost = thread.thread_type === 'channel' || ['admin', 'operations'].includes(req.session.user.role);

  res.render('chat/conversation', {
    title: thread.title,
    currentPage: 'chat',
    chatThreadId: thread.id,
    threadTitle: thread.title,
    threadSubtitle: `${memberCount} members · ${thread.thread_type === 'announcement' ? 'Announcements' : 'Team Channel'}`,
    threadType: thread.thread_type,
    canPost,
    backUrl: '/chat?tab=channels',
    user: req.session.user
  });
});

// ============================================
// HTML: New Thread Form (admin/operations only)
// ============================================
router.get('/new', (req, res) => {
  const db = getDb();
  const canCreateOpsThread = ['admin', 'operations'].includes(req.session.user.role);
  const jobs = canCreateOpsThread ? db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status IN ('active','on_hold','won','prestart') ORDER BY job_number").all() : [];
  const incidents = canCreateOpsThread ? db.prepare(`
    SELECT i.id, i.incident_number, i.title, j.job_number
    FROM incidents i JOIN jobs j ON i.job_id = j.id
    WHERE i.investigation_status IN ('reported','investigating')
    ORDER BY i.incident_date DESC
  `).all() : [];
  const users = db.prepare("SELECT id, full_name, role FROM users WHERE active = 1 AND id != ? AND username != 'admin' ORDER BY full_name").all(req.session.user.id);
  res.render('chat/new', {
    title: 'New Message',
    currentPage: 'chat',
    jobs,
    incidents,
    users,
    canCreateOpsThread,
    user: req.session.user
  });
});

router.post('/new', (req, res) => {
  const db = getDb();
  const { thread_type, entity_id, dm_user_id, initial_message } = req.body;
  const { ensureThreadForEntity, addMembersToThread, postSystemMessage, findOrCreateDM } = require('../lib/chat');

  // DM creation — any user can do this
  if (thread_type === 'dm') {
    if (!dm_user_id) { req.flash('error', 'Please select a user.'); return req.session.save(() => res.redirect('/chat/new')); }
    const threadId = findOrCreateDM(req.session.user.id, parseInt(dm_user_id));
    if (initial_message && initial_message.trim()) {
      db.prepare('INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, ?, ?, ?)').run(threadId, req.session.user.id, initial_message.trim(), 'text');
      db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);
    }
    return req.session.save(() => res.redirect(`/chat/dm/${dm_user_id}`));
  }

  // Group chat creation — any user can do this
  if (thread_type === 'group') {
    const groupName = (req.body.group_name || '').trim();
    let memberIds = req.body.group_members || [];
    if (!Array.isArray(memberIds)) memberIds = [memberIds];
    memberIds = memberIds.map(Number).filter(Boolean);

    if (!groupName) { req.flash('error', 'Please enter a group name.'); return req.session.save(() => res.redirect('/chat/new')); }
    if (memberIds.length === 0) { req.flash('error', 'Please select at least one member.'); return req.session.save(() => res.redirect('/chat/new')); }

    // Always include the creator
    if (!memberIds.includes(req.session.user.id)) memberIds.push(req.session.user.id);

    const result = db.prepare("INSERT INTO chat_threads (thread_type, title, created_by, status) VALUES ('group', ?, ?, 'active')").run(groupName, req.session.user.id);
    const threadId = Number(result.lastInsertRowid);

    const addMemberStmt = db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)');
    addMemberStmt.run(threadId, req.session.user.id, 'admin');
    for (const uid of memberIds) {
      if (uid !== req.session.user.id) addMemberStmt.run(threadId, uid, 'member');
    }

    if (initial_message && initial_message.trim()) {
      db.prepare('INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, ?, ?, ?)').run(threadId, req.session.user.id, initial_message.trim(), 'text');
    } else {
      postSystemMessage(threadId, `Group created by ${req.session.user.full_name}`);
    }
    db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);

    req.flash('success', `Group "${groupName}" created.`);
    return req.session.save(() => res.redirect(`/chat/channel/${threadId}`));
  }

  // Channel creation — any user can do this
  if (thread_type === 'channel') {
    const channelName = (req.body.channel_name || '').trim();
    let memberIds = req.body.channel_members || [];
    if (!Array.isArray(memberIds)) memberIds = [memberIds];
    memberIds = memberIds.map(Number).filter(Boolean);

    if (!channelName) { req.flash('error', 'Please enter a channel name.'); return req.session.save(() => res.redirect('/chat/new')); }

    // Generate slug from name
    const slug = channelName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Check for duplicate slug
    const existing = db.prepare('SELECT id FROM chat_threads WHERE channel_slug = ?').get(slug);
    if (existing) { req.flash('error', 'A channel with that name already exists.'); return req.session.save(() => res.redirect('/chat/new')); }

    // Always include the creator
    if (!memberIds.includes(req.session.user.id)) memberIds.push(req.session.user.id);

    const result = db.prepare("INSERT INTO chat_threads (thread_type, title, channel_slug, created_by, status) VALUES ('channel', ?, ?, ?, 'active')").run(channelName, slug, req.session.user.id);
    const threadId = Number(result.lastInsertRowid);

    const addMemberStmt = db.prepare('INSERT OR IGNORE INTO chat_thread_members (thread_id, user_id, role_in_thread) VALUES (?, ?, ?)');
    addMemberStmt.run(threadId, req.session.user.id, 'admin');
    for (const uid of memberIds) {
      if (uid !== req.session.user.id) addMemberStmt.run(threadId, uid, 'member');
    }

    if (initial_message && initial_message.trim()) {
      db.prepare('INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, ?, ?, ?)').run(threadId, req.session.user.id, initial_message.trim(), 'text');
    } else {
      postSystemMessage(threadId, `Channel created by ${req.session.user.full_name}`);
    }
    db.prepare('UPDATE chat_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);

    req.flash('success', `Channel "#${channelName}" created.`);
    return req.session.save(() => res.redirect(`/chat/channel/${threadId}`));
  }

  // Operational threads — admin/operations only
  if (!['admin', 'operations'].includes(req.session.user.role)) {
    req.flash('error', 'You do not have permission to start operational threads.');
    return req.session.save(() => res.redirect('/chat'));
  }

  if (!entity_id || !thread_type) {
    req.flash('error', 'Please select a thread type and item.');
    return req.session.save(() => res.redirect('/chat/new'));
  }

  let title, redirectUrl;
  if (thread_type === 'job') {
    const job = db.prepare('SELECT id, job_number, project_manager_id, ops_supervisor_id, planning_owner_id, marketing_owner_id, accounts_owner_id FROM jobs WHERE id = ?').get(entity_id);
    if (!job) { req.flash('error', 'Job not found.'); return req.session.save(() => res.redirect('/chat/new')); }
    title = `Job ${job.job_number}`;
    redirectUrl = `/jobs/${job.id}#chat`;
    const threadId = ensureThreadForEntity('job', job.id, title, req.session.user.id);
    const memberIds = [...new Set([req.session.user.id, job.project_manager_id, job.ops_supervisor_id, job.planning_owner_id, job.marketing_owner_id, job.accounts_owner_id].filter(Boolean))];
    addMembersToThread(threadId, memberIds, 'member', true);
    if (initial_message && initial_message.trim()) {
      db.prepare('INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, ?, ?, ?)').run(threadId, req.session.user.id, initial_message.trim(), 'text');
    } else {
      postSystemMessage(threadId, `Thread started by ${req.session.user.full_name}`);
    }
  } else if (thread_type === 'incident') {
    const incident = db.prepare('SELECT i.id, i.incident_number, i.reported_by_id, i.job_id, j.project_manager_id, j.ops_supervisor_id FROM incidents i JOIN jobs j ON i.job_id = j.id WHERE i.id = ?').get(entity_id);
    if (!incident) { req.flash('error', 'Incident not found.'); return req.session.save(() => res.redirect('/chat/new')); }
    title = `Incident ${incident.incident_number}`;
    redirectUrl = `/incidents/${incident.id}#chat`;
    const threadId = ensureThreadForEntity('incident', incident.id, title, req.session.user.id);
    const memberIds = [...new Set([req.session.user.id, incident.reported_by_id, incident.project_manager_id, incident.ops_supervisor_id].filter(Boolean))];
    addMembersToThread(threadId, memberIds, 'member', true);
    if (initial_message && initial_message.trim()) {
      db.prepare('INSERT INTO messages (thread_id, sender_id, body, message_type) VALUES (?, ?, ?, ?)').run(threadId, req.session.user.id, initial_message.trim(), 'text');
    } else {
      postSystemMessage(threadId, `Thread started by ${req.session.user.full_name}`);
    }
  } else {
    req.flash('error', 'Invalid thread type.');
    return req.session.save(() => res.redirect('/chat/new'));
  }

  req.flash('success', `Thread created for ${title}.`);
  req.session.save(() => res.redirect(redirectUrl));
});

// ============================================
// API: Search within a thread
// ============================================
router.get('/api/threads/:threadId/search', requireThreadMember, (req, res) => {
  const db = getDb();
  const q = req.query.q || '';
  if (!q || q.length < 2) return res.json({ messages: [] });

  const messages = db.prepare(`
    SELECT m.id, m.body, m.created_at, m.sender_id, u.full_name as sender_name
    FROM messages m LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.thread_id = ? AND m.deleted_at IS NULL AND m.body LIKE ?
    ORDER BY m.created_at DESC LIMIT 20
  `).all(req.params.threadId, `%${q}%`);
  res.json({ messages });
});

// ============================================
// API: Mute / unmute a thread
// ============================================
router.post('/api/threads/:threadId/mute', requireThreadMember, (req, res) => {
  const db = getDb();
  const userId = req.session.user ? req.session.user.id : (req.session.worker ? req.session.worker.id : null);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const member = db.prepare('SELECT muted_at FROM chat_thread_members WHERE thread_id = ? AND user_id = ?').get(req.params.threadId, userId);
  if (!member) return res.status(404).json({ error: 'Not a member' });

  if (member.muted_at) {
    db.prepare('UPDATE chat_thread_members SET muted_at = NULL WHERE thread_id = ? AND user_id = ?').run(req.params.threadId, userId);
    res.json({ muted: false });
  } else {
    db.prepare('UPDATE chat_thread_members SET muted_at = CURRENT_TIMESTAMP WHERE thread_id = ? AND user_id = ?').run(req.params.threadId, userId);
    res.json({ muted: true });
  }
});

// ============================================
// API: Pin / unpin a message (admin/operations only)
// ============================================
router.post('/api/threads/:threadId/messages/:msgId/pin', requireThreadMember, (req, res) => {
  const db = getDb();
  const userRole = req.session.user ? req.session.user.role : '';
  if (!['admin', 'operations'].includes(userRole)) {
    return res.status(403).json({ error: 'Only admin and operations can pin messages.' });
  }

  const msg = db.prepare('SELECT id, pinned_at FROM messages WHERE id = ? AND thread_id = ?').get(req.params.msgId, req.params.threadId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  if (msg.pinned_at) {
    db.prepare('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?').run(msg.id);
    res.json({ pinned: false });
  } else {
    const userId = req.session.user.id;
    db.prepare('UPDATE messages SET pinned_at = CURRENT_TIMESTAMP, pinned_by = ? WHERE id = ?').run(userId, msg.id);
    res.json({ pinned: true });
  }
});

// ============================================
// API: Edit own message (5-minute window)
// ============================================
router.post('/api/threads/:threadId/messages/:msgId/edit', requireThreadMember, (req, res) => {
  const db = getDb();
  const userId = req.session.user ? req.session.user.id : (req.session.worker ? req.session.worker.id : null);
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message body required' });

  const msg = db.prepare('SELECT id, sender_id, created_at FROM messages WHERE id = ? AND thread_id = ? AND deleted_at IS NULL').get(req.params.msgId, req.params.threadId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.sender_id !== userId) return res.status(403).json({ error: 'Can only edit your own messages' });

  // Check 5-minute window
  const created = new Date(msg.created_at + 'Z');
  const now = new Date();
  if (now - created > 5 * 60 * 1000) {
    return res.status(403).json({ error: 'Can only edit messages within 5 minutes of sending' });
  }

  db.prepare('UPDATE messages SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?').run(body.trim(), msg.id);
  res.json({ success: true, body: body.trim() });
});

// ============================================
// API: Typing indicator (set)
// ============================================
router.post('/api/threads/:threadId/typing', requireThreadMember, (req, res) => {
  const threadId = req.params.threadId;
  const userId = req.session.user ? req.session.user.id : (req.session.worker ? req.session.worker.id : null);
  const userName = req.session.user ? req.session.user.full_name : (req.session.worker ? req.session.worker.full_name : 'Someone');

  if (!typingUsers.has(threadId)) typingUsers.set(threadId, new Map());
  typingUsers.get(threadId).set(String(userId), { name: userName, ts: Date.now() });
  res.json({ ok: true });
});

// ============================================
// API: Typing indicator (get who's typing)
// ============================================
router.get('/api/threads/:threadId/typing', requireThreadMember, (req, res) => {
  const threadId = req.params.threadId;
  const userId = req.session.user ? req.session.user.id : (req.session.worker ? req.session.worker.id : null);
  const now = Date.now();
  const typing = [];

  if (typingUsers.has(threadId)) {
    for (const [uid, data] of typingUsers.get(threadId)) {
      if (uid !== String(userId) && now - data.ts < 5000) {
        typing.push(data.name);
      }
    }
    // Clean up stale entries
    for (const [uid, data] of typingUsers.get(threadId)) {
      if (now - data.ts > 10000) typingUsers.get(threadId).delete(uid);
    }
  }

  res.json({ typing });
});

// ============================================
// API: Get read receipts for a thread (DMs)
// ============================================
router.get('/api/threads/:threadId/read-receipts', requireThreadMember, (req, res) => {
  const db = getDb();
  const receipts = db.prepare(`
    SELECT ctm.user_id, ctm.last_read_message_id, u.full_name
    FROM chat_thread_members ctm
    JOIN users u ON ctm.user_id = u.id
    WHERE ctm.thread_id = ?
  `).all(req.params.threadId);
  res.json({ receipts });
});

// ============================================
// API: Get pinned messages for a thread
// ============================================
router.get('/api/threads/:threadId/pinned', requireThreadMember, (req, res) => {
  const db = getDb();
  const pinned = db.prepare(`
    SELECT m.id, m.body, m.created_at, m.pinned_at, u.full_name as sender_name, pu.full_name as pinned_by_name
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN users pu ON m.pinned_by = pu.id
    WHERE m.thread_id = ? AND m.pinned_at IS NOT NULL AND m.deleted_at IS NULL
    ORDER BY m.pinned_at DESC
  `).all(req.params.threadId);
  res.json({ pinned });
});

module.exports = router;
