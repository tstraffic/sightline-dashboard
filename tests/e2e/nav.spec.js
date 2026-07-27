// Phase 4 — the registry-driven sidebar (lib/sidebarNav.js).
//
// Guards:
//  - Nine sections; the seven department-hub "Home" list items became the
//    section headers themselves (still a.sidebar-link so the customiser's
//    pathname-keyed layouts keep them reachable).
//  - Messages moved out of the sidebar to a header icon whose badge carries
//    .chat-unread-badge (chat.js's live-update contract).
//  - Nothing lost: every pre-regroup destination still renders for a role
//    that could reach it before (spot checks + the admin anchor total).
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

test('sidebar is nine sections with hub-link headers and sub-labels', async ({ page }) => {
  await loginAs(page);
  const sb = page.locator('#sidebar');

  const sections = sb.locator('.sidebar-section:not([data-sb-sub])');
  await expect(sections).toHaveCount(9);

  // Section headers ARE the hub links, one per department.
  for (const dept of ['operations', 'planning', 'safety', 'people', 'finance', 'assets', 'reports']) {
    await expect(sb.locator(`.sidebar-section a.sb-section-head[href="/departments/${dept}"]`)).toHaveCount(1);
  }

  // Safety's two-tier grouping.
  await expect(sb.locator('[data-sb-sub]')).toHaveCount(2);
  await expect(sb).toContainText('Library');
  await expect(sb).toContainText('Training');
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

test('nothing lost: destinations survive the regroup', async ({ page }) => {
  await loginAs(page);
  const sb = (href) => page.locator(`#sidebar a[href="${href}"]`);

  // Moved links render exactly once in their new sections.
  for (const href of ['/projects', '/rate-cards', '/contacts', '/fleet', '/equipment',
    '/finance/invoicing', '/traffio-imports', '/kudos-admin/feed', '/documents', '/marketing']) {
    await expect(sb(href)).toHaveCount(1);
  }
  // Admin has `reports`, so the per-domain report fallbacks stay collapsed.
  await expect(sb('/safety-reports')).toHaveCount(0);
  await expect(sb('/hr/reports')).toHaveCount(0);

  // Full admin anchor count: 3 top + 55 visible links + 7 hub headers.
  await expect(page.locator('#sidebar a.sidebar-link')).toHaveCount(65);
});

test('hub headers carry the active state on their hub pages', async ({ page }) => {
  await loginAs(page);
  await page.goto('/departments/finance');
  const head = page.locator('#sidebar a.sb-section-head[href="/departments/finance"]');
  await expect(head).toHaveClass(/bg-white\/15/);
});

test('ops role keeps its tools and reaches its hub', async ({ page }) => {
  await loginAs(page, 'ops_user', 'password');
  const sb = (href) => page.locator(`#sidebar a[href="${href}"]`);
  await expect(sb('/traffio-imports')).toHaveCount(1);
  await expect(sb('/bookings')).toHaveCount(1);
  // No admin section for ops.
  await expect(sb('/admin/users')).toHaveCount(0);
  await page.goto('/departments/operations');
  await expect(page.locator('body')).not.toContainText('Server error');
});
