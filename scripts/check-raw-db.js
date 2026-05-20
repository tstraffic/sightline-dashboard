#!/usr/bin/env node
/**
 * scripts/check-raw-db.js — Phase 0 safety net.
 *
 * Greps the codebase for direct imports of better-sqlite3 (or our wrapper
 * around it at db/database.js / db/schema.js). Any file outside the
 * whitelist that imports the raw handle is flagged — those are the
 * files Phase 2 has to migrate to req.db.
 *
 * Exits 0 if all imports are inside the whitelist, 1 otherwise. During
 * Phase 0 and Phase 2 it'll fail loudly with a long list — that list IS
 * the Phase 2 work backlog. After Phase 2 completes, this becomes a
 * blocking CI check.
 *
 * Usage:
 *   node scripts/check-raw-db.js              # report violations, exit 1 if any
 *   node scripts/check-raw-db.js --quiet      # just the count + exit code
 *   node scripts/check-raw-db.js --json       # machine-readable output
 */
const fs = require('fs');
const path = require('path');

// Repo root = parent of this script's directory.
const ROOT = path.resolve(__dirname, '..');

// Files / directories that are ALLOWED to import the raw db handle.
// These are either:
//  - The wrapper itself (lib/tenant-db.js)
//  - The wrapper attach point (middleware/tenant.js)
//  - The admin portal helper (lib/admin-db.js — built in Prompt 00.E)
//  - DB internals (db/*, naturally)
//  - Anything under routes/admin/* (the admin portal intentionally
//    bypasses tenant scoping for cross-tenant queries)
//  - One-off / migration scripts (scripts/*)
//  - The app entry point (server.js — bootstraps the handle)
//  - The e2e test suite (uses its own throwaway DB)
//
// Add new exemptions sparingly; each one is a place where tenant
// scoping is the developer's responsibility, not the wrapper's.
const ALLOWLIST_PATTERNS = [
  /^db\//,
  /^lib\/tenant-db\.js$/,
  /^lib\/admin-db\.js$/,
  /^middleware\/tenant\.js$/,
  /^routes\/admin\//,
  /^scripts\//,
  /^server\.js$/,
  /^tests\/e2e\//,
];

// Regex matching the imports we care about. `require('better-sqlite3')`
// (direct), `require('./db/database')` / `require('../db/database')` /
// `require('../../db/schema')` (indirect — both give access to the raw
// handle through `getDb()` / `initializeDatabase()`).
const IMPORT_RE = /require\(\s*['"](better-sqlite3|\.{1,2}\/[\w./-]*?db\/(?:database|schema))['"]\s*\)/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function isAllowlisted(relPath) {
  return ALLOWLIST_PATTERNS.some((re) => re.test(relPath));
}

function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const asJson = args.includes('--json');

  const files = walk(ROOT);
  const violations = [];

  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    if (isAllowlisted(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (IMPORT_RE.test(lines[i])) {
        violations.push({
          file: rel,
          line: i + 1,
          source: lines[i].trim(),
        });
        break; // one violation per file is enough
      }
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: violations.length === 0, violations }, null, 2) + '\n');
  } else if (quiet) {
    if (violations.length > 0) {
      console.error(`lint:tenant FAILED — ${violations.length} file(s) still import the raw DB handle.`);
    } else {
      console.log('lint:tenant ok — all DB access goes through req.db.');
    }
  } else {
    if (violations.length === 0) {
      console.log('lint:tenant ok — no files outside the allowlist import the raw DB handle.');
    } else {
      console.error(`\nlint:tenant FAILED — ${violations.length} file(s) import the raw DB handle.\n`);
      console.error('These are the Phase 2 migration targets. Each must be refactored to use');
      console.error('req.db (in route handlers) or be added to the allowlist in this script\n');
      console.error('(only for code that legitimately needs cross-tenant access).\n');
      for (const v of violations) {
        console.error(`  ${v.file}:${v.line}  ${v.source}`);
      }
      console.error('');
    }
  }

  process.exit(violations.length === 0 ? 0 : 1);
}

main();
