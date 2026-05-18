const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');

// Multer config for induction document uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'data', 'uploads', 'inductions');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const prefix = file.fieldname;
    cb(null, `${prefix}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.pdf', '.webp', '.heic', '.heif', '.gif', '.bmp', '.tiff', '.tif', '.svg', '.avif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('File type not supported. Please upload an image (JPG, PNG, HEIC) or PDF.'));
    }
  }
});

const uploadFields = upload.fields([
  { name: 'white_card_photo', maxCount: 1 },
  { name: 'tc_licence_photo', maxCount: 1 },
  { name: 'drivers_licence_photo', maxCount: 1 },
  { name: 'drivers_licence_back_photo', maxCount: 1 },
]);

// Valid payment types
const VALID_TYPES = ['cash', 'tfn', 'abn'];

// ─── No-cache middleware for all induction routes ───
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ─── LITERAL ROUTES FIRST (before /:type catches them) ───

// GET /induction — unified form
router.get('/', (req, res) => {
  const accessToken = crypto.randomBytes(24).toString('hex');
  res.render('induction/form', {
    layout: false,
    paymentType: 'unified',
    accessToken,
    title: 'T&S Induction'
  });
});

// GET /induction/complete — confirmation page
router.get('/complete', (req, res) => {
  res.render('induction/complete', {
    layout: false,
    paymentType: 'unified',
    title: 'Application Submitted'
  });
});

// POST /induction/submit — unified submit
router.post('/submit', (req, res) => {
  handleSubmission(req, res);
});

// ─── PARAMETRIC ROUTES (legacy URLs) ───

// GET /induction/:type — legacy URLs (cash, tfn, abn)
router.get('/:type', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();

  const accessToken = crypto.randomBytes(24).toString('hex');
  res.render('induction/form', {
    layout: false,
    paymentType: type,
    accessToken,
    title: 'T&S Induction'
  });
});

// GET /induction/:type/complete — legacy complete URLs
router.get('/:type/complete', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();

  res.render('induction/complete', {
    layout: false,
    paymentType: type,
    title: 'Application Submitted'
  });
});

// POST /induction/:type/submit — legacy submit URLs
router.post('/:type/submit', (req, res, next) => {
  const { type } = req.params;
  if (!VALID_TYPES.includes(type)) return next();
  handleSubmission(req, res);
});

function handleSubmission(req, res) {
  // Check if client wants JSON (fetch-based submission)
  const wantsJSON = req.headers['x-requested-with'] === 'fetch';

  uploadFields(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      if (wantsJSON) {
        return res.status(400).json({ ok: false, error: 'Upload error: ' + err.message });
      }
      return res.status(400).send('Upload error: ' + err.message);
    }

    try {
      const b = req.body;
      const db = getDb();
      const paymentType = b.payment_type || req.params?.type || 'tfn';

      // Compute full_name from split fields (or use legacy field)
      const fn = (b.first_name || '').trim();
      const mn = (b.middle_name || '').trim();
      const ln = (b.last_name || '').trim();
      const computedFullName = [fn, mn, ln].filter(Boolean).join(' ') || (b.full_name || '').trim();

      // Get uploaded file paths
      const whiteCardPhoto = req.files?.white_card_photo?.[0]?.filename || '';
      const tcLicencePhoto = req.files?.tc_licence_photo?.[0]?.filename || '';
      const driversLicencePhoto = req.files?.drivers_licence_photo?.[0]?.filename || '';
      const driversLicenceBackPhoto = req.files?.drivers_licence_back_photo?.[0]?.filename || '';

      // For ABN contractors, bank fields have abn_ prefix to avoid form name conflicts
      if (paymentType === 'abn') {
        b.bank_name = b.abn_bank_name || b.bank_name || '';
        b.bank_bsb = b.abn_bank_bsb || b.bank_bsb || '';
        b.bank_account_number = b.abn_bank_account_number || b.bank_account_number || '';
        b.bank_account_name = b.abn_bank_account_name || b.bank_account_name || '';
      }
      // For cash workers, bank fields have cash_ prefix
      if (paymentType === 'cash') {
        b.bank_name = b.cash_bank_name || b.bank_name || '';
        b.bank_bsb = b.cash_bank_bsb || b.bank_bsb || '';
        b.bank_account_number = b.cash_bank_account_number || b.bank_account_number || '';
        b.bank_account_name = b.cash_bank_account_name || b.bank_account_name || '';
      }

      // Always generate a fresh token to avoid UNIQUE constraint on re-submit
      const accessToken = crypto.randomBytes(24).toString('hex');

      // Validate payment_type against DB CHECK constraint
      const validPaymentTypes = ['cash', 'tfn', 'abn'];
      if (!validPaymentTypes.includes(paymentType)) {
        throw new Error('Invalid payment type: "' + paymentType + '". Please go back and select Employee (TFN) or Contractor (ABN).');
      }

      // Dynamically build INSERT based on columns that actually exist in the DB
      const existingCols = db.prepare("PRAGMA table_info(induction_submissions)").all().map(c => c.name);

      console.log('DB columns found:', existingCols.length, 'Payment type:', paymentType);

      if (existingCols.length === 0) {
        throw new Error('induction_submissions table not found — migrations may not have run');
      }

      // Signature + consent
      let signatureUrl = '';
      try {
        const sigDataUrl = b.signature_data || '';
        if (/^data:image\/(png|jpeg);base64,/.test(sigDataUrl)) {
          const sigDir = path.join(__dirname, '..', 'data', 'uploads', 'inductions', 'signatures');
          fs.mkdirSync(sigDir, { recursive: true });
          const fname = `signature_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
          const base64 = sigDataUrl.split(',')[1];
          fs.writeFileSync(path.join(sigDir, fname), Buffer.from(base64, 'base64'));
          signatureUrl = `/data/uploads/inductions/signatures/${fname}`;
        }
      } catch (e) { console.error('Signature save failed:', e.message); }
      const consentAck = (b.consent_ack === 'on' || b.consent_ack === '1' || b.consent_ack === true);
      const consentFullName = (b.consent_full_name || '').trim();
      const nowIso = new Date().toISOString();

      if (!signatureUrl || !consentAck || !consentFullName) {
        if (wantsJSON) return res.status(400).json({ ok: false, error: 'Please sign the induction agreement, type your full name and tick the acknowledgement.' });
        return res.status(400).send('Please sign the induction agreement, type your full name and tick the acknowledgement.');
      }

      // DOB is compulsory — payroll, super, certain tickets and the worker
      // birthday flow all key off it. Validate format and a sane age range so
      // typos like "0202-05-18" or "2030-05-18" don't get through.
      const dobRaw = (b.date_of_birth || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dobRaw)) {
        const msg = 'Please enter your date of birth.';
        if (wantsJSON) return res.status(400).json({ ok: false, error: msg });
        return res.status(400).send(msg);
      }
      const dobDate = new Date(dobRaw + 'T00:00:00');
      const dobYear = dobDate.getFullYear();
      const nowYear = new Date().getFullYear();
      if (isNaN(dobDate.getTime()) || dobDate > new Date() || dobYear < 1900 || (nowYear - dobYear) < 14) {
        const msg = 'Date of birth looks wrong — please check and try again.';
        if (wantsJSON) return res.status(400).json({ ok: false, error: msg });
        return res.status(400).send(msg);
      }

      // All possible column→value mappings
      const allFields = {
        access_token: accessToken,
        payment_type: paymentType,
        status: 'submitted',
        full_name: computedFullName,
        first_name: fn,
        middle_name: mn,
        last_name: ln,
        email: b.email || '',
        phone: b.phone || '',
        date_of_birth: b.date_of_birth || '',
        address: b.address || '',
        suburb: b.suburb || '',
        state: b.state || '',
        postcode: b.postcode || '',
        can_drive: b.can_drive || '',
        can_drive_truck: b.can_drive_truck || '',
        has_injuries: b.has_injuries || '',
        injury_details: b.injury_details || '',
        is_indigenous: b.is_indigenous || '',
        white_card_number: b.white_card_number || '',
        tc_licence_number: b.tc_licence_number || '',
        tc_licence_date_of_issue: b.tc_licence_date_of_issue || '',
        tc_licence_state: b.tc_licence_state || '',
        drivers_licence_number: b.drivers_licence_number || '',
        white_card_photo: whiteCardPhoto,
        tc_licence_photo: tcLicencePhoto,
        drivers_licence_photo: driversLicencePhoto,
        drivers_licence_back_photo: driversLicenceBackPhoto,
        experience_years: b.experience_years || '',
        experience_description: b.experience_description || '',
        tax_file_number: b.tax_file_number || '',
        bank_name: b.bank_name || '',
        bank_bsb: b.bank_bsb || '',
        bank_account_number: b.bank_account_number || '',
        bank_account_name: b.bank_account_name || '',
        abn_number: b.abn_number || '',
        has_insurance: b.has_insurance || '',
        super_fund_name: b.super_fund_name || '',
        super_fund_abn: b.super_fund_abn || '',
        super_usi: b.super_usi || '',
        super_member_number: b.super_member_number || '',
        emergency_contact_name: b.emergency_contact_name || '',
        emergency_contact_phone: b.emergency_contact_phone || '',
        emergency_contact_relationship: b.emergency_contact_relationship || '',
        company_intro_completed: (b.company_intro_completed === 'on' || b.company_intro_completed === '1') ? 1 : 0,
        ppe_acknowledged: (b.ppe_acknowledged === 'on' || b.ppe_acknowledged === '1') ? 1 : 0,
        submitted_at: nowIso,
        signature_url: signatureUrl,
        consent_signed_at: nowIso,
        consent_full_name: consentFullName,
        consent_version: 'induction-consent-v1',
        signed_ip: (req.ip || req.connection?.remoteAddress || '').toString().slice(0, 45),
      };

      // Build named params — only for columns that exist in the table
      // Sanitize every value to a type SQLite can bind (string, number, null, buffer)
      const colNames = [];
      const params = {};
      for (const [col, val] of Object.entries(allFields)) {
        if (existingCols.includes(col)) {
          colNames.push(col);
          if (val === null || val === undefined) {
            params[col] = null;
          } else if (typeof val === 'number' || typeof val === 'bigint' || Buffer.isBuffer(val)) {
            params[col] = val;
          } else {
            // Convert arrays, objects, booleans, etc. to string
            params[col] = String(val);
          }
        }
      }

      const sql = `INSERT INTO induction_submissions (${colNames.join(', ')}) VALUES (${colNames.map(c => '$' + c).join(', ')})`;
      console.log('Running INSERT with', colNames.length, 'named params for:', computedFullName);
      db.prepare(sql).run(params);

      console.log('Induction submitted successfully:', computedFullName, paymentType);

      if (wantsJSON) {
        return res.json({ ok: true });
      }
      res.redirect('/induction/complete');
    } catch (error) {
      console.error('Induction submission error:', error);
      console.error('Error stack:', error.stack);
      if (wantsJSON) {
        return res.status(500).json({ ok: false, error: error.message });
      }
      res.status(500).send('Submission error: ' + error.message);
    }
  });
}

module.exports = router;
