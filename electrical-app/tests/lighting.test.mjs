// Recessed ("pot") light layout (lib/lighting.js): spacing rule, brightness
// count, the even grid, and the manual-count override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spacingForCeiling, requiredLumens, footcandles, gridFor, solveLayout,
  MIN_SPACING_M, MAX_SPACING_M, DEFAULT_TARGET_FC, M_PER_FT,
} from '../js/lib/lighting.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);
const FT2_PER_M2 = 1 / (M_PER_FT * M_PER_FT);

test('spacingForCeiling is half the ceiling height, within bounds', () => {
  near(spacingForCeiling(2.44), 1.22);
  assert.equal(spacingForCeiling(1.2), MIN_SPACING_M); // very low ceiling clamps up
  assert.equal(spacingForCeiling(6), MAX_SPACING_M); // very tall clamps down
  near(spacingForCeiling(undefined), 1.22); // defaults to an 8 ft ceiling
});

test('requiredLumens and footcandles are inverses through the efficiency factor', () => {
  const areaM2 = 12, fc = 20, eff = 0.7;
  const lm = requiredLumens(areaM2, fc, eff);
  near(lm, (areaM2 * FT2_PER_M2 * fc) / eff, 1e-6);
  // one fixture delivering exactly that many lumens hits the target
  near(footcandles(1, lm, areaM2, eff), fc, 1e-6);
  assert.equal(footcandles(4, 650, 0, 0.7), 0); // no area, no light level
});

test('gridFor returns an empty layout for zero lights', () => {
  const g = gridFor(0, 4, 3);
  assert.deepEqual(g, { cols: 0, rows: 0, count: 0, points: [], spacingLenM: 0, spacingWidM: 0 });
});

test('gridFor centres a single light and keeps every point inside the room', () => {
  const g = gridFor(1, 4, 3);
  assert.equal(g.count, 1);
  assert.deepEqual(g.points[0], { u: 0.5, v: 0.5 });
  for (const p of gridFor(9, 5, 4).points) {
    assert.ok(p.u > 0 && p.u < 1 && p.v > 0 && p.v < 1);
  }
});

test('gridFor matches the grid aspect to the room and trims spare columns', () => {
  const wide = gridFor(4, 6, 3); // twice as long as deep
  assert.equal(wide.cols, 2);
  assert.equal(wide.rows, 2);
  const row = gridFor(3, 9, 3); // long and shallow → one row
  assert.equal(row.rows, 1);
  assert.equal(row.cols, 3);
});

test('gridFor centres a short last row', () => {
  const g = gridFor(5, 4, 4); // 2 cols × 3 rows, last row has one light
  assert.equal(g.cols, 2);
  assert.equal(g.rows, 3);
  assert.equal(g.points.length, 5);
  assert.equal(g.points[4].u, 0.5); // the lone light is centred across the width
});

test('solveLayout: spacing drives the count for a normal room and ceiling', () => {
  const r = solveLayout({ lengthM: 4, widthM: 3, ceilingM: 2.44, targetFc: DEFAULT_TARGET_FC });
  assert.equal(r.driver, 'spacing');
  assert.equal(r.geomCount, 6); // round(4/1.22)=3 × round(3/1.22)=2
  assert.equal(r.count, 6);
  assert.ok(r.fc > 0);
});

test('solveLayout: a bright room needs more lights than the spacing grid', () => {
  const r = solveLayout({ lengthM: 4, widthM: 3, ceilingM: 2.44, targetFc: 40, lumens: 650 });
  assert.equal(r.driver, 'brightness');
  assert.ok(r.brightCount > r.geomCount);
  assert.equal(r.count, r.brightCount);
});

test('solveLayout: a manual count overrides and re-solves the grid', () => {
  const r = solveLayout({ lengthM: 4, widthM: 3, ceilingM: 2.44, targetFc: 40, count: 7 });
  assert.equal(r.driver, 'manual');
  assert.equal(r.count, 7);
  assert.equal(r.points.length, 7);
});

test('solveLayout: no room size yields no lights, not a crash', () => {
  const r = solveLayout({ lengthM: 0, widthM: 0, ceilingM: 2.44, targetFc: 20 });
  assert.equal(r.count, 0);
  assert.equal(r.points.length, 0);
  assert.equal(r.fc, 0);
});
