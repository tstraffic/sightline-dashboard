// Thin pdf-lib wrapper: concatenate a list of PDF buffers into one.

'use strict';

const { PDFDocument } = require('pdf-lib');

async function mergePdfs(buffers) {
  const out = await PDFDocument.create();
  for (const buf of buffers) {
    if (!buf || !buf.length) continue;
    const src = await PDFDocument.load(buf, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach(p => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

module.exports = { mergePdfs };
