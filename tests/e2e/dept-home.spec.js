// Department home pages — hero cards, stat strips, the needs-attention
// panel and the icon module grid (sidebar registry links + per-dept extras).
//
// Previously the hubs were thin: iconless quick-link pills from a hand-kept
// copy of the nav registry, no attention panel, and reports rendered as a
// bare link grid with no stats. Deliberately NOT serial — every test stands
// alone (the only write, the seeded overdue plan, is namespaced 'DHOME' and
// re-seeded idempotently).
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

const HUBS = [
  { key: 'planning', h1: 'Planning Home' },
  { key: 'safety', h1: 'Safety Home' },
  { key: 'operations', h1: 'Operations Home' },
  { key: 'finance', h1: 'Finance Home' },
  { key: 'people', h1: 'People / HR Home' },
  { key: 'assets', h1: 'Assets Home' },
  { key: 'reports', h1: 'Reports Home' },
];

test('all seven hubs render a header, title icon and at least one stat tile', async ({ page }) => {
  await loginAs(page);
  for (const hub of HUBS) {
    await page.goto('/departments/' + hub.key);
    await expect(page.locator('h1'), hub.key).toContainText(hub.h1);
    // Every department carries its own icon in the page title.
    await expect(page.locator('h1.page-title svg'), hub.key + ' title icon').toHaveCount(1);
    expect(await page.locator('.stat-card').count(), hub.key + ' stat cards').toBeGreaterThan(0);
  }
});

test('the title icon is centred on the heading text, not baseline-nudged', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/planning');
  const delta = await page.evaluate(() => {
    const h1 = document.querySelector('h1.page-title');
    const tile = h1.querySelector('.page-title-icon').getBoundingClientRect();
    const text = h1.querySelector('span:not(.page-title-icon)').getBoundingClientRect();
    return Math.abs((tile.top + tile.height / 2) - (text.top + text.height / 2));
  });
  expect(delta).toBeLessThanOrEqual(1.5);
});

test('sidebar section headers carry their icon, aligned with their links', async ({ page }, testInfo) => {
  // The rail is off-canvas on mobile, so its geometry isn't measurable there.
  test.skip(testInfo.project.name.includes('mobile'), 'sidebar rail is desktop-only');
  await loginAs(page);
  await page.goto('/departments/planning');

  // Section headers that link to a hub each render one icon…
  const heads = page.locator('a.sb-section-head');
  expect(await heads.count()).toBeGreaterThan(0);
  for (let i = 0; i < await heads.count(); i++) {
    await expect(heads.nth(i).locator('svg').first()).toBeVisible();
  }
  // …in the same left slot as the child links' icons, so the rail lines up.
  const lefts = await page.evaluate(() => {
    const l = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect().left : null; };
    return {
      head: l('a.sb-section-head svg'),
      child: l('a.sidebar-link:not(.sb-section-head) svg'),
    };
  });
  expect(Math.abs(lefts.head - lefts.child)).toBeLessThanOrEqual(1);
});

test('planning module grid: sidebar icons, Jobs extra, hero deduped, no duplicates', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/planning');

  const grid = page.locator('[data-module-grid]');
  await expect(grid).toBeVisible();
  // Icons ride in from the sidebar registry — each card renders one <svg>.
  expect(await grid.locator('a > svg').count()).toBeGreaterThanOrEqual(3);
  await expect(grid).toContainText('Tenders');
  // Jobs is an extraLink — it lives in the operations sidebar section, not
  // planning's, so only moduleLinks' extras can put it here.
  await expect(grid).toContainText('Jobs');
  // The hero already owns /compliance; the grid must not repeat it…
  await expect(grid.locator('a[href="/compliance"]')).toHaveCount(0);
  // …and no destination appears twice.
  const hrefs = await grid.locator('a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(hrefs.length);
});

test('heroes point at the flagship pages', async ({ page }) => {
  await loginAs(page);
  const heroes = {
    planning: '/compliance',
    safety: '/safety-today',
    people: '/hr',
    operations: '/bookings', // NOT /bookings/board — that's a redirect alias
  };
  for (const [key, href] of Object.entries(heroes)) {
    await page.goto('/departments/' + key);
    await expect(page.locator(`a.bg-brand-50[href="${href}"]`), key + ' hero').toHaveCount(1);
  }
});

test('planning needs panel surfaces an overdue plan', async ({ page }) => {
  withDb(db => {
    db.prepare("DELETE FROM compliance WHERE title LIKE 'DHOME %'").run();
    db.prepare(`
      INSERT INTO compliance (parent_id, item_type, title, status, due_date)
      VALUES (NULL, 'other', 'DHOME overdue plan', 'started', '2020-01-01')
    `).run();
  });

  await loginAs(page);
  await page.goto('/departments/planning');

  const panel = page.locator('#dept-needs');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.panel-header-title')).toContainText('Needs attention');
  const row = panel.locator('a[data-attn="overdue_plans"]');
  await expect(row).toContainText('overdue plan');
  await expect(row).toHaveAttribute('href', '/compliance');

  withDb(db => db.prepare("DELETE FROM compliance WHERE title LIKE 'DHOME %'").run());
});

test('reports hub keeps its curated links and skips the needs panel', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/reports');

  const grid = page.locator('[data-module-grid]');
  await expect(grid).toContainText('Crew reports');
  await expect(grid).toContainText('Plan P&L');
  // Reports has no needsKeys — the panel must not render at all.
  await expect(page.locator('#dept-needs')).toHaveCount(0);
  // The reports sidebar section's negated-gate links (Safety/HR Reports for
  // users WITHOUT 'reports') must not leak in for an admin who has both.
  const hrefs = await grid.locator('a').evaluateAll(as => as.map(a => a.getAttribute('href')));
  expect(new Set(hrefs).size).toBe(hrefs.length);
});
