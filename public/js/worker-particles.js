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
      } else if (p.shape === 'rect') {
        // confetti strip: thin rotated rectangle. End-of-life fade.
        var fr = p.life / p.maxLife;
        ctx.globalAlpha = p.alpha * (1 - Math.max(0, fr - 0.7) / 0.3);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillRect(-p.size, -p.size * 0.35, p.size * 2, p.size * 0.7);
        ctx.restore();
        // advance spin (re-uses vAngle as rad/s)
        p.angle += p.vAngle * dt;
      } else if (p.shape === 'triangle') {
        var ft = p.life / p.maxLife;
        ctx.globalAlpha = p.alpha * (1 - Math.max(0, ft - 0.7) / 0.3);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.beginPath();
        ctx.moveTo(0, -p.size);
        ctx.lineTo(p.size * 0.9, p.size * 0.8);
        ctx.lineTo(-p.size * 0.9, p.size * 0.8);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        p.angle += p.vAngle * dt;
      } else if (p.shape === 'hardhat') {
        // Tiny stylised hard-hat: rounded top + brim rectangle.
        var fh = p.life / p.maxLife;
        ctx.globalAlpha = p.alpha * (1 - Math.max(0, fh - 0.7) / 0.3);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.beginPath();
        // dome
        ctx.arc(0, 0, p.size, Math.PI, 0);
        // brim
        ctx.lineTo(p.size * 1.25, p.size * 0.18);
        ctx.lineTo(-p.size * 1.25, p.size * 0.18);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        p.angle += p.vAngle * dt;
      } else if (p.shape === 'vest') {
        // High-vis vest silhouette: rounded rect with reflective stripe.
        var fv = p.life / p.maxLife;
        ctx.globalAlpha = p.alpha * (1 - Math.max(0, fv - 0.7) / 0.3);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillRect(-p.size, -p.size * 1.1, p.size * 2, p.size * 2.2);
        // stripe across the middle in a contrasting tone
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(-p.size, -p.size * 0.15, p.size * 2, p.size * 0.30);
        ctx.restore();
        p.angle += p.vAngle * dt;
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

  // ----- Celebration burst -------------------------------------------
  // Imperative confetti API: WorkerParticles.celebrate({type, origin,
  // intensity, functional}). Used on form-submit success and streak
  // milestones. functional=true keeps the burst alive under
  // prefers-reduced-motion (form-submit feedback is functional, not
  // decorative).
  var PALETTES = {
    success:   ['#10B981', '#34D399', '#00D2BE', '#FCD34D', '#FFFFFF'],
    streak:    ['#EF4444', '#F97316', '#F59E0B', '#FCD34D', '#FFFFFF'],
    milestone: ['#FACC15', '#8B5CF6', '#2B7FFF', '#00D2BE', '#FFFFFF'],
    info:      ['#2B7FFF', '#60A5FA', '#8B5CF6', '#FFFFFF'],
  };
  var SHAPES = ['rect', 'circle', 'triangle', 'hardhat', 'vest'];

  function spawnConfetti(p, origin, palette) {
    var angle = (-Math.PI / 2) + (Math.random() - 0.5) * (Math.PI * 0.95);
    var speed = 280 + Math.random() * 260;
    p.x = origin.x;
    p.y = origin.y;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.gravity = 720;             // px/s^2 — confetti falls reasonably fast
    p.drag = 0.985;              // mild air resistance per frame
    p.life = 0;
    p.maxLife = 1.6 + Math.random() * 1.4;
    p.size = 6 + Math.random() * 5;
    p.color = palette[(Math.random() * palette.length) | 0];
    p.alpha = 1;
    p.shape = SHAPES[(Math.random() * SHAPES.length) | 0];
    p.angle = Math.random() * Math.PI * 2;
    p.vAngle = (Math.random() - 0.5) * 9; // rad/s spin
  }

  function celebrate(opts) {
    opts = opts || {};
    if (reduced && !opts.functional) return;
    init();
    var type = opts.type || 'success';
    var palette = PALETTES[type] || PALETTES.success;
    var intensity = Math.max(0.25, Math.min(2, opts.intensity || 1));
    var origin = opts.origin || { x: W / 2, y: H * 0.35 };
    // Budget-aware: leave headroom for weather + tap particles.
    var available = MAX - particles.length;
    var wanted = Math.round(40 * intensity);
    var n = Math.max(0, Math.min(available, wanted));
    for (var i = 0; i < n; i++) {
      var p = alloc();
      spawnConfetti(p, origin, palette);
      particles.push(p);
    }
    if (!running) start();
  }

  function burst(opts) { return celebrate(opts); }

  // ----- Tap particles -----------------------------------------------
  // Tiny 3-5 particle burst at the tap point. Decorative — skipped
  // under prefers-reduced-motion. Default colour is brand teal; the
  // delegated listener below derives a tone from a data-particle-color
  // attribute on the target or its closest ancestor.
  function tapBurst(x, y, color) {
    if (reduced) return;
    init();
    var available = MAX - particles.length;
    if (available <= 0) return;
    var n = Math.min(available, 3 + ((Math.random() * 3) | 0));
    var c = color || '#00D2BE';
    for (var i = 0; i < n; i++) {
      var p = alloc();
      var angle = Math.random() * Math.PI * 2;
      var speed = 80 + Math.random() * 120;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed - 30; // slight upward bias
      p.gravity = 280;
      p.drag = 0.94;
      p.life = 0;
      p.maxLife = 0.55 + Math.random() * 0.35;
      p.size = 2 + Math.random() * 2;
      p.color = c;
      p.alpha = 1;
      p.shape = 'circle';
      p.angle = 0; p.vAngle = 0;
      particles.push(p);
    }
    if (!running) start();
  }

  // Delegated pointerdown — fires for any element opting in via
  // data-particle="tap" or any primary CTA (.wd-btn[data-kind="primary"],
  // .wh-act-btn.primary, .wh-fab-main). Skipped if the tap originated
  // inside a disabled element.
  function bindTapDelegation() {
    if (window._wpTapBound) return;
    window._wpTapBound = true;
    document.addEventListener('pointerdown', function (e) {
      var t = e.target.closest && e.target.closest(
        '[data-particle="tap"], .wd-btn[data-kind="primary"], .wh-act-btn.primary, .wh-fab-main'
      );
      if (!t) return;
      if (t.disabled || t.getAttribute('aria-disabled') === 'true') return;
      var color = t.getAttribute('data-particle-color') ||
                  (window.getComputedStyle(t).color) ||
                  '#00D2BE';
      tapBurst(e.clientX, e.clientY, color);
    }, { passive: true });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindTapDelegation);
  } else {
    bindTapDelegation();
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
    celebrate: celebrate,
    burst: burst, // alias of celebrate, kept for parity with the brief
    tapBurst: tapBurst,
    count: count,
  };
})();
