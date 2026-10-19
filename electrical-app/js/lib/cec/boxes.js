// Box fill, CEC Rule 12-3034 with Tables 22 and 23. Volumes in mL.
//
// Counting (2021 and later; Alberta STANDATA 21-ECI-012 and IAEI 2021):
//  - each insulated conductor passing through counts 1; each one entering and ending in the box counts 1;
//  - a conductor that never leaves the box counts 0, and so do 18/16 AWG fixture wires
//    from a luminaire mounted on the box;
//  - deduct 2 conductors for each single-strap device;
//  - deduct 1 for each fixture stud or hickey;
//  - deduct 1 for each pair of wire connectors (2-3 connectors = 1, 4-5 = 2; ABB catalogue reading);
//  - cable clamps, locknuts and bushings are not counted;
//  - every allowance uses the space of the largest conductor in the box (2021 change).
// Bare bonding conductors are not counted (the rule counts insulated conductors). VERIFY that
// reading, and the allowance for devices deeper than 25.4 mm, which isn't modelled.

/**
 * Table 22: usable space per insulated conductor, mL. Confirmed: ABB/Iberville Canada
 * gangable device box catalogue (A5-A6), which reproduces the table.
 */
export const TABLE_22 = { '14': 24.6, '12': 28.7, '10': 36.9, '8': 45.1, '6': 73.7 };

/**
 * Common boxes and their volume, mL, from the ABB/Iberville Canada catalogue's box-fill
 * tables (CEC 2012 basis). VERIFY against CEC 2024 Table 23 (volumes in Table 23 are rounded
 * to the mL, so counts allow 1 mL of rounding; that reproduces the catalogue's counts).
 */
export const BOXES = [
  { id: 'oct-4x1.5', name: '4 in. octagon × 1-1/2 in.', volumeML: 245 },
  { id: 'oct-4x2.125', name: '4 in. octagon × 2-1/8 in.', volumeML: 344 },
  { id: 'sq-4x1.5', name: '4 in. square × 1-1/2 in.', volumeML: 344 },
  { id: 'sq-4x2.125', name: '4 in. square × 2-1/8 in.', volumeML: 491 },
  { id: 'sq-411x1.5', name: '4-11/16 in. square × 1-1/2 in.', volumeML: 491 },
  { id: 'sq-411x2.125', name: '4-11/16 in. square × 2-1/8 in.', volumeML: 688 },
  { id: 'dev-1.5', name: 'Device box 3 × 2 × 1-1/2 in.', volumeML: 131 },
  { id: 'dev-2', name: 'Device box 3 × 2 × 2 in.', volumeML: 163 },
  { id: 'dev-2.25', name: 'Device box 3 × 2 × 2-1/4 in.', volumeML: 180 },
  { id: 'dev-2.5', name: 'Device box 3 × 2 × 2-1/2 in.', volumeML: 204 },
  { id: 'dev-3', name: 'Device box 3 × 2 × 3 in.', volumeML: 245 },
];

const ROUNDING_ML = 1;

/** Largest number of conductors of one size a volume holds (Table 23 style). */
export function maxConductorsInBox(volumeML, size) {
  const each = TABLE_22[size];
  if (!each || !(volumeML > 0)) return 0;
  return Math.floor((Number(volumeML) + ROUNDING_ML) / each + 1e-9);
}

const bigger = (a, b) => (b == null || (TABLE_22[a] || 0) > (TABLE_22[b] || 0) ? a : b);

/**
 * boxFill({ conductors: [{ size, count }], devices, studs, connectors, boxML, extraML })
 * -> { items, count, largest, eachML, requiredML, availableML, pass, maxConductors }
 * `extraML` is the marked volume of an extension ring or raised cover.
 */
export function boxFill({ conductors = [], devices = 0, studs = 0, connectors = 0, boxML = 0, extraML = 0 }) {
  let largest = null, wires = 0;
  for (const c of conductors) {
    const n = Number(c.count) || 0;
    if (!n || !TABLE_22[c.size]) continue;
    wires += n;
    largest = bigger(c.size, largest);
  }
  const items = [];
  const each = largest ? TABLE_22[largest] : 0;
  const add = (label, count) => { if (count > 0) items.push({ label, count, each, volume: count * each }); };
  for (const c of conductors) {
    const n = Number(c.count) || 0;
    if (n && TABLE_22[c.size]) add(`${n} × ${c.size} AWG conductor${n > 1 ? 's' : ''}${c.size !== largest ? ` (counted at ${largest} AWG)` : ''}`, n);
  }
  const dev = Math.max(0, Math.floor(Number(devices) || 0));
  const stud = Math.max(0, Math.floor(Number(studs) || 0));
  const pairs = Math.floor(Math.max(0, Number(connectors) || 0) / 2);
  add(`${dev} device${dev > 1 ? 's' : ''}, 2 each`, dev * 2);
  add(`${stud} fixture stud${stud > 1 ? 's' : ''} / hickey${stud > 1 ? 's' : ''}`, stud);
  add(`${Number(connectors)} wire connectors, 1 per pair`, pairs);
  const count = items.reduce((s, i) => s + i.count, 0);
  const requiredML = count * each;
  const availableML = (Number(boxML) || 0) + (Number(extraML) || 0);
  return {
    items, count, wires, largest, eachML: each, requiredML, availableML,
    maxConductors: largest ? maxConductorsInBox(availableML, largest) : null,
    pass: availableML > 0 ? requiredML <= availableML + ROUNDING_ML + 1e-9 : null,
  };
}

/** Text for the calculator. */
export const BOX_RULES = {
  countHint: 'Each conductor in and out counts 1; ones that stay in the box count 0',
  summary: [
    'Rule 12-3034: space per conductor from Table 22, at the largest conductor size in the box.',
    'Deduct 2 per device strap, 1 per fixture stud or hickey, 1 per pair of wire connectors. Clamps and bare bonding conductors are not counted.',
  ],
};
