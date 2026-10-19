// Rule data for box placement and the drawing code check. Pure data, no DOM.
//
// Electrical rules are CSA C22.1:24 (Canadian Electrical Code, Part I, 26th
// edition, "CEC 2024") rule numbers and values only. CSA's text is copyrighted:
// never paste it here. Alarm and lighting-outlet rules come from the National
// Building Code of Canada (NBC 2020), not the CEC, and are switched by settings.
// Anything with `verify` has not been confirmed against the 2024 text; the list
// and the sources are in docs/field/box-placement.md.
//
// Sources (full links in the doc):
//   [NB]   NB Reg 2026-5 adopting C22.1-24 and restating Rule 26-722 a)–g)
//   [ESA-K] ESA Bulletin 26-23-7 (May 2025, 2024 code cycle): 26-722 d) i)–vi), 26-658 kitchen exemptions
//   [ESA-L] ESA Bulletin 26-26-6 (May 2025): 26-720 e) i)–iv), g), j)
//   [ESA-G] ESA Bulletins 26-18-15 and 26-29-6 (May 2025): 26-704, 26-706, 26-708, 26-658
//   [TSBC] Technical Safety BC D-EL 2016-01 r2: 26-722 a), b), d) iii), 26-658 b)
//   [ESA-O] ESA Q&A outdoor receptacles (2021 code): 26-724 a)
//   [NBC]  NBC 2020 9.10.19.3, 9.32.3.9, 9.34.2.2 (as quoted by municipal guides)

export const CODE_BOOK = { id: 'CEC-2024', short: 'CEC 2024', name: 'Canadian Electrical Code, Part I (CSA C22.1:24)' };
export const BUILDING_CODE = { id: 'NBC-2020', short: 'NBC 2020', name: 'National Building Code of Canada 2020' };

/**
 * Every rule the placer or the checker uses. withinM on fridge, gas range and
 * laundry is our reading of "a receptacle for it": within 300 mm of the
 * appliance's footprint, i.e. behind it or right beside it. `book` is CEC, NBC (building code)
 * or practice (company habit, not code). Distances in metres.
 */
export const RULES = {
  wallSpacing: { book: 'CEC', ref: '26-722 a)', title: 'Receptacle spacing along usable wall', maxM: 1.8, src: 'NB, TSBC' },
  balcony: { book: 'CEC', ref: '26-722 b)', title: 'Receptacle on a balcony or porch', src: 'NB, TSBC' },
  usableWall: { book: 'CEC', ref: '26-722 c)', title: 'Usable wall space', minM: 0.9, src: 'NB' },
  fridge: { book: 'CEC', ref: '26-722 d) i)', title: 'Receptacle for each refrigerator', withinM: 0.3, src: 'NB, ESA-K' },
  gasRange: { book: 'CEC', ref: '26-722 d) ii)', title: 'Receptacle behind a free-standing gas range', maxHeightM: 0.13, withinM: 0.3, src: 'NB, ESA-K' },
  counter: { book: 'CEC', ref: '26-722 d) iii)', title: 'Counter receptacle spacing', maxM: 0.9, minSegmentM: 0.3, src: 'NB, ESA-K, TSBC' },
  island: { book: 'CEC', ref: '26-722 d) iv)', title: 'Receptacle at a fixed island', minLongM: 0.6, minShortM: 0.3, src: 'NB, ESA-K' },
  peninsula: { book: 'CEC', ref: '26-722 d) v)', title: 'Receptacle at a peninsula', minLongM: 0.6, minShortM: 0.3, src: 'NB, ESA-K' },
  kitchenWalls: { book: 'CEC', ref: '26-722 d) vi)', title: 'Other kitchen walls follow 26-722 a)', src: 'NB, ESA-K' },
  sinkFront: { book: 'CEC', ref: '26-722 e)', title: 'No counter receptacle directly in front of or behind a sink', src: 'NB', verify: 'Seen in the NB restatement of 26-722; confirm it is base CEC text and not an NB addition.' },
  islandSide: { book: 'CEC', ref: '26-722 f)', title: 'Island receptacle on the side face', maxBelowM: 0.3, maxOverhangM: 0.15, src: 'NB, ESA-K', verify: 'Subrule letter from the NB restatement.' },
  hallway: { book: 'CEC', ref: '26-722 g)', title: 'Hallway receptacle reach', maxM: 4.5, src: 'NB', verify: 'Subrule letter from the NB restatement; distance is a cord path, the checker uses straight lines inside the hallway.' },
  gfciWet: { book: 'CEC', ref: '26-704 1)', title: 'GFCI within 1.5 m of a sink, tub or shower', withinM: 1.5, src: 'ESA-G', verify: 'Subrule number; ESA cites "26-704" for the 1.5 m rule and "26-704 2)" for outdoors.' },
  gfciOutdoor: { book: 'CEC', ref: '26-704 2)', title: 'GFCI on outdoor receptacles within 2.5 m of grade', gradeM: 2.5, src: 'ESA-G' },
  tamper: { book: 'CEC', ref: '26-706', title: 'Tamper-resistant receptacles', src: 'ESA-G' },
  weather: { book: 'CEC', ref: '26-708', title: 'Cover for receptacles exposed to the weather', src: 'ESA-G' },
  laundry: { book: 'CEC', ref: '26-720 e) i), ii)', title: 'Laundry receptacles', withinM: 0.3, src: 'ESA-L' },
  utility: { book: 'CEC', ref: '26-720 e) iii)', title: 'Utility room receptacle', src: 'ESA-L' },
  basement: { book: 'CEC', ref: '26-720 e) iv)', title: 'Unfinished basement receptacle', src: 'ESA-L' },
  basin: { book: 'CEC', ref: '26-720 f)', title: 'Bathroom receptacle near the basin', withinM: 1.0, src: 'ESA-L (by elimination)', verify: 'Subrule f) and the 1 m distance are not in any 2024-cycle source we found; measured here from the basin edge.' },
  tub: { book: 'CEC', ref: '26-720 g)', title: 'Receptacle distance from a tub or shower', preferM: 1.0, minM: 0.5, src: 'ESA-L' },
  maxHeight: { book: 'CEC', ref: '26-720 j)', title: 'Required receptacles not over 1.7 m', maxM: 1.7, src: 'ESA-L' },
  outdoorSingle: { book: 'CEC', ref: '26-724 a)', title: 'Outdoor receptacle for a single dwelling', src: 'ESA-O', verify: 'Number from the 2021 code; confirm 2024.' },
  garage: { book: 'CEC', ref: '26-724 b)', title: 'Receptacle for each car space', src: 'IAEI 2018 notes (as 26-726 b))', verify: 'Number moved in 2018 and 2021; confirm 2024 letter and wording.' },
  afci: { book: 'CEC', ref: '26-658', title: 'Combination AFCI on 125 V 20 A-or-less receptacle circuits', src: 'ESA-G, ESA-K, TSBC' },
  smoke: { book: 'NBC', ref: '9.10.19.3', title: 'Smoke alarms: each bedroom, between bedrooms and the rest of the storey, each storey', src: 'NBC', verify: 'Building code, not CEC. Article number from municipal guides; provinces amend it.' },
  co: { book: 'NBC', ref: '9.32.3.9', title: 'CO alarm in or within 5 m of each bedroom when there is a fuel-burning appliance or attached garage', withinM: 5, src: 'NBC', verify: 'Building code; Ontario requires one adjacent to each sleeping room.' },
  lighting: { book: 'NBC', ref: '9.34.2.2', title: 'Wall-switched lighting outlet in each room (switched receptacle allowed in bedrooms and living rooms)', src: 'NBC', verify: 'BC moved CEC 30-500 series here; confirm for your province.' },
  latchSwitch: { book: 'practice', ref: 'Practice', title: 'Switch on the latch side of each entry door' },
  threeWay: { book: 'practice', ref: 'Practice', title: '3-way switches at each entry of a room with two or more entries' },
};

/** "CEC 26-722 a)" / "NBC 9.10.19.3" / "Practice". */
export function ruleLabel(id) {
  const r = RULES[id];
  if (!r) return id;
  return r.book === 'practice' ? 'Practice' : `${r.book} ${r.ref}`;
}

/**
 * Room types. wallRule: 26-722 a) 1.8 m spacing applies (bathrooms, hallways,
 * laundry and utility rooms and closets are excluded by the rule itself).
 * light: default lighting proposal (ceiling | recessed | wall | none).
 */
export const ROOM_TYPES = {
  bedroom: { label: 'Bedroom', wallRule: true, sleeping: true, light: 'ceiling', needsLight: true, switchedReceptacleOk: true },
  living: { label: 'Living / family', wallRule: true, light: 'recessed', needsLight: true, switchedReceptacleOk: true },
  kitchen: { label: 'Kitchen', wallRule: true, kitchen: true, light: 'recessed', needsLight: true },
  dining: { label: 'Dining', wallRule: true, light: 'ceiling', needsLight: true },
  bathroom: { label: 'Bathroom', wallRule: false, bathroom: true, light: 'ceiling', needsLight: true },
  hallway: { label: 'Hallway', wallRule: false, hallway: true, light: 'ceiling', needsLight: true },
  laundry: { label: 'Laundry', wallRule: false, laundry: true, light: 'ceiling', needsLight: true },
  garage: { label: 'Garage', wallRule: false, garage: true, light: 'ceiling', needsLight: false },
  basement: { label: 'Unfinished basement', wallRule: false, basement: true, light: 'ceiling', needsLight: false },
  outdoor: { label: 'Outdoor / balcony', wallRule: false, outdoor: true, light: 'wall', needsLight: false },
  other: { label: 'Other finished room', wallRule: true, light: 'ceiling', needsLight: false },
};
export const ROOM_TYPE_ORDER = Object.keys(ROOM_TYPES);

/**
 * Things you mark on a room. Wall features sit on wall `wall` (edge index) from
 * `atM` to `atM + widthM` (metres from the wall's start corner) and reach
 * `depthM` into the room. Islands are free-standing (centre x, y in world px).
 * blocks: takes the wall out of usable wall space (26-722 c)).
 */
export const FEATURE_KINDS = {
  door: { label: 'Door', widthM: 0.81, depthM: 0, blocks: true },
  opening: { label: 'Opening (no door)', widthM: 0.91, depthM: 0, blocks: true },
  window: { label: 'Window', widthM: 1.2, depthM: 0, blocks: false },
  obstruction: { label: 'Built-in / fireplace', widthM: 1.2, depthM: 0.4, blocks: true },
  counter: { label: 'Counter', widthM: 2.4, depthM: 0.635, blocks: true },
  sink: { label: 'Sink / basin', widthM: 0.8, depthM: 0.5, blocks: true, wet: true },
  cooktop: { label: 'Cooktop / built-in', widthM: 0.76, depthM: 0.5, blocks: true },
  range: { label: 'Range', widthM: 0.76, depthM: 0.65, blocks: true },
  fridge: { label: 'Fridge', widthM: 0.91, depthM: 0.75, blocks: true },
  washer: { label: 'Washer', widthM: 0.69, depthM: 0.7, blocks: true },
  tub: { label: 'Bathtub', widthM: 1.52, depthM: 0.76, blocks: true, wet: true },
  shower: { label: 'Shower', widthM: 0.91, depthM: 0.91, blocks: true, wet: true },
  island: { label: 'Island / peninsula', lengthM: 1.8, depthM: 0.9, free: true },
};
export const FEATURE_ORDER = Object.keys(FEATURE_KINDS);
export const WET_KINDS = new Set(['sink', 'tub', 'shower']);

/**
 * Company placement habits. None of these are code values; they are the
 * defaults a contractor can change (Settings -> placement, or per drawing).
 */
export const DEFAULT_PLACEMENT = {
  receptacleHeightM: 0.4, // centre above floor
  counterHeightM: 1.1, // centre above floor, over a 915 mm counter
  applianceHeightM: 1.1, // fridge and washer receptacles
  switchHeightM: 1.2, // centre above floor
  switchFromJambM: 0.15, // from the latch-side jamb to the box centre
  recessedSpacingM: 1.5,
  hallLightSpacingM: 3,
  cornerClearM: 0.15, // keep boxes off inside corners when the spacing allows
  excludeDoorSwing: true, // 26-722 c): wall behind a fully opened door is not usable
  threeWay: true,
  alarms: { bedrooms: true, hallways: true, basement: true },
  wallTolM: 0.45, // how far from a wall a symbol can sit and still count as on it
};

/** Merge company settings and drawing overrides over the defaults. */
export function placementSettings(...layers) {
  const out = { ...DEFAULT_PLACEMENT, alarms: { ...DEFAULT_PLACEMENT.alarms } };
  for (const l of layers) {
    if (!l || typeof l !== 'object') continue;
    for (const [k, v] of Object.entries(l)) {
      if (v == null) continue;
      if (k === 'alarms' && typeof v === 'object') Object.assign(out.alarms, v);
      else if (k in DEFAULT_PLACEMENT) out[k] = v;
    }
  }
  return out;
}

/** Symbol families, by canvas symbol id (js/canvas/symbols.js). */
export const RECEPTACLE_SYMBOLS = new Set(['receptacle', 'receptacle-gfci']); // 5-15R / 5-20R
export const SWITCH_SYMBOLS = new Set(['switch', 'switch-3way', 'switch-dimmer']);
export const LIGHT_SYMBOLS = new Set(['light-ceiling', 'light-recessed', 'light-wall', 'fan']);
export const ALARM_SYMBOLS = new Set(['smoke']);
