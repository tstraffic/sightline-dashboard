// /safety-quizzes — office CRUD for Safety Quizzes (Phase 3a).
//
// Workers take quizzes via /w/safety/quizzes.
//
// Question types in v1:
//   - mcq_single   single-correct multi-choice (radio buttons)
//   - true_false   yes/no
// options_json on the question row stores the structure:
//   mcq_single   [{ "text": "..." }, { "text": "..." }, ...]
//   true_false   not used (the worker UI shows fixed True/False)
// correct_value:
//   mcq_single   "0", "1", ... (0-based option index, stored as TEXT)
//   true_false   "true" / "false"
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sendPushToAllActiveCrew } = require('../services/pushNotification');

const STATUS_VALUES = ['draft', 'published', 'archived'];
const STATUS_LABELS = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const SOURCE_LABELS = { toolbox: 'Toolbox', swms: 'SWMS', update: 'Safety Update' };

function safeJson(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

function announcePublished(req, quiz) {
  sendPushToAllActiveCrew({
    title: 'New quiz: ' + quiz.title,
    body: 'Tap to start the safety knowledge check.',
    url: '/w/safety/quizzes/' + quiz.id,
    type: 'safety_quiz',
    category: 'quiz',
  }).catch(e => console.error('[safety-quizzes] push error:', e.message));
  try {
    logActivity({
      user: req.session.user, action: 'publish', entityType: 'safety_quiz',
      entityId: quiz.id, entityLabel: quiz.title, ip: req.ip,
    });
  } catch (e) {}
}

// GET /safety-quizzes — list with status tabs + per-quiz stats
router.get('/', (req, res) => {
  const db = getDb();
  const status = STATUS_VALUES.includes(req.query.status) ? req.query.status : 'published';
  const rows = db.prepare(`
    SELECT q.*, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM safety_quiz_questions WHERE quiz_id = q.id) AS question_count,
      (SELECT COUNT(DISTINCT crew_member_id) FROM safety_quiz_attempts
        WHERE quiz_id = q.id AND status = 'submitted' AND passed = 1) AS passed_workers
    FROM safety_quizzes q
    LEFT JOIN users u ON u.id = q.created_by_id
    WHERE q.status = ?
    ORDER BY q.published_at DESC, q.created_at DESC
  `).all(status);
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='draft'     THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) AS published,
      SUM(CASE WHEN status='archived'  THEN 1 ELSE 0 END) AS archived
    FROM safety_quizzes
  `).get();
  res.render('safety-quizzes/index', {
    title: 'Safety Quizzes', currentPage: 'safety-quizzes',
    rows, counts, status, statusLabels: STATUS_LABELS, sourceLabels: SOURCE_LABELS,
  });
});

function loadSourceChoices(db) {
  return {
    toolboxes: db.prepare("SELECT id, title FROM toolbox_talks WHERE status = 'published' ORDER BY held_at DESC LIMIT 50").all(),
    swmsList:  db.prepare("SELECT id, title FROM swms WHERE status = 'active' ORDER BY title LIMIT 50").all(),
    updates:   db.prepare("SELECT id, title FROM safety_updates WHERE status = 'published' ORDER BY published_at DESC LIMIT 50").all(),
  };
}

// GET /safety-quizzes/new — quiz metadata form
router.get('/new', (req, res) => {
  const db = getDb();
  const choices = loadSourceChoices(db);
  res.render('safety-quizzes/form', {
    title: 'New Quiz', currentPage: 'safety-quizzes',
    quiz: null, isEdit: false, ...choices,
  });
});

function parseQuizForm(b) {
  const passMark = Math.min(100, Math.max(0, parseInt(b.pass_mark, 10) || 80));
  const retakePolicy = ['none','unlimited','limited'].includes(b.retake_policy) ? b.retake_policy : 'unlimited';
  const retakeLimit = retakePolicy === 'limited' ? (parseInt(b.retake_limit, 10) || 1) : null;
  let deadlineAt = null;
  if (b.deadline_at && /^\d{4}-\d{2}-\d{2}/.test(b.deadline_at)) {
    deadlineAt = b.deadline_at.length === 10 ? b.deadline_at + 'T23:59:59' : b.deadline_at;
  }
  const isMandatory = (b.is_mandatory === 'on' || b.is_mandatory === '1') ? 1 : 0;
  let sourceType = null, sourceId = null;
  if (b.source && /^(toolbox|swms|update):\d+$/.test(b.source)) {
    const [t, id] = b.source.split(':');
    sourceType = t;
    sourceId = parseInt(id, 10);
  }
  return { passMark, retakePolicy, retakeLimit, deadlineAt, isMandatory, sourceType, sourceId };
}

// POST /safety-quizzes — create as draft (publishing happens after questions are added)
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const title = String(b.title || '').trim();
    if (!title) {
      req.flash('error', 'Title is required.');
      return res.redirect('/safety-quizzes/new');
    }
    const p = parseQuizForm(b);
    const userId = req.session.user ? req.session.user.id : null;
    const r = db.prepare(`
      INSERT INTO safety_quizzes
        (title, description, pass_mark, retake_policy, retake_limit, deadline_at, is_mandatory,
         source_type, source_id, status, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)
    `).run(
      title, String(b.description || '').trim(),
      p.passMark, p.retakePolicy, p.retakeLimit, p.deadlineAt, p.isMandatory,
      p.sourceType, p.sourceId, userId
    );
    try { logActivity({ user: req.session.user, action: 'create', entityType: 'safety_quiz', entityId: r.lastInsertRowid, entityLabel: title, ip: req.ip }); } catch (e) {}
    req.flash('success', 'Quiz created. Add questions below before publishing.');
    return res.redirect('/safety-quizzes/' + r.lastInsertRowid + '/questions');
  } catch (err) {
    console.error('[safety-quizzes POST]', err);
    req.flash('error', 'Could not create quiz: ' + err.message);
    return res.redirect('/safety-quizzes/new');
  }
});

// GET /safety-quizzes/:id — show with attempt stats
router.get('/:id', (req, res) => {
  const db = getDb();
  const quiz = db.prepare(`
    SELECT q.*, u.full_name AS created_by_name, pu.full_name AS published_by_name
    FROM safety_quizzes q
    LEFT JOIN users u ON u.id = q.created_by_id
    LEFT JOIN users pu ON pu.id = q.published_by_id
    WHERE q.id = ?
  `).get(req.params.id);
  if (!quiz) { req.flash('error', 'Quiz not found.'); return res.redirect('/safety-quizzes'); }
  const questions = db.prepare(`SELECT id, question_text, question_type, sort_order FROM safety_quiz_questions WHERE quiz_id = ? ORDER BY sort_order ASC, id ASC`).all(quiz.id);
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM crew_members WHERE active = 1) AS total_crew,
      (SELECT COUNT(DISTINCT crew_member_id) FROM safety_quiz_attempts WHERE quiz_id = ? AND status = 'submitted' AND passed = 1) AS passed_workers,
      (SELECT COUNT(DISTINCT crew_member_id) FROM safety_quiz_attempts WHERE quiz_id = ? AND status = 'submitted') AS attempted_workers,
      (SELECT AVG(score_pct) FROM safety_quiz_attempts WHERE quiz_id = ? AND status = 'submitted') AS avg_score
  `).get(quiz.id, quiz.id, quiz.id);
  // Resolve source title for display.
  let sourceLabel = null;
  if (quiz.source_type === 'toolbox') sourceLabel = (db.prepare('SELECT title FROM toolbox_talks WHERE id = ?').get(quiz.source_id) || {}).title;
  if (quiz.source_type === 'swms')    sourceLabel = (db.prepare('SELECT title FROM swms WHERE id = ?').get(quiz.source_id) || {}).title;
  if (quiz.source_type === 'update')  sourceLabel = (db.prepare('SELECT title FROM safety_updates WHERE id = ?').get(quiz.source_id) || {}).title;
  res.render('safety-quizzes/show', {
    title: quiz.title, currentPage: 'safety-quizzes',
    quiz, questions, stats, sourceLabel,
    statusLabels: STATUS_LABELS, sourceLabels: SOURCE_LABELS,
  });
});

// GET /safety-quizzes/:id/edit — metadata edit
router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) { req.flash('error', 'Quiz not found.'); return res.redirect('/safety-quizzes'); }
  const choices = loadSourceChoices(db);
  res.render('safety-quizzes/form', {
    title: 'Edit Quiz', currentPage: 'safety-quizzes',
    quiz, isEdit: true, ...choices,
  });
});

router.post('/:id', (req, res) => {
  try {
    const db = getDb();
    const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
    if (!quiz) { req.flash('error', 'Not found.'); return res.redirect('/safety-quizzes'); }
    const b = req.body;
    const title = String(b.title || '').trim() || quiz.title;
    const p = parseQuizForm(b);
    db.prepare(`
      UPDATE safety_quizzes
      SET title = ?, description = ?, pass_mark = ?, retake_policy = ?, retake_limit = ?,
          deadline_at = ?, is_mandatory = ?, source_type = ?, source_id = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title, String(b.description || '').trim(),
      p.passMark, p.retakePolicy, p.retakeLimit, p.deadlineAt, p.isMandatory,
      p.sourceType, p.sourceId, quiz.id
    );
    try { logActivity({ user: req.session.user, action: 'update', entityType: 'safety_quiz', entityId: quiz.id, entityLabel: title, ip: req.ip }); } catch (e) {}
    req.flash('success', 'Quiz saved.');
    return res.redirect('/safety-quizzes/' + quiz.id);
  } catch (err) {
    console.error('[safety-quizzes PUT]', err);
    req.flash('error', 'Update failed: ' + err.message);
    return res.redirect('/safety-quizzes/' + req.params.id + '/edit');
  }
});

// GET /safety-quizzes/:id/questions — question builder
router.get('/:id/questions', (req, res) => {
  const db = getDb();
  const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) { req.flash('error', 'Not found.'); return res.redirect('/safety-quizzes'); }
  const questions = db.prepare('SELECT * FROM safety_quiz_questions WHERE quiz_id = ? ORDER BY sort_order ASC, id ASC').all(quiz.id)
    .map(q => Object.assign({}, q, { options: safeJson(q.options_json, []) }));
  res.render('safety-quizzes/questions', {
    title: 'Questions — ' + quiz.title, currentPage: 'safety-quizzes',
    quiz, questions, statusLabels: STATUS_LABELS,
  });
});

function parseOptionsAndCorrect(b) {
  const type = b.question_type === 'true_false' ? 'true_false' : 'mcq_single';
  if (type === 'true_false') {
    const correct = b.correct_value === 'true' ? 'true' : 'false';
    return { type, options: [], correct };
  }
  // mcq_single — pull option_text[] from the form; trim empties.
  let opts = [].concat(b['option_text'] || []).map(s => String(s || '').trim()).filter(s => s.length);
  if (opts.length < 2) opts = ['', ''];
  const options = opts.map(t => ({ text: t }));
  // correct_index is the 0-based index of the correct option.
  let correctIdx = parseInt(b.correct_index, 10);
  if (isNaN(correctIdx) || correctIdx < 0 || correctIdx >= options.length) correctIdx = 0;
  return { type, options, correct: String(correctIdx) };
}

// POST /safety-quizzes/:id/questions — add a question
router.post('/:id/questions', (req, res) => {
  try {
    const db = getDb();
    const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
    if (!quiz) { req.flash('error', 'Not found.'); return res.redirect('/safety-quizzes'); }
    const b = req.body;
    const text = String(b.question_text || '').trim();
    if (!text) { req.flash('error', 'Question text required.'); return res.redirect('/safety-quizzes/' + quiz.id + '/questions'); }
    const parsed = parseOptionsAndCorrect(b);
    const maxOrder = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM safety_quiz_questions WHERE quiz_id = ?').get(quiz.id)).m;
    db.prepare(`
      INSERT INTO safety_quiz_questions
        (quiz_id, question_text, question_type, options_json, correct_value, explanation, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      quiz.id, text, parsed.type, JSON.stringify(parsed.options),
      parsed.correct, String(b.explanation || '').trim(), maxOrder + 1
    );
    req.flash('success', 'Question added.');
    return res.redirect('/safety-quizzes/' + quiz.id + '/questions');
  } catch (err) {
    console.error('[safety-quizzes question POST]', err);
    req.flash('error', 'Could not add question: ' + err.message);
    return res.redirect('/safety-quizzes/' + req.params.id + '/questions');
  }
});

// POST /safety-quizzes/:id/questions/:qid — edit a question
router.post('/:id/questions/:qid', (req, res) => {
  try {
    const db = getDb();
    const b = req.body;
    const text = String(b.question_text || '').trim();
    if (!text) { req.flash('error', 'Question text required.'); return res.redirect('/safety-quizzes/' + req.params.id + '/questions'); }
    const parsed = parseOptionsAndCorrect(b);
    db.prepare(`
      UPDATE safety_quiz_questions
      SET question_text = ?, question_type = ?, options_json = ?, correct_value = ?, explanation = ?
      WHERE id = ? AND quiz_id = ?
    `).run(
      text, parsed.type, JSON.stringify(parsed.options),
      parsed.correct, String(b.explanation || '').trim(),
      req.params.qid, req.params.id
    );
    req.flash('success', 'Question updated.');
    return res.redirect('/safety-quizzes/' + req.params.id + '/questions');
  } catch (err) {
    console.error('[safety-quizzes question PUT]', err);
    req.flash('error', 'Could not save question: ' + err.message);
    return res.redirect('/safety-quizzes/' + req.params.id + '/questions');
  }
});

// POST /safety-quizzes/:id/questions/:qid/delete
router.post('/:id/questions/:qid/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM safety_quiz_questions WHERE id = ? AND quiz_id = ?').run(req.params.qid, req.params.id);
  req.flash('success', 'Question removed.');
  return res.redirect('/safety-quizzes/' + req.params.id + '/questions');
});

// POST /safety-quizzes/:id/publish — requires at least one question. Fires push.
router.post('/:id/publish', (req, res) => {
  const db = getDb();
  const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) { req.flash('error', 'Not found.'); return res.redirect('/safety-quizzes'); }
  if (quiz.status === 'published') {
    req.flash('error', 'Already published.');
    return res.redirect('/safety-quizzes/' + quiz.id);
  }
  const qCount = db.prepare('SELECT COUNT(*) AS c FROM safety_quiz_questions WHERE quiz_id = ?').get(quiz.id).c;
  if (qCount < 1) {
    req.flash('error', 'Add at least one question before publishing.');
    return res.redirect('/safety-quizzes/' + quiz.id + '/questions');
  }
  const userId = req.session.user ? req.session.user.id : null;
  db.prepare(`
    UPDATE safety_quizzes
    SET status='published', published_at=CURRENT_TIMESTAMP, published_by_id=?, updated_at=CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(userId, quiz.id);
  announcePublished(req, quiz);
  req.flash('success', 'Quiz published — workers have been notified.');
  return res.redirect('/safety-quizzes/' + quiz.id);
});

// POST /safety-quizzes/:id/archive
router.post('/:id/archive', (req, res) => {
  const db = getDb();
  const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.redirect('/safety-quizzes');
  db.prepare("UPDATE safety_quizzes SET status='archived', updated_at=CURRENT_TIMESTAMP WHERE id = ?").run(quiz.id);
  try { logActivity({ user: req.session.user, action: 'archive', entityType: 'safety_quiz', entityId: quiz.id, entityLabel: quiz.title, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Quiz archived.');
  return res.redirect('/safety-quizzes');
});

// POST /safety-quizzes/:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) return res.redirect('/safety-quizzes');
  db.prepare('DELETE FROM safety_quizzes WHERE id = ?').run(quiz.id);
  try { logActivity({ user: req.session.user, action: 'delete', entityType: 'safety_quiz', entityId: quiz.id, entityLabel: quiz.title, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Quiz deleted.');
  return res.redirect('/safety-quizzes');
});

// GET /safety-quizzes/:id/attempts — per-worker attempt list
router.get('/:id/attempts', (req, res) => {
  const db = getDb();
  const quiz = db.prepare('SELECT * FROM safety_quizzes WHERE id = ?').get(req.params.id);
  if (!quiz) { req.flash('error', 'Not found.'); return res.redirect('/safety-quizzes'); }
  // Latest attempt per crew member.
  const rows = db.prepare(`
    SELECT cm.id AS crew_id, cm.full_name, cm.employee_id,
           (SELECT id FROM safety_quiz_attempts WHERE quiz_id = ? AND crew_member_id = cm.id ORDER BY attempt_number DESC LIMIT 1) AS latest_attempt_id,
           (SELECT status FROM safety_quiz_attempts WHERE quiz_id = ? AND crew_member_id = cm.id ORDER BY attempt_number DESC LIMIT 1) AS latest_status,
           (SELECT score_pct FROM safety_quiz_attempts WHERE quiz_id = ? AND crew_member_id = cm.id ORDER BY attempt_number DESC LIMIT 1) AS latest_score,
           (SELECT passed FROM safety_quiz_attempts WHERE quiz_id = ? AND crew_member_id = cm.id ORDER BY attempt_number DESC LIMIT 1) AS latest_passed,
           (SELECT submitted_at FROM safety_quiz_attempts WHERE quiz_id = ? AND crew_member_id = cm.id ORDER BY attempt_number DESC LIMIT 1) AS latest_submitted_at,
           (SELECT COUNT(*) FROM safety_quiz_attempts WHERE quiz_id = ? AND crew_member_id = cm.id) AS attempt_count
    FROM crew_members cm
    WHERE cm.active = 1
    ORDER BY (latest_attempt_id IS NULL) DESC, cm.full_name
  `).all(quiz.id, quiz.id, quiz.id, quiz.id, quiz.id, quiz.id);
  res.render('safety-quizzes/attempts', {
    title: quiz.title + ' — Attempts', currentPage: 'safety-quizzes',
    quiz, rows, statusLabels: STATUS_LABELS,
  });
});

module.exports = router;
