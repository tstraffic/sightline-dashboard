// VOC Phase 2 e2e — cert ID + PDF + public verify + revoke.
// Builds on the Phase 1 spec: seeds a worker, populates Light Tower
// template, drives the full Competent flow, then exercises the cert
// download, the public verify page, and admin revoke/unrevoke.

const { test, expect, request } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');
const Database = require('better-sqlite3');
const path = require('path');

const TEST_DB = path.join(__dirname, '..', '..', 'data', 'test-e2e.db');
function getDb() { return new Database(TEST_DB); }

function ensureSeed() {
  const db = getDb();
  try {
    let crew = db.prepare("SELECT id FROM crew_members WHERE employee_id = 'VOC-P2-01'").get();
    if (!crew) {
      const r = db.prepare("INSERT INTO crew_members (full_name, employee_id, active) VALUES (?, ?, 1)").run('VOC P2 Worker', 'VOC-P2-01');
      crew = { id: r.lastInsertRowid };
    }
    // Populate Light Tower template with 2 theory + 2 practical so flow is fast.
    const tpl = db.prepare("SELECT id FROM voc_templates WHERE item_key = 'light_tower'").get();
    db.prepare("UPDATE voc_templates SET theory_questions_json = ?, practical_checklist_json = ? WHERE id = ?")
      .run(JSON.stringify(['Q1?', 'Q2?']),
           JSON.stringify([{ section: 'A. Pre-Op', items: ['Visual inspection', 'Confirm isolation'] }]),
           tpl.id);
    return { crewId: crew.id, templateId: tpl.id };
  } finally {
    db.close();
  }
}

test.describe.configure({ mode: 'serial' });

test('competent submit → cert_id + pdf_path persisted', async ({ page }) => {
  const { crewId, templateId } = ensureSeed();
  await loginAs(page);
  await page.goto('/voc-assessments/new');
  await page.selectOption('select[name="crew_member_id"]', String(crewId));
  await page.selectOption('select[name="template_id"]', String(templateId));
  await page.click('button[type="submit"]:has-text("Create Draft")');
  await expect(page).toHaveURL(/\/voc-assessments\/\d+\/edit/);

  // toHaveURL resolves on navigation commit — the document can still be
  // mid-parse. locator.count() does NOT wait, so an unguarded
  // `for (i < count)` loop silently checks zero radios. Wait for the rows.
  await page.locator('[data-theory-row]').first().waitFor();
  await page.locator('[data-prac-row]').first().waitFor();

  // All theory correct, all practical C
  const yes = page.locator('[data-theory-row] [data-theory-correct][value="yes"]');
  for (let i = 0; i < (await yes.count()); i++) await yes.nth(i).check();
  const c = page.locator('[data-prac-row] [data-prac-result][value="C"]');
  for (let i = 0; i < (await c.count()); i++) await c.nth(i).check();
  await page.locator('input[name="outcome_select"][value="competent"]').check();
  await page.fill('input[name="assessor_signed_name"]', 'Admin User');
  const today = new Date().toISOString().slice(0, 10);
  await page.fill('input[name="assessor_signed_date"]', today);
  // Wait for the POST itself, not just page text: 'text=COMPETENT' matches
  // the outcome radio label already on the page (case-insensitive), so a
  // text-only wait passes while the submit is still in flight and the DB
  // assertions below race the server's cert write.
  await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && /\/voc-assessments\/\d+\/submit/.test(r.url())),
    page.click('#submitBtn'),
  ]);
  await page.waitForLoadState();
  await expect(page.locator('text=COMPETENT').first()).toBeVisible();

  const db = getDb();
  const row = db.prepare("SELECT certificate_id, certificate_status, pdf_path FROM voc_assessments ORDER BY id DESC LIMIT 1").get();
  db.close();
  expect(row.certificate_id).toMatch(/^TSC-\d{4}-[A-F0-9]{6}-\d{4}$/);
  expect(row.certificate_status).toBe('active');
  expect(row.pdf_path).toMatch(/^voc-certificates\/voc-\d+-\d+\.pdf$/);
});

test('PDF download streams application/pdf', async ({ page }) => {
  await loginAs(page);
  const db = getDb();
  const row = db.prepare("SELECT id FROM voc_assessments WHERE certificate_id IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  db.close();
  const res = await page.request.get(`/voc-assessments/${row.id}/pdf`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/application\/pdf/);
  const body = await res.body();
  expect(body.length).toBeGreaterThan(2000);
  // Minimal PDF sanity — header magic bytes.
  expect(body.slice(0, 4).toString()).toBe('%PDF');
});

test('public /voc/verify/:certId renders Valid for an active cert (no auth)', async () => {
  const db = getDb();
  const row = db.prepare("SELECT certificate_id FROM voc_assessments WHERE certificate_id IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  db.close();
  // Use a fresh request context to ensure no auth cookies.
  const api = await request.newContext();
  const res = await api.get(`/voc/verify/${encodeURIComponent(row.certificate_id)}`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('VALID');
  expect(body).toContain(row.certificate_id);
  await api.dispose();
});

test('public /voc/verify/:certId for unknown ID renders Not Found', async () => {
  const api = await request.newContext();
  const res = await api.get('/voc/verify/TSC-9999-ZZZZZZ-9999');
  expect(res.status()).toBe(404);
  const body = await res.text();
  expect(body).toContain('NOT FOUND');
  await api.dispose();
});

test('admin revoke → verify page shows REVOKED with reason', async ({ page }) => {
  await loginAs(page);
  const db = getDb();
  const row = db.prepare("SELECT id, certificate_id FROM voc_assessments WHERE certificate_id IS NOT NULL ORDER BY id DESC LIMIT 1").get();
  db.close();

  await page.goto(`/voc-assessments/${row.id}/edit`);
  await page.click('summary:has-text("Revoke certificate")');
  await page.fill('textarea[name="reason"]', 'Test revocation — equipment substantively changed.');
  page.on('dialog', d => d.accept());
  await page.click('button[type="submit"]:has-text("Revoke")');

  await expect(page.locator('text=Certificate revoked')).toBeVisible();

  const api = await request.newContext();
  const res = await api.get(`/voc/verify/${encodeURIComponent(row.certificate_id)}`);
  expect(res.status()).toBe(200);
  const body = await res.text();
  expect(body).toContain('REVOKED');
  expect(body).toContain('Test revocation');
  await api.dispose();
});
