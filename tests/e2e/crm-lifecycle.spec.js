// Sightline Phase 1 acceptance: the full CRM lifecycle from organisation →
// opportunity (with referral) → stage gating → proposal send/accept → Won →
// controlled conversion → Master Project Register, asserting the brief's
// §12.2 outcomes: identifiers minted, gates enforced, history preserved.
//
// POSTs go through page.request (shares the session cookie jar) with the
// CSRF token scraped from the page, same pattern as jobs-delete.spec.js.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

// Both playwright projects (desktop/mobile) run against one DB — namespace.
function tag(projectName) { return /mobile/i.test(projectName) ? 'M' : 'D'; }

async function csrfFrom(page, url) {
  await page.goto(url);
  return page.locator('input[name="_csrf"]').first().inputValue();
}

async function metaCsrf(page) {
  return page.locator('meta[name="csrf-token"]').getAttribute('content');
}

test('full lifecycle: org → opportunity → gates → proposal → won → project', async ({ page }, testInfo) => {
  const T = tag(testInfo.project.name);
  await loginAs(page);

  // 1. Organisation — ORG ref minted, lifecycle starts as prospect.
  let csrf = await csrfFrom(page, '/clients/new');
  let resp = await page.request.post('/clients', {
    headers: { Accept: 'application/json' },
    form: {
      _csrf: csrf, company_type: 'client', company_name: `Lifecycle Dev Co ${T}`,
      industry_segment: 'developer', repeat_client_status: 'prospect',
      service_interests: 'DEV,PAS', lead_source: 'referral',
    },
  });
  const client = (await resp.json()).client;
  expect(client.org_ref).toMatch(/^ORG-\d{6}$/);
  expect(client.repeat_client_status).toBe('prospect');

  // Referrer organisation for the referral chain.
  csrf = await csrfFrom(page, '/clients/new');
  resp = await page.request.post('/clients', {
    headers: { Accept: 'application/json' },
    form: { _csrf: csrf, company_type: 'client', company_name: `Lifecycle Referrer ${T}`, repeat_client_status: 'repeat' },
  });
  const referrer = (await resp.json()).client;

  // 2. Opportunity — OPP-YY#### ref, referral row spawned, stage default probability.
  csrf = await csrfFrom(page, '/opportunities/new');
  resp = await page.request.post('/opportunities', {
    headers: { Accept: 'application/json' },
    form: {
      _csrf: csrf, title: `Lifecycle DA ${T}`, client_id: String(client.id), owner_id: '1',
      stage: 'lead', estimated_value: '9000', site_name: `9 Test St ${T}`, lga: 'Testville',
      service_streams: 'DEV', source: 'referral',
      referring_client_id: String(referrer.id), referral_channel: 'client_referral',
    },
  });
  const opp = (await resp.json()).opportunity;
  expect(opp.opportunity_number).toMatch(/^OPP-\d{6}$/);
  expect(opp.referral_id).toBeTruthy();
  expect(opp.probability).toBe(10); // lead default (§3.2)

  // 3. §6.3 gate — Proposal Sent without a proposal is refused with reasons.
  await page.goto('/opportunities/' + opp.id);
  const mCsrf = await metaCsrf(page);
  resp = await page.request.post(`/opportunities/${opp.id}/stage`, {
    headers: { 'x-csrf-token': mCsrf, 'Content-Type': 'application/json' },
    data: { stage: 'proposal_sent' },
  });
  expect(resp.status()).toBe(422);
  expect((await resp.json()).error).toMatch(/proposal must be created/i);

  // 4. Proposal — PROP-{opp}-01 with a package, then send (starts follow-up clock,
  // advances the opportunity to Proposal Sent at the stage default).
  csrf = await csrfFrom(page, `/proposals/new?opportunity_id=${opp.id}`);
  resp = await page.request.post('/proposals', {
    form: {
      _csrf: csrf, opportunity_id: String(opp.id), fee: '9000',
      scope: 'Lifecycle test scope', pkg_stream: 'DEV', pkg_scope: 'Dev assessment',
      pkg_fee: '9000', pkg_hours: '30',
    },
  });
  const propUrl = resp.url();
  const propId = propUrl.match(/\/proposals\/(\d+)/)[1];
  const oppTail = opp.opportunity_number.replace('OPP-', '');
  await page.goto('/proposals/' + propId);
  await expect(page.locator('h1')).toContainText(`PROP-${oppTail}-01`);

  csrf = await csrfFrom(page, '/proposals/' + propId);
  await page.request.post(`/proposals/${propId}/send`, {
    form: { _csrf: csrf, follow_up_date: '2027-01-15' },
  });
  await page.goto('/opportunities/' + opp.id);
  await expect(page.locator('body')).toContainText('Proposal Sent');
  await expect(page.locator('body')).toContainText('60%'); // stage default applied

  // 5. Accept, then Won via the edit path (gates: value, accepted proposal, start, owner).
  csrf = await csrfFrom(page, '/proposals/' + propId);
  await page.request.post(`/proposals/${propId}/accept`, {
    form: { _csrf: csrf, acceptance_reference: `PO-LC-${T}` },
  });
  csrf = await csrfFrom(page, `/opportunities/${opp.id}/edit`);
  await page.request.post(`/opportunities/${opp.id}`, {
    form: {
      _csrf: csrf, title: `Lifecycle DA ${T}`, client_id: String(client.id), owner_id: '1',
      stage: 'won', status: 'won', estimated_value: '9000',
      expected_start_date: '2027-02-01', won_reason: 'technical_capability',
      service_streams: 'DEV', received_date: '2026-08-14',
    },
  });

  // 6. Controlled conversion — review page green, then execute.
  await page.goto(`/opportunities/${opp.id}/convert`);
  await expect(page.locator('button[type="submit"]:has-text("Create Project")')).toBeEnabled();
  csrf = await page.locator('input[name="_csrf"]').first().inputValue();
  resp = await page.request.post(`/opportunities/${opp.id}/convert`, {
    form: {
      _csrf: csrf, project_name: `9 Test St ${T}`, final_fee: '9000', start_date: '2027-02-01',
      project_manager_id: '1', priority: 'normal',
      pkg_include: '0', pkg_stream: 'DEV', pkg_scope: 'Dev assessment',
      pkg_owner: '1', pkg_fee: '9000', pkg_hours: '30',
      pkg_internal_due: '', pkg_client_due: '', pkg_proposal_package_id: '',
    },
  });
  const jobUrl = resp.url();
  expect(jobUrl).toMatch(/\/jobs\/\d+/);

  // 7. Project artifacts: ST ref, package ref, CRM origin links, register row.
  await page.goto(jobUrl);
  const heading = await page.locator('h1').first().textContent();
  expect(heading).toMatch(/^ST-\d{6}/);
  const stRef = heading.trim().split(/\s/)[0];
  await expect(page.locator('body')).toContainText(`${stRef}-DEV-01`);
  await expect(page.locator('body')).toContainText('CRM Origin');
  await expect(page.locator('body')).toContainText(opp.opportunity_number);

  await page.goto('/projects?search=' + stRef);
  await expect(page.locator('body')).toContainText(stRef);

  // 8. §3.4 continuity: the opportunity keeps its history and links forward.
  await page.goto('/opportunities/' + opp.id);
  await expect(page.locator('body')).toContainText(`PROP-${oppTail}-01`);
  await expect(page.locator('body')).toContainText(stRef);
});
