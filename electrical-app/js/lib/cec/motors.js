// Motors, CEC Section 28: full-load current (Tables 44 and 45), conductors
// (Rule 28-106), branch-circuit overcurrent protection (Rule 28-200, Table 29)
// and overload protection (Rule 28-306).
import { SIZES, ampacity, prevStandardRating } from './conductors.js';

/**
 * Table 45: full-load current, single-phase AC motors (A).
 * The 115 V and 230 V columns match the Nexans Electrician's Handbook reprint of Table 45
 * (e.g. 1 hp 16/8 A, 5 hp 56/28 A) and NEC Table 430.248. The 200 V and 208 V columns are the
 * 230 V value +15% and +10%, the rule the table's note gives. VERIFY the 2024 column set.
 */
export const TABLE_45 = {
  volts: [115, 200, 208, 230],
  hp: {
    '1/6': [4.4, 2.5, 2.4, 2.2], '1/4': [5.8, 3.3, 3.2, 2.9], '1/3': [7.2, 4.1, 4.0, 3.6], '1/2': [9.8, 5.6, 5.4, 4.9],
    '3/4': [13.8, 7.9, 7.6, 6.9], '1': [16, 9.2, 8.8, 8], '1-1/2': [20, 11.5, 11, 10], '2': [24, 13.8, 13.2, 12],
    '3': [34, 19.6, 18.7, 17], '5': [56, 32.2, 30.8, 28], '7-1/2': [80, 46, 44, 40], '10': [100, 57.5, 55, 50],
  },
};

/**
 * Table 44: full-load current, three-phase AC induction motors (A). The 575 V column serves
 * 600 V systems (motor 115/230/460/575 V ratings match 120/240/480/600 V systems).
 * The 230, 460 and 575 V columns match the handbook reprint of Table 44 (10 hp 28/14/11 A,
 * 25 hp 68/34/27 A) and NEC Table 430.250; 200 V and 208 V are 230 V +15% and +10% per the
 * table note. VERIFY the 2024 column set.
 */
export const TABLE_44 = {
  volts: [200, 208, 230, 460, 575],
  hp: {
    '1/2': [2.5, 2.4, 2.2, 1.1, 0.9], '3/4': [3.7, 3.5, 3.2, 1.6, 1.3], '1': [4.8, 4.6, 4.2, 2.1, 1.7],
    '1-1/2': [6.9, 6.6, 6.0, 3.0, 2.4], '2': [7.8, 7.5, 6.8, 3.4, 2.7], '3': [11.0, 10.6, 9.6, 4.8, 3.9],
    '5': [17.5, 16.7, 15.2, 7.6, 6.1], '7-1/2': [25.3, 24.2, 22, 11, 9], '10': [32.2, 30.8, 28, 14, 11],
    '15': [48.3, 46.2, 42, 21, 17], '20': [62.1, 59.4, 54, 27, 22], '25': [78.2, 74.8, 68, 34, 27],
    '30': [92, 88, 80, 40, 32], '40': [120, 114, 104, 52, 41], '50': [150, 143, 130, 65, 52],
    '60': [177, 169, 154, 77, 62], '75': [221, 211, 192, 96, 77], '100': [285, 273, 248, 124, 99],
    '125': [359, 343, 312, 156, 125], '150': [414, 396, 360, 180, 144], '200': [552, 528, 480, 240, 192],
  },
};

/**
 * Table 29: maximum branch-circuit overcurrent protection, percent of motor full-load current,
 * squirrel-cage motors started across the line: time-delay fuse 175%, non-time-delay fuse 300%,
 * inverse-time breaker 250% (IAEI 2013, "Grouping of motors on a single branch circuit").
 * VERIFY the other motor types and starting methods.
 */
export const TABLE_29 = { timeDelayFuse: 175, nonTimeDelayFuse: 300, inverseTimeBreaker: 250 };

/**
 * Rule 28-200 (2024): the device may not exceed the Table 29 value; there is no NEC-style
 * next-size-up. Where the motor won't start, it may go up to: time-delay fuse 225%,
 * non-time-delay fuse 400% (300% above 600 A), breaker 400% for FLC up to 100 A (300% above).
 * A 15 A device is always permitted. (IAEI, "Motors and generators: new questions and answers".)
 */
export function wontStartLimits(flc) {
  return {
    timeDelayFuse: flc * 2.25,
    nonTimeDelayFuse: flc * (flc * 4 > 600 ? 3 : 4),
    inverseTimeBreaker: flc * (flc > 100 ? 3 : 4),
  };
}

/** Rule 28-306: overload device at most 125% of nameplate current (service factor 1.15 or more), else 115%. */
export const OVERLOAD_PCT = { marked: 125, other: 115 };

const atMost = (max) => Math.max(15, prevStandardRating(max) ?? 15);

/**
 * motor({ hp, volts, phase, nameplateA, serviceFactor115 })
 *  - conductors: ampacity at least 125% of FLC (Rule 28-106), 75 °C column (Table 2)
 *  - branch protection: the largest standard rating not above the Table 29 value, 15 A minimum
 *    (Rule 28-200), with the won't-start ceilings alongside
 *  - overload: 125% / 115% of the nameplate current (Rule 28-306)
 */
export function motor({ hp, volts, phase = 3, nameplateA = null, serviceFactor115 = true }) {
  const t = Number(phase) === 1 ? TABLE_45 : TABLE_44;
  const col = t.volts.indexOf(Number(volts));
  const row = t.hp[hp];
  if (col < 0 || !row) return null;
  const flc = row[col];
  const conductorAmps = flc * 1.25;
  const breakerMax = (flc * TABLE_29.inverseTimeBreaker) / 100;
  const tdFuseMax = (flc * TABLE_29.timeDelayFuse) / 100;
  const ntdFuseMax = (flc * TABLE_29.nonTimeDelayFuse) / 100;
  const nameplate = Number(nameplateA) > 0 ? Number(nameplateA) : flc;
  const overloadPct = serviceFactor115 ? OVERLOAD_PCT.marked : OVERLOAD_PCT.other;
  return {
    flc, table: Number(phase) === 1 ? 'Table 45' : 'Table 44',
    conductorAmps,
    // Motor branch conductors are protected per Section 28, so the Rule 14-104(2)
    // small-conductor limits don't apply; size on the 75 °C column.
    conductor: SIZES.find((sz) => (ampacity(sz, 'cu', 75) ?? -1) >= conductorAmps) ?? null,
    breakerMax, breaker: atMost(breakerMax),
    tdFuseMax, tdFuse: atMost(tdFuseMax),
    ntdFuseMax, ntdFuse: atMost(ntdFuseMax),
    wontStart: wontStartLimits(flc),
    overloadPct, overloadMax: (nameplate * overloadPct) / 100, nameplate,
  };
}
