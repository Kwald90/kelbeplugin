// Panel schedules (S26): a panel directory laid out like the real thing (odd
// slots left, even right), phases assigned from slot position, live phase
// balance and load against the main, with a service/feeder summary for the
// company's code book (CEC by default).
import * as E from '../lib/nec.js';
import * as S from '../lib/cec/systems.js';
import * as CEC from '../lib/cec/index.js';
import * as PT from '../lib/panel-templates.js';

const BREAKERS = CEC.STANDARD_RATINGS.filter((a) => a <= 400);
const SLOT_COUNTS = [12, 16, 20, 24, 30, 32, 40, 42, 54, 60, 66, 72, 84];

let ui, h, store;
const bookOf = () => (store.settings().codeBook === 'NEC-2023' ? 'NEC-2023' : 'CEC-2024');

/** Number of slots: stored value, else the smallest standard count that fits the circuits. */
function slotCount(panel) {
  if (panel.slots) return panel.slots;
  const used = Math.max(0, ...(panel.circuits || []).map((c) => Number(c.slot) + 2 * ((Number(c.poles) || 1) - 1)));
  return SLOT_COUNTS.find((s) => s >= Math.max(used, 24)) || 84;
}

const circuitAmps = S.circuitAmps;
const sysLabel = (key) => S.PANEL_SYSTEMS[key]?.label || key;

/** Map slot -> { circuit, start } for every slot a circuit occupies. */
function occupancy(circuits) {
  const map = new Map();
  for (const c of circuits) {
    for (let k = 0; k < (Number(c.poles) || 1); k++) map.set(Number(c.slot) + 2 * k, { circuit: c, start: k === 0 });
  }
  return map;
}

function withPhases(circuits, system) {
  return circuits.map((c) => ({ ...c, phase: S.circuitPhases(c.slot, c.poles, system) }));
}

function summary(panel) {
  const sys = S.systemOf(panel.voltage);
  const b = S.phaseBalance(panel.circuits || [], panel.voltage);
  const main = Number(panel.mainAmps) || 0;
  const loadPct = main ? (b.maxAmps / main) * 100 : 0;
  return { sys, b, main, loadPct };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function listView(root, ctx) {
  const jobId = ctx.query.jobId || '';
  const jobs = store.list('jobs');
  const jobName = (id) => { const j = jobs.find((x) => x.id === id); return j ? `${j.number} · ${j.title}` : '—'; };
  const panels = store.list('panels', (p) => !jobId || p.jobId === jobId);

  const createFrom = (tpl) => {
    const fields = tpl
      ? { jobId: jobId || null, name: tpl.label.split(' · ')[0] || 'New panel', voltage: tpl.voltage, mainType: tpl.mainType || 'MB', mainAmps: tpl.mainAmps ?? 0, busAmps: tpl.busAmps ?? 0, slots: tpl.slots ?? 40, feedThrough: !!tpl.feedThrough, templateId: tpl.id, circuits: [] }
      : { jobId: jobId || null, name: 'New panel', voltage: '120/240 1ph', mainType: 'MB', mainAmps: 200, busAmps: 200, slots: 40, feedThrough: false, templateId: null, circuits: [] };
    const p = store.add('panels', fields);
    ctx.nav('#/panels/' + p.id);
  };

  const create = () => {
    const book = store.settings().codeBook === 'NEC-2023' ? 'NEC-2023' : 'CEC-2024';
    const region = book === 'NEC-2023' ? 'US' : 'CA';
    const templates = PT.listPanelTemplates(store.settings()).filter((t) => !t.region || t.region.includes(region) || t.custom);
    const sheet = ui.openSheet({
      title: 'New panel',
      body: h('div', { class: 'tpl-list' },
        h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); createFrom(null); } },
          h('strong', null, 'Blank panel'), h('span', { class: 'muted' }, '120/240 V · 200 A · 40 spaces')),
        templates.map((t) => h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); createFrom(t); } },
          h('strong', null, t.label), h('span', { class: 'muted' }, `${t.mainType}${t.feedThrough ? ' · feed-through' : ''}${t.custom ? ' · company' : ''}`)))),
    });
  };

  root.append(ui.page(
    {
      title: 'Panel schedules',
      subtitle: jobId ? `For ${jobName(jobId)}` : 'Directories, phase balance and load per panel',
      actions: [
        jobId ? ui.button('All panels', { variant: 'ghost', href: '#/panels' }) : null,
        ui.button('New panel', { variant: 'primary', icon: 'plus', onClick: create }),
      ].filter(Boolean),
    },
    ui.table({
      columns: [
        { key: 'name', label: 'Panel', sort: (p) => p.name, render: (p) => h('strong', null, p.name) },
        { key: 'job', label: 'Job', sort: (p) => jobName(p.jobId), render: (p) => jobName(p.jobId) },
        { key: 'voltage', label: 'System', render: (p) => sysLabel(p.voltage) },
        { key: 'main', label: 'Main', align: 'right', sort: (p) => Number(p.mainAmps) || 0, render: (p) => `${p.mainAmps || '—'} A` },
        { key: 'circuits', label: 'Circuits', align: 'right', render: (p) => String((p.circuits || []).length) },
        { key: 'va', label: 'Load', align: 'right', sort: (p) => summary(p).b.totalVA, render: (p) => `${ui.fmtNum(summary(p).b.totalVA)} VA` },
        {
          key: 'bal', label: 'Imbalance', align: 'right', sort: (p) => summary(p).b.imbalancePct,
          render: (p) => { const s = summary(p); return ui.badge(`${ui.fmtNum(s.b.imbalancePct, 1)}%`, s.b.imbalancePct > 10 ? 'warning' : 'success'); },
        },
      ],
      rows: panels,
      onRowClick: (p) => ctx.nav('#/panels/' + p.id),
      empty: ui.empty({ icon: 'panel', title: 'No panel schedules yet', text: 'Lay out breakers slot by slot and watch the phase balance as you go.', action: ui.button('New panel', { variant: 'primary', icon: 'plus', onClick: create }) }),
    }),
  ));
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

function editorView(root, ctx, id) {
  let panel = store.get('panels', id);
  if (!panel) {
    root.append(ui.page({ title: 'Panel not found' }, ui.empty({ icon: 'panel', title: 'This panel was deleted', action: ui.button('All panels', { href: '#/panels' }) })));
    return;
  }
  const jobs = store.list('jobs');

  // Redraw after the browser has moved focus (change fires on blur), then put
  // focus back on the same control so tabbing through a row keeps working.
  const redrawKeepFocus = () => setTimeout(() => {
    const a = document.activeElement;
    const slot = a?.closest?.('[data-slot]')?.dataset.slot;
    const name = a?.getAttribute?.('name');
    redraw();
    if (slot && name) gridEl.querySelector(`[data-slot="${slot}"] [name="${name}"]`)?.focus();
  }, 0);
  const save = (patch, opts) => {
    panel = store.update('panels', panel.id, patch, opts);
    redrawKeepFocus();
  };
  const setCircuits = (circuits) => save({ circuits: withPhases(circuits, panel.voltage) });

  // header form
  const head = h('form', { class: 'card panel-head no-print', onSubmit: (e) => e.preventDefault() }, ui.formGrid([
    { label: 'Panel name', name: 'name', value: panel.name, required: true },
    { label: 'Job', name: 'jobId', type: 'select', value: panel.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`) },
    { label: 'System', name: 'voltage', type: 'select', value: panel.voltage, options: S.systemsFor(bookOf(), panel.voltage) },
    { label: 'Main type', name: 'mainType', type: 'select', value: panel.mainType || 'MB', options: [{ value: 'MB', label: 'Main breaker (MB)' }, { value: 'MLO', label: 'Main lug only (MLO)' }] },
    { label: (panel.mainType === 'MLO' ? 'Main OCPD (A)' : 'Main (A)'), name: 'mainAmps', type: 'number', value: panel.mainAmps, min: 0, step: 1, hint: panel.mainType === 'MLO' ? 'No main breaker; upstream feed rating' : null },
    { label: 'Bus (A)', name: 'busAmps', type: 'number', value: panel.busAmps, min: 0, step: 1 },
    { label: 'Spaces', name: 'slots', type: 'select', value: String(slotCount(panel)), options: SLOT_COUNTS.map(String) },
    { label: 'Feed-through lugs', name: 'feedThrough', type: 'checkbox', value: !!panel.feedThrough },
  ]));
  head.addEventListener('change', () => {
    const v = ui.readForm(head);
    const slots = Number(v.slots);
    const tooFar = (panel.circuits || []).some((c) => Number(c.slot) + 2 * ((Number(c.poles) || 1) - 1) > slots);
    if (tooFar) {
      ui.toast('Some breakers sit past that space count. Move them first.', 'error');
      head.querySelector('[name=slots]').value = String(slotCount(panel));
      return;
    }
    const single = (panel.circuits || []).filter((c) => (Number(c.poles) || 1) < S.minPoles(v.voltage));
    const threePole = (panel.circuits || []).filter((c) => Number(c.poles) === 3);
    if (single.length || (threePole.length && !S.systemOf(v.voltage).three)) {
      ui.toast(single.length
        ? `${S.systemOf(v.voltage).label} has no neutral, so 1-pole breakers can't be used. Change breaker${single.length > 1 ? 's' : ''} ${single.map((c) => c.slot).join(', ')} first.`
        : '3-pole breakers need a three-phase system. Change them first.', 'error', 4200);
      head.querySelector('[name=voltage]').value = panel.voltage;
      return;
    }
    panel = store.update('panels', panel.id, {
      name: v.name || 'Panel', jobId: v.jobId || null, voltage: v.voltage, mainType: v.mainType === 'MLO' ? 'MLO' : 'MB',
      mainAmps: v.mainAmps ?? 0, busAmps: v.busAmps ?? 0, slots, feedThrough: !!v.feedThrough,
      circuits: withPhases(panel.circuits || [], v.voltage),
    });
    redraw();
  });

  const summaryEl = h('div', { class: 'panel-summary' });
  const gridEl = h('div', { class: 'panel-grid no-print' });
  const printEl = h('div', { class: 'print-only panel-print' });

  function addCircuit(slot) {
    const circuits = panel.circuits || [];
    const poles = S.minPoles(panel.voltage);
    const occ = occupancy(circuits);
    if (poles > 1 && (occ.has(slot + 2) || slot + 2 > slotCount(panel))) {
      ui.toast('This system has no neutral: breakers need 2 or 3 poles, and the space below is taken.', 'error', 3600);
      return;
    }
    circuits.push({ slot, description: '', amps: 20, poles, loadVA: 0, phase: '' });
    setCircuits(circuits);
    setTimeout(() => gridEl.querySelector(`[data-slot="${slot}"] input[name=description]`)?.focus(), 0);
  }

  /** True if a breaker of `poles` poles can sit at `slot` (room below, not past the end, pole rules). Toasts why not. */
  function fits(slot, poles, occ) {
    const total = slotCount(panel);
    const three = S.systemOf(panel.voltage).three;
    if (poles === 3 && !three) { ui.toast('3-pole breakers need a three-phase panel.', 'error'); return false; }
    if (poles < S.minPoles(panel.voltage)) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: use a 2- or 3-pole breaker.`, 'error'); return false; }
    for (let k = 0; k < poles; k++) {
      const s = slot + 2 * k;
      if (s > total || (occ && occ.has(s))) {
        ui.toast(`A ${poles}-pole breaker at space ${slot} needs space ${s}${s > total ? ', past the end of the panel' : ', which is taken'}.`, 'error');
        return false;
      }
    }
    return true;
  }

  /** Place a breaker template at an empty slot, filling poles/amps/loadVA/description/type in one tap. */
  function placeTemplate(slot, tpl) {
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    const occ = occupancy(circuits);
    let poles = Number(tpl.poles) || S.minPoles(panel.voltage);
    if (poles < S.minPoles(panel.voltage)) poles = S.minPoles(panel.voltage); // honour a no-neutral system
    if (!fits(slot, poles, occ)) return;
    const base = PT.applyBreakerTemplate(tpl, { slot, poles, amps: 20, loadVA: 0 });
    circuits.push({ ...base, slot, poles, phase: '' });
    setCircuits(circuits);
  }

  function openTemplatePicker(slot) {
    const templates = PT.listBreakerTemplates(store.settings());
    const groups = [...new Set(templates.map((t) => t.group || 'Other'))];
    const sheet = ui.openSheet({
      title: `Breaker template · space ${slot}`,
      body: h('div', { class: 'tpl-groups' }, groups.map((g) => h('div', { class: 'tpl-group' },
        h('div', { class: 'tpl-group-head' }, g),
        templates.filter((t) => (t.group || 'Other') === g).map((t) => h('div', { class: 'tpl-row' },
          h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); placeTemplate(slot, t); } },
            h('strong', null, t.label),
            h('span', { class: 'muted' }, `${t.poles}P · ${t.amps == null ? '—' : t.amps + ' A'} · ${PT.breakerTypeLabel(t.breakerType)}${t.loadVA == null ? '' : ' · ' + ui.fmtNum(t.loadVA) + ' VA'}`)),
          t.custom ? ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: 'Delete template', onClick: () => { PT.removeBreakerTemplate(store, t.id); sheet.close(); openTemplatePicker(slot); } }) : null))))),
    });
  }

  /** Per-circuit options sheet: save as template, sub-feed, breaker type, colour override. */
  function openCircuitOptions(c) {
    const colours = coloursNow();
    const phaseKeys = (c.phase || S.circuitPhases(c.slot, c.poles, panel.voltage)).split('-');
    const typeOptions = PT.BREAKER_TYPE_KEYS.map((k) => ({ value: k, label: PT.BREAKER_TYPES[k] }));
    const colourOptions = [{ value: '', label: 'By phase (default)' }, ...Object.keys(colours.phases).map((p) => ({ value: p, label: `Phase ${p} · ${colours.phases[p].name}` }))];
    const sheet = ui.formSheet({
      title: `Breaker ${c.slot}${c.description ? ' · ' + c.description : ''}`,
      fields: [
        { label: 'Breaker type', name: 'breakerType', type: 'select', value: c.breakerType || 'standard', options: typeOptions },
        { label: 'Colour shown', name: 'colorOverride', type: 'select', value: c.colorOverride || '', options: colourOptions },
        { label: 'Sub-feed / feeder breaker', name: 'subFeed', type: 'checkbox', value: !!c.subFeed, span: true },
      ],
      submitLabel: 'Apply',
      extra: h('div', { class: 'tpl-save-row' },
        h('span', { class: 'muted small' }, `Phases ${phaseKeys.join('-')}`),
        ui.button('Save as template', { variant: 'ghost', icon: 'save', onClick: async () => {
          const label = await ui.promptDialog('Template name', { title: 'Save as template', value: c.description || 'Custom breaker', okLabel: 'Save' });
          if (label == null) return;
          PT.saveBreakerTemplate(store, { label, poles: c.poles, amps: c.amps, loadVA: c.loadVA, breakerType: c.breakerType || 'standard', descriptionDefault: c.description || '', subFeed: c.subFeed, group: 'Company' });
          ui.toast('Saved as a company template', 'success');
        } })),
      onSubmit: (v) => {
        const circuits = panel.circuits.map((x) => ({ ...x }));
        const cur = circuits.find((x) => Number(x.slot) === Number(c.slot));
        if (!cur) return;
        cur.breakerType = v.breakerType || 'standard';
        cur.colorOverride = v.colorOverride || null;
        cur.subFeed = !!v.subFeed;
        setCircuits(circuits);
      },
    });
    return sheet;
  }

  const coloursNow = () => S.systemColours(bookOf(), panel.voltage, store.settings().panelColours);

  /** Colour swatches for a circuit's phase(s); a colorOverride forces one phase's colour. */
  function circuitSwatches(c, colours) {
    const keys = c.colorOverride ? [c.colorOverride] : (c.phase || S.circuitPhases(c.slot, c.poles, panel.voltage)).split('-');
    return keys.map((p) => {
      const col = colours.phases[p];
      return col ? h('span', { class: 'wire-swatch', style: { background: col.hex }, title: `Phase ${p} · ${col.name}` }) : null;
    }).filter(Boolean);
  }

  function changeCircuit(c, field, value) {
    const circuits = panel.circuits.map((x) => ({ ...x }));
    const cur = circuits.find((x) => Number(x.slot) === Number(c.slot));
    if (!cur) return;
    if (field === 'poles') {
      const poles = Number(value);
      const occ = occupancy(circuits.filter((x) => x !== cur));
      const total = slotCount(panel);
      for (let k = 0; k < poles; k++) {
        const s = Number(cur.slot) + 2 * k;
        if (s > total || occ.has(s)) {
          ui.toast(`A ${poles}-pole breaker at space ${cur.slot} needs space ${s}${s > total ? ', past the end of the panel' : ', which is taken'}.`, 'error');
          redraw();
          return;
        }
      }
      if (poles === 3 && !S.systemOf(panel.voltage).three) {
        ui.toast('3-pole breakers need a three-phase panel.', 'error');
        redraw();
        return;
      }
      if (poles < S.minPoles(panel.voltage)) {
        ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: use a 2- or 3-pole breaker.`, 'error');
        redraw();
        return;
      }
      cur.poles = poles;
    } else if (field === 'amps' || field === 'loadVA') {
      cur[field] = Number(value) || 0;
    } else {
      cur[field] = value;
    }
    setCircuits(circuits);
  }

  async function removeCircuit(c) {
    if (!(await ui.confirmDialog(`Remove breaker ${c.slot}${c.description ? ` (${c.description})` : ''}?`, { okLabel: 'Remove' }))) return;
    setCircuits(panel.circuits.filter((x) => Number(x.slot) !== Number(c.slot)));
  }

  function slotCell(slot, occ, side, colours) {
    const phase = S.slotPhase(slot, panel.voltage);
    const o = occ.get(slot);
    const num = h('span', { class: 'slot-num num' }, slot);
    const ph = h('span', { class: ['slot-phase', 'ph-' + phase] }, phase);
    if (!o) {
      return h('div', { class: ['slot', 'empty', side], dataset: { slot } }, num, ph,
        h('div', { class: 'slot-empty-actions' },
          h('button', { class: 'slot-add', type: 'button', onClick: () => addCircuit(slot), 'aria-label': `Add breaker at space ${slot}` }, ui.icon('plus', 16), 'Add breaker'),
          h('button', { class: 'slot-add tpl', type: 'button', onClick: () => openTemplatePicker(slot), 'aria-label': `Add breaker from a template at space ${slot}` }, ui.icon('copy', 16), 'Template')));
    }
    if (!o.start) {
      return h('div', { class: ['slot', 'cont', side], dataset: { slot } }, num, ph, h('span', { class: 'slot-cont muted' }, `↳ ${o.circuit.poles}-pole from ${o.circuit.slot}`));
    }
    const c = o.circuit;
    const amps = circuitAmps(c, panel.voltage);
    const over = c.amps && amps > 0.8 * Number(c.amps);
    const onChange = (field) => (e) => changeCircuit(c, field, e.target.value);
    const bType = c.breakerType || 'standard';
    return h('div', { class: ['slot', 'used', side, over ? 'over' : null, c.subFeed ? 'subfeed' : null], dataset: { slot } },
      num, ph,
      h('div', { class: 'slot-fields' },
        h('input', { class: 'input slot-desc', name: 'description', value: c.description || '', placeholder: 'Circuit description', 'aria-label': `Space ${slot} description`, onChange: onChange('description') }),
        h('div', { class: 'slot-row' },
          h('select', { class: 'input', name: 'amps', 'aria-label': `Space ${slot} breaker amps`, onChange: onChange('amps') },
            BREAKERS.map((a) => h('option', { value: a, selected: Number(c.amps) === a }, `${a} A`))),
          h('select', { class: 'input', name: 'poles', 'aria-label': `Space ${slot} poles`, onChange: onChange('poles') },
            [1, 2, 3].filter((p) => p >= S.minPoles(panel.voltage) && (p < 3 || S.systemOf(panel.voltage).three)).map((p) => h('option', { value: p, selected: Number(c.poles) === p }, `${p}P`))),
          h('select', { class: 'input slot-type', name: 'breakerType', 'aria-label': `Space ${slot} breaker type`, onChange: onChange('breakerType') },
            PT.BREAKER_TYPE_KEYS.map((k) => h('option', { value: k, selected: bType === k }, PT.BREAKER_TYPES[k]))),
          h('label', { class: 'slot-va' }, h('input', { class: 'input', name: 'loadVA', type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: c.loadVA || '', placeholder: '0', 'aria-label': `Space ${slot} load VA`, onChange: onChange('loadVA') }), h('span', null, 'VA')),
          ui.button('', { variant: 'ghost', size: 'sm', icon: 'sliders', title: `Options for breaker ${slot}`, onClick: () => openCircuitOptions(c) }),
          ui.button('', { variant: 'ghost', size: 'sm', icon: 'trash', title: `Remove breaker ${slot}`, onClick: () => removeCircuit(c) })),
        h('div', { class: ['slot-meta', over ? 'warn' : null] },
          h('span', { class: 'wire-swatches' }, circuitSwatches(c, colours)),
          ` ${c.phase || S.circuitPhases(c.slot, c.poles, panel.voltage)} · ${ui.fmtNum(amps, 1)} A`,
          c.subFeed ? h('span', { class: 'subfeed-tag' }, 'sub-feed') : null,
          over ? ` · over 80% of ${c.amps} A` : '')));
  }

  function drawGrid() {
    ui.clear(gridEl);
    const total = slotCount(panel);
    const occ = occupancy(panel.circuits || []);
    const colours = coloursNow();
    gridEl.append(h('div', { class: 'panel-bus' }, h('span', null, 'Odd'), h('span', null, 'Even')));
    for (let row = 1; row <= total / 2; row++) {
      gridEl.append(h('div', { class: 'panel-row' }, slotCell(2 * row - 1, occ, 'left', colours), slotCell(2 * row, occ, 'right', colours)));
    }
  }

  function drawSummary() {
    ui.clear(summaryEl);
    const { sys, b, main, loadPct } = summary(panel);
    const cec = bookOf() === 'CEC-2024';
    const maxPhase = Math.max(1, ...Object.values(b.perPhase));
    const totalAmps = S.totalAmps(b.totalVA, panel.voltage);
    const contRef = cec ? 'Rule 8-104(6)' : 'NEC 210.20(A), 215.3';
    const warnings = [];
    if (main && b.maxAmps > 0.8 * main) warnings.push(`Heaviest phase is ${ui.fmtNum(loadPct, 0)}% of the ${main} A main: over 80% for continuous loads (${contRef}).`);
    if (b.imbalancePct > 10) warnings.push(`Phases are ${ui.fmtNum(b.imbalancePct, 1)}% out of balance. Move loads to the lightest phase.`);
    if (main && Number(panel.busAmps) && main > Number(panel.busAmps)) warnings.push(`Main ${main} A is larger than the ${panel.busAmps} A bus rating.`);
    const hot = (panel.circuits || []).filter((c) => c.amps && circuitAmps(c, panel.voltage) > 0.8 * c.amps);
    if (hot.length) warnings.push(`${hot.length} breaker${hot.length > 1 ? 's are' : ' is'} loaded over 80% (${contRef}): ${hot.map((c) => c.slot).join(', ')}.`);
    if (!sys.neutral && (panel.circuits || []).some((c) => (Number(c.poles) || 1) < 2)) warnings.push('1-pole breakers on a system with no neutral: change them to 2- or 3-pole.');

    summaryEl.append(
      h('div', { class: 'card panel-phases' },
        h('div', { class: 'calc-label' }, `Phase loads · ${sys.label}`),
        Object.entries(b.perPhase).map(([p, va]) => h('div', { class: 'phase-row' },
          h('span', { class: ['slot-phase', 'ph-' + p] }, p),
          h('div', { class: 'progress grow' }, h('i', { class: 'ph-fill-' + p, style: { width: `${(va / maxPhase) * 100}%` } })),
          h('span', { class: 'num phase-val' }, `${ui.fmtNum(va)} VA · ${ui.fmtNum(b.amps[p], 1)} A`))),
        sys.neutral ? null : h('div', { class: 'calc-note muted' }, `No neutral: per-phase amps use ${ui.fmtNum(S.phaseVolts(panel.voltage), 0)} V (${sys.llVolts} V ÷ √3).`)),
      h('div', { class: 'panel-stats' },
        ui.stat({ label: 'Connected load', value: `${ui.fmtNum(b.totalVA / 1000, 1)} kVA`, hint: `${ui.fmtNum(totalAmps, 1)} A ${sys.three ? '3φ at ' + sys.llVolts + ' V' : 'at ' + sys.llVolts + ' V'}` }),
        ui.stat({ label: 'Imbalance', value: `${ui.fmtNum(b.imbalancePct, 1)}%`, tone: b.imbalancePct > 10 ? 'danger' : 'success', hint: 'Max deviation from average' }),
        h('div', { class: 'card stat' },
          h('span', { class: 'label' }, 'Load vs main'),
          h('span', { class: 'value' }, main ? `${ui.fmtNum(loadPct, 0)}%` : '—'),
          h('div', { class: 'progress' }, h('i', { style: { width: `${Math.min(100, loadPct)}%`, background: loadPct > 80 ? 'var(--danger)' : '' } })),
          h('span', { class: 'hint' }, main ? `${ui.fmtNum(b.maxAmps, 1)} A of ${main} A, heaviest phase` : 'Set the main size'))),
      main ? serviceCard({ sys, b, main, totalAmps, cec }) : null,
      colourLegendCard(),
      warnings.length
        ? h('div', { class: 'card panel-warn', role: 'status' }, warnings.map((w) => h('div', { class: 'row' }, ui.icon('alert', 16), h('span', null, w))))
        : h('div', { class: 'card panel-ok' }, ui.icon('check', 16), ' No load or balance warnings.'),
    );
  }

  /** Service / feeder card: loading against the main, and conductors and bonding sized for it. */
  function serviceCard({ sys, b, main, totalAmps, cec }) {
    const rows = [];
    const add = (label, value, ref) => rows.push(h('tr', null, h('td', null, label, ref ? h('span', { class: 'muted' }, ` · ${ref}`) : null), h('td', { class: 'right num' }, value)));
    add('Connected load current', `${ui.fmtNum(totalAmps, 1)} A`, sys.three ? 'I = VA ÷ (√3 × V)' : 'I = VA ÷ V');
    add('Continuous-load limit (80% rated main)', `${ui.fmtNum(0.8 * main, 0)} A`, cec ? 'Rule 8-104(6)' : 'NEC 215.3');
    if (cec) {
      const term = CEC.terminationTemp({ amps: main });
      const cu = CEC.minConductorForAmps(main, 'cu', term);
      const al = CEC.minConductorForAmps(main, 'al', term);
      add(`Conductors for ${main} A at ${term} °C`, `${cu ? CEC.sizeLabel(cu) + ' Cu' : '—'} / ${al ? CEC.sizeLabel(al) + ' Al' : '—'}`, `Tables 2, 4; Rule 4-006`);
      const bond = CEC.bondingConductor(main);
      if (bond) add('Bonding conductor', `${CEC.sizeLabel(bond.cu)} Cu / ${CEC.sizeLabel(bond.al)} Al`, 'Table 16');
    } else {
      const temp = main <= 100 ? 60 : 75;
      const cu = E.SIZES.find((sz) => (E.ampacity(sz, 'cu', temp) || 0) >= main);
      const al = E.SIZES.find((sz) => (E.ampacity(sz, 'al', temp) || 0) >= main);
      add(`Conductors for ${main} A at ${temp} °C`, `${cu ? E.sizeLabel(cu) + ' Cu' : '—'} / ${al ? E.sizeLabel(al) + ' Al' : '—'}`, 'NEC Table 310.16, 110.14(C)');
    }
    return h('div', { class: 'card panel-service' },
      h('div', { class: 'calc-label' }, `Service / feeder · ${cec ? 'CEC 2024' : 'NEC 2023'}`),
      h('table', { class: 'calc-lines' }, h('tbody', null, rows)),
      h('p', { class: 'calc-note muted' }, 'Connected load, not a demand calculation. Conductors sized to the main rating in raceway or cable, 30 °C, three or fewer current-carrying conductors. ',
        cec ? h('a', { href: '#/calcs/load' }, 'Dwelling service (Rule 8-200)') : h('a', { href: '#/calcs/load' }, 'Dwelling load calc')));
  }

  /** Wire-colour legend: phase colours (convention) plus the mandated neutral and bond, with the disclaimer. */
  function colourLegendCard() {
    const colours = coloursNow();
    const swatch = (col) => h('span', { class: 'wire-swatch lg', style: { background: col.hex }, title: col.name });
    const row = (label, col, tag) => h('div', { class: 'legend-row' }, swatch(col), h('span', { class: 'legend-name' }, label, ' — ', col.name),
      h('span', { class: ['legend-tag', col.mandated ? 'mand' : 'conv'] }, col.mandated ? `Mandated${col.ref ? ' · ' + col.ref : ''}` : 'Convention'));
    return h('div', { class: 'card panel-colours' },
      h('div', { class: 'calc-label row-between' }, h('span', null, `Wire colours · ${colours.book === 'NEC-2023' ? 'NEC 2023' : 'CEC 2024'}`),
        ui.button('Edit colours', { variant: 'ghost', size: 'sm', icon: 'palette', onClick: () => openColourEditor() })),
      Object.entries(colours.phases).map(([p, col]) => row(`Phase ${p}`, col)),
      row('Neutral', colours.neutral),
      row('Bond / ground', colours.bond),
      h('p', { class: 'calc-note muted' }, S.COLOUR_LEGEND_NOTE));
  }

  /** Edit this company's phase/neutral/bond colours for the current system; saved in settings.panelColours. */
  function openColourEditor() {
    const book = bookOf();
    const colours = coloursNow();
    const sys = S.systemOf(panel.voltage);
    const hexOf = (c) => (/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#999999');
    const fields = [
      ...sys.phases.map((p) => ({ label: `Phase ${p}`, name: 'ph_' + p, type: 'color', value: hexOf(colours.phases[p]) })),
      { label: 'Neutral (mandated white/grey)', name: 'neutral', type: 'color', value: hexOf(colours.neutral) },
      { label: 'Bond / ground (mandated green)', name: 'bond', type: 'color', value: hexOf(colours.bond) },
    ];
    const presetBtn = (key) => ui.button(S.COLOUR_PRESETS[key].label, { variant: 'ghost', size: 'sm', onClick: () => {
      const form = sheet.el.querySelector('form');
      for (const p of sys.phases) { const el = form.querySelector(`[name=ph_${p}]`); if (el && S.COLOUR_PRESETS[key][p]) el.value = S.COLOUR_PRESETS[key][p]; }
    } });
    const sheet = ui.formSheet({
      title: `Edit colours · ${sys.label}`,
      fields,
      submitLabel: 'Save colours',
      extra: h('div', { class: 'tpl-presets' }, h('span', { class: 'muted small' }, 'Presets:'),
        presetBtn('rbb'), sys.phases.length > 2 ? presetBtn('boy') : null, presetBtn('brb')),
      danger: { label: 'Reset to code default', onClick: () => {
        const s = store.settings();
        const pc = { ...(s.panelColours || {}) };
        const bk = { ...(pc[book] || {}) };
        delete bk[panel.voltage];
        pc[book] = bk;
        store.saveSettings({ panelColours: pc });
        redraw();
      } },
      onSubmit: (v) => {
        const s = store.settings();
        const pc = { ...(s.panelColours || {}) };
        const bk = { ...(pc[book] || {}) };
        const sysOv = {};
        for (const p of sys.phases) sysOv[p] = v['ph_' + p];
        bk[panel.voltage] = sysOv;
        if (v.neutral) bk.neutral = v.neutral;
        if (v.bond) bk.bond = v.bond;
        pc[book] = bk;
        store.saveSettings({ panelColours: pc });
        redraw();
      },
    });
    return sheet;
  }

  function drawPrint() {
    ui.clear(printEl);
    const s = store.settings();
    const job = jobs.find((j) => j.id === panel.jobId);
    const total = slotCount(panel);
    const occ = occupancy(panel.circuits || []);
    const colours = coloursNow();
    const descCell = (c) => h('td', null, h('span', { class: 'print-swatches' }, circuitSwatches(c, colours)),
      ` ${c.description || '—'}${c.subFeed ? ' (sub-feed)' : ''}`);
    const cell = (slot) => {
      const o = occ.get(slot);
      if (!o) return [h('td', { class: 'num' }, slot), h('td', null, 'Spare / space'), h('td', null, '')];
      if (!o.start) return [h('td', { class: 'num' }, slot), h('td', null, `↳ ${o.circuit.slot}`), h('td', null, '')];
      const tLabel = o.circuit.breakerType && o.circuit.breakerType !== 'standard' ? ' ' + PT.breakerTypeLabel(o.circuit.breakerType) : '';
      return [h('td', { class: 'num' }, slot), descCell(o.circuit), h('td', { class: 'num' }, `${o.circuit.amps}A ${o.circuit.poles}P${tLabel}`)];
    };
    const rows = [];
    for (let r = 1; r <= total / 2; r++) rows.push(h('tr', null, cell(2 * r - 1), cell(2 * r)));
    const mainTxt = panel.mainType === 'MLO' ? `MLO${panel.mainAmps ? ' · ' + panel.mainAmps + ' A feed' : ''}` : `Main ${panel.mainAmps} A`;
    const legendChip = (label, col) => h('span', { class: 'print-legend-chip' }, h('span', { class: 'wire-swatch', style: { background: col.hex } }), `${label}: ${col.name}`);
    printEl.append(
      h('h1', null, panel.name),
      h('p', null, `${sysLabel(panel.voltage)} · ${mainTxt} · Bus ${panel.busAmps} A${panel.feedThrough ? ' · feed-through' : ''}${job ? ` · ${job.number} ${job.title}` : ''}`),
      h('table', { class: 'panel-print-table' }, h('tbody', null, rows)),
      h('div', { class: 'print-legend' },
        Object.entries(colours.phases).map(([p, col]) => legendChip(`Ø${p}`, col)),
        legendChip('N', colours.neutral), legendChip('Bond', colours.bond)),
      h('p', { class: 'small' }, 'Only neutral (white/grey) and bond (green) colours are code-mandated; phase colours are convention unless colour-coding is required (CEC Rule 4-036). Confirm with the AHJ.'),
      h('p', { class: 'small' }, `${s.company?.name || ''}${s.company?.licenceNo ? ' · Lic. ' + s.company.licenceNo : ''} · ${ui.fmtDate(new Date())}`),
    );
  }

  function redraw() { drawSummary(); drawGrid(); drawPrint(); }

  const del = async () => {
    if (!(await ui.confirmDialog(`Delete ${panel.name} and its ${panel.circuits?.length || 0} circuits?`, { okLabel: 'Delete' }))) return;
    store.remove('panels', panel.id);
    ctx.nav('#/panels' + (panel.jobId ? '?jobId=' + panel.jobId : ''));
  };

  root.append(ui.page(
    {
      title: panel.name,
      subtitle: 'Odd spaces on the left, even on the right. Phases follow the bus.',
      actions: [
        ui.button('', { variant: 'ghost', icon: 'chevron-left', title: 'All panels', href: '#/panels' + (panel.jobId ? '?jobId=' + panel.jobId : '') }),
        ui.button('Print directory', { icon: 'printer', onClick: () => window.print() }),
        ui.button('', { variant: 'ghost danger', icon: 'trash', title: 'Delete panel', onClick: del }),
      ],
    },
    head, summaryEl, gridEl, printEl,
  ));
  root.lastElementChild.classList.add('panel-page');
  redraw();
}

export default {
  id: 'panels',
  title: 'Panel schedules',
  icon: 'panel',
  group: 'field',
  perm: 'panels',
  render(root, ctx) {
    ui = ctx.ui; h = ui.h; store = ctx.store;
    if (ctx.params[0]) editorView(root, ctx, ctx.params[0]);
    else listView(root, ctx);
  },
};
