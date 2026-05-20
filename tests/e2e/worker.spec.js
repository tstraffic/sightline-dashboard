// Worker portal smoke: PIN login flow + key worker-portal pages render
// after login. These cases aren't covered by smoke.spec.js (admin only)
// or auth.spec.js (admin login only). They protect the most error-prone
// Phase 2 paths — worker login goes through a different table
// (crew_members) and a different middleware (workerAuth), and is the
// kind of thing easy to break when adding tenant_id scoping to auth.
//
// Seeded by migration 114 (db/schema.js:5101):
//   employee_id = 'EMP-TEST'  ·  PIN = '1234'  ·  full_name = 'Test Dummy'

const { test, expect } = require('@playwright/test');

async function workerLoginAs(page, employeeId = 'EMP-TEST', pin = '1234') {
  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', employeeId);
  await page.fill('input[name="pin"]', pin);
  await page.click('form button[type="submit"]');
  // POST /w/login redirects to /w/home on success. Wait for that.
  await expect(page).toHaveURL(/\/w\/home/);
}

test('worker PIN login → /w/home', async ({ page }) => {
  await workerLoginAs(page);
  // /w/home should render some worker-portal chrome. Look for the
  // bottom nav (mobile PWA layout) which is stable across rebrands.
  await expect(page.locator('nav, footer')).toBeVisible();
});

test('worker login with wrong PIN stays on /w/login', async ({ page }) => {
  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', 'EMP-TEST');
  await page.fill('input[name="pin"]', '9999');
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/w\/login/);
});

test('worker portal pages render after PIN login', async ({ page }) => {
  await workerLoginAs(page);
  for (const url of ['/w/home', '/w/jobs', '/w/forms', '/w/feed', '/w/safety']) {
    const res = await page.goto(url);
    expect(res?.status(), `${url} should not 4xx/5xx`).toBeLessThan(400);
    expect(page.url(), `${url} should not bounce to login`).not.toMatch(/\/w\/login/);
  }
});
