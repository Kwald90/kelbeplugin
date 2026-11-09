// Transformer sizing, CEC Section 26. Pure, offline, SI. Reuses the CEC conductor/rating engine
// (lib/cec) for standard overcurrent ratings and conductor selection so it agrees with the other
// calculators. An estimating aid citing CEC rules — confirm with the inspection authority.
//
// References:
//   CEC 2024 Rule 26-256: overcurrent protection of dry-type transformers rated 750 V or less.
//   CEC 2024 Rule 26-258 / Table 50: conductor sizing on transformer secondaries.
//   CEC 2024 Rule 4-004 and 8-104: conductor ampacity and the 125% continuous allowance.
// The exact Rule 26-256 percentage ladder (primary-only vs primary-and-secondary protection) is the
// part most likely to differ from the printed 2024 text, so it is modelled conservatively and
// tagged VERIFY. Inrush and impedance figures are typical ranges, not nameplate values.

import { nextStandardRating, minConductorForAmps, sizeLabel } from './cec/index.js';

// Standard single- and three-phase dry-type kVA ratings (CSA/ANSI preferred sizes). VERIFY against a
// current manufacturer catalogue; the common sizes below cover most contractor work.
export const KVA_3PH = [15, 30, 45, 75, 112.5, 150, 225, 300, 500, 750, 1000, 1500, 2000, 2500];
export const KVA_1PH = [1, 1.5, 3, 5, 7.5, 10, 15, 25, 37.5, 50, 75, 100, 167, 250, 333, 500];

export const PHASES = [{ value: '1', label: 'Single phase' }, { value: '3', label: 'Three phase' }];

/** Full-load current (A) for a kVA rating at a line-to-line voltage. 3φ uses √3. */
export function fullLoadAmps({ kva, volts, phase = 3 }) {
  const va = Number(kva) * 1000;
  const v = Number(volts);
  if (!(v > 0)) return null;
  return Number(phase) === 3 ? va / (Math.sqrt(3) * v) : va / v;
}

/** Smallest standard transformer kVA at or above a required kVA, for the phase. */
export function standardKva(kva, phase = 3) {
  const list = Number(phase) === 3 ? KVA_3PH : KVA_1PH;
  return list.find((k) => k >= Number(kva) - 1e-9) ?? null;
}

/**
 * CEC 26-256 primary overcurrent protection for a dry-type transformer ≤ 750 V, PRIMARY PROTECTION
 * ONLY (the conservative general case): not more than 125% of rated primary current, taken up to the
 * next standard rating where 125% does not land on one. (Where the primary current is small the code
 * allows a higher multiple, and where secondary protection is also provided the primary may run
 * higher still — those relaxations are NOT applied here. VERIFY against Rule 26-256.)
 * Returns { maxAmps, rating, pct }.
 */
export function primaryOcpd(primaryFla) {
  const fla = Number(primaryFla);
  const pct = 125; // VERIFY — conservative primary-only value
  const maxAmps = fla * (pct / 100);
  return { maxAmps, rating: nextStandardRating(maxAmps), pct };
}

/**
 * Transformer sizing summary.
 * inputs: { loadKva?, loadAmps?, primaryV, secondaryV, phase, impedancePct?, continuous, material }
 * Give loadKva directly, OR loadAmps + the voltage it is measured on (assumed the secondary).
 * Returns full-load currents, the standard kVA, primary OCPD, secondary conductor, inrush/impedance
 * notes and a secondary available-fault-current estimate.
 */
export function sizeTransformer(inputs = {}) {
  const phase = Number(inputs.phase) === 1 ? 1 : 3;
  const primaryV = Number(inputs.primaryV);
  const secondaryV = Number(inputs.secondaryV);
  const material = inputs.material === 'al' ? 'al' : 'cu';
  const continuous = inputs.continuous !== false;
  if (!(primaryV > 0) || !(secondaryV > 0)) throw new Error('Enter the primary and secondary voltages.');

  // Required kVA: from kVA directly, or from secondary amps.
  let loadKva = Number(inputs.loadKva) || 0;
  if (!(loadKva > 0)) {
    const a = Number(inputs.loadAmps) || 0;
    if (!(a > 0)) throw new Error('Enter the load in kVA, or the load current and its voltage.');
    loadKva = (phase === 3 ? Math.sqrt(3) * secondaryV * a : secondaryV * a) / 1000;
  }
  const kva = standardKva(loadKva, phase);
  if (!kva) throw new Error('Load exceeds the largest standard size in the list; pick multiple transformers.');

  const primaryFla = fullLoadAmps({ kva, volts: primaryV, phase });
  const secondaryFla = fullLoadAmps({ kva, volts: secondaryV, phase });
  const ocpd = primaryOcpd(primaryFla);

  // Secondary conductor: 125% of secondary FLA for a continuous load (Rule 8-104), sized from the
  // 75 °C column (Rule 4-004 termination temperature) via the CEC engine.
  const secondaryDesignA = secondaryFla * (continuous ? 1.25 : 1.0);
  const secSize = minConductorForAmps(secondaryDesignA, material, 75);

  // Impedance / fault note: available secondary fault current ≈ secondary FLA / %Z (infinite primary
  // bus assumption — conservative/high). Typical dry-type %Z is 3–6%; default 5% if not given.
  const zPct = Number(inputs.impedancePct) > 0 ? Number(inputs.impedancePct) : 5;
  const zAssumed = !(Number(inputs.impedancePct) > 0);
  const secFaultKa = (secondaryFla / (zPct / 100)) / 1000;

  // Magnetizing inrush: typically 8–12× FLA for a few cycles on energization. VERIFY (manufacturer).
  const inrushLowKa = (primaryFla * 8) / 1000;
  const inrushHighKa = (primaryFla * 12) / 1000;

  return {
    loadKva, kva, phase, primaryV, secondaryV, material, continuous,
    primaryFla, secondaryFla,
    ocpd,
    secondary: { designAmps: secondaryDesignA, size: secSize, sizeLabel: secSize ? sizeLabel(secSize) : null },
    impedance: { pct: zPct, assumed: zAssumed, secFaultKa },
    inrush: { lowKa: inrushLowKa, highKa: inrushHighKa, lowX: 8, highX: 12 },
  };
}
