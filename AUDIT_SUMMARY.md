# Atomis / T&S Platform — One-Page Audit Summary

**Audited:** main @ `17b4988` (working tree = origin/main), 2026-05-20. Read-only. Full detail in [AUDIT_REPORT.md](AUDIT_REPORT.md) + [AUDIT_FINDINGS_RAW.md](AUDIT_FINDINGS_RAW.md).

## Counts

**REAL 7** · **PARTIAL 7** · **STUB 0** · **DEAD 0** · **MISSING 1**

- REAL — Auth (1), Job Mgmt (2), Worker Portal (4), SWMS Register (6), Cert Expiry (7), Reporting (11), Design Polish (15)
- PARTIAL — Rostering (3), Timesheet/Award (5), Incidents (8), Dockets/Evidence (9), Invoicing (10), Multi-tenancy (13), Trust Signals (14)
- MISSING — Avetta/ISNetworld Compliance Export (12)

## Top 10 things that would embarrass us in a buyer demo (worst first)

1. **The Finance section title literally says "Abergeldie Payment Sheet"** — [routes/abergeldie-payments.js:74](routes/abergeldie-payments.js:74) hardcodes `CLIENT_NAME='Abergeldie'`. Whole invoicing module is one-client.
2. **54 real Villawood TCs with phone numbers + emails are seeded on every fresh DB** — including Saadat `0469295448` and Taj `0416221801`. Mig 90/91 in [db/schema.js:4308-4443](db/schema.js:4308).
3. **`EMP-TEST` / PIN `1234` dummy worker is live in the crew roster** ([db/schema.js:5101-5130](db/schema.js:5101), mig 114).
4. **"Notifiable" tickbox on incidents does nothing.** No WHS Act mapping, no SafeWork notification. [routes/incidents.js:113](routes/incidents.js:113) stores the value, nothing acts on it.
5. **Workers cannot decline shifts.** Only confirm. Manager has to cancel for them. [routes/worker/shifts.js:189-202](routes/worker/shifts.js:189).
6. **Avetta + ISNetworld compliance pack export is MISSING** — zero hits in the codebase. Brief explicitly asks for both.
7. **No Xero / MYOB / Employment Hero / KeyPay payroll export.** Only raw XLSX bucket dump.
8. **QuickBooks + Employment Hero "Test" buttons flash "coming soon"** — [routes/integrations.js:108-111](routes/integrations.js:108). Visible mid-setup.
9. **Worker incident form silently drops weather + GPS lat/lng** — [routes/worker/incidents.js:142-147](routes/worker/incidents.js:142) reads them, INSERT omits them.
10. **Dockets don't link to invoicing.** Worker signs 8 hours; office re-types from a Traffio CSV. `docket_signatures.total_hours` exists, [routes/abergeldie-payments.js](routes/abergeldie-payments.js) never queries it.

## Top 10 quick wins (<1 day each)

1. **Fix incident weather/GPS persistence** — add 3 columns to the INSERT. 30 min. ([routes/worker/incidents.js:142](routes/worker/incidents.js:142))
2. **Fix plan-code regex** — `/TSJ-(\d+)/` → `/J-(\d+)/` and update the surrounding comment. ([routes/plans.js:74-79](routes/plans.js:74))
3. **Gate `EMP-TEST` seed behind `NODE_ENV !== 'production'`** — mig 114 should self-skip on prod tenants.
4. **Rate-limit `/forgot-password` + `/w/forgot-pin`** — reuse existing `loginLimiter`. 20 min.
5. **Wire SWMS expiry reminders** — clone [services/certExpiryReminders.js](services/certExpiryReminders.js) for SWMS. 2-3 hrs.
6. **Strip PII `console.log` from job + induction + email paths** — replace with logger respecting `LOG_LEVEL`. 1 hr.
7. ~~Wire `payAsYouGo` PAYG calc~~ — **CORRECTED during Phase A**: already wired at [routes/payroll-runs.js:545](routes/payroll-runs.js:545) (employee total) and [routes/payroll-runs.js:656](routes/payroll-runs.js:656) (per-line). Audit grep missed it.
8. **Add worker decline endpoint** — `POST /w/shifts/:id/decline` mirroring confirm. 2-3 hrs.
9. **Move weekly-summary recipients to `system_config`** — kill the hardcoded "Taj + Saadat" at [server.js:416-423](server.js:416). 1 hr.
10. ~~Remove the offline "data will sync" banner~~ — **CORRECTED during Phase A**: there IS a real IndexedDB queue at [public/js/worker-offline-queue.js](public/js/worker-offline-queue.js) with retry, dead-letter, and per-form opt-in. Banner is honest. Audit sub-agent missed it.

## Top 5 structural problems (weeks of work)

1. **Genericise invoicing.** Kill the Abergeldie hardcode. Add `client_rate_cards` table. Build a real invoice + progress-claim PDF. **2-3 weeks.**
2. **Phase 2 multi-tenancy migration.** Add `tenant_id` to ~60 business tables + backfill + migrate 119 raw `getDb()` routes to `req.db`. Architecture is ready (`lib/tenant-db.js` is good); execution hasn't started. **2-3 weeks** — and it's the *required precondition* for any shared-instance multi-tenant sale.
3. **Avetta / ISNetworld evidence pack.** Pick one; design the field map; build the assembler on top of existing [lib/pdfMerge.js](lib/pdfMerge.js). **2-3 weeks per integration.**
4. **Payroll export adapter (one).** Pick Xero or MYOB or Employment Hero (Aus market reality says start with Xero). **1-2 weeks.** July 2025 award rate phase-in folds into this.
5. **Replace `setInterval` cron with a real queue + leader election.** Today the platform cannot horizontally scale — two replicas double-fire every reminder. **1-2 weeks** if you adopt BullMQ + Redis on Railway.

## Gut call

**No to a paying *multi-tenant* customer next month.** Yes to a single-tenant deployment for a friendly design partner with 1-2 weeks of focused cleanup — scrub T&S seeds, genericise the Finance / Abergeldie module, configurable brand, remove `EMP-TEST`, fix the offline-banner lie, plus the ten quick wins above. White-label-and-sell at scale is **6-10 weeks** because Phase 2 multi-tenancy + a real payroll export + an Avetta pack haven't started, and a buyer with an existing Xero or Avetta account will ask on day one.

The product underneath is more substantial than the gaps suggest: 217 migrations, real award-rate splitting, weighted safety composite, Litestream backups, account-scoped persistent PIN lockout, and a multi-tenancy wrapper architecture that's exactly how you'd want it done — it just hasn't been activated. Don't apologise for the breadth; just don't oversell what isn't wired.
