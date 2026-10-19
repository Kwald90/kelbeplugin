// Run: node --test electrical-app/tests/
// iOS app helpers (js/lib/native.js): file saving, the Keychain and printing, against a mocked
// Capacitor bridge.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isNativeApp, safeFileName, toBase64, isShareCancel, saveAndShare, getSecret, setSecret, removeSecret, nativePrint, installNativePrint, openExternal,
} from '../js/lib/native.js';

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

test('openExternal: this tab on the web, a Safari sheet in the app (https only)', async () => {
  const assigned = [];
  const win = { location: { assign: (u) => assigned.push(u) } };
  await openExternal('https://checkout.stripe.com/c/pay/cs_test_1', { win });
  assert.deepEqual(assigned, ['https://checkout.stripe.com/c/pay/cs_test_1']);

  const opened = [];
  let finished;
  let removed = 0;
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      Browser: {
        open: async (o) => { opened.push(o); },
        addListener: async (name, cb) => { assert.equal(name, 'browserFinished'); finished = cb; return { remove: () => { removed++; } }; },
      },
    },
  };
  let closed = 0;
  await openExternal('https://billing.stripe.com/p/session/x', { win, onClose: () => closed++ });
  assert.deepEqual(opened, [{ url: 'https://billing.stripe.com/p/session/x', presentationStyle: 'fullscreen' }]);
  assert.equal(assigned.length, 1, 'the app never navigates its own web view away');
  finished();
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
  assert.equal(removed, 1);
  await assert.rejects(openExternal('http://example.com/pay', { win }), /Only https/);
  await assert.rejects(openExternal('javascript:alert(1)', { win }), /Only https/);
});

test('Keychain helpers call the FishtapeKeychain plugin', async () => {
  const saved = new Map();
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      FishtapeKeychain: {
        get: async ({ key }) => (saved.has(key) ? { value: saved.get(key) } : {}),
        set: async ({ key, value }) => { saved.set(key, value); },
        remove: async ({ key }) => { saved.delete(key); },
      },
    },
  };
  assert.equal(await getSecret('session'), null);
  await setSecret('session', 'tok-1');
  assert.equal(await getSecret('session'), 'tok-1');
  await removeSecret('session');
  assert.equal(await getSecret('session'), null);
});

/** A fake window for the print helper: its own timers, events and print plugin. */
function fakeWindow({ fail = false } = {}) {
  const events = [];
  let finishPrint;
  const timers = [];
  const win = {
    events, timers,
    document: { title: 'Invoice INV-1001' },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    dispatchEvent: (e) => { events.push(e.type); return true; },
    Capacitor: { Plugins: { FishtapePrint: { print: (o) => { events.push(`print:${o.jobName}`); return new Promise((res, rej) => { finishPrint = fail ? () => rej(new Error('no printer')) : res; }); } } } },
    finish: () => finishPrint(),
  };
  return win;
}

test('nativePrint holds the clean-up timers of the calling task until the print sheet closes', async () => {
  const win = fakeWindow();
  const realSetTimeout = win.setTimeout;
  // what printDocument() does: print, then schedule the clean-up
  nativePrint(win);
  win.setTimeout(() => win.events.push('cleanup'), 500);
  assert.equal(win.timers.length, 0, 'the clean-up timer is held, not scheduled');
  nativePrint(win); // a second tap while the sheet is open does nothing
  await new Promise((r) => setImmediate(r));
  assert.equal(win.setTimeout, realSetTimeout, 'setTimeout is restored after the task');
  assert.deepEqual(win.events, ['beforeprint', 'print:Invoice INV-1001']);
  win.setTimeout(() => {}, 10); // later tasks are not held
  assert.equal(win.timers.length, 1);
  win.finish();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(win.events, ['beforeprint', 'print:Invoice INV-1001', 'afterprint']);
  assert.equal(win.timers.length, 2);
  assert.equal(win.timers[1].ms, 500);
  win.timers[1].fn();
  assert.equal(win.events.at(-1), 'cleanup');
});

test('nativePrint cleans up even when printing fails', async () => {
  const win = fakeWindow({ fail: true });
  const err = console.error;
  console.error = () => {};
  try {
    nativePrint(win);
    win.setTimeout(() => {}, 500);
    await new Promise((r) => setImmediate(r));
    win.finish();
    await new Promise((r) => setImmediate(r));
  } finally { console.error = err; }
  assert.equal(win.events.at(-1), 'afterprint');
  assert.equal(win.timers.length, 1);
});

test('installNativePrint only replaces window.print inside the app', () => {
  const win = fakeWindow();
  const original = () => 'browser print';
  win.print = original;
  assert.equal(installNativePrint(win), false);
  assert.equal(win.print, original);
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  assert.equal(installNativePrint(win), true);
  assert.notEqual(win.print, original);
  assert.equal(installNativePrint(win), false, 'once');
});

test("WebKit's own print events don't reach the screens while the sheet is open", async () => {
  let finishPrint;
  const win = Object.assign(new EventTarget(), {
    document: { title: 'Bend sheet' },
    setTimeout: (fn) => { fn(); return 1; },
    Capacitor: { Plugins: { FishtapePrint: { print: () => new Promise((res) => { finishPrint = res; }) } } },
  });
  globalThis.Capacitor = { isNativePlatform: () => true, Plugins: {} };
  assert.equal(installNativePrint(win), true);
  const seen = [];
  win.addEventListener('afterprint', () => seen.push('screen afterprint'));
  win.print();
  await new Promise((r) => setImmediate(r));
  win.dispatchEvent(new Event('beforeprint')); // WebKit laying out the preview
  win.dispatchEvent(new Event('afterprint'));
  assert.deepEqual(seen, [], 'the print-only copy stays mounted');
  finishPrint({ completed: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['screen afterprint']);
  win.dispatchEvent(new Event('afterprint')); // once the sheet is closed, events pass again
  assert.equal(seen.length, 2);
});
