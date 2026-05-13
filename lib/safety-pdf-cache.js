// Inline PDF viewing for the worker portal — render each PDF page to a PNG
// on disk and serve those instead of an iframe. Mobile Safari + standalone
// PWAs + future WKWebView wrappers all handle <img> stacks natively, where
// they can't scroll inside an <iframe src=".pdf">.
//
// Wraps lib/pdf-render.js. Caches per "scope" (swms / sop / safety_update /
// toolbox / hr_tfn) and per cacheKey (typically the SWMS/SOP version_token
// or an mtime hash for attachments without versioning). When the cacheKey
// changes — e.g. admin replaces a SWMS file — the old dir is deleted and a
// fresh render runs.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { renderPdfToPngs } = require('./pdf-render');

// Co-located under data/uploads so Railway's persistent volume mount covers
// it. Leading dot keeps it out of any naive recursive uploads scans.
const CACHE_ROOT = path.join(__dirname, '..', 'data', 'uploads', '.pdf-pages');

// In-memory render lock: if two requests hit the same uncached SWMS at the
// same moment, the second awaits the first's promise instead of double-
// rendering. Keyed by scope:id:cacheKey.
const inflight = new Map();

const VALID_SCOPES = new Set(['swms', 'sop', 'safety_update', 'toolbox', 'hr_tfn']);

function isRenderable(originalName) {
  if (!originalName) return false;
  return path.extname(String(originalName)).toLowerCase() === '.pdf';
}

// mtime-based cacheKey for files that lack a version_token. We hash mtime +
// size so a file replaced in-place (same path) busts the cache too.
function fileStatHash(absPath) {
  try {
    const st = fs.statSync(absPath);
    const h = crypto.createHash('md5').update(st.mtimeMs + ':' + st.size).digest('hex');
    return 'm' + h.slice(0, 10);
  } catch (e) {
    return 'm0';
  }
}

function safeKey(s) {
  return String(s || 'none').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

function cacheDirFor(scope, id, cacheKey) {
  return path.join(CACHE_ROOT, scope, `${id}-${safeKey(cacheKey)}`);
}

function doneSentinel(dir) {
  return path.join(dir, '.done');
}

// Delete sibling dirs for this id that don't match the current cacheKey —
// they represent a previous render of an older version of the file.
function evictStaleSiblings(scope, id, currentCacheKey) {
  const scopeDir = path.join(CACHE_ROOT, scope);
  if (!fs.existsSync(scopeDir)) return;
  const keep = `${id}-${safeKey(currentCacheKey)}`;
  let entries;
  try { entries = fs.readdirSync(scopeDir); } catch (e) { return; }
  for (const name of entries) {
    if (!name.startsWith(`${id}-`)) continue;
    if (name === keep) continue;
    const dead = path.join(scopeDir, name);
    try { fs.rmSync(dead, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

function countRenderedPages(dir) {
  if (!fs.existsSync(doneSentinel(dir))) return 0;
  let files;
  try { files = fs.readdirSync(dir); } catch (e) { return 0; }
  // Count page-N.png matches; the renderer also produces other artefacts so
  // we don't just trust readdir.length.
  let max = 0;
  for (const f of files) {
    const m = f.match(/^page-(\d+)\.png$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// Synchronously check if a cache directory is already populated. Used by
// the GET /pages handler to decide "ready now?" vs "render in flight".
function snapshot({ scope, id, cacheKey }) {
  if (!VALID_SCOPES.has(scope)) throw new Error('invalid scope ' + scope);
  const dir = cacheDirFor(scope, id, cacheKey);
  const count = countRenderedPages(dir);
  const lockKey = `${scope}:${id}:${safeKey(cacheKey)}`;
  return { dir, count, ready: count > 0, inflight: inflight.has(lockKey) };
}

// Kick off a render if needed. Returns a Promise that resolves with the
// final snapshot. Idempotent — concurrent callers share a Promise.
function ensureRendered({ scope, id, cacheKey, absPdfPath }) {
  if (!VALID_SCOPES.has(scope)) return Promise.reject(new Error('invalid scope ' + scope));
  if (!absPdfPath || !fs.existsSync(absPdfPath)) {
    return Promise.reject(new Error('source PDF not found at ' + absPdfPath));
  }
  const dir = cacheDirFor(scope, id, cacheKey);
  const lockKey = `${scope}:${id}:${safeKey(cacheKey)}`;

  // Already done — short-circuit. evictStaleSiblings still runs so we don't
  // accumulate junk after a version bump that happened to land on the same
  // count via a hit.
  if (fs.existsSync(doneSentinel(dir))) {
    evictStaleSiblings(scope, id, cacheKey);
    return Promise.resolve(snapshot({ scope, id, cacheKey }));
  }

  // Already rendering — return the existing promise.
  if (inflight.has(lockKey)) return inflight.get(lockKey);

  const p = (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const files = await renderPdfToPngs(absPdfPath, dir, { scale: 1.7 });
      // The renderer outputs <basename>__page_N.png. Rename to page-N.png so
      // route handlers can predict the filename without knowing the source
      // basename.
      for (let i = 1; i <= files.length; i++) {
        const src = path.join(dir, files[i - 1]);
        const dst = path.join(dir, `page-${i}.png`);
        if (src !== dst) {
          try { fs.renameSync(src, dst); } catch (e) { /* if already at dst, fine */ }
        }
      }
      fs.writeFileSync(doneSentinel(dir), String(Date.now()));
      evictStaleSiblings(scope, id, cacheKey);
      return snapshot({ scope, id, cacheKey });
    } catch (err) {
      // Don't leave a half-rendered dir behind — next visit will retry cleanly.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
      throw err;
    } finally {
      inflight.delete(lockKey);
    }
  })();

  inflight.set(lockKey, p);
  return p;
}

function getPagePath(scope, id, cacheKey, n) {
  return path.join(cacheDirFor(scope, id, cacheKey), `page-${n}.png`);
}

module.exports = {
  isRenderable,
  fileStatHash,
  snapshot,
  ensureRendered,
  getPagePath,
};
