# Testing strategy

Three test layers protect the migration. Each has a different cost/coverage
trade-off — run the appropriate layer for the kind of change you're making.

## Layer 1 — `lint:tenant` (grep, milliseconds)

```sh
npm run lint:tenant
```

Static check. Fails if any file outside the allowed boundary imports the raw
better-sqlite3 handle. Catches "you forgot to use req.db in a new route."

- Runs in: a few hundred milliseconds
- What it catches: import-level scoping violations
- What it doesn't catch: anything that compiles cleanly but queries the wrong
  tenant at runtime
- Today's expected output: ~110 violations (the Phase 2 work list)
- After Phase 2: exits 0; wired into CI as a blocking check

## Layer 2 — End-to-end smoke (Playwright, ~30 seconds)

```sh
npm run test:e2e          # full e2e suite
npm run test:smoke        # subset — fast feedback for Phase 2 module merges
```

Browser-driven. Boots the full Express server against a throwaway SQLite file
(`data/test-e2e.db`) and exercises critical user paths via real HTTP.

Coverage today:
- `auth.spec.js` — admin login happy + bad creds + unauthenticated redirect
- `smoke.spec.js` — all 15 top-level admin pages render after login (no 4xx/5xx)
- `worker.spec.js` — worker PIN login + 5 worker portal pages render
- `responsive.spec.js` — mobile viewport sanity
- `voc.spec.js` / `voc-phase-2.spec.js` — VOC certificate flows

- Runs in: ~30 seconds locally, slower in CI
- What it catches: broken routes, missing templates, dead form actions,
  session/cookie regressions, auth flow breakage
- What it doesn't catch: cross-tenant data leakage (that's layer 3),
  per-module business-logic bugs that don't surface in 15 seconds of
  clicking

**Run this after every Phase 2 module merge before going to bed.** If it's
red on Monday morning, you find out before the crew does.

## Layer 3 — Cross-tenant leak detector

```sh
npm run test:cross-tenant
```

The thing that catches "tenant A can see tenant B's data." Built with
`node --test` (no new dep — built into Node 22+).

- `tests/cross-tenant/fixture.js` — `createTwoTenants()` spins up a fresh
  in-memory SQLite, creates a `tenants` table and a `test_data` placeholder,
  inserts two seeded tenants, returns scoped `dbA` and `dbB` wrappers.
- `tests/cross-tenant/wrapper.test.js` — exhaustive `assertScoped`
  variants: every shape of unscoped query throws, every shape of scoped
  query passes, whitelisted tables pass without scoping, non-table SQL
  (PRAGMA, BEGIN, EXPLAIN) is ignored.
- `tests/cross-tenant/leak.test.js` — end-to-end leak proofs: insert as
  tenant-a, query as tenant-b, assert zero leakage. Mismatched-tenant
  UPDATE changes 0 rows. The `tenants` table itself is readable
  unscoped (by design).

- Runs in: ~120ms (in-memory, no browser, no file I/O)
- What it catches: the highest-impact failure mode of the whole migration
- What it doesn't catch: bugs that only surface under concurrent load

**Phase 2 expands this.** Each module prompt (02.B run per module) will
copy the `test_data` pattern in `leak.test.js` against the real business
table (`jobs`, `crew_members`, `allocations`, …) once those tables get
their `tenant_id` columns. The work pattern: insert two rows scoped to
different tenants, assert neither leaks.

## When to run what

| You're doing | Run |
|---|---|
| Anything that touches a route handler | `lint:tenant` + `test:e2e` |
| Adding `tenant_id` to a table (Phase 2 module migration) | `lint:tenant` + `test:e2e` + `test:cross-tenant` (after 00.F) |
| Changing the `tenantDb` wrapper itself | The wrapper sanity tests in `lib/tenant-db.js` header + all three layers |
| Touching only EJS templates | `test:e2e` |
| Touching only docs / CLAUDE.md | Nothing automated; eyeball the render |

## Test database

E2E suite uses `data/test-e2e.db`. `tests/e2e/globalSetup.js` deletes it
before each run, so every suite starts from a clean migration replay + seeded
admin (`admin/admin123`) and worker (employee ID `EMP-TEST`, PIN `1234`).

**Never point the test runner at `data/tstraffic.db`.** `playwright.config.js`
sets `DATABASE_PATH` for the webServer it spawns; respect that.

## What we don't have

- **Unit tests.** No `tests/unit/` directory. The wrapper's sanity is asserted
  inline in this README's verification snippet from PR #388 — good enough until
  there's a unit framework. Don't add `jest` for this; it's overkill.
- **Load tests.** Single-writer SQLite contention isn't measured. Decision
  doc `docs/DB_DECISION.md` flags this as a "revisit at customer 11" trigger.
- **Visual regression tests.** None. UI changes are reviewed manually in
  staging.

## CI integration

Today:
- `lint:tenant` runs but is expected to fail during Phase 0–2
- `test:e2e` runs against the test SQLite file

After Phase 2:
- `lint:tenant` becomes a blocking check
- `test:cross-tenant` runs on every PR

After Phase 3 (staging exists):
- Push to `staging` branch deploys to `staging.atomis.com.au`
- Smoke tests run against staging URL nightly
- Failures page Suhail via Sentry
