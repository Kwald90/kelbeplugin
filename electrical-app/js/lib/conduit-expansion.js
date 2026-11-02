// Linear thermal expansion of conduit: dL = coefficient x length x dT. Pure, offline.
// VERIFY: coefficients are typical manufacturer / handbook figures, not CEC values, and the ~6 mm
// (1/4") fitting threshold is the usual PVC manufacturer guidance, not a CEC limit. The CEC expects
// expansion to be allowed for in Section 12 (the rule 12-1014 area); confirm the exact rule against
// CSA C22.1:24 before citing it on a permit.

export const MM_PER_IN = 25.4;
export const FITTING_THRESHOLD_MM = 6; // about 1/4 inch

/** Coefficients in mm per metre per degree C (1 mm/m/C = 1e-3 per C). PVC is 3.38e-5 in/in/F, the figure behind NEC Table 352.44 (4.06 in per 100 ft per 100 F); the equivalent is 0.0608 mm/m/C. */
export const CONDUIT_MATERIALS = [
  { value: 'pvc', label: 'PVC (rigid nonmetallic)', mmPerMC: 0.0608 }, // 3.38e-5 in/in/F
  { value: 'al', label: 'Aluminum', mmPerMC: 0.0231 }, // 1.28e-5 in/in/F
  { value: 'steel', label: 'Steel (RMC / EMT)', mmPerMC: 0.0117 }, // 6.5e-6 in/in/F
];

/** in/in/F equivalent of a mm/m/C coefficient. */
export const inPerInF = (mmPerMC) => (mmPerMC * 5) / 9 / 1000;

export const fToC = (f) => ((f - 32) * 5) / 9;
export const deltaFtoC = (df) => (df * 5) / 9;

/**
 * Length change in mm. lengthM in metres, deltaC in degrees C (negative = contraction).
 */
export function expansionMm({ material = 'pvc', lengthM, deltaC }) {
  const m = CONDUIT_MATERIALS.find((x) => x.value === material);
  if (!m) throw new Error('Unknown conduit material');
  if (!(lengthM >= 0) || !Number.isFinite(deltaC)) throw new Error('Enter a run length and a temperature change');
  return m.mmPerMC * lengthM * deltaC;
}

/** True when the movement is large enough that an expansion fitting is advisable. */
export const needsExpansionFitting = (mm) => Math.abs(mm) > FITTING_THRESHOLD_MM;
