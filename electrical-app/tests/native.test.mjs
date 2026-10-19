// Run: node --test electrical-app/tests/
// iOS app file saving (js/lib/native.js) against a mocked Capacitor bridge.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeApp, safeFileName, toBase64, isShareCancel, saveAndShare } from '../js/lib/native.js';

afterEach(() => { delete globalThis.Capacitor; });

function mockBridge({ shareError } = {}) {
  const calls = [];
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      Filesystem: { writeFile: async (o) => { calls.push(['writeFile', o]); return { uri: `file:///docs/${o.path}` }; } },
      Share: { share: async (o) => { calls.push(['share', o]); if (shareError) throw shareError; return {}; } },
    },
  };
  return calls;
}

test('isNativeApp is false in a browser or Node, true with the native bridge', () => {
  assert.equal(isNativeApp(), false);
  globalThis.Capacitor = { isNativePlatform: () => false };
  assert.equal(isNativeApp(), false);
  mockBridge();
  assert.equal(isNativeApp(), true);
  globalThis.Capacitor = { isNativePlatform: () => { throw new Error('boom'); } };
  assert.equal(isNativeApp(), false);
});

test('safeFileName strips path separators and control characters', () => {
  assert.equal(safeFileName('Kitchen feed - J-1004.pdf'), 'Kitchen feed - J-1004.pdf');
  assert.equal(safeFileName('a/b\\c:d.csv'), 'a-b-c-d.csv');
  assert.equal(safeFileName('../../etc/passwd'), '-..-etc-passwd');
  assert.equal(safeFileName('  .hidden'), 'hidden');
  assert.equal(safeFileName('tab\there'), 'tab-here');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('x'.repeat(300)).length, 120);
});

test('toBase64 handles strings, Blobs and bytes, including large ones', async () => {
  assert.equal(await toBase64('héllo, wire'), Buffer.from('héllo, wire').toString('base64'));
  assert.equal(await toBase64(new Blob(['%PDF-1.4'], { type: 'application/pdf' })), Buffer.from('%PDF-1.4').toString('base64'));
  const big = new Uint8Array(200_000).map((_, i) => i % 251);
  assert.equal(await toBase64(big), Buffer.from(big).toString('base64'));
});

test('isShareCancel spots the Share plugin cancel', () => {
  assert.equal(isShareCancel(new Error('Share canceled')), true);
  assert.equal(isShareCancel({ errorMessage: 'Share cancelled' }), true);
  assert.equal(isShareCancel(new Error('Error sharing item')), false);
});

test('saveAndShare writes to Documents and shares the file', async () => {
  const calls = mockBridge();
  const r = await saveAndShare('Kitchen/feed.csv', 'a,b\n1,2\n', 'text/csv');
  assert.deepEqual(r, { uri: 'file:///docs/Kitchen-feed.csv', shared: true });
  assert.equal(calls[0][0], 'writeFile');
  assert.deepEqual(calls[0][1], { path: 'Kitchen-feed.csv', data: Buffer.from('a,b\n1,2\n').toString('base64'), directory: 'DOCUMENTS', recursive: true });
  assert.deepEqual(calls[1], ['share', { title: 'Kitchen-feed.csv', files: ['file:///docs/Kitchen-feed.csv'] }]);
});

test('saveAndShare: closing the share sheet is not an error, other share errors are', async () => {
  mockBridge({ shareError: new Error('Share canceled') });
  assert.deepEqual(await saveAndShare('a.pdf', 'x'), { uri: 'file:///docs/a.pdf', shared: false });
  mockBridge({ shareError: new Error('Error sharing item') });
  await assert.rejects(saveAndShare('a.pdf', 'x'), /Error sharing item/);
});

test('saveAndShare explains a missing plugin', async () => {
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  await assert.rejects(saveAndShare('a.pdf', 'x'), /missing the Filesystem plugin/);
});
