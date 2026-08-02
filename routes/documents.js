const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { requireAccountsAccess, canViewAccounts } = require('../middleware/auth');

const { resolveUploadPath } = require('../middleware/upload');

// Stored under data/ — the only tree on the persistent volume. Root ./uploads
// is baked into the container image and wiped on every deploy.
// file_path is now stored RELATIVE to the app root. It used to hold multer's
// absolute req.file.path, which embedded the deploy root
// (/opt/render/project/src/... or /app/...) — so those rows broke on any
// redeploy even before the volume problem, and any template rendering the
// value as a URL emitted a filesystem path.
const DOCS_STORED_PREFIX = 'data/uploads/documents';
const UPLOAD_BASE = path.join(__dirname, '..', DOCS_STORED_PREFIX);
// Files land here first, then move to their final home once the request body
// is parsed — see the note on storage below.
const INCOMING_DIR = path.join(UPLOAD_BASE, '_incoming');

const LIBRARIES = ['delivery', 'accounts'];
const CATEGORIES = {
  delivery: ['01_Quote & Tender', '02_Contracts & Insurances', '03_Planning', '04_Operations', '05_Marketing', '06_Closeout'],
  accounts: ['01_Purchase Orders', '02_Invoices Received', '03_Invoices Issued', '04_Variations', '05_Payments & Remittances', '06_Closeout'],
};

// Multer streams the file as soon as it reaches the file part, so any text
// field posted AFTER it is still missing from req.body inside destination().
// The upload form posts `category` after the file input, so building the path
// here filed every document under "uncategorised" regardless of the category
// chosen. Stage into one directory instead and move the file in the handler,
// where the body is fully parsed — that is also immune to future field
// reordering, which a template edit could otherwise silently break.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(INCOMING_DIR, { recursive: true });
    cb(null, INCOMING_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

/**
 * Normalise a posted category to one of the known values for its library.
 * These become directory names and arrive unvalidated from the form, so a
 * crafted POST could otherwise use `../` to write outside the uploads tree.
 * The result is used for BOTH the path and the stored category column, so the
 * grouping shown in the UI always matches where the file actually lives.
 */
function normaliseCategory(library, category) {
  return (CATEGORIES[library] || []).includes(category) ? category : 'uncategorised';
}

/** Final resting place for an upload, as a path relative to the app root. */
function targetRelPath(library, jobId, category, filename) {
  const job = `job_${parseInt(jobId, 10) || 0}`;
  return path.join(DOCS_STORED_PREFIX, library, job, category, filename);
}

const ALLOWED_DOC_FILES = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|png|jpg|jpeg|gif|csv|txt|zip|dwg)$/i;
const docFileFilter = (req, file, cb) => {
  if (ALLOWED_DOC_FILES.test(file.originalname)) cb(null, true);
  else cb(new Error('File type not allowed'), false);
};
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 }, fileFilter: docFileFilter }); // 50MB limit

// Documents index - browse all jobs with document counts
router.get('/', (req, res) => {
  const db = getDb();
  const jobs = db.prepare(`
    SELECT j.id, j.job_number, j.client, j.status,
      COUNT(d.id) as doc_count,
      MAX(d.created_at) as last_upload
    FROM jobs j
    LEFT JOIN documents d ON d.job_id = j.id
    WHERE j.status IN ('active','on_hold','won')
    GROUP BY j.id
    ORDER BY last_upload DESC NULLS LAST, j.job_number ASC
  `).all();

  res.render('documents/index-all', {
    title: 'Documents',
    jobs,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// Browse documents for a job
router.get('/job/:jobId', (req, res) => {
  const db = getDb();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.jobId);
  if (!job) { req.flash('error', 'Job not found.'); return req.session.save(() => res.redirect('/jobs')); }

  const deliveryDocs = db.prepare(`
    SELECT d.*, u.full_name as uploaded_by_name FROM documents d
    LEFT JOIN users u ON d.uploaded_by_id = u.id
    WHERE d.job_id = ? AND d.library = 'delivery' ORDER BY d.category, d.original_name
  `).all(job.id);

  let accountsDocs = [];
  if (canViewAccounts(req.session.user)) {
    accountsDocs = db.prepare(`
      SELECT d.*, u.full_name as uploaded_by_name FROM documents d
      LEFT JOIN users u ON d.uploaded_by_id = u.id
      WHERE d.job_id = ? AND d.library = 'accounts' ORDER BY d.category, d.original_name
    `).all(job.id);
  }

  res.render('documents/index', {
    title: `Documents: ${job.job_number}`,
    job, deliveryDocs, accountsDocs,
    deliveryCategories: CATEGORIES.delivery, accountsCategories: CATEGORIES.accounts,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// Upload document
router.post('/upload', upload.single('file'), (req, res) => {
  const db = getDb();
  const b = req.body;

  const discardStaged = () => {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) { /* already gone */ } }
  };

  // library is a CHECK-constrained column, so an unknown value would throw a
  // 500 out of the INSERT and strand the uploaded file. Reject it up front.
  if (!LIBRARIES.includes(b.library)) {
    discardStaged();
    req.flash('error', 'Unknown document library.');
    return req.session.save(() => res.redirect(`/documents/job/${b.job_id}`));
  }

  // Enforce accounts library access
  if (b.library === 'accounts' && !canViewAccounts(req.session.user)) {
    discardStaged();
    req.flash('error', 'You do not have permission to upload to Accounts.');
    return req.session.save(() => res.redirect(`/documents/job/${b.job_id}`));
  }

  if (!req.file) {
    req.flash('error', 'No file selected.');
    return req.session.save(() => res.redirect(`/documents/job/${b.job_id}`));
  }

  // Move out of the staging dir now that library/job_id/category are known.
  // Same filesystem, so rename is atomic and cheap. If it somehow fails, keep
  // the staged file and record that path rather than losing the upload.
  const category = normaliseCategory(b.library, b.category);
  const relPath = targetRelPath(b.library, b.job_id, category, req.file.filename);
  const absPath = path.join(__dirname, '..', relPath);
  let storedPath = path.relative(path.join(__dirname, '..'), req.file.path);
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.renameSync(req.file.path, absPath);
    storedPath = relPath;
  } catch (e) {
    console.error('[Documents] could not move upload out of staging:', e.message);
  }

  db.prepare(`
    INSERT INTO documents (job_id, library, category, filename, original_name, file_path, file_size, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id, b.library, category, req.file.filename, req.file.originalname, storedPath, req.file.size, req.session.user.id);

  req.flash('success', `Uploaded: ${req.file.originalname}`);
  req.session.save(() => res.redirect(`/documents/job/${b.job_id}`));
});

// Download document
router.get('/download/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'File not found.'); return req.session.save(() => res.redirect('/jobs')); }

  // Enforce accounts access
  if (doc.library === 'accounts' && !canViewAccounts(req.session.user)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have access to Accounts documents.', user: req.session.user });
  }

  // resolveUploadPath handles the current relative form and legacy absolute
  // rows alike; a miss means the file was lost to a pre-volume deploy.
  const abs = resolveUploadPath(doc.file_path);
  if (!abs) {
    req.flash('error', 'File not found on disk.');
    return req.session.save(() => res.redirect(`/documents/job/${doc.job_id}`));
  }

  res.download(abs, doc.original_name);
});

// Delete document
router.post('/delete/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'File not found.'); return req.session.save(() => res.redirect('/jobs')); }

  if (doc.library === 'accounts' && !canViewAccounts(req.session.user)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have access to Accounts documents.', user: req.session.user });
  }

  const absDel = resolveUploadPath(doc.file_path);
  if (absDel) { try { fs.unlinkSync(absDel); } catch (e) { /* already gone */ } }
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  req.flash('success', 'File deleted.');
  req.session.save(() => res.redirect(`/documents/job/${doc.job_id}`));
});

module.exports = router;
