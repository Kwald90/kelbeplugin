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

/** Phase of a breaker slot: slots 1&2 are row 1, 3&4 row 2... phases repeat by row. */
export function slotPhase(slot, system) {
  const sys = systemOf(system);
  const row = Math.ceil(Number(slot) / 2);
  return sys.phases[(row - 1) % sys.phases.length];
}

/** Phases a circuit occupies: slot, slot+2, ... for each pole. Returns e.g. 'A-B'. */
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
 * load (NEMA definition).
 */
export function phaseBalance(circuits, system) {
  const sys = systemOf(system);
  const perPhase = Object.fromEntries(sys.phases.map((p) => [p, 0]));
  let totalVA = 0;
  for (const c of circuits) {
    const va = Number(c.loadVA) || 0;
    if (!va) continue;
    const phases = (c.phase || circuitPhases(c.slot, c.poles, system)).split('-').filter((p) => p in perPhase);
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
