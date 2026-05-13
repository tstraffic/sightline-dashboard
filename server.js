const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const flash = require('connect-flash');
const ejsLayouts = require('express-ejs-layouts');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initializeDatabase } = require('./db/schema');
const { requireLogin, requirePermission, canAccess, canViewInternalCost } = require('./middleware/auth');
const { requireWorker, blockWorkerFromAdmin, workerLocals } = require('./middleware/workerAuth');
const { managerLocals } = require('./middleware/managerAuth');
const { notificationCountMiddleware, generateNotifications, sendDailyDigests, generateWeeklySummaries } = require('./middleware/notifications');
const { settingsMiddleware } = require('./middleware/settings');
const { sidebarBadges } = require('./middleware/sidebarBadges');
const { chatUnreadCountMiddleware } = require('./middleware/chat');
const { initVapid } = require('./services/pushNotification');
const { sendUpcomingShiftReminders } = require('./services/shiftReminders');
const { csrfProtection } = require('./middleware/csrf');

// Initialize database and seed data
initializeDatabase();

// Ensure default chat channels exist
const { ensureDefaultChannels } = require('./lib/chat');
ensureDefaultChannels();

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(ejsLayouts);
app.set('layout', 'layout');
app.set('layout extractScripts', true);

// Security headers
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for Tailwind CDN + inline scripts
  crossOriginEmbedderPolicy: false,
}));

// Middleware
// parameterLimit raised from default 1000 because the bulk Worker Rates form
// (/payroll/rates) submits ~14 fields per employee in a single POST. With
// 70+ employees the default limit is exceeded and body-parser throws before
// the route handler runs — Express then returns a generic 500.
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100000 }));
app.use(express.json());
// Service worker must never be cached by the browser HTTP cache — otherwise
// updates can take 24+ hours to roll out on iOS PWAs. The SW itself uses
// caches.match() to control resource caching internally; this header just
// forces the browser to always re-fetch the SW script.
app.get(['/js/worker-sw.js', '/js/admin-sw.js'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/data/uploads', express.static(path.join(__dirname, 'data', 'uploads')));
// Serve the full pdfjs-dist asset tree from node_modules so the worker
// portal's in-browser viewer has everything it needs:
//   /vendor/pdfjs/legacy/build/pdf.min.js          UMD bundle (older browsers)
//   /vendor/pdfjs/legacy/build/pdf.worker.min.js   Worker for legacy bundle
//   /vendor/pdfjs/legacy/web/viewer.html           Prebuilt fallback viewer
//   /vendor/pdfjs/cmaps/                           Character maps (CJK + composite fonts)
//   /vendor/pdfjs/standard_fonts/                  Helvetica/Times/Courier fallbacks
// Node-canvas (the server-side renderer) doesn't build on Railway's default
// Nixpacks; rendering in the browser sidesteps that entirely. Public — no
// auth on these static assets; PDFs themselves are still served via
// auth-gated routes.
app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist'), {
  maxAge: '30d',
  immutable: true,
}));

// Prevent caching of HTML pages so service worker always gets fresh content
app.use((req, res, next) => {
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.includes('text/html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Sessions (secure cookies in production)
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT === 'production';
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || (isProduction ? (() => { console.warn('WARNING: SESSION_SECRET not set in production!'); return require('crypto').randomBytes(32).toString('hex'); })() : 'dev-session-secret'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
  }
}));

// Trust proxy for Railway (needed for secure cookies behind load balancer)
if (isProduction) app.set('trust proxy', 1);

app.use(flash());

// Global date formatters — DD/MM/YYYY in Sydney time.
// All formatters delegate to lib/sydney.js so DST is handled automatically
// (Australia/Sydney via Intl) and plain DATE columns aren't shifted across
// midnight by tz conversion.
const { formatDateAU, formatDateShortAU, formatDateTimeAU, formatTimeAU } = require('./lib/sydney');

// Flash messages + permission helper available in all templates
app.use((req, res, next) => {
  res.locals.flash_success = req.flash('success');
  res.locals.flash_error = req.flash('error');
  res.locals.user = req.session.user || null;
  res.locals.canAccess = canAccess;
  res.locals.canSeeCost = canViewInternalCost(req.session.user);
  res.locals.formatDate = formatDateAU;
  res.locals.formatDateShort = formatDateShortAU;
  res.locals.formatDateTime = formatDateTimeAU;
  res.locals.formatTime = formatTimeAU;
  next();
});

// CSRF protection (after session + flash, before routes)
app.use(csrfProtection);

// Notification count available in all templates (header bell badge)
app.use(notificationCountMiddleware);

// Settings available in all templates (dropdown options, system config)
app.use(settingsMiddleware);

// Sidebar badge counts (cached 60s)
app.use(sidebarBadges);

// Chat unread count available in all templates
app.use(chatUnreadCountMiddleware);

// Public invite/setup routes (no auth required, must be BEFORE blockWorkerFromAdmin)
app.use('/invite', require('./routes/invite'));
app.use('/w/setup', require('./routes/worker/setup'));
// Induction admin routes (must be BEFORE public /induction/:type to avoid catch-all)
app.use('/induction/admin/recruitment', requireLogin, requirePermission('induction'), require('./routes/recruitment'));
app.use('/induction/admin', requireLogin, requirePermission('induction'), require('./routes/induction-admin'));
app.use('/induction', require('./routes/induction'));
app.use('/training', require('./routes/training'));
// Public token-protected SOP sign-off (no auth required, scoped by URL token)
app.use('/sop-sign', require('./routes/sop-sign'));

// Rate limiting on login endpoints (prevent brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: 'Too many login attempts, please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/login', loginLimiter);
app.post('/w/login', loginLimiter);

// Worker Portal routes (must be BEFORE blockWorkerFromAdmin)
app.use('/w', require('./routes/worker/auth'));
// Apply managerLocals once so every /w page has res.locals.isManager available
app.use('/w', (req, res, next) => { if (req.session && req.session.worker) require('./middleware/managerAuth').managerLocals(req, res, next); else next(); });
app.use('/w', requireWorker, workerLocals, require('./routes/worker/home'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/jobs'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/clock'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/shifts'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/chat'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/timesheets'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/availability'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/incidents'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/training'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/dockets'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/hr'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/hr-secure'));
app.use('/w', requireWorker, workerLocals, managerLocals, require('./routes/worker/kudos'));
app.use('/w', requireWorker, workerLocals, managerLocals, require('./routes/worker/manage'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/profile'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/forms'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/custom-checklists'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/notifications'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/safety'));
app.get('/w/more', requireWorker, workerLocals, (req, res) => {
  res.locals.isManager = require('./middleware/managerAuth').isManager(req.session.worker);
  res.render('worker/more', { title: 'More', currentPage: 'more' });
});

// Block worker-only sessions from admin routes
app.use(blockWorkerFromAdmin);

// Force password change for accounts with default credentials
app.use((req, res, next) => {
  if (req.session && req.session.user) {
    // Check if user must change password (lazy check from DB)
    if (req.session._mustChangePassword === undefined) {
      try {
        const { getDb } = require('./db/database');
        const db = getDb();
        const row = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(req.session.user.id);
        req.session._mustChangePassword = row && row.must_change_password ? true : false;
      } catch (e) { req.session._mustChangePassword = false; }
    }
    if (req.session._mustChangePassword) {
      // Allow access to profile, logout, and static assets only
      const allowed = ['/profile', '/logout', '/login'];
      const isAllowed = allowed.some(p => req.path === p || req.path.startsWith(p + '/'));
      if (!isAllowed && !req.path.startsWith('/css') && !req.path.startsWith('/js') && !req.path.startsWith('/images') && !req.path.startsWith('/notifications/push')) {
        req.flash('error', 'Please change your password before continuing. Your account is using a default password.');
        return res.redirect('/profile');
      }
    }
  }
  next();
});

// Routes (auth is public, everything else requires login + permission)
app.use('/', require('./routes/auth'));
app.use('/profile', requireLogin, require('./routes/profile'));
app.use('/dashboard', requireLogin, requirePermission('dashboard'), require('./routes/dashboard'));
app.use('/projects', requireLogin, requirePermission('projects'), require('./routes/projects'));
app.use('/clients', requireLogin, requirePermission('clients'), require('./routes/clients'));
app.use('/jobs', requireLogin, requirePermission('jobs'), require('./routes/jobs'));
app.use('/tenders', requireLogin, requirePermission('tenders'), require('./routes/tenders'));
app.use('/tasks', requireLogin, requirePermission('tasks'), require('./routes/tasks'));
app.use('/compliance', requireLogin, requirePermission('compliance'), require('./routes/compliance'));
app.use('/audits', requireLogin, requirePermission('audits'), require('./routes/audits'));
// Job-Pack submission review (workers fill at /w/forms/...; office opens here)
app.use('/safety-forms', requireLogin, requirePermission('audits'), require('./routes/safety-forms'));
// Automated Checklist Register (replaces the manual office spreadsheet)
app.use('/checklist-register', requireLogin, requirePermission('audits'), require('./routes/checklist-register'));
// Worker-signed dockets (review-only — workers create them at /w/dockets/sign)
app.use('/dockets', requireLogin, requirePermission('audits'), require('./routes/dockets-admin'));
// Operations Tasks Board — assign per-shift or general tasks to crew
app.use('/shift-tasks', requireLogin, requirePermission('tasks'), require('./routes/shift-tasks-admin'));
app.use('/leave-approvals', requireLogin, requirePermission('leave_approvals'), require('./routes/leave-approvals'));
app.use('/plans', requireLogin, requirePermission('compliance'), require('./routes/plans'));
app.use('/incidents', requireLogin, requirePermission('incidents'), require('./routes/incidents'));
app.use('/contacts', requireLogin, requirePermission('contacts'), require('./routes/contacts'));
app.use('/documents', requireLogin, requirePermission('documents'), require('./routes/documents'));
app.use('/activity', requireLogin, requirePermission('activity'), require('./routes/activity'));
app.use('/budgets', requireLogin, requirePermission('budgets'), require('./routes/budgets'));
app.use('/finance/pnl', requireLogin, require('./routes/finance-pnl'));
app.use('/timesheets', requireLogin, requirePermission('timesheets'), require('./routes/timesheets'));
app.use('/crew', requireLogin, requirePermission('crew'), require('./routes/crew'));
app.use('/bookings', requireLogin, requirePermission('bookings'), require('./routes/bookings'));
app.use('/allocations', requireLogin, requirePermission('allocations'), require('./routes/allocations'));
app.use('/schedule', requireLogin, requirePermission('schedule'), require('./routes/schedule'));
app.use('/equipment/hire-dockets', requireLogin, requirePermission('equipment'), require('./routes/equipmentHireDockets'));
app.use('/equipment', requireLogin, requirePermission('equipment'), require('./routes/equipment'));
app.use('/checklists', requireLogin, requirePermission('checklists'), require('./routes/checklists'));
app.use('/swms', requireLogin, requirePermission('swms'), require('./routes/swms'));
app.use('/sop-register', requireLogin, requirePermission('sop_register'), require('./routes/sop-register'));
app.use('/safety-updates', requireLogin, requirePermission('safety_updates'), require('./routes/safety-updates'));
app.use('/toolbox-talks', requireLogin, requirePermission('toolbox_talks'), require('./routes/toolbox-talks'));
app.use('/safety-comments', requireLogin, requirePermission('safety_comments'), require('./routes/safety-comments'));
app.use('/safety-quizzes', requireLogin, requirePermission('safety_quizzes'), require('./routes/safety-quizzes'));
app.use('/safety-reports', requireLogin, requirePermission('safety_reports'), require('./routes/safety-reports'));
app.use('/risk-assessments', requireLogin, requirePermission('risk_assessments'), require('./routes/risk-assessments'));
app.use('/exports', requireLogin, requirePermission('exports'), require('./routes/exports'));
app.use('/reports', requireLogin, requirePermission('reports'), require('./routes/reports'));
app.use('/marketing', requireLogin, requirePermission('marketing'), require('./routes/marketing'));
app.use('/hr', requireLogin, require('./routes/hr-secure'));
app.use('/hr', requireLogin, require('./routes/hr'));
app.use('/kudos-admin', requireLogin, require('./routes/kudos-admin'));
app.use('/payroll', requireLogin, require('./routes/payslips-admin'));
app.use('/payroll', requireLogin, require('./routes/payroll-runs'));
app.use('/finance', requireLogin, require('./routes/abergeldie-payments'));
app.use('/crm', requireLogin, requirePermission('crm'), require('./routes/crm'));
app.use('/opportunities', requireLogin, requirePermission('crm'), require('./routes/opportunities'));
app.use('/chat', requireLogin, require('./routes/chat'));
app.use('/notifications', requireLogin, requirePermission('notifications'), require('./routes/notifications'));
app.use('/admin/integrations', requireLogin, requirePermission('admin'), require('./routes/integrations'));
app.use('/admin', requireLogin, requirePermission('admin'), require('./routes/admin'));
app.use('/settings', requireLogin, requirePermission('settings'), require('./routes/settings'));
app.use('/api/views', requireLogin, require('./routes/saved-views'));

// Roster redirects to crew page
app.get('/roster', requireLogin, (req, res) => res.redirect('/crew'));

// Home redirects to dashboard or worker portal
app.get('/', (req, res) => {
  if (req.session.worker) return res.redirect('/w/home');
  if (req.session.user) return res.redirect('/dashboard');
  res.redirect('/login');
});

// 404
app.use((req, res) => {
  // If on a worker path, render worker error page
  if (req.path.startsWith('/w') && req.session && req.session.worker) {
    return res.status(404).render('worker/error', {
      layout: 'worker/layout',
      title: '404 Not Found',
      message: 'The page you are looking for does not exist.',
      worker: req.session.worker,
      currentPage: '',
    });
  }
  res.status(404).render('error', {
    title: '404 Not Found',
    message: 'The page you are looking for does not exist.',
    user: req.session.user || null
  });
});

// Error handler
app.use((err, req, res, _next) => {
  console.error('Server error:', err.message, isProduction ? '' : err.stack);
  // Worker routes get worker error page
  if (req.path.startsWith('/w') && req.session && req.session.worker) {
    return res.status(500).render('worker/error', {
      layout: 'worker/layout',
      title: 'Server Error',
      message: 'Something went wrong. Please try again.',
      worker: req.session.worker,
      currentPage: '',
    });
  }
  res.status(500).render('error', {
    title: 'Server Error',
    message: 'Something went wrong. Please try again.',
    user: req.session.user || null
  });
});

app.listen(PORT, () => {
  console.log(`T&S Operations Dashboard running at http://localhost:${PORT} (build 117)`);

  // ── Production security checks ──
  if (isProduction) {
    if (!process.env.SESSION_SECRET) {
      console.warn('⚠️  SECURITY: SESSION_SECRET not set! Sessions use an auto-generated secret that changes on restart.');
    }
    if (!process.env.RESEND_API_KEY && !(process.env.SMTP_PASS && process.env.SMTP_PASS.startsWith('re_'))) {
      console.warn('⚠️  EMAIL: No Resend API key configured. Password resets and notifications will not send.');
    }
    const fromEmail = process.env.SMTP_FROM_EMAIL || '';
    if (fromEmail.includes('resend.dev')) {
      console.warn('⚠️  EMAIL: Still using onboarding@resend.dev. Verify your domain in Resend for custom from address.');
    }
  } else {
    console.log(`Dev login: admin / admin123`);
  }

  // Initialize web push VAPID keys
  initVapid();

  // Generate notifications on startup and every 15 minutes
  generateNotifications();
  setInterval(generateNotifications, 15 * 60 * 1000);

  // 24-hour shift reminders for workers — push notifications fire ~24h
  // before shift start so they can confirm/accept ahead of time. Runs
  // every 15 min (matches the alloc / booking-roster cadence).
  sendUpcomingShiftReminders();
  setInterval(sendUpcomingShiftReminders, 15 * 60 * 1000);

  // Daily digest emails — check every 15 min, send at 7:00 AM
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 7 && now.getMinutes() < 15) {
      console.log('Sending daily digest emails...');
      sendDailyDigests();
    }
  }, 15 * 60 * 1000);

  // Weekly job summaries — Monday 7:15-7:29 AM, summarise diary entries and notify Taj + Saadat
  setInterval(() => {
    const now = new Date();
    if (now.getDay() === 1 && now.getHours() === 7 && now.getMinutes() >= 15 && now.getMinutes() < 30) {
      console.log('Generating weekly job summaries...');
      generateWeeklySummaries();
    }
  }, 15 * 60 * 1000);
});
