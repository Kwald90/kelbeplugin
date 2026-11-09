// Generator / optional-standby sizing + automatic transfer switch (ATS). Pure, offline, SI. Reuses
// the CEC conductor/rating engine (lib/cec) so conductor and overcurrent picks agree with the other
// calculators. An estimating aid citing CEC rules — confirm with the inspection authority and the
// genset/ATS datasheets.
//
// SAFETY/ACCURACY: kept conservative (round genset UP to a catalogue size, size the feeder and
// overcurrent at 125% of generator full-load current). CEC rule NUMBERS carry a VERIFY tag; no code
// value is invented.
//
// References (method and factors):
//   CEC 2024 Section 46, Emergency Systems, Unit Equipment and Optional Standby — generators,
//     transfer equipment and the one-line (Rule 46-xxx area, VERIFY).
//   CEC 2024 Rule 8-104 continuous-duty and Section 8 optional-standby demand: a generator feeder is
//     sized for the standby load it may carry; a standby load may take a demand factor under Section 8
//     (VERIFY the factor against the printed rule).
//   CEC 2024 Rule 4-004 / Table 2, 4 — feeder conductor ampacity (via the CEC engine).

import { minConductorForAmps, nextStandardRating, sizeLabel, bondingConductor } from './cec/index.js';

export const CONT_FACTOR = 1.25; // 125% continuous (Rule 8-104)

export const PHASES = [{ value: '1', label: 'Single phase' }, { value: '3', label: 'Three phase' }];

// Common standby/prime genset kW ratings (catalogue sizes). VERIFY against a current genset catalogue.
export const KW_SIZES = [8, 10, 12, 14, 16, 18, 20, 22, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100, 125, 150, 175, 200, 250, 300, 350, 400, 500];

/** Smallest catalogue genset kW at or above a required kW. */
export function standardKw(kw) {
  return KW_SIZES.find((k) => k >= Number(kw) - 1e-9) ?? null;
}

/** Generator full-load current (A) for a kW rating at a power factor and voltage. 3-phase uses sqrt(3). */
export function generatorFla({ kw, pf, volts, phase = 3 }) {
  const v = Number(volts);
  const p = Number(pf) > 0 ? Number(pf) : 0.8;
  if (!(v > 0)) return null;
  const va = (Number(kw) * 1000) / p; // kVA x 1000
  return Number(phase) === 3 ? va / (Math.sqrt(3) * v) : va / v;
}

/**
 * Generator / optional-standby sizing summary.
 * inputs: {
 *   connectedKw,               // total connected standby load
 *   demandPct,                 // optional-standby demand factor applied to the connected load (<=100)
 *   pf, volts, phase,
 *   largestMotorKw,            // optional: starting/largest motor, adds a sizing margin
 *   material
 * }
 * Returns required kW/kVA, the catalogue genset, generator FLA, feeder conductor + OCPD, and the
 * transfer-switch rating.
 */
export function sizeGenerator(inputs = {}) {
  const n = (x) => (x == null || x === '' ? 0 : Number(x));
  const material = inputs.material === 'al' ? 'al' : 'cu';
  const phase = Number(inputs.phase) === 1 ? 1 : 3;
  const volts = n(inputs.volts);
  const pf = n(inputs.pf) > 0 ? n(inputs.pf) : 0.8;
  const warnings = [];
  if (!(volts > 0)) throw new Error('Enter the system voltage.');

  const connectedKw = n(inputs.connectedKw);
  if (!(connectedKw > 0)) throw new Error('Enter the connected standby load (kW).');
  const demandPct = n(inputs.demandPct) > 0 ? Math.min(n(inputs.demandPct), 100) : 100;
  // Demand-adjusted standby load, plus an allowance for the largest motor's running load already in
  // the connected total — the motor kW is used only to flag a starting-margin check.
  const requiredKw = connectedKw * (demandPct / 100);
  const requiredKva = requiredKw / pf;

  const genKw = standardKw(requiredKw);
  if (!genKw) warnings.push('Required kW exceeds the largest catalogue size listed; use multiple gensets or a custom unit.');

  const usedKw = genKw || requiredKw;
  const fla = generatorFla({ kw: usedKw, pf, volts, phase });

  // Feeder: 125% of generator full-load current (continuous), 75 degC termination column (Rule 4-004).
  const feederDesignAmps = CONT_FACTOR * fla;
  const feederOcpd = nextStandardRating(feederDesignAmps);
  const feederSize = minConductorForAmps(feederDesignAmps, material, 75);
  const bond = feederOcpd ? bondingConductor(feederOcpd) : null;

  // Transfer switch: rated at or above the feeder overcurrent / generator output (next standard rating
  // at or above the generator FLA). A whole-service ATS is rated to the service it switches.
  const atsRating = nextStandardRating(Math.max(fla, feederDesignAmps));

  const largestMotorKw = n(inputs.largestMotorKw);
  if (largestMotorKw > 0) {
    warnings.push(`Largest motor ${largestMotorKw} kW: confirm the genset can supply its starting (locked-rotor) kVA without excessive voltage dip — size on starting kVA, not running kW, where motor starting governs.`);
  }

  return {
    material, phase, volts, pf,
    load: { connectedKw, demandPct, requiredKw, requiredKva },
    generator: { kw: genKw, usedKw, fla },
    feeder: {
      designAmps: feederDesignAmps, ocpd: feederOcpd,
      size: feederSize, sizeLabel: feederSize ? sizeLabel(feederSize) : null, bond,
    },
    ats: { rating: atsRating },
    warnings,
  };
}
