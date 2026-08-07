#!/usr/bin/env node
/**
 * scripts/check-contract-layout.js — layout guard for the employment
 * agreement PDF.
 *
 * A contract is a legal document that goes to a new hire and (potentially)
 * to a tribunal. A heading stranded alone at the foot of a page reads as
 * sloppy and, worse, makes it look like a clause is missing. This renders
 * both the unsigned and signed variants and fails if ANY page ends on a
 * heading with nothing under it.
 *
 * Run after touching lib/contractTemplate.js or services/contractPdf.js:
 *   npm run check:contract
 *
 * It caught the real thing once already: "A3 — Allowances" alone at the
 * bottom of page 8. Keep it passing.
 */
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const tpl = require(path.join(REPO, 'lib', 'contractTemplate'));
const { renderContractPdf } = require(path.join(REPO, 'services', 'contractPdf'));

const FIELDS = {
  WORKER_FULL_NAME: 'Layout Check', WORKER_DOB: '1990-01-01',
  WORKER_DOB_DISPLAY: '01 Jan 1990', WORKER_ADDRESS: '1 Example Street, Greenacre, NSW, 2190',
  WORKER_MOBILE: '0400 000 000', WORKER_EMAIL: 'layout@example.com',
  START_DATE: '2026-08-17', START_DATE_DISPLAY: '17 Aug 2026', OFFER_DATE: '07 Aug 2026',
  TIER: '2', POSITION_TITLE: 'Traffic Controller', REPORTS_TO: 'the Operations Manager',
  WORK_AREA: 'the Sydney metropolitan area and surrounding regions of NSW',
  MIN_ENGAGEMENT: '4', CANCELLATION_NOTICE: '12 hours', TS_CANCELLATION_NOTICE: '4 hours',
  PAY_FREQUENCY: 'weekly', RATES_EFFECTIVE_DATE: tpl.RATES_EFFECTIVE,
  BOOKING_SYSTEM: 'the T&S booking system', FIRST_AID_STD: '4.03',
  SUPER_FUND_NAME: 'AustralianSuper', SUPER_MEMBER_NUMBER: '12345678',
  TS_SIGNATORY_NAME: 'Director Name', TS_SIGNATORY_POSITION: 'Director',
  SIGNED_AT_DISPLAY: '07/08/2026 14:02 (AEST/AEDT)',
  RATES_SNAPSHOT: tpl.ratesSnapshot(),
};

// Every line that must be followed by content on the same page.
const HEADINGS = [
  /^\d+\.\s{1,3}\S/,            // numbered clause headings
  /^A\d — /,                    // Schedule A sub-headings
  /^How penalties apply:$/,
  /^SCHEDULE [AB] — /,
  /^Employee$/,
  /^For and on behalf of/,
  /^SIGNATURE$/,
  /^CASUAL EMPLOYMENT AGREEMENT$/,
];

function contractFor(signed) {
  return {
    id: 0, agreement_number: 'TSEA-CHECK', version: 1,
    status: signed ? 'signed' : 'draft',
    signed_at: '2026-08-07 04:02:00', signed_name_typed: 'Layout Check',
    signer_ip: '203.0.113.44',
    signer_user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1',
    sent_to_email: 'layout@example.com', signature_path: null,
  };
}

async function checkVariant(pdfjsLib, signed) {
  const acks = signed ? tpl.ACKNOWLEDGEMENTS.map(a => ({
    ack_key: a.key, ack_label: tpl.toPlain(a.label),
    ticked_at_client: '2026-08-07T04:01:55Z', recorded_at: '2026-08-07 04:02:00', ip: '203.0.113.44',
  })) : [];
  const buf = await renderContractPdf(contractFor(signed), FIELDS, acks);
  // verbosity 0 — we only read glyph positions, so pdfjs's missing
  // standard-font warnings are noise that would bury a real failure.
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;

  const orphans = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    const rows = {};
    for (const it of tc.items) {
      const y = Math.round(it.transform[5]);
      (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str });
    }
    const lines = Object.keys(rows).map(Number).sort((a, b) => b - a)
      .map(y => ({ y, text: rows[y].sort((a, b) => a.x - b.x).map(i => i.s).join(' ').replace(/\s+/g, ' ').trim() }))
      .filter(l => l.text && l.y > 40);            // exclude the footer band
    const last = lines[lines.length - 1];
    if (last && HEADINGS.some(re => re.test(last.text))) {
      orphans.push({ page: p, of: doc.numPages, text: last.text });
    }
  }
  return { pages: doc.numPages, orphans };
}

(async () => {
  const pdfjsLib = require(path.join(REPO, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.js'));
  let failed = 0;
  for (const signed of [false, true]) {
    const label = signed ? 'signed  ' : 'unsigned';
    const { pages, orphans } = await checkVariant(pdfjsLib, signed);
    if (orphans.length) {
      failed += orphans.length;
      for (const o of orphans) console.error(`  ${label} — page ${o.page}/${o.of} ends on heading: "${o.text}"`);
    }
    console.log(`check-contract-layout: ${label} — ${pages} pages, ${orphans.length ? orphans.length + ' ORPHAN(S)' : 'no dangling headings'}`);
  }
  if (failed) {
    console.error(`\ncheck-contract-layout: FAIL — ${failed} heading(s) stranded at a page foot.`);
    console.error('Give the heading more keep-with-next room in services/contractPdf.js (blockHeading / sectionHeading).');
    process.exit(1);
  }
  console.log('check-contract-layout: PASS');
})().catch(e => { console.error('check-contract-layout: ERROR —', e.message); process.exit(2); });
