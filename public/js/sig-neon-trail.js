// Neon pen-trail for signature pads.
//
// Draws a soft brand-blue glow that follows the pen while signing and fades
// out shortly after the pen stops. It renders on a SEPARATE overlay canvas
// layered above the signature canvas — purely decorative, so it never touches
// the signed image (toDataURL reads the underlying ink canvas only).
//
// Usage: add `data-neon-trail` to a signature <canvas>; this auto-attaches.
(function () {
  'use strict';

  var RGB = '0,210,190';    // Atomis teal (#00D2BE)
  var FADE = 340;           // ms a point stays lit after it's drawn
  var WIDTH = 1.4;          // trail line width (css px) — thin
  var BLUR = 5;             // glow blur (css px) — soft, subtle
  var ALPHA = 0.3;          // peak line opacity — light
  var GLOW = 0.45;          // peak glow opacity

  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  function attach(canvas) {
    if (!canvas || canvas._neonTrail) return;
    var host = canvas.parentElement;
    if (!host) return;
    canvas._neonTrail = true;

    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var overlay = document.createElement('canvas');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3;';
    host.appendChild(overlay);
    var octx = overlay.getContext('2d');
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    var pts = [], raf = null, pressed = false, w = 0, h = 0;

    function size() {
      var r = canvas.getBoundingClientRect();
      if (!r.width) return;
      w = r.width; h = r.height;
      overlay.width = Math.round(w * dpr);
      overlay.height = Math.round(h * dpr);
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size();
    window.addEventListener('resize', size);

    function pos(e) { var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    function render() {
      octx.clearRect(0, 0, w, h);
      var t = now();
      // Keep only the recent tail; drop old points so the trail recedes.
      while (pts.length && t - pts[0].t > FADE) pts.shift();
      if (pts.length >= 2) {
        // One continuous stroke (not per-segment) so the glow is an even
        // line, never a string of overlapping dots. The whole trail fades
        // out once the pen stops moving.
        var g = Math.max(0, 1 - (t - pts[pts.length - 1].t) / FADE);
        if (g > 0) {
          octx.lineCap = 'round'; octx.lineJoin = 'round';
          octx.beginPath();
          octx.moveTo(pts[0].x, pts[0].y);
          for (var i = 1; i < pts.length; i++) octx.lineTo(pts[i].x, pts[i].y);
          octx.strokeStyle = 'rgba(' + RGB + ',' + (ALPHA * g) + ')';
          octx.lineWidth = WIDTH;
          octx.shadowColor = 'rgba(' + RGB + ',' + (GLOW * g) + ')';
          octx.shadowBlur = BLUR * g;
          octx.stroke();
        }
      }
      if (pts.length) { raf = requestAnimationFrame(render); }
      else { raf = null; octx.clearRect(0, 0, w, h); }
    }
    function push(e) { pts.push({ x: pos(e).x, y: pos(e).y, t: now() }); if (!raf) raf = requestAnimationFrame(render); }

    canvas.addEventListener('pointerdown', function (e) { pressed = true; push(e); }, { passive: true });
    canvas.addEventListener('pointermove', function (e) { if (pressed) push(e); }, { passive: true });
    var release = function () { pressed = false; };
    canvas.addEventListener('pointerup', release, { passive: true });
    canvas.addEventListener('pointercancel', release, { passive: true });
    canvas.addEventListener('pointerleave', release, { passive: true });
  }

  function scan() { document.querySelectorAll('canvas[data-neon-trail]').forEach(attach); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  if (window.MutationObserver) { try { new MutationObserver(scan).observe(document.body, { childList: true, subtree: true }); } catch (e) {} }
  window.SigNeonTrail = { attach: attach };
})();
