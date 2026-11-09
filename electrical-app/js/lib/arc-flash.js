// Arc-flash incident energy and CSA Z462 label data. Pure, offline, SI-in / cal-cm²-out.
//
// SAFETY-CRITICAL. This is an ESTIMATING AID, not a stamped arc-flash / incident-energy study.
// An arc-flash study for a real installation must be performed or sealed by a qualified engineer
// (CSA Z462 Clause 4.3 / Annex D; IEEE 1584). Clearing time, available fault current, system
// configuration and equipment data all have to come from the real system. The numbers here are
// conservative screening values only. Never represent them as a completed study.
//
// MODEL. This implements the IEEE 1584-2002 empirical model (the equations are public and stable)
// PLUS the Ralph Lee theoretical-maximum method for cases outside the empirical range. The brief
// asked for IEEE 1584-2018. The 2018 model changes the coefficient set, adds five electrode
// configurations (VCB, VCBB, HCB, VOA, HOA) and an enclosure-size correction, and its full
// coefficient tables are behind the paywalled IEEE 1584-2018 standard. Reproducing those tables
// from memory would risk fabricating safety-critical constants, which the brief forbids, so they
// are NOT included here. 2018 TODO is tracked below as VERIFY-2018. The 2002 model remains widely
// used and is conservative for the common 208 V–600 V enclosed-equipment case; where the 2018 model
// would differ it generally gives LOWER energy for the same inputs (updated arcing-current fit), so
// using 2002 here is the safer direction for a screening tool. An engineer must still run 2018.
//
// References (method and constants):
//   IEEE 1584-2002, "Guide for Performing Arc-Flash Hazard Calculations", eq. 1, 2, 3, 5, boundary
//     eq. and Table 4 (electrode gaps and distance exponents). Eq. forms reproduced below.
//   Ralph Lee, "The Other Electrical Hazard: Electric Arc Blast Burns", IEEE Trans. IA, 1982
//     (maximum-power method), as given in IEEE 1584-2002 Annex B.
//   CSA Z462-21 / NFPA 70E-2021: incident-energy method, 1.2 cal/cm² second-degree-burn threshold
//     (Stoll curve), and the 4 / 8 / 25 / 40 cal/cm² arc-rating bands.
// Every assumed constant is tagged VERIFY so an engineer can confirm it against the printed standard.

export const CAL_PER_J = 1 / 4.184; // 1 cal = 4.184 J. J/cm² -> cal/cm².

// IEEE 1584-2002 Table 4: typical conductor gap (mm) and distance exponent x by equipment class.
// Default working distances are the IEEE 1584-2002 Table 3 values (mm). VERIFY against the printed
// Table 3/Table 4 — gaps and exponents reproduced from the 2002 standard; distances are the common
// published defaults (18 in LV panel, 24 in LV switchgear, 36 in MV switchgear).
export const EQUIPMENT = {
  'lv-panel': { label: 'Low-voltage panelboard / MCC (≤ 600 V)', gapMm: 25, x: 1.641, workingMm: 455, vMax: 1 },
  'lv-switchgear': { label: 'Low-voltage switchgear (≤ 600 V)', gapMm: 32, x: 1.473, workingMm: 610, vMax: 1 },
  'cable': { label: 'Cable / junction (≤ 600 V)', gapMm: 13, x: 2.0, workingMm: 455, vMax: 1 },
  'mv-switchgear-5': { label: 'Medium-voltage switchgear (~5 kV)', gapMm: 104, x: 0.973, workingMm: 910, vMax: 15 },
  'mv-switchgear-15': { label: 'Medium-voltage switchgear (~15 kV)', gapMm: 152, x: 0.973, workingMm: 910, vMax: 15 },
};

// Electrode configuration, 2002 model: "box" (enclosed) vs "open" (open air). The 2002 constants
// below. VERIFY-2018: the 2018 model replaces this with VCB/VCBB/HCB/VOA/HOA and new coefficients.
export const CONFIGS = {
  box: { label: 'In a box / enclosure (VCB equivalent)', K: -0.097, K1: -0.555, Cf: 1.5 },
  open: { label: 'In open air (VOA equivalent)', K: -0.153, K1: -0.792, Cf: 1.0 },
};

export const GROUNDING = [
  { value: 'grounded', label: 'Solidly grounded' },
  { value: 'ungrounded', label: 'Ungrounded / high-resistance grounded' },
];

// Incident-energy limit that defines the arc-flash boundary: 1.2 cal/cm² (5.0 J/cm²), the onset of a
// curable second-degree burn on bare skin (Stoll curve). CSA Z462 / NFPA 70E. VERIFY.
export const BOUNDARY_CAL = 1.2;
export const BOUNDARY_J = BOUNDARY_CAL / CAL_PER_J; // 5.0208 J/cm²

// Validity envelope for the IEEE 1584-2002 empirical model (the 2002 standard's stated ranges).
export const VALID = { voltMinKv: 0.208, voltMaxKv: 15, faultMinKa: 0.7, faultMaxKa: 106, gapMinMm: 13, gapMaxMm: 152 };

// CSA Z462 / NFPA 70E arc-rating bands by incident energy (cal/cm²). The incident-energy method
// selects clothing/PPE with an arc rating (ATPV or EBT) at or above the calculated incident energy;
// the bands below map to the familiar PPE "categories". Over 40 cal/cm² there is NO category — the
// hazard is beyond the listed PPE system and energized work is not permitted without an engineering
// plan. VERIFY the band edges against CSA Z462-21 Table 6/H.3.
export const PPE_BANDS = [
  { maxCal: BOUNDARY_CAL, category: 0, minArc: 0, label: 'Below arc-flash boundary threshold — minimum arc-rated PPE still required for energized work' },
  { maxCal: 4, category: 1, minArc: 4, label: 'PPE Category 1 (arc rating ≥ 4 cal/cm²)' },
  { maxCal: 8, category: 2, minArc: 8, label: 'PPE Category 2 (arc rating ≥ 8 cal/cm²)' },
  { maxCal: 25, category: 3, minArc: 25, label: 'PPE Category 3 (arc rating ≥ 25 cal/cm²)' },
  { maxCal: 40, category: 4, minArc: 40, label: 'PPE Category 4 (arc rating ≥ 40 cal/cm²)' },
];
export const DANGER_CAL = 40; // above this: "Dangerous — no PPE category".

const log10 = (x) => Math.log(x) / Math.LN10;

/** PPE band / arc rating for an incident energy in cal/cm². Over 40 cal/cm² returns the danger band. */
export function ppeFor(cal) {
  if (!(cal > 0)) return { category: 0, minArc: 0, danger: false, label: PPE_BANDS[0].label };
  if (cal > DANGER_CAL) return { category: null, minArc: null, danger: true, label: 'DANGER — over 40 cal/cm²: no PPE category; energized work not permitted without an engineering study and plan' };
  const band = PPE_BANDS.find((b) => cal <= b.maxCal + 1e-9) || PPE_BANDS[PPE_BANDS.length - 1];
  // Minimum arc rating should at least cover the calculated energy, rounded up to the next band.
  return { category: band.category, minArc: Math.max(band.minArc, Math.ceil(cal)), danger: false, label: band.label };
}

/**
 * IEEE 1584-2002 arcing current (kA) for a bolted fault Ibf (kA), line-to-line voltage V (kV),
 * gap G (mm), electrode config. Below 1 kV uses the empirical equation (eq. 1); at/above 1 kV uses
 * the voltage-independent equation (eq. 2). Returns { arcKa, equation }.
 */
export function arcingCurrent({ faultKa, voltKv, gapMm, config = 'box' }) {
  const Ibf = Number(faultKa), V = Number(voltKv), G = Number(gapMm);
  const cfg = CONFIGS[config] || CONFIGS.box;
  if (!(Ibf > 0) || !(V > 0) || !(G > 0)) throw new Error('Arcing current needs fault current, voltage and gap.');
  const lgIbf = log10(Ibf);
  if (V < 1) {
    // eq. 1: lgIa = K + 0.662 lgIbf + 0.0966 V + 0.000526 G + 0.5588 V lgIbf − 0.00304 G lgIbf
    const lgIa = cfg.K + 0.662 * lgIbf + 0.0966 * V + 0.000526 * G + 0.5588 * V * lgIbf - 0.00304 * G * lgIbf;
    return { arcKa: 10 ** lgIa, equation: 'IEEE 1584-2002 eq. 1 (< 1 kV)' };
  }
  // eq. 2: lgIa = 0.00402 + 0.983 lgIbf  (1–15 kV, config-independent)
  const lgIa = 0.00402 + 0.983 * lgIbf;
  return { arcKa: 10 ** lgIa, equation: 'IEEE 1584-2002 eq. 2 (1–15 kV)' };
}

/**
 * IEEE 1584-2002 incident energy (cal/cm²) at the working distance for a given arcing current.
 * clearSec = total arc duration (upstream device clearing time + any relay/breaker delay), s.
 * Returns { cal, joules, normJ }.  normJ is the normalized energy En (J/cm² at 0.2 s, 610 mm).
 */
export function incidentEnergyEmpirical({ arcKa, voltKv, gapMm, workingMm, x, config = 'box', grounding = 'grounded', clearSec }) {
  const Ia = Number(arcKa), G = Number(gapMm), D = Number(workingMm), t = Number(clearSec);
  const cfg = CONFIGS[config] || CONFIGS.box;
  if (!(Ia > 0) || !(D > 0) || !(t > 0)) throw new Error('Incident energy needs arcing current, working distance and time.');
  // eq. 3: lgEn = K1 + K2 + 1.081 lgIa + 0.0011 G ; K2 = 0 (ungrounded/HR) or −0.113 (grounded).
  const K2 = grounding === 'grounded' ? -0.113 : 0;
  const lgEn = cfg.K1 + K2 + 1.081 * log10(Ia) + 0.0011 * G;
  const En = 10 ** lgEn; // normalized incident energy, J/cm² at t=0.2 s, D=610 mm
  // eq. 5: E = 4.184 Cf En (t/0.2) (610^x / D^x)  — J/cm²
  const joules = 4.184 * cfg.Cf * En * (t / 0.2) * (610 ** x / D ** x);
  return { cal: joules * CAL_PER_J, joules, normJ: En };
}

/**
 * Ralph Lee maximum-power incident energy (cal/cm²). Theoretical bound used above 15 kV or when the
 * fault current is outside the empirical range. E = 2.142e6 · V · Ibf · (t / D²), J/cm²
 * (V kV, Ibf kA, D mm, t s). VERIFY the 2.142e6 constant against IEEE 1584-2002 Annex B.
 */
export const LEE_CONST = 2.142e6; // VERIFY
export function incidentEnergyLee({ voltKv, faultKa, workingMm, clearSec }) {
  const V = Number(voltKv), Ibf = Number(faultKa), D = Number(workingMm), t = Number(clearSec);
  if (!(V > 0) || !(Ibf > 0) || !(D > 0) || !(t > 0)) throw new Error('Lee method needs voltage, fault current, distance and time.');
  const joules = LEE_CONST * V * Ibf * (t / (D * D));
  return { cal: joules * CAL_PER_J, joules };
}

/** Arc-flash boundary (mm) where incident energy falls to BOUNDARY_J, empirical form. */
export function boundaryEmpirical({ arcKa, voltKv, gapMm, x, config = 'box', grounding = 'grounded', clearSec }) {
  const cfg = CONFIGS[config] || CONFIGS.box;
  const K2 = grounding === 'grounded' ? -0.113 : 0;
  const En = 10 ** (cfg.K1 + K2 + 1.081 * log10(Number(arcKa)) + 0.0011 * Number(gapMm));
  // DB = [ 4.184 Cf En (t/0.2) 610^x / EB ]^(1/x)
  const inner = (4.184 * cfg.Cf * En * (Number(clearSec) / 0.2) * 610 ** x) / BOUNDARY_J;
  return inner > 0 ? inner ** (1 / x) : 0;
}

/** Arc-flash boundary (mm), Lee form: DB = sqrt(2.142e6 · V · Ibf · t / EB). */
export function boundaryLee({ voltKv, faultKa, clearSec }) {
  const inner = (LEE_CONST * Number(voltKv) * Number(faultKa) * Number(clearSec)) / BOUNDARY_J;
  return inner > 0 ? Math.sqrt(inner) : 0;
}

/**
 * Full arc-flash screening result.
 * inputs: { faultKa, voltV, equipment, config, grounding, clearSec, gapMm?, workingMm? }
 * voltV is line-to-line volts. gapMm / workingMm override the equipment defaults when given.
 * Returns the governing incident energy (cal/cm²), boundary (mm), PPE band, the method used, the
 * arcing current, every input echoed, and the list of warnings (out-of-range, assumptions).
 */
export function arcFlash(inputs = {}) {
  const eq = EQUIPMENT[inputs.equipment] || EQUIPMENT['lv-panel'];
  const voltKv = Number(inputs.voltV) / 1000;
  const faultKa = Number(inputs.faultKa);
  const clearSec = Number(inputs.clearSec);
  const gapMm = inputs.gapMm != null && inputs.gapMm !== '' ? Number(inputs.gapMm) : eq.gapMm;
  const workingMm = inputs.workingMm != null && inputs.workingMm !== '' ? Number(inputs.workingMm) : eq.workingMm;
  const config = CONFIGS[inputs.config] ? inputs.config : 'box';
  const grounding = inputs.grounding === 'ungrounded' ? 'ungrounded' : 'grounded';
  if (!(faultKa > 0)) throw new Error('Enter the available bolted fault current (kA).');
  if (!(voltKv > 0)) throw new Error('Enter the system voltage.');
  if (!(clearSec > 0)) throw new Error('Enter the arc duration / upstream clearing time (s).');

  const warnings = [];
  const inRange = voltKv >= VALID.voltMinKv && voltKv <= VALID.voltMaxKv
    && faultKa >= VALID.faultMinKa && faultKa <= VALID.faultMaxKa
    && gapMm >= VALID.gapMinMm && gapMm <= VALID.gapMaxMm;

  let cal, boundaryMm, method, arcKa = null, arcEquation = null, normJ = null;
  if (inRange) {
    const ac = arcingCurrent({ faultKa, voltKv, gapMm, config });
    arcKa = ac.arcKa; arcEquation = ac.equation;
    // IEEE 1584-2002 §9.10.5: for systems < 1 kV, also evaluate at 85% of the arcing current and
    // take the LARGER incident energy (a lower arc current can clear slower / dissipate more).
    const atFull = incidentEnergyEmpirical({ arcKa, voltKv, gapMm, workingMm, x: eq.x, config, grounding, clearSec });
    let chosen = atFull, chosenArc = arcKa;
    if (voltKv < 1) {
      const reduced = incidentEnergyEmpirical({ arcKa: arcKa * 0.85, voltKv, gapMm, workingMm, x: eq.x, config, grounding, clearSec });
      if (reduced.cal > atFull.cal) { chosen = reduced; chosenArc = arcKa * 0.85; }
    }
    cal = chosen.cal; normJ = chosen.normJ; arcKa = chosenArc;
    boundaryMm = boundaryEmpirical({ arcKa, voltKv, gapMm, x: eq.x, config, grounding, clearSec });
    method = 'IEEE 1584-2002 empirical';
    // Conservative cross-check: if Lee is higher (it can be, near range limits), report Lee instead.
    const lee = incidentEnergyLee({ voltKv, faultKa, workingMm, clearSec });
    if (lee.cal > cal) {
      cal = lee.cal; boundaryMm = boundaryLee({ voltKv, faultKa, clearSec });
      method = 'Ralph Lee (higher than empirical here — used as the conservative value)';
      warnings.push('The Lee maximum-power value exceeded the empirical value, so the higher Lee number is shown. Have an engineer confirm.');
    }
  } else {
    const lee = incidentEnergyLee({ voltKv, faultKa, workingMm, clearSec });
    cal = lee.cal; boundaryMm = boundaryLee({ voltKv, faultKa, clearSec });
    method = 'Ralph Lee maximum-power (inputs outside the IEEE 1584-2002 empirical range)';
    warnings.push('One or more inputs are outside the IEEE 1584-2002 empirical range (0.208–15 kV, 0.7–106 kA, 13–152 mm gap). The conservative Lee method was used; it is an upper bound and usually over-predicts. An engineer must run the correct model.');
  }

  const ppe = ppeFor(cal);
  if (clearSec > 2) warnings.push('Clearing time over 2 s assumes the worker cannot move away; confirm the upstream device actually clears this fast (IEEE 1584-2002 §B.1.2).');
  warnings.push('IEEE 1584-2018 (five electrode configurations and the enclosure-size correction) is NOT applied here (VERIFY-2018). Screening value only.');

  return {
    cal, calRounded: Math.round(cal * 100) / 100,
    boundaryMm, method, arcKa, arcEquation, normJ,
    ppe, warnings, inRange,
    inputs: { faultKa, voltV: Number(inputs.voltV), voltKv, gapMm, workingMm, clearSec, config, grounding, equipment: inputs.equipment || 'lv-panel', equipmentLabel: eq.label, x: eq.x },
  };
}
