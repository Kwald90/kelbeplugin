// Solar PV array/string sizing and CEC Section 64 interconnection. Pure, offline, SI.
// Reuses the CEC conductor/rating engine (lib/cec) so conductor and overcurrent picks agree with the
// other calculators. An estimating/screening aid citing CEC rules — confirm with the inspection
// authority, the utility and the inverter/module datasheets.
//
// SAFETY/ACCURACY: Section 64 (Renewable Energy Systems) rule NUMBERS below are the parts most likely
// to differ from the printed CSA C22.1:24 text, so every rule reference carries a VERIFY tag and the
// math is kept conservative. No code value is invented: the 125% factors and the 120% busbar rule are
// the long-standing PV conventions (CEC Section 64 / Section 84; NEC 690.8 / 705.12 equivalents).
//
// References (method and factors):
//   CEC 2024 Section 64, Renewable Energy Systems — PV source/output circuit current and protection.
//   CEC 2024 Rule 64-014 (VERIFY): maximum PV circuit current = 125% of rated module short-circuit
//     current (Isc). Mirrors NEC 690.8(A)(1).
//   CEC 2024 Rule 8-104 / Section 64 continuous-duty: conductor ampacity and overcurrent not less than
//     125% of the continuous current. The two 125% factors compound (1.25 x 1.25 = 1.5625 x Isc).
//   CEC 2024 interconnection, load-side (busbar) connection — the "120% rule": the sum of the service
//     main overcurrent device and the PV back-feed overcurrent device must not exceed 120% of the
//     busbar rating (CEC Section 64 / Section 84, Rule 64-112 area — VERIFY; NEC 705.12(B)(3)(2)).
//   CEC 2024 Rule 64-218 area (VERIFY): rapid shutdown / readily accessible disconnecting means for
//     PV on or in buildings.

import { minConductorForAmps, nextStandardRating, sizeLabel, bondingConductor } from './cec/index.js';

export const CONNECTION = [
  { value: 'loadside', label: 'Load side — back-fed breaker in the panel (120% rule applies)' },
  { value: 'supplyside', label: 'Supply side — tapped ahead of the service main (no 120% rule)' },
];

// PV continuous-current factor on rated short-circuit current (Isc), CEC Rule 64-014 (VERIFY).
export const ISC_FACTOR = 1.25;
// Continuous-duty factor applied again to size conductors and overcurrent (Rule 8-104 / Section 64).
export const CONT_FACTOR = 1.25;
// Load-side interconnection busbar allowance (the "120% rule").
export const BUSBAR_ALLOWANCE = 1.20;

/**
 * Temperature-corrected open-circuit voltage of ONE module at the coldest expected cell temperature.
 * Voc rises as it gets colder: Voc(T) = Voc_stc * (1 + (beta/100) * (Tmin - 25)), beta in %/degC and
 * negative (a module's Voc temperature coefficient). Standard PV practice (not a CEC value).
 */
export function vocCold({ vocStc, betaPctPerC, tMinC }) {
  const voc = Number(vocStc);
  const beta = Number(betaPctPerC); // e.g. -0.29 %/degC
  const t = Number(tMinC);
  if (!(voc > 0)) return null;
  return voc * (1 + (beta / 100) * (t - 25));
}

/**
 * Maximum modules per series string so the cold Voc stays at or below the inverter's maximum DC input
 * voltage. Returns the integer count (0 if a single module already exceeds the limit).
 */
export function maxModulesPerString({ vocStc, betaPctPerC, tMinC, inverterVmaxDc }) {
  const vc = vocCold({ vocStc, betaPctPerC, tMinC });
  const vmax = Number(inverterVmaxDc);
  if (!(vc > 0) || !(vmax > 0)) return 0;
  return Math.floor(vmax / vc);
}

/**
 * Minimum modules per series string so the warm Vmp stays at or above the inverter MPPT minimum.
 * Vmp falls as it gets hotter: Vmp(T) = Vmp_stc * (1 + (gamma/100) * (Tmax - 25)). If no Vmp temp
 * coefficient is given, the Voc coefficient is used as a conservative stand-in.
 */
export function minModulesPerString({ vmpStc, gammaPctPerC, tMaxC, inverterMpptMin }) {
  const vmp = Number(vmpStc);
  const g = Number(gammaPctPerC);
  const vmin = Number(inverterMpptMin);
  if (!(vmp > 0) || !(vmin > 0)) return 0;
  const vmpHot = vmp * (1 + (g / 100) * (Number(tMaxC) - 25));
  if (!(vmpHot > 0)) return 0;
  return Math.ceil(vmin / vmpHot);
}

/**
 * Full PV sizing + Section 64 interconnection screening.
 * inputs: {
 *   moduleWp, vocStc, vmpStc, iscStc, betaPctPerC, gammaPctPerC,
 *   modulesPerString, strings,
 *   inverterVmaxDc, inverterMpptMin, inverterMpptMax, inverterAcKw, inverterAcAmps, acVolts, acPhase,
 *   tMinC, tMaxC,
 *   connection, busbarRating, mainBreaker, dcMaterial
 * }
 * Returns string-sizing window, DC conductor/OCPD, AC conductor/OCPD, the 120% busbar check, and notes.
 */
export function solarPv(inputs = {}) {
  const warnings = [];
  const n = (x) => (x == null || x === '' ? 0 : Number(x));
  const material = inputs.dcMaterial === 'al' ? 'al' : 'cu';

  // --- String window vs inverter ---
  const vMax = maxModulesPerString({
    vocStc: n(inputs.vocStc), betaPctPerC: n(inputs.betaPctPerC), tMinC: n(inputs.tMinC), inverterVmaxDc: n(inputs.inverterVmaxDc),
  });
  const vMin = minModulesPerString({
    vmpStc: n(inputs.vmpStc), gammaPctPerC: n(inputs.gammaPctPerC) || n(inputs.betaPctPerC), tMaxC: n(inputs.tMaxC), inverterMpptMin: n(inputs.inverterMpptMin),
  });
  const perString = Math.round(n(inputs.modulesPerString));
  const strings = Math.max(1, Math.round(n(inputs.strings)) || 1);
  const vcCold = vocCold({ vocStc: n(inputs.vocStc), betaPctPerC: n(inputs.betaPctPerC), tMinC: n(inputs.tMinC) });
  const stringVocCold = vcCold != null ? vcCold * perString : null;
  const windowOk = perString > 0 && (vMax === 0 || perString <= vMax) && (vMin === 0 || perString >= vMin);
  if (perString > 0 && vMax > 0 && perString > vMax) {
    warnings.push(`String of ${perString} modules exceeds ${vMax} max: cold Voc ${stringVocCold ? Math.round(stringVocCold) : '—'} V would pass the inverter's ${Math.round(n(inputs.inverterVmaxDc))} V limit. Shorten the string.`);
  }
  if (perString > 0 && vMin > 0 && perString < vMin) {
    warnings.push(`String of ${perString} modules is below the ${vMin} minimum: warm Vmp may drop under the inverter MPPT floor. Lengthen the string.`);
  }

  // --- Array size ---
  const moduleWp = n(inputs.moduleWp);
  const moduleCount = perString * strings;
  const arrayKwDc = (moduleWp * moduleCount) / 1000;

  // --- DC conductor + OCPD, Section 64 ---
  // Max circuit current = 1.25 x Isc (per string; parallel strings add). Then conductor ampacity and
  // overcurrent >= 1.25 x that for continuous duty. The two factors compound to 1.5625 x Isc.
  const iscString = n(inputs.iscStc);
  const dcMaxCircuitAmps = ISC_FACTOR * iscString * strings; // combined array DC current entering the combiner / inverter
  const dcDesignAmps = CONT_FACTOR * dcMaxCircuitAmps;
  const dcOcpd = nextStandardRating(dcDesignAmps);
  const dcSize = minConductorForAmps(dcDesignAmps, material, 90); // PV conductors are commonly 90 degC rated
  // Per-string overcurrent (only required where 3+ strings are paralleled): sized on one string's max.
  const stringMaxAmps = ISC_FACTOR * iscString;
  const stringOcpd = nextStandardRating(CONT_FACTOR * stringMaxAmps);

  // --- AC side (inverter output) ---
  const acVolts = n(inputs.acVolts);
  const acPhase = Number(inputs.acPhase) === 3 ? 3 : 1;
  let acContinuousAmps = n(inputs.inverterAcAmps);
  if (!(acContinuousAmps > 0) && n(inputs.inverterAcKw) > 0 && acVolts > 0) {
    const va = n(inputs.inverterAcKw) * 1000;
    acContinuousAmps = acPhase === 3 ? va / (Math.sqrt(3) * acVolts) : va / acVolts;
  }
  const acDesignAmps = CONT_FACTOR * acContinuousAmps; // 125% continuous (Rule 8-104 / Section 64)
  const acOcpd = acContinuousAmps > 0 ? nextStandardRating(acDesignAmps) : null;
  const acSize = acContinuousAmps > 0 ? minConductorForAmps(acDesignAmps, material, 75) : null;
  const bond = acOcpd ? bondingConductor(acOcpd) : null;

  // --- 120% busbar rule, load-side connection ---
  const connection = inputs.connection === 'supplyside' ? 'supplyside' : 'loadside';
  const busbar = n(inputs.busbarRating);
  const main = n(inputs.mainBreaker);
  let busbar120 = null;
  if (connection === 'loadside' && busbar > 0 && main > 0) {
    const allowed = BUSBAR_ALLOWANCE * busbar;
    const maxBackfeed = allowed - main;
    const sum = main + (acOcpd || 0);
    busbar120 = {
      busbar, main, allowedTotal: allowed, maxBackfeedBreaker: maxBackfeed,
      backfeedBreaker: acOcpd, sumBreakers: acOcpd ? sum : null,
      pass: acOcpd ? sum <= allowed + 1e-9 : null,
    };
    if (acOcpd && sum > allowed + 1e-9) {
      warnings.push(`120% rule fails: ${main} A main + ${acOcpd} A PV breaker = ${Math.round(sum)} A exceeds 120% of the ${busbar} A busbar (${Math.round(allowed)} A). Use a supply-side connection, a smaller back-feed, or a larger/derated busbar.`);
    }
  }

  return {
    material, connection,
    stringWindow: { minModules: vMin, maxModules: vMax, perString, strings, stringVocCold, windowOk, vocCold: vcCold },
    array: { moduleCount, moduleWp, arrayKwDc },
    dc: {
      maxCircuitAmps: dcMaxCircuitAmps, designAmps: dcDesignAmps, ocpd: dcOcpd,
      size: dcSize, sizeLabel: dcSize ? sizeLabel(dcSize) : null,
      stringMaxAmps, stringOcpd,
    },
    ac: {
      continuousAmps: acContinuousAmps, designAmps: acDesignAmps, ocpd: acOcpd,
      size: acSize, sizeLabel: acSize ? sizeLabel(acSize) : null,
      bond,
    },
    busbar120,
    warnings,
  };
}
