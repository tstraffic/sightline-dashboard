// Anonymous-token helper for safety_comments.
//
// True-anonymous design (Phase 2b):
//   - Every safety_comments row stores a `submitter_token` derived from
//     sha256(crew_member_id + server-side salt).
//   - When is_anonymous = 1, the row's crew_member_id is NULL — the office
//     side can't recover identity from the row alone.
//   - The token is still deterministic given crew_member_id + salt, so the
//     worker portal can list a worker's own submissions (including their
//     anonymous ones) by computing the token from the session.
//
// Anyone with shell access to the DB and the salt can recover identity by
// hashing every crew_member_id and matching tokens. That's deliberate — we
// need to be able to push response notifications back to the originating
// worker even on anonymous comments. The office UI never displays
// crew_member_id from anonymous rows; the brute-force unmask is reserved
// for the safety officer in policy-compliant cases (subpoena, formal
// incident review, etc.). For tighter anonymity, replace the deterministic
// hash with a per-submission random token saved on the client side.

'use strict';

const crypto = require('crypto');
const { getDb } = require('../db/database');

let cachedSalt = null;

function loadSalt() {
  if (cachedSalt) return cachedSalt;
  // env var wins if set, so a deployment-wide secret can be controlled
  // outside the DB (rotation, etc.).
  if (process.env.SAFETY_COMMENT_SALT) {
    cachedSalt = process.env.SAFETY_COMMENT_SALT;
    return cachedSalt;
  }
  const db = getDb();
  const row = db.prepare("SELECT config_value FROM system_config WHERE config_key = 'anonymous_comment_salt'").get();
  if (row && row.config_value) {
    cachedSalt = row.config_value;
    return cachedSalt;
  }
  // Last-resort fallback: generate + persist. Shouldn't happen in practice
  // because migration 189 seeds the salt — this guards a worktree where
  // migrations didn't run for some reason.
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    db.prepare(`
      INSERT OR IGNORE INTO system_config (config_key, config_value, config_type, description)
      VALUES ('anonymous_comment_salt', ?, 'secret', 'Salt used to derive worker submitter_token on safety_comments rows. Never log or expose.')
    `).run(fresh);
  } catch (e) { /* table may not exist on a stale dev DB */ }
  cachedSalt = fresh;
  return cachedSalt;
}

function submitterToken(crewMemberId) {
  if (!crewMemberId) return '';
  const salt = loadSalt();
  return crypto.createHash('sha256').update(String(crewMemberId) + ':' + salt).digest('hex');
}

// Resolve a token back to a crew_member_id by brute force. Used only on
// the server when pushing a notification back to an anonymous submitter.
// Never call from a request triggered by an office user.
function crewIdFromToken(token) {
  if (!token) return null;
  const db = getDb();
  const rows = db.prepare("SELECT id FROM crew_members WHERE active = 1").all();
  for (const r of rows) {
    if (submitterToken(r.id) === token) return r.id;
  }
  return null;
}

module.exports = { submitterToken, crewIdFromToken, loadSalt };
