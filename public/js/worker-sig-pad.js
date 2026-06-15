// Shared signature-pad implementation for the worker portal.
//
// Mirrors the docket-sign drawing exactly so every form's pad behaves the
// same way: smooth quadratic curves (so the ink reads as a continuous
// stroke, not dotty line-segments), device-pixel-ratio scaling (no
// pixellated edges on phones), the same dark slate-blue ink colour
// (#0F172A) and the same line weight (2.2). The neon brand-teal pen trail
// from sig-neon-trail.js is the visual layer above; this is the actual
// signed pixels.
//
// Usage:
//   var pad = WorkerSigPad.setup(canvas, padEl, { onChange: function () { … } });
//   pad.clear();       // wipe the canvas + hide "signed" state
//   pad.getData();     // toDataURL('image/png') or '' if empty
//   pad.hasDrawn();    // boolean
//
// `padEl` is the wrapper element that gets the .signed class added on
// first stroke (callers style this however they like).

(function () {
  'use strict';

  function setup(canvas, padEl, opts) {
    if (!canvas) return null;
    opts = opts || {};
    var ctx = canvas.getContext('2d');
    var drawing = false, hasDrawn = false;
    var last = null, lastMid = null, cssW = 0, cssH = 0;

    function style() {
      ctx.strokeStyle = opts.stroke || '#0F172A';
      ctx.lineWidth = opts.lineWidth || 2.2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
    function resize() {
      var rect = canvas.parentElement.getBoundingClientRect();
      if (!rect.width) return;
      var data = hasDrawn ? canvas.toDataURL() : null;
      var dpr = Math.min(window.devicePixelRatio || 1, 3);
      cssW = rect.width; cssH = rect.height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      style();
      if (data && hasDrawn) {
        var img = new Image();
        img.onload = function () { ctx.drawImage(img, 0, 0, cssW, cssH); };
        img.src = data;
      }
    }
    resize();
    window.addEventListener('resize', resize);

    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    canvas.addEventListener('pointerdown', function (e) {
      drawing = true; hasDrawn = true;
      if (padEl) { padEl.classList.add('signed'); padEl.classList.remove('ds-error'); padEl.classList.remove('cf-error'); }
      last = pos(e); lastMid = last;
      // A tap should leave a dot; without this lone clicks vanish.
      ctx.beginPath();
      ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = opts.stroke || '#0F172A';
      ctx.fill();
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pos(e);
      var mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
      // Quadratic curve through the last point smooths the ink into a
      // continuous stroke instead of straight line-segments.
      ctx.beginPath();
      ctx.moveTo(lastMid.x, lastMid.y);
      ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
      ctx.stroke();
      last = p; lastMid = mid;
      e.preventDefault();
    });
    function end() {
      if (!drawing) return;
      drawing = false;
      ctx.beginPath();
      ctx.moveTo(lastMid.x, lastMid.y);
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
      if (typeof opts.onChange === 'function') opts.onChange();
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointerleave', end);

    return {
      clear: function () {
        ctx.clearRect(0, 0, cssW, cssH);
        hasDrawn = false;
        if (padEl) padEl.classList.remove('signed');
        if (typeof opts.onChange === 'function') opts.onChange();
      },
      getData: function () { return hasDrawn ? canvas.toDataURL('image/png') : ''; },
      hasDrawn: function () { return hasDrawn; },
    };
  }

  window.WorkerSigPad = { setup: setup };
})();
