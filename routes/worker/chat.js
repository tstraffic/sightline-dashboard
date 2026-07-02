const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const { findOrCreateDM, getTotalUnreadCount } = require('../../lib/chat');

// ─────────────────────────────────────────────────────────────────────────
// Worker chat is DISABLED until it is properly built for crew identities.
//
// The chat schema keys membership/senders on users.id, but worker sessions
// carry crew_members.id. Consequences of leaving these routes live:
//   1. GET /w/chat/dm/:userId → findOrCreateDM inserts the crew id into
//      chat_thread_members.user_id → FK constraint → 500 for most workers.
//   2. If a crew id NUMERICALLY COLLIDES with a users.id, the inbox query
//      (WHERE ctm.user_id = <crew id>) lists that admin user's threads —
//      a cross-identity privacy leak.
//   3. Even inside a thread, the message API lives under /chat (admin
//      requireLogin), which redirects worker sessions away — workers can
//      never load or send messages.
//
// So every /w/chat* route short-circuits to a friendly placeholder. The
// original handlers are preserved below (dead code path) as the starting
// point for the future crew-aware build.
const CHAT_ENABLED_FOR_WORKERS = false;

router.use('/chat', (req, res, next) => {
  if (CHAT_ENABLED_FOR_WORKERS) return next();
  res.render('worker/chat-unavailable', {
    title: 'Messages',
    currentPage: 'chat',
    worker: req.session.worker,
  });
});

// Worker Chat Inbox
router.get('/chat', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;

  // Workers see: their DMs + channels they're in + job threads for assigned jobs
  // Use crew_member ID to find threads (workers are crew_members, not users)
  // But chat uses user IDs — we need to check if workers have a linked user account
  // For now, worker.id IS the crew_member.id, and they're added to threads via that ID

  const threads = db.prepare(`
    SELECT ct.*,
      (SELECT m.body FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message,
      (SELECT m.created_at FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_at,
      (SELECT u.full_name FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_sender,
      (SELECT m.message_type FROM messages m WHERE m.thread_id = ct.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_message_type,
      (SELECT COUNT(m.id) FROM messages m WHERE m.thread_id = ct.id AND m.id > COALESCE(ctm.last_read_message_id, 0) AND m.deleted_at IS NULL AND (m.sender_id != ctm.user_id OR m.sender_id IS NULL)) as unread_count
    FROM chat_thread_members ctm
    JOIN chat_threads ct ON ct.id = ctm.thread_id
    WHERE ctm.user_id = ? AND ct.status = 'active'
    ORDER BY last_message_at DESC NULLS LAST, ct.created_at DESC
  `).all(workerId);

  // Resolve DM other user names
  for (const t of threads) {
    if (t.thread_type === 'dm') {
      const otherUser = db.prepare(`
        SELECT u.id, u.full_name, u.role FROM chat_thread_members ctm
        JOIN users u ON ctm.user_id = u.id
        WHERE ctm.thread_id = ? AND ctm.user_id != ? LIMIT 1
      `).get(t.id, workerId);
      t.dm_user = otherUser || null;
    }
  }

  const unreadTotal = getTotalUnreadCount(workerId);

  res.render('worker/chat', {
    title: 'Messages',
    currentPage: 'chat',
    threads,
    unreadTotal,
    worker: req.session.worker
  });
});

// Worker DM Conversation
router.get('/chat/dm/:userId', (req, res) => {
  const db = getDb();
  const workerId = req.session.worker.id;
  const otherUserId = parseInt(req.params.userId);

  const otherUser = db.prepare('SELECT id, full_name, role FROM users WHERE id = ?').get(otherUserId);
  if (!otherUser) {
    req.flash('error', 'User not found.');
    return res.redirect('/w/chat');
  }

  const chatThreadId = findOrCreateDM(workerId, otherUserId);

  res.render('worker/chat-conversation', {
    title: otherUser.full_name,
    currentPage: 'chat',
    chatThreadId,
    threadTitle: otherUser.full_name,
    threadType: 'dm',
    worker: req.session.worker
  });
});

// Worker Channel View
router.get('/chat/channel/:id', (req, res) => {
  const db = getDb();
  const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ? AND thread_type IN (?, ?)').get(req.params.id, 'channel', 'announcement');
  if (!thread) {
    req.flash('error', 'Channel not found.');
    return res.redirect('/w/chat');
  }

  const memberCount = db.prepare('SELECT COUNT(*) as c FROM chat_thread_members WHERE thread_id = ?').get(thread.id).c;
  const canPost = thread.thread_type === 'channel'; // Workers can't post in announcements

  res.render('worker/chat-conversation', {
    title: thread.title,
    currentPage: 'chat',
    chatThreadId: thread.id,
    threadTitle: thread.title,
    threadType: thread.thread_type,
    canPost,
    worker: req.session.worker
  });
});

module.exports = router;
