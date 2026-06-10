/**
 * Invoice docket PDF — renders every Traffio docket consumed by an invoice
 * into one PDF (one docket per page), mirroring the T&S works-docket layout:
 * job header, docket number, sign-off line, per-person hours table.
 *
 * Used as the QuickBooks attachment: clients dispute invoices against the
 * docket evidence, so the push attaches this automatically when no PDF has
 * been stored yet. Data comes from the traffio_dockets / traffio_docket_persons
 * staging tables (API sync or CSV import) — when Traffio's own signed PDF
 * becomes fetchable via API, that should replace this generated fallback.
 */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');

const GRAY_DARK = '#1F2937';
const GRAY_MED  = '#4B5563';
const GRAY      = '#6B7280';
const GRAY_LINE = '#E5E7EB';
const GRAY_BG   = '#F9FAFB';
const GREEN     = '#059669';
const AMBER     = '#D97706';
const ML = 50, MR = 50, MT = 50;

const OUT_DIR = path.join(__dirname, '..', 'data', 'uploads', 'invoice-dockets');

function timePart(dt) {
  const m = String(dt || '').match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '—';
}
function datePart(dt) {
  const s = String(dt || '').slice(0, 10);
  if (!s) return '—';
  try { return new Date(s + 'T00:00:00').toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (e) { return s; }
}

/**
 * Generate (or regenerate) the docket PDF for an invoice and record it on
 * invoices.docket_pdf_path/_name. Returns { path, name, dockets }.
 * Throws when the invoice has no dockets to render.
 */
function generateInvoiceDocketPdf(invoiceId) {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
  if (!invoice) throw new Error('Invoice not found.');
  const dockets = db.prepare(`
    SELECT * FROM traffio_dockets WHERE invoice_id = ? ORDER BY booking_start_time
  `).all(invoiceId);
  if (!dockets.length) throw new Error('No dockets are linked to this invoice.');
  const personsFor = db.prepare(`
    SELECT * FROM traffio_docket_persons WHERE works_docket_id = ? AND is_deleted = 0 ORDER BY last_name, first_name
  `);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fileName = `invoice-${invoiceId}-dockets.pdf`;
  const filePath = path.join(OUT_DIR, fileName);

  const doc = new PDFDocument({ size: 'A4', margins: { top: MT, bottom: 60, left: ML, right: MR } });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  const pageW = doc.page.width - ML - MR;

  dockets.forEach((d, idx) => {
    if (idx > 0) doc.addPage();
    const persons = personsFor.all(d.works_docket_id);

    // Header
    doc.font('Helvetica-Bold').fontSize(18).fillColor(GRAY_DARK)
      .text('WORKS DOCKET', ML, MT, { width: pageW, align: 'right' });
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
      .text('T&S Traffic Control Pty Ltd', ML, MT + 24, { width: pageW, align: 'right' })
      .text(`Generated from Atomis · Invoice ${invoice.invoice_number || ('draft #' + invoice.id)}`, { width: pageW, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GRAY_DARK).text('T&S', ML, MT);

    // Job block
    let y = MT + 60;
    const line = (label, value, bold) => {
      if (!value) return;
      doc.font('Helvetica').fontSize(10).fillColor(GRAY_MED).text(label + ': ', ML, y, { continued: true })
        .font(bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(GRAY_DARK).text(String(value));
      y = doc.y + 2;
    };
    line('Ticket / Job', d.job_number || d.works_docket_number || d.works_docket_id, true);
    line('Docket number', d.works_docket_number);
    line('Client', d.client_name, true);
    line('Billing reference', d.billing_reference);
    line('Site', d.address);
    line('Date', datePart(d.booking_start_time), true);
    line('Booking window', `${timePart(d.booking_start_time)} – ${timePart(d.approx_booking_end_time)}`);

    // Sign-off line
    y += 6;
    if (d.signed_off) {
      const by = d.signed_off_by_name ? ` by ${d.signed_off_by_name}` : '';
      const at = d.signed_off_at ? ` on ${datePart(d.signed_off_at)}` : '';
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GREEN).text(`Signed off${at}${by}`, ML, y);
    } else {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(AMBER).text('Not signed off in Traffio at time of generation', ML, y);
    }
    y = doc.y + 14;

    // Person hours table
    const cols = [
      { label: 'Crew member', w: 0.30, align: 'left' },
      { label: 'Role', w: 0.18, align: 'left' },
      { label: 'Start', w: 0.10, align: 'right' },
      { label: 'Finish', w: 0.10, align: 'right' },
      { label: 'Break', w: 0.10, align: 'right' },
      { label: 'Travel', w: 0.10, align: 'right' },
      { label: 'Total hrs', w: 0.12, align: 'right' },
    ];
    const rowH = 20;
    const drawRow = (cells, opts) => {
      const { bold, bg } = opts || {};
      if (bg) doc.rect(ML, y, pageW, rowH).fill(bg);
      let x = ML;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(bold ? GRAY_DARK : GRAY_MED);
      cells.forEach((c, i) => {
        const w = cols[i].w * pageW;
        doc.text(String(c), x + 4, y + 6, { width: w - 8, align: cols[i].align, lineBreak: false });
        x += w;
      });
      y += rowH;
      doc.moveTo(ML, y).lineTo(ML + pageW, y).strokeColor(GRAY_LINE).lineWidth(0.5).stroke();
    };

    drawRow(cols.map(c => c.label), { bold: true, bg: GRAY_BG });
    let totalHours = 0;
    for (const p of persons) {
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || `Person ${p.person_id}`;
      const hrs = Number(p.total_hours) || 0;
      totalHours += hrs;
      drawRow([
        name,
        p.resource_name || 'TC',
        timePart(p.time_on),
        timePart(p.time_off),
        (Number(p.break_time) || 0).toFixed(2),
        (Number(p.travel_time) || 0).toFixed(2),
        hrs.toFixed(2),
      ]);
      if (y > doc.page.height - 110) { doc.addPage(); y = MT; }
    }
    drawRow(['Total', '', '', '', '', '', totalHours.toFixed(2)], { bold: true, bg: GRAY_BG });

    // Footer note
    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
      .text(`Docket ${idx + 1} of ${dockets.length} on this invoice · Hours as recorded in Traffio`, ML, doc.page.height - 80, { width: pageW });
  });

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => {
      db.prepare('UPDATE invoices SET docket_pdf_path = ?, docket_pdf_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(filePath, fileName, invoiceId);
      resolve({ path: filePath, name: fileName, dockets: dockets.length });
    });
    stream.on('error', reject);
  });
}

module.exports = { generateInvoiceDocketPdf };
