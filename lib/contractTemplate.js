// The T&S Casual Employment Agreement (Traffic Controller — Civil
// Construction) as structured data. Single source of truth: the public
// signing page, the PDF renderer and the admin preview all render from
// this file, so what the worker reads, what they sign and what lands in
// the archive can never drift apart.
//
// Clause text is transcribed verbatim from the reviewed agreement
// (TS-Casual-Employment-Agreement-Traffic-Control). Do not paraphrase or
// "tidy" wording here without legal review — the drafting choices
// (casual status, s.545A set-off, award references, consent vs waiver)
// are deliberate. See the onboarding-pack review notes.
//
// {{PLACEHOLDER}} tokens are resolved from a contract's fields_json via
// interpolate(). **bold** markers survive into both renderers: the HTML
// view converts them to <strong>, the PDF strips them and uses them as
// emphasis boundaries.

const TEMPLATE_VERSION = '1.0';

// ── Company constants ────────────────────────────────────────────────
const COMPANY = {
  name: 'T&S Traffic Control Pty Ltd',
  abn: '58 655 958 320',
  address: '62 Waterloo Rd, Greenacre NSW 2190',
};

// ── Schedule A — wage panel (Award MA000020, casual, incl. 25% loading
//    and industry allowance) ─────────────────────────────────────────
// Source: Fair Work Ombudsman Pay Guide MA000020 (doc G00203138),
// published 2 Jul 2026, effective first full pay period on/after
// 1 Jul 2026 — "Casual — Civil construction" tables (pages 76-77).
// Column mapping: sat2 = Sat before noon first 2h (1.5×) · satGt2 =
// Sat after 2h / after noon (2×) · sun = Sunday (2×) · pubHol (2.5×) ·
// nightLt5 = afternoon/night <5 in a row (1.5×) · nightPerm = permanent
// night (1.3×) · night5 = 5+ in a row Mon-Fri (1.15×). Loading and
// penalty are cumulative on the permanent ordinary rate (= base ÷ 1.25).
//
// When the next Annual Wage Review lands, update this grid + ALLOWANCES
// and the FIELD_DEFS default for RATES_EFFECTIVE_DATE. Existing contracts
// are safe: every contract snapshots ratesSnapshot() into its fields_json
// at generation, so old documents keep rendering their own rates.
const RATES_EFFECTIVE = '1 July 2026';
const TIERS = {
  1: { level: 'CW1(a)', role: 'Trainee TC',         base: 35.55, sat2: 49.77, satGt2: 63.99, sun: 63.99, pubHol: 78.21, nightLt5: 49.77, nightPerm: 44.08, night5: 39.82 },
  2: { level: 'CW1(c)', role: 'Traffic Controller', base: 36.66, sat2: 51.33, satGt2: 65.99, sun: 65.99, pubHol: 80.66, nightLt5: 51.33, nightPerm: 45.46, night5: 41.06 },
  3: { level: 'CW2',    role: 'Advanced TC / TMA',  base: 37.99, sat2: 53.18, satGt2: 68.38, sun: 68.38, pubHol: 83.57, nightLt5: 53.18, nightPerm: 47.10, night5: 42.55 },
  4: { level: 'CW3',    role: 'Team Leader',        base: 39.03, sat2: 54.64, satGt2: 70.25, sun: 70.25, pubHol: 85.86, nightLt5: 54.64, nightPerm: 48.39, night5: 43.71 },
  5: { level: 'CW4',    role: 'Senior Team Leader', base: 40.19, sat2: 56.26, satGt2: 72.34, sun: 72.34, pubHol: 88.41, nightLt5: 56.26, nightPerm: 49.83, night5: 45.01 },
  6: { level: 'CW5',    role: 'Site Supervisor',    base: 41.35, sat2: 57.89, satGt2: 74.43, sun: 74.43, pubHol: 90.97, nightLt5: 57.89, nightPerm: 51.27, night5: 46.31 },
};

// Award allowances (same pay guide, allowances section).
const ALLOWANCES = {
  fares: '22.41',           // Fares and travel, per day worked
  firstAidHigher: '6.38',   // First aid — higher than minimum qualifications
};

// The rates a contract locks in at generation time. Stored inside
// fields_json so a signed agreement always re-renders with the rates it
// was signed on, no matter how many wage reviews land afterwards.
function ratesSnapshot() {
  return { tiers: TIERS, fares: ALLOWANCES.fares, first_aid_higher: ALLOWANCES.firstAidHigher, effective: RATES_EFFECTIVE };
}
// A contract's own snapshot when it has one, today's rates otherwise
// (contracts generated before snapshotting existed).
function ratesFor(fields) {
  const snap = fields && fields.RATES_SNAPSHOT;
  return (snap && snap.tiers) ? snap : ratesSnapshot();
}

const PENALTY_NOTES = [
  'Saturday: first 2 hours 1.5× · thereafter (or after 12pm) 2×',
  'Sunday: 2× · Public holiday: 2.5×',
  'Night <5 (occasional / fewer than 5 consecutive night shifts): 1.5×',
  'Night permanent (rostered permanent-night arrangement): 1.3×',
  'Night 5+ (continuous, 5 or more in a row Mon–Fri): 1.15×',
];

const PENALTY_FOOTNOTE = 'Most T&S night shifts attract the **Night <5** rate. The Night Perm. rate applies only where you are on a rostered permanent-night arrangement.';

// ── Schedule B — acknowledgements. Each is stored as its own timestamped
//    row when ticked (contract_acknowledgements). Keys are stable ids —
//    never renumber existing keys once contracts have been signed. ─────
const ACKNOWLEDGEMENTS = [
  { key: 'read_full',        label: 'I have read this Agreement in full and I understand it.' },
  { key: 'casual_status',    label: 'I understand I am employed as a **casual**, that there is **no guarantee of hours or ongoing work**, and that I am not entitled to paid annual leave, paid personal/carer’s leave or redundancy pay.' },
  { key: 'casual_loading',   label: 'I understand my hourly rates include a **25% casual loading** in place of those entitlements.' },
  { key: 'fwis_ceis',        label: 'I have received the **Fair Work Information Statement** and the **Casual Employment Information Statement**.' },
  { key: 'licences_genuine', label: 'I confirm all licences, tickets, qualifications and clearances I have provided are current and genuine, and I will notify T&S in writing within 24 hours of any change.' },
  { key: 'right_to_work',    label: 'I confirm I am legally entitled to work in Australia.' },
  { key: 'whs',              label: 'I agree to comply with all T&S and client WHS requirements, policies and site rules.' },
  { key: 'daa_testing',      label: 'I consent to **drug and alcohol testing** as described in clause 13.' },
  { key: 'privacy',          label: 'I consent to T&S collecting, holding and disclosing my personal information as described in clause 23, including to clients, regulators and the Long Service Corporation.' },
  { key: 'preexisting',      label: 'I have disclosed any pre-existing injury, illness or condition relevant to the duties in clause 5, and I understand the consequences of non-disclosure under clause 25.2.' },
  { key: 'electronic_docs',  label: 'I consent to receiving employment documents and notices **electronically**.' },
  { key: 'esign',            label: 'I agree that my electronic signature below has the same legal effect as a handwritten signature, under the *Electronic Transactions Act 2000* (NSW).' },
  { key: 'questions',        label: 'I have had the opportunity to ask questions and to seek independent advice before signing.' },
];

// ── Wizard field definitions ─────────────────────────────────────────
// group: where the field renders in the generate wizard.
// The "policy" defaults carry the values suggested in the legal review's
// open-items table; they are editable per contract and the chosen value
// is snapshotted into fields_json.
const FIELD_DEFS = [
  // Worker (prefilled from the employee record, editable)
  { key: 'WORKER_FULL_NAME',   label: 'Worker full legal name', group: 'worker', required: true },
  { key: 'WORKER_DOB',         label: 'Date of birth',          group: 'worker', required: true, type: 'date', hint: 'Also used as the identity check on the signing page.' },
  { key: 'WORKER_ADDRESS',     label: 'Residential address',    group: 'worker', required: true },
  { key: 'WORKER_MOBILE',      label: 'Mobile',                 group: 'worker', required: true },
  { key: 'WORKER_EMAIL',       label: 'Email',                  group: 'worker', required: true, type: 'email', hint: 'The signing link is sent here.' },
  // Engagement
  { key: 'START_DATE',         label: 'Commencement date',      group: 'engagement', required: true, type: 'date' },
  { key: 'TIER',               label: 'Tier (1–6)',        group: 'engagement', required: true, type: 'tier' },
  { key: 'POSITION_TITLE',     label: 'Position title',         group: 'engagement', required: true, hint: 'Defaults from the tier; override if needed.' },
  { key: 'REPORTS_TO',         label: 'Reports to',             group: 'engagement', required: true, default: 'the Operations Manager' },
  { key: 'WORK_AREA',          label: 'Work area',              group: 'engagement', required: true, default: 'the Sydney metropolitan area and surrounding regions of NSW' },
  // Policy terms (legal-review open items — confirm once, then reuse)
  { key: 'MIN_ENGAGEMENT',            label: 'Minimum engagement (hours)',    group: 'policy', required: true, default: '4' },
  { key: 'CANCELLATION_NOTICE',       label: 'Worker cancellation notice',    group: 'policy', required: true, default: '12 hours' },
  { key: 'TS_CANCELLATION_NOTICE',    label: 'T&S cancellation notice',       group: 'policy', required: true, default: '4 hours' },
  { key: 'PAY_FREQUENCY',             label: 'Pay frequency',                 group: 'policy', required: true, default: 'weekly', options: ['weekly', 'fortnightly'] },
  { key: 'RATES_EFFECTIVE_DATE',      label: 'Rates effective date',          group: 'policy', required: true, default: RATES_EFFECTIVE, hint: 'The date the Schedule A wage panel took effect (FWO pay guide).' },
  { key: 'BOOKING_SYSTEM',            label: 'Booking system name',           group: 'policy', required: true, default: 'the T&S booking system' },
  // Allowances (optional — rows are omitted from Schedule A3 when blank)
  { key: 'FIRST_AID_STD',             label: 'First aid allowance — standard ($/day)', group: 'allowances', required: false, default: '4.03', hint: 'Award minimum-qualification rate ($4.03 from 1 Jul 2026). Blank omits the row.' },
  { key: 'ADDITIONAL_ALLOWANCE',      label: 'Additional allowance — name',   group: 'allowances', required: false },
  { key: 'ADDITIONAL_ALLOWANCE_RATE', label: 'Additional allowance — rate',   group: 'allowances', required: false },
  { key: 'ADDITIONAL_ALLOWANCE_NOTES',label: 'Additional allowance — notes',  group: 'allowances', required: false },
  // Super (prefilled from the latest super record when present)
  { key: 'SUPER_FUND_NAME',      label: 'Super fund',        group: 'super', required: false, default: 'Stapled fund — to be confirmed with the ATO' },
  { key: 'SUPER_MEMBER_NUMBER',  label: 'Member number',     group: 'super', required: false, default: '—' },
  // T&S signatory
  { key: 'TS_SIGNATORY_NAME',     label: 'T&S signatory — name',     group: 'signatory', required: true },
  { key: 'TS_SIGNATORY_POSITION', label: 'T&S signatory — position', group: 'signatory', required: true, default: 'Director' },
];

// ── Interpolation ────────────────────────────────────────────────────
function interpolate(text, fields) {
  return String(text).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, key) => {
    const v = fields[key];
    return v == null || v === '' ? m : String(v);
  });
}

// ── The agreement body ───────────────────────────────────────────────
// Every section: { num, heading, clauses: [string] }. Sub-points are kept
// inside their clause string with newlines so pagination can keep a
// clause's lead-in with its first points.
function sections(fields) {
  const snapTiers = ratesFor(fields).tiers;
  const f = Object.assign({
    COMPANY_ABN: COMPANY.abn,
    COMPANY_ADDRESS: COMPANY.address,
    AWARD_CLASSIFICATION: (snapTiers[Number(fields.TIER)] || {}).level || '{{AWARD_CLASSIFICATION}}',
  }, fields);
  const t = (s) => interpolate(s, f);

  return [
    {
      num: 1, heading: 'Offer of casual employment',
      clauses: [
        t('1.1 T&S offers you employment on a **casual basis** in the position of **{{POSITION_TITLE}}**, classified at **{{AWARD_CLASSIFICATION}}** (Tier {{TIER}}) under the *Building and Construction General On-site Award 2020* (MA000020) — "the Award".'),
        t('1.2 This Agreement takes effect on the commencement date above and continues until ended under clause 24. It replaces any earlier agreement, offer, discussion or representation (written or verbal) about your employment with T&S.'),
        t('1.3 Your employment is subject to and does not displace the Award, the *Fair Work Act 2009* (Cth) and the National Employment Standards ("NES"). Where any term of this Agreement is less favourable than the Award or the NES, the Award or NES applies to the extent of the inconsistency, and the rest of this Agreement continues to operate.'),
      ],
    },
    {
      num: 2, heading: 'Nature of casual employment',
      clauses: [
        t('2.1 You are employed as a **casual employee**. This means:\n\n(a) there is **no firm advance commitment** by T&S to continuing and indefinite work according to an agreed pattern of work, and no firm advance commitment by you to provide such work;\n\n(b) T&S is **not obliged to offer you any work**, and you are **not obliged to accept** any work that is offered;\n\n(c) you are engaged and paid **on a shift-by-shift basis**. Each shift you accept and work is a separate engagement;\n\n(d) work may be **irregular, intermittent and unpredictable**, and may vary in the number of hours, the days, the start and finish times, and the location;\n\n(e) you have **no guaranteed minimum number of hours or shifts** in any day, week, month or year, and no expectation of ongoing work;\n\n(f) you may work for other employers, provided you comply with clauses 13, 20 and 21;\n\n(g) you are **not entitled** to paid annual leave, paid personal/carer’s leave, paid compassionate leave, redundancy pay, or payment for public holidays not worked. You **are** entitled to the NES entitlements that apply to casuals, including unpaid carer’s leave, unpaid compassionate leave, paid family and domestic violence leave, community service leave, unpaid parental leave (where eligible), and the right to be absent on a public holiday where it is reasonable to refuse a request to work.'),
        t('2.2 Nothing in this Agreement is a promise, representation or expectation of future work. Any pattern that emerges in the shifts you are offered is the result of operational need only and does not create a firm advance commitment.'),
      ],
    },
    {
      num: 3, heading: 'Casual loading and set-off',
      clauses: [
        t('3.1 The hourly rates in **Schedule A** include a **25% casual loading**, paid instead of the entitlements listed in clause 2.1(g).'),
        t('3.2 If it is later found or determined that you were not a casual employee for all or part of your employment, then to the maximum extent permitted by law (including s.545A of the *Fair Work Act 2009*), the casual loading paid to you is to be **set off against, and taken to have satisfied**, any claim for entitlements you would have received had you been a permanent employee, and you agree that T&S may claim to reduce any such liability by the amount of loading already paid.'),
        t('3.3 Payments made to you above the Award minimum (including any over-Award rate, allowance or bonus) may be applied by T&S in satisfaction of any Award or NES monetary obligation arising in the same pay period, to the extent permitted by law.'),
      ],
    },
    {
      num: 4, heading: 'Casual Employment Information Statement and employee choice',
      clauses: [
        t('4.1 T&S will give you the **Fair Work Information Statement** and the **Casual Employment Information Statement** ("CEIS") at the start of your employment, and will give you the CEIS again at the intervals required by the *Fair Work Act 2009*.'),
        t('4.2 If you have been employed for at least **6 months** (or **12 months** if T&S is a small business employer) and you believe you no longer meet the definition of a casual employee, you may give T&S written notification under the **employee choice pathway** that you wish to change to full-time or part-time employment. T&S will respond in writing within the timeframe required by the Act. Notification does not by itself change your employment status.'),
      ],
    },
    {
      num: 5, heading: 'Position, duties and reporting',
      clauses: [
        t('5.1 Your core duties include, without limitation:\n\n(a) implementing traffic control plans (TCPs) and traffic guidance schemes as approved and issued for the site;\n(b) setting out, monitoring, adjusting and removing signage, cones, barriers, delineation and other traffic control devices;\n(c) manual traffic control (stop/slow), portable traffic control device operation, and where authorised, TMA/shadow vehicle operation;\n(d) conducting and recording pre-start checks, site risk assessments, SWMS sign-on and toolbox talks;\n(e) monitoring and reporting site hazards, incidents, near misses, plan deviations and public complaints;\n(f) maintaining the condition, cleanliness and security of T&S vehicles, plant and equipment issued to you;\n(g) completing all site paperwork, digital forms, diaries and timesheets accurately and on time;\n(h) any other lawful and reasonable duty within your skill, competence, licensing and training.'),
        t('5.2 You report to **{{REPORTS_TO}}** and to the site supervisor, team leader or client representative nominated for each shift.'),
        t('5.3 You may be required to work at **any site within {{WORK_AREA}}**, and to travel between sites during a shift.'),
      ],
    },
    {
      num: 6, heading: 'Offer and acceptance of shifts',
      clauses: [
        t('6.1 Shifts are offered through **{{BOOKING_SYSTEM}}** (currently Traffio) and/or by phone, SMS or the T&S worker portal. You must keep your availability current in the system.'),
        t('6.2 Accepting a shift is a commitment to attend. Once you accept a shift you must:\n\n(a) attend the correct site, on time, fit for work and in full uniform and PPE;\n(b) sign on and sign off in the system as directed;\n(c) not leave site before the shift ends without authorisation from your supervisor or the T&S control room.'),
        t('6.3 If you cannot attend an accepted shift, you must notify the T&S control room **as soon as you become aware**, and in any event **no later than {{CANCELLATION_NOTICE}} before the rostered start time**, by phone (not text or email alone).'),
        t('6.4 Repeated failure to attend accepted shifts, or failure to give notice, may result in fewer shifts being offered and may lead to your engagement being ended under clause 24.'),
      ],
    },
    {
      num: 7, heading: 'Hours of work, minimum engagement and shift cancellation',
      clauses: [
        t('7.1 Your hours will vary. You may be required to work days, nights, weekends, public holidays and shifts of varying length, subject to the Award and to reasonable fatigue-management limits.'),
        t('7.2 **Minimum engagement:** where you attend a shift, you will be paid for a minimum of **{{MIN_ENGAGEMENT}} hours**, or the applicable Award minimum engagement, whichever is greater.'),
        t('7.3 **Shift cancellation by T&S:** if T&S cancels a shift with less than **{{TS_CANCELLATION_NOTICE}}** notice, or you attend site and are stood down on arrival through no fault of your own, you will be paid in accordance with the Award and any applicable T&S policy. No payment is due where the cancellation results from your own conduct, non-attendance, unfitness for work, or failure to hold a required licence or ticket.'),
        t('7.4 **Breaks:** breaks are taken in accordance with the Award and site requirements. Where the nature of traffic control means a break cannot be taken at the scheduled time, you must notify your supervisor and record the actual break taken.'),
        t('7.5 **Fatigue:** you must not accept or continue a shift if doing so would leave you unfit to work or to drive safely. You must declare to the control room any work performed for another employer that may affect your fitness for a T&S shift.'),
      ],
    },
    {
      num: 8, heading: 'Rates of pay',
      clauses: [
        t('8.1 You will be paid the applicable hourly rate for your tier as set out in **Schedule A**, plus applicable penalty rates, loadings and allowances.'),
        t('8.2 Penalty rates are calculated on the ordinary hourly rate for your classification, with the casual loading and the applicable penalty applied **cumulatively (not compounded)**, in accordance with the Award.'),
        t('8.3 Rates in Schedule A are current as at **{{RATES_EFFECTIVE_DATE}}** and will be updated to reflect Annual Wage Review outcomes and any Award variation. Updated rate schedules issued by T&S replace Schedule A without the need to re-sign this Agreement, provided the rates are no less than the Award minimum.'),
        t('8.4 You will be paid **{{PAY_FREQUENCY}}** by electronic funds transfer to the account you nominate. A payslip will be issued within one working day of payment.'),
        t('8.5 Time is recorded and paid in accordance with the sign-on/sign-off records in the booking system, cross-checked against approved site records. Where there is a discrepancy, T&S will investigate and correct any underpayment promptly.'),
      ],
    },
    {
      num: 9, heading: 'Allowances',
      clauses: [
        t('9.1 The allowances in **Schedule A** apply in accordance with the Award and the conditions stated for each allowance.'),
        t('9.2 The **fares and travel allowance** is an all-purpose daily allowance paid for each day worked. It is not a reimbursement of actual travel costs, and no additional travel payment applies unless required by the Award.'),
        t('9.3 **First aid allowance** is payable only where T&S has appointed you as a first aid officer for the shift and you hold a current qualification.'),
        t('9.4 Allowances are itemised separately on your payslip.'),
      ],
    },
    {
      num: 10, heading: 'Superannuation',
      clauses: [
        t('10.1 T&S will make superannuation contributions on your behalf at the rate required by superannuation guarantee legislation, into your chosen complying fund, or your stapled fund if you do not choose one.'),
        t('10.2 Your nominated fund: **{{SUPER_FUND_NAME}}** · Member number: **{{SUPER_MEMBER_NUMBER}}**'),
      ],
    },
    {
      num: 11, heading: 'Portable long service (NSW)',
      clauses: [
        t('11.1 T&S will register you with, and report your days worked to, the **Long Service Corporation** under the *Building and Construction Industry Long Service Payments Act 1986* (NSW), where you perform work in the NSW building and construction industry.'),
        t('11.2 You must promptly provide any information T&S reasonably requires for this purpose, and must keep your own contact details with the Long Service Corporation up to date.'),
      ],
    },
    {
      num: 12, heading: 'Licences, tickets, competencies and clearances',
      clauses: [
        t('12.1 You must hold, maintain and be able to produce on request, at all times during your employment:\n\n(a) a current **Construction Induction Card (White Card)**;\n(b) a current **TfNSW Traffic Controller** authorisation card (and where your role requires it, **Implement Traffic Control Plans (ITCP)**, **Prepare Work Zone Traffic Management Plan (PWZ)** or equivalent authorisation);\n(c) a current **Australian driver licence** of the class required for the vehicles you operate, free of any restriction that prevents you performing your duties;\n(d) any additional site-, client- or council-specific inductions, cards or clearances required for the work;\n(e) the right to work in Australia (see clause 22).'),
        t('12.2 You must notify the T&S HR team **in writing within 24 hours** if any of the above is suspended, cancelled, expired, downgraded, subject to conditions, or is at risk of any of these — including any loss or suspension of your driver licence, accumulation of demerit points putting your licence at risk, or any charge or conviction relevant to your duties.'),
        t('12.3 You must not perform any work for which you are not currently licensed, ticketed, authorised, trained or competent.'),
        t('12.4 If you cannot produce a current required licence or ticket, T&S may stand you down without pay until you do. T&S is not obliged to offer you shifts during any such period.'),
        t('12.5 Where T&S pays for a course, ticket, renewal or clearance on your behalf, the arrangements for that payment (including any repayment if you leave within an agreed period) will be set out in a **separate written agreement** signed by you at the time. No repayment obligation arises under this Agreement alone.'),
      ],
    },
    {
      num: 13, heading: 'Fitness for work — drugs and alcohol',
      clauses: [
        t('13.1 You must attend every shift **fit for work**, and must not attend or remain at work while affected by alcohol or by any drug (including prescription or over-the-counter medication) that may impair your ability to work safely.'),
        t('13.2 You consent to **drug and alcohol testing** (including pre-employment, random, for-cause, post-incident and site-mandated testing) conducted by T&S or by a client, in accordance with the T&S Drug and Alcohol Policy and applicable site rules.'),
        t('13.3 A positive result, a refusal to be tested, or an attempt to interfere with a test, will be treated as serious misconduct and may result in immediate removal from site and termination.'),
        t('13.4 You must notify your supervisor before commencing work if you are taking any medication that carries a warning about operating machinery, driving, or drowsiness.'),
      ],
    },
    {
      num: 14, heading: 'Work health and safety',
      clauses: [
        t('14.1 You must:\n\n(a) take reasonable care for your own health and safety and that of others, including the travelling public;\n(b) comply with all reasonable WHS instructions, policies, SWMS, TCPs and site rules of T&S and of the client and principal contractor;\n(c) not commence work unless a valid, approved traffic control plan or traffic guidance scheme is in place, and immediately stop and escalate if site conditions render the plan unsafe or unworkable;\n(d) report **all** incidents, injuries, near misses, property damage, public complaints and hazards to your supervisor and to the T&S control room **before the end of the shift**, and complete the required incident report;\n(e) participate in any investigation, return-to-work process or rehabilitation program required.'),
        t('14.2 You must not engage in horseplay, use a mobile phone for personal purposes while performing traffic control duties, or wear earphones or headphones on site.'),
        t('14.3 T&S maintains workers compensation insurance. You must report any work-related injury immediately so that a claim can be lodged.'),
      ],
    },
    {
      num: 15, heading: 'PPE and uniform',
      clauses: [
        t('15.1 T&S will issue you with required PPE and uniform. You must wear the full T&S uniform and all required PPE (including compliant high-visibility clothing appropriate to the time of day, safety footwear, hard hat, eye protection and any site-specific PPE) at all times on site.'),
        t('15.2 You must keep issued PPE and uniform clean, serviceable and in good repair, and must report and replace any damaged or non-compliant item before your next shift.'),
        t('15.3 You must not alter, obscure or add to T&S branding, and must not wear T&S uniform other than while working or travelling to or from work.'),
      ],
    },
    {
      num: 16, heading: 'Company property, vehicles and equipment',
      clauses: [
        t('16.1 All vehicles, plant, signage, devices, tools, phones, fuel cards, keys, access cards and documents issued to you remain the property of T&S and must be used only for work purposes.'),
        t('16.2 When driving a T&S vehicle you must:\n\n(a) hold and carry a valid licence of the correct class;\n(b) comply with all road rules, the T&S Vehicle Policy and safe loading requirements;\n(c) complete pre-start and daily vehicle checks and report defects immediately;\n(d) not permit any unauthorised person to drive or travel in the vehicle;\n(e) not smoke or vape in the vehicle.'),
        t('16.3 **You are personally responsible for any fine, infringement notice, toll, penalty or demerit point incurred by you** while operating a T&S vehicle. T&S will nominate you as the responsible driver to the issuing authority.'),
        t('16.4 You must return all T&S property in good condition (fair wear and tear excepted) on the earlier of request or the end of your employment.'),
      ],
    },
    {
      num: 17, heading: 'Deductions',
      clauses: [
        t('17.1 T&S will only make a deduction from your pay where the deduction is:\n\n(a) authorised by you **in writing**, in a separate authorisation that specifies the amount, and is principally for your benefit; or\n(b) authorised by the Award, an order of a court or the Fair Work Commission, or a law of the Commonwealth, a State or a Territory.'),
        t('17.2 Any written authorisation you give may be **withdrawn by you in writing at any time**. Nothing in this Agreement authorises a deduction that would be unlawful.'),
      ],
    },
    {
      num: 18, heading: 'Conduct and client relationships',
      clauses: [
        t('18.1 You are the public face of T&S. You must:\n\n(a) behave courteously and professionally toward the public, clients, police, emergency services, council officers and other contractors;\n(b) not argue with, obstruct or abuse members of the public — disengage and escalate to your supervisor or the control room instead;\n(c) not accept payment, gift or benefit from a client, contractor or member of the public in connection with your work;\n(d) not take, post or share photographs, video or audio of any T&S site, client, worker or member of the public on social media or elsewhere, without prior written approval;\n(e) not make any public statement, comment or post that identifies or could reasonably be connected to T&S, a client or a site.'),
        t('18.2 You must not, during your employment, accept direct engagement by a T&S client for traffic control work at a site you attended for T&S, or perform work for a T&S client other than as a T&S employee, without T&S’s prior written consent.'),
      ],
    },
    {
      num: 19, heading: 'Policies',
      clauses: [
        t('19.1 You must comply with all T&S policies and procedures as varied from time to time, including the Code of Conduct, WHS, Drug and Alcohol, Vehicle, Fatigue, Social Media, Privacy, and Bullying, Discrimination and Harassment policies.'),
        t('19.2 Policies are **directions, not terms of this Agreement**, and do not form part of your contract of employment. T&S may introduce, vary or withdraw a policy at any time.'),
      ],
    },
    {
      num: 20, heading: 'Confidentiality',
      clauses: [
        t('20.1 You must not, during or after your employment, use or disclose any confidential information of T&S or its clients, including rates, pricing, quotes, margins, client lists and contacts, TCP designs and drawings, tender material, systems and software (including the Atomis platform), worker records, and any information marked or reasonably understood to be confidential.'),
        t('20.2 This clause does not prevent disclosure required by law, or a disclosure protected under whistleblower, WHS or workplace laws.'),
      ],
    },
    {
      num: 21, heading: 'Intellectual property',
      clauses: [
        t('21.1 All intellectual property created by you in the course of your employment, including plans, drawings, reports, photographs, records, processes and materials, is owned by T&S from the moment of creation. You assign to T&S all such rights and agree to do anything reasonably required to give effect to that assignment.'),
        t('21.2 To the extent permitted by law, you consent to acts or omissions by T&S that would otherwise infringe your moral rights in that material.'),
      ],
    },
    {
      num: 22, heading: 'Right to work',
      clauses: [
        t('22.1 You warrant that you are legally entitled to work in Australia and will remain so. You must provide evidence of your entitlement on request and notify T&S immediately of any change to your visa status, conditions or work rights.'),
        t('22.2 If your right to work ends or becomes restricted, your employment ends automatically on that date, or is limited to the extent permitted by your visa.'),
      ],
    },
    {
      num: 23, heading: 'Privacy and personal information',
      clauses: [
        t('23.1 T&S collects, holds and uses your personal information (including contact details, tax file number, superannuation details, licences and tickets, medical and fitness-for-work information, and site and incident records) for the purposes of employing you, paying you, and meeting legal obligations.'),
        t('23.2 You consent to T&S disclosing your name, photograph, licence and ticket details, induction status and competency records to **clients, principal contractors, councils, road authorities, insurers, the Long Service Corporation and regulators**, where required for site access, compliance or audit purposes.'),
        t('23.3 T&S handles your information in accordance with the *Privacy Act 1988* (Cth) and the T&S Privacy Policy.'),
        t('23.4 You consent to receiving employment-related documents, notices, payslips, rosters and policies **electronically**, to the email address and mobile number recorded above.'),
      ],
    },
    {
      num: 24, heading: 'Ending the employment',
      clauses: [
        t('24.1 As a casual employee, your employment ends at the conclusion of each engagement. Either party may decide not to offer or accept further shifts at any time.'),
        t('24.2 Where practical, you should give T&S notice if you no longer wish to be offered shifts, so that rosters can be adjusted.'),
        t('24.3 T&S may end your employment immediately, and remove you from site, for **serious misconduct**, including (without limitation): a safety breach creating a risk to any person; attending work unfit under clause 13; theft, fraud or falsification of records (including timesheets); violence or threats; serious harassment or discrimination; wilful damage to property; or working without a required licence or ticket.'),
        t('24.4 On the end of your employment you must immediately return all T&S property and confidential information.'),
      ],
    },
    {
      num: 25, heading: 'Warranties by you',
      clauses: [
        t('25.1 You warrant that:\n\n(a) all information you have provided to T&S (including in your application, licences, tickets, qualifications and medical declarations) is true, complete and not misleading;\n(b) you are not subject to any contract, restraint or obligation that would prevent or restrict you performing this role;\n(c) you have disclosed any pre-existing injury, illness or condition that could be affected by the duties described in clause 5;\n(d) you have no matter pending that could affect your ability to hold a required licence, ticket or clearance.'),
        t('25.2 Providing false or misleading information under this clause is serious misconduct. Under s.188 of the *Workers Compensation Act 1987* (NSW), if you fail to disclose a pre-existing injury or condition when asked, you may not be entitled to workers compensation for any aggravation of that condition.'),
      ],
    },
    {
      num: 26, heading: 'General',
      clauses: [
        t('26.1 **Entire agreement.** This Agreement, together with Schedule A, is the entire agreement between you and T&S and replaces all prior agreements, representations and understandings.'),
        t('26.2 **Variation.** This Agreement may only be varied in writing signed or electronically accepted by both parties, except that Schedule A rates may be updated by T&S under clause 8.3 and your classification may be varied in writing by T&S under clause 26.3.'),
        t('26.3 **Classification changes.** T&S may vary your classification and duties in writing where your competencies, tickets or role change. An upward classification change takes effect from the date stated in the written notice.'),
        t('26.4 **Severance.** If any part of this Agreement is invalid or unenforceable, it is severed and the rest continues to operate.'),
        t('26.5 **Governing law.** This Agreement is governed by the laws of **New South Wales** and the Commonwealth of Australia.'),
        t('26.6 **Survival.** Clauses 3, 17, 20, 21, 23 and 24.4 survive the end of your employment.'),
      ],
    },
  ];
}

// ── Schedule A as render-ready data ──────────────────────────────────
function scheduleA(fields) {
  const snap = ratesFor(fields);
  const money = (n) => '$' + Number(n).toFixed(2);
  const a1 = Object.entries(snap.tiers).map(([tier, r]) => ({
    tier, level: r.level, role: r.role, rate: money(r.base),
  }));
  const a2 = Object.entries(snap.tiers).map(([tier, r]) => ({
    tier,
    cells: [money(r.sat2), money(r.satGt2), money(r.sun), money(r.pubHol), money(r.nightLt5), money(r.nightPerm), money(r.night5)],
  }));
  const a3 = [
    { name: 'Fares and travel', rate: '$' + snap.fares + ' / day', notes: 'All-purpose, paid for each day worked' },
  ];
  const std = String(fields.FIRST_AID_STD || '').trim();
  if (std) {
    a3.push({
      name: 'First aid — standard',
      rate: '$' + std.replace(/^\$/, '') + ' / day',
      notes: 'Where appointed as first aid officer and holding a current qualification',
    });
  }
  a3.push({ name: 'First aid — higher', rate: '$' + snap.first_aid_higher + ' / day', notes: 'Higher than minimum first aid qualification, where appointed' });
  const extra = String(fields.ADDITIONAL_ALLOWANCE || '').trim();
  if (extra) {
    a3.push({
      name: extra,
      rate: String(fields.ADDITIONAL_ALLOWANCE_RATE || '').trim(),
      notes: String(fields.ADDITIONAL_ALLOWANCE_NOTES || '').trim(),
    });
  }
  return {
    intro: interpolate('Statutory minimum rates — Casual, Civil construction. Building and Construction General On-site Award MA000020. Effective {{RATES_EFFECTIVE_DATE}}. Rates include the 25% casual loading and the industry allowance.', fields),
    a1, a2,
    a2Header: ['Tier', 'Sat ≤2h', 'Sat >2h', 'Sun', 'Pub. hol.', 'Night <5', 'Night perm.', 'Night 5+'],
    penaltyNotes: PENALTY_NOTES,
    penaltyFootnote: PENALTY_FOOTNOTE,
    a3,
  };
}

// ── Formatting helpers shared by the HTML and PDF renderers ──────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// **bold** → <strong>, *italic* → <em>, newlines → <br>
function toHtml(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s.replace(/\n/g, '<br>');
}
// Strip emphasis markers for plain-text/PDF rendering.
function toPlain(text) {
  return String(text).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
}

module.exports = {
  TEMPLATE_VERSION,
  COMPANY,
  TIERS,
  RATES_EFFECTIVE,
  ratesSnapshot,
  ratesFor,
  ACKNOWLEDGEMENTS,
  FIELD_DEFS,
  interpolate,
  sections,
  scheduleA,
  toHtml,
  toPlain,
  escapeHtml,
};
