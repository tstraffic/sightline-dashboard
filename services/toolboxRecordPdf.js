/**
 * Toolbox Talk Record PDF — renders a completed toolbox talk as the
 * controlled form TS-SAF-FRM-005 (sections 1–7, attendance signatures,
 * presenter sign-off). This is the client-facing evidence document:
 * after the talk is signed off, the office emails this PDF to the client
 * to show required safety changes were addressed.
 *
 * Worker + presenter signatures are stored as PNG data URLs
 * (toolbox_attendance.signature_data / toolbox_talks.presenter_signature_data)
 * and embedded as images. Workers who didn't attend are omitted, per the
 * paper form ("Workers who didn't attend don't sign on").
 */
const PDFDocument = require('pdfkit');
const { getDb } = require('../db/database');

const GRAY_DARK = '#1F2937';
const GRAY_MED  = '#4B5563';
const GRAY      = '#6B7280';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG   = '#F9FAFB';
const GREEN     = '#059669';
const AMBER     = '#D97706';
const BRAND     = '#1D6AE5';
const ML = 50, MR = 50, MT = 50, MB = 60;

const TALK_TYPE_LABELS = {
  pre_start: 'Pre-start',
  monthly: 'Scheduled monthly',
  post_incident: 'Post-incident debrief',
  sop_rollout: 'New SOP / SWMS rollout',
  seasonal: 'Seasonal / event-driven',
  other: 'Other',
};

function datePart(dt) {
  const s = String(dt || '').slice(0, 10);
  if (!s) return '—';
  try { return new Date(s + 'T00:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (e) { return s; }
}
function dateTimePart(dt) {
  if (!dt) return '—';
  const m = String(dt).match(/(\d{1,2}):(\d{2})/);
  return datePart(dt) + (m ? ` ${m[1].padStart(2, '0')}:${m[2]}` : '');
}
function sigBuffer(dataUrl) {
  if (!dataUrl || !/^data:image\/(png|jpe?g);base64,/.test(dataUrl)) return null;
  try { return Buffer.from(dataUrl.split(',')[1], 'base64'); } catch (e) { return null; }
}

/**
 * Generate the FRM-005 PDF for a toolbox talk. Returns a Promise of
 * { buffer, fileName }. Throws if the toolbox doesn't exist.
 */
function generateToolboxRecordPdf(toolboxId) {
  const db = getDb();
  const tb = db.prepare(`
    SELECT t.*, j.job_number, j.job_name,
           pu.full_name AS presenter_signed_by_name
    FROM toolbox_talks t
    LEFT JOIN jobs j ON j.id = t.job_id
    LEFT JOIN users pu ON pu.id = t.presenter_signed_by_id
    WHERE t.id = ?
  `).get(toolboxId);
  if (!tb) throw new Error('Toolbox talk not found.');

  const attendance = db.prepare(`
    SELECT a.*, cm.full_name, cm.employee_id
    FROM toolbox_attendance a
    JOIN crew_members cm ON cm.id = a.crew_member_id
    WHERE a.toolbox_id = ? AND a.status IN ('attended','caught_up')
    ORDER BY a.late_arrival ASC, cm.full_name
  `).all(toolboxId);
  const actions = db.prepare(`
    SELECT * FROM toolbox_actions WHERE toolbox_id = ? ORDER BY id ASC
  `).all(toolboxId);
  const notes = db.prepare(`
    SELECT n.*, u.full_name AS author_name
    FROM toolbox_supplementary_notes n
    LEFT JOIN users u ON u.id = n.created_by_id
    WHERE n.toolbox_id = ? ORDER BY n.id ASC
  `).all(toolboxId);

  const doc = new PDFDocument({ size: 'A4', margins: { top: MT, bottom: MB, left: ML, right: MR } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve({
      buffer: Buffer.concat(chunks),
      fileName: `TS-SAF-FRM-005-Toolbox-Talk-TBX-${tb.id}.pdf`,
    }));
    doc.on('error', reject);
  });

  const pageW = doc.page.width - ML - MR;
  let y = MT;

  const footer = () => {
    // Writing below the content area would trigger pdfkit's auto
    // page-break, which re-fires pageAdded -> footer -> infinite
    // recursion. Zero the bottom margin while the footer draws.
    const prevBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
      .text('TS-SAF-FRM-005  |  Toolbox Talk Record Form  |  Version 1.0  —  Uncontrolled when printed. Generated from Atomis.',
        ML, doc.page.height - 42, { width: pageW, align: 'center', lineBreak: false });
    doc.page.margins.bottom = prevBottom;
  };
  doc.on('pageAdded', () => { footer(); y = MT; });

  const ensure = (h) => {
    if (y + h > doc.page.height - MB - 20) { doc.addPage(); }
  };
  const sectionHeader = (label) => {
    ensure(34);
    doc.rect(ML, y, pageW, 20).fill(GRAY_BG);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY_DARK).text(label, ML + 8, y + 5.5, { lineBreak: false });
    y += 28;
  };
  const bodyText = (text, opts) => {
    const t = String(text || '').trim() || '—';
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY_DARK);
    const h = doc.heightOfString(t, { width: pageW - 8 });
    ensure(h + 10);
    doc.text(t, ML + 4, y, { width: pageW - 8, ...(opts || {}) });
    y = doc.y + 10;
  };

  // ===== Header =====
  doc.font('Helvetica-Bold').fontSize(13).fillColor(BRAND).text('T&S', ML, MT, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(18).fillColor(GRAY_DARK)
    .text('TOOLBOX TALK RECORD', ML, MT, { width: pageW, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(GRAY)
    .text('T&S Traffic Control Pty Ltd', ML, MT + 24, { width: pageW, align: 'right' })
    .text('TS-SAF-FRM-005  |  Toolbox Talk Record Form  |  Version 1.0', ML, doc.y, { width: pageW, align: 'right' })
    .text(`Atomis Record ID: TBX-${tb.id}`, ML, doc.y, { width: pageW, align: 'right' });
  y = MT + 64;
  doc.moveTo(ML, y).lineTo(ML + pageW, y).strokeColor(GRAY_LINE).lineWidth(1).stroke();
  y += 12;

  // ===== 1. Talk Details =====
  sectionHeader('1. Talk Details');
  const talkTypeLabel = tb.talk_type
    ? (tb.talk_type === 'other' && tb.talk_type_other
        ? `Other — ${tb.talk_type_other}`
        : TALK_TYPE_LABELS[tb.talk_type] || tb.talk_type)
    : '—';
  const jobLabel = tb.job_number ? `${tb.job_number}${tb.job_name ? ' — ' + tb.job_name : ''}` : '—';
  const details = [
    ['Date', datePart(tb.held_at)], ['Time', tb.talk_time || '—'],
    ['Site / Location', tb.site_location || '—'], ['Job / Project No.', jobLabel],
    ['Presenter', tb.presenter || '—'], ['Duration (mins)', tb.duration_mins ? String(tb.duration_mins) : '—'],
    ['Talk Type', talkTypeLabel], ['Topic Reference', tb.topic_reference || '—'],
  ];
  const halfW = pageW / 2;
  for (let i = 0; i < details.length; i += 2) {
    ensure(18);
    for (let k = 0; k < 2 && i + k < details.length; k++) {
      const [label, value] = details[i + k];
      const x = ML + k * halfW;
      doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED).text(label + ':', x + 4, y, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_DARK)
        .text(String(value), x + 110, y, { width: halfW - 118, lineBreak: false });
    }
    y += 16;
  }
  y += 6;

  // ===== 2. Topic =====
  sectionHeader('2. Topic');
  bodyText(tb.title);

  // ===== 3. Key Points Covered =====
  sectionHeader('3. Key Points Covered');
  bodyText(tb.key_points);

  // ===== 4. Questions / Discussion / Worker Input =====
  sectionHeader('4. Questions / Discussion / Worker Input');
  bodyText(tb.discussion_notes);

  // ===== 5. Actions Raised =====
  sectionHeader('5. Actions Raised');
  if (!actions.length) {
    bodyText('No actions raised.');
  } else {
    actions.forEach((a, i) => {
      const meta = [
        a.raised_by ? `Raised by: ${a.raised_by}` : null,
        a.linked_record ? `Logged as: ${a.linked_record}` : null,
        a.status === 'closed' ? `Closed ${dateTimePart(a.closed_at)}` : 'Open',
      ].filter(Boolean).join('  ·  ');
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY_DARK);
      const h = doc.heightOfString(`${i + 1}. ${a.description}`, { width: pageW - 8 }) + 12;
      ensure(h + 14);
      doc.text(`${i + 1}. ${a.description}`, ML + 4, y, { width: pageW - 8 });
      y = doc.y + 1;
      doc.font('Helvetica').fontSize(8).fillColor(a.status === 'closed' ? GREEN : AMBER)
        .text(meta, ML + 16, y, { width: pageW - 20 });
      y = doc.y + 8;
    });
    y += 2;
  }

  // ===== 6. Attendance / Sign-On =====
  sectionHeader('6. Attendance / Sign-On');
  const rowH = 36;
  const colName = 0.42, colStatus = 0.24;
  const drawAttHeader = () => {
    ensure(rowH);
    doc.rect(ML, y, pageW, 18).fill(GRAY_BG);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY_DARK);
    doc.text('Worker Name', ML + 4, y + 5, { lineBreak: false });
    doc.text('Attendance', ML + colName * pageW + 4, y + 5, { lineBreak: false });
    doc.text('Signature', ML + (colName + colStatus) * pageW + 4, y + 5, { lineBreak: false });
    y += 18;
  };
  if (!attendance.length) {
    bodyText('No attendance recorded.');
  } else {
    drawAttHeader();
    for (const a of attendance) {
      if (y + rowH > doc.page.height - MB - 20) { doc.addPage(); drawAttHeader(); }
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(GRAY_DARK)
        .text(a.full_name, ML + 4, y + 8, { width: colName * pageW - 8, lineBreak: false });
      if (a.employee_id) {
        doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
          .text(a.employee_id, ML + 4, y + 21, { lineBreak: false });
      }
      let statusLabel, statusColor;
      if (a.late_arrival) {
        statusLabel = 'Late' + (a.late_arrival_time ? ` — ${a.late_arrival_time}` : '');
        statusColor = AMBER;
      } else if (a.status === 'caught_up') {
        statusLabel = 'Caught up after talk';
        statusColor = AMBER;
      } else {
        statusLabel = 'Attended';
        statusColor = GREEN;
      }
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(statusColor)
        .text(statusLabel, ML + colName * pageW + 4, y + 8, { width: colStatus * pageW - 8, lineBreak: false });
      if (a.signed_off_at) {
        doc.font('Helvetica').fontSize(7).fillColor(GRAY)
          .text('Signed ' + dateTimePart(a.signed_off_at), ML + colName * pageW + 4, y + 20, { width: colStatus * pageW - 8, lineBreak: false });
      }
      const sig = sigBuffer(a.signature_data);
      const sigX = ML + (colName + colStatus) * pageW + 4;
      if (sig) {
        try { doc.image(sig, sigX, y + 3, { fit: [(1 - colName - colStatus) * pageW - 12, rowH - 6] }); }
        catch (e) {
          doc.font('Helvetica').fontSize(8).fillColor(GRAY).text('(signature on file)', sigX, y + 12, { lineBreak: false });
        }
      } else {
        doc.font('Helvetica').fontSize(8).fillColor(GRAY)
          .text(a.recorded_by_id ? 'Marked off by office' : '—', sigX, y + 12, { lineBreak: false });
      }
      y += rowH;
      doc.moveTo(ML, y).lineTo(ML + pageW, y).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    }
    y += 10;
  }

  // ===== 7. Presenter Sign-off & Atomis Record =====
  ensure(120);
  sectionHeader('7. Presenter Sign-off & Atomis Record');
  if (tb.presenter_signed_at) {
    const sig = sigBuffer(tb.presenter_signature_data);
    if (sig) {
      try { doc.image(sig, ML + 4, y, { fit: [200, 56] }); } catch (e) {}
    }
    doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED)
      .text('Presenter:', ML + 230, y + 4, { lineBreak: false })
      .font('Helvetica-Bold').fillColor(GRAY_DARK)
      .text(tb.presenter || tb.presenter_signed_by_name || '—', ML + 290, y + 4, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED)
      .text('Signed:', ML + 230, y + 20, { lineBreak: false })
      .font('Helvetica-Bold').fillColor(GRAY_DARK)
      .text(dateTimePart(tb.presenter_signed_at), ML + 290, y + 20, { lineBreak: false });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED)
      .text('Atomis Record ID:', ML + 230, y + 36, { lineBreak: false })
      .font('Helvetica-Bold').fillColor(GRAY_DARK)
      .text(`TBX-${tb.id}`, ML + 330, y + 36, { lineBreak: false });
    y += 64;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GREEN)
      .text('Record signed off and locked in Atomis. Attendance above is the audit evidence.', ML + 4, y, { width: pageW - 8 });
    y = doc.y + 8;
  } else {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(AMBER)
      .text('Not yet signed off by the presenter — draft record.', ML + 4, y, { width: pageW - 8 });
    y = doc.y + 8;
  }

  // ===== Supplementary notes (post-lock additions, per TS-SAF-WI-003) =====
  if (notes.length) {
    sectionHeader('Supplementary Notes');
    for (const n of notes) {
      doc.font('Helvetica').fontSize(9.5).fillColor(GRAY_DARK);
      const h = doc.heightOfString(n.note, { width: pageW - 8 }) + 14;
      ensure(h);
      doc.text(n.note, ML + 4, y, { width: pageW - 8 });
      y = doc.y + 1;
      doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
        .text(`${n.author_name || 'Office'} · ${dateTimePart(n.created_at)}`, ML + 4, y, { lineBreak: false });
      y += 16;
    }
  }

  doc.font('Helvetica').fontSize(8).fillColor(GRAY)
    .text(`Generated ${dateTimePart(new Date().toISOString())} — End of Form TS-SAF-FRM-005`, ML, y + 6, { width: pageW });

  footer();
  doc.end();
  return done;
}

module.exports = { generateToolboxRecordPdf, TALK_TYPE_LABELS };
