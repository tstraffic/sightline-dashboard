// Requester + Planner on a booking are people from the SAME pool as the Site
// Contacts picker — the selected client's contacts — and each is gated by its
// own opt-in checkbox.
//
// Regression guards:
//  1. The two dropdowns were only rebuilt when the client <select> changed, so
//     a contact added inline via "+ Add contact" showed up under Site Contacts
//     but not as a pickable requester or planner until you re-picked the
//     client. They now rebuild whenever the contact pool itself changes.
//  2. Each select stays disabled until its checkbox is ticked. A disabled
//     control submits nothing, which is what makes unticking clear the stored
//     id (the route falls back to `|| null`) — so "greyed out" and "clears on
//     save" are the same mechanism, and both are asserted here.
//
// Two quirks of this form shape the test:
//  - smart-select.js hides native <select>s that have 8+ options (1px, opacity
//    0, pointer-events none) behind a widget, so selectOption uses `force`.
//    Contact lists are usually shorter than that, so these particular selects
//    normally stay native — the spec must not depend on either outcome.
//  - The form is a tab wizard; off-tab fields are in the DOM but not visible,
//    so each field is reached by clicking its tab first (depot / client /
//    schedule).
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

// Both browser projects run against one shared DB — keep data project-unique.
const suffix = (testInfo) => (testInfo.project.name.includes('mobile') ? 'M' : 'D');

const postJson = (page, url, payload) =>
  page.evaluate(async ({ u, body }) => {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const res = await fetch(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-csrf-token': csrf },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.success === false) throw new Error(json.error || `POST ${u} failed`);
    return json;
  }, { u: url, body: payload });

const openTab = (page, key) => page.locator(`[data-tab="${key}"]`).click();

// Visible option labels of a select, minus the empty placeholder.
const optionLabels = (page, id) =>
  page.$eval(`#${id}`, (el) => [...el.options].filter((o) => o.value).map((o) => o.text));

async function pickClient(page, clientName) {
  const value = await page.$eval(
    'select[name="client_id"]',
    (el, name) => [...el.options].find((o) => o.text === name)?.value,
    clientName,
  );
  expect(value, `client "${clientName}" is in the dropdown`).toBeTruthy();
  await page.selectOption('select[name="client_id"]', value, { force: true });
  return value;
}

test('requester and planner offer the same people as site contacts', async ({ page }, testInfo) => {
  const s = suffix(testInfo);
  const clientName = `Party Gate Co ${s}`;
  await loginAs(page);
  await page.goto('/bookings/new');

  const { client } = await postJson(page, '/clients', { company_name: clientName, company_type: 'client' });
  for (const [full_name, position] of [[`Dana Whitfield ${s}`, 'Site Manager'], [`Marco Ellis ${s}`, 'Traffic Planner']]) {
    await postJson(page, '/contacts/api/quick-create', { company_id: client.id, full_name, position });
  }

  await page.reload();
  await openTab(page, 'client');

  // Before a client is chosen there is nobody to pick, and both are gated off.
  for (const key of ['requester', 'planner']) {
    await expect(page.locator(`#${key}Select`)).toBeDisabled();
    expect(await optionLabels(page, `${key}Select`)).toEqual([]);
  }

  await pickClient(page, clientName);

  // The two dropdowns and the Site Contacts picker must offer the same people.
  const siteContacts = await page.$$eval('[data-toggle]', (els) =>
    els.map((e) => e.innerText.trim().split('\n')[0].replace(/\s+·\s+/g, ' · ')));
  expect(siteContacts.length).toBeGreaterThan(0);
  for (const key of ['requester', 'planner']) {
    expect(await optionLabels(page, `${key}Select`)).toEqual(siteContacts);
  }

  // Still gated until ticked, and the gates are independent.
  await expect(page.locator('#plannerSelect')).toBeDisabled();
  await page.locator('[data-party-gate="plannerSelect"]').check();
  await expect(page.locator('#plannerSelect')).toBeEnabled();
  await expect(page.locator('#requesterSelect')).toBeDisabled();
});

test('a contact added inline is immediately pickable as planner', async ({ page }, testInfo) => {
  const s = suffix(testInfo);
  const clientName = `Party Gate Co ${s}`;
  const newContact = `Tessa Nguyen ${s}`;
  await loginAs(page);
  await page.goto('/bookings/new');
  await openTab(page, 'client');
  const clientId = await pickClient(page, clientName);

  expect(await optionLabels(page, 'plannerSelect')).not.toContainEqual(expect.stringContaining(newContact));

  // Drive the real "+ Add contact" modal — the regression lived in its success
  // handler, which refreshed Site Contacts but not these two dropdowns.
  await page.locator('#addSiteContactBtn').click();
  await page.fill('#cm_full_name', newContact);
  await page.fill('#cm_position', 'Works Supervisor');
  await page.locator('#cm_save').click();

  // No client re-pick, no reload — the new person is pickable straight away.
  await expect
    .poll(() => optionLabels(page, 'plannerSelect'))
    .toContainEqual(expect.stringContaining(newContact));
  expect(await optionLabels(page, 'requesterSelect')).toContainEqual(expect.stringContaining(newContact));
});

test('a ticked planner saves, and unticking it clears the booking', async ({ page }, testInfo) => {
  const s = suffix(testInfo);
  const clientName = `Party Gate Co ${s}`;
  await loginAs(page);
  await page.goto('/bookings/new');

  // Depot tab — required.
  await openTab(page, 'depot');
  const depots = await page.$eval('select[name="depot"]', (el) =>
    [...el.options].map((o) => o.value).filter(Boolean));
  await page.selectOption('select[name="depot"]', depots[0], { force: true });

  // Client tab — client, then a designated planner from its contacts.
  await openTab(page, 'client');
  await pickClient(page, clientName);
  await page.locator('[data-party-gate="plannerSelect"]').check();
  const plannerLabel = (await optionLabels(page, 'plannerSelect'))[0];
  const plannerId = await page.$eval(
    '#plannerSelect', (el, label) => [...el.options].find((o) => o.text === label)?.value, plannerLabel);
  await page.selectOption('#plannerSelect', plannerId, { force: true });

  // Schedule tab — the remaining required fields.
  await openTab(page, 'schedule');
  await page.fill('input[name="title"]', `Party gate booking ${s}`);
  await page.fill('input[name="start_date"]', '2026-08-04');
  await page.fill('input[name="end_date"]', '2026-08-04');
  await page.fill('input[name="start_time"]', '07:00');
  await page.fill('input[name="end_time"]', '15:00');

  await page.locator('button[type="submit"]:has-text("Create Booking")').click();
  await expect(page).toHaveURL(/\/bookings\/\d+/);
  const bookingUrl = page.url().replace(/[?#].*$/, '');

  // The contact's name — the person, not the company — is on the booking.
  await expect(page.locator('body')).toContainText(plannerLabel.split(' · ')[0]);

  // Reopen: the gate comes back ticked with the saved person.
  await page.goto(`${bookingUrl}/edit`);
  await openTab(page, 'client');
  await expect(page.locator('[data-party-gate="plannerSelect"]')).toBeChecked();
  await expect(page.locator('#plannerSelect')).toHaveValue(plannerId);

  // Untick and save — the disabled select submits nothing, so the id clears.
  await page.locator('[data-party-gate="plannerSelect"]').uncheck();
  await expect(page.locator('#plannerSelect')).toBeDisabled();
  await page.locator('button[type="submit"]:has-text("Update Booking")').click();
  await expect(page).toHaveURL(/\/bookings\/\d+/);

  await page.goto(`${bookingUrl}/edit`);
  await openTab(page, 'client');
  await expect(page.locator('[data-party-gate="plannerSelect"]')).not.toBeChecked();
  await expect(page.locator('#plannerSelect')).toHaveValue('');
});
