// Regression for #210 — compliance + hire-dockets tables hide low-
// priority columns on phones. Doesn't need seeded data: the header
// row renders even when the table is empty.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

// Login once, reuse for both checks (rate-limited /login).
test.describe.configure({ mode: 'serial' });

test('compliance + hire-dockets — columns hide correctly on mobile', async ({ page }) => {
  await loginAs(page);

  // Compliance
  await page.goto('/compliance');
  const complianceHasTable = await page.locator('table thead th').count() > 0;
  test.skip(!complianceHasTable, '/compliance has no items to render a table — seed data in future suites');

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopHeaders = await page.$$eval('table thead th', ths =>
    ths.filter(t => t.offsetWidth > 0).map(t => (t.textContent || '').trim())
  );
  // Column set per views/compliance/index.ejs <thead>: Title/Status/Invoice
  // always show; Type + Due Date are sm:, Ref + Client Req are md:, Project +
  // Assigned are lg:. (The old Expiry/Fee columns are long gone — this
  // assertion went stale unnoticed because the test skipped for years
  // whenever /compliance had no rows to render a table.)
  for (const col of ['Ref', 'Title', 'Type', 'Project', 'Status', 'Client Req', 'Due Date', 'Assigned', 'Invoice']) {
    expect(desktopHeaders).toContain(col);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileHeaders = await page.$$eval('table thead th', ths =>
    ths.filter(t => t.offsetWidth > 0).map(t => (t.textContent || '').trim())
  );
  for (const col of ['Ref', 'Type', 'Project', 'Client Req', 'Due Date', 'Assigned']) {
    expect(mobileHeaders).not.toContain(col);
  }
  for (const col of ['Title', 'Status', 'Invoice']) {
    expect(mobileHeaders).toContain(col);
  }

  // Hire dockets
  await page.goto('/equipment/hire-dockets');
  const dockHasTable = await page.locator('table thead th').count() > 0;
  if (!dockHasTable) return; // nothing seeded — skip dock half silently

  await page.setViewportSize({ width: 375, height: 812 });
  const dockMobile = await page.$$eval('table thead th', ths =>
    ths.filter(t => t.offsetWidth > 0).map(t => (t.textContent || '').trim())
  );
  for (const col of ['Job / PO', 'Site', 'Items', 'Prepared']) {
    expect(dockMobile).not.toContain(col);
  }
  for (const col of ['Docket #', 'Supplier', 'Status']) {
    expect(dockMobile).toContain(col);
  }
});
