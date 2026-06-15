// Branded PDF renderer for a signed SHIFT docket. One docket per shift,
// covering the whole crew. Output is a single-purpose Works Docket:
//
//   • T&S logo + brand header
//   • Hero docket-number block (prominent, unambiguous)
//   • Status pill (current / superseded · v1, v2, …)
//   • Job & shift info card  (two columns, generous whitespace)
//   • Sign-off card           (signer + signed at + client rep)
//   • Crew & hours table      (zebra rows, clear totals footer)
//   • Notes                   (only when present)
//   • Signature panels        (worker + client side by side, named)
//   • Footer line             (page numbers, generated-at stamp)
//
// Pure hours + sign-off record. No checklist stats appear anywhere.

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getDocketCrew } = require('./../lib/shiftDocket');

// ── Brand palette ─────────────────────────────────────────────
const BRAND      = '#1D6AE5';
const BRAND_DARK = '#0F47A8';
const GRAY_DARK  = '#0F172A';
const GRAY_MED   = '#475569';
const GRAY       = '#64748B';
const GRAY_SOFT  = '#94A3B8';
const GRAY_LINE  = '#E2E8F0';
const GRAY_BG    = '#F8FAFC';
const GRAY_BG_2  = '#F1F5F9';
const GREEN      = '#047857';
const GREEN_BG   = '#ECFDF5';
const AMBER      = '#B45309';
const AMBER_BG   = '#FFFBEB';
const GRAY_PILL  = '#E2E8F0';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');

// Page geometry — bigger margins than the first cut so nothing feels crammed
// against the edges. Letter-spacing and line gaps are tuned for an A4 print.
const ML = 48, MR = 48, MT = 48, MB = 64;

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
  try { return new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch (e) { return d; }
}
function dataUrlToBuffer(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_) { return null; }
}

function loadDocket(db, id) {
  return db.prepare(`
    SELECT ds.*,
      signer.full_name AS signer_name,
      COALESCE(ds.shift_date, ca.allocation_date) AS allocation_date,
      COALESCE(sj.job_number, j.job_number, b.booking_number) AS job_number,
      COALESCE(sj.client, j.client, b.title) AS job_client,
      COALESCE(sj.job_name, j.job_name) AS job_name,
      COALESCE(sj.site_address, j.site_address, b.site_address) AS site_address,
      COALESCE(sj.suburb, j.suburb, b.suburb) AS suburb,
      COALESCE(b.booking_number) AS booking_number
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

  const doc = new PDFDocument({ size: 'A4', margins: { top: MT, bottom: MB, left: ML, right: MR }, bufferPages: true, info: {
    Title: 'Works Docket ' + (docket.docket_number || ('#' + docket.id)),
    Author: 'T&S Traffic Control',
  } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const pageW = doc.page.width - ML - MR;

  // ── Header ───────────────────────────────────────────────────
  drawHeader(doc, pageW);
  doc.y = MT + 78;

  // ── Hero docket-number block ────────────────────────────────
  drawHero(doc, pageW, docket);

  // ── Job & shift info card ───────────────────────────────────
  drawInfoCard(doc, pageW, docket);

  // ── Sign-off card ───────────────────────────────────────────
  drawSignOff(doc, pageW, docket);

  // ── Crew & hours table ──────────────────────────────────────
  drawCrewTable(doc, pageW, crew);

  // ── Notes ───────────────────────────────────────────────────
  if (docket.notes) drawNotes(doc, pageW, docket.notes);

  // ── Signature panels ────────────────────────────────────────
  drawSignatures(doc, pageW, docket);

  // ── Footer on every page ────────────────────────────────────
  drawFooters(doc, pageW, docket);

  doc.end();
  return done;
}

// ─── Components ─────────────────────────────────────────────────

function drawHeader(doc, pageW) {
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { width: 78 }); } catch (_) {}
  }
  doc.fillColor(GRAY_DARK).font('Helvetica-Bold').fontSize(22)
    .text('WORKS DOCKET', ML + 100, MT + 6, { width: pageW - 100, align: 'right' });
  doc.font('Helvetica').fontSize(8.5).fillColor(GRAY_MED)
    .text('T&S Traffic Control PTY LTD', ML + 100, MT + 34, { align: 'right' })
    .text('9 Epic Pl, Villawood, NSW 2163', { align: 'right' })
    .text('ABN 58 655 958 320 · admin@tstc.com.au · 1300 00 8782', { align: 'right' });
  // Brand divider
  doc.moveTo(ML, MT + 70).lineTo(doc.page.width - MR, MT + 70).strokeColor(BRAND).lineWidth(2).stroke();
}

function drawHero(doc, pageW, docket) {
  const y0 = doc.y + 8;
  const number = docket.docket_number || ('TS-DK-' + String(docket.id).padStart(5, '0'));
  // Big number — left side
  doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY).text('DOCKET NUMBER', ML, y0, { characterSpacing: 1 });
  doc.font('Helvetica-Bold').fontSize(26).fillColor(BRAND_DARK)
    .text(number, ML, y0 + 14, { lineBreak: false });

  // Status pill — right side
  const status = (docket.status || 'current').toLowerCase();
  const isCurrent = status === 'current';
  const versionLabel = 'v' + (docket.version || 1);
  const sourceLabel = (docket.source === 'admin') ? 'OFFICE EDITED' : 'WORKER SIGNED';

  drawPill(doc, isCurrent ? 'CURRENT' : 'SUPERSEDED',
    isCurrent ? GREEN_BG : GRAY_BG_2,
    isCurrent ? GREEN    : GRAY_MED,
    doc.page.width - MR, y0, 'right');
  drawPill(doc, versionLabel, GRAY_BG_2, GRAY_MED, doc.page.width - MR - 90, y0, 'right');
  drawPill(doc, sourceLabel,
    docket.source === 'admin' ? AMBER_BG : '#EFF6FF',
    docket.source === 'admin' ? AMBER : BRAND_DARK,
    doc.page.width - MR, y0 + 22, 'right');

  doc.y = y0 + 50;
}

function drawPill(doc, label, bg, fg, anchorX, y, align) {
  doc.font('Helvetica-Bold').fontSize(8);
  const padX = 8;
  const w = doc.widthOfString(label) + padX * 2;
  const h = 16;
  const x = align === 'right' ? anchorX - w : anchorX;
  doc.roundedRect(x, y, w, h, 8).fill(bg);
  doc.fillColor(fg).text(label, x, y + 4, { width: w, align: 'center', lineBreak: false });
  doc.fillColor(GRAY_DARK);
}

function drawInfoCard(doc, pageW, docket) {
  const y0 = doc.y + 4;
  const cardH = 96;
  // Card background + border (fillAndStroke uses the current lineWidth, so set
  // it first; pdfkit consumes the path on the first paint op so a separate
  // .stroke() after .fill() would no-op).
  doc.lineWidth(0.6).roundedRect(ML, y0, pageW, cardH, 8).fillAndStroke(GRAY_BG, GRAY_LINE);
  // Section heading bar
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND_DARK).text('JOB & SHIFT', ML + 14, y0 + 10, { characterSpacing: 1 });

  // Two-column grid
  const colX1 = ML + 14;
  const colX2 = ML + pageW / 2 + 6;
  const rowY  = y0 + 28;
  const rowH  = 22;

  field(doc, colX1, rowY,            'Client',    docket.job_client || '—');
  field(doc, colX2, rowY,            'Job / Ref', docket.job_number || docket.booking_number || '—');
  field(doc, colX1, rowY + rowH,     'Site',      [docket.site_address, docket.suburb].filter(Boolean).join(', ') || '—');
  field(doc, colX2, rowY + rowH,     'Shift date', fmtDate(docket.allocation_date));
  doc.y = y0 + cardH + 10;
}

function field(doc, x, y, label, value) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(GRAY).text(label.toUpperCase(), x, y, { characterSpacing: 0.8 });
  doc.font('Helvetica').fontSize(10).fillColor(GRAY_DARK).text(String(value || '—'), x, y + 10, { width: 240, lineBreak: false, ellipsis: true });
}

function drawSignOff(doc, pageW, docket) {
  const y0 = doc.y;
  const cardH = 70;
  doc.lineWidth(0.6).roundedRect(ML, y0, pageW, cardH, 8).fillAndStroke(GRAY_BG, GRAY_LINE);
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND_DARK).text('SIGN-OFF', ML + 14, y0 + 10, { characterSpacing: 1 });

  const colX1 = ML + 14;
  const colX2 = ML + pageW / 3 + 8;
  const colX3 = ML + (pageW / 3) * 2 + 8;
  const rowY  = y0 + 28;
  field(doc, colX1, rowY, 'Signed by',    docket.signer_name || '—');
  field(doc, colX2, rowY, 'Signed at',    docket.signed_at ? fmtDateTime(docket.signed_at) : '—');
  if (docket.no_client_on_site) {
    field(doc, colX3, rowY, 'Client rep', 'No client on site');
    if (docket.no_client_reason) {
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(GRAY).text(docket.no_client_reason, colX3, rowY + 22, { width: pageW - (colX3 - ML) - 14, lineBreak: false, ellipsis: true });
    }
  } else {
    field(doc, colX3, rowY, 'Client rep', docket.client_name || docket.client_signed_name || '—');
  }
  doc.y = y0 + cardH + 14;
}

function drawCrewTable(doc, pageW, crew) {
  const startY = doc.y;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(GRAY_DARK).text('Crew & Hours', ML, startY);
  doc.y = startY + 20;

  const cols = [
    { label: 'Crew member', w: 0.32, align: 'left' },
    { label: 'Role',        w: 0.18, align: 'left' },
    { label: 'Start',       w: 0.10, align: 'right' },
    { label: 'Finish',      w: 0.10, align: 'right' },
    { label: 'Break',       w: 0.08, align: 'right' },
    { label: 'Travel',      w: 0.10, align: 'right' },
    { label: 'Total hrs',   w: 0.12, align: 'right' },
  ];
  const rowH = 24;
  const headerH = 22;
  let y = doc.y;

  // Header
  doc.roundedRect(ML, y, pageW, headerH, 4).fill(GRAY_BG_2);
  let x = ML;
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY_DARK);
  cols.forEach(c => {
    const w = c.w * pageW;
    doc.text(c.label.toUpperCase(), x + 8, y + 7, { width: w - 16, align: c.align, lineBreak: false, characterSpacing: 0.6 });
    x += w;
  });
  y += headerH + 2;

  // Body
  let totalHours = 0;
  if (!crew.length) {
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(GRAY).text('No crew recorded on this docket.', ML + 8, y + 6);
    y += rowH;
  }
  crew.forEach((c, i) => {
    if (y > doc.page.height - MB - 180) { doc.addPage(); y = MT; }
    // Zebra
    if (i % 2 === 1) doc.rect(ML, y, pageW, rowH).fill(GRAY_BG);
    const hrs = Number(c.total_hours) || 0;
    totalHours += hrs;
    const vals = [
      c.name || '—',
      c.role || 'TC',
      c.start_on_site || '—',
      c.finish_on_site || '—',
      (Number(c.break_minutes) || 0) + 'm',
      (Number(c.travel_hours) || 0).toFixed(2),
      hrs.toFixed(2),
    ];
    x = ML;
    doc.font('Helvetica').fontSize(9.5).fillColor(GRAY_DARK);
    vals.forEach((v, idx) => {
      const w = cols[idx].w * pageW;
      doc.font(idx === 0 ? 'Helvetica-Bold' : 'Helvetica');
      doc.fillColor(idx === 6 ? BRAND_DARK : GRAY_DARK);
      doc.text(String(v), x + 8, y + 8, { width: w - 16, align: cols[idx].align, lineBreak: false, ellipsis: true });
      x += w;
    });
    y += rowH;
    doc.moveTo(ML + 4, y).lineTo(ML + pageW - 4, y).strokeColor(GRAY_LINE).lineWidth(0.4).stroke();
  });

  // Totals footer — tinted brand strip
  doc.rect(ML, y + 4, pageW, rowH + 2).fill('#EFF6FF');
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND_DARK)
    .text('TOTAL MAN-HOURS', ML + 8, y + 13, { lineBreak: false, characterSpacing: 0.5 });
  doc.text(totalHours.toFixed(2), ML, y + 13, { width: pageW - 16, align: 'right', lineBreak: false });
  doc.y = y + rowH + 14;
}

function drawNotes(doc, pageW, notes) {
  // Page break if not enough room left for notes + signatures.
  if (doc.y > doc.page.height - MB - 220) doc.addPage();
  const y0 = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY_DARK).text('Notes', ML, y0);
  doc.y = y0 + 16;
  doc.font('Helvetica').fontSize(9.5).fillColor(GRAY_MED).text(notes, ML, doc.y, { width: pageW, align: 'left', lineGap: 2 });
  doc.y += 10;
}

function drawSignatures(doc, pageW, docket) {
  // Always keep signatures together on one page.
  const need = 160;
  if (doc.y > doc.page.height - MB - need) doc.addPage();
  const y0 = doc.y + 4;

  const gap = 18;
  const boxW = (pageW - gap) / 2;
  const boxH = 120;

  const drawBox = (x, label, dataUrl, captionName) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND_DARK).text(label.toUpperCase(), x, y0, { characterSpacing: 1 });
    doc.lineWidth(0.8).strokeColor(GRAY_LINE).roundedRect(x, y0 + 14, boxW, boxH, 6).stroke();
    const buf = dataUrlToBuffer(dataUrl);
    if (buf) {
      try { doc.image(buf, x + 10, y0 + 24, { fit: [boxW - 20, boxH - 36] }); } catch (_) {}
    } else {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(GRAY_SOFT)
        .text('— no signature captured —', x, y0 + 14 + boxH / 2 - 5, { width: boxW, align: 'center' });
    }
    // Caption line under the box: name + when (worker signature was at signed_at;
    // client signature has its own client_signed_at).
    doc.font('Helvetica').fontSize(8).fillColor(GRAY_MED);
    if (captionName) {
      doc.text(captionName, x + 4, y0 + 14 + boxH + 6, { width: boxW - 8, lineBreak: false, ellipsis: true });
    }
  };

  drawBox(ML, 'Worker signature', docket.signature_data, docket.signer_name || '');

  if (docket.no_client_on_site) {
    const x = ML + boxW + gap;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(BRAND_DARK).text('CLIENT SIGNATURE', x, y0, { characterSpacing: 1 });
    doc.lineWidth(0.8).roundedRect(x, y0 + 14, boxW, boxH, 6).fillAndStroke(AMBER_BG, '#FCD34D');
    doc.font('Helvetica-Bold').fontSize(11).fillColor(AMBER)
      .text('No client on site', x, y0 + 14 + boxH / 2 - 18, { width: boxW, align: 'center' });
    if (docket.no_client_reason) {
      doc.font('Helvetica').fontSize(8.5).fillColor(GRAY_MED)
        .text(docket.no_client_reason, x + 12, y0 + 14 + boxH / 2, { width: boxW - 24, align: 'center' });
    }
  } else {
    drawBox(ML + boxW + gap, 'Client signature', docket.client_signature, docket.client_signed_name || docket.client_name || '');
  }
  doc.y = y0 + 14 + boxH + 30;
}

function drawFooters(doc, pageW, docket) {
  const range = doc.bufferedPageRange();
  const stamp = fmtDateTime(new Date().toISOString());
  const ref = docket.docket_number || ('#' + docket.id);
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - MB + 14;
    doc.moveTo(ML, y - 8).lineTo(doc.page.width - MR, y - 8).strokeColor(GRAY_LINE).lineWidth(0.4).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
      .text(ref + '  ·  Generated from Atomis · ' + stamp, ML, y, { width: pageW, align: 'left', lineBreak: false });
    doc.text('Page ' + (i + 1 - range.start) + ' of ' + range.count, ML, y, { width: pageW, align: 'right', lineBreak: false });
  }
}

module.exports = { renderShiftDocketPdf };
