// Server-side .docx / .doc / .pptx / .xlsx → PDF conversion using
// LibreOffice in headless mode. The admin uploads Word docs for SWMS / SOPs
// / toolbox slides (easier to edit when policies change); workers need PDFs
// because the in-browser pdfjs viewer can only render PDFs.
//
// Conversion is cached per scope:id:cacheKey under data/uploads/.docx-pdf/.
// cacheKey is normally the source SWMS/SOP version_token (rotates on file
// replace, so the cache busts automatically). For attachments without a
// versioning concept (safety updates, toolbox slides) callers can pass an
// mtime-derived hash via fileStatHash().
//
// LibreOffice required: apt-get install libreoffice-core libreoffice-writer
// libreoffice-impress libreoffice-calc. The Railway build does this via
// nixpacks.toml at the repo root.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CACHE_ROOT = path.join(__dirname, '..', 'data', 'uploads', '.docx-pdf');

// Per-key promise lock so concurrent first-view requests for the same source
// don't fork two LibreOffice processes; the second await reuses the first's
// promise.
const inflight = new Map();

// Office file extensions LibreOffice can convert to PDF. We're explicit
// rather than "anything not .pdf" so unexpected uploads (e.g. a stray .txt)
// don't get pushed through libreoffice.
const CONVERTIBLE_EXT = new Set([
  '.doc', '.docx', '.docm',
  '.ppt', '.pptx', '.pptm',
  '.xls', '.xlsx', '.xlsm',
  '.odt', '.ods', '.odp',
  '.rtf',
]);

function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

function isConvertible(originalName) {
  return CONVERTIBLE_EXT.has(extOf(originalName));
}

// mtime + size hash — fallback cacheKey when callers don't have a version_token.
function fileStatHash(absPath) {
  try {
    const st = fs.statSync(absPath);
    return 'm' + crypto.createHash('md5').update(st.mtimeMs + ':' + st.size).digest('hex').slice(0, 12);
  } catch (e) {
    return 'm0';
  }
}

function safeKey(s) {
  return String(s || 'none').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

function pdfPathFor(scope, id, cacheKey) {
  return path.join(CACHE_ROOT, safeKey(scope), String(id) + '-' + safeKey(cacheKey) + '.pdf');
}

// After a successful conversion, sweep sibling cache entries for the same
// scope/id that don't match the current cacheKey. Keeps disk usage bounded
// when admin replaces a SWMS file repeatedly.
function evictStaleSiblings(scope, id, currentCacheKey) {
  const scopeDir = path.join(CACHE_ROOT, safeKey(scope));
  if (!fs.existsSync(scopeDir)) return;
  const keep = String(id) + '-' + safeKey(currentCacheKey) + '.pdf';
  let entries;
  try { entries = fs.readdirSync(scopeDir); } catch (e) { return; }
  const prefix = String(id) + '-';
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.pdf')) continue;
    if (name === keep) continue;
    try { fs.rmSync(path.join(scopeDir, name), { force: true }); } catch (e) { /* best effort */ }
  }
}

// Run LibreOffice once. Resolves with the absolute path of the produced PDF.
// Each invocation gets its own UserInstallation profile dir under /tmp so
// concurrent runs don't fight over LibreOffice's exclusive profile lock.
function runLibreOffice(absSourcePath, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const profileDir = '/tmp/lo-' + crypto.randomBytes(6).toString('hex');
    const args = [
      '--headless',
      '--nologo',
      '--nocrashreport',
      '--nodefault',
      '--nolockcheck',
      '--norestore',
      '-env:UserInstallation=file://' + profileDir,
      '--convert-to', 'pdf',
      '--outdir', outDir,
      absSourcePath,
    ];
    const proc = spawn('libreoffice', args, { timeout: 120000 });
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += String(d); });
    proc.stderr.on('data', (d) => { stderr += String(d); });
    proc.on('error', (err) => reject(new Error('spawn libreoffice failed: ' + err.message)));
    proc.on('exit', (code, signal) => {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      if (signal) return reject(new Error('libreoffice killed by signal ' + signal));
      if (code !== 0) return reject(new Error('libreoffice exit code ' + code + ': ' + (stderr || stdout).slice(0, 500)));
      // LibreOffice writes <basename>.pdf into outDir, where <basename> is
      // the input filename with its extension replaced.
      const base = path.basename(absSourcePath).replace(/\.[^.]+$/, '');
      const produced = path.join(outDir, base + '.pdf');
      if (!fs.existsSync(produced)) {
        return reject(new Error('libreoffice exited 0 but PDF not found at ' + produced));
      }
      resolve(produced);
    });
  });
}

// Idempotent ensure-cached. Resolves with the absolute PDF path. Concurrent
// callers share the same inflight promise.
function ensureConverted({ scope, id, cacheKey, absSourcePath }) {
  if (!scope || !id) return Promise.reject(new Error('docx-to-pdf: scope+id required'));
  if (!absSourcePath || !fs.existsSync(absSourcePath)) {
    return Promise.reject(new Error('docx-to-pdf: source not found at ' + absSourcePath));
  }
  if (!isConvertible(absSourcePath)) {
    return Promise.reject(new Error('docx-to-pdf: not a convertible extension: ' + extOf(absSourcePath)));
  }
  const dest = pdfPathFor(scope, id, cacheKey);
  if (fs.existsSync(dest)) {
    // Cache hit — clean up any stale siblings opportunistically and return.
    evictStaleSiblings(scope, id, cacheKey);
    return Promise.resolve(dest);
  }
  const lockKey = scope + ':' + id + ':' + safeKey(cacheKey);
  if (inflight.has(lockKey)) return inflight.get(lockKey);

  const p = (async () => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmpDir = path.join(path.dirname(dest), '_tmp-' + crypto.randomBytes(4).toString('hex'));
    try {
      const produced = await runLibreOffice(absSourcePath, tmpDir);
      // Move into the canonical cache path. Use renameSync first; on
      // cross-device errors fall back to copy+unlink.
      try {
        fs.renameSync(produced, dest);
      } catch (e) {
        if (e.code === 'EXDEV') {
          fs.copyFileSync(produced, dest);
          try { fs.unlinkSync(produced); } catch (ee) { /* ignore */ }
        } else {
          throw e;
        }
      }
      evictStaleSiblings(scope, id, cacheKey);
      return dest;
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
      inflight.delete(lockKey);
    }
  })();

  inflight.set(lockKey, p);
  return p;
}

module.exports = {
  isConvertible,
  fileStatHash,
  pdfPathFor,
  ensureConverted,
};
