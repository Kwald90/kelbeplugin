// Run: node --test electrical-app/tests/
// Conduit bending. Expected values are worked by hand in the comments (inches unless noted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../js/lib/bending.js';
import * as P from '../js/lib/bending-profiles.js';
import * as S from '../js/lib/bending-svg.js';
import { inToM, mToIn } from '../js/lib/units.js';

const near = (actual, expected, tol = 1e-3, msg = '') =>
  assert.ok(actual != null && Math.abs(actual - expected) <= tol, `${msg} expected ${expected} ±${tol}, got ${actual}`);
const inch = (m) => mToIn(m);
const at = (r, label) => r.marks.find((m) => m.label === label)?.atM;

test('offset multipliers and shrink per unit for the common angles', () => {
  // csc θ and tan(θ/2): the numbers on every bending chart
  const want = { 10: [5.7588, 0.0875], 22.5: [2.6131, 0.1989], 30: [2.0, 0.2679], 45: [1.4142, 0.4142], 60: [1.1547, 0.5774] };
  for (const row of B.offsetTable()) {
    near(row.multiplier, want[row.angleDeg][0], 1e-4, `multiplier ${row.angleDeg}`);
    near(row.shrinkPerUnit, want[row.angleDeg][1], 1e-4, `shrink ${row.angleDeg}`);
  }
  near(B.multiplier(15), 3.8637, 1e-4); // any angle works
});

test('6" offset at 30°: marks 12" apart, shrink about 1.6"', () => {
  // 6 / sin 30° = 12; 6 × tan 15° = 1.6077
  const r = B.offset({ riseM: inToM(6), angleDeg: 30 });
  near(inch(r.spacingM), 12, 1e-9);
  near(inch(r.shrinkM), 1.6077, 1e-4);
  assert.equal(r.reference, 'mark1');
  near(inch(at(r, 'Mark 2') - at(r, 'Mark 1')), 12, 1e-9);
  assert.equal(r.degrees, 60);
});

test('offset into an obstruction adds the shrink to the far mark', () => {
  // obstruction 36" from the end: mark 2 = 36 + 1.6077 = 37.6077, mark 1 = 25.6077
  const r = B.offset({ riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36), runM: inToM(60) });
  assert.equal(r.reference, 'end');
  near(inch(at(r, 'Mark 1')), 25.6077, 1e-4);
  near(inch(at(r, 'Mark 2')), 37.6077, 1e-4);
  // cut length = run along the wall + shrink = 61.6077
  near(inch(r.developedLengthM), 61.6077, 1e-4);
  // the drawn pipe really rises 6"
  const path = B.tracePath(r.segments, r.start);
  near(inch(path.end[1]), 6, 1e-9);
  near(inch(path.end[0]), 60, 1e-9, 'pipe end lands at the run');
});

test('offset working away from a fixed first bend', () => {
  const r = B.offset({ riseM: inToM(4), angleDeg: 45, firstBendM: inToM(10) });
  near(inch(at(r, 'Mark 1')), 10, 1e-9);
  near(inch(at(r, 'Mark 2')), 10 + 4 * Math.SQRT2, 1e-9);
});

test('offset solves the angle from a fixed mark distance', () => {
  // rise 6, marks 12 apart -> asin(0.5) = 30°; rise 10, 14.142 apart -> 45°
  near(B.angleForSpacing(inToM(6), inToM(12)), 30, 1e-9);
  near(B.angleForSpacing(inToM(10), inToM(10 * Math.SQRT2)), 45, 1e-9);
  const r = B.offset({ riseM: inToM(6), spacingM: inToM(12) });
  near(r.angleDeg, 30, 1e-9);
  assert.throws(() => B.angleForSpacing(inToM(6), inToM(5)), B.BendError);
});

test('offset with no room before the obstruction is refused', () => {
  // 6" at 30° needs 12" before the obstruction: at 5" mark 1 would be off the pipe
  assert.throws(() => B.offset({ riseM: inToM(6), angleDeg: 30, obstacleM: inToM(5) }), /Not enough room/);
  assert.throws(() => B.offset({ riseM: 0, angleDeg: 30 }), B.BendError);
  assert.throws(() => B.offset({ riseM: inToM(6), angleDeg: 90 }), B.BendError);
});

test('kick: mark at rise × multiplier from the end', () => {
  // 3" kick at 30°: mark at 6", run 3 × cot 30° = 5.196, shrink 0.804
  const r = B.kick({ riseM: inToM(3), angleDeg: 30 });
  near(inch(r.marks[0].atM), 6, 1e-9);
  near(inch(r.shrinkM), 6 - 3 * Math.sqrt(3), 1e-9);
  const path = B.tracePath(r.segments, r.start);
  near(inch(path.bends[0].y), -3, 1e-9, 'end sits 3" off the run');
});

test('3-point saddle over a 2" obstruction at 45/22.5', () => {
  // side marks 2 / sin 22.5° = 5.2263 each side; shrink to centre 2 × tan 11.25° = 0.3978 (chart: 3/16 per inch = 0.375)
  // obstruction centre 24" from the end: centre mark 24.3978, side marks 19.1715 and 29.6241
  const r = B.saddle3({ heightM: inToM(2), centerAngleDeg: 45, centerM: inToM(24) });
  near(inch(r.spacingM), 5.2263, 1e-4);
  near(inch(at(r, 'Mark 2')), 24.3978, 1e-4);
  near(inch(at(r, 'Mark 1')), 19.1715, 1e-4);
  near(inch(at(r, 'Mark 3')), 29.6241, 1e-4);
  near(inch(r.shrinkM), 0.7956, 1e-4, 'total shrink, both halves');
  assert.equal(r.marks.find((m) => m.label === 'Mark 2').symbol, 'notch');
  assert.equal(r.degrees, 90);
  assert.ok(r.warnings.some((w) => /2½/.test(w)), 'mentions the 2½ chart rule');
  // the drawn saddle peaks at 2" over the obstruction centre and comes back to the line
  const path = B.tracePath(r.segments, r.start);
  near(inch(path.bends[1].y), 2, 1e-9);
  near(inch(path.bends[1].x), 24, 1e-9);
  near(inch(path.end[1]), 0, 1e-9);
});

test('3-point saddle at 60/30: marks 2 × height, shrink 1/4" per inch to the centre', () => {
  const r = B.saddle3({ heightM: inToM(2), centerAngleDeg: 60, centerM: inToM(24) });
  near(inch(r.spacingM), 4, 1e-9);
  near(inch(at(r, 'Mark 2') - inToM(24)), 2 * Math.tan(Math.PI / 12), 1e-9);
  assert.equal(r.degrees, 120);
  assert.ok(!r.warnings.some((w) => /2½/.test(w)));
});

test('4-point saddle', () => {
  // 4" high, 10" wide, 30°, near edge 50" from the end. Offset 8", shrink 4 tan 15° = 1.0718 each.
  // marks 43.0718, 51.0718, 61.0718, 69.0718; total shrink 2.1436
  const r = B.saddle4({ heightM: inToM(4), widthM: inToM(10), angleDeg: 30, obstacleM: inToM(50) });
  const marks = r.marks.map((m) => inch(m.atM));
  [43.0718, 51.0718, 61.0718, 69.0718].forEach((v, i) => near(marks[i], v, 1e-4, `mark ${i + 1}`));
  near(inch(r.shrinkM), 2.1436, 1e-4);
  assert.equal(r.degrees, 120);
  const path = B.tracePath(r.segments, r.start);
  near(inch(path.bends[1].x), 50, 1e-9, 'top of first offset at the near edge');
  near(inch(path.bends[2].x), 60, 1e-9, 'starts down at the far edge');
  near(inch(path.end[1]), 0, 1e-9);
});

test('90° stub: 10" stub with a 5" take-up marks at 5"', () => {
  const r = B.stub90({ stubM: inToM(10), takeUpM: inToM(5) });
  assert.equal(r.marks.length, 1);
  near(inch(r.marks[0].atM), 5, 1e-9);
  assert.equal(r.marks[0].symbol, 'arrow');
  assert.equal(r.degrees, 90);
  assert.throws(() => B.stub90({ stubM: inToM(4), takeUpM: inToM(5) }), /shorter than the take-up/);
});

test('90° cut length with gain', () => {
  // legs 10 and 20 to the back, gain 2 5/8: cut 27 3/8
  const r = B.stub90({ stubM: inToM(10), takeUpM: inToM(5), otherLegM: inToM(20), gainM: inToM(2.625) });
  near(inch(r.developedLengthM), 27.375, 1e-9);
  near(inch(B.cutLength90({ leg1M: inToM(10), leg2M: inToM(20), gainM: inToM(2.625) })), 27.375, 1e-9);
});

test('gain and take-up from the radius', () => {
  // gain = r(2 − π/2) + OD = 4 × 0.42920 + 0.706 = 2.4228
  near(inch(B.gain90({ radiusM: inToM(4), odM: inToM(0.706) })), 2.4228, 1e-4);
  near(inch(B.takeUpFromRadius({ radiusM: inToM(4), odM: inToM(0.706) })), 4.353, 1e-9);
  // developed length of a 90 = 1.5708 × radius
  near(inch(B.arcLength(inToM(10), 90)), 15.708, 1e-3);
});

test('90 laid out from the radius (PVC): bend starts at stub − radius − OD/2', () => {
  // 21 (3/4") PVC, OD 1.050, radius 5": 18" stub -> start 12.475, bend uses 7.854
  const r = B.stub90({ stubM: inToM(18), radiusM: inToM(5), odM: inToM(1.05), heat: true });
  near(inch(at(r, 'Start of heat')), 12.475, 1e-9);
  near(inch(at(r, 'End of heat') - at(r, 'Start of heat')), 7.854, 1e-3);
  // the drawing's back of bend sits 18" below the end
  const path = B.tracePath(r.segments, r.start);
  const lowest = Math.min(...path.points.map((p) => p[1]));
  near(inch(lowest) - 0.525, -18, 1e-6);
});

test('back-to-back 90s', () => {
  // stub 10, 30 across the backs, take-up 5, gain 2.5: mark 1 at 5, mark 2 at 10 + 30 − 2.5 = 37.5
  // second stub 12: cut 10 + 30 + 12 − 5 = 47
  const r = B.backToBack({ stubM: inToM(10), backToBackM: inToM(30), secondStubM: inToM(12), takeUpM: inToM(5), gainM: inToM(2.5) });
  near(inch(at(r, 'Mark 1')), 5, 1e-9);
  near(inch(at(r, 'Mark 2')), 37.5, 1e-9);
  assert.equal(r.marks[1].symbol, 'star');
  near(inch(r.developedLengthM), 47, 1e-9);
  assert.equal(r.degrees, 180);
  // drawn with a real radius, the second riser sits D − OD from the first (centrelines)
  const g = B.backToBack({ stubM: inToM(10), backToBackM: inToM(30), takeUpM: inToM(5), radiusM: inToM(4), odM: inToM(0.706) });
  const path = B.tracePath(g.segments, g.start);
  near(inch(path.end[0]), 30 - 0.706, 1e-6);
  assert.throws(() => B.backToBack({ stubM: inToM(10), backToBackM: inToM(30), takeUpM: inToM(5) }), /gain/);
});

test('box offset: marks from the box end, small rise', () => {
  // 1/2" at 10°: 0.5 × 5.7588 = 2.8794 apart; straight 1.5 -> marks 1.5 and 4.3794
  const r = B.boxOffset({ riseM: inToM(0.5), angleDeg: 10, straightM: inToM(1.5) });
  near(inch(at(r, 'Mark 1')), 1.5, 1e-9);
  near(inch(at(r, 'Mark 2')), 4.3794, 1e-4);
  near(inch(r.shrinkM), 0.5 * Math.tan(Math.PI / 36), 1e-9);
  // bracket mode is an offset into the bracket
  const b = B.boxOffset({ target: 'bracket', riseM: inToM(2), angleDeg: 22.5, obstacleM: inToM(30) });
  assert.equal(b.kind, 'boxOffset');
  near(inch(at(b, 'Mark 2')), 30 + 2 * Math.tan((11.25 * Math.PI) / 180), 1e-9);
});

test('rolling offset: true offset is the hypotenuse', () => {
  // rise 6, roll 8 -> true 10; at 45° marks 14.142 apart, shrink 4.142; roll the pipe atan(8/6) = 53.13°
  const r = B.rollingOffset({ riseM: inToM(6), rollM: inToM(8), angleDeg: 45, obstacleM: inToM(40) });
  near(inch(r.trueM), 10, 1e-9);
  near(r.rollDeg, 53.1301, 1e-4);
  near(inch(r.spacingM), 14.1421, 1e-4);
  near(inch(r.shrinkM), 4.1421, 1e-4);
  assert.equal(r.kind, 'rolling');
});

test('parallel offsets shift each pipe by spacing × tan(θ/2)', () => {
  // 3 pipes 2" centres, 6" offset at 30°: shift 2 tan 15° = 0.5359 per pipe
  const r = B.parallelOffsets({ riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36), count: 3, centersM: inToM(2), odM: inToM(0.922) });
  near(inch(r.adjustM), 0.5359, 1e-4);
  assert.equal(r.pipes.length, 3);
  near(inch(r.pipes[2].marks[0].atM - r.pipes[0].marks[0].atM), 1.0718, 1e-4);
  near(inch(r.pipes[2].marks[1].atM - r.pipes[2].marks[0].atM), 12, 1e-9, 'spacing between marks is the same on every pipe');
  assert.equal(r.marks.length, 6);
  assert.equal(r.degrees, 60);
  const tight = B.parallelOffsets({ riseM: inToM(6), angleDeg: 30, count: 2, centersM: inToM(0.5), odM: inToM(0.922) });
  assert.ok(tight.warnings.some((w) => /less than the pipe OD/.test(w)));
});

test('parallel offset geometry: the shifted bends keep the pipes parallel', () => {
  // Trace pipe 1 at y = 0 and pipe 2 at y = −C; after the offset they are still C apart and their
  // sloped legs are C apart too.
  const C = 0.05;
  const r = B.parallelOffsets({ riseM: 0.15, angleDeg: 45, firstBendM: 0.3, count: 2, centersM: C });
  const leg = (p) => [{ straightM: p.marks[0].atM }, { bendDeg: 45 }, { straightM: p.marks[1].atM - p.marks[0].atM }, { bendDeg: -45 }, { straightM: 0.2 }];
  const a = B.tracePath(leg(r.pipes[0]), { x: 0, y: 0 });
  const b = B.tracePath(leg(r.pipes[1]), { x: 0, y: -C });
  near(a.bends[1].y - b.bends[1].y, C, 1e-9);
  // perpendicular distance between the sloped legs: (Δx, Δy)·(−sin45, cos45)
  const dx = a.bends[0].x - b.bends[0].x, dy = a.bends[0].y - b.bends[0].y;
  near(-dx * Math.SQRT1_2 + dy * Math.SQRT1_2, C, 1e-9);
});

test('segment bend: shots at the middle of equal spaces', () => {
  // 30" radius 90 on 2" rigid (OD 2.375), 48" stub, 10 shots
  // start = 48 − 30 − 1.1875 = 16.8125; arc = 47.1239; spacing 4.7124; first shot 19.1687
  const r = B.segmentBend({ radiusM: inToM(30), angleDeg: 90, shots: 10, stubM: inToM(48), odM: inToM(2.375) });
  near(inch(r.startM), 16.8125, 1e-9);
  near(inch(r.arcM), 47.1239, 1e-4);
  near(inch(r.spacingM), 4.7124, 1e-4);
  near(inch(at(r, 'Shot 1')), 19.1687, 1e-4);
  near(inch(at(r, 'Shot 10')), 16.8125 + 47.1239 - 2.3562, 1e-4);
  assert.equal(r.perShotDeg, 9);
  assert.equal(r.degrees, 90);
  near(inch(r.developedLengthM), 16.8125 + 47.1239, 1e-4);
  // the drawn polygon turns 90° in total
  const path = B.tracePath(r.segments, r.start);
  near(path.headingDeg, 0, 1e-9);
  // shots from maxShotDeg: 45° at no more than 10° a shot -> 5 shots
  assert.equal(B.segmentBend({ radiusM: 1, angleDeg: 45, maxShotDeg: 10 }).shots, 5);
  const small = B.segmentBend({ radiusM: inToM(10), angleDeg: 90, shots: 4, minRadiusM: inToM(13) });
  assert.ok(small.warnings.some((w) => /code minimum/.test(w)));
  assert.ok(small.warnings.some((w) => /a shot is a lot/.test(w)));
});

test('concentric 90s: radius grows by the centre spacing, bends start together', () => {
  // inner radius 20, 4" centres, 3 pipes: radii 20, 24, 28; arcs 31.416, 37.699, 43.982
  const r = B.concentric90({ count: 3, centersM: inToM(4), innerRadiusM: inToM(20), startM: inToM(10), shots: 9, topM: inToM(40) });
  const radii = r.pipes.map((p) => inch(p.radiusM));
  [20, 24, 28].forEach((v, i) => near(radii[i], v, 1e-9));
  const arcs = r.pipes.map((p) => inch(p.arcM));
  [31.4159, 37.6991, 43.9823].forEach((v, i) => near(arcs[i], v, 1e-4));
  // every first shot is half a space past the common start
  r.pipes.forEach((p) => near(p.shotsAtM[0], inToM(10) + p.spacingM / 2, 1e-12));
  // cut length: start + arc + (top − inner radius) = 10 + arc + 20
  near(inch(r.pipes[0].cutM), 61.4159, 1e-4);
  near(inch(r.developedLengthM), 73.9823, 1e-4, 'outer pipe is the longest');
});

test('cumulative degrees between pull points', () => {
  const ok = B.pullCheck([90, 90, 45, 45, 30, 30, 22.5]);
  near(ok.totalDeg, 352.5, 1e-9);
  assert.equal(ok.ok, true);
  near(ok.leftDeg, 7.5, 1e-9);
  const over = B.pullCheck([90, 90, 90, 90, 10]);
  assert.equal(over.ok, false);
  assert.ok(over.warnings[0].includes('12-942'));
  assert.equal(B.pullCheck([90, 90, 90, 90]).ok, true, 'exactly 360° is allowed');
});

test('tracePath draws arcs with the right radius and heading', () => {
  // from (0,0) heading +x, a 90° left turn of radius 1 ends at (1, 1) heading +y
  const p = B.tracePath([{ bendDeg: 90, radiusM: 1 }]);
  near(p.end[0], 1, 1e-12);
  near(p.end[1], 1, 1e-12);
  near(p.headingDeg, 90, 1e-12);
  // a right turn goes the other way
  const q = B.tracePath([{ bendDeg: -90, radiusM: 1 }]);
  near(q.end[1], -1, 1e-12);
  near(B.developedLength([{ straightM: 2 }, { bendDeg: 90, radiusM: 1 }, { straightM: 3 }]), 5 + Math.PI / 2, 1e-12);
});

test('trade sizes and outside diameters', () => {
  assert.equal(B.tradeSizeLabel('16'), '16 (1/2")');
  assert.equal(B.tradeSizeLabel('35'), '35 (1-1/4")');
  near(inch(B.conduitOD('EMT', '21')), 0.922, 1e-9);
  near(inch(B.conduitOD('RMC', '53')), 2.375, 1e-9);
  near(inch(B.conduitOD('PVC', '27')), 1.315, 1e-9);
  assert.equal(B.conduitOD('EMT', '99'), null);
});

test('saved record keeps only the contract fields', () => {
  const r = B.offset({ riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36) });
  const rec = B.toRecordResult(r);
  assert.deepEqual(Object.keys(rec).sort(), ['developedLengthM', 'marks', 'shrinkM', 'warnings']);
  assert.deepEqual(Object.keys(rec.marks[0]).sort(), ['atM', 'label']);
  assert.match(rec.marks[1].label, /Mark 2 · 30° · roll 180°/);
});

test('every kind computes through the dispatcher with a formatter', () => {
  const fmt = (m) => `${(m / 0.0254).toFixed(2)}in`;
  const cases = {
    offset: { riseM: 0.15, angleDeg: 30, obstacleM: 1 },
    kick: { riseM: 0.08, angleDeg: 22.5 },
    saddle3: { heightM: 0.05, centerM: 0.8 },
    saddle4: { heightM: 0.1, widthM: 0.3, obstacleM: 1 },
    stub90: { stubM: 0.3, takeUpM: 0.127 },
    backToBack: { stubM: 0.3, backToBackM: 0.9, takeUpM: 0.127, gainM: 0.06 },
    boxOffset: { riseM: 0.013 },
    rolling: { riseM: 0.1, rollM: 0.1, angleDeg: 45 },
    parallel: { riseM: 0.15, angleDeg: 30, count: 3, centersM: 0.05 },
    segment: { radiusM: 0.75, stubM: 1.2, shots: 10 },
    concentric: { count: 3, centersM: 0.1, innerRadiusM: 0.5, startM: 0.3 },
  };
  for (const [kind, input] of Object.entries(cases)) {
    const r = B.compute(kind, input, { fmt });
    assert.ok(r.marks.length > 0, kind);
    assert.ok(r.marks.every((m) => Number.isFinite(m.atM) && m.atM >= 0), `${kind} marks on the pipe`);
    assert.ok(r.steps.length > 0 && r.steps.every((s) => typeof s === 'string'), `${kind} steps`);
    assert.ok(r.steps.join(' ').includes('in'), `${kind} steps use the formatter`);
    for (let i = 1; i < r.marks.length; i++) {
      const [a, b] = [r.marks[i - 1], r.marks[i]];
      assert.ok((b.pipe || 0) > (a.pipe || 0) || b.atM >= a.atM, `${kind} marks sorted by pipe, then along the pipe`);
    }
  }
  assert.throws(() => B.compute('nope', {}), B.BendError);
});

// ---------------------------------------------------------------------------
// Bender chart numbers, profiles and calibration
// ---------------------------------------------------------------------------

test('chart numbers match what is printed on the bender', () => {
  // 6" at 30°: 2 × 6 = 12, shrink 1/4 per inch = 1.5
  const r = B.offset({ riseM: inToM(6), angleDeg: 30 }, { chart: true });
  near(inch(r.spacingM), 12, 1e-9);
  near(inch(r.shrinkM), 1.5, 1e-9);
  // 2" at 10°: 6 × 2 = 12, shrink 1/16 × 2 = 1/8
  const t = B.offset({ riseM: inToM(2), angleDeg: 10 }, { chart: true });
  near(inch(t.spacingM), 12, 1e-9);
  near(inch(t.shrinkM), 0.125, 1e-9);
  // an angle not on the chart falls back to the exact figure
  near(B.offset({ riseM: 1, angleDeg: 15 }, { chart: true }).spacingM, B.multiplier(15), 1e-12);
  // 3-point saddle 2" at 45: side marks 2½ × 2 = 5, centre shrink 3/16 × 2 = 3/8
  const s = B.saddle3({ heightM: inToM(2), centerAngleDeg: 45, centerM: inToM(24) }, { chart: true });
  near(inch(s.spacingM), 5, 1e-9);
  near(inch(at(s, 'Mark 2')), 24.375, 1e-9);
  assert.ok(!s.warnings.some((w) => /2½/.test(w)));
  assert.ok(s.figures.some((f) => f.label === 'Exact geometry'));
  const table = B.offsetTable();
  assert.equal(table.find((x) => x.angleDeg === 60).chartMultiplier, 1.2);
});

test('mark names from the bender go into the steps', () => {
  const r = B.saddle3({ heightM: inToM(2), centerM: inToM(24) }, { names: { centre: 'rim notch' } });
  assert.ok(r.steps.some((s) => s.includes('on the rim notch')));
  const b = B.backToBack({ stubM: inToM(10), backToBackM: inToM(30), takeUpM: inToM(5), gainM: inToM(2.5) }, { names: { star: 'star point' } });
  assert.ok(b.steps.some((s) => s.includes('on the star point')));
});

test('hand bender defaults: published take-up and radius', () => {
  // take-up 5, 6, 8, 11 for 16-35 EMT; rigid 16 shares the 21 EMT shoe (6")
  const tu = (type, size) => inch(P.DEFAULT_PROFILES.find((p) => p.conduitType === type && p.tradeSize === size && p.brand === 'Klein').takeUpM);
  near(tu('EMT', '16'), 5, 1e-9);
  near(tu('EMT', '21'), 6, 1e-9);
  near(tu('EMT', '27'), 8, 1e-9);
  near(tu('EMT', '35'), 11, 1e-9);
  near(tu('RMC', '16'), 6, 1e-9);
  near(tu('IMC', '27'), 11, 1e-9);
  // 16 EMT radius 4 3/16; gain = 4.1875 × (2 − π/2) + 0.706 = 2.5033
  const g = P.DEFAULT_PROFILES.find((p) => p.id === 'std:greenlee:EMT:16');
  near(inch(g.minRadiusM), 4.1875, 1e-9);
  near(inch(g.gainM), 2.5033, 1e-4);
  assert.equal(g.backToBackMark, 'star mark');
  assert.ok(g.notes.includes('own bender'));
  // every built-in has a unique id and the contract fields
  const ids = new Set(P.DEFAULT_PROFILES.map((p) => p.id));
  assert.equal(ids.size, P.DEFAULT_PROFILES.length);
  for (const p of P.DEFAULT_PROFILES) {
    for (const k of ['name', 'brand', 'model', 'conduitType', 'tradeSize', 'takeUpM', 'gainM', 'backToBackMark', 'centreMark', 'minRadiusM', 'isDefault', 'notes']) assert.ok(k in p, `${p.id} has ${k}`);
    assert.ok(p.takeUpM != null || p.minRadiusM != null, `${p.id} can lay out a 90`);
  }
});

test('larger benders: published deducts, one-shot shoes by radius', () => {
  const p = P.findProfile('std:greenlee-555c:EMT:53');
  near(inch(p.takeUpM), 15.375, 1e-9);
  near(inch(p.minRadiusM), 9.25, 1e-9);
  const shoe = P.findProfile('std:greenlee-881ct:RMC:103');
  assert.equal(shoe.takeUpM, null);
  // a 90 on it is laid out from the radius: 60" stub, R 20 7/8, OD 4.5 -> start 36.875
  const r = B.stub90({ stubM: inToM(60), radiusM: shoe.minRadiusM, odM: B.conduitOD('RMC', '103') });
  near(inch(at(r, 'Start of bend')), 60 - 20.875 - 2.25, 1e-9);
});

test('profiles for a pipe: the user first, their default wins', () => {
  const mine = [
    { id: 'u1', conduitType: 'EMT', tradeSize: '21', takeUpM: 0.15, isDefault: false },
    { id: 'u2', conduitType: 'EMT', tradeSize: '21', takeUpM: 0.152, isDefault: true },
    { id: 'u3', conduitType: 'EMT', tradeSize: '16', takeUpM: 0.127, isDefault: true },
  ];
  const list = P.profilesFor('EMT', '21', mine);
  assert.deepEqual(list.slice(0, 2).map((p) => p.id), ['u1', 'u2']);
  assert.ok(list.length > 2);
  assert.equal(P.pickProfile('EMT', '21', mine).id, 'u2');
  assert.equal(P.pickProfile('EMT', '21', mine, 'std:ideal:EMT:21').id, 'std:ideal:EMT:21');
  assert.equal(P.pickProfile('EMT', '21', []).builtIn, true);
  assert.equal(P.pickProfile('EMT', '103', []), null, 'no hand bender for 4" EMT');
});

test('code minimum radius', () => {
  near(P.minBendRadius('EMT', '16'), 0.102, 1e-12); // CEC Table 7
  near(P.minBendRadius('RMC', '103'), 0.406, 1e-12);
  near(inch(P.minBendRadius('PVC', '53')), 12, 1e-9); // PVC field bends: 6 × trade size
  assert.equal(P.minBendRadius('EMT', '12'), null);
});

test('diagrams: every kind draws, one line per mark, text escaped', () => {
  const fmt = (m) => `${(m / 0.0254).toFixed(1)}"`; // quotes must be escaped in the SVG
  const cases = {
    offset: { riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36) },
    kick: { riseM: inToM(3), angleDeg: 22.5 },
    saddle3: { heightM: inToM(2), centerM: inToM(24) },
    saddle4: { heightM: inToM(4), widthM: inToM(10) },
    stub90: { stubM: inToM(10), takeUpM: inToM(5), radiusM: inToM(4.1875), odM: inToM(0.706), otherLegM: inToM(30) },
    backToBack: { stubM: inToM(10), backToBackM: inToM(30), takeUpM: inToM(5), radiusM: inToM(4.1875), odM: inToM(0.706) },
    boxOffset: { riseM: inToM(0.5) },
    rolling: { riseM: inToM(6), rollM: inToM(8), angleDeg: 45, obstacleM: inToM(40) },
    parallel: { riseM: inToM(6), angleDeg: 30, count: 3, centersM: inToM(2), obstacleM: inToM(36) },
    segment: { radiusM: inToM(30), stubM: inToM(48), shots: 10, odM: inToM(2.375) },
    concentric: { count: 3, centersM: inToM(4), innerRadiusM: inToM(20), startM: inToM(12), shots: 9 },
  };
  for (const [kind, input] of Object.entries(cases)) {
    const r = B.compute(kind, input, { fmt });
    const bent = S.bentSvg(r, { fmt, width: 480, odM: input.odM || 0 });
    const straight = S.marksSvg(r, { fmt, width: 480 });
    for (const svg of [bent, straight]) {
      assert.match(svg, /^<svg class="bend-svg" viewBox="0 0 480 \d+"/, kind);
      assert.ok(!/NaN|undefined/.test(svg), `${kind} has no NaN`);
      assert.ok(!/>[^<]*"[^<]*</.test(svg), `${kind} escapes quotes in text`);
    }
    const lines = (straight.match(/class="bd-markline"/g) || []).length;
    assert.equal(lines, r.marks.filter((m) => m.symbol !== 'tick').length, `${kind} one line per mark`);
  }
  const par = S.marksSvg(B.compute('parallel', cases.parallel, { fmt }), { fmt });
  assert.ok(par.includes('Pipe 3'), 'one row per pipe');
  assert.ok(S.rollSvg(B.compute('rolling', cases.rolling, { fmt }), { fmt }).includes('53.1° from up'));
  // the star shows on a back-to-back's second mark
  assert.ok(S.marksSvg(B.compute('backToBack', cases.backToBack, { fmt }), { fmt }).includes('<polygon class="bd-sym"'));
});

test('calibrate: take-up and gain from one test 90', () => {
  // marked at 12" and 30"; stub measured 17 1/8", other leg (back of 90 to the 30" mark) 15 3/8"
  // take-up = 17.125 − 12 = 5.125; gain = 17.125 + 15.375 − 30 = 2.5
  const c = P.calibrate({ markM: inToM(12), stubM: inToM(17.125), mark2M: inToM(30), legM: inToM(15.375) });
  near(inch(c.takeUpM), 5.125, 1e-9);
  near(inch(c.gainM), 2.5, 1e-9);
  assert.deepEqual(c.warnings, []);
  assert.equal(P.calibrate({ markM: inToM(12), stubM: inToM(17) }).gainM, null);
  assert.throws(() => P.calibrate({ markM: inToM(12), stubM: inToM(10) }), /back of the bend/);
  assert.ok(P.calibrate({ markM: inToM(12), stubM: inToM(17), mark2M: inToM(30), legM: inToM(10) }).warnings.length);
});

// ---------------------------------------------------------------------------
// Animated bend visual (animatedBendSvg)
// ---------------------------------------------------------------------------

const fmtIn = (m) => `${(m / 0.0254).toFixed(1)}"`;
const animCases = {
  offset: { riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36) },
  kick: { riseM: inToM(3), angleDeg: 22.5 },
  saddle3: { heightM: inToM(2), centerM: inToM(24) },
  saddle4: { heightM: inToM(4), widthM: inToM(10) },
  stub90: { stubM: inToM(10), takeUpM: inToM(5), radiusM: inToM(4.1875), odM: inToM(0.706) },
  backToBack: { stubM: inToM(10), backToBackM: inToM(30), takeUpM: inToM(5), radiusM: inToM(4.1875), odM: inToM(0.706) },
  boxOffset: { riseM: inToM(0.5) },
  rolling: { riseM: inToM(6), rollM: inToM(8), angleDeg: 45, obstacleM: inToM(40) },
  parallel: { riseM: inToM(6), angleDeg: 30, count: 3, centersM: inToM(2), obstacleM: inToM(36) },
  segment: { radiusM: inToM(30), stubM: inToM(48), shots: 10, odM: inToM(2.375) },
  concentric: { count: 3, centersM: inToM(4), innerRadiusM: inToM(20), startM: inToM(12), shots: 9 },
};
// every value in a SMIL points animation must have the same coordinate count, or Chrome won't tween
const pointCounts = (values) => values.split(';').map((v) => v.trim().split(/\s+/).length);
const firstPoints = (svg, cls) => (svg.match(new RegExp(`<polyline class="${cls}"[^>]*?points="([^"]*)"`)) || [])[1];

test('animated bend: every kind makes a valid, animated SVG that forms the shape', () => {
  for (const [kind, input] of Object.entries(animCases)) {
    const r = B.compute(kind, input, { fmt: fmtIn });
    const svg = S.animatedBendSvg(r, { fmt: fmtIn, width: 480, odM: input.odM || 0 });
    assert.match(svg, /^<svg class="bend-svg" viewBox="0 0 480 \d+"/, kind);
    assert.ok(!/NaN|undefined/.test(svg), `${kind} has no NaN/undefined`);
    assert.ok(!/>[^<]*"[^<]*</.test(svg), `${kind} escapes quotes in text`);
    // the pipe animates its points, the labels fade in, and the trigger is findable
    assert.ok(/<animate class="bd-anim" attributeName="points"/.test(svg), `${kind} animates the pipe points`);
    assert.ok(/<animate class="bd-anim" attributeName="opacity"/.test(svg), `${kind} fades the labels in`);
    // CSP: no inline style attribute, no script, SMIL only
    assert.ok(!/\sstyle=/.test(svg), `${kind} uses no inline style`);
    assert.ok(!/<script/i.test(svg), `${kind} has no script`);
    // the pipe moves: the first frame differs from the last (the finished) frame
    const vals = (svg.match(/attributeName="points"[^>]*values="([^"]*)"/) || [])[1];
    const frames = vals.split(';');
    assert.ok(frames.length >= 2, `${kind} has several frames`);
    assert.notEqual(frames[0], frames[frames.length - 1], `${kind} forms (start !== end)`);
    // every frame has the same number of points, so the tween is smooth
    const counts = pointCounts(vals);
    assert.ok(counts.every((c) => c === counts[0]), `${kind} frames keep a constant point count`);
  }
});

test('animated bend: the finished frame equals the static diagram, and reduced motion drops the motion', () => {
  for (const [kind, input] of Object.entries(animCases)) {
    const r = B.compute(kind, input, { fmt: fmtIn });
    const bent = S.bentSvg(r, { fmt: fmtIn, width: 480, odM: input.odM || 0 });
    const reduced = S.animatedBendSvg(r, { fmt: fmtIn, width: 480, odM: input.odM || 0, reduced: true });
    // reduced motion: no animation at all, and the pipe sits on the finished shape, same as bentSvg
    assert.ok(!/<animate/.test(reduced), `${kind} reduced motion has no <animate>`);
    assert.equal(firstPoints(reduced, 'bd-pipe'), firstPoints(bent, 'bd-pipe'), `${kind} reduced frame == static diagram`);
    // the animation rests on the finished shape: the polyline's base points equal its last frame,
    // so with no script run (or once play ends and freezes) it shows the finished bend
    const anim = S.animatedBendSvg(r, { fmt: fmtIn, width: 480, odM: input.odM || 0 });
    const vals = (anim.match(/attributeName="points"[^>]*values="([^"]*)"/) || [])[1].split(';');
    assert.equal(firstPoints(anim, 'bd-pipe'), vals[vals.length - 1], `${kind} rests on its finished frame`);
  }
});

test('animated bend: a still at 0 is flatter than the finished bend; stills reflect progress', () => {
  const r = B.compute('offset', animCases.offset, { fmt: fmtIn });
  const flat = S.animatedBendSvg(r, { fmt: fmtIn, width: 480, still: 0 });
  const done = S.animatedBendSvg(r, { fmt: fmtIn, width: 480, still: 1 });
  assert.ok(!/<animate/.test(flat) && !/<animate/.test(done), 'stills carry no motion');
  const ys = (pts) => pts.split(/\s+/).map((p) => Number(p.split(',')[1]));
  const spread = (pts) => { const v = ys(pts); return Math.max(...v) - Math.min(...v); };
  assert.ok(spread(firstPoints(flat, 'bd-pipe')) < spread(firstPoints(done, 'bd-pipe')), 'the flat still rises less than the finished bend');
  // the finished still matches the static diagram
  assert.equal(firstPoints(done, 'bd-pipe'), firstPoints(S.bentSvg(r, { fmt: fmtIn, width: 480 }), 'bd-pipe'));
});

test('animated bend: the picture reflects the inputs (the measured rise is drawn and labelled)', () => {
  const mm = (m) => `${Math.round(m * 1000)}mm`; // avoids the escaped inch quote, to keep the assert simple
  const svgFor = (riseIn) => S.animatedBendSvg(B.compute('offset', { riseM: inToM(riseIn), angleDeg: 30 }, { fmt: mm }), { fmt: mm, width: 480 });
  const shallow = svgFor(3), deep = svgFor(9);
  assert.notEqual(shallow, deep, 'different rises draw differently');
  assert.ok(shallow.includes('76mm'), 'the 3" (76 mm) rise is labelled on the picture');
  assert.ok(deep.includes('229mm'), 'the 9" (229 mm) rise is labelled on the picture');
  // a steeper angle makes a visibly different shape too (the bends move closer together)
  const steep = S.animatedBendSvg(B.compute('offset', { riseM: inToM(6), angleDeg: 45 }, { fmt: mm }), { fmt: mm, width: 480 });
  const shallowA = S.animatedBendSvg(B.compute('offset', { riseM: inToM(6), angleDeg: 22.5 }, { fmt: mm }), { fmt: mm, width: 480 });
  assert.notEqual(steep, shallowA, 'the angle changes the drawing');
});

test('animated bend: every shade layer of every pipe animates together', () => {
  const r = B.compute('parallel', animCases.parallel, { fmt: fmtIn });
  const svg = S.animatedBendSvg(r, { fmt: fmtIn, width: 480 });
  const pointAnims = (svg.match(/attributeName="points"/g) || []).length;
  assert.equal(pointAnims, r.pipes.length * S.pipeLayers(10).length, 'each shade layer animates for each pipe');
});

// ---------------------------------------------------------------------------
// Layout: labels never collide, the pipe clears the obstruction, nothing is cropped
// ---------------------------------------------------------------------------
// The renderers return their scene (bentLayout, animatedBendLayout, marksLayout, rollLayout): every
// label with its box (S.textBox: characters × font size, one approximation used everywhere), every
// element's box, the drawn pipe centrelines with their outside half-width, and the obstruction.

const OD = inToM(0.922); // 3/4" EMT
const R = inToM(5.13);   // its hand bender's centreline radius
const fmtLay = (m) => `${(m / 0.0254).toFixed(2).replace(/\.?0+$/, '')}"`;

/** A sweep of inputs per bend kind, across the ranges the screen allows. */
function layoutCases() {
  const out = [];
  const add = (kind, input) => out.push([kind, input]);
  for (const rise of [1, 6, 24]) for (const a of [10, 30, 60]) for (const m of [{}, { obstacleM: inToM(36) }, { firstBendM: inToM(12) }]) for (const r of [0, R]) add('offset', { riseM: inToM(rise), angleDeg: a, ...m, radiusM: r || undefined, odM: OD });
  for (const rise of [1, 8]) for (const a of [10, 22.5, 45]) add('kick', { riseM: inToM(rise), angleDeg: a, radiusM: R, odM: OD });
  for (const ht of [0.5, 2, 6]) for (const c of [20, 45, 60]) for (const m of [{}, { centerM: inToM(24) }]) for (const r of [0, R]) add('saddle3', { heightM: inToM(ht), centerAngleDeg: c, ...m, radiusM: r || undefined, odM: OD });
  for (const ht of [1, 4, 8]) for (const w of [4, 30]) for (const a of [22.5, 30, 45]) for (const m of [{}, { obstacleM: inToM(36) }]) add('saddle4', { heightM: inToM(ht), widthM: inToM(w), angleDeg: a, ...m, radiusM: R, odM: OD });
  for (const s of [6, 24, 60]) {
    for (const o of [{}, { otherLegM: inToM(30) }]) {
      add('stub90', { stubM: inToM(s), takeUpM: inToM(5), radiusM: inToM(4.1875), odM: inToM(0.706), ...o });
      add('stub90', { stubM: inToM(s), radiusM: inToM(5), odM: inToM(1.05), heat: true, ...o });
    }
  }
  for (const bb of [12, 30, 80]) add('backToBack', { stubM: inToM(10), backToBackM: inToM(bb), takeUpM: inToM(5), radiusM: inToM(4.1875), odM: inToM(0.706) });
  for (const r of [0.25, 1]) for (const a of [10, 30]) add('boxOffset', { riseM: inToM(r), angleDeg: a, radiusM: R, odM: OD });
  add('boxOffset', { target: 'bracket', riseM: inToM(1.5), angleDeg: 22.5, obstacleM: inToM(24), radiusM: R, odM: OD });
  for (const [ri, ro] of [[2, 3], [12, 4]]) for (const m of [{}, { obstacleM: inToM(40) }]) add('rolling', { riseM: inToM(ri), rollM: inToM(ro), angleDeg: 45, ...m, radiusM: R, odM: OD });
  for (const n of [2, 6]) for (const a of [22.5, 45]) for (const m of [{}, { obstacleM: inToM(36) }]) add('parallel', { riseM: inToM(6), angleDeg: a, count: n, centersM: inToM(2), ...m, radiusM: R, odM: OD });
  for (const a of [30, 90]) {
    for (const sh of [2, 4, 20]) {
      add('segment', a === 90
        ? { radiusM: inToM(30), angleDeg: a, shots: sh, stubM: inToM(60), odM: inToM(2.375) }
        : { radiusM: inToM(30), angleDeg: a, shots: sh, startM: inToM(12), odM: inToM(2.375) });
    }
  }
  for (const n of [2, 6]) for (const sh of [1, 9]) add('concentric', { count: n, centersM: inToM(4), innerRadiusM: inToM(20), startM: inToM(12), shots: sh, odM: inToM(2.375) });
  return out;
}

// Independent geometry for the checks (not the renderer's own helpers).
const toBox = (x, y, b) => Math.hypot(Math.max(b.x0 - x, 0, x - b.x1), Math.max(b.y0 - y, 0, y - b.y1));
/** Smallest gap between a drawn pipe (centreline ± halfW) and a rect or circle (negative = overlap). */
function pipeGap(pipe, shape) {
  let best = Infinity;
  for (let k = 1; k < pipe.points.length; k++) {
    const [ax, ay] = pipe.points[k - 1], [bx, by] = pipe.points[k];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.5));
    for (let j = 0; j <= n; j++) {
      const x = ax + ((bx - ax) * j) / n, y = ay + ((by - ay) * j) / n;
      const inside = shape.shape !== 'circle' && x >= shape.x0 && x <= shape.x1 && y >= shape.y0 && y <= shape.y1;
      const d = shape.shape === 'circle' ? Math.hypot(x - shape.cx, y - shape.cy) - shape.r : inside ? -1 : toBox(x, y, shape);
      best = Math.min(best, d);
    }
  }
  return best - pipe.halfW;
}
const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

function checkLayout(L, name, { result, hero = false }) {
  const [, , vw, vh] = L.viewBox;
  assert.equal(vw, L.width, `${name}: fits the width, not scaled down`);
  // no two labels touch, whatever they are: marks, dimensions, angles, titles, END, warnings
  for (let i = 0; i < L.labels.length; i++) {
    for (let j = i + 1; j < L.labels.length; j++) {
      const a = L.labels[i], b = L.labels[j];
      assert.ok(!overlaps(a.box, b.box), `${name}: "${a.text}" overlaps "${b.text}"`);
    }
  }
  // everything drawn is inside the view box (nothing cropped)
  for (const e of L.elements) {
    const b = e.box;
    assert.ok(b.x0 >= -0.01 && b.y0 >= -0.01 && b.x1 <= vw + 0.01 && b.y1 <= vh + 0.01, `${name}: ${e.kind} outside the view ${JSON.stringify(b)} of ${vw}×${vh}`);
  }
  if (!hero) return;
  // no label sits on the pipe
  for (const l of L.labels) for (const p of L.pipes) assert.ok(pipeGap(p, { shape: 'rect', ...l.box }) >= -0.05, `${name}: "${l.text}" on the pipe`);
  // the pipe never runs through the obstruction; when it truly can't clear, the bend warns and the
  // obstruction is drawn as an outline instead
  const warns = result.warnings.some((w) => /won't clear/.test(w));
  if (L.obstacle) {
    assert.equal(!!L.obstacle.clash, warns, `${name}: clash drawing matches the warning`);
    if (!L.obstacle.clash) for (const p of L.pipes) assert.ok(pipeGap(p, L.obstacle) >= -0.05, `${name}: pipe overlaps the obstruction by ${(-pipeGap(p, L.obstacle)).toFixed(2)}px`);
  }
}

test('layout: text boxes come from one approximation (characters × font size)', () => {
  const b = S.textBox(100, 50, '25.61"', 'bd-pos', 'middle');
  near(b.x1 - b.x0, S.textWidth('25.61"', 'bd-pos'), 1e-9);
  near(b.y1 - b.y0, S.TEXT_SIZE['bd-pos'], 1e-9);
  near((b.x0 + b.x1) / 2, 100, 1e-9);
  assert.ok(S.textWidth('1 · 22.5°', 'bd-angle') > S.textWidth('1 · 22.5°', 'bd-note'), 'bigger font, wider text');
  assert.equal(S.textBox(0, 0, 'END', 'bd-endtext', 'start').x0, 0);
  assert.equal(S.textBox(0, 0, 'END', 'bd-endtext', 'end').x1, 0);
});

test('layout: every bend, across its inputs, at phone and iPad widths: no text collides, nothing cropped, the pipe clears', () => {
  let checked = 0;
  for (const [kind, input] of layoutCases()) {
    let r;
    try { r = B.compute(kind, input, { fmt: fmtLay }); } catch (e) { if (e instanceof B.BendError) continue; throw e; }
    for (const width of [320, 700]) {
      const tag = `${kind} ${JSON.stringify(input)} @${width}`;
      checkLayout(S.bentLayout(r, { fmt: fmtLay, width, odM: input.odM }), `${tag} bent`, { result: r, hero: true });
      checkLayout(S.marksLayout(r, { fmt: fmtLay, width }), `${tag} marks`, { result: r });
      checked += 2;
    }
    if (r.endView) checkLayout(S.rollLayout(r, { fmt: fmtLay }), `${kind} roll`, { result: r });
  }
  assert.ok(checked > 300, `checked ${checked} layouts`);
});

test('layout: the animation keeps the same guarantees, and every frame stays in view', () => {
  const cases = [
    ['saddle3', { heightM: inToM(2), centerM: inToM(24), radiusM: R, odM: OD }],
    ['saddle4', { heightM: inToM(4), widthM: inToM(10), obstacleM: inToM(36), radiusM: R, odM: OD }],
    ['offset', { riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36), radiusM: R, odM: OD }],
    ['parallel', { riseM: inToM(6), angleDeg: 30, count: 4, centersM: inToM(2), obstacleM: inToM(36), radiusM: R, odM: OD }],
    ['stub90', animCases.stub90],
  ];
  for (const [kind, input] of cases) {
    const r = B.compute(kind, input, { fmt: fmtLay });
    for (const width of [320, 480, 700]) {
      const L = S.animatedBendLayout(r, { fmt: fmtLay, width, odM: input.odM });
      checkLayout(L, `${kind} animated @${width}`, { result: r, hero: true });
      const frames = [...L.svg.matchAll(/attributeName="points"[^>]*values="([^"]*)"/g)].flatMap((m) => m[1].split(';'));
      const [tx, ty] = L.svg.match(/translate\(([-\d.]+),([-\d.]+)\)/).slice(1).map(Number);
      for (const f of frames) {
        for (const pt of f.trim().split(/\s+/)) {
          const [x, y] = pt.split(',').map(Number);
          assert.ok(x + tx >= 0 && x + tx <= L.viewBox[2] && y + ty >= 0 && y + ty <= L.viewBox[3], `${kind} @${width}: a frame point is outside the view`);
        }
      }
    }
  }
});

test('layout: 3- and 4-point saddles fill the view (not zoomed in, not lost in it)', () => {
  const cases = [
    ['saddle3', { heightM: inToM(2), centerAngleDeg: 45, radiusM: R, odM: OD }],
    ['saddle3', { heightM: inToM(2), centerM: inToM(24), radiusM: R, odM: OD }],
    ['saddle4', { heightM: inToM(4), widthM: inToM(10), radiusM: R, odM: OD }],
    ['saddle4', { heightM: inToM(4), widthM: inToM(10), obstacleM: inToM(36), angleDeg: 22.5, radiusM: R, odM: OD }],
  ];
  for (const [kind, input] of cases) {
    const r = B.compute(kind, input, { fmt: fmtLay });
    for (const width of [320, 700]) {
      const L = S.bentLayout(r, { fmt: fmtLay, width, odM: OD });
      const xs = L.pipes.flatMap((p) => p.points.map((q) => q[0]));
      const span = Math.max(...xs) - Math.min(...xs);
      assert.ok(span >= 0.5 * width && span <= width, `${kind} @${width}: the pipe spans ${Math.round(span)}px of ${width}`);
      assert.ok(L.obstacle && !L.obstacle.clash, `${kind}: the obstruction is drawn under the pipe`);
      assert.equal(L.labels.filter((l) => l.role === 'mark').length, r.marks.filter((m) => m.angleDeg).length, `${kind}: a label at every bend`);
    }
    // on the straight pipe every mark keeps its full label, even on a narrow phone
    const M = S.marksLayout(r, { fmt: fmtLay, width: 300 });
    assert.equal(M.viewBox[2], 300, `${kind} @300: the mark strip fits the phone`);
    for (const m of r.marks) assert.ok(M.labels.some((l) => l.text === fmtLay(m.atM)), `${kind} @300: position of ${m.label}`);
    assert.equal(M.labels.filter((l) => l.cls === 'bd-marktag').length, r.marks.length, `${kind} @300: number and angle of every mark`);
  }
});

test('layout: bender tools on the mark strip never cover each other', () => {
  const cases = [
    ['saddle4', { heightM: inToM(1), widthM: inToM(30), obstacleM: inToM(36), angleDeg: 45 }],
    ['saddle3', { heightM: inToM(2), centerAngleDeg: 45 }],
    ['offset', { riseM: inToM(1), angleDeg: 60 }],
  ];
  for (const [kind, input] of cases) {
    const r = B.compute(kind, input, { fmt: fmtLay });
    for (const width of [300, 480]) {
      const tools = S.marksLayout(r, { fmt: fmtLay, width }).elements.filter((e) => e.kind === 'tool');
      assert.equal(tools.length, r.marks.filter((m) => m.angleDeg).length, `${kind}: a tool on every bend mark`);
      for (let i = 0; i < tools.length; i++) for (let j = i + 1; j < tools.length; j++) assert.ok(!overlaps(tools[i].box, tools[j].box), `${kind} @${width}: tools ${i} and ${j} overlap`);
    }
  }
});

test('real geometry: corners rounded to the bend radius, the legs where the maths puts them', () => {
  const r = B.offset({ riseM: inToM(6), angleDeg: 30, radiusM: R, odM: OD });
  assert.equal(r.bendRadiusM, R);
  const sharp = B.tracePath(r.segments, r.start).points;
  const round = B.filletPoints(sharp, R, 8);
  assert.equal(round.length, sharp.length + (sharp.length - 2) * 8, 'a fixed count per corner, so animation frames stay in step');
  near(round[0][1], 0, 1e-12);
  near(round[round.length - 1][1], inToM(6), 1e-12, 'the far run is still the rise up');
  // the first corner's arc starts on the flat run and keeps radius R about its centre
  const [ax, ay] = round[1];
  near(ay, 0, 1e-12, 'the arc starts on the flat run');
  for (const [x, y] of round.slice(1, 10)) near(Math.hypot(x - ax, y - (ay + R)), R, 1e-9, 'arc point');
  // a zero angle (the animation's first frame) leaves the pipe straight
  assert.ok(B.filletPoints([[0, 0], [1, 0], [2, 0]], R, 4).every(([, y]) => y === 0));
  // sharp corners and no OD clear a 4-point saddle exactly
  near(B.obstacleClearance(B.saddle4({ heightM: inToM(4), widthM: inToM(10), obstacleM: inToM(36) }), {}).clearM, 0, 1e-9);
  // the bend radius eats a little into the allowance (within what "+ clearance" is for)
  const c = B.obstacleClearance(B.saddle4({ heightM: inToM(4), widthM: inToM(10), obstacleM: inToM(36), radiusM: R, odM: OD }), { odM: OD, radiusM: R });
  assert.ok(c.clearM < 0 && c.ok, `rounded corners dip ${inch(-c.clearM).toFixed(3)}" into the allowance`);
});

test('clearance warning: only when the pipe really would hit the obstruction', () => {
  const wont = (r) => r.warnings.some((w) => /won't clear/.test(w));
  // everyday saddles and offsets with a 3/4" EMT bender: fine
  assert.ok(!wont(B.saddle3({ heightM: inToM(2), centerM: inToM(24), radiusM: R, odM: OD })));
  assert.ok(!wont(B.saddle4({ heightM: inToM(4), widthM: inToM(10), obstacleM: inToM(36), radiusM: R, odM: OD })));
  assert.ok(!wont(B.offset({ riseM: inToM(6), angleDeg: 30, obstacleM: inToM(36), radiusM: R, odM: OD })));
  // a 1" saddle at 60° with that radius: the round centre bend sits well into the 1" allowance
  const tight = B.saddle3({ heightM: inToM(1), centerAngleDeg: 60, centerM: inToM(24), radiusM: R, odM: OD }, { fmt: fmtLay });
  assert.ok(wont(tight), 'warns');
  assert.ok(tight.clearanceM < -inToM(0.25));
  // the picture shows it as a clash outline with its own warning, not a pipe through a solid block
  const L = S.bentLayout(tight, { fmt: fmtLay, width: 480, odM: OD });
  assert.ok(L.obstacle.clash && L.labels.some((l) => l.role === 'warning'));
  assert.ok(L.svg.includes('bd-clash'));
  // marks too close for the bender's radius
  assert.ok(B.saddle4({ heightM: inToM(1), widthM: inToM(30), obstacleM: inToM(36), angleDeg: 45, radiusM: R, odM: OD }).warnings.some((w) => /run into each other/.test(w)));
});

test('bend picker art: a picture for every bend, one view box, theme colours only', async () => {
  const A = await import('../js/lib/bend-art.js');
  for (const id of [...Object.keys(B.KINDS), 'pull']) {
    const svg = A.bendArt(id);
    assert.ok(A.BEND_ART[id], `art for ${id}`);
    assert.match(svg, /^<svg class="bend-art" viewBox="0 0 64 40" aria-hidden="true"/, id);
    assert.ok(/class="ba-pipe/.test(svg), `${id} draws the pipe`);
    assert.ok(!/style=|#[0-9a-f]{3,6}\b|fill="|stroke="/i.test(svg), `${id}: no inline styles or fixed colours (currentColor via CSS)`);
  }
});
