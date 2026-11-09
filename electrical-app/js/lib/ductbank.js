// Underground duct-bank ampacity derating (screening). Pure, offline. SI.
//
// VERIFY GENEROUSLY. This is a CONSERVATIVE SCREENING estimate, NOT a Neher-McGrath calculation and
// NOT a substitute for the CEC underground ampacity tables. A real duct-bank design uses:
//   CEC 2024 Tables D8A–D17 (underground cables and ducts, various configurations), Rule 4-004, and
//   Appendix D; or an IEEE 835 / Neher-McGrath heat-flow study with the actual soil thermal
//   resistivity (RHO), burial depth, duct spacing, load factor and group geometry.
// The model here starts from the CEC free-air/raceway ampacity (lib/cec Table 2/4) and applies three
// simple correction factors — earth ambient, a mutual-heating group factor, and a load-factor
// allowance — each tagged VERIFY. The group factors are a smooth conservative curve, NOT a CEC table.
// Use only to sanity-check a feeder size; confirm the final size against CEC Tables D8A–D17.

import { ampacity, sizeLabel } from './cec/index.js';

export const MATERIALS = [{ value: 'cu', label: 'Copper' }, { value: 'al', label: 'Aluminum' }];

// Reference earth (ambient) temperature the base ampacity is taken at. CEC underground tables are
// typically based on 20 °C earth ambient. VERIFY against the specific CEC Table used.
export const BASE_EARTH_C = 20;

// Earth ambient correction: sqrt((Tc − Ta)/(Tc − 20)), Tc the conductor rating. Same square-root form
// as the CEC/NEC air-ambient factor but referenced to 20 °C earth instead of 30 °C air. VERIFY.
export function earthAmbientFactor(ambientC, conductorC = 90) {
  const Ta = Number(ambientC), Tc = Number(conductorC);
  if (!(Tc > Ta)) return 0;
  return Math.sqrt((Tc - Ta) / (Tc - BASE_EARTH_C));
}

// Mutual-heating group factor by the number of loaded ducts in the bank. A conservative smooth curve
// (1 duct = 1.00, falling toward ~0.5 for large banks). This is NOT a CEC table — the real derating
// depends on geometry, spacing and load factor (CEC Tables D8A–D17). VERIFY / replace with the table.
export const GROUP_FACTOR = { 1: 1.0, 2: 0.88, 3: 0.80, 4: 0.75, 6: 0.68, 9: 0.60, 12: 0.55, 16: 0.50 };
export function groupFactor(loadedDucts) {
  const n = Math.max(1, Math.round(Number(loadedDucts) || 1));
  const keys = Object.keys(GROUP_FACTOR).map(Number).sort((a, b) => a - b);
  let f = GROUP_FACTOR[keys[0]];
  for (const k of keys) { if (n >= k) f = GROUP_FACTOR[k]; }
  return f;
}

// Load-factor allowance: continuous (100 %) load gets no credit; a lower daily load factor lets the
// earth cool between peaks and raises ampacity. Conservative linear credit up to +15 % at 50 % LF.
// VERIFY — real load-factor credit comes from the Neher-McGrath loss factor, not a straight line.
export function loadFactorAllowance(loadFactorPct) {
  const lf = Math.min(100, Math.max(50, Number(loadFactorPct) || 100));
  return 1 + (100 - lf) / 100 * 0.3; // 100%->1.00, 50%->1.15
}

/**
 * Derated ampacity for a conductor in an underground duct bank (screening).
 * inputs: { size, material, conductorC, earthAmbientC, loadedDucts, loadFactorPct }
 * Returns the base ampacity, each factor, the derated ampacity and the inputs. Tagged VERIFY.
 */
export function ductBankAmpacity(inputs = {}) {
  const size = inputs.size;
  const material = inputs.material === 'al' ? 'al' : 'cu';
  const conductorC = Number(inputs.conductorC) || 90;
  const base = ampacity(size, material, conductorC, false); // CEC Table 2/4 raceway ampacity
  if (base == null) throw new Error('That conductor size is not in the CEC ampacity table.');
  const fAmbient = earthAmbientFactor(inputs.earthAmbientC == null ? BASE_EARTH_C : inputs.earthAmbientC, conductorC);
  const fGroup = groupFactor(inputs.loadedDucts);
  const fLoad = loadFactorAllowance(inputs.loadFactorPct);
  const derated = base * fAmbient * fGroup * fLoad;
  return {
    size, sizeLabel: sizeLabel(size), material, conductorC,
    baseAmpacity: base, factors: { ambient: fAmbient, group: fGroup, loadFactor: fLoad },
    deratedAmpacity: derated,
    loadedDucts: Math.max(1, Math.round(Number(inputs.loadedDucts) || 1)),
    earthAmbientC: inputs.earthAmbientC == null ? BASE_EARTH_C : Number(inputs.earthAmbientC),
    loadFactorPct: Math.min(100, Math.max(50, Number(inputs.loadFactorPct) || 100)),
  };
}
