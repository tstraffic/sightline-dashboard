// Sightline Phase 2 acceptance: delivery controls end-to-end — deliverable
// with QA prepare→check→approve→issue (§5.3/§5.6, the §6.3 issue gate),
// permanent document-issue record (§5.5), revision supersession, variation
// approval syncing the contract total (§5.8), time entry syncing
// actual_hours (§5.9), and the gated closeout with authorised exception
// (§6.3).
//
// POSTs go through page.request (shares the session cookie jar) with the
// CSRF token scraped from the page; JSON error assertions send
// Accept: application/json so the QA gates answer with real status codes.
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./helpers/setup');

test.describe.configure({ mode: 'serial' });

function tag(projectName) { return /mobile/i.test(projectName) ? 'M' : 'D'; }

async function csrfFrom(page, url) {
  await page.goto(url);
  return page.locator('input[name="_csrf"]').first().inputValue();
}

test('delivery controls: QA chain → issue register → variation → time → closeout gate', async ({ page, browser }, testInfo) => {
  const T = tag(testInfo.project.name);
  await loginAs(page);

  // 0. A project to deliver against (JSON create path).
  let csrf = await csrfFrom(page, '/projects/new');
  let resp = await page.request.post('/projects', {
    headers: { Accept: 'application/json' },
    form: {
      _csrf: csrf, client: `Delivery Test Client ${T}`, site_address: `12 Gate St ${T}`,
      suburb: 'Testville', start_date: '2027-03-01', status: 'active',
      project_name: `Delivery Lifecycle ${T}`, contract_value: '10000', estimated_hours: '40',
      project_manager_id: '1',
    },
  });
  const job = (await resp.json()).job;
  expect(job.id).toBeTruthy();

  // 1. Deliverable — {job}-RPT-001 ref minted; admin (user 1) is approver.
  csrf = await csrfFrom(page, `/deliverables/new?job_id=${job.id}`);
  resp = await page.request.post('/deliverables', {
    form: {
      _csrf: csrf, job_id: String(job.id), title: `TIA Report ${T}`, doc_type: 'report',
      preparer_id: '1', approver_id: '1',
    },
  });
  const dUrl = resp.url();
  const dId = dUrl.match(/\/deliverables\/(\d+)/)[1];
  await page.goto('/deliverables/' + dId);
  await expect(page.locator('body')).toContainText(`${job.job_number}-RPT-001`);

  // 2. §6.3 hard gate — issue with no revision/QA is refused.
  csrf = await csrfFrom(page, '/deliverables/' + dId);
  resp = await page.request.post(`/deliverables/${dId}/issue`, {
    headers: { Accept: 'application/json' },
    form: { _csrf: csrf, issued_to: 'Client', issue_purpose: 'For Approval' },
  });
  expect(resp.status()).toBe(422);

  // 3. Revision A → prepare → check with comments.
  csrf = await csrfFrom(page, '/deliverables/' + dId);
  await page.request.post(`/deliverables/${dId}/revisions`, { form: { _csrf: csrf, revision_label: 'A' } });
  await page.goto('/deliverables/' + dId);
  const revA = (await page.content()).match(/\/deliverables\/revisions\/(\d+)\//)[1];

  csrf = await csrfFrom(page, '/deliverables/' + dId);
  await page.request.post(`/deliverables/revisions/${revA}/prepare`, { form: { _csrf: csrf } });
  csrf = await csrfFrom(page, '/deliverables/' + dId);
  await page.request.post(`/deliverables/revisions/${revA}/check`, {
    form: { _csrf: csrf, qa_comments: 'Swept path figure missing title block.' },
  });

  // 4. Approve refused while comments stay open.
  csrf = await csrfFrom(page, '/deliverables/' + dId);
  resp = await page.request.post(`/deliverables/revisions/${revA}/approve`, {
    headers: { Accept: 'application/json' }, form: { _csrf: csrf },
  });
  expect(resp.status()).toBe(422);
  expect((await resp.json()).error).toMatch(/comments must be closed/i);

  csrf = await csrfFrom(page, '/deliverables/' + dId);
  await page.request.post(`/deliverables/revisions/${revA}/close-comments`, { form: { _csrf: csrf } });

  // 5. QA authority: a non-approver (planning) is 403'd; the approver passes.
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await loginAs(page2, 'planning_user', 'password');
  const csrf2 = await csrfFrom(page2, '/deliverables/' + dId);
  resp = await page2.request.post(`/deliverables/revisions/${revA}/approve`, {
    headers: { Accept: 'application/json' }, form: { _csrf: csrf2 },
  });
  expect(resp.status()).toBe(403);
  await ctx2.close();

  csrf = await csrfFrom(page, '/deliverables/' + dId);
  resp = await page.request.post(`/deliverables/revisions/${revA}/approve`, { form: { _csrf: csrf } });
  expect(resp.status()).toBeLessThan(400);

  // 6. Issue — permanent §5.5 record; deliverable becomes ISSUED.
  csrf = await csrfFrom(page, '/deliverables/' + dId);
  await page.request.post(`/deliverables/${dId}/issue`, {
    form: { _csrf: csrf, issued_to: `Council ${T}`, issue_purpose: 'For Approval', transmittal_ref: `TX-${T}-01` },
  });
  await page.goto('/deliverables/' + dId);
  await expect(page.locator('body')).toContainText('ISSUED');
  await expect(page.locator('body')).toContainText(`Council ${T}`);

  // 7. Revision B supersedes A; the issue record survives.
  csrf = await csrfFrom(page, '/deliverables/' + dId);
  await page.request.post(`/deliverables/${dId}/revisions`, { form: { _csrf: csrf, revision_label: 'B' } });
  await page.goto('/deliverables/' + dId);
  await expect(page.locator('body')).toContainText('SUPERSEDED');
  await expect(page.locator('body')).toContainText(`Council ${T}`); // issue log intact

  // 8. Variation — submit needs a fee; approval needs a reference and
  // rolls the fee into the project's contract total (§5.8).
  csrf = await csrfFrom(page, `/variations/new?job_id=${job.id}`);
  resp = await page.request.post('/variations', {
    form: { _csrf: csrf, job_id: String(job.id), description: `Extra intersection ${T}`, additional_fee: '1500' },
  });
  await page.goto(`/variations?job_id=${job.id}`);
  const vId = (await page.content()).match(/\/variations\/(\d+)\/edit/)[1];
  csrf = await csrfFrom(page, `/variations/${vId}/edit`);
  await page.request.post(`/variations/${vId}/submit`, { form: { _csrf: csrf } });
  csrf = await csrfFrom(page, `/variations/${vId}/edit`);
  await page.request.post(`/variations/${vId}/approve`, { form: { _csrf: csrf, approval_reference: `PO-VAR-${T}` } });
  await page.goto(`/jobs/${job.id}`);
  await expect(page.locator('body')).toContainText('1,500 approved variations');

  // 9. Time entry syncs actual_hours; the job form locks the field.
  csrf = await csrfFrom(page, '/time');
  await page.request.post('/time', {
    form: { _csrf: csrf, job_id: String(job.id), entry_date: '2027-03-02', activity_code: '07', hours: '2' },
  });
  await page.goto(`/jobs/${job.id}/edit`);
  await expect(page.locator('input[name="actual_hours"]')).toBeDisabled();
  await expect(page.locator('body')).toContainText('Derived from');

  // 10. Closeout gate (§6.3): refused with named blockers (invoicing is
  // incomplete and time is unbilled), then closed via authorised exception,
  // then reopen clears the record.
  await page.goto(`/jobs/${job.id}`);
  await expect(page.locator('body')).toContainText('Closeout blocked');
  csrf = await csrfFrom(page, `/jobs/${job.id}`);
  resp = await page.request.post(`/jobs/${job.id}/close`, { form: { _csrf: csrf } });
  // The refusal flash renders on the redirect page (request follows it) —
  // assert there; a fresh goto would arrive after the flash is consumed.
  expect(await resp.text()).toContain('close out yet');
  await page.goto(`/jobs/${job.id}`);
  await expect(page.locator('body')).toContainText('Closeout blocked'); // still open

  csrf = await csrfFrom(page, `/jobs/${job.id}`);
  await page.request.post(`/jobs/${job.id}/close`, {
    form: { _csrf: csrf, override_reason: `E2E acceptance closeout exception ${T} — remaining items intentionally open.` },
  });
  await page.goto(`/jobs/${job.id}`);
  await expect(page.locator('body')).toContainText('Closed with an authorised exception');

  csrf = await csrfFrom(page, `/jobs/${job.id}`);
  await page.request.post(`/jobs/${job.id}/reopen`, { form: { _csrf: csrf } });
  await page.goto(`/jobs/${job.id}`);
  await expect(page.locator('body')).not.toContainText('Closed with an authorised exception');
  await expect(page.locator('body')).toContainText('Closeout blocked');
});
