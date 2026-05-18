// Worker portal — birthday wishes.
//
// GET  /w/birthday/:targetId — the wish page for a coworker whose birthday
//                              is today. Shows the form (or "Already wished"
//                              state) plus the full message wall.
// POST /w/birthday/:targetId — submit one wish. UNIQUE constraint on
//                              (from, target, birthday_date) means a worker
//                              can only post one message per coworker per
//                              birthday — the server enforces this even if
//                              the UI is bypassed.
//
// Auth: mounted under /w which requires `requireWorker` middleware (see
// server.js), so req.session.worker.id is always set.

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../../db/database');
const {
  todaysBirthdays, messagesForBirthday, hasMessaged, addMessage, localIso,
} = require('../../lib/birthdays');
const { sendPushToCrew } = require('../../services/pushNotification');

function findTodayBirthday(db, targetId) {
  return todaysBirthdays(db).find(b => b.crew_member_id === Number(targetId));
}

// GET /w/birthday/:targetId — wish a coworker on their birthday
router.get('/birthday/:targetId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const targetId = parseInt(req.params.targetId, 10);
  if (!targetId) return res.redirect('/w/home');

  const target = findTodayBirthday(db, targetId);
  if (!target) {
    // Not actually a birthday today (or worker not active) — soft redirect
    req.flash('error', "That isn't a birthday today.");
    return res.redirect('/w/home');
  }

  const today = localIso();
  const messages = messagesForBirthday(db, target.crew_member_id, today);
  const alreadyWished = hasMessaged(db, worker.id, target.crew_member_id, today);
  const isSelf = worker.id === target.crew_member_id;

  res.render('worker/birthday-wish', {
    title: `Wish ${target.full_name.split(' ')[0]} a happy birthday`,
    currentPage: 'home',
    target, messages, alreadyWished, isSelf, today,
  });
});

// POST /w/birthday/:targetId — submit a wish
router.post('/birthday/:targetId', (req, res) => {
  const db = getDb();
  const worker = req.session.worker;
  const targetId = parseInt(req.params.targetId, 10);
  if (!targetId) return res.redirect('/w/home');

  const target = findTodayBirthday(db, targetId);
  if (!target) {
    req.flash('error', "That isn't a birthday today.");
    return res.redirect('/w/home');
  }

  if (worker.id === target.crew_member_id) {
    // Can't wish yourself.
    req.flash('error', "You can't wish yourself — enjoy the day!");
    return res.redirect(`/w/birthday/${targetId}`);
  }

  const message = (req.body.message || '').toString().trim().slice(0, 500);
  if (!message) {
    req.flash('error', 'Write a quick message before sending.');
    return res.redirect(`/w/birthday/${targetId}`);
  }

  const today = localIso();
  const newId = addMessage(db, worker.id, target.crew_member_id, today, message);
  if (!newId) {
    // UNIQUE constraint — they already wished this person today
    req.flash('error', "You've already wished them today.");
    return res.redirect(`/w/birthday/${targetId}`);
  }

  // Fan the wish straight to the birthday person's device(s). Fire-and-
  // forget — push delivery failures shouldn't block the redirect.
  sendPushToCrew(target.crew_member_id, {
    title: `🎉 ${worker.full_name.split(' ')[0]} wished you a happy birthday!`,
    body: message.length > 90 ? message.slice(0, 87) + '…' : message,
    url: '/w/home',
    type: 'birthday_wish',
    category: 'birthday',
  }).catch(e => console.error('[birthday] push failed:', e.message));

  req.flash('success', `Wish sent to ${target.full_name.split(' ')[0]} 🎂`);
  res.redirect(`/w/birthday/${targetId}`);
});

module.exports = router;
