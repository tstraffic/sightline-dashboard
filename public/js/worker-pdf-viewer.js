// Worker-portal client-side PDF viewer.
//
// Renders an auth-gated PDF inline as a stack of canvas elements using
// pdfjs-dist, served same-origin from /vendor/pdfjs/. This sidesteps two
// production-breaking issues with the previous server-side render approach:
//
//   1. Node-canvas doesn't build on Railway's default Nixpacks (no cairo/pango),
//      so the server-side PDF→PNG path threw silently and the "Preparing…"
//      placeholder spun forever.
//   2. iOS Safari and standalone PWAs can't scroll inside <iframe src=".pdf">,
//      and the "open in new tab" download link strands the worker outside
//      the app shell with no back button.
//
// Auto-binds on DOMContentLoaded to every <div class="pdf-viewer" data-pdf-src="...">
// on the page. DOM contract:
//
//   <div class="pdf-viewer"
//        data-pdf-src="/w/safety/swms/123/file"     (required: PDF URL)
//        data-pdf-name="Some Doc.pdf"               (optional: download filename)
//        data-pdf-max-width="900"></div>            (optional: cap canvas width)
//
// On any failure (network, corrupt PDF, render exception) we render a clean
// fallback with an <a download> link so the worker can still save the file
// without leaving the PWA shell.

(function () {
  'use strict';

  var PDFJS_LIB_URL = '/vendor/pdfjs/legacy/build/pdf.min.js';
  var PDFJS_WORKER_URL = '/vendor/pdfjs/legacy/build/pdf.worker.min.js';
  // cmaps + standard_fonts let pdfjs render PDFs that reference standard
  // Type 1 fonts (Helvetica/Times/Courier) without embedding them, plus
  // anything using composite CJK fonts. Without these, half the Word/Acrobat
  // exports out there throw "Cannot read property of undefined" during
  // glyph mapping.
  var PDFJS_CMAP_URL = '/vendor/pdfjs/cmaps/';
  var PDFJS_FONTS_URL = '/vendor/pdfjs/standard_fonts/';
  // docx-preview (UMD) and its jszip dependency. Used when the file
  // extension is .doc/.docx — iOS Safari and pdfjs can't render Word docs.
  var DOCX_LIB_URL = '/vendor/docx-preview/docx-preview.min.js';
  var JSZIP_LIB_URL = '/vendor/jszip/jszip.min.js';

  var cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    var style = document.createElement('style');
    style.textContent = [
      '.pdfv-stack { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }',
      '.pdfv-page-wrap { position: relative; background: #fff; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06); overflow: hidden; min-height: 120px; }',
      '.pdfv-page { display: block; width: 100%; height: auto; }',
      '.pdfv-page-placeholder { display: flex; align-items: center; justify-content: center; min-height: 200px; color: #6b7280; font-size: 0.8rem; }',
      '.pdfv-loading { color: rgba(255,255,255,0.7); text-align: center; padding: 36px 14px; background: rgba(255,255,255,0.03); border: 1px dashed rgba(255,255,255,0.1); border-radius: 12px; font-size: 0.85rem; }',
      '.pdfv-loading .pdfv-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #2B7FFF; margin: 0 2px; animation: pdfv-pulse 1.2s infinite ease-in-out; }',
      '.pdfv-loading .pdfv-dot:nth-child(2) { animation-delay: 0.15s; }',
      '.pdfv-loading .pdfv-dot:nth-child(3) { animation-delay: 0.3s; }',
      '@keyframes pdfv-pulse { 0%,100% { opacity: 0.35; transform: scale(0.85); } 50% { opacity: 1; transform: scale(1); } }',
      '.pdfv-error { padding: 20px 16px; border-radius: 12px; background: rgba(244,63,94,0.10); border: 1px solid rgba(244,63,94,0.25); color: #fda4af; font-size: 0.85rem; text-align: center; }',
      '.pdfv-error a { color: #93C5FD; font-weight: 600; text-decoration: underline; display: inline-block; margin-top: 8px; }',
      '.pdfv-error .pdfv-err-detail { display: block; margin-top: 6px; color: rgba(253,164,175,0.7); font-size: 0.72rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }',
      /* docx-preview renders Word documents into a white card so the dark
         page background doesnt fight the doc layout. Override the librarys
         default styles to keep things consistent on mobile. */
      '.pdfv-docx-wrap { background: #fff; color: #111; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06); padding: 4px; overflow: hidden; }',
      '.pdfv-docx-wrap .docx-wrapper { background: transparent !important; padding: 0 !important; margin: 0 !important; }',
      '.pdfv-docx-wrap .docx-wrapper > section.docx { box-shadow: none !important; margin: 0 0 8px !important; max-width: 100% !important; width: auto !important; }',
      '.pdfv-docx-wrap .docx { width: 100% !important; min-height: auto !important; }',
      '.pdfv-docx-wrap img { max-width: 100% !important; height: auto !important; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // Generic UMD script loader — promise-cached so multiple viewers don't
  // reinject the same <script>.
  var scriptPromises = {};
  function loadScript(url) {
    if (scriptPromises[url]) return scriptPromises[url];
    scriptPromises[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete scriptPromises[url]; reject(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
    return scriptPromises[url];
  }

  function loadPdfjs() {
    if (window.pdfjsLib) {
      try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; } catch (e) {}
      return Promise.resolve(window.pdfjsLib);
    }
    return loadScript(PDFJS_LIB_URL).then(function () {
      var lib = window.pdfjsLib;
      if (!lib) throw new Error('pdfjsLib not defined after load');
      try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; } catch (e) {}
      return lib;
    });
  }

  function loadDocxLib() {
    // docx-preview needs JSZip available globally first.
    return loadScript(JSZIP_LIB_URL)
      .then(function () { return loadScript(DOCX_LIB_URL); })
      .then(function () {
        // docx-preview UMD exports onto window.docx in v0.3.x.
        var d = window.docx || window['docx-preview'] || null;
        if (!d || typeof d.renderAsync !== 'function') {
          throw new Error('docx-preview not available on window after load');
        }
        return d;
      });
  }

  function loadingHtml() {
    // Loader is a particle-ring driven by /js/worker-particles.js'
    // [data-loader] auto-attach. Inline width/height ensures the
    // canvas-side particle ring has a centre to track even before
    // text content fills the row.
    return '<div class="pdfv-loading"><span data-loader data-loader-radius="14" data-loader-color="#60A5FA" style="display:inline-block;width:36px;height:36px;vertical-align:middle;margin-right:8px;"></span>Loading document</div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function errorHtml(src, name, err) {
    var safeName = (name || 'document.pdf').replace(/"/g, '');
    var errLabel = '';
    if (err) {
      var errName = err.name || 'Error';
      var msg = String(err.message || err || '').slice(0, 200);
      errLabel = '<span class="pdfv-err-detail">' + escapeHtml(errName) + ': ' + escapeHtml(msg) + '</span>';
    }
    return [
      '<div class="pdfv-error">',
      "  Couldn't load the document inline.",
      '  <br>',
      '  <a href="', src, '" download="', safeName, '">Save the document</a>',
      errLabel,
      '</div>',
    ].join('');
  }

  function safeName(el, src) {
    var n = el.getAttribute('data-pdf-name');
    if (n) return n;
    try {
      var u = new URL(src, window.location.origin);
      var base = u.pathname.split('/').pop() || 'document.pdf';
      if (!/\.pdf$/i.test(base)) base += '.pdf';
      return base;
    } catch (e) { return 'document.pdf'; }
  }

  function pageWidthPx(container, maxWidth) {
    var w = container.clientWidth || 360;
    if (maxWidth && w > maxWidth) w = maxWidth;
    return w;
  }

  // Render one page into its wrapper element. Uses devicePixelRatio (capped
  // at 2x) for a crisp result without blowing out memory on huge docs.
  function renderPage(pdf, n, wrapEl, containerWidth) {
    return pdf.getPage(n).then(function (page) {
      var baseVp = page.getViewport({ scale: 1 });
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      var scale = (containerWidth / baseVp.width) * dpr;
      var vp = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.className = 'pdfv-page';
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      var ctx = canvas.getContext('2d');
      // Clear the placeholder + insert canvas.
      wrapEl.innerHTML = '';
      wrapEl.appendChild(canvas);
      return page.render({ canvasContext: ctx, viewport: vp }).promise;
    });
  }

  // Dispatch entry — fetches the document once, sniffs the first 4 bytes,
  // then picks the renderer based on the magic header. This works regardless
  // of what the filename extension says — the server-side docx→PDF conversion
  // means a /file URL named "*.docx" can actually return a PDF body, and
  // earlier-extension-based dispatch routed those into the wrong renderer.
  //   %PDF       -> pdfjs
  //   PK\x03\x04 -> docx-preview (ZIP / Office Open XML container)
  function initOne(el) {
    if (el._pdfvInitialised) return;
    el._pdfvInitialised = true;
    var src = el.getAttribute('data-pdf-src');
    if (!src) return;
    var maxWidth = parseInt(el.getAttribute('data-pdf-max-width') || '0', 10) || 0;
    var name = safeName(el, src);

    injectCss();
    el.innerHTML = loadingHtml();

    fetch(src, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching document');
        return r.blob();
      })
      .then(function (blob) {
        return blob.slice(0, 4).arrayBuffer().then(function (buf) {
          var b = new Uint8Array(buf);
          var sig = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
          if (sig === 0x25504446) return renderPdfFromBlob(el, blob, name, maxWidth, src);
          if (sig === 0x504B0304) return renderDocxFromBlob(el, blob, name, src);
          var hex = '0x' + ('00000000' + sig.toString(16)).slice(-8);
          throw new Error('Unknown document type (magic ' + hex + ')');
        });
      })
      .catch(function (err) {
        console.error('[pdf-viewer] dispatch failed:', err && (err.name + ': ' + err.message) || err);
        el.innerHTML = errorHtml(src, name, err);
      });
  }

  // Render a Word document client-side using docx-preview. Wrapped in a
  // white card so the dark page background doesn't fight the doc layout.
  function renderDocxFromBlob(el, blob, name, src) {
    return loadDocxLib()
      .then(function (docxLib) {
        el.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'pdfv-docx-wrap';
        var content = document.createElement('div');
        var styles = document.createElement('div');
        styles.style.display = 'none';
        wrap.appendChild(content);
        el.appendChild(wrap);
        el.appendChild(styles);
        return docxLib.renderAsync(blob, content, styles, {
          className: 'docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: false,
          experimental: false,
          breakPages: true,
        });
      })
      .catch(function (err) {
        console.error('[pdf-viewer] docx render failed:', err && (err.name + ': ' + err.message) || err);
        el.innerHTML = errorHtml(src || '', name, err);
      });
  }

  function renderPdfFromBlob(el, blob, name, maxWidth, src) {
    return Promise.all([loadPdfjs(), blob.arrayBuffer()])
      .then(function (parts) {
        var lib = parts[0];
        var data = parts[1];
        return lib.getDocument({
          data: data,
          cMapUrl: PDFJS_CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: PDFJS_FONTS_URL,
          // XFA forms (used by some Word/Acrobat exports) need explicit opt-in
          // in pdfjs 3.x, otherwise getDocument fails.
          enableXfa: true,
        }).promise;
      })
      .then(function (pdf) {
        el.innerHTML = '';
        var stack = document.createElement('div');
        stack.className = 'pdfv-stack';
        el.appendChild(stack);

        var containerWidth = pageWidthPx(el, maxWidth);

        // Pre-build per-page wrappers with a placeholder so the scroll
        // height stabilises immediately; we'll fill in canvases lazily via
        // IntersectionObserver so long docs don't render all pages upfront.
        var wraps = [];
        for (var i = 1; i <= pdf.numPages; i++) {
          var wrap = document.createElement('div');
          wrap.className = 'pdfv-page-wrap';
          wrap.dataset.pageNumber = i;
          wrap.innerHTML = '<div class="pdfv-page-placeholder">Page ' + i + '</div>';
          // Rough placeholder height ~ A4 aspect so the scrollbar feels stable.
          wrap.style.minHeight = Math.round(containerWidth * 1.414) + 'px';
          stack.appendChild(wrap);
          wraps.push(wrap);
        }

        var rendered = new WeakSet();
        function ensureRendered(wrap) {
          if (rendered.has(wrap)) return;
          rendered.add(wrap);
          var pageNo = parseInt(wrap.dataset.pageNumber, 10);
          renderPage(pdf, pageNo, wrap, containerWidth)
            .then(function () { wrap.style.minHeight = ''; })
            .catch(function (e) {
              console.error('[pdf-viewer] page', pageNo, 'render error:', e);
              wrap.innerHTML = '<div class="pdfv-page-placeholder">Couldn’t render page ' + pageNo + '</div>';
            });
        }

        if (wraps[0]) ensureRendered(wraps[0]);
        if (wraps[1]) ensureRendered(wraps[1]);

        if ('IntersectionObserver' in window) {
          var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting) ensureRendered(entry.target);
            });
          }, { rootMargin: '300px 0px' });
          wraps.forEach(function (w) { io.observe(w); });
        } else {
          wraps.forEach(ensureRendered);
        }
      })
      .catch(function (err) {
        console.error('[pdf-viewer] pdf render failed:', err && (err.name + ': ' + err.message) || err);
        injectCss();
        el.innerHTML = errorHtml(src || '', name, err);
      });
  }

  function initAll() {
    var els = document.querySelectorAll('.pdf-viewer[data-pdf-src]');
    // Lazy-init when the viewer scrolls near the viewport. Wallet pages can
    // have several PDF viewers on the same scroll; we don't want to fetch
    // all of them on page load.
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            io.unobserve(entry.target);
            initOne(entry.target);
          }
        });
      }, { rootMargin: '600px 0px' });
      for (var i = 0; i < els.length; i++) {
        // Pre-paint a "Loading…" stub so the page height is stable.
        if (!els[i].innerHTML.trim()) {
          injectCss();
          els[i].innerHTML = loadingHtml();
        }
        io.observe(els[i]);
      }
    } else {
      // No IO support — init everything synchronously (rare on modern mobile).
      for (var j = 0; j < els.length; j++) initOne(els[j]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }

  // Expose for any view that wants to mount viewers dynamically.
  window.WorkerPdfViewer = { initAll: initAll, initOne: initOne };
})();
