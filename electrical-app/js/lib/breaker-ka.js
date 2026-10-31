// Breaker / panelboard interrupting-rating selector (AIC / kAIC). A conservative selection aid: the
// install conditions score into a recommended minimum interrupting rating. This is a faithful port of
// the field tool (G:\TG Electrical\breaker_ka_value_selector.html) — same options, scoring and
// thresholds, so it gives the same answer. Code basis: an overcurrent device's interrupting rating must
// be at least the available fault current at its terminals (CEC 2024 Rule 14-012; NEC 110.9 / 110.10).
// It is an estimating aid, not a short-circuit study. Pure, offline, code-book-neutral.

/** Standard interrupting ratings the tool recommends (kA). */
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

/** The dropdown choices — values and labels verbatim from the field tool. */
export const KA_OPTIONS = {
  building: [
    { value: 'res', label: 'Residential dwelling' },
    { value: 'farm', label: 'Farm / shop / outbuilding' },
    { value: 'smallcomm', label: 'Small commercial / retail' },
    { value: 'comm', label: 'Commercial / institutional' },
    { value: 'ind', label: 'Industrial' },
  ],
  location: [
    { value: 'branch_far', label: 'Branch circuit, far from panel/service' },
    { value: 'branch', label: 'Branch circuit in panel' },
    { value: 'feeder', label: 'Feeder / subpanel breaker' },
    { value: 'main', label: 'Main breaker or service equipment' },
    { value: 'xfmr', label: 'Directly at transformer secondary' },
  ],
  xfmr: [
    { value: 'small', label: '50 kVA or less' },
    { value: 'med', label: '75–112.5 kVA' },
    { value: 'large', label: '150–300 kVA' },
    { value: 'xl', label: '400–750 kVA' },
    { value: 'xxl', label: 'Over 750 kVA' },
    { value: 'unknown', label: 'Unknown' },
  ],
  distance: [
    { value: 'close', label: 'Less than 25 ft' },
    { value: 'mid', label: '25–100 ft' },
    { value: 'far', label: 'More than 100 ft' },
    { value: 'unknown', label: 'Unknown' },
  ],
  conductor: [
    { value: 'small', label: '#6 AWG or smaller' },
    { value: 'med', label: '#4 AWG to 4/0 AWG' },
    { value: 'large', label: '250 kcmil to 500 kcmil' },
    { value: 'par', label: 'Parallel conductors / large feeder' },
    { value: 'unknown', label: 'Unknown' },
  ],
  source: [
    { value: 'weak', label: 'Weak / long rural primary' },
    { value: 'normal', label: 'Typical utility source' },
    { value: 'strong', label: 'Strong source / large nearby utility transformer' },
    { value: 'unknown', label: 'Unknown' },
  ],
  motor: [
    { value: 'no', label: 'No / minimal' },
    { value: 'some', label: 'Some large motors or a generator' },
    { value: 'yes', label: 'Multiple large motors / generator close to panel' },
    { value: 'unknown', label: 'Unknown' },
  ],
};

// Score contributions — verbatim from the field tool.
const TYPE = { res: 0, farm: 1, smallcomm: 2, comm: 3, ind: 4 };
const LOC = { branch_far: -2, branch: -1, feeder: 1, main: 2, xfmr: 4 };
const XFMR = { small: -1, med: 1, large: 2, xl: 3, xxl: 4, unknown: 1 };
const DIST = { close: 2, mid: 0, far: -2, unknown: 1 };
const COND = { small: -1, med: 0, large: 1, par: 2, unknown: 1 };
const UTIL = { weak: -2, normal: 0, strong: 2, unknown: 1 };
const MOTOR = { no: 0, some: 1, yes: 3, unknown: 1 };

const g = (table, v, fallback = 0) => (table[v] != null ? table[v] : fallback);

/**
 * recommendBreakerKa(inputs) -> { score, rating, ratingKa, level, reasons, engineeringReview }
 * inputs: { building, location, xfmr, distance, conductor, source, motor } (the option values above).
 * `score` sums the condition weights; `rating` is the label (e.g. '22 kA'), `ratingKa` its number,
 * `level` the severity ('g' low / 'y' moderate / 'r' high), `reasons` the plain-language drivers. Pure.
 */
export function recommendBreakerKa(inputs = {}) {
  const score = g(TYPE, inputs.building) + g(LOC, inputs.location) + g(XFMR, inputs.xfmr, 1)
    + g(DIST, inputs.distance, 1) + g(COND, inputs.conductor, 1) + g(UTIL, inputs.source, 1) + g(MOTOR, inputs.motor, 1);

  let rating, ratingKa, level;
  if (score <= 1) { rating = '10 kA'; ratingKa = 10; level = 'g'; }
  else if (score <= 3) { rating = '22 kA'; ratingKa = 22; level = 'y'; }
  else if (score <= 5) { rating = '25 kA'; ratingKa = 25; level = 'y'; }
  else if (score <= 7) { rating = '35 kA'; ratingKa = 35; level = 'r'; }
  else if (score <= 9) { rating = '50 kA'; ratingKa = 50; level = 'r'; }
  else { rating = '65 kA or engineering review'; ratingKa = 65; level = 'r'; }

  const reasons = [];
  if (inputs.location === 'xfmr' || inputs.location === 'main') reasons.push('Breaker is at a high-fault-current location.');
  if (inputs.xfmr === 'xl' || inputs.xfmr === 'xxl') reasons.push('Large transformer can supply high short-circuit current.');
  if (inputs.distance === 'close') reasons.push('Short conductor run provides little impedance to reduce fault current.');
  if (inputs.conductor === 'par') reasons.push('Parallel / large conductors reduce impedance and increase available fault current.');
  if (inputs.source === 'strong') reasons.push('Strong utility source increases available fault current.');
  if (inputs.motor === 'yes') reasons.push('Large motors or a nearby generator can add fault-current contribution.');
  if (inputs.xfmr === 'unknown' || inputs.distance === 'unknown' || inputs.source === 'unknown') reasons.push('One or more key values are unknown, so a higher conservative rating is appropriate.');
  if (!reasons.length) reasons.push('Selected conditions indicate a lower available fault-current location.');

  return { score, rating, ratingKa, level, reasons, engineeringReview: score > 9 };
}
