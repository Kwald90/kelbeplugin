// Pipe bending: offsets, kicks, saddles, 90s, back-to-backs, box offsets, rolling, parallel,
// segment and concentric bends, with the marks to put on the pipe and a diagram drawn to scale.
// Saved bends live in `bends`, the crew's own bender numbers in `benderProfiles`.
import * as B from '../lib/bending.js';
import * as P from '../lib/bending-profiles.js';
import { bentSvg, marksSvg, rollSvg, SYMBOL_NAMES } from '../lib/bending-svg.js';
import { fmtLength, parseLength, getUnits, setUnits, inToM, mToIn } from '../lib/units.js';

let ui, h, store, ctx;

// ---------------------------------------------------------------------------
// Units: inches to the 1/16" or millimetres, per user
// ---------------------------------------------------------------------------

let units = 'imperial';
const snap = (m) => (units === 'imperial' ? inToM(Math.round(mToIn(m) * 16) / 16) : Math.round(m * 1000) / 1000);
/** Bending marks read off a tape: inches under 10', feet-inches above; metric always in mm. */
const FEET_FROM = inToM(120);
const fmt = (m) => (m == null || !Number.isFinite(m) ? '—' : fmtLength(snap(m), { units, feet: Math.abs(m) >= FEET_FROM, metric: 'mm' }));
const fmtOther = (m) => fmtLength(m, units === 'imperial' ? { units: 'metric', metric: 'mm' } : { units: 'imperial', feet: Math.abs(m) >= FEET_FROM });
const parse = (s) => parseLength(s, { units, bare: units === 'metric' ? 'mm' : 'in' });
const pick = ([inches, mm]) => (units === 'imperial' ? inToM(inches) : mm / 1000);
const deg = B.fmtDeg;

// Per-device memory of the last screen; wrapped because storage can be blocked.
const LS = 'ft.bend.';
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(LS + key)); return v ?? fallback; } catch { return fallback; }
}
function keep(key, value) { try { localStorage.setItem(LS + key, JSON.stringify(value)); } catch { /* storage blocked */ } }

// Inline icons (icons.js is shared and frozen).
const ICON = {
  ruler: '<path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M10 10l2 2M13 7l2 2"/>',
  bend: '<path d="M4 20V12a8 8 0 018-8h8"/>',
};

// ---------------------------------------------------------------------------
// The bend kinds and their inputs
// ---------------------------------------------------------------------------

const MEASURE = {
  type: 'choice', name: 'measure', label: 'Measure from the end of the pipe to', def: 'obstacle',
  options: [{ value: 'obstacle', label: 'The obstruction' }, { value: 'first', label: 'The first bend' }, { value: 'none', label: 'Nothing (marks from mark 1)' }],
};
const MEASURED = [
  { type: 'len', name: 'obstacleM', label: 'End to the obstruction', def: [36, 900], hint: 'Where the offset has to be done. Shrink is added for you.', when: (f) => f.measure === 'obstacle' },
  { type: 'len', name: 'firstBendM', label: 'End to the first bend', def: [12, 300], when: (f) => f.measure === 'first' },
];
const RUN = { type: 'len', name: 'runM', label: 'Overall run', optional: true, hint: 'End to where the far end lands, along the wall. Gives the cut length.', when: (f) => f.measure === 'obstacle' };

const KIND_LIST = [
  { id: 'offset', label: 'Offset', blurb: 'Two equal bends that move the pipe over an obstruction.', fields: [
    { type: 'len', name: 'riseM', label: 'Offset depth (rise)', def: [6, 150] },
    { type: 'angle', def: 30, fit: { name: 'spacingM', label: 'Distance between marks', def: [12, 300] } },
    MEASURE, ...MEASURED, RUN,
  ] },
  { id: 'kick', label: 'Kick', blurb: 'One bend that moves the end of the pipe off the line of the run.', fields: [
    { type: 'len', name: 'riseM', label: 'Kick (how far the end moves)', def: [3, 75] },
    { type: 'angle', def: 22.5, fit: { name: 'spacingM', label: 'Mark from the end', def: [8, 200] } },
  ] },
  { id: 'saddle3', label: '3-point saddle', blurb: 'Over a pipe or round obstruction: one centre bend, two side bends.', fields: [
    { type: 'len', name: 'heightM', label: 'Obstruction height + clearance', def: [2, 50] },
    { type: 'choice', name: 'centerAngleDeg', label: 'Bends', def: '45', options: [{ value: '45', label: '45° centre, 22.5° sides' }, { value: '60', label: '60° centre, 30° sides' }] },
    { type: 'len', name: 'centerM', label: 'End to the centre of the obstruction', optional: true, def: [24, 600], hint: 'Leave empty to space the marks from mark 1.' },
    { type: 'len', name: 'runM', label: 'Overall run', optional: true, hint: 'For a cut length.' },
  ] },
  { id: 'saddle4', label: '4-point saddle', blurb: 'Over a wide obstruction: an offset up, across, and back down.', fields: [
    { type: 'len', name: 'heightM', label: 'Obstruction height + clearance', def: [4, 100] },
    { type: 'len', name: 'widthM', label: 'Obstruction width + clearance', def: [10, 250] },
    { type: 'angle', def: 30, choices: [22.5, 30, 45] },
    { type: 'len', name: 'obstacleM', label: 'End to the near edge', optional: true, def: [36, 900], hint: 'Shrink is added for you. Empty: marks from mark 1.' },
    { type: 'len', name: 'runM', label: 'Overall run', optional: true, hint: 'For a cut length.' },
  ] },
  { id: 'stub90', label: '90° stub', blurb: 'A stub-up: end of the pipe to the back of the 90, less the take-up.', fields: [
    { type: 'len', name: 'stubM', label: 'Stub (end to back of the 90)', def: [10, 250] },
    { type: 'len', name: 'otherLegM', label: 'Other leg', optional: true, hint: 'To the back of the bend. Gives the cut length (uses gain).' },
  ] },
  { id: 'backToBack', label: 'Back-to-back', blurb: 'Two 90s a set distance apart, measured across their backs.', fields: [
    { type: 'len', name: 'stubM', label: 'First stub (end to back of the 90)', def: [10, 250] },
    { type: 'len', name: 'backToBackM', label: 'Across the backs of the 90s', def: [30, 750] },
    { type: 'len', name: 'secondStubM', label: 'Second stub', optional: true, hint: 'Gives the cut length.' },
  ] },
  { id: 'boxOffset', label: 'Box / bracket', blurb: 'Small offsets into a box knockout, or over a bracket or strut.', fields: [
    { type: 'choice', name: 'target', label: 'Where', def: 'box', options: [{ value: 'box', label: 'Into a box' }, { value: 'bracket', label: 'Over a bracket or strut' }] },
    { type: 'len', name: 'riseM', label: 'Offset', def: [0.5, 13], hint: 'Box: knockout centre off the line of the pipe. Bracket: its depth + clearance.' },
    { type: 'angle', def: 10, choices: [10, 22.5, 30] },
    { type: 'len', name: 'straightM', label: 'Straight into the box', def: [1.5, 38], hint: 'Pipe past the offset for the connector.', when: (f) => f.target !== 'bracket' },
    { type: 'len', name: 'obstacleM', label: 'End to the bracket', def: [24, 600], when: (f) => f.target === 'bracket' },
  ] },
  { id: 'rolling', label: 'Rolling offset', blurb: 'Up and over at the same time: true offset = √(rise² + roll²).', fields: [
    { type: 'len', name: 'riseM', label: 'Rise (up)', def: [6, 150] },
    { type: 'len', name: 'rollM', label: 'Roll (over)', def: [8, 200] },
    { type: 'angle', def: 45, fit: { name: 'spacingM', label: 'Distance between marks', def: [14, 350] } },
    MEASURE, ...MEASURED, RUN,
  ] },
  { id: 'parallel', label: 'Parallel offsets', blurb: 'A rack of pipes offsetting together, kept the same distance apart.', fields: [
    { type: 'len', name: 'riseM', label: 'Offset depth (rise)', def: [6, 150] },
    { type: 'angle', def: 30, fit: { name: 'spacingM', label: 'Distance between marks', def: [12, 300] } },
    { type: 'count', name: 'count', label: 'Conduits', def: 3, min: 2, max: 12 },
    { type: 'len', name: 'centersM', label: 'Centre-to-centre spacing', def: [2, 50] },
    MEASURE, ...MEASURED,
  ] },
  { id: 'segment', label: 'Segment bend', blurb: 'A large-radius bend made as several small shots.', fields: [
    { type: 'len', name: 'radiusM', label: 'Bend radius (to the centre of the pipe)', def: [30, 750] },
    { type: 'angle', def: 90, choices: [90, 45, 30], name: 'angleDeg' },
    { type: 'count', name: 'shots', label: 'Shots', def: 9, min: 2, max: 60, hint: 'Degrees per shot = angle ÷ shots.' },
    { type: 'choice', name: 'segRef', label: 'Measure', def: 'stub', options: [{ value: 'stub', label: 'Stub to the back of the 90' }, { value: 'start', label: 'End to the start of the bend' }], when: (f) => f.angleSel === '90' },
    { type: 'len', name: 'stubM', label: 'Stub (end to back of the 90)', def: [48, 1200], when: (f) => f.angleSel === '90' && f.segRef !== 'start' },
    { type: 'len', name: 'startM', label: 'End to the start of the bend', def: [12, 300], when: (f) => f.angleSel !== '90' || f.segRef === 'start' },
  ] },
  { id: 'concentric', label: 'Concentric 90s', blurb: 'A rack of 90s that share one centre: each pipe out adds the spacing to its radius.', fields: [
    { type: 'count', name: 'count', label: 'Conduits', def: 3, min: 2, max: 12 },
    { type: 'len', name: 'centersM', label: 'Centre-to-centre spacing', def: [4, 100] },
    { type: 'len', name: 'innerRadiusM', label: 'Inside radius (pipe 1)', def: [20, 500] },
    { type: 'len', name: 'startM', label: 'End to the start of the bends', def: [12, 300], hint: 'Pipe ends square across the rack.' },
    { type: 'count', name: 'shots', label: 'Shots per bend', def: 9, min: 1, max: 60 },
    { type: 'len', name: 'topM', label: 'Top of the risers', optional: true, hint: 'From pipe 1 (before the bend) to where the risers end. Gives cut lengths.' },
  ] },
];
const KINDS = Object.fromEntries(KIND_LIST.map((k) => [k.id, k]));
const TABS = [...KIND_LIST.map((k) => ({ id: k.id, label: k.label })), { id: 'pull', label: '360° check' }];
const kindLabel = (id) => KINDS[id]?.label || id;

// ---------------------------------------------------------------------------
// State (survives route changes; remembered per device)
// ---------------------------------------------------------------------------

const state = {
  kind: load('kind', 'offset'),
  type: load('type', 'EMT'),
  size: load('size', '21'),
  profileId: load('profile', null),
  chart: load('chart', false),
  forms: load('forms', {}), // kind -> { field: text|value }
  over: load('over', {}), // bender overrides as text: takeUpM, gainM, radiusM
  editing: null, // { id, name, jobId, notes } while a saved bend is open
};
const remember = () => {
  keep('kind', state.kind); keep('type', state.type); keep('size', state.size); keep('profile', state.profileId);
  keep('chart', state.chart); keep('forms', state.forms); keep('over', state.over);
};

function formFor(kind) {
  if (!state.forms[kind]) state.forms[kind] = {};
  const f = state.forms[kind];
  for (const spec of KINDS[kind].fields) {
    if (spec.type === 'len' && f[spec.name] == null) f[spec.name] = spec.def ? fmt(pick(spec.def)) : '';
    if (spec.type === 'choice' && f[spec.name] == null) f[spec.name] = spec.def;
    if (spec.type === 'count' && f[spec.name] == null) f[spec.name] = spec.def;
    if (spec.type === 'angle') {
      if (f.angleSel == null) f.angleSel = String(spec.def);
      if (f.angleOther == null) f.angleOther = '';
      if (spec.fit && f[spec.fit.name] == null) f[spec.fit.name] = fmt(pick(spec.fit.def));
    }
  }
  return f;
}

const userProfiles = () => store.list('benderProfiles');
function currentProfile() {
  if (state.type === 'PVC') return null;
  return P.pickProfile(state.type, state.size, userProfiles(), state.profileId);
}

/** Bender numbers in use: override text > profile > code. */
function benderValues() {
  const prof = currentProfile();
  const o = (k) => { const t = (state.over[k] || '').trim(); return t ? parse(t) : null; };
  const odM = B.conduitOD(state.type, state.size);
  const minRadiusM = P.minBendRadius(state.type, state.size);
  const heat = state.type === 'PVC';
  return {
    prof, odM, minRadiusM, heat,
    takeUpM: heat ? null : (o('takeUpM') ?? prof?.takeUpM ?? null),
    gainM: o('gainM') ?? (heat ? null : prof?.gainM ?? null),
    radiusM: o('radiusM') ?? (heat ? minRadiusM : prof?.minRadiusM ?? null),
  };
}

/** Turn the form into the calculator's SI input. Returns { input, errors }. */
function readForm(kind, f) {
  const input = {};
  const errors = [];
  for (const spec of KINDS[kind].fields) {
    if (spec.when && !spec.when(f)) continue;
    if (spec.type === 'len') {
      const t = String(f[spec.name] ?? '').trim();
      if (!t) { if (!spec.optional) errors.push(`${spec.label}: needed`); continue; }
      const m = parse(t);
      if (m == null) errors.push(`${spec.label}: can't read "${t}"`);
      else input[spec.name] = m;
    } else if (spec.type === 'choice') {
      input[spec.name] = /^\d+(\.\d+)?$/.test(f[spec.name]) ? Number(f[spec.name]) : f[spec.name];
    } else if (spec.type === 'count') {
      input[spec.name] = Number(f[spec.name]);
    } else if (spec.type === 'angle') {
      const key = spec.name || 'angleDeg';
      if (f.angleSel === 'fit') {
        const m = parse(String(f[spec.fit.name] || ''));
        if (m == null) errors.push(`${spec.fit.label}: can't read that`);
        else input[spec.fit.name] = m;
      } else if (f.angleSel === 'other') {
        const a = Number(f.angleOther);
        if (!(a > 0)) errors.push('Angle: enter the degrees');
        else input[key] = a;
      } else input[key] = Number(f.angleSel);
    }
  }
  // The measure choice decides which reference distance is used.
  if (f.measure === 'none') { delete input.obstacleM; delete input.firstBendM; delete input.runM; }
  if (kind === 'segment' && (f.angleSel !== '90' || f.segRef === 'start')) delete input.stubM;
  return { input, errors };
}

/** The full calculator input: the form plus the bender and pipe. */
function siInputs(kind, f) {
  const { input, errors } = readForm(kind, f);
  const b = benderValues();
  const full = { ...input, odM: b.odM ?? undefined, chart: state.chart };
  if (['stub90', 'backToBack'].includes(kind)) Object.assign(full, { takeUpM: b.takeUpM ?? undefined, gainM: b.gainM ?? undefined, radiusM: b.radiusM ?? undefined, heat: b.heat });
  else if (['segment', 'concentric'].includes(kind)) full.minRadiusM = b.minRadiusM ?? undefined;
  else if (b.radiusM) full.radiusM = b.radiusM;
  return { input: full, errors, bender: b };
}

const calcOpts = (profile, chart, f = fmt) => ({ fmt: f, chart, names: P.markNames(profile) });

// ---------------------------------------------------------------------------
// Form controls: big, forgiving, touch-first
// ---------------------------------------------------------------------------

function lenInput(label, value, onValue, { optional, hint, name } = {}) {
  const echo = h('span', { class: 'bend-echo', 'aria-live': 'polite' });
  const input = h('input', {
    class: 'bend-input', type: 'text', value, name, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    inputmode: units === 'metric' ? 'decimal' : 'text', enterkeyhint: 'next',
    placeholder: optional ? 'optional' : units === 'imperial' ? `e.g. 30 1/2 or 2' 6"` : 'e.g. 450 or 1.2 m',
  });
  const show = () => {
    const t = input.value.trim();
    echo.className = 'bend-echo';
    if (!t) { echo.textContent = optional ? '' : 'Needed'; if (!optional) echo.classList.add('bad'); return; }
    const m = parse(t);
    if (m == null) { echo.textContent = units === 'imperial' ? `Can't read that. Try 30 1/2, 2' 6" or 450mm` : `Can't read that. Try 450, 45 cm or 1.2 m`; echo.classList.add('bad'); return; }
    echo.textContent = `= ${fmt(m)} · ${fmtOther(m)}`;
  };
  input.addEventListener('input', () => { show(); onValue(input.value); });
  input.addEventListener('focus', () => input.select());
  show();
  return h('label', { class: 'bend-field' }, h('span', { class: 'bend-label' }, label, optional ? h('em', null, ' optional') : null), input, echo, hint ? h('span', { class: 'bend-hint' }, hint) : null);
}

function chips(label, options, value, onPick) {
  return h('div', { class: 'bend-field' },
    h('span', { class: 'bend-label' }, label),
    h('div', { class: 'bend-chips', role: 'group', 'aria-label': label }, options.map((o) =>
      h('button', { type: 'button', class: 'bend-chip', 'aria-pressed': String(String(o.value) === String(value)), onClick: () => onPick(String(o.value)) }, o.label))));
}

function counter(label, value, { min, max, hint }, onValue) {
  const input = h('input', { class: 'bend-input num', type: 'number', inputmode: 'numeric', min, max, step: 1, value });
  const set = (v) => { const n = Math.max(min, Math.min(max, Math.round(Number(v) || min))); input.value = n; onValue(n); };
  input.addEventListener('input', () => { if (input.value !== '') onValue(Math.max(min, Math.min(max, Math.round(Number(input.value))))); });
  input.addEventListener('change', () => set(input.value));
  return h('div', { class: 'bend-field' },
    h('span', { class: 'bend-label' }, label),
    h('div', { class: 'bend-counter' },
      h('button', { type: 'button', class: 'bend-step', 'aria-label': `Fewer ${label.toLowerCase()}`, onClick: () => set(Number(input.value) - 1) }, '−'),
      input,
      h('button', { type: 'button', class: 'bend-step', 'aria-label': `More ${label.toLowerCase()}`, onClick: () => set(Number(input.value) + 1) }, '+')),
    hint ? h('span', { class: 'bend-hint' }, hint) : null);
}

/** The inputs for a kind. `changed()` recalculates; `redraw()` rebuilds the form (a choice changed). */
function formView(kind, f, changed, redraw) {
  const wrap = h('div', { class: 'bend-fields' });
  for (const spec of KINDS[kind].fields) {
    if (spec.when && !spec.when(f)) continue;
    if (spec.type === 'len') {
      wrap.append(lenInput(spec.label, f[spec.name] ?? '', (v) => { f[spec.name] = v; changed(); }, spec));
    } else if (spec.type === 'choice') {
      wrap.append(chips(spec.label, spec.options, f[spec.name], (v) => { f[spec.name] = v; redraw(); }));
    } else if (spec.type === 'count') {
      wrap.append(counter(spec.label, f[spec.name], spec, (v) => { f[spec.name] = v; changed(); }));
    } else if (spec.type === 'angle') {
      const choices = spec.choices || B.COMMON_ANGLES;
      const opts = [...choices.map((a) => ({ value: String(a), label: deg(a) })), { value: 'other', label: 'Other' }];
      if (spec.fit) opts.push({ value: 'fit', label: 'Fit to marks' });
      wrap.append(chips('Angle', opts, f.angleSel, (v) => { f.angleSel = v; redraw(); }));
      if (f.angleSel === 'other') {
        const a = h('input', { class: 'bend-input num', type: 'number', inputmode: 'decimal', min: 1, max: 179, step: 'any', value: f.angleOther, placeholder: 'degrees' });
        a.addEventListener('input', () => { f.angleOther = a.value; changed(); });
        wrap.append(h('label', { class: 'bend-field' }, h('span', { class: 'bend-label' }, 'Angle (degrees)'), a));
      }
      if (f.angleSel === 'fit') {
        wrap.append(lenInput(spec.fit.label, f[spec.fit.name] ?? '', (v) => { f[spec.fit.name] = v; changed(); }, { hint: 'The angle is worked out so the marks land this far apart.' }));
      }
    }
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Pipe and bender bar
// ---------------------------------------------------------------------------

const typeOptions = () => B.CONDUIT_TYPES.map((c) => ({ value: c.id, label: c.label }));
const sizeOptions = () => B.TRADE_SIZES.map((s) => ({ value: s.id, label: B.tradeSizeLabel(s.id) }));

function select(label, options, value, onPick, cls) {
  return h('label', { class: ['bend-field', cls] }, h('span', { class: 'bend-label' }, label),
    h('select', { class: 'bend-input', onChange: (e) => onPick(e.target.value) },
      options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label))));
}

function benderBar(rerender) {
  const b = benderValues();
  const list = state.type === 'PVC' ? [] : P.profilesFor(state.type, state.size, userProfiles());
  const parts = [
    select('Conduit', typeOptions(), state.type, (v) => { state.type = v; state.profileId = null; state.over = {}; remember(); rerender(); }),
    select('Trade size', sizeOptions(), state.size, (v) => { state.size = v; state.profileId = null; state.over = {}; remember(); rerender(); }),
  ];
  if (state.type === 'PVC') {
    parts.push(lenInput('Bend radius (heat bending)', state.over.radiusM || fmt(b.minRadiusM), (v) => { state.over.radiusM = v; remember(); rerender.calc(); },
      { hint: `Code minimum for this size: ${fmt(b.minRadiusM)}` }));
  } else if (list.length) {
    parts.push(select('Bender', list.map((p) => ({ value: p.id, label: `${p.builtIn ? '' : '★ '}${p.name}` })), b.prof?.id, (v) => { state.profileId = v; state.over = {}; remember(); rerender(); }, 'wide'));
  } else {
    parts.push(h('div', { class: 'bend-field wide' }, h('span', { class: 'bend-label' }, 'Bender'),
      h('div', { class: 'bend-none' }, 'No bender on file for this size. Enter its numbers below, or use a segment bend.')));
  }
  const vals = [
    b.takeUpM != null ? `take-up ${fmt(b.takeUpM)}` : null,
    b.gainM != null ? `gain ${fmt(b.gainM)}` : null,
    b.radiusM != null ? `radius ${fmt(b.radiusM)}` : null,
    b.odM != null ? `OD ${fmt(b.odM)}` : null,
  ].filter(Boolean).join(' · ');
  const overrides = h('details', { class: 'bend-over', open: Object.values(state.over).some((v) => v && String(v).trim()) && state.type !== 'PVC' },
    h('summary', null, 'Use my own numbers'),
    h('div', { class: 'bend-fields three' },
      ...(state.type === 'PVC' ? [] : [
        lenInput('Take-up (deduct)', state.over.takeUpM || '', (v) => { state.over.takeUpM = v; remember(); rerender.calc(); }, { optional: true }),
        lenInput('Gain', state.over.gainM || '', (v) => { state.over.gainM = v; remember(); rerender.calc(); }, { optional: true }),
        lenInput('Bend radius', state.over.radiusM || '', (v) => { state.over.radiusM = v; remember(); rerender.calc(); }, { optional: true }),
      ])),
    h('div', { class: 'row' },
      ui.button('Clear my numbers', { size: 'sm', variant: 'ghost', onClick: () => { state.over = {}; remember(); rerender(); } }),
      ui.button('Calibrate a bender', { size: 'sm', icon: 'wrench', onClick: () => calibrateSheet(rerender) })));
  return h('section', { class: 'card bend-setup' },
    h('div', { class: 'bend-setup-row' }, parts),
    h('div', { class: 'bend-setup-meta' },
      h('span', { class: 'num' }, vals || 'No bender numbers'),
      b.prof?.builtIn ? h('span', { class: 'bend-verify' }, ui.icon('alert', 14), 'Typical published values. Check them against the marks on your own bender.') : null,
      b.prof && !b.prof.builtIn ? ui.badge('Your bender', 'success') : null,
      h('label', { class: 'bend-toggle' },
        h('input', { type: 'checkbox', checked: state.chart, onChange: (e) => { state.chart = e.target.checked; remember(); rerender.calc(); } }),
        h('span', null, 'Chart numbers'),
        h('span', { class: 'muted' }, ' (6, 2.6, 2, 1.4, 1.2; 2½ saddles)'))),
    state.type === 'PVC' ? pvcNote(b) : overrides);
}

function pvcNote(b) {
  return h('details', { class: 'bend-pvc', open: true },
    h('summary', null, 'Heat bending rigid PVC'),
    h('ul', null,
      h('li', null, 'Heat with a flameless heater (hot box, blanket or infra-red), about 127 °C / 260 °F. Never an open flame (IPEX).'),
      h('li', null, 'Heat evenly over about 10 × the pipe diameter, turning it as you go. Too little heat and it kinks; too much and it scorches.'),
      h('li', null, `Bend around a form no tighter than ${fmt(b.radiusM)} radius (CEC Rule 12-1108; IPEX: six times the inside diameter). The marks show where to heat.`),
      h('li', null, 'Hold it until it cools. Cooling with water or air makes it spring back, so overbend a few degrees.'),
      h('li', null, 'Large sizes: plug both ends so it stays round (common practice; check with the maker).'),
      h('li', null, 'Offsets and saddles use the same marks as metal pipe: heat centred on each mark.')));
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function figureValue(fg) {
  if (fg.m != null) return fmt(fg.m);
  if (fg.deg != null) return deg(fg.deg);
  if (fg.x != null) return `× ${Number(fg.x.toFixed(fg.x >= 3 ? 2 : 3))}`;
  return fg.text ?? '—';
}

const SYMBOL_TEXT = { arrow: '▼ arrow', star: '★ star', notch: '◆ centre', heat: 'heat', tick: '—' };

function markTiles(result) {
  const marks = result.marks;
  if (result.pipes || marks.length > 6) return null;
  return h('div', { class: 'bend-tiles' }, marks.map((m, i) => {
    const prev = i ? marks[i - 1].atM : result.reference === 'end' ? 0 : null;
    return h('div', { class: ['bend-tile', m.symbol === 'tick' ? 'ref' : null] },
      h('div', { class: 'bend-tile-head' }, h('span', null, m.label), h('span', { class: 'bend-sym' }, SYMBOL_TEXT[m.symbol] || '')),
      h('div', { class: 'bend-tile-val num' }, fmt(m.atM)),
      h('div', { class: 'bend-tile-sub' },
        m.angleDeg ? h('strong', null, deg(m.angleDeg)) : null,
        m.note ? ` ${m.note}` : null,
        prev != null && m.atM - prev > 0 ? h('span', { class: 'muted' }, ` · ${fmt(snap(m.atM) - snap(prev))} from ${i ? 'last' : 'end'}`) : null));
  }));
}

function marksTable(result) {
  const rows = result.marks.map((m, i, all) => {
    const prevSame = [...all.slice(0, i)].reverse().find((q) => q.pipe === m.pipe);
    return { ...m, gap: prevSame ? snap(m.atM) - snap(prevSame.atM) : null };
  });
  return ui.table({
    columns: [
      { key: 'label', label: 'Mark', render: (m) => h('strong', null, m.label) },
      { key: 'at', label: result.reference === 'end' ? 'From the end' : 'From mark 1', align: 'right', render: (m) => fmt(m.atM) },
      { key: 'gap', label: 'From last', align: 'right', render: (m) => (m.gap ? fmt(m.gap) : '—') },
      { key: 'bend', label: 'Bend', render: (m) => [m.angleDeg ? deg(m.angleDeg) : '', SYMBOL_TEXT[m.symbol] && m.symbol !== 'tick' ? ` ${SYMBOL_TEXT[m.symbol]}` : '', m.note ? ` · ${m.note}` : ''].join('') || '—' },
    ],
    rows,
  });
}

function diagrams(result, odM, width) {
  const w = Math.max(300, Math.min(900, Math.round(width || 640)));
  const bent = h('div', { class: 'bend-svg-wrap' });
  bent.innerHTML = bentSvg(result, { fmt, width: w, odM: odM || 0 });
  const straight = h('div', { class: 'bend-svg-wrap' });
  straight.innerHTML = marksSvg(result, { fmt, snap, width: w });
  const roll = result.endView ? h('div', { class: 'bend-svg-wrap roll' }) : null;
  if (roll) roll.innerHTML = rollSvg(result, { fmt });
  const used = [...new Set(result.marks.map((m) => m.symbol))].filter((s) => s && s !== 'tick');
  return h('div', { class: 'bend-diagrams' },
    h('div', { class: 'bend-cap' }, 'Bent, to scale'), bent,
    roll ? [h('div', { class: 'bend-cap' }, 'End view: roll the pipe'), roll] : null,
    h('div', { class: 'bend-cap' }, result.reference === 'end' ? 'Marks on the straight pipe, from the end' : 'Marks on the straight pipe, from mark 1'), straight,
    used.length ? h('div', { class: 'bend-legend' }, used.map((s) => h('span', null, `${SYMBOL_TEXT[s]?.split(' ')[0] || ''} ${SYMBOL_NAMES[s]}`))) : null);
}

function resultsView(result, bender, width) {
  const minis = result.figures.map((fg) => h('div', { class: 'calc-mini' }, h('span', null, fg.label), h('strong', { class: 'num' }, figureValue(fg))));
  return [
    result.warnings.length ? h('div', { class: 'card bend-warn', role: 'alert' }, result.warnings.map((w) => h('div', { class: 'row' }, ui.icon('alert', 16), h('span', null, w)))) : null,
    markTiles(result),
    h('div', { class: 'calc-minis' }, minis, h('div', { class: 'calc-mini' }, h('span', null, 'Degrees in this piece'), h('strong', { class: 'num' }, deg(result.degrees)))),
    h('div', { class: 'card bend-diagram-card' }, diagrams(result, bender.odM, width)),
    result.pipes || result.marks.length > 6 ? marksTable(result) : null,
    h('div', { class: 'card bend-steps' }, h('h3', null, 'How to bend it'), h('ol', null, result.steps.map((s) => h('li', null, s)))),
  ];
}

// ---------------------------------------------------------------------------
// Calculator screen
// ---------------------------------------------------------------------------

function calculatorView(root) {
  const kind = state.kind;
  const body = h('div', { class: 'bend-body' });
  const page = ui.page({
    title: 'Pipe bending',
    subtitle: state.editing ? `Editing "${state.editing.name}"` : 'Marks for the pipe, drawn to scale. Results update as you type.',
    actions: [
      unitsToggle(() => rerenderAll()),
      ui.button('Saved bends', { icon: 'list', href: '#/bending/saved' }),
      ui.button('My benders', { icon: 'wrench', href: '#/bending/profiles' }),
    ],
  },
  h('div', { class: 'bend-tabs no-print' }, ui.tabs(TABS, kind, (id) => { state.kind = id; remember(); ctx.nav('#/bending/' + id); })),
  body);
  root.append(page);
  let observer = null;
  let lastWidth = 0;

  const rerenderAll = () => ctx.route();

  function draw() {
    ui.clear(body);
    if (kind === 'pull') { body.append(pullView()); return; }
    const f = formFor(kind);
    const out = h('div', { class: 'bend-out', 'aria-live': 'polite' });
    const formHost = h('div');
    const calc = () => {
      remember();
      ui.clear(out);
      const { input, errors, bender } = siInputs(kind, f);
      if (errors.length) { out.append(h('div', { class: 'card calc-result warn' }, h('div', { class: 'calc-label' }, 'Check the inputs'), h('ul', { class: 'calc-why' }, errors.map((e) => h('li', null, e))))); current = null; return; }
      try {
        const result = B.compute(kind, input, calcOpts(bender.prof, state.chart));
        current = { kind, input, result, bender, form: structuredClone(f) };
        out.append(...resultsView(result, bender, (out.clientWidth || lastWidth || 640) - 34).filter(Boolean));
      } catch (err) {
        current = null;
        if (!(err instanceof B.BendError)) console.error(err);
        out.append(h('div', { class: 'card calc-result warn' }, h('div', { class: 'calc-label' }, 'Can\'t bend that'), h('p', null, err.message)));
      }
    };
    const redraw = () => { ui.clear(formHost); formHost.append(formView(kind, f, calc, redraw)); calc(); };
    const rerender = () => draw();
    rerender.calc = calc;
    const k = KINDS[kind];
    body.append(
      benderBar(rerender),
      h('div', { class: 'bend-layout' },
        h('form', { class: 'card bend-form', onSubmit: (e) => e.preventDefault() },
          h('p', { class: 'bend-blurb' }, k.blurb),
          formHost,
          h('div', { class: 'bend-actions' },
            ui.button(state.editing ? 'Save changes' : 'Save', { variant: 'primary', icon: 'save', onClick: () => saveSheet() }),
            state.editing ? ui.button('Save as new', { icon: 'copy', onClick: () => saveSheet({ asNew: true }) }) : null,
            ui.button('Print', { icon: 'printer', onClick: () => (current ? printBend(current, state.editing) : ui.toast('Fix the inputs first', 'error')) }),
            ui.button(state.editing ? 'Close' : 'Reset', { variant: 'ghost', onClick: () => { if (!state.editing) delete state.forms[kind]; state.editing = null; remember(); rerenderAll(); } })),
          offsetReference(kind)),
        out));
    formHost.append(formView(kind, f, calc, redraw));
    calc();
    // Redraw the diagrams at the column's real width, so text stays readable on a phone.
    observer?.disconnect();
    if (globalThis.ResizeObserver) {
      observer = new ResizeObserver(([e]) => {
        const w = Math.round(e.contentRect.width);
        if (w && Math.abs(w - lastWidth) > 24) { lastWidth = w; calc(); }
      });
      observer.observe(out);
    }
  }
  draw();
  return () => observer?.disconnect();
}

let current = null; // { kind, input, result, bender, form } for save and print

function unitsToggle(onChange) {
  const set = (u) => {
    if (u === units) return;
    const old = units;
    // re-express every typed length in the new units
    const convert = (t) => { units = old; const m = parse(t); units = u; return m == null ? t : fmt(m); };
    for (const [kind, f] of Object.entries(state.forms)) {
      for (const spec of KINDS[kind]?.fields || []) {
        if (spec.type === 'len' && f[spec.name]) f[spec.name] = convert(f[spec.name]);
        if (spec.type === 'angle' && spec.fit && f[spec.fit.name]) f[spec.fit.name] = convert(f[spec.fit.name]);
      }
    }
    for (const k of Object.keys(state.over)) if (state.over[k]) state.over[k] = convert(state.over[k]);
    units = old;
    setUnits(u);
    units = u;
    remember();
    onChange();
  };
  return h('div', { class: 'bend-units', role: 'group', 'aria-label': 'Units' },
    h('button', { type: 'button', 'aria-pressed': String(units === 'imperial'), onClick: () => set('imperial') }, 'in'),
    h('button', { type: 'button', 'aria-pressed': String(units === 'metric'), onClick: () => set('metric') }, 'mm'));
}

function offsetReference(kind) {
  if (!['offset', 'kick', 'rolling', 'parallel', 'saddle4', 'boxOffset'].includes(kind)) return null;
  return h('details', { class: 'bend-ref' },
    h('summary', null, 'Multipliers and shrink'),
    h('table', { class: 'calc-lines' }, h('tbody', null,
      h('tr', { class: 'demand' }, h('td', null, 'Angle'), h('td', { class: 'right' }, 'Multiplier'), h('td', { class: 'right' }, 'Shrink per inch of rise'), h('td', { class: 'right' }, 'Chart')),
      B.offsetTable().map((r) => h('tr', null,
        h('td', null, deg(r.angleDeg)),
        h('td', { class: 'right num' }, r.multiplier.toFixed(3)),
        h('td', { class: 'right num' }, `${r.shrinkPerUnit.toFixed(3)}"`),
        h('td', { class: 'right num' }, `${r.chartMultiplier} · ${fmtFrac(r.chartShrink)}"`))))),
    h('p', { class: 'calc-note muted' }, 'Multiplier = 1 ÷ sin(angle); shrink = rise × tan(angle ÷ 2). Chart: the rounded numbers printed on hand benders.'));
}
const fmtFrac = (x) => ({ 0.0625: '1/16', 0.1875: '3/16', 0.25: '1/4', 0.375: '3/8', 0.5: '1/2' }[x] || String(x));

// ---------------------------------------------------------------------------
// Save, open, duplicate, delete
// ---------------------------------------------------------------------------

const jobOptions = () => ui.recordOptions(store.list('jobs'), (j) => `${j.number || ''} · ${j.title || ''}`, '— no job —');
const jobName = (id) => { const j = id && store.get('jobs', id); return j ? `${j.number || ''} · ${j.title || ''}` : '—'; };

function record(cur, meta) {
  return {
    name: meta.name.trim() || kindLabel(cur.kind),
    jobId: meta.jobId || null,
    kind: cur.kind,
    conduit: { type: state.type, tradeSize: state.size },
    benderProfileId: cur.bender.prof?.id || null,
    inputs: { ...cur.input, units, form: cur.form },
    result: B.toRecordResult(cur.result),
    notes: meta.notes || '',
  };
}

function saveSheet({ asNew = false } = {}) {
  if (!current) { ui.toast('Fix the inputs first', 'error'); return; }
  const ed = state.editing;
  const suggested = ed && !asNew ? ed.name : `${kindLabel(current.kind)} ${current.input.riseM ? fmt(current.input.riseM) : ''}`.trim();
  ui.formSheet({
    title: asNew ? 'Save as a new bend' : ed ? 'Save changes' : 'Save bend',
    submitLabel: 'Save',
    fields: [
      { label: 'Name', name: 'name', value: asNew && ed ? `${ed.name} (copy)` : suggested, required: true, span: true },
      { label: 'Job', name: 'jobId', type: 'select', value: ed?.jobId || ctx.query.jobId || '', options: jobOptions(), span: true },
      { label: 'Notes', name: 'notes', type: 'textarea', value: ed?.notes || '', rows: 3, span: true },
    ],
    onSubmit: (v) => {
      const rec = record(current, v);
      let saved;
      if (ed && !asNew && store.get('bends', ed.id)) saved = store.update('bends', ed.id, rec);
      else saved = store.add('bends', rec);
      state.editing = { id: saved.id, name: saved.name, jobId: saved.jobId, notes: saved.notes };
      ui.toast(`Saved "${saved.name}"`, 'success');
      ctx.route();
    },
  });
}

/** Load a saved bend into the calculator. */
function openSaved(id) {
  const b = store.get('bends', id);
  if (!b) return false;
  state.kind = KINDS[b.kind] ? b.kind : 'offset';
  state.type = b.conduit?.type || state.type;
  state.size = b.conduit?.tradeSize || state.size;
  state.profileId = b.benderProfileId || null;
  state.chart = !!b.inputs?.chart;
  const form = b.inputs?.form ? structuredClone(b.inputs.form) : {};
  // lengths were typed in the units of the day; show them in today's
  for (const spec of KINDS[state.kind].fields) {
    const key = spec.type === 'angle' ? spec.fit?.name : spec.name;
    if (spec.type !== 'len' && !(spec.type === 'angle' && key)) continue;
    const m = b.inputs?.[key];
    form[key] = Number.isFinite(m) ? fmt(m) : spec.optional ? '' : form[key];
  }
  state.forms[state.kind] = form;
  state.over = {};
  const prof = P.findProfile(b.benderProfileId, userProfiles());
  const differs = (k, v) => Number.isFinite(b.inputs?.[k]) && (v == null || Math.abs(b.inputs[k] - v) > 1e-6);
  if (state.kind === 'stub90' || state.kind === 'backToBack') {
    if (differs('takeUpM', prof?.takeUpM)) state.over.takeUpM = fmt(b.inputs.takeUpM);
    if (differs('gainM', prof?.gainM)) state.over.gainM = fmt(b.inputs.gainM);
    if (differs('radiusM', prof?.minRadiusM)) state.over.radiusM = fmt(b.inputs.radiusM);
  }
  state.editing = { id: b.id, name: b.name, jobId: b.jobId, notes: b.notes };
  remember();
  return true;
}

/** Recompute a saved bend for display or print. */
function computeSaved(b) {
  const prof = P.findProfile(b.benderProfileId, userProfiles());
  try {
    return { kind: b.kind, input: b.inputs, result: B.compute(b.kind, b.inputs, calcOpts(prof, !!b.inputs?.chart)), bender: { prof, odM: b.inputs?.odM } };
  } catch {
    return null;
  }
}

function savedView(root) {
  const jobId = ctx.query.jobId || '';
  let q = '';
  const listHost = h('div');
  const draw = () => {
    ui.clear(listHost);
    const needle = q.trim().toLowerCase();
    const rows = store.list('bends', (b) => (!jobId || b.jobId === jobId) && (!needle || [b.name, kindLabel(b.kind), jobName(b.jobId), b.notes].some((s) => String(s || '').toLowerCase().includes(needle))));
    listHost.append(ui.table({
      columns: [
        { key: 'name', label: 'Name', sort: (b) => b.name, render: (b) => h('strong', null, b.name) },
        { key: 'kind', label: 'Bend', sort: (b) => kindLabel(b.kind), render: (b) => kindLabel(b.kind) },
        { key: 'pipe', label: 'Pipe', render: (b) => `${B.conduitLabel(b.conduit?.type)} ${B.tradeSizeLabel(b.conduit?.tradeSize)}` },
        { key: 'marks', label: 'Marks', render: (b) => (b.result?.marks || []).slice(0, 4).map((m) => fmt(m.atM)).join(', ') + ((b.result?.marks || []).length > 4 ? '…' : '') },
        { key: 'job', label: 'Job', sort: (b) => jobName(b.jobId), render: (b) => jobName(b.jobId) },
        { key: 'updated', label: 'Updated', sort: (b) => b.updatedAt, render: (b) => ui.fmtDate(b.updatedAt) },
        { key: 'act', label: '', render: (b) => h('div', { class: 'row bend-row-actions', onClick: (e) => e.stopPropagation() },
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'printer', title: 'Print', onClick: () => { const c = computeSaved(b); if (c) printBend(c, b); else ui.toast('This bend no longer computes', 'error'); } }),
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'copy', title: 'Duplicate', onClick: () => {
            const { id, createdAt, updatedAt, ...rest } = b;
            const copy = store.add('bends', { ...structuredClone(rest), name: `${b.name} (copy)` });
            ui.toast(`Duplicated as "${copy.name}"`, 'success');
          } }),
          ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Delete', onClick: async () => {
            if (await ui.confirmDialog(`Delete "${b.name}"?`, { okLabel: 'Delete' })) { store.remove('bends', b.id); if (state.editing?.id === b.id) state.editing = null; ui.toast('Deleted'); }
          } })) },
      ],
      rows,
      onRowClick: (b) => ctx.nav('#/bending/open/' + b.id),
      empty: ui.empty({ icon: 'wrench', title: jobId ? 'No bends saved for this job' : 'No saved bends yet', text: 'Work out a bend, then Save it with a name and a job.', action: ui.button('New bend', { variant: 'primary', icon: 'plus', href: '#/bending' }) }),
    }));
  };
  const jobPick = h('select', { class: 'bend-input', 'aria-label': 'Job', onChange: (e) => ctx.nav(e.target.value ? `#/bending/saved?jobId=${encodeURIComponent(e.target.value)}` : '#/bending/saved') },
    jobOptions().map((o) => h('option', { value: o.value, selected: o.value === jobId }, o.value ? o.label : 'All jobs')));
  root.append(ui.page(
    { title: 'Saved bends', subtitle: jobId ? `For ${jobName(jobId)}` : 'Every bend you saved, newest first', actions: [ui.button('Back to bending', { icon: 'wrench', href: '#/bending' }), ui.button('New bend', { variant: 'primary', icon: 'plus', onClick: () => { state.editing = null; ctx.nav('#/bending/' + (state.kind === 'pull' ? 'offset' : state.kind)); } })] },
    h('div', { class: 'row bend-filter' }, ui.searchBox('Search bends', (v) => { q = v; draw(); }), h('label', { class: 'bend-field inline' }, h('span', { class: 'bend-label' }, 'Job'), jobPick)),
    listHost));
  draw();
  return store.on('bends', draw);
}

// ---------------------------------------------------------------------------
// Print / save as PDF
// ---------------------------------------------------------------------------

function inputLines(kind, input) {
  const lines = [];
  for (const spec of KINDS[kind]?.fields || []) {
    if (spec.type === 'len' && Number.isFinite(input[spec.name])) lines.push([spec.label, fmt(input[spec.name])]);
    if (spec.type === 'count' && Number.isFinite(input[spec.name])) lines.push([spec.label, String(input[spec.name])]);
    if (spec.type === 'choice' && input[spec.name] != null) lines.push([spec.label, spec.options.find((o) => String(o.value) === String(input[spec.name]))?.label || String(input[spec.name])]);
    if (spec.type === 'angle') {
      const a = input[spec.name || 'angleDeg'];
      if (Number.isFinite(a)) lines.push(['Angle', deg(a)]);
      else if (spec.fit && Number.isFinite(input[spec.fit.name])) lines.push([spec.fit.label, fmt(input[spec.fit.name])]);
    }
  }
  if (Number.isFinite(input.takeUpM)) lines.push(['Take-up', fmt(input.takeUpM)]);
  if (Number.isFinite(input.gainM)) lines.push(['Gain', fmt(input.gainM)]);
  if (Number.isFinite(input.radiusM)) lines.push(['Bend radius', fmt(input.radiusM)]);
  if (input.chart) lines.push(['Numbers', 'Bender chart (rounded)']);
  return lines;
}

function bendSheet(cur, meta) {
  const s = store.settings();
  const conduit = meta?.conduit || { type: state.type, tradeSize: state.size };
  const prof = cur.bender?.prof;
  const r = cur.result;
  const svg = (html) => { const d = h('div', { class: 'bend-svg-wrap' }); d.innerHTML = html; return d; };
  return h('article', { class: 'bend-sheet' },
    h('header', { class: 'bend-sheet-top' },
      h('div', null, h('div', { class: 'bend-sheet-co' }, s.company?.name || ''), h('div', { class: 'bend-sheet-small' }, `Pipe bending sheet · ${ui.fmtDate(new Date())}`)),
      h('div', { class: 'bend-sheet-title' }, h('h1', null, meta?.name || kindLabel(cur.kind)), h('div', { class: 'bend-sheet-small' }, [kindLabel(cur.kind), meta?.jobId ? jobName(meta.jobId) : null].filter(Boolean).join(' · ')))),
    h('table', { class: 'bend-sheet-inputs' }, h('tbody', null,
      h('tr', null, h('th', null, 'Pipe'), h('td', null, `${B.conduitLabel(conduit.type)} ${B.tradeSizeLabel(conduit.tradeSize)}`)),
      prof ? h('tr', null, h('th', null, 'Bender'), h('td', null, prof.name)) : null,
      inputLines(cur.kind, cur.input).map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
    svg(bentSvg(r, { fmt, width: 680, odM: cur.bender?.odM || cur.input?.odM || 0, maxHeight: 300 })),
    r.endView ? svg(rollSvg(r, { fmt })) : null,
    svg(marksSvg(r, { fmt, snap, width: 680 })),
    h('table', { class: 'bend-sheet-marks' },
      h('thead', null, h('tr', null, h('th', null, 'Mark'), h('th', { class: 'right' }, r.reference === 'end' ? 'From the end' : 'From mark 1'), h('th', null, 'Bend'))),
      h('tbody', null, r.marks.map((m) => h('tr', null, h('td', null, m.label), h('td', { class: 'right num' }, fmt(m.atM)), h('td', null, [m.angleDeg ? deg(m.angleDeg) : '', m.symbol && m.symbol !== 'tick' ? SYMBOL_NAMES[m.symbol] : '', m.note || ''].filter(Boolean).join(' · ')))))),
    h('p', { class: 'bend-sheet-small' }, [r.shrinkM ? `Shrink ${fmt(r.shrinkM)}` : null, r.developedLengthM ? `Pipe ${fmt(r.developedLengthM)}` : null, `${deg(r.degrees)} of bends`].filter(Boolean).join(' · ')),
    h('h2', null, 'How to bend it'),
    h('ol', null, r.steps.map((t) => h('li', null, t))),
    r.warnings.length ? h('div', { class: 'bend-sheet-warn' }, r.warnings.map((w) => h('p', null, w))) : null,
    meta?.notes ? h('p', null, h('strong', null, 'Notes: '), meta.notes) : null,
    h('footer', { class: 'bend-sheet-small' }, 'Check every mark against your own bender before you bend. Bender values vary by make, model and wear.'));
}

function printBend(cur, meta) {
  const node = h('div', { class: 'bend-print' }, bendSheet(cur, meta));
  document.body.append(node);
  document.body.classList.add('printing-bend');
  const done = () => { node.remove(); document.body.classList.remove('printing-bend'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 500); }, 50);
}

// ---------------------------------------------------------------------------
// 360° between pull points
// ---------------------------------------------------------------------------

function pullView() {
  const list = load('pull', []);
  const wrap = h('div', { class: 'bend-layout' });
  const save = () => keep('pull', list);
  const out = h('div', { class: 'bend-out' });
  const rows = h('div', { class: 'list bend-pull-list' });
  const draw = () => {
    ui.clear(rows); ui.clear(out);
    if (!list.length) rows.append(h('div', { class: 'list-row muted' }, 'Add each bend between the two pull points.'));
    list.forEach((b, i) => rows.append(h('div', { class: 'list-row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, deg(b.deg)), b.label ? h('div', { class: 'meta' }, b.label) : null),
      ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'x', title: 'Remove', onClick: () => { list.splice(i, 1); save(); draw(); } }))));
    const r = B.pullCheck(list.map((b) => b.deg));
    const pct = Math.min(100, (r.totalDeg / 360) * 100);
    out.append(h('div', { class: ['card', 'calc-result', r.ok ? (r.totalDeg > 270 ? 'warn' : 'pass') : 'fail'] },
      h('div', { class: 'calc-result-head' }, h('span', { class: 'calc-label' }, 'Bends between pull points'), ui.badge(r.ok ? `${deg(r.leftDeg)} left` : 'Over 360°', r.ok ? 'success' : 'danger')),
      h('div', { class: 'calc-value num' }, deg(r.totalDeg), h('span', { class: 'calc-unit' }, ' of 360°')),
      h('div', { class: 'progress calc-bar', role: 'img', 'aria-label': `${Math.round(pct)}% of 360°` }, h('i', { style: { width: pct + '%', background: r.ok ? '' : 'var(--danger)' } })),
      h('ul', { class: 'calc-why' },
        h('li', null, `${(r.quarterBends).toFixed(2).replace(/\.?0+$/, '')} quarter bends. The limit is four (360°) between pull points, counting bends right at a box or fitting (CEC Rule 12-942).`),
        r.warnings.map((w) => h('li', null, w)))));
  };
  const add = (d, label = '') => { if (d > 0) { list.push({ deg: d, label }); save(); draw(); } };
  const other = h('input', { class: 'bend-input num', type: 'number', inputmode: 'decimal', min: 1, max: 180, step: 'any', placeholder: 'degrees' });
  const saved = store.list('bends');
  const pickSaved = h('select', { class: 'bend-input', 'aria-label': 'Add a saved bend', onChange: (e) => {
    const b = saved.find((x) => x.id === e.target.value);
    e.target.value = '';
    if (!b) return;
    const c = computeSaved(b);
    if (!c) { ui.toast('That bend no longer computes', 'error'); return; }
    add(c.result.degrees, `${b.name} (${kindLabel(b.kind)})`);
  } }, h('option', { value: '' }, saved.length ? 'Add a saved bend…' : 'No saved bends yet'), saved.map((b) => h('option', { value: b.id }, `${b.name} · ${kindLabel(b.kind)}`)));
  wrap.append(
    h('div', { class: 'card bend-form' },
      h('p', { class: 'bend-blurb' }, 'Add up every bend in the run between two pull points: boxes, condulets or the ends of the run.'),
      h('div', { class: 'bend-chips big' }, [90, 45, 30, 22.5, 10].map((d) => h('button', { type: 'button', class: 'bend-chip', onClick: () => add(d) }, `+ ${deg(d)}`))),
      h('div', { class: 'row' }, other, ui.button('Add', { onClick: () => { add(Number(other.value)); other.value = ''; } })),
      h('label', { class: 'bend-field' }, h('span', { class: 'bend-label' }, 'From a saved bend'), pickSaved),
      rows,
      h('div', { class: 'row' }, ui.button('Clear', { variant: 'ghost', onClick: () => { list.length = 0; save(); draw(); } }))),
    out);
  draw();
  return wrap;
}

// ---------------------------------------------------------------------------
// Bender profiles and calibration
// ---------------------------------------------------------------------------

function profilesView(root) {
  const host = h('div');
  const draw = () => {
    ui.clear(host);
    const mine = userProfiles();
    host.append(
      h('h2', { class: 'section' }, 'Your benders'),
      ui.table({
        columns: [
          { key: 'name', label: 'Bender', sort: (p) => p.name, render: (p) => h('div', null, h('strong', null, p.name), p.isDefault ? ' ' : null, p.isDefault ? ui.badge('default', 'success') : null) },
          { key: 'pipe', label: 'Pipe', render: (p) => `${B.conduitLabel(p.conduitType)} ${B.tradeSizeLabel(p.tradeSize)}` },
          { key: 'tu', label: 'Take-up', align: 'right', render: (p) => fmt(p.takeUpM) },
          { key: 'gain', label: 'Gain', align: 'right', render: (p) => fmt(p.gainM) },
          { key: 'r', label: 'Radius', align: 'right', render: (p) => fmt(p.minRadiusM) },
          { key: 'act', label: '', render: (p) => h('div', { class: 'row bend-row-actions', onClick: (e) => e.stopPropagation() },
            ui.button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Edit', onClick: () => profileSheet(p) }),
            ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Delete', onClick: async () => {
              if (await ui.confirmDialog(`Delete "${p.name}"?`, { okLabel: 'Delete' })) store.remove('benderProfiles', p.id);
            } })) },
        ],
        rows: mine,
        onRowClick: (p) => profileSheet(p),
        empty: ui.empty({ icon: 'wrench', title: 'No benders of your own yet', text: 'Calibrate one: bend a test 90, measure it, and save its real take-up and gain.', action: ui.button('Calibrate a bender', { variant: 'primary', icon: 'wrench', onClick: () => calibrateSheet(draw) }) }),
      }),
      h('h2', { class: 'section' }, 'Built-in values'),
      h('p', { class: 'bend-verify' }, ui.icon('alert', 14), 'Typical published figures (Klein, Greenlee and IDEAL guides). Check them against the marks on your own bender, or calibrate it.'),
      ui.table({
        columns: [
          { key: 'name', label: 'Bender', sort: (p) => p.name, render: (p) => p.name },
          { key: 'pipe', label: 'Pipe', sort: (p) => p.conduitType + p.tradeSize.padStart(3, '0'), render: (p) => `${B.conduitLabel(p.conduitType)} ${B.tradeSizeLabel(p.tradeSize)}` },
          { key: 'tu', label: 'Take-up', align: 'right', render: (p) => fmt(p.takeUpM) },
          { key: 'r', label: 'Radius', align: 'right', render: (p) => fmt(p.minRadiusM) },
          { key: 'gain', label: 'Gain*', align: 'right', render: (p) => fmt(p.gainM) },
          { key: 'src', label: 'Source', render: (p) => h('span', { class: 'muted bend-src' }, p.source) },
          { key: 'act', label: '', render: (p) => ui.button('Copy', { size: 'sm', icon: 'copy', onClick: (e) => { e.stopPropagation(); profileSheet(copyOf(p)); } }) },
        ],
        rows: P.DEFAULT_PROFILES,
      }),
      h('p', { class: 'calc-note muted' }, '* Gain is worked out from the radius and the pipe OD (radius × (2 − π/2) + OD). The makers do not publish it.'));
  };
  root.append(ui.page(
    { title: 'My benders', subtitle: 'Your benders\' real take-up and gain, used in every bend', actions: [
      ui.button('Back to bending', { icon: 'wrench', href: '#/bending' }),
      ui.button('Add by hand', { icon: 'plus', onClick: () => profileSheet({ conduitType: state.type === 'PVC' ? 'EMT' : state.type, tradeSize: state.size }) }),
      ui.button('Calibrate a bender', { variant: 'primary', icon: 'wrench', onClick: () => calibrateSheet(draw) }),
    ] },
    host));
  draw();
  return store.on('benderProfiles', draw);
}

const copyOf = (p) => ({ name: `My ${p.brand} ${B.tradeSizeLabel(p.tradeSize)}`, brand: p.brand, model: p.model, conduitType: p.conduitType, tradeSize: p.tradeSize, takeUpM: p.takeUpM, gainM: p.gainM, minRadiusM: p.minRadiusM, backToBackMark: p.backToBackMark, centreMark: p.centreMark, notes: `Copied from the built-in ${p.name}; check against the bender.` });

/** Only one default per conduit type and size. */
function saveProfile(id, data) {
  if (data.isDefault) {
    for (const p of userProfiles()) {
      if (p.id !== id && p.isDefault && p.conduitType === data.conduitType && String(p.tradeSize) === String(data.tradeSize)) store.update('benderProfiles', p.id, { isDefault: false });
    }
  }
  return id ? store.update('benderProfiles', id, data) : store.add('benderProfiles', data);
}

function profileSheet(p) {
  const types = B.CONDUIT_TYPES.filter((c) => c.id !== 'PVC').map((c) => ({ value: c.id, label: c.label }));
  const len = (m) => (Number.isFinite(m) ? fmt(m) : '');
  ui.formSheet({
    title: p.id ? 'Edit bender' : 'Add a bender',
    fields: [
      { label: 'Name', name: 'name', value: p.name || '', required: true, span: true, placeholder: 'e.g. Van 2 Klein 3/4"' },
      { label: 'Brand', name: 'brand', value: p.brand || '' },
      { label: 'Model', name: 'model', value: p.model || '' },
      { label: 'Conduit', name: 'conduitType', type: 'select', value: p.conduitType || 'EMT', options: types },
      { label: 'Trade size', name: 'tradeSize', type: 'select', value: p.tradeSize || '21', options: sizeOptions() },
      { label: 'Take-up (deduct)', name: 'takeUp', value: len(p.takeUpM), placeholder: units === 'imperial' ? 'e.g. 6' : 'e.g. 152' },
      { label: 'Gain', name: 'gain', value: len(p.gainM) },
      { label: 'Bend radius (centre of pipe)', name: 'radius', value: len(p.minRadiusM) },
      { label: 'Back-to-back mark', name: 'backToBackMark', value: p.backToBackMark || 'star' },
      { label: 'Saddle centre mark', name: 'centreMark', value: p.centreMark || 'rim notch' },
      { label: 'Use this bender by default for this pipe', name: 'isDefault', type: 'checkbox', value: p.id ? !!p.isDefault : true, span: true },
      { label: 'Notes', name: 'notes', type: 'textarea', value: p.notes || '', rows: 3, span: true },
    ],
    danger: p.id ? { label: 'Delete', onClick: () => store.remove('benderProfiles', p.id) } : null,
    onSubmit: (v) => {
      const read = (t, label) => { if (!String(t).trim()) return { ok: true, m: null }; const m = parse(t); if (m == null || m <= 0) { ui.toast(`${label}: can't read that`, 'error'); return { ok: false }; } return { ok: true, m }; };
      const tu = read(v.takeUp, 'Take-up'), g = read(v.gain, 'Gain'), r = read(v.radius, 'Radius');
      if (!tu.ok || !g.ok || !r.ok) return false;
      if (tu.m == null && r.m == null) { ui.toast('Enter a take-up or a radius', 'error'); return false; }
      saveProfile(p.id, {
        name: v.name.trim(), brand: v.brand.trim(), model: v.model.trim(), conduitType: v.conduitType, tradeSize: v.tradeSize,
        takeUpM: tu.m, gainM: g.m ?? (r.m ? B.gain90({ radiusM: r.m, odM: B.conduitOD(v.conduitType, v.tradeSize) || 0 }) : null),
        minRadiusM: r.m, backToBackMark: v.backToBackMark.trim(), centreMark: v.centreMark.trim(), isDefault: !!v.isDefault, notes: v.notes,
      });
      ui.toast('Bender saved', 'success');
    },
  });
}

/** Bend a test 90, measure it, save the real take-up and gain. */
function calibrateSheet(onDone) {
  const c = {
    type: state.type === 'PVC' ? 'EMT' : state.type, size: state.size, brand: currentProfile()?.brand || '', model: currentProfile()?.model || 'Hand bender',
    mark: fmt(pick([12, 300])), mark2: fmt(pick([30, 750])), stub: '', leg: '', isDefault: true,
  };
  const out = h('div', { class: 'bend-cal-out', 'aria-live': 'polite' });
  let result = null;
  const refresh = () => {
    ui.clear(out);
    result = null;
    const markM = parse(c.mark), mark2M = parse(c.mark2), stubM = parse(c.stub), legM = c.leg.trim() ? parse(c.leg) : null;
    if (stubM == null) { out.append(h('p', { class: 'muted' }, 'Enter what you measured to see the take-up.')); return; }
    try {
      result = P.calibrate({ markM, stubM, mark2M, legM });
    } catch (e) { out.append(h('p', { class: 'bend-bad' }, e.message)); return; }
    const pub = P.pickProfile(c.type, c.size, [], null);
    const diff = (a, b) => (a != null && b != null ? ` (published ${fmt(b)}, ${a >= b ? '+' : '−'}${fmt(Math.abs(a - b))})` : '');
    out.append(h('div', { class: 'calc-minis' },
      h('div', { class: 'calc-mini' }, h('span', null, 'Take-up'), h('strong', { class: 'num' }, fmt(result.takeUpM)), h('span', null, diff(result.takeUpM, pub?.takeUpM))),
      h('div', { class: 'calc-mini' }, h('span', null, 'Gain'), h('strong', { class: 'num' }, result.gainM != null ? fmt(result.gainM) : '—'), h('span', null, result.gainM != null ? diff(result.gainM, pub?.gainM) : 'Measure the other leg for gain'))),
    result.warnings.map((w) => h('p', { class: 'bend-bad' }, w)));
  };
  const field = (label, key, hint, optional) => lenInput(label, c[key], (v) => { c[key] = v; refresh(); }, { hint, optional });
  const body = h('div', { class: 'stack bend-cal' },
    h('div', { class: 'bend-fields three' },
      select('Conduit', B.CONDUIT_TYPES.filter((t) => t.id !== 'PVC').map((t) => ({ value: t.id, label: t.label })), c.type, (v) => { c.type = v; refresh(); }),
      select('Trade size', sizeOptions(), c.size, (v) => { c.size = v; refresh(); }),
      h('label', { class: 'bend-field' }, h('span', { class: 'bend-label' }, 'Brand'), h('input', { class: 'bend-input', value: c.brand, onInput: (e) => { c.brand = e.target.value; } }))),
    h('ol', { class: 'bend-cal-steps' },
      h('li', null, 'Take a straight piece of pipe with a square-cut end.', field('Mark it this far from the end', 'mark')),
      h('li', null, 'For gain, make a second mark farther along (optional).', field('Second mark from the end', 'mark2', null, true)),
      h('li', null, 'Put the first mark on the arrow, hook toward the end, and bend a 90. Check it with a level.'),
      h('li', null, 'Measure from the end of the pipe to the back of the 90.', field('Stub you measured', 'stub')),
      h('li', null, 'Measure from the back of the 90 along the other leg to the second mark.', field('Back of 90 to second mark', 'leg', null, true))),
    out,
    h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: c.isDefault, onChange: (e) => { c.isDefault = e.target.checked; } }), h('span', null, 'Use this bender by default for this pipe')));
  const sheet = ui.openSheet({
    title: 'Calibrate a bender', wide: true, body,
    actions: [
      ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }),
      ui.button('Save bender', { variant: 'primary', icon: 'save', onClick: () => {
        if (!result) { ui.toast('Measure the test bend first', 'error'); return; }
        const pub = P.pickProfile(c.type, c.size, [], null);
        const saved = saveProfile(null, {
          name: `${c.brand || 'My'} ${B.conduitLabel(c.type)} ${B.tradeSizeLabel(c.size)} (calibrated)`.trim(),
          brand: c.brand, model: c.model, conduitType: c.type, tradeSize: c.size,
          takeUpM: result.takeUpM, gainM: result.gainM ?? pub?.gainM ?? null, minRadiusM: pub?.minRadiusM ?? null,
          backToBackMark: pub?.backToBackMark || 'star', centreMark: pub?.centreMark || 'rim notch', isDefault: c.isDefault,
          notes: `Calibrated ${new Date().toISOString().slice(0, 10)}: marked ${fmt(parse(c.mark))}, stub ${fmt(parse(c.stub))}.${result.gainM == null ? ' Gain from the built-in radius.' : ''}`,
        });
        if (c.type === state.type && c.size === state.size) { state.profileId = saved.id; state.over = {}; remember(); }
        ui.toast('Bender saved', 'success');
        sheet.close();
        onDone?.();
      } }),
    ],
  });
  refresh();
}

// ---------------------------------------------------------------------------

export default {
  id: 'bending',
  title: 'Pipe bending',
  icon: 'wrench',
  group: 'field',
  perm: 'calcs',
  render(root, c) {
    ctx = c; ui = c.ui; h = ui.h; store = c.store;
    units = getUnits(store.settings().units);
    const [p0, p1] = c.params;
    if (p0 === 'saved') return savedView(root);
    if (p0 === 'profiles') return profilesView(root);
    if (p0 === 'open') {
      if (!openSaved(p1)) {
        root.append(ui.page({ title: 'Pipe bending' }, ui.empty({ icon: 'wrench', title: 'Bend not found', text: 'It may have been deleted.', action: ui.button('Saved bends', { href: '#/bending/saved' }) })));
        return undefined;
      }
      // further re-renders (units, reset) must not reload the saved copy over your edits
      history.replaceState(null, '', '#/bending/' + state.kind);
    } else if (p0 && (KINDS[p0] || p0 === 'pull')) state.kind = p0;
    if (!KINDS[state.kind] && state.kind !== 'pull') state.kind = 'offset';
    return calculatorView(root);
  },
};
