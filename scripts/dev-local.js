// Local dev entry — keeps the SQLite database OUTSIDE the OneDrive-synced
// working copy (better-sqlite3 WAL + OneDrive sync can lock/corrupt the
// file). Production (Railway/start.sh) sets DB_PATH itself and never uses
// this entry.
const fs = require('fs');
const path = require('path');

if (!process.env.DB_PATH) {
  const dir = path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'sightline-dev');
  fs.mkdirSync(dir, { recursive: true });
  process.env.DB_PATH = path.join(dir, 'sightline.db');
}
console.log('[dev-local] DB_PATH =', process.env.DB_PATH);

require(path.join(__dirname, '..', 'server.js'));
