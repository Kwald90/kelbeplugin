// Run: node --test electrical-app/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from '../vendor/jsqr-1.4.0/jsQR.js';
import { resolveScan } from '../js/lib/scanner.js';

test('vendored jsQR loads as a callable decoder', () => {
  assert.equal(typeof jsQR, 'function');
});

test('resolveScan matches a scanned code or our QR url to an item', () => {
  const items = [
    { id: 'a', name: 'Marrette', sku: 'WRE-RED-6', barcode: '0-1234-5' },
    { id: 'b', name: 'EMT', sku: 'EMT-050-10', barcode: null },
  ];
  // raw barcode
  assert.equal(resolveScan('0-1234-5', items)?.id, 'a');
  // raw sku
  assert.equal(resolveScan('EMT-050-10', items)?.id, 'b');
  // our printed QR url (?q=<sku>)
  assert.equal(resolveScan('https://app.fishtapehq.com/#/inventory/book?q=WRE-RED-6', items)?.id, 'a');
  // a bin url resolves to a location id, not an item
  assert.equal(resolveScan('https://x/#/inventory/stock?loc=loc1', items), null);
  // unknown
  assert.equal(resolveScan('nope', items), null);
});

test('resolveScan can target locations too', () => {
  const locs = [{ id: 'loc1', name: 'Van 2' }];
  const hit = resolveScan('https://x/#/inventory/stock?loc=loc1', [], { locations: locs });
  assert.equal(hit?.kind, 'location');
  assert.equal(hit?.location?.id, 'loc1');
});
