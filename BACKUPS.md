# Database Backups (Litestream)

The production SQLite database (`data/tstraffic.db`) is continuously
replicated to S3-compatible object storage by [Litestream](https://litestream.io).
Litestream runs as PID 1 in the container and supervises `node server.js`,
flushing WAL frames to the replica every second.

`sessions.db` is **not** replicated by design — restoring stale sessions
leads to ghost logins.

---

## One-time setup

### 1. Create a bucket

**Cloudflare R2 (recommended — free egress, ~$0.015/GB-month):**
1. Cloudflare dashboard → R2 → Create bucket: `ts-dashboard-backup`.
2. Settings → API Tokens → Create API Token → "Object Read & Write" on
   this bucket only. Save the Access Key ID + Secret.
3. Endpoint URL: `https://<account_id>.r2.cloudflarestorage.com`
   (account ID is on the R2 overview page).

**AWS S3** also works — use a standard IAM user with `s3:Get*`,
`s3:Put*`, `s3:List*`, `s3:DeleteObject` on the bucket.

### 2. Set Railway env vars

| Variable | R2 value | S3 value |
|----------|----------|----------|
| `LITESTREAM_BUCKET` | `ts-dashboard-backup` | `ts-dashboard-backup` |
| `LITESTREAM_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` | (blank, or `https://s3.<region>.amazonaws.com`) |
| `LITESTREAM_REGION` | `auto` | e.g. `ap-southeast-2` |
| `LITESTREAM_ACCESS_KEY_ID` | (from step 1) | (IAM user key id) |
| `LITESTREAM_SECRET_ACCESS_KEY` | (from step 1) | (IAM user secret) |

Redeploy. Startup logs should show:

```
[start.sh] Litestream bucket=ts-dashboard-backup endpoint=https://...
[start.sh] starting node under 'litestream replicate'
```

If `LITESTREAM_BUCKET` is **unset**, start.sh logs a warning and runs
node without replication. Useful for staging environments.

---

## Verify it's working

After ~30 seconds of traffic on the live app:

```sh
# From your laptop, with the same env vars exported:
litestream snapshots -config litestream.yml /app/data/tstraffic.db
litestream wal-segments -config litestream.yml /app/data/tstraffic.db
```

You should see a `generation`, a snapshot, and a growing list of WAL
segments. New WAL segments appear roughly every second under load.

---

## Disaster recovery

### Restore latest

A fresh container with no local DB will auto-restore on startup via
`litestream restore -if-replica-exists -if-db-not-exists`. To force a
restore in-place, stop the app and run:

```sh
rm /app/data/tstraffic.db /app/data/tstraffic.db-wal /app/data/tstraffic.db-shm
litestream restore -config /etc/litestream.yml /app/data/tstraffic.db
```

### Restore to a point in time

```sh
litestream restore \
  -config /etc/litestream.yml \
  -timestamp 2026-05-18T03:15:00Z \
  -o /tmp/restored.db \
  /app/data/tstraffic.db
```

Then swap `/tmp/restored.db` in for `data/tstraffic.db` and restart.

### Restore on a developer laptop

```sh
export LITESTREAM_BUCKET=ts-dashboard-backup
export LITESTREAM_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com
export LITESTREAM_REGION=auto
export LITESTREAM_ACCESS_KEY_ID=...
export LITESTREAM_SECRET_ACCESS_KEY=...

litestream restore -config litestream.yml -o ./tstraffic.db /app/data/tstraffic.db
```

`-o` overrides the destination path; the source path inside `-config`
must still match what the live app uses.

---

## Retention & cost

Defaults in `litestream.yml`:

- `retention: 720h` (30 days of WAL history)
- `snapshot-interval: 24h` (one snapshot per day)
- `sync-interval: 1s` (RPO ≈ 1 second)

At current DB size (~50–200 MB) expect well under $1/month on R2.
Adjust `retention` / `snapshot-interval` if storage cost matters.

---

## Common failure modes

- **`AccessDenied` in startup logs** → bucket creds wrong or token
  doesn't have write permission on the bucket. Re-issue.
- **`Litestream bucket=...` printed but no WAL segments appearing** →
  `LITESTREAM_ENDPOINT` is wrong. R2 endpoint must include the account
  ID; S3 endpoint must include region.
- **App restarts but DB is empty** → check `[start.sh]` line in logs.
  `-if-db-not-exists` means restore is **skipped** if the data volume
  already has a `tstraffic.db` file. Delete it manually if you
  intentionally want to roll back to the replica.
- **`sessions.db` lost after restore** → expected; sessions are not
  replicated. All users will need to log in again.
