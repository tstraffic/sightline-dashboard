// ROL / ROLA PDF auto-extraction (Plans Module, spec §8 Phase 2).
//
// The NSW TfNSW licence layout is consistent (LICENCE NO, LICENCE DURATION,
// APPROVED DATES & TIMES, LICENCE CONDITIONS), so we reconstruct text lines
// from pdfjs positional data and regex the known anchors. Parsing is
// best-effort by design — the result feeds a "review & confirm" screen where
// the user corrects anything before it is saved.
const fs = require('fs');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const DOW = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const ALERT_RE = /(prior to works|must contact|contact the following|late start|no works|long weekend|kings birthday)/i;
// A single approved-ROL shift row (no year): "Thu 21 May 22:00 - Fri 22 May 05:00"
const ROL_SHIFT_RE = new RegExp(`${DOW}\\s+(\\d{1,2})\\s+([A-Z][a-z]{2})\\s+(\\d{1,2}:\\d{2})\\s*[-–]\\s*${DOW}\\s+(\\d{1,2})\\s+([A-Z][a-z]{2})\\s+(\\d{1,2}:\\d{2})`, 'g');
// A ROLA requested-times row (with year): "Mon 18 May 2026 19:00 Tue 19 May 2026 05:00"
const ROLA_SHIFT_RE = new RegExp(`${DOW}\\s+(\\d{1,2})\\s+([A-Z][a-z]{2})\\s+(\\d{4})\\s+(\\d{1,2}:\\d{2})\\s+${DOW}\\s+(\\d{1,2})\\s+([A-Z][a-z]{2})\\s+(\\d{4})\\s+(\\d{1,2}:\\d{2})`, 'g');

// Reconstruct page text as ordered lines using item y/x positions.
async function extractLines(absPath) {
  const data = new Uint8Array(fs.readFileSync(absPath));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const byY = {};
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      (byY[y] = byY[y] || []).push({ x: it.transform[4], s: it.str });
    }
    const lines = Object.keys(byY).map(Number).sort((a, b) => b - a)
      .map(y => byY[y].sort((a, b) => a.x - b.x).map(o => o.s).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    pages.push(lines);
  }
  return pages;
}

function isoFrom(day, monName, year) {
  const mm = MONTHS[monName];
  if (!mm) return null;
  return `${year}-${mm}-${String(parseInt(day, 10)).padStart(2, '0')}`;
}

function summarise(shifts) {
  const dates = shifts.map(s => s.start_date).filter(Boolean).sort();
  const ends = shifts.map(s => s.end_date).filter(Boolean).sort();
  const times = {};
  shifts.forEach(s => { const k = `${s.start_time}-${s.end_time}`; times[k] = (times[k] || 0) + 1; });
  const common = Object.keys(times).sort((a, b) => times[b] - times[a])[0] || '';
  return {
    from: dates[0] || null,
    to: ends[ends.length - 1] || null,
    timeWindow: common ? common.replace('-', '–') + (shifts.length > 1 ? ' (typical)' : '') : ''
  };
}

// Parse an issued ROL licence PDF.
function parseIssuedRol(allLines) {
  const flat = allLines.flat();
  const joined = flat.join('\n');
  const out = { docType: 'rol', licenceNumber: '', from: null, to: null, shifts: [], conditions: [] };

  const mNo = joined.match(/LICENCE NO\s*:?\s*(\d{4,})/i);
  if (mNo) out.licenceNumber = mNo[1];

  // Licence duration → infer year for the approved-dates table (no year there)
  const mFrom = joined.match(/From:\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  const mTo = joined.match(/To:\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  let baseYear = mFrom ? parseInt(mFrom[3], 10) : new Date().getFullYear();
  let startMonthNum = mFrom ? parseInt(MONTHS[mFrom[2]] || '1', 10) : 1;
  if (mFrom) out.from = isoFrom(mFrom[1], mFrom[2], mFrom[3]);
  if (mTo) out.to = isoFrom(mTo[1], mTo[2], mTo[3]);

  // Shifts: process per line so regex \s can never bleed across line breaks.
  // The licence + SZA pages repeat the same table, so dedup on the full key.
  const seen = new Set();
  for (const line of flat) {
    ROL_SHIFT_RE.lastIndex = 0;
    let m;
    while ((m = ROL_SHIFT_RE.exec(line)) !== null) {
      const [, sd, sMon, st, ed, eMon, et] = m;
      const sYear = (parseInt(MONTHS[sMon] || '1', 10) < startMonthNum) ? baseYear + 1 : baseYear;
      const eYear = (parseInt(MONTHS[eMon] || '1', 10) < startMonthNum) ? baseYear + 1 : baseYear;
      const startDate = isoFrom(sd, sMon, sYear), endDate = isoFrom(ed, eMon, eYear);
      const key = `${startDate} ${st} ${endDate} ${et}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.shifts.push({ source: 'rol', start_date: startDate, start_time: st, end_date: endDate, end_time: et });
    }
  }

  // Licence conditions: numbered list. The two-column page layout merges the
  // right-hand approved-dates table into condition lines, so strip shift rows
  // and table headers before accumulating. Lines wrap, so append until the
  // next number or a section break.
  let inConditions = false, current = null;
  const pushCurrent = () => { if (current && current.text.trim()) out.conditions.push({ condition_no: current.no, text: current.text.replace(/\s+/g, ' ').trim(), is_alert: ALERT_RE.test(current.text) ? 1 : 0 }); current = null; };
  const stripTable = (s) => s.replace(ROL_SHIFT_RE, ' ').replace(/From Shift|To Shift|From D M Time|To D M Time/gi, ' ').replace(/\s+/g, ' ').trim();
  for (const raw of flat) {
    if (/LICENCE CONDITIONS/i.test(raw)) { inConditions = true; continue; }
    if (!inConditions) continue;
    if (/All pages of this|Page \d+ of|SPEED ZONE AUTH/i.test(raw)) { pushCurrent(); inConditions = false; continue; }
    const line = stripTable(raw);
    if (!line) continue;
    const mNum = line.match(/^(\d{1,2})\s+(.*)$/);
    if (mNum && parseInt(mNum[1], 10) >= 1 && parseInt(mNum[1], 10) <= 40 && /[A-Za-z]/.test(mNum[2])) {
      pushCurrent();
      current = { no: parseInt(mNum[1], 10), text: mNum[2] };
    } else if (current) {
      current.text += ' ' + line;
    }
  }
  pushCurrent();

  const sum = summarise(out.shifts);
  out.summaryFrom = sum.from || out.from;
  out.summaryTo = sum.to || out.to;
  out.timeWindow = sum.timeWindow;
  return out;
}

// Parse a ROLA application PDF.
function parseRola(allLines) {
  const flat = allLines.flat();
  const joined = flat.join('\n');
  const out = { docType: 'rola', applicationNumber: '', shifts: [], conditions: [] };

  const mApp = joined.match(/Application\s*#?\s*(\d{4,})/i) || joined.match(/ROL\s*(\d{5,})/i);
  if (mApp) out.applicationNumber = mApp[1];

  // ROLA rows include the year: "Mon 18 May 2026 19:00 Tue 19 May 2026 05:00".
  // Process per line; the SZA-times page repeats the table, so dedup full key.
  const seen = new Set();
  for (const line of flat) {
    ROLA_SHIFT_RE.lastIndex = 0;
    let m;
    while ((m = ROLA_SHIFT_RE.exec(line)) !== null) {
      const [, sd, sMon, sy, st, ed, eMon, ey, et] = m;
      const startDate = isoFrom(sd, sMon, sy), endDate = isoFrom(ed, eMon, ey);
      const key = `${startDate} ${st} ${endDate} ${et}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.shifts.push({ source: 'rola', start_date: startDate, start_time: st, end_date: endDate, end_time: et });
    }
  }
  const sum = summarise(out.shifts);
  out.summaryFrom = sum.from;
  out.summaryTo = sum.to;
  out.timeWindow = sum.timeWindow;
  return out;
}

// Public entry point. force = 'rol' | 'rola' to override auto-detection.
async function parseRolPdf(absPath, force) {
  const pages = await extractLines(absPath);
  const joined = pages.flat().join('\n');
  let docType = force;
  if (!docType) {
    // The ROLA also references a licence number, so detect on application
    // markers, which the issued licence never carries.
    docType = /APPLICATION\s+FORM|entered online|Requested Speed Zone Times|Submitted by/i.test(joined)
      ? 'rola' : 'rol';
  }
  return docType === 'rola' ? parseRola(pages) : parseIssuedRol(pages);
}

module.exports = { parseRolPdf };
