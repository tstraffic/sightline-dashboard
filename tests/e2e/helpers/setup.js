// Shared helpers for Playwright tests.
//
// loginAs(page, username, password) — drives the login form and asserts
// we land on the dashboard. Every test uses this because every admin
// route requires a session.
//
// resetTestDb() — synchronously deletes the test SQLite file so the app
// re-runs migrations + seeds a fresh admin user on next boot. Called
// from globalSetup before webServer starts.

const fs = require('fs');
const path = require('path');
const { expect } = require('@playwright/test');

const TEST_DB = path.join(__dirname, '..', '..', '..', 'data', 'test-e2e.db');

function resetTestDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = TEST_DB + suffix;
    try { fs.unlinkSync(p); } catch (e) { /* not present → fine */ }
  }

  // Build the fresh DB with test fixtures BEFORE the webServer boots.
  // Historic bug: the config set DATABASE_PATH, which the app never read —
  // so this suite silently ran against the developer's dev DB, and the
  // accounts it relies on (a usable admin/admin123, the EMP-TEST worker)
  // only existed there. On a genuinely fresh DB:
  //   - migration 114 seeds EMP-TEST only when SEED_TEST_USERS=true
  //   - the seeded admin gets must_change_password=1, which diverts the
  //     login happy-path to the change-password screen
  // So initialise here with the right flags, then clear the flag for the
  // test admin. The server (booted with the same DB_PATH) finds users
  // already present and skips re-seeding.
  process.env.DB_PATH = TEST_DB;
  process.env.SEED_TEST_USERS = 'true';
  const { initializeDatabase } = require('../../../db/schema');
  initializeDatabase();
  const Database = require('better-sqlite3');
  const db = new Database(TEST_DB);
  db.prepare("UPDATE users SET must_change_password = 0 WHERE username = 'admin'").run();
  db.close();
}

async function loginAs(page, username = 'admin', password = 'admin123') {
  await page.goto('/login');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/dashboard$/);
}

module.exports = { loginAs, resetTestDb, TEST_DB };
