// Adding an employee (Roster → Add employee → POST /hr/employees).
//
// Regression guard: the INSERT listed 53 columns but only 52 values — the
// hardcoded 1 for `active` sat one slot early, on internal_notes — so the
// statement failed to prepare and every submit 500'd with
// "52 values for 53 columns". A statement that can't prepare fails on the
// first save, so simply completing this form is the test.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

test('creating an employee from the form saves and lands on their page', async ({ page }, testInfo) => {
  await loginAs(page);
  // Unique per browser project — both run against the same DB.
  const last = `Probe${testInfo.project.name.includes('mobile') ? 'M' : 'D'}`;

  await page.goto('/hr/employees/new');
  await page.fill('input[name="first_name"]', 'Filter');
  await page.fill('input[name="last_name"]', last);

  // Fill only the FIRST of the duplicated copies: the other submits empty, and
  // the route must keep the filled one (and must not pass the pair through as
  // an array, which expands into extra bind values and 500s the request).
  const notes = page.locator('textarea[name="internal_notes"]').first();
  if (await notes.count()) await notes.fill('Created by the e2e regression test.');

  // Six-step wizard — the submit button only appears on the last panel.
  const submit = page.locator('button[type="submit"]:has-text("Add Employee")');
  const next = page.locator('#wizard-next');
  for (let i = 0; i < 8; i++) {
    if (await submit.isVisible()) break;
    if (!(await next.isVisible())) break; // Next hides on the final panel
    await next.click();
  }
  await expect(submit).toBeVisible();
  await submit.click();

  // A 500 would leave us on an error page; success redirects to the record.
  await expect(page).toHaveURL(/\/hr\/employees\/\d+/);
  await expect(page.locator('body')).toContainText(`Filter ${last}`);
  await expect(page.locator('body')).not.toContainText('Server error');
});
