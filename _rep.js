const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1400, height: 1100 } });
  await p.goto('http://localhost:3123/login');
  await p.fill('input[name="username"]', 'admin');
  await p.fill('input[name="password"]', 'preview123');
  await p.click('button[type="submit"]');
  await p.waitForLoadState('networkidle');
  await p.evaluate(() => localStorage.setItem('bk2-density','comfortable'));
  await p.goto('http://localhost:3123/bookings/board');
  await p.waitForLoadState('networkidle');
  await p.waitForTimeout(900);
  const card = p.locator('.bk2-card', { hasText: 'MEDLOW' }).first();
  await card.scrollIntoViewIfNeeded();
  console.log(JSON.stringify(await card.evaluate(el => ({
    unassignZone: el.querySelectorAll('.bk2-slot--drop-unassign').length,
    unassignedPool: el.querySelectorAll('.bk2-unassigned').length,
    filledSlots: el.querySelectorAll('.bk2-slot--filled').length,
  })), null, 1));
  // Open the popover for a seated worker and inspect the pool row.
  await card.locator('.bk2-slot--filled.bk2-slot--click', { hasText: 'Marcus Kelly' }).first().click();
  await p.waitForTimeout(500);
  const pop = p.locator('.bk2-pop');
  console.log('popover:', await pop.count());
  console.log('moves:', await pop.locator('.bk2-pop-move').allTextContents());
  console.log('pool row disabled?', await pop.locator('.bk2-pop-move--pool').first().evaluate(el => ({ disabled: el.disabled, cls: el.className })).catch(() => 'no pool row'));
  // Try clicking the pool row.
  const pool = pop.locator('.bk2-pop-move--pool:not(.is-here)');
  if (await pool.count()) {
    await pool.first().click();
    await p.waitForTimeout(1500);
    console.log('after click: marcus veh =', 'checked in db next');
  } else {
    console.log('POOL ROW NOT CLICKABLE/PRESENT');
  }
  await b.close();
})();
