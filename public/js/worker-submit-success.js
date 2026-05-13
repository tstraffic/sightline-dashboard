// Full-screen submit-success overlay controller.
//
// The overlay markup lives in views/worker/partials/submit-success.ejs
// (included once in the worker layout). This script exposes:
//
//   WorkerSubmitSuccess.show({ message?, sub?, dismissMs?, redirect? })
//     - Animates the overlay in, strokes the checkmark, fires the
//       success haptic, dismisses after dismissMs (default 1400ms).
//     - If `redirect` is set, navigates there once the dismiss-fade
//       finishes — replaces the toast+navigation flow in
//       worker-offline-form.js for online submissions.
//   WorkerSubmitSuccess.hide()
//
// Also auto-shows on page load when the URL has ?ok=1 (or ?ok=<msg>),
// then scrubs the param via history.replaceState so the overlay doesn't
// re-trigger on refresh. Server-rendered redirects (most of the worker
// form routes) just need to redirect to <url>?ok=1 to get the animation.

(function () {
  'use strict';

  var DEFAULT_MS = 1400;
  var FADE_MS = 220;

  function $(id) { return document.getElementById(id); }

  function hide() {
    var ov = $('wss-overlay');
    if (!ov) return;
    ov.classList.add('is-leaving');
    setTimeout(function () {
      ov.classList.remove('is-visible');
      ov.classList.remove('is-leaving');
      ov.setAttribute('aria-hidden', 'true');
    }, FADE_MS);
  }

  function show(opts) {
    opts = opts || {};
    var ov = $('wss-overlay');
    if (!ov) return;
    var msgEl = $('wss-msg');
    var subEl = $('wss-sub');
    if (msgEl && opts.message) msgEl.textContent = opts.message;
    if (subEl && opts.sub) subEl.textContent = opts.sub;
    // Restart checkmark animation by removing/re-adding the class — the
    // CSS keyframe only runs when `.is-visible` toggles on.
    ov.classList.remove('is-visible');
    ov.classList.remove('is-leaving');
    // Force reflow so the next class-add restarts the animation.
    void ov.offsetWidth;
    ov.classList.add('is-visible');
    ov.setAttribute('aria-hidden', 'false');
    try { if (window.WorkerHaptics) window.WorkerHaptics.success(); } catch (e) {}

    var ms = opts.dismissMs == null ? DEFAULT_MS : opts.dismissMs;
    if (ms > 0) {
      setTimeout(function () {
        hide();
        if (opts.redirect) {
          setTimeout(function () { window.location.assign(opts.redirect); }, FADE_MS);
        }
      }, ms);
    }
  }

  window.WorkerSubmitSuccess = { show: show, hide: hide };

  // Auto-trigger on ?ok=1 after a server-side redirect. Keeps the
  // value-friendly form: ?ok=1 → default copy; ?ok=Saved → custom message.
  function maybeAutoShow() {
    try {
      var url = new URL(window.location.href);
      if (!url.searchParams.has('ok')) return;
      var val = url.searchParams.get('ok');
      var custom = (val && val !== '1') ? decodeURIComponent(val) : null;
      url.searchParams.delete('ok');
      // Clean the URL so a refresh doesn't re-fire the overlay.
      try { history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash); }
      catch (e) { /* old browsers */ }
      show(custom ? { message: custom } : {});
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeAutoShow);
  } else {
    maybeAutoShow();
  }
})();
