const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { requireAccountsAccess, canViewAccounts } = require('../middleware/auth');

const UPLOAD_BASE = path.join(__dirname, '..', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const library = req.body.library || 'delivery';
    const jobId = req.body.job_id;
    const category = req.body.category || 'uncategorised';
    const dir = path.join(UPLOAD_BASE, library, `job_${jobId}`, category);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

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

  const deliveryCategories = ['01_Quote & Tender', '02_Contracts & Insurances', '03_Planning', '04_Operations', '05_Marketing', '06_Closeout'];
  const accountsCategories = ['01_Purchase Orders', '02_Invoices Received', '03_Invoices Issued', '04_Variations', '05_Payments & Remittances', '06_Closeout'];

  res.render('documents/index', {
    title: `Documents: ${job.job_number}`,
    job, deliveryDocs, accountsDocs, deliveryCategories, accountsCategories,
    user: req.session.user,
    canViewAccounts: canViewAccounts(req.session.user)
  });
});

// Upload document
router.post('/upload', upload.single('file'), (req, res) => {
  const db = getDb();
  const b = req.body;

  // Enforce accounts library access
  if (b.library === 'accounts' && !canViewAccounts(req.session.user)) {
    if (req.file) fs.unlinkSync(req.file.path);
    req.flash('error', 'You do not have permission to upload to Accounts.');
    return req.session.save(() => res.redirect(`/documents/job/${b.job_id}`));
  }

  if (!req.file) {
    req.flash('error', 'No file selected.');
    return req.session.save(() => res.redirect(`/documents/job/${b.job_id}`));
  }

  db.prepare(`
    INSERT INTO documents (job_id, library, category, filename, original_name, file_path, file_size, uploaded_by_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.job_id, b.library, b.category, req.file.filename, req.file.originalname, req.file.path, req.file.size, req.session.user.id);

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

  if (!fs.existsSync(doc.file_path)) {
    req.flash('error', 'File not found on disk.');
    return req.session.save(() => res.redirect(`/documents/job/${doc.job_id}`));
  }

  res.download(doc.file_path, doc.original_name);
});

// Delete document
router.post('/delete/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) { req.flash('error', 'File not found.'); return req.session.save(() => res.redirect('/jobs')); }

  if (doc.library === 'accounts' && !canViewAccounts(req.session.user)) {
    return res.status(403).render('error', { title: 'Access Denied', message: 'You do not have access to Accounts documents.', user: req.session.user });
  }

  if (fs.existsSync(doc.file_path)) fs.unlinkSync(doc.file_path);
  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  req.flash('success', 'File deleted.');
  req.session.save(() => res.redirect(`/documents/job/${doc.job_id}`));
});

module.exports = router;
