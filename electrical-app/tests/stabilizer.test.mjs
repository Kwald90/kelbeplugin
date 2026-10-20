// Run: node --test electrical-app/tests/
// Stroke stabilizer: 0 is raw, jitter is reduced, corners survive, the line ends where the pen lifted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStabilizer, smoothParams, clampSmooth } from '../js/canvas/stabilizer.js';
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
const rms = (arr) => Math.sqrt(arr.reduce((a, v) => a + v * v, 0) / arr.length);

test('smoothness is clamped to 0–100 and 0 means no filter', () => {
  assert.equal(clampSmooth(-5), 0);
  assert.equal(clampSmooth(140), 100);
  assert.equal(clampSmooth('50'), 50);
  assert.equal(smoothParams(0), null);
  assert.ok(smoothParams(100).minCutoff < smoothParams(10).minCutoff, 'stronger setting, lower cutoff');
  assert.equal(smoothParams(30).lazy, 0, 'no string pull at low settings');
  assert.ok(smoothParams(90).lazy > 0);
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
