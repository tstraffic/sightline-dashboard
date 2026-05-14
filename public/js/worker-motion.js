// Unified motion bootstrap for the worker portal. Powered by Motion One
// (window.Motion, loaded from /vendor/motion/motion.js).
//
// Reads a single `data-motion` attribute on opted-in elements and
// applies the corresponding animation. All behaviours are no-ops under
// `prefers-reduced-motion: reduce`.
//
// Supported intents (space-separated, so an element can opt into more
// than one — e.g. data-motion="fade-up press"):
//
//   data-motion~="fade-up"     Element fades in + slides up 8px when it
//                              first enters the viewport.
//
//   data-motion~="stagger"     CONTAINER. Direct children animate in
//                              with a 50ms cascade (fade + 8px slide)
//                              once the container enters the viewport.
//
//   data-motion~="press"       Element springs to scale(0.96) on
//                              pointerdown and bounces back on
//                              pointerup / cancel via Motion One spring.
//
//   data-motion~="count"       Numeric stat. Reads `data-count-to="N"`
//                              (or falls back to the element's
//                              textContent), animates 0 -> N over
//                              ~700ms with an easeOutCubic when the
//                              element first enters the viewport.
//                              Trailing unit text (e.g. "12hrs") is
//                              preserved.
//
// Legacy attributes from v1 PR 2 are auto-upgraded so we don't have to
// touch every view:
//   data-stagger          -> data-motion="stagger"
//   data-countup="N"      -> data-motion="count" data-count-to="N"

(function () {
  'use strict';

  var M = window.Motion;
  var hasMotion = !!(M && M.animate && M.inView);

  var reducedMotion = false;
  try {
    reducedMotion = window.matchMedia &&
                    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* old browsers */ }

  // --- Tokens -----------------------------------------------------------
  var SPRING       = { type: 'spring', stiffness: 220, damping: 22, mass: 1 };
  var EASE_OUT     = [0.22, 1, 0.36, 1];
  var FADE_UP_TO   = { opacity: 1, transform: 'translateY(0px)' };
  var STAGGER_MS   = 50;
  var COUNT_MS     = 700;

  function setInitial(el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.willChange = 'opacity, transform';
  }
  function clearInitial(el) {
    el.style.willChange = '';
  }

  function tokens(el) {
    var raw = el.getAttribute('data-motion') || '';
    return raw.trim().split(/\s+/).filter(Boolean);
  }

  // --- Legacy attribute migration --------------------------------------
  function upgradeLegacyAttrs(root) {
    root.querySelectorAll('[data-stagger]:not([data-motion])').forEach(function (el) {
      el.setAttribute('data-motion', 'stagger');
    });
    root.querySelectorAll('[data-countup]:not([data-motion])').forEach(function (el) {
      el.setAttribute('data-motion', 'count');
      var n = el.getAttribute('data-countup');
      if (n != null && !el.hasAttribute('data-count-to')) el.setAttribute('data-count-to', n);
    });
  }

  // --- fade-up ----------------------------------------------------------
  function bindFadeUp(el) {
    if (reducedMotion || !hasMotion) {
      el.style.opacity = '';
      el.style.transform = '';
      return;
    }
    setInitial(el);
    M.inView(el, function () {
      M.animate(el, FADE_UP_TO, { duration: 0.5, easing: EASE_OUT });
      setTimeout(function () { clearInitial(el); }, 600);
    }, { amount: 0.15, margin: '0px 0px -10% 0px' });
  }

  // --- stagger ---------------------------------------------------------
  function bindStagger(container) {
    var kids = Array.prototype.slice.call(container.children);
    if (!kids.length) return;
    if (reducedMotion || !hasMotion) return;
    kids.forEach(function (k) {
      setInitial(k);
      k.setAttribute('data-motion-child', '');
    });
    M.inView(container, function () {
      var delayFn = (M.stagger
        ? M.stagger(STAGGER_MS / 1000)
        : function (_el, i) { return (i * STAGGER_MS) / 1000; });
      M.animate(kids, FADE_UP_TO, {
        duration: 0.45,
        easing: EASE_OUT,
        delay: delayFn,
      });
      setTimeout(function () { kids.forEach(clearInitial); }, 600 + STAGGER_MS * kids.length);
    }, { amount: 0.05, margin: '0px 0px -5% 0px' });
  }

  // --- press -----------------------------------------------------------
  function bindPress(el) {
    if (reducedMotion || !hasMotion) return;
    if (el._motionPress) return;
    el._motionPress = true;
    el.style.transformOrigin = '50% 50%';

    function down() {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      M.animate(el, { transform: 'scale(0.96)' }, { duration: 0.12, easing: EASE_OUT });
    }
    function up() {
      M.animate(el, { transform: 'scale(1)' }, SPRING);
    }
    el.addEventListener('pointerdown', down, { passive: true });
    el.addEventListener('pointerup',     up, { passive: true });
    el.addEventListener('pointerleave',  up, { passive: true });
    el.addEventListener('pointercancel', up, { passive: true });
  }

  // --- count-up --------------------------------------------------------
  // Uses requestAnimationFrame directly (Web Animations API isn't ideal
  // for text-content interpolation). Motion One's inView is reused for
  // viewport gating.
  function bindCount(el) {
    var to = parseFloat(el.getAttribute('data-count-to') || el.textContent || '0');
    if (!isFinite(to)) return;
    var raw = el.textContent || '';
    var match = raw.match(/^[\s-]*([0-9]+(?:\.[0-9]+)?)(.*)$/);
    var suffix = match ? match[2] : '';
    var decimals = to % 1 === 0 ? 0 : 1;

    if (reducedMotion || !hasMotion) {
      el.textContent = (decimals ? to.toFixed(decimals) : Math.round(to)) + suffix;
      return;
    }

    el.textContent = '0' + suffix;
    var fired = false;
    function play() {
      if (fired) return;
      fired = true;
      var start = performance.now();
      function tick(now) {
        var t = Math.min(1, (now - start) / COUNT_MS);
        var eased = 1 - Math.pow(1 - t, 3);
        var v = to * eased;
        el.textContent = (decimals ? v.toFixed(decimals) : Math.round(v)) + suffix;
        if (t < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
    M.inView(el, play, { amount: 0.4 });
  }

  // --- Bootstrap -------------------------------------------------------
  function init(root) {
    root = root || document;
    upgradeLegacyAttrs(root);

    root.querySelectorAll('[data-motion]').forEach(function (el) {
      var ts = tokens(el);
      if (ts.indexOf('stagger') !== -1) bindStagger(el);
      if (ts.indexOf('fade-up') !== -1) bindFadeUp(el);
      if (ts.indexOf('press')   !== -1) bindPress(el);
      if (ts.indexOf('count')   !== -1) bindCount(el);
    });

    // Auto-bind press to obvious tappables that don't opt in explicitly
    // so we don't have to touch every button across the worker views.
    var auto = root.querySelectorAll(
      '.wd-btn, .wh-act-btn, .wh-qa-btn, .wd-stat-tile, button.wh-fab-main'
    );
    auto.forEach(bindPress);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(document); });
  } else {
    init(document);
  }

  window.WorkerMotion = {
    init: init,
    bindPress: bindPress,
    bindFadeUp: bindFadeUp,
    bindCount: bindCount,
  };
})();
