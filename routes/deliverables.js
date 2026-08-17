// Deliverables register (brief §5.3) with per-revision QA (§5.6:
// prepare → check → close comments → approve) and the append-only
// document issue register (§5.5). The §6.3 hard gate lives in POST
// /:id/issue — an unapproved revision can never be issued.
//
// QA authority (user decision 2026-08-17): anyone with project access can
// prepare/check; only the revision's assigned approver or admin/management
// can approve; a NULL approver means only admin/management may approve
// (forces assignment discipline).
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/database');
const { logActivity } = require('../middleware/audit');
const { generateDeliverableRef, DOC_TYPES } = require('../lib/refNumbers');
const { syncDeliverableStatus, suggestNextRevisionLabel } = require('../lib/deliverableStatus');
const { sydneyToday } = require('../lib/sydney');

const DELIV_DIR = path.join(__dirname, '..', 'data', 'uploads', 'deliverables');
const revisionUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DELIV_DIR, String(req.deliverableJobId || 'misc'));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '.pdf') || '.pdf').toLowerCase();
      cb(null, `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.(pdf|doc|docx|dwg|png|jpg|jpeg|xlsx|zip)$/i.test(path.extname(file.originalname || ''))),
});

function isQaAdmin(user) {
  const role = String((user && user.role) || '').toLowerCase();
  return role === 'admin' || role === 'management';
}

function wantsJson(req) {
  return req.xhr || (req.headers.accept || '').includes('application/json');
}

function fail(req, res, status, message, backTo) {
  if (wantsJson(req)) return res.status(status).json({ success: false, error: message });
  req.flash('error', message);
  return req.session.save(() => res.redirect(backTo));
}

function loadDeliverable(db, id) {
  return db.prepare(`
    SELECT d.*, j.job_number, j.project_name, j.job_name, j.client AS client_name, j.project_manager_id,
      sp.package_ref, u1.full_name AS preparer_name, u2.full_name AS checker_name, u3.full_name AS approver_name
    FROM deliverables d
    JOIN jobs j ON d.job_id = j.id
    LEFT JOIN service_packages sp ON d.service_package_id = sp.id
    LEFT JOIN users u1 ON d.preparer_id = u1.id
    LEFT JOIN users u2 ON d.checker_id = u2.id
    LEFT JOIN users u3 ON d.approver_id = u3.id
    WHERE d.id = ?
  `).get(id);
}

function currentRevision(db, deliverableId) {
  return db.prepare(`
    SELECT r.*, p.full_name AS preparer_name, c.full_name AS checker_name, a.full_name AS approver_name
    FROM deliverable_revisions r
    LEFT JOIN users p ON r.preparer_id = p.id
    LEFT JOIN users c ON r.checker_id = c.id
    LEFT JOIN users a ON r.approver_id = a.id
    WHERE r.deliverable_id = ? ORDER BY r.id DESC LIMIT 1
  `).get(deliverableId);
}

// ============ Register ============
router.get('/', (req, res, next) => {
  try {
    const db = getDb();
    const { job_id, doc_type, status, qa, search, due } = req.query;
    const today = sydneyToday();
    let where = [];
    const params = [];
    if (job_id) { where.push('d.job_id = ?'); params.push(job_id); }
    if (doc_type && DOC_TYPES[doc_type]) { where.push('d.doc_type = ?'); params.push(doc_type); }
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (qa === 'pending') { where.push("d.status = 'in_qa'"); }
    if (due === 'overdue') {
      where.push("d.status NOT IN ('issued','closed','superseded') AND (d.internal_due_date < ? OR d.external_due_date < ?)");
      params.push(today, today);
    }
    if (search) {
      where.push('(d.deliverable_ref LIKE ? OR d.title LIKE ? OR j.job_number LIKE ? OR j.project_name LIKE ?)');
      const s = `%${search}%`;
      params.push(s, s, s, s);
    }
    const deliverables = db.prepare(`
      SELECT d.*, j.job_number, j.project_name, j.job_name, j.client AS client_name,
        sp.package_ref,
        (SELECT r.revision_label FROM deliverable_revisions r WHERE r.deliverable_id = d.id ORDER BY r.id DESC LIMIT 1) AS current_revision,
        (SELECT r.status FROM deliverable_revisions r WHERE r.deliverable_id = d.id ORDER BY r.id DESC LIMIT 1) AS revision_status,
        u1.full_name AS preparer_name
      FROM deliverables d
      JOIN jobs j ON d.job_id = j.id
      LEFT JOIN service_packages sp ON d.service_package_id = sp.id
      LEFT JOIN users u1 ON d.preparer_id = u1.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY CASE WHEN d.status IN ('issued','closed','superseded') THEN 1 ELSE 0 END,
        d.internal_due_date IS NULL, d.internal_due_date, d.deliverable_ref
    `).all(...params);

    const stats = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'in_qa' THEN 1 ELSE 0 END) AS in_qa,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS ready_to_issue,
        SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) AS issued,
        SUM(CASE WHEN status NOT IN ('issued','closed','superseded')
              AND ((internal_due_date IS NOT NULL AND internal_due_date < ?) OR (external_due_date IS NOT NULL AND external_due_date < ?))
            THEN 1 ELSE 0 END) AS overdue
      FROM deliverables
    `).get(today, today);

    res.render('deliverables/index', {
      title: 'Deliverables',
      currentPage: 'deliverables',
      deliverables,
      stats,
      docTypes: Object.keys(DOC_TYPES),
      filters: { job_id, doc_type, status, qa, search, due },
    });
  } catch (err) { next(err); }
});

// ============ Create ============
router.get('/new', (req, res, next) => {
  try {
    const db = getDb();
    const jobId = req.query.job_id;
    if (!jobId) {
      req.flash('error', 'Deliverables are created against a project — open the project and add one from its Deliverables tab.');
      return req.session.save(() => res.redirect('/deliverables'));
    }
    const job = db.prepare('SELECT id, job_number, project_name, job_name, project_manager_id, technical_lead_id, checker_id FROM jobs WHERE id = ?').get(jobId);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/deliverables'));
    }
    res.render('deliverables/form', {
      title: 'New Deliverable — ' + job.job_number,
      currentPage: 'deliverables',
      deliverable: null,
      job,
      docTypes: Object.keys(DOC_TYPES),
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      packages: db.prepare('SELECT id, package_ref, scope FROM service_packages WHERE job_id = ? ORDER BY package_ref').all(job.id),
    });
  } catch (err) { next(err); }
});

router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const job = db.prepare('SELECT id, job_number FROM jobs WHERE id = ?').get(b.job_id);
    if (!job) {
      req.flash('error', 'Project not found.');
      return req.session.save(() => res.redirect('/deliverables'));
    }
    if (!DOC_TYPES[b.doc_type]) {
      req.flash('error', 'Choose a deliverable type.');
      return req.session.save(() => res.redirect('/deliverables/new?job_id=' + job.id));
    }
    const ref = generateDeliverableRef(job.job_number, b.doc_type);
    const result = db.prepare(`
      INSERT INTO deliverables (deliverable_ref, job_id, service_package_id, title, doc_type,
        preparer_id, checker_id, approver_id, internal_due_date, external_due_date,
        issue_purpose, next_action, sharepoint_working_url, sharepoint_issued_url, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref, job.id, b.service_package_id || null, b.title, b.doc_type,
      b.preparer_id || (req.session.user ? req.session.user.id : null),
      b.checker_id || null, b.approver_id || null,
      b.internal_due_date || null, b.external_due_date || null,
      b.issue_purpose || '', b.next_action || '',
      b.sharepoint_working_url || '', b.sharepoint_issued_url || '',
      req.session.user ? req.session.user.id : null
    );
    logActivity({
      user: req.session.user, action: 'create', entityType: 'deliverable',
      entityId: result.lastInsertRowid, entityLabel: ref,
      jobId: job.id, jobNumber: job.job_number, ip: req.ip,
    });
    req.flash('success', `Deliverable ${ref} created.`);
    req.session.save(() => res.redirect('/deliverables/' + result.lastInsertRowid));
  } catch (err) {
    req.flash('error', 'Failed to create deliverable: ' + err.message);
    req.session.save(() => res.redirect(b.job_id ? '/deliverables/new?job_id=' + b.job_id : '/deliverables'));
  }
});

// ============ Detail ============
router.get('/:id', (req, res, next) => {
  try {
    const db = getDb();
    const deliverable = loadDeliverable(db, req.params.id);
    if (!deliverable) {
      req.flash('error', 'Deliverable not found.');
      return req.session.save(() => res.redirect('/deliverables'));
    }
    const revisions = db.prepare(`
      SELECT r.*, p.full_name AS preparer_name, c.full_name AS checker_name, a.full_name AS approver_name
      FROM deliverable_revisions r
      LEFT JOIN users p ON r.preparer_id = p.id
      LEFT JOIN users c ON r.checker_id = c.id
      LEFT JOIN users a ON r.approver_id = a.id
      WHERE r.deliverable_id = ? ORDER BY r.id DESC
    `).all(deliverable.id);
    const issues = db.prepare(`
      SELECT di.*, u.full_name AS issued_by_name, ab.full_name AS approved_by_name, r.revision_label
      FROM document_issues di
      LEFT JOIN users u ON di.issued_by_id = u.id
      LEFT JOIN users ab ON di.approved_by_id = ab.id
      LEFT JOIN deliverable_revisions r ON di.revision_id = r.id
      WHERE di.deliverable_id = ? ORDER BY di.id DESC
    `).all(deliverable.id);
    const trail = db.prepare(`
      SELECT al.*, u.full_name AS user_name FROM activity_log al
      LEFT JOIN users u ON al.user_id = u.id
      WHERE (al.entity_type = 'deliverable' AND al.entity_id = ?)
         OR (al.entity_type = 'deliverable_revision' AND al.entity_id IN (SELECT id FROM deliverable_revisions WHERE deliverable_id = ?))
      ORDER BY al.created_at DESC LIMIT 25
    `).all(deliverable.id, deliverable.id);

    res.render('deliverables/show', {
      title: deliverable.deliverable_ref,
      currentPage: 'deliverables',
      deliverable,
      revisions,
      currentRev: revisions[0] || null,
      issues,
      trail,
      users: db.prepare('SELECT id, full_name FROM users WHERE active = 1 ORDER BY full_name').all(),
      suggestedLabel: suggestNextRevisionLabel(revisions[0] ? revisions[0].revision_label : null),
      isQaAdmin: isQaAdmin(req.session.user),
    });
  } catch (err) { next(err); }
});

// ============ Edit header fields ============
router.post('/:id', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const deliverable = db.prepare('SELECT d.*, j.job_number FROM deliverables d JOIN jobs j ON d.job_id = j.id WHERE d.id = ?').get(req.params.id);
    if (!deliverable) return fail(req, res, 404, 'Deliverable not found.', '/deliverables');
    db.prepare(`
      UPDATE deliverables SET title=?, service_package_id=?, preparer_id=?, checker_id=?, approver_id=?,
        internal_due_date=?, external_due_date=?, issue_purpose=?, next_action=?,
        sharepoint_working_url=?, sharepoint_issued_url=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      b.title || deliverable.title, b.service_package_id || null,
      b.preparer_id || null, b.checker_id || null, b.approver_id || null,
      b.internal_due_date || null, b.external_due_date || null,
      b.issue_purpose !== undefined ? b.issue_purpose : deliverable.issue_purpose,
      b.next_action !== undefined ? b.next_action : deliverable.next_action,
      b.sharepoint_working_url !== undefined ? b.sharepoint_working_url : deliverable.sharepoint_working_url,
      b.sharepoint_issued_url !== undefined ? b.sharepoint_issued_url : deliverable.sharepoint_issued_url,
      deliverable.id
    );
    logActivity({
      user: req.session.user, action: 'update', entityType: 'deliverable',
      entityId: deliverable.id, entityLabel: deliverable.deliverable_ref,
      jobId: deliverable.job_id, jobNumber: deliverable.job_number, ip: req.ip,
    });
    req.flash('success', 'Deliverable updated.');
    req.session.save(() => res.redirect('/deliverables/' + deliverable.id));
  } catch (err) {
    req.flash('error', 'Failed to update: ' + err.message);
    req.session.save(() => res.redirect('/deliverables/' + req.params.id));
  }
});

// ============ New revision ============
// Resolve the job id BEFORE multer so the upload lands in the right dir.
function attachJobId(req, res, next) {
  try {
    const row = getDb().prepare('SELECT job_id FROM deliverables WHERE id = ?').get(req.params.id);
    req.deliverableJobId = row ? row.job_id : null;
  } catch (e) { req.deliverableJobId = null; }
  next();
}

router.post('/:id/revisions', attachJobId, revisionUpload.single('file'), (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const deliverable = db.prepare('SELECT d.*, j.job_number FROM deliverables d JOIN jobs j ON d.job_id = j.id WHERE d.id = ?').get(req.params.id);
    if (!deliverable) return fail(req, res, 404, 'Deliverable not found.', '/deliverables');
    const back = '/deliverables/' + deliverable.id;
    const prior = currentRevision(db, deliverable.id);
    const label = (b.revision_label || '').trim() || suggestNextRevisionLabel(prior ? prior.revision_label : null) || 'A';
    const filePath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).split(path.sep).join('/') : '';

    let newId;
    db.transaction(() => {
      db.prepare("UPDATE deliverable_revisions SET status = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE deliverable_id = ? AND status != 'superseded'").run(deliverable.id);
      newId = db.prepare(`
        INSERT INTO deliverable_revisions (deliverable_id, revision_label, preparer_id, checker_id, approver_id, file_path, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        deliverable.id, label,
        b.preparer_id || deliverable.preparer_id || (req.session.user ? req.session.user.id : null),
        b.checker_id || deliverable.checker_id || null,
        b.approver_id || deliverable.approver_id || null,
        filePath, req.session.user ? req.session.user.id : null
      ).lastInsertRowid;
      syncDeliverableStatus(db, deliverable.id);
    })();

    logActivity({
      user: req.session.user, action: 'create', entityType: 'deliverable_revision',
      entityId: newId, entityLabel: `${deliverable.deliverable_ref} Rev ${label}`,
      jobId: deliverable.job_id, jobNumber: deliverable.job_number, ip: req.ip,
    });
    req.flash('success', `Revision ${label} started${prior ? ` — Rev ${prior.revision_label} superseded` : ''}.`);
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to add revision: ' + err.message);
    req.session.save(() => res.redirect('/deliverables/' + req.params.id));
  }
});

// ============ QA stepper (revision endpoints) ============
function loadRevision(db, rid) {
  return db.prepare(`
    SELECT r.*, d.id AS deliverable_id, d.deliverable_ref, d.job_id, j.job_number
    FROM deliverable_revisions r
    JOIN deliverables d ON r.deliverable_id = d.id
    JOIN jobs j ON d.job_id = j.id
    WHERE r.id = ?
  `).get(rid);
}

router.post('/revisions/:rid/prepare', (req, res) => {
  const db = getDb();
  const rev = loadRevision(db, req.params.rid);
  if (!rev) return fail(req, res, 404, 'Revision not found.', '/deliverables');
  const back = '/deliverables/' + rev.deliverable_id;
  if (rev.status !== 'draft') return fail(req, res, 422, `Rev ${rev.revision_label} is ${rev.status} — only a draft can be marked prepared.`, back);
  db.transaction(() => {
    db.prepare(`
      UPDATE deliverable_revisions SET status='prepared',
        preparer_id = COALESCE(preparer_id, ?), prepared_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.session.user.id, rev.id);
    syncDeliverableStatus(db, rev.deliverable_id);
  })();
  logActivity({
    user: req.session.user, action: 'complete', entityType: 'deliverable_revision',
    entityId: rev.id, entityLabel: `${rev.deliverable_ref} Rev ${rev.revision_label}`,
    jobId: rev.job_id, jobNumber: rev.job_number, details: 'Preparation completed', ip: req.ip,
  });
  req.flash('success', `Rev ${rev.revision_label} marked prepared — over to the checker.`);
  req.session.save(() => res.redirect(back));
});

router.post('/revisions/:rid/check', (req, res) => {
  const db = getDb();
  const rev = loadRevision(db, req.params.rid);
  if (!rev) return fail(req, res, 404, 'Revision not found.', '/deliverables');
  const back = '/deliverables/' + rev.deliverable_id;
  if (rev.status !== 'prepared') return fail(req, res, 422, `Rev ${rev.revision_label} must be prepared before it can be checked (currently ${rev.status}).`, back);
  const comments = (req.body.qa_comments || '').trim();
  db.transaction(() => {
    db.prepare(`
      UPDATE deliverable_revisions SET status='checked', checker_id=?, checked_at=CURRENT_TIMESTAMP,
        qa_comments = CASE WHEN ? != '' THEN TRIM(COALESCE(qa_comments,'') || CASE WHEN COALESCE(qa_comments,'') != '' THEN char(10) ELSE '' END || ?) ELSE qa_comments END,
        comments_closed = CASE WHEN ? != '' THEN 0 WHEN COALESCE(qa_comments,'') = '' THEN 1 ELSE comments_closed END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.session.user.id, comments, comments, comments, rev.id);
    syncDeliverableStatus(db, rev.deliverable_id);
  })();
  logActivity({
    user: req.session.user, action: 'complete', entityType: 'deliverable_revision',
    entityId: rev.id, entityLabel: `${rev.deliverable_ref} Rev ${rev.revision_label}`,
    jobId: rev.job_id, jobNumber: rev.job_number,
    details: comments ? 'Checked with comments' : 'Checked — no comments', ip: req.ip,
  });
  req.flash('success', `Rev ${rev.revision_label} checked${comments ? ' — comments recorded for close-out' : ''}.`);
  req.session.save(() => res.redirect(back));
});

router.post('/revisions/:rid/close-comments', (req, res) => {
  const db = getDb();
  const rev = loadRevision(db, req.params.rid);
  if (!rev) return fail(req, res, 404, 'Revision not found.', '/deliverables');
  const back = '/deliverables/' + rev.deliverable_id;
  if (rev.status !== 'checked') return fail(req, res, 422, `Comments are closed after checking — Rev ${rev.revision_label} is ${rev.status}.`, back);
  if (!(rev.qa_comments || '').trim()) return fail(req, res, 422, 'There are no QA comments to close.', back);
  db.prepare('UPDATE deliverable_revisions SET comments_closed = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(rev.id);
  logActivity({
    user: req.session.user, action: 'complete', entityType: 'deliverable_revision',
    entityId: rev.id, entityLabel: `${rev.deliverable_ref} Rev ${rev.revision_label}`,
    jobId: rev.job_id, jobNumber: rev.job_number, details: 'QA comments closed out', ip: req.ip,
  });
  req.flash('success', 'QA comments closed out — ready for approval.');
  req.session.save(() => res.redirect(back));
});

router.post('/revisions/:rid/approve', (req, res) => {
  const db = getDb();
  const rev = loadRevision(db, req.params.rid);
  if (!rev) return fail(req, res, 404, 'Revision not found.', '/deliverables');
  const back = '/deliverables/' + rev.deliverable_id;
  if (rev.status !== 'checked') return fail(req, res, 422, `Rev ${rev.revision_label} cannot be approved — prepare and check must be complete first (currently ${rev.status}).`, back);
  if ((rev.qa_comments || '').trim() && !rev.comments_closed) return fail(req, res, 422, 'QA comments must be closed out before approval.', back);
  const admin = isQaAdmin(req.session.user);
  if (!(admin || (rev.approver_id && rev.approver_id === req.session.user.id))) {
    return fail(req, res, 403, rev.approver_id
      ? 'Only the assigned approver (or admin/management) can approve this revision.'
      : 'No approver is assigned — assign one on the deliverable, or an admin/management user must approve.', back);
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE deliverable_revisions SET status='approved', approved_at=CURRENT_TIMESTAMP,
        evidence_link = CASE WHEN ? != '' THEN ? ELSE evidence_link END, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(req.body.evidence_link || '', req.body.evidence_link || '', rev.id);
    syncDeliverableStatus(db, rev.deliverable_id);
  })();
  logActivity({
    user: req.session.user, action: 'approve', entityType: 'deliverable_revision',
    entityId: rev.id, entityLabel: `${rev.deliverable_ref} Rev ${rev.revision_label}`,
    jobId: rev.job_id, jobNumber: rev.job_number, ip: req.ip,
  });
  req.flash('success', `Rev ${rev.revision_label} approved — the deliverable can now be issued.`);
  req.session.save(() => res.redirect(back));
});

router.post('/revisions/:rid/reopen', (req, res) => {
  const db = getDb();
  const rev = loadRevision(db, req.params.rid);
  if (!rev) return fail(req, res, 404, 'Revision not found.', '/deliverables');
  const back = '/deliverables/' + rev.deliverable_id;
  if (rev.status !== 'approved') return fail(req, res, 422, `Only an approved revision can be reopened (Rev ${rev.revision_label} is ${rev.status}).`, back);
  if (db.prepare('SELECT 1 FROM document_issues WHERE revision_id = ?').get(rev.id)) {
    return fail(req, res, 422, `Rev ${rev.revision_label} has been issued — the issue record is permanent. Start a new revision instead.`, back);
  }
  if (!(isQaAdmin(req.session.user) || (rev.approver_id && rev.approver_id === req.session.user.id))) {
    return fail(req, res, 403, 'Only the approver or admin/management can reopen an approval.', back);
  }
  db.transaction(() => {
    db.prepare("UPDATE deliverable_revisions SET status='checked', approved_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(rev.id);
    syncDeliverableStatus(db, rev.deliverable_id);
  })();
  logActivity({
    user: req.session.user, action: 'reject', entityType: 'deliverable_revision',
    entityId: rev.id, entityLabel: `${rev.deliverable_ref} Rev ${rev.revision_label}`,
    jobId: rev.job_id, jobNumber: rev.job_number, details: 'Approval reopened', ip: req.ip,
  });
  req.flash('success', `Approval reopened — Rev ${rev.revision_label} is back with the checker.`);
  req.session.save(() => res.redirect(back));
});

// ============ Issue (§6.3 hard gate; §5.5 append-only register) ============
router.post('/:id/issue', (req, res) => {
  const db = getDb();
  const b = req.body;
  try {
    const deliverable = db.prepare('SELECT d.*, j.job_number, j.project_manager_id FROM deliverables d JOIN jobs j ON d.job_id = j.id WHERE d.id = ?').get(req.params.id);
    if (!deliverable) return fail(req, res, 404, 'Deliverable not found.', '/deliverables');
    const back = '/deliverables/' + deliverable.id;
    const rev = currentRevision(db, deliverable.id);
    if (!rev) return fail(req, res, 422, 'Nothing to issue — start a revision and complete QA first.', back);
    if (rev.status !== 'approved') {
      const missing = { draft: 'prepare, check and approve', prepared: 'check and approve', checked: 'approve' }[rev.status] || 'complete QA for';
      return fail(req, res, 422, `Rev ${rev.revision_label} has not been approved — ${missing} it before issuing.`, back);
    }
    if (!(b.issued_to || '').trim()) return fail(req, res, 422, 'Record who the document was issued to.', back);
    if (!(b.issue_purpose || '').trim()) return fail(req, res, 422, 'Record the issue purpose (e.g. For Approval, For Construction).', back);

    const priorIssued = db.prepare(`
      SELECT r.revision_label FROM document_issues di
      JOIN deliverable_revisions r ON di.revision_id = r.id
      WHERE di.deliverable_id = ? AND di.revision_id != ? ORDER BY di.id DESC LIMIT 1
    `).get(deliverable.id, rev.id);
    const issueDate = b.issue_date || sydneyToday();

    let issueId;
    db.transaction(() => {
      issueId = db.prepare(`
        INSERT INTO document_issues (deliverable_id, revision_id, issue_date, issue_purpose,
          issued_by_id, issued_to, transmittal_ref, superseded_revision_label, approved_by_id,
          sharepoint_file_link, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deliverable.id, rev.id, issueDate, b.issue_purpose.trim(),
        req.session.user.id, b.issued_to.trim(), b.transmittal_ref || '',
        priorIssued ? priorIssued.revision_label : '', rev.approver_id || null,
        b.sharepoint_file_link || '', b.notes || ''
      ).lastInsertRowid;
      db.prepare(`
        UPDATE deliverables SET status='issued', latest_issue_date=?, issue_purpose=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).run(issueDate, b.issue_purpose.trim(), deliverable.id);
    })();

    logActivity({
      user: req.session.user, action: 'create', entityType: 'document_issue',
      entityId: issueId, entityLabel: `${deliverable.deliverable_ref} Rev ${rev.revision_label} → ${b.issued_to.trim()}`,
      jobId: deliverable.job_id, jobNumber: deliverable.job_number,
      details: `${b.issue_purpose.trim()} · ${issueDate}`, ip: req.ip,
    });
    req.flash('success', `${deliverable.deliverable_ref} Rev ${rev.revision_label} issued to ${b.issued_to.trim()}.`);
    req.session.save(() => res.redirect(back));
  } catch (err) {
    req.flash('error', 'Failed to issue: ' + err.message);
    req.session.save(() => res.redirect('/deliverables/' + req.params.id));
  }
});

// ============ Close / reopen the deliverable ============
router.post('/:id/close', (req, res) => {
  const db = getDb();
  const deliverable = db.prepare('SELECT d.*, j.job_number FROM deliverables d JOIN jobs j ON d.job_id = j.id WHERE d.id = ?').get(req.params.id);
  if (!deliverable) return fail(req, res, 404, 'Deliverable not found.', '/deliverables');
  db.prepare("UPDATE deliverables SET status='closed', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(deliverable.id);
  logActivity({
    user: req.session.user, action: 'complete', entityType: 'deliverable',
    entityId: deliverable.id, entityLabel: deliverable.deliverable_ref,
    jobId: deliverable.job_id, jobNumber: deliverable.job_number, details: 'Closed', ip: req.ip,
  });
  req.flash('success', `${deliverable.deliverable_ref} closed.`);
  req.session.save(() => res.redirect('/deliverables/' + deliverable.id));
});

router.post('/:id/reopen', (req, res) => {
  const db = getDb();
  const deliverable = db.prepare('SELECT d.*, j.job_number FROM deliverables d JOIN jobs j ON d.job_id = j.id WHERE d.id = ?').get(req.params.id);
  if (!deliverable) return fail(req, res, 404, 'Deliverable not found.', '/deliverables');
  db.transaction(() => {
    db.prepare("UPDATE deliverables SET status='draft', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(deliverable.id);
    syncDeliverableStatus(db, deliverable.id);
  })();
  logActivity({
    user: req.session.user, action: 'update', entityType: 'deliverable',
    entityId: deliverable.id, entityLabel: deliverable.deliverable_ref,
    jobId: deliverable.job_id, jobNumber: deliverable.job_number, details: 'Reopened', ip: req.ip,
  });
  req.flash('success', `${deliverable.deliverable_ref} reopened.`);
  req.session.save(() => res.redirect('/deliverables/' + deliverable.id));
});

// ============ Delete (never after an issue — the register is permanent) ============
router.post('/:id/delete', (req, res) => {
  const db = getDb();
  const deliverable = db.prepare('SELECT d.*, j.job_number FROM deliverables d JOIN jobs j ON d.job_id = j.id WHERE d.id = ?').get(req.params.id);
  if (!deliverable) return fail(req, res, 404, 'Deliverable not found.', '/deliverables');
  if (db.prepare('SELECT 1 FROM document_issues WHERE deliverable_id = ?').get(deliverable.id)) {
    return fail(req, res, 422, `${deliverable.deliverable_ref} has issue records — the register is permanent. Close the deliverable instead.`, '/deliverables/' + deliverable.id);
  }
  db.transaction(() => {
    db.prepare('DELETE FROM deliverable_revisions WHERE deliverable_id = ?').run(deliverable.id);
    db.prepare('DELETE FROM deliverables WHERE id = ?').run(deliverable.id);
  })();
  logActivity({
    user: req.session.user, action: 'delete', entityType: 'deliverable',
    entityId: parseInt(req.params.id), entityLabel: deliverable.deliverable_ref,
    jobId: deliverable.job_id, jobNumber: deliverable.job_number, ip: req.ip,
  });
  req.flash('success', `${deliverable.deliverable_ref} deleted.`);
  req.session.save(() => res.redirect('/deliverables'));
});

module.exports = router;
