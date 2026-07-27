// Department hubs — the write paths the smoke probe can't cover: create a
// meeting, save a notebook section, add/toggle a to-do, edit details,
// cancel, and the unknown-department 404.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

test('create a meeting from the operations hub', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/operations');
  await expect(page.locator('h1')).toContainText('Operations Home');

  // Open the add-meeting disclosure and create.
  await page.locator('#add-meeting summary').click();
  await page.fill('#add-meeting input[name="title"]', 'Weekly ops meeting');
  await page.fill('#add-meeting input[name="meeting_time"]', '09:00');
  await page.fill('#add-meeting input[name="attendees"]', 'Suhail, Saadat');
  await page.click('#add-meeting button[type="submit"]');

  await expect(page).toHaveURL(/\/departments\/operations\/meetings\/\d+/);
  await expect(page.locator('h1')).toContainText('Weekly ops meeting');
  await expect(page.locator('body')).toContainText('Suhail, Saadat');
});

test('discussion notes save and persist', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/operations');
  await page.locator('a:has-text("Weekly ops meeting")').first().click();
  await expect(page).toHaveURL(/\/meetings\/\d+/);

  await page.fill('#section-discussion textarea[name="content"]', 'Talked about crew rosters and the new booking board.');
  await page.click('#section-discussion button[type="submit"]');
  await expect(page).toHaveURL(/#section-discussion/);

  await page.reload();
  await expect(page.locator('#section-discussion textarea[name="content"]')).toHaveValue('Talked about crew rosters and the new booking board.');
});

test('high-priority todo: add, toggle, disappears from hub roll-up', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/operations');
  await page.locator('a:has-text("Weekly ops meeting")').first().click();

  // Add into the High column (its add form carries priority=high).
  const highForm = page.locator('#section-todos form:has(input[name="priority"][value="high"])');
  await highForm.locator('input[name="text"]').fill('Chase up ute rego');
  await highForm.locator('button[type="submit"]').click();
  await expect(page.locator('#section-todos')).toContainText('Chase up ute rego');

  // Shows on the hub roll-up while open.
  await page.goto('/departments/operations');
  await expect(page.locator('body')).toContainText('Chase up ute rego');

  // Toggle done from the hub; it leaves the open list.
  const row = page.locator('div.flex.items-start:has-text("Chase up ute rego")').first();
  await row.locator('button[title="Mark done"]').click();
  await expect(page).toHaveURL(/\/departments\/operations/);
  await expect(page.locator('body')).not.toContainText('Chase up ute rego');

  // On the meeting page it renders struck-through (done state). .first():
  // both browser projects run this serial file against the same DB, so a
  // second identical done todo exists on the second project's pass.
  await page.locator('a:has-text("Weekly ops meeting")').first().click();
  const done = page.locator('#section-todos p.line-through:has-text("Chase up ute rego")').first();
  await expect(done).toBeVisible();
});

test('edit details renames the meeting; cancel shows the banner', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/operations');
  await page.locator('a:has-text("Weekly ops meeting")').first().click();

  await page.locator('#edit summary').click();
  await page.fill('#edit input[name="title"]', 'Weekly ops meeting (renamed)');
  await page.click('#edit button[type="submit"]');
  await expect(page.locator('h1')).toContainText('Weekly ops meeting (renamed)');

  // Cancel via the footer action (first cancel form on the page).
  await page.locator('form[action$="/cancel"] button').first().click();
  await expect(page.locator('body')).toContainText('This meeting was cancelled.');
  // Restore so later runs/readers see a live meeting.
  await page.locator('form[action$="/cancel"] button').first().click();
  await expect(page.locator('body')).not.toContainText('This meeting was cancelled.');
});

test("last meeting's notes are readable from the new meeting", async ({ page }, testInfo) => {
  await loginAs(page);
  // Both browser projects run this file serially against the same DB, so the
  // meeting chain must be unique per project or one project's follow-up
  // chains onto the other's empty meeting.
  const tag = testInfo.project.name;
  const month = tag.includes('mobile') ? '2027-04' : '2027-03';

  // The department's earliest meeting has nothing before it.
  await page.goto('/departments/operations');
  await page.locator('a:has-text("Weekly ops meeting")').first().click();
  await expect(page.locator('#section-recap')).toContainText('No previous Operations meeting to look back on');
  await expect(page.locator('[data-last-meeting]')).toHaveCount(0);

  // A meeting with real notes + an open to-do…
  await page.goto('/departments/operations');
  await page.locator('#add-meeting summary').click();
  await page.fill('#add-meeting input[name="title"]', `Notes source ${tag}`);
  await page.fill('#add-meeting input[name="meeting_date"]', `${month}-01`);
  await page.click('#add-meeting button[type="submit"]');
  await page.fill('#section-discussion textarea[name="content"]', 'Agreed the Villawood detour needs a briefing.');
  await page.click('#section-discussion button[type="submit"]');
  const highForm = page.locator('#section-todos form:has(input[name="priority"][value="high"])');
  await highForm.locator('input[name="text"]').fill('Write the detour briefing');
  await highForm.locator('button[type="submit"]').click();

  // …then the next meeting, which should surface those notes inline.
  await page.goto('/departments/operations');
  await page.locator('#add-meeting summary').click();
  await page.fill('#add-meeting input[name="title"]', `Follow-up ${tag}`);
  await page.fill('#add-meeting input[name="meeting_date"]', `${month}-02`);
  await page.click('#add-meeting button[type="submit"]');
  await expect(page.locator('h1')).toContainText(`Follow-up ${tag}`);

  const panel = page.locator('[data-last-meeting]');
  await expect(panel).toContainText(`Notes source ${tag}`);
  await expect(panel).toContainText('Agreed the Villawood detour needs a briefing.');
  await expect(panel).toContainText('Write the detour briefing');
  await expect(panel).toContainText('still open');

  // Collapsible, and reachable from further down the page.
  await panel.locator('summary').click();
  await expect(panel).not.toHaveAttribute('open', /.*/);
  await panel.locator('summary').click();
  await expect(panel).toHaveAttribute('open', /.*/);
  await expect(page.locator('#lastMtgPeek')).toHaveCount(1);
});

test('unknown department 404s', async ({ page }) => {
  await loginAs(page);
  const res = await page.goto('/departments/nope');
  expect(res?.status()).toBe(404);
});
