// Cable-pulling tension and sidewall bearing pressure for feeder pulls. Pure, offline. SI internally
// (N, m); the UI converts to lbf/ft for the field. An estimating aid using the standard pulling
// formulas — confirm against the cable maker's maximum tension and sidewall-pressure limits.
//
// Formulas (standard, widely published — Polywater pulling guide; NECA/IEEE 525; Southwire pulling
// calculations):
//   Straight section (horizontal):  T_out = T_in + w·L·μ               (friction drag)
//   Straight section (incline up):  T_out = T_in + w·L·(μ·cosθ + sinθ)
//   Bend (capstan / belt eq.):       T_out = T_in · e^(μ·α)            (α in radians)
//   Sidewall bearing pressure:       SWBP = T_out / r                  (single cable; r bend radius)
//   Max pulling tension, pulling eye: T_max = 0.008 · n · CM  (lbf)    (0.008 lbf per circular mil
//       per conductor, copper; 0.006 for aluminium). Basket grip is limited further by the grip.
// The coefficient of friction μ depends on lubricant, conduit and cable jacket (typ. 0.2–0.5); it is
// a user input. The multi-cable weight-correction factor and the cradled/triangular SWBP reduction
// are simplified here (single-cable SWBP) and tagged VERIFY — use the maker's configuration factor
// for a true 3-conductor pull.

export const LBF_PER_N = 0.2248089431;    // 1 N = 0.224809 lbf
export const N_PER_LBF = 4.4482216153;
export const FT_PER_M = 3.280839895;
export const CMIL_PER_MM2 = 1973.525;     // 1 mm² = 1973.525 circular mils

// Max allowable tension per conductor material, lbf per circular mil (pulling eye / direct to
// conductor). VERIFY against ICEA / the cable maker. 0.008 Cu, 0.006 Al are the standard values.
export const MAX_TENSION_LBF_PER_CMIL = { cu: 0.008, al: 0.006 };

// Typical maximum sidewall bearing pressure, lbf/ft of bend radius. 500 lbf/ft is the common limit
// for building wire and medium-voltage cable; some jackets are lower. User-overridable. VERIFY.
export const DEFAULT_SWBP_LIMIT_LBF_FT = 500;

/** Tension (N) added by a straight section: T_in + w·L·(μ·cosθ + sinθ), θ incline from horizontal. */
export function straightTension({ tensionInN = 0, weightNPerM, lengthM, mu, inclineDeg = 0 }) {
  const w = Number(weightNPerM), L = Number(lengthM), m = Number(mu);
  if (!(w >= 0) || !(L >= 0) || !(m >= 0)) throw new Error('Straight pull needs weight, length and friction.');
  const theta = (Number(inclineDeg) || 0) * Math.PI / 180;
  return Number(tensionInN) + w * L * (m * Math.cos(theta) + Math.sin(theta));
}

/** Tension (N) out of a bend: T_in · e^(μ·α), α the bend angle in degrees. Capstan equation. */
export function bendTension({ tensionInN, mu, bendDeg }) {
  const t = Number(tensionInN), m = Number(mu), a = (Number(bendDeg) || 0) * Math.PI / 180;
  if (!(t >= 0) || !(m >= 0)) throw new Error('Bend needs an incoming tension and friction.');
  return t * Math.exp(m * a);
}

/** Sidewall bearing pressure (lbf/ft) at a bend from the tension out (N) and bend radius (m). */
export function sidewallPressure({ tensionOutN, radiusM }) {
  const r = Number(radiusM);
  if (!(r > 0)) return null;
  const tensionLbf = Number(tensionOutN) * LBF_PER_N;
  const radiusFt = r * FT_PER_M;
  return tensionLbf / radiusFt; // lbf/ft
}

/** Maximum allowable pulling tension (N) for n conductors of a given size and material. */
export function maxTension({ areaMm2, conductors = 1, material = 'cu' }) {
  const cmil = Number(areaMm2) * CMIL_PER_MM2;
  const k = MAX_TENSION_LBF_PER_CMIL[material] ?? MAX_TENSION_LBF_PER_CMIL.cu;
  const lbf = k * Number(conductors) * cmil;
  return { lbf, newtons: lbf * N_PER_LBF };
}

/**
 * Full pull: a straight run, then one bend (the usual worst case at the end of a run), computing the
 * tension entering and leaving the bend and the sidewall pressure at it.
 * inputs: { weightNPerM, lengthM, mu, inclineDeg, bendDeg, radiusM, tensionInN,
 *           areaMm2, conductors, material, swbpLimitLbfFt }
 * Returns tensions (N and lbf), SWBP (lbf/ft), the limits and pass/fail flags.
 */
export function pull(inputs = {}) {
  const mu = Number(inputs.mu);
  if (!(mu > 0)) throw new Error('Enter a coefficient of friction (typ. 0.2–0.5).');
  const tStraight = straightTension({
    tensionInN: Number(inputs.tensionInN) || 0, weightNPerM: inputs.weightNPerM,
    lengthM: inputs.lengthM, mu, inclineDeg: inputs.inclineDeg,
  });
  const bendDeg = Number(inputs.bendDeg) || 0;
  const tAfterBend = bendDeg > 0 ? bendTension({ tensionInN: tStraight, mu, bendDeg }) : tStraight;
  const swbp = bendDeg > 0 ? sidewallPressure({ tensionOutN: tAfterBend, radiusM: inputs.radiusM }) : null;

  const maxT = Number(inputs.areaMm2) > 0
    ? maxTension({ areaMm2: inputs.areaMm2, conductors: inputs.conductors || 1, material: inputs.material || 'cu' })
    : null;
  const swbpLimit = Number(inputs.swbpLimitLbfFt) > 0 ? Number(inputs.swbpLimitLbfFt) : DEFAULT_SWBP_LIMIT_LBF_FT;

  const tensionPass = maxT ? tAfterBend <= maxT.newtons + 1e-6 : null;
  const swbpPass = swbp == null ? null : swbp <= swbpLimit + 1e-6;

  return {
    tensionBeforeBendN: tStraight, tensionBeforeBendLbf: tStraight * LBF_PER_N,
    tensionAfterBendN: tAfterBend, tensionAfterBendLbf: tAfterBend * LBF_PER_N,
    hasBend: bendDeg > 0,
    swbpLbfFt: swbp, swbpLimitLbfFt: swbpLimit, swbpPass,
    maxTensionN: maxT?.newtons ?? null, maxTensionLbf: maxT?.lbf ?? null, tensionPass,
    mu,
  };
}
