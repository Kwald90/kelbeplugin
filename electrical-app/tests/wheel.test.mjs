// The quick-actions wheel: each person's show/hide/order prefs (lib/wheel.js), which the live wheel
// and the Settings editor share.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// a tiny localStorage for node
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { WHEEL, wheelPrefs, saveWheelPrefs, resetWheelPrefs, orderWheel } = await import('../js/lib/wheel.js');

const ids = (list) => list.map((w) => w.id);

test('every shortcut has a stable id, icon and either a target or a run handler', () => {
  const seen = new Set();
  for (const w of WHEEL) {
    assert.ok(w.id && !seen.has(w.id), `duplicate or missing id: ${w.id}`);
    seen.add(w.id);
    assert.ok(w.icon && w.label, `${w.id} needs an icon and label`);
    assert.ok(w.go || w.run, `${w.id} needs go or run`);
  }
});

test('no prefs: the wheel is the full list in its default order', () => {
  assert.deepEqual(ids(orderWheel(WHEEL, {})), ids(WHEEL));
  assert.deepEqual(ids(orderWheel(WHEEL)), ids(WHEEL));
});

test('hidden ids drop out; the rest keep their order', () => {
  const shown = orderWheel(WHEEL, { hidden: ['draw', 'calc'] });
  assert.ok(!ids(shown).includes('draw') && !ids(shown).includes('calc'));
  assert.equal(shown.length, WHEEL.length - 2);
});

test('order puts placed ids first; unplaced (newer) shortcuts keep WHEEL order after them', () => {
  const shown = orderWheel(WHEEL, { order: ['sops', 'job'] });
  assert.equal(shown[0].id, 'sops');
  assert.equal(shown[1].id, 'job');
  // the rest follow in their original relative order
  const rest = ids(shown).slice(2);
  const expected = ids(WHEEL).filter((id) => id !== 'sops' && id !== 'job');
  assert.deepEqual(rest, expected);
});

test('orderWheel only ever returns items from the list it was given (permission-filtered)', () => {
  const allowed = WHEEL.filter((w) => w.id !== 'invoice' && w.id !== 'receipt');
  const shown = orderWheel(allowed, { order: ['invoice', 'clock'] }); // invoice not allowed
  assert.ok(!ids(shown).includes('invoice'));
  assert.equal(shown[0].id, 'clock');
});

test('prefs round-trip per user and reset clears them', () => {
  mem.clear();
  saveWheelPrefs('u1', { hidden: ['calc'], order: ['job'] });
  assert.deepEqual(wheelPrefs('u1'), { hidden: ['calc'], order: ['job'] });
  assert.deepEqual(wheelPrefs('u2'), {}, 'another person is unaffected');
  resetWheelPrefs('u1');
  assert.deepEqual(wheelPrefs('u1'), {});
});

test('bad stored JSON falls back to defaults', () => {
  mem.set('kc.wheel.u3', '{not json');
  assert.deepEqual(wheelPrefs('u3'), {});
});
