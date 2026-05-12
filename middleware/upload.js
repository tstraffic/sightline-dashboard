const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

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
module.exports.payrollReceiptUpload = payrollReceiptUpload;
module.exports.payrollReceiptsDir = payrollReceiptsDir;
