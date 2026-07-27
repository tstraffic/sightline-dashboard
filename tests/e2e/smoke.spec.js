// Smoke: every top-level admin page loads without a 500 and renders a
// sensible title. Cheap regression net against broken routes / missing
// template vars / bad SQL.
//
// The server rate-limits /login to 10 attempts / 15 min, so we log in
// ONCE at describe setup and reuse the session for all page probes.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

const PAGES = [
  '/dashboard',
  '/jobs',
  '/projects',
  '/tasks',
  '/compliance',
  '/plans',
  '/audits',
  '/incidents',
  '/equipment',
  '/equipment/hire-dockets',
  '/timesheets',
  '/contacts',
  '/crew',
  '/clients',
  '/profile',
  // Department hubs — probing all seven executes every registry statsFn
  // (lib/departments.js) against a fresh schema.
  '/departments/planning',
  '/departments/safety',
  '/departments/operations',
  '/departments/finance',
  '/departments/people',
  '/departments/assets',
  '/departments/reports',
];

test.describe.configure({ mode: 'serial' });

test('smoke — every admin page renders after login', async ({ page }) => {
  await loginAs(page);
  for (const url of PAGES) {
    const res = await page.goto(url);
    expect(res?.status(), `${url} should not 4xx/5xx`).toBeLessThan(400);
    expect(page.url(), `${url} should not bounce to login`).not.toMatch(/\/login/);
    // Just ensure we're not on the login page — specific page titles diverge
    // from URLs (e.g. /crew → "Workforce") and are easy to rename.
    await expect(page, `${url} should not show login title`).not.toHaveTitle(/^Login/i);
  }
});
