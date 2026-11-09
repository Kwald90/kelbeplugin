// Grounding electrode + fall-of-potential (3-point) ground-resistance test record. Pure, offline,
// STATELESS (no saved collection — the record is printed/exported, not persisted). SI.
//
// References:
//   CEC 2024 Section 10 (Grounding and Bonding): Rule 10-700 series, grounding electrodes; Rule
//     10-102 the grounding electrode. The CEC generally does NOT set a single maximum ground
//     resistance for a bonded system the way the NEC does; a project spec, the AHJ, or the utility
//     usually sets the target (commonly ≤ 25 Ω for a made electrode, ≤ 5 Ω for sensitive/telecom,
//     ≤ 1 Ω for some substation work). The target here is a USER INPUT, defaulting to 25 Ω.
//   Fall-of-potential (IEEE 81): drive the current probe well away from the electrode, then read
//     resistance with the potential probe at several distances; the "62 % rule" places the potential
//     probe at 61.8 % of the electrode-to-current-probe distance for a hemispherical electrode, where
//     the reading approximates the true resistance (a flat spot in the curve).
// VERIFY: the 25 Ω default and the typical targets above are design-practice / NEC 250.53(A)(2)
// references, not a CEC maximum. Confirm the required value with the spec and the AHJ.

// Common ground-resistance targets (Ω). VERIFY — set by spec / AHJ / utility, not a CEC maximum.
export const TARGETS = [
  { value: 25, label: '25 Ω — single made electrode (NEC 250.53(A)(2) reference)' },
  { value: 5, label: '5 Ω — sensitive equipment / telecom (industry practice)' },
  { value: 1, label: '1 Ω — substation / critical (industry practice)' },
];
export const DEFAULT_TARGET_OHMS = 25;

// 62 % rule: the potential probe distance where the measured resistance ≈ true resistance.
export const FOP_RATIO = 0.618;

/** Potential-probe distance (same unit as the current-probe distance) for the 62 % rule. */
export function potentialProbeDistance(currentProbeDistance) {
  const d = Number(currentProbeDistance);
  return d > 0 ? d * FOP_RATIO : null;
}

/**
 * Evaluate a set of fall-of-potential readings against a target resistance.
 * inputs: { readings: number[] (Ω), targetOhms, currentProbeDistance?, electrode? }
 * The result resistance is taken as the MEDIAN of the readings on the flat part of the curve (a
 * simple robust estimate); a wide spread flags a questionable measurement.
 * Returns { resultOhms, pass, targetOhms, spreadPct, probeDistance, readings, notes }.
 */
export function evaluateTest(inputs = {}) {
  const readings = (inputs.readings || []).map(Number).filter((x) => Number.isFinite(x) && x >= 0);
  const targetOhms = Number(inputs.targetOhms) > 0 ? Number(inputs.targetOhms) : DEFAULT_TARGET_OHMS;
  const notes = [];
  if (!readings.length) {
    return { resultOhms: null, pass: null, targetOhms, spreadPct: null, probeDistance: potentialProbeDistance(inputs.currentProbeDistance), readings, notes: ['Enter at least one resistance reading.'] };
  }
  const sorted = [...readings].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const resultOhms = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const min = sorted[0], max = sorted[sorted.length - 1];
  const spreadPct = resultOhms > 0 ? ((max - min) / resultOhms) * 100 : 0;
  const pass = resultOhms <= targetOhms + 1e-9;

  notes.push(pass
    ? `PASS: ${round(resultOhms)} Ω ≤ ${round(targetOhms)} Ω target.`
    : `FAIL: ${round(resultOhms)} Ω exceeds the ${round(targetOhms)} Ω target — add electrodes (more rods, spaced at least their length apart), a longer/deeper rod, a ground ring, or chemical/soil treatment, then re-test.`);
  if (readings.length >= 3 && spreadPct > 30) notes.push(`Readings vary by ${round(spreadPct, 0)}% — the probe may be too close to the electrode or in its resistance area. Move the current probe farther out and re-read at 52 %, 62 % and 72 % of that distance; they should agree (IEEE 81).`);
  if (readings.length < 3) notes.push('A proper fall-of-potential test uses several potential-probe positions (at least 52 %, 62 %, 72 %); one reading is not enough to confirm the flat spot.');
  notes.push('The CEC does not set a general maximum ground resistance; confirm the required value with the project spec, the AHJ and the utility (VERIFY).');
  return { resultOhms, pass, targetOhms, spreadPct, probeDistance: potentialProbeDistance(inputs.currentProbeDistance), readings, notes };
}

function round(n, d = 2) { return Math.round(Number(n) * 10 ** d) / 10 ** d; }
