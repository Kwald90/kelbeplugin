// Bender profiles: published take-up, radius and mark names for common benders, the code minimum
// bend radius, and the "calibrate my bender" maths. Pure data and functions, SI units.
//
// Every default is a typical published figure. Benders vary by model and wear: check each one
// against the marks and chart on your own bender, or calibrate it (bend a test 90 and measure).
import { inToM } from './units.js';
import { conduitOD, gain90, BendError } from './bending.js';

const need = (ok, message) => { if (!ok) throw new BendError(message); };
const isPos = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// ---------------------------------------------------------------------------
// Minimum bend radius
// ---------------------------------------------------------------------------

// CEC Rule 12-924 points to Table 7, "Radius of conduit bends": minimum radius to the centre of the
// conduit, mm. Values from the CSA Part I committee proposal (Subject 2914, 2003); they equal the NEC
// Chapter 9 Table 2 one-shot/full-shoe column in mm. VERIFY against the CSA C22.1:24 table.
export const CEC_TABLE_7_MM = { 16: 102, 21: 114, 27: 146, 35: 184, 41: 210, 53: 241, 63: 267, 78: 330, 91: 381, 103: 406 };

// Rigid PVC field bends (heat bent). IPEX (Canadian catalogue) gives a radius of six times the inside
// diameter; NEC Chapter 9 Table 2 "other bends" is about six times the trade size. CEC Rule 12-1108
// covers field bends in rigid PVC. We default to the larger "other bends" figure. VERIFY.
export const PVC_FIELD_RADIUS_IN = { 16: 4, 21: 5, 27: 6, 35: 8, 41: 10, 53: 12, 63: 15, 78: 18, 91: 21, 103: 24 };

/** Code minimum radius (centreline) in metres for a trade size, or null. */
export function minBendRadius(type, size) {
  if (type === 'PVC') return PVC_FIELD_RADIUS_IN[size] ? inToM(PVC_FIELD_RADIUS_IN[size]) : null;
  return CEC_TABLE_7_MM[size] ? CEC_TABLE_7_MM[size] / 1000 : null;
}

// ---------------------------------------------------------------------------
// Default benders
// ---------------------------------------------------------------------------

// Hand benders. Take-up (deduct) for a 90: Klein Conduit Bender Guide and the Greenlee Site-Rite
// guide (2023), the same for all three brands; rigid and IMC share the next EMT shoe up (Klein,
// Greenlee; IDEAL inferred from its order table). Centreline radius: Greenlee Site-Rite guide and
// 2019 catalogue. Klein and IDEAL do not publish a radius; we use Greenlee's. VERIFY.
// [take-up in, radius in]
const HAND = {
  EMT: { 16: [5, 4 + 3 / 16], 21: [6, 5 + 1 / 8], 27: [8, 6.5], 35: [11, 9 + 5 / 8] },
  RMC: { 16: [6, 5 + 1 / 8], 21: [8, 6.5], 27: [11, 9 + 5 / 8] },
};
HAND.IMC = HAND.RMC;
HAND.AL = HAND.RMC; // rigid aluminum on rigid shoes: same pipe sizes as RMC. VERIFY with the maker.

const HAND_BRANDS = [
  { key: 'klein', brand: 'Klein', model: 'hand bender', backToBackMark: 'star point', centreMark: 'rim notch', names: { arrow: 'arrow', star: 'star point', centre: 'rim notch' }, source: 'Klein Conduit Bender Guide (take-up, marks); radius from Greenlee' },
  { key: 'greenlee', brand: 'Greenlee', model: 'Site-Rite hand bender', backToBackMark: 'star mark', centreMark: '3-bend saddle notch', names: { arrow: 'arrow', star: 'star mark', centre: '3-bend saddle notch' }, source: 'Greenlee Site-Rite hand bender guide (2023), Greenlee 2019 catalogue' },
  { key: 'ideal', brand: 'Ideal', model: 'hand bender', backToBackMark: 'star-point', centreMark: 'rim notch', names: { arrow: 'arrow', star: 'star-point', centre: 'rim notch' }, source: 'IDEAL bender guide ND 1534-4 (marks); take-up per Klein/Greenlee; radius from Greenlee' },
];

// Mechanical and electric benders, Greenlee: 1818 deducts from IM 1101 ("figures are approximate"),
// 555C deducts from IM 1448 (2025; minimum stub = deduct + 2"), radii from the 2019 catalogue.
// One-shot hydraulic shoes (881CT, 884/885): radius from the catalogue; no published deduct, so the
// 90 is laid out from the radius. [take-up in or null, radius in or null]
const POWER = [
  { key: 'greenlee-1818', brand: 'Greenlee', model: '1818 mechanical', note: 'Deducts are approximate (Greenlee IM 1101).', sizes: {
    EMT: { 35: [12 + 5 / 8, 8 + 9 / 32], 41: [12 + 15 / 16, null], 53: [15, 9 + 3 / 16] },
    RMC: { 35: [12 + 3 / 8, 7 + 3 / 8], 41: [15, 9] },
    IMC: { 35: [12.5, 7 + 3 / 8] },
  } },
  { key: 'greenlee-555c', brand: 'Greenlee', model: '555C electric', note: 'Minimum stub is the deduct + 2" (Greenlee IM 1448).', sizes: {
    EMT: { 35: [13 + 1 / 8, 8 + 13 / 16], 41: [13 + 7 / 8, 8 + 3 / 8], 53: [15 + 3 / 8, 9 + 1 / 4] },
    RMC: { 35: [14, 8.75], 41: [14.25, 8.25], 53: [16 + 1 / 8, 9] },
    IMC: { 35: [14, 8.75], 41: [13.75, 8.25], 53: [15.25, 9] },
  } },
  { key: 'greenlee-884', brand: 'Greenlee', model: '884/885 hydraulic', note: 'No published deduct: the 90 is laid out from the radius. Calibrate before you trust it.', sizes: {
    RMC: { 35: [null, 7.25], 41: [null, 8.25], 53: [null, 9.5], 63: [null, 12.5], 78: [null, 15], 91: [null, 17.5], 103: [null, 20] },
  } },
  { key: 'greenlee-881ct', brand: 'Greenlee', model: '881CT one-shot', note: 'No published deduct: the 90 is laid out from the radius. Calibrate before you trust it.', sizes: {
    RMC: { 63: [null, 13.5], 78: [null, 16], 91: [null, 18 + 5 / 8], 103: [null, 20 + 7 / 8] },
  } },
];

function profile({ key, brand, model, type, size, takeUpIn, radiusIn, backToBackMark = 'star', centreMark = 'centre-of-bend mark', names, notes, source }) {
  const od = conduitOD(type, size) || 0;
  const radiusM = radiusIn ? inToM(radiusIn) : null;
  return {
    id: `std:${key}:${type}:${size}`,
    name: `${brand} ${model}`,
    brand, model, conduitType: type, tradeSize: String(size),
    takeUpM: takeUpIn ? inToM(takeUpIn) : null,
    gainM: radiusM ? gain90({ radiusM, odM: od }) : null,
    backToBackMark, centreMark,
    minRadiusM: radiusM,
    isDefault: false,
    notes: [notes, 'Typical published values. Check them against the marks on your own bender, or calibrate it.', radiusM ? 'Gain worked out from the radius and OD (not published).' : null].filter(Boolean).join(' '),
    names: names || null,
    source,
    builtIn: true,
  };
}

/** Every built-in profile. */
export const DEFAULT_PROFILES = [
  ...Object.entries(HAND).flatMap(([type, sizes]) => Object.entries(sizes).flatMap(([size, [tu, r]]) =>
    HAND_BRANDS.map((b) => profile({ ...b, type, size, takeUpIn: tu, radiusIn: r })))),
  ...POWER.flatMap((p) => Object.entries(p.sizes).flatMap(([type, sizes]) => Object.entries(sizes).map(([size, [tu, r]]) =>
    profile({ key: p.key, brand: p.brand, model: p.model, type, size, takeUpIn: tu, radiusIn: r, notes: p.note, source: `Greenlee (${p.model})`, backToBackMark: 'star', centreMark: '—' })))),
];

/** Profiles for a conduit type and size: the user's own first, then the built-ins. */
export function profilesFor(type, size, userProfiles = []) {
  const match = (p) => p.conduitType === type && String(p.tradeSize) === String(size);
  return [...userProfiles.filter(match), ...DEFAULT_PROFILES.filter(match)];
}

/** The profile to start with: the user's default for this pipe, else their first, else the first built-in. */
export function pickProfile(type, size, userProfiles = [], preferredId = null) {
  const list = profilesFor(type, size, userProfiles);
  return list.find((p) => p.id === preferredId) || list.find((p) => !p.builtIn && p.isDefault) || list.find((p) => !p.builtIn) || list[0] || null;
}

export const findProfile = (id, userProfiles = []) => userProfiles.find((p) => p.id === id) || DEFAULT_PROFILES.find((p) => p.id === id) || null;

/** Mark names for a profile, for the calculators' steps. */
export function markNames(p) {
  if (!p) return undefined;
  if (p.names) return p.names;
  const out = {};
  if (p.backToBackMark && p.backToBackMark !== '—') out.star = p.backToBackMark;
  if (p.centreMark && p.centreMark !== '—') out.centre = p.centreMark;
  return out;
}

// ---------------------------------------------------------------------------
// Calibrate: bend a test 90 and measure
// ---------------------------------------------------------------------------

/**
 * Before bending, mark the pipe at markM from the end (and optionally a second mark at mark2M).
 * Bend a 90 with the first mark on the arrow, hook toward the end. Measure:
 *   stubM: end of the pipe to the back of the 90
 *   legM: back of the 90 to the second mark, along the other leg (optional)
 * take-up = stub − mark. gain = stub + leg − mark2 (the legs to the back, less the pipe used).
 */
export function calibrate({ markM, stubM, mark2M, legM }) {
  need(isPos(markM), 'Enter where you marked the pipe (end to the mark).');
  need(isPos(stubM), 'Enter the stub you measured (end to the back of the 90).');
  need(stubM > markM, 'The stub has to be longer than the distance to the mark. Measure to the back of the bend.');
  const takeUpM = stubM - markM;
  const warnings = [];
  let gainM = null;
  if (isPos(mark2M) && isPos(legM)) {
    need(mark2M > markM, 'The second mark has to be farther from the end than the first.');
    gainM = stubM + legM - mark2M;
    if (gainM <= 0) warnings.push('That gives no gain at all. Measure both legs to the back of the bend and check the second mark.');
    else if (gainM >= takeUpM) warnings.push('The gain came out larger than the take-up, which is unusual. Check the measurements.');
  }
  if (takeUpM < 0.05 || takeUpM > 0.6) warnings.push('That take-up is outside the usual range for a hand or mechanical bender. Check the measurements.');
  return { takeUpM, gainM, warnings };
}
