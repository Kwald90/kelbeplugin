// Run: node --test electrical-app/tests/
// Freehand ink: collecting samples into a stroke and drawing it keeps sharp corners (a fast V).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnAngle, addInkPoint, endInk, inkSegments, CORNER_DEG } from '../js/canvas/ink.js';

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
