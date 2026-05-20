# Deployment runbook

Three environments. Three deploy modes. Don't get them confused.

| Env | Branch | URL | Database |
|---|---|---|---|
| **prod** | `main` | `tstc.up.railway.app` (Phase 3: `atomis.com.au`) | `data/tstraffic.db` |
| **staging** | `staging` | `staging.atomis.com.au` (set up after Phase 0) | `data/tstraffic.db` (separate Railway volume) |
| **local** | any | `http://localhost:3000` | `data/tstraffic.db` (your machine) |

The **only** thing that distinguishes staging from prod at the code level is the `ATOMIS_ENV=staging` environment variable. When that's set, the EJS layouts inject a bright-orange "STAGING" banner across the top of every page so we never confuse them in browser tabs.

---

## Promoting changes: the standard flow

1. **Push to `staging`** — Railway auto-deploys to `staging.atomis.com.au`. The orange banner appears at the top.
2. **Smoke-test on staging** — run `npm run test:smoke` against the staging URL, or click through the affected feature manually. For Phase 2 module merges, exercise that module's screens: list view, detail view, at least one form submit.
3. **Backup prod DB before merging to main** — if the change includes a migration. The Litestream replica covers automatic restore but the explicit snapshot makes the rollback instant:
   ```sh
   # Run from the prod Railway shell, OR pull the latest Litestream snapshot
   cp data/tstraffic.db backups/prod-pre-{module-or-feature}-$(date +%Y%m%d).db
   ```
4. **Merge to `main`** — Railway auto-deploys to prod.
5. **Verify** — hit `/` on prod, log in, check the affected feature. If anything's wrong, see "Rolling back" below.

---

## Rolling back prod

Two failure modes, two recovery paths.

### Code regression (no schema change)

```sh
# From your laptop, on main:
git revert <bad-commit-sha>
git push origin main
# Railway redeploys in ~30 seconds.
```

If the revert itself fails (merge conflicts), force-rewind:

```sh
git push origin main --force-with-lease <last-known-good-sha>:main
```

Force-pushing main is destructive — only do it if revert isn't viable and you're confident no other work is queued.

### Schema migration broke something

Litestream has been replicating to Cloudflare R2 since the start of the project (`BACKUPS.md`). To restore:

```sh
# On a fresh Railway shell, or locally:
litestream restore -o data/tstraffic-restored.db -if-replica-exists s3://...
# Swap it in:
mv data/tstraffic.db data/tstraffic-broken-$(date +%s).db
mv data/tstraffic-restored.db data/tstraffic.db
# Restart the service.
```

Then revert the offending migration commit on `main` so the broken migration doesn't reapply.

The migration replay is **idempotent** — `db/schema.js` checks `schema_migrations` before each migration, so booting against the restored DB picks up only the missing ones. But a migration that's already half-applied (column added, backfill failed) needs manual intervention. Don't restart the service without checking the state of `schema_migrations`.

---

## Setting up the staging Railway service (one-time)

Per v0.3 Prompt 00.A. This is a manual step in the Railway dashboard — Claude Code can't do it.

1. **In Railway dashboard:** project `ts-dashboard` (or whatever it's named) → New service → Deploy from GitHub → same repo, branch `staging`.
2. **Settings → Service Name:** `atomis-staging`.
3. **Variables:** copy from prod, then **change**:
   - `ATOMIS_ENV=staging` (this is what triggers the orange banner)
   - `SESSION_SECRET` to a different random value (don't share with prod)
   - `DATABASE_PATH=data/tstraffic-staging.db` (a different file from prod — never share)
   - `RESEND_API_KEY` — either use the same key or set up a separate Resend project so test emails don't pollute prod analytics
   - Drop `LITESTREAM_*` vars entirely — staging doesn't need backups
4. **Volumes:** mount a fresh persistent volume for `/app/data`. Do not reuse the prod volume.
5. **Domain:** Settings → Networking → Custom Domain → `staging.atomis.com.au`. Add the CNAME at Cloudflare pointing at the Railway-provided target.
6. **First deploy:** push the `staging` branch:
   ```sh
   git checkout main
   git pull
   git checkout -b staging
   git push -u origin staging
   ```
   Railway picks it up. Wait for the green check, hit `staging.atomis.com.au/login`, confirm the orange banner shows.
7. **Seed an admin user on staging** — first login uses `admin / admin123` (migration 0 seeds it on a fresh DB).

After that the staging branch is your sandbox. Push to it freely; never use force-push.

---

## Phase 3 cutover (T&S domain switch)

Documented here once Phase 3 ships. Short version: 48-hour comms email, Sunday evening cutover window, DNS swap, old domain 301-redirects for 90 days. Workers re-install the PWA from the new subdomain.

---

## What NOT to do

- **Never commit `data/*.db`** — that's the live database. Existing `.gitignore` covers it; double-check before any `git add -A`.
- **Never run migrations directly on the prod Railway shell unless you've taken a backup first.**
- **Never force-push `main`** unless you understand what's about to be lost. Always check `git log --oneline main..origin/main` first.
- **Never share staging credentials with prod** — different `SESSION_SECRET`, different DB file, different volume.
- **Never run `playwright test` against prod** — `playwright.config.js` is wired to spawn its own server with a throwaway DB, but a developer accidentally pointing it elsewhere = bad day.

---

## Backup verification drill (quarterly)

The Litestream restore path was set up in `BACKUPS.md` but has never been exercised. Per `docs/DB_DECISION.md` action items, run a restore drill once a quarter:

1. Spin up a fresh Railway service (no domain, no traffic)
2. Run `litestream restore` against the latest R2 snapshot
3. Boot the service, log in, hit `/dashboard`, confirm data renders
4. Tear down the service

If this drill ever fails, the SQLite-vs-Postgres decision should be revisited immediately — losing the backup story is one of the explicit re-open criteria.
