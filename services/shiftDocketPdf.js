// Branded PDF renderer for a signed SHIFT docket (docket_signatures +
// docket_crew). One docket covers a whole shift's crew. Output is a clean
// single-purpose works docket: T&S header, job / date / sign-off band,
// per-crew hours table with a man-hours total, then the worker + client
// signatures. No checklist-completion stats — a docket is the hours +
// sign-off record, nothing else.
//
// Usage:
//   const buf = await renderShiftDocketPdf(db, docketId);
//   res.type('application/pdf').send(buf);

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getDocketCrew } = require('../lib/shiftDocket');

const BRAND = '#1D6AE5';
const GRAY_DARK = '#1F2937';
const GRAY_MED = '#4B5563';
const GRAY = '#6B7280';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG = '#F9FAFB';
const GREEN = '#059669';
const AMBER = '#D97706';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 40, MR = 40, MT = 40, MB = 50;

function fmtDateTime(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return String(s); }
}
function fmtDate(s) {
  if (!s) return '—';
  const d = String(s).slice(0, 10);
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (e) { return d; }
}
function dataUrlToBuffer(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_) { return null; }
}

// Load the docket header with its job/booking context (mirrors the joins in
// routes/dockets-admin.loadDocket so this works standalone).
function loadDocket(db, id) {
  return db.prepare(`
    SELECT ds.*,
      signer.full_name AS signer_name,
      COALESCE(ds.shift_date, ca.allocation_date) AS allocation_date,
      COALESCE(sj.job_number, j.job_number, b.booking_number) AS job_number,
      COALESCE(sj.client, j.client, b.title) AS job_client,
      COALESCE(sj.job_name, j.job_name) AS job_name,
      COALESCE(sj.site_address, j.site_address, b.site_address) AS site_address
    FROM docket_signatures ds
    LEFT JOIN crew_allocations ca ON ds.allocation_id = ca.id
    LEFT JOIN jobs sj            ON ds.shift_job_id = sj.id
    LEFT JOIN jobs j             ON ca.job_id = j.id
    LEFT JOIN bookings b         ON ds.booking_id = b.id
    LEFT JOIN crew_members signer ON COALESCE(ds.signed_by_crew_id, ds.crew_member_id) = signer.id
    WHERE ds.id = ?
  `).get(id);
}

function renderShiftDocketPdf(db, docketId) {
  const docket = loadDocket(db, docketId);
  if (!docket) throw new Error('Docket not found.');
  const crew = getDocketCrew(db, docket);

  const doc = new PDFDocument({ size: 'A4', margins: { top: MT, bottom: MB, left: ML, right: MR } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageW = doc.page.width - ML - MR;

  // ── Header ───────────────────────────────────────────────────
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { width: 70 }); } catch (_) {}
  }
  doc.fillColor(GRAY_DARK).font('Helvetica-Bold').fontSize(20)
    .text('WORKS DOCKET', ML + 90, MT + 4, { width: pageW - 90, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(GRAY_MED)
    .text('T&S Traffic Control PTY LTD.', ML + 90, MT + 30, { align: 'right' })
    .text('9 Epic Pl, Villawood, NSW 2163', { align: 'right' })
    .text('ABN 58 655 958 320  ·  E admin@tstc.com.au  ·  P 1300 00 8782', { align: 'right' });
  doc.moveTo(ML, MT + 78).lineTo(doc.page.width - MR, MT + 78).strokeColor(BRAND).lineWidth(1.5).stroke();
  doc.y = MT + 90;

  // ── Info band: Job / Date / Signed by / Client ───────────────
  const cols = 4;
  const colW = pageW / cols;
  const bandY = doc.y;
  const headers = ['Job / Booking', 'Shift date', 'Signed by', 'Client'];
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_DARK);
  headers.forEach((h, i) => doc.text(h, ML + colW * i + 6, bandY + 4, { width: colW - 12 }));

  const jobLines = [];
  if (docket.job_client) jobLines.push(docket.job_client);
  if (docket.job_number) jobLines.push(docket.job_number);
  if (docket.site_address) jobLines.push(docket.site_address);
  const clientVal = docket.no_client_on_site
    ? ('No client on site' + (docket.no_client_reason ? '\n' + docket.no_client_reason : ''))
    : (docket.client_name || docket.client_signed_name || '—');

  doc.font('Helvetica').fontSize(9).fillColor(GRAY_DARK);
  const valY = bandY + 18;
  doc.text(jobLines.join('\n') || '—', ML + 6, valY, { width: colW - 12 });
  doc.text(fmtDate(docket.allocation_date), ML + colW + 6, valY, { width: colW - 12 });
  doc.text(docket.signer_name || '—', ML + colW * 2 + 6, valY, { width: colW - 12 });
  doc.text(clientVal, ML + colW * 3 + 6, valY, { width: colW - 12 });

  const bandH = Math.max(64, doc.y - bandY + 8);
  doc.rect(ML, bandY - 2, pageW, bandH).strokeColor(GRAY_LINE).lineWidth(0.6).stroke();
  doc.y = bandY + bandH + 6;

  // Signed-at line
  if (docket.signed_at) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GREEN)
      .text('Signed ' + fmtDateTime(docket.signed_at) + (docket.source === 'admin' ? '  ·  Office-adjusted (v' + (docket.version || 1) + ')' : ''), ML, doc.y);
    doc.y += 6;
  }

  // ── Crew & hours table ───────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(11).fillColor(GRAY_DARK).text('Crew & Hours', ML, doc.y + 4);
  doc.y += 4;

  const tcols = [
    { label: 'Crew member', w: 0.30, align: 'left' },
    { label: 'Role', w: 0.18, align: 'left' },
    { label: 'Start', w: 0.10, align: 'right' },
    { label: 'Finish', w: 0.10, align: 'right' },
    { label: 'Break', w: 0.10, align: 'right' },
    { label: 'Travel', w: 0.10, align: 'right' },
    { label: 'Total hrs', w: 0.12, align: 'right' },
  ];
  const rowH = 20;
  let y = doc.y + 4;
  const drawRow = (cells, opts) => {
    const { bold, bg } = opts || {};
    if (y > doc.page.height - MB - 120) { doc.addPage(); y = MT; }
    if (bg) doc.rect(ML, y, pageW, rowH).fill(bg);
    let x = ML;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? GRAY_DARK : GRAY_MED);
    cells.forEach((c, i) => {
      const w = tcols[i].w * pageW;
      doc.text(String(c), x + 4, y + 6, { width: w - 8, align: tcols[i].align, lineBreak: false });
      x += w;
    });
    y += rowH;
    doc.moveTo(ML, y).lineTo(ML + pageW, y).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
  };

  drawRow(tcols.map(c => c.label), { bold: true, bg: GRAY_BG });
  let totalHours = 0;
  if (!crew.length) {
    doc.font('Helvetica').fontSize(9).fillColor(GRAY).text('No crew recorded on this docket.', ML + 4, y + 6);
    y += rowH;
  }
  for (const c of crew) {
    const hrs = Number(c.total_hours) || 0;
    totalHours += hrs;
    drawRow([
      c.name || '—',
      c.role || 'TC',
      c.start_on_site || '—',
      c.finish_on_site || '—',
      (Number(c.break_minutes) || 0) + 'm',
      (Number(c.travel_hours) || 0).toFixed(2),
      hrs.toFixed(2),
    ]);
  }
  drawRow(['Total man-hours', '', '', '', '', '', totalHours.toFixed(2)], { bold: true, bg: GRAY_BG });
  doc.y = y + 14;

  // ── Notes ────────────────────────────────────────────────────
  if (docket.notes) {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY_DARK).text('Notes', ML, doc.y);
    doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED).text(docket.notes, ML, doc.y + 2, { width: pageW });
    doc.y += 8;
  }

  // ── Signatures ───────────────────────────────────────────────
  if (doc.y > doc.page.height - MB - 150) doc.addPage();
  const sigY = doc.y + 10;
  const sigBoxW = (pageW - 20) / 2;
  const sigBoxH = 90;
  const workerSig = dataUrlToBuffer(docket.signature_data);
  const clientSig = dataUrlToBuffer(docket.client_signature);

  const drawSig = (x, label, buf, captionName) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_MED).text(label, x, sigY);
    doc.rect(x, sigY + 12, sigBoxW, sigBoxH).strokeColor(GRAY_LINE).lineWidth(0.6).stroke();
    if (buf) {
      try { doc.image(buf, x + 6, sigY + 18, { fit: [sigBoxW - 12, sigBoxH - 28] }); } catch (_) {}
    }
    if (captionName) {
      doc.font('Helvetica').fontSize(8).fillColor(GRAY).text(captionName, x, sigY + 12 + sigBoxH + 4, { width: sigBoxW });
    }
  };
  drawSig(ML, 'Worker signature', workerSig, docket.signer_name || '');
  if (docket.no_client_on_site) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_MED).text('Client signature', ML + sigBoxW + 20, sigY);
    doc.rect(ML + sigBoxW + 20, sigY + 12, sigBoxW, sigBoxH).strokeColor(GRAY_LINE).lineWidth(0.6).stroke();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(AMBER).text('No client on site', ML + sigBoxW + 26, sigY + 18, { width: sigBoxW - 12 });
    if (docket.no_client_reason) doc.font('Helvetica').fontSize(8).fillColor(GRAY_MED).text(docket.no_client_reason, ML + sigBoxW + 26, doc.y + 2, { width: sigBoxW - 12 });
  } else {
    drawSig(ML + sigBoxW + 20, 'Client signature', clientSig, docket.client_signed_name || docket.client_name || '');
  }

  // ── Footer ───────────────────────────────────────────────────
  doc.font('Helvetica').fontSize(7.5).fillColor(GRAY)
    .text('Generated from Atomis · ' + fmtDateTime(new Date().toISOString()), ML, doc.page.height - MB + 6, { width: pageW, align: 'center' });

  doc.end();
  return done;
}

module.exports = { renderShiftDocketPdf };
