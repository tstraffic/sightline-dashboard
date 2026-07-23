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
  // So initialise here with the right flags, then give the test admin a
  // usable (non-default) password. It can't stay admin123: migration 325 +
  // the login-time guard in routes/auth.js force a password change on ANY
  // successful admin123 login, which would divert every loginAs() to
  // /profile. The server (booted with the same DB_PATH) finds users
  // already present and skips re-seeding.
  process.env.DB_PATH = TEST_DB;
  process.env.SEED_TEST_USERS = 'true';
  const { initializeDatabase } = require('../../../db/schema');
  initializeDatabase();
  const Database = require('better-sqlite3');
  const bcrypt = require('bcryptjs');
  const db = new Database(TEST_DB);
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE username = 'admin'")
    .run(bcrypt.hashSync(TEST_ADMIN_PASSWORD, 10));
  // Role-gating specs log in as the seeded non-admin roles too (e.g.
  // planning_user in voc.spec.js). Dev seeds flag every account
  // must_change_password=1, which diverts login to /profile — clear the
  // flag for the accounts the suite drives. Their seed password stays
  // 'password' (not admin123, so the forced-change guard ignores it).
  db.prepare("UPDATE users SET must_change_password = 0 WHERE username IN ('planning_user','ops_user','finance_user','accounts_user')").run();
  db.close();
}

const TEST_ADMIN_PASSWORD = 'e2e-test-password';

async function loginAs(page, username = 'admin', password = TEST_ADMIN_PASSWORD) {
  await page.goto('/login');
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/dashboard$/);
}

module.exports = { loginAs, resetTestDb, TEST_DB, TEST_ADMIN_PASSWORD };
