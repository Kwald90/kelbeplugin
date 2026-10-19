// Electrical calculations and NEC 2023 data tables. Pure functions, no DOM.
// These are estimating aids. A licensed electrician must verify every design
// against the adopted code edition and local amendments (the AHJ decides).

// ---------------------------------------------------------------------------
// Conductors
// ---------------------------------------------------------------------------

/** Sizes in ascending order. */
export const SIZES = ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500'];

export const sizeLabel = (s) => (/^\d{3}$/.test(s) ? `${s} kcmil` : `${s} AWG`);

/**
 * NEC Chapter 9, Table 8: circular mils and DC resistance at 75 °C,
 * ohms per 1000 ft, stranded uncoated copper and aluminum.
 */
export const TABLE_8 = {
  '14': { cm: 4110, cu: 3.07, al: 5.06 },
  '12': { cm: 6530, cu: 1.93, al: 3.18 },
  '10': { cm: 10380, cu: 1.21, al: 2.00 },
  '8': { cm: 16510, cu: 0.764, al: 1.26 },
  '6': { cm: 26240, cu: 0.491, al: 0.808 },
  '4': { cm: 41740, cu: 0.308, al: 0.508 },
  '3': { cm: 52620, cu: 0.245, al: 0.403 },
  '2': { cm: 66360, cu: 0.194, al: 0.319 },
  '1': { cm: 83690, cu: 0.154, al: 0.253 },
  '1/0': { cm: 105600, cu: 0.122, al: 0.201 },
  '2/0': { cm: 133100, cu: 0.0967, al: 0.159 },
  '3/0': { cm: 167800, cu: 0.0766, al: 0.126 },
  '4/0': { cm: 211600, cu: 0.0608, al: 0.100 },
  '250': { cm: 250000, cu: 0.0515, al: 0.0847 },
  '300': { cm: 300000, cu: 0.0429, al: 0.0707 },
  '350': { cm: 350000, cu: 0.0367, al: 0.0605 },
  '400': { cm: 400000, cu: 0.0321, al: 0.0529 },
  '500': { cm: 500000, cu: 0.0258, al: 0.0424 },
};

/**
 * NEC Table 310.16: allowable ampacity, not more than three current-carrying
 * conductors, 30 °C ambient. [60 °C, 75 °C, 90 °C]. null = not listed.
 */
export const TABLE_310_16 = {
  cu: {
    '14': [15, 20, 25], '12': [20, 25, 30], '10': [30, 35, 40], '8': [40, 50, 55], '6': [55, 65, 75],
    '4': [70, 85, 95], '3': [85, 100, 115], '2': [95, 115, 130], '1': [110, 130, 145],
    '1/0': [125, 150, 170], '2/0': [145, 175, 195], '3/0': [165, 200, 225], '4/0': [195, 230, 260],
    '250': [215, 255, 290], '300': [240, 285, 320], '350': [260, 310, 350], '400': [280, 335, 380], '500': [320, 380, 430],
  },
  al: {
    '14': [null, null, null], '12': [15, 20, 25], '10': [25, 30, 35], '8': [35, 40, 45], '6': [40, 50, 55],
    '4': [55, 65, 75], '3': [65, 75, 85], '2': [75, 90, 100], '1': [85, 100, 115],
    '1/0': [100, 120, 135], '2/0': [115, 135, 150], '3/0': [130, 155, 175], '4/0': [150, 180, 205],
    '250': [170, 205, 230], '300': [195, 230, 260], '350': [210, 250, 280], '400': [225, 270, 305], '500': [260, 310, 350],
  },
};

const TEMP_COL = { 60: 0, 75: 1, 90: 2 };

export function ampacity(size, material = 'cu', tempC = 75) {
  const row = TABLE_310_16[material]?.[size];
  if (!row) return null;
  return row[TEMP_COL[tempC] ?? 1];
}

/** NEC 240.4(D): small conductor overcurrent protection limits. */
export const SMALL_CONDUCTOR_OCPD = { cu: { '14': 15, '12': 20, '10': 30 }, al: { '12': 15, '10': 25 } };

/**
 * NEC Table 310.15(B)(1)(1): ambient temperature correction, 30 °C base.
 * Rows: [max ambient °C, 60 °C factor, 75 °C factor, 90 °C factor].
 */
export const AMBIENT_CORRECTION = [
  [10, 1.29, 1.20, 1.15], [15, 1.22, 1.15, 1.12], [20, 1.15, 1.11, 1.08], [25, 1.08, 1.05, 1.04],
  [30, 1.00, 1.00, 1.00], [35, 0.91, 0.94, 0.96], [40, 0.82, 0.88, 0.91], [45, 0.71, 0.82, 0.87],
  [50, 0.58, 0.75, 0.82], [55, 0.41, 0.67, 0.76], [60, null, 0.58, 0.71], [65, null, 0.47, 0.65],
  [70, null, 0.33, 0.58], [75, null, null, 0.50], [80, null, null, 0.41], [85, null, null, 0.29],
];

/** Ambient correction factor; null when the insulation can't be used at that ambient. */
export function ambientFactor(ambientC = 30, tempC = 90) {
  const col = (TEMP_COL[tempC] ?? 2) + 1;
  for (const row of AMBIENT_CORRECTION) if (ambientC <= row[0]) return row[col];
  return null;
}

/** NEC Table 310.15(C)(1): adjustment for more than three current-carrying conductors. */
export function cccFactor(ccc = 3) {
  if (ccc <= 3) return 1;
  if (ccc <= 6) return 0.8;
  if (ccc <= 9) return 0.7;
  if (ccc <= 20) return 0.5;
  if (ccc <= 30) return 0.45;
  if (ccc <= 40) return 0.4;
  return 0.35;
}

/** NEC 240.6(A) standard ampere ratings for fuses and inverse-time breakers. */
export const STANDARD_OCPD = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250,
  300, 350, 400, 450, 500, 600, 700, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000, 5000, 6000];

/** Smallest standard OCPD rating at or above `amps`. */
export function nextStandardOCPD(amps) {
  return STANDARD_OCPD.find((a) => a >= amps - 1e-9) ?? null;
}

/** Largest standard OCPD at or below `amps`. */
export function prevStandardOCPD(amps) {
  let best = null;
  for (const a of STANDARD_OCPD) if (a <= amps + 1e-9) best = a;
  return best;
}

/**
 * Largest OCPD allowed to protect a conductor of the given (adjusted) ampacity:
 * 240.4(B) next size up when the ampacity isn't a standard rating and the
 * device is 800 A or less, capped by 240.4(D) for small conductors.
 */
export function maxOCPDForConductor(size, material, conductorAmpacity) {
  let max = STANDARD_OCPD.includes(conductorAmpacity) ? conductorAmpacity : nextStandardOCPD(conductorAmpacity);
  if (max > 800) max = prevStandardOCPD(conductorAmpacity);
  const small = SMALL_CONDUCTOR_OCPD[material]?.[size];
  if (small != null) max = Math.min(max, small);
  return max;
}

// ---------------------------------------------------------------------------
// Voltage drop
// ---------------------------------------------------------------------------

/** K: resistivity of the conductor in ohm-cmil/ft (approximate, at 75 °C). */
export const K = { cu: 12.9, al: 21.2 };

/**
 * voltageDrop({ volts, phase, amps, lengthFt (one way), size, material })
 * Returns both the K method (VD = 2·K·I·L/CM or 1.732·K·I·L/CM) and the
 * Chapter 9 Table 8 resistance method (VD = 2·R·I·L/1000 or 1.732·R·I·L/1000).
 * `volts`/`percent`/`endVolts` use the K method, the usual field method.
 */
export function voltageDrop({ volts, phase = 1, amps, lengthFt, size, material = 'cu' }) {
  const t = TABLE_8[size];
  if (!t) throw new Error(`Unknown conductor size ${size}`);
  const mult = Number(phase) === 3 ? Math.sqrt(3) : 2;
  const kVolts = (mult * K[material] * amps * lengthFt) / t.cm;
  const rVolts = (mult * t[material] * amps * lengthFt) / 1000;
  return {
    volts: kVolts,
    percent: (kVolts / volts) * 100,
    endVolts: volts - kVolts,
    tableVolts: rVolts,
    tablePercent: (rVolts / volts) * 100,
    cm: t.cm,
    ohmsPerKft: t[material],
  };
}

/** Smallest conductor whose K-method voltage drop is within maxPct. */
export function minSizeForVoltageDrop({ volts, phase = 1, amps, lengthFt, material = 'cu', maxPct = 3 }) {
  for (const s of SIZES) {
    if (material === 'al' && s === '14') continue;
    if (voltageDrop({ volts, phase, amps, lengthFt, size: s, material }).percent <= maxPct + 1e-9) return s;
  }
  return null;
}

/** Maximum one-way length for a conductor to stay within maxPct drop. */
export function maxLengthForVoltageDrop({ volts, phase = 1, amps, size, material = 'cu', maxPct = 3 }) {
  const mult = Number(phase) === 3 ? Math.sqrt(3) : 2;
  return ((maxPct / 100) * volts * TABLE_8[size].cm) / (mult * K[material] * amps);
}

// ---------------------------------------------------------------------------
// Conductor sizing
// ---------------------------------------------------------------------------

/**
 * sizeConductor({ amps, continuous, material, tempRating (terminations 60|75),
 *   insulationRating (90 for THHN/THWN-2), ambientC, ccc, maxVdPct, volts, phase, lengthFt })
 *
 * A size passes when:
 *  1. termination column ampacity ≥ 125% of continuous load + noncontinuous load
 *     (210.19(A)(1), 215.2(A)(1), 110.14(C)) — no adjustment factors here;
 *  2. insulation column ampacity × ambient × CCC factors ≥ the load (310.15);
 *  3. the OCPD needed for the load (125% continuous, next standard size) is
 *     allowed to protect it (240.4(B), 240.4(D));
 *  4. voltage drop ≤ maxVdPct when a length and voltage are given (210.19 IN No. 2).
 */
export function sizeConductor(opts) {
  const {
    amps, continuous = false, material = 'cu', tempRating = 75, insulationRating = 90,
    ambientC = 30, ccc = 3, maxVdPct = 3, volts = 0, phase = 1, lengthFt = 0,
  } = opts;
  const load = Number(amps) || 0;
  const required = continuous ? load * 1.25 : load;
  const amb = ambientFactor(ambientC, insulationRating);
  const adj = cccFactor(ccc);
  if (amb == null) return { size: null, error: `${insulationRating} °C insulation can't be used at ${ambientC} °C ambient (Table 310.15(B)(1)(1)).` };
  const factor = amb * adj;
  const ocpd = nextStandardOCPD(required);
  const tried = [];

  for (const size of SIZES) {
    const term = ampacity(size, material, tempRating);
    const ins = ampacity(size, material, insulationRating);
    if (term == null || ins == null) continue;
    const derated = ins * factor;
    // The usable ampacity can't exceed the termination rating either (110.14(C)).
    const usable = Math.min(derated, term);
    const why = [];
    if (term < required) why.push(`${term} A at ${tempRating} °C terminations < ${fmt(required)} A required`);
    if (derated < load) why.push(`${fmt(derated)} A after correction (${ins} A × ${fmt(factor, 3)}) < ${fmt(load)} A load`);
    const maxOcpd = maxOCPDForConductor(size, material, usable);
    if (ocpd != null && maxOcpd < ocpd) why.push(`a ${ocpd} A breaker can't protect it (max ${maxOcpd} A, 240.4)`);
    let vd = null;
    if (volts > 0 && lengthFt > 0) {
      vd = voltageDrop({ volts, phase, amps: load, lengthFt, size, material });
      if (vd.percent > maxVdPct) why.push(`voltage drop ${fmt(vd.percent, 2)}% > ${maxVdPct}%`);
    }
    tried.push({ size, why });
    if (!why.length) {
      const ampOnly = tried.find((t) => !t.why.some((w) => !w.startsWith('voltage drop')));
      const reasons = [
        `Load ${fmt(load)} A${continuous ? ` × 125% continuous = ${fmt(required)} A` : ''}.`,
        `${sizeLabel(size)} ${material === 'cu' ? 'Cu' : 'Al'}: ${term} A at the ${tempRating} °C termination column (Table 310.16).`,
        factor !== 1
          ? `${insulationRating} °C column ${ins} A × ${fmt(amb, 2)} ambient (${ambientC} °C) × ${fmt(adj, 2)} (${ccc} CCC) = ${fmt(derated)} A.`
          : `${insulationRating} °C column ${ins} A, no correction needed.`,
        `Breaker ${ocpd} A (next standard size, 240.6(A)); conductor allows up to ${maxOcpd} A.`,
      ];
      if (vd) reasons.push(`Voltage drop ${fmt(vd.volts, 2)} V (${fmt(vd.percent, 2)}%) over ${lengthFt} ft.`);
      const governedBy = ampOnly && ampOnly.size !== size ? 'voltage drop' : 'ampacity';
      if (governedBy === 'voltage drop') reasons.push(`Upsized from ${sizeLabel(ampOnly.size)} for voltage drop.`);
      return { size, label: sizeLabel(size), material, ocpd, maxOcpd, terminationAmpacity: term, deratedAmpacity: derated, factor, ambient: amb, adjustment: adj, required, vd, governedBy, reasons, rejected: tried.slice(0, -1) };
    }
  }
  return { size: null, error: 'Load is beyond 500 kcmil: use parallel conductors (310.10(G)).', rejected: tried, ocpd, required };
}

function fmt(n, d = 1) {
  const p = 10 ** d;
  return String(Math.round(n * p) / p);
}

// ---------------------------------------------------------------------------
// Conduit fill
// ---------------------------------------------------------------------------

export const TRADE_SIZES = ['1/2', '3/4', '1', '1-1/4', '1-1/2', '2', '2-1/2', '3', '3-1/2', '4'];

/** NEC Chapter 9, Table 4: total internal area (100%), in². */
export const TABLE_4 = {
  EMT: [0.304, 0.533, 0.864, 1.496, 2.036, 3.356, 5.858, 8.846, 11.545, 14.753],
  'PVC Sch 40': [0.285, 0.508, 0.832, 1.453, 1.986, 3.291, 4.695, 7.268, 9.737, 12.554],
  'PVC Sch 80': [0.217, 0.409, 0.688, 1.237, 1.711, 2.874, 4.119, 6.442, 8.688, 11.258],
  RMC: [0.314, 0.549, 0.887, 1.526, 2.071, 3.408, 4.866, 7.499, 10.010, 12.882],
};

/** NEC Chapter 9, Table 5: approximate conductor area, in². */
export const TABLE_5 = {
  THHN: {
    '14': 0.0097, '12': 0.0133, '10': 0.0211, '8': 0.0366, '6': 0.0507, '4': 0.0824, '3': 0.0973, '2': 0.1158, '1': 0.1562,
    '1/0': 0.1855, '2/0': 0.2223, '3/0': 0.2679, '4/0': 0.3237, '250': 0.3970, '300': 0.4608, '350': 0.5242, '400': 0.5863, '500': 0.7073,
  },
  XHHW: {
    '14': 0.0139, '12': 0.0181, '10': 0.0243, '8': 0.0437, '6': 0.0590, '4': 0.0814, '3': 0.0962, '2': 0.1146, '1': 0.1534,
    '1/0': 0.1825, '2/0': 0.2190, '3/0': 0.2642, '4/0': 0.3197, '250': 0.3904, '300': 0.4536, '350': 0.5166, '400': 0.5782, '500': 0.6984,
  },
};
TABLE_5['THWN-2'] = TABLE_5.THHN;

/** Chapter 9, Table 1: max fill — 53% for one conductor, 31% for two, 40% for over two. */
export function allowedFillPct(count) {
  if (count <= 1) return 53;
  if (count === 2) return 31;
  return 40;
}

/** conduitFill({ conduitType, tradeSize, wires: [{ size, insulation, count }] }) */
export function conduitFill({ conduitType = 'EMT', tradeSize, wires = [] }) {
  const idx = TRADE_SIZES.indexOf(tradeSize);
  const areas = TABLE_4[conduitType];
  if (!areas || idx < 0) throw new Error(`Unknown conduit ${conduitType} ${tradeSize}`);
  const area = areas[idx];
  let wireArea = 0, count = 0;
  for (const w of wires) {
    const a = TABLE_5[w.insulation || 'THHN']?.[w.size];
    const n = Number(w.count) || 0;
    if (a == null || n <= 0) continue;
    wireArea += a * n;
    count += n;
  }
  const allowedPct = allowedFillPct(count);
  const fillPct = (wireArea / area) * 100;
  return { conduitArea: area, wireArea, count, fillPct, allowedPct, allowedArea: (area * allowedPct) / 100, pass: fillPct <= allowedPct + 1e-9 };
}

/** Smallest trade size that passes; null if none up to 4". */
export function minConduit({ conduitType = 'EMT', wires = [] }) {
  for (const t of TRADE_SIZES) {
    const r = conduitFill({ conduitType, tradeSize: t, wires });
    if (r.pass) return { tradeSize: t, ...r };
  }
  return null;
}

/** How many identical conductors fit (Annex C style), for > 2 conductors. */
export function maxConductors({ conduitType = 'EMT', tradeSize, size, insulation = 'THHN' }) {
  const area = TABLE_4[conduitType][TRADE_SIZES.indexOf(tradeSize)];
  const a = TABLE_5[insulation][size];
  for (let n = Math.floor(area / a); n > 0; n--) {
    if ((n * a) / area * 100 <= allowedFillPct(n) + 1e-9) return n;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Box fill, NEC 314.16
// ---------------------------------------------------------------------------

/** Table 314.16(B)(1): volume allowance per conductor, in³. */
export const BOX_VOLUME_PER_CONDUCTOR = { '18': 1.5, '16': 1.75, '14': 2.0, '12': 2.25, '10': 2.5, '8': 3.0, '6': 5.0 };

/** Common boxes from Table 314.16(A), in³. */
export const STANDARD_BOXES = [
  { name: '3 × 2 × 2-1/2 device box', volume: 12.5 },
  { name: '3 × 2 × 2-3/4 device box', volume: 14.0 },
  { name: '3 × 2 × 3-1/2 device box', volume: 18.0 },
  { name: '4 × 1-1/2 round/octagon', volume: 15.5 },
  { name: '4 × 2-1/8 round/octagon', volume: 21.5 },
  { name: '4 × 1-1/2 square', volume: 21.0 },
  { name: '4 × 2-1/8 square', volume: 30.3 },
  { name: '4-11/16 × 1-1/2 square', volume: 29.5 },
  { name: '4-11/16 × 2-1/8 square', volume: 42.0 },
];

/**
 * boxFill({ conductors: [{ size, count }], clamps (bool), supportFittings (n),
 *   devices: [{ size }] (size = largest conductor on that device), grounds: [{ size, count }],
 *   boxVolume, extraVolume (plaster ring etc.) })
 * Rules, 314.16(B):
 *  (1) each conductor entering and terminating or spliced counts 1;
 *  (2) one or more internal clamps count 1, by the largest conductor;
 *  (3) each type of support fitting counts 1, by the largest conductor;
 *  (4) each device yoke counts 2, by the largest conductor on it;
 *  (5) equipment grounding conductors: up to four count 1 (largest EGC),
 *      each additional EGC counts 1/4.
 */
export function boxFill({ conductors = [], clamps = false, supportFittings = 0, devices = [], grounds = [], boxVolume = 0, extraVolume = 0 }) {
  const vol = (s) => BOX_VOLUME_PER_CONDUCTOR[s] ?? 0;
  const items = [];
  let largest = null;
  // compare by volume allowance so 18/16 AWG work too
  const larger = (a, b) => (b == null || vol(a) > vol(b) ? a : b);
  for (const c of conductors) {
    const n = Number(c.count) || 0;
    if (!n) continue;
    items.push({ label: `${n} × ${c.size} AWG conductors`, count: n, each: vol(c.size), volume: n * vol(c.size) });
    largest = larger(c.size, largest);
  }
  if (clamps && largest) items.push({ label: 'Internal clamps', count: 1, each: vol(largest), volume: vol(largest) });
  if (supportFittings > 0 && largest) items.push({ label: 'Support fittings', count: supportFittings, each: vol(largest), volume: supportFittings * vol(largest) });
  for (const d of devices) {
    const s = d.size || largest;
    if (!s) continue;
    items.push({ label: `Device yoke (${s} AWG)`, count: 2, each: vol(s), volume: 2 * vol(s) });
  }
  let egcCount = 0, egcLargest = null;
  for (const g of grounds) {
    const n = Number(g.count) || 0;
    if (!n) continue;
    egcCount += n;
    egcLargest = larger(g.size, egcLargest);
  }
  if (egcCount && egcLargest) {
    const units = 1 + Math.max(0, egcCount - 4) * 0.25;
    items.push({ label: `${egcCount} grounding conductor${egcCount > 1 ? 's' : ''} (${egcLargest} AWG)`, count: units, each: vol(egcLargest), volume: units * vol(egcLargest) });
  }
  const required = items.reduce((s, i) => s + i.volume, 0);
  const available = (Number(boxVolume) || 0) + (Number(extraVolume) || 0);
  return { items, required, available, pass: available > 0 ? required <= available + 1e-9 : null };
}

// ---------------------------------------------------------------------------
// Dwelling load calculation, Article 220
// ---------------------------------------------------------------------------

export const SERVICE_SIZES = [100, 125, 150, 175, 200, 225, 300, 320, 400, 600, 800];

function nextService(amps) {
  // 230.79(C): 100 A minimum for a one-family dwelling.
  return SERVICE_SIZES.find((s) => s >= Math.max(100, amps - 1e-9)) ?? null;
}

/** 220.55 Table, Column C, for one range: ≤12 kW → 8 kW; over 12 kW add 5% per kW (major fraction counts). */
export function rangeDemandVA(kw) {
  const k = Number(kw) || 0;
  if (k <= 0) return 0;
  if (k <= 12) {
    // Note 3 allows Column A/B for 1¾–8¾ kW; Column C (8 kW) is the conservative default.
    return 8000;
  }
  const over = Math.round(k - 12);
  return Math.round(8000 * (1 + 0.05 * over));
}

/**
 * dwellingLoadCalc({ sqft, smallApplianceCircuits (≥2), laundryCircuits (≥1),
 *   appliances: [{ name, va }] (fastened in place: water heater, dishwasher, disposal...),
 *   dryerVA, rangeKW, heatVA, acVA, evVA: [va...], largestMotorVA, volts })
 * Standard method, Article 220 Part III (NEC 2023 numbering; 2020 in brackets):
 *  - general lighting 3 VA/ft² (220.41 [220.12])
 *  - small appliance 1500 VA each, ≥ 2 (220.52(A)); laundry 1500 VA (220.52(B))
 *  - demand: first 3000 VA at 100%, 3001–120,000 at 35%, rest 25% (220.45 [220.42])
 *  - fastened-in-place appliances: 75% when four or more (220.53)
 *  - dryer: 5000 VA or nameplate, whichever is larger (220.54)
 *  - range: Table 220.55 Column C
 *  - heat vs A/C: the larger, noncoincident (220.60)
 *  - EVSE: 7200 W or nameplate, whichever is larger (220.57)
 *  - largest motor +25% (220.50, 430.24), optional input
 */
export function dwellingLoadCalc(o) {
  const volts = o.volts || 240;
  const lines = [];
  const general = (Number(o.sqft) || 0) * 3;
  const sa = Math.max(2, Number(o.smallApplianceCircuits ?? 2)) * 1500;
  const laundry = Math.max(1, Number(o.laundryCircuits ?? 1)) * 1500;
  const glTotal = general + sa + laundry;
  const demandGL = Math.min(glTotal, 3000) + Math.max(0, Math.min(glTotal, 120000) - 3000) * 0.35 + Math.max(0, glTotal - 120000) * 0.25;
  lines.push({ label: `General lighting ${o.sqft || 0} ft² × 3 VA`, rule: '220.41', va: general });
  lines.push({ label: `Small appliance circuits`, rule: '220.52(A)', va: sa });
  lines.push({ label: `Laundry circuit`, rule: '220.52(B)', va: laundry });
  lines.push({ label: `Lighting & receptacle demand (3000 @ 100%, rest @ 35%)`, rule: '220.45', va: demandGL, demand: true });

  const apps = (o.appliances || []).filter((a) => Number(a.va) > 0);
  const appSum = apps.reduce((s, a) => s + Number(a.va), 0);
  const appFactor = apps.length >= 4 ? 0.75 : 1;
  const appDemand = appSum * appFactor;
  if (apps.length) lines.push({ label: `Fastened-in-place appliances (${apps.length}) ${appFactor < 1 ? '@ 75%' : '@ 100%'}`, rule: '220.53', va: appDemand, demand: true });

  let dryer = 0;
  if (Number(o.dryerVA) > 0) { dryer = Math.max(5000, Number(o.dryerVA)); lines.push({ label: 'Dryer (5000 VA min)', rule: '220.54', va: dryer, demand: true }); }

  const range = rangeDemandVA(o.rangeKW);
  if (range) lines.push({ label: `Range ${o.rangeKW} kW, Column C`, rule: '220.55', va: range, demand: true });

  const heat = Number(o.heatVA) || 0, ac = Number(o.acVA) || 0;
  const hvac = Math.max(heat, ac);
  if (hvac) lines.push({ label: `${heat >= ac ? 'Heating' : 'Air conditioning'} (larger of heat / A/C)`, rule: '220.60', va: hvac, demand: true });

  const evs = (o.evVA || []).map(Number).filter((v) => v > 0).map((v) => Math.max(7200, v));
  const ev = evs.reduce((s, v) => s + v, 0);
  if (ev) lines.push({ label: `EV charging (${evs.length}) at 7200 VA min`, rule: '220.57', va: ev, demand: true });

  const motor = (Number(o.largestMotorVA) || 0) * 0.25;
  if (motor) lines.push({ label: '25% of largest motor', rule: '220.50, 430.24', va: motor, demand: true });

  const totalVA = demandGL + appDemand + dryer + range + hvac + ev + motor;
  const amps = totalVA / volts;
  return { method: 'standard', lines, totalVA, amps, service: nextService(amps), volts };
}

/**
 * Optional method, 220.82 (one-family dwelling, 120/240 V or 208Y/120, ≥100 A service).
 * General load = 3 VA/ft² + 1500 VA per small-appliance and laundry circuit +
 * nameplate of fastened-in-place appliances, range, dryer, water heater, EVSE
 * (220.82(B)); first 10 kVA at 100%, remainder at 40%. Plus heating/A-C
 * (220.82(C)): the larger of 100% A/C and 65% central electric heat.
 */
export function dwellingLoadOptional(o) {
  const volts = o.volts || 240;
  const lines = [];
  const general = (Number(o.sqft) || 0) * 3;
  const circuits = (Math.max(2, Number(o.smallApplianceCircuits ?? 2)) + Math.max(1, Number(o.laundryCircuits ?? 1))) * 1500;
  const apps = (o.appliances || []).reduce((s, a) => s + (Number(a.va) || 0), 0);
  const dryer = Number(o.dryerVA) || 0;
  const range = (Number(o.rangeKW) || 0) * 1000;
  const ev = (o.evVA || []).map(Number).filter((v) => v > 0).reduce((s, v) => s + v, 0);
  const gl = general + circuits + apps + dryer + range + ev;
  lines.push({ label: 'Lighting 3 VA/ft²', rule: '220.82(B)(1)', va: general });
  lines.push({ label: 'Small appliance + laundry circuits', rule: '220.82(B)(2)', va: circuits });
  lines.push({ label: 'Appliances, range, dryer, EV (nameplate)', rule: '220.82(B)(3)', va: apps + dryer + range + ev });
  const demandGL = Math.min(gl, 10000) + Math.max(0, gl - 10000) * 0.4;
  lines.push({ label: 'General load demand (10 kVA @ 100%, rest @ 40%)', rule: '220.82(B)', va: demandGL, demand: true });
  const heat = (Number(o.heatVA) || 0) * 0.65, ac = Number(o.acVA) || 0;
  const hvac = Math.max(heat, ac);
  if (hvac) lines.push({ label: ac >= heat ? 'A/C at 100%' : 'Central electric heat at 65%', rule: '220.82(C)', va: hvac, demand: true });
  const totalVA = demandGL + hvac;
  const amps = totalVA / volts;
  return { method: 'optional', lines, totalVA, amps, service: nextService(amps), volts };
}

// ---------------------------------------------------------------------------
// Ohm's law, power, motors
// ---------------------------------------------------------------------------

/** ohmsLaw({ v, i, r, p }) with any two given (others null/undefined) -> all four (DC / resistive). */
export function ohmsLaw({ v, i, r, p }) {
  const has = (x) => x != null && x !== '' && Number.isFinite(Number(x));
  let V = has(v) ? +v : null, I = has(i) ? +i : null, R = has(r) ? +r : null, P = has(p) ? +p : null;
  const n = [V, I, R, P].filter((x) => x != null).length;
  if (n < 2) return null;
  if (V != null && I != null) { R = V / I; P = V * I; }
  else if (V != null && R != null) { I = V / R; P = (V * V) / R; }
  else if (V != null && P != null) { I = P / V; R = (V * V) / P; }
  else if (I != null && R != null) { V = I * R; P = I * I * R; }
  else if (I != null && P != null) { V = P / I; R = P / (I * I); }
  else if (R != null && P != null) { V = Math.sqrt(P * R); I = Math.sqrt(P / R); }
  return { v: V, i: I, r: R, p: P };
}

/** threePhase({ volts, kva?, kw?, pf=1, amps? }) -> amps and kVA/kW. I = VA / (√3 · V). */
export function threePhase({ volts, kva, kw, pf = 1, amps }) {
  const V = Number(volts);
  const PF = Number(pf) || 1;
  if (Number(amps) > 0) {
    const KVA = (Math.sqrt(3) * V * Number(amps)) / 1000;
    return { amps: Number(amps), kva: KVA, kw: KVA * PF };
  }
  const KVA = Number(kva) > 0 ? Number(kva) : (Number(kw) || 0) / PF;
  return { amps: (KVA * 1000) / (Math.sqrt(3) * V), kva: KVA, kw: KVA * PF };
}

export const singlePhaseAmps = (va, volts) => va / volts;

/** Table 430.248: full-load current, single-phase AC motors. Voltages 115, 200, 208, 230. */
export const TABLE_430_248 = {
  volts: [115, 200, 208, 230],
  hp: {
    '1/6': [4.4, 2.5, 2.4, 2.2], '1/4': [5.8, 3.3, 3.2, 2.9], '1/3': [7.2, 4.1, 4.0, 3.6], '1/2': [9.8, 5.6, 5.4, 4.9],
    '3/4': [13.8, 7.9, 7.6, 6.9], '1': [16, 9.2, 8.8, 8], '1-1/2': [20, 11.5, 11, 10], '2': [24, 13.8, 13.2, 12],
    '3': [34, 19.6, 18.7, 17], '5': [56, 32.2, 30.8, 28], '7-1/2': [80, 46, 44, 40], '10': [100, 57.5, 55, 50],
  },
};

/** Table 430.250: full-load current, three-phase induction motors. Voltages 200, 208, 230, 460, 575. */
export const TABLE_430_250 = {
  volts: [200, 208, 230, 460, 575],
  hp: {
    '1/2': [2.5, 2.4, 2.2, 1.1, 0.9], '3/4': [3.7, 3.5, 3.2, 1.6, 1.3], '1': [4.8, 4.6, 4.2, 2.1, 1.7],
    '1-1/2': [6.9, 6.6, 6.0, 3.0, 2.4], '2': [7.8, 7.5, 6.8, 3.4, 2.7], '3': [11.0, 10.6, 9.6, 4.8, 3.9],
    '5': [17.5, 16.7, 15.2, 7.6, 6.1], '7-1/2': [25.3, 24.2, 22, 11, 9], '10': [32.2, 30.8, 28, 14, 11],
    '15': [48.3, 46.2, 42, 21, 17], '20': [62.1, 59.4, 54, 27, 22], '25': [78.2, 74.8, 68, 34, 27],
    '30': [92, 88, 80, 40, 32], '40': [120, 114, 104, 52, 41], '50': [150, 143, 130, 65, 52],
    '60': [177, 169, 154, 77, 62], '75': [221, 211, 192, 96, 77], '100': [285, 273, 248, 124, 99],
    '125': [359, 343, 312, 156, 125], '150': [414, 396, 360, 180, 144], '200': [552, 528, 480, 240, 192],
  },
};

/**
 * motorFLC({ hp, volts, phase }) -> FLC and the derived sizes:
 *  - conductor ampacity ≥ 125% FLC (430.22)
 *  - inverse-time breaker max 250% FLC (Table 430.52), next size up allowed (430.52(C)(1) Ex. 1)
 *  - dual-element fuse max 175% FLC
 */
export function motorFLC({ hp, volts, phase = 3 }) {
  const t = Number(phase) === 1 ? TABLE_430_248 : TABLE_430_250;
  const col = t.volts.indexOf(Number(volts));
  const row = t.hp[hp];
  if (col < 0 || !row) return null;
  const flc = row[col];
  const conductorAmps = flc * 1.25;
  const breakerMax = flc * 2.5;
  const fuseMax = flc * 1.75;
  return {
    flc, conductorAmps,
    // 240.4(G): motor circuit conductors are protected per Article 430, so the
    // 240.4(D) small-conductor limits don't apply; size on 75 °C ampacity alone.
    conductor: SIZES.find((sz) => ampacity(sz, 'cu', 75) >= conductorAmps) ?? null,
    breakerMax, breaker: nextStandardOCPD(breakerMax), fuseMax, fuse: nextStandardOCPD(fuseMax),
    table: Number(phase) === 1 ? '430.248' : '430.250',
  };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

export const PANEL_SYSTEMS = {
  '120/240 1ph': { phases: ['A', 'B'], lnVolts: 120, llVolts: 240, three: false },
  '208/120 3ph': { phases: ['A', 'B', 'C'], lnVolts: 120, llVolts: 208, three: true },
  '480/277 3ph': { phases: ['A', 'B', 'C'], lnVolts: 277, llVolts: 480, three: true },
};

/** Phase of a breaker slot: slots 1&2 are row 1, 3&4 row 2... phases repeat by row. */
export function slotPhase(slot, system) {
  const sys = PANEL_SYSTEMS[system] || PANEL_SYSTEMS['120/240 1ph'];
  const row = Math.ceil(Number(slot) / 2);
  return sys.phases[(row - 1) % sys.phases.length];
}

/** Phases a circuit occupies: slot, slot+2, ... for each pole. Returns e.g. 'A-B'. */
export function circuitPhases(slot, poles, system) {
  const out = [];
  for (let k = 0; k < (Number(poles) || 1); k++) out.push(slotPhase(Number(slot) + 2 * k, system));
  return out.join('-');
}

/**
 * phaseBalance(circuits, system) -> { perPhase: { A: va, ... }, amps: { A: a, ... }, totalVA, imbalancePct }
 * A multi-pole load is split equally across the phases it occupies; per-phase
 * current uses the line-to-neutral voltage. Imbalance is max deviation from the
 * average phase load (NEMA definition).
 */
export function phaseBalance(circuits, system) {
  const sys = PANEL_SYSTEMS[system] || PANEL_SYSTEMS['120/240 1ph'];
  const perPhase = Object.fromEntries(sys.phases.map((p) => [p, 0]));
  let totalVA = 0;
  for (const c of circuits) {
    const va = Number(c.loadVA) || 0;
    if (!va) continue;
    const phases = (c.phase || circuitPhases(c.slot, c.poles, system)).split('-').filter((p) => p in perPhase);
    if (!phases.length) continue;
    for (const p of phases) perPhase[p] += va / phases.length;
    totalVA += va;
  }
  const vals = Object.values(perPhase);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const imbalancePct = avg > 0 ? (Math.max(...vals.map((v) => Math.abs(v - avg))) / avg) * 100 : 0;
  const amps = Object.fromEntries(Object.entries(perPhase).map(([p, va]) => [p, va / sys.lnVolts]));
  return { perPhase, amps, totalVA, imbalancePct, maxAmps: Math.max(...Object.values(amps)) };
}

/** Breaker for a load: 125% for continuous, next standard rating (210.20(A), 240.6(A)). */
export function suggestBreaker(loadAmps, continuous = true) {
  return nextStandardOCPD((Number(loadAmps) || 0) * (continuous ? 1.25 : 1));
}
