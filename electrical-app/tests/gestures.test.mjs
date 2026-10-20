// Run: node --test electrical-app/tests/
// Finger taps on the canvas: a two- or three-finger tap is told apart from a pinch, a pan, slow
// presses, staggered fingers and the Pencil; the per-person choices are stored and synced.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// a tiny localStorage for node
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { createTapDetector, gesturePrefs, getGesture, setGesture, hasGestureChoice, GESTURE_ACTION_IDS } = await import('../js/canvas/gestures.js');
const { reconcilePrefs } = await import('../js/session.js');

/**
 * Play a touch sequence: [[t, 'down'|'move'|'up', id, x, y], ...]; returns what the last up gave.
 */
function play(seq, det = createTapDetector()) {
  const results = [];
  for (const [t, kind, id, x, y] of seq) {
    if (kind === 'down') det.down(id, x, y, t);
    else if (kind === 'move') det.move(id, x, y, t);
    else if (kind === 'up') { const r = det.up(id, t); if (r) results.push(r); }
    else if (kind === 'pen') det.cancel();
  }
  return results;
}

test('two fingers down together and lifted quickly is a two-finger tap', () => {
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [30, 'down', 2, 180, 110], [110, 'up', 1], [130, 'up', 2]]), [2]);
});

test('three fingers is a three-finger tap; a little wobble is allowed', () => {
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [20, 'down', 2, 160, 100], [60, 'down', 3, 220, 100],
    [80, 'move', 2, 163, 104], [150, 'up', 3], [160, 'up', 1], [170, 'up', 2]]), [3]);
});

test('a pinch is not a tap', () => {
  const seq = [[0, 'down', 1, 100, 100], [20, 'down', 2, 200, 100]];
  for (let i = 1; i <= 6; i++) seq.push([20 + i * 16, 'move', 1, 100 - i * 8, 100], [20 + i * 16, 'move', 2, 200 + i * 8, 100]);
  seq.push([140, 'up', 1], [150, 'up', 2]);
  assert.deepEqual(play(seq), []);
});

test('a quick two-finger pan is not a tap', () => {
  const seq = [[0, 'down', 1, 100, 100], [15, 'down', 2, 160, 100]];
  for (let i = 1; i <= 5; i++) seq.push([15 + i * 16, 'move', 1, 100, 100 + i * 9], [15 + i * 16, 'move', 2, 160, 100 + i * 9]);
  seq.push([110, 'up', 1], [115, 'up', 2]);
  assert.deepEqual(play(seq), []);
});

test('fingers held too long, or landing too far apart in time, are not a tap', () => {
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [20, 'down', 2, 160, 100], [400, 'up', 1], [410, 'up', 2]]), [], 'held');
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [220, 'down', 2, 160, 100], [300, 'up', 1], [310, 'up', 2]]), [], 'staggered');
});

test('two quick one-finger taps in a row are not a two-finger tap', () => {
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [60, 'up', 1], [80, 'down', 2, 160, 100], [140, 'up', 2]]), []);
});

test('a single finger tap is not a gesture', () => {
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [60, 'up', 1]]), []);
});

test('the Pencil coming down cancels a tap in progress, and the next tap still works', () => {
  const det = createTapDetector();
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [20, 'down', 2, 160, 100], [40, 'pen'], [90, 'up', 1], [100, 'up', 2]], det), []);
  assert.deepEqual(play([[1000, 'down', 5, 100, 100], [1020, 'down', 6, 160, 100], [1100, 'up', 5], [1120, 'up', 6]], det), [2]);
});

test('touch-and-hold fires once for one still finger, and not after it moves', () => {
  const det = createTapDetector();
  det.down(1, 100, 100, 0);
  assert.equal(det.holdDue(300), false);
  assert.equal(det.holdDue(600), true);
  assert.equal(det.holdDue(700), false, 'only once');
  assert.equal(det.up(1, 800), null);
  det.down(2, 100, 100, 1000);
  det.move(2, 140, 100, 1100);
  assert.equal(det.holdDue(1700), false, 'moved: a pan');
  det.up(2, 1800);
  det.down(3, 100, 100, 2000); det.down(4, 160, 100, 2010);
  assert.equal(det.holdDue(2700), false, 'two fingers');
});

beforeEach(() => mem.clear());

test('gesture prefs: defaults are undo / redo / nothing; choices are stored and validated', () => {
  assert.deepEqual(gesturePrefs(), { twoFingerTap: 'undo', threeFingerTap: 'redo', longPress: 'none' });
  assert.equal(hasGestureChoice('twoFingerTap'), false);
  setGesture('twoFingerTap', 'wheel');
  assert.equal(getGesture('twoFingerTap'), 'wheel');
  assert.equal(hasGestureChoice('twoFingerTap'), true);
  assert.throws(() => setGesture('twoFingerTap', 'explode'));
  assert.throws(() => setGesture('fourFingerTap', 'undo'));
  assert.deepEqual(GESTURE_ACTION_IDS, ['undo', 'redo', 'wheel', 'lastTool', 'fit', 'none']);
  mem.set('ft.gestures', '{"threeFingerTap":"bogus"');
  assert.equal(getGesture('threeFingerTap'), 'redo', 'broken storage falls back to the default');
});

test('gesture prefs sync like units and theme: local changes go up, the profile comes down', () => {
  // a new device with nothing chosen takes the profile's choice
  let r = reconcilePrefs({ local: { units: null, theme: 'system', twoFingerTap: null }, server: { twoFingerTap: 'redo' }, synced: null });
  assert.equal(r.pull.twoFingerTap, 'redo');
  // changed here since the last sync: pushed
  r = reconcilePrefs({ local: { units: null, theme: 'system', twoFingerTap: 'fit' }, server: { twoFingerTap: 'undo' }, synced: { twoFingerTap: 'undo' } });
  assert.equal(r.push.twoFingerTap, 'fit');
  // untouched defaults are not pushed to a profile that has none
  r = reconcilePrefs({ local: { units: null, theme: 'system', twoFingerTap: null, threeFingerTap: null, longPress: null }, server: {}, synced: null });
  assert.equal(Object.hasOwn(r.push, 'twoFingerTap'), false);
});
