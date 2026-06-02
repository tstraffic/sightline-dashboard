# Atomis — Platform Context

## Overview
Atomis is a multi-tenant operations platform. **T&S Traffic Control** (Sydney traffic management company) is the launch customer. The platform currently runs single-tenant against T&S's data; multi-tenancy migration is planned per `atomis-migration` v0.2. Two interfaces in a single codebase:

1. **Admin Dashboard** — Desktop + mobile responsive web app for office staff (management, operations, admin roles)
2. **Worker Portal** ("Atomis Crew") — Mobile-first PWA for field crew members (under `/w/` prefix)

**Domain**: `atomis.com.au` (purchased; wildcard DNS + per-tenant subdomains land in Phase 3 of the migration).

## Tech Stack
- **Backend**: Node.js, Express, EJS templates, express-ejs-layouts
- **Database**: SQLite via better-sqlite3
- **Frontend**: Tailwind CSS (CDN), vanilla JS
- **Auth**: Admin = username/password (bcrypt). Worker = Employee ID + numeric PIN (bcrypt)
- **Hosting**: Railway (auto-deploys from `main` branch)
- **Email**: Resend HTTP API (env var `RESEND_API_KEY` or `SMTP_PASS` starting with `re_`)
- **Push Notifications**: Web Push (VAPID) via `web-push` npm package
- **Node path on this machine**: `PATH="/c/Program Files/nodejs:$PATH"` (required for all node/npm commands)
- **GitHub repo**: `tstraffic/ts-dashboard` (origin)
- **Live URL**: `https://tstc.up.railway.app`

## Brand Colors
- Primary: `#2B7FFF` (brand-600: `#1D6AE5`)
- Full scale: brand-50 through brand-950 defined in Tailwind config
- Light enterprise theme (white/gray backgrounds, colored accents)

## Architecture
- **Admin routes**: `/dashboard`, `/jobs`, `/crew`, `/allocations`, `/profile`, etc. Protected by `req.session.user`
- **Worker routes**: `/w/home`, `/w/jobs`, `/w/jobs/:id`, etc. Protected by `req.session.worker`
- **Session isolation**: `req.session.worker` is separate from `req.session.user`. Both can coexist
- **Layout override**: Admin uses `views/layout.ejs` (default). Worker uses `views/worker/layout.ejs` via `res.locals.layout`
- **`blockWorkerFromAdmin`** middleware prevents worker-only sessions from accessing admin routes
- **Permissions**: `middleware/auth.js` has `PERMISSIONS` object mapping modules to allowed roles

## Database
- SQLite via better-sqlite3, file at `./data/tstraffic.db` (env `DB_PATH`)
- 245+ migrations in `db/schema.js`, run on startup by `initializeDatabase()`. Each is gated by `isMigrationApplied(version)` and recorded via `recordMigration.run(version, name)` in `schema_migrations`. **New migrations must use the next unused version number** (check the max before adding) — duplicate versions silently skip.
- Key tables: `users`, `jobs`, `crew_members`, `crew_allocations`, `tasks`, `incidents`, `notifications`, `push_subscriptions`, `system_config`, `invitations`, `compliance`, `traffic_plans`, `plan_revisions`, `plan_flags`, `plan_fees`, `plan_extensions`, `ctmps`, `ctmp_revisions`, `rol_shifts`, `rol_conditions`, `activity_log`, `app_settings`
- Migration 14 = Worker Portal auth columns on `crew_members`
- Migration 29 = `push_subscriptions` table for Web Push
- Migrations 241–245 = Plans Module (council/ROL workflow, fees, extensions, CTMP entity, ROL two-stage + PDF extraction)

## Key Middleware
- `middleware/auth.js` — Admin auth (`requireLogin`, `requireRole`, `requirePermission`, `canAccess`)
- `middleware/workerAuth.js` — Worker auth (`requireWorker`, `requireOwnData`, `blockWorkerFromAdmin`, `workerLocals`)
- `middleware/compliance.js` — Ticket/licence/fatigue compliance checks
- `middleware/notifications.js` — Notification generation engine + push integration
- `middleware/audit.js` — Activity logging (`logActivity`)
- `middleware/settings.js` — System settings

## Key Services
- `services/email.js` — Email sending (Resend HTTP API or SMTP fallback)
- `services/emailTemplates.js` — Branded HTML email templates
- `services/pushNotification.js` — Web Push (VAPID key management, subscription CRUD, sending)
- `services/invitations.js` — Token-based invitations/password resets
- `services/rolParser.js` — ROL/ROLA PDF text extraction (pdfjs-dist): licence/application number, date+time range, shifts (gaps preserved), conditions w/ alert flagging

## Test Data
- Admin: username `admin` / password `admin123` (**CHANGE THIS ON PRODUCTION**)
- Worker: Employee ID `EMP-001` / PIN `1234` (John Smith, crew_member id=1)

---

## Completed Work

### Plans Module — council/ROL workflow (completed, PR #462)
Enhanced the existing **Traffic Plans** module (`routes/plans.js`, `traffic_plans`) for T&S's real council/ROL workflow:
- **Plan types unlocked**: dropped the `plan_type` CHECK (table rebuild) so `Council Application`, `ROL`, `CTMP`, `Permit` are valid alongside TGS/TCP/TMP; added `council_plan_type` (free-text) + `job_date`.
- **Editable detail hub**: new `GET /plans/:id` (`views/plans/show.ejs`) with a per-plan activity log (`activity_log`, `entityType:'plan'`). Conditional date validation — Council/ROL require Client Requested + Submission + Job Date; others Job-Date-optional.
- **Fees** (`plan_fees`, multiple w/ receipts) and **extensions** (`plan_extensions`, ROL/Council).
- **CTMP as its own linked entity**: `routes/ctmps.js` (mounted `/ctmps`) + `views/ctmps/`, `ctmps` + `ctmp_revisions` tables. Draft→Rev A→B versioning, per-version QA status, dashboard chip.
- **Council automation**: auto-creates a finalisation task on creation; 7- and 2-day reminders for Council/ROL added to `generateNotifications()`. Dashboard "Plans & Safety" widget (upcoming, CTMP QA, ROL alerts).
- **ROL two-stage + PDF auto-extraction**: `services/rolParser.js` parses ROLA/issued-ROL PDFs (parse-then-confirm via `views/plans/rol-review.ejs`); stores actual shifts (`rol_shifts`, gaps preserved) and conditions (`rol_conditions`, alerts surfaced on detail page + dashboard).
- Also fixed two pre-existing `middleware/notifications.js` bugs (`now`, `mgmtUsers` undefined) that had disabled the whole notification engine.

### UI Rebrand (completed)
- Migrated all 52+ EJS views from dark to light enterprise theme
- T&S brand colors throughout
- Added compliance middleware, crew management views, settings system, enhanced allocation/incident routes

### Worker Portal Sprint 1 (completed)
- **Auth**: Employee ID + PIN login, logout, session management
- **Home screen**: Time-based greeting, today's shift card, compliance alerts, quick actions
- **My Jobs**: List view (today + 7 days grouped by date), job detail (supervisor, crew, site info)
- **PWA foundation**: manifest.json, service worker (network-first caching), worker.css, worker.js
- **Admin PIN management**: Set/reset/clear PIN from crew profile page, login tracking
- **PR**: Merged via `claude/eloquent-booth` branch

### Admin PWA + Mobile Responsive (completed)
- **PWA**: `manifest-admin.json`, `admin-sw.js` service worker, offline page, meta tags
- **Mobile sidebar**: Full-height overlay with scrollable nav, user avatar header, close button, swipe-to-close gesture, sign out pinned at bottom, backdrop blur animation
- **Mobile header**: Sticky, compact 56px on mobile, profile avatar circle (initials), notification bell
- **Responsive views**: Dashboard, jobs, crew, tasks views all responsive with hidden columns, stacked filters, touch-friendly buttons
- **CSS**: `custom.css` with mobile touch targets (44px min), iOS zoom prevention, safe-area insets, tap feedback
- **Service worker cache**: Versioned (`ts-admin-v3`), network-first for HTML, cache-first for assets

### Push Notifications (completed)
- **VAPID keys**: Auto-generated on startup, stored in `system_config` DB table
- **Client flow**: Service worker registers → checks subscription → shows enable prompt after 3s → subscribes via Push API → saves to server
- **Server**: `services/pushNotification.js` handles init, subscribe, send. Routes at `/notifications/push/*`
- **Triggers**: Task creation/assignment/status change (`routes/tasks.js`), notification engine (`middleware/notifications.js`)
- **Test button**: Profile page has "Send Test Notification" button + status indicator (Enabled/Not Enabled/Blocked/Not Supported)
- **Push subscriptions DB**: `push_subscriptions` table (user_id, endpoint, p256dh, auth)

### User Profile Page (completed)
- **Route**: `/profile` (requireLogin only, all roles)
- **Features**: Edit full name, email, notification preferences (toggle + frequency)
- **Security**: Change password (current + new), send password reset link to own email
- **Push section**: Shows push notification status, test notification button
- **Header link**: Username in header is clickable → profile page. Avatar circle with initials on desktop.

### Email System (completed)
- **Resend HTTP API**: Replaces SMTP (Railway blocks ports 465/587)
- **Env vars**: `RESEND_API_KEY` (or `SMTP_PASS` starting with `re_`), `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`, `APP_BASE_URL`
- **Templates**: Branded HTML emails for password reset, notifications
- **Fallback**: If key doesn't start with `re_`, falls back to nodemailer SMTP

---

## File Structure (Admin — Key Files)

```
server.js                        — Express app setup, route registration
db/schema.js                     — All migrations
db/database.js                   — SQLite connection

middleware/auth.js               — Admin auth + permissions
middleware/notifications.js      — Notification generation engine
middleware/compliance.js         — Compliance checks
middleware/settings.js           — System settings

routes/auth.js                   — Login/logout/forgot-password/reset
routes/profile.js                — User profile (GET/POST + change password + reset email)
routes/dashboard.js              — Main dashboard
routes/notifications.js          — Notifications + push subscription endpoints
routes/tasks.js                  — Tasks (with push notification triggers)
routes/[module].js               — Other CRUD routes

services/email.js                — Email sending (Resend/SMTP)
services/pushNotification.js     — Web Push service
services/invitations.js          — Token management

views/layout.ejs                 — Admin layout (header + sidebar + main)
views/partials/header.ejs        — Sticky header (hamburger, logo, bell, avatar, logout)
views/partials/sidebar.ejs       — Sidebar nav (mobile overlay + desktop static)
views/partials/footer.ejs        — Footer
views/profile.ejs                — User profile page
views/dashboard.ejs              — Dashboard
views/[module]/*.ejs             — Module views

public/css/custom.css            — Custom styles (mobile sidebar, touch targets, animations)
public/js/app.js                 — Client JS (sidebar toggle, tabs, push subscription)
public/js/admin-sw.js            — Admin service worker (caching + push handler)
public/manifest-admin.json       — Admin PWA manifest
public/offline.html              — Offline fallback page
```

## File Structure (Worker Portal)
```
middleware/workerAuth.js
routes/worker/auth.js            — Login/logout
routes/worker/home.js            — Home screen
routes/worker/jobs.js            — Jobs list + detail
views/worker/layout.ejs          — Mobile shell + bottom tab nav
views/worker/login.ejs           — Standalone login page
views/worker/home.ejs            — Home screen
views/worker/jobs.ejs            — Jobs list
views/worker/job-detail.ejs      — Job detail
views/worker/error.ejs           — Error page
public/manifest.json             — Worker PWA manifest
public/css/worker.css
public/js/worker.js
public/js/worker-sw.js           — Worker service worker
```

## Bottom Tab Nav (Worker Portal)
4 tabs: Home (house), Jobs (briefcase), Clock (clock), Profile (user)
- Home + Jobs = Sprint 1 (done)
- Clock = Sprint 2 (next)
- Profile = Sprint 5 (future)

---

## Upcoming Sprints

### Sprint 2: Clock In/Out + Availability
- **Clock In/Out system**: GPS-stamped clock in/out from worker portal, linked to crew_allocations
- **Availability submission**: Workers can submit availability/unavailability for upcoming dates
- **Database**: New tables or columns for clock events and availability records
- **Views**: Clock in/out UI on worker home + dedicated clock page, availability calendar/form
- **Admin side**: View clock events on allocation detail, availability visible on scheduling views

### Sprint 3: Prestart/Fatigue Declaration + Incident Reporting
- **Prestart checklist**: Workers complete a prestart safety checklist before starting work
- **Fatigue declaration**: Workers declare fatigue status (integrates with existing fatigue compliance)
- **Incident reporting**: Workers can submit incident reports from the field (photos, description, severity)
- **Database**: New tables for prestarts, fatigue declarations; leverage existing incidents table
- **Views**: Prestart form, fatigue declaration form, incident report form (all mobile-optimized)

### Sprint 4: Timesheet Auto-Generation + Supervisor Approvals
- **Timesheet auto-generation**: Generate timesheets from clock in/out data
- **Supervisor approvals**: Supervisors can review and approve timesheets, prestarts
- **Push to admin**: Approved timesheets flow into the existing admin timesheet system
- **Views**: Timesheet review screens, approval workflows

### Sprint 5: Mobile Polish + PWA Install + Notifications
- **PWA install prompts**: Proper install flow with app icons and splash screens
- **Push notifications**: Shift reminders, approval notifications
- **Offline support**: Enhanced service worker for offline prestart/clock forms
- **UI polish**: Animations, transitions, loading states, error recovery
- **Performance**: Optimize queries, add indexes if needed

---

## Environment Variables (Railway)
```
DATABASE_PATH=./data/database.sqlite
SESSION_SECRET=<random-string>
APP_BASE_URL=https://tstc.up.railway.app
RESEND_API_KEY=re_xxxxxxxxxxxx       # or SMTP_PASS=re_xxxxxxxxxxxx
SMTP_FROM_EMAIL=onboarding@resend.dev # change after domain verification
SMTP_FROM_NAME=T&S Traffic Control
# VAPID keys auto-generated and stored in system_config DB
# Optional: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL
```

## Known Issues / TODO
- **Default admin password**: Still `admin/admin123` on production — needs changing
- **Resend domain**: Using `onboarding@resend.dev` — need to verify `tstc.com.au` domain in Resend for custom from address
- **iOS push**: Limited support (iOS 16.4+ Safari only, must add to home screen)
