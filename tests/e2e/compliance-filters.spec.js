// Plans & Approvals time filters (Weekly / Monthly / From–To).
//
// Regression guard: these filters used to query due_date, which the current
// plan-creation flow never sets — so every modern plan was filtered out and
// the list came back empty. They now filter on the plan date
// (client_request_date → due_date → created_at), the same date the page
// groups by.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');
const Database = require('better-sqlite3');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', '..', 'data', 'test-e2e.db');

// A plan whose ONLY date is client_request_date — exactly the shape the
// filters used to miss.
function seedPlan(tag) {
  const db = new Database(TEST_DB);
  try {
    const r = db.prepare(`
      INSERT INTO compliance (parent_id, plan_number, item_type, title, status, client_request_date, due_date)
      VALUES (NULL, ?, 'other', ?, 'not_started', '2026-05-14', NULL)
    `).run(`FILTER-${tag}`, `Filter probe ${tag}`);
    return r.lastInsertRowid;
  } finally { db.close(); }
}

test.describe.configure({ mode: 'serial' });

test('monthly / weekly / date-range filters match a plan by its request date', async ({ page }, testInfo) => {
  seedPlan(testInfo.project.name);
  await loginAs(page);

  // Rows are <tr> with an onclick, so match on the plan's unique title.
  const row = page.locator(`tr:has-text("Filter probe ${testInfo.project.name}")`);

  // Unfiltered — the plan is on the page.
  await page.goto('/compliance?view=all');
  await expect(row).toHaveCount(1);

  // Monthly: May 2026 hits, September 2026 doesn't.
  await page.goto('/compliance?view=month&ref=2026-05');
  await expect(page.locator('body')).toContainText('May 2026');
  await expect(row).toHaveCount(1);
  await page.goto('/compliance?view=month&ref=2026-09');
  await expect(row).toHaveCount(0);

  // Weekly: the week containing Thu 14 May 2026 (Mon 11 – Sun 17).
  await page.goto('/compliance?view=week&ref=2026-05-11');
  await expect(row).toHaveCount(1);
  await page.goto('/compliance?view=week&ref=2026-05-18');
  await expect(row).toHaveCount(0);

  // Explicit From–To range.
  await page.goto('/compliance?date_from=2026-05-01&date_to=2026-05-31');
  await expect(row).toHaveCount(1);
  await page.goto('/compliance?date_from=2026-06-01&date_to=2026-06-30');
  await expect(row).toHaveCount(0);
});
