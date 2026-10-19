// Voltage drop the CEC way (Rule 8-102), in SI: lengths in metres, resistance in Ω/km.
import { SIZES } from './conductors.js';

/**
 * Rule 8-102(1): voltage drop limits, percent of nominal.
 *  - total: 5% from the supply side of the consumer's service (or the transformer
 *    secondary) to the point of utilization;
 *  - branch / feeder: 3% in any one feeder or branch circuit.
 * The drop is based on the connected load when it is known, otherwise 80% of the
 * overcurrent device rating. Confirmed: ESA Bulletin 8-6-5 (May 2025); BCcampus Section 8.
 * Manitoba applies the limit to branch circuits only (amendments.js).
 */
export const VD_LIMITS = { branch: 3, feeder: 3, total: 5 };

/** Rule 8-102: the current to use for voltage drop. */
export function designCurrent({ loadAmps, ocpdAmps }) {
  if (Number(loadAmps) > 0) return { amps: Number(loadAmps), basis: 'connected load' };
  if (Number(ocpdAmps) > 0) return { amps: 0.8 * Number(ocpdAmps), basis: `80% of the ${ocpdAmps} A overcurrent device` };
  return { amps: 0, basis: 'no load' };
}

/**
 * DC resistance at 75 °C, Ω/km, stranded uncoated copper and stranded aluminum.
 * Physical conductor data: NEC 2023 Chapter 9 Table 8 (Ω/kft) × 3.2808. The
 * conductors are the same AWG/kcmil sizes used in Canada. AC resistance of large
 * conductors in steel raceway is a few percent higher, so drops for 250 kcmil and
 * up read slightly low. VERIFY against CEC Appendix D voltage-drop data.
 */
export const R_OHM_PER_KM = {
  cu: {
    '14': 10.30, '12': 6.50, '10': 4.07, '8': 2.55, '6': 1.61, '4': 1.01, '3': 0.804, '2': 0.636, '1': 0.505,
    '1/0': 0.400, '2/0': 0.317, '3/0': 0.251, '4/0': 0.199, '250': 0.169, '300': 0.141, '350': 0.120, '400': 0.105, '500': 0.0846,
  },
  al: {
    '12': 10.66, '10': 6.69, '8': 4.20, '6': 2.65, '4': 1.67, '3': 1.32, '2': 1.05, '1': 0.830,
    '1/0': 0.659, '2/0': 0.522, '3/0': 0.413, '4/0': 0.328, '250': 0.278, '300': 0.232, '350': 0.198, '400': 0.174, '500': 0.139,
  },
};

const mult = (phase) => (Number(phase) === 3 ? Math.sqrt(3) : 2);

/**
 * voltageDrop({ volts, phase, amps, lengthM (one way), size, material })
 * VD = 2 · I · R · L (single phase) or √3 · I · R · L (three phase), R in Ω/km, L in km.
 */
export function voltageDrop({ volts, phase = 1, amps, lengthM, size, material = 'cu' }) {
  const r = R_OHM_PER_KM[material]?.[size];
  if (r == null) throw new Error(`No resistance data for ${size} ${material === 'al' ? 'aluminum' : 'copper'}`);
  const v = (mult(phase) * Number(amps) * r * Number(lengthM)) / 1000;
  return { volts: v, percent: (v / Number(volts)) * 100, endVolts: Number(volts) - v, ohmsPerKm: r };
}

/** Smallest conductor within maxPct. */
export function minSizeForVoltageDrop({ volts, phase = 1, amps, lengthM, material = 'cu', maxPct = VD_LIMITS.branch }) {
  for (const s of SIZES) {
    if (R_OHM_PER_KM[material]?.[s] == null) continue;
    if (voltageDrop({ volts, phase, amps, lengthM, size: s, material }).percent <= maxPct + 1e-9) return s;
  }
  return null;
}

/** Longest one-way run (m) for a conductor to stay within maxPct. */
export function maxLengthForVoltageDrop({ volts, phase = 1, amps, size, material = 'cu', maxPct = VD_LIMITS.branch }) {
  const r = R_OHM_PER_KM[material]?.[size];
  if (r == null || !(amps > 0)) return null;
  return ((maxPct / 100) * volts * 1000) / (mult(phase) * amps * r);
}
