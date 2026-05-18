// VOC Certificate PDF renderer.
//
// A4 landscape; navy (#1f3864) + gold (#d4af37) brand. Mirrors the HTML
// preview at views/voc-assessments/certificate.ejs section-for-section
// so the printed and screen versions match.
//
// Inputs:
//   assessment — joined voc_assessments + voc_templates + crew_members row
//                (use getAssessmentWithTemplate in routes/voc-assessments.js)
//   certId     — already-issued certificate id (TSC-...). Caller computes
//                this once on submit and persists it; we just render it.
//   verifyUrl  — absolute URL the QR code points at, e.g.
//                https://tstc.up.railway.app/voc/verify/<certId>
//
// Returns a Buffer.

'use strict';

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'images', 'logo.jpg');

const NAVY = '#1f3864';
const GOLD = '#d4af37';
const MUTED = '#666666';
const BORDER_GREY = '#e5e7eb';
const SUBTLE = '#555555';

function fmtDateAU(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney',
  });
}

async function renderVocCertificatePdf(assessment, certId, verifyUrl) {
  const qrPngBuffer = await QRCode.toBuffer(verifyUrl || '', {
    errorCorrectionLevel: 'M',
    type: 'png',
    margin: 1,
    width: 320,
    color: { dark: NAVY, light: '#FFFFFF' },
  });

  return new Promise((resolve, reject) => {
    try {
      // A4 landscape: 842 x 595 pt. Margin 0 so we control everything.
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;   // 842
      const H = doc.page.height;  // 595
      const pad = 40;             // outer page padding (~14mm)

      // Background — clean white. PDFKit fills white by default.

      // Double border: navy outer + gold inner. Insets in pt.
      const navyInset = 22;  // ~8mm
      const goldInset = 28;  // ~10mm
      doc.lineWidth(2).strokeColor(NAVY)
        .rect(navyInset, navyInset, W - navyInset * 2, H - navyInset * 2).stroke();
      doc.lineWidth(1).strokeColor(GOLD)
        .rect(goldInset, goldInset, W - goldInset * 2, H - goldInset * 2).stroke();

      // Corner ornaments — L-shaped gold lines (~18mm)
      const cornerSize = 50;
      const co = navyInset;
      doc.lineWidth(2).strokeColor(GOLD);
      // top-left
      doc.moveTo(co, co + cornerSize).lineTo(co, co).lineTo(co + cornerSize, co).stroke();
      // top-right
      doc.moveTo(W - co - cornerSize, co).lineTo(W - co, co).lineTo(W - co, co + cornerSize).stroke();
      // bottom-left
      doc.moveTo(co, H - co - cornerSize).lineTo(co, H - co).lineTo(co + cornerSize, H - co).stroke();
      // bottom-right
      doc.moveTo(W - co - cornerSize, H - co).lineTo(W - co, H - co).lineTo(W - co, H - co - cornerSize).stroke();

      // Subtle watermark "T&S" rotated, centered. Faint navy at ~4% alpha.
      doc.save();
      doc.fillColor(NAVY).opacity(0.04);
      doc.font('Helvetica-Bold').fontSize(180);
      doc.rotate(-22, { origin: [W / 2, H / 2] });
      doc.text('T&S', W / 2 - 200, H / 2 - 90, { width: 400, align: 'center' });
      doc.restore();
      doc.opacity(1);

      // ─── Brand strip ───────────────────────────────────────
      const brandY = pad + 16;
      let cursorX = pad + 20;
      if (fs.existsSync(LOGO_PATH)) {
        doc.image(LOGO_PATH, cursorX, brandY, { height: 50 });
        cursorX += 90; // logo width allowance
      }
      // Gold vertical divider
      doc.lineWidth(2).strokeColor(GOLD)
        .moveTo(cursorX, brandY).lineTo(cursorX, brandY + 50).stroke();
      cursorX += 14;
      doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(13).text('T&S TRAFFIC CONTROL', cursorX, brandY + 8, { characterSpacing: 1 });
      doc.fillColor(SUBTLE).font('Helvetica').fontSize(8)
        .text('9 Epic Pl, Villawood NSW 2163  |  ABN 58 655 958 320', cursorX, brandY + 30);

      // ─── Title block ───────────────────────────────────────
      const titleTopY = brandY + 75;
      doc.fillColor(GOLD).font('Helvetica-Bold').fontSize(9)
        .text('THIS IS TO CERTIFY', 0, titleTopY, { width: W, align: 'center', characterSpacing: 6 });
      doc.fillColor(NAVY).font('Times-Bold').fontSize(28)
        .text('Certificate of Verification of Competency', 0, titleTopY + 18, { width: W, align: 'center' });
      doc.fillColor('#444').font('Times-Italic').fontSize(12)
        .text('issued in accordance with NSW WHS standards and T&S in-house assessment procedures',
              0, titleTopY + 56, { width: W, align: 'center' });

      // Gold rule + diamond ornament
      const ruleY = titleTopY + 90;
      const ruleW = 360;
      const ruleX = (W - ruleW) / 2;
      doc.lineWidth(1).strokeColor(GOLD)
        .moveTo(ruleX, ruleY).lineTo(ruleX + ruleW / 2 - 8, ruleY).stroke()
        .moveTo(ruleX + ruleW / 2 + 8, ruleY).lineTo(ruleX + ruleW, ruleY).stroke();
      // Diamond
      doc.save();
      doc.translate(W / 2, ruleY).rotate(45);
      doc.fillColor(GOLD).rect(-3, -3, 6, 6).fill();
      doc.restore();

      // ─── Body ───────────────────────────────────────────────
      const bodyY = ruleY + 16;
      doc.fillColor('#333').font('Times-Roman').fontSize(11)
        .text('presented to', 0, bodyY, { width: W, align: 'center' });

      doc.fillColor(NAVY).font('Times-Bold').fontSize(32)
        .text(assessment.worker_name || '—', 0, bodyY + 18, { width: W, align: 'center' });

      if (assessment.worker_emp_id) {
        doc.fillColor(SUBTLE).font('Helvetica').fontSize(9)
          .text('Employee ID: ' + assessment.worker_emp_id, 0, bodyY + 60, { width: W, align: 'center' });
      }

      doc.fillColor(SUBTLE).font('Helvetica-Bold').fontSize(8)
        .text('HAS BEEN ASSESSED COMPETENT IN', 0, bodyY + 80, { width: W, align: 'center', characterSpacing: 3 });
      doc.fillColor(NAVY).font('Times-Bold').fontSize(20)
        .text(assessment.template_name || '—', 0, bodyY + 95, { width: W, align: 'center' });

      // ─── Detail grid ───────────────────────────────────────
      const grid = [
        ['ASSESSMENT DATE', fmtDateAU(assessment.assessment_date)],
        ['VALID UNTIL',     fmtDateAU(assessment.valid_until)],
        ['VOC REFERENCE',   assessment.voc_number || ''],
      ];
      const gridY = bodyY + 140;
      const gridW = W - pad * 2 - 60;
      const gridX = (W - gridW) / 2;
      const colW = gridW / 3;
      doc.lineWidth(0.7).strokeColor(GOLD)
        .moveTo(gridX, gridY).lineTo(gridX + gridW, gridY).stroke();
      doc.moveTo(gridX, gridY + 44).lineTo(gridX + gridW, gridY + 44).stroke();
      grid.forEach((cell, i) => {
        const cx = gridX + i * colW;
        if (i > 0) {
          doc.lineWidth(0.5).strokeColor(BORDER_GREY)
            .moveTo(cx, gridY + 6).lineTo(cx, gridY + 38).stroke();
        }
        doc.fillColor('#888').font('Helvetica-Bold').fontSize(7.5)
          .text(cell[0], cx, gridY + 9, { width: colW, align: 'center', characterSpacing: 2 });
        doc.fillColor(NAVY).font('Times-Bold').fontSize(12)
          .text(cell[1], cx, gridY + 22, { width: colW, align: 'center' });
      });

      // ─── Sign-off row ──────────────────────────────────────
      const signY = gridY + 70;
      const signNames = [
        { name: assessment.assessor_signed_name || assessment.assessor_name || '', role: 'ASSESSOR' },
        { name: assessment.manager_signed_name || '',                              role: 'MANAGER / SUPERVISOR' },
        { name: assessment.worker_signed_name  || assessment.worker_name || '',    role: 'WORKER ACKNOWLEDGEMENT' },
      ];
      const signColW = (gridW - 80) / 3;
      signNames.forEach((s, i) => {
        const cx = gridX + 40 + i * (signColW + 40);
        doc.lineWidth(1.2).strokeColor(NAVY)
          .moveTo(cx, signY + 22).lineTo(cx + signColW, signY + 22).stroke();
        doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5)
          .text(s.name, cx, signY + 26, { width: signColW, align: 'center' });
        doc.fillColor('#888').font('Helvetica').fontSize(7)
          .text(s.role, cx, signY + 42, { width: signColW, align: 'center', characterSpacing: 1.5 });
      });

      // ─── Bottom strip ──────────────────────────────────────
      const bottomY = H - pad - 36;
      // Cert ID (left)
      doc.fillColor('#888').font('Helvetica-Bold').fontSize(7)
        .text('CERTIFICATE ID', pad + 20, bottomY, { characterSpacing: 2 });
      doc.fillColor(NAVY).font('Courier-Bold').fontSize(10)
        .text(certId, pad + 20, bottomY + 12);

      // QR (center)
      const qrSize = 60; // ~22mm
      const qrX = (W - qrSize) / 2;
      const qrY = bottomY - 22;
      doc.image(qrPngBuffer, qrX, qrY, { width: qrSize, height: qrSize });
      doc.lineWidth(1.2).strokeColor(NAVY)
        .rect(qrX, qrY, qrSize, qrSize).stroke();

      // Legal (right)
      const legalW = 280;
      const legalX = W - pad - 20 - legalW;
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
        .text(
          'This certificate verifies competency at the time of assessment. Validity is subject to ongoing adherence to T&S SOPs, the relevant SWMS, and applicable NSW WHS / road regulations. Re-assessment is required by the expiry date above, or sooner if equipment, procedures, or worker capability changes.',
          legalX, bottomY - 4, { width: legalW, align: 'right', lineGap: 1 }
        );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderVocCertificatePdf };
