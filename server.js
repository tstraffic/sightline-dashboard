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
const { advanceShiftStatuses, sendInShiftFormsReminders } = require('./services/shiftAdvance');
const { sendCertExpiryReminders } = require('./services/certExpiryReminders');
const { sendSwmsExpiryReminders } = require('./services/swmsExpiryReminders');
const { sendInductionReminders } = require('./services/inductionReminders');
const { sendInductionEmailReminders } = require('./services/inductionEmailReminders');
const { csrfProtection } = require('./middleware/csrf');
const { tenantMiddleware } = require('./middleware/tenant');

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
app.get(['/worker-sw.js', '/admin-sw.js', '/js/worker-sw.js'], (req, res, next) => {
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
// docx-preview + jszip are the client-side Word renderer (mirrors the pdfjs
// setup). Workers' iOS Safari can't render docx natively, and the server-
// side LibreOffice approach was unreliable on Railway — so we render the
// docx in the browser using docx-preview, served same-origin so the worker
// session cookie covers it.
app.use('/vendor/docx-preview', express.static(path.join(__dirname, 'node_modules', 'docx-preview', 'dist'), {
  maxAge: '30d',
  immutable: true,
}));
app.use('/vendor/jszip', express.static(path.join(__dirname, 'node_modules', 'jszip', 'dist'), {
  maxAge: '30d',
  immutable: true,
}));
// Motion One — the worker-motion bootstrap (public/js/worker-motion.js)
// reads window.Motion to spring-animate UI behaviours via the Web
// Animations API. Same self-host pattern as pdfjs / docx-preview so the
// service worker can cache it.
app.use('/vendor/motion', express.static(path.join(__dirname, 'node_modules', 'motion', 'dist'), {
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
// Trust the Railway TLS-terminating proxy so req.secure / X-Forwarded-Proto
// work correctly. MUST be set before session() so cookie.secure can be
// honoured for proxied HTTPS requests.
if (isProduction) app.set('trust proxy', 1);
// SESSION_SECRET is mandatory in production. Falling back to an ephemeral
// random secret silently invalidates every session on each restart (defeats
// the 30-day rolling login below) — refuse to boot instead so the missing
// env var is caught at deploy time, not discovered as "everyone got logged
// out again".
if (isProduction && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production. Set it in the Railway service variables and redeploy.');
  process.exit(1);
}
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false,
  saveUninitialized: false,
  // rolling: refresh the cookie's expiry on every response so an active
  // user is never logged out mid-use. Combined with the 30-day maxAge this
  // means people only re-login after 30 days of *no* visits — phones and
  // PCs stay signed in independently. (Sessions surviving restarts also
  // requires a fixed SESSION_SECRET — see the warning below.)
  rolling: true,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
  }
}));

app.use(flash());

// Global date formatters — DD/MM/YYYY in Sydney time.
// All formatters delegate to lib/sydney.js so DST is handled automatically
// (Australia/Sydney via Intl) and plain DATE columns aren't shifted across
// midnight by tz conversion.
const { formatDateAU, formatDateShortAU, formatDateTimeAU, formatTimeAU, parseAsSydney } = require('./lib/sydney');

// Identifies THIS running instance. Railway sets these per deploy, so the
// value changes the moment a new container takes over — which is what lets a
// loaded tab notice it's running old code (see the Refresh control in
// views/partials/header.ejs). Locally it falls back to boot time, so a
// restart also counts as a new build.
const APP_BUILD = String(
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.RAILWAY_DEPLOYMENT_ID ||
  process.env.SOURCE_VERSION ||
  Date.now()
).slice(0, 12);

// Cheap, unauthenticated build probe. The admin shell polls this to tell
// whether the server has moved on since the page was served. Deliberately
// tiny and no-store: it must never itself be cached.
app.get('/__build', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.json({ build: APP_BUILD });
});

// Flash messages + permission helper available in all templates
app.use((req, res, next) => {
  res.locals.appBuild = APP_BUILD;
  res.locals.flash_success = req.flash('success');
  res.locals.flash_error = req.flash('error');
  res.locals.user = req.session.user || null;
  // Theme preference: lazy-load once per session from users.preferences so the
  // chosen theme follows the user to a fresh browser/device (localStorage still
  // takes precedence client-side for instant, FOUC-free application).
  if (req.session.user && typeof req.session.user.theme === 'undefined') {
    try {
      const { getDb } = require('./db/database');
      const row = getDb().prepare('SELECT preferences FROM users WHERE id = ?').get(req.session.user.id);
      const prefs = JSON.parse((row && row.preferences) || '{}');
      req.session.user.theme = (prefs && typeof prefs.theme === 'string') ? prefs.theme : '';
    } catch (e) { req.session.user.theme = ''; }
  }
  res.locals.canAccess = canAccess;
  res.locals.canSeeCost = canViewInternalCost(req.session.user);
  res.locals.formatDate = formatDateAU;
  res.locals.formatDateShort = formatDateShortAU;
  res.locals.formatDateTime = formatDateTimeAU;
  res.locals.formatTime = formatTimeAU;
  res.locals.parseAsSydney = parseAsSydney;
  next();
});

// CSRF protection (after session + flash, before routes)
app.use(csrfProtection);

// Tenant resolution — attaches req.tenant + req.db (tenantDb wrapper).
// Phase 0: hardcoded to 'ts'. Phase 3 Prompt 03.A swaps in real
// subdomain lookup. Routes that haven't been migrated to req.db yet
// keep using getDb() directly; those are flagged by `npm run lint:tenant`
// as the Phase 2 work list.
app.use(tenantMiddleware);

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
app.use('/toolbox-attend', require('./routes/toolbox-attend'));
// Public VOC cert verification (auditors scan a QR on a printed cert).
// Mounted before blockWorkerFromAdmin so it works in any session state.
app.use('/voc', require('./routes/voc-public'));
// Public token-protected contract signing (new hires have no login yet;
// the unguessable URL token is the capability). CSRF skipped by prefix in
// middleware/csrf.js.
app.use('/contract-sign', require('./routes/contract-sign'));

// Rate limiting on login endpoints (prevent brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: 'Too many login attempts, please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
  // The e2e suite logs in dozens of times per run from one IP — without
  // this skip the later specs 429 and fail order-dependently.
  skip: () => process.env.NODE_ENV === 'test',
});
app.post('/login', loginLimiter);
app.post('/w/login', loginLimiter);

// Rate limiting on password / PIN reset endpoints. Lower cap, longer
// window than login because the legitimate use case is rare (a few times
// a year per worker, even rarer for office staff) and the abuse vector
// is email-spam DoS — the response sends a reset email regardless of
// whether the address exists, so spammers can use these endpoints to
// hammer inboxes. The cap also prevents a single attacker grinding
// through usernames hoping to trigger reset-link interception.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 reset attempts per IP per hour
  message: 'Too many password reset attempts, please try again in 1 hour.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.post('/forgot-password', resetLimiter);
app.post('/w/forgot-pin', resetLimiter);

// Worker Portal routes (must be BEFORE blockWorkerFromAdmin)
app.use('/w', require('./routes/worker/auth'));
// Apply managerLocals once so every /w page has res.locals.isManager available
app.use('/w', (req, res, next) => { if (req.session && req.session.worker) require('./middleware/managerAuth').managerLocals(req, res, next); else next(); });
app.use('/w', requireWorker, workerLocals, require('./routes/worker/home'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/jobs'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/clock'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/shifts'));
app.use('/w', requireWorker, workerLocals, require('./routes/worker/chat'));
// Worker timesheets removed — traffic control workflow uses end-of-shift
// docket signing, not self-submitted hours. Old deep links redirect to
// dockets. The admin-side timesheets module still exists for office use.
app.use('/w/timesheets', requireWorker, (req, res) => res.redirect('/w/dockets'));
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
app.use('/w', requireWorker, workerLocals, require('./routes/worker/birthday'));
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
      // Allow access to profile, logout, static assets — and the whole
      // worker portal: the gate protects office surfaces, and yanking an
      // admin out of /w mid-shift into /profile intertwines the portals.
      const allowed = ['/profile', '/logout', '/login', '/w'];
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
// /feedback — POST /submit is open to both portals (auth inside the route
// based on session.user vs session.worker); GET / and admin actions are
// gated inside the route too. Mounted before /dashboard so the bare
// /feedback URL is unambiguous.
app.use('/feedback', require('./routes/feedback'));
app.use('/dashboard', requireLogin, requirePermission('dashboard'), require('./routes/dashboard'));
app.use('/notes', requireLogin, requirePermission('notes'), require('./routes/notes'));
// Company Meetings — weekly all-of-company minutes (admin/management). Dept
// slices render on the dept hubs via routes/departments.js, not here.
app.use('/meetings', requireLogin, requirePermission('meetings'), require('./routes/meetings'));
// Department home pages — no requirePermission here: access depends on :key,
// enforced per-department inside the router (lib/departments.js accessKeys).
app.use('/departments', requireLogin, require('./routes/departments'));
app.use('/projects', requireLogin, requirePermission('projects'), require('./routes/projects'));
app.use('/clients', requireLogin, requirePermission('clients'), require('./routes/clients'));
app.use('/jobs', requireLogin, requirePermission('jobs'), require('./routes/jobs'));
app.use('/tenders', requireLogin, requirePermission('tenders'), require('./routes/tenders'));
// Quoting Module — fixed-price offers (vs. tenders = competitive bids).
// /rate-cards/settings = singleton-row admin form; /rate-cards = CRUD over
// rate cards + nested items; /quotes (later) = the quote builder. Settings
// must be mounted FIRST so its '/' route shadows what would otherwise be a
// GET /rate-cards/:id matching 'settings' as an integer-coerced id.
app.use('/rate-cards/settings', requireLogin, requirePermission('quoting'), require('./routes/quoting/settings'));
app.use('/rate-cards',          requireLogin, requirePermission('quoting'), require('./routes/quoting/rate-cards'));
app.use('/quotes',              requireLogin, requirePermission('quoting'), require('./routes/quoting/quotes'));
app.use('/tasks', requireLogin, requirePermission('tasks'), require('./routes/tasks'));
app.use('/compliance', requireLogin, requirePermission('compliance'), require('./routes/compliance'));
// Safety command centre — cross-module roll-up; first item in the SAFETY group.
app.use('/safety-today', requireLogin, requirePermission('safety_today'), require('./routes/safety-today'));
app.get('/safety', requireLogin, (req, res) => res.redirect('/safety-today'));
// Cross-audit reporting dashboard — mounted BEFORE /audits so /audits/reports
// isn't captured by the /audits/:id show route.
app.use('/audits/reports', requireLogin, requirePermission('audits'), require('./routes/audit-reports'));
app.use('/audits', requireLogin, requirePermission('audits'), require('./routes/audits'));
// Vehicle Audits (Safety) — yard/site roadworthiness checks against the fleet register
app.use('/vehicle-audits', requireLogin, requirePermission('audits'), require('./routes/vehicle-audits'));
// Central cross-audit / cross-incident open-actions register
app.use('/actions', requireLogin, requirePermission('incidents'), require('./routes/actions'));
// Crew ↔ HR employee linking (bridge for per-person audit tagging)
app.use('/crew-link', requireLogin, requirePermission('audits'), require('./routes/crew-link'));
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
app.use('/ctmps', requireLogin, requirePermission('compliance'), require('./routes/ctmps'));
app.use('/tgs-risk-assessments', requireLogin, requirePermission('compliance'), require('./routes/tgs-risk-assessments'));
app.use('/incidents', requireLogin, requirePermission('incidents'), require('./routes/incidents'));
app.use('/contacts', requireLogin, requirePermission('contacts'), require('./routes/contacts'));
app.use('/documents', requireLogin, requirePermission('documents'), require('./routes/documents'));
app.use('/activity', requireLogin, requirePermission('activity'), require('./routes/activity'));
app.use('/budgets', requireLogin, requirePermission('budgets'), require('./routes/budgets'));
app.use('/finance/pnl', requireLogin, require('./routes/finance-pnl'));
app.use('/finance/invoicing', requireLogin, requirePermission('invoicing'), require('./routes/invoicing'));
app.use('/timesheets', requireLogin, requirePermission('timesheets'), require('./routes/timesheets'));
app.use('/crew', requireLogin, requirePermission('crew'), require('./routes/crew'));
app.use('/bookings', requireLogin, requirePermission('bookings'), require('./routes/bookings'));
app.use('/traffio-imports', requireLogin, requirePermission('traffio_imports'), require('./routes/traffio-imports'));
app.use('/allocations', requireLogin, requirePermission('allocations'), require('./routes/allocations'));
app.use('/schedule', requireLogin, requirePermission('schedule'), require('./routes/schedule'));
app.use('/equipment/hire-dockets', requireLogin, requirePermission('equipment'), require('./routes/equipmentHireDockets'));
app.use('/equipment/hire', requireLogin, requirePermission('equipment'), require('./routes/equipmentHires'));
app.use('/equipment', requireLogin, requirePermission('equipment'), require('./routes/equipment'));
app.use('/fleet', requireLogin, requirePermission('fleet'), require('./routes/fleet'));
app.use('/checklists', requireLogin, requirePermission('checklists'), require('./routes/checklists'));
app.use('/swms', requireLogin, requirePermission('swms'), require('./routes/swms'));
app.use('/sop-register', requireLogin, requirePermission('sop_register'), require('./routes/sop-register'));
app.use('/safety-updates', requireLogin, requirePermission('safety_updates'), require('./routes/safety-updates'));
app.use('/toolbox-talks', requireLogin, requirePermission('toolbox_talks'), require('./routes/toolbox-talks'));
app.use('/safety-comments', requireLogin, requirePermission('safety_comments'), require('./routes/safety-comments'));
app.use('/safety-quizzes', requireLogin, requirePermission('safety_quizzes'), require('./routes/safety-quizzes'));
app.use('/safety-workshops', requireLogin, requirePermission('safety_workshops'), require('./routes/safety-workshops'));
// /wq/:code is public-no-auth (capability = session_code from QR). CSRF
// is skipped for this prefix in middleware/csrf.js; the session_code
// lives in the URL so it's already in any request.
app.use('/wq', require('./routes/workshop-participant'));
app.use('/safety-reports', requireLogin, requirePermission('safety_reports'), require('./routes/safety-reports'));
app.use('/risk-assessments', requireLogin, requirePermission('risk_assessments'), require('./routes/risk-assessments'));
app.use('/voc-assessments', requireLogin, requirePermission('voc'), require('./routes/voc-assessments'));
app.use('/voc-templates', requireLogin, requirePermission('voc_admin'), require('./routes/voc-templates'));
app.use('/exports', requireLogin, requirePermission('exports'), require('./routes/exports'));
app.use('/reports', requireLogin, requirePermission('reports'), require('./routes/reports'));
app.use('/marketing', requireLogin, requirePermission('marketing'), require('./routes/marketing'));
app.use('/hr', requireLogin, require('./routes/hr-secure'));
app.use('/hr', requireLogin, require('./routes/hr'));
app.use('/contracts', requireLogin, require('./routes/contracts'));
app.use('/kudos-admin', requireLogin, require('./routes/kudos-admin'));
app.use('/payroll', requireLogin, require('./routes/payslips-admin'));
app.use('/payroll', requireLogin, require('./routes/payroll-runs'));
app.use('/finance', requireLogin, require('./routes/abergeldie-payments'));
// Sidebar nav registry — one require at boot, visible to every render.
app.locals.sidebarNav = require('./lib/sidebarNav');

// /crm/accounts merged into /clients?view=crm (two lists over one table).
// Query preserved so saved filter links keep working; requireLogin only —
// the destination self-gates (non-CRM users get the plain directory).
app.get('/crm/accounts', requireLogin, (req, res) => {
  const qs = new URLSearchParams({ view: 'crm' });
  for (const k of ['search', 'owner', 'type', 'status', 'priority', 'dormant', 'no_action']) {
    if (req.query[k] != null && req.query[k] !== '') qs.set(k, req.query[k]);
  }
  res.redirect('/clients?' + qs.toString());
});
app.use('/crm', requireLogin, requirePermission('crm'), require('./routes/crm'));
app.use('/opportunities', requireLogin, requirePermission('crm'), require('./routes/opportunities'));
app.use('/referrals', requireLogin, requirePermission('crm'), require('./routes/referrals'));
app.use('/proposals', requireLogin, requirePermission('crm'), require('./routes/proposals'));
app.use('/service-packages', requireLogin, requirePermission('projects'), require('./routes/service-packages'));
app.use('/deliverables', requireLogin, requirePermission('projects'), require('./routes/deliverables'));
app.use('/approvals', requireLogin, requirePermission('projects'), require('./routes/approvals'));
app.use('/variations', requireLogin, requirePermission('projects'), require('./routes/variations'));
app.use('/client-inputs', requireLogin, requirePermission('projects'), require('./routes/client-inputs'));
app.use('/correspondence', requireLogin, requirePermission('projects'), require('./routes/correspondence'));
app.use('/time', requireLogin, requirePermission('projects'), require('./routes/time'));
app.use('/chat', requireLogin, require('./routes/chat'));
app.use('/notifications', requireLogin, requirePermission('notifications'), require('./routes/notifications'));
app.use('/admin/integrations', requireLogin, requirePermission('admin'), require('./routes/integrations'));
app.use('/admin', requireLogin, requirePermission('admin'), require('./routes/admin-permissions'));
app.use('/admin', requireLogin, requirePermission('admin'), require('./routes/admin'));
app.use('/settings', requireLogin, requirePermission('settings'), require('./routes/settings'));
app.use('/api/views', requireLogin, require('./routes/saved-views'));

// Roster redirects to crew page
app.get('/roster', requireLogin, (req, res) => res.redirect('/crew'));

// Home routes to whichever portal was used last; single-session users go
// straight to their side, dual-session users (admins who also use the crew
// app) follow lastPortal so neither portal hijacks the other.
app.get('/', (req, res) => {
  const { user, worker, lastPortal } = req.session;
  if (user && worker) return res.redirect(lastPortal === 'admin' ? '/dashboard' : '/w/home');
  if (worker) return res.redirect('/w/home');
  if (user) return res.redirect('/dashboard');
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
  console.log(`Atomis running at http://localhost:${PORT} (build ${APP_BUILD})`);

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

  // Time-based booking lifecycle: roll shifts to in_progress once their start
  // time passes (silent), and nudge crew to submit forms ~2h into the shift.
  // Same 15-min cadence as the reminders.
  const runShiftAdvance = () => {
    try { advanceShiftStatuses(); } catch (e) { console.error('[cron] advanceShiftStatuses error:', e.message); }
    sendInShiftFormsReminders().catch(e => console.error('[cron] in-shift forms reminder error:', e.message));
  };
  runShiftAdvance();
  setInterval(runShiftAdvance, 15 * 60 * 1000);

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

  // Cert expiry reminders — daily at 7:30 AM. Fires for licence / white
  // card / medical / TC / TI / first-aid items expiring in 30 / 14 / 7
  // days, deduped via cert_expiry_reminder_log. Each worker can mute
  // the 'cert_expiry' category in /w/profile/notifications.
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 7 && now.getMinutes() >= 30 && now.getMinutes() < 45) {
      sendCertExpiryReminders().catch(e => console.error('[cron] cert-expiry error:', e.message));
    }
  }, 15 * 60 * 1000);

  // SWMS expiry reminders — daily at 7:45 AM, just after cert expiry. Fires
  // for active SWMS docs expiring in 30 / 14 / 7 days, deduped via
  // swms_expiry_reminder_log (mig 219). Goes to admin / safety / operations
  // users via the notifications table + push, not to individual workers —
  // SWMS renewal is an office responsibility, not a worker action.
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 7 && now.getMinutes() >= 45 && now.getMinutes() < 60) {
      sendSwmsExpiryReminders().catch(e => console.error('[cron] swms-expiry error:', e.message));
    }
  }, 15 * 60 * 1000);

  // Induction reminders — daily at 8:00 AM. Fires for upcoming recruitment
  // inductions at 7 / 3 / 1 / 0 days out, deduped via induction_reminder_log
  // (mig 222). Goes to admin / operations / hr roles via notifications + push.
  // Skips applicants already in a terminal status (Inducted / Hired / No Show /
  // Withdrew / Not Suitable).
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 8 && now.getMinutes() >= 0 && now.getMinutes() < 15) {
      sendInductionReminders().catch(e => console.error('[cron] induction-reminder error:', e.message));
    }
  }, 15 * 60 * 1000);

  // Applicant-facing induction reminder EMAILS — 36h and 12h before the
  // booked time, to the person doing the induction (seek_applicants.email).
  // Every 15 min because the windows are hour-scale; dedup lives in
  // induction_email_reminder_log (mig 326) so ticks are idempotent. The db
  // handle is injected here (server.js is the allowlisted bootstrap) so the
  // service itself stays off the raw-getDb backlog.
  setInterval(() => {
    try {
      const { getDb } = require('./db/database');
      sendInductionEmailReminders(getDb()).catch(e => console.error('[cron] induction-email-reminder error:', e.message));
    } catch (e) { console.error('[cron] induction-email-reminder error:', e.message); }
  }, 15 * 60 * 1000);

  // Traffio booking sync — polls every 5 min when the integration is enabled
  // AND auto_sync is turned on in /admin/integrations (a manual "Sync now" is
  // always available there regardless). Confident job matches become bookings;
  // ambiguous ones queue at /traffio-imports for reconciliation. Non-fatal.
  setInterval(() => {
    try {
      const { getIntegrationConfig } = require('./middleware/integrations');
      const ic = getIntegrationConfig('traffio');
      if (!ic.enabled || !ic.config.auto_sync) return;
      const { syncTraffioBookings } = require('./middleware/traffio');
      const today = new Date().toISOString().split('T')[0];
      const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      Promise.resolve(syncTraffioBookings('scheduled', from, today))
        .then(s => { if (s && (s.created || s.queued)) console.log(`[traffio] sync: ${s.created} created, ${s.queued} queued, ${s.updated} updated`); })
        .catch(e => console.error('[cron] traffio sync error:', e.message));
    } catch (e) { console.error('[cron] traffio sync error:', e.message); }
  }, 5 * 60 * 1000);
});
