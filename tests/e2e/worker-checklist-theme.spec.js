// Worker portal checklists must be readable in LIGHT mode.
//
// views/worker/forms/vehicle-prestart.ejs shipped with no light-mode block
// at all, so every .vps-* rule applied in both themes: white question text
// on a white card, a white input with a white border, white pill labels.
// On a phone in daylight the Vehicle Pre-Start was blank apart from its
// pre-filled vehicle id — what the crew reported.
//
// It is not enough to add `:root[data-theme="light"] .vps-q-text`: the
// safety net in worker.css matches on class SUFFIX
// (`[class$="-title"]`, `[class$="-row"]`, `[class$="-card"]`…) at (0,4,1)
// and beats a (0,3,0) per-view rule. Three overrides in
// forms-custom-fill.ejs were dead that way. These tests assert the
// RENDERED colour, so a rule that loses the specificity fight fails here
// instead of shipping invisible.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const { TEST_DB } = require('./helpers/setup');
const { sydneyToday } = require('../../lib/sydney');

test.describe.configure({ mode: 'serial' });

const WORKER_ID = 'EMP-TEST';
const WORKER_PIN = '1234';

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

// The checklist routes refuse to render without a crew_allocations row
// ("Open this checklist from the shift it belongs to").
function seedAllocation() {
  return withDb(db => {
    const today = sydneyToday();
    const worker = db.prepare('SELECT id FROM crew_members WHERE employee_id = ?').get(WORKER_ID);
    if (!worker) return null;
    let alloc = db.prepare("SELECT id FROM crew_allocations WHERE crew_member_id = ? AND role_on_site = 'theme-test'").get(worker.id);
    if (!alloc) {
      db.prepare(`
        INSERT INTO crew_allocations (job_id, crew_member_id, allocation_date, start_time, end_time, role_on_site, status)
        VALUES (NULL, ?, ?, '07:00', '15:00', 'theme-test', 'allocated')
      `).run(worker.id, today);
      alloc = { id: db.prepare('SELECT last_insert_rowid() AS id').get().id };
    }
    const tpl = db.prepare("SELECT id FROM checklist_templates WHERE worker_visible = 1 AND system_key NOT IN ('vehicle_prestart') ORDER BY id LIMIT 1").get();
    return { allocationId: alloc.id, customTemplateId: tpl && tpl.id };
  });
}

// Relative luminance + WCAG contrast, so assertions are about legibility
// rather than exact hex values a designer may retune.
const CONTRAST = `(fg, bg) => {
  const parse = (s) => {
    const m = String(s).match(/rgba?\\(([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:[,\\s/]+([\\d.]+))?/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const a = parse(fg), b = parse(bg);
  if (!a || !b) return 0;
  const flat = a.a < 1
    ? { r: a.r * a.a + b.r * (1 - a.a), g: a.g * a.a + b.g * (1 - a.a), b: a.b * a.a + b.b * (1 - a.a) }
    : a;
  const L1 = lum(flat), L2 = lum(b);
  return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
}`;

async function openLight(page, path) {
  await page.addInitScript(() => {
    // The worker layout's head script maps theme ids to a mode; 'daylight'
    // is a light id. A stored value beats prefers-color-scheme.
    try { localStorage.setItem('atomis-theme', 'daylight'); } catch (e) {}
  });
  await page.goto('/w/login');
  await page.fill('input[name="employee_id"]', WORKER_ID);
  await page.fill('input[name="pin"]', WORKER_PIN);
  await page.click('form button[type="submit"]');
  await expect(page).toHaveURL(/\/w\//);
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
}

// Contrast of an element's text against the nearest opaque ancestor
// background, measured in the page.
async function contrastOf(page, selector) {
  return page.evaluate(({ sel, fnSrc }) => {
    const contrast = eval(fnSrc);
    const el = document.querySelector(sel);
    if (!el) return { missing: true };
    const bgOf = (node) => {
      let cur = node;
      while (cur) {
        const c = getComputedStyle(cur).backgroundColor;
        const m = String(c).match(/rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/);
        if (m && (m[4] === undefined || +m[4] >= 0.999)) return c;
        cur = cur.parentElement;
      }
      return 'rgb(255,255,255)';
    };
    const cs = getComputedStyle(el);
    return { ratio: contrast(cs.color, bgOf(el)), color: cs.color };
  }, { sel: selector, fnSrc: CONTRAST });
}

test('Vehicle Pre-Start is legible in light mode', async ({ page }) => {
  const seed = seedAllocation();
  test.skip(!seed, 'EMP-TEST worker not seeded in this DB');
  await openLight(page, `/w/forms/vehicle-prestart?allocationId=${seed.allocationId}`);

  // The form actually rendered (not the "open it from the shift" bounce).
  await expect(page.locator('.vps-card').first()).toBeVisible();

  // Question labels and the 22 inspection rows — both were plain #fff.
  for (const sel of ['.vps-q-text', '.vps-inline-row-q']) {
    const r = await contrastOf(page, sel);
    expect(r.missing, `${sel} should exist`).toBeFalsy();
    expect(r.ratio, `${sel} contrast (was white-on-white)`).toBeGreaterThan(4.5);
  }

  // Answer pills: unchecked labels were rgba(255,255,255,0.65).
  const pill = await contrastOf(page, '.vps-radio span');
  expect(pill.ratio, 'answer pill contrast').toBeGreaterThan(4);

  // The vehicle field had a white border on a white card — no visible box.
  const border = await page.locator('.vps-input').first().evaluate(el => getComputedStyle(el).borderTopColor);
  expect(border).not.toBe('rgb(255, 255, 255)');
  const borderContrast = await page.evaluate(({ fnSrc }) => {
    const contrast = eval(fnSrc);
    const el = document.querySelector('.vps-input');
    return contrast(getComputedStyle(el).borderTopColor, 'rgb(255,255,255)');
  }, { fnSrc: CONTRAST });
  expect(borderContrast, 'input border must be visible on a white card').toBeGreaterThan(1.2);

  // Section eyebrows keep the brand emerald rather than being flattened to
  // near-black by the [class$="-title"] safety net.
  const title = await page.locator('.vps-section-title').first().evaluate(el => getComputedStyle(el).color);
  expect(title).not.toBe('rgb(15, 17, 21)');

  // .vps-q-row / .vps-inline-row end in "-row", which the net paints as a
  // white CARD — a bordered, shadowed box around every single answer.
  const rowBg = await page.locator('.vps-q-row').first().evaluate(el => getComputedStyle(el).backgroundColor);
  expect(rowBg, 'answer rows must not be turned into cards').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});

test('the custom-checklist filler is legible in light mode', async ({ page }) => {
  const seed = seedAllocation();
  test.skip(!seed || !seed.customTemplateId, 'no worker-visible custom template');
  await openLight(page, `/w/forms/custom/${seed.customTemplateId}?allocationId=${seed.allocationId}`);
  await expect(page.locator('.cf-card').first()).toBeVisible();

  const q = await contrastOf(page, '.cf-q-text');
  expect(q.ratio, 'question text contrast').toBeGreaterThan(4.5);

  // These two overrides existed but were DEAD — outgunned by the suffix net.
  const title = await page.locator('.cf-section-title').first().evaluate(el => getComputedStyle(el).color);
  expect(title, 'section title should stay brand emerald').not.toBe('rgb(15, 17, 21)');
  const shadow = await page.locator('.cf-card').first().evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow, 'card should keep its light-mode shadow').not.toBe('none');

  const rowBg = await page.locator('.cf-q-row').first().evaluate(el => getComputedStyle(el).backgroundColor);
  expect(rowBg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});

test('a selected answer keeps its white label', async ({ page }) => {
  const seed = seedAllocation();
  test.skip(!seed, 'EMP-TEST worker not seeded in this DB');
  await openLight(page, `/w/forms/team-leader?allocationId=${seed.allocationId}`);

  // worker.css declares .text-gray-600 !important to survive the dark
  // remap, which beat Tailwind's peer-checked:text-white — so a CHECKED
  // chip kept grey text on its emerald fill (measured 2.01:1).
  const chip = page.locator('label:has(input.peer[value="yes"]) span').first();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect.poll(async () =>
    chip.evaluate(el => getComputedStyle(el).color), { timeout: 3000 }
  ).toBe('rgb(255, 255, 255)');
});
