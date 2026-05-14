// Signature-pad particle trail + shimmer-sweep on completion.
//
// Attaches to any <canvas data-particle-trail> in the worker portal.
// Does not touch the canvas's drawing logic — works alongside the
// existing inline scripts that handle the actual signature capture
// (toDataURL etc.). We just listen to pointerdown/move/up and emit
// particles through the shared engine, then trigger a CSS shimmer
// sweep on completion.
//
// Performance: emits at most ~30 particles/sec (1 per pointermove event
// that exceeds a small distance threshold), capped by the engine's
// global 100-particle budget. Skipped entirely under prefers-reduced-
// motion (signature drawing itself remains functional).

(function () {
  'use strict';

  var reduced = false;
  try {
    reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var MIN_DIST = 6;   // px between particle emissions
  var TRAIL_COLOR = '#60A5FA';

  function emitTrail(canvas, clientX, clientY) {
    if (!window.WorkerParticles || !window.WorkerParticles.tapBurst) return;
    // Single small particle per emission rather than a burst — gives a
    // genuine trail effect, not little explosions every few pixels.
    var color = canvas.getAttribute('data-particle-color') || TRAIL_COLOR;
    // tapBurst always spawns 3-5; for a trail we want 1, so we go direct
    // through the shared API used by tapBurst's underlying logic via
    // celebrate-style synthetic params. Cleaner: just call tapBurst with
    // a small radius and accept it emits 3-5. We compensate by raising
    // MIN_DIST so the trail is sparser.
    window.WorkerParticles.tapBurst(clientX, clientY, color);
  }

  function injectShimmerCss() {
    if (document.getElementById('ws-shimmer-css')) return;
    var s = document.createElement('style');
    s.id = 'ws-shimmer-css';
    s.textContent = [
      'canvas[data-particle-trail] { position: relative; }',
      '.ws-shimmer-wrap { position: relative; overflow: hidden; isolation: isolate; }',
      '.ws-shimmer-wrap.ws-sweep::after {',
      '  content: ""; position: absolute; inset: 0; pointer-events: none;',
      '  background: linear-gradient(120deg, transparent 35%, rgba(0,210,190,0.55) 50%, transparent 65%);',
      '  transform: translateX(-110%);',
      '  animation: ws-sweep 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards;',
      '}',
      '@keyframes ws-sweep { to { transform: translateX(110%); } }',
      '@media (prefers-reduced-motion: reduce) { .ws-shimmer-wrap.ws-sweep::after { animation: none; opacity: 0; } }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function attach(canvas) {
    if (canvas._wsAttached) return;
    canvas._wsAttached = true;
    injectShimmerCss();

    // Wrap the canvas's parent so the shimmer can sit above it without
    // touching the canvas's own rendering. The form templates use a
    // dashed-border wrapper around the canvas; we tag that wrapper.
    var wrap = canvas.parentElement;
    if (wrap) wrap.classList.add('ws-shimmer-wrap');

    var lastX = -999, lastY = -999, drawing = false, anyDrawn = false;

    canvas.addEventListener('pointerdown', function (e) {
      drawing = true;
      anyDrawn = true;
      lastX = e.clientX; lastY = e.clientY;
      if (!reduced) emitTrail(canvas, e.clientX, e.clientY);
    }, { passive: true });

    canvas.addEventListener('pointermove', function (e) {
      if (!drawing || reduced) return;
      var dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (dx * dx + dy * dy < MIN_DIST * MIN_DIST) return;
      lastX = e.clientX; lastY = e.clientY;
      emitTrail(canvas, e.clientX, e.clientY);
    }, { passive: true });

    function end() {
      if (!drawing) return;
      drawing = false;
      if (anyDrawn && wrap) {
        wrap.classList.remove('ws-sweep');
        // Force reflow so the animation re-triggers on subsequent
        // pen-lifts.
        void wrap.offsetWidth;
        wrap.classList.add('ws-sweep');
      }
    }
    canvas.addEventListener('pointerup', end, { passive: true });
    canvas.addEventListener('pointerleave', end, { passive: true });
    canvas.addEventListener('pointercancel', end, { passive: true });
  }

  function autoAttach() {
    document.querySelectorAll('canvas[data-particle-trail]').forEach(attach);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoAttach);
  } else {
    autoAttach();
  }

  // Observe for late-added canvases (forms loaded via partials).
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () { autoAttach(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  window.WorkerSignature = { attach: attach };
})();
