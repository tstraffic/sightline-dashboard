#!/usr/bin/env node
/**
 * scripts/lint-tenant-ratchet.js — CI gate for check-raw-db.js.
 *
 * check-raw-db.js exits 1 while ANY raw-DB import exists — by design, its
 * violation list IS the Phase 2 migration backlog (140 files at baseline).
 * That makes it unusable as a hard CI gate until Phase 2 lands.
 *
 * This ratchet fails ONLY when the count GROWS past the baseline, so new
 * raw `getDb()` imports are blocked today while the legacy list burns down.
 * When you migrate files to req.db, lower BASELINE to match (the script
 * tells you). At 0, delete this file and gate on `lint:tenant` directly.
 */
const { spawnSync } = require('child_process');
const path = require('path');

// Raw-DB violation count. History:
//   140  2026-07-23  initial baseline
//   141  2026-07-27  +routes/departments.js — dept hubs join the Phase 2
//        backlog consciously: its stat queries span legacy tables without
//        tenant_id columns, so req.db's assertScoped would reject them
//        until Phase 2 backfills tenant_id. Migrate it with the rest.
//   142  2026-08-03  +routes/meetings.js — company_meetings tables mirror
//        dept_meetings (no tenant_id yet, Phase 2 backfills) and the module
//        is joined at the hip to routes/departments.js, which is already on
//        this backlog. Migrate the pair together.
//   144  2026-08-07  +routes/contracts.js, +routes/contract-sign.js — the
//        employment-contracts module (migration 344). Its tables carry no
//        tenant_id yet and the queries join employees/users, so req.db's
//        assertScoped would reject them until Phase 2 backfills. Conscious
//        add; migrate both together with the HR cluster.
//   171  2026-08-14  +Sightline Phase 1 (routes/referrals, proposals,
//        service-packages + lib/refNumbers, crmStages, sightlineJobFields
//        and touched CRM routes). This fork IS the Sightline tenant —
//        single-tenant by design — and the new tables (referrals,
//        proposals, service_packages, ref_sequences) carry no tenant_id.
//        Conscious add; if this fork ever joins the multi-tenant migration,
//        the Sightline CRM cluster migrates as one unit.
//   177  2026-08-17  +Sightline Phase 2 delivery cluster (routes/
//        deliverables, approvals, variations, client-inputs,
//        correspondence, time + lib/deliverableStatus, wip). Same
//        single-tenant conscious add as Phase 1; the delivery cluster
//        migrates with the CRM cluster if multi-tenancy ever lands here.
const BASELINE = 177;

// spawnSync (not execFileSync): check-raw-db exits 1 while violations exist,
// and the JSON must still be read off stdout without an exception path.
const r = spawnSync(process.execPath, [path.join(__dirname, 'check-raw-db.js'), '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (!r.stdout) { console.error('lint-tenant-ratchet: check-raw-db.js produced no output'); process.exit(2); }

const count = JSON.parse(r.stdout).rawDbViolations.length;

if (count > BASELINE) {
  console.error(`lint-tenant-ratchet: FAIL — ${count} raw-DB violations (baseline ${BASELINE}).`);
  console.error('New code must use req.db (lib/tenant-db.js), not raw getDb().');
  console.error('Run `npm run lint:tenant` to see the full list.');
  process.exit(1);
}
if (count < BASELINE) {
  console.log(`lint-tenant-ratchet: PASS — ${count} violations, below baseline ${BASELINE}.`);
  console.log(`Nice: lower BASELINE to ${count} in scripts/lint-tenant-ratchet.js to lock in the progress.`);
} else {
  console.log(`lint-tenant-ratchet: PASS — ${count} violations, at baseline.`);
}
