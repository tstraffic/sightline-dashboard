// Standalone TGS Risk & Options Assessment PDF renderer.
//
// Sibling to lib/raTemplates/tgsRiskOptions.js — that one renders the
// risk_assessments / fill-tgs flow; this one renders the standalone
// /tgs-risk-assessments form persisted to the tgs_risk_assessments table.
// Layout matches the screen form section-for-section so the printed PDF
// is recognisable as the same document.

'use strict';

const PDFDocument = require('pdfkit');
const {
  QUESTIONS,
  LIKELIHOOD,
  CONSEQUENCE,
  MATRIX_HEADERS,
  MATRIX_ROWS,
  ACTION_LEVELS,
  computeRating,
} = require('../raTemplates/tgsRiskOptions');

const BRAND = '#1D6AE5';
const BRAND_LIGHT = '#E5EEFB';
const BORDER = '#D0D7E2';
const MUTED = '#666666';

function renderTgsRiskAssessmentPdf(assessment, responses) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 36 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const r = responses || {};
      const site = r.site || {};
      const opts = r.options || {};
      const answers = r.answers || {};
      const section4 = Array.isArray(r.section4) ? r.section4 : [];
      const riskMgmt = Array.isArray(r.risk_management) ? r.risk_management : [];
      const signOff = r.sign_off || {};
      const author = signOff.author || {};
      const approver = signOff.approver || {};
      const oneUp = signOff.one_up || {};

      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const usable = right - left;

      // Header band
      const headerY = doc.y;
      doc.rect(left, headerY, usable, 56).fill(BRAND);
      doc.fillColor('white').font('Helvetica-Bold').fontSize(14)
        .text('T&S Traffic Control', left + 12, headerY + 8, { width: usable - 24 });
      doc.font('Helvetica').fontSize(9)
        .text('ABN 58 655 958 320', left + 12, headerY + 25, { width: usable - 24 });
      doc.font('Helvetica-Bold').fontSize(11)
        .text('Traffic Guidance Scheme — Risk & Options Assessment', left + 12, headerY + 37, { width: usable - 24 });
      doc.fillColor('black');
      doc.y = headerY + 60;

      doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
        `Doc No: TSROA-001    Rev: A    Ref: ${assessment.tgs_ref_no || '—'}    Assessment #${assessment.id}    Generated: ${new Date().toISOString().slice(0, 10)}`,
        left, doc.y, { width: usable, align: 'right' }
      );
      doc.fillColor('black').moveDown(0.6);

      const sectionHeading = (text) => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(0.4);
        const y0 = doc.y;
        doc.rect(left, y0, usable, 18).fill(BRAND_LIGHT);
        doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(11)
          .text(text, left + 8, y0 + 4, { width: usable - 16 });
        doc.fillColor('black').font('Helvetica');
        doc.y = y0 + 22;
      };

      // Site Location Details — two-column grid
      sectionHeading('Site Location Details');
      const siteFields = [
        ['Road', site.road], ['Suburb', site.suburb],
        ['From Side St', site.from_side_st], ['To Side St', site.to_side_st],
        ['Direction', (site.direction || '').toUpperCase()],
        ['Posted Speed', site.posted_speed ? site.posted_speed + ' km/h' : ''],
        ['Client / Principal', site.client_principal], ['Road Authority', site.road_authority],
        ['TGS Design No', site.tgs_design_no], ['Design Date', site.design_date],
        ['Estimated Duration', site.estimated_duration], ['Scope of Works', site.scope_of_works],
      ];
      const colW = usable / 2;
      const yStart = doc.y;
      siteFields.forEach((pair, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = left + col * colW;
        const y = yStart + row * 24;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#555')
          .text(pair[0].toUpperCase(), x + 4, y, { width: colW - 8 });
        doc.font('Helvetica').fontSize(10).fillColor('black')
          .text(pair[1] || '—', x + 4, y + 10, { width: colW - 8 });
      });
      doc.y = yStart + Math.ceil(siteFields.length / 2) * 24 + 4;

      // Options Assessment
      sectionHeading('Options Assessment');
      const method = opts.method_selected || '';
      const mk = (label, val) => (method === val ? '☒ ' : '☐ ') + label;
      doc.font('Helvetica').fontSize(10)
        .text('Method Selected:   ' + mk('Around', 'around') + '     ' + mk('Past', 'past') + '     ' + mk('Through', 'through'),
          left, doc.y, { width: usable });
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#555')
        .text('REASON FOR METHOD SELECTED', left, doc.y);
      doc.font('Helvetica').fontSize(10).fillColor('black')
        .text(opts.method_reason || '—', left, doc.y + 2, { width: usable });
      doc.moveDown(0.5);

      // Question table renderer
      const drawQuestionTable = (sectionLabel, rows, note) => {
        sectionHeading(sectionLabel);
        if (note) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
            .text(note, left, doc.y, { width: usable });
          doc.fillColor('black').moveDown(0.3);
        }
        const colNo = 28, colYN = 28, colRate = 70, colDesc = 110;
        const colQ = usable - colNo - colYN - colYN - colDesc - colRate;
        const headers = ['#', 'Question', 'Yes', 'No', 'Description of Risks (if No)', 'Rating'];
        const widths = [colNo, colQ, colYN, colYN, colDesc, colRate];

        const headerY = doc.y;
        doc.rect(left, headerY, usable, 16).fill(BRAND_LIGHT).stroke(BORDER);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#333');
        let xCur = left;
        widths.forEach((w, i) => {
          doc.text(headers[i], xCur + 4, headerY + 4, { width: w - 8 });
          xCur += w;
        });
        let y = headerY + 16;
        doc.fillColor('black').font('Helvetica').fontSize(9);
        rows.forEach((row) => {
          const qH = doc.heightOfString(row.text || '', { width: colQ - 8 });
          const dH = doc.heightOfString(row.desc || '—', { width: colDesc - 8 });
          const rowH = Math.max(20, qH + 6, dH + 6);
          if (y + rowH > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          doc.rect(left, y, usable, rowH).stroke(BORDER);
          let cx = left;
          doc.text(row.number, cx + 4, y + 4, { width: colNo - 8 }); cx += colNo;
          doc.text(row.text || '', cx + 4, y + 4, { width: colQ - 8 }); cx += colQ;
          doc.text(row.yn === 'yes' ? '☒' : '☐', cx + 8, y + 4); cx += colYN;
          doc.text(row.yn === 'no'  ? '☒' : '☐', cx + 8, y + 4); cx += colYN;
          doc.text(row.desc || '—', cx + 4, y + 4, { width: colDesc - 8 }); cx += colDesc;
          const rating = row.rating || computeRating(row.likelihood, row.consequence) || '—';
          const lcStr = (row.likelihood && row.consequence) ? `  (${row.consequence}${row.likelihood})` : '';
          doc.text(rating + lcStr, cx + 4, y + 4, { width: colRate - 8 });
          y += rowH;
        });
        doc.y = y + 4;
      };

      const buildRow = (q) => Object.assign({}, q, answers[q.number] || {});
      drawQuestionTable('Risk Assessment — Section 1: General',
        QUESTIONS.filter(q => q.section === 1).map(buildRow));
      drawQuestionTable('Section 2 — Shuttle Flow',
        QUESTIONS.filter(q => q.section === 2).map(buildRow),
        'If not applicable, Section 2 answers may be left blank.');
      drawQuestionTable('Section 3 — Detours',
        QUESTIONS.filter(q => q.section === 3).map(buildRow),
        'If not applicable, Section 3 answers may be left blank.');

      if (section4.length > 0) {
        drawQuestionTable('Section 4 — Other Hazards & Risks',
          section4.map((row, i) => ({
            number: '4.' + (i + 1),
            text: row.question || '—',
            yn: row.yn,
            desc: row.desc,
            rating: row.rating,
            likelihood: row.likelihood,
            consequence: row.consequence,
          }))
        );
      }

      // Risk Management
      sectionHeading('Risk Management');
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED).text(
        'Any risks identified during the above assessment must be controlled below. Control measures must meet the WHS Risk Management Hierarchy of Controls (Eliminate → Substitute → Engineering → Administrative → PPE).',
        left, doc.y, { width: usable }
      );
      doc.fillColor('black').moveDown(0.3);
      if (riskMgmt.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(MUTED)
          .text('No risk-management entries recorded.', left, doc.y);
        doc.fillColor('black').moveDown(0.5);
      } else {
        const wItem = 36, wRating = 90;
        const wHazard = (usable - wItem - wRating) / 2;
        const wCtrl = wHazard;
        const headerY = doc.y;
        doc.rect(left, headerY, usable, 16).fill(BRAND_LIGHT).stroke(BORDER);
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#333');
        doc.text('Item',                       left + 4,                                headerY + 4, { width: wItem - 8 });
        doc.text('Hazard / Risk',              left + wItem + 4,                        headerY + 4, { width: wHazard - 8 });
        doc.text('Control Measures',           left + wItem + wHazard + 4,              headerY + 4, { width: wCtrl - 8 });
        doc.text('Remaining Risk Rating',      left + wItem + wHazard + wCtrl + 4,      headerY + 4, { width: wRating - 8 });
        let y = headerY + 16;
        doc.font('Helvetica').fontSize(9).fillColor('black');
        riskMgmt.forEach((row, i) => {
          const hazH = doc.heightOfString(row.hazard || '—', { width: wHazard - 8 });
          const ctrlH = doc.heightOfString(row.controls || '—', { width: wCtrl - 8 });
          const rowH = Math.max(22, hazH + 6, ctrlH + 6);
          if (y + rowH > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          doc.rect(left, y, usable, rowH).stroke(BORDER);
          doc.text(row.ref || String(i + 1), left + 4, y + 4, { width: wItem - 8 });
          doc.text(row.hazard || '—', left + wItem + 4, y + 4, { width: wHazard - 8 });
          doc.text(row.controls || '—', left + wItem + wHazard + 4, y + 4, { width: wCtrl - 8 });
          const rating = row.rating || computeRating(row.likelihood, row.consequence) || '—';
          const lc = (row.likelihood && row.consequence) ? `  (${row.consequence}${row.likelihood})` : '';
          doc.text(rating + lc, left + wItem + wHazard + wCtrl + 4, y + 4, { width: wRating - 8 });
          y += rowH;
        });
        doc.y = y + 4;
      }

      // Matrix reference
      sectionHeading('Risk Rating Matrix');
      const cols = MATRIX_HEADERS.length;
      const matrixColW = usable / cols;
      const my0 = doc.y;
      doc.rect(left, my0, usable, 16).fill(BRAND_LIGHT).stroke(BORDER);
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#333');
      MATRIX_HEADERS.forEach((h, i) =>
        doc.text(h, left + i * matrixColW + 2, my0 + 4, { width: matrixColW - 4 })
      );
      let my = my0 + 16;
      doc.fillColor('black').font('Helvetica').fontSize(7);
      MATRIX_ROWS.forEach((row) => {
        doc.rect(left, my, usable, 18).stroke(BORDER);
        row.forEach((cell, j) => {
          doc.font(j === 0 ? 'Helvetica-Bold' : 'Helvetica')
            .text(cell, left + j * matrixColW + 2, my + 5, { width: matrixColW - 4 });
        });
        my += 18;
      });
      doc.y = my + 6;

      sectionHeading('Residual Risk Action Levels');
      doc.font('Helvetica').fontSize(9);
      ACTION_LEVELS.forEach(lvl => {
        doc.font('Helvetica-Bold').text(`${lvl.rating} — ${lvl.label}`, left, doc.y, { continued: true });
        doc.font('Helvetica').text(`  ${lvl.text}`, { width: usable });
      });
      doc.moveDown(0.4);

      // Additional comments
      sectionHeading('Additional Comments');
      doc.font('Helvetica').fontSize(10)
        .text(r.additional_comments || '—', left, doc.y, { width: usable });
      doc.moveDown(0.5);

      // Sign-off
      sectionHeading('Sign-Off');
      const drawSignBlock = (title, who) => {
        if (doc.y > doc.page.height - 100) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text(title, left, doc.y, { width: usable });
        doc.font('Helvetica').fontSize(9).fillColor('black');
        doc.text(`Name: ${who.name || '________________'}    PWZ Lic No: ${who.pwz || '________'}    Date: ${who.date || '________'}`,
          left, doc.y + 2, { width: usable });
        doc.text('Signature: ' + '_'.repeat(80), left, doc.y + 4);
        doc.moveDown(0.4);
      };
      drawSignBlock('Author (Designer)', author);
      drawSignBlock('Approver', approver);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#333')
        .text(`TGS Ref No: ${signOff.tgs_ref_no || assessment.tgs_ref_no || ''}`, left, doc.y);
      doc.fillColor('black').moveDown(0.2);

      doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('One-Up Manager', left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black').text(
        `Name: ${oneUp.name || '________________'}    Accreditation: ${oneUp.accreditation || '________'}    Date: ${oneUp.date || '________'}`,
        left, doc.y + 2, { width: usable }
      );
      doc.text('Signature: ' + '_'.repeat(80), left, doc.y + 4);
      doc.moveDown(0.4);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUTED).text(
        'One-Up Manager approval required where any residual risk is rated High (3) or Extreme (4).',
        left, doc.y, { width: usable }
      );
      doc.fillColor('black');

      // Footer / residual summary
      if (assessment.residual_risk) {
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#333')
          .text(`Highest residual risk: ${assessment.residual_risk}${assessment.requires_one_up ? '  —  One-Up Manager sign-off required' : ''}`,
            left, doc.y, { width: usable });
        doc.fillColor('black');
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { renderTgsRiskAssessmentPdf };
