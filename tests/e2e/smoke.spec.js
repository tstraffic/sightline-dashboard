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
  // Sightline CRM (brief Phase 1)
  '/clients',
  '/clients?view=crm',
  '/contacts',
  '/opportunities',
  '/opportunities/pipeline',
  '/opportunities/new',
  '/proposals',
  '/referrals',
  '/referrals/new',
  '/crm',
  '/crm/activities',
  '/crm/meetings',
  // Delivery
  '/projects',
  '/jobs',
  '/service-packages',
  '/deliverables',
  '/approvals',
  '/variations',
  '/budgets',
  // Shared
  '/tasks',
  '/profile',
  '/settings',
  // Hidden-but-alive T&S modules stay routable for admins (hide ≠ delete).
  '/compliance',
  '/timesheets',
  '/crew',
  // The two department hubs whose sidebar sections survive the Sightline trim.
  '/departments/operations',
  '/departments/finance',
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

test('smoke — delisted department hubs are gated, not broken', async ({ page }) => {
  await loginAs(page);
  // Planning/safety/people/assets sections were delisted for Sightline, so
  // sectionVisibleByKey gates their hubs. They must refuse cleanly (403 or
  // a redirect elsewhere), never 500.
  for (const url of ['/departments/planning', '/departments/safety', '/departments/people', '/departments/assets']) {
    const res = await page.goto(url);
    expect(res?.status(), `${url} should not 5xx`).toBeLessThan(500);
  }
});
