// Worker portal haptics.
//
// Web equivalent of expo-haptics: navigator.vibrate() wrapped in named
// helpers so view code reads as "WorkerHaptics.success()" rather than
// passing magic millisecond arrays around.
//
// Platform coverage:
//   Android Chrome / WebView      ✓ supported, vibrates the phone
//   Android Firefox / Samsung     ✓ supported
//   desktop Chrome (no haptic hw) ✓ accepted but no-op
//   iOS Safari + iOS PWA          ✗ Web Vibration API not implemented
//   iOS WKWebView wrappers        ✗ same
//
// iOS doesn't have a PWA-accessible haptic API as of this writing. We
// no-op silently rather than try to fake it with Audio/Visual cues — a
// missing haptic is invisible UX, a fake one is annoying. If the team
// later wraps the portal in a native shell, this helper can be swapped
// for a postMessage to the native bridge.
//
// All helpers are safe to call without checking for support: each does
// its own `navigator.vibrate &&` guard. Per the brief, "haptics
// throughout" means: light on tap, success on form submit success,
// warning on enqueue, error on permanent failure.

(function () {
  'use strict';

  function buzz(pattern) {
    if (!navigator.vibrate) return false;
    try { return navigator.vibrate(pattern) === true; } catch (e) { return false; }
  }

  window.WorkerHaptics = {
    // Brief tick — single tap confirmation. Use on tab nav, secondary buttons.
    light:   function () { return buzz(10); },
    // Slightly more substantial — used for "removed", "cleared", "toggled off".
    medium:  function () { return buzz(20); },
    // Two-pulse success cadence — form submit OK, ack acknowledged, etc.
    success: function () { return buzz([15, 40, 15]); },
    // Double bump — queued offline / awaiting retry / cautionary.
    warning: function () { return buzz([40, 30, 40]); },
    // Three-bump alert — permanent 4xx rejection, unable to save.
    error:   function () { return buzz([80, 60, 80, 60, 80]); },
    // Available for ad-hoc patterns when needed.
    pattern: buzz,
    // Tells callers whether haptics actually buzz on this device. iOS
    // PWA returns false; the rest return true even if the user has
    // silenced vibration (browser handles that).
    isSupported: function () { return !!navigator.vibrate; },
  };

  // Global tap haptic: every element opting in with data-haptic gets a
  // light buzz on click. Keeps view code light — no per-button onclick.
  // Variants via data-haptic="success" etc.
  function onTap(ev) {
    var el = ev.target.closest && ev.target.closest('[data-haptic]');
    if (!el) return;
    var kind = el.getAttribute('data-haptic') || 'light';
    var fn = window.WorkerHaptics[kind] || window.WorkerHaptics.light;
    try { fn(); } catch (e) { /* swallow */ }
  }
  document.addEventListener('click', onTap, { passive: true });
})();
