// /safety-comments — office inbox for worker-submitted hazard flags,
// SWMS issues, suggestions, equipment concerns, general comments.
//
// True-anonymous design (Phase 2b): when is_anonymous=1 on a row, the
// crew_member_id is NULL. The office side renders these rows as
// "Anonymous worker" and never joins to crew_members. Pushing a response
// back to an anonymous submitter is done server-side via
// lib/anonymousToken.crewIdFromToken() — the office UI never sees the
// crew_member_id even for anonymous responses.
'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { sendPushToUser, sendPushToCrew } = require('../services/pushNotification');
const { crewIdFromToken } = require('../lib/anonymousToken');

const CATEGORY_VALUES = ['hazard', 'swms_issue', 'suggestion', 'equipment', 'general'];
const CATEGORY_LABELS = {
  hazard: 'Hazard',
  swms_issue: 'SWMS issue',
  suggestion: 'Suggestion',
  equipment: 'Equipment',
  general: 'General',
};
const STATUS_VALUES = ['submitted', 'acknowledged', 'under_review', 'closed'];
const STATUS_LABELS = {
  submitted: 'Submitted',
  acknowledged: 'Acknowledged',
  under_review: 'Under review',
  closed: 'Closed',
};

// GET /safety-comments — inbox with filters + counts
router.get('/', (req, res) => {
  const db = getDb();
  const { category, status, job_id, anonymous } = req.query;

  let where = '1=1';
  const params = [];
  if (status && STATUS_VALUES.includes(status)) { where += ' AND c.status = ?'; params.push(status); }
  if (category && CATEGORY_VALUES.includes(category)) { where += ' AND c.category = ?'; params.push(category); }
  if (job_id) { where += ' AND c.job_id = ?'; params.push(parseInt(job_id, 10) || 0); }
  if (anonymous === '1') where += ' AND c.is_anonymous = 1';
  if (anonymous === '0') where += ' AND c.is_anonymous = 0';

  // crew_members JOIN deliberately gated by is_anonymous = 0. For anonymous
  // rows the join is suppressed — the office side renders "Anonymous worker".
  const rows = db.prepare(`
    SELECT c.*,
      CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cm.full_name END AS submitter_name,
      CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cm.employee_id END AS submitter_emp_id,
      j.job_number, j.client,
      au.full_name AS assigned_to_name,
      (SELECT COUNT(*) FROM safety_comment_attachments WHERE comment_id = c.id) AS attachment_count
    FROM safety_comments c
    LEFT JOIN crew_members cm ON cm.id = c.crew_member_id AND c.is_anonymous = 0
    LEFT JOIN jobs j ON j.id = c.job_id
    LEFT JOIN users au ON au.id = c.assigned_to_id
    WHERE ${where}
    ORDER BY c.created_at DESC
    LIMIT 200
  `).all(...params);

  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='submitted'    THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
      SUM(CASE WHEN status='under_review' THEN 1 ELSE 0 END) AS under_review,
      SUM(CASE WHEN status='closed'       THEN 1 ELSE 0 END) AS closed
    FROM safety_comments
  `).get();

  res.render('safety-comments/index', {
    title: 'Safety Comments', currentPage: 'safety-comments',
    rows, counts,
    filters: { category: category || 'all', status: status || 'all', job_id: job_id || '', anonymous: anonymous || 'all' },
    categoryLabels: CATEGORY_LABELS, statusLabels: STATUS_LABELS,
    categoryValues: CATEGORY_VALUES,
  });
});

// GET /safety-comments/:id — show + response form
router.get('/:id', (req, res) => {
  const db = getDb();
  // Same anti-leak join — crew_members is only joined when not anonymous.
  const comment = db.prepare(`
    SELECT c.*,
      CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cm.full_name END AS submitter_name,
      CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cm.employee_id END AS submitter_emp_id,
      j.job_number, j.client,
      au.full_name AS assigned_to_name,
      ru.full_name AS response_by_name
    FROM safety_comments c
    LEFT JOIN crew_members cm ON cm.id = c.crew_member_id AND c.is_anonymous = 0
    LEFT JOIN jobs j ON j.id = c.job_id
    LEFT JOIN users au ON au.id = c.assigned_to_id
    LEFT JOIN users ru ON ru.id = c.response_by_id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!comment) { req.flash('error', 'Comment not found.'); return req.session.save(() => res.redirect('/safety-comments')); }
  const photos = db.prepare('SELECT * FROM safety_comment_attachments WHERE comment_id = ? ORDER BY id ASC').all(comment.id);
  const officeUsers = db.prepare("SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name").all();
  res.render('safety-comments/show', {
    title: 'Comment #' + comment.id, currentPage: 'safety-comments',
    comment, photos, officeUsers,
    categoryLabels: CATEGORY_LABELS, statusLabels: STATUS_LABELS,
    statusValues: STATUS_VALUES,
  });
});

// POST /safety-comments/:id — update status / assignee / internal notes.
// Office-side only; does NOT touch office_response (use /respond for that).
router.post('/:id', (req, res) => {
  const db = getDb();
  const comment = db.prepare('SELECT * FROM safety_comments WHERE id = ?').get(req.params.id);
  if (!comment) { req.flash('error', 'Not found.'); return req.session.save(() => res.redirect('/safety-comments')); }
  const b = req.body;
  const status = STATUS_VALUES.includes(b.status) ? b.status : comment.status;
  const assignedToId = b.assigned_to_id ? (parseInt(b.assigned_to_id, 10) || null) : null;
  const internalNotes = String(b.internal_notes || '').trim();
  db.prepare(`
    UPDATE safety_comments
    SET status = ?, assigned_to_id = ?, internal_notes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, assignedToId, internalNotes, comment.id);
  try {
    logActivity({
      user: req.session.user, action: 'update', entityType: 'safety_comment',
      entityId: comment.id, entityLabel: 'Comment #' + comment.id,
      details: status, ip: req.ip,
    });
  } catch (e) {}
  req.flash('success', 'Comment updated.');
  return req.session.save(() => res.redirect('/safety-comments/' + comment.id));
});

// POST /safety-comments/:id/respond — record office response, set status=closed,
// push the response back to the originating worker (resolved via the token
// for anonymous rows so the office UI never sees the crew_member_id).
router.post('/:id/respond', (req, res) => {
  const db = getDb();
  const comment = db.prepare('SELECT * FROM safety_comments WHERE id = ?').get(req.params.id);
  if (!comment) { req.flash('error', 'Not found.'); return req.session.save(() => res.redirect('/safety-comments')); }
  const responseText = String(req.body.response || '').trim();
  if (!responseText) {
    req.flash('error', 'Response cannot be empty.');
    return req.session.save(() => res.redirect('/safety-comments/' + comment.id));
  }
  const userId = req.session.user ? req.session.user.id : null;
  db.prepare(`
    UPDATE safety_comments
    SET office_response = ?, response_at = CURRENT_TIMESTAMP, response_by_id = ?,
        status = 'closed', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(responseText, userId, comment.id);

  // Push back to the worker. For non-anon comments we have crew_member_id
  // directly; for anonymous we resolve via the token. Either way the
  // office UI doesn't surface the crew_member_id.
  try {
    let crewId = comment.crew_member_id;
    if (!crewId && comment.is_anonymous && comment.submitter_token) {
      crewId = crewIdFromToken(comment.submitter_token);
    }
    if (crewId) {
      sendPushToCrew(crewId, {
        title: 'Safety: response to your comment',
        body: 'The office has responded to your submission.',
        url: '/w/safety/comments/' + comment.id,
        type: 'safety_comment_response',
        category: 'comment_response',
      }).catch(e => console.error('[safety-comments] push response error:', e.message));
    }
  } catch (e) { console.error('[safety-comments] respond push error:', e.message); }

  try {
    logActivity({
      user: req.session.user, action: 'respond', entityType: 'safety_comment',
      entityId: comment.id, entityLabel: 'Comment #' + comment.id,
      details: comment.is_anonymous ? 'anonymous' : '', ip: req.ip,
    });
  } catch (e) {}
  req.flash('success', 'Response sent and comment closed.');
  return req.session.save(() => res.redirect('/safety-comments/' + comment.id));
});

// POST /safety-comments/:id/delete
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const comment = db.prepare('SELECT * FROM safety_comments WHERE id = ?').get(req.params.id);
  if (!comment) return res.redirect('/safety-comments');
  db.prepare('DELETE FROM safety_comments WHERE id = ?').run(comment.id);
  try { logActivity({ user: req.session.user, action: 'delete', entityType: 'safety_comment', entityId: comment.id, entityLabel: 'Comment #' + comment.id, ip: req.ip }); } catch (e) {}
  req.flash('success', 'Comment deleted.');
  return req.session.save(() => res.redirect('/safety-comments'));
});

// GET /safety-comments/:id/photos/:photoId — inline serve for the admin gallery.
router.get('/:id/photos/:photoId', (req, res) => {
  const db = getDb();
  const ph = db.prepare(`
    SELECT a.file_path, a.file_original_name FROM safety_comment_attachments a
    WHERE a.id = ? AND a.comment_id = ?
  `).get(req.params.photoId, req.params.id);
  if (!ph || !ph.file_path) return res.status(404).send('not found');
  const abs = path.join(__dirname, '..', ph.file_path);
  if (!fs.existsSync(abs)) return res.status(404).send('missing');
  return res.sendFile(abs);
});

module.exports = router;
