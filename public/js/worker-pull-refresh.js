// Custom pull-to-refresh for the worker portal.
//
// Replaces the mobile browser's generic spinner with a branded teal
// indicator that descends from the top of <main>. The worker has to drag
// past 80px to arm the refresh — past the threshold a light haptic
// fires; releasing armed triggers a medium haptic + spin + reload.
//
// Touch handling is scoped to <main> so it never hijacks normal scroll:
// the rubber-band only fires while main.scrollTop === 0 and the drag is
// downward (deltaY > 0). On iOS PWA the OS's bounce-scroll is naturally
// suppressed by the preventDefault on touchmove during that window.
//
// Indicator markup is injected at runtime (one fixed-position div + a
// CSS spinner). Styles live in views/worker/layout.ejs alongside the
// ambient layer so the whole motion system lives in one place.

(function () {
  'use strict';

  var THRESHOLD = 80; // px to drag (post-resist) before refresh arms
  var RESIST = 0.4;   // rubber-band resistance — drag feels 40% as far

  function init() {
    var main = document.querySelector('main');
    if (!main) return;

    // Build the indicator once. .wh-ptr / .wh-ptr-spinner styles are in
    // worker layout's <style> block.
    var ind = document.createElement('div');
    ind.className = 'wh-ptr';
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = '<div class="wh-ptr-spinner"></div>';
    document.body.appendChild(ind);

    var startY = 0;
    var dragging = false;
    var armed = false;

    main.addEventListener('touchstart', function (e) {
      // Only engage when already at the top — otherwise let normal
      // scroll happen.
      if (main.scrollTop !== 0) { dragging = false; return; }
      startY = e.touches[0].clientY;
      dragging = true;
      armed = false;
      // Reset any in-flight transitions from a prior release.
      ind.style.transition = 'none';
      ind.classList.remove('wh-ptr-armed', 'wh-ptr-refreshing');
    }, { passive: true });

    main.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        // Worker is dragging up — let normal scroll resume.
        ind.style.opacity = 0;
        ind.style.transform = 'translate(-50%, 0)';
        return;
      }
      e.preventDefault();
      var pulled = Math.min(dy * RESIST, 120);
      ind.style.transform = 'translate(-50%, ' + pulled + 'px)';
      ind.style.opacity = Math.min(pulled / THRESHOLD, 1);
      if (pulled > THRESHOLD && !armed) {
        armed = true;
        ind.classList.add('wh-ptr-armed');
        if (window.WorkerHaptics) window.WorkerHaptics.light();
      } else if (pulled <= THRESHOLD && armed) {
        armed = false;
        ind.classList.remove('wh-ptr-armed');
      }
    }, { passive: false });

    function release() {
      if (!dragging) return;
      dragging = false;
      ind.style.transition = 'transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease';
      if (armed) {
        if (window.WorkerHaptics) window.WorkerHaptics.medium();
        ind.classList.add('wh-ptr-refreshing');
        ind.style.transform = 'translate(-50%, 48px)';
        // Brief delay so the spin shows before the page reloads.
        setTimeout(function () { window.location.reload(); }, 600);
      } else {
        ind.style.transform = 'translate(-50%, 0)';
        ind.style.opacity = 0;
        setTimeout(function () { ind.style.transition = 'none'; }, 280);
      }
    }
    main.addEventListener('touchend', release);
    main.addEventListener('touchcancel', release);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
