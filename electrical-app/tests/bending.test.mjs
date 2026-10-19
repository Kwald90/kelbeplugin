// Run: node --test electrical-app/tests/
// Conduit bending. Expected values are worked by hand in the comments (inches unless noted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../js/lib/bending.js';
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
    for (let i = 1; i < r.marks.length; i++) assert.ok(r.marks[i].atM >= r.marks[i - 1].atM, `${kind} marks sorted`);
  }
  assert.throws(() => B.compute('nope', {}), B.BendError);
});
