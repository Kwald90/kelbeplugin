// Calculators (S25): voltage drop, wire size, conduit fill, box fill, service
// load, motors, Ohm's law and three-phase. They follow the company's code book:
// CEC 2024 (CSA C22.1:24) by default, NEC 2023 when chosen in Settings. Results
// cite rule and table numbers. Lengths and areas show in the user's units;
// everything is computed in SI.
import * as NEC from '../lib/nec.js';
import * as CEC from '../lib/cec/index.js';
import { getUnits, parseLength, fmtLength, M_PER_FT } from '../lib/units.js';

const FT2 = M_PER_FT * M_PER_FT; // m² per ft²
const ML_PER_IN3 = 16.387064;
const MM2_PER_IN2 = 645.16;

const TABS = [
  { id: 'vd', label: 'Voltage drop' },
  { id: 'wire', label: 'Wire size' },
  { id: 'conduit', label: 'Conduit fill' },
  { id: 'box', label: 'Box fill' },
  { id: 'load', label: 'Service load' },
  { id: 'motor', label: 'Motors' },
  { id: 'ohms', label: "Ohm's law" },
  { id: '3ph', label: '3-phase' },
];

const MATERIALS = [{ value: 'cu', label: 'Copper' }, { value: 'al', label: 'Aluminum' }];
const PHASES = [{ value: '1', label: 'Single phase' }, { value: '3', label: 'Three phase' }];

let ui, h, units, book, province;

// ---------------------------------------------------------------------------
// Inputs with units. Fields declared with `qty: 'length' | 'area'` are shown in
// the user's units and read back in metres / m²; saved values are always SI.
// ---------------------------------------------------------------------------

const imperial = () => units === 'imperial';
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;
const QTY = {
  length: {
    suffix: () => (imperial() ? 'ft-in' : 'm'),
    toInput: (m) => (m == null || !Number.isFinite(Number(m)) ? '' : imperial() ? fmtLength(Number(m), { units, denom: 8 }) : String(round(Number(m), 2))),
    parse: (s) => (s == null || String(s).trim() === '' ? null : parseLength(s, { units, bare: imperial() ? 'ft' : 'm' })),
  },
  area: {
    suffix: () => (imperial() ? 'ft²' : 'm²'),
    toInput: (m2) => (m2 == null || m2 === '' ? '' : String(imperial() ? round(m2 / FT2, 0) : round(m2, 1))),
    parse: (s) => (s == null || String(s).trim() === '' ? null : Number(s) * (imperial() ? FT2 : 1)),
  },
};

function saved(tab, defaults) {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(`kc.calc.${book}.${tab}`) || '{}') }; } catch { return { ...defaults }; }
}
function remember(tab, values) {
  try { localStorage.setItem(`kc.calc.${book}.${tab}`, JSON.stringify(values)); } catch { /* storage blocked */ }
}

const num = (n, d = 2) => (Number.isFinite(n) ? ui.fmtNum(n, d) : '—');
const n = (x) => (x == null || x === '' ? 0 : Number(x));
const len = (m) => fmtLength(m, { units, denom: 8 });
const areaTxt = (mm2) => (imperial() ? `${num(mm2 / MM2_PER_IN2, 3)} in² (${num(mm2, 0)} mm²)` : `${num(mm2, 0)} mm²`);
const volTxt = (ml) => (imperial() ? `${num(ml, 1)} mL (${num(ml / ML_PER_IN3, 2)} in³)` : `${num(ml, 1)} mL`);

/** Result card: a big number, an optional pass/fail badge, and the reasons. */
function result({ label, value, unit, tone, badge, sub, lines = [], children }) {
  return h('div', { class: ['card', 'calc-result', tone] },
    h('div', { class: 'calc-result-head' }, h('span', { class: 'calc-label' }, label), badge ? ui.badge(badge, tone === 'fail' ? 'danger' : tone === 'warn' ? 'warning' : 'success') : null),
    value != null ? h('div', { class: 'calc-value num' }, value, unit ? h('span', { class: 'calc-unit' }, ' ' + unit) : null) : null,
    sub ? h('div', { class: 'calc-sub' }, sub) : null,
    lines.length ? h('ul', { class: 'calc-why' }, lines.filter(Boolean).map((l) => h('li', null, l))) : null,
    children || null);
}

function mini(label, value) {
  return h('div', { class: 'calc-mini' }, h('span', null, label), h('strong', { class: 'num' }, value));
}

/** Rule/table references under a result. */
function refs(...items) {
  return h('p', { class: 'calc-refs muted' }, ui.icon('book', 14), ' ', items.filter(Boolean).join(' · '));
}

/**
 * A live calculator: fields on the left, results on the right. `compute(values)`
 * returns result nodes. Inputs are remembered per tab and code book on this device.
 */
function liveCalc(tab, defaults, fieldsFor, compute, { onChange } = {}) {
  const v = saved(tab, defaults);
  const fields = fieldsFor(v).filter(Boolean);
  const qtyFields = fields.filter((f) => f.qty);
  const shown = fields.map((f) => (f.qty ? {
    ...f, type: f.qty === 'length' ? 'text' : 'number', step: 'any', label: `${f.label} (${QTY[f.qty].suffix()})`,
    value: QTY[f.qty].toInput(f.value), placeholder: f.qty === 'length' ? (imperial() ? `e.g. 98' 6"` : 'e.g. 30') : null,
  } : f));
  const out = h('div', { class: 'calc-out', 'aria-live': 'polite' });
  const form = h('form', { class: 'card calc-form', onSubmit: (e) => e.preventDefault() }, ui.formGrid(shown));
  const read = () => {
    const x = ui.readForm(form);
    for (const f of qtyFields) x[f.name] = QTY[f.qty].parse(form.querySelector(`[name="${f.name}"]`).value);
    return x;
  };
  const update = (e) => {
    const x = read();
    remember(tab, Object.fromEntries(Object.entries(x).filter(([k, val]) => !(qtyFields.some((f) => f.name === k) && val == null))));
    if (onChange && e && onChange(x, e) === 'rerender') return;
    ui.clear(out);
    const bad = qtyFields.filter((f) => x[f.name] == null && form.querySelector(`[name="${f.name}"]`).value.trim() !== '');
    if (bad.length) { out.append(result({ label: 'Check the inputs', tone: 'warn', lines: bad.map((f) => `Can't read the ${f.label.toLowerCase()}. Try ${imperial() ? `98' 6" or 98.5` : '30 or 30 m'}.`) })); return; }
    try {
      const r = compute(x);
      out.append(...[r].flat().filter(Boolean));
    } catch (err) {
      out.append(result({ label: 'Check the inputs', tone: 'warn', lines: [err.message] }));
    }
  };
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  update();
  return h('div', { class: 'calc-layout' }, form, out);
}

// ===========================================================================
// CEC 2024
// ===========================================================================

const C = {
  sizeOpts: (material = 'cu') => CEC.SIZES.filter((s) => material !== 'al' || s !== '14').map((s) => ({ value: s, label: `${CEC.sizeLabel(s)} (${CEC.AREA_MM2[s]} mm²)` })),
  mat: (m) => (m === 'al' ? 'Al' : 'Cu'),
};

function cecVoltageDrop() {
  const D = { volts: 240, phase: '1', amps: 20, ocpd: 20, length: 30, size: '12', material: 'cu', maxPct: 3 };
  return liveCalc('vd', D, (v) => [
    { label: 'System voltage', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 1, hint: '120, 208, 240, 347 or 600 V' },
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'Load (A)', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0, hint: '0 if unknown: uses 80% of the breaker' },
    { label: 'Breaker (A)', name: 'ocpd', type: 'number', value: v.ocpd, step: 1, min: 0 },
    { label: 'One-way length', name: 'length', qty: 'length', value: v.length },
    { label: 'Conductor', name: 'size', type: 'select', value: v.size, options: C.sizeOpts(v.material) },
    { label: 'Material', name: 'material', type: 'select', value: v.material, options: MATERIALS },
    { label: 'Max drop (%)', name: 'maxPct', type: 'number', value: v.maxPct, step: 'any', min: 0, hint: CEC.ruleParams('8-102', province).feeder == null ? `Rule 8-102 as amended in ${province}: 3%, branch circuits only` : 'Rule 8-102: 3% feeder or branch, 5% total' },
  ], (x) => {
    if (x.material === 'al' && x.size === '14') throw new Error('14 AWG aluminum is not in Table 4. Pick 12 AWG or larger.');
    if (!(n(x.volts) > 0)) throw new Error('Enter a system voltage.');
    const I = CEC.designCurrent({ loadAmps: x.amps, ocpdAmps: x.ocpd });
    if (!(I.amps > 0)) throw new Error('Enter the load, or the breaker size if the load is not known (Rule 8-102).');
    const L = x.length ?? 0;
    const args = { volts: n(x.volts), phase: Number(x.phase), amps: I.amps, material: x.material };
    const r = CEC.voltageDrop({ ...args, lengthM: L, size: x.size });
    const max = n(x.maxPct) || 3;
    const ok = r.percent <= max + 1e-9;
    const minSize = CEC.minSizeForVoltageDrop({ ...args, lengthM: L, maxPct: max });
    const maxLen = CEC.maxLengthForVoltageDrop({ ...args, size: x.size, maxPct: max });
    const k = Number(x.phase) === 3 ? '√3' : '2';
    return [
      result({
        label: 'Voltage drop', value: num(r.percent, 2), unit: '%', tone: ok ? 'pass' : 'fail', badge: ok ? `Within ${max}%` : `Over ${max}%`,
        sub: `${num(r.volts, 2)} V drop · ${num(r.endVolts, 1)} V at the load`,
        lines: [
          `Current ${num(I.amps, 1)} A: ${I.basis} (Rule 8-102(2)).`,
          `VD = ${k} × I × R × L = ${k} × ${num(I.amps, 1)} A × ${r.ohmsPerKm} Ω/km × ${num(L / 1000, 4)} km = ${num(r.volts, 2)} V.`,
          `R: DC resistance at 75 °C, ${x.material === 'cu' ? 'copper' : 'aluminum'} ${CEC.sizeLabel(x.size)}.`,
        ],
      }),
      h('div', { class: 'calc-minis' },
        mini(`Smallest within ${max}%`, minSize ? `${CEC.sizeLabel(minSize)} ${C.mat(x.material)}` : 'over 500 kcmil'),
        mini(`Longest run, ${CEC.sizeLabel(x.size)}`, maxLen != null ? len(maxLen) : '—')),
      refs('Rule 8-102: 5% from the service to the point of use, 3% in any feeder or branch circuit', 'checks the conductor only, not other causes of drop'),
    ];
  });
}

function cecWire() {
  const D = { amps: 40, continuous: true, rated100: false, material: 'cu', termination: 'auto', insulation: '90', ambientC: 30, ccc: 3, freeAir: false, volts: 240, phase: '1', length: 0, maxVdPct: 3 };
  return liveCalc('wire', D, (v) => [
    { label: 'Load (A)', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'Continuous load', name: 'continuous', type: 'checkbox', value: v.continuous },
    { label: 'Breaker rated 100% continuous', name: 'rated100', type: 'checkbox', value: v.rated100 },
    { label: 'Material', name: 'material', type: 'select', value: v.material, options: MATERIALS },
    { label: 'Insulation rating', name: 'insulation', type: 'select', value: v.insulation, options: [{ value: '90', label: '90 °C (RW90, T90, NMD90, Teck90)' }, { value: '75', label: '75 °C (TWN75, RW75)' }, { value: '60', label: '60 °C (TW)' }] },
    { label: 'Terminations', name: 'termination', type: 'select', value: v.termination, options: [{ value: 'auto', label: 'Unmarked (Rule 4-006)' }, { value: '60', label: '60 °C' }, { value: '75', label: '75 °C' }, { value: '90', label: '90 °C' }], hint: 'Unmarked: 60 °C up to 100 A, 75 °C above' },
    { label: 'Ambient (°C)', name: 'ambientC', type: 'number', value: v.ambientC, step: 'any' },
    { label: 'Current-carrying conductors', name: 'ccc', type: 'number', value: v.ccc, min: 1, step: 1 },
    { label: 'Single conductors in free air', name: 'freeAir', type: 'checkbox', value: v.freeAir },
    { label: 'Voltage (for drop)', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 0 },
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'One-way length (0 = skip)', name: 'length', qty: 'length', value: v.length },
    { label: 'Max drop (%)', name: 'maxVdPct', type: 'number', value: v.maxVdPct, step: 'any', min: 0 },
  ], (x) => {
    const L = x.length || 0;
    const vd = n(x.volts) > 0 && L > 0
      ? (size) => (CEC.R_OHM_PER_KM[x.material]?.[size] == null ? null : CEC.voltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), lengthM: L, size, material: x.material }))
      : null;
    const r = CEC.sizeConductor({
      amps: n(x.amps), continuous: x.continuous, rated100: x.rated100, material: x.material,
      terminationC: x.termination === 'auto' ? null : Number(x.termination), insulationC: Number(x.insulation),
      ambientC: x.ambientC == null ? 30 : n(x.ambientC), ccc: n(x.ccc) || 3, freeAir: x.freeAir, maxVdPct: n(x.maxVdPct) || 3, vd,
    });
    if (!r.size) return result({ label: 'No single conductor works', tone: 'fail', badge: 'Check', lines: [r.error] });
    const bond = CEC.bondingConductor(r.ocpd);
    return [
      result({
        label: 'Conductor', value: r.label, unit: C.mat(x.material), tone: 'pass', badge: `Breaker ${r.ocpd} A`,
        sub: `${CEC.AREA_MM2[r.size]} mm² · governed by ${r.governedBy}${r.vd ? ` · drop ${num(r.vd.percent, 2)}%` : ''}`,
        lines: r.reasons,
      }),
      h('div', { class: 'calc-minis' },
        mini(`Usable ampacity (${r.table})`, `${num(r.usableAmpacity, 1)} A`),
        bond ? mini('Bonding conductor (Table 16)', `${CEC.sizeLabel(bond.cu)} Cu / ${CEC.sizeLabel(bond.al)} Al`) : null),
      r.rejected?.length ? h('div', { class: 'card flat calc-rejected' },
        h('div', { class: 'calc-label' }, 'Why not smaller'),
        h('ul', { class: 'calc-why' }, r.rejected.slice(-3).map((t) => h('li', null, h('strong', null, CEC.sizeLabel(t.size) + ': '), t.why.join('; '))))) : null,
      refs(`${r.table}`, 'Tables 5A, 5C', 'Rules 4-004, 4-006, 8-104, 14-104', vd ? 'Rule 8-102' : null),
    ];
  });
}

function cecConduit() {
  const types = Object.keys(CEC.CONDUCTOR_TYPES);
  const D = { conduitType: 'EMT', tradeSize: '21', s1: '12', i1: types[0], c1: 4, s2: '12', i2: types[0], c2: 1, s3: '10', i3: types[0], c3: 0 };
  return liveCalc('conduit', D, (v) => {
    const row = (k) => [
      { label: `Group ${k}: size`, name: 's' + k, type: 'select', value: v['s' + k], options: CEC.SIZES.map((s) => ({ value: s, label: CEC.sizeLabel(s) })) },
      { label: 'Type', name: 'i' + k, type: 'select', value: v['i' + k], options: types.map((t) => ({ value: t, label: CEC.CONDUCTOR_TYPES[t].label })) },
      { label: 'Count', name: 'c' + k, type: 'number', value: v['c' + k], min: 0, step: 1 },
    ];
    return [
      { label: 'Conduit', name: 'conduitType', type: 'select', value: v.conduitType, options: Object.entries(CEC.CONDUIT_TYPES).map(([k, c]) => ({ value: k, label: c.label })) },
      { label: 'Trade size', name: 'tradeSize', type: 'select', value: v.tradeSize, options: CEC.TRADE_SIZES.map((t) => ({ value: t, label: `${t} (${CEC.TRADE_SIZE_IN[t]}")` })) },
      ...row(1), ...row(2), ...row(3),
    ];
  }, (x) => {
    const wires = [1, 2, 3].map((k) => ({ size: x['s' + k], insulation: x['i' + k], count: n(x['c' + k]) })).filter((w) => w.count > 0);
    const r = CEC.conduitFill({ conduitType: x.conduitType, tradeSize: x.tradeSize, wires });
    const min = wires.length ? CEC.minConduit({ conduitType: x.conduitType, wires }) : null;
    const first = wires[0];
    const pct = Math.min(100, (r.fillPct / r.allowedPct) * 100);
    const ct = CEC.CONDUIT_TYPES[x.conduitType];
    return [
      result({
        label: `Fill, ${x.tradeSize} ${ct.label}`, value: num(r.fillPct, 1), unit: '%', tone: r.pass ? 'pass' : 'fail', badge: r.pass ? `≤ ${r.allowedPct}% allowed` : `Over ${r.allowedPct}%`,
        sub: `${areaTxt(r.wireArea)} of ${areaTxt(r.allowedArea)} allowed (${areaTxt(r.conduitArea)} inside)`,
        lines: [
          `${r.count} conductor${r.count === 1 ? '' : 's'}: ${r.allowedPct}% limit (Table 8, Rule 12-910).`,
          r.missing.length ? `No area data for ${r.missing.join(', ')}: left out.` : null,
        ],
        children: h('div', { class: 'progress calc-bar', role: 'img', 'aria-label': `${num(r.fillPct, 1)}% of ${r.allowedPct}%` }, h('i', { style: { width: pct + '%', background: r.pass ? '' : 'var(--danger)' } })),
      }),
      h('div', { class: 'calc-minis' },
        mini(`Smallest ${ct.label}`, min ? `${min.tradeSize} (${CEC.TRADE_SIZE_IN[min.tradeSize]}") · ${num(min.fillPct, 1)}%` : wires.length ? 'over 103' : '—'),
        first ? mini(`Max ${CEC.sizeLabel(first.size)} ${CEC.CONDUCTOR_TYPES[first.insulation].label} in ${x.tradeSize}`, String(CEC.maxConductors({ conduitType: x.conduitType, tradeSize: x.tradeSize, size: first.size, insulation: first.insulation }))) : null),
      refs('Rule 12-910', 'Table 8 (fill %)', `${ct.table} (conduit area)`, `${CEC.CONDUCTOR_TYPES[first?.insulation || types[0]].table} (conductor area)`),
    ];
  });
}

function cecBox() {
  const boxes = CEC.BOXES;
  const D = { box: 'dev-2.5', custom: 0, extra: 0, s1: '14', c1: 4, s2: '12', c2: 0, devices: 1, connectors: 2, studs: 0 };
  return liveCalc('box', D, (v) => [
    { label: 'Box (Table 23)', name: 'box', type: 'select', value: v.box, options: [...boxes.map((b) => ({ value: b.id, label: `${b.name} (${num(b.volumeML, 0)} mL)` })), { value: 'custom', label: 'Other: enter volume' }], span: true },
    { label: 'Box volume if other (mL)', name: 'custom', type: 'number', value: v.custom, step: 'any', min: 0 },
    { label: 'Extension ring / raised cover (mL)', name: 'extra', type: 'number', value: v.extra, step: 'any', min: 0, hint: 'Marked volume adds to the box' },
    { label: 'Conductors, size', name: 's1', type: 'select', value: v.s1, options: Object.keys(CEC.TABLE_22).map((s) => ({ value: s, label: `${s} AWG` })) },
    { label: 'Count', name: 'c1', type: 'number', value: v.c1, min: 0, step: 1, hint: CEC.BOX_RULES.countHint },
    { label: 'More conductors, size', name: 's2', type: 'select', value: v.s2, options: Object.keys(CEC.TABLE_22).map((s) => ({ value: s, label: `${s} AWG` })) },
    { label: 'Count', name: 'c2', type: 'number', value: v.c2, min: 0, step: 1 },
    { label: 'Wiring devices (straps)', name: 'devices', type: 'number', value: v.devices, min: 0, step: 1 },
    { label: 'Wire connectors (marrettes)', name: 'connectors', type: 'number', value: v.connectors, min: 0, step: 1, hint: 'Each pair counts as 1 conductor' },
    { label: 'Fixture studs / hickeys', name: 'studs', type: 'number', value: v.studs, min: 0, step: 1 },
  ], (x) => {
    const b = boxes.find((y) => y.id === x.box);
    const boxML = x.box === 'custom' ? n(x.custom) : b?.volumeML || 0;
    const r = CEC.boxFill({
      conductors: [{ size: x.s1, count: n(x.c1) }, { size: x.s2, count: n(x.c2) }],
      devices: n(x.devices), connectors: n(x.connectors), studs: n(x.studs), boxML, extraML: n(x.extra),
    });
    return [
      result({
        label: 'Box fill', value: num(r.requiredML, 1), unit: `of ${num(r.availableML, 1)} mL`,
        tone: r.pass == null ? 'warn' : r.pass ? 'pass' : 'fail', badge: r.pass == null ? 'Enter a box volume' : r.pass ? 'Fits' : 'Too full',
        sub: r.pass === false ? `Needs ${volTxt(r.requiredML - r.availableML)} more: a deeper box or an extension ring.` : imperial() ? `${num(r.requiredML / ML_PER_IN3, 2)} of ${num(r.availableML / ML_PER_IN3, 2)} in³` : null,
        lines: [...CEC.BOX_RULES.summary, r.largest && r.availableML > 0 ? `This box holds up to ${r.maxConductors} × ${r.largest} AWG (Table 23 method).` : null],
      }),
      ui.table({
        columns: [
          { key: 'label', label: 'Item' },
          { key: 'count', label: 'Counts as', align: 'right', render: (i) => num(i.count, 0) },
          { key: 'each', label: 'mL each', align: 'right', render: (i) => num(i.each, 1) },
          { key: 'volume', label: 'mL', align: 'right', render: (i) => num(i.volume, 1) },
        ],
        rows: r.items,
      }),
      refs('Rule 12-3034', 'Table 22 (space per conductor)', 'Table 23 (box volumes)'),
    ];
  });
}

function cecLoad(rerender) {
  const D = { mode: 'single', ground: 120, above: 0, basement: 100, basementTall: true, heatW: 0, centralHeat: false, acW: 3500, interlocked: false, rangeW: 12000, tanklessW: 0, evseW: 0, evems: false, evemsW: 0,
    dryerW: 5000, whW: 3000, dwW: 0, other1: 0, other2: 0, units: 12, unitArea: 70, unitHeatW: 5000, unitAcW: 0, unitRangeW: 12000, unitOtherW: 0, unitEvW: 0, commonW: 20000, aptVolts: 208, aptPhase: '3' };
  const v0 = saved('load', D);
  if (v0.mode === 'apartment') return cecApartment(rerender, D);
  return liveCalc('load', D, (v) => [
    { label: 'Building', name: 'mode', type: 'select', value: v.mode, options: [{ value: 'single', label: 'Single dwelling (Rule 8-200)' }, { value: 'apartment', label: 'Apartment building (Rule 8-202)' }], span: true },
    { label: 'Ground floor area', name: 'ground', qty: 'area', value: v.ground },
    { label: 'Floors above, living area', name: 'above', qty: 'area', value: v.above },
    { label: 'Basement area', name: 'basement', qty: 'area', value: v.basement },
    { label: 'Basement headroom 1.8 m or more', name: 'basementTall', type: 'checkbox', value: v.basementTall },
    { label: 'Electric space heating (W)', name: 'heatW', type: 'number', value: v.heatW, min: 0, step: 'any' },
    { label: 'Central heat (furnace, duct heater): 100%', name: 'centralHeat', type: 'checkbox', value: v.centralHeat },
    { label: 'Air conditioning / heat pump (W)', name: 'acW', type: 'number', value: v.acW, min: 0, step: 'any' },
    { label: 'Heat and A/C never run together', name: 'interlocked', type: 'checkbox', value: v.interlocked },
    { label: 'Range (W, 0 = none)', name: 'rangeW', type: 'number', value: v.rangeW, min: 0, step: 'any' },
    { label: 'Tankless water heater, hot tub, pool heater (W)', name: 'tanklessW', type: 'number', value: v.tanklessW, min: 0, step: 'any' },
    { label: 'EV charger (W)', name: 'evseW', type: 'number', value: v.evseW, min: 0, step: 'any', hint: '48 A × 240 V = 11,520 W' },
    { label: 'EV energy management (EVEMS)', name: 'evems', type: 'checkbox', value: v.evems },
    { label: 'EVEMS limit (W)', name: 'evemsW', type: 'number', value: v.evemsW, min: 0, step: 'any' },
    { label: 'Dryer (W)', name: 'dryerW', type: 'number', value: v.dryerW, min: 0, step: 'any' },
    { label: 'Water heater, tank (W)', name: 'whW', type: 'number', value: v.whW, min: 0, step: 'any' },
    { label: 'Dishwasher (W)', name: 'dwW', type: 'number', value: v.dwW, min: 0, step: 'any' },
    { label: 'Other load (W)', name: 'other1', type: 'number', value: v.other1, min: 0, step: 'any' },
    { label: 'Other load (W)', name: 'other2', type: 'number', value: v.other2, min: 0, step: 'any' },
  ], (x) => {
    const areaM2 = CEC.livingArea({ groundM2: x.ground, aboveM2: x.above, basementM2: x.basementTall ? x.basement : 0 }, { province });
    const r = CEC.singleDwelling({
      areaM2, areaNoBasementM2: (x.ground || 0) + (x.above || 0), heatW: n(x.heatW), centralHeat: x.centralHeat, acW: n(x.acW), interlocked: x.interlocked,
      rangeW: n(x.rangeW), tanklessW: [n(x.tanklessW)], evseW: [n(x.evseW)], evems: x.evems, evemsW: n(x.evemsW),
      otherW: [n(x.dryerW), n(x.whW), n(x.dwW), n(x.other1), n(x.other2)], volts: 240,
    }, { province });
    const cu = CEC.minConductorForAmps(r.service, 'cu', 75), al = CEC.minConductorForAmps(r.service, 'al', 75);
    const t39 = CEC.table39(r.service, { province });
    return [
      result({
        label: 'Single dwelling, Rule 8-200', value: ui.fmtNum(Math.ceil(r.amps)), unit: 'A @ 240 V', tone: 'pass', badge: `${r.service} A service`,
        sub: `${ui.fmtNum(Math.round(r.totalW))} W calculated · living area ${imperial() ? `${ui.fmtNum(areaM2 / FT2)} ft²` : `${ui.fmtNum(areaM2, 1)} m²`} (Rule 8-110)`,
        children: h('table', { class: 'calc-lines' }, h('tbody', null, r.lines.map((l) => h('tr', { class: 'demand' },
          h('td', null, l.label, h('span', { class: 'muted' }, ` · ${l.rule}`)), h('td', { class: 'right num' }, ui.fmtNum(Math.round(l.w))))))),
      }),
      h('div', { class: 'calc-minis' },
        mini('Minimum service', r.minimumRule),
        mini(`Conductors for ${r.service} A at 75 °C (Tables 2, 4)`, `${cu ? CEC.sizeLabel(cu) + ' Cu' : '—'} / ${al ? CEC.sizeLabel(al) + ' Al' : '—'}`),
        t39 ? mini(`${province} Table 39, 90 °C conductors`, `${CEC.sizeLabel(t39.cu)} Cu (to ${t39.maxCu} A) / ${CEC.sizeLabel(t39.al)} Al (to ${t39.maxAl} A)`) : null),
      refs('Rules 8-200, 8-110, 8-106', 'Rule 62-118 for heating', t39 ? 'Ontario Rule 4-004(26) and Table 39' : 'Conductors from Tables 2 and 4 (Table 39 was deleted in 2021 outside Ontario)', 'not a continuous load (8-200(3))'),
    ];
  }, { onChange: (vals, e) => { if (e?.target?.name === 'mode') { rerender(); return 'rerender'; } } });
}

function cecApartment(rerender, D) {
  return liveCalc('load', D, (v) => [
    { label: 'Building', name: 'mode', type: 'select', value: v.mode, options: [{ value: 'single', label: 'Single dwelling (Rule 8-200)' }, { value: 'apartment', label: 'Apartment building (Rule 8-202)' }], span: true },
    { label: 'Dwelling units', name: 'units', type: 'number', value: v.units, min: 1, step: 1 },
    { label: 'Living area per unit', name: 'unitArea', qty: 'area', value: v.unitArea },
    { label: 'Space heating per unit (W)', name: 'unitHeatW', type: 'number', value: v.unitHeatW, min: 0, step: 'any' },
    { label: 'A/C per unit (W)', name: 'unitAcW', type: 'number', value: v.unitAcW, min: 0, step: 'any' },
    { label: 'Range per unit (W)', name: 'unitRangeW', type: 'number', value: v.unitRangeW, min: 0, step: 'any' },
    { label: 'Other load over 1500 W per unit (W)', name: 'unitOtherW', type: 'number', value: v.unitOtherW, min: 0, step: 'any' },
    { label: 'EV charger per unit (W)', name: 'unitEvW', type: 'number', value: v.unitEvW, min: 0, step: 'any' },
    { label: 'Common-area loads (W)', name: 'commonW', type: 'number', value: v.commonW, min: 0, step: 'any', hint: 'Corridors, laundry, parkade, pumps' },
    { label: 'Service voltage', name: 'aptVolts', type: 'number', value: v.aptVolts, min: 1, step: 'any' },
    { label: 'Phase', name: 'aptPhase', type: 'select', value: v.aptPhase, options: PHASES },
  ], (x) => {
    const unit = { areaM2: x.unitArea || 0, heatW: n(x.unitHeatW), acW: n(x.unitAcW), rangeW: n(x.unitRangeW), otherW: [n(x.unitOtherW)], evseW: [n(x.unitEvW)] };
    const r = CEC.apartmentService({ units: Array.from({ length: Math.max(1, n(x.units)) }, () => unit), commonW: n(x.commonW), volts: n(x.aptVolts) || 208, phase: Number(x.aptPhase) }, { province });
    return [
      result({
        label: 'Apartment service, Rule 8-202', value: ui.fmtNum(Math.ceil(r.amps)), unit: `A @ ${n(x.aptVolts) || 208} V ${Number(x.aptPhase) === 3 ? '3φ' : '1φ'}`, tone: 'warn', badge: r.service ? `${r.service} A service` : 'Over 800 A',
        sub: `${ui.fmtNum(Math.round(r.totalW))} W calculated`,
        children: h('table', { class: 'calc-lines' }, h('tbody', null, r.lines.map((l) => h('tr', { class: 'demand' },
          h('td', null, l.label, h('span', { class: 'muted' }, ` · ${l.rule}`)), h('td', { class: 'right num' }, ui.fmtNum(Math.round(l.w))))))),
      }),
      h('p', { class: 'calc-note muted' }, 'Being checked against the 2024 code: the 25% band for the next 15 units, 10% for the rest, how Section 62 applies across units, and the 2024 EV demand factors for multi-unit buildings (docs/code/verify.md). Use for estimating only.'),
      refs('Rule 8-202', 'Section 62 for heating'),
    ];
  }, { onChange: (vals, e) => { if (e?.target?.name === 'mode') { rerender(); return 'rerender'; } } });
}

function cecMotor(rerender) {
  const D = { phase: '3', hp: '10', volts: '575', nameplate: 0, sf: true };
  const v0 = saved('motor', D);
  const t = v0.phase === '1' ? CEC.TABLE_45 : CEC.TABLE_44;
  const hp = t.hp[v0.hp] ? v0.hp : Object.keys(t.hp)[0];
  const volts = t.volts.includes(Number(v0.volts)) ? v0.volts : String(t.volts[t.volts.length - 1]);
  return liveCalc('motor', { ...D, hp, volts }, (v) => [
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'Horsepower', name: 'hp', type: 'select', value: hp, options: Object.keys(t.hp).map((k) => ({ value: k, label: k + ' hp' })) },
    { label: 'Voltage', name: 'volts', type: 'select', value: volts, options: t.volts.map((y) => ({ value: String(y), label: y + ' V' })) },
    { label: 'Nameplate current (A, optional)', name: 'nameplate', type: 'number', value: v.nameplate, min: 0, step: 'any', hint: 'For the overload setting' },
    { label: 'Service factor 1.15+ or rise ≤ 40 °C', name: 'sf', type: 'checkbox', value: v.sf },
  ], (x) => {
    const r = CEC.motor({ hp: x.hp, volts: Number(x.volts), phase: Number(x.phase), nameplateA: n(x.nameplate), serviceFactor115: x.sf });
    if (!r) throw new Error('Pick a horsepower and voltage from the table.');
    return [
      result({ label: `Full-load current, ${r.table}`, value: num(r.flc, 1), unit: 'A', tone: 'pass', badge: `${x.hp} hp · ${x.volts} V`,
        sub: 'Size conductors and branch protection from the table current, not the nameplate.' }),
      h('div', { class: 'calc-minis' },
        mini('Conductors 125% FLC (Rule 28-106)', `${num(r.conductorAmps, 1)} A → ${r.conductor ? CEC.sizeLabel(r.conductor) + ' Cu' : '—'}`),
        mini(`Inverse-time breaker, max ${CEC.TABLE_29.inverseTimeBreaker}%`, `${num(r.breakerMax, 1)} A → ${r.breaker} A`),
        mini(`Time-delay fuse, max ${CEC.TABLE_29.timeDelayFuse}%`, `${num(r.tdFuseMax, 1)} A → ${r.tdFuse} A`),
        mini(`Non-time-delay fuse, max ${CEC.TABLE_29.nonTimeDelayFuse}%`, `${num(r.ntdFuseMax, 1)} A → ${r.ntdFuse} A`),
        mini(`Overload ${r.overloadPct}% (Rule 28-306)`, `${num(r.overloadMax, 1)} A max${n(x.nameplate) ? '' : ' (table FLC; enter the nameplate)'}`)),
      h('p', { class: 'calc-note muted' }, `Protection is the largest standard rating not above the Table 29 value (no next size up in Rule 28-200), 15 A minimum. If the motor won't start: breaker up to ${num(r.wontStart.inverseTimeBreaker, 1)} A, time-delay fuse up to ${num(r.wontStart.timeDelayFuse, 1)} A.`),
      refs(r.table, 'Rule 28-106', 'Table 29, Rule 28-200', 'Rule 28-306', 'conductors at 75 °C, Table 2'),
    ];
  }, { onChange: (vals, e) => { if (e?.target?.name === 'phase') { rerender(); return 'rerender'; } } });
}

// ===========================================================================
// NEC 2023 (kept for companies that choose it). Lengths and areas still follow
// the user's units and are converted to feet for the NEC functions.
// ===========================================================================

const SIZE_OPTS = NEC.SIZES.map((s) => ({ value: s, label: NEC.sizeLabel(s) }));
const SMALL_SIZES = ['14', '12', '10', '8', '6'];
const toFt = (m) => (m || 0) / M_PER_FT;

function necVoltageDrop() {
  const D = { volts: 240, phase: '1', amps: 20, length: 30.48, size: '12', material: 'cu', maxPct: 3 };
  return liveCalc('vd', D, (v) => [
    { label: 'System voltage', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 1 },
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'Load (A)', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'One-way length', name: 'length', qty: 'length', value: v.length },
    { label: 'Conductor', name: 'size', type: 'select', value: v.size, options: SIZE_OPTS },
    { label: 'Material', name: 'material', type: 'select', value: v.material, options: MATERIALS },
    { label: 'Max drop (%)', name: 'maxPct', type: 'number', value: v.maxPct, step: 'any', min: 0, hint: '3% branch, 5% feeder + branch (210.19 IN No. 2)' },
  ], (x) => {
    if (x.material === 'al' && x.size === '14') throw new Error('14 AWG aluminum is not listed in Table 310.16. Pick 12 AWG or larger.');
    if (!(n(x.volts) > 0)) throw new Error('Enter a system voltage.');
    const lengthFt = toFt(x.length);
    const r = NEC.voltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), lengthFt, size: x.size, material: x.material });
    const max = n(x.maxPct) || 3;
    const ok = r.percent <= max;
    const minSize = NEC.minSizeForVoltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), lengthFt, material: x.material, maxPct: max });
    const maxLen = n(x.amps) > 0 ? NEC.maxLengthForVoltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), size: x.size, material: x.material, maxPct: max }) : null;
    const formula = Number(x.phase) === 3 ? '1.732 × K × I × L ÷ CM' : '2 × K × I × L ÷ CM';
    return [
      result({
        label: 'Voltage drop', value: num(r.percent, 2), unit: '%', tone: ok ? 'pass' : 'fail', badge: ok ? `Within ${max}%` : `Over ${max}%`,
        sub: `${num(r.volts, 2)} V drop · ${num(r.endVolts, 1)} V at the load`,
        lines: [
          `${formula} = ${Number(x.phase) === 3 ? '1.732' : '2'} × ${NEC.K[x.material]} × ${n(x.amps)} × ${num(lengthFt, 1)} ft ÷ ${ui.fmtNum(r.cm)} = ${num(r.volts, 2)} V`,
          `K = ${NEC.K[x.material]} Ω·cmil/ft (${x.material === 'cu' ? 'copper' : 'aluminum'}); CM from Chapter 9 Table 8.`,
        ],
      }),
      h('div', { class: 'calc-minis' },
        mini('Table 8 method', `${num(r.tableVolts, 2)} V · ${num(r.tablePercent, 2)}%`),
        mini(`Smallest within ${max}%`, minSize ? NEC.sizeLabel(minSize) : 'over 500 kcmil'),
        mini(`Max length, ${NEC.sizeLabel(x.size)}`, maxLen != null ? len(maxLen * M_PER_FT) : '—')),
    ];
  });
}

function necWire() {
  const D = { amps: 40, continuous: true, material: 'cu', tempRating: '75', insulationRating: '90', ambientC: 30, ccc: 3, volts: 240, phase: '1', length: 0, maxVdPct: 3 };
  return liveCalc('wire', D, (v) => [
    { label: 'Load (A)', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'Continuous load (3 h+)', name: 'continuous', type: 'checkbox', value: v.continuous },
    { label: 'Material', name: 'material', type: 'select', value: v.material, options: MATERIALS },
    { label: 'Termination rating', name: 'tempRating', type: 'select', value: v.tempRating, options: [{ value: '60', label: '60 °C (≤100 A, unmarked)' }, { value: '75', label: '75 °C' }], hint: '110.14(C)' },
    { label: 'Insulation rating', name: 'insulationRating', type: 'select', value: v.insulationRating, options: [{ value: '60', label: '60 °C (NM-B uses 60 °C ampacity)' }, { value: '75', label: '75 °C (THW, XHHW)' }, { value: '90', label: '90 °C (THHN/THWN-2)' }] },
    { label: 'Ambient (°C)', name: 'ambientC', type: 'number', value: v.ambientC, step: 'any' },
    { label: 'Current-carrying conductors', name: 'ccc', type: 'number', value: v.ccc, min: 1, step: 1 },
    { label: 'Voltage (for drop)', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 0 },
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'One-way length (0 = skip)', name: 'length', qty: 'length', value: v.length },
    { label: 'Max drop (%)', name: 'maxVdPct', type: 'number', value: v.maxVdPct, step: 'any', min: 0 },
  ], (x) => {
    const term = Number(x.tempRating), ins = Math.max(Number(x.insulationRating), 0);
    const r = NEC.sizeConductor({
      amps: n(x.amps), continuous: x.continuous, material: x.material, tempRating: Math.min(term, ins), insulationRating: ins,
      ambientC: x.ambientC == null ? 30 : n(x.ambientC), ccc: n(x.ccc) || 3, volts: n(x.volts), phase: Number(x.phase), lengthFt: Math.round(toFt(x.length) * 10) / 10, maxVdPct: n(x.maxVdPct) || 3,
    });
    if (!r.size) return result({ label: 'No single conductor works', tone: 'fail', badge: 'Check', lines: [r.error] });
    return [
      result({
        label: 'Conductor', value: r.label, unit: x.material === 'cu' ? 'Cu' : 'Al', tone: 'pass', badge: `Breaker ${r.ocpd} A`,
        sub: `Governed by ${r.governedBy}${r.vd ? ` · drop ${num(r.vd.percent, 2)}%` : ''}`,
        lines: r.reasons,
      }),
      r.rejected?.length ? h('div', { class: 'card flat calc-rejected' },
        h('div', { class: 'calc-label' }, 'Why not smaller'),
        h('ul', { class: 'calc-why' }, r.rejected.slice(-3).map((t) => h('li', null, h('strong', null, NEC.sizeLabel(t.size) + ': '), t.why.join('; '))))) : null,
    ];
  });
}

function necConduit() {
  const D = { conduitType: 'EMT', tradeSize: '3/4', s1: '12', i1: 'THHN', c1: 4, s2: '12', i2: 'THHN', c2: 1, s3: '10', i3: 'THHN', c3: 0 };
  const ins = Object.keys(NEC.TABLE_5).map((k) => ({ value: k, label: k }));
  return liveCalc('conduit', D, (v) => {
    const row = (k) => [
      { label: `Group ${k}: size`, name: 's' + k, type: 'select', value: v['s' + k], options: SIZE_OPTS },
      { label: 'Insulation', name: 'i' + k, type: 'select', value: v['i' + k], options: ins },
      { label: 'Count', name: 'c' + k, type: 'number', value: v['c' + k], min: 0, step: 1 },
    ];
    return [
      { label: 'Conduit', name: 'conduitType', type: 'select', value: v.conduitType, options: Object.keys(NEC.TABLE_4) },
      { label: 'Trade size', name: 'tradeSize', type: 'select', value: v.tradeSize, options: NEC.TRADE_SIZES.map((t) => ({ value: t, label: t + '"' })) },
      ...row(1), ...row(2), ...row(3),
    ];
  }, (x) => {
    const wires = [1, 2, 3].map((k) => ({ size: x['s' + k], insulation: x['i' + k], count: n(x['c' + k]) })).filter((w) => w.count > 0);
    const r = NEC.conduitFill({ conduitType: x.conduitType, tradeSize: x.tradeSize, wires });
    const min = wires.length ? NEC.minConduit({ conduitType: x.conduitType, wires }) : null;
    const first = wires[0];
    const pct = Math.min(100, (r.fillPct / r.allowedPct) * 100);
    return [
      result({
        label: `Fill, ${x.tradeSize}" ${x.conduitType}`, value: num(r.fillPct, 1), unit: '%', tone: r.pass ? 'pass' : 'fail', badge: r.pass ? `≤ ${r.allowedPct}% allowed` : `Over ${r.allowedPct}%`,
        sub: `${num(r.wireArea, 4)} in² of ${num(r.allowedArea, 4)} in² allowed (${num(r.conduitArea, 3)} in² total)`,
        lines: [
          `${r.count} conductor${r.count === 1 ? '' : 's'}: ${r.count <= 1 ? '53%' : r.count === 2 ? '31%' : '40%'} limit (Chapter 9, Table 1).`,
          'Areas from Chapter 9 Table 4 (conduit) and Table 5 (conductors).',
        ],
        children: h('div', { class: 'progress calc-bar', role: 'img', 'aria-label': `${num(r.fillPct, 1)}% of ${r.allowedPct}%` }, h('i', { style: { width: pct + '%', background: r.pass ? '' : 'var(--danger)' } })),
      }),
      h('div', { class: 'calc-minis' },
        mini(`Smallest ${x.conduitType}`, min ? `${min.tradeSize}" (${num(min.fillPct, 1)}%)` : wires.length ? 'over 4"' : '—'),
        first ? mini(`Max ${NEC.sizeLabel(first.size)} ${first.insulation} in ${x.tradeSize}"`, String(NEC.maxConductors({ conduitType: x.conduitType, tradeSize: x.tradeSize, size: first.size, insulation: first.insulation }))) : null),
    ];
  });
}

function necBox() {
  const D = { box: '5', custom: 0, extra: 0, s1: '12', c1: 4, s2: '14', c2: 0, devices: 1, deviceSize: '12', clamps: true, fittings: 0, egc: 2, egcSize: '12' };
  const boxes = [...NEC.STANDARD_BOXES.map((b, i) => ({ value: String(i), label: `${b.name} (${b.volume} in³)` })), { value: 'custom', label: 'Other (enter volume)' }];
  const ss = SMALL_SIZES.map((s) => ({ value: s, label: `${s} AWG` }));
  return liveCalc('box', D, (v) => [
    { label: 'Box', name: 'box', type: 'select', value: v.box, options: boxes, span: true },
    { label: 'Box volume if other (in³)', name: 'custom', type: 'number', value: v.custom, step: 'any', min: 0 },
    { label: 'Plaster ring / extension (in³)', name: 'extra', type: 'number', value: v.extra, step: 'any', min: 0 },
    { label: 'Conductors, size', name: 's1', type: 'select', value: v.s1, options: ss },
    { label: 'Count', name: 'c1', type: 'number', value: v.c1, min: 0, step: 1, hint: 'Each in and out; unbroken loop ≥12" counts 2' },
    { label: 'More conductors, size', name: 's2', type: 'select', value: v.s2, options: ss },
    { label: 'Count', name: 'c2', type: 'number', value: v.c2, min: 0, step: 1 },
    { label: 'Devices (yokes)', name: 'devices', type: 'number', value: v.devices, min: 0, step: 1 },
    { label: 'Largest conductor on device', name: 'deviceSize', type: 'select', value: v.deviceSize, options: ss },
    { label: 'Internal cable clamps', name: 'clamps', type: 'checkbox', value: v.clamps },
    { label: 'Support fittings (studs, hickeys)', name: 'fittings', type: 'number', value: v.fittings, min: 0, step: 1 },
    { label: 'Grounding conductors', name: 'egc', type: 'number', value: v.egc, min: 0, step: 1 },
    { label: 'Largest ground', name: 'egcSize', type: 'select', value: v.egcSize, options: ss },
  ], (x) => {
    const boxVolume = x.box === 'custom' ? n(x.custom) : NEC.STANDARD_BOXES[Number(x.box)]?.volume || 0;
    const r = NEC.boxFill({
      conductors: [{ size: x.s1, count: n(x.c1) }, { size: x.s2, count: n(x.c2) }],
      clamps: x.clamps, supportFittings: n(x.fittings),
      devices: Array.from({ length: n(x.devices) }, () => ({ size: x.deviceSize })),
      grounds: [{ size: x.egcSize, count: n(x.egc) }], boxVolume, extraVolume: n(x.extra),
    });
    return [
      result({
        label: 'Box fill', value: num(r.required, 2), unit: `of ${num(r.available, 2)} in³`,
        tone: r.pass == null ? 'warn' : r.pass ? 'pass' : 'fail', badge: r.pass == null ? 'Enter a box volume' : r.pass ? 'Fits' : 'Too full',
        sub: r.pass === false ? `Needs ${num(r.required - r.available, 2)} in³ more: a deeper box or an extension ring.` : null,
        lines: ['NEC 314.16(B): volumes per Table 314.16(B)(1); yokes count 2; clamps 1; up to 4 grounds count 1, each extra ¼.'],
      }),
      ui.table({
        columns: [
          { key: 'label', label: 'Item' },
          { key: 'count', label: 'Allowances', align: 'right', render: (i) => num(i.count, 2) },
          { key: 'each', label: 'in³ each', align: 'right', render: (i) => num(i.each, 2) },
          { key: 'volume', label: 'in³', align: 'right', render: (i) => num(i.volume, 2) },
        ],
        rows: r.items,
      }),
    ];
  });
}

function necLoad() {
  const D = { area: 2000 * FT2, sa: 2, laundry: 1, rangeKW: 12, dryerVA: 5000, wh: 4500, dw: 1200, disp: 900, micro: 0, other1: 0, other2: 0, heatVA: 0, acVA: 5000, ev1: 0, ev2: 0, motorVA: 0 };
  return liveCalc('load', D, (v) => [
    { label: 'Living area', name: 'area', qty: 'area', value: v.area },
    { label: 'Small appliance circuits', name: 'sa', type: 'number', value: v.sa, min: 2, step: 1 },
    { label: 'Laundry circuits', name: 'laundry', type: 'number', value: v.laundry, min: 1, step: 1 },
    { label: 'Range (kW nameplate)', name: 'rangeKW', type: 'number', value: v.rangeKW, min: 0, step: 'any' },
    { label: 'Dryer (VA, 0 = gas)', name: 'dryerVA', type: 'number', value: v.dryerVA, min: 0, step: 'any' },
    { label: 'Water heater (VA)', name: 'wh', type: 'number', value: v.wh, min: 0, step: 'any' },
    { label: 'Dishwasher (VA)', name: 'dw', type: 'number', value: v.dw, min: 0, step: 'any' },
    { label: 'Disposal (VA)', name: 'disp', type: 'number', value: v.disp, min: 0, step: 'any' },
    { label: 'Microwave / hood (VA)', name: 'micro', type: 'number', value: v.micro, min: 0, step: 'any' },
    { label: 'Other fixed appliance (VA)', name: 'other1', type: 'number', value: v.other1, min: 0, step: 'any' },
    { label: 'Other fixed appliance (VA)', name: 'other2', type: 'number', value: v.other2, min: 0, step: 'any' },
    { label: 'Electric heat (VA)', name: 'heatVA', type: 'number', value: v.heatVA, min: 0, step: 'any' },
    { label: 'Air conditioning (VA)', name: 'acVA', type: 'number', value: v.acVA, min: 0, step: 'any' },
    { label: 'EV charger 1 (VA)', name: 'ev1', type: 'number', value: v.ev1, min: 0, step: 'any', hint: '48 A charger = 11,520 VA' },
    { label: 'EV charger 2 (VA)', name: 'ev2', type: 'number', value: v.ev2, min: 0, step: 'any' },
    { label: 'Largest motor (VA, optional)', name: 'motorVA', type: 'number', value: v.motorVA, min: 0, step: 'any', hint: 'Adds 25% (220.50)' },
  ], (x) => {
    const appliances = [['Water heater', x.wh], ['Dishwasher', x.dw], ['Disposal', x.disp], ['Microwave/hood', x.micro], ['Other', x.other1], ['Other', x.other2]]
      .map(([name, va]) => ({ name, va: n(va) }));
    const input = {
      sqft: Math.round((x.area || 0) / FT2), smallApplianceCircuits: n(x.sa) || 2, laundryCircuits: n(x.laundry) || 1, appliances,
      dryerVA: n(x.dryerVA), rangeKW: n(x.rangeKW), heatVA: n(x.heatVA), acVA: n(x.acVA), evVA: [n(x.ev1), n(x.ev2)], largestMotorVA: n(x.motorVA),
    };
    const std = NEC.dwellingLoadCalc(input);
    const opt = NEC.dwellingLoadOptional(input);
    const card = (r, title) => result({
      label: title, value: ui.fmtNum(Math.ceil(r.amps)), unit: 'A @ 240 V', tone: 'pass', badge: `${r.service} A service`,
      sub: `${ui.fmtNum(Math.round(r.totalVA))} VA calculated load`,
      children: h('table', { class: 'calc-lines' }, h('tbody', null, r.lines.map((l) => h('tr', { class: l.demand ? 'demand' : null },
        h('td', null, l.label, h('span', { class: 'muted' }, ` · ${l.rule}`)), h('td', { class: 'right num' }, ui.fmtNum(Math.round(l.va))))))),
    });
    return [
      card(std, 'Standard method (Art. 220 Part III)'),
      card(opt, 'Optional method (220.82)'),
      h('p', { class: 'calc-note muted' }, 'NEC works in square feet: the area is converted. Service size is the next standard rating at or above the calculated load, 100 A minimum (230.79(C)).'),
    ];
  });
}

function necMotor(rerender) {
  const D = { phase: '3', hp: '10', volts: '460' };
  const v0 = saved('motor', D);
  const t = v0.phase === '1' ? NEC.TABLE_430_248 : NEC.TABLE_430_250;
  const hp = t.hp[v0.hp] ? v0.hp : Object.keys(t.hp)[0];
  const volts = t.volts.includes(Number(v0.volts)) ? v0.volts : String(t.volts[t.volts.length - 1]);
  return liveCalc('motor', { ...D, hp, volts }, (v) => [
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'Horsepower', name: 'hp', type: 'select', value: hp, options: Object.keys(t.hp).map((k) => ({ value: k, label: k + ' hp' })) },
    { label: 'Voltage', name: 'volts', type: 'select', value: volts, options: t.volts.map((y) => ({ value: String(y), label: y + ' V' })) },
  ], (x) => {
    const r = NEC.motorFLC({ hp: x.hp, volts: Number(x.volts), phase: Number(x.phase) });
    if (!r) throw new Error('Pick a horsepower and voltage from the table.');
    return [
      result({
        label: `Full-load current, Table ${r.table}`, value: num(r.flc, 1), unit: 'A', tone: 'pass', badge: `${x.hp} hp · ${x.volts} V`,
        sub: 'Use the table FLC, not the nameplate, to size conductors and short-circuit protection (430.6(A)(1)).',
      }),
      h('div', { class: 'calc-minis' },
        mini('Conductor 125% FLC (430.22)', `${num(r.conductorAmps, 1)} A → ${r.conductor ? NEC.sizeLabel(r.conductor) + ' Cu' : '—'}`),
        mini('Inverse-time breaker, max 250%', `${num(r.breakerMax, 1)} A → ${r.breaker} A`),
        mini('Dual-element fuse, max 175%', `${num(r.fuseMax, 1)} A → ${r.fuse} A`)),
      h('p', { class: 'calc-note muted' }, 'Breaker and fuse are Table 430.52 maximums with the next standard size up (430.52(C)(1) Ex. 1). Overload protection is sized from the nameplate (430.32).'),
    ];
  }, { onChange: (vals, e) => { if (e?.target?.name === 'phase') { rerender(); return 'rerender'; } } });
}

// ===========================================================================
// Code-neutral
// ===========================================================================

function ohmsTab() {
  // Use whichever two values were typed most recently.
  let order = ['v', 'i'];
  const tracker = (vals, e) => {
    const name = e?.target?.name;
    if (name && ['v', 'i', 'r', 'p'].includes(name)) {
      order = order.filter((k) => k !== name);
      if (vals[name] != null) order.push(name);
    }
  };
  return liveCalc('ohms', { v: 120, i: 10, r: '', p: '' }, (v) => [
    { label: 'Voltage V (volts)', name: 'v', type: 'number', value: v.v, step: 'any' },
    { label: 'Current I (amps)', name: 'i', type: 'number', value: v.i, step: 'any' },
    { label: 'Resistance R (ohms)', name: 'r', type: 'number', value: v.r, step: 'any' },
    { label: 'Power P (watts)', name: 'p', type: 'number', value: v.p, step: 'any' },
  ], (x) => {
    const filled = ['v', 'i', 'r', 'p'].filter((k) => x[k] != null);
    const use = [...order.filter((k) => x[k] != null), ...filled].filter((k, i, a) => a.indexOf(k) === i).slice(-2);
    if (use.length < 2) return result({ label: 'Enter any two values', tone: 'warn', lines: ['Fill in two of V, I, R or P. The newest two you typed are used.'] });
    const r = NEC.ohmsLaw(Object.fromEntries(use.map((k) => [k, x[k]])));
    return [
      result({ label: `From ${use.map((k) => k.toUpperCase()).join(' and ')}`, tone: 'pass', lines: ['V = I × R · P = V × I = I² × R = V² ÷ R (DC or resistive AC loads).'] }),
      h('div', { class: 'calc-minis four' },
        mini('Voltage', `${num(r.v, 3)} V`), mini('Current', `${num(r.i, 3)} A`),
        mini('Resistance', `${num(r.r, 3)} Ω`), mini('Power', `${num(r.p, 1)} W`)),
    ];
  }, { onChange: tracker });
}

function threePhaseTab() {
  const cec = book === 'CEC-2024';
  const D = { mode: 'kva', volts: cec ? 600 : 208, kva: 30, kw: 0, pf: 0.9, amps: 0, continuous: true };
  return liveCalc('3ph', D, (v) => [
    { label: 'Line-to-line voltage', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 1, hint: cec ? '208 or 600 V (CSA C235)' : '208 or 480 V' },
    { label: 'Calculate from', name: 'mode', type: 'select', value: v.mode, options: [{ value: 'kva', label: 'kVA' }, { value: 'kw', label: 'kW and power factor' }, { value: 'amps', label: 'Amps' }] },
    { label: 'kVA', name: 'kva', type: 'number', value: v.kva, step: 'any', min: 0 },
    { label: 'kW', name: 'kw', type: 'number', value: v.kw, step: 'any', min: 0 },
    { label: 'Power factor', name: 'pf', type: 'number', value: v.pf, step: 'any', min: 0.1, max: 1 },
    { label: 'Amps', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'Continuous load', name: 'continuous', type: 'checkbox', value: v.continuous },
  ], (x) => {
    if (!(n(x.volts) > 0)) throw new Error('Enter a voltage.');
    const r = x.mode === 'amps' ? NEC.threePhase({ volts: n(x.volts), amps: n(x.amps), pf: n(x.pf) || 1 })
      : x.mode === 'kw' ? NEC.threePhase({ volts: n(x.volts), kw: n(x.kw), pf: n(x.pf) || 1 })
        : NEC.threePhase({ volts: n(x.volts), kva: n(x.kva), pf: n(x.pf) || 1 });
    const breaker = cec ? CEC.nextStandardRating(r.amps / (x.continuous ? 0.8 : 1)) : NEC.suggestBreaker(r.amps, x.continuous);
    return [
      result({
        label: x.mode === 'amps' ? 'Apparent power' : 'Line current', value: x.mode === 'amps' ? num(r.kva, 2) : num(r.amps, 1), unit: x.mode === 'amps' ? 'kVA' : 'A',
        tone: 'pass', badge: breaker ? `Breaker ${breaker} A` : null,
        lines: ['I = VA ÷ (√3 × V). kVA = kW ÷ PF.', cec
          ? (x.continuous ? 'Continuous load at 80% of the breaker (Rule 8-104(6)), next standard rating.' : 'Breaker at the next standard rating (Rule 14-104, Table 13).')
          : (x.continuous ? 'Breaker at 125% for a continuous load, next standard size (240.6(A)).' : 'Breaker at the next standard size (240.6(A)).')],
      }),
      h('div', { class: 'calc-minis' }, mini('Amps', `${num(r.amps, 2)} A`), mini('kVA', num(r.kva, 2)), mini('kW', num(r.kw, 2)),
        mini('Same load single phase', `${num((r.kva * 1000) / n(x.volts), 1)} A @ ${n(x.volts)} V`)),
    ];
  });
}

const VIEWS = {
  'CEC-2024': { vd: cecVoltageDrop, wire: cecWire, conduit: cecConduit, box: cecBox, load: cecLoad, motor: cecMotor, ohms: ohmsTab, '3ph': threePhaseTab },
  'NEC-2023': { vd: necVoltageDrop, wire: necWire, conduit: necConduit, box: necBox, load: necLoad, motor: necMotor, ohms: ohmsTab, '3ph': threePhaseTab },
};

export default {
  id: 'calcs',
  title: 'Calculators',
  icon: 'calculator',
  group: 'field',
  perm: 'calcs',
  render(root, ctx) {
    ui = ctx.ui; h = ui.h;
    const s = ctx.store.settings();
    book = CEC.codeBookOf(s);
    province = s.company?.province || null;
    units = getUnits(s.units);
    const views = VIEWS[book];
    const tab = views[ctx.params[0]] ? ctx.params[0] : 'vd';
    const body = h('div', { class: 'calc-body' });
    const draw = () => {
      ui.clear(body);
      body.append(views[tab](draw));
    };
    const cec = book === 'CEC-2024';
    const amend = cec && province ? CEC.amendmentsFor(province) : [];
    root.append(ui.page(
      { title: 'Calculators', subtitle: `${cec ? 'Canadian Electrical Code 2024 (CSA C22.1:24)' : 'NEC 2023'} · lengths in ${imperial() ? 'feet and inches' : 'metres'}. Results update as you type.` },
      h('div', { class: 'calc-tabs' }, ui.tabs(TABS, tab, (id) => ctx.nav('#/calcs/' + id))),
      h('p', { class: 'calc-disclaimer' }, ui.icon('info', 16),
        cec
          ? `Estimating aid citing CEC 2024 rules and tables${province ? ` for ${province}${amend.length ? `, with ${amend.length} provincial amendment${amend.length > 1 ? 's' : ''} noted` : ''}` : ''}. Values marked for checking are listed in the docs. Confirm with the inspection authority before you install.`
          : 'Estimating aid based on NEC 2023. Check local amendments and confirm with the AHJ before you install.',
        ' ', h('a', { href: '#/settings' }, 'Change code book or units')),
      body,
    ));
    draw();
  },
};
