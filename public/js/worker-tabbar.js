// Animated active-indicator pill for the worker portal bottom tab bar.
// On every page we:
//   1. Find .wh-tab-bar a.is-active, measure its centre + width.
//   2. Write --wh-tab-x (centre, px) and --wh-tab-w (pill width, px) onto
//      the indicator. The CSS uses translateX(var(--wh-tab-x)) translateX(-50%)
//      so the pill is centred under the active tab.
//   3. Add `data-tab-ready` so the indicator fades in (no flash at 0,0).
//   4. On tap, pre-update the vars to the tapped tab's geometry so the
//      spring fires the moment the worker tips the screen, not after the
//      next page mounts. Skipped for the already-active tab.
//   5. Re-measure on resize + orientationchange (label collapse on narrow).

(function () {
  'use strict';

  var PILL_RATIO = 0.45; // pill width = activeTabWidth * PILL_RATIO, min 22px
  var PILL_MIN = 22;

  function widthFor(tab) {
    var w = Math.max(PILL_MIN, Math.round(tab.offsetWidth * PILL_RATIO));
    return w;
  }

  function centreFor(tab) {
    return Math.round(tab.offsetLeft + tab.offsetWidth / 2);
  }

  function place(bar, indicator, tab, immediate) {
    if (!tab || !indicator) return;
    var x = centreFor(tab);
    var w = widthFor(tab);
    if (immediate) {
      var prev = indicator.style.transition;
      indicator.style.transition = 'none';
      indicator.style.setProperty('--wh-tab-x', x + 'px');
      indicator.style.setProperty('--wh-tab-w', w + 'px');
      // Force reflow so the no-transition write lands before we restore it.
      void indicator.offsetWidth;
      indicator.style.transition = prev || '';
    } else {
      indicator.style.setProperty('--wh-tab-x', x + 'px');
      indicator.style.setProperty('--wh-tab-w', w + 'px');
    }
  }

  function init() {
    var bar = document.querySelector('.wh-tab-bar');
    if (!bar) return;
    var indicator = bar.querySelector('.wh-tab-indicator');
    if (!indicator) return;
    var tabs = bar.querySelectorAll('a[data-tab]');
    if (!tabs.length) return;

    var active = bar.querySelector('a.is-active') || tabs[0];
    place(bar, indicator, active, true);
    // Reveal on next frame so the pill doesn't streak in from x=0.
    requestAnimationFrame(function () {
      bar.setAttribute('data-tab-ready', '');
    });

    // Pre-animate on tap so the spring fires under the worker's finger,
    // not after the new page mounts. Don't pre-animate the active tab.
    tabs.forEach(function (a) {
      a.addEventListener('click', function () {
        if (a.classList.contains('is-active')) return;
        place(bar, indicator, a, false);
      }, { passive: true });
      // Touchstart gives an even snappier feel on iOS (click fires later).
      a.addEventListener('touchstart', function () {
        if (a.classList.contains('is-active')) return;
        place(bar, indicator, a, false);
      }, { passive: true });
    });

    var rafId = 0;
    function remeasure() {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(function () {
        var a = bar.querySelector('a.is-active') || tabs[0];
        place(bar, indicator, a, true);
      });
    }
    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);
    // Fonts can shift label widths after first paint.
    if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
      document.fonts.ready.then(remeasure).catch(function () {});
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
