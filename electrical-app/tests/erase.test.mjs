// Run: node --test electrical-app/tests/
// The area eraser: strokes lose only what the eraser swept over, cut cleanly, and undo gets them back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraseStrokes, splitPolyline, capsuleInterval, strokeTouches, segSegDist } from '../js/canvas/erase.js';

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
let n = 0;
const newId = () => `new${++n}`;

/** A long straight pen line along y = 0 with a sample every `step` units and rising pressure. */
function longLine(len = 10000, step = 5, extra = {}) {
  const points = [];
  for (let x = 0; x <= len; x += step) points.push([x, 0, 0.2 + 0.6 * (x / len)]);
  return { id: 'S1', layer: 'L1', tool: 'pen', color: '#1c1b19', size: 2, opacity: 1, points, ...extra };
}

test('capsuleInterval: a segment through the circle, through the band, and missing it', () => {
  const iv = capsuleInterval([-10, 0], [10, 0], [0, 0], [0, 0], 5);
  assert.ok(near(iv[0], 0.25) && near(iv[1], 0.75));
  const band = capsuleInterval([0, -10], [0, 10], [-20, 0], [20, 0], 2); // crossing a swipe
  assert.ok(near(band[0], 0.4) && near(band[1], 0.6));
  assert.equal(capsuleInterval([-10, 9], [10, 9], [0, 0], [0, 0], 5), null);
  assert.deepEqual(capsuleInterval([-1, 0], [1, 0], [0, 0], [0, 0], 5), [0, 1], 'wholly inside');
});

test('a long line erased in the middle leaves two strokes with exact cut ends', () => {
  const s = longLine();
  const before = JSON.stringify(s);
  const r = 10; // eraser radius; the pen's 1-unit half width is added
  const res = eraseStrokes([s], [5002, 0], [5002, 0], r, { newId });
  assert.equal(res.changed, true);
  assert.equal(res.strokes.length, 2);
  const [left, right] = res.strokes;
  assert.deepEqual(left.points[0], s.points[0], 'left starts where it did');
  assert.deepEqual(right.points.at(-1), s.points.at(-1), 'right ends where it did');
  assert.ok(near(left.points.at(-1)[0], 5002 - 11) && near(left.points.at(-1)[1], 0), `left cut at ${left.points.at(-1)[0]}`);
  assert.ok(near(right.points[0][0], 5002 + 11), `right cut at ${right.points[0][0]}`);
  // pressure interpolated at the cut, not copied from the neighbour sample
  assert.ok(near(left.points.at(-1)[2], 0.2 + 0.6 * (4991 / 10000)), 'pressure at the cut');
  // every other field copied, the first piece keeps the id
  assert.equal(left.id, 'S1');
  assert.notEqual(right.id, 'S1');
  for (const k of ['layer', 'tool', 'color', 'size', 'opacity']) assert.equal(right[k], s[k]);
  // nothing inside the eraser remains
  for (const p of [...left.points, ...right.points]) assert.ok(Math.abs(p[0] - 5002) >= 11 - 1e-9);
  // the original is untouched, so undo (the snapshot from before) restores it in one step
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(res.removed, [s]);
});

test('attribution metadata (by/at) and unknown fields are copied onto every piece', () => {
  const s = longLine(200, 5, { by: 'emp-7', at: '2026-10-19T10:00:00Z', custom: { x: 1 } });
  const res = eraseStrokes([s], [100, 0], [100, 0], 5, { newId });
  assert.equal(res.strokes.length, 2);
  for (const p of res.strokes) { assert.equal(p.by, 'emp-7'); assert.equal(p.at, '2026-10-19T10:00:00Z'); assert.deepEqual(p.custom, { x: 1 }); }
});

test('a fast swipe across many strokes cuts each one (the whole path between samples)', () => {
  const strokes = [0, 40, 80, 120].map((x, i) => ({ id: `V${i}`, tool: 'pen', size: 2, points: [[x, -100, 0.5], [x, 100, 0.5]] }));
  const res = eraseStrokes(strokes, [-20, 0], [140, 0], 4, { newId }); // one jump, two samples
  assert.equal(res.strokes.length, 8, 'each vertical line is now a top and a bottom piece');
  for (const p of res.strokes) assert.ok(p.points.every((q) => Math.abs(q[1]) >= 5 - 1e-9));
});

test('erasing an end trims it; erasing all of it removes the stroke; a miss changes nothing', () => {
  const s = { id: 'A', tool: 'marker', size: 4, points: [[0, 0, 0.5], [10, 0, 0.5], [20, 0, 0.5]] };
  const trimmed = eraseStrokes([s], [0, 0], [0, 0], 3, { newId });
  assert.equal(trimmed.strokes.length, 1);
  assert.ok(near(trimmed.strokes[0].points[0][0], 5));
  const gone = eraseStrokes([s], [-10, 0], [30, 0], 3, { newId });
  assert.deepEqual(gone.strokes, []);
  const miss = [s];
  const res = eraseStrokes(miss, [0, 50], [20, 50], 3, { newId });
  assert.equal(res.changed, false);
  assert.equal(res.strokes, miss, 'same array when nothing changed');
});

test('tiny leftover crumbs are dropped', () => {
  const s = { id: 'A', tool: 'pen', size: 2, points: [[0, 0, 0.5], [100, 0, 0.5]] };
  const res = eraseStrokes([s], [10.5, 0], [100, 0], 9, { newId, minLen: 1 }); // leaves 0.5 at the start
  assert.deepEqual(res.strokes, []);
});

test('whole-stroke mode removes anything touched, and rectangles always go whole', () => {
  const s = longLine(100);
  const whole = eraseStrokes([s], [50, 0], [50, 0], 2, { mode: 'stroke' });
  assert.deepEqual(whole.strokes, []);
  const rect = { id: 'R', tool: 'rect', size: 2, points: [[0, 0, 0.5], [50, 30, 0.5]] };
  assert.deepEqual(eraseStrokes([rect], [25, 0], [25, 0], 3).strokes, []);
  assert.equal(eraseStrokes([rect], [25, 15], [25, 15], 3).changed, false, 'inside the rectangle, away from its edges');
});

test('locked or hidden layers are left alone', () => {
  const s = longLine(100);
  const res = eraseStrokes([s], [50, 0], [50, 0], 5, { canErase: () => false });
  assert.equal(res.changed, false);
});

test('a straight line tool stroke splits into two line strokes', () => {
  const s = { id: 'L', tool: 'line', size: 2, points: [[0, 0, 0.5], [100, 0, 0.5]] };
  const res = eraseStrokes([s], [50, 0], [50, 0], 4, { newId });
  assert.equal(res.strokes.length, 2);
  assert.ok(res.strokes.every((x) => x.tool === 'line' && x.points.length === 2));
  assert.ok(near(res.strokes[0].points[1][0], 45) && near(res.strokes[1].points[0][0], 55));
});

test('splitPolyline keeps corners between cuts and segSegDist/strokeTouches agree', () => {
  const v = [[0, 0], [50, 100], [100, 0]];
  const pieces = splitPolyline(v, [25, 50], [25, 50], 5);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[1].slice(-2), [[50, 100], [100, 0]], 'the tip of the V is untouched');
  assert.equal(segSegDist(0, 0, 10, 10, 0, 10, 10, 0), 0);
  assert.ok(near(segSegDist(0, 0, 10, 0, 0, 5, 10, 5), 5));
  assert.equal(strokeTouches({ tool: 'pen', size: 2, points: [[0, 0], [100, 0]] }, [50, 5.5], [50, 5.5], 4.6), true);
  assert.equal(strokeTouches({ tool: 'pen', size: 2, points: [[0, 0], [100, 0]] }, [50, 6], [50, 6], 4.9), false);
});

test('fast on very long strokes: 50k points, 2000 eraser moves elsewhere and 50 cuts', () => {
  const s = longLine(250000, 5); // 50,001 points
  const t0 = performance.now();
  let strokes = [s];
  for (let i = 0; i < 2000; i++) strokes = eraseStrokes(strokes, [i * 10, 50], [i * 10 + 10, 50], 5).strokes; // near, not touching
  const tMiss = performance.now() - t0;
  assert.equal(strokes.length, 1);
  const t1 = performance.now();
  for (let i = 1; i <= 50; i++) strokes = eraseStrokes(strokes, [i * 4500, 0], [i * 4500, 0], 5, { newId }).strokes;
  const tCut = performance.now() - t1;
  assert.equal(strokes.length, 51);
  assert.ok(tMiss < 3000, `misses took ${tMiss.toFixed(0)} ms`);
  assert.ok(tCut < 3000, `cuts took ${tCut.toFixed(0)} ms`);
});
