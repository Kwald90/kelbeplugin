// Overcurrent interrupting / SCCR quick-check. Pure, offline, code-book-neutral.
//
// A DOCUMENTED QUICK-CHECK, not a short-circuit coordination study. It compares the available fault
// current at a point to a device's interrupting rating (breakers/fuses: AIC/kAIC) or an assembly's
// short-circuit current rating (SCCR, UL 508A / CSA), and flags pass/fail with margin. It does not
// model let-through current, series ratings beyond a yes/no reminder, or selective coordination
// curves — those need the manufacturer's data and a full study.
//
// Code basis: an overcurrent device's interrupting rating must be at least the available fault
// current at its line terminals, and equipment must withstand the available fault current.
//   CEC 2024 Rule 14-012 (interrupting and withstand ratings).
//   NEC 2023 110.9 (interrupting rating) and 110.10 (withstand / component protection).
//   SCCR of assembled equipment: UL 508A Supplement SB / product standards.
// Standard interrupting ratings reused from lib/breaker-ka.js so the two tools agree.

import { KA_STANDARD } from './breaker-ka.js';

export { KA_STANDARD };

// Default safety margin: the device rating should exceed available fault current. 0% = rating may
// equal the available fault current (code minimum). A positive margin is good practice for growth
// and utility changes. VERIFY: no code mandates a margin; this is a design-practice default.
export const DEFAULT_MARGIN_PCT = 0;

export const DEVICE_KINDS = [
  { value: 'breaker', label: 'Circuit breaker (interrupting rating, kAIC)' },
  { value: 'fuse', label: 'Fuse (interrupting rating, kAIC)' },
  { value: 'panel', label: 'Panelboard / switchboard (short-circuit rating)' },
  { value: 'sccr', label: 'Assembled equipment (SCCR, UL 508A)' },
];

/**
 * quickCheck({ availableKa, ratingKa, marginPct, deviceKind, seriesRated })
 *   availableKa  available (bolted) fault current at the device terminals, kA (from the kA calc).
 *   ratingKa     the device's marked interrupting rating or the assembly SCCR, kA.
 *   marginPct    required headroom of rating over available (default 0 = code minimum).
 *   seriesRated  true if a tested series-rated combination is being relied on.
 * Returns { pass, availableKa, ratingKa, requiredKa, marginKa, marginActualPct, nextStandard, notes }.
 */
export function quickCheck({ availableKa, ratingKa, marginPct = DEFAULT_MARGIN_PCT, deviceKind = 'breaker', seriesRated = false } = {}) {
  const avail = Number(availableKa);
  const rating = Number(ratingKa);
  const margin = Number(marginPct) || 0;
  if (!(avail >= 0)) throw new Error('Enter the available fault current (kA).');
  if (!(rating > 0)) throw new Error('Enter the device interrupting / withstand rating (kA).');
  const requiredKa = avail * (1 + margin / 100);
  const pass = rating >= requiredKa - 1e-9;
  const marginKa = rating - avail;
  const marginActualPct = avail > 0 ? (marginKa / avail) * 100 : Infinity;
  const nextStandard = KA_STANDARD.find((k) => k >= requiredKa - 1e-9) ?? null;

  const notes = [];
  if (!pass) {
    notes.push(`FAIL: the ${deviceLabel(deviceKind)} rating (${rating} kA) is below the available fault current${margin ? ` plus the ${margin}% margin` : ''} (${round(requiredKa)} kA).`);
    if (seriesRated) notes.push('A series-rated combination can be used ONLY if it is a tested, listed combination of these exact upstream and downstream devices (CEC 14-012 / NEC 110.22(C)); confirm the manufacturer\'s series-rating table and mark the panel.');
    else notes.push(`Specify a device rated at least ${nextStandard ? nextStandard + ' kA' : round(requiredKa) + ' kA'}, or use a tested series-rated combination.`);
  } else {
    notes.push(`PASS: ${rating} kA rating ≥ ${round(requiredKa)} kA required (${round(marginActualPct, 0)}% headroom over the available ${round(avail)} kA).`);
  }
  return { pass, availableKa: avail, ratingKa: rating, requiredKa, marginKa, marginActualPct, nextStandard, deviceKind, notes };
}

/**
 * Short breaker-vs-fuse selectivity note. NOT a coordination study — a documented reminder of the
 * two behaviours. Returns an array of plain-language lines. VERIFY: general industry guidance
 * (current-limiting fuse let-through, breaker instantaneous overlap); confirm with device TCC curves.
 */
export function selectivityNote({ availableKa } = {}) {
  const lines = [
    'Current-limiting fuses (CSA/UL Class J, T, RK1, L) cut off the fault in under a quarter-cycle above their threshold, lowering the let-through energy; this can protect downstream equipment (component short-circuit protection, NEC 110.10) but two fuses in series are only selective when their amp ratios meet the maker\'s ratio table (often ~2:1).',
    'Moulded-case breakers in series are generally NOT selective on a high fault: the instantaneous trip of both the upstream and downstream breaker overlaps, so both can open. Selectivity needs the manufacturer\'s tested selectivity (coordination) tables or zone-selective interlocking.',
    'For both: selective coordination and series ratings are only valid from tested, published combinations of the actual devices. Confirm against the manufacturer\'s TCC curves / series and selectivity tables before relying on them.',
  ];
  if (availableKa != null && Number(availableKa) > 10) lines.unshift(`At ${round(Number(availableKa))} kA available, current-limiting fuses or a tested series rating are worth checking to protect downstream gear.`);
  return lines;
}

function deviceLabel(kind) { return (DEVICE_KINDS.find((d) => d.value === kind) || DEVICE_KINDS[0]).label.replace(/ \(.*\)$/, '').toLowerCase(); }
function round(n, d = 1) { return Math.round(Number(n) * 10 ** d) / 10 ** d; }
