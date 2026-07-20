// Marketing dashboard.
//
// INTERNAL workflow panels (Tasks, Approvals, Quick ask, Activity feed) are
// backed by real tables — migration 134 — and these routes handle the
// mutations. EXTERNAL-data panels (KPIs, campaigns, SEO, social, lead
// source, regions, reviews, agency performance) remain illustrative until
// the integration adapters (GA4 / Google Ads / LinkedIn / GSC / GBP /
// CRM) land. The banner on the page explains which is which.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');

// ── External-data placeholders (still illustrative) ─────────────────────
const staticData = {
  periodLabel: 'April 2026 · month-to-date',
  syncedAgo: '8 min ago',

  alerts: [
    { tone: 'bad',  text: '1 blog missed this month — reschedule' },
    { tone: 'warn', text: 'Employee advocacy: 5 below target (7/12)' },
    { tone: 'warn', text: '"event traffic management sydney" ▼ 3 positions' },
    { tone: 'bad',  text: 'Retainer hours over-pacing (95% used · 73% through month)' },
  ],

  kpis: [
    { label: 'Marketing leads',           value: '17',       split: '11 form · 6 phone', delta: '▲ 41% vs last month', tone: 'up' },
    { label: 'Cost per qualified lead',   value: '$128',     delta: '▼ 12% vs target',   tone: 'up',  target: 'Target: $145' },
    { label: 'Content delivered vs plan', value: '92%',      delta: '11 of 12 shipped',  tone: 'flat', target: 'Target: 100%' },
    { label: 'Spend this month',          value: '$10.8k',   valueSuffix: ' / $12k', pace: { fill: 90, mark: 73, leftLabel: 'spend 90%', rightLabel: 'month 73%' } },
  ],

  campaigns: [
    { name: 'Indigenous Engagement — Community Stories Q2', tag: 'RAP',         tagTone: 'indig', status: 'live', statusLabel: 'Live',    spendText: '$3,200 / $6,000',   progress: 53, reach: '18,400 reach' },
    { name: 'Google Ads — Traffic control NSW',             tag: 'PAID SEARCH', tagTone: 'paid',  status: 'live', statusLabel: 'Live',    spendText: '$2,180 / $4,000',   progress: 55, reach: '312 clicks' },
    { name: 'LinkedIn ABM — Tier 1 civil contractors',      tag: 'PAID SOCIAL', tagTone: 'paid',  status: 'live', statusLabel: 'Live',    spendText: '$1,420 / $3,000',   progress: 47, reach: '9,100 impressions' },
    { name: 'Case study launch — Parramatta Council TGS',   tag: 'BRAND',       tagTone: 'brand', status: 'plan', statusLabel: 'Planned', spendText: 'Launch 28 Apr',     progress: 20, reach: 'not yet live' },
    { name: 'Local SEO push — Western Sydney LGAs',         tag: 'SEO',         tagTone: 'seo',   status: 'live', statusLabel: 'Live',    spendText: 'Retainer',          progress: 70, reach: '7 pages live' },
    { name: 'Employer brand — Controller recruitment video',tag: 'BRAND',       tagTone: 'brand', status: 'prep', statusLabel: 'Prep',    spendText: 'Shoot 2 May',       progress: 15, reach: 'not yet live' },
  ],

  social: {
    stats: [
      { k: 'LinkedIn eng.', v: '4.8%',  d: '▲ 1.2pp',     dTone: 'up',    target: 'Target: 3.6%' },
      { k: 'Posts / mo',    v: '16 / 16', d: 'on plan',    dTone: 'up',    target: 'Target: 16' },
      { k: 'Advocacy',      v: '7 / 12', d: 'below target', dTone: 'warn', target: 'Target: 12 staff' },
    ],
    sparkline: { points: '0,62 60,55 120,48 180,36 240,24 300,14', months: ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr'] },
    followersLabel: 'Follower growth — last 6 months (1,276)',
  },

  leadSource: [
    { label: 'Organic search',   last: 7, first: 4 },
    { label: 'Google Ads',       last: 4, first: 2 },
    { label: 'LinkedIn organic', last: 3, first: 6 },
    { label: 'LinkedIn Ads',     last: 2, first: 3 },
    { label: 'Referral',         last: 1, first: 1 },
    { label: 'Direct',           last: 0, first: 1 },
  ],

  regions: [
    { label: 'Sydney metro',           n: 8, pct: 47, barPct: 100 },
    { label: 'Western Sydney',         n: 4, pct: 24, barPct: 50 },
    { label: 'Newcastle / Hunter',     n: 2, pct: 12, barPct: 25 },
    { label: 'Illawarra',              n: 2, pct: 12, barPct: 25 },
    { label: 'Central Coast',          n: 1, pct: 6,  barPct: 12 },
    { label: 'Regional / other NSW',   n: 0, pct: 0,  barPct: 0 },
    { label: 'Unknown / unattributed', n: 0, pct: 0,  barPct: 0 },
  ],

  reviews: {
    stars: '4.7',
    totalText: 'from 68 reviews',
    rows: [
      { k: 'New reviews this month',        v: '12', delta: '▲ 5' },
      { k: 'Response rate (owner)',         v: '94%' },
      { k: '5-star share',                  v: '82%' },
      { k: 'Google Business Profile views', v: '3,410' },
      { k: 'Direction / call clicks',       v: '148' },
    ],
    footer: 'Target: 5 new reviews/month, 100% owner response within 48 hrs.',
  },

  content: {
    cards: [
      { num: '3 / 4', cat: 'Blogs',           sub: 'of plan' },
      { num: '2 / 2', cat: 'Case studies',    sub: 'of plan' },
      { num: '1 / 1', cat: 'Videos',          sub: 'of plan' },
      { num: '148',   cat: 'Photos captured', sub: '3 shoots' },
    ],
    items: [
      { title: '"How councils reduce risk with certified TGS plans"', meta: 'Blog · Shipped 8 Apr',               comments: 2, avatar: 'li', status: 'live',    statusLabel: 'Live' },
      { title: '"TMP vs TGS — what councils actually need"',          meta: 'Blog · Shipped 15 Apr',              comments: 0, avatar: 'li', status: 'live',    statusLabel: 'Live' },
      { title: '"Western Sydney projects we\'re proud of"',           meta: 'Blog · Awaiting your approval · 26 Apr', comments: 4, avatar: 'li', status: 'plan', statusLabel: 'Review' },
      { title: '"Why safety isn\'t a checkbox"',                      meta: 'Blog · Reschedule',                  comments: 2, avatar: 'li', status: 'blocked', statusLabel: 'Blocked', missed: true },
      { title: 'Parramatta Council — roundabout upgrade case study',  meta: 'Case study · Awaiting your approval · 28 Apr', comments: 6, avatar: 'li', status: 'plan', statusLabel: 'Review' },
      { title: 'Ausgrid — after-hours lane closure case study',       meta: 'Case study · Shipped 12 Apr',        comments: 1, avatar: 'to', status: 'live',    statusLabel: 'Live' },
      { title: 'Acknowledgement of Country — website video',          meta: 'Video · Edit · 30 Apr',              comments: 5, avatar: 'je', status: 'plan',    statusLabel: 'In edit' },
      { title: 'Team spotlight — senior TC Darren (15 years)',        meta: 'Photo + social · Shipped 20 Apr',    comments: 0, avatar: 'li', status: 'live',    statusLabel: 'Live' },
    ],
  },

  seo: {
    keywords: [
      { kw: 'traffic control sydney',               pos: '#6',  chg: '▲ 3',        chgTone: 'up'   , volume: '1,900' },
      { kw: 'traffic management nsw',               pos: '#9',  chg: '▲ 2',        chgTone: 'up'   , volume: '1,300' },
      { kw: 'TMP plan sydney',                      pos: '#4',  chg: '▲ 5',        chgTone: 'up'   , volume: '720'   },
      { kw: 'traffic guidance scheme newcastle',    pos: '#12', chg: '▲ 4',        chgTone: 'up'   , volume: '390'   },
      { kw: 'traffic controllers western sydney',   pos: '#8',  chg: '—',          chgTone: 'flat' , volume: '580'   },
      { kw: 'event traffic management sydney',      pos: '#22', chg: '▼ 3',        chgTone: 'down' , volume: '260'   },
      { kw: 'aboriginal owned traffic management',  pos: '—',   chg: 'new target', chgTone: 'flat' , volume: '140', tag: 'RAP', tagTone: 'indig' },
    ],
    footer: '7 of 12 target keywords on page 1. Domain authority 22 (+3 MoM). Strategic keyword (RAP) tracked even at low volume.',
  },

  agency: [
    { lbl: 'Deliverables shipped on time',  val: '11 / 12 · 92%',         tone: 'good', pace: { fill: 92, tone: 'good' } },
    { lbl: 'Retainer hours used',           val: '38 / 40 hrs',           tone: 'warn', pace: { fill: 95, mark: 73, tone: 'warn' } },
    { lbl: '',                              val: '↑ over-pacing — 95% hours used, 73% through month', tone: 'warn', note: true },
    { lbl: 'Average response time',         val: '3.2 hrs',               tone: 'good' },
    { lbl: 'Monthly report delivered',      val: 'On time (day 3)',       tone: 'good' },
    { lbl: 'Scope changes this month',      val: '1 (approved)',          tone: 'neutral' },
    { lbl: 'Invoice vs. retainer',          val: '$8,000 / $8,000 · match', tone: 'good' },
  ],

  funnel: [
    { label: 'Website visits', value: '2,148', sub: 'organic + paid',           conv: '0.8%',  convTone: 'weak', isWin: false },
    { label: 'Leads',          value: '17',    sub: 'form + call',              conv: '53%',                    isWin: false },
    { label: 'Opportunities',  value: '9',     sub: 'qualified',                conv: '22%',                    isWin: false },
    { label: 'Won',            value: '2',     sub: '$84k TCV · YTD $342k',                                     isWin: true  },
  ],

  funnelNote: 'Bottleneck: site conversion 0.8% — below 1.5% B2B benchmark. Ask agency for CRO review before scaling paid traffic. Later stages look healthy.',
};

// ── Helpers ──────────────────────────────────────────────────────────────
const VALID_PRIORITY = new Set(['low', 'med', 'high', 'urgent']);
const VALID_DECISION = new Set(['approved', 'rejected']);
const VALID_TYPE     = new Set(['BUDGET', 'CONTENT', 'CASE STUDY', 'CREATIVE', 'INVOICE', 'SCOPE CHANGE']);

function logActivity(db, user, verb, targetType, targetId, snippet) {
  db.prepare(`
    INSERT INTO marketing_activity (actor_user_id, actor_label, verb, target_type, target_id, snippet)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(user.id, user.full_name || user.username, verb, targetType, targetId || null, snippet);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function dueFromOption(option) {
  const now = new Date();
  switch (option) {
    case 'today':      return 'Today';
    case 'this_week':  return 'This week';
    case 'this_month': return 'This month';
    default:           return null;
  }
}

// ── GET /marketing ──────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const db = getDb();
  const user = req.session.user;

  // Tasks split by assignee for the two tabs.
  const mine = db.prepare(`
    SELECT * FROM marketing_tasks
    WHERE assignee_user_id = ? AND status = 'open'
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 WHEN 'low' THEN 3 END,
             created_at DESC
  `).all(user.id);

  const theirs = db.prepare(`
    SELECT * FROM marketing_tasks
    WHERE (assignee_user_id IS NULL OR assignee_user_id != ?) AND status = 'open'
    ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'med' THEN 2 WHEN 'low' THEN 3 END,
             created_at DESC
  `).all(user.id);

  const openTotal = mine.length + theirs.length;

  const approvals = db.prepare(`
    SELECT * FROM marketing_approvals
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all();

  const activity = db.prepare(`
    SELECT * FROM marketing_activity
    ORDER BY created_at DESC
    LIMIT 20
  `).all();

  // People picker for the "+ Add task" and "Quick ask" forms — pull
  // internal users who could be assignees (admin, management, marketing).
  const people = db.prepare(`
    SELECT id, full_name, username, role FROM users
    WHERE active = 1 AND role IN ('admin','management','marketing')
    ORDER BY full_name COLLATE NOCASE
  `).all();

  res.render('marketing', {
    title: 'Marketing',
    currentPage: 'marketing',
    data: {
      ...staticData,
      tasks: {
        mine,
        theirs,
        openTotal,
        mineCount: mine.length,
        theirsCount: theirs.length,
      },
      approvals,
      activity,
      people,
    },
  });
});

// ── POST /marketing/tasks — create a task ────────────────────────────────
router.post('/tasks', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const b = req.body || {};

  const title = String(b.title || '').trim();
  if (!title) {
    req.flash('error', 'Task title is required.');
    return req.session.save(() => res.redirect('/marketing#sec-tasks'));
  }

  const priority = VALID_PRIORITY.has(b.priority) ? b.priority : 'med';
  const dueText  = String(b.due_text || '').trim() || null;

  // Assignee: either an internal user_id, or a free-text label.
  let assigneeUserId = null;
  let assigneeLabel  = '';
  if (b.assignee_user_id && Number(b.assignee_user_id) > 0) {
    const u = db.prepare('SELECT id, full_name, username FROM users WHERE id = ? AND active = 1').get(Number(b.assignee_user_id));
    if (u) {
      assigneeUserId = u.id;
      assigneeLabel  = u.full_name || u.username;
    }
  }
  if (!assigneeLabel) {
    assigneeLabel = String(b.assignee_label || '').trim() || 'Unassigned';
  }

  const info = db.prepare(`
    INSERT INTO marketing_tasks (title, assignee_user_id, assignee_label, from_user_id, from_label, priority, due_text, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(title, assigneeUserId, assigneeLabel, user.id, user.full_name || user.username, priority, dueText);

  logActivity(
    db, user, 'created', 'task', info.lastInsertRowid,
    `<strong>${escapeHtml(user.full_name || user.username)}</strong> created task <strong>"${escapeHtml(title)}"</strong>${assigneeLabel ? ` for <strong>${escapeHtml(assigneeLabel)}</strong>` : ''}.`
  );

  req.flash('success', 'Task added.');
  req.session.save(() => res.redirect('/marketing#sec-tasks'));
});

// ── POST /marketing/tasks/:id/toggle — flip open/done ────────────────────
router.post('/tasks/:id/toggle', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const t = db.prepare('SELECT * FROM marketing_tasks WHERE id = ?').get(req.params.id);
  if (!t) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect('/marketing#sec-tasks')); }

  if (t.status === 'open') {
    db.prepare("UPDATE marketing_tasks SET status = 'done', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(t.id);
    logActivity(db, user, 'completed', 'task', t.id,
      `<strong>${escapeHtml(user.full_name || user.username)}</strong> completed <strong>"${escapeHtml(t.title)}"</strong>.`);
  } else {
    db.prepare("UPDATE marketing_tasks SET status = 'open', completed_at = NULL WHERE id = ?").run(t.id);
    logActivity(db, user, 'reopened', 'task', t.id,
      `<strong>${escapeHtml(user.full_name || user.username)}</strong> reopened <strong>"${escapeHtml(t.title)}"</strong>.`);
  }

  req.session.save(() => res.redirect('/marketing#sec-tasks'));
});

// ── POST /marketing/tasks/:id/delete ─────────────────────────────────────
router.post('/tasks/:id/delete', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const t = db.prepare('SELECT * FROM marketing_tasks WHERE id = ?').get(req.params.id);
  if (!t) { req.flash('error', 'Task not found.'); return req.session.save(() => res.redirect('/marketing#sec-tasks')); }

  db.prepare('DELETE FROM marketing_tasks WHERE id = ?').run(t.id);
  logActivity(db, user, 'deleted', 'task', t.id,
    `<strong>${escapeHtml(user.full_name || user.username)}</strong> deleted task <strong>"${escapeHtml(t.title)}"</strong>.`);

  req.flash('success', 'Task deleted.');
  req.session.save(() => res.redirect('/marketing#sec-tasks'));
});

// ── POST /marketing/approvals/:id/decide ─────────────────────────────────
router.post('/approvals/:id/decide', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const a = db.prepare('SELECT * FROM marketing_approvals WHERE id = ?').get(req.params.id);
  if (!a) { req.flash('error', 'Approval not found.'); return req.session.save(() => res.redirect('/marketing#sec-tasks')); }

  const decision = String(req.body.decision || '').toLowerCase();
  if (!VALID_DECISION.has(decision)) {
    req.flash('error', 'Invalid decision.');
    return req.session.save(() => res.redirect('/marketing#sec-tasks'));
  }

  const note = String(req.body.note || '').trim() || null;

  db.prepare(`
    UPDATE marketing_approvals
    SET status = ?, decided_at = CURRENT_TIMESTAMP, decision_note = ?, decided_by_user_id = ?
    WHERE id = ?
  `).run(decision, note, user.id, a.id);

  const verb = decision === 'approved' ? 'approved' : 'rejected';
  logActivity(db, user, verb, 'approval', a.id,
    `<strong>${escapeHtml(user.full_name || user.username)}</strong> ${verb} <strong>${escapeHtml(a.type)}</strong> — ${escapeHtml(a.title)}${note ? ` <em>"${escapeHtml(note)}"</em>` : ''}.`);

  req.flash('success', `Approval ${verb}.`);
  req.session.save(() => res.redirect('/marketing#sec-tasks'));
});

// ── POST /marketing/quick-ask — creates a task from the quick-ask form ──
router.post('/quick-ask', (req, res) => {
  const db = getDb();
  const user = req.session.user;
  const b = req.body || {};

  const body = String(b.body || '').trim();
  if (!body) {
    req.flash('error', 'Ask cannot be empty.');
    return req.session.save(() => res.redirect('/marketing#sec-tasks'));
  }

  // Title = first 80 chars of body
  const title = body.length > 80 ? body.slice(0, 77) + '...' : body;
  const priority = VALID_PRIORITY.has(b.priority) ? b.priority : 'med';
  const dueText = dueFromOption(String(b.due || ''));

  // Assignee: dropdown value is either a user id ("user:123") or a label ("label:Whole team")
  const toRaw = String(b.to || '').trim();
  let assigneeUserId = null;
  let assigneeLabel  = 'Whole team';
  if (toRaw.startsWith('user:')) {
    const uid = Number(toRaw.slice(5));
    const u = db.prepare('SELECT id, full_name, username FROM users WHERE id = ? AND active = 1').get(uid);
    if (u) { assigneeUserId = u.id; assigneeLabel = u.full_name || u.username; }
  } else if (toRaw.startsWith('label:')) {
    assigneeLabel = toRaw.slice(6) || 'Whole team';
  }

  const info = db.prepare(`
    INSERT INTO marketing_tasks (title, assignee_user_id, assignee_label, from_user_id, from_label, priority, due_text, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
  `).run(title, assigneeUserId, assigneeLabel, user.id, user.full_name || user.username, priority, dueText);

  logActivity(db, user, 'asked', 'task', info.lastInsertRowid,
    `<strong>${escapeHtml(user.full_name || user.username)}</strong> sent a quick ask to <strong>${escapeHtml(assigneeLabel)}</strong>: <em>"${escapeHtml(title)}"</em>`);

  req.flash('success', `Ask sent to ${assigneeLabel}.`);
  req.session.save(() => res.redirect('/marketing#sec-tasks'));
});

module.exports = router;
