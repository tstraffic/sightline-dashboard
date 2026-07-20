const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { autoLogDiary, logStatusChange } = require('../lib/diary');
const { sydneyToday } = require('../lib/sydney');
const planStatus = require('../lib/planStatus');
const { notifyPlanSubmission, parseTaggedIds } = require('../lib/planNotify');

// Friendly labels for sub-plan item types (used in submission notifications).
const ITEM_TYPE_LABELS = {
  tmp_approval: 'TMP / CTMP', council_permit: 'Council Permit', traffic_guidance: 'Traffic Guidance Scheme',
  rol: 'Road Occupancy Licence', road_occupancy: 'Road Occupancy Licence', spa: 'SPA', sza: 'SZA',
  bus_approval: 'Bus Approval', police_notification: 'Police Notification', letter_drop: 'Letter Drop',
  insurance: 'Insurance', swms_review: 'SWMS Review', induction: 'Induction',
  utility_clearance: 'Utility Clearance', environmental: 'Environmental', other: 'Plan / Approval',
};

// Multer config for compliance document uploads
const complianceStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'data', 'uploads', 'compliance', req.params.id || 'new');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const complianceUpload = multer({
  storage: complianceStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|doc|docx|xls|xlsx|csv|txt|jpg|jpeg|png|gif|webp|dwg|dxf)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

// Sub-plan uploads land under compliance/<subPlanId>/ — same shape as the
// parent compliance dirs, just keyed on req.params.subId.
const subPlanStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'data', 'uploads', 'compliance', req.params.subId || 'new');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const subPlanUpload = multer({
  storage: subPlanStorage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /\.(pdf|doc|docx|xls|xlsx|csv|txt|jpg|jpeg|png|gif|webp|dwg|dxf)$/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

// Loads a row and confirms it's a sub-plan (parent_id IS NOT NULL).
function getSubPlan(db, subId) {
  return db.prepare("SELECT * FROM compliance WHERE id = ? AND parent_id IS NOT NULL").get(subId);
}

// Sub-plan types the count grid offers on the create form.
const SUB_PLAN_TYPES = [
  'traffic_guidance', 'tmp_approval', 'spa', 'sza', 'rol',
  'council_permit', 'bus_approval', 'police_notification',
  'letter_drop', 'other',
];

// Creates a parent Plan + N pre-numbered Sub-Plans atomically. Body shape:
//   title, job_id, client_id, client_request_date,
//   count_<type>=N for each ticked type
function createParentPlan(req, res, db, b) {
  const title = (b.title || '').trim();
  if (!title) {
    req.flash('error', 'Title is required.');
    return req.session.save(() => res.redirect('back'));
  }
  const planNumber = planStatus.nextPlanNumber(db);
  const jobId = b.job_id || null;
  const clientId = b.client_id || null;
  const tenderId = b.tender_id ? (parseInt(b.tender_id, 10) || null) : null;
  const clientRequestDate = b.client_request_date || null;
  const pmId = b.pm_id || null;

  let parentId = null;
  let subPlanCount = 0;
  let raCreatedCount = 0;
  try {
    // Detect tender_id column once; legacy DBs without migration 158 fall back gracefully.
    let hasTenderCol = false;
    try {
      hasTenderCol = db.prepare("PRAGMA table_info(compliance)").all().some(c => c.name === 'tender_id');
    } catch (e) {}

    const tx = db.transaction(() => {
      // item_type is NOT NULL + CHECK in legacy schema; use 'other' as a
      // benign placeholder. Parent rows are distinguished from regular
      // 'other'-typed legacy rows by plan_number IS NOT NULL.
      const parentInsertSql = hasTenderCol
        ? `INSERT INTO compliance (parent_id, plan_number, item_type, item_types, job_id, client_id, tender_id, title, status, client_request_date, notes, assigned_to_id)
           VALUES (NULL, ?, 'other', '', ?, ?, ?, ?, 'not_started', ?, ?, ?)`
        : `INSERT INTO compliance (parent_id, plan_number, item_type, item_types, job_id, client_id, title, status, client_request_date, notes, assigned_to_id)
           VALUES (NULL, ?, 'other', '', ?, ?, ?, 'not_started', ?, ?, ?)`;
      const parentRes = hasTenderCol
        ? db.prepare(parentInsertSql).run(planNumber, jobId, clientId, tenderId, title, clientRequestDate, b.notes || '', pmId)
        : db.prepare(parentInsertSql).run(planNumber, jobId, clientId, title, clientRequestDate, b.notes || '', pmId);
      parentId = parentRes.lastInsertRowid;

      const subInsertSql = hasTenderCol
        ? `INSERT INTO compliance (parent_id, job_id, client_id, tender_id, item_type, item_types, title, status, reference_number, description, assigned_to_id, other_description)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'not_started', ?, '', ?, ?)`
        : `INSERT INTO compliance (parent_id, job_id, client_id, item_type, item_types, title, status, reference_number, description, assigned_to_id, other_description)
           VALUES (?, ?, ?, ?, ?, ?, 'not_started', ?, '', ?, ?)`;
      const insertSub = db.prepare(subInsertSql);

      // For 'Other', each generated sub-plan gets its own description from
      // body field `other_description_<seq>`. Falls back to legacy single
      // `other_description` field if the per-row inputs aren't present.
      const legacyOtherDesc = String(b.other_description || '').trim().slice(0, 120);

      // Optional: also create a Risk Assessment record per TGS sub-plan
      // when the parent form's "RA needed" toggle was ticked for TGS.
      // Detect the risk_assessments shape once — schema v199 adds the
      // compliance_id + template_type columns; older DBs fall through.
      let raReady = false;
      try {
        const raCols = db.prepare("PRAGMA table_info(risk_assessments)").all().map(c => c.name);
        raReady = raCols.includes('compliance_id') && raCols.includes('template_type') && raCols.includes('responses_json');
      } catch (e) {}
      const insertRa = raReady ? db.prepare(`
        INSERT INTO risk_assessments (title, description, kind, status, job_id, owner_id, expiry_date,
          compliance_id, template_type, created_by_id, created_at, updated_at)
        VALUES (?, '', 'job', 'draft', ?, ?, date('now', '+6 months'), ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `) : null;
      SUB_PLAN_TYPES.forEach(type => {
        const raw = b['count_' + type];
        const count = parseInt(raw, 10);
        if (!Number.isFinite(count) || count <= 0) return;
        const typeOwnerId = b['owner_' + type] || null;
        const raNeeded = type === 'traffic_guidance' && (b['ra_needed_' + type] === '1' || b['ra_needed_' + type] === 1 || b['ra_needed_' + type] === 'on' || b['ra_needed_' + type] === true);
        for (let seq = 1; seq <= count; seq++) {
          const ref = planStatus.buildSubPlanRef(planNumber, type, seq);
          let subTitle = ref;
          let subOtherDesc = '';
          if (type === 'other') {
            const perRow = String(b['other_description_' + seq] || '').trim().slice(0, 120);
            subOtherDesc = perRow || legacyOtherDesc;
            if (subOtherDesc) subTitle = `${subOtherDesc} (${ref})`;
          }
          let subRes;
          if (hasTenderCol) {
            subRes = insertSub.run(parentId, jobId, clientId, tenderId, type, type, subTitle, ref, typeOwnerId, subOtherDesc);
          } else {
            subRes = insertSub.run(parentId, jobId, clientId, type, type, subTitle, ref, typeOwnerId, subOtherDesc);
          }
          subPlanCount += 1;
          if (raNeeded && insertRa) {
            try {
              insertRa.run('RA — ' + ref, jobId, typeOwnerId, subRes.lastInsertRowid, 'tgs_risk_options', req.session.user.id);
              raCreatedCount += 1;
            } catch (raErr) { console.error('[Compliance] auto-create RA failed for ' + ref + ':', raErr.message); }
          }
        }
      });
    });
    tx();
    planStatus.syncParentStatus(db, parentId);

    autoLogDiary(db, {
      jobId, complianceItemId: parentId,
      summary: `[${req.session.user.full_name}] Created Plan ${title} (#${planNumber}) with ${subPlanCount} sub-plan(s).`,
      userId: req.session.user.id
    });

    // Notify admin + planning that a new plan was created, plus any tagged users.
    try {
      const jobNumber = jobId
        ? (db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(jobId) || {}).job_number
        : null;
      notifyPlanSubmission(db, {
        submitterId: req.session.user.id,
        submitterName: req.session.user.full_name,
        taggedIds: parseTaggedIds(b.notify_user_ids),
        ref: '#' + planNumber,
        label: `"${title}"`,
        jobNumber,
        link: '/compliance/' + parentId + '/edit',
        jobId: jobId || null,
        verb: 'created',
      });
    } catch (notifyErr) {
      console.error('[Compliance] new-plan notify failed:', notifyErr.message);
    }

    const raSuffix = raCreatedCount > 0 ? ` + ${raCreatedCount} Risk Assessment${raCreatedCount === 1 ? '' : 's'} drafted` : '';
    req.flash('success', `Plan #${planNumber} created with ${subPlanCount} sub-plan slot(s)${raSuffix}.`);
    return req.session.save(() => res.redirect('/compliance/' + parentId + '/edit'));
  } catch (err) {
    console.error('[Compliance] createParentPlan error:', err.message);
    req.flash('error', 'Failed to create Plan: ' + err.message);
    return req.session.save(() => res.redirect('/compliance/new'));
  }
}

function weekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}
function toDateStr(d) { return d.toISOString().split('T')[0]; }

router.get('/', (req, res) => {
  const db = getDb();
  const { status, job_id, client_id, item_type, view = 'all', ref, date_from, date_to, invoice_state } = req.query;

  let query = `SELECT c.*, j.job_number, j.client as job_client,
    cl.company_name as client_name,
    u.full_name as approver_name, a.full_name as assigned_name,
    rfi.full_name as ready_for_invoice_by_name,
    inv.full_name as invoiced_by_name
    FROM compliance c
    LEFT JOIN jobs j ON c.job_id = j.id
    LEFT JOIN clients cl ON c.client_id = cl.id
    LEFT JOIN users u ON c.internal_approver_id = u.id
    LEFT JOIN users a ON c.assigned_to_id = a.id
    LEFT JOIN users rfi ON c.ready_for_invoice_by = rfi.id
    LEFT JOIN users inv ON c.invoiced_by_id = inv.id
    WHERE c.parent_id IS NULL`;
  // ^ Sub-plans live nested under their parent on the page; the top-level
  // list shows parents + legacy flat rows only.
  const params = [];

  if (status && status !== 'all')       { query += ` AND c.status = ?`;     params.push(status); }
  if (job_id)                           { query += ` AND c.job_id = ?`;     params.push(job_id); }
  if (client_id)                        { query += ` AND c.client_id = ?`;  params.push(client_id); }
  // Type filter: a Plan's real type(s) live on its SUB-PLANS (the parent row
  // is a header with item_type 'other'), so match the parent's own type/types
  // OR any child sub-plan of that type. Without the EXISTS clause, filtering
  // by TGS/ROL/etc. returned nothing after every plan became a parent. ROL is
  // stored as both 'rol' (new) and 'road_occupancy' (legacy) — the ROL chip
  // matches either.
  if (item_type && item_type !== 'all') {
    const typeAliases = (item_type === 'rol' || item_type === 'road_occupancy') ? ['rol', 'road_occupancy'] : [item_type];
    const inList = typeAliases.map(() => '?').join(',');
    query += ` AND (c.item_type IN (${inList}) OR c.item_types LIKE ? OR EXISTS (SELECT 1 FROM compliance sc WHERE sc.parent_id = c.id AND sc.item_type IN (${inList})))`;
    params.push(...typeAliases, `%${item_type}%`, ...typeAliases);
  }
  if (date_from) { query += ` AND c.due_date >= ?`; params.push(date_from); }
  if (date_to)   { query += ` AND c.due_date <= ?`; params.push(date_to); }

  // Invoice workflow filter — pending / ready / invoiced
  if (invoice_state === 'pending')  query += ` AND COALESCE(c.ready_for_invoice, 0) = 0 AND COALESCE(c.invoiced, 0) = 0`;
  if (invoice_state === 'ready')    query += ` AND COALESCE(c.ready_for_invoice, 0) = 1 AND COALESCE(c.invoiced, 0) = 0`;
  if (invoice_state === 'invoiced') query += ` AND COALESCE(c.invoiced, 0) = 1`;

  const today = new Date();
  let prevRef = null, nextRef = null, periodLabel = null;

  if (view === 'week') {
    const base = ref ? new Date(ref) : today;
    const ws = weekStart(base);
    const we = new Date(ws); we.setDate(ws.getDate() + 6);
    const rangeStart = toDateStr(ws), rangeEnd = toDateStr(we);
    const prevWs = new Date(ws); prevWs.setDate(ws.getDate() - 7);
    const nextWs = new Date(ws); nextWs.setDate(ws.getDate() + 7);
    prevRef = toDateStr(prevWs);
    nextRef = toDateStr(nextWs);
    periodLabel = `${ws.toLocaleDateString('en-AU', { day: '2-digit', month: 'short' })} – ${we.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}`;
    query += ` AND c.due_date BETWEEN ? AND ?`;
    params.push(rangeStart, rangeEnd);
  } else if (view === 'month') {
    const base = ref ? new Date(ref + '-01') : today;
    const ms = new Date(base.getFullYear(), base.getMonth(), 1);
    const me = new Date(base.getFullYear(), base.getMonth() + 1, 0);
    const rangeStart = toDateStr(ms), rangeEnd = toDateStr(me);
    const prevMs = new Date(base.getFullYear(), base.getMonth() - 1, 1);
    const nextMs = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    prevRef = `${prevMs.getFullYear()}-${String(prevMs.getMonth() + 1).padStart(2, '0')}`;
    nextRef = `${nextMs.getFullYear()}-${String(nextMs.getMonth() + 1).padStart(2, '0')}`;
    periodLabel = ms.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    query += ` AND c.due_date BETWEEN ? AND ?`;
    params.push(rangeStart, rangeEnd);
  }

  query += ` ORDER BY c.id DESC`;
  const items = db.prepare(query).all(...params);

  // Pull all sub-plans for visible parents in one shot, grouped by parent_id
  // for the inline expansion. Pre-bucketing here keeps the EJS simple.
  const parentIds = items.filter(i => i.parent_id == null && i.plan_number != null).map(i => i.id);
  const subPlansByParent = {};
  if (parentIds.length > 0) {
    const placeholders = parentIds.map(() => '?').join(',');
    const subs = db.prepare(`SELECT c.id, c.parent_id, c.item_type, c.reference_number, c.description, c.status, c.submitted_date, c.expiry_date, c.extension_required,
      c.hours_spent, c.charge_client, c.charge_amount, c.council_fee_paid, c.council_fee_amount,
      c.assigned_to_id, u.full_name AS owner_name
      FROM compliance c LEFT JOIN users u ON c.assigned_to_id = u.id
      WHERE c.parent_id IN (${placeholders}) ORDER BY c.item_type, c.reference_number`).all(...parentIds);
    const docCounts = db.prepare(`SELECT compliance_id, COUNT(*) as c FROM compliance_documents WHERE compliance_id IN (SELECT id FROM compliance WHERE parent_id IN (${placeholders})) GROUP BY compliance_id`).all(...parentIds);
    const dcMap = {};
    docCounts.forEach(r => { dcMap[r.compliance_id] = r.c; });
    subs.forEach(s => {
      s.doc_count = dcMap[s.id] || 0;
      (subPlansByParent[s.parent_id] = subPlansByParent[s.parent_id] || []).push(s);
    });
  }

  // Bucket items into collapsible monthly groups, keyed by
  // client_request_date month. Plans with no request date go into a
  // single "Undated" group rendered first. Newest month first
  // otherwise — request dates flow naturally newest-on-top so admins
  // see fresh work without scrolling.
  const monthBuckets = new Map();
  items.forEach(it => {
    const reqDate = it.client_request_date && /^\d{4}-\d{2}/.test(it.client_request_date)
      ? it.client_request_date.slice(0, 7) : null;
    const key = reqDate || '0000-00';
    if (!monthBuckets.has(key)) monthBuckets.set(key, []);
    monthBuckets.get(key).push(it);
  });
  const sortedKeys = Array.from(monthBuckets.keys()).sort((a, b) => b.localeCompare(a));
  const currentMonthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const monthGroups = sortedKeys.map(key => {
    let label;
    if (key === '0000-00') {
      label = 'Undated';
    } else {
      const [y, m] = key.split('-');
      const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
      label = d.toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', month: 'long', year: 'numeric' });
    }
    return {
      key,
      label,
      items: monthBuckets.get(key),
      // Open the current month and the Undated bucket by default; older
      // months stay collapsed so the page isn't a wall of rows.
      open: key === currentMonthKey || key === '0000-00',
    };
  });

  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();

  const allItems = db.prepare('SELECT status, due_date, expiry_date, ready_for_invoice, invoiced, invoiced_at, charge_amount, costs FROM compliance').all();
  const todayStr = toDateStr(today);
  const soonStr = toDateStr(new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000));
  const cutoff30Str = toDateStr(new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000));
  const summary = {
    total: allItems.length,
    approved: allItems.filter(i => i.status === 'approved').length,
    pending: allItems.filter(i => ['not_started', 'submitted'].includes(i.status)).length,
    overdue: allItems.filter(i => i.due_date && i.due_date < todayStr && i.status !== 'approved' && i.status !== 'expired').length,
    expiringSoon: allItems.filter(i => i.status === 'approved' && i.expiry_date && i.expiry_date >= todayStr && i.expiry_date <= soonStr).length,
    // Invoice workflow stats
    readyForInvoice: allItems.filter(i => i.ready_for_invoice && !i.invoiced).length,
    readyForInvoiceValue: allItems.filter(i => i.ready_for_invoice && !i.invoiced)
      .reduce((sum, i) => sum + (parseFloat(i.charge_amount) || parseFloat(i.costs) || 0), 0),
    invoicedLast30: allItems.filter(i => i.invoiced && i.invoiced_at && i.invoiced_at >= cutoff30Str).length,
    invoicedLast30Value: allItems.filter(i => i.invoiced && i.invoiced_at && i.invoiced_at >= cutoff30Str)
      .reduce((sum, i) => sum + (parseFloat(i.charge_amount) || parseFloat(i.costs) || 0), 0),
  };

  res.render('compliance/index', {
    title: 'Plans & Approvals',
    items, monthGroups, jobs, clients, users,
    filters: { status: status || '', job_id: job_id || '', client_id: client_id || '', item_type: item_type || '', view, ref: ref || '', date_from: date_from || '', date_to: date_to || '', invoice_state: invoice_state || '' },
    view, periodLabel, prevRef, nextRef, summary,
    subPlansByParent,
    user: req.session.user
  });
});

// API: Generate next reference number for a given item_type
router.get('/api/next-ref', (req, res) => {
  const db = getDb();
  const type = req.query.item_type || '';

  const prefixMap = {
    traffic_guidance: 'TSTGS',
    road_occupancy: 'TSROL',
    rol: 'TSROL',
    council_permit: 'TSCA',
    tmp_approval: 'TSTMP',
    swms_review: 'TSSWMS',
    insurance: 'TSINS',
    induction: 'TSIND',
    environmental: 'TSENV',
    utility_clearance: 'TSUC',
    spa: 'TSSPA',
    police_notification: 'TSPN',
    letter_drop: 'TSLD',
    other: 'TSOTH',
  };
  const prefix = prefixMap[type] || 'TSREF';

  // Global monotonic counter — one shared number space across every
  // prefix so refs sort cleanly by recency and the sequence keeps
  // climbing instead of resetting per-type. Floor at 3000 (legacy
  // genesis) only kicks in for an empty DB; with data, the counter
  // simply continues from the highest existing suffix.
  const rows = db.prepare("SELECT reference_number FROM compliance WHERE reference_number IS NOT NULL AND reference_number != ''").all();
  const tailRe = /^TS[A-Z]+(\d+)(?:-\d+)?$/;
  let max = 3000;
  rows.forEach(r => {
    const match = (r.reference_number || '').match(tailRe);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  });
  const next = max + 1;

  res.json({ reference_number: prefix + next });
});

// API: Check if a reference number already exists
router.get('/api/check-ref', (req, res) => {
  const db = getDb();
  const refNum = req.query.reference_number || '';
  const excludeId = req.query.exclude_id || '';
  if (!refNum) return res.json({ exists: false });

  let query = 'SELECT id, title FROM compliance WHERE reference_number = ?';
  const params = [refNum];
  if (excludeId) { query += ' AND id != ?'; params.push(excludeId); }

  const existing = db.prepare(query).get(...params);
  res.json({ exists: !!existing, title: existing ? existing.title : '' });
});

// ============================================================
// Plans → Sub-Plans endpoints
//
// A "Plan" is a parent compliance row (parent_id IS NULL,
// item_type IS NULL, plan_number set). Its Sub-Plans are
// compliance rows with parent_id pointing back at it.
//
// Routes here handle add/remove of sub-plans from an existing
// parent, plus the per-sub-plan status transitions. Upload-and-
// submit is a single combined action: uploading files locks in
// submitted_date / expiry_date / notes and flips the sub-plan's
// status to 'submitted'.
// ============================================================

// Add a sub-plan to an existing parent. Body: { item_type, other_description? }.
// For 'other', other_description is the user-supplied label (e.g. "Methodologies",
// "Staging") so the row isn't anonymous in the register.
router.post('/:id/sub-plans', (req, res) => {
  const db = getDb();
  const parent = db.prepare("SELECT id, plan_number, job_id, client_id FROM compliance WHERE id = ? AND parent_id IS NULL AND plan_number IS NOT NULL").get(req.params.id);
  if (!parent) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Parent Plan not found' });
    req.flash('error', 'Parent Plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  const itemType = (req.body.item_type || '').trim();
  if (!itemType) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(400).json({ error: 'item_type required' });
    req.flash('error', 'Sub-plan type required.');
    return req.session.save(() => res.redirect('/compliance/' + parent.id + '/edit'));
  }
  const seq = planStatus.nextSubPlanSeq(db, parent.id, itemType);
  const ref = planStatus.buildSubPlanRef(parent.plan_number, itemType, seq);
  const otherDesc = itemType === 'other'
    ? String(req.body.other_description || '').trim().slice(0, 120)
    : '';
  // Title shows "<Other label> (REF)" when there is one, plain ref otherwise — matches
  // the createParentPlan path so newly-added rows look the same as initial-creation rows.
  const title = otherDesc ? `${otherDesc} (${ref})` : ref;
  const result = db.prepare(`
    INSERT INTO compliance (parent_id, job_id, client_id, item_type, item_types, title, status, reference_number, description, other_description)
    VALUES (?, ?, ?, ?, ?, ?, 'not_started', ?, '', ?)
  `).run(parent.id, parent.job_id || null, parent.client_id || null, itemType, itemType, title, ref, otherDesc);
  planStatus.syncParentStatus(db, parent.id);
  if (req.headers.accept && req.headers.accept.includes('json')) {
    return res.json({ success: true, id: result.lastInsertRowid, reference_number: ref, other_description: otherDesc });
  }
  req.flash('success', `Sub-plan ${ref} added.`);
  req.session.save(() => res.redirect('/compliance/' + parent.id + '/edit'));
});

// Inline description update for a sub-plan.
router.post('/sub-plans/:subId/description', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Sub-plan not found' });
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  const desc = (req.body.description || '').trim();
  db.prepare("UPDATE compliance SET description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(desc, sub.id);
  if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true, description: desc });
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Inline owner update for a sub-plan.
router.post('/sub-plans/:subId/owner', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Sub-plan not found' });
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  const ownerId = req.body.assigned_to_id || null;
  db.prepare("UPDATE compliance SET assigned_to_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ownerId, sub.id);
  if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true, assigned_to_id: ownerId });
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Toggle the ROL extension flag on a sub-plan.
router.post('/sub-plans/:subId/extension', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Sub-plan not found' });
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  const flag = (req.body.extension_required === '1' || req.body.extension_required === 1 || req.body.extension_required === true) ? 1 : 0;
  db.prepare("UPDATE compliance SET extension_required = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(flag, sub.id);
  if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true, extension_required: flag });
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Combined upload + submit. Files are required (≥1); submitted_date
// is required (validated server-side); expiry_date is optional.
// Notes are stored on the sub-plan's `notes` column. Status flips to
// 'submitted' as a side-effect of a successful upload.
router.post('/sub-plans/:subId/upload-submit', subPlanUpload.array('documents', 10), (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  const files = req.files || [];
  const desc = (req.body.description || sub.description || '').trim();
  if (!desc) {
    req.flash('error', 'Description is required before submitting.');
    return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  const submittedDateRaw = (req.body.submitted_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(submittedDateRaw)) {
    req.flash('error', 'Submission date is required.');
    return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  const hoursSpentParsed = parseFloat(req.body.hours_spent);
  if (!Number.isFinite(hoursSpentParsed) || hoursSpentParsed <= 0) {
    req.flash('error', 'Hours spent is required and must be greater than zero.');
    return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  // Job start is mandatory for ROL and Council Application sub-plans.
  const jobMandatory = ['council_permit', 'rol', 'road_occupancy'].includes(sub.item_type);
  if (jobMandatory && !/^\d{4}-\d{2}-\d{2}$/.test((req.body.job_date || '').trim())) {
    req.flash('error', 'Job start date is required for ' + (sub.item_type === 'council_permit' ? 'Council' : 'ROL') + ' plans.');
    return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  // Council permit applications are lodged before any document exists (the
  // permit/approval file only arrives once the council issues it), so a file
  // is NOT mandatory for council. Every other type still needs ≥1 file.
  const fileOptional = (sub.item_type === 'council_permit');
  if (files.length === 0 && !fileOptional) {
    // No files attached AND no existing files = can't submit.
    const existingDocs = db.prepare('SELECT COUNT(*) as c FROM compliance_documents WHERE compliance_id = ?').get(sub.id).c;
    if (existingDocs === 0) {
      req.flash('error', 'At least one file is required to submit.');
      return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
    }
  }
  try {
    const insDoc = db.prepare('INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    files.forEach(f => {
      const relPath = '/data/uploads/compliance/' + sub.id + '/' + f.filename;
      insDoc.run(sub.id, f.filename, f.originalname, relPath, f.size, f.mimetype || '', req.session.user.id);
    });

    const submittedDate = submittedDateRaw;
    // Expiry input only renders for ROL sub-plans; when it's absent, preserve
    // any existing value rather than wiping it.
    const expiryDate = (req.body.expiry_date !== undefined) ? (req.body.expiry_date || null) : (sub.expiry_date || null);
    const clientRequestDate = req.body.client_request_date || sub.client_request_date || null;
    const notes = req.body.notes || sub.notes || '';
    const hoursSpent = hoursSpentParsed;
    // Charging is now handled by the always-available inline "Charge client"
    // editor (POST /sub-plans/:subId/charge), decoupled from submission so it
    // works before AND after a plan is put in. Submitting must therefore NOT
    // clobber a charge set there — preserve the existing value when the submit
    // form doesn't carry the field (it no longer does).
    const chargeClient = (req.body.charge_client !== undefined)
      ? ((req.body.charge_client === '1' || req.body.charge_client === 1 || req.body.charge_client === true || req.body.charge_client === 'on') ? 1 : 0)
      : (sub.charge_client ? 1 : 0);
    const chargeAmount = (req.body.charge_amount !== undefined)
      ? (parseFloat(req.body.charge_amount) || 0)
      : (parseFloat(sub.charge_amount) || 0);
    // Council cost/fee is no longer captured here — it's driven by the itemised
    // Fees section (compliance_fees), which rolls up into council_fee_amount.

    const jobDate = req.body.job_date || sub.job_date || null;
    const councilPlanType = (req.body.council_plan_type !== undefined) ? req.body.council_plan_type : (sub.council_plan_type || '');
    db.prepare(`
      UPDATE compliance
      SET description = ?, status = 'submitted', submitted_date = ?, expiry_date = ?, notes = ?,
          hours_spent = ?,
          charge_client = ?, charge_amount = ?,
          job_date = ?, council_plan_type = ?, client_request_date = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(desc, submittedDate, expiryDate, notes,
           hoursSpent,
           chargeClient, chargeAmount,
           jobDate, councilPlanType, clientRequestDate,
           sub.id);

    planStatus.syncParentStatus(db, sub.parent_id);

    // Audit trail
    if (sub.job_id || req.session.user) {
      autoLogDiary(db, {
        jobId: sub.job_id, complianceItemId: sub.id,
        summary: `[${req.session.user.full_name}] Submitted ${sub.reference_number}: ${desc}. ${files.length} file(s) uploaded.${expiryDate ? ' Expires ' + expiryDate + '.' : ''}`,
        userId: req.session.user.id
      });
    }

    // Notify admin + planning, plus anyone the submitter tagged.
    try {
      const jobNumber = sub.job_id
        ? (db.prepare('SELECT job_number FROM jobs WHERE id = ?').get(sub.job_id) || {}).job_number
        : null;
      notifyPlanSubmission(db, {
        submitterId: req.session.user.id,
        submitterName: req.session.user.full_name,
        taggedIds: parseTaggedIds(req.body.notify_user_ids),
        ref: sub.reference_number,
        label: ITEM_TYPE_LABELS[sub.item_type] || 'Plan / Approval',
        jobNumber,
        link: '/compliance/' + sub.parent_id + '/edit',
        jobId: sub.job_id || null,
      });
    } catch (notifyErr) {
      console.error('[Compliance] submission notify failed:', notifyErr.message);
    }

    req.flash('success', `${sub.reference_number} submitted (${files.length} file(s) uploaded).`);
  } catch (err) {
    console.error('[Compliance] Sub-plan upload-submit error:', err.message);
    req.flash('error', 'Submission failed: ' + err.message);
  }
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Mark a sub-plan approved. Gated: must be 'submitted' first.
router.post('/sub-plans/:subId/approve', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Sub-plan not found' });
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  if (sub.status !== 'submitted') {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(400).json({ error: 'Sub-plan must be submitted before approval' });
    req.flash('error', 'Sub-plan must be submitted before it can be approved.');
    return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  const today = new Date().toISOString().split('T')[0];
  db.prepare("UPDATE compliance SET status = 'approved', approved_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(today, sub.id);
  planStatus.syncParentStatus(db, sub.parent_id);
  if (sub.job_id) {
    autoLogDiary(db, { jobId: sub.job_id, complianceItemId: sub.id,
      summary: `[${req.session.user.full_name}] Approved ${sub.reference_number}.`, userId: req.session.user.id });
  }
  if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true });
  req.flash('success', `${sub.reference_number} approved.`);
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Mark a sub-plan rejected. Allowed from any status.
router.post('/sub-plans/:subId/reject', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Sub-plan not found' });
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  db.prepare("UPDATE compliance SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(sub.id);
  planStatus.syncParentStatus(db, sub.parent_id);
  if (sub.job_id) {
    autoLogDiary(db, { jobId: sub.job_id, complianceItemId: sub.id,
      summary: `[${req.session.user.full_name}] Rejected ${sub.reference_number}.`, userId: req.session.user.id });
  }
  if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true });
  req.flash('success', `${sub.reference_number} marked rejected.`);
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Delete a sub-plan and its documents. Parent status re-synced after.
router.post('/sub-plans/:subId/delete', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) {
    if (req.headers.accept && req.headers.accept.includes('json')) return res.status(404).json({ error: 'Sub-plan not found' });
    req.flash('error', 'Sub-plan not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  const parentId = sub.parent_id;
  // Remove docs (rows + files on disk)
  const docs = db.prepare('SELECT id, file_path FROM compliance_documents WHERE compliance_id = ?').all(sub.id);
  docs.forEach(d => {
    try { fs.unlinkSync(path.join(__dirname, '..', 'data', d.file_path)); } catch (e) {}
  });
  db.prepare('DELETE FROM compliance_documents WHERE compliance_id = ?').run(sub.id);
  // site_diary_entries.compliance_item_id is ON DELETE NO ACTION; detach first.
  try { db.prepare('UPDATE site_diary_entries SET compliance_item_id = NULL WHERE compliance_item_id = ?').run(sub.id); } catch (e) {}
  db.prepare('DELETE FROM compliance WHERE id = ?').run(sub.id);
  planStatus.syncParentStatus(db, parentId);
  if (req.headers.accept && req.headers.accept.includes('json')) return res.json({ success: true });
  req.flash('success', `Sub-plan ${sub.reference_number} removed.`);
  req.session.save(() => res.redirect('/compliance/' + parentId + '/edit'));
});

// ─── Plans Module enhancements on the compliance sub-plan ────────────────
const wantsJson = (req) => !!(req.headers.accept && req.headers.accept.includes('json'));
const subRel = (sub, f) => '/data/uploads/compliance/' + sub.id + '/' + f.filename;
const unlinkRel = (p) => { if (p) { try { fs.unlinkSync(path.join(__dirname, '..', String(p).replace(/^\//, ''))); } catch (e) {} } };

// Inline save: Job Date + free-text Type of Council Plan (spec §2/§3).
router.post('/sub-plans/:subId/details', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  db.prepare("UPDATE compliance SET job_date = ?, council_plan_type = ?, client_request_date = COALESCE(?, client_request_date), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(req.body.job_date || null, req.body.council_plan_type || '', req.body.client_request_date || null, sub.id);
  if (wantsJson(req)) return res.json({ success: true });
  req.flash('success', 'Details saved.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Manual ROL entry — the counterpart to the PDF auto-extract. Captures the
// applied-for date (drives the 14-day expiry + 10-day chase), the manually
// keyed ROL licence number, the approved date range + time window, and an
// optional "mark approved". The auto-generated TSROL ref lives on
// reference_number and isn't touched here.
router.post('/sub-plans/:subId/rol-manual', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  if (sub.item_type !== 'rol' && sub.item_type !== 'road_occupancy') {
    if (wantsJson(req)) return res.status(400).json({ error: 'Not a ROL sub-plan' });
    req.flash('error', 'Not a ROL sub-plan.'); return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  const b = req.body;
  const appliedDate = /^\d{4}-\d{2}-\d{2}$/.test(b.rol_applied_date || '') ? b.rol_applied_date : null;
  const approved = b.mark_approved === '1' || b.mark_approved === 'on';
  // Stage: approved wins; else 'applied' once an application date exists; else keep.
  const stage = approved ? 'approved' : (appliedDate ? 'applied' : (sub.rol_stage || 'none'));
  db.prepare(`
    UPDATE compliance SET
      rol_applied_date = ?,
      rol_actual_number = ?,
      rol_summary_from = ?,
      rol_summary_to = ?,
      rol_time_window = ?,
      rol_stage = ?,
      status = CASE WHEN ? = 1 THEN 'approved' ELSE status END,
      approved_date = CASE WHEN ? = 1 THEN COALESCE(approved_date, date('now','localtime')) ELSE approved_date END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    appliedDate,
    String(b.rol_actual_number || '').trim().slice(0, 120),
    /^\d{4}-\d{2}-\d{2}$/.test(b.rol_summary_from || '') ? b.rol_summary_from : null,
    /^\d{4}-\d{2}-\d{2}$/.test(b.rol_summary_to || '') ? b.rol_summary_to : null,
    String(b.rol_time_window || '').trim().slice(0, 120),
    stage,
    approved ? 1 : 0,
    approved ? 1 : 0,
    sub.id
  );
  if (wantsJson(req)) return res.json({ success: true });
  req.flash('success', 'ROL details saved.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Link a TGS sub-plan to a ROL sub-plan of the SAME plan (or clear the link).
router.post('/sub-plans/:subId/link-rol', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  let linkId = parseInt(req.body.linked_rol_id, 10) || null;
  if (linkId) {
    // Only allow linking to a ROL sub-plan under the same parent plan.
    const target = db.prepare("SELECT id FROM compliance WHERE id = ? AND parent_id = ? AND item_type IN ('rol','road_occupancy')").get(linkId, sub.parent_id);
    if (!target) linkId = null;
  }
  db.prepare("UPDATE compliance SET linked_rol_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(linkId, sub.id);
  if (wantsJson(req)) return res.json({ success: true, linked_rol_id: linkId });
  req.flash('success', linkId ? 'Linked to ROL.' : 'ROL link cleared.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Charge the client — set/clear the charge flag + amount independently of the
// upload/submit flow, so it can be edited at ANY status (before submitting,
// after submitting, even once approved). This is its own dedicated form, so an
// unchecked box (charge_client absent from the body) correctly means "don't
// charge". Body arrives urlencoded (see __subPlanAjaxSave), so the global
// express.urlencoded parser handles it — no per-route body middleware needed.
router.post('/sub-plans/:subId/charge', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const chargeClient = (req.body.charge_client === '1' || req.body.charge_client === 1 || req.body.charge_client === true || req.body.charge_client === 'on') ? 1 : 0;
  const chargeAmount = chargeClient ? (parseFloat(req.body.charge_amount) || 0) : 0;
  db.prepare("UPDATE compliance SET charge_client = ?, charge_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(chargeClient, chargeAmount, sub.id);
  if (wantsJson(req)) return res.json({ success: true, charge_client: chargeClient, charge_amount: chargeAmount });
  req.flash('success', 'Charge updated.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Council permit application reference number — the council-issued reference
// for a lodged application, captured beside the Charge client control and
// editable at any status. AJAX-saved (urlencoded, like /charge).
router.post('/sub-plans/:subId/app-ref', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const ref = String(req.body.application_ref_no || '').trim().slice(0, 120);
  db.prepare("UPDATE compliance SET application_ref_no = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(ref, sub.id);
  if (wantsJson(req)) return res.json({ success: true, application_ref_no: ref });
  req.flash('success', 'Application ref saved.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Council permit two-stage workflow (spec: "first stage is applied, then mark
// as approved and drag drop/select file"):
//   action=apply   → status 'submitted'. Requires Description + Submission date
//                    + Job start (saved here); a file is optional at this stage.
//   action=approve → attaches any dropped/selected file(s), status 'approved',
//                    stamps approved_date. File is optional here too.
// The council-issued application ref rides along on either action so it can be
// filled in at the moment of applying.
router.post('/sub-plans/:subId/council', subPlanUpload.array('documents', 10), (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  if (sub.item_type !== 'council_permit') {
    if (wantsJson(req)) return res.status(400).json({ error: 'Not a council permit sub-plan' });
    req.flash('error', 'Not a council permit sub-plan.'); return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
  }
  const action = req.body.action === 'approve' ? 'approve' : 'apply';
  const files = req.files || [];
  const today = new Date().toISOString().split('T')[0];
  const parentEdit = '/compliance/' + sub.parent_id + '/edit';

  // Applying lodges the application, so the core details must be in first:
  // Description, Submission date, Job start. (Files stay optional.)
  const desc = String(req.body.description || '').trim();
  const submittedDate = String(req.body.submitted_date || '').trim();
  const jobDate = String(req.body.job_date || '').trim();
  const dateOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
  if (action === 'apply') {
    const missing = [];
    if (!desc) missing.push('Description');
    if (!dateOk(submittedDate)) missing.push('Submission date');
    if (!dateOk(jobDate)) missing.push('Job start date');
    if (missing.length) {
      const msg = missing.join(', ') + (missing.length > 1 ? ' are' : ' is') + ' required before a council permit can be marked as applied.';
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      req.flash('error', msg);
      return req.session.save(() => res.redirect(parentEdit));
    }
  }

  // Persist the council application ref whenever it's supplied (both stages).
  if (req.body.application_ref_no !== undefined) {
    db.prepare("UPDATE compliance SET application_ref_no = ? WHERE id = ?")
      .run(String(req.body.application_ref_no || '').trim().slice(0, 120), sub.id);
  }

  // Attach any dropped/selected files (optional at either stage).
  if (files.length) {
    const insDoc = db.prepare('INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    files.forEach(f => insDoc.run(sub.id, f.filename, f.originalname, subRel(sub, f), f.size, f.mimetype || '', req.session.user.id));
  }

  if (action === 'apply') {
    // Lodged: save the required details + flip to submitted.
    db.prepare("UPDATE compliance SET description = ?, submitted_date = ?, job_date = ?, status = CASE WHEN status = 'approved' THEN status ELSE 'submitted' END, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(desc, submittedDate, jobDate, sub.id);
  } else {
    db.prepare("UPDATE compliance SET status = 'approved', approved_date = COALESCE(approved_date, ?), submitted_date = COALESCE(submitted_date, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(today, today, sub.id);
  }
  planStatus.syncParentStatus(db, sub.parent_id);
  if (sub.job_id) {
    autoLogDiary(db, { jobId: sub.job_id, complianceItemId: sub.id,
      summary: `[${req.session.user.full_name}] ${action === 'approve' ? 'Approved' : 'Lodged'} council permit ${sub.reference_number}${files.length ? ' (+' + files.length + ' file' + (files.length > 1 ? 's' : '') + ')' : ''}.`,
      userId: req.session.user.id });
  }
  if (wantsJson(req)) return res.json({ success: true });
  req.flash('success', action === 'approve' ? `${sub.reference_number} approved.` : `${sub.reference_number} marked applied.`);
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Roll the itemised fees up into the legacy council_fee_amount/_paid columns
// so the P&L, list view and invoice workflow (which all read council_fee_amount)
// stay correct now that the single "Council cost / fee" input is gone.
function rollupCouncilFee(db, complianceId) {
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM compliance_fees WHERE compliance_id = ?').get(complianceId).t || 0;
  db.prepare('UPDATE compliance SET council_fee_amount = ?, council_fee_paid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(total, total > 0 ? 1 : 0, complianceId);
}

// Itemised fees with receipts (spec §5).
router.post('/sub-plans/:subId/fees', subPlanUpload.single('receipt'), (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  db.prepare("INSERT INTO compliance_fees (compliance_id, description, amount, receipt_file_path, receipt_original_name, created_by) VALUES (?,?,?,?,?,?)")
    .run(sub.id, req.body.description || '', parseFloat(req.body.amount) || 0, req.file ? subRel(sub, req.file) : '', req.file ? req.file.originalname : '', req.session.user.id);
  rollupCouncilFee(db, sub.id);
  req.flash('success', 'Fee added.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});
router.post('/sub-plans/:subId/fees/:feeId/delete', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const fee = db.prepare('SELECT * FROM compliance_fees WHERE id = ? AND compliance_id = ?').get(req.params.feeId, sub.id);
  if (fee) { unlinkRel(fee.receipt_file_path); db.prepare('DELETE FROM compliance_fees WHERE id = ?').run(fee.id); }
  rollupCouncilFee(db, sub.id);
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Extension records (spec §4) — ROL / Council.
router.post('/sub-plans/:subId/extensions', subPlanUpload.single('extension_file'), (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  db.prepare("INSERT INTO compliance_extensions (compliance_id, label, extended_to, reason, file_path, file_original_name, created_by) VALUES (?,?,?,?,?,?,?)")
    .run(sub.id, req.body.label || '', req.body.extended_to || null, req.body.reason || '', req.file ? subRel(sub, req.file) : '', req.file ? req.file.originalname : '', req.session.user.id);
  if (sub.item_type === 'rol' || sub.item_type === 'road_occupancy') { try { db.prepare("UPDATE compliance SET extension_required = 1 WHERE id = ?").run(sub.id); } catch (e) {} }
  autoLogDiary(db, { jobId: sub.job_id, complianceItemId: sub.id, summary: `[${req.session.user.full_name}] Extension added to ${sub.reference_number}${req.body.extended_to ? ' (to ' + req.body.extended_to + ')' : ''}.`, userId: req.session.user.id });
  req.flash('success', 'Extension added.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});
router.post('/sub-plans/:subId/extensions/:extId/delete', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const ext = db.prepare('SELECT * FROM compliance_extensions WHERE id = ? AND compliance_id = ?').get(req.params.extId, sub.id);
  if (ext) { unlinkRel(ext.file_path); db.prepare('DELETE FROM compliance_extensions WHERE id = ?').run(ext.id); }
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// CTMP QA status (spec §6) — set on the (tmp_approval) sub-plan.
router.post('/sub-plans/:subId/qa', (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { if (wantsJson(req)) return res.status(404).json({ error: 'Sub-plan not found' }); req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const qa = req.body.qa_status || 'pending';
  db.prepare("UPDATE compliance SET qa_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(qa, sub.id);
  if (wantsJson(req)) return res.json({ success: true });
  req.flash('success', 'QA status updated.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// Replace this sub-plan's ROL conditions (one per line; leading "!" = alert).
function replaceComplianceConditions(db, cid, raw) {
  db.prepare('DELETE FROM compliance_rol_conditions WHERE compliance_id = ?').run(cid);
  const lines = String(raw || '').split('\n').map(l => l.trim()).filter(Boolean);
  const ins = db.prepare('INSERT INTO compliance_rol_conditions (compliance_id, condition_no, text, is_alert) VALUES (?,?,?,?)');
  lines.forEach((line, i) => { const a = line.startsWith('!') ? 1 : 0; ins.run(cid, i + 1, a ? line.slice(1).trim() : line, a); });
}
function saveComplianceShifts(db, cid, source, json) {
  let arr; try { arr = JSON.parse(json || '[]'); } catch (e) { return; }
  if (!Array.isArray(arr)) return;
  db.prepare('DELETE FROM compliance_rol_shifts WHERE compliance_id = ? AND source = ?').run(cid, source);
  const ins = db.prepare('INSERT INTO compliance_rol_shifts (compliance_id, source, start_date, start_time, end_date, end_time) VALUES (?,?,?,?,?,?)');
  for (const s of arr) ins.run(cid, source, s.start_date || null, s.start_time || '', s.end_date || null, s.end_time || '');
}

// ROL PDF auto-extraction → review screen (parse-then-confirm, spec §8).
function parseComplianceRol(stage) {
  return async (req, res) => {
    const db = getDb();
    const sub = getSubPlan(db, req.params.subId);
    if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
    if (!req.file) { req.flash('error', 'Choose a PDF to extract.'); return req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit')); }
    const filePath = subRel(sub, req.file);
    try {
      const { parseRolPdf } = require('../services/rolParser');
      const parsed = await parseRolPdf(path.join(__dirname, '..', filePath.replace(/^\//, '')), stage);
      res.render('compliance/rol-review', { title: 'Review extracted ' + stage.toUpperCase(), sub, stage, parsed, filePath, fileOriginalName: req.file.originalname, user: req.session.user });
    } catch (err) {
      console.error('[Compliance] ' + stage + ' parse failed:', err.message);
      req.flash('error', 'Could not read that PDF automatically — enter details manually. (' + err.message + ')');
      req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
    }
  };
}
router.post('/sub-plans/:subId/rola/parse', subPlanUpload.single('rola_file'), parseComplianceRol('rola'));
router.post('/sub-plans/:subId/rol/parse', subPlanUpload.single('rol_file'), parseComplianceRol('rol'));

// ROL Stage 1 — ROLA application
router.post('/sub-plans/:subId/rola', subPlanUpload.single('rola_file'), (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const b = req.body;
  const filePath = req.file ? subRel(sub, req.file) : (b.existing_rola_file_path || sub.rola_file_path || '');
  const fileName = req.file ? req.file.originalname : (b.existing_rola_file_original_name || sub.rola_file_original_name || '');
  const stage = sub.rol_stage === 'approved' ? 'approved' : 'applied';
  db.prepare(`UPDATE compliance SET rola_application_number=?, rola_file_path=?, rola_file_original_name=?,
      rol_summary_from=COALESCE(?, rol_summary_from), rol_summary_to=COALESCE(?, rol_summary_to),
      rol_time_window=COALESCE(NULLIF(?, ''), rol_time_window), rol_stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.rola_application_number || '', filePath, fileName, b.rol_summary_from || null, b.rol_summary_to || null, b.rol_time_window || '', stage, sub.id);
  if (typeof b.shifts_json !== 'undefined') saveComplianceShifts(db, sub.id, 'rola', b.shifts_json);
  req.flash('success', 'ROLA application saved.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

// ROL Stage 2 — issued ROL
router.post('/sub-plans/:subId/rol', subPlanUpload.single('rol_file'), (req, res) => {
  const db = getDb();
  const sub = getSubPlan(db, req.params.subId);
  if (!sub) { req.flash('error', 'Sub-plan not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const b = req.body;
  const filePath = req.file ? subRel(sub, req.file) : (b.existing_rol_file_path || sub.rol_file_path || '');
  const fileName = req.file ? req.file.originalname : (b.existing_rol_file_original_name || sub.rol_file_original_name || '');
  db.prepare(`UPDATE compliance SET rol_actual_number=?, rol_file_path=?, rol_file_original_name=?,
      rol_summary_from=?, rol_summary_to=?, rol_time_window=?, rol_stage='approved', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.rol_actual_number || '', filePath, fileName, b.rol_summary_from || null, b.rol_summary_to || null, b.rol_time_window || '', sub.id);
  if (typeof b.conditions !== 'undefined') replaceComplianceConditions(db, sub.id, b.conditions);
  if (typeof b.shifts_json !== 'undefined') saveComplianceShifts(db, sub.id, 'rol', b.shifts_json);
  autoLogDiary(db, { jobId: sub.job_id, complianceItemId: sub.id, summary: `[${req.session.user.full_name}] Issued ROL ${b.rol_actual_number || ''} recorded on ${sub.reference_number}.`, userId: req.session.user.id });
  req.flash('success', 'Issued ROL saved.');
  req.session.save(() => res.redirect('/compliance/' + sub.parent_id + '/edit'));
});

router.get('/new', (req, res) => {
  const db = getDb();
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  let tenders = [];
  try { tenders = db.prepare("SELECT id, tender_number, title, status FROM tenders WHERE status IN ('open','submitted','won') ORDER BY id DESC").all(); } catch (e) {}
  res.render('compliance/form', {
    title: 'New Plan', item: null, jobs, clients, users, tenders,
    user: req.session.user, prefillJobId: req.query.job_id || '', prefillClientId: req.query.client_id || '',
    prefillTenderId: req.query.tender_id || '',
    returnTo: req.query.return_to || '/compliance', linkedTask: null, revisions: [],
    isParent: true, subPlans: [], subPlanDocs: {}, subPlanTypes: SUB_PLAN_TYPES,
  });
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;

  // New-style Plan create: body has the count grid (count_<type> fields)
  // and the is_parent flag. Inserts a parent row + N sub-plans atomically.
  if (b.is_parent === '1' || b.is_parent === 1) {
    return createParentPlan(req, res, db, b);
  }

  // Legacy flat-row create — preserved so existing /compliance/new flows
  // (and anything that posts the old shape) keep working.
  // Handle multi-select item types
  const typesArr = b.item_types ? (Array.isArray(b.item_types) ? b.item_types : [b.item_types]) : (b.item_type ? [b.item_type] : []);
  const itemTypes = typesArr.join(',');
  const itemType = typesArr[0] || '';
  const result = db.prepare(`
    INSERT INTO compliance (job_id, client_id, item_type, item_types, title, authority_approver, internal_approver_id, assigned_to_id, due_date, submitted_date, approved_date, expiry_date, status, notes, designer, file_link, council_fee_paid, council_fee_amount,
      reference_number, rol_required, rol_response, bus_approvals_required, bus_approvals_response, client_pm, costs, action_required, charge_client, charge_amount, invoiced, invoice_number, police_notification, letter_drop,
      tmp_response, spa_response, sza_response, council_response, tgs_response, police_response, letter_drop_response,
      tgs_quantity, received_date, revision_required, revision_count, start_date, finish_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id || null, b.client_id || null, itemType, itemTypes, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status || 'not_started', b.notes || '', b.designer || '', b.file_link || '', b.council_fee_paid === '1' || b.council_fee_paid === 1 ? 1 : 0, parseFloat(b.council_fee_amount) || 0,
    b.reference_number || '', b.rol_required ? 1 : 0, b.rol_response || '', b.bus_approvals_required ? 1 : 0, b.bus_approvals_response || '', b.client_pm || '', parseFloat(b.costs) || 0, b.action_required || '', b.charge_client === '1' || b.charge_client === 1 ? 1 : 0, parseFloat(b.charge_amount) || 0, b.invoiced === '1' || b.invoiced === 1 ? 1 : 0, b.invoice_number || '', b.police_notification ? 1 : 0, b.letter_drop ? 1 : 0,
    b.tmp_response || '', b.spa_response || '', b.sza_response || '', b.council_response || '', b.tgs_response || '', b.police_response || '', b.letter_drop_response || '',
    parseInt(b.tgs_quantity) || 1, b.received_date || null, b.revision_required ? 1 : 0, 0, b.start_date || null, b.finish_date || null);

  // Auto-create linked task when someone is assigned
  const complianceId = result.lastInsertRowid;
  if (b.assigned_to_id && b.status !== 'approved') {
    try {
      const typeLabels = { traffic_guidance: 'TGS', road_occupancy: 'ROL', rol: 'ROL', council_permit: 'Council Permit', tmp_approval: 'TMP', swms_review: 'SWMS', insurance: 'Insurance', induction: 'Induction', environmental: 'Environmental', utility_clearance: 'Utility Clearance', spa: 'SPA', sza: 'SZA', police_notification: 'Police Notification', letter_drop: 'Letter Drop', bus_approval: 'Bus Approval', other: 'Other' };
      const typeLabel = typesArr.map(t => typeLabels[t] || t).join(' / ') || 'Plan';
      const taskTitle = `${typeLabel}: ${b.title || 'Compliance Item'}`;
      db.prepare(`
        INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, priority, task_type, notes, created_by, compliance_id)
        VALUES (?, 'planning', ?, ?, ?, ?, 'not_started', 'medium', 'one_off', ?, ?, ?)
      `).run(
        b.job_id || null,
        taskTitle,
        `Auto-created from Plans & Approvals. Reference: ${b.reference_number || 'N/A'}`,
        b.assigned_to_id,
        b.due_date || new Date().toISOString().split('T')[0],
        b.action_required || '',
        req.session.user ? req.session.user.id : null,
        complianceId
      );
    } catch (taskErr) {
      console.error('[Compliance] Auto-task creation error:', taskErr.message);
    }
  }

  // Auto-log to site diary
  const typeLabelsForDiary = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council Permit', spa: 'SPA', sza: 'SZA', bus_approval: 'Bus Approval', police_notification: 'Police Notification', letter_drop: 'Letter Drop' };
  const typeLabel = typesArr.map(t => typeLabelsForDiary[t] || t).join(' / ') || 'Plan';
  autoLogDiary(db, {
    jobId: b.job_id,
    complianceItemId: complianceId,
    summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${typeLabel} created: ${b.title || 'Untitled'}. Ref: ${b.reference_number || 'N/A'}. Status: ${b.status || 'not_started'}.`,
    userId: req.session.user ? req.session.user.id : null
  });

  req.flash('success', 'Item created.' + (b.assigned_to_id && b.status !== 'approved' ? ' Task auto-created for assignee.' : ''));
  req.session.save(() => res.redirect(b.return_to || '/compliance'));
});

// Bulk operations (must be before /:id routes)
router.post('/bulk-delete', (req, res) => {
  try {
    const db = getDb();
    const ids = req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items selected' });
    const placeholders = ids.map(() => '?').join(',');
    // site_diary_entries.compliance_item_id is ON DELETE NO ACTION, so a linked
    // diary row blocks the delete. Detach diary links first, then delete.
    const tx = db.transaction(() => {
      db.prepare(`UPDATE site_diary_entries SET compliance_item_id = NULL WHERE compliance_item_id IN (${placeholders})`).run(...ids);
      db.prepare(`DELETE FROM compliance WHERE id IN (${placeholders})`).run(...ids);
    });
    tx();
    res.json({ success: true });
  } catch (e) {
    console.error('[compliance] bulk-delete failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/bulk-status', (req, res) => {
  const db = getDb();
  const { ids, status } = req.body;
  const validStatuses = ['not_started', 'started', 'submitted', 'approved', 'rejected', 'expired'];
  if (!Array.isArray(ids) || ids.length === 0 || !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid request' });
  const placeholders = ids.map(() => '?').join(',');
  // Log to diary before updating
  const items = db.prepare(`SELECT id, parent_id, job_id, title, reference_number, item_type, item_types, status as old_status FROM compliance WHERE id IN (${placeholders})`).all(...ids);
  db.prepare(`UPDATE compliance SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`).run(status, ...ids);
  // Roll up to each affected parent so the badge on the register/job pages
  // stays in step with the sub-plan it summarises.
  const affectedParents = new Set();
  items.forEach(it => { if (it.parent_id != null) affectedParents.add(it.parent_id); });
  affectedParents.forEach(pid => planStatus.syncParentStatus(db, pid));
  // Sync linked tasks so approved/submitted plans close their assigned task
  // instead of building up. Same status map as the single-edit handler.
  try {
    const statusMap = { not_started: 'not_started', started: 'in_progress', submitted: 'complete', approved: 'complete', rejected: 'not_started', expired: 'not_started' };
    const taskStatus = statusMap[status] || 'not_started';
    const today = new Date().toISOString().split('T')[0];
    const completedDate = taskStatus === 'complete' ? today : null;
    db.prepare(`
      UPDATE tasks
      SET status = ?, completed_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE compliance_id IN (${placeholders}) AND deleted_at IS NULL
    `).run(taskStatus, completedDate, ...ids);
  } catch (taskErr) {
    console.error('[Compliance bulk-status] task sync failed:', taskErr.message);
  }
  // Auto-log bulk status change to diary
  items.forEach(item => {
    if (item.job_id && item.old_status !== status) {
      const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
      const types = (item.item_types || item.item_type || '').split(',').map(t => typeMap[t] || t).join(' / ');
      autoLogDiary(db, {
        jobId: item.job_id, complianceItemId: item.id,
        summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${types} status changed (${item.reference_number || 'N/A'}): ${item.title}. ${(item.old_status || 'not_started').replace(/_/g, ' ')} → ${status.replace(/_/g, ' ')}.`,
        userId: req.session.user ? req.session.user.id : null
      });
    }
  });
  res.json({ success: true });
});

router.post('/bulk-ready-invoice', (req, res) => {
  const db = getDb();
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items' });
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`UPDATE compliance SET ready_for_invoice = 1, ready_for_invoice_at = CURRENT_TIMESTAMP, ready_for_invoice_by = ? WHERE id IN (${placeholders})`).run(req.session.user.id, ...ids);
  // Notify admin/accounts
  try {
    const accountsUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin','finance','accounts')").all();
    const insertNotif = db.prepare("INSERT INTO notifications (user_id, type, title, message, link) VALUES (?, 'invoice_ready', ?, ?, '/compliance')");
    accountsUsers.forEach(u => {
      try { insertNotif.run(u.id, ids.length + ' items ready for invoice', ids.length + ' compliance item(s) marked ready for invoice.', '/compliance'); } catch(e) {}
    });
  } catch(e) {}
  res.json({ success: true });
});

router.post('/bulk-invoiced', (req, res) => {
  const db = getDb();
  const { ids, invoice_number, charge_amount } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: 'No items' });
  // Only admin/finance/accounts can mark as invoiced
  if (!['admin', 'finance', 'accounts'].includes(req.session.user.role)) return res.status(403).json({ error: 'Only admin/accounts can mark as invoiced' });
  const chargeAmt = parseFloat(charge_amount);
  if (!Number.isFinite(chargeAmt) || chargeAmt <= 0) {
    return res.status(400).json({ error: 'Charge amount is required to mark invoiced' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const invNum = (invoice_number || '').toString().trim();
  if (invNum) {
    db.prepare(`UPDATE compliance SET invoiced = 1, invoice_number = ?, charge_client = 1, charge_amount = ?, invoiced_at = CURRENT_TIMESTAMP, invoiced_by_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`)
      .run(invNum, chargeAmt, req.session.user.id, ...ids);
  } else {
    db.prepare(`UPDATE compliance SET invoiced = 1, charge_client = 1, charge_amount = ?, invoiced_at = CURRENT_TIMESTAMP, invoiced_by_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`)
      .run(chargeAmt, req.session.user.id, ...ids);
  }
  res.json({ success: true });
});

// Helper: return the columns the front-end needs to re-render the invoice cell
function freshInvoiceState(db, id) {
  return db.prepare(`
    SELECT c.id, c.ready_for_invoice, c.ready_for_invoice_at, c.invoiced, c.invoice_number, c.invoiced_at,
      c.charge_client, c.charge_amount,
      rfi.full_name AS ready_for_invoice_by_name,
      inv.full_name AS invoiced_by_name
    FROM compliance c
    LEFT JOIN users rfi ON c.ready_for_invoice_by = rfi.id
    LEFT JOIN users inv ON c.invoiced_by_id = inv.id
    WHERE c.id = ?
  `).get(id);
}

// Mark a single item as invoiced (with optional invoice number)
router.post('/:id/mark-invoiced', (req, res) => {
  const db = getDb();
  const wantsJson = req.xhr || (req.headers.accept || '').includes('json');
  if (!['admin', 'finance', 'accounts'].includes(req.session.user.role)) {
    if (wantsJson) return res.status(403).json({ error: 'Only admin/accounts can mark as invoiced' });
    req.flash('error', 'Only admin or accounts can mark items as invoiced.');
    return req.session.save(() => res.redirect(req.body.return_to || '/compliance'));
  }
  const item = db.prepare('SELECT id, title, job_id FROM compliance WHERE id = ?').get(req.params.id);
  if (!item) {
    if (wantsJson) return res.status(404).json({ error: 'Item not found' });
    req.flash('error', 'Item not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }
  // Charge amount is mandatory before a row can be marked invoiced — you
  // can't bill nothing. Mark Ready remains unrestricted so finance can
  // queue rows even before the price is set.
  const chargeAmt = parseFloat(req.body.charge_amount);
  if (!Number.isFinite(chargeAmt) || chargeAmt <= 0) {
    if (wantsJson) return res.status(400).json({ error: 'Charge amount is required to mark invoiced' });
    req.flash('error', 'Enter a charge amount before marking as invoiced.');
    return req.session.save(() => res.redirect(req.body.return_to || '/compliance'));
  }
  const invNum = (req.body.invoice_number || '').toString().trim();
  if (invNum) {
    db.prepare(`UPDATE compliance SET invoiced = 1, invoice_number = ?, charge_client = 1, charge_amount = ?, invoiced_at = CURRENT_TIMESTAMP, invoiced_by_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(invNum, chargeAmt, req.session.user.id, item.id);
  } else {
    db.prepare(`UPDATE compliance SET invoiced = 1, charge_client = 1, charge_amount = ?, invoiced_at = CURRENT_TIMESTAMP, invoiced_by_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(chargeAmt, req.session.user.id, item.id);
  }
  if (wantsJson) return res.json({ success: true, item: freshInvoiceState(db, item.id) });
  req.flash('success', `Marked invoiced${invNum ? ' (' + invNum + ')' : ''}.`);
  req.session.save(() => res.redirect(req.body.return_to || '/compliance'));
});

// Undo invoiced state (admin only) — does NOT touch invoice_number, so a
// later "Mark invoiced" on the same row keeps the previous number unless
// explicitly changed.
router.post('/:id/unmark-invoiced', (req, res) => {
  const db = getDb();
  const wantsJson = req.xhr || (req.headers.accept || '').includes('json');
  if (!['admin', 'finance', 'accounts'].includes(req.session.user.role)) {
    if (wantsJson) return res.status(403).json({ error: 'Forbidden' });
    req.flash('error', 'Only admin or accounts can undo this.');
    return req.session.save(() => res.redirect(req.body.return_to || '/compliance'));
  }
  db.prepare('UPDATE compliance SET invoiced = 0, invoiced_at = NULL, invoiced_by_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  if (wantsJson) return res.json({ success: true, item: freshInvoiceState(db, req.params.id) });
  req.flash('success', 'Invoiced mark removed.');
  req.session.save(() => res.redirect(req.body.return_to || '/compliance'));
});

router.get('/:id/edit', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect('/compliance')); }
  const jobs = db.prepare("SELECT id, job_number, client, project_name FROM jobs WHERE status NOT IN ('closed','completed','cancelled') ORDER BY job_number").all();
  const clients = db.prepare('SELECT id, company_name FROM clients WHERE active = 1 ORDER BY company_name').all();
  const users = db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all();
  const returnTo = req.query.return_to || '/compliance';
  let documents = [];
  try { documents = db.prepare('SELECT cd.*, u.full_name as uploaded_by_name FROM compliance_documents cd LEFT JOIN users u ON cd.uploaded_by_id = u.id WHERE cd.compliance_id = ? ORDER BY cd.created_at DESC').all(item.id); } catch (e) { /* table may not exist yet */ }
  let linkedTask = null;
  try { linkedTask = db.prepare('SELECT t.id, t.title, t.status, t.owner_id, u.full_name as owner_name FROM tasks t LEFT JOIN users u ON t.owner_id = u.id WHERE t.compliance_id = ? AND t.deleted_at IS NULL').get(item.id); } catch (e) { /* column may not exist yet */ }
  let revisions = [];
  try { revisions = db.prepare('SELECT * FROM compliance_revisions WHERE compliance_id = ? ORDER BY revision_number ASC').all(item.id); } catch (e) { /* table may not exist yet */ }

  // Parent rows surface their sub-plans + each sub-plan's documents so
  // the edit page renders the new grid. Legacy + sub-plan rows pass
  // empty arrays through and fall back to the legacy form layout.
  // Discriminator: parent_id IS NULL AND plan_number IS NOT NULL.
  const isParent = item.parent_id == null && item.plan_number != null;
  let subPlans = [];
  let subPlanDocs = {};
  if (isParent) {
    subPlans = db.prepare("SELECT * FROM compliance WHERE parent_id = ? ORDER BY item_type, reference_number").all(item.id);
    if (subPlans.length > 0) {
      const ids = subPlans.map(s => s.id);
      const placeholders = ids.map(() => '?').join(',');
      const docRows = db.prepare(`SELECT cd.*, u.full_name as uploaded_by_name FROM compliance_documents cd LEFT JOIN users u ON cd.uploaded_by_id = u.id WHERE cd.compliance_id IN (${placeholders}) ORDER BY cd.created_at DESC`).all(...ids);
      docRows.forEach(d => {
        (subPlanDocs[d.compliance_id] = subPlanDocs[d.compliance_id] || []).push(d);
      });
    }
  }

  // Risk Assessments keyed by sub-plan id (the sub-plan card surfaces a
  // "Risk Assessment: …" badge with a link to the fill form + a
  // Generate Combined PDF button when RA is active + TGS uploaded).
  // Guarded with try/catch — pre-mig-199 DBs won't have compliance_id.
  let raBySubPlan = {};
  if (isParent && subPlans.length > 0) {
    try {
      const subIds = subPlans.map(s => s.id);
      const subPh = subIds.map(() => '?').join(',');
      const raRows = db.prepare(`SELECT id, compliance_id, title, status, template_type, combined_pdf_path FROM risk_assessments WHERE compliance_id IN (${subPh})`).all(...subIds);
      raRows.forEach(r => { raBySubPlan[r.compliance_id] = r; });
    } catch (e) { /* schema not migrated yet */ }
  }

  // Per-sub-plan council/ROL data for the card (fees, extensions, ROL
  // shifts/conditions). Guarded — pre-mig-247 DBs won't have these tables.
  let subPlanFees = {}, subPlanExtensions = {}, subPlanRolShifts = {}, subPlanRolConditions = {};
  if (isParent && subPlans.length > 0) {
    const subIds = subPlans.map(s => s.id);
    const ph = subIds.map(() => '?').join(',');
    try { db.prepare(`SELECT * FROM compliance_fees WHERE compliance_id IN (${ph}) ORDER BY created_at`).all(...subIds).forEach(r => (subPlanFees[r.compliance_id] = subPlanFees[r.compliance_id] || []).push(r)); } catch (e) {}
    try { db.prepare(`SELECT * FROM compliance_extensions WHERE compliance_id IN (${ph}) ORDER BY created_at`).all(...subIds).forEach(r => (subPlanExtensions[r.compliance_id] = subPlanExtensions[r.compliance_id] || []).push(r)); } catch (e) {}
    try { db.prepare(`SELECT * FROM compliance_rol_shifts WHERE compliance_id IN (${ph}) ORDER BY start_date, start_time`).all(...subIds).forEach(r => (subPlanRolShifts[r.compliance_id] = subPlanRolShifts[r.compliance_id] || []).push(r)); } catch (e) {}
    try { db.prepare(`SELECT * FROM compliance_rol_conditions WHERE compliance_id IN (${ph}) ORDER BY is_alert DESC, condition_no`).all(...subIds).forEach(r => (subPlanRolConditions[r.compliance_id] = subPlanRolConditions[r.compliance_id] || []).push(r)); } catch (e) {}
  }

  // Tender link (if this plan is rolled up under a tender)
  let tender = null;
  if (item.tender_id) {
    try { tender = db.prepare("SELECT id, tender_number, title, status FROM tenders WHERE id = ?").get(item.tender_id); } catch (e) {}
  }

  let tenders = [];
  try { tenders = db.prepare("SELECT id, tender_number, title, status FROM tenders ORDER BY id DESC").all(); } catch (e) {}

  res.render('compliance/form', {
    title: isParent ? 'Edit Plan' : 'Edit Plan / Approval',
    item, jobs, clients, users, tenders, user: req.session.user,
    prefillJobId: '', prefillClientId: '', prefillTenderId: '', returnTo,
    documents, linkedTask, revisions, tender,
    isParent, subPlans, subPlanDocs, subPlanTypes: SUB_PLAN_TYPES,
    raBySubPlan, subPlanFees, subPlanExtensions, subPlanRolShifts, subPlanRolConditions,
  });
});

router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  // Load old item to detect changes for diary logging
  const oldItem = db.prepare('SELECT * FROM compliance WHERE id = ?').get(req.params.id);

  // Parent rows (Plans → Sub-Plans hierarchy) update only the fields the
  // parent form actually surfaces. The legacy multi-field UPDATE below
  // would clobber item_type with empty string and trip the CHECK
  // constraint, so branch early.
  if (oldItem && oldItem.parent_id == null && oldItem.plan_number != null) {
    const wantsJson = req.headers.accept && req.headers.accept.includes('application/json');
    try {
      let hasTenderCol = false;
      try { hasTenderCol = db.prepare("PRAGMA table_info(compliance)").all().some(c => c.name === 'tender_id'); } catch (e) {}
      const newTenderId = b.tender_id ? (parseInt(b.tender_id, 10) || null) : null;
      if (hasTenderCol) {
        db.prepare(`
          UPDATE compliance
          SET title = ?, job_id = ?, client_id = ?, tender_id = ?, client_request_date = ?, notes = ?, assigned_to_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          b.title || oldItem.title,
          b.job_id || null,
          b.client_id || null,
          newTenderId,
          b.client_request_date || null,
          b.notes || '',
          b.pm_id || null,
          req.params.id
        );
        // Cascade tender_id to all sub-plans so the rollup stays consistent.
        try { db.prepare("UPDATE compliance SET tender_id = ? WHERE parent_id = ?").run(newTenderId, req.params.id); } catch (e) {}
      } else {
        db.prepare(`
          UPDATE compliance
          SET title = ?, job_id = ?, client_id = ?, client_request_date = ?, notes = ?, assigned_to_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(
          b.title || oldItem.title,
          b.job_id || null,
          b.client_id || null,
          b.client_request_date || null,
          b.notes || '',
          b.pm_id || null,
          req.params.id
        );
      }
      if (wantsJson) return res.json({ ok: true, savedAt: new Date().toISOString() });
      req.flash('success', 'Plan updated.');
    } catch (err) {
      console.error('[Compliance] Parent Plan update error:', err.message);
      if (wantsJson) return res.status(500).json({ ok: false, error: err.message });
      req.flash('error', 'Failed to update Plan: ' + err.message);
    }
    const returnTo = b.return_to && b.return_to !== '/compliance' ? b.return_to : '/compliance/' + req.params.id + '/edit';
    return req.session.save(() => res.redirect(returnTo));
  }

  // Handle multi-select item types
  const typesArr = b.item_types ? (Array.isArray(b.item_types) ? b.item_types : [b.item_types]) : (b.item_type ? [b.item_type] : []);
  const itemTypes = typesArr.join(',');
  const itemType = typesArr[0] || '';
  try {
    // Recalculate revision_count from revisions table
    let revCount = 0;
    try { revCount = db.prepare('SELECT COUNT(*) as c FROM compliance_revisions WHERE compliance_id = ?').get(req.params.id)?.c || 0; } catch(e) {}
    db.prepare(`
      UPDATE compliance SET job_id=?, client_id=?, item_type=?, item_types=?, title=?, authority_approver=?, internal_approver_id=?, assigned_to_id=?,
        due_date=?, submitted_date=?, approved_date=?, expiry_date=?, status=?, notes=?, designer=?, file_link=?, council_fee_paid=?, council_fee_amount=?,
        reference_number=?, rol_required=?, rol_response=?, bus_approvals_required=?, bus_approvals_response=?, client_pm=?, costs=?, action_required=?, charge_client=?, charge_amount=?, invoiced=?, invoice_number=?, police_notification=?, letter_drop=?,
        tmp_response=?, spa_response=?, sza_response=?, council_response=?, tgs_response=?, police_response=?, letter_drop_response=?,
        tgs_quantity=?, received_date=?, revision_required=?, revision_count=?, start_date=?, finish_date=?,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(b.job_id || null, b.client_id || null, itemType, itemTypes, b.title, b.authority_approver || '', b.internal_approver_id || null, b.assigned_to_id || null, b.due_date || null, b.submitted_date || null, b.approved_date || null, b.expiry_date || null, b.status, b.notes || '', b.designer || '', b.file_link || '', b.council_fee_paid === '1' || b.council_fee_paid === 1 ? 1 : 0, parseFloat(b.council_fee_amount) || 0,
      b.reference_number || '', b.rol_required ? 1 : 0, b.rol_response || '', b.bus_approvals_required ? 1 : 0, b.bus_approvals_response || '', b.client_pm || '', parseFloat(b.costs) || 0, b.action_required || '', b.charge_client === '1' || b.charge_client === 1 ? 1 : 0, parseFloat(b.charge_amount) || 0, b.invoiced === '1' || b.invoiced === 1 ? 1 : 0, b.invoice_number || '', b.police_notification ? 1 : 0, b.letter_drop ? 1 : 0,
      b.tmp_response || '', b.spa_response || '', b.sza_response || '', b.council_response || '', b.tgs_response || '', b.police_response || '', b.letter_drop_response || '',
      parseInt(b.tgs_quantity) || 1, b.received_date || null, b.revision_required ? 1 : 0, revCount, b.start_date || null, b.finish_date || null,
      req.params.id);

    // Sync linked task: create if new assignee, update if exists, complete if plan approved
    try {
      const existingTask = db.prepare('SELECT id, status FROM tasks WHERE compliance_id = ? AND deleted_at IS NULL').get(req.params.id);
      const typeLabels = { traffic_guidance: 'TGS', road_occupancy: 'ROL', rol: 'ROL', council_permit: 'Council Permit', tmp_approval: 'TMP', swms_review: 'SWMS', insurance: 'Insurance', induction: 'Induction', environmental: 'Environmental', utility_clearance: 'Utility Clearance', spa: 'SPA', sza: 'SZA', police_notification: 'Police Notification', letter_drop: 'Letter Drop', bus_approval: 'Bus Approval', other: 'Other' };
      const typeLabel = typesArr.map(t => typeLabels[t] || t).join(' / ') || 'Plan';
      const taskTitle = `${typeLabel}: ${b.title || 'Compliance Item'}`;

      // Map compliance status → task status (single source of truth)
      const statusMap = { not_started: 'not_started', started: 'in_progress', submitted: 'complete', approved: 'complete', rejected: 'not_started', expired: 'not_started' };
      const mappedTaskStatus = statusMap[b.status] || 'not_started';
      const isTaskComplete = mappedTaskStatus === 'complete';
      const today = new Date().toISOString().split('T')[0];

      if (existingTask) {
        // Always sync task status + title to match compliance
        db.prepare(`UPDATE tasks SET title=?, status=?, completed_date=?, owner_id=COALESCE(?, owner_id), due_date=COALESCE(?, due_date), job_id=COALESCE(?, job_id), notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(taskTitle, mappedTaskStatus, isTaskComplete ? today : null,
            b.assigned_to_id || null, b.due_date || null, b.job_id || null,
            b.action_required || '', existingTask.id);
      } else if (b.assigned_to_id) {
        // Create new linked task with correct initial status
        db.prepare(`
          INSERT INTO tasks (job_id, division, title, description, owner_id, due_date, status, completed_date, priority, task_type, notes, created_by, compliance_id)
          VALUES (?, 'planning', ?, ?, ?, ?, ?, ?, 'medium', 'one_off', ?, ?, ?)
        `).run(
          b.job_id || null,
          taskTitle,
          `Auto-created from Plans & Approvals. Reference: ${b.reference_number || 'N/A'}`,
          b.assigned_to_id,
          b.due_date || today,
          mappedTaskStatus,
          isTaskComplete ? today : null,
          b.action_required || '',
          req.session.user ? req.session.user.id : null,
          req.params.id
        );
      }
    } catch (taskErr) {
      console.error('[Compliance] Auto-task sync error:', taskErr.message);
    }

    // Auto-log changes to site diary with user name
    if (oldItem) {
      const userName = req.session.user ? req.session.user.full_name : 'System';
      const changes = [];
      if (oldItem.status !== b.status) changes.push(`Status: ${(oldItem.status || 'not_started').replace(/_/g, ' ')} → ${(b.status || '').replace(/_/g, ' ')}`);
      if ((oldItem.title || '') !== (b.title || '')) changes.push(`Title: ${b.title}`);
      if ((oldItem.submitted_date || '') !== (b.submitted_date || '')) changes.push(`Submitted: ${b.submitted_date || 'cleared'}`);
      if ((oldItem.approved_date || '') !== (b.approved_date || '')) changes.push(`Approved: ${b.approved_date || 'cleared'}`);
      if ((oldItem.received_date || '') !== (b.received_date || '')) changes.push(`Received: ${b.received_date || 'cleared'}`);
      if ((oldItem.start_date || '') !== (b.start_date || '')) changes.push(`Start date: ${b.start_date || 'cleared'}`);
      if ((oldItem.finish_date || '') !== (b.finish_date || '')) changes.push(`Finish date: ${b.finish_date || 'cleared'}`);
      if ((oldItem.designer || '') !== (b.designer || '')) changes.push(`Designer: ${b.designer || 'unassigned'}`);
      if ((oldItem.reference_number || '') !== (b.reference_number || '')) changes.push(`Ref: ${b.reference_number}`);
      if ((oldItem.client_pm || '') !== (b.client_pm || '')) changes.push(`Client PM: ${b.client_pm || 'cleared'}`);
      if ((oldItem.file_link || '') !== (b.file_link || '')) changes.push(`File link updated`);
      if ((oldItem.notes || '') !== (b.notes || '')) changes.push(`Notes updated`);
      if (String(oldItem.assigned_to_id || '') !== String(b.assigned_to_id || '')) {
        const newAssignee = b.assigned_to_id ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(b.assigned_to_id) || {}).full_name || 'Unknown' : 'Unassigned';
        changes.push(`Assigned to: ${newAssignee}`);
      }
      if (String(oldItem.internal_approver_id || '') !== String(b.internal_approver_id || '')) {
        const newApprover = b.internal_approver_id ? (db.prepare('SELECT full_name FROM users WHERE id = ?').get(b.internal_approver_id) || {}).full_name || 'Unknown' : 'None';
        changes.push(`Approver: ${newApprover}`);
      }
      if (oldItem.revision_required != (b.revision_required ? 1 : 0)) changes.push(b.revision_required ? 'Revision required flagged' : 'Revision required cleared');
      if (changes.length > 0) {
        const diaryTypeLabels = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council Permit', spa: 'SPA', sza: 'SZA', bus_approval: 'Bus Approval', police_notification: 'Police Notification', letter_drop: 'Letter Drop' };
        const diaryTypeLabel = typesArr.map(t => diaryTypeLabels[t] || t).join(' / ') || 'Plan';
        autoLogDiary(db, {
          jobId: b.job_id || oldItem.job_id,
          complianceItemId: parseInt(req.params.id),
          summary: `[${userName}] ${diaryTypeLabel} updated (${b.reference_number || oldItem.reference_number || 'N/A'}): ${b.title || oldItem.title}. ${changes.join('. ')}.`,
          userId: req.session.user ? req.session.user.id : null
        });
        // Notify relevant users on status change
        if (oldItem.status !== b.status) {
          logStatusChange(db, {
            jobId: b.job_id || oldItem.job_id,
            entityType: 'compliance',
            entityLabel: `${diaryTypeLabel} ${b.reference_number || oldItem.reference_number || b.title || oldItem.title}`,
            oldStatus: oldItem.status,
            newStatus: b.status,
            userId: req.session.user ? req.session.user.id : null,
            userName: req.session.user ? req.session.user.full_name : 'System'
          });
        }
      }
    }

    // If this row is a sub-plan, roll its status change up to the parent so
    // the badge on the register and the job's Plans tab matches what the
    // user just set on the child.
    if (oldItem && oldItem.parent_id != null) {
      try { planStatus.syncParentStatus(db, oldItem.parent_id); } catch (e) { console.error('syncParentStatus after /:id update failed:', e.message); }
    }

    req.flash('success', 'Item updated.');
  } catch (err) {
    console.error('Compliance update error:', err.message);
    req.flash('error', 'Failed to update: ' + err.message);
  }
  // Return the user where they came from (job page, register, etc.) — fall back to the edit page.
  const returnTo = b.return_to && b.return_to !== '/compliance' ? b.return_to : '/compliance/' + req.params.id + '/edit';
  req.session.save(() => res.redirect(returnTo));
});

router.post('/:id/delete', (req, res) => {
  const db = getDb();
  try {
    const tx = db.transaction(() => {
      db.prepare('UPDATE site_diary_entries SET compliance_item_id = NULL WHERE compliance_item_id = ?').run(req.params.id);
      db.prepare('DELETE FROM compliance WHERE id = ?').run(req.params.id);
    });
    tx();
    req.flash('success', 'Item deleted.');
  } catch (e) {
    console.error('[compliance] single delete failed:', e.message);
    req.flash('error', 'Failed to delete: ' + e.message);
  }
  req.session.save(() => res.redirect(req.body.return_to || '/compliance'));
});

// Mark as ready for invoice
router.post('/:id/ready-for-invoice', (req, res) => {
  const db = getDb();
  const item = db.prepare('SELECT c.*, j.job_number FROM compliance c LEFT JOIN jobs j ON c.job_id = j.id WHERE c.id = ?').get(req.params.id);
  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  if (!item) {
    if (wantsJson) return res.status(404).json({ error: 'Item not found' });
    req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect('/compliance'));
  }

  db.prepare('UPDATE compliance SET ready_for_invoice = 1, ready_for_invoice_at = CURRENT_TIMESTAMP, ready_for_invoice_by = ? WHERE id = ?')
    .run(req.session.user.id, req.params.id);

  // Notify admin and accounts users
  try {
    const accountsUsers = db.prepare("SELECT id FROM users WHERE active = 1 AND role IN ('admin','finance','accounts')").all();
    const insertNotif = db.prepare(`
      INSERT INTO notifications (user_id, type, title, message, link)
      VALUES (?, 'invoice_ready', ?, ?, ?)
    `);
    const title = 'Ready for Invoice: ' + item.title;
    const message = (item.job_number ? item.job_number + ' — ' : '') + item.title + ' is ready to be invoiced.';
    const link = '/compliance/' + req.params.id + '/edit';
    accountsUsers.forEach(u => {
      try { insertNotif.run(u.id, title, message, link); } catch(e) {}
    });
  } catch(e) { console.error('[Compliance] Notification error:', e.message); }

  if (wantsJson) {
    const fresh = db.prepare(`
      SELECT c.id, c.ready_for_invoice, c.ready_for_invoice_at, c.invoiced, c.invoice_number, c.invoiced_at,
        c.charge_client, c.charge_amount,
        rfi.full_name AS ready_for_invoice_by_name,
        inv.full_name AS invoiced_by_name
      FROM compliance c
      LEFT JOIN users rfi ON c.ready_for_invoice_by = rfi.id
      LEFT JOIN users inv ON c.invoiced_by_id = inv.id
      WHERE c.id = ?
    `).get(req.params.id);
    return res.json({ success: true, item: fresh });
  }
  req.flash('success', 'Marked as ready for invoice. Admin/accounts team notified.');
  req.session.save(() => res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit'));
});

// Unmark ready for invoice (revert to pending)
router.post('/:id/unmark-invoice', (req, res) => {
  const db = getDb();
  const wantsJson = req.xhr || (req.headers.accept || '').includes('application/json');
  db.prepare('UPDATE compliance SET ready_for_invoice = 0, ready_for_invoice_at = NULL, ready_for_invoice_by = NULL WHERE id = ?').run(req.params.id);
  if (wantsJson) return res.json({ success: true });
  req.flash('success', 'Invoice mark removed.');
  req.session.save(() => res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit'));
});

// Upload documents to a compliance item
router.post('/:id/upload', complianceUpload.array('documents', 10), (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) {
    req.flash('error', 'Item not found.');
    return req.session.save(() => res.redirect('/compliance'));
  }

  try {
    const ins = db.prepare('INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type, uploaded_by_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const files = req.files || [];
    console.log(`[Compliance] Upload ${files.length} file(s) for item ${complianceId}`);
    files.forEach(f => {
      console.log(`  File: ${f.originalname} -> ${f.path} (${f.size} bytes)`);
      const relPath = '/data/uploads/compliance/' + complianceId + '/' + f.filename;
      ins.run(complianceId, f.filename, f.originalname, relPath, f.size, f.mimetype || '', req.session.user.id);
    });

    if (files.length === 0) {
      req.flash('error', 'No files selected. Please choose files to upload.');
    } else {
      // Uploading a file IS the act of submitting — stamp the submitted date
      // to today (the upload date) if it isn't already set, and move a
      // not-yet-started plan into 'submitted'. An existing submitted date and
      // any further-along status (submitted/approved/…) are left untouched, so
      // adding supporting files later never rewrites the original date or
      // knocks an approved plan back a step.
      const today = sydneyToday();
      const cur = db.prepare('SELECT submitted_date, status FROM compliance WHERE id = ?').get(complianceId);
      const stampDate = !(cur && cur.submitted_date);
      const advanceStatus = cur && cur.status === 'not_started';
      if (stampDate || advanceStatus) {
        db.prepare(`UPDATE compliance SET
          submitted_date = COALESCE(NULLIF(submitted_date, ''), ?),
          status = CASE WHEN status = 'not_started' THEN 'submitted' ELSE status END,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`).run(today, complianceId);
      }
      req.flash('success', `${files.length} file(s) uploaded${stampDate ? ` — submitted date set to ${today}.` : '.'}`);
      // Audit trail: log upload to site diary
      const compItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(complianceId);
      if (compItem && compItem.job_id) {
        const userName = req.session.user ? req.session.user.full_name : 'System';
        const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
        const typeLabel = (compItem.item_types || compItem.item_type || '').split(',').map(t => typeMap[t.trim()] || t.trim()).join(' / ');
        const fileNames = files.map(f => f.originalname).join(', ');
        autoLogDiary(db, {
          jobId: compItem.job_id, complianceItemId: parseInt(complianceId),
          summary: `[${userName}] Uploaded ${files.length} file(s) to ${typeLabel} ${compItem.reference_number || compItem.title}: ${fileNames}`,
          userId: req.session.user ? req.session.user.id : null
        });
      }
    }
  } catch (err) {
    console.error('[Compliance] Upload error:', err.message);
    req.flash('error', 'Upload failed: ' + err.message);
  }
  req.session.save(() => res.redirect(req.body.return_to || '/compliance/' + complianceId + '/edit'));
});

// Delete a compliance document
router.post('/:id/documents/:docId/delete', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM compliance_documents WHERE id = ? AND compliance_id = ?').get(req.params.docId, req.params.id);
  if (doc) {
    const fullPath = path.join(__dirname, '..', 'data', doc.file_path);
    try { fs.unlinkSync(fullPath); } catch (e) { /* file may not exist */ }
    db.prepare('DELETE FROM compliance_documents WHERE id = ?').run(doc.id);
    // Audit trail: log deletion to site diary
    const compItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(req.params.id);
    if (compItem && compItem.job_id) {
      const userName = req.session.user ? req.session.user.full_name : 'System';
      const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
      const typeLabel = (compItem.item_types || compItem.item_type || '').split(',').map(t => typeMap[t.trim()] || t.trim()).join(' / ');
      autoLogDiary(db, {
        jobId: compItem.job_id, complianceItemId: parseInt(req.params.id),
        summary: `[${userName}] Deleted document from ${typeLabel} ${compItem.reference_number || compItem.title}: ${doc.original_name}`,
        userId: req.session.user ? req.session.user.id : null
      });
    }
  }
  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Document deleted.');
  req.session.save(() => res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit'));
});

// Add a revision to a compliance item
router.post('/:id/revisions', (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect('/compliance')); }

  const b = req.body;
  // Get next revision number
  const maxRev = db.prepare('SELECT MAX(revision_number) as m FROM compliance_revisions WHERE compliance_id = ?').get(complianceId)?.m || 0;
  const clientIssued = b.client_issued === '1' || b.client_issued === 'on' ? 1 : 0;
  db.prepare('INSERT INTO compliance_revisions (compliance_id, revision_number, revision_date, notes, client_issued) VALUES (?, ?, ?, ?, ?)')
    .run(complianceId, maxRev + 1, b.revision_date || null, b.revision_notes || '', clientIssued);

  // Update revision_count on parent
  const count = db.prepare('SELECT COUNT(*) as c FROM compliance_revisions WHERE compliance_id = ?').get(complianceId).c;
  db.prepare('UPDATE compliance SET revision_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(count, complianceId);

  // Auto-log revision to site diary
  const revItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(complianceId);
  if (revItem) {
    const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
    const types = (revItem.item_types || revItem.item_type || '').split(',').map(t => typeMap[t] || t).join(' / ');
    autoLogDiary(db, {
      jobId: revItem.job_id,
      complianceItemId: parseInt(complianceId),
      summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${types} revision ${maxRev + 1} added (${revItem.reference_number || 'N/A'}): ${revItem.title}.${clientIssued ? ' [CLIENT ISSUED]' : ''} ${b.revision_notes || ''}`.trim(),
      userId: req.session.user ? req.session.user.id : null
    });
  }

  req.flash('success', 'Revision ' + (maxRev + 1) + ' added.');
  req.session.save(() => res.redirect(b.return_to || '/compliance/' + complianceId + '/edit'));
});

// Edit a revision
router.post('/:id/revisions/:revId/edit', (req, res) => {
  const db = getDb();
  const complianceId = req.params.id;
  const revId = req.params.revId;
  const item = db.prepare('SELECT id FROM compliance WHERE id = ?').get(complianceId);
  if (!item) { req.flash('error', 'Item not found.'); return req.session.save(() => res.redirect('/compliance')); }

  const rev = db.prepare('SELECT * FROM compliance_revisions WHERE id = ? AND compliance_id = ?').get(revId, complianceId);
  if (!rev) { req.flash('error', 'Revision not found.'); return req.session.save(() => res.redirect('/compliance/' + complianceId + '/edit')); }

  const b = req.body;
  const clientIssued = b.client_issued === '1' || b.client_issued === 'on' ? 1 : 0;
  db.prepare('UPDATE compliance_revisions SET revision_date = ?, notes = ?, client_issued = ? WHERE id = ? AND compliance_id = ?')
    .run(b.revision_date || null, b.revision_notes || '', clientIssued, revId, complianceId);

  // Auto-log edit to site diary
  const revItem = db.prepare('SELECT job_id, title, reference_number, item_type, item_types FROM compliance WHERE id = ?').get(complianceId);
  if (revItem) {
    const typeMap = { traffic_guidance: 'TGS', tmp_approval: 'CTMP', rol: 'ROL', council_permit: 'Council', spa: 'SPA', sza: 'SZA' };
    const types = (revItem.item_types || revItem.item_type || '').split(',').map(t => typeMap[t] || t).join(' / ');
    autoLogDiary(db, {
      jobId: revItem.job_id,
      complianceItemId: parseInt(complianceId),
      summary: `[${req.session.user ? req.session.user.full_name : 'System'}] ${types} revision ${rev.revision_number} edited (${revItem.reference_number || 'N/A'}): ${revItem.title}.${clientIssued ? ' [CLIENT ISSUED]' : ''} ${b.revision_notes || ''}`.trim(),
      userId: req.session.user ? req.session.user.id : null
    });
  }

  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Revision ' + rev.revision_number + ' updated.');
  req.session.save(() => res.redirect(b.return_to || '/compliance/' + complianceId + '/edit'));
});

// Delete a revision
router.post('/:id/revisions/:revId/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM compliance_revisions WHERE id = ? AND compliance_id = ?').run(req.params.revId, req.params.id);

  // Update revision_count on parent
  const count = db.prepare('SELECT COUNT(*) as c FROM compliance_revisions WHERE compliance_id = ?').get(req.params.id)?.c || 0;
  db.prepare('UPDATE compliance SET revision_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(count, req.params.id);

  if (req.headers['accept'] && req.headers['accept'].includes('json')) {
    return res.json({ success: true });
  }
  req.flash('success', 'Revision deleted.');
  req.session.save(() => res.redirect(req.body.return_to || '/compliance/' + req.params.id + '/edit'));
});

// Serve compliance uploads
router.get('/:id/documents/:filename', (req, res) => {
  const filePath = path.join(__dirname, '..', 'data', 'uploads', 'compliance', req.params.id, req.params.filename);
  console.log('[Compliance] Download:', filePath, 'exists:', fs.existsSync(filePath));
  if (fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('File not found');
});

module.exports = router;
