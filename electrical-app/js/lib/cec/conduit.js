// Conduit fill, CEC Rule 12-910: conductor area against the conduit's internal
// area, limited by Table 8. Areas in mm²; metric trade sizes 16 to 103.
import { SIZES } from './conductors.js';

export const TRADE_SIZES = ['16', '21', '27', '35', '41', '53', '63', '78', '91', '103'];
/** Imperial trade size for each metric designator. */
export const TRADE_SIZE_IN = { '16': '1/2', '21': '3/4', '27': '1', '35': '1-1/4', '41': '1-1/2', '53': '2', '63': '2-1/2', '78': '3', '91': '3-1/2', '103': '4' };

const IN2 = 645.16; // mm² per in²
const mm2 = (arr) => arr.map((a) => (a == null ? null : Math.round(a * IN2 * 10) / 10));

/**
 * Internal cross-sectional area (100%), mm², by trade size 16..103 (null = not made).
 * Since 2015 the CEC Table 9 series uses the internal diameter from each raceway's CSA
 * standard (IAEI 2016, "Why did the Table 6 change..."); since 2021 it is eight tables, two
 * per fill level (100, 53, 31, 40%), with 40% in Table 9G (IAEI 2021 updates, article 2).
 * Confirmed points (Table 9G 40% value ÷ 0.4): RMC 16 = 202.3, RMC 21 = 354.0 (IAEI 2021),
 * EMT 16 = 181.3 (ESA Code File example). Every other value is VERIFY: converted from NEC
 * Chapter 9 Table 4 (in² × 645.16). RMC matches the NEC within 0.1%, but CSA EMT 16 is 7.5%
 * smaller than the US figure, so unconfirmed EMT sizes probably read a little generous.
 */
const EMT = mm2([0.304, 0.533, 0.864, 1.496, 2.036, 3.356, 5.858, 8.846, 11.545, 14.753]);
EMT[0] = 181.3;
const RMC = mm2([0.314, 0.549, 0.887, 1.526, 2.071, 3.408, 4.866, 7.499, 10.010, 12.882]);
RMC[0] = 202.3; RMC[1] = 354.0;
export const CONDUIT_TYPES = {
  EMT: { label: 'EMT', table: 'Table 9 series', areas: EMT, verify: 'sizes 21 to 103' },
  RMC: { label: 'Rigid steel (RMC)', table: 'Table 9 series', areas: RMC, verify: 'sizes 27 to 103' },
  PVC: { label: 'Rigid PVC', table: 'Table 9 series', areas: mm2([0.285, 0.508, 0.832, 1.453, 1.986, 3.291, 4.695, 7.268, 9.737, 12.554]), verify: 'all sizes' },
  ENT: { label: 'ENT', table: 'Table 9 series', areas: mm2([0.285, 0.508, 0.832, 1.453, 1.986, 3.291, null, null, null, null]), verify: 'all sizes' },
  FMC: { label: 'Flexible metal (FMC)', table: 'Table 9 series', areas: mm2([0.317, 0.533, 0.817, 1.277, 1.858, 3.269, 4.909, 7.069, 9.621, 12.566]), verify: 'all sizes' },
};

/**
 * Conductor cross-sectional area including insulation, mm², by size. Since 2021, Tables 6A-6K
 * give these areas (6A: RW90 XLPE 600 V unjacketed; 6K: TWN75 / T90 Nylon) and Tables 10A-10D
 * the dimensions (IAEI 2021 updates, article 2). Confirmed: RW90 XLPE 600 V unjacketed
 * 14 AWG = 8.867 (10 conductors = 88.67, IAEI 2021) and 10 AWG = 15.69 (3 = 47.08, ESA Code File).
 * VERIFY the rest: converted from NEC Chapter 9 Table 5 (THHN/THWN for T90 Nylon and TWN75,
 * XHHW for RW90 XLPE), the same constructions.
 */
const T90 = [0.0097, 0.0133, 0.0211, 0.0366, 0.0507, 0.0824, 0.0973, 0.1158, 0.1562, 0.1855, 0.2223, 0.2679, 0.3237, 0.3970, 0.4608, 0.5242, 0.5863, 0.7073];
const RW90 = [0.0139, 0.0181, 0.0243, 0.0437, 0.0590, 0.0814, 0.0962, 0.1146, 0.1534, 0.1825, 0.2190, 0.2642, 0.3197, 0.3904, 0.4536, 0.5166, 0.5782, 0.6984];
const bySize = (arr) => Object.fromEntries(SIZES.map((s, i) => [s, Math.round(arr[i] * IN2 * 100) / 100]));
const rw90 = { ...bySize(RW90), '14': 8.867, '10': 15.69 };
export const CONDUCTOR_TYPES = {
  'T90 Nylon': { label: 'T90 Nylon', table: 'Table 6K', areas: bySize(T90) },
  TWN75: { label: 'TWN75', table: 'Table 6K', areas: bySize(T90) },
  'RW90 XLPE': { label: 'RW90 XLPE (600 V, unjacketed)', table: 'Table 6A', areas: rw90 },
};

/**
 * Table 8: maximum fill, percent of the conduit area, by number of conductors or cables:
 * 1 = 53%, 2 = 31%, 3 or more = 40% (lead-sheathed cables differ and aren't modelled).
 * Confirmed: Nexans Electrician's Handbook reprint; ESA Code File (3 conductors = 40%).
 */
export function allowedFillPct(count) {
  if (count <= 1) return 53;
  if (count === 2) return 31;
  return 40;
}

function areaOf(conduitType, tradeSize) {
  const c = CONDUIT_TYPES[conduitType];
  const i = TRADE_SIZES.indexOf(tradeSize);
  if (!c || i < 0) throw new Error(`Unknown conduit ${conduitType} ${tradeSize}`);
  const a = c.areas[i];
  if (a == null) throw new Error(`${c.label} isn't made in trade size ${tradeSize}`);
  return a;
}

/** conduitFill({ conduitType, tradeSize, wires: [{ size, insulation, count }] }) -> areas in mm². */
export function conduitFill({ conduitType = 'EMT', tradeSize, wires = [] }) {
  const area = areaOf(conduitType, tradeSize);
  let wireArea = 0, count = 0;
  const missing = [];
  for (const w of wires) {
    const n = Number(w.count) || 0;
    if (n <= 0) continue;
    const a = CONDUCTOR_TYPES[w.insulation || 'T90 Nylon']?.areas[w.size];
    if (a == null) { missing.push(`${w.size} ${w.insulation}`); continue; }
    wireArea += a * n;
    count += n;
  }
  const allowedPct = allowedFillPct(count);
  const fillPct = (wireArea / area) * 100;
  return { conduitArea: area, wireArea, count, fillPct, allowedPct, allowedArea: (area * allowedPct) / 100, pass: fillPct <= allowedPct + 1e-9, missing };
}

/** Smallest trade size that passes, or null. */
export function minConduit({ conduitType = 'EMT', wires = [] }) {
  const c = CONDUIT_TYPES[conduitType];
  for (const [i, t] of TRADE_SIZES.entries()) {
    if (c.areas[i] == null) continue;
    const r = conduitFill({ conduitType, tradeSize: t, wires });
    if (r.pass) return { tradeSize: t, ...r };
  }
  return null;
}

/** How many identical conductors fit. */
export function maxConductors({ conduitType = 'EMT', tradeSize, size, insulation = 'T90 Nylon' }) {
  const area = areaOf(conduitType, tradeSize);
  const a = CONDUCTOR_TYPES[insulation]?.areas[size];
  if (!a) return 0;
  for (let k = Math.floor(area / a); k > 0; k--) if ((k * a) / area * 100 <= allowedFillPct(k) + 1e-9) return k;
  return 0;
}
