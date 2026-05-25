// Inline document viewer — replaces target="_blank" / new-tab patterns
// for HR documents and induction submission uploads. One modal element
// is lazily created on first call and reused; close fires on the X
// button, the backdrop, or Esc.
//
// Usage:
//   <a href="/hr/documents/123/download?inline=1" data-doc-viewer
//      data-doc-name="Drivers Licence.pdf">View</a>
//   <img src="..." data-doc-viewer data-doc-href="...">
// Anything with [data-doc-viewer] gets wired automatically. You can
// also call window.openDocViewer(url, filename) directly.
//
// The viewer infers content type from URL extension. PDFs render in
// an <iframe>; images in <img>; anything else (docx, xlsx) gets a
// download fallback link since browsers can't render them inline.

(function () {
  'use strict';

  var modal = null;
  var iframe = null;
  var image = null;
  var titleEl = null;
  var fallbackEl = null;

  function ensureModal() {
    if (modal) return;
    var css = [
      '.dv-backdrop {',
      '  position: fixed; inset: 0; z-index: 9000;',
      '  background: rgba(15,17,21,0.85); backdrop-filter: blur(4px);',
      '  display: none; align-items: center; justify-content: center; padding: 24px;',
      '  opacity: 0; transition: opacity 0.18s ease;',
      '}',
      '.dv-backdrop.dv-open { display: flex; opacity: 1; }',
      '.dv-shell {',
      '  position: relative; width: min(1100px, 100%); height: min(90vh, 100%);',
      '  background: #0F1115; border-radius: 14px; overflow: hidden;',
      '  display: flex; flex-direction: column; box-shadow: 0 30px 80px rgba(0,0,0,0.5);',
      '}',
      '.dv-head {',
      '  display: flex; align-items: center; justify-content: space-between;',
      '  padding: 12px 14px 12px 18px; background: #1A1D24;',
      '  border-bottom: 1px solid rgba(255,255,255,0.06); flex-shrink: 0;',
      '}',
      '.dv-title { font-size: 14px; font-weight: 600; color: #F5F5F7; min-width: 0;',
      '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 12px; }',
      '.dv-close {',
      '  appearance: none; border: 0; cursor: pointer;',
      '  width: 36px; height: 36px; border-radius: 8px;',
      '  background: rgba(255,255,255,0.08); color: #F5F5F7;',
      '  display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;',
      '  font-size: 18px; font-weight: 600;',
      '}',
      '.dv-close:hover { background: rgba(255,255,255,0.18); }',
      '.dv-body { flex: 1; min-height: 0; background: #0F1115; display: flex; align-items: center; justify-content: center; }',
      '.dv-body iframe { width: 100%; height: 100%; border: 0; background: #fff; }',
      '.dv-body img { max-width: 100%; max-height: 100%; object-fit: contain; }',
      '.dv-fallback { color: #F5F5F7; text-align: center; padding: 40px 20px; }',
      '.dv-fallback a { color: #6EE7B7; font-weight: 600; text-decoration: underline; }',
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'doc-viewer-css';
    style.textContent = css;
    document.head.appendChild(style);

    modal = document.createElement('div');
    modal.className = 'dv-backdrop';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = [
      '<div class="dv-shell" role="document">',
      '  <header class="dv-head">',
      '    <span class="dv-title">Document</span>',
      '    <button type="button" class="dv-close" aria-label="Close (Esc)">',
      '      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
      '    </button>',
      '  </header>',
      '  <div class="dv-body">',
      '    <iframe class="dv-iframe" hidden></iframe>',
      '    <img class="dv-img" alt="" hidden>',
      '    <div class="dv-fallback" hidden></div>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);

    iframe     = modal.querySelector('.dv-iframe');
    image      = modal.querySelector('.dv-img');
    titleEl    = modal.querySelector('.dv-title');
    fallbackEl = modal.querySelector('.dv-fallback');

    // Backdrop click (but not clicks on the shell).
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelector('.dv-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('dv-open')) close();
    });
  }

  function close() {
    if (!modal) return;
    modal.classList.remove('dv-open');
    // Clear the iframe src so the browser stops streaming/loading the
    // file in the background once the user closes the viewer.
    if (iframe) { iframe.src = 'about:blank'; iframe.hidden = true; }
    if (image)  { image.src = '';            image.hidden = true; }
    if (fallbackEl) { fallbackEl.innerHTML = ''; fallbackEl.hidden = true; }
    document.body.style.overflow = '';
  }

  function open(url, name) {
    if (!url) return;
    ensureModal();
    var label = name || (url.split('/').pop() || 'Document');
    titleEl.textContent = label;

    // Force ?inline=1 on HR document downloads so the server serves
    // with Content-Disposition: inline instead of attachment. Harmless
    // for routes that ignore the query.
    var serveUrl = url;
    if (/\/hr\/documents\/\d+\/download/.test(serveUrl) && !/[?&]inline=/.test(serveUrl)) {
      serveUrl += (serveUrl.indexOf('?') === -1 ? '?' : '&') + 'inline=1';
    }

    var ext = (label.split('.').pop() || '').toLowerCase();
    var isImage = /^(jpg|jpeg|png|gif|webp|bmp|svg|avif|heic|heif)$/.test(ext);
    var isPdf   = ext === 'pdf';

    if (isImage) {
      image.src = serveUrl;
      image.alt = label;
      image.hidden = false;
    } else if (isPdf) {
      iframe.src = serveUrl;
      iframe.hidden = false;
    } else {
      // Office docs / unknown — browsers can't render these inline
      // reliably, so surface a download link instead of a broken iframe.
      fallbackEl.innerHTML =
        '<p style="margin-bottom:12px">Preview not available for this file type.</p>' +
        '<a href="' + serveUrl + '" download="' + label.replace(/"/g, '&quot;') + '">Download ' + label + '</a>';
      fallbackEl.hidden = false;
    }

    modal.classList.add('dv-open');
    document.body.style.overflow = 'hidden';
  }

  // Auto-wire any [data-doc-viewer] element (clicked anchor or image).
  document.addEventListener('click', function (e) {
    var trigger = e.target.closest && e.target.closest('[data-doc-viewer]');
    if (!trigger) return;
    e.preventDefault();
    e.stopPropagation();
    var url = trigger.getAttribute('data-doc-href')
           || trigger.getAttribute('href')
           || trigger.getAttribute('src');
    var name = trigger.getAttribute('data-doc-name') || trigger.getAttribute('alt') || '';
    open(url, name);
  });

  window.openDocViewer = open;
  window.closeDocViewer = close;
})();
