#!/bin/bash
# Production entry-point. Wraps `node server.js` with Litestream so the
# live SQLite database is continuously replicated to object storage.
#
# Flow:
#   1. If a Litestream replica is configured (LITESTREAM_BUCKET set):
#        a. Restore from the replica IF this container has no local DB
#           yet. -if-replica-exists guards the very first deploy (no
#           replica yet); -if-db-not-exists guards normal restarts (don't
#           clobber a live DB).
#        b. exec litestream replicate -exec "node server.js" so litestream
#           supervises the node process and forwards SIGTERM.
#   2. Otherwise run node directly — for local dev or any environment
#      without a configured bucket.
#
# Set LITESTREAM_BUCKET (and the rest of the LITESTREAM_* vars listed in
# litestream.yml) in Railway to turn this on.

set -e

cd "$(dirname "$0")"

DB_PATH=${DB_PATH:-/app/data/tstraffic.db}

echo ""
echo "  T&S Traffic Control - Project Dashboard"
echo "  ========================================="
echo ""

if [ -n "$LITESTREAM_BUCKET" ] && command -v litestream >/dev/null 2>&1; then
  echo "[start.sh] Litestream bucket=$LITESTREAM_BUCKET endpoint=$LITESTREAM_ENDPOINT"

  # Restore if there's a replica AND no local DB on this volume.
  # || true so an empty replica on first boot doesn't fail the container.
  litestream restore \
    -if-replica-exists \
    -if-db-not-exists \
    -config /etc/litestream.yml \
    "$DB_PATH" || true

  echo "[start.sh] starting node under 'litestream replicate'"
  exec litestream replicate -config /etc/litestream.yml -exec "node server.js"
else
  if [ -z "$LITESTREAM_BUCKET" ]; then
    echo "[start.sh] LITESTREAM_BUCKET not set — running without replication"
  else
    echo "[start.sh] litestream binary missing — running without replication"
  fi
  exec node server.js
fi
