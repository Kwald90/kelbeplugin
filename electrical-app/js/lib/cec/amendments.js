// Provincial amendments to the CEC, modelled as rule-level overrides.
//
// RULE_PARAMS holds the numbers the calculators use for a rule, as the national
// code sets them. A province that changes one of those numbers gets an entry in
// AMENDMENTS with `params`; ruleParams(rule, province) merges it in. Amendments
// that change what to check rather than a number carry only a summary, and
// show up in the compliance checklists and docs/code/adoption.md.
// Only amendments with a public source are listed.

/** National CEC 2024 parameters per rule (sources in the modules that use them). */
export const RULE_PARAMS = {
  // Table 39 was deleted from the national CEC in 2021 (ESA amendment 2021-OA-002); Ontario keeps it.
  '4-004': { table39: null },
  '8-102': { branch: 3, feeder: 3, total: 5 },
  '8-110': { basementFactor: 0.75, basementMinHeightM: 1.8 },
  '62-118': { fullW: 10000, restFactor: 0.75 },
  '8-200': {
    basicW: 5000, basicAreaM2: 90, blockM2: 90, blockW: 1000,
    rangeBaseW: 6000, rangeThresholdW: 12000, rangeOverFactor: 0.4,
    otherThresholdW: 1500, otherFactor: 0.25, noRangeFullW: 6000,
    minAreaM2: 80, minLargeW: 24000, minSmallW: 14400,
  },
  '8-202': {
    basicW: 3500, basicAreaM2: 45, secondW: 1500, secondAreaM2: 45, blockM2: 90, blockW: 1000,
    unitFactors: [[1, 1], [2, 0.65], [2, 0.4], [15, 0.25], [Infinity, 0.1]], // 15-unit band and 10%: VERIFY
    evFactor: 1, commonFactor: 0.75,
  },
};

const ON_SRC = 'ESA, 2024 Ontario Amendments (2024-11-13), esasafe.com';
const SK_SRC = 'TSASK, 2024 CEC Saskatchewan Interpretations v2.0 (2025-10-15)';
const MB_SRC = 'Man. Reg. 30/2026, Manitoba Electrical Code schedule';
const PE_SRC = 'PEI EC2024-874, Schedule 1 (2024-09-24)';

/**
 * AMENDMENTS[province] = [{ rule, summary, source, effective?, params? }]
 * `summary` is our own plain-language wording, never CSA text. BC and NS adopted
 * CEC 2024 with no amendments. Sources: docs/code/adoption.md.
 */
export const AMENDMENTS = {
  ON: [
    { rule: '2-004', summary: 'File a notification with ESA before work starts (or within 48 h when that isn\'t practicable); ESA connection authorization is needed before use.', source: ON_SRC },
    { rule: '2-005', summary: 'Some small jobs need no notification, such as like-for-like device swaps up to 30 A, 130 V by a licensed contractor in an owner-occupied dwelling.', source: ON_SRC },
    { rule: '2-010', summary: 'Plan review for 3-phase services of 400 A or more, single-phase 600 A or more, feeders over 1000 A, and larger EV or Section 64 systems (EV/bidirectional threshold 12 kW from 2026-07-06).', source: `${ON_SRC}; ESA Director's Order` },
    {
      rule: '4-004',
      summary: '90 °C single-dwelling service and feeder conductors may be sized from Ontario Table 39 (Rule 4-004(26)) when the load stays within their 75 °C ampacity.',
      source: `${ON_SRC}; ESA 2021-OA-002 (Rule 4-004)`,
      // [service A, Cu size, max load A on Cu, Al size, max load A on Al]
      params: { table39: [[100, '3', 100, '2', 90], [125, '2', 115, '1/0', 120], [200, '2/0', 175, '4/0', 180], [225, '3/0', 200, '250', 205], [400, '500', 380, '700', 375]] },
    },
    { rule: '6-112', summary: 'Ontario rules for the overhead attachment point (4.5 m to 9 m above grade), service head position and mast guying (also 6-116, new 6-118).', source: ON_SRC },
    { rule: '8-106', summary: 'Energy management systems may limit any load, not only EV loads (also 8-202(3) and new 8-500).', source: ON_SRC },
    { rule: '14-418', summary: 'One disconnect per non-dwelling unit, per shared area, and per building fed from another building.', source: ON_SRC },
    { rule: '26-744', summary: 'Dwellings need a 14-50R range receptacle unless a built-in cooktop or oven is installed, or gas is provided for a range.', source: ON_SRC },
    { rule: '28-500', summary: 'A manual starter not marked suitable as a motor disconnect may not serve as the disconnect and must be field-marked.', source: ON_SRC },
  ],
  AB: [
    { rule: '6-308', summary: 'Variance 24-ECV-006-308: USEB cable with a bare neutral is again allowed at service equipment.', source: 'Alberta Safety Codes variance 24-ECV-006-308 (electricalindustry.ca, 2025-10-06)' },
  ],
  SK: [
    { rule: '26-656', summary: 'Outdoor receptacles on their own circuit, not shared with indoor outlets.', source: SK_SRC },
    { rule: '26-658', summary: 'AFCI on all dwelling branch circuits except bathroom receptacles within 1 m of the basin, fridge circuits, kitchen counter/island/peninsula receptacles, a single receptacle for a sump, septic or heating appliance, and a dedicated medical receptacle. Outbuildings are exempt.', source: SK_SRC },
    { rule: '26-704', summary: 'Outdoor 5-15R/5-20R receptacles within 2.5 m of grade (decks count as grade) need Class A GFCI; a single septic pump-out receptacle is exempt; no block-heater exemption.', source: `${SK_SRC}; TSASK 2024 CEC roll-out Q&A (2025-03-01)` },
    { rule: '26-706', summary: 'Tamper-resistant receptacles also in garages and sheds of residences.', source: SK_SRC },
    { rule: '26-724', summary: 'Read as two outdoor duplex receptacles when the dwelling perimeter exceeds 20 m.', source: SK_SRC },
    { rule: '26-806', summary: 'A cord-connected boiler on a labelled single receptacle does not need AFCI.', source: SK_SRC },
  ],
  MB: [
    { rule: '2-004', summary: 'Section 2 administrative rules 2-000 and 2-004 to 2-032 do not apply; Manitoba Hydro or the Winnipeg Electrical By-law administers permits.', source: MB_SRC },
    { rule: '6-400', summary: 'Utility metering standards prevail.', source: MB_SRC },
    { rule: '8-102', summary: 'The voltage drop limit applies to branch circuits only.', source: MB_SRC, params: { feeder: null, total: null } },
    { rule: '8-202', summary: 'EV loads count at 100% in apartment calculations unless an energy management system is used.', source: MB_SRC },
    { rule: '10-102', summary: 'Rod electrodes: two rods at least 15.8 mm in diameter, at least 3 m apart.', source: MB_SRC },
    { rule: '10-116', summary: 'No splices in the grounding conductor except by approved methods.', source: MB_SRC },
    { rule: '10-210', summary: 'Replaced by Manitoba\'s own rule.', source: MB_SRC },
    { rule: '12-2208', summary: 'Cable tray bonded at least every 15 m.', source: MB_SRC },
    { rule: '26-704', summary: 'GFCI on block-heater receptacles for emergency or fleet vehicles may be left off with written approval.', source: 'Manitoba Hydro / City of Winnipeg 2024 Technical Interpretations (2026-04-01)' },
    { rule: '26-724', summary: 'One duplex receptacle per driveway or parking area.', source: 'Manitoba Hydro / City of Winnipeg 2024 Technical Interpretations (2026-04-01)' },
    { rule: '64-110', summary: 'Single-phase inverters may not connect to three-phase systems.', source: MB_SRC },
    { rule: '76-006', summary: 'Requirements for temporary service posts.', source: MB_SRC },
  ],
  NB: [
    { rule: '26-722', summary: 'NB\'s own dwelling receptacle rule: finished rooms no point more than 1.8 m from a receptacle; kitchen counters 900 mm; islands and peninsulas 600 × 300 mm or larger need one; none directly in front of or behind the sink; hallways 4.5 m.', source: 'N.B. Reg. 2026-5 (filed 2026-03-11)' },
  ],
  PE: [
    { rule: '2-036', summary: 'The inspector may refuse permits to contractors with uncorrected defects.', source: PE_SRC },
    { rule: '6-112', summary: 'Attachment point no higher than 9 m with set clearances; masts at least 1.2 m above the roof.', source: PE_SRC },
    { rule: '64-210', summary: 'PV arc-fault protection wording changed.', source: PE_SRC },
    { rule: '72-114', summary: 'Receptacle posts in mobile home and RV parks.', source: PE_SRC },
  ],
};

/** Parameters for a rule in a province: national values with any provincial override. */
export function ruleParams(rule, province) {
  const base = RULE_PARAMS[rule];
  if (!base) throw new Error(`No parameters for Rule ${rule}`);
  const over = (AMENDMENTS[province] || []).filter((a) => a.rule === rule && a.params);
  return over.length ? Object.assign({}, base, ...over.map((a) => a.params)) : base;
}

/** Amendments that apply in a province, optionally for one rule (or rules starting with a prefix like '26-'). */
export function amendmentsFor(province, rule = null) {
  const all = AMENDMENTS[province] || [];
  if (!rule) return all;
  return all.filter((a) => a.rule === rule || (rule.endsWith('-') && a.rule.startsWith(rule)));
}
