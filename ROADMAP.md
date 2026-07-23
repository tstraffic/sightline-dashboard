# Atomis / ts-dashboard — Platform Upgrade Roadmap

**Date:** 2026-07-23 · **HEAD:** `6e5a5de`
**Grounded in:** the May 2026 buyer-honesty audit ([AUDIT_REPORT.md](AUDIT_REPORT.md) @ `17b4988`), the 481 commits landed since, and a fresh read-only sweep of HEAD (dashboard, code health, performance, tests, security, front-end delivery).

---

## Where the platform actually stands (July 2026)

Stronger than the May audit reads today. Already **fixed** since the audit: worker-incident weather/GPS persistence, plan-code regex, `EMP-TEST` seed gating, password-reset rate limiting, worker shift decline, configurable weekly-summary recipients. Invoice engine v2 (client billing profiles, per-client rate cards), the Traffio docket→invoice pipeline, and QuickBooks Online push **supersede much of the "one-client invoicing" finding**. Indexing is thorough (540 indexes), Litestream backup is production-grade, and the code has essentially zero TODO rot.

What remains is: **no delivery safety net (CI), a handful of security/ops hygiene items, front-end delivery debt, and the unstarted sellable-product structural work.**

---

## Tier 0 — Do immediately (hours, mostly ops not code)

| # | Item | Where | Why |
|---|------|-------|-----|
| 1 | **Rotate the live prod admin password** (still `admin/admin123` per CLAUDE.md; fresh-deploy code is already safe, the live DB predates it) | production DB | Highest-risk item on the list |
| 2 | **Delete the dev auth-bypass block** (`TODO(remove)`, auto-logs-in an admin) | `server.js:150-168` | Latent risk if prod detection ever regresses |
| 3 | **Fail-fast when `SESSION_SECRET` is unset in prod** (today: warns, generates an ephemeral secret, logs everyone out each restart) | `server.js:123` | Silent session wipe on every restart |

## Tier 1 — Reliability rails (days; do before feature work)

| # | Item | Where | Why |
|---|------|-------|-----|
| 4 | **Stand up CI** — GitHub Actions running `test:smoke`, `lint:tenant`, `test:cross-tenant` on PR | new `.github/workflows/` | 80+ routes ship with zero automated gate; the highest-leverage single change |
| 5 | **Tailwind build step + self-host vendor libs (Chart.js, Leaflet, Sortable), then enable CSP** | `views/layout.ejs:124`, `views/worker/layout.ejs:93`, partials | `cdn.tailwindcss.com` is the not-for-production build; it's also *why* CSP is off (helmet CSP disabled at `server.js:45`). One move fixes perf + reliability + security |
| 6 | **CSRF on multipart uploads** (currently bypassed; many forms are uploads) | `middleware/csrf.js` | Meaningful hole, cheap fix |
| 7 | **e2e smoke coverage for the money paths** — booking→docket→invoice, a payroll run, a compliance submission | `tests/e2e/` | The largest modules (bookings, payroll, invoicing) have zero coverage today |

## Tier 2 — Team effectiveness (days each)

| # | Item | Where | Why |
|---|------|-------|-----|
| 8 | **Fix bookings N+1s** — per-row COUNT/crew subqueries in list maps (`:251`, `:619`, `:2597`, `:3079`) → batched GROUP BY / IN joins | `routes/bookings.js` | The board is the busiest screen in daily use |
| 9 | **Start splitting the giants**: `bookings.js` (3,991 lines), `board.ejs` (6,803), `hr.js` (2,733), `payroll-runs.js` (2,689); migrations → directory (`schema.js` is 15,255 lines) | `routes/`, `views/`, `db/` | Change velocity + review safety on the hottest files |
| 10 | **Make "Notifiable incident" real** — the checkbox is currently stored + counted only; add WHS Act category mapping + a SafeWork NSW notification workflow/reminder | `routes/incidents.js:139,281` | Compliance liability for a traffic-control business |
| 11 | **Dashboard correctness + shape**: wire the two hardcoded-false onboarding checks (`dashboard.js:186,188`), show a "widget failed to load" state instead of silently vanishing, consider a configurable widget layout (the `sidebar-customise` pattern already exists) | `routes/dashboard.js`, `views/dashboard.ejs` | The landing page should be trustworthy and personal |
| 12 | **CSS consolidation** — 428KB unminified across `custom.css` (653 `!important`), `worker.css`, `bookings-v2.css`; purge via the Tier-1 Tailwind build | `public/css/` | Mobile load time; folds into item 5 |

## Tier 3 — Sellable product (weeks; sequence by business need)

| # | Item | Effort | Why |
|---|------|--------|-----|
| 13 | **One payroll export adapter — Xero first**; remove the "coming soon" integration stubs (`integrations.js:260`) | 1–2 wk | The gap every Aus buyer hits day one; QBO push covers AR only |
| 14 | **Retire/fold the Abergeldie module into invoice engine v2** — `abergeldie-payments.js` (1,143 lines) still hardcodes the client; v2 rate cards make it redundant | ~1 wk | Kills the worst white-label artifact; engine v2 already did the hard part |
| 15 | **Avetta OR ISNetworld evidence pack** (pick one — Avetta) built on `lib/pdfMerge.js`; the audit-trail data already exists | 2–3 wk | Explicit buyer ask; still zero code |
| 16 | **Cron → leader-elected scheduler/queue; PDF/parse work off the request thread** (11 `setInterval`s at `server.js:515-601`) | 1–2 wk | Precondition for running more than one instance |
| 17 | **2FA (TOTP) for admin accounts** | ~1 wk | The first enterprise-security question; SSO/SAML can wait for a real deal |
| 18 | **Multi-tenancy Phase 2** — migrate the 104 raw `getDb()` route files to `req.db` (wrapper + lint guard already built), `tenant_id` backfill | 2–3 wk | ONLY when a shared-instance SaaS deal is real; single-tenant-per-Railway-service sells today without it |

---

## Recommended order

- **Week 1:** Tier 0 (hours) + start CI (item 4).
- **Weeks 1–2:** Items 5–7 — the delivery/safety rails. Everything after this ships with a net.
- **Weeks 3–4:** Items 8–12 as a "daily effectiveness" batch — board speed + incident compliance + dashboard trust.
- **Then choose the product track:** if a second customer/demo is on the horizon → 13, 14, 15 in that order. If scaling T&S usage is the priority → 16 first. Defer 18 until a shared-instance deal exists.

## What NOT to spend time on

- Multi-tenancy before there's a shared-instance buyer (single-tenant deploys sell now)
- SSO/SAML before an enterprise deal asks for it
- More design polish — the audit and the fresh sweep both rate it REAL; 481 commits already invested here
- New dashboards/widgets beyond item 11 — the data layer is the constraint, not the UI
