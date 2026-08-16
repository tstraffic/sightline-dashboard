# Sightline Dashboard — Platform Context

## Overview
This repo is **Sightline Traffic Engineers'** operating platform — a fork of the Atomis platform (`tstraffic/ts-dashboard`, which serves T&S Traffic Control). Sightline is an independent traffic engineering **consultancy** (development approvals and construction traffic — TIAs, swept paths, SIDRA modelling, CTMPs, ROL/approvals support), not a traffic control company.

The build implements **Phase 1 of the "Atomis Operating Platform, CRM & Systems Brief" v1.0** (source doc: OneDrive `7. General Team Folder/3. Suhail/`): CRM (organisations → contacts → opportunities → activities → referrals → proposals) → controlled won-to-project conversion → Master Project Register + Service Packages → manual Xero/SharePoint link fields → CRM dashboards + follow-up automations. Phases 2–3 (deliverables register, QA prepare/check/approve chains, document issue register, approvals register, variations, time/WIP, Client-360 key-account reviews, real Xero/SharePoint APIs) are **not built yet** — the schema leaves seams for them.

- **GitHub repo**: `tstraffic/sightline-dashboard` (origin). Push to `main` deploys (Railway, once the service is connected).
- **T&S modules are HIDDEN, NOT DELETED** — bookings, crew, worker portal, safety, fleet, payroll, quoting/rate-cards, compliance etc. keep their routes/tables/permissions but are delisted from `lib/sidebarNav.js`. To restore one, re-add its link there (full T&S registry is in this file's git history).

## Brand (Sightline Brand Guidelines v3.2 — consolidated docx in the same OneDrive folder)
- **Palette**: Aubergine `#3E2632` (primary ground: sidebar, dark surfaces, PWA theme), Oxide `#A34652` (direction/emphasis ONLY — links, CTAs, active states; never a decorative wash; must not read as "error"), Carbon `#24272A` (text), Survey Grey `#657278` (secondary text), Mineral Dust `#E5E1DE` (supporting surfaces), Drawing Paper `#F8F6F2` (default background), Brass `#C9A15A` (1–3% accent, dark grounds; `#AB894C` on light, large/non-text only). Retired: `#B08D57`.
- **GREEN IS PROHIBITED at brand level** (v3.1 rule). The Tailwind `brand` ramp is an Oxide ramp (50 `#FAF3F4` … 500 `#A34652` … 950 `#2E1418`). Semantic status greens (job health dots, `.is-good`, success flashes) are data semantics and stay. Danger red `#EF4444` stays distinct from Oxide.
- **Type**: Hanken Grotesk 500 (headings), 400 (body); IBM Plex Mono (technical labels only — refs, revisions, eyebrows; caps + letterspacing OK; never body copy). Sentence case, no exclamation marks.
- **Themes**: predominantly LIGHT — default theme `paper` (Drawing Paper); dark option `aubergine`. Registry in `views/layout.ejs` (`window.ATOMIS_THEMES`); legacy stored ids map by mode. Old skins in themes.css are unused.
- **Marketing line** (the only one): "Designed for approval. Built for construction." (on the login page). Logo: `public/images/sightline-mark{,-reversed}.svg` (angled Aubergine/Oxide stripes — geometry locked, no third stripe, no brass in the mark); icons generated from the mark on an Aubergine tile.

## Tech stack (unchanged from the fork)
Node/Express/EJS + express-ejs-layouts · SQLite via better-sqlite3 · Tailwind CDN (inline config in layout.ejs) · sessions in `data/sessions.db` · Resend email · web-push. Node path on Windows dev machines: `PATH="/c/Program Files/nodejs:$PATH"`.

- **Local dev**: `node scripts/dev-local.js` (keeps the SQLite DB OUTSIDE OneDrive at `%LOCALAPPDATA%\sightline-dev\sightline.db` — better-sqlite3 + OneDrive sync corrupts DBs). Plain `npm run dev` works if you set `DB_PATH` yourself. Login `admin/admin123` → forced password change on first login.
- **Prod**: `start.sh` (litestream wrapper), `DB_PATH` on the Railway volume. Leave `SEED_T_AND_S_DATA` and `SEED_TEST_USERS` unset — the DB starts clean.

## Database
- Migrations in `db/schema.js`, gated by `isMigrationApplied(version)`. **Max version = 354** — always check the current max before adding (duplicates silently skip). House pattern: try/catch that logs, `recordMigration.run(n, 'name')`, PRAGMA-guarded column adds, table-rebuild dance for CHECK changes (see 329/354).
- **Sightline migrations**: 347 `ref_sequences` + org/contact refs · 348 CRM vocabulary (8 stages with default probability in `app_settings.metadata`, sectors, won/lost reasons, DEV/PAS/MOD/CON/APR streams, repeat-client statuses, referral channels) · 349 clients/contacts brief fields · 350 `referrals` · 351 opportunity brief fields · 352 `proposals` + `proposal_service_packages` · 353 jobs register fields + `job_budgets` invoiced/paid + `service_packages` · 354 notifications CHECK expanded for the CRM sweeps.
- **Identifiers** (`lib/refNumbers.js`, backed by `ref_sequences`, self-heal loops, Sydney-year scopes): `ORG-000123`, `CON-000456`, `OPP-YY####`, `ST-YY####` (projects — `jobs.job_number`), `PROP-{opp#}-{rev}`, `{ST-…}-{STREAM}-{NN}` (service packages). Legacy `generateJobNumber()` (J-XXXX) still exists for hidden T&S paths.
- **`notifications.type` has a live CHECK** — adding a notification type REQUIRES a table-rebuild migration (354 is the template) or inserts throw silently inside the engine's try/catch.

## Sightline domain model (Phase 1)
- **Organisations = `clients`** (also still the supplier/subbie directory via `company_type`). CRM lifecycle axis = `repeat_client_status` (prospect → new_client → active_first_time → repeat → key_account → dormant → inactive) — do NOT use `company_type` for lead/prospect states (an old bug did; it's fixed). Also: `key_account_tier`, `org_ref`, `referred_by_client_id`, `first_engagement_date` (stamped at first conversion), manual `xero_contact_id`/lifetime figures, `sharepoint_url`.
- **Opportunities**: stage list is data (`app_settings` `opportunity_stages`; default probability in row `metadata` JSON). **Keys `won` and `lost` are load-bearing** (status derivation in routes/opportunities.js) — never rename them. Stage GATES are code: `lib/crmStages.js` (`proposal_sent` needs a sent proposal + value + owner + follow-up; `won` needs value + accepted proposal + expected start + owner), enforced on BOTH the edit POST and the kanban `/stage` endpoint (422 + toast + snap-back). Probability overrides demand `probability_override_reason`; `weighted_value` is stored and recomputed on every write path.
- **Proposals** (`/proposals`): document-revision entity — draft-only editing, `/send` (requires follow-up date; creates the follow-up activity; advances the opportunity), `/revise` (rev+1, supersedes), `/accept` (captures acceptance/PO ref — the conversion needs it), `/decline`. Deliberately separate from the hidden T&S quoting module.
- **Referrals** (`/referrals`): spawned from the opportunity form's referring-organisation fields or created directly; `outcome` syncs with the opportunity; thank-you stewardship toggle; attributed values are derived via joins, never stored.
- **Won-to-project conversion** (`GET/POST /opportunities/:id/convert`): review page (validation checklist + package confirmation per brief §3.4) → one transaction: ST number, job row, `job_budgets` row, `service_packages` from confirmed rows, `related_job_id` write-back, client lifecycle transition, referral outcome, kickoff task + activity. **Non-negotiable: no CRM history is deleted or moved.** A Won opportunity left unconverted >1 day triggers the `won_unconverted` sweep.
- **Projects = `jobs`** (everything platform-shaped hangs off `jobs.id`). Owner mapping: Project Director = `project_manager_id` (relabelled in views — notification/health logic reads it); `commercial_lead_id`/`technical_lead_id`/`checker_id` are Sightline columns (do not squat on `accounts/planning/ops` owner cols — hidden T&S logic reads those). `service_streams` is a denormalised CSV column (register filters read it); `service_packages` is the operational truth. Register = `/projects` (Master Project Register, §5.1); detail = `views/jobs/show.ejs` (Packages tab + CRM Origin panel; served by BOTH `/projects/:id` and `/jobs/:id` — keep their data assembly mirrored). Job-form Sightline fields apply via `lib/sightlineJobFields.js`, gated on `sightline_fields=1` so hidden T&S update paths can't blank them. **Never bare `DELETE FROM jobs`** — only the guarded `POST /projects/:id/delete`.
- **Xero/SharePoint are manual in Phase 1**: money numerics on `job_budgets` (`invoiced_to_date`, `paid_to_date`; outstanding/remaining always DERIVED), workflow fields on `jobs` (`po_*`, `invoice_status`, `xero_reference`), URLs on clients/proposals/jobs. Real APIs are a later phase (QuickBooks code exists from T&S; `integrations.provider` CHECK needs a rebuild to admit `'xero'`).
- **Automations** (`middleware/notifications.js`, 15-min sweep; blocks S1–S4 near the end): CRM follow-ups due/overdue, stale opportunities (`system_config` `crm_stale_days`, default 14), proposal follow-up + 7-day management escalation, won-unconverted. Prefs category `crm` in `lib/notificationPrefs.js`. Dashboard row `crm_followups_due` in `NEEDS_ROWS` (`routes/helpers/dashboard-queries.js`).
- **CRM dashboard** (`/crm`): §3.7 KPI strip (proposal conversion, avg/median sales cycle, new clients, repeat + referral revenue, revenue by stream, dormant key clients, next actions due) ahead of the legacy BDM panels.

## Navigation & permissions
- Sidebar (`lib/sidebarNav.js`): 4 sections — **CRM** (key `sales`: Clients, Contacts, Pipeline, Opportunities, Proposals, Referrals, CRM Dashboard, Activities, CRM Meetings), **Delivery** (key `operations`: Projects, Service Packages), **Money** (key `finance`: Budgets & Costs), **Admin**. TOP_LINKS: Today/Tasks/Notes/Meetings. Legacy keys retained so pathname-keyed customiser layouts and `lib/departments.js` gating hold; hub links are delisted (operations/finance hubs remain URL-reachable; the other hubs 403 via `sectionVisibleByKey`). Never register two hrefs differing only by query string.
- `crm` permission = `['admin','management','operations','planning','finance']`. New CRM-side mounts reuse `crm`; delivery-side reuse `projects`.

## Conventions that bite
- Flash idiom: `req.flash(...)` then `req.session.save(() => res.redirect(...))` — or flashes vanish.
- Every form needs `<%- include('../partials/csrf') %>` (the budget forms were missing it for months — every save silently bounced).
- `logActivity` `action` is CHECK-constrained (`create|update|delete|…|approve|reject`) — never invent actions; `entity_type` is free text. Per-record trails: `SELECT FROM activity_log WHERE entity_type=? AND entity_id=?`.
- Views: `<% locals.currentPage = 'x' %>` first line; `views/partials/page-header.ejs`; `.stat-card` grids; badge recipe `bg-x-50 text-x-700 ring-1 ring-x-600/20`; layout `title` param mandatory.
- Dates: `lib/sydney.js` for anything user-facing or year-scoped (server clock is UTC).

## Tests
- `npm run test:e2e` (Playwright, port 3101, serial, `SEED_TEST_USERS=true`, always `loginAs` from `helpers/setup` — the seeded admin has a forced-password-change gate). Sightline specs: `smoke.spec.js` (page list reflects the trim; delisted hubs must 403-not-500), `nav.spec.js` (4 sections, no hub heads, T&S links absent), `crm-lifecycle.spec.js` (org → opp → gate 422 → proposal send/accept → won → conversion → register, per brief §12.2).
- Some inherited T&S specs exercise hidden modules; they should still pass since routes/permissions are intact — if one asserts sidebar/hub presence, fix the spec, not the trim.
- `npm run test:cross-tenant`, `npm run lint:tenant:ratchet` still apply.

## Deployment (Railway — service to be created)
New Railway service on this repo: volume mounted, `DB_PATH` pointing at it, `SESSION_SECRET`, `APP_BASE_URL`, `RESEND_API_KEY`/SMTP vars (`SMTP_FROM_NAME=Sightline Traffic Engineers`). Leave both seed gates unset. Change the admin password immediately (the gate forces it).

## Known gaps / next phases
- Phase 2 (brief §12.1): deliverables register + QA prepare/check/approve + document issue register + approvals register + variations + time/WIP + invoice-readiness workflow. Best in-repo precedents: the compliance module's status/QA/ready-for-invoice machinery and `lib/planStatus.js`.
- Phase 3: Client-360 key-account reviews, capacity/utilisation, profitability, dormant-client prompts beyond the KPI, Outlook logging.
- Real Xero (OAuth + contact/invoice sync) and SharePoint (Graph folder provisioning at conversion) integrations.
- `views/clients/accounts.ejs` (`/clients?view=crm`) and parts of `routes/crm.js` still carry pre-Sightline assumptions worth a future tidy.
