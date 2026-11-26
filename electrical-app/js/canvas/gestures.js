// Finger and Pencil gestures on the drawing canvas, modelled on the Concepts app's gesture
// settings: what two-, three- and four-finger taps do, touch-and-hold with a finger or the
// Pencil, the Apple Pencil's double-tap and squeeze, whether a finger draws, pinch and rotate,
// hold-to-snap and the Pencil hover preview. Telling a tap apart from a pinch or a pan, the
// two-finger view maths (zoom, rotate with snap to level, pan) and the preference model are pure
// (no DOM) so they can be tested; gesturePanel() builds the settings controls with the ui helpers
// it is given, and connectPencil() reaches the iOS app's FishtapePencil plugin when there is one.
//
// The choices are the person's own: kept on this device (localStorage) like units. The taps and
// the finger touch-and-hold (GESTURE_KEYS) also go to their profile when signed in (PATCH
// /api/v1/me/prefs, see session.js), so they follow them to their other devices.

export const GESTURE_ACTIONS = [
  { id: 'undo', label: 'Undo' },
  { id: 'redo', label: 'Redo' },
  { id: 'toggleUI', label: 'Hide or show toolbars' },
  { id: 'wheel', label: 'Tuck away or show the tool wheel' },
  { id: 'eraser', label: 'Switch to eraser and back' },
  { id: 'lastTool', label: 'Toggle last tool' },
  { id: 'colors', label: 'Show colour picker' },
  { id: 'palette', label: 'Show tool palette' },
  { id: 'eyedropper', label: 'Eyedropper' },
  { id: 'select', label: 'Select' },
  { id: 'duplicate', label: 'Duplicate selection' },
  { id: 'picker', label: 'Symbol picker' },
  { id: 'fit', label: 'Zoom to fit' },
  { id: 'system', label: 'Same as the iPad setting' },
  { id: 'none', label: 'Nothing' },
];
export const GESTURE_ACTION_IDS = GESTURE_ACTIONS.map((a) => a.id);

const TAP_ACTIONS = ['undo', 'redo', 'toggleUI', 'wheel', 'eraser', 'lastTool', 'colors', 'palette', 'duplicate', 'picker', 'fit', 'none'];
const HOLD_ACTIONS = ['eyedropper', 'select', 'colors', 'palette', 'picker', 'undo', 'redo', 'toggleUI', 'wheel', 'eraser', 'lastTool', 'fit', 'none'];
const PENCIL_ACTIONS = ['system', 'eraser', 'lastTool', 'colors', 'palette', 'undo', 'redo', 'toggleUI', 'wheel', 'fit', 'none'];

/**
 * Each gesture: its prefs key, label, default action and the actions it can take. `sync`: it also
 * goes to the person's profile. `pencil`: it needs the iOS app's native Pencil bridge.
 */
export const GESTURES = [
  { key: 'twoFingerTap', label: 'Two-finger tap', group: 'Taps', def: 'undo', actions: TAP_ACTIONS, sync: true },
  { key: 'threeFingerTap', label: 'Three-finger tap', group: 'Taps', def: 'redo', actions: TAP_ACTIONS, sync: true },
  { key: 'fourFingerTap', label: 'Four-finger tap', group: 'Taps', def: 'toggleUI', actions: TAP_ACTIONS },
  { key: 'longPress', label: 'Finger touch and hold', group: 'Touch and hold', hint: 'One finger held still: where fingers pan, or before a finger starts to draw', def: 'eyedropper', actions: HOLD_ACTIONS, sync: true },
  { key: 'pencilHold', label: 'Pencil touch and hold', group: 'Touch and hold', hint: 'The Pencil held still where it touched, before it moves', def: 'none', actions: HOLD_ACTIONS },
  { key: 'pencilDoubleTap', label: 'Double-tap the Pencil', group: 'Apple Pencil', hint: 'Apple Pencil 2 and Pencil Pro', def: 'system', actions: PENCIL_ACTIONS, pencil: true },
  { key: 'pencilSqueeze', label: 'Squeeze the Pencil', group: 'Apple Pencil', hint: 'Apple Pencil Pro', def: 'palette', actions: PENCIL_ACTIONS, pencil: true },
];
/** The gestures that follow the person to their other devices (session.js syncs these). */
export const GESTURE_KEYS = GESTURES.filter((g) => g.sync).map((g) => g.key);
const ALL_KEYS = GESTURES.map((g) => g.key);

/** On/off and choice settings: whether a finger draws, pinch, rotate, hold-to-snap, hover. Device only. */
export const GESTURE_OPTIONS = [
  { key: 'fingerDraw', label: 'Draw with finger', group: 'Finger and Pencil', def: 'auto',
    choices: [{ id: 'auto', label: 'Until the Pencil is used' }, { id: 'on', label: 'Always' }, { id: 'off', label: 'Never' }],
    hint: 'When a finger does not draw, one finger pans and a tap selects; the Pencil draws.' },
  { key: 'pinchZoom', label: 'Pinch to zoom', group: 'Two fingers', def: true },
  { key: 'rotate', label: 'Rotate the canvas with two fingers', group: 'Two fingers', def: true, hint: 'Snaps back to level near 0°, 90°, 180° and 270°.' },
  { key: 'holdSnap', label: 'Hold at the end of a stroke to snap it', group: 'Touch and hold', def: true,
    hint: 'Straightens it into a line, or a circle, ellipse, rectangle or triangle when the stroke closes.' },
  { key: 'hover', label: 'Brush preview while the Pencil hovers', group: 'Apple Pencil', def: true, hint: 'iPad Pro with M2 or later.' },
];

const LS_KEY = 'ft.gestures';
const readAll = () => { try { const v = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const writeKey = (k, v) => { try { localStorage.setItem(LS_KEY, JSON.stringify({ ...readAll(), [k]: v })); } catch { /* storage blocked */ } };
const gestureOf = (key) => GESTURES.find((g) => g.key === key);
const allowed = (key, action) => !!gestureOf(key)?.actions.includes(action);

/** Has this person picked an action for the gesture on this device? */
export function hasGestureChoice(key) { return allowed(key, readAll()[key]); }

/** The action for a gesture key ('twoFingerTap'…), or its default. */
export function getGesture(key) {
  const v = readAll()[key];
  return allowed(key, v) ? v : gestureOf(key)?.def ?? 'none';
}

/** Every gesture's action: { twoFingerTap, threeFingerTap, fourFingerTap, longPress, … }. */
export function gesturePrefs() { return Object.fromEntries(ALL_KEYS.map((k) => [k, getGesture(k)])); }

export function setGesture(key, action) {
  if (!ALL_KEYS.includes(key)) throw new Error(`Unknown gesture: ${key}`);
  if (!allowed(key, action)) throw new Error(`Unknown gesture action: ${action}`);
  writeKey(key, action);
}

/** An option's value ('fingerDraw' -> 'auto' | 'on' | 'off'; the rest true/false), or its default. */
export function getOption(key) {
  const o = GESTURE_OPTIONS.find((x) => x.key === key);
  if (!o) return undefined;
  const v = readAll()[key];
  if (o.choices) return o.choices.some((c) => c.id === v) ? v : o.def;
  return typeof v === 'boolean' ? v : o.def;
}
export function setOption(key, value) {
  const o = GESTURE_OPTIONS.find((x) => x.key === key);
  if (!o) throw new Error(`Unknown gesture option: ${key}`);
  if (o.choices ? !o.choices.some((c) => c.id === value) : typeof value !== 'boolean') throw new Error(`Bad value for ${key}: ${value}`);
  writeKey(key, value);
}

export const actionLabel = (id) => GESTURE_ACTIONS.find((a) => a.id === id)?.label || id;

/** Tap timing: fingers land within downMs of each other, each lifts within upMs, moving under slop px. */
export const TAP = { downMs: 150, upMs: 250, slop: 12, holdMs: 550 };

// How long a touch-and-hold must stay still before it fires — a per-device setting (localStorage).
const HOLD_KEY = '_holdMs';
export const HOLD_MIN = 200, HOLD_MAX = 1000;
export function getHoldMs() {
  const raw = readAll()[HOLD_KEY];
  const v = Number(raw);
  return raw != null && Number.isFinite(v) ? Math.min(HOLD_MAX, Math.max(HOLD_MIN, v)) : TAP.holdMs;
}
export function setHoldMs(ms) {
  const v = Math.min(HOLD_MAX, Math.max(HOLD_MIN, Math.round(Number(ms) || TAP.holdMs)));
  writeKey(HOLD_KEY, v);
  return v;
}

/**
 * A detector for multi-finger taps and a one-finger hold, fed touch pointers in screen px and ms.
 *   down(id, x, y, t) / move(id, x, y, t) / up(id, t) -> 2, 3 or 4 when the last finger of a tap lifts, else null
 *   cancel()  the Pencil came down (or the touches were taken away): no tap from these fingers
 *   holdDue(t) -> true once, when one finger has been held still long enough
 * A tap needs every finger down at the same time (two quick one-finger taps are not a two-finger
 * tap), every finger to lift quickly, and none to move more than a little: a pinch or a pan that
 * starts is never a tap, so it never undoes anything.
 */
export function createTapDetector(opts = {}) {
  const o = { maxFingers: 4, ...TAP, ...opts };
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
      return done.valid && !done.held && done.count >= 2 && done.count <= o.maxFingers && done.max === done.count ? done.count : null;
    },
    cancel() { fingers.clear(); s = null; },
    holdDue(t) {
      const holdMs = typeof o.holdMs === 'function' ? o.holdMs() : o.holdMs; // live, so the setting applies at once
      if (!s || !s.valid || s.held || s.count !== 1 || fingers.size !== 1 || t - s.first < holdMs) return false;
      s.held = true;
      return true;
    },
  };
}

/** The tap gesture key for a number of fingers. */
export const tapKey = (n) => ({ 2: 'twoFingerTap', 3: 'threeFingerTap', 4: 'fourFingerTap' })[n] || null;

/**
 * Does a finger draw? 'on' always, 'off' never, 'auto' until the Pencil has been used on this
 * drawing (or never, when iPadOS's "Only Draw with Apple Pencil" is on).
 */
export function fingerDraws({ mode = 'auto', penSeen = false, pencilOnly = false } = {}) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !penSeen && !pencilOnly;
}

/**
 * Is the pointer holding still? move(x, y, t) re-anchors and returns true when the pointer leaves
 * the slop circle around where the hold began (so a hold timer restarts); stillFor(t) is how long
 * it has stayed inside. Used for hold-to-snap at the end of a stroke and the Pencil's hold.
 */
export function createStillness({ slop = 6 } = {}) {
  let ax = 0, ay = 0, at = 0, started = false;
  return {
    move(x, y, t) {
      if (started && Math.hypot(x - ax, y - ay) <= slop) return false;
      ax = x; ay = y; at = t; started = true;
      return true;
    },
    stillFor(t) { return started ? t - at : 0; },
  };
}

// ---------- the view: zoom, rotation and pan ----------
// A view is { x, y, zoom, rot? }: screen = R(rot) · world · zoom + (x, y). rot (radians) is left
// out when level, so views saved before rotation existed read the same.

const TAU = Math.PI * 2;
/** An angle in (-π, π]. */
export const normAngle = (a) => { let r = ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI; if (r <= -Math.PI) r += TAU; return r; };
const mkView = (zoom, rot, x, y) => (rot ? { zoom, rot, x, y } : { zoom, x, y });

export function screenToWorld(v, sx, sy) {
  const r = v.rot || 0, dx = (sx - v.x) / v.zoom, dy = (sy - v.y) / v.zoom;
  if (!r) return [dx, dy];
  const c = Math.cos(r), s = Math.sin(r);
  return [c * dx + s * dy, -s * dx + c * dy];
}
export function worldToScreen(v, wx, wy) {
  const r = v.rot || 0, c = Math.cos(r), s = Math.sin(r);
  return [v.x + v.zoom * (c * wx - s * wy), v.y + v.zoom * (s * wx + c * wy)];
}
/** The view with this zoom and rotation that puts world (wx, wy) at screen (sx, sy). */
export function viewAt(zoom, rot, wx, wy, sx, sy) {
  const r = rot || 0, c = Math.cos(r), s = Math.sin(r);
  return mkView(zoom, r, sx - zoom * (c * wx - s * wy), sy - zoom * (s * wx + c * wy));
}

/** Rotation: a twist under deadDeg is ignored (a pinch never turns the page); near level it snaps. */
export const ROTATE = { deadDeg: 8, snapDeg: 6 };

/** Snap a rotation to the nearest quarter turn when within snapDeg of it; 0 when level. */
export function snapRotation(rot, snapDeg = ROTATE.snapDeg) {
  let r = normAngle(rot || 0);
  const q = Math.PI / 2, k = Math.round(r / q);
  if (Math.abs(r - k * q) <= (snapDeg * Math.PI) / 180) r = normAngle(k * q);
  return Math.abs(r) < 1e-9 ? 0 : r;
}

/**
 * Two fingers moved from a0, b0 to a1, b1 (screen px), starting from view v0: the new view.
 * Pinch zooms (when zoom), twisting rotates (when rotate), and the point under the fingers'
 * midpoint stays under it, so dragging two fingers pans.
 */
export function twoFingerView(v0, a0, b0, a1, b1, { zoom = true, rotate = true, minZoom = 0.05, maxZoom = 24, deadDeg = ROTATE.deadDeg, snapDeg = ROTATE.snapDeg } = {}) {
  const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 1, d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1]) || 1;
  const nz = zoom ? Math.min(maxZoom, Math.max(minZoom, (v0.zoom * d1) / d0)) : v0.zoom;
  let rot = v0.rot || 0;
  if (rotate) {
    let da = normAngle(Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]));
    const dead = (deadDeg * Math.PI) / 180;
    da = Math.abs(da) <= dead ? 0 : da - Math.sign(da) * dead;
    rot = snapRotation(rot + da, snapDeg);
  }
  const c0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2], c1 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
  const [wx, wy] = screenToWorld(v0, c0[0], c0[1]);
  return viewAt(nz, rot, wx, wy, c1[0], c1[1]);
}

// ---------- Apple Pencil (iOS app) ----------

/** iPadOS's own Pencil setting (UIPencilInteraction.preferredTapAction / preferredSqueezeAction) as an action. */
export const PENCIL_PREFERRED = {
  switchEraser: 'eraser', switchPrevious: 'lastTool', showColorPalette: 'colors', showInkAttributes: 'palette',
  showContextualPalette: 'palette', ignore: 'none', runSystemShortcut: 'none',
};
/** The action to run for a Pencil double-tap or squeeze: the person's choice, or the iPad's when 'system'. */
export function pencilAction(choice, preferred) {
  if (choice !== 'system') return choice;
  if (!preferred) return 'eraser'; // the iPad's default
  return PENCIL_PREFERRED[preferred] ?? 'none';
}

const pencilPlugin = () => { try { return globalThis.Capacitor?.Plugins?.FishtapePencil || null; } catch { return null; } };
/** Is the iOS app's Pencil bridge here (double-tap and squeeze)? */
export const pencilBridge = () => !!pencilPlugin()?.addListener;

/**
 * Listen for the Apple Pencil's double-tap and squeeze from the iOS app's FishtapePencil plugin
 * (mobile/ios/App/App/Plugins/FishtapePencilPlugin.swift). Without the plugin (a browser, the
 * Android app, an older iOS build) nothing happens and `available` is false.
 *   onDoubleTap({ preferred, x?, y? })      preferred: the iPad's setting ('switchEraser'…)
 *   onSqueeze({ phase, preferred, x?, y? })  phase 'began' | 'changed' | 'ended' | 'cancelled'
 * @returns {{ available: boolean, pencilOnly: boolean, preferredTap: string|null, off(): void }}
 */
export function connectPencil({ onDoubleTap, onSqueeze } = {}) {
  const p = pencilPlugin();
  const state = { available: false, pencilOnly: false, preferredTap: null, off() {} };
  if (!p?.addListener) return state;
  const handles = [];
  const listen = (name, fn) => { try { handles.push(p.addListener(name, (e) => fn?.(e || {}))); } catch { /* an older plugin */ } };
  listen('doubleTap', onDoubleTap);
  listen('squeeze', onSqueeze);
  state.available = true;
  state.off = () => {
    for (const hd of handles.splice(0)) Promise.resolve(hd).then((x) => x?.remove?.()).catch(() => {});
  };
  Promise.resolve().then(() => p.status?.()).then((s) => {
    if (!s) return;
    state.pencilOnly = !!s.prefersPencilOnlyDrawing;
    state.preferredTap = s.preferredTapAction || null;
  }).catch(() => {});
  return state;
}

/**
 * Taking back a multi-finger tap's first finger. In finger-drawing mode that finger acts with the
 * tool as it lands (erases, places a symbol, moves), before the second one turns it into a tap.
 * `mark` holds copies of the editor's undo and redo stacks from when the first finger went down.
 * Returns null when nothing was checkpointed since, else { snap, undo, redo }: restore `snap` (the
 * drawing before the finger's change) and put the stacks back, then run the gesture.
 */
export function tapRollback(mark, undo) {
  if (!mark) return null;
  const fresh = undo.filter((s) => !mark.undo.includes(s));
  return fresh.length ? { snap: fresh[0], undo: mark.undo, redo: mark.redo } : null;
}

const GROUPS = ['Finger and Pencil', 'Taps', 'Two fingers', 'Touch and hold', 'Apple Pencil'];

/**
 * The Gestures settings: every gesture with a picker of actions, and the on/off options, grouped
 * like Concepts' gesture settings. Used on the canvas (Gestures sheet) and in Settings → Drawing.
 * @param {{ h: Function, toast?: Function }} ui
 * @param {(key: string, action: string) => any} save  stores a synced choice (session.savePref when signed in)
 * @param {{ pencil?: boolean }} [opts]  pencil: the native Pencil bridge is here (else its rows say so)
 */
export function gesturePanel(ui, save, { pencil = pencilBridge() } = {}) {
  const { h } = ui;
  const prefs = gesturePrefs();
  const told = (label, value) => ui.toast?.(`${label}: ${value}`, 'success');
  const gestureRow = (g) => {
    const id = `gesture-${g.key}`;
    const hint = g.pencil && !pencil ? `${g.hint ? g.hint + '. ' : ''}Works in the Fishtape iPad app.` : g.hint;
    return h('label', { class: 'field', for: id },
      h('span', null, g.label),
      h('select', {
        id, name: g.key, 'aria-label': g.label,
        onChange: async (e) => {
          const v = e.target.value;
          if (g.sync) await save(g.key, v); else setGesture(g.key, v);
          told(g.label, actionLabel(v));
        },
      }, g.actions.map((a) => h('option', { value: a, selected: prefs[g.key] === a }, actionLabel(a)))),
      hint ? h('span', { class: 'hint' }, hint) : null);
  };
  const optionRow = (o) => {
    const id = `gesture-${o.key}`;
    if (o.choices) {
      return h('label', { class: 'field', for: id },
        h('span', null, o.label),
        h('select', { id, name: o.key, 'aria-label': o.label, onChange: (e) => { setOption(o.key, e.target.value); told(o.label, o.choices.find((c) => c.id === e.target.value)?.label); } },
          o.choices.map((c) => h('option', { value: c.id, selected: getOption(o.key) === c.id }, c.label))),
        o.hint ? h('span', { class: 'hint' }, o.hint) : null);
    }
    return h('div', { class: 'cv-gesture-opt' },
      h('label', { class: 'field check', for: id },
        h('input', { id, type: 'checkbox', name: o.key, checked: getOption(o.key), onChange: (e) => { setOption(o.key, e.target.checked); told(o.label, e.target.checked ? 'on' : 'off'); } }),
        h('span', null, o.label)),
      o.hint ? h('span', { class: 'hint' }, o.hint) : null);
  };
  const holdTime = () => {
    const out = h('output', null, `${(getHoldMs() / 1000).toFixed(1)} s`);
    return h('label', { class: 'field cv-range' }, h('span', null, 'Hold time'),
      h('input', {
        type: 'range', min: HOLD_MIN, max: HOLD_MAX, step: 50, value: getHoldMs(), 'aria-label': 'Touch and hold activation time',
        onInput: (e) => { setHoldMs(e.target.value); out.textContent = `${(Number(e.target.value) / 1000).toFixed(1)} s`; },
      }), out);
  };
  const notes = {
    'Finger and Pencil': 'Palm rejection: while the Pencil is on the glass, a resting hand is ignored.',
    'Two fingers': 'Two-finger drag pans. Taps never fire while the Pencil is on the glass, during a pinch or pan, or when your fingers move.',
  };
  return h('div', { class: 'stack cv-gestures' },
    GROUPS.map((grp) => h('section', { class: 'stack cv-gesture-group', 'aria-label': grp },
      h('h3', { class: 'cv-gesture-head' }, grp),
      GESTURE_OPTIONS.filter((o) => o.group === grp && o.choices).map(optionRow),
      GESTURES.filter((g) => g.group === grp).map(gestureRow),
      GESTURE_OPTIONS.filter((o) => o.group === grp && !o.choices).map(optionRow),
      grp === 'Touch and hold' ? holdTime() : null,
      notes[grp] ? h('div', { class: 'muted cv-gesture-note' }, notes[grp]) : null)));
}
