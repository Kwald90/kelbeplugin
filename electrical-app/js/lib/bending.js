// Conduit bending geometry. Pure functions, SI units: metres and degrees.
//
// Every calculator takes an input object and returns the same result shape:
//   { kind, marks[{ label, atM, symbol, angleDeg, bend, note }], shrinkM, developedLengthM,
//     warnings[], figures[], steps[], degrees, segments, start, dims, ... }
// `atM` is measured along the straight pipe from the reference end (the left end in the
// drawings). `segments` describe the bent pipe for the diagram (see tracePath).
// Text in steps and warnings is built with `opts.fmt(metres)`, so the screen can show it in
// the user's units; the default prints millimetres.
//
// Formulas (worked through in docs/field/bending.md):
//   offset: distance between bends = rise / sin θ, shrink = rise × tan(θ/2)
//   rolling offset: true offset = √(rise² + roll²), then as an offset
//   parallel offsets: each conduit moves its marks by centre spacing × tan(θ/2)
//   90° stub: mark = stub − take-up; cut length with two legs = leg1 + leg2 − gain
//   gain (legs to the back of the bend) = radius × (2 − π/2) + OD
//   segment bends: arc = radius × θ (radians), split into equal shots, bend at the middle of each
//   concentric 90s: radius grows by the centre spacing per conduit; all bends start on one line

export class BendError extends Error {
  constructor(message) { super(message); this.name = 'BendError'; }
}

const RAD = Math.PI / 180;
const sinD = (d) => Math.sin(d * RAD);
const cosD = (d) => Math.cos(d * RAD);
const tanD = (d) => Math.tan(d * RAD);
const need = (ok, message) => { if (!ok) throw new BendError(message); };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPos = (v) => isNum(v) && v > 0;
const mmFmt = (m) => `${Math.round(m * 1000)} mm`;
export const fmtDeg = (d) => `${Number(Number(d).toFixed(1))}°`;

/** The angles printed on hand benders and in every offset chart. */
export const COMMON_ANGLES = [10, 22.5, 30, 45, 60];

/** Offset multiplier: distance between the two bends per unit of rise (cosecant). */
export const multiplier = (angleDeg) => 1 / sinD(angleDeg);
/** Shrink per unit of rise for one offset (two bends of this angle). */
export const shrinkPerUnit = (angleDeg) => tanD(angleDeg / 2);

// The rounded numbers printed on hand benders and in their guides (shrink in inches per inch of
// rise, so per unit of rise in any units). Same in the Klein Conduit Bender Guide, Greenlee
// IM 1071 and the Greenlee Site-Rite guide (2023); IDEAL ND 1534-4 matches.
export const CHART = {
  10: { multiplier: 6, shrink: 1 / 16 },
  22.5: { multiplier: 2.6, shrink: 3 / 16 },
  30: { multiplier: 2, shrink: 1 / 4 },
  45: { multiplier: 1.4, shrink: 3 / 8 },
  60: { multiplier: 1.2, shrink: 1 / 2 },
};
// 3-point saddles by centre angle: side marks per unit of height from the centre, and shrink to the
// centre per unit of height. 45°: Klein, IDEAL and Greenlee all print 2½ and 3/16. 60°: Klein
// prints 2 and 1/4 (IDEAL says to use 2½ and 3/16 for both; VERIFY on your bender).
export const CHART_SADDLE = { 45: { multiplier: 2.5, shrink: 3 / 16 }, 60: { multiplier: 2, shrink: 1 / 4 } };

const chartRow = (angleDeg, opts) => (opts?.chart ? CHART[angleDeg] : null);
const mult = (a, opts) => chartRow(a, opts)?.multiplier ?? multiplier(a);
const shrinkPer = (a, opts) => chartRow(a, opts)?.shrink ?? shrinkPerUnit(a);

/** [{ angleDeg, multiplier, shrinkPerUnit, chartMultiplier, chartShrink }] for the common angles. */
export const offsetTable = () => COMMON_ANGLES.map((a) => ({
  angleDeg: a, multiplier: multiplier(a), shrinkPerUnit: shrinkPerUnit(a), chartMultiplier: CHART[a].multiplier, chartShrink: CHART[a].shrink,
}));

// What each brand calls its marks (Klein Conduit Bender Guide, IDEAL ND 1534-4, Greenlee Site-Rite
// guide 2023). Calculators take these as opts.names so the steps use your bender's words.
export const DEFAULT_MARK_NAMES = { arrow: 'arrow', star: 'star', centre: 'centre-of-bend mark (rim notch)' };
const names = (opts) => ({ ...DEFAULT_MARK_NAMES, ...(opts?.names || {}) });

/** The bend angle that puts the marks `spacingM` apart for an offset `riseM` deep. */
export function angleForSpacing(riseM, spacingM) {
  need(isPos(riseM) && isPos(spacingM), 'Enter the rise and the distance between marks.');
  need(spacingM > riseM, 'The marks have to be farther apart than the offset is deep.');
  return Math.asin(riseM / spacingM) / RAD;
}

/** Length of conduit in a bend of this radius (centreline) and angle. */
export const arcLength = (radiusM, angleDeg) => radiusM * Math.abs(angleDeg) * RAD;
/** Gain of a 90 with both legs measured to the back of the bend. */
export const gain90 = ({ radiusM, odM = 0 }) => radiusM * (2 - Math.PI / 2) + odM;
/** Take-up when the bend starts at the mark (one-shot shoes, PVC). Hand benders publish their own. */
export const takeUpFromRadius = ({ radiusM, odM = 0 }) => radiusM + odM / 2;

// ---------------------------------------------------------------------------
// Conduit types, trade sizes, diameters
// ---------------------------------------------------------------------------

/** Canadian metric designators with the imperial trade size. */
export const TRADE_SIZES = [
  { id: '16', inch: '1/2' }, { id: '21', inch: '3/4' }, { id: '27', inch: '1' }, { id: '35', inch: '1-1/4' },
  { id: '41', inch: '1-1/2' }, { id: '53', inch: '2' }, { id: '63', inch: '2-1/2' }, { id: '78', inch: '3' },
  { id: '91', inch: '3-1/2' }, { id: '103', inch: '4' },
];
export function tradeSizeLabel(id) {
  const t = TRADE_SIZES.find((s) => s.id === String(id));
  return t ? `${t.id} (${t.inch}")` : String(id ?? '—');
}

export const CONDUIT_TYPES = [
  { id: 'EMT', label: 'EMT', name: 'Electrical metallic tubing' },
  { id: 'RMC', label: 'Rigid steel', name: 'Rigid metal conduit' },
  { id: 'IMC', label: 'IMC', name: 'Intermediate metal conduit' },
  { id: 'PVC', label: 'Rigid PVC', name: 'Rigid PVC conduit (heat bent)' },
  { id: 'AL', label: 'Rigid aluminum', name: 'Rigid aluminum conduit' },
];
export const conduitLabel = (id) => CONDUIT_TYPES.find((c) => c.id === id)?.label || id || '—';

// Outside diameters in inches, trade sizes 1/2 to 4 (16 to 103).
// EMT: ANSI C80.3. RMC: ANSI C80.1. IMC: ANSI C80.6. Rigid aluminum: ANSI C80.5 (same pipe
// sizes as RMC). PVC Schedule 40: NEMA TC 2 / CSA C22.2 No. 211.2 (same as RMC). VERIFY against
// the maker's sheet if a bend depends on the last 1/32".
const OD_IN = {
  EMT: [0.706, 0.922, 1.163, 1.510, 1.740, 2.197, 2.875, 3.500, 4.000, 4.500],
  RMC: [0.840, 1.050, 1.315, 1.660, 1.900, 2.375, 2.875, 3.500, 4.000, 4.500],
  IMC: [0.815, 1.029, 1.290, 1.638, 1.883, 2.360, 2.857, 3.476, 3.971, 4.466],
};
OD_IN.AL = OD_IN.RMC;
OD_IN.PVC = OD_IN.RMC;

/** Outside diameter in metres, or null for an unknown type/size. */
export function conduitOD(type, size) {
  const i = TRADE_SIZES.findIndex((s) => s.id === String(size));
  const v = OD_IN[type]?.[i];
  return v == null ? null : v * 0.0254;
}

// ---------------------------------------------------------------------------
// Drawing the bent pipe
// ---------------------------------------------------------------------------

/**
 * Follow a list of segments from (x, y) heading `headingDeg` (0 = +x, 90 = +y):
 *   { straightM }            a straight run
 *   { bendDeg, radiusM? }    a bend; positive turns left (counter-clockwise). No radius = sharp corner.
 * Returns { points: [[x, y]], bends: [{ x, y, headingDeg, bendDeg }], end: [x, y], headingDeg }.
 * `bends[i]` is the corner (or the middle of the arc).
 */
export function tracePath(segments, { x = 0, y = 0, headingDeg = 0 } = {}) {
  const points = [[x, y]];
  const bends = [];
  let h = headingDeg;
  for (const s of segments) {
    if (isNum(s.straightM)) {
      x += s.straightM * cosD(h);
      y += s.straightM * sinD(h);
      points.push([x, y]);
    } else if (isNum(s.bendDeg)) {
      const r = s.radiusM || 0;
      if (r > 0) {
        const sign = Math.sign(s.bendDeg) || 1;
        const cx = x + r * cosD(h + 90 * sign), cy = y + r * sinD(h + 90 * sign);
        const a0 = h - 90 * sign;
        const steps = Math.max(2, Math.ceil(Math.abs(s.bendDeg) / 5));
        for (let k = 1; k <= steps; k++) {
          const a = a0 + (s.bendDeg * k) / steps;
          points.push([cx + r * cosD(a), cy + r * sinD(a)]);
        }
        const am = a0 + s.bendDeg / 2;
        bends.push({ x: cx + r * cosD(am), y: cy + r * sinD(am), headingDeg: h + s.bendDeg / 2, bendDeg: s.bendDeg });
        [x, y] = points[points.length - 1];
      } else {
        bends.push({ x, y, headingDeg: h + s.bendDeg / 2, bendDeg: s.bendDeg });
      }
      h += s.bendDeg;
    }
  }
  return { points, bends, end: [x, y], headingDeg: h };
}

/** Straight length of conduit the segments use (straights plus arcs). */
export function developedLength(segments) {
  let total = 0;
  for (const s of segments) {
    if (isNum(s.straightM)) total += s.straightM;
    else if (isNum(s.bendDeg) && s.radiusM) total += arcLength(s.radiusM, s.bendDeg);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Shared result helpers
// ---------------------------------------------------------------------------

function finish(kind, r) {
  const marks = [...(r.marks || [])].sort((a, b) => (a.pipe || 0) - (b.pipe || 0) || a.atM - b.atM);
  const degrees = r.degrees ?? marks.reduce((s, m) => s + Math.abs(m.angleDeg || 0), 0);
  const warnings = [...(r.warnings || [])];
  if (degrees > 360) warnings.push(`This piece alone has ${fmtDeg(degrees)} of bends. A run can have at most 360° between pull points (CEC Rule 12-942).`);
  return {
    kind,
    reference: r.reference || 'end',
    marks,
    shrinkM: r.shrinkM ?? 0,
    developedLengthM: r.developedLengthM ?? null,
    warnings,
    figures: r.figures || [],
    steps: r.steps || [],
    degrees,
    segments: r.segments || [],
    start: r.start || { x: 0, y: 0, headingDeg: 0 },
    dims: r.dims || [],
    ...(r.extra || {}),
  };
}

/** What a saved `bends` record keeps of a result (the data contract in docs/BUILD-PLAN.md). */
export function toRecordResult(result) {
  return {
    marks: result.marks.map((m) => ({ label: [m.label, m.angleDeg ? fmtDeg(m.angleDeg) : null, m.note].filter(Boolean).join(' · '), atM: m.atM })),
    shrinkM: result.shrinkM ?? 0,
    developedLengthM: result.developedLengthM ?? null,
    warnings: [...result.warnings],
  };
}

function resolveAngle({ angleDeg, riseM, spacingM }) {
  if (isPos(angleDeg)) {
    need(angleDeg < 90, 'The bend angle has to be under 90°.');
    return { angleDeg, solved: false };
  }
  need(isPos(spacingM), 'Pick an angle, or enter the distance you want between the marks.');
  return { angleDeg: angleForSpacing(riseM, spacingM), solved: true };
}

function tailFor(lastM, span, runM, shrinkM) {
  if (isNum(runM)) return Math.max(0, runM + shrinkM - lastM);
  return Math.max(span * 0.5, 0.05);
}

// ---------------------------------------------------------------------------
// Offsets and kicks
// ---------------------------------------------------------------------------

/**
 * Offset: two equal bends in opposite directions.
 * input: { riseM, angleDeg | spacingM, obstacleM? | firstBendM?, runM?, radiusM? }
 *   obstacleM: end of pipe to where the offset must be done (shrink is added for you)
 *   firstBendM: end of pipe to the first bend (working away from a fixed point)
 *   neither: marks are measured from mark 1
 *   runM: end of pipe to where the far end must land, along the wall, for a cut length
 */
export function offset(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { riseM, obstacleM, firstBendM, runM, radiusM } = input;
  need(isPos(riseM), 'Enter how deep the offset is (the rise).');
  const { angleDeg, solved } = resolveAngle(input);
  const nm = names(opts);
  const k = mult(angleDeg, opts);
  const dist = riseM * k;
  const shrink = riseM * shrinkPer(angleDeg, opts);
  const runAlong = riseM / tanD(angleDeg);
  let m1, m2, reference = 'end';
  if (isNum(obstacleM)) { m2 = obstacleM + shrink; m1 = m2 - dist; }
  else if (isNum(firstBendM)) { m1 = firstBendM; m2 = m1 + dist; }
  else { m1 = 0; m2 = dist; reference = 'mark1'; }
  need(m1 >= 0, `Not enough room: mark 1 would be ${f(-m1)} past the end of the pipe. Use a steeper angle, or start from a longer piece.`);
  const warnings = [];
  if (isPos(radiusM) && dist < arcLength(radiusM, angleDeg)) warnings.push(`The marks are ${f(dist)} apart but each ${fmtDeg(angleDeg)} bend needs about ${f(arcLength(radiusM, angleDeg))} of pipe. The bends will run into each other: use a smaller angle.`);
  if (isNum(runM) && isNum(obstacleM) && runM < obstacleM) warnings.push('The run is shorter than the distance to the obstruction.');
  if (angleDeg > 60) warnings.push(`${fmtDeg(angleDeg)} offsets are hard to pull through and easy to over-bend. 45° or less is usual.`);
  const cut = isNum(runM) ? runM + shrink : null;
  return finish('offset', {
    reference,
    marks: [
      { label: 'Mark 1', atM: m1, symbol: 'arrow', angleDeg, bend: 1, dir: 'up' },
      { label: 'Mark 2', atM: m2, symbol: 'arrow', angleDeg, bend: 2, dir: 'down', note: 'roll 180°' },
    ],
    shrinkM: shrink,
    developedLengthM: cut ?? m2,
    warnings,
    figures: [
      { label: solved ? 'Angle for that spacing' : 'Angle', deg: angleDeg },
      { label: chartRow(angleDeg, opts) ? 'Multiplier (chart)' : 'Multiplier', x: k },
      { label: 'Between marks', m: dist },
      { label: 'Shrink', m: shrink },
      { label: 'Run of the offset', m: runAlong },
      cut != null ? { label: 'Cut length', m: cut } : { label: 'Pipe to mark 2', m: m2 },
    ],
    steps: [
      reference === 'end'
        ? `Mark 1 at ${f(m1)} and mark 2 at ${f(m2)} from the end (${f(dist)} apart).`
        : `Put mark 1 where the offset starts, then mark 2 ${f(dist)} past it.`,
      `Bend 1: mark 1 on the ${nm.arrow}, the hook facing away from mark 2, bend to ${fmtDeg(angleDeg)}.`,
      `Bend 2: slide the bender to mark 2, roll the pipe half a turn (180°), mark 2 on the ${nm.arrow}, bend ${fmtDeg(angleDeg)}.`,
      `Check: the legs are parallel and ${f(riseM)} apart.`,
    ],
    segments: [
      { straightM: m1 }, { bendDeg: angleDeg }, { straightM: dist }, { bendDeg: -angleDeg },
      { straightM: tailFor(m2, dist, runM, shrink) },
    ],
    dims: [{ type: 'rise', label: riseM, obstacle: reference === 'end' && isNum(obstacleM) }],
    extra: { angleDeg, multiplier: k, spacingM: dist, riseM },
  });
}

/**
 * Kick: one bend under 90° that moves the end of the pipe off the line of the run.
 * input: { riseM, angleDeg | spacingM } — spacingM fixes the mark and solves the angle.
 * The mark is measured from the end that kicks out.
 */
export function kick(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { riseM } = input;
  need(isPos(riseM), 'Enter how far the end has to move (the kick).');
  const { angleDeg, solved } = resolveAngle(input);
  const nm = names(opts);
  const k = mult(angleDeg, opts);
  const travel = riseM * k;
  const run = riseM / tanD(angleDeg);
  const shrink = riseM * shrinkPer(angleDeg, opts);
  return finish('kick', {
    marks: [{ label: 'Mark', atM: travel, symbol: 'arrow', angleDeg, bend: 1, dir: 'up' }],
    shrinkM: shrink,
    developedLengthM: travel,
    figures: [
      { label: solved ? 'Angle for that mark' : 'Angle', deg: angleDeg },
      { label: 'Mark from the end', m: travel },
      { label: 'Run of the kick', m: run },
      { label: 'Shrink', m: shrink },
    ],
    steps: [
      `Mark ${f(travel)} from the end that kicks out (${f(riseM)} × ${Number(k.toFixed(2))}).`,
      `Mark on the ${nm.arrow}, that end toward the bender hook, bend to ${fmtDeg(angleDeg)}.`,
      `Check: lay the pipe on the floor; the end sits ${f(riseM)} up.`,
    ],
    start: { x: 0, y: 0, headingDeg: -angleDeg },
    segments: [{ straightM: travel }, { bendDeg: angleDeg }, { straightM: Math.max(travel, 0.15) }],
    dims: [{ type: 'kick', label: riseM }],
    extra: { angleDeg, riseM },
  });
}

// ---------------------------------------------------------------------------
// Saddles
// ---------------------------------------------------------------------------

/**
 * 3-point saddle over a pipe or other round obstruction.
 * input: { heightM, centerAngleDeg: 45 | 60 (any), centerM?, runM? }
 *   centerM: end of pipe to the centre of the obstruction (shrink is added for you)
 * Outer bends are half the centre bend. Spacing uses the exact geometry, H / sin(side angle).
 */
export function saddle3(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { heightM, centerM, runM } = input;
  const center = isPos(input.centerAngleDeg) ? input.centerAngleDeg : 45;
  need(isPos(heightM), 'Enter the height of the obstruction (plus any clearance you want).');
  need(center > 0 && center < 180, 'The centre bend has to be under 180°.');
  const side = center / 2;
  const nm = names(opts);
  const chart = opts.chart ? CHART_SADDLE[center] : null;
  const exactSp = heightM * multiplier(side);
  const sp = chart ? heightM * chart.multiplier : exactSp;
  const shHalf = heightM * (chart ? chart.shrink : shrinkPerUnit(side));
  let c, reference = 'end';
  if (isNum(centerM)) c = centerM + shHalf;
  else { c = sp; reference = 'mark1'; }
  const a = c - sp, b = c + sp;
  need(a >= 0, `Not enough room: the first side mark would be ${f(-a)} past the end of the pipe.`);
  const warnings = [];
  const figures = [
    { label: 'Bends', text: `${fmtDeg(center)} centre, ${fmtDeg(side)} sides` },
    { label: chart ? 'Side marks from centre (chart)' : 'Side marks from centre', m: sp },
    { label: 'Shrink to the centre', m: shHalf },
    { label: 'Total shrink', m: 2 * shHalf },
  ];
  if (chart) {
    figures.push({ label: 'Exact geometry', m: exactSp });
  } else if (CHART_SADDLE[center]) {
    const ch = CHART_SADDLE[center];
    figures.push({ label: `Bender chart (${ch.multiplier === 2.5 ? '2½' : ch.multiplier} × height)`, m: ch.multiplier * heightM });
    if (Math.abs(sp - ch.multiplier * heightM) > 0.003) warnings.push(`Bender charts space the side marks ${ch.multiplier === 2.5 ? '2½' : ch.multiplier} × the height (${f(ch.multiplier * heightM)}). The exact geometry gives ${f(sp)}; this uses the exact figure. Switch on chart numbers to match your bender.`);
  }
  const cut = isNum(runM) ? runM + 2 * shHalf : null;
  figures.push(cut != null ? { label: 'Cut length', m: cut } : { label: 'Pipe to the last mark', m: b });
  return finish('saddle3', {
    reference,
    marks: [
      { label: 'Mark 1', atM: a, symbol: 'arrow', angleDeg: side, bend: 2, dir: 'up' },
      { label: 'Mark 2', atM: c, symbol: 'notch', angleDeg: center, bend: 1, dir: 'down', note: 'centre' },
      { label: 'Mark 3', atM: b, symbol: 'arrow', angleDeg: side, bend: 3, dir: 'up' },
    ],
    shrinkM: 2 * shHalf,
    developedLengthM: cut ?? b,
    warnings,
    figures,
    steps: [
      reference === 'end'
        ? `Centre mark (mark 2) at ${f(c)}: ${f(centerM)} to the centre of the obstruction + ${f(shHalf)} shrink.`
        : `Put the centre mark (mark 2) over the centre of the obstruction, plus ${f(shHalf)} shrink measured toward the far end.`,
      reference === 'end' ? `Side marks ${f(sp)} each side of it: mark 1 at ${f(a)}, mark 3 at ${f(b)}.` : `Side marks ${f(sp)} each side of the centre mark.`,
      `Bend 1 (centre): mark 2 on the ${nm.centre}, bend ${fmtDeg(center)}.`,
      `Bend 2: roll the pipe half a turn (180°), mark 1 on the ${nm.arrow}, bend ${fmtDeg(side)}.`,
      `Bend 3: turn the pipe end for end, mark 3 on the ${nm.arrow}, bend ${fmtDeg(side)} the same way as bend 2.`,
      `Check: the saddle clears ${f(heightM)} and both ends lie flat.`,
    ],
    segments: [
      { straightM: a }, { bendDeg: side }, { straightM: sp }, { bendDeg: -center }, { straightM: sp }, { bendDeg: side },
      { straightM: tailFor(b, sp, runM, 2 * shHalf) },
    ],
    dims: [{ type: 'obstacle', centerM: isNum(centerM) ? centerM : c - shHalf, heightM, round: true }],
    extra: { heightM, centerAngleDeg: center, sideAngleDeg: side, spacingM: sp },
  });
}

/**
 * 4-point saddle: an offset up, a straight over the obstruction, and an offset back down.
 * input: { heightM, widthM, angleDeg (default 30), obstacleM?, runM? }
 *   obstacleM: end of pipe to the near edge of the obstruction
 */
export function saddle4(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { heightM, widthM, obstacleM, runM } = input;
  const angleDeg = isPos(input.angleDeg) ? input.angleDeg : 30;
  need(isPos(heightM), 'Enter the height of the obstruction (plus clearance).');
  need(isPos(widthM), 'Enter the width of the obstruction (plus clearance).');
  need(angleDeg < 90, 'The bend angle has to be under 90°.');
  const nm = names(opts);
  const k = mult(angleDeg, opts);
  const dist = heightM * k;
  const sh = heightM * shrinkPer(angleDeg, opts);
  let m2, reference = 'end';
  if (isNum(obstacleM)) m2 = obstacleM + sh;
  else { m2 = dist; reference = 'mark1'; }
  const m1 = m2 - dist, m3 = m2 + widthM, m4 = m3 + dist;
  need(m1 >= 0, `Not enough room: mark 1 would be ${f(-m1)} past the end of the pipe.`);
  const cut = isNum(runM) ? runM + 2 * sh : null;
  return finish('saddle4', {
    reference,
    marks: [
      { label: 'Mark 1', atM: m1, symbol: 'arrow', angleDeg, bend: 1, dir: 'up' },
      { label: 'Mark 2', atM: m2, symbol: 'arrow', angleDeg, bend: 2, dir: 'down', note: 'roll 180°' },
      { label: 'Mark 3', atM: m3, symbol: 'arrow', angleDeg, bend: 3, dir: 'down' },
      { label: 'Mark 4', atM: m4, symbol: 'arrow', angleDeg, bend: 4, dir: 'up', note: 'roll 180°' },
    ],
    shrinkM: 2 * sh,
    developedLengthM: cut ?? m4,
    figures: [
      { label: 'Angle', deg: angleDeg },
      { label: chartRow(angleDeg, opts) ? 'Multiplier (chart)' : 'Multiplier', x: k },
      { label: 'Marks 1–2 and 3–4', m: dist },
      { label: 'Marks 2–3 (width)', m: widthM },
      { label: 'Shrink per offset', m: sh },
      { label: 'Total shrink', m: 2 * sh },
      cut != null ? { label: 'Cut length', m: cut } : { label: 'Pipe to mark 4', m: m4 },
    ],
    steps: [
      reference === 'end'
        ? `Mark 2 at ${f(m2)}: ${f(obstacleM)} to the near edge + ${f(sh)} shrink.`
        : `Put mark 2 at the near edge of the obstruction plus ${f(sh)} shrink.`,
      reference === 'end'
        ? `Mark 1 at ${f(m1)} (${f(dist)} back), mark 3 at ${f(m3)} (the width past mark 2), mark 4 at ${f(m4)}.`
        : `Mark 1 ${f(dist)} before mark 2, mark 3 ${f(widthM)} past mark 2, mark 4 ${f(dist)} past mark 3.`,
      `Bend 1: mark 1 on the ${nm.arrow}, the hook facing away from mark 2, bend ${fmtDeg(angleDeg)}.`,
      `Bend 2: roll the pipe half a turn, mark 2 on the ${nm.arrow}, bend ${fmtDeg(angleDeg)}. That is the first offset.`,
      `Bend 3: no roll from bend 2; mark 3 on the ${nm.arrow}, bend ${fmtDeg(angleDeg)} so the pipe heads back down.`,
      `Bend 4: roll half a turn, mark 4 on the ${nm.arrow}, bend ${fmtDeg(angleDeg)}. Check both ends lie flat.`,
    ],
    segments: [
      { straightM: m1 }, { bendDeg: angleDeg }, { straightM: dist }, { bendDeg: -angleDeg }, { straightM: widthM },
      { bendDeg: -angleDeg }, { straightM: dist }, { bendDeg: angleDeg }, { straightM: tailFor(m4, dist, runM, 2 * sh) },
    ],
    dims: [{ type: 'obstacle', startM: isNum(obstacleM) ? obstacleM : m2 - sh, widthM, heightM }],
    extra: { angleDeg, heightM, widthM, spacingM: dist },
  });
}

// ---------------------------------------------------------------------------
// 90s
// ---------------------------------------------------------------------------

/**
 * 90° stub-up. Measured from the end of the stub to the back of the bend.
 * input: { stubM, takeUpM?, radiusM?, odM?, otherLegM?, gainM?, heat? }
 *   takeUpM: the bender's take-up (deduct). Without it, the bend is laid out from the radius
 *   (start of bend at stub − radius − OD/2), which is how PVC and one-shot shoes work.
 *   otherLegM: the second leg, also to the back of the bend, for a cut length (needs gain or radius).
 *   heat: PVC; marks show where to heat.
 */
export function stub90(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { stubM, takeUpM, radiusM, otherLegM, heat } = input;
  const odM = input.odM || 0;
  const nm = names(opts);
  need(isPos(stubM), 'Enter the stub height (end of pipe to the back of the 90).');
  need(isPos(takeUpM) || isPos(radiusM), 'Pick a bender (take-up) or enter the bend radius.');
  const warnings = [];
  const figures = [];
  const steps = [];
  const marks = [];
  const byRadius = !isPos(takeUpM);
  let gainM = isPos(input.gainM) ? input.gainM : null;
  if (gainM == null && isPos(radiusM)) gainM = gain90({ radiusM, odM });
  let startM;
  if (byRadius) {
    const tu = takeUpFromRadius({ radiusM, odM });
    startM = stubM - tu;
    need(startM >= 0, `The stub is shorter than the bend itself (${f(tu)}). Bend a longer stub and cut it to length.`);
    const endM = startM + arcLength(radiusM, 90);
    marks.push(
      { label: heat ? 'Start of heat' : 'Start of bend', atM: startM, symbol: heat ? 'heat' : 'arrow', angleDeg: 90, bend: 1, dir: 'up' },
      { label: heat ? 'End of heat' : 'End of bend', atM: endM, symbol: heat ? 'heat' : 'tick' },
    );
    figures.push({ label: 'Start of bend', m: startM }, { label: 'Length in the bend', m: endM - startM }, { label: 'Take-up (radius + ½ OD)', m: tu });
    steps.push(heat
      ? `Mark the start of the bend at ${f(startM)} and the end at ${f(endM)} from the end. Heat the pipe evenly between the marks (a little past each).`
      : `Mark the start of the bend at ${f(startM)} from the end (${f(stubM)} − ${f(tu)}).`);
    steps.push(heat
      ? `Bend around a ${f(radiusM)} radius form to 90°, end of the pipe up, and hold it until it cools.`
      : `Line the start-of-bend mark up with the start of the shoe and bend to 90°. Check your bender's chart for where its mark sits.`);
  } else {
    const m = stubM - takeUpM;
    need(m > 0, `The stub is shorter than the take-up (${f(takeUpM)}). Bend a longer stub and cut it to length.`);
    if (m < 0.025) warnings.push('The mark is very close to the end; the bender may not grip it. Bend a longer stub and cut it to length.');
    marks.push({ label: 'Mark', atM: m, symbol: 'arrow', angleDeg: 90, bend: 1, dir: 'up' });
    startM = m;
    figures.push({ label: 'Mark from the end', m }, { label: 'Take-up', m: takeUpM });
    steps.push(`Mark ${f(m)} from the end (${f(stubM)} − ${f(takeUpM)} take-up).`);
    steps.push(`Mark on the ${nm.arrow}, the hook pointed toward the free end (the stub). Bend until the stub is plumb (90°); check it with a level.`);
  }
  let cut = null;
  if (isPos(otherLegM)) {
    need(gainM != null, 'A cut length needs the bender gain or its radius.');
    cut = stubM + otherLegM - gainM;
    figures.push({ label: 'Gain', m: gainM }, { label: 'Cut length', m: cut });
    steps.unshift(`Cut the pipe to ${f(cut)} (${f(stubM)} + ${f(otherLegM)} − ${f(gainM)} gain).`);
  }
  steps.push(`Check: ${f(stubM)} from the end to the back of the bend${isPos(otherLegM) ? `, ${f(otherLegM)} on the other leg` : ''}.`);
  const r = isPos(radiusM) ? radiusM : 0;
  const legDisplay = isPos(otherLegM) ? otherLegM : Math.max(stubM * 0.8, 0.15);
  return finish('stub90', {
    marks,
    shrinkM: 0,
    developedLengthM: cut ?? (r ? stubM - r - odM / 2 + arcLength(r, 90) : null),
    warnings,
    figures,
    steps,
    degrees: 90,
    start: { x: 0, y: 0, headingDeg: -90 },
    segments: [{ straightM: Math.max(0, stubM - r - odM / 2) }, { bendDeg: 90, radiusM: r }, { straightM: Math.max(0.02, legDisplay - r - odM / 2) }],
    dims: [{ type: 'stub', label: stubM, odM }, isPos(otherLegM) ? { type: 'leg', label: otherLegM, odM } : null].filter(Boolean),
    extra: { stubM, gainM, takeUpM: byRadius ? takeUpFromRadius({ radiusM, odM }) : takeUpM, byRadius },
  });
}

/**
 * Back-to-back 90s (a U): two stubs, a set distance apart measured across the backs.
 * input: { stubM, backToBackM, secondStubM?, takeUpM?, gainM?, radiusM?, odM?, heat? }
 */
export function backToBack(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { stubM, backToBackM, secondStubM, takeUpM, radiusM, heat } = input;
  const odM = input.odM || 0;
  const nm = names(opts);
  need(isPos(stubM), 'Enter the first stub height (end to the back of the first 90).');
  need(isPos(backToBackM), 'Enter the distance between the backs of the two 90s.');
  need(isPos(takeUpM) || isPos(radiusM), 'Pick a bender (take-up) or enter the bend radius.');
  let gainM = isPos(input.gainM) ? input.gainM : null;
  if (gainM == null && isPos(radiusM)) gainM = gain90({ radiusM, odM });
  need(gainM != null, 'The second mark needs the bender gain or its radius. Or bend the first 90 and measure from its back.');
  const warnings = [];
  const r = isPos(radiusM) ? radiusM : 0;
  const tu = isPos(takeUpM) ? takeUpM : takeUpFromRadius({ radiusM, odM });
  const m1 = stubM - tu;
  need(m1 > 0, `The first stub is shorter than the take-up (${f(tu)}). Bend a longer stub and cut it.`);
  if (r && backToBackM < 2 * (r + odM / 2)) warnings.push(`At ${f(backToBackM)} the two bends overlap (each needs ${f(r + odM / 2)}). The pipe can't be bent this tight with this radius.`);
  const m2 = stubM + backToBackM - gainM;
  const marks = [
    { label: 'Mark 1', atM: m1, symbol: isPos(takeUpM) ? 'arrow' : heat ? 'heat' : 'arrow', angleDeg: 90, bend: 1, dir: 'up', note: 'first 90' },
    { label: 'Mark 2', atM: m2, symbol: isPos(takeUpM) ? 'star' : heat ? 'heat' : 'tick', angleDeg: 90, bend: 2, dir: 'up', note: 'back of second 90' },
  ];
  const cut = isPos(secondStubM) ? stubM + backToBackM + secondStubM - 2 * gainM : null;
  const steps = [
    cut != null ? `Cut the pipe to ${f(cut)} (${f(stubM)} + ${f(backToBackM)} + ${f(secondStubM)} − 2 × ${f(gainM)} gain).` : null,
    `Bend 1: mark ${f(m1)} from the end, mark on the ${nm.arrow}, hook toward the free end (the stub), bend 90°.`,
    `Mark 2: measure ${f(backToBackM)} from the back of the first 90 along the pipe (on the straight pipe that is ${f(m2)} from the end).`,
    isPos(takeUpM)
      ? `Bend 2: turn the bender around so the hook faces the other free end, away from the first stub; mark 2 on the ${nm.star} (back-of-90 mark), bend 90° the same way as the first.`
      : `Bend 2: the back of this 90 lands on mark 2; start the bend ${f(r + odM / 2)} before it.`,
    `Check: ${f(backToBackM)} across the backs of the two stubs.`,
  ].filter(Boolean);
  const leg2 = isPos(secondStubM) ? secondStubM : stubM;
  return finish('backToBack', {
    marks,
    shrinkM: 0,
    developedLengthM: cut ?? m2,
    warnings,
    figures: [
      { label: 'Mark 1 (arrow)', m: m1 },
      { label: 'Mark 2 (star)', m: m2 },
      { label: 'Gain', m: gainM },
      cut != null ? { label: 'Cut length', m: cut } : null,
    ].filter(Boolean),
    steps,
    degrees: 180,
    start: { x: 0, y: 0, headingDeg: -90 },
    segments: [
      { straightM: Math.max(0, stubM - r - odM / 2) }, { bendDeg: 90, radiusM: r },
      { straightM: Math.max(0, backToBackM - 2 * r - odM) }, { bendDeg: 90, radiusM: r },
      { straightM: Math.max(0.02, leg2 - r - odM / 2) },
    ],
    dims: [{ type: 'stub', label: stubM, odM }, { type: 'backToBack', label: backToBackM, odM }],
    extra: { gainM, takeUpM: tu },
  });
}

/** Cut length of a pipe with one 90 and both legs measured to the back of the bend. */
export const cutLength90 = ({ leg1M, leg2M, gainM }) => leg1M + leg2M - gainM;

// ---------------------------------------------------------------------------
// Box and bracket offsets
// ---------------------------------------------------------------------------

/**
 * Small offsets.
 * target 'box' (default): into a box knockout. input: { riseM, angleDeg (default 10), straightM }
 *   straightM is the straight pipe you need past the offset for the connector; marks measured
 *   from the end that goes into the box.
 * target 'bracket': over a bracket, strut or hanger, as an offset into an obstruction.
 *   input: { riseM, angleDeg, obstacleM }
 */
export function boxOffset(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const angleDeg = isPos(input.angleDeg) ? input.angleDeg : 10;
  if (input.target === 'bracket') {
    const r = offset({ ...input, angleDeg }, opts);
    return { ...r, kind: 'boxOffset', target: 'bracket' };
  }
  const { riseM } = input;
  const straightM = isNum(input.straightM) ? input.straightM : 0.038;
  need(isPos(riseM), 'Enter the offset: how far the knockout sits off the line of the pipe.');
  need(angleDeg < 90, 'The bend angle has to be under 90°.');
  const nm = names(opts);
  const dist = riseM * mult(angleDeg, opts);
  const sh = riseM * shrinkPer(angleDeg, opts);
  const m1 = straightM, m2 = straightM + dist;
  const warnings = [];
  if (riseM > 0.05) warnings.push(`${f(riseM)} is deep for a box offset; treat it as a regular offset with a steeper angle.`);
  if (straightM < 0.019) warnings.push('Leave enough straight pipe past the offset for the connector to grip.');
  return finish('boxOffset', {
    marks: [
      { label: 'Mark 1', atM: m1, symbol: 'arrow', angleDeg, bend: 1, dir: 'down', note: 'box side' },
      { label: 'Mark 2', atM: m2, symbol: 'arrow', angleDeg, bend: 2, dir: 'up', note: 'roll 180°' },
    ],
    shrinkM: sh,
    developedLengthM: m2,
    warnings,
    figures: [
      { label: 'Angle', deg: angleDeg },
      { label: 'Between marks', m: dist },
      { label: 'Straight into the box', m: straightM },
      { label: 'Shrink', m: sh },
    ],
    steps: [
      `From the end that goes into the box: mark 1 at ${f(m1)}, mark 2 at ${f(m2)}.`,
      `Bend 1: mark 1 on the ${nm.arrow}, bend ${fmtDeg(angleDeg)}.`,
      `Bend 2: roll the pipe half a turn, mark 2 on the ${nm.arrow}, bend ${fmtDeg(angleDeg)}.`,
      `Check: lay it on the wall; the end sits ${f(riseM)} off the wall line and lines up with the knockout. Many crews make these with a box-offset bender or by eye; check yours on a scrap first.`,
    ],
    segments: [{ straightM: m1 }, { bendDeg: -angleDeg }, { straightM: dist }, { bendDeg: angleDeg }, { straightM: Math.max(dist, 0.1) }],
    dims: [{ type: 'rise', from: 0, to: 1, label: riseM }],
    extra: { target: 'box', angleDeg, riseM },
  });
}

// ---------------------------------------------------------------------------
// Rolling and parallel offsets
// ---------------------------------------------------------------------------

/**
 * Rolling offset: the pipe moves up (rise) and over (roll) at the same time.
 * input: { riseM, rollM, angleDeg | spacingM, obstacleM?, firstBendM?, runM? }
 */
export function rollingOffset(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { riseM, rollM } = input;
  need(isNum(riseM) && riseM >= 0 && isNum(rollM) && rollM >= 0 && riseM + rollM > 0, 'Enter the rise and the roll.');
  const trueM = Math.hypot(riseM, rollM);
  const rollDeg = Math.atan2(rollM, riseM) / RAD;
  const base = offset({ ...input, riseM: trueM }, opts);
  const steps = [
    `True offset = √(${f(riseM)}² + ${f(rollM)}²) = ${f(trueM)}.`,
    base.steps[0],
    `Bend 1: before bending, turn the pipe ${fmtDeg(rollDeg)} from straight up toward the roll side. Mark 1 on the ${names(opts).arrow}, bend ${fmtDeg(base.angleDeg)}.`,
    `Bend 2: slide to mark 2, roll half a turn from where bend 1 was made, bend ${fmtDeg(base.angleDeg)}.`,
    `Check: the end is ${f(riseM)} up and ${f(rollM)} over.`,
  ];
  return {
    ...base,
    kind: 'rolling',
    steps,
    figures: [{ label: 'True offset', m: trueM }, { label: 'Roll the pipe', deg: rollDeg }, ...base.figures],
    endView: { riseM, rollM, trueM, rollDeg },
    trueM,
    rollDeg,
  };
}

/**
 * Parallel (stacked) offsets: several conduits making the same offset side by side in the plane
 * of the bend. Pipe 1 is on the inside of the first bend (the side the offset moves toward);
 * each pipe further out moves its marks by spacing × tan(θ/2).
 * input: { riseM, angleDeg | spacingM, obstacleM? | firstBendM?, count, centersM, odM? }
 */
export function parallelOffsets(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const count = Math.round(input.count || 0);
  need(count >= 2 && count <= 12, 'Enter how many conduits (2 to 12).');
  need(isPos(input.centersM), 'Enter the centre-to-centre spacing between the conduits.');
  const base = offset(input, opts);
  const adj = input.centersM * shrinkPerUnit(base.angleDeg);
  const warnings = [...base.warnings];
  if (isPos(input.odM) && input.centersM < input.odM) warnings.push(`The centre spacing (${f(input.centersM)}) is less than the pipe OD (${f(input.odM)}).`);
  const pipes = Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    shiftM: i * adj,
    marks: base.marks.map((m) => ({ ...m, atM: m.atM + i * adj })),
  }));
  const marks = pipes.flatMap((p) => p.marks.map((m) => ({ ...m, label: `Pipe ${p.index} ${m.label.toLowerCase()}`, pipe: p.index })));
  return {
    ...finish('parallel', {
      reference: base.reference,
      marks,
      shrinkM: base.shrinkM,
      developedLengthM: base.developedLengthM + (count - 1) * adj,
      warnings,
      degrees: 2 * base.angleDeg,
      figures: [
        { label: 'Angle', deg: base.angleDeg },
        { label: 'Between marks (every pipe)', m: base.spacingM },
        { label: 'Shift per pipe', m: adj },
        { label: 'Shrink', m: base.shrinkM },
      ],
      steps: [
        `Pipe 1 is the one on the inside of the first bend (the side the offset moves toward). Lay it out like a single offset: ${base.steps[0].charAt(0).toLowerCase()}${base.steps[0].slice(1)}`,
        `Move both marks ${f(adj)} farther from the end for each pipe out (${f(input.centersM)} × tan ${fmtDeg(base.angleDeg / 2)}).`,
        ...pipes.map((p) => `Pipe ${p.index}: ${p.marks.map((m) => f(m.atM)).join(' and ')}.`),
        `Bend every pipe the same: ${fmtDeg(base.angleDeg)} at the first mark, roll half a turn, ${fmtDeg(base.angleDeg)} at the second.`,
        'Conduits side by side across the bend (not in its plane) need no shift: use the same marks on all of them.',
      ],
      segments: base.segments,
      dims: base.dims,
      extra: { angleDeg: base.angleDeg, spacingM: base.spacingM, adjustM: adj, pipes, centersM: input.centersM, count, riseM: input.riseM },
    }),
  };
}

// ---------------------------------------------------------------------------
// Large-radius (segment) bends and concentric 90s
// ---------------------------------------------------------------------------

function shotLayout(radiusM, angleDeg, shots, startM) {
  const arc = arcLength(radiusM, angleDeg);
  const sp = arc / shots;
  return { arc, sp, per: angleDeg / shots, at: Array.from({ length: shots }, (_, k) => startM + sp / 2 + k * sp) };
}

/**
 * Segment (shot) bend: a large-radius bend made as several small bends.
 * input: { radiusM, angleDeg (default 90), shots? | maxShotDeg?, startM? | stubM?, odM?, minRadiusM? }
 *   startM: end of pipe to the start of the bend. stubM (90s only): end of pipe to the back of the bend.
 */
export function segmentBend(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const { radiusM, stubM, minRadiusM } = input;
  const odM = input.odM || 0;
  const angleDeg = isPos(input.angleDeg) ? input.angleDeg : 90;
  need(isPos(radiusM), 'Enter the radius of the bend (to the centre of the pipe).');
  need(angleDeg <= 180, 'Keep a segment bend to 180° or less.');
  const shots = Math.round(isPos(input.shots) ? input.shots : Math.ceil(angleDeg / (isPos(input.maxShotDeg) ? input.maxShotDeg : 10)));
  need(shots >= 2 && shots <= 60, 'Use 2 to 60 shots.');
  let startM;
  if (isNum(input.startM)) startM = input.startM;
  else if (isPos(stubM) && Math.abs(angleDeg - 90) < 1e-9) startM = stubM - radiusM - odM / 2;
  else startM = 0;
  need(startM >= 0, `The stub is too short for a ${f(radiusM)} radius: the bend would start ${f(-startM)} past the end.`);
  const { arc, sp, per, at } = shotLayout(radiusM, angleDeg, shots, startM);
  const warnings = [];
  if (isPos(minRadiusM) && radiusM < minRadiusM - 1e-6) warnings.push(`The radius is under the code minimum for this size (${f(minRadiusM)}, CEC Rule 12-924 and Table 7).`);
  if (per > 15) warnings.push(`${fmtDeg(per)} a shot is a lot; more, smaller shots make a smoother bend.`);
  const marks = [
    { label: 'Start of bend', atM: startM, symbol: 'tick' },
    ...at.map((m, k) => ({ label: `Shot ${k + 1}`, atM: m, symbol: 'arrow', angleDeg: per, bend: k + 1, dir: 'up' })),
    { label: 'End of bend', atM: startM + arc, symbol: 'tick' },
  ];
  const segs = [{ straightM: startM + sp / 2 }];
  for (let k = 0; k < shots; k++) {
    segs.push({ bendDeg: per });
    segs.push({ straightM: k === shots - 1 ? sp / 2 + Math.max(radiusM * 0.6, 0.1) : sp });
  }
  return finish('segment', {
    marks,
    shrinkM: 0,
    developedLengthM: startM + arc,
    warnings,
    figures: [
      { label: 'Shots', text: `${shots} × ${fmtDeg(per)}` },
      { label: 'Mark spacing', m: sp },
      { label: 'Length in the bend', m: arc },
      { label: 'Start of bend', m: startM },
    ],
    steps: [
      isPos(stubM) && !isNum(input.startM)
        ? `Start of bend at ${f(startM)} from the end (${f(stubM)} stub − ${f(radiusM)} radius${odM ? ` − ${f(odM / 2)} half OD` : ''}).`
        : `Start of bend at ${f(startM)} from the end.`,
      `The bend uses ${f(arc)} of pipe (${f(radiusM)} × ${(angleDeg * RAD).toFixed(4)} rad). Split it into ${shots} spaces of ${f(sp)}.`,
      `Mark the middle of each space: first shot ${f(at[0])}, then every ${f(sp)}. Measure each mark from the end so the rounding doesn't add up.`,
      `Bend ${fmtDeg(per)} at each shot mark, all in the same plane and direction. Sight down the pipe between shots to keep it flat.`,
      `Check the finished angle with a level or protractor; add or take out a little on the last shot.`,
    ],
    degrees: angleDeg,
    segments: segs,
    dims: isPos(stubM) && Math.abs(angleDeg - 90) < 1e-9 ? [{ type: 'radius', label: radiusM }] : [],
    start: Math.abs(angleDeg - 90) < 1e-9 && isPos(stubM) ? { x: 0, y: 0, headingDeg: -90 } : undefined,
    extra: { shots, perShotDeg: per, spacingM: sp, arcM: arc, startM, angleDeg },
  });
}

/**
 * Concentric 90s: a rack of conduits turning together with the same centre point.
 * Pipe 1 is on the inside. Radius of pipe i = inner radius + (i − 1) × centre spacing.
 * With the pipe ends square to the run, every bend starts the same distance from the end.
 * input: { count, centersM, innerRadiusM, startM, shots?, odM?, topM?, minRadiusM? }
 *   topM: from the inside pipe's centreline (before the bend) to the common top of the risers.
 */
export function concentric90(input, opts = {}) {
  const f = opts.fmt || mmFmt;
  const count = Math.round(input.count || 0);
  const { centersM, innerRadiusM, topM, minRadiusM } = input;
  const startM = isNum(input.startM) ? input.startM : 0;
  const shots = Math.round(isPos(input.shots) ? input.shots : 9);
  need(count >= 2 && count <= 12, 'Enter how many conduits (2 to 12).');
  need(isPos(centersM), 'Enter the centre-to-centre spacing.');
  need(isPos(innerRadiusM), 'Enter the radius of the inside bend.');
  need(shots >= 1 && shots <= 60, 'Use 1 to 60 shots.');
  need(startM >= 0, 'The start of the bend has to be on the pipe.');
  const warnings = [];
  if (isPos(input.odM) && centersM < input.odM) warnings.push(`The centre spacing (${f(centersM)}) is less than the pipe OD (${f(input.odM)}).`);
  if (isPos(minRadiusM) && innerRadiusM < minRadiusM - 1e-6) warnings.push(`The inside radius is under the code minimum for this size (${f(minRadiusM)}, CEC Rule 12-924 and Table 7).`);
  if (isPos(topM) && topM < innerRadiusM) warnings.push('The top is lower than the end of the inside bend.');
  const pipes = Array.from({ length: count }, (_, i) => {
    const radiusM = innerRadiusM + i * centersM;
    const lay = shotLayout(radiusM, 90, shots, startM);
    const legM = isPos(topM) ? Math.max(0, topM - innerRadiusM) : null;
    return {
      index: i + 1, radiusM, arcM: lay.arc, spacingM: lay.sp, perShotDeg: lay.per, shotsAtM: lay.at,
      endM: startM + lay.arc, legM, cutM: legM != null ? startM + lay.arc + legM : null,
    };
  });
  const marks = pipes.flatMap((p) => [
    ...(shots > 1 ? p.shotsAtM.map((m, k) => ({ label: `Pipe ${p.index} shot ${k + 1}`, atM: m, symbol: 'arrow', angleDeg: p.perShotDeg, pipe: p.index })) : []),
    { label: `Pipe ${p.index} end of bend`, atM: p.endM, symbol: 'tick', pipe: p.index },
  ]);
  if (shots === 1) pipes.forEach((p) => marks.push({ label: `Pipe ${p.index} start of bend`, atM: startM, symbol: 'tick', pipe: p.index }));
  const outer = pipes[pipes.length - 1];
  return {
    ...finish('concentric', {
      marks,
      shrinkM: 0,
      developedLengthM: outer.cutM ?? outer.endM,
      warnings,
      degrees: 90,
      figures: [
        { label: 'Inside radius', m: innerRadiusM },
        { label: 'Outside radius', m: outer.radiusM },
        { label: 'Every bend starts at', m: startM },
        { label: 'Shots per bend', text: `${shots} × ${fmtDeg(90 / shots)}` },
      ],
      steps: [
        `Every pipe starts its bend ${f(startM)} from the end, square across the rack.`,
        'Each pipe out adds the centre spacing to the radius, so its bend is longer and its marks farther apart:',
        ...pipes.map((p) => `Pipe ${p.index}: radius ${f(p.radiusM)}, bend uses ${f(p.arcM)}${shots > 1 ? `, ${shots} shots of ${fmtDeg(p.perShotDeg)} every ${f(p.spacingM)} (first at ${f(p.shotsAtM[0])})` : ''}${p.cutM != null ? `, cut ${f(p.cutM)}` : ''}.`),
        'Bend pipe 1 first and use it as the template for the others.',
      ],
      segments: [],
      extra: { pipes, centersM, innerRadiusM, startM, shots, count, topM },
    }),
  };
}

// ---------------------------------------------------------------------------
// Bends between pull points
// ---------------------------------------------------------------------------

export const MAX_DEGREES_BETWEEN_PULL_POINTS = 360;

/**
 * Add up the bends in a run between pull points. The CEC (Rule 12-942) and the NEC (e.g. 358.26,
 * 344.26, 352.26) allow the equivalent of four quarter bends, 360° in total.
 * input: degrees[] -> { totalDeg, quarterBends, leftDeg, ok, warnings }
 */
export function pullCheck(degrees) {
  const list = (degrees || []).map(Number).filter((d) => Number.isFinite(d) && d > 0);
  const totalDeg = list.reduce((s, d) => s + d, 0);
  const ok = totalDeg <= MAX_DEGREES_BETWEEN_PULL_POINTS + 1e-9;
  const warnings = [];
  if (!ok) warnings.push(`${fmtDeg(totalDeg)} between pull points is over the 360° limit (CEC Rule 12-942). Add a pull box or condulet, or take bends out.`);
  else if (totalDeg > 270) warnings.push(`${fmtDeg(totalDeg)} is legal but a hard pull. Use plenty of lubricant, or add a pull point.`);
  return { totalDeg, quarterBends: totalDeg / 90, leftDeg: Math.max(0, MAX_DEGREES_BETWEEN_PULL_POINTS - totalDeg), ok, warnings };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const KINDS = {
  offset: { label: 'Offset', calc: offset },
  kick: { label: 'Kick', calc: kick },
  saddle3: { label: '3-point saddle', calc: saddle3 },
  saddle4: { label: '4-point saddle', calc: saddle4 },
  stub90: { label: '90° stub', calc: stub90 },
  backToBack: { label: 'Back-to-back', calc: backToBack },
  boxOffset: { label: 'Box / bracket', calc: boxOffset },
  rolling: { label: 'Rolling offset', calc: rollingOffset },
  parallel: { label: 'Parallel offsets', calc: parallelOffsets },
  segment: { label: 'Segment bend', calc: segmentBend },
  concentric: { label: 'Concentric 90s', calc: concentric90 },
};

/** compute('offset', inputs, opts) -> result. Throws BendError on bad input. */
export function compute(kind, inputs, opts) {
  const k = KINDS[kind];
  if (!k) throw new BendError(`Unknown bend: ${kind}`);
  return k.calc(inputs || {}, opts);
}
