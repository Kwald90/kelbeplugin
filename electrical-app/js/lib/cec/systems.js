// Supply systems and panel phase maths. Code-neutral: the NEC book re-exports
// these. Keys are what panel records store in `voltage`, so existing keys stay.
//
// Canadian nominal voltages (CSA C235 preferred voltages; the standard itself is
// paywalled, VERIFY): utilities supply 120/240 V single-phase 3-wire, 120/208Y V and
// 347/600Y V three-phase 4-wire; 600 V three-phase 3-wire (delta) and 277/480Y come
// from a customer transformer (BC Hydro "Electrical service voltages"). CEC Rule 8-100
// lists 120, 208, 240, 277, 347, 416, 480 and 600 V as the voltages for calculating
// current (BCcampus Section 8 text; Burr guide, 2024). 277/480Y is the usual US system.

const R3 = Math.sqrt(3);

export const PANEL_SYSTEMS = {
  '120/240 1ph': { label: '120/240 V 1φ 3-wire', phases: ['A', 'B'], lnVolts: 120, llVolts: 240, three: false, neutral: true, region: 'CA US' },
  '208/120 3ph': { label: '120/208 V 3φ 4-wire', phases: ['A', 'B', 'C'], lnVolts: 120, llVolts: 208, three: true, neutral: true, region: 'CA US' },
  '347/600 3ph': { label: '347/600 V 3φ 4-wire', phases: ['A', 'B', 'C'], lnVolts: 347, llVolts: 600, three: true, neutral: true, region: 'CA' },
  '600 3ph 3w': { label: '600 V 3φ 3-wire (no neutral)', phases: ['A', 'B', 'C'], lnVolts: null, llVolts: 600, three: true, neutral: false, region: 'CA' },
  '480/277 3ph': { label: '277/480 V 3φ 4-wire', phases: ['A', 'B', 'C'], lnVolts: 277, llVolts: 480, three: true, neutral: true, region: 'US' },
};

const DEFAULT = '120/240 1ph';
export const systemOf = (key) => PANEL_SYSTEMS[key] || PANEL_SYSTEMS[DEFAULT];

/** Systems to offer for a code book: Canadian ones for CEC, US ones for NEC (the stored one is always kept). */
export function systemsFor(book, current) {
  const region = book === 'NEC-2023' ? 'US' : 'CA';
  return Object.entries(PANEL_SYSTEMS).filter(([k, s]) => s.region.includes(region) || k === current).map(([k, s]) => ({ value: k, label: s.label }));
}

/**
 * Voltage used to turn one phase's VA into amps. Systems with a neutral use
 * line-to-neutral; a 3-wire delta has none, so the equivalent phase voltage
 * V_LL / √3 is used. That is exact for balanced three-phase loads; for a
 * two-pole load it reads about 13% low (the same simplification the 4-wire
 * systems make), which is fine for balancing but not for sizing a conductor.
 */
export function phaseVolts(system) {
  const sys = systemOf(system);
  return sys.lnVolts || sys.llVolts / R3;
}

/** Phase of a breaker slot: slots 1&2 are row 1, 3&4 row 2... phases repeat by row.
 * Both halves of a space (a tandem 1A/1B) share the space's phase, so a half circuit
 * takes the phase of its slot exactly as a full 1-pole breaker there would. */
export function slotPhase(slot, system) {
  const sys = systemOf(system);
  const row = Math.ceil(Number(slot) / 2);
  return sys.phases[(row - 1) % sys.phases.length];
}

/** Phases a circuit occupies: slot, slot+2, ... for each pole. Returns e.g. 'A-B'.
 * A half-space (tandem) circuit is always a single pole, so it returns its space's phase. */
export function circuitPhases(slot, poles, system) {
  const out = [];
  for (let k = 0; k < (Number(poles) || 1); k++) out.push(slotPhase(Number(slot) + 2 * k, system));
  return out.join('-');
}

/** Current a circuit draws: 1-pole on L-N, 2-pole on L-L, 3-pole as three-phase. */
export function circuitAmps(c, system) {
  const sys = systemOf(system);
  const va = Number(c.loadVA) || 0;
  const poles = Number(c.poles) || 1;
  if (poles === 1) return va / phaseVolts(system);
  if (poles === 2) return va / sys.llVolts;
  return va / (R3 * sys.llVolts);
}

/** Smallest number of poles a circuit may have: 2 on a system with no neutral. */
export const minPoles = (system) => (systemOf(system).neutral ? 1 : 2);

/**
 * phaseBalance(circuits, system) -> { perPhase: { A: va, ... }, amps: { A: a, ... }, totalVA, imbalancePct, maxAmps }
 * A multi-pole load is split equally across the phases it occupies; per-phase
 * current uses phaseVolts(). Imbalance is max deviation from the average phase
 * load (NEMA definition). A half-space (tandem) circuit is a single pole on its
 * space's phase, so both halves of a space count on that one phase.
 */
export function phaseBalance(circuits, system) {
  const sys = systemOf(system);
  const perPhase = Object.fromEntries(sys.phases.map((p) => [p, 0]));
  let totalVA = 0;
  for (const c of circuits) {
    const va = Number(c.loadVA) || 0;
    if (!va) continue;
    const poles = c.half === 'A' || c.half === 'B' ? 1 : c.poles; // a tandem is one pole on its space's phase
    const phases = (c.phase || circuitPhases(c.slot, poles, system)).split('-').filter((p) => p in perPhase);
    if (!phases.length) continue;
    for (const p of phases) perPhase[p] += va / phases.length;
    totalVA += va;
  }
  const vals = Object.values(perPhase);
  const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
  const imbalancePct = avg > 0 ? (Math.max(...vals.map((v) => Math.abs(v - avg))) / avg) * 100 : 0;
  const pv = phaseVolts(system);
  const amps = Object.fromEntries(Object.entries(perPhase).map(([p, va]) => [p, va / pv]));
  return { perPhase, amps, totalVA, imbalancePct, maxAmps: Math.max(...Object.values(amps)) };
}

/** Line current of a whole panel's connected load: VA / V (1φ) or VA / (√3 · V) (3φ). */
export function totalAmps(totalVA, system) {
  const sys = systemOf(system);
  return sys.three ? totalVA / (R3 * sys.llVolts) : totalVA / sys.llVolts;
}

// ---------------------------------------------------------------------------
// Conductor / phase colour codes (research 2026-10-23; see docs note below).
//
// Only two colours are code-MANDATED: the identified (neutral) conductor is white or
// natural grey, and the bonding/grounding conductor is green (or green with a yellow
// stripe). Phase (ungrounded) colours are CONVENTION in Canada — the CEC prescribes
// red(A)/black(B)/blue(C) only where colour-coded circuits are required (Rule 4-036);
// otherwise the phase colours shown are industry convention (e.g. brown/orange/yellow
// for 347/600 V). US/NEC is the same except the orange high-leg marking, which is
// mandated (110.15). Rule numbers are secondary-sourced — VERIFY against CSA C22.1:24.
// ---------------------------------------------------------------------------

const BLACK = '#1a1a1a', RED = '#d32f2f', BLUE = '#1565c0';
const BROWN = '#6d4c41', ORANGE = '#ef6c00', YELLOW = '#fbc02d';
const WHITE = '#e8e8e8', GREEN = '#2e7d32';

/** Built-in default colours per code book. `systems[key]` is a map of phase -> { name, hex }. */
export const WIRE_COLOURS = {
  'CEC-2024': {
    neutral: { name: 'White / natural grey', hex: WHITE, mandated: true, ref: 'Rule 4-024 / 4-026' },
    bond: { name: 'Green (or green/yellow)', hex: GREEN, mandated: true, ref: 'Rule 4-032' },
    systems: {
      '120/240 1ph': { A: { name: 'Black', hex: BLACK }, B: { name: 'Red', hex: RED } },
      '208/120 3ph': { A: { name: 'Red', hex: RED }, B: { name: 'Black', hex: BLACK }, C: { name: 'Blue', hex: BLUE } },
      '347/600 3ph': { A: { name: 'Red', hex: RED }, B: { name: 'Black', hex: BLACK }, C: { name: 'Blue', hex: BLUE } },
      '600 3ph 3w': { A: { name: 'Red', hex: RED }, B: { name: 'Black', hex: BLACK }, C: { name: 'Blue', hex: BLUE } },
      '480/277 3ph': { A: { name: 'Brown', hex: BROWN }, B: { name: 'Orange', hex: ORANGE }, C: { name: 'Yellow', hex: YELLOW } },
    },
  },
  'NEC-2023': {
    neutral: { name: 'White / grey', hex: WHITE, mandated: true, ref: 'NEC 200.6' },
    bond: { name: 'Green / green-yellow / bare', hex: GREEN, mandated: true, ref: 'NEC 250.119' },
    systems: {
      '120/240 1ph': { A: { name: 'Black', hex: BLACK }, B: { name: 'Red', hex: RED } },
      '208/120 3ph': { A: { name: 'Black', hex: BLACK }, B: { name: 'Red', hex: RED }, C: { name: 'Blue', hex: BLUE } },
      '347/600 3ph': { A: { name: 'Brown', hex: BROWN }, B: { name: 'Orange', hex: ORANGE }, C: { name: 'Yellow', hex: YELLOW } },
      '600 3ph 3w': { A: { name: 'Brown', hex: BROWN }, B: { name: 'Orange', hex: ORANGE }, C: { name: 'Yellow', hex: YELLOW } },
      '480/277 3ph': { A: { name: 'Brown', hex: BROWN }, B: { name: 'Orange', hex: ORANGE }, C: { name: 'Yellow', hex: YELLOW } },
    },
  },
};

/** Named phase-colour presets the colour editor can apply to A/B/C in one tap. */
export const COLOUR_PRESETS = {
  rbb: { label: 'Red / Black / Blue (CEC Rule 4-036)', A: RED, B: BLACK, C: BLUE },
  boy: { label: 'Brown / Orange / Yellow (347/600 V trade practice)', A: BROWN, B: ORANGE, C: YELLOW },
  brb: { label: 'Black / Red / Blue (NEC convention)', A: BLACK, B: RED, C: BLUE },
};

/** The identification-vs-convention disclaimer shown with the colour legend. */
export const COLOUR_LEGEND_NOTE =
  'Under the Canadian Electrical Code (CSA C22.1), only two conductor colours are mandated: the '
  + 'identified (neutral) conductor is white or natural grey, and the bonding/grounding conductor '
  + 'is green or green-with-yellow-stripe. Phase (ungrounded) colours are not generally mandated — '
  + 'red (A) / black (B) / blue (C) are prescribed only where colour-coded circuits are required '
  + '(Rule 4-036); otherwise the phase colours shown are industry convention (brown/orange/yellow is '
  + 'common for 347/600 V). NEC colours are convention except the orange high-leg marking, which NEC '
  + 'mandates (110.15); Canadian high-leg practice differs (red / phase-A plus barriering) — confirm '
  + 'with your authority having jurisdiction and the governing code edition. Rule numbers are for '
  + 'reference, not legal citation.';

const colourBook = (book) => (WIRE_COLOURS[book] ? book : 'CEC-2024');

/** The mandated neutral and bond colours for a code book. */
export function mandatedColours(book) {
  const set = WIRE_COLOURS[colourBook(book)];
  return { neutral: { ...set.neutral }, bond: { ...set.bond } };
}

/**
 * systemColours(book, systemKey, overrides) -> { phases: { A: {name,hex,mandated,convention}, ... },
 *   neutral, bond, book }. `overrides` is settings.panelColours: { [book]: { [systemKey]: {A,B,C},
 *   neutral, bond } }, each value a hex string. Phase colours are convention; neutral and bond mandated.
 */
export function systemColours(book, systemKey, overrides) {
  const bk = colourBook(book);
  const set = WIRE_COLOURS[bk];
  const sys = systemOf(systemKey);
  const base = set.systems[systemKey] || set.systems[DEFAULT] || {};
  const ov = (overrides && overrides[bk]) || {};
  const sysOv = ov[systemKey] || {};
  const phases = {};
  for (const p of sys.phases) {
    const def = base[p] || { name: '—', hex: '#999999' };
    const hex = sysOv[p];
    phases[p] = hex ? { name: 'Custom', hex, mandated: false, convention: true } : { ...def, mandated: false, convention: true };
  }
  const neutral = ov.neutral ? { ...set.neutral, name: 'Custom', hex: ov.neutral } : { ...set.neutral };
  const bond = ov.bond ? { ...set.bond, name: 'Custom', hex: ov.bond } : { ...set.bond };
  return { phases, neutral, bond, book: bk };
}

/** One phase's colour for a book + system, honouring overrides. */
export function phaseColour(book, systemKey, phase, overrides) {
  return systemColours(book, systemKey, overrides).phases[phase] || null;
}
