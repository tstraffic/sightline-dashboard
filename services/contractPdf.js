// Employment agreement PDF — renders a contract (with its snapshotted
// fields_json) into a branded, paginated A4 document. Called twice in a
// contract's life: once at generation (unsigned copy) and again after the
// worker signs (embeds the signature image, per-acknowledgement tick
// times and the audit metadata). Both copies are kept.
//
// PDFs are written to data/contracts/ — deliberately NOT data/uploads/,
// which server.js exposes as unauthenticated static files. These carry a
// worker's DOB, address and pay rates, so they are only ever streamed
// through the authed admin route or the token-gated signing route.

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const tpl = require('../lib/contractTemplate');

const CONTRACT_DIR = path.join(__dirname, '..', 'data', 'contracts');

// Document palette — the muted "paper" emerald used by the other T&S PDFs,
// not the neon web brand.
const BRAND = '#059669';
const BRAND_DARK = '#065F46';
const INK = '#1F2937';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const RULE = '#E5E7EB';
const PANEL = '#F9FAFB';

const ML = 46, MR = 46, MT = 52, MB = 56;
const A4W = 595.28;
const CW = A4W - ML - MR;
const LOGO = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');

function money2(s) { return s; }

function ensureDir() { fs.mkdirSync(CONTRACT_DIR, { recursive: true }); }

// ── Low-level helpers ────────────────────────────────────────────────
function need(doc, h) {
  if (doc.y + h > doc.page.height - MB) { doc.addPage(); return true; }
  return false;
}

// A heading must never be the last thing on a page. Every heading reserves
// itself PLUS a slab of whatever follows, so if both don't fit we break
// early and they start the next page together. ~70pt ≈ a table header plus
// its first row, or three lines of clause text.
const KEEP_WITH_NEXT = 72;

// Sub-heading inside a schedule (A1 / A2 / A3, "How penalties apply", the
// signatory blocks). Measures its own height rather than assuming one line.
function blockHeading(doc, text, opts = {}) {
  const size = opts.size || 10.5;
  const color = opts.color || BRAND_DARK;
  const follow = opts.follow == null ? KEEP_WITH_NEXT : opts.follow;
  doc.font('Helvetica-Bold').fontSize(size);
  const h = doc.heightOfString(text, { width: CW });
  need(doc, h + 6 + follow);
  doc.fillColor(color).font('Helvetica-Bold').fontSize(size).text(text, ML, doc.y, { width: CW });
  doc.y += 6;
}

function sectionHeading(doc, num, heading) {
  const label = `${num}.  ${heading}`;
  doc.font('Helvetica-Bold').fontSize(11.5);
  const h = doc.heightOfString(label, { width: CW });
  // gap + heading + rule + the opening lines of clause 1
  need(doc, 12 + h + 12 + KEEP_WITH_NEXT);
  doc.moveDown(0.9);
  const y = doc.y;
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(11.5)
    .text(label, ML, y, { width: CW });
  doc.moveTo(ML, doc.y + 3).lineTo(ML + CW, doc.y + 3).lineWidth(0.7).strokeColor(RULE).stroke();
  doc.y += 9;
}

function clauseText(doc, text) {
  // Split a clause into its paragraphs / sub-points so pdfkit flows each
  // block and page-breaks between points rather than mid-line.
  const blocks = tpl.toPlain(text).split(/\n+/).map(s => s.trim()).filter(Boolean);
  for (const block of blocks) {
    const indent = /^\([a-z]\)/.test(block) ? 14 : 0;
    need(doc, 24);
    doc.fillColor(INK).font('Helvetica').fontSize(9.3)
      .text(block, ML + indent, doc.y, { width: CW - indent, lineGap: 2.1, align: 'left' });
    doc.y += 4;
  }
  doc.y += 3;
}

function drawTable(doc, header, rows, widths, opts = {}) {
  const x0 = ML;
  const rowH = (cells, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.6);
    let h = 0;
    cells.forEach((c, i) => {
      h = Math.max(h, doc.heightOfString(String(c), { width: widths[i] - 10, lineGap: 1 }));
    });
    return Math.max(h + 9, 20);
  };
  const drawRow = (cells, y, h, { bold = false, fill = null, color = INK } = {}) => {
    if (fill) doc.rect(x0, y, CW, h).fillColor(fill).fill();
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.6).fillColor(color);
    let x = x0;
    cells.forEach((c, i) => {
      doc.text(String(c), x + 5, y + 5, { width: widths[i] - 10, lineGap: 1 });
      x += widths[i];
    });
    doc.moveTo(x0, y + h).lineTo(x0 + CW, y + h).lineWidth(0.5).strokeColor(RULE).stroke();
  };

  const headH = rowH(header, true);
  // Never strand a table header: reserve it plus its first real row.
  need(doc, headH + (rows.length ? rowH(rows[0], false) : 0) + 4);
  drawRow(header, doc.y, headH, { bold: true, fill: PANEL, color: BRAND_DARK });
  doc.y += headH;
  for (const row of rows) {
    const h = rowH(row, false);
    if (need(doc, h + 4)) {
      // repeat the header after a page break so the grid stays readable
      drawRow(header, doc.y, headH, { bold: true, fill: PANEL, color: BRAND_DARK });
      doc.y += headH;
    }
    drawRow(row, doc.y, h, {});
    doc.y += h;
  }
  doc.y += 6;
}

// Label + value stacked in a column of width w. Measures first and breaks
// the page if it won't fit — without this a run of rows walked straight
// through the bottom margin and overprinted the page footer.
function metaCellHeight(doc, value, w) {
  doc.font('Helvetica').fontSize(9.5);
  return 10 + doc.heightOfString(String(value || '—'), { width: w, lineGap: 1.5 }) + 7;
}
function drawMetaCell(doc, label, value, x, y, w) {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(String(label).toUpperCase(), x, y, { width: w });
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(String(value || '—'), x, y + 10, { width: w, lineGap: 1.5 });
}
function metaRow(doc, label, value, x, w) {
  const h = metaCellHeight(doc, value, w);
  need(doc, h);
  const y = doc.y;
  drawMetaCell(doc, label, value, x, y, w);
  doc.y = y + h;
}

// Two-column grid of label/value pairs — keeps the signing record compact
// instead of a long single-file stack running off the page.
function metaGrid(doc, pairs) {
  const gap = 20;
  const colW = (CW - gap) / 2;
  for (let i = 0; i < pairs.length; i += 2) {
    const left = pairs[i];
    const right = pairs[i + 1];
    const h = Math.max(
      metaCellHeight(doc, left[1], colW),
      right ? metaCellHeight(doc, right[1], colW) : 0
    );
    need(doc, h);
    const y = doc.y;
    drawMetaCell(doc, left[0], left[1], ML, y, colW);
    if (right) drawMetaCell(doc, right[0], right[1], ML + colW + gap, y, colW);
    doc.y = y + h;
  }
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(String(dataUrl || ''));
  return m ? Buffer.from(m[2], 'base64') : null;
}

// ── Renderer ─────────────────────────────────────────────────────────
// contract: contracts row · fields: parsed fields_json ·
// acks: contract_acknowledgements rows (empty array pre-signing)
function renderContractPdf(contract, fields, acks = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const signed = contract.status === 'signed';
    let firstPage = true;
    doc.on('pageAdded', () => {
      if (firstPage) { firstPage = false; doc.y = MT; return; }
      // Slim running header on pages 2+
      doc.fillColor(FAINT).font('Helvetica').fontSize(7.5)
        .text(`Casual Employment Agreement · ${fields.WORKER_FULL_NAME || ''} · ${contract.agreement_number}`, ML, 24, { width: CW - 90 });
      doc.fillColor(signed ? BRAND : '#B45309').font('Helvetica-Bold').fontSize(7.5)
        .text(signed ? 'SIGNED' : 'UNSIGNED', ML + CW - 80, 24, { width: 80, align: 'right' });
      doc.moveTo(ML, 36).lineTo(ML + CW, 36).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.y = 48;
    });

    doc.addPage();

    // ── Title block ──
    try { if (fs.existsSync(LOGO)) doc.image(LOGO, ML, MT - 8, { fit: [120, 40] }); } catch (e) { /* logo optional */ }
    doc.fillColor(signed ? BRAND : '#B45309').font('Helvetica-Bold').fontSize(8.5)
      .text(signed ? 'SIGNED AGREEMENT' : 'UNSIGNED — FOR REVIEW AND SIGNATURE', ML, MT - 4, { width: CW, align: 'right' });
    doc.fillColor(FAINT).font('Helvetica').fontSize(7.5)
      .text(`${contract.agreement_number} · version ${contract.version}`, ML, MT + 8, { width: CW, align: 'right' });

    doc.y = MT + 48;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(19)
      .text('CASUAL EMPLOYMENT AGREEMENT', ML, doc.y, { width: CW });
    doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(11)
      .text('Traffic Controller — Civil Construction', ML, doc.y + 2, { width: CW });
    doc.y += 10;
    doc.moveTo(ML, doc.y).lineTo(ML + CW, doc.y).lineWidth(1.4).strokeColor(BRAND).stroke();
    doc.y += 14;

    // ── Parties panel ──
    const colW = CW / 2 - 10;
    const panelTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('THE COMPANY', ML, panelTop, { width: colW });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(tpl.COMPANY.name, ML, doc.y + 1, { width: colW });
    doc.font('Helvetica').fontSize(8.8).fillColor(INK)
      .text(`ABN ${tpl.COMPANY.abn}`, ML, doc.y + 1, { width: colW })
      .text(`Registered office: ${tpl.COMPANY.address}`, ML, doc.y + 1, { width: colW, lineGap: 1.5 })
      .text('"the Company", "T&S", "we", "us"', ML, doc.y + 1, { width: colW });
    const leftEnd = doc.y;

    doc.y = panelTop;
    const rx = ML + colW + 20;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('THE EMPLOYEE  ("YOU")', rx, panelTop, { width: colW });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(fields.WORKER_FULL_NAME || '—', rx, doc.y + 1, { width: colW });
    doc.font('Helvetica').fontSize(8.8).fillColor(INK)
      .text(`Date of birth: ${fields.WORKER_DOB_DISPLAY || fields.WORKER_DOB || '—'}`, rx, doc.y + 1, { width: colW })
      .text(`Address: ${fields.WORKER_ADDRESS || '—'}`, rx, doc.y + 1, { width: colW, lineGap: 1.5 })
      .text(`Mobile: ${fields.WORKER_MOBILE || '—'} · Email: ${fields.WORKER_EMAIL || '—'}`, rx, doc.y + 1, { width: colW, lineGap: 1.5 });
    doc.y = Math.max(leftEnd, doc.y) + 10;

    // ── Reference strip ──
    const stripY = doc.y;
    doc.rect(ML, stripY, CW, 34).fillColor(PANEL).fill();
    const cells = [
      ['AGREEMENT REFERENCE', contract.agreement_number],
      ['DATE OFFERED', fields.OFFER_DATE || '—'],
      ['COMMENCEMENT DATE', fields.START_DATE_DISPLAY || fields.START_DATE || '—'],
    ];
    const cw3 = CW / 3;
    cells.forEach(([l, v], i) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED).text(l, ML + i * cw3 + 10, stripY + 7, { width: cw3 - 16 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND_DARK).text(v, ML + i * cw3 + 10, stripY + 17, { width: cw3 - 16 });
    });
    doc.y = stripY + 44;

    // ── Body sections ──
    for (const sec of tpl.sections(fields)) {
      sectionHeading(doc, sec.num, sec.heading);
      for (const clause of sec.clauses) clauseText(doc, clause);
    }

    // ── Schedule A ──
    const A = tpl.scheduleA(fields);
    doc.addPage();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('SCHEDULE A — RATES OF PAY AND ALLOWANCES', ML, doc.y, { width: CW });
    doc.y += 4;
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.6).text(A.intro, ML, doc.y, { width: CW, lineGap: 1.5 });
    doc.y += 10;

    blockHeading(doc, 'A1 — Base hourly rates (Mon–Fri, day)');
    drawTable(doc,
      ['Tier', 'Award level', 'Role', 'Hourly rate'],
      A.a1.map(r => [r.tier, r.level, r.role, money2(r.rate)]),
      [50, 100, CW - 260, 110]);

    blockHeading(doc, 'A2 — Penalty rates');
    const a2w = [42].concat(Array(7).fill((CW - 42) / 7));
    drawTable(doc, A.a2Header, A.a2.map(r => [r.tier].concat(r.cells)), a2w);

    blockHeading(doc, 'How penalties apply:', { size: 9, color: INK, follow: 78 });
    doc.y -= 3;
    for (const n of A.penaltyNotes) {
      doc.fillColor(INK).font('Helvetica').fontSize(8.6).text('•  ' + n, ML + 6, doc.y, { width: CW - 6, lineGap: 1.5 });
      doc.y += 2;
    }
    doc.y += 4;
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(8.4).text(tpl.toPlain(A.penaltyFootnote), ML, doc.y, { width: CW, lineGap: 1.5 });
    doc.y += 12;

    blockHeading(doc, 'A3 — Allowances');
    drawTable(doc,
      ['Allowance', 'Rate', 'Notes'],
      A.a3.map(r => [r.name, r.rate, r.notes]),
      [140, 100, CW - 240]);

    // ── Schedule B ──
    doc.addPage();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text('SCHEDULE B — ACKNOWLEDGEMENTS AND ELECTRONIC SIGNATURE', ML, doc.y, { width: CW });
    doc.y += 6;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.8)
      .text(signed
        ? 'Each acknowledgement below was ticked individually by the employee. The recorded time and network address of each tick are retained by T&S as part of the signing record.'
        : 'Tick each box to confirm. All boxes must be ticked before you can submit.',
        ML, doc.y, { width: CW, lineGap: 1.5 });
    doc.y += 10;

    const ackByKey = {};
    for (const a of acks) ackByKey[a.ack_key] = a;
    for (const ack of tpl.ACKNOWLEDGEMENTS) {
      const rec = ackByKey[ack.key];
      const label = tpl.toPlain(ack.label);
      doc.font('Helvetica').fontSize(8.8);
      const h = doc.heightOfString(label, { width: CW - 26, lineGap: 1.5 }) + (rec ? 12 : 6);
      need(doc, h + 8);
      const y = doc.y;
      // checkbox
      doc.rect(ML, y + 1, 9, 9).lineWidth(0.9).strokeColor(rec ? BRAND : MUTED).stroke();
      if (rec) {
        doc.moveTo(ML + 2, y + 6).lineTo(ML + 4, y + 8.2).lineTo(ML + 7.6, y + 2.6).lineWidth(1.3).strokeColor(BRAND).stroke();
      }
      doc.fillColor(INK).font('Helvetica').fontSize(8.8).text(label, ML + 18, y, { width: CW - 26, lineGap: 1.5 });
      if (rec) {
        doc.fillColor(FAINT).font('Helvetica').fontSize(7.2)
          .text(`Ticked ${rec.ticked_at_client || rec.recorded_at}${rec.ip ? ' · IP ' + rec.ip : ''}`, ML + 18, doc.y + 1, { width: CW - 26 });
      }
      doc.y += 7;
    }

    // ── Signature blocks ──
    // The whole employee block (rule, heading, name, signature box and the
    // signing record) is kept together — reserved as one slab so it never
    // splits across a page break.
    need(doc, signed ? 250 : 170);
    doc.moveDown(1);
    doc.moveTo(ML, doc.y).lineTo(ML + CW, doc.y).lineWidth(0.7).strokeColor(RULE).stroke();
    doc.y += 12;

    doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(10.5).text('Employee', ML, doc.y, { width: CW });
    doc.y += 8;
    metaRow(doc, 'Full name', fields.WORKER_FULL_NAME, ML, CW);
    if (signed && contract.signature_path) {
      // Label + box are one unit — never split them across a page.
      need(doc, 92);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('SIGNATURE', ML, doc.y, { width: CW });
      const sigAbs = path.join(__dirname, '..', contract.signature_path);
      try {
        if (fs.existsSync(sigAbs)) {
          doc.rect(ML, doc.y + 3, 210, 64).fillColor('#FFFFFF').fill();
          doc.rect(ML, doc.y + 3, 210, 64).lineWidth(0.7).strokeColor(RULE).stroke();
          doc.image(sigAbs, ML + 8, doc.y + 8, { fit: [194, 54] });
        }
      } catch (e) { /* image missing — metadata below still records the signing */ }
      doc.y += 74;
      // Two columns rather than a long single-file stack. The raw
      // user-agent string is deliberately NOT printed here — it's a wall of
      // machine text on a document a person has to read, and it stays on
      // the signing record in the dashboard either way.
      metaGrid(doc, [
        ['Signed name (typed)', contract.signed_name_typed],
        ['Date and time signed', fields.SIGNED_AT_DISPLAY || contract.signed_at],
        ['IP address', contract.signer_ip],
        ['Link sent to', contract.sent_to_email || fields.WORKER_EMAIL],
      ]);
      metaRow(doc, 'Identity checks', 'Date of birth verified · full agreement scrolled · name typed to confirm', ML, CW);
    } else {
      need(doc, 92);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('SIGNATURE', ML, doc.y, { width: CW });
      doc.rect(ML, doc.y + 3, 210, 64).lineWidth(0.7).strokeColor(RULE).stroke();
      doc.fillColor(FAINT).font('Helvetica-Oblique').fontSize(8.5).text('Not yet signed', ML + 12, doc.y + 28);
      doc.y += 78;
    }

    doc.y += 10;
    // The company block is one unit: heading, name, position, signature, date.
    blockHeading(doc, 'For and on behalf of T&S Traffic Control Pty Ltd', { follow: 96 });
    doc.y += 2;
    metaGrid(doc, [
      ['Name', fields.TS_SIGNATORY_NAME],
      ['Position', fields.TS_SIGNATORY_POSITION],
    ]);
    need(doc, 46);
    const tsSigY = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('SIGNATURE', ML, tsSigY, { width: CW });
    doc.fillColor(INK).font('Helvetica-Oblique').fontSize(15).text(fields.TS_SIGNATORY_NAME || '', ML, tsSigY + 11, { width: CW / 2 });
    // Date sits alongside the signature rather than under it.
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('DATE', ML + CW / 2 + 20, tsSigY, { width: CW / 2 - 20 });
    doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(fields.OFFER_DATE || '—', ML + CW / 2 + 20, tsSigY + 10, { width: CW / 2 - 20 });
    doc.y = tsSigY + 34;

    const closing = signed
      ? `Document ${contract.agreement_number} · Version ${contract.version} · Generated by the T&S Control Room · A copy of this signed agreement has been emailed to ${fields.WORKER_EMAIL || 'the employee'} and stored against the worker record.`
      : `Document ${contract.agreement_number} · Version ${contract.version} · Generated by the T&S Control Room · This copy is unsigned.`;
    doc.font('Helvetica-Oblique').fontSize(7.5);
    need(doc, 14 + doc.heightOfString(closing, { width: CW, lineGap: 1.5 }));
    doc.y += 12;
    doc.fillColor(FAINT).font('Helvetica-Oblique').fontSize(7.5)
      .text(closing, ML, doc.y, { width: CW, lineGap: 1.5 });

    // ── Page footers (buffered) ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const savedBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0; // stop pdfkit appending a phantom page
      doc.fillColor(FAINT).font('Helvetica').fontSize(7)
        .text(`${contract.agreement_number} · v${contract.version} · Private & confidential`, ML, doc.page.height - 34, { width: CW / 2, lineBreak: false });
      doc.fillColor(FAINT).font('Helvetica').fontSize(7)
        .text(`Page ${i - range.start + 1} of ${range.count}`, ML + CW / 2, doc.page.height - 34, { width: CW / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBottom;
    }

    doc.end();
  });
}

// Write a rendered buffer to data/contracts/, returning the app-root-relative
// path to store in the DB (relative so a deploy-root change can't orphan it).
function writeContractPdf(buf, filename) {
  ensureDir();
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '');
  const abs = path.join(CONTRACT_DIR, safe);
  fs.writeFileSync(abs, buf);
  return path.join('data', 'contracts', safe);
}

// Save a signature data URL as a PNG in data/contracts/ (same privacy
// reasoning as the PDFs). Returns the relative path, or null if invalid.
const MAX_SIG_BYTES = 400 * 1024;
function writeSignaturePng(dataUrl, filename) {
  const buf = dataUrlToBuffer(dataUrl);
  if (!buf || buf.length > MAX_SIG_BYTES) return null;
  ensureDir();
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '');
  fs.writeFileSync(path.join(CONTRACT_DIR, safe), buf);
  return path.join('data', 'contracts', safe);
}

module.exports = { renderContractPdf, writeContractPdf, writeSignaturePng, CONTRACT_DIR };
