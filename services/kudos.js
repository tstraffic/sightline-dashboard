// Kudos peer-recognition service. Pure data assembly + write helpers —
// routes stay thin, views render whatever this returns.

const { getDb } = require('../db/database');

const RATE_LIMIT_PER_DAY = 10;
const QUIET_HOURS_START = 21; // 9pm
const QUIET_HOURS_END = 7;    // 7am

// Small profanity list. Intentionally narrow — this is a "warn then allow
// with confirmation" filter, not a censor. Tune in admin later if needed.
const PROFANITY = [
  'fuck','shit','bitch','asshole','bastard','cunt','dickhead','wanker',
  'retard','faggot','nigger','slut','whore',
];

function containsProfanity(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return PROFANITY.some(w => new RegExp('\\b' + w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\b', 'i').test(t));
}

function isQuietHours(now = new Date()) {
  const h = now.getHours();
  return h >= QUIET_HOURS_START || h < QUIET_HOURS_END;
}

// ---- Send ----
function sendKudos({ senderCrewId, recipientCrewIds, valueId, message, photoUrl, visibility, allowProfanity }) {
  const db = getDb();
  if (!senderCrewId) throw new Error('Sender required');
  if (!Array.isArray(recipientCrewIds) || recipientCrewIds.length === 0) throw new Error('Pick at least one recipient');
  if (recipientCrewIds.includes(senderCrewId)) throw new Error("You can't send kudos to yourself");

  const msg = String(message || '').trim();
  if (!msg) throw new Error('Message required');
  if (msg.length > 280) throw new Error('Message must be 280 characters or less');
  if (!allowProfanity && containsProfanity(msg)) throw new Error('PROFANITY');

  // Public + team only — kudos is a reward system, not a DM. Legacy 'private' rows
  // still exist in DB but nothing new can be created that way.
  if (!['public', 'team'].includes(visibility)) visibility = 'public';

  // Rate limit
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const sentToday = db.prepare(`SELECT COUNT(*) as c FROM kudos WHERE sender_crew_id = ? AND created_at >= ?`).get(senderCrewId, dayStart.toISOString()).c;
  if (sentToday >= RATE_LIMIT_PER_DAY) throw new Error(`Rate limit — you can send up to ${RATE_LIMIT_PER_DAY} kudos per day`);

  // Filter blocked recipients — you can't send kudos to someone who blocked you
  const blockedByRecipients = db.prepare(`
    SELECT blocker_crew_id FROM kudos_blocks
    WHERE blocked_crew_id = ? AND blocker_crew_id IN (${recipientCrewIds.map(() => '?').join(',')})
  `).all(senderCrewId, ...recipientCrewIds).map(r => r.blocker_crew_id);
  const filteredRecipients = recipientCrewIds.filter(r => !blockedByRecipients.includes(r));
  if (filteredRecipients.length === 0) throw new Error('Recipients unavailable');

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO kudos (sender_crew_id, value_id, message, photo_url, visibility)
      VALUES (?, ?, ?, ?, ?)
    `).run(senderCrewId, valueId || null, msg, photoUrl || null, visibility);
    const kudosId = result.lastInsertRowid;
    const rcptStmt = db.prepare('INSERT INTO kudos_recipients (kudos_id, recipient_crew_id) VALUES (?, ?)');
    for (const rid of filteredRecipients) rcptStmt.run(kudosId, rid);
    return kudosId;
  });
  return { id: tx(), recipientCount: filteredRecipients.length };
}

// ---- Feed ----
// Filters: 'all' | 'team' | 'mentions' | 'mine'
// Hides anything from users the viewer has blocked
function getFeed({ viewerCrewId, filter = 'all', beforeId = null, limit = 20 }) {
  const db = getDb();
  const blocks = db.prepare('SELECT blocked_crew_id FROM kudos_blocks WHERE blocker_crew_id = ?').all(viewerCrewId).map(r => r.blocked_crew_id);

  let where = ['k.hidden_at IS NULL'];
  const params = {};
  // Visibility: public for everyone; private kudos only visible to sender + recipients; team is same as public for now (team filter handled in UI)
  where.push(`(
    k.visibility = 'public'
    OR k.sender_crew_id = $viewer
    OR EXISTS (SELECT 1 FROM kudos_recipients kr WHERE kr.kudos_id = k.id AND kr.recipient_crew_id = $viewer)
  )`);
  params.viewer = viewerCrewId;

  if (blocks.length) {
    where.push(`k.sender_crew_id NOT IN (${blocks.map((_, i) => '$b' + i).join(',')})`);
    blocks.forEach((b, i) => { params['b' + i] = b; });
  }

  if (filter === 'mentions') {
    where.push(`EXISTS (SELECT 1 FROM kudos_recipients kr WHERE kr.kudos_id = k.id AND kr.recipient_crew_id = $viewer)`);
  } else if (filter === 'mine') {
    where.push(`k.sender_crew_id = $viewer`);
  } else if (filter === 'team') {
    // "team" = everyone except private. We don't model crews yet, so fall through to public + mine + mentions.
    // Narrow here if crew grouping is added.
  }

  if (beforeId) { where.push(`k.id < $beforeId`); params.beforeId = beforeId; }

  const sql = `
    SELECT k.*, s.full_name as sender_name, s.employee_id as sender_emp_id,
           v.name as value_name, v.colour as value_colour, v.icon as value_icon, v.slug as value_slug, v.points_value as value_points,
           (SELECT COUNT(*) FROM kudos_comments kc WHERE kc.kudos_id = k.id AND kc.hidden_at IS NULL) as comment_count
    FROM kudos k
    JOIN crew_members s ON s.id = k.sender_crew_id
    LEFT JOIN company_values v ON v.id = k.value_id
    WHERE ${where.join(' AND ')}
    ORDER BY k.id DESC LIMIT ${Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)}
  `;
  const rows = db.prepare(sql).all(params);

  if (rows.length === 0) return { items: [], nextBefore: null };

  const ids = rows.map(r => r.id);
  const inClause = ids.map(() => '?').join(',');
  const recipients = db.prepare(`
    SELECT kr.kudos_id, cm.id as crew_id, cm.full_name, cm.employee_id
    FROM kudos_recipients kr JOIN crew_members cm ON cm.id = kr.recipient_crew_id
    WHERE kr.kudos_id IN (${inClause})
  `).all(...ids);

  const reactionRows = db.prepare(`
    SELECT kudos_id, reaction_type, COUNT(*) as c,
      SUM(CASE WHEN crew_member_id = ? THEN 1 ELSE 0 END) as mine
    FROM kudos_reactions WHERE kudos_id IN (${inClause})
    GROUP BY kudos_id, reaction_type
  `).all(viewerCrewId, ...ids);

  const byId = new Map(rows.map(r => [r.id, { ...r, recipients: [], reactions: {}, myReactions: new Set() }]));
  for (const r of recipients) {
    const k = byId.get(r.kudos_id); if (k) k.recipients.push({ crewId: r.crew_id, name: r.full_name, empId: r.employee_id });
  }
  for (const r of reactionRows) {
    const k = byId.get(r.kudos_id); if (!k) continue;
    k.reactions[r.reaction_type] = r.c;
    if (r.mine) k.myReactions.add(r.reaction_type);
  }

  return {
    items: rows.map(r => {
      const k = byId.get(r.id);
      return { ...k, myReactions: Array.from(k.myReactions) };
    }),
    nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}

function getKudosWithComments({ kudosId, viewerCrewId }) {
  const db = getDb();
  const k = db.prepare(`
    SELECT k.*, s.full_name as sender_name, s.employee_id as sender_emp_id,
      v.name as value_name, v.colour as value_colour, v.slug as value_slug, v.points_value as value_points
    FROM kudos k
    JOIN crew_members s ON s.id = k.sender_crew_id
    LEFT JOIN company_values v ON v.id = k.value_id
    WHERE k.id = ? AND k.hidden_at IS NULL
  `).get(kudosId);
  if (!k) return null;
  // Access check
  const isRcpt = db.prepare('SELECT 1 FROM kudos_recipients WHERE kudos_id = ? AND recipient_crew_id = ?').get(kudosId, viewerCrewId);
  if (k.visibility === 'private' && k.sender_crew_id !== viewerCrewId && !isRcpt) return null;

  k.recipients = db.prepare(`
    SELECT cm.id as crewId, cm.full_name as name, cm.employee_id as empId
    FROM kudos_recipients kr JOIN crew_members cm ON cm.id = kr.recipient_crew_id WHERE kr.kudos_id = ?
  `).all(kudosId);

  k.comments = db.prepare(`
    SELECT c.*, cm.full_name as author_name, cm.employee_id as author_emp_id
    FROM kudos_comments c JOIN crew_members cm ON cm.id = c.crew_member_id
    WHERE c.kudos_id = ? AND c.hidden_at IS NULL ORDER BY c.id ASC
  `).all(kudosId);

  return k;
}

// ---- Reactions ----
function toggleReaction({ kudosId, crewId, reactionType }) {
  const db = getDb();
  if (!['clap','heart','raise','flex','fire'].includes(reactionType)) throw new Error('Invalid reaction');
  const existing = db.prepare('SELECT 1 FROM kudos_reactions WHERE kudos_id = ? AND crew_member_id = ? AND reaction_type = ?').get(kudosId, crewId, reactionType);
  if (existing) {
    db.prepare('DELETE FROM kudos_reactions WHERE kudos_id = ? AND crew_member_id = ? AND reaction_type = ?').run(kudosId, crewId, reactionType);
    return { added: false };
  }
  db.prepare('INSERT OR IGNORE INTO kudos_reactions (kudos_id, crew_member_id, reaction_type) VALUES (?, ?, ?)').run(kudosId, crewId, reactionType);
  return { added: true };
}

// ---- Comments ----
function addComment({ kudosId, crewId, message, parentCommentId }) {
  const db = getDb();
  const msg = String(message || '').trim();
  if (!msg) throw new Error('Comment cannot be empty');
  if (msg.length > 280) throw new Error('Comment too long');
  // Enforce 1-level depth — if parent has its own parent, collapse to root
  let parentId = null;
  if (parentCommentId) {
    const p = db.prepare('SELECT parent_comment_id FROM kudos_comments WHERE id = ? AND kudos_id = ?').get(parentCommentId, kudosId);
    if (p) parentId = p.parent_comment_id || parentCommentId;
  }
  const result = db.prepare('INSERT INTO kudos_comments (kudos_id, parent_comment_id, crew_member_id, message) VALUES (?, ?, ?, ?)').run(kudosId, parentId, crewId, msg);
  return { id: result.lastInsertRowid };
}

// ---- Milestones ----
// Auto-posted when missing. Called at feed render time — cheap enough, avoids a cron job.
function generateMilestones(crewIds) {
  const db = getDb();
  if (!crewIds || !crewIds.length) return;
  const insert = db.prepare("INSERT OR IGNORE INTO kudos_milestones (crew_member_id, milestone_type, payload, posted_at) VALUES (?, ?, ?, datetime('now'))");
  const today = new Date();

  for (const id of crewIds) {
    // Anniversaries — based on linked employee.start_date
    try {
      const emp = db.prepare(`SELECT e.id, e.start_date, e.full_name FROM employees e WHERE e.linked_crew_member_id = ?`).get(id);
      if (emp && emp.start_date) {
        const start = new Date(emp.start_date + 'T00:00:00');
        if (!isNaN(start) && today >= start) {
          const years = today.getFullYear() - start.getFullYear();
          if (years >= 1 && [1,2,3,5,10,15,20].includes(years)) {
            const key = `anniversary_${years}yr`;
            insert.run(id, key, JSON.stringify({ years, started_on: emp.start_date, name: emp.full_name }));
          }
        }
      }
    } catch (e) { /* ignore */ }

    // Shift milestones — from distinct clock-in days (approximate "shifts")
    try {
      const shiftCount = db.prepare(`SELECT COUNT(DISTINCT DATE(event_time)) as c FROM clock_events WHERE crew_member_id = ? AND event_type = 'clock_in'`).get(id).c;
      for (const ms of [100, 500, 1000]) {
        if (shiftCount >= ms) insert.run(id, `shifts_${ms}`, JSON.stringify({ shifts: ms }));
      }
    } catch (e) { /* ignore */ }
  }
}

function getRecentMilestones({ limit = 10 }) {
  const db = getDb();
  return db.prepare(`
    SELECT m.*, cm.full_name, cm.employee_id
    FROM kudos_milestones m JOIN crew_members cm ON cm.id = m.crew_member_id
    ORDER BY m.posted_at DESC LIMIT ?
  `).all(limit).map(r => ({ ...r, payload: safeParse(r.payload) }));
}

function safeParse(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }

// ---- Leaderboard ----
function getLeaderboard({ window = 'month', category = 'received', limit = 10 }) {
  const db = getDb();
  let since = null;
  if (window === 'month') since = new Date(Date.now() - 30 * 86400 * 1000);
  else if (window === 'quarter') since = new Date(Date.now() - 90 * 86400 * 1000);

  const optouts = db.prepare('SELECT crew_member_id FROM leaderboard_optouts').all().map(r => r.crew_member_id);
  const optoutClause = optouts.length ? `AND cm.id NOT IN (${optouts.join(',')})` : '';

  let sql;
  if (category === 'received') {
    sql = `
      SELECT cm.id as crew_id, cm.full_name, cm.employee_id, COUNT(*) as count
      FROM kudos_recipients kr
      JOIN kudos k ON k.id = kr.kudos_id
      JOIN crew_members cm ON cm.id = kr.recipient_crew_id
      WHERE k.hidden_at IS NULL ${since ? "AND k.created_at >= '" + since.toISOString() + "'" : ''}
      ${optoutClause}
      GROUP BY cm.id ORDER BY count DESC LIMIT ?
    `;
  } else if (category === 'sent') {
    sql = `
      SELECT cm.id as crew_id, cm.full_name, cm.employee_id, COUNT(*) as count
      FROM kudos k
      JOIN crew_members cm ON cm.id = k.sender_crew_id
      WHERE k.hidden_at IS NULL ${since ? "AND k.created_at >= '" + since.toISOString() + "'" : ''}
      ${optoutClause}
      GROUP BY cm.id ORDER BY count DESC LIMIT ?
    `;
  } else if (category === 'hours') {
    sql = `
      SELECT cm.id as crew_id, cm.full_name, cm.employee_id, ROUND(SUM(ts.total_hours), 1) as count
      FROM timesheets ts JOIN crew_members cm ON cm.id = ts.crew_member_id
      WHERE 1=1 ${since ? "AND ts.work_date >= '" + since.toISOString().split('T')[0] + "'" : ''}
      ${optoutClause}
      GROUP BY cm.id HAVING count > 0 ORDER BY count DESC LIMIT ?
    `;
  } else return [];

  return db.prepare(sql).all(limit);
}

// ---- Profile summary ----
function getProfileSummary({ crewId }) {
  const db = getDb();
  const received = db.prepare(`
    SELECT COUNT(*) as c FROM kudos_recipients kr JOIN kudos k ON k.id = kr.kudos_id
    WHERE kr.recipient_crew_id = ? AND k.hidden_at IS NULL
  `).get(crewId).c;
  const topValue = db.prepare(`
    SELECT v.name, v.colour, COUNT(*) as c
    FROM kudos_recipients kr JOIN kudos k ON k.id = kr.kudos_id
    LEFT JOIN company_values v ON v.id = k.value_id
    WHERE kr.recipient_crew_id = ? AND k.hidden_at IS NULL AND v.id IS NOT NULL
    GROUP BY v.id ORDER BY c DESC LIMIT 1
  `).get(crewId);
  const recent = db.prepare(`
    SELECT k.id, k.message, k.created_at, s.full_name as sender_name, v.name as value_name, v.colour as value_colour, v.points_value as value_points
    FROM kudos_recipients kr JOIN kudos k ON k.id = kr.kudos_id
    JOIN crew_members s ON s.id = k.sender_crew_id
    LEFT JOIN company_values v ON v.id = k.value_id
    WHERE kr.recipient_crew_id = ? AND k.hidden_at IS NULL AND k.visibility != 'private'
    ORDER BY k.id DESC LIMIT 3
  `).all(crewId);
  return { received, topValue, recent };
}

// ---- Moderation ----
function hideKudos({ kudosId, userId, reason }) {
  const db = getDb();
  db.prepare(`UPDATE kudos SET hidden_at = datetime('now'), hidden_by_user_id = ?, hidden_reason = ? WHERE id = ?`).run(userId, reason || '', kudosId);
}

function reportKudos({ kudosId, commentId, reporterCrewId, reason }) {
  const db = getDb();
  db.prepare(`INSERT INTO kudos_reports (kudos_id, comment_id, reporter_crew_id, reason) VALUES (?, ?, ?, ?)`)
    .run(kudosId || null, commentId || null, reporterCrewId, reason || '');
}

function blockUser({ blockerCrewId, blockedCrewId }) {
  if (blockerCrewId === blockedCrewId) throw new Error("Can't block yourself");
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO kudos_blocks (blocker_crew_id, blocked_crew_id) VALUES (?, ?)`).run(blockerCrewId, blockedCrewId);
}
function unblockUser({ blockerCrewId, blockedCrewId }) {
  const db = getDb();
  db.prepare(`DELETE FROM kudos_blocks WHERE blocker_crew_id = ? AND blocked_crew_id = ?`).run(blockerCrewId, blockedCrewId);
}

// ---- Delete (sender-only) ----
// Allow the original sender to take their kudos down — useful when it
// was sent to the wrong person, contained a typo, or the sender wants
// to retract for any reason. ON DELETE CASCADE on kudos_recipients,
// kudos_reactions, kudos_comments, kudos_reports cleans those up.
function deleteKudos({ kudosId, crewId }) {
  const db = getDb();
  const k = db.prepare('SELECT id, sender_crew_id FROM kudos WHERE id = ?').get(kudosId);
  if (!k) throw new Error('Kudos not found');
  if (k.sender_crew_id !== crewId) throw new Error('Only the sender can delete their kudos');
  db.prepare('DELETE FROM kudos WHERE id = ?').run(kudosId);
  return { ok: true };
}

// ---- Values ----
function getActiveValues() {
  const db = getDb();
  return db.prepare('SELECT * FROM company_values WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
}

module.exports = {
  RATE_LIMIT_PER_DAY,
  containsProfanity, isQuietHours,
  sendKudos, getFeed, getKudosWithComments,
  toggleReaction, addComment,
  generateMilestones, getRecentMilestones,
  getLeaderboard, getProfileSummary,
  hideKudos, reportKudos, blockUser, unblockUser,
  deleteKudos,
  getActiveValues,
};
