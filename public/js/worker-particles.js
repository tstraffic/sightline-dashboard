// Worker portal particle engine — shared canvas, single rAF loop, object
// pool. The web-native translation of @shopify/react-native-skia for our
// 2D needs.
//
// Performance budget (from the brief):
//   - <= 100 active particles globally
//   - 60fps target on a 3-year-old Android
//   - Pause when document.hidden (iOS app switcher, screen lock)
//   - Skip everything under prefers-reduced-motion: reduce, except for
//     "functional" bursts (form-submit celebration) which clients opt
//     into via { functional: true }.
//
// Public API (window.WorkerParticles):
//   .init({ canvasId? })            Lazy-mounts a full-viewport <canvas>
//                                   if one isn't already in the DOM.
//   .setWeather(kind)               Start continuously emitting weather
//                                   particles (rain / snow / sun motes /
//                                   fog wisps / stars). Pass null to stop.
//   .burst({ x, y, type, count })   One-off emission for celebration /
//                                   tap feedback. type ∈ rgbColorPalette.
//   .count()                        Current active particle count.
//
// This PR (2/8) implements the engine + weather emission only. Burst is
// stubbed for PRs 3 & 4 to extend.

(function () {
  'use strict';

  var MAX = 100;
  var DPR = Math.min(window.devicePixelRatio || 1, 2);

  var reduced = false;
  try {
    reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var canvas = null, ctx = null;
  var W = 0, H = 0;
  var particles = [];
  var pool = [];
  var weatherKind = null;
  var emitAccumulator = 0;
  var lastTick = 0;
  var rafId = 0;
  var running = false;

  // ----- Canvas mount + sizing -----------------------------------------
  function mountCanvas(id) {
    canvas = document.getElementById(id);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = id;
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.cssText =
        'position:fixed;inset:0;z-index:1;pointer-events:none;width:100vw;height:100vh;';
      document.body.appendChild(canvas);
    }
    ctx = canvas.getContext('2d', { alpha: true });
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);
  }
  function resize() {
    if (!canvas) return;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // ----- Particle factory + pool --------------------------------------
  function alloc() {
    if (pool.length) return pool.pop();
    return {
      x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1,
      size: 1, color: '#fff', alpha: 1, shape: 'circle',
      angle: 0, vAngle: 0, gravity: 0, drag: 1,
    };
  }
  function recycle(p) {
    if (pool.length < 200) pool.push(p);
  }

  // ----- Weather emission --------------------------------------------
  // Per-condition recipes. Each emit() call may add 0-N particles
  // depending on emit rate + dt. Recipes return an "emit rate" in
  // particles per second; the engine caps total at MAX.
  var WEATHER = {
    rainy:    { rate: 24, init: initRain,    cap: 70 },
    stormy:   { rate: 40, init: initRain,    cap: 90, gust: true },
    snow:     { rate: 14, init: initSnow,    cap: 60 },
    fog:      { rate: 1.5, init: initFog,    cap: 14 },
    sunny:    { rate: 4,  init: initSunMote, cap: 30 },
    night:    { rate: 0.8, init: initStar,   cap: 22, twinkle: true },
    // partly-cloudy / cloudy intentionally idle for now — the orbs and
    // the weather card SVG already carry the cloudiness signal. Pure
    // cloud wisps were hard to read at the brief's 3-8% opacity budget.
  };

  function initRain(p) {
    p.x = Math.random() * (W + 80) - 40;
    p.y = -Math.random() * H - 10;
    p.vx = 1.0 + Math.random() * 0.6;       // slight diagonal drift
    p.vy = 380 + Math.random() * 140;        // px/s
    p.life = 0; p.maxLife = (H + 40) / p.vy;
    p.size = 1.0 + Math.random() * 0.6;      // streak width
    p.color = 'rgba(96,165,250,0.55)';
    p.alpha = 0.55 + Math.random() * 0.25;
    p.shape = 'rain';
  }
  function initSnow(p) {
    p.x = Math.random() * W;
    p.y = -Math.random() * H * 0.4 - 10;
    p.vx = (Math.random() - 0.5) * 18;
    p.vy = 30 + Math.random() * 45;
    p.life = 0; p.maxLife = (H + 30) / p.vy;
    p.size = 1.4 + Math.random() * 2.0;
    p.color = 'rgba(226,232,255,0.85)';
    p.alpha = 0.6 + Math.random() * 0.3;
    p.shape = 'circle';
    p.angle = Math.random() * Math.PI * 2;
    p.vAngle = (Math.random() - 0.5) * 1.2; // gentle sway via sin(angle)
  }
  function initFog(p) {
    p.y = H * (0.3 + Math.random() * 0.5);
    p.x = -120 + Math.random() * 60;
    p.vx = 10 + Math.random() * 8;
    p.vy = (Math.random() - 0.5) * 2;
    p.life = 0; p.maxLife = (W + 240) / p.vx;
    p.size = 120 + Math.random() * 100;
    p.color = 'rgba(203,213,225,0.10)';
    p.alpha = 0.6;
    p.shape = 'fog';
  }
  function initSunMote(p) {
    p.x = Math.random() * W;
    p.y = H + 10;
    p.vx = (Math.random() - 0.5) * 8;
    p.vy = -10 - Math.random() * 18;
    p.life = 0; p.maxLife = 6 + Math.random() * 5;
    p.size = 1.4 + Math.random() * 1.8;
    p.color = 'rgba(253,224,71,0.65)';
    p.alpha = 0.0;
    p.shape = 'circle';
  }
  function initStar(p) {
    p.x = Math.random() * W;
    p.y = Math.random() * H * 0.6;
    p.vx = 0; p.vy = 0;
    p.life = 0; p.maxLife = 4 + Math.random() * 6;
    p.size = 0.8 + Math.random() * 1.4;
    p.color = 'rgba(254,243,199,0.95)';
    p.alpha = 0.0;
    p.shape = 'star';
    p.angle = Math.random() * Math.PI * 2; // for twinkle phase
  }

  function emitWeather(dt) {
    if (!weatherKind) return;
    var recipe = WEATHER[weatherKind];
    if (!recipe) return;
    emitAccumulator += dt * recipe.rate;
    var cap = Math.min(recipe.cap || MAX, MAX);
    while (emitAccumulator >= 1 && particles.length < cap) {
      var p = alloc();
      recipe.init(p);
      particles.push(p);
      emitAccumulator -= 1;
    }
  }

  // ----- Step + render -----------------------------------------------
  function step(now) {
    rafId = requestAnimationFrame(step);
    if (document.hidden) return;
    var dt = lastTick ? Math.min(0.05, (now - lastTick) / 1000) : 0.016;
    lastTick = now;

    emitWeather(dt);

    ctx.clearRect(0, 0, W, H);
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life += dt;

      // motion
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.gravity) p.vy += p.gravity * dt;
      if (p.drag !== 1) { p.vx *= Math.pow(p.drag, dt * 60); p.vy *= Math.pow(p.drag, dt * 60); }

      // shape-specific tweaks
      if (p.shape === 'circle' && p.vAngle) {
        p.angle += p.vAngle * dt;
        p.x += Math.sin(p.angle) * 0.6;
      }
      if (p.shape === 'star') {
        // twinkle alpha (cosine 0..1)
        p.alpha = 0.35 + 0.55 * (0.5 + 0.5 * Math.cos(p.angle + p.life * 2));
      } else if (p.shape === 'circle' && weatherKind === 'sunny') {
        // sun motes fade in then out
        var f = p.life / p.maxLife;
        p.alpha = f < 0.2 ? f * 5 : (f > 0.8 ? (1 - f) * 5 : 1);
      }

      // cull
      var done = p.life >= p.maxLife ||
                 p.y > H + 40 || p.y < -120 ||
                 p.x > W + 240 || p.x < -240;
      if (done) {
        recycle(particles.splice(i, 1)[0]);
        continue;
      }

      // draw
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = p.color;
      ctx.strokeStyle = p.color;
      if (p.shape === 'rain') {
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04);
        ctx.stroke();
      } else if (p.shape === 'fog') {
        // soft horizontal band — a radial gradient ellipse
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.size, p.size * 0.30, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else if (p.shape === 'star') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // circle
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function start() {
    if (running) return;
    running = true;
    lastTick = 0;
    rafId = requestAnimationFrame(step);
  }
  function stop() {
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (ctx) ctx.clearRect(0, 0, W, H);
  }

  // ----- Public API ---------------------------------------------------
  function init(opts) {
    opts = opts || {};
    if (canvas) return; // idempotent
    mountCanvas(opts.canvasId || 'wp-canvas');
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        // Don't fully stop — just skip rendering. Resumes seamlessly.
      } else {
        lastTick = 0; // reset so a long pause doesn't blow dt
      }
    });
  }
  function setWeather(kind) {
    if (reduced) return; // decorative — skip under reduced motion
    weatherKind = (kind && WEATHER[kind]) ? kind : null;
    if (weatherKind && !running) start();
  }
  function count() { return particles.length; }
  function burst(opts) {
    // Placeholder — PRs 3/4 will extend.
    if (reduced && !(opts && opts.functional)) return;
    // (no-op for now)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit);
  } else {
    autoInit();
  }
  function autoInit() {
    // Mount canvas if any element on the page declares a particle kind.
    var trigger = document.querySelector('[data-weather-kind]');
    if (trigger) {
      init();
      setWeather(trigger.getAttribute('data-weather-kind'));
    }
  }

  window.WorkerParticles = {
    init: init,
    setWeather: setWeather,
    burst: burst,
    count: count,
  };
})();
