// TGS Risk & Options Assessment — single source of truth for the question
// catalogue + the PDF renderer that drives Generate Combined PDF.
//
// The same QUESTIONS array feeds the EJS fill form, so screen and print
// can't drift. responses_json shape is documented under SCHEMA below.

'use strict';

const PDFDocument = require('pdfkit');

// Section 1 / 2 / 3 question banks. Section 4 is user-defined free rows.
const QUESTIONS = [
  { section: 1, number: '1.1', text: 'Does the TGS define minimum clearances required of workers to live traffic, are distances compliant?' },
  { section: 1, number: '1.2', text: 'Are taper lengths compliant and not placed in areas with poor sight distance?' },
  { section: 1, number: '1.3', text: 'Are lane status signs placed in advance of a lane merge?' },
  { section: 1, number: '1.4', text: 'Are worker symbolic signs placed in advance of areas where workers will be visible to traffic?' },
  { section: 1, number: '1.5', text: 'Are the correct tapers being used? (Merge Taper, Traffic Control Taper, Lateral Shift Taper)' },
  { section: 1, number: '1.6', text: 'Does the TGS clearly define buffer areas, are they compliant and at least 30m in length?' },
  { section: 1, number: '1.7', text: 'Does the TGS clearly define transition zones between tapers on multilane roads, are they compliant?' },
  { section: 1, number: '1.8', text: 'Does the TGS clearly define site access and egress for work vehicles, is impact to traffic managed?' },
  { section: 1, number: '1.9', text: 'Does the TGS consider cyclists, can cyclists transverse the site safely?' },
  { section: 1, number: '1.10', text: 'Does the TGS clearly define pedestrian routes, are the routes suitable for all pedestrians?' },
  { section: 2, number: '2.1', text: 'Are escape routes clearly defined on the TGS, clear and safe to use?' },
  { section: 2, number: '2.2', text: 'Is a PTCD used in place of a manual Traffic Controller where existing speed is greater than 45 km/h?' },
  { section: 2, number: '2.3', text: 'Are x4 Traffic Cones placed on the edge or centre line, approaching the Traffic Controller or PTCD?' },
  { section: 2, number: '2.4', text: 'Do Traffic Control and PTCD positions have adequate lighting during low light conditions?' },
  { section: 2, number: '2.5', text: "Is 'Prepare to Stop' and Traffic Control or PTCD symbolic signs installed?" },
  { section: 2, number: '2.6', text: 'Does sight distance of at least 1.5D exist on approach to Traffic Control or PTCD?' },
  { section: 3, number: '3.1', text: 'Are detour signs located at decision points to clearly guide motorists through the detour?' },
  { section: 3, number: '3.2', text: 'Is access to local residences and businesses maintained?' },
  { section: 3, number: '3.3', text: 'Are detour routes suitable for all vehicle classes being detoured?' },
  { section: 3, number: '3.4', text: 'Is the same level of safety maintained for turn movements (e.g. traffic using signalised intersections)?' },
  { section: 3, number: '3.5', text: 'Are detour signs located at decision points to clearly guide motorists through the detour?' },
];

const RATING_OPTIONS = ['Low', 'Medium', 'High', 'Extreme'];

// SCHEMA — responses_json shape produced by views/risk-assessments/fill-tgs.ejs:
// {
//   site: { road, from_side_st, to_side_st, suburb, direction, posted_speed,
//           client_principal, road_authority, scope_of_works,
//           tgs_design_no, design_date, estimated_duration },
//   options: { method_selected: 'around'|'past'|'through', method_reason: '' },
//   shuttle_applies: bool, detour_applies: bool,
//   answers: { '1.1': { yn: 'yes'|'no', desc: '', rating: '' }, ... '3.5': {...} },
//   section4: [ { question, yn, desc, rating }, ... ],   // user-defined rows
//   risk_management: [ { hazard, controls, remaining } , ... ],
//   additional_comments: '',
//   sign_off: { author: { name, pwz, date }, approver: { name, pwz, date },
//               one_up: { name, pwz, accreditation, date }, tgs_ref_no: '' }
// }

const MATRIX_HEADERS = ['', '1 Insignificant', '2 Minor', '3 Major', '4 Severe', '5 Catastrophic'];
const MATRIX_ROWS = [
  ['A. Almost Certain', 'Medium (1A)', 'High (2A)',   'Extreme (3A)', 'Extreme (4A)', 'Extreme (5A)'],
  ['B. Likely',         'Medium (1B)', 'High (2B)',   'High (3B)',    'Extreme (4B)', 'Extreme (5B)'],
  ['C. Possible',       'Low (1C)',    'Medium (2C)', 'High (3C)',    'High (4C)',    'Extreme (5C)'],
  ['D. Unlikely',       'Low (1D)',    'Low (2D)',    'Medium (3D)',  'High (4D)',    'High (5D)'],
  ['E. Rare',           'Low (1E)',    'Low (2D)',    'Low (3E)',     'Medium (4E)',  'High (5E)'],
];

const ACTION_LEVELS = [
  { rating: 4, label: 'Extreme', text: 'URGENT — Stop work immediately. Risk requires immediate attention.' },
  { rating: 3, label: 'High',    text: 'Continue with supervision and control measures in SWMS or site risk assessment.' },
  { rating: 2, label: 'Medium',  text: 'Use control measures to ensure risk is as low as reasonably practicable.' },
  { rating: 1, label: 'Low',     text: 'Manage by routine procedures and safe practices.' },
];

// Render the filled assessment as a Buffer. Layout: A4 portrait, narrow
// margins to mirror the docx. Tables drawn as bordered boxes with cell
// padding; ☐ / ☒ characters used for checkboxes (default font supports them).
function renderTgsRiskOptionsPdf({ ra, sub, parent, job, responses }) {
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

      const pageW = doc.page.width;
      const left = doc.page.margins.left;
      const right = pageW - doc.page.margins.right;
      const usable = right - left;

      // Header — brand band
      doc.rect(left, doc.y, usable, 50).fillAndStroke('#1D6AE5', '#1D6AE5');
      doc.fillColor('white').font('Helvetica-Bold').fontSize(14)
        .text('T&S Traffic Control', left + 12, doc.y - 42, { width: usable - 24 });
      doc.font('Helvetica').fontSize(9).text('ABN 58 655 958 320', { width: usable - 24 });
      doc.font('Helvetica-Bold').fontSize(11)
        .text('Traffic Guidance Scheme — Risk & Options Assessment', left + 12, doc.y + 2, { width: usable - 24 });
      doc.fillColor('black');
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(8).fillColor('#666')
        .text(`Doc No: TSROA-001    Rev: A    Plan #${parent && parent.plan_number || ''}    Ref: ${sub && sub.reference_number || ''}    Generated: ${new Date().toISOString().slice(0, 10)}`,
              left, doc.y, { width: usable, align: 'right' });
      doc.fillColor('black');
      doc.moveDown(0.8);

      // Section heading helper
      const sectionHeading = (text) => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.moveDown(0.4);
        doc.rect(left, doc.y, usable, 18).fill('#E5EEFB');
        doc.fillColor('#1D6AE5').font('Helvetica-Bold').fontSize(11).text(text, left + 8, doc.y - 14, { width: usable - 16 });
        doc.fillColor('black').font('Helvetica');
        doc.moveDown(0.6);
      };

      // Two-column site location grid
      sectionHeading('Site Location Details');
      const siteFields = [
        ['Road', site.road], ['Suburb', site.suburb],
        ['From Side St', site.from_side_st], ['To Side St', site.to_side_st],
        ['Direction', site.direction ? site.direction.toUpperCase() : ''], ['Posted Speed', site.posted_speed ? site.posted_speed + ' km/h' : ''],
        ['Client / Principal', site.client_principal], ['Road Authority', site.road_authority],
        ['TGS Design No', site.tgs_design_no], ['Design Date', site.design_date],
        ['Estimated Duration', site.estimated_duration], ['Scope of Works', site.scope_of_works],
      ];
      const colW = usable / 2;
      let yStart = doc.y;
      siteFields.forEach((pair, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const x = left + col * colW;
        const y = yStart + row * 22;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text(pair[0].toUpperCase(), x + 4, y, { width: colW - 8 });
        doc.font('Helvetica').fontSize(10).fillColor('black').text(pair[1] || '—', x + 4, y + 9, { width: colW - 8 });
      });
      doc.y = yStart + Math.ceil(siteFields.length / 2) * 22 + 4;

      // Options Assessment
      sectionHeading('Options Assessment');
      const method = opts.method_selected || '';
      doc.font('Helvetica').fontSize(10);
      const mk = (label, val) => (method === val ? '☒ ' : '☐ ') + label;
      doc.text('Method Selected:   ' + mk('Around', 'around') + '     ' + mk('Past', 'past') + '     ' + mk('Through', 'through'),
               left, doc.y, { width: usable });
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#555').text('REASON FOR METHOD SELECTED', left, doc.y);
      doc.font('Helvetica').fontSize(10).fillColor('black').text(opts.method_reason || '—', left, doc.y + 2, { width: usable });
      doc.moveDown(0.5);

      // Risk-question table renderer
      const drawQuestionTable = (sectionLabel, rows, opts2 = {}) => {
        sectionHeading(sectionLabel);
        if (opts2.note) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666').text(opts2.note, left, doc.y, { width: usable });
          doc.fillColor('black').moveDown(0.3);
        }
        const colNo = 28, colYN = 30, colRate = 56;
        const colQ = usable - colNo - colYN - colYN - colRate - 100;
        const colDesc = 100;
        // header row
        const headerY = doc.y;
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#333');
        const headers = ['#', 'Question', 'Yes', 'No', 'Description of Risks (if No)', 'Rating'];
        const widths = [colNo, colQ, colYN, colYN, colDesc, colRate];
        let xCur = left;
        doc.rect(left, headerY, usable, 16).fill('#F1F4FA').stroke('#D0D7E2');
        widths.forEach((w, i) => { doc.fillColor('#333').text(headers[i], xCur + 4, headerY + 4, { width: w - 8 }); xCur += w; });
        let y = headerY + 16;
        doc.fillColor('black').font('Helvetica').fontSize(9);
        rows.forEach((row) => {
          // estimate row height by wrapping the question text
          const qH = doc.heightOfString(row.text, { width: colQ - 8 });
          const dH = doc.heightOfString(row.desc || '—', { width: colDesc - 8 });
          const rowH = Math.max(18, qH + 4, dH + 4);
          if (y + rowH > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          doc.rect(left, y, usable, rowH).stroke('#D0D7E2');
          let cx = left;
          doc.text(row.number, cx + 4, y + 4, { width: colNo - 8 }); cx += colNo;
          doc.text(row.text, cx + 4, y + 4, { width: colQ - 8 }); cx += colQ;
          doc.text(row.yn === 'yes' ? '☒' : '☐', cx + 8, y + 4); cx += colYN;
          doc.text(row.yn === 'no' ? '☒' : '☐', cx + 8, y + 4); cx += colYN;
          doc.text(row.desc || '—', cx + 4, y + 4, { width: colDesc - 8 }); cx += colDesc;
          doc.text(row.rating || '—', cx + 4, y + 4, { width: colRate - 8 });
          y += rowH;
        });
        doc.y = y + 4;
      };

      const ans = (q) => Object.assign({}, q, answers[q.number] || {});
      drawQuestionTable('Risk Assessment — Section 1: General', QUESTIONS.filter(q => q.section === 1).map(ans));
      if (r.shuttle_applies) {
        drawQuestionTable('Section 2 — Shuttle Flow', QUESTIONS.filter(q => q.section === 2).map(ans));
      } else {
        sectionHeading('Section 2 — Shuttle Flow');
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666').text('Not applicable — Scope of Works does not involve shuttle flow.', left, doc.y, { width: usable });
        doc.fillColor('black');
      }
      if (r.detour_applies) {
        drawQuestionTable('Section 3 — Detours', QUESTIONS.filter(q => q.section === 3).map(ans));
      } else {
        sectionHeading('Section 3 — Detours');
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666').text('Not applicable — TGS does not involve detours.', left, doc.y, { width: usable });
        doc.fillColor('black');
      }
      if (section4.length > 0) {
        drawQuestionTable('Section 4 — Other Hazards & Risks', section4.map((row, i) => ({
          number: '4.' + (i + 1), text: row.question || '—', yn: row.yn, desc: row.desc, rating: row.rating
        })));
      }

      // Risk management table
      sectionHeading('Risk Management');
      doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666')
        .text('Any risks identified during the above assessment must be controlled below. Control measures must meet the WHS Risk Management Hierarchy of Controls (Eliminate → Substitute → Engineering → Administrative → PPE).',
              left, doc.y, { width: usable });
      doc.fillColor('black').moveDown(0.3);
      if (riskMgmt.length === 0) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor('#666').text('No risk-management entries recorded.', left, doc.y);
        doc.fillColor('black').moveDown(0.5);
      } else {
        const wItem = 30, wRating = 80;
        const wHazard = (usable - wItem - wRating) / 2;
        const wCtrl = wHazard;
        const headerY = doc.y;
        doc.rect(left, headerY, usable, 16).fill('#F1F4FA').stroke('#D0D7E2');
        doc.font('Helvetica-Bold').fontSize(8).fillColor('#333');
        doc.text('Item', left + 4, headerY + 4, { width: wItem - 8 });
        doc.text('Hazard / Risk', left + wItem + 4, headerY + 4, { width: wHazard - 8 });
        doc.text('Control Measures', left + wItem + wHazard + 4, headerY + 4, { width: wCtrl - 8 });
        doc.text('Remaining Risk Rating', left + wItem + wHazard + wCtrl + 4, headerY + 4, { width: wRating - 8 });
        let y = headerY + 16;
        doc.font('Helvetica').fontSize(9).fillColor('black');
        riskMgmt.forEach((row, i) => {
          const hazH = doc.heightOfString(row.hazard || '—', { width: wHazard - 8 });
          const ctrlH = doc.heightOfString(row.controls || '—', { width: wCtrl - 8 });
          const rowH = Math.max(20, hazH + 6, ctrlH + 6);
          if (y + rowH > doc.page.height - 60) { doc.addPage(); y = doc.page.margins.top; }
          doc.rect(left, y, usable, rowH).stroke('#D0D7E2');
          doc.text(String(i + 1), left + 4, y + 4, { width: wItem - 8 });
          doc.text(row.hazard || '—', left + wItem + 4, y + 4, { width: wHazard - 8 });
          doc.text(row.controls || '—', left + wItem + wHazard + 4, y + 4, { width: wCtrl - 8 });
          doc.text(row.remaining || '—', left + wItem + wHazard + wCtrl + 4, y + 4, { width: wRating - 8 });
          y += rowH;
        });
        doc.y = y + 4;
      }

      // Risk rating matrix (static reference)
      sectionHeading('Risk Rating Matrix');
      const matrixCols = 6;
      const matrixColW = usable / matrixCols;
      const matrixY0 = doc.y;
      // header row
      doc.rect(left, matrixY0, usable, 16).fill('#F1F4FA').stroke('#D0D7E2');
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#333');
      MATRIX_HEADERS.forEach((h, i) => doc.text(h, left + i * matrixColW + 2, matrixY0 + 4, { width: matrixColW - 4 }));
      let my = matrixY0 + 16;
      doc.fillColor('black').font('Helvetica').fontSize(7);
      MATRIX_ROWS.forEach((row) => {
        doc.rect(left, my, usable, 18).stroke('#D0D7E2');
        row.forEach((cell, j) => {
          doc.font(j === 0 ? 'Helvetica-Bold' : 'Helvetica').text(cell, left + j * matrixColW + 2, my + 5, { width: matrixColW - 4 });
        });
        my += 18;
      });
      doc.y = my + 6;

      // Action levels reference
      sectionHeading('Residual Risk Action Levels');
      doc.font('Helvetica').fontSize(9);
      ACTION_LEVELS.forEach(lvl => {
        doc.font('Helvetica-Bold').text(`${lvl.rating} — ${lvl.label}`, left, doc.y, { continued: true });
        doc.font('Helvetica').text(`  ${lvl.text}`, { width: usable });
      });
      doc.moveDown(0.4);

      // Additional comments
      sectionHeading('Additional Comments');
      doc.font('Helvetica').fontSize(10).text(r.additional_comments || '—', left, doc.y, { width: usable });
      doc.moveDown(0.5);

      // Sign-off
      sectionHeading('Sign-Off');
      const drawSignBlock = (title, who) => {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text(title, left, doc.y, { width: usable });
        doc.font('Helvetica').fontSize(9).fillColor('black');
        doc.text(`Name: ${who.name || '________________'}    PWZ Lic No: ${who.pwz || '________'}    Date: ${who.date || '________'}`, left, doc.y + 2, { width: usable });
        doc.text('Signature: ' + '_'.repeat(80), left, doc.y + 4);
        doc.moveDown(0.4);
      };
      drawSignBlock('Author (Designer)', author);
      drawSignBlock('Approver', approver);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text(`TGS Ref No: ${signOff.tgs_ref_no || (sub && sub.reference_number) || ''}`, left, doc.y);
      doc.fillColor('black').moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#333').text('One-Up Manager', left, doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('black')
        .text(`Name: ${oneUp.name || '________________'}    Accreditation: ${oneUp.accreditation || '________'}    Date: ${oneUp.date || '________'}`, left, doc.y + 2, { width: usable });
      doc.text('Signature: ' + '_'.repeat(80), left, doc.y + 4);
      doc.moveDown(0.4);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#666')
        .text('One-Up Manager approval required where any residual risk is rated High (3) or Extreme (4).', left, doc.y, { width: usable });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  QUESTIONS,
  RATING_OPTIONS,
  MATRIX_HEADERS,
  MATRIX_ROWS,
  ACTION_LEVELS,
  renderTgsRiskOptionsPdf,
};
