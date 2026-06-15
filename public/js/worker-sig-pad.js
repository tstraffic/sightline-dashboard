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

    // Strokes recorded as arrays of {x, y} points in CSS-pixel coordinates.
    // We replay these at export time on a high-resolution offscreen canvas
    // so the PNG that ends up in the docket PDF stays crisp at print size —
    // the on-screen canvas is only ~350×160 at 3× dpr, which looks fuzzy
    // when scaled up for a signature box on an A4 page. Re-rendering the
    // strokes onto a bigger canvas with the same quadratic-curve smoothing
    // gives effectively "vector-quality" output.
    var strokes = [];
    var current = null;
    var STROKE_COLOR = opts.stroke || '#0F172A';
    var STROKE_WIDTH = opts.lineWidth || 2.2;

    function style(c) {
      c.strokeStyle = STROKE_COLOR;
      c.lineWidth = STROKE_WIDTH;
      c.lineCap = 'round';
      c.lineJoin = 'round';
    }
    function resize() {
      var rect = canvas.parentElement.getBoundingClientRect();
      if (!rect.width) return;
      var dpr = Math.min(window.devicePixelRatio || 1, 3);
      cssW = rect.width; cssH = rect.height;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      style(ctx);
      // Re-render any existing strokes so a layout shift / orientation
      // change preserves them at the new size.
      if (hasDrawn) replayInto(ctx, cssW, cssH, 1, STROKE_WIDTH);
    }
    resize();
    window.addEventListener('resize', resize);

    function pos(e) {
      var rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    // Quadratic-curve replay: same algorithm as the live drawing, just over
    // a stored point list. Used for resize repaint AND high-res export.
    function replayInto(targetCtx, w, h, scale, lineWidth) {
      targetCtx.clearRect(0, 0, w, h);
      targetCtx.strokeStyle = STROKE_COLOR;
      targetCtx.lineWidth = lineWidth || STROKE_WIDTH;
      targetCtx.lineCap = 'round';
      targetCtx.lineJoin = 'round';
      targetCtx.fillStyle = STROKE_COLOR;
      strokes.forEach(function (pts) {
        if (!pts || !pts.length) return;
        // Single-point stroke (tap) — render as a dot so it doesn't vanish.
        if (pts.length === 1) {
          targetCtx.beginPath();
          targetCtx.arc(pts[0].x * scale, pts[0].y * scale, (lineWidth || STROKE_WIDTH) / 2, 0, Math.PI * 2);
          targetCtx.fill();
          return;
        }
        var prev = pts[0];
        var prevMid = prev;
        for (var i = 1; i < pts.length; i++) {
          var p = pts[i];
          var mid = { x: (prev.x + p.x) / 2, y: (prev.y + p.y) / 2 };
          targetCtx.beginPath();
          targetCtx.moveTo(prevMid.x * scale, prevMid.y * scale);
          targetCtx.quadraticCurveTo(prev.x * scale, prev.y * scale, mid.x * scale, mid.y * scale);
          targetCtx.stroke();
          prev = p; prevMid = mid;
        }
        // Final tail segment from last midpoint to last point.
        var lastPt = pts[pts.length - 1];
        targetCtx.beginPath();
        targetCtx.moveTo(prevMid.x * scale, prevMid.y * scale);
        targetCtx.lineTo(lastPt.x * scale, lastPt.y * scale);
        targetCtx.stroke();
      });
    }

    canvas.addEventListener('pointerdown', function (e) {
      drawing = true; hasDrawn = true;
      if (padEl) { padEl.classList.add('signed'); padEl.classList.remove('ds-error'); padEl.classList.remove('cf-error'); }
      last = pos(e); lastMid = last;
      current = [{ x: last.x, y: last.y }];
      strokes.push(current);
      // A tap should leave a dot; without this lone clicks vanish.
      ctx.beginPath();
      ctx.arc(last.x, last.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fillStyle = STROKE_COLOR;
      ctx.fill();
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!drawing) return;
      var p = pos(e);
      if (current) current.push({ x: p.x, y: p.y });
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
      current = null;
      if (typeof opts.onChange === 'function') opts.onChange();
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointerleave', end);

    // Build the PNG that ends up in the docket PDF. We replay the strokes
    // onto a high-resolution offscreen canvas (target ≈ 2000px on the long
    // edge) so the embedded image stays crisp when the PDF viewer scales it
    // to a 1.5" signature box. Line width is scaled proportionally so the
    // ink reads about the same weight relative to the box.
    function exportHighRes() {
      if (!hasDrawn || !cssW || !cssH) return '';
      var target = opts.exportLongEdge || 2000;
      var scale = Math.max(1, target / Math.max(cssW, cssH));
      var out = document.createElement('canvas');
      out.width = Math.round(cssW * scale);
      out.height = Math.round(cssH * scale);
      var octx = out.getContext('2d');
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      // Scale the line width slightly less than the canvas — keeps the
      // stroke from looking too thick in a big canvas. (sqrt growth.)
      var exportLineW = STROKE_WIDTH * Math.sqrt(scale);
      replayInto(octx, out.width, out.height, scale, exportLineW);
      return out.toDataURL('image/png');
    }

    return {
      clear: function () {
        strokes = [];
        ctx.clearRect(0, 0, cssW, cssH);
        hasDrawn = false;
        if (padEl) padEl.classList.remove('signed');
        if (typeof opts.onChange === 'function') opts.onChange();
      },
      getData: function () { return exportHighRes(); },
      hasDrawn: function () { return hasDrawn; },
    };
  }

  window.WorkerSigPad = { setup: setup };
})();
