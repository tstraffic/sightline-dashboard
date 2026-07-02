// Playwright config for the atomis e2e suite.
//
// Notes:
//  - We spin up the Express server ourselves (see webServer below) so the
//    test suite never touches a developer's dev DB or the prod Railway DB.
//  - DATABASE_PATH is redirected to a throwaway file inside ./data so the
//    existing `.gitignore` pattern (data/*.db) keeps it out of commits.
//  - SQLite is single-writer; we pin to 1 worker to avoid race flake on CI.
//    E2E wall-clock hit is small — these are full-stack smoke tests, not
//    unit tests.
//  - Use PORT=3101 to avoid clashing with the default dev server on 3000.

const path = require('path');
const testDbPath = path.join(__dirname, 'data', 'test-e2e.db');

module.exports = {
  testDir: './tests/e2e',
  globalSetup: require.resolve('./tests/e2e/globalSetup.js'),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3101',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium-desktop', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'chromium-mobile',  use: { viewport: { width:  375, height: 812 } } },
  ],
  webServer: {
    command: 'node server.js',
    port: 3101,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      PORT: '3101',
      // The app reads DB_PATH (db/schema.js). DATABASE_PATH alone was set
      // here historically but never read by the app — the suite silently ran
      // against the dev DB. DB_PATH now does the real isolation.
      DB_PATH: testDbPath,
      DATABASE_PATH: testDbPath,
      SEED_TEST_USERS: 'true',
      SESSION_SECRET: 'test-suite-session-secret',
      // Keep the seed script quiet; it's already side-effect-free for tests.
      NODE_ENV: 'test',
    },
    // Blow away the test DB before each run so state is deterministic.
    // Playwright runs the command as-is; do the cleanup via a wrapper script.
  },
};
