// Test-server entry point for the Playwright webServer.
//
// Playwright boots the webServer BEFORE globalSetup runs. The old layout
// (reset in globalSetup, command: 'node server.js') meant the server opened
// the PREVIOUS run's test-e2e.db, globalSetup then unlinked + recreated the
// file, and the server kept serving the deleted inode via its open file
// descriptor — so every run actually tested the prior run's DB state. That
// stayed invisible while the seeded state never changed between runs, and
// would break outright on a fresh checkout (CI) where no test DB exists yet.
//
// Resetting here — inside the webServer command, before the app loads —
// guarantees the server and the tests see the same freshly-migrated file.
const { resetTestDb } = require('./helpers/setup');

resetTestDb();

// Boots Express on PORT (3101 from playwright.config.js webServer.env).
require('../../server.js');
