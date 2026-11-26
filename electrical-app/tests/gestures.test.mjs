// Run: node --test electrical-app/tests/
// Gestures on the canvas: a two-, three- or four-finger tap is told apart from a pinch, a pan, slow
// presses, staggered fingers and the Pencil; two fingers zoom, rotate (snapping to level) and pan;
// whether a finger draws; holding still; the Apple Pencil bridge; the per-person choices are stored
// and the synced ones synced.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// a tiny localStorage for node
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const {
  createTapDetector, gesturePrefs, getGesture, setGesture, hasGestureChoice, tapRollback, GESTURE_ACTION_IDS, GESTURE_KEYS, GESTURES,
  getOption, setOption, tapKey, fingerDraws, createStillness, screenToWorld, worldToScreen, viewAt, twoFingerView, snapRotation, normAngle,
  pencilAction, connectPencil, pencilBridge, getHoldMs, setHoldMs,
} = await import('../js/canvas/gestures.js');
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

test('gesture prefs: the Concepts-style defaults; choices are stored and validated per gesture', () => {
  assert.deepEqual(gesturePrefs(), {
    twoFingerTap: 'undo', threeFingerTap: 'redo', fourFingerTap: 'toggleUI', longPress: 'eyedropper',
    pencilHold: 'none', pencilDoubleTap: 'system', pencilSqueeze: 'palette',
  });
  assert.equal(hasGestureChoice('twoFingerTap'), false);
  setGesture('twoFingerTap', 'wheel');
  assert.equal(getGesture('twoFingerTap'), 'wheel');
  assert.equal(hasGestureChoice('twoFingerTap'), true);
  assert.throws(() => setGesture('twoFingerTap', 'explode'));
  assert.throws(() => setGesture('fiveFingerTap', 'undo'));
  assert.throws(() => setGesture('twoFingerTap', 'eyedropper'), 'a tap has no point to pick a colour at');
  assert.throws(() => setGesture('longPress', 'system'), 'only the Pencil has an iPad setting');
  setGesture('pencilDoubleTap', 'colors');
  assert.equal(getGesture('pencilDoubleTap'), 'colors');
  for (const id of ['undo', 'redo', 'toggleUI', 'wheel', 'eraser', 'lastTool', 'colors', 'palette', 'eyedropper', 'select', 'duplicate', 'picker', 'fit', 'system', 'none']) {
    assert.ok(GESTURE_ACTION_IDS.includes(id), id);
  }
  for (const g of GESTURES) assert.ok(g.actions.includes(g.def) && g.actions.every((a) => GESTURE_ACTION_IDS.includes(a)), g.key);
  mem.set('ft.gestures', '{"threeFingerTap":"bogus"');
  assert.equal(getGesture('threeFingerTap'), 'redo', 'broken storage falls back to the default');
});

test('only the taps and the finger hold go to the profile; the rest stay on the device', () => {
  assert.deepEqual(GESTURE_KEYS, ['twoFingerTap', 'threeFingerTap', 'longPress']);
});

test('options: draw with finger, pinch, rotate, hold-to-snap, hover; with defaults and validation', () => {
  assert.equal(getOption('fingerDraw'), 'auto');
  assert.equal(getOption('pinchZoom'), true);
  assert.equal(getOption('rotate'), true);
  assert.equal(getOption('holdSnap'), true);
  assert.equal(getOption('hover'), true);
  setOption('fingerDraw', 'off'); setOption('rotate', false);
  assert.equal(getOption('fingerDraw'), 'off');
  assert.equal(getOption('rotate'), false);
  assert.throws(() => setOption('fingerDraw', 'sometimes'));
  assert.throws(() => setOption('rotate', 'yes'));
  assert.throws(() => setOption('teleport', true));
  assert.equal(getHoldMs(), 550);
  assert.equal(setHoldMs(5000), 1000);
  assert.equal(getHoldMs(), 1000);
});

test('draw with finger: auto draws until the Pencil is used (or never with Only Draw with Apple Pencil)', () => {
  assert.equal(fingerDraws({ mode: 'auto', penSeen: false }), true);
  assert.equal(fingerDraws({ mode: 'auto', penSeen: true }), false);
  assert.equal(fingerDraws({ mode: 'auto', penSeen: false, pencilOnly: true }), false);
  assert.equal(fingerDraws({ mode: 'on', penSeen: true, pencilOnly: true }), true);
  assert.equal(fingerDraws({ mode: 'off', penSeen: false }), false);
});

test('a four-finger tap is a four-finger tap; five fingers are nothing', () => {
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [20, 'down', 2, 160, 100], [40, 'down', 3, 220, 100], [60, 'down', 4, 280, 110],
    [150, 'up', 1], [160, 'up', 2], [170, 'up', 3], [175, 'up', 4]]), [4]);
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [10, 'down', 2, 160, 100], [20, 'down', 3, 220, 100], [30, 'down', 4, 280, 110], [40, 'down', 5, 340, 120],
    [150, 'up', 1], [160, 'up', 2], [170, 'up', 3], [175, 'up', 4], [180, 'up', 5]]), []);
  assert.equal(tapKey(2), 'twoFingerTap');
  assert.equal(tapKey(3), 'threeFingerTap');
  assert.equal(tapKey(4), 'fourFingerTap');
  assert.equal(tapKey(5), null);
});

test('a pinch that starts slowly never undoes: once the fingers spread past the slop it is not a tap', () => {
  const seq = [[0, 'down', 1, 100, 100], [20, 'down', 2, 200, 100]];
  // the fingers creep apart, just past the slop, and lift quickly (inside the tap time)
  for (let i = 1; i <= 4; i++) seq.push([20 + i * 30, 'move', 1, 100 - i * 3.5, 100], [20 + i * 30, 'move', 2, 200 + i * 3.5, 100]);
  seq.push([150, 'up', 1], [160, 'up', 2]);
  assert.deepEqual(play(seq), []);
  // but a little wobble under the slop is still a tap
  assert.deepEqual(play([[0, 'down', 1, 100, 100], [20, 'down', 2, 200, 100], [60, 'move', 1, 104, 103], [60, 'move', 2, 197, 98], [140, 'up', 1], [150, 'up', 2]]), [2]);
});

test('holding still: only leaving the slop circle restarts the hold', () => {
  const s = createStillness({ slop: 6 });
  assert.equal(s.move(100, 100, 0), true, 'the first sample starts it');
  assert.equal(s.move(103, 102, 100), false, 'a wobble is still still');
  assert.equal(s.stillFor(600), 600);
  assert.equal(s.move(110, 100, 650), true, 'moved on');
  assert.equal(s.stillFor(700), 50);
});

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const closePt = (a, b, eps = 1e-6) => close(a[0], b[0], eps) && close(a[1], b[1], eps);

test('view maths: screen and world round-trip, rotated or not; a level view has no rot', () => {
  for (const v of [{ x: 30, y: -20, zoom: 2 }, { x: 300, y: 120, zoom: 0.5, rot: 0.7 }, { x: -50, y: 40, zoom: 3, rot: -2.4 }]) {
    for (const p of [[0, 0], [123, -45], [-300, 800]]) assert.ok(closePt(screenToWorld(v, ...worldToScreen(v, ...p)), p), JSON.stringify(v));
  }
  assert.deepEqual(Object.keys(viewAt(1, 0, 0, 0, 10, 20)).sort(), ['x', 'y', 'zoom']);
  const v = viewAt(2, Math.PI / 2, 10, 5, 400, 300);
  assert.ok(closePt(worldToScreen(v, 10, 5), [400, 300]));
  assert.ok(closePt(worldToScreen(v, 11, 5), [400, 302]), 'a quarter turn: world +x is screen +y');
});

test('two fingers: spreading zooms about their midpoint, dragging pans, and neither rotates', () => {
  const v0 = { x: 0, y: 0, zoom: 1 };
  const z = twoFingerView(v0, [400, 300], [500, 300], [350, 300], [550, 300]);
  assert.ok(close(z.zoom, 2));
  assert.equal(z.rot, undefined, 'no rotation from a straight pinch');
  assert.ok(closePt(worldToScreen(z, 450, 300), [450, 300]), 'the point between the fingers stays under them');
  const p = twoFingerView(v0, [400, 300], [500, 300], [430, 340], [530, 340]);
  assert.ok(close(p.zoom, 1) && close(p.x, 30) && close(p.y, 40), JSON.stringify(p));
  const nz = twoFingerView(v0, [400, 300], [500, 300], [350, 300], [550, 300], { zoom: false });
  assert.ok(close(nz.zoom, 1), 'pinch to zoom off: the zoom stays');
});

test('two fingers: a twist rotates past a small dead zone, snaps back to level near it, and can be turned off', () => {
  const v0 = { x: 0, y: 0, zoom: 1 };
  const turn = (deg, opts) => {
    const a = (deg * Math.PI) / 180, c = [450, 300], r = 50;
    return twoFingerView(v0, [400, 300], [500, 300], [c[0] - r * Math.cos(a), c[1] - r * Math.sin(a)], [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)], opts);
  };
  assert.equal(turn(5).rot, undefined, 'a 5° wobble while pinching does not rotate');
  assert.ok(close((turn(45).rot * 180) / Math.PI, 37), 'past the 8° dead zone, the rest of the turn counts');
  assert.ok(closePt(worldToScreen(turn(45), 450, 300), [450, 300]), 'it turns about the fingers');
  assert.ok(close((turn(100).rot * 180) / Math.PI, 90), 'within 6° of a quarter turn it snaps to it');
  assert.equal(turn(45, { rotate: false }).rot, undefined, 'rotate off');
  // turning back to near level from a rotated view snaps to exactly 0 (the rot goes away)
  const tilted = { x: 0, y: 0, zoom: 1, rot: (20 * Math.PI) / 180 };
  const back = twoFingerView(tilted, [400, 300], [500, 300], [400 + 50 - 50 * Math.cos(-0.43), 300 - 50 * Math.sin(-0.43)], [450 + 50 * Math.cos(-0.43), 300 + 50 * Math.sin(-0.43)]);
  assert.equal(back.rot, undefined, `level again (${back.rot})`);
  assert.equal(snapRotation((3 * Math.PI) / 180), 0);
  assert.ok(close(snapRotation(Math.PI - 0.05), Math.PI));
  assert.ok(close(snapRotation(0.5), 0.5));
  assert.ok(close(normAngle(3 * Math.PI), Math.PI) && close(normAngle(-Math.PI / 2 - 2 * Math.PI), -Math.PI / 2));
});

test('Pencil double-tap and squeeze: the person\'s choice, or the iPad\'s own setting', () => {
  assert.equal(pencilAction('colors', 'switchEraser'), 'colors');
  assert.equal(pencilAction('system', 'switchEraser'), 'eraser');
  assert.equal(pencilAction('system', 'switchPrevious'), 'lastTool');
  assert.equal(pencilAction('system', 'showColorPalette'), 'colors');
  assert.equal(pencilAction('system', 'showContextualPalette'), 'palette');
  assert.equal(pencilAction('system', 'ignore'), 'none');
  assert.equal(pencilAction('system', 'somethingNew'), 'none');
  assert.equal(pencilAction('system', null), 'eraser', 'the iPad default when it did not say');
});

test('without the iOS app\'s Pencil bridge nothing happens; with it, double-tap and squeeze arrive', async () => {
  delete globalThis.Capacitor;
  assert.equal(pencilBridge(), false);
  const none = connectPencil({ onDoubleTap: () => assert.fail('no bridge') });
  assert.equal(none.available, false);
  none.off();
  const listeners = new Map();
  let removed = 0;
  globalThis.Capacitor = { Plugins: { FishtapePencil: {
    addListener: (name, fn) => { listeners.set(name, fn); return Promise.resolve({ remove: () => { removed++; } }); },
    status: async () => ({ available: true, preferredTapAction: 'switchPrevious', prefersPencilOnlyDrawing: true }),
  } } };
  const got = [];
  const p = connectPencil({ onDoubleTap: (e) => got.push(['tap', e.preferred]), onSqueeze: (e) => got.push(['squeeze', e.phase]) });
  assert.equal(p.available, true);
  assert.equal(pencilBridge(), true);
  listeners.get('doubleTap')({ preferred: 'switchEraser' });
  listeners.get('squeeze')({ phase: 'ended' });
  assert.deepEqual(got, [['tap', 'switchEraser'], ['squeeze', 'ended']]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.pencilOnly, true, 'Only Draw with Apple Pencil is read from the iPad');
  assert.equal(p.preferredTap, 'switchPrevious');
  p.off();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(removed, 2);
  delete globalThis.Capacitor;
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

// The editor's undo model (canvas/editor.js): checkpoint() pushes a snapshot and clears redo; a
// recognised tap takes back its first finger (tapRollback) and then runs the gesture.
function miniEditor(items) {
  const ed = { items: [...items], undo: [], redo: [], mark: null };
  const snap = () => ({ json: JSON.stringify(ed.items) });
  ed.checkpoint = () => { ed.undo.push(snap()); if (ed.undo.length > 80) ed.undo.shift(); ed.redo = []; };
  ed.doUndo = () => { if (!ed.undo.length) return false; ed.redo.push(snap()); ed.items = JSON.parse(ed.undo.pop().json); return true; };
  ed.doRedo = () => { if (!ed.redo.length) return false; ed.undo.push(snap()); ed.items = JSON.parse(ed.redo.pop().json); return true; };
  ed.erase = (x) => { ed.checkpoint(); ed.items = ed.items.filter((i) => i !== x); };
  ed.place = (x) => { ed.checkpoint(); ed.items.push(x); };
  ed.fingerDown = () => { ed.mark = { undo: ed.undo.slice(), redo: ed.redo.slice() }; };
  ed.tap = (act) => {
    const back = tapRollback(ed.mark, ed.undo);
    ed.mark = null;
    if (back) { ed.items = JSON.parse(back.snap.json); ed.undo = back.undo; ed.redo = back.redo; }
    return act === 'undo' ? ed.doUndo() : ed.doRedo();
  };
  return ed;
}

test('a two-finger tap whose first finger erased something undoes the last real erase', () => {
  const ed = miniEditor(['a', 'b', 'c']);
  ed.erase('a'); // what the person wants undone
  ed.fingerDown(); ed.erase('b'); // the tap's first finger lands on other ink
  ed.tap('undo');
  assert.deepEqual(ed.items, ['a', 'b', 'c'], 'b is back and so is a');
  assert.equal(ed.redo.length, 1);
  ed.fingerDown(); ed.erase('c'); // a three-finger tap's first finger
  assert.equal(ed.tap('redo'), true, 'redo history survives the tap');
  assert.deepEqual(ed.items, ['b', 'c']);
});

test('a two-finger tap while placing symbols undoes the previous placement, not the one it made', () => {
  const ed = miniEditor([]);
  ed.place('s1'); ed.place('s2');
  ed.fingerDown(); ed.place('s3');
  ed.tap('undo');
  assert.deepEqual(ed.items, ['s1']);
  ed.fingerDown(); ed.place('s4');
  ed.tap('undo');
  assert.deepEqual(ed.items, []);
});

test('tap rollback: nothing to take back when the first finger changed nothing, and a full undo stack is kept whole', () => {
  assert.equal(tapRollback(null, []), null);
  const ed = miniEditor(['x']);
  for (let i = 0; i < 80; i++) ed.place(`p${i}`);
  ed.fingerDown();
  assert.equal(tapRollback(ed.mark, ed.undo), null, 'a freehand finger commits nothing before lifting');
  const oldest = ed.undo[0];
  ed.place('stray'); // the 81st checkpoint drops the oldest
  ed.tap('undo');
  assert.equal(ed.undo[0], oldest, 'the dropped snapshot is back');
  assert.equal(ed.undo.length, 79);
  assert.deepEqual(ed.items, ['x', ...Array.from({ length: 79 }, (_, i) => `p${i}`)]);
});
