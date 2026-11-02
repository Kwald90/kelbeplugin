// Burial depth (lib/burial.js): CEC Table 53 cover table, all values VERIFY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BURIAL_MM, BURIAL_METHODS, BURIAL_LOCATIONS, minimumCover } from '../js/lib/burial.js';

test('every method and location has a cover figure', () => {
  for (const m of BURIAL_METHODS) for (const l of BURIAL_LOCATIONS) assert.ok(BURIAL_MM[m.value][l.value] > 0, `${m.value}/${l.value}`);
});

test('cover converts to inches', () => {
  const r = minimumCover('cable', 'general');
  assert.equal(r.mm, 600);
  assert.ok(Math.abs(r.inches - 23.622) < 0.001);
});

test('metal conduit needs less cover than cable; vehicle areas need the most', () => {
  assert.ok(minimumCover('rmc', 'general').mm < minimumCover('pvc', 'general').mm);
  assert.ok(minimumCover('pvc', 'general').mm < minimumCover('cable', 'general').mm);
  for (const m of BURIAL_METHODS) assert.ok(minimumCover(m.value, 'vehicle').mm >= minimumCover(m.value, 'general').mm);
});

test('unknown pairs return null', () => {
  assert.equal(minimumCover('nope', 'general'), null);
  assert.equal(minimumCover('cable', 'moon'), null);
});
