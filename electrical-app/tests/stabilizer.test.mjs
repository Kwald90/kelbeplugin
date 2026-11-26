// Run: node --test electrical-app/tests/
// Stroke stabilizer: 0 is raw, 100 is a ruler, each step between is smoother than the last, corners
// survive, the line ends where the pen lifted, and the same hand feels the same at any zoom or sample rate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStabilizer, smoothParams, clampSmooth, SMOOTH_SCALE, fromOldSmooth } from '../js/canvas/stabilizer.js';
import { addInkPoint, endInk, inkSegments } from '../js/canvas/ink.js';

// deterministic noise
function rng(seed = 7) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; }; }

/** Samples along a polyline at `speed` px/s and `hz`, with jitter of `amp` px (zero-mean). */
function trace(poly, { speed = 300, hz = 240, amp = 0, seed = 7 } = {}) {
  const rnd = rng(seed);
  const out = [];
  const step = speed / hz;
  let t = 0;
  out.push({ x: poly[0][0], y: poly[0][1], t, clean: poly[0] });
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1], [bx, by] = poly[i];
    const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) {
      t += 1000 / hz;
      const cx = ax + ((bx - ax) * k) / n, cy = ay + ((by - ay) * k) / n;
      out.push({ x: cx + (k === n ? 0 : rnd() * 2 * amp), y: cy + (k === n ? 0 : rnd() * 2 * amp), t, clean: [cx, cy] });
    }
  }
  return out;
}

function run(samples, smoothness, zoom = 1) {
  const st = createStabilizer({ smoothness, zoom, minDist: 0.8 / zoom });
  for (const s of samples) st.add([s.x, s.y, 0.5], s.t);
  st.end();
  return st;
}

const distToLine = (p) => Math.abs(p[1]); // for lines along y = 0
const rms = (arr) => (arr.length ? Math.sqrt(arr.reduce((a, v) => a + v * v, 0) / arr.length) : 0);

test('smoothness is clamped to 0–100 and 0 means no filter', () => {
  assert.equal(clampSmooth(-5), 0);
  assert.equal(clampSmooth(140), 100);
  assert.equal(clampSmooth('50'), 50);
  assert.equal(smoothParams(0), null);
  assert.equal(smoothParams(100).straight, true, '100 is a ruler');
  assert.equal(smoothParams(99).straight, false);
  assert.equal(smoothParams(80).chord, 0, 'no pull to the chord up to 80');
  assert.ok(smoothParams(90).chord > 0 && smoothParams(90).chord < smoothParams(99).chord && smoothParams(99).chord < 1);
});

test('every setting is stronger than the one below it: string, easing and chord pull never shrink', () => {
  let prev = { string: 0, ease: 0, chord: 0 };
  for (let s = 1; s <= 99; s++) {
    const p = smoothParams(s);
    assert.ok(p.string > prev.string && p.ease > prev.ease && p.chord >= prev.chord, `at ${s}`);
    prev = p;
  }
  // the string grows along a curve: gentle at the bottom, long at the top
  assert.ok(smoothParams(10).string < 2 && smoothParams(50).string > 10 && smoothParams(99).string > 35);
});

test('100% is a straight line from the first point to the pen, live and committed, two points', () => {
  const samples = trace([[0, 0], [60, 40], [100, -30], [150, 10]], { amp: 3 });
  const st = createStabilizer({ smoothness: 100, minDist: 0.8 });
  for (const s of samples) {
    st.add([s.x, s.y, 0.5], s.t);
    // live, like a ruler: always from where the stroke began to where the pen is now
    assert.ok(st.points.length <= 2);
    assert.deepEqual(st.points[0].slice(0, 2), [samples[0].x, samples[0].y]);
    if (st.points.length === 2) assert.deepEqual(st.points[1].slice(0, 2), [s.x, s.y]);
  }
  st.end();
  assert.equal(st.points.length, 2, 'a 2-point straight stroke');
  assert.deepEqual(st.points.map((p) => p.slice(0, 2)), [[0, 0], [150, 10]]);
  assert.equal(inkSegments(st.points).length, 1, 'drawn as one straight segment');
});

test('0% leaves the points unchanged', () => {
  const samples = trace([[0, 0], [50, 20], [80, -40]], { amp: 2.5 });
  const st = createStabilizer({ smoothness: 0 });
  for (const s of samples) st.add([s.x, s.y, 0.5], s.t);
  st.end();
  assert.deepEqual(st.points.map((p) => p.slice(0, 2)), samples.map((s) => [s.x, s.y]));
});

test('smoothing increases monotonically from 0 to 100: jitter and wobble only ever get smaller', () => {
  const jittery = trace([[0, 0], [400, 0]], { amp: 2.5, speed: 300 });
  const wobble = [];
  for (let x = 0; x <= 600; x += 1.5) wobble.push({ x, y: 4 * Math.sin((2 * Math.PI * x) / 50), t: x * 4 });
  const devOf = (samples, s) => rms(run(samples, s).points.filter((p) => p[0] > 40 && p[0] < samples.at(-1).x - 40).map(distToLine));
  let prevJ = Infinity, prevW = Infinity;
  for (let s = 0; s <= 100; s += 5) {
    const j = devOf(jittery, s), w = devOf(wobble, s);
    assert.ok(j <= prevJ + 1e-9, `jitter at ${s}: ${j.toFixed(3)} after ${prevJ.toFixed(3)}`);
    assert.ok(w <= prevW + 1e-9, `wobble at ${s}: ${w.toFixed(3)} after ${prevW.toFixed(3)}`);
    prevJ = j; prevW = w;
  }
  assert.equal(devOf(wobble, 100), 0, 'straight at 100');
  // and it is spread along the slider, not all at one end: the 50 px wobble is still partly there at 50
  const w0 = devOf(wobble, 0), w50 = devOf(wobble, 50), w90 = devOf(wobble, 90);
  assert.ok(w50 < w0 * 0.75 && w50 > w0 * 0.2 && w90 < w50 * 0.5, `${w0.toFixed(2)} ${w50.toFixed(2)} ${w90.toFixed(2)}`);
});

test('hand tremor never fakes corners: a jittery straight line has none at any setting', () => {
  for (const hz of [60, 240]) {
    const samples = trace([[0, 0], [400, 0]], { amp: 3, speed: 300, hz });
    for (const s of [5, 10, 25, 40, 60, 80, 95]) assert.equal(run(samples, s).corners.length, 0, `${hz} Hz, smoothness ${s}`);
  }
});

test('the same hand at 60 Hz and 240 Hz gives the same smoothing: it goes by distance, not time', () => {
  const wave = (hz) => { const out = []; const step = 300 / hz; for (let x = 0; x <= 600; x += step) out.push({ x, y: 4 * Math.sin((2 * Math.PI * x) / 60), t: (x / 300) * 1000 }); return out; };
  const dev = (samples) => rms(run(samples, 50).points.filter((p) => p[0] > 60 && p[0] < 540).map(distToLine));
  const a = dev(wave(60)), b = dev(wave(240));
  assert.ok(Math.abs(a - b) < 0.25, `${a.toFixed(3)} vs ${b.toFixed(3)}`);
  // and timestamps play no part at all
  const s1 = trace([[0, 0], [200, 50]], { amp: 2 }), s2 = s1.map((s, i) => ({ ...s, t: i * 37 }));
  assert.deepEqual(run(s1, 60).points, run(s2, 60).points);
});

test('above 80 a curve is pulled toward its chord, a little more at each step', () => {
  const arc = [];
  for (let i = 0; i <= 60; i++) { const a = (i / 60) * Math.PI; arc.push([200 - Math.cos(a) * 200, -Math.sin(a) * 80]); }
  const bow = (s) => Math.max(...run(trace(arc, { speed: 300 }), s).points.map((p) => -p[1]));
  const b80 = bow(80), b90 = bow(90), b95 = bow(95), b100 = bow(100);
  assert.ok(b80 > b90 && b90 > b95 && b95 > b100, `${b80} ${b90} ${b95} ${b100}`);
  assert.ok(b100 < 1e-9, 'flat at 100');
});

test('settings saved on the old scale keep their feel; 100 stays a ruler', () => {
  assert.equal(SMOOTH_SCALE, 2);
  assert.equal(fromOldSmooth(55), 30);
  assert.equal(fromOldSmooth(0), 0);
  assert.equal(fromOldSmooth(100), 100);
  assert.ok(fromOldSmooth(99) < 100);
});

test('smoothness 0 is the identity: the same points as addInkPoint + endInk', () => {
  const samples = trace([[0, 0], [40, 80], [90, 10], [130, 60]], { amp: 1.5 });
  const st = run(samples, 0);
  const ref = [];
  for (const s of samples) addInkPoint(ref, [s.x, s.y, 0.5], { minDist: 0.8 });
  endInk(ref, [samples.at(-1).x, samples.at(-1).y, 0.5]);
  assert.deepEqual(st.points, ref);
});

test('jitter on a straight line is reduced, more at higher settings', () => {
  const samples = trace([[0, 0], [300, 0]], { amp: 2, speed: 250 });
  const rawDev = rms(samples.slice(1, -1).map((s) => distToLine([s.x, s.y])));
  const dev = (s) => { const pts = run(samples, s).points; return rms(pts.slice(1, -1).map(distToLine)); };
  const d20 = dev(20), d50 = dev(50), d80 = dev(80);
  assert.ok(d50 < rawDev * 0.5, `50 halves the wobble (${d50.toFixed(3)} vs ${rawDev.toFixed(3)})`);
  assert.ok(d80 < d50 && d50 < d20 && d20 < rawDev, `${d20} > ${d50} > ${d80}`);
});

test('low settings barely lag behind the pen', () => {
  const samples = trace([[0, 0], [400, 0]], { speed: 600 });
  const st = createStabilizer({ smoothness: 10 });
  let worst = 0;
  for (const s of samples) { st.add([s.x, s.y, 0.5], s.t); const last = st.points.at(-1); worst = Math.max(worst, s.x - last[0]); }
  assert.ok(worst < 8, `lag ${worst.toFixed(2)} px at 600 px/s`);
});

test('the line ends exactly where the pen lifted', () => {
  for (const s of [10, 50, 80, 100]) {
    const samples = trace([[0, 0], [120, 30], [200, -20]], { amp: 1 });
    const pts = run(samples, s).points;
    const last = samples.at(-1);
    assert.deepEqual(pts.at(-1).slice(0, 2), [last.x, last.y], `smoothness ${s}`);
    assert.deepEqual(pts[0].slice(0, 2), [samples[0].x, samples[0].y], 'starts where the pen went down');
  }
});

test('a V keeps its sharp tip at smoothness 50 (dense samples, a little jitter)', () => {
  const samples = trace([[0, 0], [60, 150], [120, 0]], { amp: 0.4, speed: 500 });
  const st = run(samples, 50);
  const tip = [60, 150];
  const near = st.points.filter((p) => Math.hypot(p[0] - tip[0], p[1] - tip[1]) < 1.2);
  assert.ok(near.length >= 1, 'a point on the tip');
  assert.ok(Math.max(...st.points.map((p) => p[1])) >= 149, 'the lowest point is the tip, not rounded off above it');
  const segs = inkSegments(st.points);
  const t = segs.find((s) => Math.hypot(s.to[0] - tip[0], s.to[1] - tip[1]) < 1.2);
  assert.ok(t && !t.q, 'drawn as a corner: straight into the tip');
  assert.equal(st.corners.length, 1, 'exactly one corner');
});

test('a fast zig-zag with sparse samples keeps every corner at 50', () => {
  const zig = [[0, 0], [10, 30], [20, 0], [30, 30], [40, 0], [50, 30]];
  const st = createStabilizer({ smoothness: 50, minDist: 0.8 });
  zig.forEach(([x, y], i) => st.add([x, y, 0.5], i * 8));
  st.end();
  for (const [x, y] of zig) assert.ok(st.points.some((p) => p[0] === x && p[1] === y), `corner ${x},${y}`);
});

test('a smooth arc with jitter gets no corners', () => {
  const arc = [];
  for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI; arc.push([100 - Math.cos(a) * 60, Math.sin(a) * 60]); }
  for (const s of [20, 50, 80]) {
    const st = run(trace(arc, { amp: 0.8, speed: 200 }), s);
    assert.equal(st.corners.length, 0, `smoothness ${s}`);
  }
});

test('filter lengths are in screen px: zoomed in, the same hand gives the same shape', () => {
  const base = trace([[0, 0], [300, 0]], { amp: 2 });
  const at2 = base.map((s) => ({ ...s, x: s.x / 2, y: s.y / 2 })); // world units at zoom 2
  const a = run(base, 60, 1).points, b = run(at2, 60, 2).points;
  const da = rms(a.map(distToLine)), db = rms(b.map(distToLine)) * 2;
  assert.ok(Math.abs(da - db) < 0.05, `${da} vs ${db}`);
});
