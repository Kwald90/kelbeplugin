// Run: node --test electrical-app/tests/
// Freehand ink: collecting samples into a stroke and drawing it keeps sharp corners (a fast V);
// hold-to-snap turns a held stroke into a line, circle, ellipse, rectangle or polygon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnAngle, addInkPoint, endInk, inkSegments, snapShape, CORNER_DEG } from '../js/canvas/ink.js';

// A fast V as an iPad delivers it with coalesced events: few, widely spaced samples, the
// tip sample at (50, 100), then straight back up.
const FAST_V = [[0, 0, 0.4], [12, 24, 0.5], [25, 50, 0.6], [38, 76, 0.6], [50, 100, 0.7], [62, 76, 0.6], [75, 50, 0.5], [88, 24, 0.5], [100, 0, 0.4]];

function collect(samples, minDist = 0.8) {
  const pts = [];
  for (const s of samples) addInkPoint(pts, s, { minDist });
  return endInk(pts, samples[samples.length - 1]);
}

test('turnAngle: straight on is 0, a right angle 90, doubling back 180', () => {
  assert.equal(turnAngle([0, 0], [1, 0], [2, 0]), 0);
  assert.ok(Math.abs(turnAngle([0, 0], [1, 0], [1, 1]) - 90) < 1e-9);
  assert.ok(Math.abs(turnAngle([0, 0], [1, 0], [0, 0]) - 180) < 1e-9);
  assert.equal(turnAngle([0, 0], [0, 0], [1, 0]), 0); // zero-length: no turn
});

test('a fast V gives one stroke with every sample and the tip kept exactly', () => {
  const pts = collect(FAST_V);
  assert.equal(pts.length, FAST_V.length);
  assert.ok(pts.some((p) => p[0] === 50 && p[1] === 100), 'tip sample kept as sampled');
  // nothing is pulled back toward the previous sample (the old lag filter cut the tip short)
  for (let i = 0; i < FAST_V.length; i++) assert.deepEqual(pts[i].slice(0, 2), FAST_V[i].slice(0, 2));
  assert.deepEqual(pts[pts.length - 1].slice(0, 2), [100, 0], 'ends where the pen lifted');
});

test('the V tip is drawn as a corner: the path goes straight to it', () => {
  const pts = collect(FAST_V);
  const segs = inkSegments(pts);
  const tip = segs.find((s) => s.to[0] === 50 && s.to[1] === 100);
  assert.ok(tip, 'a segment ends exactly on the tip');
  assert.equal(tip.q, undefined, 'straight into the corner, not a curve around it');
  // the path's lowest point is the tip itself, not a rounded-off point above it
  const maxY = Math.max(...segs.map((s) => s.to[1]));
  assert.equal(maxY, 100);
  // the whole V is one path ending where the pen lifted
  assert.deepEqual(segs[segs.length - 1].to, [100, 0]);
});

test('an A apex and a zig-zag keep all their corners', () => {
  const zig = [[0, 0], [10, 30], [20, 0], [30, 30], [40, 0], [50, 30]].map(([x, y]) => [x, y, 0.5]);
  const segs = inkSegments(collect(zig));
  for (const [x, y] of zig.slice(1, -1)) assert.ok(segs.some((s) => !s.q && s.to[0] === x && s.to[1] === y), `corner ${x},${y}`);
});

test('gentle curves are still smoothed', () => {
  const arc = [];
  for (let i = 0; i <= 20; i++) { const a = (i / 20) * Math.PI; arc.push([100 - Math.cos(a) * 100, Math.sin(a) * 100, 0.5]); }
  const pts = collect(arc);
  for (let i = 1; i < pts.length - 1; i++) assert.ok(turnAngle(pts[i - 1], pts[i], pts[i + 1]) < CORNER_DEG);
  const segs = inkSegments(pts);
  assert.equal(segs.filter((s) => s.q).length, pts.length - 2, 'every interior sample is a curve control point');
});

test('a 1 px mouse staircase is smoothed, not drawn as corners', () => {
  const stairs = [];
  for (let i = 0; i < 10; i++) stairs.push([i, i, 0.5], [i + 1, i, 0.5]);
  const segs = inkSegments(collect(stairs));
  assert.equal(segs.filter((s) => !s.q).length, 1, 'only the closing segment is straight');
});

test('samples closer than minDist are skipped but the stroke still ends at the pen', () => {
  const pts = [];
  addInkPoint(pts, [0, 0, 0.5], { minDist: 2 });
  assert.equal(addInkPoint(pts, [0.5, 0, 0.5], { minDist: 2 }), false);
  assert.equal(addInkPoint(pts, [3, 0, 0.5], { minDist: 2 }), true);
  assert.equal(addInkPoint(pts, [3.5, 0, 0.5], { minDist: 2 }), false);
  endInk(pts, [3.5, 0, 0.5]);
  assert.deepEqual(pts.map((p) => p[0]), [0, 3, 3.5]);
});

test('pressure 0 samples do not end or break the stroke', () => {
  const pts = [];
  for (const s of [[0, 0, 0.5], [5, 5, 0], [10, 10, 0], [15, 5, 0.6]]) addInkPoint(pts, s);
  assert.equal(pts.length, 4);
  assert.ok(pts.every((p) => Number.isFinite(p[2])));
});

test('short strokes: one or two points', () => {
  assert.deepEqual(inkSegments([[1, 1, 0.5]]), []);
  assert.deepEqual(inkSegments([[1, 1, 0.5], [4, 5, 0.6]]), [{ to: [4, 5], p: 0.6 }]);
});

// ---- hold-to-snap ----
function jitter(seed = 5) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; }; }
function handDrawn(fn, n, amp = 3, seed = 5) { const r = jitter(seed); return Array.from({ length: n + 1 }, (_, i) => { const [x, y] = fn(i / n); return [x + r() * amp, y + r() * amp, 0.5]; }); }
function outline(verts, per = 20, amp = 3) {
  const pts = [], r = jitter(9);
  verts.forEach((a, i) => { const b = verts[(i + 1) % verts.length]; for (let k = 0; k < per; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / per + r() * amp, a[1] + ((b[1] - a[1]) * k) / per + r() * amp, 0.5]); });
  pts.push([verts[0][0], verts[0][1], 0.5]);
  return pts;
}

test('hold-to-snap: an open stroke becomes a straight line from its start to where the pen is held', () => {
  const wavy = handDrawn((t) => [t * 200, 100 + Math.sin(t * 6) * 20], 50);
  const s = snapShape(wavy);
  assert.equal(s.kind, 'line');
  assert.deepEqual(s.points.map((p) => p.slice(0, 2)), [wavy[0].slice(0, 2), wavy.at(-1).slice(0, 2)]);
});

test('hold-to-snap: a closed round stroke becomes a circle, a long one an ellipse (even drawn past the start)', () => {
  const circle = handDrawn((t) => [200 + 60 * Math.cos(t * 2.2 * Math.PI), 200 + 60 * Math.sin(t * 2.2 * Math.PI)], 90);
  const c = snapShape(circle);
  assert.equal(c.kind, 'circle');
  const radii = c.points.map((p) => Math.hypot(p[0] - 200, p[1] - 200));
  assert.ok(radii.every((r) => Math.abs(r - 60) < 4), 'round, about the right size and place');
  assert.deepEqual(c.points[0], c.points.at(-1), 'closed');
  const e = snapShape(handDrawn((t) => [200 + 100 * Math.cos(t * 2 * Math.PI), 200 + 50 * Math.sin(t * 2 * Math.PI)], 80));
  assert.equal(e.kind, 'ellipse');
  const xs = e.points.map((p) => p[0]), ys = e.points.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - 200) < 12 && Math.abs(Math.max(...ys) - Math.min(...ys) - 100) < 12, 'level, about 200 by 100');
});

test('hold-to-snap: a closed four-cornered stroke becomes a level rectangle, three corners a triangle', () => {
  const r = snapShape(outline([[100, 100], [300, 104], [297, 220], [102, 216]]));
  assert.equal(r.kind, 'rect');
  assert.equal(r.points.length, 5);
  for (let i = 0; i < 4; i++) {
    const a = r.points[i], b = r.points[i + 1];
    assert.ok(Math.abs(a[0] - b[0]) < 1e-6 || Math.abs(a[1] - b[1]) < 1e-6, 'every side level or plumb');
  }
  const segs = inkSegments(r.points);
  assert.ok(segs.every((sg) => !sg.q), 'drawn with sharp corners');
  const t = snapShape(outline([[100, 300], [200, 120], [300, 300]]));
  assert.equal(t.kind, 'polygon');
  assert.equal(t.points.length, 4, 'three corners, closed');
});

test('hold-to-snap: a closed scribble is left alone, and so is a dot', () => {
  const scribble = handDrawn((t) => { const a = t * 2 * Math.PI, r = 60 + 30 * Math.sin(7 * a); return [200 + r * Math.cos(a), 200 + r * Math.sin(a)]; }, 120, 1);
  assert.equal(snapShape(scribble), null);
  assert.equal(snapShape([[5, 5, 0.5]]), null);
  assert.equal(snapShape([[5, 5, 0.5], [5, 5, 0.5]]), null);
});
