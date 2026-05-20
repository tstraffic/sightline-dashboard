# Atomis / T&S Platform — Raw Audit Findings

Companion dump to [AUDIT_REPORT.md](AUDIT_REPORT.md). Organised by the brief's grep-sweep categories. `[CRITICAL]` prefix = white-label-sale showstoppers.

---

## §A — Hidden incompleteness

### A1. TODO / FIXME / HACK / XXX / WIP markers

Direct intentional unfinished markers are sparse — most "XXX" matches are placeholder formatting for codes like `EMP-XXX` ([routes/induction-admin.js:195](routes/induction-admin.js:195), [routes/induction-admin.js:406](routes/induction-admin.js:406)). The codebase prefers explicit "Phase N" comments to TODOs, which is generally cleaner but means the actual backlog hides inside multi-tenant migration prose.

### A2. "Not implemented" / explicit unfinished markers

| File:line | Severity | Note |
|---|---|---|
| [routes/integrations.js:108](routes/integrations.js:108) | **[CRITICAL]** | `req.flash('error', 'QuickBooks Online integration is not yet active — coming soon')` — user can fill in QBO config + hit Test → flashes "coming soon" |
| [routes/integrations.js:111](routes/integrations.js:111) | **[CRITICAL]** | Same for Employment Hero |
| [routes/voc-assessments.js:488-493](routes/voc-assessments.js:488) | MODERATE | VOC certificate Phase-2 stub — comment says "Screen-only render…Phase 2 will: persist a real certificate_id". Tooling exists at [lib/pdf/vocCertificatePdf.js](lib/pdf/vocCertificatePdf.js) — just not wired through |
| [lib/admin-db.js:61](lib/admin-db.js:61) | INFO (by design) | `requireAdmin()` always returns 403 — `atomis admin portal not yet built (Phase 4)`. Intentional stub for future phase |
| [middleware/tenant.js:30-40](middleware/tenant.js:30) | INFO (by design) | Tenant hardcoded to `'ts'` until Phase 3 |

### A3. Routes returning empty / placeholder data

Spot-checked the candidates the brief flagged ([routes/reports.js](routes/reports.js), [routes/exports.js](routes/exports.js), [routes/marketing.js](routes/marketing.js), [routes/finance-pnl.js](routes/finance-pnl.js), [routes/integrations.js](routes/integrations.js), [routes/admin.js](routes/admin.js)). All return real DB-backed data. The only "empty return" pattern found: [routes/saved-views.js](routes/saved-views.js) returns `[]` if `?module` query param is missing — defensive, not a stub.

### A4. Mock / fake / dummy / seed data in non-test paths

**[CRITICAL] Migration 114 — EMP-TEST / PIN 1234 dummy worker in production DB**
[db/schema.js:5101-5130](db/schema.js:5101)
```
INSERT INTO crew_members (..., 'Test Dummy', 'EMP-TEST', 'traffic_controller', '0400000000', 'test@tstc.com.au', 1, pinHash)
INSERT INTO employees    (employee_code='EMP-TEST', first_name='Test', last_name='Dummy', ...)
```
PIN bcrypt-hashed from `'1234'`. Account is active. **Visible in any roster search on a fresh DB.**

**[CRITICAL] Seed migrations that target live business tables on prod startup:**
- Mig 39: "Seed realistic demo budget data for active jobs"
- Mig 40: "Seed comprehensive demo data — allocations, equipment, activity, CRM, updates"
- Mig 63: "Wipe all data for clean production launch (keep only users)" — fired once on the real production cut-over
- Mig 83: "Import/update clients from Dashboard CSV export"
- Mig 90: "Seed Villawood depot crew members from Traffio export (54 active/reserve TCs)" — see §A8
- Mig 91: "Seed Villawood depot into employees table for HR roster"
- Mig 149: "vehicle columns on equipment + seed T&S fleet" — real T&S vehicle plates
- Mig 160: "Seed Building & Construction General On-site Award" — award rate seed (legitimate)
- Mig 64: "Import 2026 TGS Register into Plans & Approvals" — real T&S TGS register

Run a fresh DB and these all execute. The award seeds (mig 160) are fine for any AU customer. The Villawood / T&S / Abergeldie ones are not.

### A5. console.log in production paths

49 instances across routes/, services/, middleware/, public/js/, plus 20+ informational logs in `db/schema.js` (intentional migration markers).

**Highest-noise PII offenders:**
- [routes/jobs.js:122](routes/jobs.js:122) — logs jobNumber + client_id + suburb on every POST
- [routes/induction.js:174](routes/induction.js:174), [routes/induction.js:295](routes/induction.js:295), [routes/induction.js:298](routes/induction.js:298) — logs computed full names + payment type on every induction submit
- [services/email.js:144](services/email.js:144), [services/email.js:166](services/email.js:166) — logs recipient address + Resend message ID

Strip these or route through a logger that respects a log-level env var. PII in stdout = PII in Railway logs.

### A6. Empty `catch` blocks

30+ instances; most are defensive migration-init / index-creation patterns. The ones that matter:

| File:line | Risk |
|---|---|
| [middleware/workerAuth.js:93](middleware/workerAuth.js:93) | **`catch (_) {}` while looking up `portal_role` from DB.** On DB hiccup the worker is silently demoted to `traffic_controller` and `requirePortalRole` checks reject. Surfaces as a confusing "Team Leader access only" flash mid-session. |
| [middleware/workerAuth.js:122](middleware/workerAuth.js:122) | Same pattern in `workerLocals` — falls back to `traffic_controller` for template locals. |
| [db/schema.js](db/schema.js) various ROLLBACK catches | Acceptable — errors are logged before swallowing. |

### A7. Commented-out code blocks > 5 lines

Grep didn't surface any abandoned blocks in route/middleware/service files. Most comments are intentional rationale (Phase markers, design notes). `db/schema.js` has long block comments by design.

### A8. **[CRITICAL] Hardcoded customer / personal data in seeds**

These names appear directly in `db/schema.js` and execute on every fresh DB:

| Identity | Locations | Why this matters |
|---|---|---|
| **Saadat Ahmed**, mobile `0469295448`, `saadat@tstc.com.au`, ID `EMP-128575` | [db/schema.js:4352, 4419](db/schema.js:4352) | Real owner's contact in the seed roster |
| **Taj Rahman**, mobile `0416221801`, `TAJ@tstc.com.au`, ID `EMP-39938` | [db/schema.js:4362, 4429](db/schema.js:4362) | Real co-owner's contact in the seed roster |
| 52 other Villawood-depot TCs with real names + phones + emails + Traffio IDs | mig 90/91, ~[db/schema.js:4308-4443](db/schema.js:4308) | Privacy-act-regulated personal info shipped in every deployment |
| **Abergeldie Complex Infrastructure**, contact Harry Iqbal, `0499 516 282` | [db/schema.js:2585, 4028](db/schema.js:2585) | Real T&S customer's client record |
| **T&S Traffic Control** as a vendor/client | [db/schema.js:1004, 4105](db/schema.js:1004) | Self-reference; remove for white-label |
| `pmMap['taj']` job assignments — 20+ live jobs assigned to Taj/Greg | [db/schema.js:3451-3482](db/schema.js:3451) | Operational job data tied to T&S staff |
| `'Villawood'` depot name | [db/schema.js:4308, 4376](db/schema.js:4308) and views | T&S-specific site |
| Hardcoded `'Abergeldie'` in code (not seed) | [routes/abergeldie-payments.js:74](routes/abergeldie-payments.js:74) | Whole module hardcoded to one client — see Component 10 |
| Hardcoded approver name fallbacks `saadat` / `sajid` | [routes/payroll-runs.js](routes/payroll-runs.js) | Pay-run approval falls back to specific user logins |
| Hardcoded recipients `Taj + Saadat` for weekly summary email | [server.js:416-423](server.js:416) | Cron job emails real owners |

### A9. ABNs / phone numbers / postcodes / addresses

- Aus mobile pattern `04XXXXXXXX` hits in seed migrations 90/91/83 (Villawood crew + clients).
- ABN field present on `clients` (mig 35) but the values seeded are mostly empty or NULL — no fake ABNs at risk of cross-contamination.
- Postcodes appear in seed addresses; concentrated in NSW 2xxx range (Sydney).

### A10. Feature flags & dark paths

No `if (false)` / `if (0)` patterns found. No env-var-gated dark code beyond the documented Phase 4 stub in [lib/admin-db.js:52-62](lib/admin-db.js:52). Routes that exist but aren't sidebar-linked: verify [routes/voc-public.js](routes/voc-public.js), [routes/sop-sign.js](routes/sop-sign.js), [routes/toolbox-attend.js](routes/toolbox-attend.js) — these are *intentionally* public token-protected URLs (auditor QR scan, public sign-off), not orphans.

---

## §B — Security & tenancy

### B1. Hardcoded secrets / keys
**CLEAN.** Grep for AWS / Stripe / Resend / VAPID / JWT patterns across the whole repo (excl. node_modules + .git) returned 0 real keys. `.env.example` contains only placeholders (`re_YOUR_API_KEY_HERE`). `.gitignore` covers `.env`.

### B2. Auth bypass in dev mode
**NONE.** `NODE_ENV !== 'production'` only flips cookie.secure and one warning log. Default admin password (`admin`/`admin123`) is gated by `must_change_password` enforced at [server.js:237-259](server.js:237). Named-seed admins flagged the same way via mig 214.

### B3. Tenant scoping — the structural risk

`npm run lint:tenant` reports **119 files using raw `getDb()`** instead of `req.db`. This is the Phase 2 migration backlog. **Today** it's INFO because tenant is hardcoded to `'ts'`. **At Phase 3** (real multi-tenant) without remediation it is CRITICAL — every business table query becomes a cross-tenant leak vector.

**Highest-risk unscoped routes (today's second-line defence + Phase-3 risk):**

| Route | Today's filter | Phase-3 risk if not migrated |
|---|---|---|
| [routes/hr.js:77-140](routes/hr.js:77) | Permission check `hr_dashboard`/`hr_employees` only — query uses `WHERE 1=1 AND e.company = ?` | HIGH — admin in tenant A could read tenant B's headcount via `?company=...` |
| [routes/hr-secure.js:14-74](routes/hr-secure.js:14) | Permission check; decrypts bank/TFN/super | HIGH — most sensitive table in the system |
| [routes/payslips-admin.js:91-194](routes/payslips-admin.js:91) | Permission check | HIGH — payroll data |
| [routes/abergeldie-payments.js:23](routes/abergeldie-payments.js:23) | Permission check + hardcoded client filter | MEDIUM — single-client today, becomes HIGH when genericised |
| [routes/chat.js:6](routes/chat.js:6) | Session check + per-thread membership | MEDIUM |
| [middleware/managerAuth.js:4](middleware/managerAuth.js:4) | — | MEDIUM (auth-decision query) |

Worker routes are well-defended by `WHERE crew_member_id = ?` (worker.id) at the query level — second-line defence is strong on `/w/*`.

### B4. CSRF
Solid. [middleware/csrf.js](middleware/csrf.js) generates a 256-bit token per session, validated on all unsafe methods. Service workers same-origin → cookie included. Exempt paths are intentionally token-protected (`/induction/*`, `/sop-sign/*`, `/toolbox-attend/*`, `/voc/*`) or service-worker scripts.

### B5. Permission checks
All sensitive route mounts in [server.js:262-324](server.js:262) use `requireLogin + requirePermission(...)`. Three mounts use `requireLogin` only:
- `/profile` — own-record only, intentional
- `/chat` — internal isAdmin / per-thread membership checks
- `/kudos-admin`, `/payroll`, `/finance/abergeldie-payments`, `/hr` — verified that router-internal handlers re-check the right permissions (`requirePermission('hr_employees')` etc.)

### B6. Worker authorization
`requireOwnData` middleware exists but is never used in production routes. Every worker route I checked filters by `req.session.worker.id` in the SQL `WHERE` clause — same outcome, different mechanism. Manager-side `routes/worker/manage.js` checks `portal_role` (re-read from DB on every request via [middleware/workerAuth.js:82-102](middleware/workerAuth.js:82)).

### B7. SQL injection
**CLEAN.** All dynamic SQL goes through `.prepare()` with `.get(...params)` / `.all(...params)`. Concatenated SQL (e.g. [routes/hr.js:90](routes/hr.js:90)) builds the WHERE clause from static string fragments with placeholders — no user input concatenated.

### B8. Upload security
[middleware/upload.js](middleware/upload.js): 25MB cap, allowlist `jpeg|jpg|png|gif|pdf|webp`, random filenames (`Date.now() + random + ext`). Files served via `express.static` from `public/uploads/` and auth-gated `data/uploads/`. No script extensions allowed. `pdfjs-dist` is `^3.11.174` (post-CVE-2021-44419).

### B9. Rate limits
- Login (`/login`, `/w/login`): 10 attempts / 15 min, IP-based ([server.js:191-199](server.js:191)). Vulnerable to office shared-IP lockout — one bad user blocks colleagues.
- Worker PIN: account-level lockout `PIN_MAX_ATTEMPTS=5` / `PIN_LOCK_MINUTES=15`, persistent across restart.
- **`/forgot-password` and `/w/forgot-pin` are NOT rate-limited.** Email-spam DoS vector.

### B10. Session hygiene
- No `session.regenerate()` after login. Session fixation defence-in-depth missing. LOW severity — connect-sqlite3 IDs aren't predictable.
- Logout properly calls `req.session.destroy()`.
- Mixed admin + worker sessions co-exist by design; `blockWorkerFromAdmin` handles the boundary.
- `SESSION_SECRET` not enforced — auto-generated if unset ([server.js:120](server.js:120)) → all sessions die on Node restart. Operational gotcha, not a security hole.

### B11. Default credentials
Default `admin/admin123` and named seeds (`suhail.a` / `Suhail123`, `saadat` / `TandS2026.`, `savanah` / `Savanah123`, `taj` / `Taj123`) are flagged with `must_change_password=1` by migrations 81 + 214. Enforcement is at [server.js:237-259](server.js:237) — every request short-circuits to `/profile` until changed. Cannot be bypassed except by going directly to `/profile` (which is the point).

---

## §C — Database honesty

### C1. Schema vitals
- **217 migrations declared, 215 actually applied.** Gaps at 98 and 126 — `recordMigration.run(98, ...)` and `recordMigration.run(126, ...)` are skipped. No in-file explanation. Likely failed migrations that were rolled back manually; verify with the owner.
- `PRAGMA foreign_keys = ON` at [db/database.js:10](db/database.js:10). FKs actually enforced.

### C2. DEAD tables (created, never read)
- **`email_inbox`** — table created, 0 references in code. Likely abandoned inbound-email feature.
- Spot-check confirms this is the only obvious DEAD business table.

### C3. Tables that are written but barely read
- `external_refs`, `sync_log` — integration plumbing (mig 11 era), no active routes call them.
- `activity_log` — written by [middleware/audit.js:22](middleware/audit.js:22) (245 call sites), read only by [routes/activity.js](routes/activity.js) summary page. Useful as a compliance artifact, under-leveraged in the UI.

### C4. Dead columns
Spot-checked recent column additions (mig 73 priority, 75 ready_for_invoice, 80 compliance_id, 81 must_change_password, 94 deleted_at, 102 employees deleted_at, 147 invoiced columns, 169 internal_hourly_rate). All read in handlers; none obviously dead. The `compliance_revisions.client_issued` (mig 85) is the borderline case — exists, flagged, but downstream invoicing doesn't yet leverage it (see Component 10).

### C5. Missing FK relationships (informal)
- `docket_signatures` has no `approved_at` / `approved_by_user_id` (Component 9 gap).
- `incidents.notifiable_incident` is boolean only — no link to a categories table or notification log (Component 8 gap).
- `incidents.photo_path` is comma-separated text — should be a normalised attachments table.

### C6. Migration sequence notes worth knowing
- Mig 1 jobs schema rebuilt (status CHECK constraint).
- Mig 14 worker PIN columns.
- Mig 63 one-time "wipe all data for clean production launch."
- Mig 81 + 214 default-creds defence.
- Mig 90/91 Villawood crew seed (white-label problem).
- Mig 154 Plans → Sub-Plans hierarchy.
- Mig 160/161 Building & Construction Award seed.
- Mig 166 SWMS 6-month expiry.
- Mig 186 SWMS version_token (re-ack on file change).
- Mig 200 crew_swms_grants + access_requests.
- Mig 210 standalone TGS Risk Assessments.
- Mig 215 VOC tables.
- Mig 217 (latest) toolbox_attendance CHECK relax.

---

## §D — Automations inventory

All automations run as `setInterval` inside the single Node process. No `pg_cron`, no Bull/BeeQueue, no distributed scheduler. If the Railway dyno restarts, intervals reset. If you scale horizontally to two replicas, **every job fires twice** — there's no leader election or distributed lock.

| Trigger | Cadence | What it does | Tables | Error handling | Defined |
|---|---|---|---|---|---|
| `generateNotifications` | startup + every 15 min | Pulls unread events (incidents, tasks, messages) → upserts `notifications` | `notifications` | Logs to console | [server.js:398-399](server.js:398) |
| `sendUpcomingShiftReminders` | startup + every 15 min | Finds shifts 23–25h ahead → push notify roster, dedup via `shift_reminder_log` | `shift_reminder_log`, `worker_push_subscriptions` | Console + individual catch | [server.js:404-405](server.js:404) |
| `sendDailyDigests` | every 15 min, fires when hour=7 & min<15 | Email digests via Resend | — (email only) | Console | [server.js:407-414](server.js:407) |
| `generateWeeklySummaries` | every 15 min, fires Mon 7:15-7:29 AM | Diary summary → email to **hardcoded Taj + Saadat** | — | Console | [server.js:416-423](server.js:416) |
| `sendCertExpiryReminders` | every 15 min, fires 7:30-7:45 AM | Scan crew_members for 30/14/7-day expiries → push | `cert_expiry_reminder_log` | Console + caught | [server.js:429-434](server.js:429) |

### Anthropic / LLM
**Zero.** No `anthropic` / `@anthropic-ai/sdk` dependency. No prompts. No model calls. No AI features.

### Email-driven
- Outbound only, via Resend HTTP API ([services/email.js](services/email.js)).
- No inbound webhook processing despite the `email_inbox` table existing (see §C2).

### Push
- VAPID keys auto-generated on startup, stored in `system_config`.
- `services/pushNotification.js` handles subscribe / unsubscribe / send.
- Worker prefs honoured via [worker_notification_prefs](db/schema.js) (mig 201).

---

## §E — Concentrated white-label data leaks (the buyer-demo nightmare list)

For convenience, the items a buyer would see by clicking around on a fresh DB:

1. **Crew list / HR roster:** 54 real Villawood TCs including Saadat (`0469295448`) and Taj (`0416221801`) with phone numbers and emails. Source: mig 90/91.
2. **Client list:** Abergeldie Complex Infrastructure with contact Harry Iqbal (`0499 516 282`). Source: mig 83 + earlier seeds.
3. **Finance section title:** literally "Abergeldie Payment Sheet". Source: [routes/abergeldie-payments.js:74](routes/abergeldie-payments.js:74) hardcoded + view titles.
4. **Sidebar / header / favicon / PWA manifest:** "Atomis" branding everywhere. Source: [public/manifest.json](public/manifest.json), [public/manifest-admin.json](public/manifest-admin.json), [views/partials/header.ejs](views/partials/header.ejs), `public/images/atomis-*.svg`.
5. **Dummy account `EMP-TEST` / PIN `1234`** in crew roster. Source: mig 114.
6. **Pay-run approvers** hardcoded fallback to `saadat`/`sajid`. Source: [routes/payroll-runs.js](routes/payroll-runs.js).
7. **Weekly summary email** sent every Monday 7:15 AM to Taj + Saadat. Source: [server.js:416-423](server.js:416).
8. **TGS Register** in the Plans module pre-populated with T&S 2026 register entries. Source: mig 64.
9. **Active jobs** seeded with real assignments to "Taj" / "Greg" via `pmMap`. Source: ~[db/schema.js:3451-3482](db/schema.js:3451).
10. **T&S vehicle fleet** seeded with real plates. Source: mig 149.

All of these are fixed by either a "scrub seeds for fresh deployments" path or a configuration layer on top of the existing schema. None require architectural change — but until they're addressed, **don't run a buyer demo on a fresh seed.**
