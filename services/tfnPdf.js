// Generate a PDF summary of a TFN declaration. This is a clean, labeled
// document that captures every ATO field — not a pixel-perfect NAT 3092 replica,
// which would require reproducing ATO artwork. The layout mirrors the official
// section structure so admins can cross-reference against NAT 3092.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function formatTfn(tfn) {
  if (!tfn) return '';
  const digits = String(tfn).replace(/\D/g, '');
  return digits.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
}

/**
 * Generate PDF at target path. Input is the already-decrypted declaration data.
 * Returns the written path.
 */
function generateTfnPdf({ employee, declaration, tfn, signatureDataUrl, outPath }) {
  ensureDir(path.dirname(outPath));

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const stream = fs.createWriteStream(outPath);
    stream.on('finish', () => resolve(outPath));
    stream.on('error', reject);
    doc.pipe(stream);

    // Header band
    doc.rect(0, 0, doc.page.width, 70).fill('#0A1628');
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(16)
      .text('Tax File Number Declaration', 48, 22, { align: 'left' });
    doc.fontSize(9).fillColor('#93C5FD')
      .text('Modelled on ATO NAT 3092 — generated electronically by T&S Traffic Control', 48, 44, { align: 'left' });

    doc.fillColor('#111827').font('Helvetica').fontSize(10);
    doc.moveDown(3);

    // Section 1 — Payee
    sectionHeader(doc, 'Section A — Payee (employee)');
    labelValue(doc, 'Full name', employee.full_name || '');
    labelValue(doc, 'Employee code', employee.employee_code || '');
    labelValue(doc, 'Date of birth', employee.date_of_birth || '—');
    labelValue(doc, 'Tax file number', formatTfn(tfn));
    labelValue(doc, 'Residency status', residencyLabel(declaration.residency_status));
    labelValue(doc, 'Australian address', formatAddress(employee));
    doc.moveDown(0.5);

    // Section 2 — Declarations
    sectionHeader(doc, 'Section B — Declarations');
    labelValue(doc, 'Claim tax-free threshold', declaration.claim_threshold ? 'Yes' : 'No');
    labelValue(doc, 'Has a Higher Education Loan Program (HELP) debt', declaration.has_help_debt ? 'Yes' : 'No');
    labelValue(doc, 'Has a Student Start-up Loan (SSL) / Trade Support Loan / STSL debt', declaration.has_stsl_debt ? 'Yes' : 'No');
    labelValue(doc, 'Medicare levy variation', medicareLabel(declaration.medicare_variation));
    doc.moveDown(0.5);

    // Section 3 — Declaration & Signature
    sectionHeader(doc, 'Section C — Employee declaration');
    doc.fontSize(9).fillColor('#374151').text(
      'I declare that the information I have given on this form is true and correct. ' +
      'I am aware that providing false or misleading information is a serious offence under the Taxation Administration Act 1953.',
      { align: 'left' }
    );
    doc.moveDown(0.5);

    doc.fontSize(10).fillColor('#111827');
    labelValue(doc, 'Submitted at', declaration.submitted_at || new Date().toISOString());

    // Signature image (data URL)
    const sigY = doc.y + 8;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#6B7280').text('SIGNATURE', 48, sigY);
    if (signatureDataUrl && /^data:image\/(png|jpeg);base64,/.test(signatureDataUrl)) {
      try {
        const base64 = signatureDataUrl.split(',')[1];
        const imgBuf = Buffer.from(base64, 'base64');
        doc.image(imgBuf, 48, sigY + 14, { fit: [220, 70] });
      } catch (e) { /* skip image */ }
    }
    doc.rect(48, sigY + 84, 220, 0.8).fill('#9CA3AF');
    doc.fontSize(8).fillColor('#9CA3AF').text('Signed electronically via Atomis Crew', 48, sigY + 88);

    // Footer watermark
    doc.fontSize(7).fillColor('#9CA3AF').text(
      `TFN: ${maskTfn(tfn)} — this copy contains only the last three digits of the TFN for identification. Original encrypted value stored in the T&S payroll system.`,
      48, doc.page.height - 40, { align: 'left', width: doc.page.width - 96 }
    );

    doc.end();
  });
}

function sectionHeader(doc, text) {
  doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11).fillColor('#1D6AE5').text(text);
  doc.rect(doc.x, doc.y + 2, doc.page.width - 96, 0.8).fill('#BFDBFE');
  doc.moveDown(0.4).font('Helvetica').fontSize(10).fillColor('#111827');
}

function labelValue(doc, label, value) {
  const startY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#6B7280').text(label.toUpperCase(), { continued: false });
  doc.font('Helvetica').fontSize(11).fillColor('#111827').text(String(value || '—'));
  doc.moveDown(0.2);
  return startY;
}

function residencyLabel(r) {
  return {
    resident: 'Australian resident for tax purposes',
    foreign: 'Foreign resident for tax purposes',
    working_holiday: 'Working holiday maker',
  }[r] || '—';
}
function medicareLabel(m) {
  return {
    none: 'No variation',
    reduction: 'Request reduced Medicare levy',
    exemption: 'Request full Medicare levy exemption',
  }[m] || '—';
}
function formatAddress(e) {
  const parts = [e.address_line1, e.address_line2, e.suburb, e.state, e.postcode].filter(Boolean);
  return parts.join(', ');
}
function maskTfn(tfn) {
  if (!tfn) return '••• ••• •••';
  const d = String(tfn).replace(/\D/g, '');
  return '••• ••• ' + d.slice(-3);
}

module.exports = { generateTfnPdf };
