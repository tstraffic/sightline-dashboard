// Branded PDF renderer for submitted Job-Pack checklists.
//
// Layout: T&S header, a meta band (submitter / date / booking / vehicle),
// the answers grouped into the checklist's own sections using the real
// question text, photos in a filled grid, then the signature.
//
// Answer labels come from the published checklist template
// (services/systemChecklists.js) rather than the raw JSON keys, so a row
// reads the actual question instead of "Hi Vis Shirt", and items appear in
// the order and sections the template defines. When no template is published
// the renderer falls back to walking the JSON, so a legacy or unpublished
// form still produces a complete document.
//
// Usage:
//   const buf = await renderSubmissionPdf(db, submissionId);
//   res.type('application/pdf').send(buf);

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getSystemItems } = require('./systemChecklists');

// Atomis brand is emerald (see CLAUDE.md). The old #1D6AE5 blue is retired.
const BRAND = '#059669';        // brand-600 — headings and rules
const BRAND_DARK = '#065F46';   // emerald-800 — document title
const GRAY_DARK = '#1F2937';
const GRAY_MED = '#4B5563';
const GRAY_SOFT = '#6B7280';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG = '#F9FAFB';

// Status pills — light fill + deep text, matching the web badges. "No" used
// to render in muted grey, which reads as unanswered on a safety record.
const PILL = {
  yes:   { bg: '#ECFDF5', fg: '#047857', label: 'Yes' },
  no:    { bg: '#FEF2F2', fg: '#B91C1C', label: 'No' },
  ok:    { bg: '#ECFDF5', fg: '#047857', label: 'OK' },
  notok: { bg: '#FEF2F2', fg: '#B91C1C', label: 'NOT OK' },
  na:    { bg: '#F3F4F6', fg: '#6B7280', label: 'N/A' },
};

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo-colour.png');
const ML = 40, MR = 40, MT = 40, MB = 46;

const FORM_HEADING = {
  vehicle_prestart:   '1. T&S Vehicle Pre-Start',
  risk_toolbox:       '2. Risk Assessment and Toolbox',
  tc_prestart:        '3. Traffic Controller Prestart Declaration',
  team_leader:        '4. Team Leader Checklist',
  post_shift_vehicle: '5. Post Shift Vehicle Checklist',
  prestart:           'Pre-Start Checklist',
  take5:              'Take 5 Safety Check',
  hazard:             'Hazard Report',
  incident:           'Incident Report',
  equipment:          'Equipment Check',
};

const TAG_LABEL = {
  arrow_board: 'Arrow board',
  setup: 'Site setup',
  team: 'Team / PPE',
  interior: 'Vehicle interior',
  equipment_cage: 'Equipment cage',
  fuel_gauge: 'Fuel gauge',
  other: 'Other',
};

function prettify(s) {
  if (!s) return '';
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function fmtDate(s) {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('en-AU', {
      timeZone: 'Australia/Sydney',
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch (e) { return String(s); }
}

// Decode a "data:image/png;base64,…" signature data URL into a Buffer for
// pdfkit's image() call. Returns null when the value isn't actually a data URL.
function dataUrlToBuffer(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/);
  if (!m) return null;
  try { return Buffer.from(m[1], 'base64'); } catch (_) { return null; }
}

function innerWidth(doc) { return doc.page.width - ML - MR; }

// The document is built with margin:0 and all geometry is manual, so page
// breaks have to be explicit. Reserve `h` points; start a new page if they
// don't fit above the footer. Returns true when a page was added.
function ensureSpace(doc, h) {
  if (doc.y + h > doc.page.height - MB) {
    doc.addPage();
    return true;
  }
  return false;
}

// ── Chrome ──────────────────────────────────────────────────────────────────

function drawHeader(doc, sub) {
  const formTitle = FORM_HEADING[sub.form_type] || prettify(sub.form_type || 'Submission');
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { width: 70 }); } catch (_) {}
  }
  // Every run needs an explicit width: with margin:0 pdfkit right-aligns to
  // the physical paper edge, 40pt past the divider — that is what used to
  // push the address block off the page.
  const textX = ML + 90;
  const textW = doc.page.width - MR - textX;

  doc.fillColor(BRAND_DARK).font('Helvetica-Bold').fontSize(19)
    .text(formTitle, textX, MT + 2, { width: textW, align: 'right' });
  doc.font('Helvetica').fontSize(7.5).fillColor(GRAY_SOFT)
    .text('T&S Traffic Control Pty Ltd  ·  9 Epic Pl, Villawood NSW 2163', textX, MT + 30, { width: textW, align: 'right' })
    .text('ABN 58 655 958 320  ·  admin@tstc.com.au  ·  1300 00 8782', textX, doc.y, { width: textW, align: 'right' });

  doc.moveTo(ML, MT + 70).lineTo(doc.page.width - MR, MT + 70)
    .strokeColor(BRAND).lineWidth(1.5).stroke();
  doc.y = MT + 84;
}

// Slim running header for pages 2+, so a page found on its own still says
// what it belongs to.
function drawRunningHeader(doc, sub) {
  const title = FORM_HEADING[sub.form_type] || prettify(sub.form_type || 'Submission');
  const w = innerWidth(doc);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_SOFT)
    .text(title, ML, MT - 10, { width: w * 0.6, lineBreak: false, ellipsis: true });
  doc.font('Helvetica').fontSize(8).fillColor(GRAY_SOFT)
    .text(sub.signed_name || sub.crew_name || '', ML + w * 0.6, MT - 10,
      { width: w * 0.4, align: 'right', lineBreak: false, ellipsis: true });
  doc.moveTo(ML, MT + 4).lineTo(doc.page.width - MR, MT + 4)
    .strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
  doc.y = MT + 16;
}

// Footers are drawn last over the buffered pages, once the total is known.
// pdfkit appends a phantom page when a text() lands below the bottom margin,
// so zero the margin for the write and restore it afterwards.
function drawFooters(doc, sub) {
  const range = doc.bufferedPageRange();
  const ref = 'Ref #' + sub.id;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const saved = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const w = innerWidth(doc);
    const y = doc.page.height - MB + 14;
    doc.moveTo(ML, y - 8).lineTo(doc.page.width - MR, y - 8)
      .strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(GRAY_SOFT)
      .text(ref, ML, y, { width: w * 0.5, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, ML + w * 0.5, y,
        { width: w * 0.5, align: 'right', lineBreak: false });
    doc.page.margins.bottom = saved;
  }
}

// ── Meta band ───────────────────────────────────────────────────────────────

function drawHeaderBand(doc, sub) {
  const cells = [
    { label: 'Submitted by', value: sub.signed_name || sub.crew_name || '—' },
    { label: 'Submitted', value: fmtDate(sub.submitted_at) },
  ];

  const bookingLines = [];
  if (sub.job_client) bookingLines.push(sub.job_client);
  if (sub.job_number) bookingLines.push(sub.job_number);
  if (sub.job_name && sub.job_name !== sub.job_client) bookingLines.push(sub.job_name);
  cells.push({ label: 'Booking', value: bookingLines.join('\n') || '—' });

  if (['vehicle_prestart', 'post_shift_vehicle'].includes(sub.form_type)) {
    cells.push({
      label: 'Vehicle',
      value: [sub.vehicle_rego, sub.vehicle_asset].filter(Boolean).join(' · ') || '—',
    });
  }

  const innerW = innerWidth(doc);
  const colW = innerW / cells.length;
  const padX = 8;
  const y0 = doc.y;

  // Measure every cell up front — band height is the tallest cell, not
  // wherever the last text() happened to leave doc.y.
  doc.font('Helvetica').fontSize(9);
  const valueH = cells.reduce((max, c) =>
    Math.max(max, doc.heightOfString(c.value, { width: colW - padX * 2 })), 0);
  const bandH = 20 + valueH + 10;

  doc.lineWidth(0.6).roundedRect(ML, y0, innerW, bandH, 4).fillAndStroke(GRAY_BG, GRAY_LINE);

  cells.forEach((c, i) => {
    const x = ML + colW * i;
    if (i > 0) {
      doc.moveTo(x, y0 + 6).lineTo(x, y0 + bandH - 6)
        .strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    }
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor(GRAY_SOFT)
      .text(c.label.toUpperCase(), x + padX, y0 + 7, { width: colW - padX * 2, characterSpacing: 0.6 });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY_DARK)
      .text(c.value, x + padX, y0 + 20, { width: colW - padX * 2 });
  });

  doc.y = y0 + bandH + 14;
}

// ── Answers ─────────────────────────────────────────────────────────────────

// `reserve` is the height of whatever follows the heading, so a heading can
// never strand itself at the foot of a page.
function drawSection(doc, title, reserve) {
  ensureSpace(doc, 26 + (reserve || 0));
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BRAND).text(title, ML, doc.y);
  doc.moveDown(0.35);
  doc.strokeColor(BRAND).lineWidth(0.8)
    .moveTo(ML, doc.y).lineTo(doc.page.width - MR, doc.y).stroke();
  doc.moveDown(0.5);
}

function drawSubSection(doc, title, reserve) {
  ensureSpace(doc, 20 + (reserve || 0));
  doc.font('Helvetica-Bold').fontSize(8).fillColor(GRAY_DARK)
    .text(String(title).toUpperCase(), ML, doc.y, { characterSpacing: 0.7 });
  doc.moveDown(0.4);
}

// Classify a value into a status pill, or null when it's free text.
function pillFor(value) {
  if (typeof value === 'boolean') return value ? PILL.yes : PILL.no;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (s === 'yes' || s === 'true') return PILL.yes;
  if (s === 'no' || s === 'false') return PILL.no;
  if (s === 'ok') return PILL.ok;
  if (s === 'not_ok' || s === 'notok') return PILL.notok;
  if (s === 'na' || s === 'n/a') return PILL.na;
  return null;
}

function drawPill(doc, pill, x, y) {
  doc.font('Helvetica-Bold').fontSize(7.5);
  const w = doc.widthOfString(pill.label) + 14;
  doc.roundedRect(x, y, w, 14, 7).fill(pill.bg);
  doc.fillColor(pill.fg).text(pill.label, x, y + 3.5, { width: w, align: 'center', lineBreak: false });
}

// One label → value row. Zebra striping keeps long checklists scannable.
function drawAnswerRow(doc, label, value, index) {
  const innerW = innerWidth(doc);
  const labelW = innerW * 0.52;
  const valueX = ML + labelW + 10;
  const valueW = innerW - labelW - 10;
  const pill = pillFor(value);

  let valueText = null;
  if (!pill) {
    if (value == null || value === '') valueText = '—';
    else if (Array.isArray(value)) valueText = value.length ? value.join('  ·  ') : '— none selected';
    else valueText = String(value);
  }

  doc.font('Helvetica').fontSize(9);
  const labelH = doc.heightOfString(String(label), { width: labelW - 12 });
  const valueH = pill ? 14 : doc.heightOfString(valueText, { width: valueW - 8 });
  const rowH = Math.max(labelH, valueH) + 10;

  if (ensureSpace(doc, rowH)) index = 0; // restart striping cleanly after a break
  const y0 = doc.y;

  if (index % 2 === 1) doc.rect(ML, y0, innerW, rowH).fill(GRAY_BG);

  doc.font('Helvetica').fontSize(9).fillColor(GRAY_MED)
    .text(String(label), ML + 6, y0 + 5, { width: labelW - 12 });

  if (pill) {
    drawPill(doc, pill, valueX, y0 + 4);
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(valueText === '—' ? GRAY_SOFT : GRAY_DARK)
      .text(valueText, valueX, y0 + 5, { width: valueW - 8 });
  }

  doc.y = y0 + rowH;
}

// Find the answer for a template item. Forms nest differently
// (vehicle_prestart keeps items under data.items, team_leader keeps PPE under
// data.ppe), so check the top level then one level into any nested object.
// Returns { found, value } so a genuine `false` isn't read as "not answered".
function lookupAnswer(data, key) {
  if (!data || typeof data !== 'object') return { found: false };
  if (Object.prototype.hasOwnProperty.call(data, key)) return { found: true, value: data[key] };
  for (const k of Object.keys(data)) {
    const v = data[k];
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        Object.prototype.hasOwnProperty.call(v, key)) {
      return { found: true, value: v[key] };
    }
  }
  return { found: false };
}

// Walk raw JSON when no template is published — the original behaviour, kept
// so legacy submissions still render every field they captured.
function drawRawAnswers(doc, obj, counter) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      drawSubSection(doc, prettify(k), 24);
      counter.i = 0;
      drawRawAnswers(doc, v, counter);
    } else {
      drawAnswerRow(doc, prettify(k), v, counter.i++);
    }
  }
}

function drawAnswers(doc, sub, parsed) {
  if (!parsed || typeof parsed !== 'object') return;

  // Two shapes exist in the wild: { answers: {...}, ...extras } and a plain
  // flat object.
  let data = parsed;
  if (parsed.answers && typeof parsed.answers === 'object') {
    data = Object.assign({}, parsed.answers);
    Object.entries(parsed).forEach(([k, v]) => { if (k !== 'answers') data[k] = v; });
  }

  let items = [];
  try { items = getSystemItems(sub.form_type, []) || []; }
  catch (e) { console.error('[jobPackPdf] checklist template lookup failed:', e.message); }

  drawSection(doc, 'Answers', 30);

  if (!items.length) {
    drawRawAnswers(doc, data, { i: 0 });
    return;
  }

  // Template-driven: real question text, template order, grouped by section.
  const ordered = items.slice().sort((a, b) => (a.item_order || 0) - (b.item_order || 0));
  const groups = [];
  const used = new Set();
  for (const it of ordered) {
    const section = it.section || '';
    let group = groups.find(g => g.section === section);
    if (!group) { group = { section, rows: [] }; groups.push(group); }
    const hit = lookupAnswer(data, it.item_key);
    if (hit.found) used.add(it.item_key);
    group.rows.push({ label: it.question || prettify(it.item_key), value: hit.found ? hit.value : null });
  }

  for (const group of groups) {
    if (group.section) drawSubSection(doc, group.section, 24);
    let i = 0;
    for (const r of group.rows) drawAnswerRow(doc, r.label, r.value, i++);
    doc.moveDown(0.4);
  }

  // Anything the submission captured that the template doesn't describe —
  // free-text notes, legacy fields — still has to appear.
  const leftovers = {};
  for (const [k, v] of Object.entries(data)) {
    if (used.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = {};
      for (const [nk, nv] of Object.entries(v)) if (!used.has(nk)) nested[nk] = nv;
      if (Object.keys(nested).length) leftovers[k] = nested;
    } else {
      leftovers[k] = v;
    }
  }
  if (Object.keys(leftovers).length) {
    drawSubSection(doc, 'Additional', 24);
    drawRawAnswers(doc, leftovers, { i: 0 });
  }
}

// ── Photos ──────────────────────────────────────────────────────────────────

function drawPhotos(doc, photos) {
  if (!photos || !photos.length) return;

  const byTag = {};
  for (const p of photos) (byTag[p.tag || 'other'] = byTag[p.tag || 'other'] || []).push(p);

  const innerW = innerWidth(doc);
  const cols = 3;
  const gap = 8;
  const cellW = (innerW - gap * (cols - 1)) / cols;
  const cellH = cellW * 0.78;

  drawSection(doc, 'Photos', 20 + cellH);

  for (const tag of Object.keys(byTag)) {
    const list = byTag[tag];
    // Reserve the caption plus its first row together — the caption used to
    // fit at the foot of a page while its photos broke to the next one.
    drawSubSection(doc, `${TAG_LABEL[tag] || prettify(tag)}  (${list.length})`, cellH + gap);

    let rowY = doc.y;
    list.forEach((p, i) => {
      const col = i % cols;
      if (col === 0) {
        if (i > 0) rowY += cellH + gap;
        // Break per row and re-anchor to the new page. The old code added a
        // fixed row offset to a doc.y that never advanced, so a tag with more
        // than three photos ran straight off the bottom of the page.
        doc.y = rowY;
        if (ensureSpace(doc, cellH)) rowY = doc.y;
      }
      const x = ML + col * (cellW + gap);

      let drawn = false;
      try {
        const abs = path.isAbsolute(p.file_path) ? p.file_path : path.join(__dirname, '..', p.file_path);
        if (fs.existsSync(abs)) {
          // cover, not fit: fills the cell instead of letterboxing a portrait
          // phone photo into a landscape box with white bars either side.
          doc.save();
          doc.roundedRect(x, rowY, cellW, cellH, 3).clip();
          doc.image(abs, x, rowY, { cover: [cellW, cellH], align: 'center', valign: 'center' });
          doc.restore();
          drawn = true;
        }
      } catch (e) { /* fall through to the placeholder */ }

      if (!drawn) {
        // A missing or undecodable file used to leave a silent hole in the
        // grid — show it, so the gap is explicable.
        doc.roundedRect(x, rowY, cellW, cellH, 3).fill(GRAY_BG);
        doc.font('Helvetica').fontSize(7).fillColor(GRAY_SOFT)
          .text('Image unavailable', x, rowY + cellH / 2 - 4, { width: cellW, align: 'center' });
      }
      doc.roundedRect(x, rowY, cellW, cellH, 3).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    });

    doc.y = rowY + cellH + 14;
  }
}

// ── Signature ───────────────────────────────────────────────────────────────

function drawSignature(doc, sub) {
  if (!sub.signature_data && !sub.signed_name) return;
  drawSection(doc, 'Signature', 100);

  const boxW = 250, boxH = 78;
  const y0 = doc.y;
  doc.lineWidth(0.6).roundedRect(ML, y0, boxW, boxH, 4).fillAndStroke('#FFFFFF', GRAY_LINE);

  const buf = dataUrlToBuffer(sub.signature_data);
  if (buf) {
    try { doc.image(buf, ML + 8, y0 + 6, { fit: [boxW - 16, boxH - 16], align: 'center', valign: 'center' }); }
    catch (e) { console.error('[jobPackPdf] signature render failed:', e.message); }
  }

  doc.y = y0 + boxH + 8;
  if (sub.signed_name) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY_DARK).text(sub.signed_name, ML, doc.y);
  }
  doc.font('Helvetica').fontSize(7.5).fillColor(GRAY_SOFT)
    .text('Signed ' + fmtDate(sub.submitted_at), ML, doc.y);
  doc.y += 10;
}

// ── Entry point ─────────────────────────────────────────────────────────────

function renderSubmissionPdf(db, submissionId) {
  return new Promise((resolve, reject) => {
    const sub = db.prepare(`
      SELECT sf.*, cm.full_name AS crew_name, cm.employee_id AS employee_code,
        j.job_number, j.client AS job_client, j.job_name,
        v.rego AS vehicle_rego, v.asset_id AS vehicle_asset
      FROM safety_forms sf
      LEFT JOIN crew_members cm ON sf.crew_member_id = cm.id
      LEFT JOIN jobs j ON sf.job_id = j.id
      LEFT JOIN vehicles v ON v.id = sf.vehicle_id
      WHERE sf.id = ?
    `).get(submissionId);
    if (!sub) return reject(new Error('Submission not found: ' + submissionId));

    const photos = db.prepare(`
      SELECT * FROM safety_form_photos WHERE safety_form_id = ? ORDER BY id ASC
    `).all(sub.id);

    let parsed = {};
    try { parsed = sub.data ? JSON.parse(sub.data) : {}; } catch (_) {}

    // bufferPages so the footer can print "Page 1 of N" once N is known.
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, bufferPages: true });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let firstPage = true;
    doc.on('pageAdded', () => {
      if (firstPage) { firstPage = false; doc.y = MT; return; }
      drawRunningHeader(doc, sub);
    });

    doc.addPage();

    drawHeader(doc, sub);
    drawHeaderBand(doc, sub);
    drawAnswers(doc, sub, parsed);
    drawPhotos(doc, photos);
    drawSignature(doc, sub);
    drawFooters(doc, sub);

    doc.end();
  });
}

// FORM_HEADING is exported so the worker-portal viewer can title its page
// with exactly the heading printed on the document.
module.exports = { renderSubmissionPdf, FORM_HEADING };
