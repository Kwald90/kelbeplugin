// Breaker / panelboard interrupting-rating selector (AIC / kAIC). A conservative selection aid: from
// categorical install conditions it estimates the available fault current at a point and rounds up to
// the next standard interrupting rating. The infinite-bus upper bound set by transformer size is
// reduced by conductor and distance impedance and by a weaker utility source; motor / generator
// contribution is added back. Code basis: an overcurrent device's interrupting rating must be at least
// the available fault current at its terminals (CEC 2024 Rule 14-012; NEC 110.9 / 110.10). This is an
// estimating aid, not a short-circuit study — verify with the utility's available fault current and a
// calculation for permit-final or critical work. Pure, offline, code-book-neutral.

/** Standard interrupting ratings the tool rounds up to (kA). */
export const KA_STANDARD = [10, 22, 25, 35, 50, 65];

/** The "standard ratings used" reference shown under the result. */
export const KA_REFERENCE = [
  { rating: '10 kA', use: 'Small residential / farm branch circuits, long conductor runs, small transformers' },
  { rating: '22 kA', use: 'Typical residential services, small commercial panels, unknown but likely moderate fault levels' },
  { rating: '25 kA', use: 'Commercial subpanels, larger services, panels close to 150–300 kVA transformers' },
  { rating: '35 kA', use: 'Commercial / industrial distribution, large feeders, close to larger transformers' },
  { rating: '50 kA', use: 'Industrial service equipment, large transformers, high available fault current' },
  { rating: '65 kA / engineering review', use: 'Very large transformers, close-coupled switchgear, major motor / generator contribution' },
];

/** The dropdown choices, each value keyed into the factor tables below. */
export const KA_OPTIONS = {
  building: [
    { value: 'res', label: 'Residential dwelling' },
    { value: 'small-comm', label: 'Small commercial / farm' },
    { value: 'comm', label: 'Commercial' },
    { value: 'ind', label: 'Industrial' },
  ],
  location: [
    { value: 'service', label: 'Main / service entrance' },
    { value: 'subpanel', label: 'Subpanel (downstream)' },
    { value: 'branch-near', label: 'Branch circuit, near the panel/service' },
    { value: 'branch-far', label: 'Branch circuit, far from panel/service' },
  ],
  xfmr: [
    { value: '50', label: '50 kVA or less' },
    { value: '150', label: '75–150 kVA' },
    { value: '300', label: '150–300 kVA' },
    { value: '500', label: '300–500 kVA' },
    { value: '1000', label: '500–1000 kVA' },
    { value: '1500', label: 'Over 1000 kVA' },
    { value: 'unknown', label: 'Unknown' },
  ],
  distance: [
    { value: '25', label: 'Less than 25 ft' },
    { value: '50', label: '25–50 ft' },
    { value: '100', label: '50–100 ft' },
    { value: '200', label: 'More than 100 ft' },
  ],
  conductor: [
    { value: '6', label: '#6 AWG or smaller' },
    { value: '1/0', label: '#4 – 1/0 AWG' },
    { value: '4/0', label: '2/0 – 4/0 AWG' },
    { value: '250', label: '250 kcmil or larger' },
    { value: 'parallel', label: 'Parallel sets' },
  ],
  source: [
    { value: 'weak', label: 'Weak / long rural primary' },
    { value: 'typical', label: 'Typical urban / suburban' },
    { value: 'strong', label: 'Strong / network / downtown' },
    { value: 'unknown', label: 'Unknown' },
  ],
  motor: [
    { value: 'no', label: 'No / minimal' },
    { value: 'some', label: 'Some motors' },
    { value: 'big', label: 'Significant motors or generators' },
  ],
};

// Base available fault current (kA) from transformer size — an infinite-bus style upper bound at the
// secondary. Unknown defaults to a conservative "typical moderate" value.
const BASE = { 50: 12, 150: 18, 300: 25, 500: 35, 1000: 50, 1500: 65, unknown: 22 };
// Utility source strength: a weak/long rural primary has real source impedance; a network/downtown
// source is nearly an infinite bus.
const SRC = { weak: 0.55, typical: 1, strong: 1.4, unknown: 1 };
// Conductor length and size add series impedance, lowering the fault current reaching the panel.
const DIST = { 25: 1, 50: 0.85, 100: 0.7, 200: 0.55 };
const COND = { 6: 0.6, '1/0': 0.8, '4/0': 0.92, 250: 1, parallel: 1.1 };
// How far downstream the device sits: the service entrance sees the most, a far branch the least.
const LOC = { service: 1, subpanel: 0.8, 'branch-near': 0.75, 'branch-far': 0.5 };
// Motor / generator fault contribution, added in kA.
const MOTOR = { no: 0, some: 3, big: 8 };
// A conservative floor on the recommendation by occupancy — you don't spec a 10 kA device for
// commercial/industrial service equipment even where the estimate comes out low. Each is a standard rating.
const FLOOR = { res: 10, 'small-comm': 10, comm: 22, ind: 22 };

const key = (table, v, fallback) => (table[v] != null ? table[v] : table[fallback]);

/**
 * recommendBreakerKa(inputs) -> { estimateKa, rating, engineeringReview, base, factors }
 * inputs: { building, location, xfmr, distance, conductor, source, motor } (the option values above).
 * `estimateKa` is the estimated available fault current; `rating` is the smallest standard interrupting
 * rating at or above it (never below the occupancy floor); `engineeringReview` is true when the estimate
 * exceeds the top standard. Pure.
 */
export function recommendBreakerKa(inputs = {}) {
  const base = key(BASE, inputs.xfmr, 'unknown');
  const factors = key(SRC, inputs.source, 'unknown') * key(DIST, inputs.distance, 25) * key(COND, inputs.conductor, 250)
    * key(LOC, inputs.location, 'service');
  const estimateKa = base * factors + key(MOTOR, inputs.motor, 'no');
  const top = KA_STANDARD[KA_STANDARD.length - 1];
  const engineeringReview = estimateKa > top;
  const floor = key(FLOOR, inputs.building, 'res');
  const rounded = KA_STANDARD.find((k) => estimateKa <= k) ?? top;
  const rating = engineeringReview ? top : Math.max(rounded, floor);
  return { estimateKa, rating, engineeringReview, base, factors };
}
