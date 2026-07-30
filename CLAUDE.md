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

## Brand & Design System (Atomis)
- **Brand = emerald**: brand-500 `#10B981`, brand-600 `#059669` (full 50–950 ramp in the inline Tailwind config, views/layout.ejs). Signal tones: amber `#FBBF24` warn, red `#EF4444` danger, blue `#60A5FA` info. (The old blue `#2B7FFF` era is gone — don't reintroduce it.)
- **Type**: Bricolage Grotesque (display, `font-display`), Geist (body, `font-sans`), Geist Mono (technical voice — eyebrows, labels, timestamps; `font-mono`). Loaded via Google Fonts in layout.ejs.
- **Theming is dark-first**: `body.dark-glass` is always on; light mode is the `:root[data-theme="light"]` override layer. 13 user-selectable themes (`window.ATOMIS_THEMES` in layout.ejs; skins re-tint surfaces via themes.css). `bg-white` cards auto-remap to frosted dark surfaces — new markup using `bg-white border border-gray-200 rounded-xl/2xl` gets both themes for free.
- **Key CSS layers**: custom.css (tokens + dark-glass remaps) → themes.css (skins) → admin-fluid.css (view-transition motion) → admin-polish.css (§9 `.stat-card`, §11 page title/eyebrow, §12 `.chevron-rail`/`.chevron-rail-left` hazard striping, §13 `.lane-divider`, §17 dashboard devices: `.panel-header`, `.attn-row`, `.hero-board`). Reuse these before inventing new ones.

## Architecture
- **Admin routes**: `/dashboard`, `/jobs`, `/crew`, `/allocations`, `/profile`, etc. Protected by `req.session.user`
- **Worker routes**: `/w/home`, `/w/jobs`, `/w/jobs/:id`, etc. Protected by `req.session.worker`
- **Session isolation**: `req.session.worker` is separate from `req.session.user`. Both can coexist
- **Layout override**: Admin uses `views/layout.ejs` (default). Worker uses `views/worker/layout.ejs` via `res.locals.layout`
- **`blockWorkerFromAdmin`** middleware prevents worker-only sessions from accessing admin routes
- **Permissions**: `middleware/auth.js` has `PERMISSIONS` object mapping modules to allowed roles
- **Sidebar nav**: registry-driven from `lib/sidebarNav.js` (9 sections; section headers ARE the dept-hub links and keep the `sidebar-link` class so the drag-drop customiser's pathname-keyed layouts survive). Never register two hrefs differing only by query string — the customiser dedupes by pathname. Messages lives in the header (`#header-chat`, badge class `chat-unread-badge` live-updates via public/js/chat.js).
- **Department hubs**: `/departments/:key` (planning, safety, operations, finance, people, assets, reports) — registry in `lib/departments.js`. **Hub access = sidebar section visibility**, delegated to `sidebarNav.sectionVisibleByKey()` (single source of truth; the old hand-synced `accessKeys` are gone). Meetings + notebook to-dos live in `dept_meetings`/`dept_meeting_todos` (migration 328; `dept_key` validated in app, not a CHECK). `recap_source`/`todos.source` columns are pre-provisioned so AI generation (last-meeting summary, todo extraction) can be added without schema changes — AI writes POST the existing `/sections` endpoint with `source='ai'`.

## Database
- SQLite via better-sqlite3, file at `./data/tstraffic.db` (env `DB_PATH`)
- 247+ migrations in `db/schema.js`, run on startup by `initializeDatabase()`. Each is gated by `isMigrationApplied(version)`; **new migrations must use the next unused version** (check the max first — duplicate versions silently skip).
- Key tables: `users`, `jobs`, `crew_members`, `crew_allocations`, `tasks`, `incidents`, `notifications`, `push_subscriptions`, `system_config`, `invitations`, `compliance` (+ `compliance_documents`, `compliance_revisions`, `compliance_fees`, `compliance_extensions`, `compliance_rol_shifts`, `compliance_rol_conditions`), `activity_log`, `app_settings`
- Migration 14 = Worker Portal auth columns on `crew_members`
- Migration 29 = `push_subscriptions` table for Web Push
- Migration 247 = Compliance council/ROL workflow (council_plan_type, job_date, itemised fees, extensions, ROL two-stage + PDF extraction, CTMP QA)

## Two "plans" areas — don't confuse them
- **Compliance / "Plans & Approvals"** (`/compliance`, `compliance` table, sidebar "Plans & Approvals") — **the module the team actually uses.** Parent plans → sub-plans with refs `TSCA` (council_permit), `TSROL` (rol), `TSTMP` (CTMP/tmp_approval), `TSTGS`, `TSSPA`, etc. Owner, status workflow, fees, dates, revisions live here. Council/ROL/CTMP features belong here. TGS↔ROL links are **many-to-many** via `compliance_tgs_rol_links` (mig 332) — `compliance.linked_rol_id` is retired (unread, unwritten; left in place because SQLite column drops rewrite the table). Sub-plan documents: attach-only via `POST /sub-plans/:id/documents` (no status change); `upload-submit` remains the explicit submission. The ROL parse routes accept `existing_doc_id` to read an already-attached PDF.
- **Traffic Plans** (`/plans`, `traffic_plans` table) — a separate, lightly-used design-document register. (A council/ROL build landed here by mistake via PR #462; the real work is in Compliance.)

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

## Test Data
- Admin: username `admin` / password `admin123` (**CHANGE THIS ON PRODUCTION**)
- Worker: Employee ID `EMP-001` / PIN `1234` (John Smith, crew_member id=1)

---

## Completed Work

### Compliance — council/ROL/CTMP workflow (completed)
Extended the **Compliance** sub-plan module (`routes/compliance.js`, `views/compliance/_sub_plan_card.ejs`) for the council/ROL workflow:
- **Type of Council Plan** (free-text) + **Job Date** on sub-plans (saved via upload-submit / `/sub-plans/:id/details`).
- **Itemised fees** with description + amount + receipt (`compliance_fees`, `POST /sub-plans/:id/fees`) — alongside the legacy single council fee.
- **Extension records** (`compliance_extensions`, `POST /sub-plans/:id/extensions`) for ROL/Council.
- **CTMP QA status** on `tmp_approval` sub-plans (`POST /sub-plans/:id/qa`).
- **ROL two-stage + PDF auto-extraction**: `services/rolParser.js` (pdfjs-dist) reads ROLA/issued-ROL PDFs → number, date+time range, shifts (gaps preserved → `compliance_rol_shifts`), conditions (`compliance_rol_conditions`, contact/late-start/no-works/long-weekend flagged as alerts). Parse-then-confirm via `views/compliance/rol-review.ejs`; alerts surface on the sub-plan card.
- **Council/ROL reminders** (Job Date 7 + 2 days) in `generateNotifications()`.

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
# Native iOS push (APNs) — channel no-ops until set. See docs/APP_STORE.md
# APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_BASE64, APNS_BUNDLE_ID=au.com.atomis.crew, APNS_ENV=production
```

## Native iOS app (Capacitor)
- `mobile/` — Capacitor shell ("Atomis Crew", bundle id `au.com.atomis.crew`, SPM not CocoaPods). WKWebView loads the live portal via `server.url`; most updates ship by deploying `main`, no app release needed.
- Server push is dual-channel: web-push (browsers/PWA) + APNs (`services/apns.js`, `worker_device_tokens` table, migration 303). `sendPushToCrew` fans out to both.
- `public/js/worker-native.js` runs only inside the shell: APNs token registration, notification-tap deep links, Face ID lock.
- Full build/submission runbook: `docs/APP_STORE.md`.

## Known Issues / TODO
- **Default admin password**: Still `admin/admin123` on production — needs changing
- **Resend domain**: Using `onboarding@resend.dev` — need to verify `tstc.com.au` domain in Resend for custom from address
- **iOS push**: Web-push limited (iOS 16.4+ Safari, must add to home screen). Native app (mobile/) uses APNs instead — needs APNS_* env vars on Railway once the Apple Developer account exists.
