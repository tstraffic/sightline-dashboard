/**
 * Audit PDF export v5 — professional branded Atomis report (built for T&S Traffic Control).
 *
 * Design: Clean cover page, structured body, proper typography,
 * no blank pages, professional color scheme.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { AUDIT_SECTIONS, normaliseState } = require('../lib/auditQuestions');

/* ── Brand palette ── */
const BRAND     = '#10B981';
const BRAND_BG  = '#ECFDF5';   // light brand tint
const GREEN     = '#059669';
const GREEN_BG  = '#ECFDF5';
const RED       = '#DC2626';
const RED_BG    = '#FEF2F2';
const AMBER     = '#D97706';
const AMBER_BG  = '#FFFBEB';
const GRAY      = '#6B7280';
const GRAY_DARK = '#1F2937';
const GRAY_MED  = '#4B5563';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG   = '#F9FAFB';
const WHITE     = '#FFFFFF';
const BLACK     = '#111827';

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'atomis-icon-512.png');
const ML = 50, MR = 50, MT = 50, MB = 60;

/* ── Helpers ── */
function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'medium', timeStyle: 'short' }); }
  catch (e) { return String(d); }
}
function fmtDateShort(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (e) { return String(d); }
}
const RED_BADGE = '#C00000';
const RED_LIGHT = '#FCE4E4';
const COMMENT_BG = '#F5F5F5';
const COMMENT_BORDER = '#DDDDDD';
const BRAND_DARK = '#047857';

function findingLabel(f) {
  if (f === 'pass') return 'PASS';
  if (f === 'pass_with_actions') return 'PASS WITH ACTIONS';
  if (f === 'fail') return 'FAIL — IMMEDIATE RECTIFICATION';
  return (f || '—').toUpperCase();
}
function scoreColor(pct) {
  if (pct >= 90) return GREEN;
  if (pct >= 70) return AMBER;
  return RED;
}
function findingColor(f) {
  if (f === 'pass') return GREEN;
  if (f === 'fail') return RED;
  return AMBER;
}
function findingBg(f) {
  if (f === 'pass') return GREEN_BG;
  if (f === 'fail') return RED_BG;
  return AMBER_BG;
}
function ucFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'; }

/* ════════════════════════════════════════════════════════ */

function generateAuditPdf(opts, out) {
  const { audit: a, responses, sectionComments, nonconformances,
    score, attachmentsByContext, sections } = opts;
  const ctxMap = attachmentsByContext || {};

  // Render from the audit's (template) section list when provided, else fall
  // back to the legacy AUDIT_SECTIONS catalogue. Normalised to { key, title,
  // questions:[{key,text}] } so the loops below are template-agnostic.
  const SECTIONS = (sections && sections.length)
    ? sections.map(function (s) { return { key: s.key, title: s.title, questions: (s.questions || []).map(function (q) { return { key: q.key, text: q.text }; }) }; })
    : AUDIT_SECTIONS.map(function (s) { return { key: s.key, title: s.title, questions: s.items.map(function (t, i) { return { key: s.key + '.' + (i + 1), text: t }; }) }; });

  const doc = new PDFDocument({
    size: 'A4',
    bufferPages: true,
    margins: { top: MT, bottom: MB, left: ML, right: MR },
    info: {
      Title: 'Site Audit #' + a.id + ' — ' + (a.project_site || 'Untitled'),
      Author: 'Atomis',
    },
  });
  doc.pipe(out);

  const pw = doc.page.width - ML - MR;   // usable width
  const ph = doc.page.height;
  const pageBot = ph - MB;

  /* ── Drawing primitives ── */
  function curY() { return doc.y; }
  function setY(y) { doc.y = y; doc.x = ML; }
  function gap(n) { doc.y += n; }
  function need(h) { if (doc.y + h > pageBot) { doc.addPage(); } }

  function rect(x, y, w, h, fill) {
    doc.save().rect(x, y, w, h).fill(fill).restore();
  }
  function roundRect(x, y, w, h, r, fill) {
    doc.save().roundedRect(x, y, w, h, r).fill(fill).restore();
  }
  function line(x1, y1, x2, y2, color, width) {
    doc.save().moveTo(x1, y1).lineTo(x2, y2).strokeColor(color || GRAY_LINE).lineWidth(width || 0.5).stroke().restore();
  }

  /* Text — ALWAYS lineBreak:false unless explicitly multi-line to prevent blank pages */
  function txt(str, x, y, opts2) {
    doc.text(str || '', x, y, Object.assign({ lineBreak: false }, opts2 || {}));
  }

  function font(name, size, color) {
    doc.font(name || 'Helvetica').fontSize(size || 9).fillColor(color || BLACK);
  }

  /* Measure text height for multi-line content */
  function measureText(str, width, size) {
    doc.fontSize(size || 7);
    return doc.heightOfString(str || '', { width: width });
  }

  /* ═══════════════════════════════════════════════════════════
     PAGE 1: COVER / SUMMARY
     ═══════════════════════════════════════════════════════════ */

  // Top brand bar
  rect(0, 0, doc.page.width, 4, BRAND);

  // Logo
  let logoW = 0;
  if (fs.existsSync(LOGO_PATH)) {
    try { doc.image(LOGO_PATH, ML, MT, { height: 42 }); logoW = 120; } catch (e) {}
  }

  // Title block right of logo
  font('Helvetica-Bold', 18, BRAND);
  txt('Site Safety Audit', ML + logoW + 12, MT + 4, { width: pw - logoW - 12 });
  font('Helvetica', 9, GRAY);
  txt('Atomis  ·  Audit #' + a.id, ML + logoW + 12, MT + 26, { width: pw - logoW - 12 });

  setY(MT + 52);
  line(ML, curY(), ML + pw, curY(), BRAND, 2);
  gap(16);

  // ── Overall Score Card ──
  const scoreCardY = curY();
  const scoreCardH = 70;
  roundRect(ML, scoreCardY, pw, scoreCardH, 6, GRAY_BG);

  // Score circle area (left). The number + label stack inside the ring —
  // width is the full diameter so 2- and 3-digit percentages (94%, 100%)
  // don't wrap under the %, and the score/max line sits below the number
  // without overlapping it.
  const circleX = ML + 45;
  const circleY = scoreCardY + 35;
  const circleR = 26;
  doc.save().circle(circleX, circleY, circleR).lineWidth(3.5).strokeColor(BRAND).stroke().restore();
  font('Helvetica-Bold', 16, BRAND);
  txt(score.percent + '%', circleX - circleR, circleY - 12, { width: circleR * 2, align: 'center' });
  font('Helvetica', 6.5, GRAY);
  txt(score.total + ' / ' + score.max, circleX - circleR, circleY + 7, { width: circleR * 2, align: 'center' });

  // Overall finding badge (right of circle)
  const badgeX = ML + 100;
  const badgeY = scoreCardY + 12;
  const badgeW = 150;
  roundRect(badgeX, badgeY, badgeW, 22, 4, findingColor(a.overall_finding));
  font('Helvetica-Bold', 10, WHITE);
  txt(findingLabel(a.overall_finding), badgeX + 10, badgeY + 6, { width: badgeW - 20 });

  // Area scores right side (3 cols)
  const areaX = badgeX;
  const areaY = badgeY + 28;
  const aColW = (pw - 100 + ML - areaX) > 0 ? Math.floor((ML + pw - areaX) / 3) : 100;
  score.groups.forEach(function (g, i) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const ax = areaX + col * aColW;
    const ay = areaY + row * 11;
    font('Helvetica', 6, GRAY);
    txt(g.label, ax, ay, { width: aColW - 35 });
    font('Helvetica-Bold', 6.5, g.percent >= 80 ? GREEN : g.percent >= 50 ? AMBER : RED);
    txt(g.score + '/' + g.max + ' (' + g.percent + '%)', ax + aColW - 50, ay, { width: 48, align: 'right' });
  });

  setY(scoreCardY + scoreCardH + 14);

  // ── FIX 7: Findings Summary on cover page ──
  var failures = [];
  SECTIONS.forEach(function (sec) {
    sec.questions.forEach(function (q) {
      var r = responses[q.key] || {};
      if (normaliseState(r) === 'no') {
        // Keep the full item text — PDFKit's pixel-width ellipsis trims on render.
        failures.push({ key: q.key, item: q.text, section: sec.title });
      }
    });
  });
  if (failures.length > 0) {
    var headerH = 16;
    var rowH    = 12;
    var showFailures = failures.slice(0, 10); // max 10 on cover
    var fsH = headerH + 4 + showFailures.length * rowH + 6;
    need(fsH);
    var fsY = curY();
    // Header bar — slightly taller, with a little more horizontal padding.
    roundRect(ML, fsY, pw, headerH, 3, RED_LIGHT);
    roundRect(ML, fsY, 3, headerH, 1, RED);
    font('Helvetica-Bold', 7.5, RED);
    txt(failures.length + ' non-conformance' + (failures.length !== 1 ? 's' : '') + ' identified',
      ML + 10, fsY + 4, { width: pw - 20 });
    setY(fsY + headerH + 4);
    // Column geometry. Give the item text the bulk of the width — the section
    // name is short and right-aligned, so its column doesn't need to be big.
    var refColX  = ML + 10;
    var refColW  = 28;
    var itemColX = ML + 40;
    var itemColW = Math.floor((pw - 48) * 0.74);
    var secColX  = itemColX + itemColW + 8;
    var secColW  = (ML + pw) - secColX - 6;
    showFailures.forEach(function (f) {
      need(rowH);
      var rowY = curY();
      font('Helvetica-Bold', 6.5, GRAY_DARK);
      txt(f.key, refColX, rowY + 1, { width: refColW });
      font('Helvetica', 6.5, GRAY_DARK);
      txt(f.item, itemColX, rowY + 1, { width: itemColW, height: 10, ellipsis: true });
      font('Helvetica', 5.5, GRAY);
      txt('(' + f.section + ')', secColX, rowY + 1.5, { width: secColW, height: 10, ellipsis: true, align: 'right' });
      setY(rowY + rowH);
    });
    if (failures.length > 10) {
      font('Helvetica', 5.5, GRAY);
      txt('… and ' + (failures.length - 10) + ' more (see checklist)', ML + 10, curY(), { width: pw - 20 });
      gap(8);
    }
    gap(4);
  }

  // ── Audit Details Table ──
  // Legacy audits have project_site stored as "J-XXXX | Client | Suburb | Date"
  // (the auto-generated job_name). Collapse that to the first two segments so
  // the value reads as a label instead of a stringified record.
  const ps = (a.project_site || '').trim();
  const psParts = ps.split(/\s*\|\s*/).filter(Boolean);
  const prettyProjectSite = psParts.length >= 2
    ? psParts.slice(0, 2).join(' — ')
    : (ps || '—');
  const details = [
    ['Project / Site',  prettyProjectSite],
    ['Client',          a.client || '—'],
    ['Date',            fmtDate(a.audit_datetime || a.created_at)],
    ['Job Number',      a.job_number || '—'],
    ['Location',        a.location || '—'],
    ['Shift',           ucFirst(a.shift)],
    ['TGS / TCP Ref',   a.tgs_ref || '—'],
    ['Weather',         a.weather || '—'],
    ['Auditor',         a.auditor_name || a.created_by_name || '—'],
    ['Supervisor',      a.supervisor_name || '—'],
    ['Status',          (a.status || 'draft').replace(/_/g, ' ').toUpperCase()],
  ];
  const labelColW = 90;
  const valColW = pw / 2 - labelColW;
  const halfW = pw / 2;
  const detY = curY();
  details.forEach(function (d, i) {
    var col = i % 2;
    var row = Math.floor(i / 2);
    var dx = ML + col * halfW;
    var dy = detY + row * 16;
    // Alternating row background (spans full width on even indices)
    if (col === 0 && row % 2 === 0) {
      rect(ML, dy - 2, pw, 16, GRAY_BG);
    }
    font('Helvetica', 7, GRAY);
    txt(d[0], dx + 4, dy + 1, { width: labelColW - 8 });
    font('Helvetica-Bold', 7.5, GRAY_DARK);
    txt(d[1], dx + labelColW, dy + 1, { width: valColW - 4 });
  });
  setY(detY + Math.ceil(details.length / 2) * 16 + 4);

  // Follow-up notice
  if (a.follow_up_required) {
    need(22);
    var fuY = curY();
    roundRect(ML, fuY, pw, 18, 3, AMBER_BG);
    font('Helvetica-Bold', 7, AMBER);
    txt('⚠  FOLLOW-UP REQUIRED: ' + (a.follow_up_date ? fmtDateShort(a.follow_up_date) : 'TBC'), ML + 8, fuY + 5, { width: pw - 16 });
    setY(fuY + 22);
  }

  gap(4);

  // ── Site Overview Evidence ──
  embedImages(doc, a, ctxMap['overview'], 'Site Overview Photos', pw, pageBot, ML, MT);

  /* ═══════════════════════════════════════════════════════════
     CHECKLIST SECTIONS
     ═══════════════════════════════════════════════════════════ */
  SECTIONS.forEach(function (section) {
    need(40);

    // Section header bar
    var hY = curY();
    roundRect(ML, hY, pw, 20, 4, BRAND);
    font('Helvetica-Bold', 9, WHITE);
    txt(section.key + '.  ' + section.title, ML + 8, hY + 5, { width: pw - 60 });
    // Section score
    var sYes = 0, sMax = 0;
    section.questions.forEach(function (q) {
      var st = normaliseState(responses[q.key]);
      if (st === 'yes') { sYes++; sMax++; } else if (st === 'no') { sMax++; }
    });
    var sPct = sMax ? Math.round(sYes / sMax * 100) : 0;
    font('Helvetica-Bold', 8, WHITE);
    txt(sYes + '/' + sMax + '  (' + sPct + '%)', ML + pw - 80, hY + 6, { width: 72, align: 'right' });
    setY(hY + 24);

    // Column headers
    var colHY = curY();
    rect(ML, colHY, pw, 12, GRAY_BG);
    font('Helvetica-Bold', 6, GRAY);
    txt('STATUS', ML + 4, colHY + 3, { width: 35 });
    txt('REF', ML + 38, colHY + 3, { width: 22 });
    txt('ITEM', ML + 62, colHY + 3, { width: pw - 66 });
    setY(colHY + 13);

    // Collect items with state for N/A collapsing (Fix 5)
    var items = section.questions.map(function (q) {
      var r = responses[q.key] || {};
      return { key: q.key, item: q.text, r: r, state: normaliseState(r) };
    });

    var ii = 0;
    while (ii < items.length) {
      var it = items[ii];

      // ── FIX 5: Collapse 3+ consecutive N/A items ──
      if (it.state === 'na') {
        var naRun = [it];
        var jj = ii + 1;
        while (jj < items.length && normaliseState(items[jj].r) === 'na') {
          naRun.push(items[jj]); jj++;
        }
        if (naRun.length >= 3) {
          need(12);
          var naY = curY();
          var keyList = naRun.map(function (n) { return n.key; }).join(', ');
          font('Helvetica', 7, '#999999');
          txt('Items ' + keyList + ' — not applicable to this site', ML + 4, naY + 2, { width: pw - 8 });
          setY(naY + 12);
          ii = jj; continue;
        }
        // < 3 consecutive: render individually but de-emphasised
        for (var nk = 0; nk < naRun.length; nk++) {
          need(10);
          var niy = curY();
          roundRect(ML + 4, niy + 2, 28, 8, 2, '#E0E0E0');
          font('Helvetica', 5, '#777777');
          txt('N/A', ML + 5, niy + 3, { width: 26, align: 'center' });
          font('Helvetica', 6, '#999999');
          txt(naRun[nk].key, ML + 38, niy + 3, { width: 22 });
          txt(naRun[nk].item, ML + 62, niy + 3, { width: pw - 66, height: 7, ellipsis: true });
          setY(niy + 10);
        }
        ii = jj; continue;
      }

      // ── FIX 1: NO items — structured observation block ──
      if (it.state === 'no') {
        need(14);
        var noy = curY();
        // Full-width light red background
        rect(ML, noy, pw, 13, RED_LIGHT);
        // NO badge — larger, bold, white on dark red
        roundRect(ML + 4, noy + 1, 28, 10, 2, RED_BADGE);
        font('Helvetica-Bold', 6, WHITE);
        txt('NO', ML + 5, noy + 3, { width: 26, align: 'center' });
        font('Helvetica', 6.5, GRAY);
        txt(it.key, ML + 38, noy + 3, { width: 22 });
        font('Helvetica-Bold', 7, GRAY_DARK);
        txt(it.item, ML + 62, noy + 3, { width: pw - 66, height: 9, ellipsis: true });
        setY(noy + 14);

        // Observation block (structured fields or legacy fallback)
        var obs  = it.r.observation || '';
        var risk = it.r.risk_level || '';
        var corr = it.r.corrective_action || '';
        var resp = it.r.responsible || '';
        var rectified = it.r.rectified_on_site;
        var hasStructured = !!(obs || risk || corr || resp);

        if (hasStructured) {
          var indent = 10;
          var bx = ML + indent, bw = pw - indent;
          var fldH = 10;
          // Use measureText for accurate height, cap text blocks at 40px
          var obsH = obs ? Math.min(measureText(obs, bw - 16, 6.5) + 2, 40) : 0;
          var actH = corr ? Math.min(measureText(corr, bw - 16, 6.5) + 2, 40) : 0;
          var totalH = 6;
          if (obs) totalH += 8 + obsH;
          if (risk) totalH += fldH;
          if (corr) totalH += 8 + actH;
          if (resp) totalH += fldH;
          if (rectified !== undefined && rectified !== null && rectified !== '') totalH += fldH;
          totalH += 4;
          need(totalH);
          var bY = curY();
          roundRect(bx, bY, bw, totalH, 3, RED_BG);
          roundRect(bx, bY, 3, totalH, 1, RED);
          var cy2 = bY + 4;
          if (obs) {
            font('Helvetica-Bold', 5.5, BRAND_DARK);
            txt('OBSERVATION', bx + 8, cy2, { width: bw - 16 });
            cy2 += 8;
            doc.font('Helvetica').fontSize(6.5).fillColor(GRAY_DARK);
            doc.text(obs, bx + 8, cy2, { width: bw - 16, height: obsH, lineBreak: true, ellipsis: true });
            cy2 += obsH;
          }
          if (risk) {
            font('Helvetica-Bold', 5.5, BRAND_DARK);
            txt('RISK', bx + 8, cy2, { width: 22 });
            var rc = risk === 'Critical' ? RED : risk === 'High' ? '#DC2626' : risk === 'Medium' ? AMBER : GREEN;
            roundRect(bx + 30, cy2 - 1, 45, 8, 2, rc);
            font('Helvetica-Bold', 5, WHITE);
            txt(risk.toUpperCase(), bx + 32, cy2, { width: 41, align: 'center' });
            // Inline responsible + rectified on same line if present
            var inlineX = bx + 82;
            if (resp) {
              font('Helvetica-Bold', 5.5, BRAND_DARK);
              txt('RESP:', inlineX, cy2, { width: 25 });
              font('Helvetica', 6, GRAY_DARK);
              txt(resp, inlineX + 26, cy2, { width: 100 });
              inlineX += 130;
            }
            if (rectified !== undefined && rectified !== null && rectified !== '') {
              font('Helvetica-Bold', 5.5, BRAND_DARK);
              txt('RECTIFIED:', inlineX, cy2, { width: 40 });
              var rtext = rectified ? 'Yes' : 'No';
              font('Helvetica-Bold', 5.5, rectified ? GREEN : RED);
              txt(rtext, inlineX + 42, cy2, { width: 30 });
            }
            cy2 += fldH;
            resp = ''; rectified = ''; // already rendered inline
          }
          if (corr) {
            font('Helvetica-Bold', 5.5, BRAND_DARK);
            txt('ACTION', bx + 8, cy2, { width: bw - 16 });
            cy2 += 8;
            doc.font('Helvetica').fontSize(6.5).fillColor(GRAY_DARK);
            doc.text(corr, bx + 8, cy2, { width: bw - 16, height: actH, lineBreak: true, ellipsis: true });
            cy2 += actH;
          }
          if (resp) {
            font('Helvetica-Bold', 5.5, BRAND_DARK);
            txt('RESP:', bx + 8, cy2, { width: 25 });
            font('Helvetica', 6, GRAY_DARK);
            txt(resp, bx + 34, cy2, { width: bw - 44 });
            cy2 += fldH;
          }
          if (rectified !== undefined && rectified !== null && rectified !== '') {
            font('Helvetica-Bold', 5.5, BRAND_DARK);
            txt('RECTIFIED:', bx + 8, cy2, { width: 40 });
            var rtext2 = rectified ? 'Yes' : 'No — escalated';
            font('Helvetica-Bold', 5.5, rectified ? GREEN : RED);
            txt(rtext2, bx + 50, cy2, { width: bw - 60 });
            cy2 += fldH;
          }
          setY(bY + totalH + 2);
        } else if (it.r.notes && it.r.notes.trim()) {
          // Legacy fallback — red observation box for old audits
          var bx3 = ML + 10, bw3 = pw - 10;
          var notesH = Math.min(measureText(it.r.notes, bw3 - 16, 6.5) + 2, 40);
          var bH3 = 12 + notesH;
          need(bH3);
          var bY3 = curY();
          roundRect(bx3, bY3, bw3, bH3, 3, RED_BG);
          roundRect(bx3, bY3, 3, bH3, 1, RED);
          font('Helvetica-Bold', 5.5, BRAND_DARK);
          txt('OBSERVATION', bx3 + 8, bY3 + 3, { width: bw3 - 16 });
          doc.font('Helvetica').fontSize(6.5).fillColor(GRAY_DARK);
          doc.text(it.r.notes, bx3 + 8, bY3 + 11, { width: bw3 - 16, height: notesH, lineBreak: true, ellipsis: true });
          setY(bY3 + bH3 + 2);
        }
        // Item-specific photos for this NO finding
        embedImages(doc, a, ctxMap['item_' + it.key], null, pw, pageBot, ML, MT);
        ii++; continue;
      }

      // ── YES items — standard row ──
      var rowH = (it.r.notes && it.r.notes.trim()) ? 20 : 12;
      need(rowH);
      var iy = curY();
      if (ii % 2 === 0) rect(ML, iy, pw, rowH, GRAY_BG);
      line(ML, iy + rowH, ML + pw, iy + rowH, '#F3F4F6', 0.3);
      roundRect(ML + 4, iy + 2, 28, 9, 2, GREEN);
      font('Helvetica-Bold', 5.5, WHITE);
      txt('YES', ML + 5, iy + 3.5, { width: 26, align: 'center' });
      font('Helvetica', 6.5, GRAY);
      txt(it.key, ML + 38, iy + 3, { width: 22 });
      font('Helvetica', 7, GRAY_DARK);
      txt(it.item, ML + 62, iy + 3, { width: pw - 66, height: 9, ellipsis: true });
      // Notes only if non-empty (don't render empty boxes)
      if (it.r.notes && it.r.notes.trim()) {
        font('Helvetica-Oblique', 6, GRAY_MED);
        txt('↳ ' + it.r.notes, ML + 62, iy + 12, { width: pw - 66, height: 7, ellipsis: true });
      }
      setY(iy + rowH);
      ii++;
    }

    // ── FIX 2: Section comments — bordered box, readable, navy label ──
    // Only render if there's actual comment text (don't render empty boxes)
    if (sectionComments[section.key] && sectionComments[section.key].trim()) {
      var cmtText = sectionComments[section.key];
      var cmtH = measureText(cmtText, pw - 24, 8);
      var boxH = Math.min(Math.max(cmtH + 22, 30), 80);
      need(boxH + 4);
      gap(3);
      var cmtY = curY();
      // Bordered box with light grey fill
      roundRect(ML, cmtY, pw, boxH, 4, COMMENT_BG);
      doc.save().roundedRect(ML, cmtY, pw, boxH, 4).strokeColor(COMMENT_BORDER).lineWidth(1).stroke().restore();
      // Left accent bar
      roundRect(ML, cmtY, 3, boxH, 1, BRAND);
      // Label: navy bold
      font('Helvetica-Bold', 7, BRAND_DARK);
      txt('COMMENTS', ML + 10, cmtY + 5, { width: 60 });
      // Comment body: 8pt, #333, regular weight, capped height
      doc.font('Helvetica').fontSize(8).fillColor(GRAY_DARK);
      doc.text(cmtText, ML + 10, cmtY + 17, { width: pw - 24, height: boxH - 20, lineBreak: true, ellipsis: true });
      setY(cmtY + boxH + 2);
    }

    // Section evidence images
    embedImages(doc, a, ctxMap['section_' + section.key], null, pw, pageBot, ML, MT);
    gap(6);
  });

  /* ═══════════════════════════════════════════════════════════
     NON-CONFORMANCE REGISTER
     ═══════════════════════════════════════════════════════════ */
  if (nonconformances && nonconformances.length) {
    need(50);
    gap(4);
    var ncHeaderY = curY();
    roundRect(ML, ncHeaderY, pw, 20, 4, RED);
    font('Helvetica-Bold', 9, WHITE);
    txt('Non-Conformance Register  (' + nonconformances.length + ')', ML + 8, ncHeaderY + 5, { width: pw - 16 });
    setY(ncHeaderY + 24);

    // Table header
    var thY = curY();
    rect(ML, thY, pw, 13, RED_BG);
    var ncCols = { n: 18, issue: 0, risk: 35, action: 0, resp: 50, due: 45, done: 28 };
    var ncFlex = Math.floor((pw - ncCols.n - ncCols.risk - ncCols.resp - ncCols.due - ncCols.done) / 2);
    ncCols.issue = ncFlex;
    ncCols.action = ncFlex;
    var headers = [
      { label: '#', w: ncCols.n },
      { label: 'Issue', w: ncCols.issue },
      { label: 'Risk', w: ncCols.risk },
      { label: 'Action Required', w: ncCols.action },
      { label: 'Responsible', w: ncCols.resp },
      { label: 'Due', w: ncCols.due },
      { label: 'Closed', w: ncCols.done },
    ];
    var hx = ML;
    headers.forEach(function (h) {
      font('Helvetica-Bold', 5.5, RED);
      txt(h.label, hx + 2, thY + 4, { width: h.w - 4 });
      hx += h.w;
    });
    setY(thY + 14);

    // NC rows
    nonconformances.forEach(function (nc, i) {
      need(14);
      var ry = curY();
      if (i % 2 === 0) rect(ML, ry, pw, 12, GRAY_BG);
      var cx = ML;
      var vals = [
        { v: String(i + 1), w: ncCols.n },
        { v: nc.issue || '—', w: ncCols.issue },
        { v: nc.risk || '—', w: ncCols.risk },
        { v: nc.action || '—', w: ncCols.action },
        { v: nc.responsible || '—', w: ncCols.resp },
        { v: nc.due_date || '—', w: ncCols.due },
        { v: nc.closed ? '✓ Yes' : '—', w: ncCols.done },
      ];
      vals.forEach(function (cell) {
        font('Helvetica', 6, GRAY_DARK);
        txt(cell.v, cx + 2, ry + 3, { width: cell.w - 4, height: 9, ellipsis: true });
        cx += cell.w;
      });
      setY(ry + 12);

      // NC evidence images
      embedImages(doc, a, ctxMap['nc_' + (i + 1)], null, pw, pageBot, ML, MT);
    });
    gap(6);
  }

  /* ═══════════════════════════════════════════════════════════
     SIGNATURES
     ═══════════════════════════════════════════════════════════ */
  if (a.auditor_signature_text || a.supervisor_signature_text) {
    // Reserve enough for the whole block (title + gap + two 52pt boxes + trailing gap)
    // so we don't start the section then overflow mid-box onto a new page.
    need(88);
    gap(4);
    line(ML, curY(), ML + pw, curY(), BRAND, 1);
    gap(6);
    font('Helvetica-Bold', 9, BRAND);
    txt('Sign-off', ML, curY(), { width: pw });
    gap(14);

    var sigY = curY();
    var sigW = (pw - 14) / 2;
    var sigH = 52;

    function drawSigBox(x, label, name, signedAt) {
      roundRect(x, sigY, sigW, sigH, 4, WHITE);
      rect(x, sigY, sigW, 2.5, BRAND);
      doc.save().roundedRect(x, sigY, sigW, sigH, 4).strokeColor(GRAY_LINE).lineWidth(0.5).stroke().restore();
      font('Helvetica-Bold', 6, GRAY);
      txt(label, x + 10, sigY + 7, { width: sigW - 20 });
      // Signature name — italic, sized to fit one line inside the box
      doc.font('Helvetica-Oblique').fontSize(14).fillColor(GRAY_DARK);
      txt(name, x + 10, sigY + 18, { width: sigW - 20 });
      doc.font('Helvetica');
      if (signedAt) {
        font('Helvetica', 6, GREEN);
        txt('Signed  ·  ' + fmtDate(signedAt), x + 10, sigY + 38, { width: sigW - 20 });
      }
    }

    if (a.auditor_signature_text) {
      drawSigBox(ML, 'AUDITOR', a.auditor_signature_text, a.auditor_signed_at);
    }
    if (a.supervisor_signature_text) {
      drawSigBox(ML + sigW + 14, 'SUPERVISOR / STMS', a.supervisor_signature_text, a.supervisor_signed_at);
    }
    setY(sigY + sigH + 6);
  }

  // ── Annotated TGS ──
  embedImages(doc, a, ctxMap['annotated_tgs'], 'Annotated TGS / Close-out Sketch', pw, pageBot, ML, MT);

  /* ═══════════════════════════════════════════════════════════
     FOOTER — Created by + Internal Sign-off
     ═══════════════════════════════════════════════════════════ */
  gap(10);
  need(50);
  line(ML, curY(), ML + pw, curY(), GRAY_LINE, 0.5);
  gap(6);

  // Created by
  font('Helvetica', 6.5, GRAY);
  txt('Created by  ' + (a.created_by_name || '—') + '  ·  ' + fmtDate(a.created_at), ML, curY(), { width: pw });
  gap(10);

  // Internal sign-off
  if (a.signed_off_by_name) {
    var soY = curY();
    var soH = 32;
    roundRect(ML, soY, pw, soH, 5, GREEN_BG);
    // Left green accent
    roundRect(ML, soY, 4, soH, 2, GREEN);
    // Check icon area
    roundRect(ML + 14, soY + 8, 16, 16, 8, GREEN);
    font('Helvetica-Bold', 10, WHITE);
    txt('✓', ML + 17, soY + 11, { width: 12, align: 'center' });
    // Text
    font('Helvetica-Bold', 7, GREEN);
    txt('INTERNALLY SIGNED OFF', ML + 38, soY + 8, { width: pw - 46 });
    font('Helvetica', 7.5, GRAY_DARK);
    txt(a.signed_off_by_name + '  ·  ' + fmtDate(a.signed_off_at), ML + 38, soY + 19, { width: pw - 46 });
    setY(soY + soH + 4);
  }

  /* ═══════════════════════════════════════════════════════════
     PAGE NUMBERS + FOOTER BAR
     ═══════════════════════════════════════════════════════════ */
  var range = doc.bufferedPageRange();
  var totalPages = range.count;
  for (var p = range.start; p < range.start + totalPages; p++) {
    doc.switchToPage(p);
    // The footer writes inside the bottom margin. PDFKit auto-paginates when
    // text is drawn past pageBot with a width set (even with lineBreak:false),
    // which previously spawned a blank trailing page per existing page.
    // Drop the margin for these writes; the document ends right after.
    doc.page.margins.bottom = 0;
    // Bottom brand line
    line(ML, ph - MB + 10, ML + pw, ph - MB + 10, GRAY_LINE, 0.3);
    // Footer text
    font('Helvetica', 5.5, GRAY);
    txt('Atomis  ·  Site Audit #' + a.id + '  ·  Confidential',
      ML, ph - MB + 14, { width: pw - 50 });
    font('Helvetica', 5.5, GRAY);
    txt('Page ' + (p + 1) + ' of ' + totalPages,
      ML + pw - 50, ph - MB + 14, { width: 50, align: 'right' });
    // Top brand bar on every page (except first which already has it)
    if (p > range.start) {
      rect(0, 0, doc.page.width, 3, BRAND);
    }
  }

  doc.end();
}


/* ════════════════════════════════════════════════════════
   Image grid — compact evidence thumbnails, 3 per row
   Bigger than tiny postage stamps, but not page-eating monsters.
   ════════════════════════════════════════════════════════ */
function embedImages(doc, audit, items, label, pw, pageBot, ml, mt) {
  if (!items || !items.length) return;

  var images = [];
  items.forEach(function (att) {
    if (!(att.mime_type || '').startsWith('image/')) return;
    var fp = path.join(__dirname, '..', 'data', 'uploads', 'audits', String(audit.id), att.filename);
    if (fs.existsSync(fp)) images.push({ att: att, fp: fp });
  });
  if (!images.length) return;

  // Section label
  if (label) {
    if (doc.y + 18 > pageBot) doc.addPage();
    doc.y += 4;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(GRAY);
    doc.text(label, ml, doc.y, { lineBreak: false });
    doc.font('Helvetica');
    doc.y += 10;
  }

  // 3 per row, reasonable size (~155x105), with captions
  var gutter = 6;
  var cols = images.length <= 2 ? images.length : 3;
  var tw = Math.floor((pw - gutter * (cols - 1)) / cols);
  var th = Math.floor(tw * 0.68);
  var captionH = 9;
  var col = 0, rowY = doc.y;

  images.forEach(function (img) {
    if (col >= cols) { col = 0; rowY += th + captionH + gutter; }
    if (col === 0 && rowY + th + captionH > pageBot) { doc.addPage(); rowY = doc.y; }
    var ix = ml + col * (tw + gutter);

    // Light border
    doc.save().roundedRect(ix, rowY, tw, th, 2).strokeColor('#E5E7EB').lineWidth(0.5).stroke().restore();

    try {
      doc.image(img.fp, ix + 1, rowY + 1, { fit: [tw - 2, th - 2], align: 'center', valign: 'center' });
    } catch (e) { /* skip corrupt image */ }

    // Caption
    if (img.att.caption) {
      doc.font('Helvetica').fontSize(5).fillColor(GRAY);
      doc.text(img.att.caption, ix, rowY + th + 1, { width: tw, lineBreak: false, height: 7, ellipsis: true });
    }
    col++;
  });
  doc.y = rowY + th + (images[images.length - 1] && images[images.length - 1].att.caption ? captionH : gutter) + gutter;
  doc.x = ml;
}


module.exports = { generateAuditPdf };
