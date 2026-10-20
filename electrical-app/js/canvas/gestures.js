// Finger gestures on the drawing canvas: what a two-finger tap, a three-finger tap and a
// one-finger touch-and-hold do, and telling a tap apart from a pinch or a pan. The detector and
// the preference model are pure (no DOM) so they can be tested; gesturePanel() builds the
// Settings controls with the ui helpers it is given.
//
// The choices are the person's own: kept on this device (localStorage) like units, and in their
// profile when signed in (PATCH /api/v1/me/prefs, see session.js), so they follow them.

export const GESTURE_ACTIONS = [
  { id: 'undo', label: 'Undo' },
  { id: 'redo', label: 'Redo' },
  { id: 'wheel', label: 'Show tool wheel' },
  { id: 'lastTool', label: 'Toggle last tool' },
  { id: 'fit', label: 'Zoom to fit' },
  { id: 'none', label: 'Nothing' },
];
export const GESTURE_ACTION_IDS = GESTURE_ACTIONS.map((a) => a.id);

/** Each gesture: its prefs key, label and default action. */
export const GESTURES = [
  { key: 'twoFingerTap', label: 'Two-finger tap', def: 'undo' },
  { key: 'threeFingerTap', label: 'Three-finger tap', def: 'redo' },
  { key: 'longPress', label: 'Touch and hold', hint: 'One finger, held still, when fingers pan (after the Pencil has been used)', def: 'none' },
];
export const GESTURE_KEYS = GESTURES.map((g) => g.key);

const LS_KEY = 'ft.gestures';
const readAll = () => { try { const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };

/** Has this person picked an action for the gesture on this device? */
export function hasGestureChoice(key) { return GESTURE_ACTION_IDS.includes(readAll()[key]); }

/** The action for a gesture key ('twoFingerTap'…), or its default. */
export function getGesture(key) {
  const v = readAll()[key];
  return GESTURE_ACTION_IDS.includes(v) ? v : GESTURES.find((g) => g.key === key)?.def ?? 'none';
}

/** All three: { twoFingerTap, threeFingerTap, longPress }. */
export function gesturePrefs() { return Object.fromEntries(GESTURE_KEYS.map((k) => [k, getGesture(k)])); }

export function setGesture(key, action) {
  if (!GESTURE_KEYS.includes(key)) throw new Error(`Unknown gesture: ${key}`);
  if (!GESTURE_ACTION_IDS.includes(action)) throw new Error(`Unknown gesture action: ${action}`);
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...readAll(), [key]: action })); } catch { /* storage blocked */ }
}

export const actionLabel = (id) => GESTURE_ACTIONS.find((a) => a.id === id)?.label || id;

/** Tap timing: fingers land within downMs of each other, each lifts within upMs, moving under slop px. */
export const TAP = { downMs: 150, upMs: 250, slop: 12, holdMs: 550 };

/**
 * A detector for multi-finger taps and a one-finger hold, fed touch pointers in screen px and ms.
 *   down(id, x, y, t) / move(id, x, y, t) / up(id, t) -> 2 or 3 when the last finger of a tap lifts, else null
 *   cancel()  the Pencil came down (or the touches were taken away): no tap from these fingers
 *   holdDue(t) -> true once, when one finger has been held still long enough
 * A tap needs every finger down at the same time (two quick one-finger taps are not a two-finger tap).
 */
export function createTapDetector(opts = {}) {
  const o = { ...TAP, ...opts };
  const fingers = new Map();
  let s = null; // { first, count, max, valid, held }
  const fail = () => { if (s) s.valid = false; };
  return {
    get active() { return fingers.size; },
    down(id, x, y, t) {
      if (!fingers.size) s = { first: t, count: 0, max: 0, valid: true, held: false };
      if (!s) return;
      if (t - s.first > o.downMs) fail();
      fingers.set(id, { x0: x, y0: y, t });
      s.count++;
      s.max = Math.max(s.max, fingers.size);
    },
    move(id, x, y) {
      const f = fingers.get(id);
      if (f && Math.hypot(x - f.x0, y - f.y0) > o.slop) fail();
    },
    up(id, t) {
      const f = fingers.get(id);
      if (!f || !s) return null;
      fingers.delete(id);
      if (t - f.t > o.upMs) fail();
      if (fingers.size) return null;
      const done = s;
      s = null;
      return done.valid && !done.held && done.count >= 2 && done.count <= 3 && done.max === done.count ? done.count : null;
    },
    cancel() { fingers.clear(); s = null; },
    holdDue(t) {
      if (!s || !s.valid || s.held || s.count !== 1 || fingers.size !== 1 || t - s.first < o.holdMs) return false;
      s.held = true;
      return true;
    },
  };
}

/**
 * Settings controls for the gestures: one row per gesture with a select of actions.
 * @param {{ h: Function }} ui
 * @param {(key: string, action: string) => any} save  stores the choice (session.savePref when signed in)
 */
export function gesturePanel(ui, save) {
  const { h } = ui;
  const prefs = gesturePrefs();
  return h('div', { class: 'stack cv-gestures' },
    GESTURES.map((g) => {
      const id = `gesture-${g.key}`;
      return h('label', { class: 'field', for: id },
        h('span', null, g.label),
        h('select', { id, name: g.key, 'aria-label': g.label, onChange: async (e) => { await save(g.key, e.target.value); ui.toast?.(`${g.label}: ${actionLabel(e.target.value)}`, 'success'); } },
          GESTURE_ACTIONS.map((a) => h('option', { value: a.id, selected: prefs[g.key] === a.id }, a.label))),
        g.hint ? h('span', { class: 'hint' }, g.hint) : null);
    }),
    h('div', { class: 'muted' }, 'Taps never fire while the Pencil is on the glass, during a pinch or pan, or when your fingers move.'));
}
