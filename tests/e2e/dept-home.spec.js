// Department home pages — Sightline trim edition.
//
// Only the hubs whose sidebar sections survived the trim (operations →
// "Delivery", finance → "Money") stay reachable; the rest must refuse
// cleanly via sectionVisibleByKey. The old 7-hub assertions live in this
// file's git history alongside the pre-Sightline sidebar registry.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

const LIVE_HUBS = [
  { key: 'operations', h1: 'Operations Home' },
  { key: 'finance', h1: 'Finance Home' },
];

test('surviving hubs render a header, title icon and at least one stat tile', async ({ page }) => {
  await loginAs(page);
  for (const hub of LIVE_HUBS) {
    await page.goto('/departments/' + hub.key);
    await expect(page.locator('h1'), hub.key).toContainText(hub.h1);
    await expect(page.locator('h1.page-title svg'), hub.key + ' title icon').toHaveCount(1);
    expect(await page.locator('.stat-card').count(), hub.key + ' stat cards').toBeGreaterThan(0);
  }
});

test('delisted hubs are gated, not broken', async ({ page }) => {
  await loginAs(page);
  for (const key of ['planning', 'safety', 'people', 'assets']) {
    const res = await page.goto('/departments/' + key);
    // 403 (gated) or a controlled redirect — never a 500 and never the hub.
    expect(res?.status(), key).toBeLessThan(500);
    if (res && res.status() === 200) {
      await expect(page.locator('h1'), key + ' must not render its hub').not.toContainText(/Home$/);
    }
  }
});

test('unknown hub 404s', async ({ page }) => {
  await loginAs(page);
  const res = await page.goto('/departments/nope');
  expect(res?.status()).toBe(404);
});
