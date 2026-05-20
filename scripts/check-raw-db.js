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
//  - The admin portal helper (lib/admin-db.js — Prompt 00.E)
//  - DB internals (db/*, naturally)
//  - Anything under routes/admin/* (the admin portal intentionally
//    bypasses tenant scoping for cross-tenant queries)
//  - One-off / migration scripts (scripts/*)
//  - The app entry point (server.js — bootstraps the handle)
//  - The e2e test suite (uses its own throwaway DB)
//
// Add new exemptions sparingly; each one is a place where tenant
// scoping is the developer's responsibility, not the wrapper's.
const RAW_DB_ALLOWLIST = [
  /^db\//,
  /^lib\/tenant-db\.js$/,
  /^lib\/admin-db\.js$/,
  /^middleware\/tenant\.js$/,
  /^routes\/admin\//,
  /^scripts\//,
  /^server\.js$/,
  /^tests\/e2e\//,
];

// Files / directories ALLOWED to import lib/admin-db.js. That helper
// intentionally bypasses tenant scoping, so import-site discipline is
// the only thing keeping it from leaking elsewhere.
const ADMIN_DB_ALLOWLIST = [
  /^lib\/admin-db\.js$/,    // self
  /^routes\/admin\//,        // the admin portal
  /^scripts\//,              // maintenance / migration tools
];

// Regex matching raw-DB imports: `require('better-sqlite3')` (direct),
// `require('./db/database')` / `require('../db/database')` /
// `require('../../db/schema')` (indirect — both give access to the raw
// handle through `getDb()` / `initializeDatabase()`).
const RAW_DB_RE = /require\(\s*['"](better-sqlite3|\.{1,2}\/[\w./-]*?db\/(?:database|schema))['"]\s*\)/;

// Regex matching adminDb imports — `require('./lib/admin-db')`,
// `require('../lib/admin-db')`, etc.
const ADMIN_DB_RE = /require\(\s*['"](\.{1,2}\/[\w./-]*?lib\/admin-db)['"]\s*\)/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function matches(patterns, relPath) {
  return patterns.some((re) => re.test(relPath));
}

function findFirstMatch(text, re) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return { line: i + 1, source: lines[i].trim() };
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const asJson = args.includes('--json');

  const files = walk(ROOT);
  const rawViolations = [];
  const adminViolations = [];

  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    const text = fs.readFileSync(abs, 'utf8');

    if (!matches(RAW_DB_ALLOWLIST, rel)) {
      const hit = findFirstMatch(text, RAW_DB_RE);
      if (hit) rawViolations.push({ file: rel, ...hit });
    }
    if (!matches(ADMIN_DB_ALLOWLIST, rel)) {
      const hit = findFirstMatch(text, ADMIN_DB_RE);
      if (hit) adminViolations.push({ file: rel, ...hit });
    }
  }

  const ok = rawViolations.length === 0 && adminViolations.length === 0;

  if (asJson) {
    process.stdout.write(JSON.stringify({
      ok,
      rawDbViolations: rawViolations,
      adminDbViolations: adminViolations,
    }, null, 2) + '\n');
  } else if (quiet) {
    if (rawViolations.length > 0) {
      console.error(`lint:tenant — ${rawViolations.length} raw-DB violation(s) (Phase 2 work list).`);
    }
    if (adminViolations.length > 0) {
      console.error(`lint:tenant — ${adminViolations.length} admin-DB violation(s) (block).`);
    }
    if (ok) console.log('lint:tenant ok.');
  } else {
    if (rawViolations.length > 0) {
      console.error(`\n${rawViolations.length} file(s) still import the raw DB handle.\n`);
      console.error('These are Phase 2 migration targets. Each must be refactored to use');
      console.error('req.db (in route handlers) or added to RAW_DB_ALLOWLIST in this script');
      console.error('(only for code that legitimately needs cross-tenant access).\n');
      for (const v of rawViolations) {
        console.error(`  ${v.file}:${v.line}  ${v.source}`);
      }
      console.error('');
    }
    if (adminViolations.length > 0) {
      console.error(`\n${adminViolations.length} file(s) import lib/admin-db.js from outside the allowed paths.\n`);
      console.error('lib/admin-db.js intentionally bypasses tenant scoping; only routes/admin/* and');
      console.error('scripts/ may import it. Either move the caller under those paths or justify');
      console.error('the cross-tenant query in a code review and extend ADMIN_DB_ALLOWLIST.\n');
      for (const v of adminViolations) {
        console.error(`  ${v.file}:${v.line}  ${v.source}`);
      }
      console.error('');
    }
    if (ok) {
      console.log('lint:tenant ok — every DB import is inside the allowed boundary.');
    }
  }

  process.exit(ok ? 0 : 1);
}

main();
