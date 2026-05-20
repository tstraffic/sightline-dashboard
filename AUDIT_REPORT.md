# Atomis / T&S Platform — Buyer-Honesty Audit Report

**Audit date:** 2026-05-20
**Branch audited:** `main` via working tree (HEAD `56ccad8` on `claude/control-room-rebrand` ≡ `origin/main` `17b4988`; only diff is merge-commit SHA, content identical)
**Methodology:** Read-only static analysis of source + schema. Six parallel sub-agents covered components 1–15 plus grep/security sweeps. All findings cross-checked against `db/schema.js`, `server.js` route mounts, `views/partials/sidebar.ejs`, and `views/worker/layout.ejs`. Where a sub-agent missed a file (noted in §Caveats) I corrected.
**Auditor stance:** Brutal. The owner asked for the truth before a buyer finds it.

---

## Stack reality (vs. brief's assumption)

The brief assumed Next.js + Supabase + React Native. **None of those apply.** Actual stack:

- **Backend:** Node ≥18, Express 4.21, EJS templates, `express-ejs-layouts`
- **DB:** better-sqlite3 12.6 — single SQLite file at `data/tstraffic.db`. NO Postgres, NO Supabase, NO RLS.
- **Schema:** `db/schema.js` (10,764 lines, **217 migrations declared, 215 actually applied** — gaps at 98 and 126, no in-file explanation)
- **Worker portal:** EJS-based PWA at `/w/`, NOT React Native. `public/manifest.json` + `public/worker-sw.js`.
- **Admin PWA:** `public/manifest-admin.json` + `public/admin-sw.js`.
- **Auth:** sessions in `connect-sqlite3` SQLiteStore. Admin = username/password (bcrypt). Worker = employee_id + 4–6 digit PIN (bcrypt) with account-level lockout.
- **Multi-tenancy:** Explicit Phase 0 — see Component 13. Wrapper exists, unused.
- **Automations:** Five `setInterval` jobs inside the single Node process. NO `pg_cron`, NO job queue, NO horizontal scaling.
- **AI:** Zero. No `anthropic` / `@anthropic-ai/sdk` in `package.json`. No prompts. No LLM calls.

---

## Audit at a glance

| Status   | Count | Components |
|----------|-------|------------|
| REAL     | 7     | 1 Auth · 2 Job Mgmt · 4 Worker Portal · 6 SWMS Register · 7 Cert Expiry · 11 Reporting · 15 Design Polish |
| PARTIAL  | 7     | 3 Rostering · 5 Timesheet/Award · 8 Incidents · 9 Dockets/Evidence · 10 Invoicing · 13 Multi-tenancy · 14 Trust Signals |
| STUB     | 0     | — |
| DEAD     | 0     | — (one DEAD *table* — `email_inbox`; no DEAD route/feature) |
| MISSING  | 1     | 12 Avetta / ISNetworld Compliance Export |

---

## Component 1 — Auth, login, onboarding

**Status:** REAL
**Files of record:** [routes/auth.js](routes/auth.js), [routes/profile.js](routes/profile.js), [routes/invite.js](routes/invite.js), [routes/worker/auth.js](routes/worker/auth.js), [routes/worker/setup.js](routes/worker/setup.js), [middleware/auth.js](middleware/auth.js), [middleware/workerAuth.js](middleware/workerAuth.js), [services/email.js](services/email.js), [services/invitations.js](services/invitations.js)
**Database tables:** `users`, `crew_members` (PIN columns mig 14, lockout mig 214), `invitations`, `sessions`
**What works:** bcrypt admin passwords; worker PIN with account-level lockout that survives restarts ([routes/worker/auth.js:22-31](routes/worker/auth.js:22), `PIN_MAX_ATTEMPTS = 5`, `PIN_LOCK_MINUTES = 15`); Resend HTTP API + SMTP fallback for transactional email; time-limited invitation tokens for both admin user provisioning and worker PIN setup; `must_change_password` flag forces password change on first login ([server.js:237-259](server.js:237)) and is set by mig 81 (default admin) and mig 214 (named-seed admins). Login rate limited (10/15min, [server.js:191-199](server.js:191)). 47-module PERMISSIONS map in [middleware/auth.js:25-149](middleware/auth.js:25) with role aliases (`management→admin`, `accounts→finance`).
**What's broken or fake:** No SSO/SAML/OAuth/OIDC (grep confirms zero hits). No 2FA/TOTP/passkeys. No tenant selector at login — tenant hardcoded to `'ts'` in [middleware/tenant.js:30](middleware/tenant.js:30). `/forgot-password` and `/w/forgot-pin` are NOT rate-limited ([routes/auth.js:63](routes/auth.js:63), [routes/worker/auth.js:178](routes/worker/auth.js:178)) — email-spam DoS vector. No `session.regenerate()` after login (session fixation defence-in-depth missing). `SESSION_SECRET` not enforced — [server.js:120](server.js:120) auto-generates if unset, invalidating all sessions on restart.
**Effort to make it REAL:** N/A — already REAL. Add 2FA = M, SSO/SAML = L.
**Red flags a buyer would find by clicking:** Forgot-password email never arrives → no UI feedback. Office shared-IP scenario — one frustrated user locks out everyone for 15 min. No "log out other sessions" UI.
**Genuinely good:** Worker PIN lockout is account-scoped + persistent. Admin invitation flow uses single-use expiring tokens. `must_change_password` enforcement is tight.

---

## Component 2 — Job management

**Status:** REAL (with one silent bug)
**Files of record:** [routes/jobs.js](routes/jobs.js), [routes/plans.js](routes/plans.js), [routes/tgs-risk-assessments.js](routes/tgs-risk-assessments.js), [lib/jobNumbers.js](lib/jobNumbers.js), [lib/planStatus.js](lib/planStatus.js), [services/jobPackPdf.js](services/jobPackPdf.js), [services/jobPackNotify.js](services/jobPackNotify.js), [lib/pdf/tgsRiskAssessmentPdf.js](lib/pdf/tgsRiskAssessmentPdf.js)
**Database tables:** `jobs`, `traffic_plans`, `plan_revisions`, `compliance` (sub-plans live here per mig 154), `tgs_risk_assessments` (mig 210)
**What works:** Job-code auto-increment via [lib/jobNumbers.js](lib/jobNumbers.js) — format is `J-XXXX` (mig 106 normalised from earlier formats). Status lifecycle enforced by CHECK constraint (`tender | won | prestart | active | on_hold | completed | closed`). Dual-view planning vs. operations gated by `planning_*` / `ops_*` permission keys ([middleware/auth.js:119-129](middleware/auth.js:119)). Plans → Sub-Plans hierarchy via mig 154 (compliance table). Plan revisions tracked. Job-pack PDF rendered via [services/jobPackPdf.js](services/jobPackPdf.js) and notified via [services/jobPackNotify.js](services/jobPackNotify.js). Job health computed live by [middleware/jobHealth.js](middleware/jobHealth.js), no stale DB cache.
**What's broken or fake:** **Plan-code regex bug.** [routes/plans.js:79](routes/plans.js:79) matches `/TSJ-(\d+)/` but actual job codes are `J-XXXX` (per [lib/jobNumbers.js:16](lib/jobNumbers.js:16)). The fallback strips non-digits and pads, so plan numbers are produced — but the comment at line 74 references "TSJ-XXXX → XXXX" that reality contradicts. Buyer who notices this will infer that the code references a previous brand convention that was never cleaned up. The brief assumes `TSJ-XXXX` codes — the actual prefix is `J-`. Worth flagging upfront in any buyer conversation. Hardcoded SharePoint integration field on `jobs.sharepoint_url` (mig 1) — a buyer not on SharePoint sees a confusing optional field.
**Effort to make it REAL:** S — fix the regex (`/J-(\d+)/`) and the surrounding comment.
**Red flags:** "Sharepoint URL" field on every job. Plan numbers occasionally look wrong (silent fallback hides it).
**Genuinely good:** 217-migration history is real engineering. ROL/TMP/principal-contractor fields are first-class. Sub-Plans hierarchy is sophisticated.

---

## Component 3 — Rostering & shift management

**Status:** PARTIAL
**Files of record:** [routes/allocations.js](routes/allocations.js), [routes/schedule.js](routes/schedule.js), [routes/bookings.js](routes/bookings.js), [routes/crew.js](routes/crew.js), [routes/worker/shifts.js](routes/worker/shifts.js), [routes/worker/manage.js](routes/worker/manage.js), [services/shiftReminders.js](services/shiftReminders.js)
**Database tables:** `crew_allocations` (mig 10/112/113/142), `bookings` (mig 49/89/92/93/94), `booking_crew`, `booking_vehicles` (mig 146), `booking_dockets`, `booking_documents`, `booking_requirements`, `crew_availability` (mig 57/67), `shift_reminder_log`, `clock_events`
**What works:** Allocations board with day/week/month views (55KB EJS view at `views/allocations/index.ejs`). Conflict detection via [middleware/compliance.js](middleware/compliance.js) `checkAllocationBlocks`. Bulk confirm by date. Auto-equipment-sync — every "Nx TC Crew" requirement spawns a ute row in `booking_vehicles`. Booking lifecycle through unconfirmed → confirmed → green_to_go → in_progress → completed. Worker portal shows weekly shifts plus an always-on "Requests" banner ([routes/worker/shifts.js:189-202](routes/worker/shifts.js:189) handles confirm). Shift reminders fire every 15 min ([server.js:404](server.js:404)), find allocations 23–25h ahead, push via [services/shiftReminders.js](services/shiftReminders.js), deduped via `shift_reminder_log`. Manager dashboard ([routes/worker/manage.js](routes/worker/manage.js)) shows clocked-in count, pending leave, open incidents.
**What's broken or fake:** **Worker has no decline endpoint.** [routes/worker/shifts.js](routes/worker/shifts.js) has `POST /w/shifts/:id/confirm` but no `/decline`. Manager-side `POST /:id/cancel` in [routes/allocations.js:445-457](routes/allocations.js:445) exists but is office-only. A worker who can't make a shift either ghosts it or rings the office. **No auto-reassign on decline / no-show.** **No recurring shifts** — every allocation is per-date. Conflict detection returns reject/allow with no UI listing of which existing alloc caused the conflict.
**Effort to make it REAL:** M for decline endpoint + status flow (~3h). L for auto-reassign (find available + compliance-check + notify, ~6h). M for recurring shifts (frequency field + nightly cron expansion, ~5h).
**Red flags:** Buyer mimics a real workflow — "I can't work Tuesday, let me decline this shift" → button doesn't exist. Buyer attempts "schedule a recurring Monday-morning TC at Wynyard" → no repeat option.
**Genuinely good:** Ute auto-sync is clever. Booking module supports standalone (no parent job) AND job-linked. Tiered portal roles (`traffic_controller<team_leader<supervisor`, mig 144) are enforced live on every request, not just from session ([middleware/workerAuth.js:82-102](middleware/workerAuth.js:82)). Shift-reminder dedup via composite key works.

---

## Component 4 — Worker portal (EJS PWA, not React Native)

**Status:** REAL (with one offline lie)
**Files of record:** [routes/worker/*](routes/worker), [views/worker/*](views/worker), [public/manifest.json](public/manifest.json), [public/worker-sw.js](public/worker-sw.js), [public/js/worker.js](public/js/worker.js), [services/pushNotification.js](services/pushNotification.js)
**Database tables:** `crew_members`, `crew_allocations`, `booking_crew`, `clock_events` (repaired mig 138), `docket_signatures` (mig 57/62/140), `safety_forms`, `swms_acknowledgements`, `crew_swms_grants` (mig 200), `worker_push_subscriptions` (mig 148), `worker_notification_prefs` (mig 201)
**What works:** 22 worker routes covering home, jobs, shifts, clock, dockets, safety, HR self-service, kudos, chat, custom checklists, incidents, manage (for supervisors). Bottom-tab nav with full feature breadth. Dual-source shift list (crew_allocations + booking_crew) with auto-heal on read ([routes/worker/jobs.js:30-57](routes/worker/jobs.js:30)). Lazy alloc binding from booking on first visit. Clock event types: `clock_in | break_start | break_end | clock_out`. Docket signing captures Canvas PNG signature + client signature + breaks + travel. SWMS sign-on with `version_token` (mig 186) — workers re-acknowledge only on meaningful changes (file replace or draft→active), not on title edits ([routes/swms.js:33-39](routes/swms.js:33)). Worker-initiated SWMS access requests with induction metadata. Push subscription via `web-push`/VAPID — keys auto-generated and stored in `system_config`. Tiered portal-role gating on supervisor/team-leader features.
**What's broken or fake:** **Audit-agent miss (corrected):** the original report claimed the offline banner was lying. It isn't. The queue is implemented in [public/js/worker-offline-queue.js](public/js/worker-offline-queue.js) with an IndexedDB store, Blob-based file capture (no base64 roundtrip), retry on `online` event + service-worker `sync` event, and 4xx dead-letter status. Forms opt in via `data-offline-form` ([public/js/worker-offline-form.js](public/js/worker-offline-form.js)). The banner partial only appears when `listPending()` returns rows. Non-idempotent endpoints (timesheets, leave) are deliberately not queued in v1 — that's the only real gap. Old `/w/timesheets` route still exists ([routes/worker/timesheets.js](routes/worker/timesheets.js)) with a fully-functional form but is redirect-shadowed at [server.js:213](server.js:213) — workers who bookmarked the old URL get redirected, but the form itself still posts if called directly.
**Effort to make it REAL:** N/A — already REAL. Extending queue coverage to non-idempotent endpoints with proper idempotency tokens is M, but optional.
**Red flags:** Workers may not realise which forms are queue-eligible vs not (no UI marker). Not a buyer-demo blocker.
**Genuinely good:** SWMS `version_token` re-acknowledgement is a real compliance audit feature. Booking-only workers get their alloc auto-created on visit. Cache strategy is sane (stale-while-revalidate HTML, cache-first static). PWA manifest is real (icons, theme color, splash).

---

## Component 5 — Timesheet & award compliance

**Status:** PARTIAL
**Files of record:** [routes/payroll-runs.js](routes/payroll-runs.js), [routes/payslips-admin.js](routes/payslips-admin.js), [lib/payroll.js](lib/payroll.js), [routes/timesheets.js](routes/timesheets.js)
**Database tables:** `pay_runs` (mig 141, rebuilt 159/160), `pay_run_lines` (mig 141/157/159), `payslips` (mig 137), `employees`, `crew_allocations.shift_type`
**What works:** Traffio "Person Dockets" CSV import via multer ([routes/payroll-runs.js:38-53](routes/payroll-runs.js:38)). Categorises shifts into 8 buckets per MA000020 logic: day_normal / day_ot / day_dt / night_normal / night_ot / night_dt / weekend / public_holiday ([lib/payroll.js:6-22](lib/payroll.js:6)). Different rules per employment type: TFN gets ≤8h normal / 8–10h OT / >10h DT; ABN gets ≤8h normal / >8h OT (no DT); Cash flat-normals ([lib/payroll.js:14-16](lib/payroll.js:14)). Auto-allowances for TFN: travel × distinct work dates, meal × shifts ≥10h. Pay-run approval workflow locks runs after sign-off ([routes/payroll-runs.js:77-79](routes/payroll-runs.js:77)). XLSX export built by hand (zip + XML) at [routes/payroll-runs.js:1361-1396](routes/payroll-runs.js:1361). Internal cost rate $40/hr defaulted (mig 169) and configurable in `system_config`.
**What's broken or fake:** **No Xero / MYOB / Employment Hero / KeyPay export.** Grep returns zero matches for any of those names. Only output is raw bucket XLSX. **July 2025 3.5% award increase not phased in.** Rates are static snapshots at import time — there's no scheduled rate-rotation logic, no `effective_date` on the seeded award rates. ~~PAYG tax calc is stubbed~~ — **CORRECTED**: `payAsYouGo` IS called from [routes/payroll-runs.js:545](routes/payroll-runs.js:545) (employee-level for management runs) and [routes/payroll-runs.js:656](routes/payroll-runs.js:656) (per-line for TFN workers). Audit sub-agent grep missed it. Pay-run "Approvers" list is hardcoded to fall back to specific names if `saadat`/`sajid` not found — buyer-specific.
**Effort to make it REAL:** Xero/MYOB adapters L each (~1 week per integration). EH/KeyPay L. July 2025 phase-in S (add effective_date + bump logic). PAYG S (wire the existing function).
**Red flags:** Buyer asks "show me the Xero export" — there isn't one. Buyer's bookkeeper asks "did you handle the July 2025 increase" — no. Hardcoded `saadat`/`sajid` approver fallback visible in code review.
**Genuinely good:** TFN/ABN/Cash split is real and follows the award structure. Approval lock is correct. The Traffio CSV import is robust.

---

## Component 6 — SWMS library

**Status:** REAL (with auto-renewal gap)
**Files of record:** [routes/swms.js](routes/swms.js), [routes/worker/safety.js](routes/worker/safety.js), [routes/sop-register.js](routes/sop-register.js)
**Database tables:** `swms` (mig 165, expiry mig 166, version_token mig 186), `swms_acknowledgements` (mig 187), `crew_swms_grants`, `crew_swms_access_requests` (mig 200), `sops` (mig 188), `sop_acknowledgements` (mig 189)
**What works:** Dual-mode register — template SWMS (visible to all) vs. job-linked (gated by `crew_swms_grants`). Status: draft / active / archived. Upload via swmsUpload middleware (≤25 MB, PDF/DOCX/XLSX/image). Expiry auto-defaults: 3 months for templates, 6 months for job-linked. `version_token` rotates on file replace or draft→active transition — forces re-ack only on meaningful change. Workers without a grant see a "Request Access" form which captures induction metadata + worker note and pushes notifications to admin/ops/safety. Sign-on stores base64 PNG signature in `data/uploads/swms-signatures` with IP + user-agent. Docx→PDF pre-warmed on upload to avoid cold-start UX stall. SOP register mirrors SWMS 1:1.
**What's broken or fake:** **Auto-renewal not wired.** Mig 166 added `expiry_date` and `last_reminded_at` but no cron job extends expiry. After 6 months a job-linked SWMS goes to "expired" status — workers see it greyed out, no notification fires, admin must edit the DB directly or re-upload. **No job→SWMS mandatory binding UI** — you can attach a SWMS to a job but there's no "this job-type requires these SWMS" pattern.
**Effort to make it REAL:** S — add `sendSwmsRenewalReminders` cron that runs daily, finds SWMS expiring in 30/14/7 days, pushes to office, optionally auto-extends.
**Red flags:** Demo question "what happens 6 months after you sign on a SWMS" → no good answer.
**Genuinely good:** `version_token` is real compliance audit trail. Access-request flow with induction metadata is thoughtful. Docx→PDF prewarm is a nice UX detail.

---

## Component 7 — Ticket / certification expiry tracking

**Status:** REAL
**Files of record:** [services/certExpiryReminders.js](services/certExpiryReminders.js), [middleware/compliance.js](middleware/compliance.js), [routes/crew.js](routes/crew.js), [lib/competencyMap.js](lib/competencyMap.js), [routes/voc-assessments.js](routes/voc-assessments.js)
**Database tables:** `crew_members` (ticket cols mig 3, licence mig 61), `voc_assessments` (mig 215), `cert_expiry_reminder_log` (mig 202), `worker_notification_prefs` (mig 201), `employee_competencies` (mig 38, backfilled mig 195)
**What works:** Daily cron at 7:30 AM ([server.js:429-434](server.js:429)) scans `crew_members` for white-card / first-aid / TC ticket / TI ticket / licence / medical / induction expiry at 30 / 14 / 7-day windows. Push notifications via `sendPushToCrew`. Deduped via `cert_expiry_reminder_log`. Workers can mute the `cert_expiry` notification category in `/w/profile/notifications`. [middleware/compliance.js:32-104](middleware/compliance.js:32) computes expiry status live for each crew member (6 cert types + licence). Crew roster ([routes/crew.js:17-147](routes/crew.js:17)) surfaces compliance flags and offers a 30-day "expiring" filter. VOC assessments fire 30/14/7-day alerts in parallel ([routes/voc-assessments.js](routes/voc-assessments.js)). [lib/competencyMap.js](lib/competencyMap.js) mirrors white-card + TC-licence uploads from `employee_documents` into `employee_competencies` for wallet display.
**What's broken or fake:** Brief asks for ticket-driven *assignment blocking* — [middleware/compliance.js](middleware/compliance.js) `checkAllocationBlocks` does exist and is called by allocations create. Verify in your own demo that an expired-cert worker is actually rejected (the code path exists; I didn't end-to-end test).
**Effort to make it REAL:** N/A — already REAL.
**Red flags:** None for cert tracking itself. (Notifiable-incident mapping — see Component 8 — is a separate issue.)
**Genuinely good:** Batch fatigue fetch in [middleware/compliance.js:110-127](middleware/compliance.js:110) avoids N+1. Dedup table prevents reminder spam. VOC parallel path doesn't pollute the crew_members schema. **Demo this.**

---

## Component 8 — Incident reporting

**Status:** PARTIAL
**Files of record:** [routes/incidents.js](routes/incidents.js), [routes/worker/incidents.js](routes/worker/incidents.js)
**Database tables:** `incidents` (mig 5/34/48), `incident_crew_members` (mig 34), `corrective_actions` (mig 5/170), `activity_log`
**What works:** Admin creates incidents with auto-sequence `incident_number`. Photo upload via multer. Status transitions reported → investigating → resolved → closed. Corrective actions auto-link to incident and spawn a task ([mig 170 in schema](db/schema.js:8071)). Chat thread auto-created per incident. Worker form ([routes/worker/incidents.js:94-151](routes/worker/incidents.js:94)) supports near_miss / traffic_incident / worker_injury / vehicle_damage / public_complaint / environmental / injury / hazard / property_damage / vehicle / other. Multi-photo upload (up to 5). Activity log captures creation/edits.
**What's broken or fake:** **`notifiable_incident` is a checkbox with no logic.** Schema column exists; [routes/incidents.js:113](routes/incidents.js:113) stores the value; nothing computes it. No WHS Act 2011 category mapping. No SafeWork NSW notification. No category enum. No "this incident must be notified within X hours" automation. **Worker form silently drops weather + GPS.** [routes/worker/incidents.js:101-102](routes/worker/incidents.js:101) reads `weather_conditions`, `gps_lat`, `gps_lng` from `req.body` but the INSERT at line 142–147 does not reference those columns — they're never persisted. **No incident → docket → photo evidence linkage** — photos live as a comma-separated `photo_path` text column, not a normalised attachment table.
**Effort to make it REAL:** M — add `notifiable_categories` config + auto-classification trigger + a "send to SafeWork" stub. S — fix the silent weather/GPS drop. L — proper evidence-chain (incident_attachments table, link to job/docket).
**Red flags:** Demo: tick "Notifiable" on an incident, look for follow-up action — there is none. Submit incident from worker portal with GPS captured, then check the DB row — lat/lng are NULL.
**Genuinely good:** Auto-created chat thread + auto-spawned task from corrective action is a real workflow. Multi-photo upload works.

---

## Component 9 — Dockets, photos, evidence chain

**Status:** PARTIAL
**Files of record:** [routes/worker/dockets.js](routes/worker/dockets.js), [routes/dockets-admin.js](routes/dockets-admin.js), [middleware/upload.js](middleware/upload.js)
**Database tables:** `docket_signatures` (mig 57/62/140), `booking_dockets` (mig 51), `booking_documents` (mig 52), `safety_forms` (job-pack forms mig 139)
**What works:** End-to-end worker flow: `/w/dockets` lists today's allocations + past signed dockets; `/w/dockets/sign/:allocationId` renders a Canvas signature pad + client signature + break/travel inputs; POST validates required safety forms (risk_toolbox + team_leader mandatory; vehicle_prestart + tc_prestart + post_shift_vehicle "recommended" with 2-warning gate) before inserting into `docket_signatures` with `signature_data` (base64 PNG), timestamps, `total_hours`. Admin review at [routes/dockets-admin.js:9-103](routes/dockets-admin.js:9) — list with date/type/no-client filters, detail page shows companion safety forms.
**What's broken or fake:** **No link from approved docket to invoice.** `docket_signatures.total_hours` exists; [routes/abergeldie-payments.js](routes/abergeldie-payments.js) never queries it — admin re-uploads a Traffio CSV. **No approval gate.** Detail page at [routes/dockets-admin.js:66-103](routes/dockets-admin.js:66) has no Approve/Reject button, no `approved_at` column, no `ready_for_invoice` flag on docket_signatures. **`/jobs/:id/documents` upload path unclear** — [views/job-documents.ejs](views/job-documents.ejs) exists but I didn't trace a corresponding POST handler; verify before demo.
**Effort to make it REAL:** L — add `approved_at` + `ready_for_invoice` columns + admin approve action + wire abergeldie/invoicing to read approved dockets.
**Red flags:** Buyer signs a test docket → admin opens it → no Approve button. Hours typed twice (once in docket, once in payment sheet).
**Genuinely good:** Lazy crew_allocations creation on booking-shift visit. Required safety-forms gating before docket-sign is a real compliance feature. Canvas-PNG signature + per-line time entries (mig 62) are persisted.

---

## Component 10 — Invoicing & payment claims

**Status:** PARTIAL (and the worst white-label finding)
**Files of record:** [routes/abergeldie-payments.js](routes/abergeldie-payments.js), [routes/compliance.js](routes/compliance.js)
**Database tables:** `abergeldie_payment_sheets` + `abergeldie_payment_sheet_lines` (mig 176, status mig 178, ute lines mig 181), `compliance` with `ready_for_invoice` (mig 75) + `invoiced` (mig 85, 147)
**What works:** CSV-driven payment sheet — one client (Abergeldie), hours grouped by project, fee/hr typed in, PDF generated. Compliance items have a parallel "ready_for_invoice → invoiced + invoice_number" workflow with activity log.
**What's broken or fake:** **The entire invoicing module is hardcoded to one client.** [routes/abergeldie-payments.js:74](routes/abergeldie-payments.js:74): `const CLIENT_NAME = 'Abergeldie'`. The view paths say "Abergeldie Payment Sheet" in titles. There is no clients/rate-cards table. No `rate_per_hour` field on `clients`. No client picker on the upload form. Compliance "invoiced" flag is a flag — it does not generate an invoice PDF or a payment claim document. **No Security of Payment / progress claim / BPC workflow.** Zero matches in the codebase for `payment_claim`, `progress_claim`, `BPC`, `Security of Payment`, `SOPA`.
**Effort to make it REAL:** XL — genericise to multi-client + rate_cards table + invoice PDF template + optional progress-claim format. Realistic 3–4 weeks.
**Red flags:** **Open the Finance section in any buyer demo and the words "Abergeldie Payment Sheet" appear.** Buyer asks "where do I set my client's hourly rate?" — there is no answer.
**Genuinely good:** The compliance `ready_for_invoice` workflow has the right shape — if you genericise the invoicing module, the compliance side bolts on cleanly.

---

## Component 11 — Reporting & analytics

**Status:** REAL — **lead with this in the demo.**
**Files of record:** [routes/reports.js](routes/reports.js), [routes/finance-pnl.js](routes/finance-pnl.js), [routes/safety-reports.js](routes/safety-reports.js), [lib/safetyMetrics.js](lib/safetyMetrics.js)
**Database tables:** `crew_members`, `crew_allocations`, `timesheets`, `jobs`, `job_budgets`, `cost_entries`, `incidents`, `corrective_actions`, `compliance`, `swms_acknowledgements`, `safety_quiz_attempts`, `toolbox_attendance`, `safety_update_reads`, `activity_log`
**What works:** Crew utilisation (alloc_count, days_allocated, total_hours, OT, fatigue-risk >50h/wk) computed live from real tables ([routes/reports.js:20-49](routes/reports.js:20)). Job health dashboard with overdue / over-budget / stale jobs against `jobs + job_budgets + cost_entries`. Financial P&L by compliance parent plan ([routes/finance-pnl.js:36](routes/finance-pnl.js:36)) rolls up hours_spent × internal_hourly_rate ($40/hr default from `system_config`) + council fees = labour cost + profit. Weighted safety composite per worker ([lib/safetyMetrics.js:38-130](lib/safetyMetrics.js:38)): SWMS 40% + Quiz 25% + Toolbox 20% + Update 15%, with null-rate renormalisation so a missing category doesn't penalise. Disengagement threshold = 60%. Incident aggregation by month/type. CSV exports preserve sub-metrics. Date-range filtering applied consistently.
**What's broken or fake:** None identified.
**Effort to make it REAL:** N/A.
**Red flags:** None.
**Genuinely good:** The safety composite is genuinely thoughtful — null-rate renorm + transparent weights. The P&L separates council fees from labour cost. **This is the part of the demo that earns trust.**

---

## Component 12 — Compliance & evidence export (Avetta / ISNetworld)

**Status:** MISSING
**Files of record:** none — grep across the entire repo for `avetta` / `isnetworld` / `evidence pack` / `compliance pack` returns **0 matches**.
**Database tables:** N/A — the supporting data exists (`activity_log` mig 2/119, `compliance`, `swms_acknowledgements`, `site_audits` mig 99/100/101, `corrective_actions`) but no export pipeline assembles them.
**What works:** The raw materials are all in the DB. [middleware/audit.js:19](middleware/audit.js:19) `logActivity` is called from 245+ sites — the audit trail is dense and real. Site audits (FORM-663, mig 99) can be individually printed. CSV exports exist at [routes/exports.js](routes/exports.js) for jobs, timesheets, incidents, and safety-engagement. PDF tooling exists ([lib/pdf-render.js](lib/pdf-render.js), [lib/pdfMerge.js](lib/pdfMerge.js), [lib/pdf/tgsRiskAssessmentPdf.js](lib/pdf/tgsRiskAssessmentPdf.js), [lib/pdf/vocCertificatePdf.js](lib/pdf/vocCertificatePdf.js)).
**What's broken or fake:** No "compliance pack" or "evidence pack" endpoint anywhere. No batch site-audit export. No XML/JSON adapter to Avetta or ISNetworld import specs.
**Effort to make it REAL:** L–XL — design the pack schema (which fields → which Avetta XML), assemble per-tenant evidence pipeline, ship a `/compliance-pack` endpoint. ~2–3 weeks if you pick one (Avetta) and skip the other.
**Red flags:** **Don't claim Avetta/ISN integration on the website.** Buyer with a current Avetta account will ask immediately.
**Genuinely good:** The 245+ `logActivity` calls and `before_value`/`after_value` audit columns mean a future export will have real data to draw from.

---

## Component 13 — Multi-tenancy & data isolation

**Status:** PARTIAL — architecturally mature, operationally untested
**Files of record:** [lib/tenant-db.js](lib/tenant-db.js), [middleware/tenant.js](middleware/tenant.js), [lib/admin-db.js](lib/admin-db.js), [scripts/check-raw-db.js](scripts/check-raw-db.js), [tests/cross-tenant/](tests/cross-tenant)
**Database tables:** `tenants` table **does not exist yet** (Phase 2 Prompt 02.A creates it). No `tenant_id` column on any business table yet.
**What works:** The wrapper architecture is the most impressive thing in the codebase. [lib/tenant-db.js:79-107](lib/tenant-db.js:79) `assertScoped` inspects every prepared statement: SELECT/UPDATE/DELETE must contain the `tenant_id` substring; INSERT must include `tenant_id` in its column list. Whitelisted global tables for unscoped access. [lib/admin-db.js](lib/admin-db.js) is the *intentional* bypass for a future atomis admin portal (Phase 4) — guarded by an allowlist enforced by [scripts/check-raw-db.js](scripts/check-raw-db.js). Cross-tenant leak tests pass against a sample table. PRAGMA foreign_keys ON ([db/database.js:10](db/database.js:10)).
**What's broken or fake:** **The wrapper is load-bearing on nothing.** `npm run lint:tenant` reports 119 raw `getDb()` violations across the codebase — every route, every middleware, every service still uses the raw handle. No business table has `tenant_id`. No tenants table. Sessions are a single shared SQLiteStore (cookie-domain isolation isn't designed yet). Audit log is explicitly global (a deliberate decision in the whitelist, but cross-tenant by design). All branding hardcoded to "Atomis" — manifest, header, mark SVGs.
**Effort to make it REAL:** XL. Phase 2 = add tenant_id to every business table + index + backfill = 2–3 weeks of pure migration work. Phase 3 = subdomain lookup + cookie-domain sessions + tenant-scoped storage paths = 1–2 weeks. Phase 4 = atomis admin portal = 1 week.
**Red flags:** Buyer asks "if I have two depots can I separate them?" — answer is "not yet". Branding hardcoded.
**Genuinely good:** **This is the most thoughtful piece of engineering in the codebase.** The wrapper, the lint script, the cross-tenant test fixture, and the explicit Phase 0/2/3/4 plan are exactly how you should set up a multi-tenant migration. It just hasn't happened yet. If you sell single-tenant deployments today (one Railway service per customer, one SQLite file each), you can ship this week — the multi-tenant story is for later.

---

## Component 14 — Trust & commercial signals

**Status:** PARTIAL
**Files of record:** [litestream.yml](litestream.yml), [BACKUPS.md](BACKUPS.md), [routes/exports.js](routes/exports.js), [.env.example](.env.example), [middleware/csrf.js](middleware/csrf.js), [middleware/upload.js](middleware/upload.js)
**What works:** **Litestream backup is real production-grade.** 1-second WAL replication to S3-compatible storage, 30-day retention, point-in-time restore. Documented in [BACKUPS.md](BACKUPS.md). Data exports for jobs + timesheets + incidents + safety engagement at [routes/exports.js](routes/exports.js), audit-logged. CSRF protection across the app ([middleware/csrf.js](middleware/csrf.js)). Helmet on (CSP disabled because Tailwind CDN). Login rate-limited. Upload allowlist (jpeg/jpg/png/gif/pdf/webp, 25MB cap, random filenames). PIN lockout per-account, persistent. No hardcoded secrets in the repo (sweep confirmed).
**What's broken or fake:** **No SSO / SAML / OIDC / OAuth.** No 2FA / TOTP / passkeys. `SESSION_SECRET` auto-generated if unset — all sessions invalidate on restart ([server.js:120](server.js:120)). No "request my data" GDPR-style export modal. No "log out other sessions" UI. `/forgot-password` and `/w/forgot-pin` not rate-limited (email-spam DoS vector).
**Effort to make it REAL:** M for 2FA. L for SSO/SAML.
**Red flags:** Enterprise buyer asks for SAML — no. Asks for 2FA — no.
**Genuinely good:** Litestream + retention + restore = enterprise-grade backup story. Demo this. The `.env.example` is clean — no committed secrets.

---

## Component 15 — Design polish

**Status:** REAL
**Files reviewed (sample of 10):** [views/dashboard.ejs](views/dashboard.ejs), [views/worker/home.ejs](views/worker/home.ejs), [views/jobs/show.ejs](views/jobs/show.ejs), [views/worker/booking-detail.ejs](views/worker/booking-detail.ejs), [views/worker/chat.ejs](views/worker/chat.ejs), [views/crew/show.ejs](views/crew/show.ejs), [views/partials/sidebar.ejs](views/partials/sidebar.ejs), [views/partials/header.ejs](views/partials/header.ejs), [views/worker/layout.ejs](views/worker/layout.ejs), [public/css/custom.css](public/css/custom.css)
**What works:** 14 distinct "No X yet" empty states in [views/jobs/show.ejs](views/jobs/show.ejs) alone. Tailwind responsive breakpoints (`sm:` / `md:` / `lg:`) used consistently. Worker portal has a dark-glass theme. Skeleton loaders in the notification panel ([views/partials/header.ejs:40-43](views/partials/header.ejs:40)). Birthday banner with confetti animation on dashboard. Mobile-first worker portal with bottom-tab nav. iOS-safe-area-inset CSS in [public/css/custom.css](public/css/custom.css). Touch targets ≥44px.
**What's broken or fake:** Minor — worker portal "offline" banner promises a sync that doesn't happen (see Component 4). No major design holes.
**Effort to make it REAL:** S — remove the offline banner.
**Red flags:** None at the polish layer.
**Genuinely good:** The empty-state messaging is consistent across modules — that alone separates this from 80% of internal tools. Mobile responsiveness is real, not a TODO.

---

## Notes & caveats (sub-agent corrections)

Five sub-agent findings were checked and corrected during synthesis and Phase A implementation:

1. **The Components 1–3 agent reported `routes/tgs-risk-assessments.js` may be missing.** It exists ([routes/tgs-risk-assessments.js](routes/tgs-risk-assessments.js)), backed by mig 210 and [lib/pdf/tgsRiskAssessmentPdf.js](lib/pdf/tgsRiskAssessmentPdf.js). The module is REAL; sub-agent search missed it.
2. **The Components 10–12 agent reported `lib/pdfMerge.js` and `lib/pdf-render.js` do not exist.** Both exist ([lib/pdfMerge.js](lib/pdfMerge.js), [lib/pdf-render.js](lib/pdf-render.js)). Tooling for a future Avetta/ISN compliance pack is in place; the *endpoint* is what's missing.
3. **The security agent flagged `pdfjs-dist` for vulnerability check.** Installed version is `^3.11.174` (per `package.json`), which is post-CVE-2021-44419 (fixed in 3.4.120). No action required.
4. **Component 4 said the offline banner was a lie.** It isn't — see corrected entry above. There's a full IndexedDB-backed queue at [public/js/worker-offline-queue.js](public/js/worker-offline-queue.js) with retry, dead-letter, and form-level opt-in.
5. **Component 3 said workers can't decline shifts.** Half-right — decline DOES exist via [routes/worker/jobs.js:522](routes/worker/jobs.js:522) (`POST /w/jobs/:id/respond` action=decline) and [routes/worker/jobs.js:770](routes/worker/jobs.js:770) for booking-only. The actual gap was a missing parallel on `POST /w/shifts/:id/decline` — added in Phase A.
6. **No-one flagged the named T&S admin auto-seed at [db/schema.js:10806-10821](db/schema.js:10806).** Two startup blocks (ensureUsers + dev-mode seed) recreated `suhail.a / saadat / savanah / taj` on every boot, outside the migration system. Caught during synthesis and gated in Phase A.

Two genuinely surprising findings that the brief's stack assumption would have hidden:

- **There is no AI.** Zero `anthropic` calls anywhere. No prompts. No LLM features.
- **All "cron" is `setInterval` in the single Node process.** If the process crashes and Railway restarts, intervals reset. Two replicas = double-fire. No queue, no observability beyond `console.log`.
