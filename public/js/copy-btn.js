// Click-to-copy helper. Any element with [data-copy-text="..."] copies
// that value to the clipboard on click, flashes a green "Copied!"
// tooltip for 1.2s, then restores. Uses navigator.clipboard when
// available, falls back to a hidden textarea + execCommand('copy')
// for older / non-HTTPS contexts.

(function () {
  'use strict';

  function flash(el, msg) {
    var prev = el.getAttribute('aria-label') || '';
    var prevHtml = el.innerHTML;
    el.setAttribute('aria-label', msg);
    el.classList.add('copy-btn-flash');
    if (el.querySelector('.copy-label')) {
      el.querySelector('.copy-label').textContent = msg;
    }
    setTimeout(function () {
      el.classList.remove('copy-btn-flash');
      el.setAttribute('aria-label', prev);
      if (el.querySelector('.copy-label')) {
        el.innerHTML = prevHtml;
      }
    }, 1200);
  }

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  // One-shot CSS so callers don't need to repeat styles.
  var css = document.createElement('style');
  css.textContent = [
    '.copy-btn-flash { color: #047857 !important; background: #ECFDF5 !important; }',
  ].join('\n');
  document.head.appendChild(css);

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-copy-text]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    var text = btn.getAttribute('data-copy-text') || '';
    if (!text) return;
    copy(text).then(
      function ()  { flash(btn, 'Copied!'); },
      function ()  { flash(btn, 'Copy failed'); }
    );
  });
})();
