// Phase 3 consolidation — nothing lost, everything reachable.
//
// Guards:
//  - /crm/accounts merged into /clients?view=crm (two list pages over the one
//    clients table). The old URL 302s WITH its query so saved filter links
//    keep working; the CRM view is permission-gated and falls back to the
//    plain directory for non-CRM users.
//  - Audits / Checklists / Reports each gained a shared tab strip so a single
//    sidebar entry reaches every register; the old URLs all still serve.
//  - The sidebar lost its duplicate and leaf links (second Jobs/Equipment/
//    Vehicles, Accounts, per-domain report pages for users with `reports`).
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

// The fresh test DB has no clients — the CRM view would render its empty
// state and hide the table whose columns these tests assert on. Idempotent:
// both browser projects run this file against one DB.
test.beforeAll(() => {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try {
    if (!db.prepare("SELECT id FROM clients WHERE company_name = 'E2E CRM Co'").get()) {
      db.prepare("INSERT INTO clients (company_name, company_type, active) VALUES ('E2E CRM Co', 'lead', 1)").run();
    }
  } finally { db.close(); }
});

test('old /crm/accounts URL redirects into /clients with filters intact', async ({ page }) => {
  await loginAs(page);
  await page.goto('/crm/accounts?type=lead&dormant=1');
  await expect(page).toHaveURL(/\/clients\?/);
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBe('crm');
  expect(url.searchParams.get('type')).toBe('lead');
  expect(url.searchParams.get('dormant')).toBe('1');
  await expect(page.locator('body')).not.toContainText('Server error');
});

test('admin gets both client views and the toggle', async ({ page }) => {
  await loginAs(page);

  // CRM view: account columns + the Directory | CRM toggle.
  await page.goto('/clients?view=crm');
  await expect(page.locator('nav[aria-label="Client views"]')).toBeVisible();
  await expect(page.locator('th', { hasText: 'Pipeline' })).toBeAttached();
  await expect(page.locator('th', { hasText: 'Open Opps' })).toBeAttached();

  // Directory unchanged, same toggle back.
  await page.locator('nav[aria-label="Client views"] a', { hasText: 'Directory' }).click();
  await expect(page).toHaveURL(/\/clients$/);
  await expect(page.locator('body')).toContainText('Company Directory');
  await expect(page.locator('th', { hasText: 'Pipeline' })).toHaveCount(0);
});

test('non-CRM user asking for the CRM view gets the directory', async ({ page }) => {
  // ops_user (role operations) has `clients` but not `crm`.
  await loginAs(page, 'ops_user', 'password');
  await page.goto('/clients?view=crm');
  await expect(page.locator('body')).toContainText('Company Directory');
  await expect(page.locator('th', { hasText: 'Pipeline' })).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Client views"]')).toHaveCount(0);
});

test('tab strips connect the consolidated registers', async ({ page }) => {
  await loginAs(page);

  // Job Pack strip: Forms → Templates.
  await page.goto('/safety-forms');
  await page.locator('a', { hasText: 'Templates' }).first().click();
  await expect(page).toHaveURL(/\/checklists$/);

  // Audits strip: Site → Vehicle.
  await page.goto('/audits');
  await page.locator('nav[aria-label="Audit registers"] a', { hasText: 'Vehicle Audits' }).click();
  await expect(page).toHaveURL(/\/vehicle-audits$/);

  // Reports switcher: Overview → Safety Reports.
  await page.goto('/reports');
  await page.locator('nav[aria-label="Report domains"] a', { hasText: 'Safety Reports' }).click();
  await expect(page).toHaveURL(/\/safety-reports$/);
});

test('sidebar carries single entries, no retired links', async ({ page }) => {
  await loginAs(page);
  const sb = (href) => page.locator(`#sidebar a[href="${href}"]`);
  await expect(sb('/audits')).toHaveCount(1);
  await expect(sb('/vehicle-audits')).toHaveCount(0);
  await expect(sb('/crm/accounts')).toHaveCount(0);
  // Admin has `reports`, so the per-domain report leaves collapse into the
  // switcher on /reports.
  await expect(sb('/safety-reports')).toHaveCount(0);
  await expect(sb('/hr/reports')).toHaveCount(0);
  await expect(sb('/crm/reports')).toHaveCount(0);
  await expect(sb('/reports')).toHaveCount(1);
  // Duplicate cleanup: one Jobs (Planning), one Equipment/Vehicles (Ops).
  await expect(sb('/projects')).toHaveCount(1);
  await expect(sb('/equipment')).toHaveCount(1);
  await expect(sb('/fleet')).toHaveCount(1);
});
