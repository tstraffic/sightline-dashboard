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

  var PDFJS_LIB_URL = '/vendor/pdfjs/pdf.min.js';
  var PDFJS_WORKER_URL = '/vendor/pdfjs/pdf.worker.min.js';

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
    ].join('\n');
    document.head.appendChild(style);
  }

  // Cache the script load promise so we don't re-inject on subsequent viewers.
  var libPromise = null;
  function loadLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PDFJS_LIB_URL;
      s.onload = function () {
        var lib = window.pdfjsLib;
        if (!lib) { reject(new Error('pdfjsLib not defined after load')); return; }
        try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL; } catch (e) { /* non-fatal */ }
        resolve(lib);
      };
      s.onerror = function () { libPromise = null; reject(new Error('Failed to load ' + PDFJS_LIB_URL)); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function loadingHtml() {
    return '<div class="pdfv-loading">Loading document<span class="pdfv-dot"></span><span class="pdfv-dot"></span><span class="pdfv-dot"></span></div>';
  }

  function errorHtml(src, name) {
    var safeName = (name || 'document.pdf').replace(/"/g, '');
    return [
      '<div class="pdfv-error">',
      "  Couldn't load the document inline.",
      '  <br>',
      '  <a href="', src, '" download="', safeName, '">Save the document</a>',
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

  function initOne(el) {
    if (el._pdfvInitialised) return;
    el._pdfvInitialised = true;
    var src = el.getAttribute('data-pdf-src');
    if (!src) return;
    var maxWidth = parseInt(el.getAttribute('data-pdf-max-width') || '0', 10) || 0;
    var name = safeName(el, src);

    injectCss();
    el.innerHTML = loadingHtml();

    loadLib()
      .then(function (lib) {
        return lib.getDocument({ url: src, withCredentials: true }).promise;
      })
      .then(function (pdf) {
        el.innerHTML = '';
        var stack = document.createElement('div');
        stack.className = 'pdfv-stack';
        el.appendChild(stack);

        // Container width is fixed once at render time; if the viewport
        // changes orientation we'd need to re-render. For now a simple
        // resize listener triggers a re-render of all visible pages.
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

        // Render the first 2 pages immediately so the viewer feels instant.
        // The rest render as the worker scrolls them into view.
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
          // No IO support — render everything upfront (rare on modern mobile).
          wraps.forEach(ensureRendered);
        }
      })
      .catch(function (err) {
        console.error('[pdf-viewer] load failed:', err && err.message ? err.message : err);
        el.innerHTML = errorHtml(src, name);
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
