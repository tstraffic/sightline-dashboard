// Plans & Approvals — unified Documents zone, attach-only uploads, ROL
// parse-from-attached, TGS↔ROL many-to-many links, streamlined selects.
//
// Previously: uploading files to a sub-plan ALWAYS submitted it (status →
// submitted + required description/date/hours); the ROL workflow demanded
// its own upload even when the ROL PDF was already attached; a TGS could
// link to exactly ONE ROL (compliance.linked_rol_id); and creating plans
// meant one owner <select> per type row plus a type dropdown to add more.
const { test, expect } = require('@playwright/test');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { loginAs, TEST_DB } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function withDb(fn) {
  const db = new Database(TEST_DB);
  db.pragma('busy_timeout = 5000');
  try { return fn(db); } finally { db.close(); }
}

// A minimal but genuinely parseable PDF: pdfjs reads the one text run, so
// the ROL parser extracts "LICENCE NO 98765" and the review page renders
// with real data — no binary fixture needed in the repo.
const MINI_PDF = Buffer.from(
  '%PDF-1.4\n' +
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 12 Tf 72 720 Td (LICENCE NO 98765) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n' +
  'trailer<</Size 6/Root 1 0 R>>\n%%EOF'
);

// Parent plan + one TGS + two ROL sub-plans, fresh each run.
function seedPlan() {
  return withDb(db => {
    db.prepare("DELETE FROM compliance WHERE title LIKE 'JPPLAN %'").run();
    db.prepare(`
      INSERT INTO compliance (parent_id, plan_number, item_type, title, status)
      VALUES (NULL, 9901, 'other', 'JPPLAN parent', 'not_started')
    `).run();
    const parentId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    const mkSub = (type, ref, title) => {
      db.prepare(`
        INSERT INTO compliance (parent_id, item_type, title, reference_number, status)
        VALUES (?, ?, ?, ?, 'not_started')
      `).run(parentId, type, title, ref);
      return db.prepare('SELECT last_insert_rowid() AS id').get().id;
    };
    const tgsId = mkSub('traffic_guidance', 'TSTGS-E2E', 'JPPLAN tgs');
    const rol1 = mkSub('rol', 'TSROL-E2E-1', 'JPPLAN rol one');
    const rol2 = mkSub('rol', 'TSROL-E2E-2', 'JPPLAN rol two');
    try { db.prepare('DELETE FROM compliance_tgs_rol_links WHERE tgs_id = ?').run(tgsId); } catch (e) {}
    return { parentId, tgsId, rol1, rol2 };
  });
}

const editUrl = (seed) => `/compliance/${seed.parentId}/edit`;

test('dropping files on a sub-plan attaches them WITHOUT submitting', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));

  const card = page.locator(`#sub-${seed.tgsId}`);
  await expect(card).toBeVisible();
  // setInputFiles fires `change` — the same event the dropzone dispatches
  // on drop — which auto-submits the attach-only form.
  await card.locator('form[data-attach-form] input[type="file"]')
    .setInputFiles({ name: 'jp-attach.pdf', mimeType: 'application/pdf', buffer: MINI_PDF });
  await page.waitForLoadState('networkidle');

  await expect(page.locator(`#sub-${seed.tgsId}`)).toContainText('jp-attach.pdf');
  const row = withDb(db => db.prepare('SELECT status FROM compliance WHERE id = ?').get(seed.tgsId));
  expect(row.status).toBe('not_started'); // attach ≠ submit
});

test('the plan can then be SUBMITTED without re-picking files', async ({ page }) => {
  const seed = seedPlan();
  withDb(db => {
    db.prepare(`
      INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type)
      VALUES (?, 'pre.pdf', 'pre.pdf', '/data/uploads/compliance/${seed.tgsId}/pre.pdf', 100, 'application/pdf')
    `).run(seed.tgsId);
  });
  await loginAs(page);
  await page.goto(editUrl(seed));

  const card = page.locator(`#sub-${seed.tgsId}`);
  await card.locator('summary', { hasText: /Submit plan/ }).click();
  const submitForm = card.locator('form[action*="upload-submit"]');
  await submitForm.locator('input[name="description"]').fill('E2E submitted with attached docs');
  await submitForm.locator('input[name="hours_spent"]').fill('0.5');
  // NO file selected — the already-attached doc satisfies the server rule,
  // and the file input's `required` is relaxed when docs exist.
  await submitForm.locator('button', { hasText: 'Upload & Submit' }).click();
  await page.waitForLoadState('networkidle');

  const row = withDb(db => db.prepare('SELECT status FROM compliance WHERE id = ?').get(seed.tgsId));
  expect(row.status).toBe('submitted');
});

test('upload-submit still validates (missing hours blocks it)', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.tgsId}`);
  await card.locator('summary', { hasText: /Submit plan/ }).click();
  await card.locator('form[action*="upload-submit"] input[name="description"]').fill('Missing hours');
  // Attach a file so the file rule passes; hours left empty. The browser's
  // own `required` blocks first — clear it to exercise the server rule.
  await card.locator('form[action*="upload-submit"] input[type="file"]')
    .setInputFiles({ name: 'v.pdf', mimeType: 'application/pdf', buffer: MINI_PDF });
  await card.locator('form[action*="upload-submit"] input[name="hours_spent"]').evaluate(el => el.removeAttribute('required'));
  await card.locator('form[action*="upload-submit"] button', { hasText: 'Upload & Submit' }).click();
  await page.waitForLoadState('networkidle');

  const row = withDb(db => db.prepare('SELECT status FROM compliance WHERE id = ?').get(seed.tgsId));
  expect(row.status).toBe('not_started');
  await expect(page.locator('body')).toContainText(/hours/i);
});

test('the ROL workflow reads an already-attached PDF — no re-upload', async ({ page }) => {
  const seed = seedPlan();
  // Attach a parseable PDF to the ROL sub-plan on disk + in the DB, the
  // exact shape the attach route produces.
  const docId = withDb(db => {
    const dir = path.join(__dirname, '..', '..', 'data', 'uploads', 'compliance', String(seed.rol1));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'e2e-rol.pdf'), MINI_PDF);
    db.prepare(`
      INSERT INTO compliance_documents (compliance_id, filename, original_name, file_path, file_size, mime_type)
      VALUES (?, 'e2e-rol.pdf', 'e2e-rol.pdf', '/data/uploads/compliance/${seed.rol1}/e2e-rol.pdf', ${MINI_PDF.length}, 'application/pdf')
    `).run(seed.rol1);
    return db.prepare('SELECT last_insert_rowid() AS id').get().id;
  });

  await loginAs(page);
  await page.goto(editUrl(seed));
  const card = page.locator(`#sub-${seed.rol1}`);
  await card.locator('summary', { hasText: 'ROL workflow' }).click();

  const docRow = card.locator('[data-rol-existing-docs]');
  await expect(docRow).toContainText('e2e-rol.pdf');
  await docRow.locator('button', { hasText: 'Read as issued ROL' }).click();
  await page.waitForLoadState('networkidle');

  // The review page rendered from the ATTACHED file (no upload happened),
  // with the parser's output prefilled and the path carried forward.
  await expect(page.locator('body')).toContainText('Review extracted');
  await expect(page.locator('input[name="existing_rol_file_path"]'))
    .toHaveValue(`/data/uploads/compliance/${seed.rol1}/e2e-rol.pdf`);
  await expect(page.locator('input[name="rol_actual_number"]')).toHaveValue('98765');

  // Confirm → the reused path lands in the dedicated ROL columns.
  await page.locator('button', { hasText: /Confirm/ }).click();
  await page.waitForLoadState('networkidle');
  const row = withDb(db => db.prepare('SELECT rol_file_path, rol_stage FROM compliance WHERE id = ?').get(seed.rol1));
  expect(row.rol_file_path).toBe(`/data/uploads/compliance/${seed.rol1}/e2e-rol.pdf`);
  expect(row.rol_stage).toBe('approved');
});

test('a TGS links to MULTIPLE ROLs, with back-links, and unlinks cleanly', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));

  const tgsCard = page.locator(`#sub-${seed.tgsId}`);
  await tgsCard.locator('[data-rol-links] button', { hasText: 'TSROL-E2E-1' }).click();
  await page.waitForLoadState('networkidle');
  await page.locator(`#sub-${seed.tgsId} [data-rol-links] button`, { hasText: 'TSROL-E2E-2' }).click();
  await page.waitForLoadState('networkidle');

  let links = withDb(db => db.prepare('SELECT rol_id FROM compliance_tgs_rol_links WHERE tgs_id = ? ORDER BY rol_id').all(seed.tgsId));
  expect(links.map(l => l.rol_id)).toEqual([seed.rol1, seed.rol2]);

  // Both ROL cards carry the back-link.
  await expect(page.locator(`#sub-${seed.rol1} [data-tgs-backlinks]`)).toContainText('TSTGS-E2E');
  await expect(page.locator(`#sub-${seed.rol2} [data-tgs-backlinks]`)).toContainText('TSTGS-E2E');

  // Unlink one — the other survives.
  await page.locator(`#sub-${seed.tgsId} [data-rol-links] button`, { hasText: 'TSROL-E2E-1' }).click();
  await page.waitForLoadState('networkidle');
  links = withDb(db => db.prepare('SELECT rol_id FROM compliance_tgs_rol_links WHERE tgs_id = ?').all(seed.tgsId));
  expect(links.map(l => l.rol_id)).toEqual([seed.rol2]);
});

test('quick-add buttons create sub-plans without the type dropdown', async ({ page }) => {
  const seed = seedPlan();
  await loginAs(page);
  await page.goto(editUrl(seed));

  await page.locator('details summary', { hasText: 'Add a sub-plan' }).click();
  await page.locator('[data-quick-add="spa"]').click();
  await page.waitForLoadState('networkidle');
  const spa = withDb(db => db.prepare("SELECT id, reference_number FROM compliance WHERE parent_id = ? AND item_type = 'spa'").get(seed.parentId));
  expect(spa).toBeTruthy();
  expect(spa.reference_number).toMatch(/^TSSPA/);

  // "Other" needs a description first — its button reveals the inline form.
  await page.locator('details summary', { hasText: 'Add a sub-plan' }).click();
  await page.locator('[data-quick-add="other"]').click();
  await page.locator('#addOtherForm input[name="other_description"]').fill('Environmental approval');
  await page.locator('#addOtherForm button', { hasText: 'Add Other' }).click();
  await page.waitForLoadState('networkidle');
  const other = withDb(db => db.prepare("SELECT other_description FROM compliance WHERE parent_id = ? AND item_type = 'other' AND parent_id IS NOT NULL").get(seed.parentId));
  expect(other && other.other_description).toBe('Environmental approval');
});

test('plan creation: one default owner covers every type, override wins per type', async ({ page }) => {
  const users = withDb(db => db.prepare('SELECT id FROM users ORDER BY id LIMIT 2').all());
  test.skip(users.length < 2, 'needs two users');
  await loginAs(page);
  await page.goto('/compliance/new');

  await page.fill('input[name="title"]', 'JPPLAN default-owner probe');
  await page.selectOption('select[name="default_owner_id"]', String(users[0].id));

  // Tick TGS + ROL; leave owners at the default.
  await page.locator('.type-toggle[data-type="traffic_guidance"]').check();
  await page.locator('.type-toggle[data-type="rol"]').check();
  // Per-type override for ROL only.
  await page.locator('#customiseOwners').check();
  await page.selectOption('select[name="owner_rol"]', String(users[1].id));

  await page.locator('button', { hasText: 'Create Plan' }).click();
  await page.waitForLoadState('networkidle');

  const rows = withDb(db => db.prepare(`
    SELECT c.item_type, c.assigned_to_id FROM compliance c
    JOIN compliance p ON p.id = c.parent_id
    WHERE p.title = 'JPPLAN default-owner probe'
  `).all());
  const byType = Object.fromEntries(rows.map(r => [r.item_type, r.assigned_to_id]));
  expect(byType.traffic_guidance).toBe(users[0].id); // default owner
  expect(byType.rol).toBe(users[1].id);              // per-type override
});
