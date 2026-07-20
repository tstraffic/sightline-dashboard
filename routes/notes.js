// /notes — personal notes, reminders, meeting-discussion items.
// Default visibility is private to the author. Selective sharing via
// the user_note_shares junction table.
//
// Visibility rule: user U sees note N iff N.created_by_id = U OR a row
// exists in user_note_shares with note_id = N.id AND shared_with_user_id = U.

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

const VALID_TAGS = new Set(['note', 'reminder', 'meeting']);
const VALID_VIEWS = new Set(['all', 'mine', 'shared']);
const VALID_RANGES = new Set(['today', 'week', 'all']);

function todayStr() { return new Date().toISOString().slice(0, 10); }

// Friendly day header — "Today", "Tomorrow", "Yesterday", "Wed 21 May 2026"
function dayLabel(iso) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(iso + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
}

function authorOnly(db, note, userId) {
  return note && note.created_by_id === userId;
}

// Parse share_user_ids from a form body — accepts comma-separated string or
// array (multiple form fields with the same name).
function parseShareIds(raw) {
  if (raw == null) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map(v => parseInt(v, 10)).filter(n => Number.isFinite(n) && n > 0);
}

// GET /notes — list visible notes grouped by note_date
router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const tag = VALID_TAGS.has(req.query.tag) ? req.query.tag : '';
  const view = VALID_VIEWS.has(req.query.view) ? req.query.view : 'all';
  const range = VALID_RANGES.has(req.query.range) ? req.query.range : 'week';

  // Build visibility predicate. `mine` = author only, `shared` = where I
  // appear in the share list AND I'm not the author, `all` = either.
  const where = ['(n.created_by_id = ? OR EXISTS(SELECT 1 FROM user_note_shares s WHERE s.note_id = n.id AND s.shared_with_user_id = ?))'];
  const params = [user.id, user.id];
  if (view === 'mine')   { where.push('n.created_by_id = ?'); params.push(user.id); }
  if (view === 'shared') { where.push('n.created_by_id != ? AND EXISTS(SELECT 1 FROM user_note_shares s2 WHERE s2.note_id = n.id AND s2.shared_with_user_id = ?)'); params.push(user.id, user.id); }
  if (tag) { where.push('n.tag = ?'); params.push(tag); }
  if (range === 'today') { where.push("n.note_date = date('now','localtime')"); }
  if (range === 'week')  { where.push("n.note_date BETWEEN date('now','localtime','-7 days') AND date('now','localtime','+14 days')"); }

  const rows = db.prepare(`
    SELECT n.id, n.created_by_id, n.content, n.note_date, n.tag, n.is_shared, n.pinned, n.created_at, n.updated_at,
           u.full_name AS author_name,
           (SELECT COUNT(*) FROM user_note_shares s WHERE s.note_id = n.id) AS share_count
    FROM user_notes n
    LEFT JOIN users u ON u.id = n.created_by_id
    WHERE ${where.join(' AND ')}
    ORDER BY n.note_date DESC, n.pinned DESC, n.created_at DESC
  `).all(...params);

  // Pre-bucket share-user-ids for notes I own (so the share modal can
  // pre-populate without a separate fetch). Other people's notes don't
  // need this — they can't open the share modal anyway.
  const myNoteIds = rows.filter(r => r.created_by_id === user.id).map(r => r.id);
  const sharesByNote = {};
  if (myNoteIds.length > 0) {
    const ph = myNoteIds.map(() => '?').join(',');
    db.prepare(`SELECT s.note_id, s.shared_with_user_id, u.full_name FROM user_note_shares s LEFT JOIN users u ON u.id = s.shared_with_user_id WHERE s.note_id IN (${ph})`).all(...myNoteIds)
      .forEach(s => { (sharesByNote[s.note_id] = sharesByNote[s.note_id] || []).push({ id: s.shared_with_user_id, name: s.full_name }); });
  }

  // Group by date for the EJS to render headed sections.
  const groups = [];
  const groupIndex = {};
  rows.forEach(r => {
    if (groupIndex[r.note_date] == null) {
      groupIndex[r.note_date] = groups.length;
      groups.push({ date: r.note_date, label: dayLabel(r.note_date), notes: [] });
    }
    groups[groupIndex[r.note_date]].notes.push(r);
  });

  const users = db.prepare("SELECT id, full_name FROM users WHERE active = 1 AND id != ? ORDER BY full_name").all(user.id);

  res.render('notes/index', {
    title: 'Notes', currentPage: 'notes',
    user, users, groups, sharesByNote,
    filters: { tag, view, range },
    today: todayStr(),
  });
});

// POST /notes — create
router.post('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const content = String(req.body.content || '').trim();
  const tag = VALID_TAGS.has(req.body.tag) ? req.body.tag : 'note';
  const noteDate = String(req.body.note_date || todayStr()).slice(0, 10);
  const shareIds = parseShareIds(req.body.share_user_ids);

  if (!content) {
    req.flash('error', 'Note content required.');
    return req.session.save(() => res.redirect('/notes'));
  }

  try {
    const tx = db.transaction(() => {
      const r = db.prepare("INSERT INTO user_notes (created_by_id, content, note_date, tag, is_shared) VALUES (?, ?, ?, ?, ?)")
        .run(user.id, content, noteDate, tag, shareIds.length > 0 ? 1 : 0);
      if (shareIds.length > 0) {
        // Filter to known active users; ignore self-sharing.
        const validIds = db.prepare(`SELECT id FROM users WHERE active = 1 AND id != ? AND id IN (${shareIds.map(() => '?').join(',')})`).all(user.id, ...shareIds).map(u => u.id);
        const ins = db.prepare("INSERT OR IGNORE INTO user_note_shares (note_id, shared_with_user_id) VALUES (?, ?)");
        validIds.forEach(id => ins.run(r.lastInsertRowid, id));
      }
    });
    tx();
    req.flash('success', shareIds.length > 0 ? 'Note saved and shared.' : 'Note saved.');
  } catch (e) {
    console.error('[notes] create failed:', e.message);
    req.flash('error', 'Failed to save note: ' + e.message);
  }
  req.session.save(() => res.redirect('/notes'));
});

// GET /notes/:id — JSON (for inline editor)
router.get('/:id', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const note = db.prepare("SELECT * FROM user_notes WHERE id = ?").get(req.params.id);
  if (!note) return res.status(404).json({ error: 'Not found' });
  const visible = note.created_by_id === user.id
    || !!db.prepare("SELECT 1 FROM user_note_shares WHERE note_id = ? AND shared_with_user_id = ?").get(note.id, user.id);
  if (!visible) return res.status(404).json({ error: 'Not found' });
  const shares = db.prepare("SELECT s.shared_with_user_id AS id, u.full_name AS name FROM user_note_shares s LEFT JOIN users u ON u.id = s.shared_with_user_id WHERE s.note_id = ?").all(note.id);
  res.json({ note, shares, can_edit: note.created_by_id === user.id });
});

// POST /notes/:id — update content / tag / note_date
router.post('/:id', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const note = db.prepare("SELECT * FROM user_notes WHERE id = ?").get(req.params.id);
  if (!note) { req.flash('error', 'Note not found.'); return req.session.save(() => res.redirect('/notes')); }
  if (!authorOnly(db, note, user.id)) return res.status(403).send('Forbidden');

  const content = String(req.body.content || '').trim();
  const tag = VALID_TAGS.has(req.body.tag) ? req.body.tag : note.tag;
  const noteDate = String(req.body.note_date || note.note_date).slice(0, 10);
  if (!content) { req.flash('error', 'Note content required.'); return req.session.save(() => res.redirect('/notes')); }

  db.prepare("UPDATE user_notes SET content = ?, tag = ?, note_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(content, tag, noteDate, note.id);
  req.flash('success', 'Note updated.');
  req.session.save(() => res.redirect('/notes'));
});

// POST /notes/:id/share — replace share list
router.post('/:id/share', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const note = db.prepare("SELECT * FROM user_notes WHERE id = ?").get(req.params.id);
  if (!note) { req.flash('error', 'Note not found.'); return req.session.save(() => res.redirect('/notes')); }
  if (!authorOnly(db, note, user.id)) return res.status(403).send('Forbidden');

  const shareIds = parseShareIds(req.body.share_user_ids);
  try {
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM user_note_shares WHERE note_id = ?").run(note.id);
      if (shareIds.length > 0) {
        const validIds = db.prepare(`SELECT id FROM users WHERE active = 1 AND id != ? AND id IN (${shareIds.map(() => '?').join(',')})`).all(user.id, ...shareIds).map(u => u.id);
        const ins = db.prepare("INSERT OR IGNORE INTO user_note_shares (note_id, shared_with_user_id) VALUES (?, ?)");
        validIds.forEach(id => ins.run(note.id, id));
        db.prepare("UPDATE user_notes SET is_shared = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(validIds.length > 0 ? 1 : 0, note.id);
      } else {
        db.prepare("UPDATE user_notes SET is_shared = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(note.id);
      }
    });
    tx();
    req.flash('success', shareIds.length > 0 ? `Note shared with ${shareIds.length} user(s).` : 'Note made private.');
  } catch (e) {
    console.error('[notes] share failed:', e.message);
    req.flash('error', 'Share update failed: ' + e.message);
  }
  req.session.save(() => res.redirect('/notes'));
});

// POST /notes/:id/unshare — drop everyone from the share list
router.post('/:id/unshare', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const note = db.prepare("SELECT * FROM user_notes WHERE id = ?").get(req.params.id);
  if (!note) { req.flash('error', 'Note not found.'); return req.session.save(() => res.redirect('/notes')); }
  if (!authorOnly(db, note, user.id)) return res.status(403).send('Forbidden');
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_note_shares WHERE note_id = ?").run(note.id);
    db.prepare("UPDATE user_notes SET is_shared = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(note.id);
  });
  tx();
  req.flash('success', 'Note is private again.');
  req.session.save(() => res.redirect('/notes'));
});

// POST /notes/:id/pin — toggle pin
router.post('/:id/pin', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const note = db.prepare("SELECT * FROM user_notes WHERE id = ?").get(req.params.id);
  if (!note) { req.flash('error', 'Note not found.'); return req.session.save(() => res.redirect('/notes')); }
  if (!authorOnly(db, note, user.id)) return res.status(403).send('Forbidden');
  db.prepare("UPDATE user_notes SET pinned = CASE pinned WHEN 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(note.id);
  req.session.save(() => res.redirect('/notes'));
});

// POST /notes/:id/delete — hard delete (share rows cascade)
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const note = db.prepare("SELECT * FROM user_notes WHERE id = ?").get(req.params.id);
  if (!note) { req.flash('error', 'Note not found.'); return req.session.save(() => res.redirect('/notes')); }
  if (!authorOnly(db, note, user.id)) return res.status(403).send('Forbidden');
  db.prepare("DELETE FROM user_notes WHERE id = ?").run(note.id);
  req.flash('success', 'Note deleted.');
  req.session.save(() => res.redirect('/notes'));
});

module.exports = router;
