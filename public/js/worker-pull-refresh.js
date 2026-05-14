// Custom pull-to-refresh for the worker portal — particle edition.
//
// Phases:
//   1. PULL (worker is dragging down, scrollTop=0, not yet armed):
//      Particles spawn off-screen at random viewport edges and steer
//      ("converge" behavior) toward a focus point at top-centre. The
//      teal anchor indicator descends along with the drag distance.
//   2. ARMED (drag exceeded threshold): all 'ptr' particles flip to
//      orbit behavior around the indicator, forming a swirling ring.
//      Light haptic fires once on the transition.
//   3. RELEASE-ARMED: medium haptic, particles explode outward (regular
//      ballistic burst), then 600ms later window.location.reload().
//   4. RELEASE-UNARMED: indicator snaps back, particles fade.
//
// The teal teardrop anchor is retained as a focal point — particles
// orbit around it during the armed phase. Under prefers-reduced-motion
// the particles are skipped and only the anchor + drag are kept (the
// interaction itself is not decorative).

(function () {
  'use strict';

  var THRESHOLD = 80;
  var RESIST = 0.4;
  var WP = function () { return window.WorkerParticles; };

  var reduced = false;
  try {
    reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  function init() {
    var main = document.querySelector('main');
    if (!main) return;

    var ind = document.createElement('div');
    ind.className = 'wh-ptr';
    ind.setAttribute('aria-hidden', 'true');
    ind.innerHTML = '<div class="wh-ptr-spinner"></div>';
    document.body.appendChild(ind);

    var startY = 0;
    var dragging = false;
    var armed = false;
    var lastEmit = 0;

    // Centre of the indicator in viewport coords as it descends.
    function indCenter(pulled) {
      return { x: window.innerWidth / 2, y: 18 + pulled };
    }

    function emitConverge(target) {
      if (reduced || !WP() || !WP().spawn) return;
      // Throttle emission to ~12 particles/sec while pulling, with a
      // cap of ~14 active 'ptr' particles at any time.
      var now = performance.now();
      if (now - lastEmit < 80) return;
      lastEmit = now;
      if (WP().tagCount && WP().tagCount('ptr') >= 14) return;
      // Spawn from a ring around the viewport edges.
      var edge = Math.random();
      var x, y;
      if (edge < 0.5) { // top
        x = Math.random() * window.innerWidth;
        y = -10 - Math.random() * 30;
      } else if (edge < 0.75) { // left
        x = -10 - Math.random() * 40;
        y = Math.random() * (window.innerHeight * 0.6);
      } else { // right
        x = window.innerWidth + 10 + Math.random() * 40;
        y = Math.random() * (window.innerHeight * 0.6);
      }
      WP().spawn({
        tag: 'ptr',
        x: x, y: y,
        vx: 0, vy: 0,
        behavior: 'converge',
        targetX: target.x, targetY: target.y,
        color: '#00D2BE',
        size: 1.6 + Math.random() * 1.6,
        maxLife: 1.8,
        shape: 'circle',
        alpha: 0.95,
      });
    }

    function flipToOrbit(c) {
      if (reduced || !WP() || !WP().modifyTagged) return;
      WP().modifyTagged('ptr', {
        behavior: 'orbit',
        cx: c.x, cy: c.y,
        radius: 22,
        omega: 7.5,
        angle: Math.random() * Math.PI * 2,
      });
    }

    function explode(c) {
      if (reduced || !WP() || !WP().celebrate) return;
      // Convert orbit particles -> outward ballistic, then layer a
      // celebration burst on top for emphasis.
      WP().removeTagged && WP().removeTagged('ptr');
      WP().celebrate({
        type: 'info', origin: c, intensity: 1.0,
        functional: true,
      });
    }

    main.addEventListener('touchstart', function (e) {
      if (main.scrollTop !== 0) { dragging = false; return; }
      startY = e.touches[0].clientY;
      dragging = true;
      armed = false;
      ind.style.transition = 'none';
      ind.classList.remove('wh-ptr-armed', 'wh-ptr-refreshing');
      if (WP() && WP().removeTagged) WP().removeTagged('ptr');
    }, { passive: true });

    main.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        ind.style.opacity = 0;
        ind.style.transform = 'translate(-50%, 0)';
        return;
      }
      e.preventDefault();
      var pulled = Math.min(dy * RESIST, 120);
      ind.style.transform = 'translate(-50%, ' + pulled + 'px)';
      ind.style.opacity = Math.min(pulled / THRESHOLD, 1);

      var c = indCenter(pulled);
      if (pulled > THRESHOLD && !armed) {
        armed = true;
        ind.classList.add('wh-ptr-armed');
        if (window.WorkerHaptics) window.WorkerHaptics.light();
        flipToOrbit(c);
      } else if (pulled <= THRESHOLD && armed) {
        armed = false;
        ind.classList.remove('wh-ptr-armed');
        // back to converge — set new target and switch behaviour
        if (WP() && WP().modifyTagged) {
          WP().modifyTagged('ptr', { behavior: 'converge', targetX: c.x, targetY: c.y });
        }
      } else if (!armed) {
        emitConverge(c);
      } else {
        // armed and still moving — update orbit centre
        if (WP() && WP().modifyTagged) WP().modifyTagged('ptr', { cx: c.x, cy: c.y });
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
        explode(indCenter(48));
        setTimeout(function () { window.location.reload(); }, 600);
      } else {
        ind.style.transform = 'translate(-50%, 0)';
        ind.style.opacity = 0;
        if (WP() && WP().removeTagged) WP().removeTagged('ptr');
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
