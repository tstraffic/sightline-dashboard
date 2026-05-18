// VOC e2e — Phase 1 happy paths.
//
// Covers:
//  1. Migration ran — /voc-assessments lists empty + 6 seeded templates exist.
//  2. Admin edits a template, adds theory + practical, values rehydrate.
//  3. Trainer creates a VOC, fills all-correct + all-C, submits → COMPETENT,
//     valid_until populated from template default (24 months from valid_from).
//  4. NYC path — one practical NYC + outcome=NYC → submit blocked until
//     manager fields filled.
//  5. Permission gating — planning_user sees 403 on /voc-assessments and
//     /voc-templates.

const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');
const Database = require('better-sqlite3');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', '..', 'data', 'test-e2e.db');

function getDb() {
  return new Database(TEST_DB);
}

// Seed a crew_member so we have someone to assess. Idempotent.
function ensureTestCrew() {
  const db = getDb();
  try {
    const existing = db.prepare("SELECT id FROM crew_members WHERE employee_id = 'VOC-TEST-01'").get();
    if (existing) { db.close(); return existing.id; }
    const r = db.prepare(`
      INSERT INTO crew_members (full_name, employee_id, active)
      VALUES (?, ?, 1)
    `).run('VOC Test Worker', 'VOC-TEST-01');
    db.close();
    return r.lastInsertRowid;
  } catch (e) {
    db.close();
    throw e;
  }
}

test.describe.configure({ mode: 'serial' });

test('migration seeded six VOC templates', async ({ page }) => {
  await loginAs(page);
  const res = await page.goto('/voc-templates');
  expect(res?.status()).toBeLessThan(400);
  // Six equipment items present.
  for (const name of [
    'Traffic Control Vehicle Operations',
    'Drop Deck Vehicle Operations',
    'Hitching and Unhitching a Trailer',
    'Portable Boom Gate Operations',
    'Light Tower Operations',
    'Portable Variable Message Sign (VMS) Operations',
  ]) {
    await expect(page.locator('td', { hasText: name }).first()).toBeVisible();
  }
});

test('admin edits a template — theory + practical rehydrate', async ({ page }) => {
  await loginAs(page);
  await page.goto('/voc-templates');
  // Click edit on "Light Tower Operations"
  const row = page.locator('tr', { hasText: 'Light Tower Operations' });
  await row.locator('a', { hasText: 'Edit' }).click();

  await expect(page).toHaveURL(/\/voc-templates\/\d+\/edit/);

  // Fill 3 theory questions — first row exists, add two more.
  const theoryTextareas = page.locator('#theoryList textarea[name="theory_q"]');
  await theoryTextareas.nth(0).fill('Q1: What is the maximum wind speed for safe operation?');
  await page.click('#theoryAdd');
  await page.click('#theoryAdd');
  await theoryTextareas.nth(1).fill('Q2: List the pre-start checks.');
  await theoryTextareas.nth(2).fill('Q3: What is the emergency stop procedure?');

  // Fill section heading + 2 items in the practical block.
  const sectionInput = page.locator('input[name="prac_section"]').first();
  await sectionInput.fill('A. Pre-Operational Checks');
  const itemInputs = page.locator('[data-practical-section]:first-of-type textarea[data-prac-item-text]');
  await itemInputs.nth(0).fill('Conducts visual inspection per checklist');
  await page.locator('[data-practical-section]:first-of-type [data-practical-item-add]').click();
  await itemInputs.nth(1).fill('Confirms isolation procedure');

  // Save
  await page.click('button[type="submit"]:has-text("Save Template")');

  // Reload and confirm values rehydrate.
  await expect(page.locator('text=Saved.')).toBeVisible();
  await page.reload();
  await expect(theoryTextareas.nth(0)).toHaveValue('Q1: What is the maximum wind speed for safe operation?');
  await expect(theoryTextareas.nth(2)).toHaveValue('Q3: What is the emergency stop procedure?');
  await expect(sectionInput).toHaveValue('A. Pre-Operational Checks');
});

test('competent path — submit fills outcome + valid_until', async ({ page }) => {
  ensureTestCrew();
  await loginAs(page);

  // Start new VOC
  await page.goto('/voc-assessments/new');
  await page.selectOption('select[name="crew_member_id"]', { label: 'VOC Test Worker (VOC-TEST-01)' });
  await page.selectOption('select[name="template_id"]', { label: /Light Tower Operations/ });
  await page.click('button[type="submit"]:has-text("Create Draft")');

  // Land on edit page with VOC number
  await expect(page).toHaveURL(/\/voc-assessments\/\d+\/edit/);
  await expect(page.locator('text=/VOC-\\d{4}-\\d{4}/')).toBeVisible();

  // Theory: mark all 3 questions correct
  const theoryYes = page.locator('[data-theory-row] [data-theory-correct][value="yes"]');
  const theoryCount = await theoryYes.count();
  for (let i = 0; i < theoryCount; i++) {
    await theoryYes.nth(i).check();
  }

  // Practical: mark all rows C
  const pracC = page.locator('[data-prac-row] [data-prac-result][value="C"]');
  const pracCount = await pracC.count();
  for (let i = 0; i < pracCount; i++) {
    await pracC.nth(i).check();
  }

  // Outcome
  await page.locator('input[name="outcome_select"][value="competent"]').check();

  // Sign-offs
  await page.fill('input[name="worker_signed_name"]', 'VOC Test Worker');
  await page.fill('input[name="assessor_signed_name"]', 'Admin User');
  const todayIso = new Date().toISOString().slice(0, 10);
  await page.fill('input[name="assessor_signed_date"]', todayIso);

  await page.click('#submitBtn');

  // Confirm we're back on the edit page with Competent outcome
  await expect(page).toHaveURL(/\/voc-assessments\/\d+\/edit/);
  await expect(page.locator('text=COMPETENT').first()).toBeVisible();

  // Verify valid_until in DB is 24 months from valid_from
  const db = getDb();
  const row = db.prepare(`
    SELECT outcome, valid_from, valid_until, status FROM voc_assessments
    ORDER BY id DESC LIMIT 1
  `).get();
  db.close();
  expect(row.status).toBe('submitted');
  expect(row.outcome).toBe('competent');
  expect(row.valid_until).toBeTruthy();
  // Roughly 24 months ahead (allow leap-year wobble; just assert > 700 days)
  const days = (new Date(row.valid_until) - new Date(row.valid_from)) / (24 * 60 * 60 * 1000);
  expect(days).toBeGreaterThan(700);
  expect(days).toBeLessThan(740);
});

test('NYC path — manager block enforced server-side', async ({ page }) => {
  ensureTestCrew();
  await loginAs(page);

  await page.goto('/voc-assessments/new');
  await page.selectOption('select[name="crew_member_id"]', { label: 'VOC Test Worker (VOC-TEST-01)' });
  await page.selectOption('select[name="template_id"]', { label: /Light Tower Operations/ });
  await page.click('button[type="submit"]:has-text("Create Draft")');

  // Mark theory all correct but practical: at least one NYC
  const theoryYes = page.locator('[data-theory-row] [data-theory-correct][value="yes"]');
  for (let i = 0; i < (await theoryYes.count()); i++) await theoryYes.nth(i).check();
  const pracNYC = page.locator('[data-prac-row] [data-prac-result][value="NYC"]').first();
  await pracNYC.check();
  // Pick C for remaining rows
  const pracC = page.locator('[data-prac-row] [data-prac-result][value="C"]');
  const pracCount = await pracC.count();
  for (let i = 1; i < pracCount; i++) await pracC.nth(i).check();

  await page.locator('input[name="outcome_select"][value="nyc"]').check();
  await page.fill('input[name="assessor_signed_name"]', 'Admin User');

  // Submit without manager — should bounce with flash error.
  await page.click('#submitBtn');
  // Flash text is on the redirect target. Look for the error.
  await expect(page.locator('text=Manager / Supervisor sign-off')).toBeVisible();

  // Fill manager + retry
  await page.fill('input[name="manager_signed_name"]', 'Test Manager');
  await page.fill('input[name="manager_signed_date"]', new Date().toISOString().slice(0, 10));
  await page.click('#submitBtn');

  await expect(page.locator('text=NOT YET COMPETENT').first()).toBeVisible();
});

test('permission gating — planning role gets 403', async ({ page }) => {
  await loginAs(page, 'planning_user', 'password');
  const res1 = await page.goto('/voc-assessments');
  expect(res1?.status()).toBe(403);
  const res2 = await page.goto('/voc-templates');
  expect(res2?.status()).toBe(403);
});
