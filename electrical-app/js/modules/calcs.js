// Calculators (S25): voltage drop, wire size, conduit fill, box fill, dwelling
// load, Ohm's law, motor FLC, three-phase. Every result updates as you type.
import * as E from '../lib/electrical.js';

const TABS = [
  { id: 'vd', label: 'Voltage drop' },
  { id: 'wire', label: 'Wire size' },
  { id: 'conduit', label: 'Conduit fill' },
  { id: 'box', label: 'Box fill' },
  { id: 'load', label: 'Load calc' },
  { id: 'ohms', label: "Ohm's law" },
  { id: 'motor', label: 'Motor FLC' },
  { id: '3ph', label: '3-phase' },
];

const SIZE_OPTS = E.SIZES.map((s) => ({ value: s, label: E.sizeLabel(s) }));
const SMALL_SIZES = ['14', '12', '10', '8', '6'];
const MATERIALS = [{ value: 'cu', label: 'Copper' }, { value: 'al', label: 'Aluminum' }];
const PHASES = [{ value: '1', label: 'Single phase' }, { value: '3', label: 'Three phase' }];

let ui, h;

function saved(tab, defaults) {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('kc.calc.' + tab) || '{}') }; } catch { return { ...defaults }; }
}
function remember(tab, values) {
  try { localStorage.setItem('kc.calc.' + tab, JSON.stringify(values)); } catch { /* storage blocked */ }
}

const num = (n, d = 2) => (Number.isFinite(n) ? ui.fmtNum(n, d) : '—');

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

/**
 * A live calculator: fields on the left, results on the right. `compute(values)`
 * returns result nodes. Inputs are remembered per tab on this device.
 */
function liveCalc(tab, fields, compute, { onChange } = {}) {
  const out = h('div', { class: 'calc-out', 'aria-live': 'polite' });
  const form = h('form', { class: 'card calc-form', onSubmit: (e) => e.preventDefault() }, ui.formGrid(fields));
  const update = (e) => {
    const v = ui.readForm(form);
    remember(tab, v);
    if (onChange && e && onChange(v, e) === 'rerender') return;
    ui.clear(out);
    try {
      const r = compute(v);
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

const n = (x) => (x == null || x === '' ? 0 : Number(x));

// ---------------------------------------------------------------------------

function voltageDropTab() {
  const v = saved('vd', { volts: 240, phase: '1', amps: 20, lengthFt: 100, size: '12', material: 'cu', maxPct: 3 });
  return liveCalc('vd', [
    { label: 'System voltage', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 1 },
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'Load (A)', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'One-way length (ft)', name: 'lengthFt', type: 'number', value: v.lengthFt, step: 'any', min: 0 },
    { label: 'Conductor', name: 'size', type: 'select', value: v.size, options: SIZE_OPTS },
    { label: 'Material', name: 'material', type: 'select', value: v.material, options: MATERIALS },
    { label: 'Max drop (%)', name: 'maxPct', type: 'number', value: v.maxPct, step: 'any', min: 0, hint: '3% branch, 5% feeder + branch (210.19 IN No. 2)' },
  ], (x) => {
    if (x.material === 'al' && x.size === '14') throw new Error('14 AWG aluminum is not listed in Table 310.16. Pick 12 AWG or larger.');
    if (!(n(x.volts) > 0)) throw new Error('Enter a system voltage.');
    const r = E.voltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), lengthFt: n(x.lengthFt), size: x.size, material: x.material });
    const max = n(x.maxPct) || 3;
    const ok = r.percent <= max;
    const minSize = E.minSizeForVoltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), lengthFt: n(x.lengthFt), material: x.material, maxPct: max });
    const maxLen = n(x.amps) > 0 ? E.maxLengthForVoltageDrop({ volts: n(x.volts), phase: Number(x.phase), amps: n(x.amps), size: x.size, material: x.material, maxPct: max }) : null;
    const formula = Number(x.phase) === 3 ? '1.732 × K × I × L ÷ CM' : '2 × K × I × L ÷ CM';
    return [
      result({
        label: 'Voltage drop', value: num(r.percent, 2), unit: '%', tone: ok ? 'pass' : 'fail', badge: ok ? `Within ${max}%` : `Over ${max}%`,
        sub: `${num(r.volts, 2)} V drop · ${num(r.endVolts, 1)} V at the load`,
        lines: [
          `${formula} = ${Number(x.phase) === 3 ? '1.732' : '2'} × ${E.K[x.material]} × ${n(x.amps)} × ${n(x.lengthFt)} ÷ ${ui.fmtNum(r.cm)} = ${num(r.volts, 2)} V`,
          `K = ${E.K[x.material]} Ω·cmil/ft (${x.material === 'cu' ? 'copper' : 'aluminum'}); CM from Chapter 9 Table 8.`,
        ],
      }),
      h('div', { class: 'calc-minis' },
        mini('Table 8 method', `${num(r.tableVolts, 2)} V · ${num(r.tablePercent, 2)}%`),
        mini(`Smallest within ${max}%`, minSize ? E.sizeLabel(minSize) : 'over 500 kcmil'),
        mini(`Max length, ${E.sizeLabel(x.size)}`, maxLen != null ? `${ui.fmtNum(maxLen)} ft` : '—')),
    ];
  });
}

function wireTab() {
  const v = saved('wire', { amps: 40, continuous: true, material: 'cu', tempRating: '75', insulationRating: '90', ambientC: 30, ccc: 3, volts: 240, phase: '1', lengthFt: 0, maxVdPct: 3 });
  return liveCalc('wire', [
    { label: 'Load (A)', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'Continuous load (3 h+)', name: 'continuous', type: 'checkbox', value: v.continuous },
    { label: 'Material', name: 'material', type: 'select', value: v.material, options: MATERIALS },
    { label: 'Termination rating', name: 'tempRating', type: 'select', value: v.tempRating, options: [{ value: '60', label: '60 °C (≤100 A, unmarked)' }, { value: '75', label: '75 °C' }], hint: '110.14(C)' },
    { label: 'Insulation rating', name: 'insulationRating', type: 'select', value: v.insulationRating, options: [{ value: '60', label: '60 °C (NM-B uses 60 °C ampacity)' }, { value: '75', label: '75 °C (THW, XHHW)' }, { value: '90', label: '90 °C (THHN/THWN-2)' }] },
    { label: 'Ambient (°C)', name: 'ambientC', type: 'number', value: v.ambientC, step: 'any' },
    { label: 'Current-carrying conductors', name: 'ccc', type: 'number', value: v.ccc, min: 1, step: 1 },
    { label: 'Voltage (for drop)', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 0 },
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'One-way length (ft, 0 = skip)', name: 'lengthFt', type: 'number', value: v.lengthFt, step: 'any', min: 0 },
    { label: 'Max drop (%)', name: 'maxVdPct', type: 'number', value: v.maxVdPct, step: 'any', min: 0 },
  ], (x) => {
    const term = Number(x.tempRating), ins = Math.max(Number(x.insulationRating), 0);
    const r = E.sizeConductor({
      amps: n(x.amps), continuous: x.continuous, material: x.material, tempRating: Math.min(term, ins), insulationRating: ins,
      ambientC: x.ambientC == null ? 30 : n(x.ambientC), ccc: n(x.ccc) || 3, volts: n(x.volts), phase: Number(x.phase), lengthFt: n(x.lengthFt), maxVdPct: n(x.maxVdPct) || 3,
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
        h('ul', { class: 'calc-why' }, r.rejected.slice(-3).map((t) => h('li', null, h('strong', null, E.sizeLabel(t.size) + ': '), t.why.join('; '))))) : null,
    ];
  });
}

function conduitTab() {
  const v = saved('conduit', { conduitType: 'EMT', tradeSize: '3/4', s1: '12', i1: 'THHN', c1: 4, s2: '12', i2: 'THHN', c2: 1, s3: '10', i3: 'THHN', c3: 0 });
  const ins = Object.keys(E.TABLE_5).map((k) => ({ value: k, label: k }));
  const row = (k) => [
    { label: `Group ${k}: size`, name: 's' + k, type: 'select', value: v['s' + k], options: SIZE_OPTS },
    { label: 'Insulation', name: 'i' + k, type: 'select', value: v['i' + k], options: ins },
    { label: 'Count', name: 'c' + k, type: 'number', value: v['c' + k], min: 0, step: 1 },
  ];
  return liveCalc('conduit', [
    { label: 'Conduit', name: 'conduitType', type: 'select', value: v.conduitType, options: Object.keys(E.TABLE_4) },
    { label: 'Trade size', name: 'tradeSize', type: 'select', value: v.tradeSize, options: E.TRADE_SIZES.map((t) => ({ value: t, label: t + '"' })) },
    ...row(1), ...row(2), ...row(3),
  ], (x) => {
    const wires = [1, 2, 3].map((k) => ({ size: x['s' + k], insulation: x['i' + k], count: n(x['c' + k]) })).filter((w) => w.count > 0);
    const r = E.conduitFill({ conduitType: x.conduitType, tradeSize: x.tradeSize, wires });
    const min = wires.length ? E.minConduit({ conduitType: x.conduitType, wires }) : null;
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
        first ? mini(`Max ${E.sizeLabel(first.size)} ${first.insulation} in ${x.tradeSize}"`, String(E.maxConductors({ conduitType: x.conduitType, tradeSize: x.tradeSize, size: first.size, insulation: first.insulation }))) : null),
    ];
  });
}

function boxTab() {
  const v = saved('box', { box: '5', custom: 0, extra: 0, s1: '12', c1: 4, s2: '14', c2: 0, devices: 1, deviceSize: '12', clamps: true, fittings: 0, egc: 2, egcSize: '12' });
  const boxes = [...E.STANDARD_BOXES.map((b, i) => ({ value: String(i), label: `${b.name} (${b.volume} in³)` })), { value: 'custom', label: 'Other (enter volume)' }];
  const ss = SMALL_SIZES.map((s) => ({ value: s, label: `${s} AWG` }));
  return liveCalc('box', [
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
    const boxVolume = x.box === 'custom' ? n(x.custom) : E.STANDARD_BOXES[Number(x.box)]?.volume || 0;
    const r = E.boxFill({
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

function loadTab() {
  const v = saved('load', { sqft: 2000, sa: 2, laundry: 1, rangeKW: 12, dryerVA: 5000, wh: 4500, dw: 1200, disp: 900, micro: 0, other1: 0, other2: 0, heatVA: 0, acVA: 5000, ev1: 0, ev2: 0, motorVA: 0 });
  return liveCalc('load', [
    { label: 'Living area (ft²)', name: 'sqft', type: 'number', value: v.sqft, min: 0, step: 'any' },
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
      sqft: n(x.sqft), smallApplianceCircuits: n(x.sa) || 2, laundryCircuits: n(x.laundry) || 1, appliances,
      dryerVA: n(x.dryerVA), rangeKW: n(x.rangeKW), heatVA: n(x.heatVA), acVA: n(x.acVA), evVA: [n(x.ev1), n(x.ev2)], largestMotorVA: n(x.motorVA),
    };
    const std = E.dwellingLoadCalc(input);
    const opt = E.dwellingLoadOptional(input);
    const card = (r, title) => result({
      label: title, value: ui.fmtNum(Math.ceil(r.amps)), unit: 'A @ 240 V', tone: 'pass', badge: `${r.service} A service`,
      sub: `${ui.fmtNum(Math.round(r.totalVA))} VA calculated load`,
      children: h('table', { class: 'calc-lines' }, h('tbody', null, r.lines.map((l) => h('tr', { class: l.demand ? 'demand' : null },
        h('td', null, l.label, h('span', { class: 'muted' }, ` · ${l.rule}`)), h('td', { class: 'right num' }, ui.fmtNum(Math.round(l.va))))))),
    });
    return [
      card(std, 'Standard method (Art. 220 Part III)'),
      card(opt, 'Optional method (220.82)'),
      h('p', { class: 'calc-note muted' }, 'Service size is the next standard rating at or above the calculated load, 100 A minimum (230.79(C)). The optional method needs a 100 A or larger service and is for one-family dwellings only.'),
    ];
  });
}

function ohmsTab() {
  // Use whichever two values were typed most recently.
  let order = ['v', 'i'];
  const v = saved('ohms', { v: 120, i: 10, r: '', p: '' });
  const tracker = (vals, e) => {
    const name = e?.target?.name;
    if (name && ['v', 'i', 'r', 'p'].includes(name)) {
      order = order.filter((k) => k !== name);
      if (vals[name] != null) order.push(name);
    }
  };
  return liveCalc('ohms', [
    { label: 'Voltage V (volts)', name: 'v', type: 'number', value: v.v, step: 'any' },
    { label: 'Current I (amps)', name: 'i', type: 'number', value: v.i, step: 'any' },
    { label: 'Resistance R (ohms)', name: 'r', type: 'number', value: v.r, step: 'any' },
    { label: 'Power P (watts)', name: 'p', type: 'number', value: v.p, step: 'any' },
  ], (x) => {
    const filled = ['v', 'i', 'r', 'p'].filter((k) => x[k] != null);
    const use = [...order.filter((k) => x[k] != null), ...filled].filter((k, i, a) => a.indexOf(k) === i).slice(-2);
    if (use.length < 2) return result({ label: 'Enter any two values', tone: 'warn', lines: ['Fill in two of V, I, R or P. The newest two you typed are used.'] });
    const r = E.ohmsLaw(Object.fromEntries(use.map((k) => [k, x[k]])));
    return [
      result({ label: `From ${use.map((k) => k.toUpperCase()).join(' and ')}`, tone: 'pass', lines: ['V = I × R · P = V × I = I² × R = V² ÷ R (DC or resistive AC loads).'] }),
      h('div', { class: 'calc-minis four' },
        mini('Voltage', `${num(r.v, 3)} V`), mini('Current', `${num(r.i, 3)} A`),
        mini('Resistance', `${num(r.r, 3)} Ω`), mini('Power', `${num(r.p, 1)} W`)),
    ];
  }, { onChange: tracker });
}

function motorTab(rerender) {
  const v = saved('motor', { phase: '3', hp: '10', volts: '460' });
  const t = v.phase === '1' ? E.TABLE_430_248 : E.TABLE_430_250;
  const hp = t.hp[v.hp] ? v.hp : Object.keys(t.hp)[0];
  const volts = t.volts.includes(Number(v.volts)) ? v.volts : String(t.volts[t.volts.length - 1]);
  return liveCalc('motor', [
    { label: 'Phase', name: 'phase', type: 'select', value: v.phase, options: PHASES },
    { label: 'Horsepower', name: 'hp', type: 'select', value: hp, options: Object.keys(t.hp).map((k) => ({ value: k, label: k + ' hp' })) },
    { label: 'Voltage', name: 'volts', type: 'select', value: volts, options: t.volts.map((x) => ({ value: String(x), label: x + ' V' })) },
  ], (x) => {
    const r = E.motorFLC({ hp: x.hp, volts: Number(x.volts), phase: Number(x.phase) });
    if (!r) throw new Error('Pick a horsepower and voltage from the table.');
    return [
      result({
        label: `Full-load current, Table ${r.table}`, value: num(r.flc, 1), unit: 'A', tone: 'pass', badge: `${x.hp} hp · ${x.volts} V`,
        sub: 'Use the table FLC, not the nameplate, to size conductors and short-circuit protection (430.6(A)(1)).',
      }),
      h('div', { class: 'calc-minis' },
        mini('Conductor 125% FLC (430.22)', `${num(r.conductorAmps, 1)} A → ${r.conductor ? E.sizeLabel(r.conductor) + ' Cu' : '—'}`),
        mini('Inverse-time breaker, max 250%', `${num(r.breakerMax, 1)} A → ${r.breaker} A`),
        mini('Dual-element fuse, max 175%', `${num(r.fuseMax, 1)} A → ${r.fuse} A`)),
      h('p', { class: 'calc-note muted' }, 'Breaker and fuse are Table 430.52 maximums with the next standard size up (430.52(C)(1) Ex. 1). Overload protection is sized from the nameplate (430.32).'),
    ];
  }, { onChange: (vals, e) => { if (e?.target?.name === 'phase') { rerender(); return 'rerender'; } } });
}

function threePhaseTab() {
  const v = saved('3ph', { mode: 'kva', volts: 208, kva: 30, kw: 0, pf: 0.9, amps: 0, continuous: true });
  return liveCalc('3ph', [
    { label: 'Line-to-line voltage', name: 'volts', type: 'number', value: v.volts, step: 'any', min: 1 },
    { label: 'Calculate from', name: 'mode', type: 'select', value: v.mode, options: [{ value: 'kva', label: 'kVA' }, { value: 'kw', label: 'kW and power factor' }, { value: 'amps', label: 'Amps' }] },
    { label: 'kVA', name: 'kva', type: 'number', value: v.kva, step: 'any', min: 0 },
    { label: 'kW', name: 'kw', type: 'number', value: v.kw, step: 'any', min: 0 },
    { label: 'Power factor', name: 'pf', type: 'number', value: v.pf, step: 'any', min: 0.1, max: 1 },
    { label: 'Amps', name: 'amps', type: 'number', value: v.amps, step: 'any', min: 0 },
    { label: 'Continuous load', name: 'continuous', type: 'checkbox', value: v.continuous },
  ], (x) => {
    if (!(n(x.volts) > 0)) throw new Error('Enter a voltage.');
    const r = x.mode === 'amps' ? E.threePhase({ volts: n(x.volts), amps: n(x.amps), pf: n(x.pf) || 1 })
      : x.mode === 'kw' ? E.threePhase({ volts: n(x.volts), kw: n(x.kw), pf: n(x.pf) || 1 })
        : E.threePhase({ volts: n(x.volts), kva: n(x.kva), pf: n(x.pf) || 1 });
    const breaker = E.suggestBreaker(r.amps, x.continuous);
    return [
      result({
        label: x.mode === 'amps' ? 'Apparent power' : 'Line current', value: x.mode === 'amps' ? num(r.kva, 2) : num(r.amps, 1), unit: x.mode === 'amps' ? 'kVA' : 'A',
        tone: 'pass', badge: breaker ? `Breaker ${breaker} A` : null,
        lines: ['I = VA ÷ (1.732 × V). kVA = kW ÷ PF.', x.continuous ? 'Breaker at 125% for a continuous load, next standard size (240.6(A)).' : 'Breaker at the next standard size (240.6(A)).'],
      }),
      h('div', { class: 'calc-minis' }, mini('Amps', `${num(r.amps, 2)} A`), mini('kVA', num(r.kva, 2)), mini('kW', num(r.kw, 2)),
        mini('Same load single phase', `${num((r.kva * 1000) / n(x.volts), 1)} A @ ${n(x.volts)} V`)),
    ];
  });
}

const VIEWS = { vd: voltageDropTab, wire: wireTab, conduit: conduitTab, box: boxTab, load: loadTab, ohms: ohmsTab, motor: motorTab, '3ph': threePhaseTab };

export default {
  id: 'calcs',
  title: 'Calculators',
  icon: 'calculator',
  group: 'field',
  perm: 'calcs',
  render(root, ctx) {
    ui = ctx.ui; h = ui.h;
    let tab = VIEWS[ctx.params[0]] ? ctx.params[0] : 'vd';
    const body = h('div', { class: 'calc-body' });
    const draw = () => {
      ui.clear(body);
      body.append(VIEWS[tab](draw));
    };
    root.append(ui.page(
      { title: 'Calculators', subtitle: 'Field calcs to NEC 2023. Results update as you type.' },
      h('div', { class: 'calc-tabs' }, ui.tabs(TABS, tab, (id) => ctx.nav('#/calcs/' + id))),
      h('p', { class: 'calc-disclaimer' }, ui.icon('info', 16), 'Estimating aid based on NEC 2023. Check local amendments and confirm with the AHJ before you install.'),
      body,
    ));
    draw();
  },
};
