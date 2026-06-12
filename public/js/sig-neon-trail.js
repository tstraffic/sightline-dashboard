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

  var RGB = '43,127,255';   // brand blue (#2B7FFF)
  var FADE = 420;           // ms a point stays lit after it's drawn
  var WIDTH = 3.2;          // trail line width (css px)
  var BLUR = 14;            // glow blur (css px)

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
      while (pts.length && t - pts[0].t > FADE) pts.shift();
      if (pts.length > 1) {
        octx.lineCap = 'round'; octx.lineJoin = 'round';
        octx.shadowColor = 'rgba(' + RGB + ',0.9)';
        for (var i = 1; i < pts.length; i++) {
          var a = Math.max(0, 1 - (t - pts[i].t) / FADE);
          if (a <= 0) continue;
          octx.beginPath();
          octx.moveTo(pts[i - 1].x, pts[i - 1].y);
          octx.lineTo(pts[i].x, pts[i].y);
          octx.strokeStyle = 'rgba(' + RGB + ',' + (0.85 * a) + ')';
          octx.lineWidth = WIDTH;
          octx.shadowBlur = BLUR * a;
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
