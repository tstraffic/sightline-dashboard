// Worker portal — in-app photo capture widget.
//
// Adopts any <input type="file" data-wpi> on the page and replaces it with a
// tap-to-shoot tile + thumbnail grid. The native input is moved to the rear
// camera (capture="environment") and kept hidden underneath — same DOM name,
// same form submission, so existing multer routes work without changes.
//
// iOS-specific quirks handled:
//   - capture="environment" opens the rear camera directly (no Photos.app
//     jump), keeping the worker inside the PWA shell on iOS Safari.
//   - HEIC files from the iPhone camera roll get a runtime conversion to
//     JPEG via the optional heic2any library if present (skip if not — the
//     server-side multer route still accepts HEIC, just won't process via
//     sharp on those rows).
//   - Removing an item requires us to rebuild a DataTransfer because
//     HTMLInputElement.files is read-only on iOS; do not rely on splice.

(function () {
  'use strict';

  var cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    var style = document.createElement('style');
    style.textContent = [
      '.wpi-wrap { display: block; }',
      '.wpi-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; }',
      '.wpi-tile { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); }',
      '.wpi-tile img { width: 100%; height: 100%; object-fit: cover; display: block; }',
      '.wpi-tile button.wpi-remove { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 999px; border: 0; background: rgba(0,0,0,0.65); color: #fff; font-size: 14px; line-height: 1; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer; }',
      '.wpi-tile button.wpi-remove:active { background: rgba(0,0,0,0.85); }',
      '.wpi-add { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; aspect-ratio: 1 / 1; border-radius: 10px; border: 1.5px dashed rgba(255,255,255,0.25); background: rgba(255,255,255,0.02); color: rgba(255,255,255,0.7); cursor: pointer; font-size: 0.72rem; font-weight: 600; text-align: center; padding: 6px; }',
      '.wpi-add:active { background: rgba(255,255,255,0.05); }',
      '.wpi-add svg { width: 26px; height: 26px; opacity: 0.85; }',
      '.wpi-add[disabled] { opacity: 0.4; pointer-events: none; }',
      /* Light-card backgrounds (used inside the few admin-themed views the
         worker portal inherits) need legible text/border colours. */
      '.bg-white .wpi-add, .sf-wrap .wpi-add { color: #4b5563; border-color: rgba(0,0,0,0.18); background: #f9fafb; }',
      '.bg-white .wpi-tile, .sf-wrap .wpi-tile { background: #f3f4f6; border-color: rgba(0,0,0,0.08); }',
      '.wpi-meta { font-size: 0.7rem; color: rgba(255,255,255,0.55); margin-top: 6px; }',
      '.bg-white .wpi-meta, .sf-wrap .wpi-meta { color: #6b7280; }',
    ].join('\n');
    document.head.appendChild(style);
  }

  // Rebuild HTMLInputElement.files from an array of File objects, going
  // through DataTransfer because .files is read-only.
  function applyFiles(input, files) {
    var dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    input.files = dt.files;
    // Fire change so any other listeners (validation, framework hooks) re-run.
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Lightweight HEIC → JPEG conversion when the optional heic2any global is
  // present. Returns a Promise that resolves to a (possibly new) File.
  function maybeConvertHeic(file) {
    if (!/\.heic$|\.heif$/i.test(file.name) && file.type !== 'image/heic' && file.type !== 'image/heif') {
      return Promise.resolve(file);
    }
    if (typeof window.heic2any !== 'function') return Promise.resolve(file); // skip silently
    return window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 })
      .then(function (out) {
        var blob = Array.isArray(out) ? out[0] : out;
        var newName = file.name.replace(/\.heic$|\.heif$/i, '.jpg');
        return new File([blob], newName, { type: 'image/jpeg', lastModified: Date.now() });
      })
      .catch(function () { return file; });
  }

  function adopt(input) {
    if (input._wpiAdopted) return;
    input._wpiAdopted = true;

    var multiple = input.hasAttribute('multiple');
    var max = parseInt(input.getAttribute('data-wpi-max') || (multiple ? '6' : '1'), 10);
    var label = input.getAttribute('data-wpi-label') || (multiple ? 'Add photo' : 'Take photo');

    // No `capture` by default — workers asked to keep the choice between
    // camera and gallery. iOS Safari then shows its native action sheet
    // (Take Photo / Photo Library / Choose Files) and Android Chrome
    // shows a similar picker. Callers can opt into camera-only by
    // setting data-wpi-camera="1".
    if (!input.hasAttribute('accept')) input.setAttribute('accept', 'image/*');
    if (input.getAttribute('data-wpi-camera') === '1' && !input.hasAttribute('capture')) {
      input.setAttribute('capture', 'environment');
    } else if (input.getAttribute('data-wpi-camera') !== '1') {
      // Strip a hardcoded `capture` from earlier markup so the action
      // sheet is restored without having to touch every view.
      input.removeAttribute('capture');
    }

    injectCss();

    var wrap = document.createElement('div');
    wrap.className = 'wpi-wrap';
    var grid = document.createElement('div');
    grid.className = 'wpi-tiles';
    var meta = document.createElement('div');
    meta.className = 'wpi-meta';
    wrap.appendChild(grid);
    wrap.appendChild(meta);

    input.style.display = 'none';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input); // keep the input inside the wrap so labels and form submission still work

    var files = [];

    function renderMeta() {
      if (max <= 1) { meta.textContent = ''; return; }
      meta.textContent = files.length + ' of ' + max + ' photo' + (max === 1 ? '' : 's');
    }

    function sync() {
      applyFiles(input, files);
      // Repaint grid.
      // Remove tiles (everything before the add tile).
      var addTile = grid.querySelector('.wpi-add');
      while (grid.firstChild && grid.firstChild !== addTile) grid.removeChild(grid.firstChild);
      if (addTile) grid.removeChild(addTile);

      files.forEach(function (f, idx) {
        var tile = document.createElement('div');
        tile.className = 'wpi-tile';
        var img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.loading = 'lazy';
        try { img.src = URL.createObjectURL(f); } catch (e) { /* fallback: no preview */ }
        tile.appendChild(img);
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'wpi-remove';
        rm.setAttribute('aria-label', 'Remove photo');
        rm.textContent = '×';
        rm.addEventListener('click', function () {
          try { URL.revokeObjectURL(img.src); } catch (e) {}
          files.splice(idx, 1);
          sync();
        });
        tile.appendChild(rm);
        grid.appendChild(tile);
      });

      if (files.length < max) {
        var addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'wpi-add';
        addBtn.innerHTML = [
          '<svg fill="none" stroke="currentColor" stroke-width="1.6" viewBox="0 0 24 24">',
          '  <path stroke-linecap="round" stroke-linejoin="round" d="M3 7h3l2-2h8l2 2h3v12H3V7z"/>',
          '  <circle cx="12" cy="13" r="3.5" stroke-linecap="round" stroke-linejoin="round"/>',
          '</svg>',
          '<span>' + label + '</span>',
        ].join('');
        addBtn.addEventListener('click', function () { input.click(); });
        grid.appendChild(addBtn);
      }

      renderMeta();
    }

    input.addEventListener('change', function () {
      var picked = Array.from(input.files || []);
      if (!picked.length) return;
      // Don't double-count when we programmatically reset .files in applyFiles().
      // Only treat as new pick if the count differs from our internal files[].
      if (picked.length === files.length && picked.every(function (f, i) { return f === files[i]; })) {
        return;
      }
      Promise.all(picked.map(maybeConvertHeic)).then(function (out) {
        var room = Math.max(0, max - files.length);
        files = files.concat(out.slice(0, room));
        sync();
      });
    });

    sync();
  }

  function init(root) {
    var scope = root || document;
    var inputs = scope.querySelectorAll('input[type="file"][data-wpi]');
    for (var i = 0; i < inputs.length; i++) adopt(inputs[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }

  window.WorkerPhotoInput = { init: init, adopt: adopt };
})();
