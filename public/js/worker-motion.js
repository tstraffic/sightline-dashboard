// Worker portal motion layer.
//
// Three behaviours, all CSS-driven + a tiny JS shim:
//
//   1. Tap feedback — spring-back scale on every tappable. Pure CSS,
//      no script needed beyond the styles this file injects.
//   2. Stagger fade-in for opted-in lists — any element with
//      `data-stagger` reveals its direct children with a 40ms
//      cascade. IntersectionObserver gates lists below the fold so
//      they don't burn frames before they're visible.
//   3. Count-up for numeric stats — every `[data-countup]` element
//      animates from 0 to its final value over 600ms using easeOutCubic
//      when it enters the viewport. Falls back to the static value
//      under prefers-reduced-motion.
//
// Self-contained: injects its own CSS, no design-system dependency
// other than the spring curve token (read via a CSS var, falls back
// to a hardcoded curve if worker-design.css hasn't loaded).

(function () {
  'use strict';

  // Honour the OS-level reduced-motion preference. We still bind the
  // tap-feedback styles (the tap-scale is so small it isn't bothersome)
  // but skip the entrance animation + count-up so the page paints
  // instantly.
  var reduced = false;
  try {
    reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* old browsers */ }

  // ----- CSS injection -----------------------------------------------------
  if (!document.getElementById('wd-motion-css')) {
    var style = document.createElement('style');
    style.id = 'wd-motion-css';
    style.textContent = [
      // Tap feedback: any element opting in with .wd-tap, or any native
      // <button> / <a role="button">, springs back on press. Existing
      // worker-portal buttons get this for free.
      '.wd-tap, .wd-btn, button:not([disabled]):not([aria-disabled="true"]), a[role="button"], .wh-act-btn, .wh-qa-btn, .saf-card, .nf-row, .wd-stat-tile {',
      '  transition: transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 120ms ease;',
      '}',
      '.wd-tap:active, .wd-btn:active:not([disabled]):not([aria-disabled="true"]), button:active:not([disabled]):not([aria-disabled="true"]), a[role="button"]:active, .wh-act-btn:active, .wh-qa-btn:active {',
      '  transform: scale(var(--wd-tap-scale, 0.96));',
      '}',

      // Stagger entrance: only applies once the parent has the
      // data-stagger-ready attribute, which the JS adds either on
      // DOMContentLoaded (above the fold) or via IntersectionObserver
      // (below the fold). That avoids ugly invisible content for
      // workers on slow devices.
      '[data-stagger][data-stagger-ready] > * {',
      '  animation: wd-stagger-in 360ms cubic-bezier(0.22, 1, 0.36, 1) both;',
      '}',
      // 12 cascading steps; lists longer than that just settle quickly.
      '[data-stagger][data-stagger-ready] > *:nth-child(1) { animation-delay: 20ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(2) { animation-delay: 60ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(3) { animation-delay: 100ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(4) { animation-delay: 140ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(5) { animation-delay: 180ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(6) { animation-delay: 220ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(7) { animation-delay: 260ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(8) { animation-delay: 300ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(9) { animation-delay: 320ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(10) { animation-delay: 340ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(11) { animation-delay: 360ms; }',
      '[data-stagger][data-stagger-ready] > *:nth-child(n+12) { animation-delay: 380ms; }',
      '@keyframes wd-stagger-in {',
      '  from { opacity: 0; transform: translateY(8px); }',
      '  to   { opacity: 1; transform: translateY(0); }',
      '}',

      // Reduced-motion: kill the entrance animation entirely. We still
      // keep the tap-scale because it's information, not decoration.
      '@media (prefers-reduced-motion: reduce) {',
      '  [data-stagger][data-stagger-ready] > * { animation: none; }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // ----- Stagger --------------------------------------------------------
  function armStagger(el) {
    if (el.hasAttribute('data-stagger-ready')) return;
    el.setAttribute('data-stagger-ready', '');
  }

  function bindStagger() {
    var lists = document.querySelectorAll('[data-stagger]:not([data-stagger-ready])');
    if (!lists.length) return;
    if (reduced || !('IntersectionObserver' in window)) {
      // Skip observation entirely — just paint immediately.
      lists.forEach(armStagger);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          io.unobserve(entry.target);
          armStagger(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    lists.forEach(function (el) {
      // Above-the-fold lists trigger immediately; IO confirms anything
      // off-screen on first paint.
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight) armStagger(el);
      else io.observe(el);
    });
  }

  // ----- Count-up -------------------------------------------------------
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  function runCountUp(el, target) {
    var t = parseFloat(target);
    if (!isFinite(t)) { el.textContent = target; return; }
    var isInt = String(target).indexOf('.') === -1;
    var start = performance.now();
    var dur = 600;
    function tick(now) {
      var p = Math.min(1, (now - start) / dur);
      var v = t * easeOutCubic(p);
      el.textContent = isInt ? Math.round(v).toString() : v.toFixed(1);
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = isInt ? String(Math.round(t)) : String(t);
    }
    requestAnimationFrame(tick);
  }

  function bindCountUp() {
    var els = document.querySelectorAll('[data-countup]');
    if (!els.length) return;
    if (reduced || !('IntersectionObserver' in window)) {
      els.forEach(function (el) {
        var t = el.getAttribute('data-countup');
        // Keep the rendered text as-is when reduced or no IO; just clear the
        // attribute so we don't re-run after a future bindCountUp().
        el.removeAttribute('data-countup');
        if (t != null && t !== '') el.textContent = t;
      });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          io.unobserve(el);
          var t = el.getAttribute('data-countup');
          el.removeAttribute('data-countup');
          // Reset to 0 before animating so the eye catches the rise.
          el.textContent = '0';
          requestAnimationFrame(function () { runCountUp(el, t); });
        }
      });
    }, { threshold: 0.15 });
    els.forEach(function (el) { io.observe(el); });
  }

  // ----- Boot -----------------------------------------------------------
  function init() {
    bindStagger();
    bindCountUp();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Re-arm after dynamic content insertions (e.g. SPA-style nav swaps).
  window.WorkerMotion = { init: init, armStagger: armStagger };
})();
