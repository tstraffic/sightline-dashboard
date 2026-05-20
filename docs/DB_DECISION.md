# SQLite vs Postgres — Atomis DB decision

**Status:** Decided · v1 · Week of Phase 0
**Owner:** Suhail
**Trigger to re-open:** Customer 11 onboarded, OR sustained write contention
that affects user experience, OR a feature requirement that genuinely needs
Postgres (row-level security, full-text search, large JSON aggregations).

---

## Decision

**Stay on SQLite (better-sqlite3 + WAL + Litestream) for year 1.** Revisit
at customer 11 or first sustained write-contention incident, whichever
comes first.

## Why this is even a question

Phase 2 of the migration adds `tenant_id` to ~80 tables. That's a
natural fork point — keep the SQLite story or move to Postgres before
doing the heavy refactor. Both options work multi-tenant; the question
is which has the right cost/risk shape for atomis specifically.

## Current state

| Thing | Value |
|---|---|
| Engine | SQLite via `better-sqlite3` ^12.6.2 |
| Path | `data/tstraffic.db` (single file) |
| Pragmas | `journal_mode = WAL`, `foreign_keys = ON` |
| Tables | ~80 defined across `db/schema.js` (10,000+ lines) |
| Migrations applied | 208 |
| Backups | Litestream continuous replication to Cloudflare R2 (see `BACKUPS.md`) |
| Sessions | Separate file `sessions.db` via `connect-sqlite3` |
| Tests | Playwright e2e suite (`tests/e2e/`) — separate test DB via `DATABASE_PATH` |
| Hosting | Railway, single service, persistent volume |
| Concurrent users | T&S today: ~5 admin + ~50 workers across the day. Peak concurrent writes: low. |

## Year-1 scale targets

| Year | Tenants | Total users (admin + worker) | Peak concurrent writes |
|---|---|---|---|
| 1 | 3–6 | ~300 | ~20/sec sustained, ~100/sec burst |
| 2 | 10–15 | ~800 | ~50/sec sustained |
| 3 | 30+ | ~2,500 | Postgres territory |

## Option A — Stay on SQLite (recommended)

### Pros (specific to atomis)

1. **No migration risk to T&S.** Phase 2 is hard enough without
   simultaneously porting 208 migrations and rewriting every
   `db.prepare(...).run()` call. T&S keeps running on the same engine
   they've been running on for months.
2. **WAL mode handles our concurrency.** `journal_mode = WAL` means
   many concurrent readers + one writer at a time. At our peak load
   (single-digit writes/sec across all tenants in year 1), this is
   nowhere near SQLite's ceiling (~10k inserts/sec on a hot connection
   per better-sqlite3 benchmarks).
3. **Synchronous API matches the codebase.** Every route file uses
   `db.prepare(...).get()` / `.all()` / `.run()` synchronously. Postgres
   = `pg`'s async API = every route handler becomes `async`/`await`.
   That's a codebase-wide refactor independent of the tenant work.
4. **Litestream backup story is already solved.** `BACKUPS.md` documents
   the existing R2 replication. Continuous WAL-frame replication with
   point-in-time recovery. Switching to Postgres means migrating to
   Railway's managed Postgres backups (different RPO/RTO story) or
   building our own.
5. **Lower ops surface.** No connection pool to tune, no pgbouncer to
   eventually add, no `max_connections` to monitor. The "database" is
   a file. Railway's persistent volume handles durability.
6. **Cheaper.** Railway Postgres add-on is ~$20–40/mo in addition to
   compute. SQLite is free.

### Cons (specific to atomis)

1. **Single writer ceiling.** WAL allows concurrent readers but
   serialises writes. If two requests both try to mutate the same row
   at the same instant, one waits. Today this is invisible. With 30
   tenants and 50 active users each writing concurrently, it could
   start showing as p99 latency spikes.
2. **No JSONB-style indexed JSON.** SQLite has JSON1 functions
   (`json_extract`, `json_set`) but no JSONB type and no GIN index. For
   `custom_fields` (Phase 5) and `tenant_settings`, queries that filter
   inside JSON will table-scan. Mitigation: index by the few common
   filter keys with computed columns if it becomes a hot path.
3. **No native row-level security.** Postgres has RLS as a
   defence-in-depth layer below the application. SQLite doesn't. Our
   `tenantDb` wrapper + grep check + cross-tenant tests have to be the
   only line of defence.
4. **Vertical scaling only.** Can't add read replicas. Can't shard. If
   one tenant has a runaway export job that locks the file for a
   minute, every tenant feels it.
5. **Backup-restore drill never run on prod.** Litestream replicates,
   but we've never restored from R2 to a fresh Railway service. The
   first time we do it shouldn't be during an incident.

### What we mitigate if we stay

| Risk | Mitigation | Owner |
|---|---|---|
| File size growth uncapped | Cron job that reports `data/tstraffic.db` size to logs daily. Alert at >5 GB. | Phase 0 ongoing |
| Backup never tested | Quarterly drill: restore latest Litestream snapshot to a throwaway Railway service, run `node server.js`, verify smoke tests pass. Document in `BACKUPS.md`. | Phase 0 ongoing |
| Single-writer contention | Phase 2.5 includes a load smoke test that runs N concurrent requests against the staging DB. If p99 > 500ms, investigate. | Phase 2 ongoing |
| Tenant data exports needed | Build a `scripts/export-tenant.js` in Phase 4 that produces a clean SQL dump per-tenant. Doubles as the per-tenant restore path AND the Postgres-migration export when we eventually need it. | Phase 4 |
| Custom fields JSON queries slow | Add computed-column indexes only when a specific query goes hot. Don't pre-optimise. | Phase 5 onwards |

## Option B — Migrate to Postgres now

### Pros (specific to atomis)

1. **True concurrent writers.** Multiple processes/connections each
   writing simultaneously. At 30+ tenants this matters.
2. **JSONB with GIN indexes.** Custom-fields queries are indexed.
   `WHERE custom_fields @> '{...}'` is fast.
3. **Row-level security as defence-in-depth.** Even if `tenantDb`
   wrapper has a hole, RLS policies on every table would refuse the
   query at the engine level. Belt-and-suspenders for the
   highest-impact failure mode.
4. **Ecosystem.** pgAdmin, real ORMs (Drizzle / Kysely), connection
   pooling tools, monitoring (pg_stat_statements). The path from
   "single instance" to "read replica + primary" is well-trodden.
5. **Cloud-native portability.** Easier to move off Railway later
   (any cloud's managed Postgres works). SQLite on Railway is a
   Railway-volume bet.

### Cons (specific to atomis)

1. **208 migrations to port.** Many use SQLite-specific syntax (no
   `IF NOT EXISTS` on `ALTER TABLE`, `INTEGER PRIMARY KEY AUTOINCREMENT`,
   `json_extract`, table-rebuild dance). Real estimate: 2–3 weeks of
   careful work to replay schema in Postgres-native form, plus a data
   export/import cutover. **Risks T&S downtime.**
2. **Every route file refactor.** `db.prepare(...).run()` synchronous →
   `await pool.query(...)` async. That's the entire codebase touched
   independently of the tenant work. Conservative estimate: 1 week
   solid + significant test debt.
3. **New ops surface.** Connection pool tuning, vacuum schedule
   awareness, pgbouncer when connection counts grow. None of these
   are hard; they're just new responsibilities for a solo dev.
4. **Bigger Phase 0.** Postgres setup pushes Phase 0 from ~13 hrs to
   ~80–120 hrs. Slides the customer-2 window from Q4 2026 to Q1 2027.
5. **Cost.** Railway Postgres add-on ~$20–40/mo. Marginal but real.

### Effort if we did it now

- Week 1: Set up Railway Postgres, install `pg`, port `db/schema.js`
  migrations to a Postgres-native sequence (probably using `node-pg-migrate`
  or similar). Cross-validate each migration's resulting schema against
  the current SQLite schema.
- Week 2: Refactor `db/database.js` to a `pg` pool. Refactor every
  `db.prepare(...)` call site (every route file, every lib file, every
  middleware) to `await pool.query(...)`. This is mechanical but ~80
  files.
- Week 3: Data export from `tstraffic.db` → import to Postgres. Cutover
  weekend. Smoke test. Switch DATABASE_URL. Pray.

Total: 3 weeks of intense work just to get back to where we are today,
before any multi-tenant work starts.

## Recommendation reasoning

The pivot from "T&S dashboard" to "atomis platform" is the hard part.
That work happens regardless of engine. Adding a Postgres migration on
top means doing two big things at once — and T&S is the live patient.

SQLite + WAL + Litestream + `tenantDb` wrapper handles year 1 cleanly.
At year 2 customer 11 we'll know enough about real concurrency patterns
to make a much better-informed Postgres decision. By then we'll also
have:

- A working `scripts/export-tenant.js` (Phase 4) that produces clean
  per-tenant SQL — half the Postgres export problem solved.
- A bigger team or budget for an ops-heavy migration.
- Pricing data that tells us whether the Postgres cost matters.

Defer the migration. Do it when there's a reason, not because of
hypothetical scaling.

## Action items (during Phase 0)

- [x] Document this decision (this file)
- [ ] Add file-size monitoring to the daily log roll-up
- [ ] Schedule first quarterly Litestream restore drill (target: end
      of Phase 1)
- [ ] Confirm WAL checkpointing isn't bottlenecking — `PRAGMA
      wal_autocheckpoint` is at default 1000 pages; verify in
      production Railway logs no `SQLITE_BUSY` errors in the last 30
      days
- [ ] Add a `data/tstraffic.db` size to the admin portal's metrics
      page (Phase 4) so we see growth over time

## Re-open criteria

This decision gets a v2 review if any of:

1. Customer 11 onboards (we're approaching the year-2 scale band)
2. A single `SQLITE_BUSY` incident affects a user
3. p99 write latency exceeds 500ms for sustained periods
4. A required feature genuinely needs Postgres (RLS-style
   defence-in-depth on a regulated customer; full-text search across
   millions of rows; etc.)
5. We hire someone whose part-time job is ops

Until then: SQLite, Litestream, WAL.
