// Battery energy storage system (ESS) basics. Pure, offline, SI. Reuses the CEC conductor/rating
// engine (lib/cec) so conductor and overcurrent picks agree with the other calculators. An estimating
// aid citing CEC rules — confirm with the inspection authority and the ESS/inverter datasheets.
//
// SAFETY/ACCURACY: kept deliberately conservative (round battery capacity UP, size conductors and
// overcurrent at 125% continuous). CEC rule NUMBERS carry a VERIFY tag; no code value is invented.
//
// References (method and factors):
//   CEC 2024 Section 64, Renewable Energy Systems — energy storage systems, disconnecting means and
//     overcurrent protection (Rule 64-8xx area, VERIFY).
//   CEC 2024 Section 26, Rule 26-500 series — batteries and battery rooms (VERIFY).
//   CEC 2024 Rule 8-104 continuous-duty: conductor ampacity and overcurrent not less than 125% of the
//     continuous current. Inverter/charger output is treated as continuous.

import { minConductorForAmps, nextStandardRating, sizeLabel, bondingConductor } from './cec/index.js';

export const CONT_FACTOR = 1.25; // 125% continuous (Rule 8-104)

export const CHEMISTRIES = [
  { value: 'liion', label: 'Lithium-ion (LFP/NMC)', dodPct: 90 },
  { value: 'leadacid', label: 'Lead-acid (flooded/AGM)', dodPct: 50 },
  { value: 'custom', label: 'Custom depth of discharge' },
];

/** Usable energy a backup load needs: kW x hours = kWh. */
export function usableKwh({ loadKw, hours }) {
  return Number(loadKw) * Number(hours);
}

/**
 * Nominal (rated) battery capacity so the usable energy is available at the given depth of discharge,
 * plus an optional round-trip/aging derate. nominalKwh = usableKwh / (dod/100 x derate).
 */
export function nominalKwh({ loadKw, hours, dodPct, deratePct = 100 }) {
  const usable = usableKwh({ loadKw, hours });
  const dod = Number(dodPct) / 100;
  const der = Number(deratePct) / 100;
  if (!(dod > 0) || !(der > 0)) return null;
  return usable / (dod * der);
}

/**
 * ESS screening summary.
 * inputs: {
 *   loadKw, hours, dodPct, deratePct,
 *   inverterKw, acVolts, acPhase,        // AC output side
 *   dcVolts,                             // battery nominal DC bus (for DC current/disconnect)
 *   material
 * }
 * Returns energy capacity, AC and DC continuous currents, conductor + overcurrent/disconnect sizing.
 */
export function sizeEss(inputs = {}) {
  const n = (x) => (x == null || x === '' ? 0 : Number(x));
  const material = inputs.material === 'al' ? 'al' : 'cu';
  const warnings = [];

  const loadKw = n(inputs.loadKw);
  const hours = n(inputs.hours);
  const dodPct = n(inputs.dodPct) > 0 ? n(inputs.dodPct) : 90;
  const deratePct = n(inputs.deratePct) > 0 ? n(inputs.deratePct) : 100;
  if (!(loadKw > 0) || !(hours > 0)) throw new Error('Enter the backup load (kW) and the backup time (hours).');

  const usable = usableKwh({ loadKw, hours });
  const nominal = nominalKwh({ loadKw, hours, dodPct, deratePct });

  // AC side: inverter continuous output current (defaults to the backup load if no inverter kW given).
  const acVolts = n(inputs.acVolts);
  const acPhase = Number(inputs.acPhase) === 3 ? 3 : 1;
  const inverterKw = n(inputs.inverterKw) > 0 ? n(inputs.inverterKw) : loadKw;
  let acContinuousAmps = 0;
  if (acVolts > 0) {
    const va = inverterKw * 1000;
    acContinuousAmps = acPhase === 3 ? va / (Math.sqrt(3) * acVolts) : va / acVolts;
  } else {
    warnings.push('Enter the AC voltage to size the AC conductor and overcurrent.');
  }
  const acDesignAmps = CONT_FACTOR * acContinuousAmps;
  const acOcpd = acContinuousAmps > 0 ? nextStandardRating(acDesignAmps) : null;
  const acSize = acContinuousAmps > 0 ? minConductorForAmps(acDesignAmps, material, 75) : null;
  const bond = acOcpd ? bondingConductor(acOcpd) : null;

  // DC side: battery/inverter DC current at the nominal battery voltage. Disconnect + overcurrent at
  // 125% of the continuous DC current (Section 64 / Rule 8-104).
  const dcVolts = n(inputs.dcVolts);
  let dcContinuousAmps = 0;
  if (dcVolts > 0) {
    dcContinuousAmps = (inverterKw * 1000) / dcVolts; // P = V x I on the DC bus
  }
  const dcDesignAmps = CONT_FACTOR * dcContinuousAmps;
  const dcOcpd = dcContinuousAmps > 0 ? nextStandardRating(dcDesignAmps) : null;
  const dcSize = dcContinuousAmps > 0 ? minConductorForAmps(dcDesignAmps, material, 90) : null;

  return {
    material,
    energy: { usableKwh: usable, nominalKwh: nominal, dodPct, deratePct },
    ac: {
      inverterKw, continuousAmps: acContinuousAmps, designAmps: acDesignAmps, ocpd: acOcpd,
      size: acSize, sizeLabel: acSize ? sizeLabel(acSize) : null, bond,
    },
    dc: {
      volts: dcVolts, continuousAmps: dcContinuousAmps, designAmps: dcDesignAmps, ocpd: dcOcpd,
      size: dcSize, sizeLabel: dcSize ? sizeLabel(dcSize) : null,
    },
    warnings,
  };
}
