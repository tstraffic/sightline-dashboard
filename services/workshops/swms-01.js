'use strict';

/*
 * services/workshops/swms-01.js
 *
 * Content + scoring helpers for the SWMS 01 — Mini-SWMS Challenge workshop.
 * Pure data + tiny pure functions: no DB, no Express, no globals.
 *
 * Source of truth for the questions: SWMS 01 Traffic Operations v3.0
 * (11 May 2026), preserved verbatim from the workshop artifact spec so
 * the in-room exercise and the dashboard tool stay aligned.
 *
 * To add a second workshop later, create services/workshops/swms-02.js
 * with the same shape (CASES, IMPACTS, LIKE, BANDS, CLAUSE_DETAIL) and
 * register it from the route layer.
 */

// ── Risk matrix (SWMS p.18) ──
// IMPACTS rows: 5 (Catastrophic) down to 1 (Insignificant).
// LIKE columns: E (Rare) → A (Almost Certain), L→R.
// BANDS lookup: for each impact row, the band for each likelihood
// column, ordered E,D,C,B,A. e.g. BANDS[5][0] = high (5E = High).
const IMPACTS = [
  { n: 5, label: 'Catastrophic' },
  { n: 4, label: 'Severe' },
  { n: 3, label: 'Major' },
  { n: 2, label: 'Minor' },
  { n: 1, label: 'Insignificant' },
];

const LIKE = [
  { c: 'E', label: 'Rare' },
  { c: 'D', label: 'Unlikely' },
  { c: 'C', label: 'Possible' },
  { c: 'B', label: 'Likely' },
  { c: 'A', label: 'Almost Certain' },
];

const BANDS = {
  5: ['high',   'high',   'extreme', 'extreme', 'extreme'],
  4: ['medium', 'medium', 'high',    'high',    'extreme'],
  3: ['low',    'medium', 'medium',  'high',    'high'   ],
  2: ['low',    'low',    'medium',  'medium',  'high'   ],
  1: ['low',    'low',    'low',     'medium',  'medium' ],
};

// ── Cases ──
// Each case: id/letter, title, where, brief, and an ordered list of
// questions. Question kinds: 'single' (radio), 'multi' (checkboxes,
// partial credit), 'matrix' (tap a cell on the 5x5 risk grid, ±1 band
// gives partial credit). Each question carries its own `fb` feedback
// text and `src` SWMS clause label shown after the answer is locked in.
const CASES = [
  {
    id: 'A', letter: 'A',
    title: 'TC killed by a speeding driver',
    where: 'Carrum Downs, VIC · Nov 2021',
    brief: 'Early hours, 9 November 2021. A 44-year-old traffic controller was setting up road cones at a roadworks site. The posted limit through the work zone was 40 km/h. A disqualified driver drove through the zone at roughly 105 km/h, killing the TC and seriously injuring a second worker. The driver fled the scene.',
    questions: [
      { kind: 'single', short: 'Golden Rule',
        prompt: 'Which Golden Rule of Safety was broken?',
        options: [
          { t: 'Beware of Live Traffic', c: true },
          { t: "Don't Rush", c: false },
          { t: 'Watch Your Mates', c: false },
          { t: 'Exclusion Zones', c: false },
          { t: 'Safety Controls', c: false },
        ],
        fb: 'Beware of Live Traffic — always keep an escape route and minimise exposure to live traffic. Make It Safe / Keep It Safe also applies.',
        src: 'Golden Rules of Safety — SWMS p.1' },
      { kind: 'single', short: 'SWMS Item',
        prompt: 'Which SWMS Item most directly applies?',
        options: [
          { t: 'Item 7b — Controlling traffic: motorist non-compliance & breach', c: true },
          { t: 'Item 1a — Safe vehicle operation', c: false },
          { t: 'Item 8a — Working around mobile plant', c: false },
          { t: 'Item 12 — School zones', c: false },
          { t: 'Item 9c — Lone / remote worker', c: false },
        ],
        fb: 'Item 7b covers motorists breaching the work zone and the breach response, and points to Appendix B. Item 7e (speed non-compliance) and Item 5 (high-speed roads) also apply.',
        src: 'Item 7b — SWMS p.10 · Appendix B p.22' },
      { kind: 'matrix', short: 'Initial Risk',
        prompt: 'Tap the cell for the INITIAL (before-controls) risk rating.',
        accept: ['4C'],
        fb: 'The SWMS rates Item 7b — the item that applies here — as High (4C) in its Risk Rating column. That is the before-controls rating: read it off the row, the SWMS has already set it.',
        src: 'Item 7b Risk Rating — SWMS p.10' },
      { kind: 'multi', short: 'Controls',
        prompt: 'Select ALL controls that apply to this incident.',
        options: [
          { t: 'Use a shadow vehicle to physically protect workers on foot; driver acts as lookout', c: true },
          { t: 'Position a lookout off the travelled path with an unobstructed escape route, doing no other task', c: true },
          { t: 'Maintain an unobstructed escape route at all times', c: true },
          { t: 'On longer sites or driver non-compliance risk, use an escort vehicle to regulate speed', c: true },
          { t: 'Observe a 10 m no-go exclusion zone around mobile plant', c: false },
          { t: "Apply and re-apply sunscreen per the manufacturer's instructions", c: false },
          { t: 'Use no ladders for covering or uncovering signs', c: false },
        ],
        fb: 'What matters here is shadow vehicle, lookout, escape route and escort vehicle (Items 3a, 4a, 5, 7e). Sunscreen, ladders and plant exclusion zones are real SWMS controls — for other hazards.',
        src: 'Items 3a / 4a / 5 / 7e — SWMS p.6–12' },
      { kind: 'matrix', short: 'Residual Risk',
        prompt: 'Tap the cell for the RESIDUAL (after-controls) risk rating.',
        accept: ['4D'],
        fb: "After controls, the SWMS rates Item 7b residual risk as Medium (4D). Controls cut the likelihood — they don't remove live traffic, so impact stays Severe. Medium = safe to proceed, keep monitoring.",
        src: 'Item 7b residual risk — SWMS p.10' },
      { kind: 'multi', short: 'Pre-Start',
        prompt: 'What SHOULD the pre-start have covered? Select all that apply.',
        options: [
          { t: 'Identify the directional escape route — "if a breach occurs, retreat to X"', c: true },
          { t: 'Identify the breach radio call (default "Breach, Breach, Breach")', c: true },
          { t: 'Identify where the dashcam / phone sits for evidence capture', c: true },
          { t: 'Conduct a drive-through of the approaches to find safe, compliant locations for signage', c: true },
          { t: 'Agree pickup and drop-off windows with school administration', c: false },
          { t: 'Confirm the location of the snake-bite pressure bandage', c: false },
          { t: 'Set the maximum continuous shift length', c: false },
        ],
        fb: 'Appendix B states exactly what the pre-start MUST cover for breach risk — the escape route, the breach radio call and the dashcam/phone position. The drive-through of the approaches is required by Item 2.',
        src: 'Appendix B p.22 · Item 2 p.5' },
      { kind: 'single', short: 'Escalation', advanced: true,
        prompt: 'After a vehicle breach, Appendix B sets escalation deadlines. Which is correct?',
        options: [
          { t: 'Team Leader within 5 minutes; Branch Manager within 30 minutes; written report before end of shift', c: true },
          { t: 'Team Leader within 30 minutes; Branch Manager next day; report within a week', c: false },
          { t: 'Branch Manager immediately; Team Leader at end of shift; no written report needed', c: false },
          { t: 'Report only if there was an injury; otherwise no escalation', c: false },
          { t: 'Team Leader at end of shift; written report within 48 hours', c: false },
        ],
        fb: 'Appendix B — Team Leader notified within 5 minutes, Branch Manager within 30 minutes, and a written near-miss / incident report before end of shift.',
        src: 'Appendix B — SWMS p.22' },
      { kind: 'multi', short: '000 Triggers', advanced: true,
        prompt: 'Per Appendix B, which of these REQUIRE a 000 call after a breach? Select all.',
        options: [
          { t: 'Any injury', c: true },
          { t: 'Vehicle damage to T&S equipment beyond minor', c: true },
          { t: 'Aggressive behaviour from the driver', c: true },
          { t: 'The vehicle leaves the scene', c: true },
          { t: 'The breach was captured on dashcam', c: false },
          { t: 'A single cone was knocked over', c: false },
        ],
        fb: 'Appendix B — call 000 if ANY of: an injury, vehicle damage beyond minor, aggressive driver behaviour, or the vehicle leaves the scene. Dashcam footage and a knocked cone are not, on their own, 000 triggers.',
        src: 'Appendix B — SWMS p.22' },
    ],
  },
  {
    id: 'B', letter: 'B',
    title: 'TC killed during night works',
    where: 'Bruce Highway, QLD · Nov 2017',
    brief: "Just after midnight, 7 November 2017. A 56-year-old traffic controller was working a night shift on the Bruce Highway, Sunshine Coast. He was standing on the driver's side of a stationary bump truck when a vehicle struck him. He died at the scene, in front of his workmates.",
    questions: [
      { kind: 'single', short: 'Golden Rule',
        prompt: 'Which Golden Rule of Safety was broken?',
        options: [
          { t: 'Beware of Live Traffic', c: true },
          { t: 'Pre-Start', c: false },
          { t: 'Communicate', c: false },
          { t: 'Reversing Vehicles', c: false },
          { t: 'Watch Your Mates', c: false },
        ],
        fb: 'Beware of Live Traffic — escape route and minimised exposure. The TC was exposed on the traffic side of the truck.',
        src: 'Golden Rules of Safety — SWMS p.1' },
      { kind: 'single', short: 'SWMS Item',
        prompt: 'Which SWMS Item most directly applies?',
        options: [
          { t: 'Item 13 — Night works', c: true },
          { t: 'Item 1b — Unsafe driving', c: false },
          { t: 'Item 8a — Working around mobile plant', c: false },
          { t: 'Item 10 — Hostile members of public', c: false },
          { t: 'Item 4b — Manual handling', c: false },
        ],
        fb: 'Item 13 covers night works — visibility, glare, fatigue and drunk-driver windows. Item 3a (exiting / positioning on the non-traffic side) also applies.',
        src: 'Item 13 — SWMS p.17' },
      { kind: 'matrix', short: 'Initial Risk',
        prompt: 'Tap the cell for the INITIAL (before-controls) risk rating.',
        accept: ['4B'],
        fb: "The SWMS rates Item 13 — night works — as High (4B) in its Risk Rating column: Severe impact, Likely. The point of a SWMS is that the rating is already set — you use 4B from the document, you don't re-calculate it from this one incident. A 5B answer rates the impact as Catastrophic; the SWMS assesses the night-works task as Severe (4).",
        src: 'Item 13 Risk Rating — SWMS p.17' },
      { kind: 'multi', short: 'Controls',
        prompt: 'Select ALL controls that apply to this incident.',
        options: [
          { t: 'Bio-motion compliant hi-vis mandatory — reflective hoops on pants and shirts', c: true },
          { t: 'Site lighting to give a minimum 50 lux at the control point', c: true },
          { t: 'Position the TC out of the direct headlight line; angle light towers away from traffic', c: true },
          { t: 'Mandatory 15-minute break between 2 am and 4 am; rotate TCs hourly in that window', c: true },
          { t: 'Keep the buffer / shadow vehicle a minimum 40 m from workers on foot', c: true },
          { t: 'Observe a 10 m no-go zone around mobile plant', c: false },
          { t: 'Carry no more than 4 cones at a time', c: false },
        ],
        fb: 'Night-works controls (Item 13) plus the 40 m shadow-vehicle buffer (Item 5). Plant exclusion zones and manual-handling limits are not the hazard here.',
        src: 'Items 13 / 5 — SWMS p.8 & p.17' },
      { kind: 'matrix', short: 'Residual Risk',
        prompt: 'Tap the cell for the RESIDUAL (after-controls) risk rating.',
        accept: ['3D'],
        fb: 'The SWMS prints Item 13 residual risk as Medium (3D) — read it straight off the Residual Risk column. Night-works controls bring it down from High, but moderate risk remains: continually monitor.',
        src: 'Item 13 residual risk — SWMS p.17' },
      { kind: 'multi', short: 'Pre-Start',
        prompt: 'What SHOULD the pre-start have covered? Select all that apply.',
        options: [
          { t: 'Identify the drunk-driver risk windows and the additional controls for them', c: true },
          { t: "Run the pre-shift visual acuity check — reassign any TC who can't see clearly in low light", c: true },
          { t: 'Complete the Site Traffic Management Risk Assessment, identifying night works as a site hazard', c: true },
          { t: 'Self-declaration of fitness for work at sign-on', c: true },
          { t: 'Contact the school office to confirm pickup / drop-off windows', c: false },
          { t: 'Create a Journey Management Plan for a 200 km-plus drive', c: false },
          { t: 'Confirm the ratchet-strap method for the load', c: false },
        ],
        fb: 'Item 13 sets the night-works pre-start — it states the pre-start must identify the drunk-driver windows, and that a pre-shift visual acuity check is run. Item 2 requires the site risk assessment; Item 7d the fitness self-declaration at sign-on.',
        src: 'Item 13 p.17 · Item 2 p.5 · Item 7d p.11' },
      { kind: 'multi', short: 'Fatigue Limits', advanced: true,
        prompt: 'Which fatigue limits does the SWMS set for traffic control work? Select all that apply.',
        options: [
          { t: 'Maximum continuous shift length: 12 hours', c: true },
          { t: 'Minimum break between shifts: 10 hours', c: true },
          { t: 'Maximum 6 consecutive shifts before a mandatory rest day', c: true },
          { t: 'If shift plus commute exceeds 14 hours, T&S arranges transport or accommodation', c: true },
          { t: 'Maximum continuous shift length: 16 hours', c: false },
          { t: 'Minimum break between shifts: 6 hours', c: false },
        ],
        fb: 'Item 7d — max 12-hour continuous shift, min 10-hour break between shifts, max 6 consecutive shifts before a mandatory rest day, and the drive-time-home rule: shift plus commute over 14 hours and T&S arranges transport or accommodation.',
        src: 'Item 7d — SWMS p.11' },
      { kind: 'single', short: 'Radio Failure', advanced: true,
        prompt: 'Two-way single-lane closure at night. The radio between the two TCs fails. What does the SWMS require?',
        options: [
          { t: 'Both TCs go to STOP, hold traffic both ends, restore comms before any release', c: true },
          { t: 'The sending TC keeps releasing traffic at timed intervals', c: false },
          { t: 'Carry on — use hand signals from 200 m away', c: false },
          { t: 'The TC nearest the queue releases traffic and the other follows', c: false },
          { t: 'Switch to phones and keep releasing on a 2-minute cycle', c: false },
        ],
        fb: 'Appendix A — if comms fail, BOTH TCs go to STOP and hold traffic both ends. Restore comms via a spare radio, a phone relay, or a runner. Never release on assumption.',
        src: 'Appendix A — SWMS p.21' },
    ],
  },
  {
    id: 'C', letter: 'C',
    title: 'Worker killed by a plant vehicle',
    where: 'M1 Extension, NSW · Nov 2025',
    brief: '11:50 pm, 6 November 2025. M1 extension construction site at Tarro, near Raymond Terrace. A 45-year-old worker was standing behind a parked truck when he was struck by a material transfer vehicle. He died at the scene. SafeWork NSW is investigating.',
    questions: [
      { kind: 'single', short: 'Golden Rule',
        prompt: 'Which Golden Rule of Safety was broken?',
        options: [
          { t: 'Exclusion Zones', c: true },
          { t: "Don't Rush", c: false },
          { t: 'Communicate', c: false },
          { t: 'Pre-Start', c: false },
          { t: 'Safety Controls', c: false },
        ],
        fb: 'Exclusion Zones — keep a safe zone around mobile plant, agreed at the pre-start. Watch Your Mates (acting as lookout) also applies.',
        src: 'Golden Rules of Safety — SWMS p.1' },
      { kind: 'single', short: 'SWMS Item',
        prompt: 'Which SWMS Item most directly applies?',
        options: [
          { t: 'Item 8a — Working around mobile plant & machinery', c: true },
          { t: 'Item 7c — Uneven ground / trip hazards', c: false },
          { t: 'Item 1b — Unsafe driving', c: false },
          { t: 'Item 4d — Signage becoming a hazard', c: false },
          { t: 'Item 11 — Emergency response', c: false },
        ],
        fb: 'Item 8a — being struck by moving plant, rated Extreme (5C). It also covers reversing heavy vehicles needing a dedicated spotter. Item 13 (night works) applies too — it was 11:50 pm.',
        src: 'Item 8a — SWMS p.14' },
      { kind: 'matrix', short: 'Initial Risk',
        prompt: 'Tap the cell for the INITIAL (before-controls) risk rating.',
        accept: ['5C'],
        fb: 'The SWMS rates Item 8a — working around mobile plant — as Extreme (5C) in its Risk Rating column. Read it off the row. Extreme means stop work, immediate intervention.',
        src: 'Item 8a Risk Rating — SWMS p.14' },
      { kind: 'multi', short: 'Controls',
        prompt: 'Select ALL controls that apply to this incident.',
        options: [
          { t: 'Observe a 10 m minimum no-go zone around mobile plant', c: true },
          { t: 'Enter the zone only after direct comms with the operator, with plant on hold', c: true },
          { t: "Reversing heavy vehicles need a dedicated spotter — a TC controlling traffic can't double up", c: true },
          { t: "Don't stand in blind spots; keep eye contact with plant operators", c: true },
          { t: 'Pre-entry comms with the heavy vehicle driver — confirm path and exclusion zone clear', c: true },
          { t: 'Apply two of: lookout, traffic gaps, shadow vehicle before crossing a live lane', c: false },
          { t: 'Position the TC a minimum 10 m from the PTCD', c: false },
        ],
        fb: 'Every correct option is straight out of Item 8a. The two wrong ones are real controls — for crossing live lanes (Item 6) and PTCD positioning (Item 7a) — not for plant proximity.',
        src: 'Item 8a — SWMS p.14' },
      { kind: 'matrix', short: 'Residual Risk',
        prompt: 'Tap the cell for the RESIDUAL (after-controls) risk rating.',
        accept: ['5D'],
        fb: "Even with every control in place, the SWMS rates Item 8a residual risk as HIGH (5D) — not Medium. You can't make being struck by plant non-fatal, so impact stays Catastrophic. High residual = stop and assess before proceeding.",
        src: 'Item 8a residual risk — SWMS p.14' },
      { kind: 'multi', short: 'Pre-Start',
        prompt: 'What SHOULD the pre-start have covered? Select all that apply.',
        options: [
          { t: 'Discuss the risks of all plant movements at the pre-start', c: true },
          { t: 'Establish agreed exclusion zones with the client at the pre-start', c: true },
          { t: 'All TCs sign on to the Traffic Management Risk Assessment / Pre-Start Declaration', c: true },
          { t: 'As night works, identify the drunk-driver risk windows and the extra controls', c: true },
          { t: 'Confirm the partial-plate phraseology for traffic releases', c: false },
          { t: 'Agree the pedestrian-escort method for school children', c: false },
          { t: 'Set the maximum number of cones to be carried', c: false },
        ],
        fb: 'Item 8a states plant movement risks and exclusion zones are dealt with at the pre-start; Item 2 requires every TC to sign the Pre-Start Declaration. It was 11:50 pm, so Item 13 night-works controls apply too.',
        src: 'Item 8a p.14 · Item 2 p.5 · Item 13 p.17' },
      { kind: 'single', short: 'Span of Control', advanced: true,
        prompt: 'A PTCD fails mid-shift, leaving one TC to cover two control points. What does the SWMS require?',
        options: [
          { t: "STOP work at the affected control points; contact Team Leader and Branch; don't resume until the device is restored or another TC is on site", c: true },
          { t: 'The TC manages both points by walking between them', c: false },
          { t: 'A trainee covers the second control point', c: false },
          { t: 'Continue if the two points are within sight of each other', c: false },
          { t: 'Close the second point and let traffic self-regulate', c: false },
        ],
        fb: "Item 2c — a single TC must NOT manage more than one control point. STOP work at the affected points, contact Team Leader and Branch, and don't resume until the device is restored or additional TC resource is on site. Trainees do not count as TC resource.",
        src: 'Item 2c — SWMS p.5' },
      { kind: 'multi', short: 'Heavy Vehicles', advanced: true,
        prompt: 'A tipper is reversing and operating its tip mechanism on site. Which Item 8a controls apply? Select all.',
        options: [
          { t: "Reversing heavy vehicles require a dedicated spotter — a TC controlling traffic can't be the spotter", c: true },
          { t: 'A 10 m exclusion zone applies for a tipper operating its tip mechanism — a raised tray is a power line strike and instability risk', c: true },
          { t: 'No TC within the turning radius of a heavy vehicle, including swing-tail clearance', c: true },
          { t: 'Pre-entry comms with the driver before entry — confirm the path and exclusion zone are clear', c: true },
          { t: 'Hearing protection removes the need for a spotter', c: false },
          { t: 'The TC may double as spotter if the site is quiet', c: false },
        ],
        fb: 'Item 8a — reversing heavy vehicles need a dedicated spotter (never the controlling TC); a 10 m exclusion zone applies to a raised tip tray; no TC inside the turning or swing-tail radius; and pre-entry comms confirm the path and zone are clear.',
        src: 'Item 8a — SWMS p.14' },
    ],
  },
  {
    id: 'D', letter: 'D',
    title: 'TC struck on a public road',
    where: 'Newcastle, NSW · Feb 2023',
    brief: '8 February 2023. A 64-year-old traffic controller was carrying out traffic control duties on a public road near Newcastle when he was struck by a moving vehicle, sustaining serious injuries. SafeWork NSW issued an Incident Information Release on the risks of positioning and exposure to live traffic.',
    questions: [
      { kind: 'single', short: 'Golden Rule',
        prompt: 'Which Golden Rule of Safety was broken?',
        options: [
          { t: 'Beware of Live Traffic', c: true },
          { t: "Don't Rush", c: false },
          { t: 'Exclusion Zones', c: false },
          { t: 'Reversing Vehicles', c: false },
          { t: 'Speak Up', c: false },
        ],
        fb: 'Beware of Live Traffic — escape route, minimised exposure, never cross live lanes on the higher-speed roads.',
        src: 'Golden Rules of Safety — SWMS p.1' },
      { kind: 'single', short: 'SWMS Item',
        prompt: 'Which SWMS Item most directly applies?',
        options: [
          { t: 'Item 7a — Controlling traffic: control point positioning', c: true },
          { t: 'Item 1c — Load restraint', c: false },
          { t: 'Item 8b — Noise affecting comms', c: false },
          { t: 'Item 9d — Emergency situations', c: false },
          { t: 'Item 12 — School zones', c: false },
        ],
        fb: 'Item 7a covers control point selection and positioning: 10 m from any PTCD, non-traffic side, unobstructed escape route. Item 3a (positioning / exiting the vehicle) and Item 4a (lookout) also apply.',
        src: 'Item 7a — SWMS p.9' },
      { kind: 'matrix', short: 'Initial Risk',
        prompt: 'Tap the cell for the INITIAL (before-controls) risk rating.',
        accept: ['4B'],
        fb: 'The SWMS rates Item 7a — control point positioning — as High (4B) in its Risk Rating column. Read it straight off the row; the residual on the same row is Medium (3D).',
        src: 'Item 7a Risk Rating — SWMS p.9' },
      { kind: 'multi', short: 'Controls',
        prompt: 'Select ALL controls that apply to this incident.',
        options: [
          { t: 'Position the TC a minimum 10 m from any PTCD or boom gate — a hard rule', c: true },
          { t: 'TC operates from the non-traffic side only — never between the device and approaching traffic', c: true },
          { t: 'Keep an unobstructed escape route to the non-traffic side at all times', c: true },
          { t: 'Provide a lookout — strongly encouraged on all jobs; mandatory on these roads with no shadow vehicle', c: true },
          { t: "If geometry won't allow 10 m + non-traffic-side positioning, stop work and request a layout reassessment", c: true },
          { t: 'Observe a 10 m no-go zone around mobile plant', c: false },
          { t: 'Place chocks under trailed equipment on slopes', c: false },
        ],
        fb: "Item 7a is the core — 10 m, non-traffic side, escape route, and stop work if the geometry doesn't allow it. Plant exclusion zones and wheel chocks are other hazards.",
        src: 'Items 7a / 4a — SWMS p.7 & p.9' },
      { kind: 'matrix', short: 'Residual Risk',
        prompt: 'Tap the cell for the RESIDUAL (after-controls) risk rating.',
        accept: ['3D'],
        fb: 'The SWMS rates Item 7a residual risk as Medium (3D). With 10 m positioning, non-traffic-side operation and an escape route, the High hazard drops to Medium — moderate risk remains, keep monitoring.',
        src: 'Item 7a residual risk — SWMS p.9' },
      { kind: 'multi', short: 'Pre-Start',
        prompt: 'What SHOULD the pre-start have covered? Select all that apply.',
        options: [
          { t: 'Conduct a drive-through of the approaches to identify safe, compliant control-point locations', c: true },
          { t: 'Complete the Site Traffic Management Risk Assessment — intersections, blind corners, site hazards', c: true },
          { t: 'All TCs sign on to the Pre-Start Declaration confirming they understand the site hazards', c: true },
          { t: 'Confirm the control point allows the 10 m and non-traffic-side positioning Item 7a requires', c: true },
          { t: 'Confirm the lux level of the light towers', c: false },
          { t: 'Agree the snake-bite first aid kit location', c: false },
          { t: 'Confirm the school point of contact', c: false },
        ],
        fb: 'Item 2 sets the pre-start — a drive-through of the approaches, the Site Traffic Management Risk Assessment, and every TC signing the Pre-Start Declaration. Item 7a sets the 10 m positioning the pre-start confirms.',
        src: 'Item 2 p.5 · Item 7a p.9' },
      { kind: 'multi', short: 'Lone Worker', advanced: true,
        prompt: "When is a TC a 'lone worker', and what does the SWMS require? Select all that apply.",
        options: [
          { t: 'Lone worker = the only T&S worker on site, out of line-of-sight of a teammate for more than 15 minutes at a time', c: true },
          { t: 'Team Leader must contact the TC by phone or radio at least every 2 hours', c: true },
          { t: 'A missed check-in means the Team Leader attends the site within 30 minutes', c: true },
          { t: 'No lone-worker assignment to school zones, sites with known driver hostility, multiple PTCDs, or night work', c: true },
          { t: 'Lone workers may work any site as long as they carry a phone', c: false },
          { t: 'Check-ins are only needed for journeys over 200 km', c: false },
        ],
        fb: "Item 9c — a lone worker is out of a teammate's line-of-sight for over 15 minutes; the Team Leader checks in at least 2-hourly; a missed check-in means the TL attends within 30 minutes; and lone workers are not assigned to elevated-risk sites.",
        src: 'Item 9c — SWMS p.15' },
      { kind: 'single', short: 'Crossing Lanes', advanced: true,
        prompt: 'Setting up on a road posted 90 km/h. What does the SWMS say about crossing the live lanes?',
        options: [
          { t: 'Live lanes shall not be crossed under any circumstances — do a circuit to reach the other side', c: true },
          { t: 'Cross only when there is a 200 m gap in traffic', c: false },
          { t: 'Cross if wearing bio-motion hi-vis', c: false },
          { t: 'Reverse up the shoulder to reach the other side', c: false },
          { t: 'Cross if two of: lookout, gaps, shadow vehicle are in place', c: false },
        ],
        fb: 'Item 5 — on any multi-lane road and any road posted 80 km/h or above, live lanes shall NOT be crossed under any circumstances. Crews do a circuit to place signs on the other side, and never reverse up a lane or shoulder.',
        src: 'Item 5 — SWMS p.8' },
    ],
  },
];

// ── Clause detail lookup ──
// Long-form clause text shown in the feedback box under the SWMS reference.
// Keyed [caseId][questionIndex] — must mirror CASES question ordering.
// Kept as a separate map so it's easy to update wording without scanning
// through the question structures.
const CLAUSE_DETAIL = {
  A: [
    'p.1 — Beware of Live Traffic: "Ensure you always have an escape route, minimise exposure to live traffic."',
    'Item 7b, p.10 — vehicle breach response; see Appendix B. Item 7e, p.12 — escort vehicle on sites with driver non-compliance risk.',
    "Item 7b, p.10 — the Risk Rating column reads High (4C). The SWMS sets the rating; you read it off the row, you don't re-derive it per incident.",
    'Item 4a, p.7 — lookout strongly encouraged on all jobs; Item 5, p.8 — buffer/shadow vehicle min 40 m from workers on foot.',
    'p.18 — Medium = task safe to perform, moderate risk remains, continually monitor. Item 7b residual = Medium (4D).',
    'Appendix B, p.22 — pre-start MUST identify the directional escape route, the breach radio call and the dashcam/phone position. Item 2, p.5 — drive-through of the approaches.',
    'Appendix B, p.22 — Team Leader within 5 minutes, Branch Manager within 30 minutes, written report before end of shift.',
    'Appendix B, p.22 — call 000 for any injury, vehicle damage beyond minor, an aggressive driver, or the vehicle leaving the scene.',
  ],
  B: [
    'p.1 — Beware of Live Traffic: escape route, minimise exposure, never cross a live lane on 80 km/h+ roads.',
    'Item 13, p.17 — night works: reduced visibility, driver fatigue/intoxication, glare, TC fatigue post-2am.',
    "Item 13, p.17 — the Risk Rating column reads High (4B): Severe impact, Likely. The document's rating is the answer, not a fresh calculation from the incident.",
    'Item 13, p.17 — 50 lux minimum, bio-motion hi-vis, glare management, 2–4am break + hourly rotation. Item 5, p.8 — 40 m buffer.',
    'p.18 — Item 13 prints Residual Risk Medium (3D). Medium = continually monitor control effectiveness.',
    'Item 13, p.17 — pre-start identifies drunk-driver risk windows; pre-shift visual acuity check. Item 2, p.5 — site risk assessment. Item 7d, p.11 — fitness self-declaration at sign-on.',
    'Item 7d, p.11 — 12-hour max shift, 10-hour min break between shifts, 6 consecutive shifts max, 14-hour drive-time-home rule.',
    'Appendix A, p.21 — if comms fail both TCs go to STOP, hold both ends, restore comms, and never release on assumption.',
  ],
  C: [
    'p.1 — Exclusion Zones: maintain a safe exclusion zone around mobile plant; agree zones with the client at the pre-start.',
    'Item 8a, p.14 — working around mobile plant: being struck by moving plant; reversing heavy vehicles need a dedicated spotter.',
    'Item 8a, p.14 — the Risk Rating column reads Extreme (5C). p.18 — Extreme = stop work, immediate intervention.',
    'Item 8a, p.14 — 10 m no-go zone, comms with operator with plant on hold, dedicated spotter, no blind spots, pre-entry comms.',
    'p.18 — Item 8a prints Residual Risk High (5D). High = stop and assess; proceed only with due care.',
    'Item 8a, p.14 — "Discuss risks associated with Plant Movements at pre-start"; exclusion zones agreed with the client. Item 2, p.5 — all TCs sign the Pre-Start Declaration.',
    "Item 2c, p.5 — a single TC must not cover more than one control point; STOP, contact TL and Branch, don't resume until restored or extra TC on site.",
    'Item 8a, p.14 — dedicated spotter for reversing; 10 m zone for a raised tip tray; no TC in the turning / swing-tail radius; pre-entry comms.',
  ],
  D: [
    'p.1 — Beware of Live Traffic: always keep an escape route and minimise exposure to live traffic.',
    'Item 7a, p.9 — control point positioning: min 10 m from any PTCD, non-traffic side, unobstructed escape route.',
    'Item 7a, p.9 — the Risk Rating column reads High (4B); residual on the same row is Medium (3D).',
    "Item 7a, p.9 — 10 m is a hard rule; non-traffic side only; stop work and escalate if geometry won't allow it.",
    'p.18 — Item 7a prints Residual Risk Medium (3D). Controls reduce the likelihood; the rating drops to Medium.',
    'Item 2, p.5 — drive-through of approaches, Site Traffic Management Risk Assessment, all TCs sign the Pre-Start Declaration. Item 7a, p.9 — control point positioning.',
    'Item 9c, p.15 — lone worker out of line-of-sight 15 min+; 2-hourly check-in; missed check-in = TL attends in 30 min; no elevated-risk sites.',
    'Item 5, p.8 — on 80 km/h+ and multi-lane roads, never cross live lanes; do a circuit; never reverse up a lane or shoulder.',
  ],
};

// ── Pure scoring helpers ──
// Lifted from the artifact so server-side code can re-validate a submitted
// score if we ever turn off the client-trusts-itself default.

// Convert a cell code like "4C" to {imp, lk} 1-indexed.
function cellCoords(code) {
  return {
    imp: parseInt(code.charAt(0), 10),
    lk: { E: 1, D: 2, C: 3, B: 4, A: 5 }[code.charAt(1)],
  };
}

// Manhattan distance between picked cell and the nearest accepted cell.
// Used for matrix partial credit: 0 = exact, 1 = one band off (part marks),
// 2+ = wrong.
function matrixMinDist(accept, picked) {
  if (!picked) return 99;
  const p = cellCoords(picked);
  let best = 99;
  for (const a of accept) {
    const x = cellCoords(a);
    const d = Math.abs(x.imp - p.imp) + Math.abs(x.lk - p.lk);
    if (d < best) best = d;
  }
  return best;
}

// Look up the band ("low" / "medium" / "high" / "extreme") for a cell code.
function cellBand(code) {
  const c = cellCoords(code);
  return BANDS[c.imp][c.lk - 1];
}

module.exports = {
  slug: 'swms-01',
  title: 'SWMS 01 — Mini-SWMS Challenge',
  description:
    'Office-crew workshop. Four real traffic incidents (A–D), 8 questions each.',
  CASES,
  IMPACTS,
  LIKE,
  BANDS,
  CLAUSE_DETAIL,
  // helpers
  cellCoords,
  cellBand,
  matrixMinDist,
};
