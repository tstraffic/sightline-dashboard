const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../../db/database');
const {
  sendKudos, getFeed, getKudosWithComments, toggleReaction, addComment,
  generateMilestones, getRecentMilestones, getLeaderboard, getProfileSummary,
  hideKudos, reportKudos, blockUser, unblockUser, deleteKudos, getActiveValues,
  containsProfanity, isQuietHours, RATE_LIMIT_PER_DAY,
} = require('../../services/kudos');

let sendPushToUser = null;
try { ({ sendPushToUser } = require('../../services/pushNotification')); } catch (e) {}

const UPLOAD_BASE = path.join(__dirname, '..', '..', 'data', 'uploads', 'kudos');

const photoStorage = multer.diskStorage({
  destination: (req, file, cb) => { fs.mkdirSync(UPLOAD_BASE, { recursive: true }); cb(null, UPLOAD_BASE); },
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname || '.jpg') || '.jpg').toLowerCase();
    cb(null, `k_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const photoUpload = multer({
  storage: photoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp|heic)$/i.test(file.mimetype)) return cb(new Error('JPEG, PNG, WEBP or HEIC images only'));
    cb(null, true);
  }
});

function wantsJson(req) {
  return req.xhr || (req.headers.accept || '').includes('application/json');
}

// Push helper: notify a worker's linked user account; respect quiet hours
async function notifyRecipient(recipientCrewId, title, body, link) {
  if (!sendPushToUser) return;
  if (isQuietHours()) return;
  try {
    const db = getDb();
    const emp = db.prepare('SELECT linked_user_id FROM employees WHERE linked_crew_member_id = ?').get(recipientCrewId);
    if (emp && emp.linked_user_id) await sendPushToUser(emp.linked_user_id, { title, body, url: link });
  } catch (e) { /* best effort */ }
}

// ====================================================
// GET /w/feed — Team feed with optional filter + paging
// ====================================================
router.get('/feed', (req, res) => {
  const viewerCrewId = req.session.worker.id;
  const filter = ['all','team','mentions','mine'].includes(req.query.filter) ? req.query.filter : 'all';
  const beforeId = parseInt(req.query.before, 10) || null;

  // Opportunistic milestone generation for the viewer
  try { generateMilestones([viewerCrewId]); } catch (e) { /* ignore */ }

  const feed = getFeed({ viewerCrewId, filter, beforeId, limit: 20 });
  const values = getActiveValues();

  if (req.query.partial === '1' || wantsJson(req)) {
    return res.render('worker/_feed_items', { layout: false, items: feed.items, viewerCrewId }, (err, html) => {
      if (err) return res.status(500).json({ ok: false, error: err.message });
      res.json({ ok: true, html, nextBefore: feed.nextBefore });
    });
  }

  const milestones = getRecentMilestones({ limit: 5 });

  // NOTE: no flash re-read here — workerLocals already consumed req.flash()
  // into res.locals; reading again returns [] and shadows the real message,
  // which is why "Kudos sent!" never showed. The layout renders the banner.
  res.render('worker/feed', {
    title: 'Team feed', currentPage: 'feed',
    items: feed.items, nextBefore: feed.nextBefore,
    filter, values, milestones, viewerCrewId,
  });
});

// ====================================================
// GET /w/feed/new — Send kudos form
// ====================================================
router.get('/feed/new', (req, res) => {
  const db = getDb();
  const values = getActiveValues();
  // Active crew for recipient picker
  const crew = db.prepare('SELECT id, full_name, employee_id FROM crew_members WHERE active = 1 AND id != ? ORDER BY full_name').all(req.session.worker.id);
  res.render('worker/feed-new', {
    title: 'Send kudos', currentPage: 'feed',
    values, crew,
  });
});

// ====================================================
// POST /w/feed/send — Submit a new kudos
// ====================================================
router.post('/feed/send', (req, res) => {
  photoUpload.single('photo')(req, res, async function (err) {
    if (err) { req.flash('error', err.message); return res.redirect('/w/feed/new'); }
    try {
      let recipients = req.body.recipient_crew_id;
      if (!Array.isArray(recipients)) recipients = recipients ? [recipients] : [];
      recipients = recipients.map(r => parseInt(r, 10)).filter(Boolean);

      const valueId = req.body.value_id ? parseInt(req.body.value_id, 10) : null;
      const message = req.body.message || '';
      const visibility = req.body.visibility || 'public';
      const allowProfanity = req.body.allow_profanity === '1';
      const photoUrl = req.file ? `/data/uploads/kudos/${req.file.filename}` : null;

      const { id, recipientCount } = sendKudos({
        senderCrewId: req.session.worker.id,
        recipientCrewIds: recipients,
        valueId, message, photoUrl, visibility, allowProfanity,
      });

      // Notify recipients
      const link = `/w/feed#kudos-${id}`;
      const senderFirst = (req.session.worker.full_name || '').split(' ')[0];
      for (const r of recipients) {
        await notifyRecipient(r, `${senderFirst} sent you kudos 👏`, message.slice(0, 120), link);
      }

      req.flash('success', recipientCount === 1 ? 'Kudos sent!' : `Kudos sent to ${recipientCount} teammates!`);
      // Persist the flash before the browser follows the redirect — same
      // session-store race the logins guard against; without this the
      // "Kudos sent!" banner silently vanished.
      req.session.save(() => res.redirect('/w/feed'));
    } catch (e) {
      if (e.message === 'PROFANITY') {
        req.flash('error', 'Your message contains language we filter by default. Tick "send anyway" to confirm.');
      } else {
        req.flash('error', e.message);
      }
      req.session.save(() => res.redirect('/w/feed/new'));
    }
  });
});

// ====================================================
// POST /w/feed/:id/react — Toggle reaction
// ====================================================
router.post('/feed/:id/react', (req, res) => {
  try {
    const out = toggleReaction({ kudosId: parseInt(req.params.id, 10), crewId: req.session.worker.id, reactionType: req.body.type });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// ====================================================
// POST /w/feed/:id/comment — Add comment
// ====================================================
router.post('/feed/:id/comment', async (req, res) => {
  try {
    const msg = req.body.message || '';
    if (containsProfanity(msg) && req.body.allow_profanity !== '1') {
      if (wantsJson(req)) return res.status(400).json({ ok: false, error: 'PROFANITY' });
      req.flash('error', 'Comment contains filtered language');
      return res.redirect('/w/feed/' + req.params.id);
    }
    const { id } = addComment({
      kudosId: parseInt(req.params.id, 10),
      crewId: req.session.worker.id,
      message: msg,
      parentCommentId: req.body.parent_comment_id ? parseInt(req.body.parent_comment_id, 10) : null,
    });
    // Notify original kudos sender (unless the commenter is the sender)
    const db = getDb();
    const k = db.prepare('SELECT sender_crew_id FROM kudos WHERE id = ?').get(req.params.id);
    if (k && k.sender_crew_id !== req.session.worker.id) {
      await notifyRecipient(k.sender_crew_id, 'New comment on your kudos', msg.slice(0, 120), `/w/feed/${req.params.id}`);
    }
    if (wantsJson(req)) return res.json({ ok: true, id });
    res.redirect('/w/feed/' + req.params.id);
  } catch (e) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: e.message });
    req.flash('error', e.message);
    res.redirect('/w/feed/' + req.params.id);
  }
});

// ====================================================
// GET /w/feed/:id — Single kudos with comments
// ====================================================
router.get('/feed/:id', (req, res) => {
  const k = getKudosWithComments({ kudosId: parseInt(req.params.id, 10), viewerCrewId: req.session.worker.id });
  if (!k) return res.status(404).render('worker/feed-not-found', { title: 'Not found', currentPage: 'feed', layout: 'worker/layout' });
  res.render('worker/feed-detail', {
    title: 'Kudos', currentPage: 'feed',
    k, viewerCrewId: req.session.worker.id,
  });
});

// ====================================================
// POST /w/feed/:id/delete — Sender retracts their own kudos
// ====================================================
router.post('/feed/:id/delete', (req, res) => {
  try {
    deleteKudos({ kudosId: parseInt(req.params.id, 10), crewId: req.session.worker.id });
    if (wantsJson(req)) return res.json({ ok: true });
    req.flash('success', 'Kudos deleted.');
  } catch (e) {
    if (wantsJson(req)) return res.status(400).json({ ok: false, error: e.message });
    req.flash('error', e.message);
  }
  req.session.save(() => res.redirect('/w/feed'));
});

// ====================================================
// POST /w/feed/:id/report — Report kudos
// ====================================================
router.post('/feed/:id/report', (req, res) => {
  reportKudos({ kudosId: parseInt(req.params.id, 10), reporterCrewId: req.session.worker.id, reason: req.body.reason || '' });
  if (wantsJson(req)) return res.json({ ok: true });
  req.flash('success', 'Reported to admin — thanks for flagging.');
  req.session.save(() => res.redirect('/w/feed'));
});

// ====================================================
// POST /w/feed/block — Block another worker
// ====================================================
router.post('/feed/block', (req, res) => {
  const blockedId = parseInt(req.body.crew_id, 10);
  try {
    blockUser({ blockerCrewId: req.session.worker.id, blockedCrewId: blockedId });
    req.flash('success', 'User blocked');
  } catch (e) { req.flash('error', e.message); }
  req.session.save(() => res.redirect('/w/feed'));
});

// ====================================================
// GET /w/feed/leaderboard — Leaderboard
// ====================================================
router.get('/leaderboard', (req, res) => {
  const windowKey = ['month','quarter','all'].includes(req.query.w) ? req.query.w : 'month';
  const cats = [
    { key: 'received', label: 'Most kudos received', suffix: 'kudos' },
    { key: 'sent', label: 'Most kudos sent', suffix: 'kudos' },
    { key: 'hours', label: 'Most hours worked', suffix: 'hrs' },
  ];
  const boards = cats.map(c => ({ ...c, rows: getLeaderboard({ window: windowKey, category: c.key, limit: 10 }) }));
  const db = getDb();
  const optedOut = !!db.prepare('SELECT 1 FROM leaderboard_optouts WHERE crew_member_id = ?').get(req.session.worker.id);
  res.render('worker/leaderboard', {
    title: 'Leaderboard', currentPage: 'feed',
    windowKey, boards, optedOut,
  });
});

// ====================================================
// POST /w/leaderboard/optout — Toggle opt-out
// ====================================================
router.post('/leaderboard/optout', (req, res) => {
  const db = getDb();
  const id = req.session.worker.id;
  const row = db.prepare('SELECT 1 FROM leaderboard_optouts WHERE crew_member_id = ?').get(id);
  if (row) db.prepare('DELETE FROM leaderboard_optouts WHERE crew_member_id = ?').run(id);
  else db.prepare('INSERT INTO leaderboard_optouts (crew_member_id) VALUES (?)').run(id);
  req.flash('success', row ? 'Opted back in — you will appear on the leaderboard.' : 'Opted out of the leaderboard.');
  req.session.save(() => res.redirect('/w/leaderboard'));
});

module.exports = router;
