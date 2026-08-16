// Sightline trim — the registry-driven sidebar (lib/sidebarNav.js).
//
// Guards:
//  - Four sections (CRM, Delivery, Money, Admin) + four top links. The T&S
//    traffic-control sections (bookings/safety/people/assets…) are delisted,
//    not deleted — their routes still exist but must not render in the nav.
//  - No hub headers: Sightline has no department hubs in the nav.
//  - Messages stays in the header (chat.js live-badge contract).
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

test('sidebar is four Sightline sections with no hub headers', async ({ page }) => {
  await loginAs(page);
  const sb = page.locator('#sidebar');

  const sections = sb.locator('.sidebar-section:not([data-sb-sub])');
  await expect(sections).toHaveCount(4);

  // Hub links are delisted for Sightline.
  await expect(sb.locator('a.sb-section-head')).toHaveCount(0);

  // Section labels present.
  for (const label of ['CRM', 'Delivery', 'Money', 'Admin']) {
    await expect(sb.locator(`.sidebar-section[data-sb-name="${label}"]`)).toHaveCount(1);
  }
});

test('messages lives in the header, not the sidebar', async ({ page }) => {
  await loginAs(page);
  await expect(page.locator('#sidebar a[href="/chat"]')).toHaveCount(0);
  const headerChat = page.locator('#header-chat');
  await expect(headerChat).toBeVisible();
  expect(await headerChat.getAttribute('href')).toBe('/chat');
  // Fresh test DB has no unread messages — badge hidden.
  await expect(headerChat.locator('.chat-unread-badge')).toHaveClass(/hidden/);
});

test('Sightline destinations render; T&S modules are delisted', async ({ page }) => {
  await loginAs(page);
  // Scope to .sidebar-link — the sidebar logo is also an <a href="/dashboard">.
  const sb = (href) => page.locator(`#sidebar a.sidebar-link[href="${href}"]`);

  // CRM + Delivery + Money links render exactly once.
  for (const href of ['/clients', '/contacts', '/opportunities/pipeline', '/opportunities',
    '/crm', '/crm/activities', '/crm/meetings', '/projects', '/budgets']) {
    await expect(sb(href)).toHaveCount(1);
  }

  // Hidden T&S modules must NOT appear even for admin.
  for (const href of ['/bookings', '/traffio-imports', '/compliance', '/quotes', '/rate-cards',
    '/fleet', '/equipment', '/finance/invoicing', '/payroll/runs', '/timesheets',
    '/hr', '/crew', '/safety-today', '/incidents', '/tenders', '/marketing', '/reports']) {
    await expect(sb(href)).toHaveCount(0);
  }

  // Top links intact.
  for (const href of ['/dashboard', '/tasks', '/notes', '/meetings']) {
    await expect(sb(href)).toHaveCount(1);
  }
});

test('planning role sees the CRM section (crm permission widened)', async ({ page }) => {
  await loginAs(page, 'planning_user', 'password');
  const sb = (href) => page.locator(`#sidebar a.sidebar-link[href="${href}"]`);
  await expect(sb('/opportunities/pipeline')).toHaveCount(1);
  await expect(sb('/crm')).toHaveCount(1);
  // No admin section for planning.
  await expect(sb('/admin/users')).toHaveCount(0);
});
