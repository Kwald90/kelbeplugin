// CEC conductors: ampacity (Tables 1-4), correction factors (Tables 5A, 5C),
// termination temperature (Rule 4-006), overcurrent limits (Rule 14-104,
// Table 13) and conductor sizing. Pure functions, SI units.
//
// Rule and table numbers are CSA C22.1:24 (CEC 2024, 26th edition). CSA's text
// is copyrighted, so only numbers and references are here. Every value has a
// source comment; anything not confirmed against the 2024 tables says VERIFY
// and is listed in docs/code/verify.md. These are estimating aids: the
// inspection authority's reading of the code in force decides.

// ---------------------------------------------------------------------------
// Sizes
// ---------------------------------------------------------------------------

/** Conductor sizes, ascending (AWG, then kcmil). */
export const SIZES = ['14', '12', '10', '8', '6', '4', '3', '2', '1', '1/0', '2/0', '3/0', '4/0', '250', '300', '350', '400', '500'];

export const sizeLabel = (s) => (/^\d{3}$/.test(s) ? `${s} kcmil` : `${s} AWG`);

/**
 * Nominal cross-section in mm². Physical AWG/kcmil areas (ASTM B258:
 * area = circular mils × 5.067e-4 mm²), not a CEC table.
 */
export const AREA_MM2 = {
  '14': 2.08, '12': 3.31, '10': 5.26, '8': 8.37, '6': 13.3, '4': 21.2, '3': 26.7, '2': 33.6, '1': 42.4,
  '1/0': 53.5, '2/0': 67.4, '3/0': 85.0, '4/0': 107.2, '250': 126.7, '300': 152.0, '350': 177.3, '400': 202.7, '500': 253.4,
};

// ---------------------------------------------------------------------------
// Ampacity, Tables 1-4: [60 °C, 75 °C, 90 °C] columns, 30 °C ambient.
// ---------------------------------------------------------------------------

/**
 * Table 2: copper, not more than three conductors in a raceway or cable (Rule 4-004).
 * 75 °C and 90 °C columns, 14 AWG to 500 kcmil: confirmed. Southwire Canada spec 10006
 * ("2021 CEC Table 2") and SIMpull RW90 sheet ("2015 CEC Table 2"). 60 °C column: 14 and 12
 * confirmed (15, 20 A; the NEC lowered its values in 2011 to match CEC Tables 2 and 4, EC&M);
 * the other 60 °C values are VERIFY (they equal NEC Table 310.16). The 2012 CEC harmonized
 * Tables 1-4 with the NEC (IAEI magazine).
 */
export const TABLE_2 = {
  '14': [15, 20, 25], '12': [20, 25, 30], '10': [30, 35, 40], '8': [40, 50, 55], '6': [55, 65, 75],
  '4': [70, 85, 95], '3': [85, 100, 115], '2': [95, 115, 130], '1': [110, 130, 145],
  '1/0': [125, 150, 170], '2/0': [145, 175, 195], '3/0': [165, 200, 225], '4/0': [195, 230, 260],
  '250': [215, 255, 290], '300': [240, 285, 320], '350': [260, 310, 350], '400': [280, 335, 380], '500': [320, 380, 430],
};

/**
 * Table 4: aluminum, not more than three conductors in a raceway or cable.
 * 75 °C and 90 °C columns for 8 AWG to 500 kcmil: confirmed (Prysmian NUAL RWU90 spec 5600A,
 * "CEC Table 4"); 6 AWG at 60 °C = 40 A confirmed (Southwire NMD90 Al). VERIFY: the 12, 10 and
 * 3 AWG rows and the rest of the 60 °C column.
 */
export const TABLE_4 = {
  '12': [15, 20, 25], '10': [25, 30, 35], '8': [35, 40, 45], '6': [40, 50, 55],
  '4': [55, 65, 75], '3': [65, 75, 85], '2': [75, 90, 100], '1': [85, 100, 115],
  '1/0': [100, 120, 135], '2/0': [115, 135, 150], '3/0': [130, 155, 175], '4/0': [150, 180, 205],
  '250': [170, 205, 230], '300': [195, 230, 260], '350': [210, 250, 280], '400': [225, 270, 305], '500': [260, 310, 350],
};

/**
 * Table 1: single copper conductor in free air. 75 °C and 90 °C columns confirmed (Southwire
 * SIMpull RW90 sheet; IAEI 2016 for 350 kcmil at 75 °C). VERIFY: the 60 °C column.
 */
export const TABLE_1 = {
  '14': [25, 30, 35], '12': [30, 35, 40], '10': [40, 50, 55], '8': [60, 70, 80], '6': [80, 95, 105],
  '4': [105, 125, 140], '3': [120, 145, 165], '2': [140, 170, 190], '1': [165, 195, 220],
  '1/0': [195, 230, 260], '2/0': [225, 265, 300], '3/0': [260, 310, 350], '4/0': [300, 360, 405],
  '250': [340, 405, 455], '300': [375, 445, 500], '350': [420, 505, 570], '400': [455, 545, 615], '500': [515, 620, 700],
};

/** Table 3: single aluminum conductor in free air. VERIFY: every value (taken from NEC Table 310.17). */
export const TABLE_3 = {
  '12': [25, 30, 35], '10': [35, 40, 45], '8': [45, 55, 60], '6': [60, 75, 85],
  '4': [80, 100, 115], '3': [95, 115, 130], '2': [110, 135, 150], '1': [130, 155, 175],
  '1/0': [150, 180, 205], '2/0': [175, 210, 235], '3/0': [200, 240, 270], '4/0': [235, 280, 315],
  '250': [265, 315, 355], '300': [290, 350, 395], '350': [330, 395, 445], '400': [355, 425, 480], '500': [405, 485, 545],
};

const COL = { 60: 0, 75: 1, 90: 2 };

/** The table a conductor's ampacity comes from: { table: 'Table 2', rows }. */
export function ampacityTable(material = 'cu', freeAir = false) {
  if (material === 'al') return freeAir ? { name: 'Table 3', rows: TABLE_3 } : { name: 'Table 4', rows: TABLE_4 };
  return freeAir ? { name: 'Table 1', rows: TABLE_1 } : { name: 'Table 2', rows: TABLE_2 };
}

/** ampacity(size, material, tempC, freeAir) -> amps, or null when the size isn't listed. */
export function ampacity(size, material = 'cu', tempC = 75, freeAir = false) {
  const row = ampacityTable(material, freeAir).rows[size];
  return row ? row[COL[tempC] ?? 1] : null;
}

/** Smallest size whose table ampacity at tempC is at least `amps` (raceway/cable unless freeAir). */
export function minConductorForAmps(amps, material = 'cu', tempC = 75, freeAir = false) {
  return SIZES.find((s) => (ampacity(s, material, tempC, freeAir) ?? -1) >= amps - 1e-9) ?? null;
}

// ---------------------------------------------------------------------------
// Correction factors
// ---------------------------------------------------------------------------

/**
 * Table 5A: correction for ambient temperature above 30 °C.
 * Rows: [ambient up to °C, 60 °C factor, 75 °C factor, 90 °C factor]; null = not permitted.
 * The factors are sqrt((Tc − Ta)/(Tc − 30)) rounded to two places, the same as NEC
 * Table 310.15(B)(1)(1). Confirmed points: 90 °C column 0.91 at 40 °C and 0.82 at 50 °C,
 * 75 °C column 0.88 at 40 °C (IAEI 2012 and 2016; BCcampus Section 4 text). Rows step by 5 °C;
 * an ambient between rows uses the next row up. VERIFY the other points. (Before 2012 the
 * CEC values were lower, e.g. 0.90 at 40 °C.)
 */
export const TABLE_5A = [
  [30, 1.00, 1.00, 1.00], [35, 0.91, 0.94, 0.96], [40, 0.82, 0.88, 0.91], [45, 0.71, 0.82, 0.87],
  [50, 0.58, 0.75, 0.82], [55, 0.41, 0.67, 0.76], [60, null, 0.58, 0.71], [65, null, 0.47, 0.65],
  [70, null, 0.33, 0.58], [75, null, null, 0.50], [80, null, null, 0.41],
];

/** Ambient correction factor (Table 5A); 1 at or below 30 °C; null if the insulation can't be used there. */
export function ambientFactor(ambientC = 30, tempC = 90) {
  if (ambientC <= 30) return 1;
  const col = (COL[tempC] ?? 2) + 1;
  for (const row of TABLE_5A) if (ambientC <= row[0]) return row[col];
  return null;
}

/**
 * Table 5C: correction for more than three current-carrying conductors in a raceway or cable.
 * 1-3: 1.00, 4-6: 0.80, 7-24: 0.70, 25-42: 0.60, 43 and more: 0.50. Confirmed: Nexans
 * Electrician's Handbook reprint of the table, 0.80 and 0.70 in IAEI 2012/2016 and the BCcampus
 * text. Not applied in auxiliary gutters with 30 or fewer conductors.
 */
export const TABLE_5C = [[3, 1.0], [6, 0.8], [24, 0.7], [42, 0.6], [Infinity, 0.5]];

export function cccFactor(ccc = 3) {
  for (const [max, f] of TABLE_5C) if (ccc <= max) return f;
  return 0.5;
}

// ---------------------------------------------------------------------------
// Terminations and overcurrent protection
// ---------------------------------------------------------------------------

/**
 * Rule 4-006: equipment marked with a termination temperature uses that column.
 * Unmarked: 60 °C for equipment rated 100 A or less (or marked for 1 AWG and smaller),
 * 75 °C above 100 A (or larger than 1 AWG). Confirmed: IAEI "Ampere rating of a circuit,
 * feeder or service".
 */
export function terminationTemp({ amps = 0, marked = null } = {}) {
  if (marked) return Number(marked);
  return amps > 100 ? 75 : 60;
}

/**
 * Rule 14-104(2): small conductors. Overcurrent protection not more than
 * 15 A for 14 AWG Cu, 20 A for 12 AWG Cu, 30 A for 10 AWG Cu;
 * 15 A for 12 AWG Al, 25 A for 10 AWG Al (no 14 AWG Al; 12 AWG is the smallest Al size).
 * Confirmed: IAEI 2016 "When is overcurrent protection required"; BCcampus Section 4 text.
 */
export const SMALL_CONDUCTOR_OCPD = { cu: { '14': 15, '12': 20, '10': 30 }, al: { '12': 15, '10': 25 } };

/**
 * Standard fuse and circuit-breaker ratings, the steps used by Table 13.
 * 15 A to 600 A: the Canadian fuse ampere series (Mersen CSA Class H data sheet). VERIFY: the
 * breaker series and the steps above 600 A (taken from NEC 240.6(A)), and Table 13's rows.
 */
export const STANDARD_RATINGS = [15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 225, 250,
  300, 350, 400, 450, 500, 600, 700, 800, 1000, 1200, 1600, 2000, 2500, 3000, 4000, 5000, 6000];

export function nextStandardRating(amps) {
  return STANDARD_RATINGS.find((a) => a >= amps - 1e-9) ?? null;
}
export function prevStandardRating(amps) {
  let best = null;
  for (const a of STANDARD_RATINGS) if (a <= amps + 1e-9) best = a;
  return best;
}

/**
 * Largest overcurrent device allowed for a conductor (Rule 14-104(1) with Table 13):
 * the conductor's ampacity, or the next standard rating when that ampacity isn't
 * a standard rating, up to 800 A (Burr, "Guide to the CE Code 26th ed., Section 14",
 * electricalindustry.ca; earlier editions said 600 A), capped by Rule 14-104(2).
 */
export function maxOCPDForConductor(size, material, conductorAmpacity) {
  let max = STANDARD_RATINGS.includes(conductorAmpacity) ? conductorAmpacity : nextStandardRating(conductorAmpacity);
  if (max > 800) max = prevStandardRating(conductorAmpacity);
  const small = SMALL_CONDUCTOR_OCPD[material]?.[size];
  if (small != null) max = Math.min(max, small);
  return max;
}

/**
 * Rule 8-104: a continuous load may load the overcurrent device and the
 * conductors to 80% of their rating (100% when the device is marked for
 * continuous operation at 100%). For single conductors in free air
 * (Tables 1 and 3) the limits are 70% and 85%. Continuous: more than 1 h in any 2 h at 225 A
 * or less, more than 3 h in any 6 h above. Confirmed: IAEI 2016 "Circuit loading requirements
 * of Section 8"; Burr guide to Section 8 (2024). A dwelling's Rule 8-200 load is not continuous.
 */
export function continuousLimit({ rated100 = false, freeAir = false } = {}) {
  if (freeAir) return rated100 ? 0.85 : 0.7;
  return rated100 ? 1 : 0.8;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

const fmt = (n, d = 1) => String(Math.round(n * 10 ** d) / 10 ** d);
const matLabel = (m) => (m === 'al' ? 'Al' : 'Cu');

/**
 * sizeConductor({ amps, continuous, rated100, material, terminationC, insulationC,
 *   ambientC, ccc, freeAir, maxVdPct, vd(size) -> { percent } })
 *
 * A size passes when:
 *  1. its ampacity in the insulation column, corrected for ambient (Table 5A) and
 *     for more than three conductors (Table 5C), and not above the termination
 *     column (Rule 4-006), is at least the load, or load ÷ 80% for a continuous
 *     load (Rule 8-104(6); ÷ 100% with a 100%-rated device, Rule 8-104(5));
 *  2. the breaker that load needs (next standard rating) may protect it
 *     (Rule 14-104 and Table 13);
 *  3. the voltage drop, when `vd` is given, is within maxVdPct (Rule 8-102).
 */
export function sizeConductor(opts) {
  const {
    amps, continuous = false, rated100 = false, material = 'cu', terminationC = null, insulationC = 90,
    ambientC = 30, ccc = 3, freeAir = false, maxVdPct = 3, vd = null,
  } = opts;
  const load = Number(amps) || 0;
  const limit = continuous ? continuousLimit({ rated100, freeAir }) : 1;
  const required = load / limit;
  const ocpd = nextStandardRating(required);
  const termC = Number(terminationC) || terminationTemp({ amps: ocpd || required });
  const amb = ambientFactor(ambientC, insulationC);
  const adj = freeAir ? 1 : cccFactor(ccc);
  const table = ampacityTable(material, freeAir).name;
  if (amb == null) return { size: null, error: `${insulationC} °C insulation can't be used at ${ambientC} °C ambient (Table 5A).` };
  const factor = amb * adj;
  const tried = [];

  for (const size of SIZES) {
    const term = ampacity(size, material, Math.min(termC, insulationC), freeAir);
    const ins = ampacity(size, material, insulationC, freeAir);
    if (term == null || ins == null) continue;
    const corrected = ins * factor;
    const usable = Math.min(corrected, term);
    const why = [];
    if (usable < required) {
      why.push(corrected < term
        ? `${fmt(corrected)} A after correction (${ins} A × ${fmt(factor, 2)}) < ${fmt(required)} A`
        : `${term} A at the ${Math.min(termC, insulationC)} °C termination column < ${fmt(required)} A`);
    }
    const maxOcpd = maxOCPDForConductor(size, material, usable);
    if (ocpd != null && maxOcpd < ocpd) why.push(`a ${ocpd} A breaker can't protect it (max ${maxOcpd} A, Rule 14-104)`);
    let drop = null;
    if (vd) {
      drop = vd(size);
      if (drop && drop.percent > maxVdPct + 1e-9) why.push(`voltage drop ${fmt(drop.percent, 2)}% > ${maxVdPct}% (Rule 8-102)`);
    }
    tried.push({ size, why });
    if (!why.length) {
      const ampOnly = tried.find((t) => !t.why.some((w) => !w.startsWith('voltage drop')));
      const governedBy = ampOnly && ampOnly.size !== size ? 'voltage drop' : 'ampacity';
      const reasons = [
        continuous
          ? `Continuous load ${fmt(load)} A ÷ ${Math.round(limit * 100)}% = ${fmt(required)} A needed (Rule 8-104${rated100 ? '(5)' : '(6)'}).`
          : `Load ${fmt(load)} A.`,
        `${sizeLabel(size)} ${matLabel(material)}: ${ins} A in the ${insulationC} °C column (${table}).`,
        factor !== 1
          ? `Corrected: ${ins} A × ${fmt(amb, 2)} ambient ${ambientC} °C (Table 5A)${adj !== 1 ? ` × ${fmt(adj, 2)} for ${ccc} conductors (Table 5C)` : ''} = ${fmt(corrected)} A.`
          : 'No ambient or bundling correction (30 °C, three or fewer conductors).',
        `Terminations ${Math.min(termC, insulationC)} °C: ${term} A limit (Rule 4-006). Usable ${fmt(usable)} A.`,
        `Breaker ${ocpd} A (next standard rating); this conductor may be protected at up to ${maxOcpd} A (Rule 14-104, Table 13).`,
      ];
      if (drop) reasons.push(`Voltage drop ${fmt(drop.volts, 2)} V (${fmt(drop.percent, 2)}%) (Rule 8-102).`);
      if (governedBy === 'voltage drop') reasons.push(`Upsized from ${sizeLabel(ampOnly.size)} for voltage drop.`);
      return { size, label: sizeLabel(size), material, ocpd, maxOcpd, terminationC: Math.min(termC, insulationC), terminationAmpacity: term, insulationAmpacity: ins, correctedAmpacity: corrected, usableAmpacity: usable, factor, ambient: amb, adjustment: adj, required, vd: drop, governedBy, table, reasons, rejected: tried.slice(0, -1) };
    }
  }
  return { size: null, error: 'Load is beyond 500 kcmil: use conductors in parallel.', rejected: tried, ocpd, required };
}
