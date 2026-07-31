const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Shared uploads (traffic plans, CTMPs, incident photos).
//
// These used to land in public/uploads. That directory is baked into the
// container image and is NOT on the persistent volume — only `data/` is
// (render.yaml mounts the disk at .../data; Railway mounts /app/data). So
// every redeploy wiped the files while the DB rows survived, and the stored
// path then 404'd. Compliance documents never had this problem because they
// already lived under data/uploads. Now everything does.
//
// STORED_PREFIX is the relative path written to the DB. Templates render it
// as `/` + value, which lands on the `/data/uploads` static mount in
// server.js — so no template changes were needed when this moved.
const STORED_PREFIX = 'data/uploads/shared';
const uploadsDir = path.join(__dirname, '..', STORED_PREFIX);
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

/**
 * Resolve a stored upload path to a file on disk, tolerating both the current
 * `data/uploads/shared/x.pdf` convention and the legacy `uploads/x.pdf` one
 * (which lived under public/). Returns null when nothing exists — callers
 * should treat that as "already gone" rather than an error.
 */
function resolveUploadPath(stored) {
  if (!stored) return null;
  const rel = String(stored).replace(/^\/+/, '');
  const candidates = [
    path.isAbsolute(stored) ? stored : null,
    path.join(__dirname, '..', rel),            // data/uploads/... (current)
    path.join(__dirname, '..', 'public', rel),  // public/uploads/... (legacy)
  ].filter(Boolean);
  return candidates.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } }) || null;
}

const upload = multer({
  storage,
  // 25MB — traffic plan PDFs (TGS/TMP) routinely run 15–20MB. The previous
  // 10MB cap was rejecting real plans and surfacing as a confusing
  // "Unexpected token '<'" because Express returned an HTML error page.
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|pdf|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext && mime);
  }
});

// Payroll receipt uploads. Stored under data/uploads/payroll-receipts/<runId>/<lineId>/.
// Kept outside /public so the file path is private — receipts are served by an
// auth-checked route, not by express.static.
const payrollReceiptsDir = path.join(__dirname, '..', 'data', 'uploads', 'payroll-receipts');
if (!fs.existsSync(payrollReceiptsDir)) fs.mkdirSync(payrollReceiptsDir, { recursive: true });

const payrollReceiptStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const runId  = String(parseInt(req.params.id, 10) || 0);
    const lineId = String(parseInt(req.params.lineId, 10) || 0);
    const dir = path.join(payrollReceiptsDir, runId, lineId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = Date.now() + '_' + Math.round(Math.random() * 1e9);
    cb(null, base + ext);
  },
});

const payrollReceiptUpload = multer({
  storage: payrollReceiptStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|pdf|webp|heic|heif/;
    const ext = allowed.test(path.extname(file.originalname || '').toLowerCase());
    const mime = allowed.test(file.mimetype || '');
    if (!ext && !mime) return cb(new Error('Only images and PDFs are allowed for receipts.'));
    cb(null, true);
  },
});

module.exports = upload;
module.exports.upload = upload;
module.exports.STORED_PREFIX = STORED_PREFIX;
module.exports.resolveUploadPath = resolveUploadPath;
module.exports.payrollReceiptUpload = payrollReceiptUpload;
module.exports.payrollReceiptsDir = payrollReceiptsDir;
