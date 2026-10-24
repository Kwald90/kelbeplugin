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

/** The half of a space a circuit sits in: 'A' (upper) or 'B' (lower) for a tandem, else null (full space). */
export const halfOf = (c) => (c && (c.half === 'A' || c.half === 'B') ? c.half : null);

/** Slots a circuit spans past its first: a half takes only its own space, a full breaker 2×(poles−1) more. */
const spanTo = (c) => (halfOf(c) ? Number(c.slot) : Number(c.slot) + 2 * ((Number(c.poles) || 1) - 1));

/** Identity of a circuit within a panel: same space and same half (full breakers share the null half). */
const sameCircuit = (a, b) => Number(a.slot) === Number(b.slot) && (halfOf(a) || '') === (halfOf(b) || '');

/** Number of slots: stored value, else the smallest standard count that fits the circuits. */
export function slotCount(panel) {
  if (panel.slots) return panel.slots;
  const used = Math.max(0, ...(panel.circuits || []).map(spanTo));
  return SLOT_COUNTS.find((s) => s >= Math.max(used, 24)) || 84;
}

const circuitAmps = S.circuitAmps;
const sysLabel = (key) => S.PANEL_SYSTEMS[key]?.label || key;

/**
 * Occupancy of every space a circuit touches. Returns a Map slot ->
 *   { full, start, A, B }
 * where `full` is a whole-space breaker occupying the slot (null if none), `start`
 * is true on that breaker's first slot, and `A`/`B` are the half-space (tandem)
 * circuits sitting in the upper/lower half of the slot (null if empty). A full
 * breaker and a half can never share a space; two halves (A and B) may.
 */
export function occupancy(circuits) {
  const map = new Map();
  const at = (slot) => {
    let o = map.get(slot);
    if (!o) { o = { full: null, start: false, A: null, B: null }; map.set(slot, o); }
    return o;
  };
  for (const c of circuits) {
    const half = halfOf(c);
    if (half) { at(Number(c.slot))[half] = c; continue; }
    const poles = Number(c.poles) || 1;
    for (let k = 0; k < poles; k++) {
      const o = at(Number(c.slot) + 2 * k);
      o.full = c;
      if (k === 0) o.start = true;
    }
  }
  return map;
}

/** True if a space holds any breaker (a full one or either half). */
const spaceTaken = (o) => !!(o && (o.full || o.A || o.B));

/**
 * Pure placement check: can a breaker go at `slot` in `circuits` on a panel of
 * `total` spaces? `half` 'A'/'B' means a tandem (half space); otherwise a full
 * breaker of `poles` poles. Returns { ok } or { ok:false, reason } with a
 * ready-to-toast message. Pole/system rules (neutral, three-phase) are checked
 * by the caller; this only enforces physical collisions.
 */
export function placement(circuits, { slot, poles = 1, half = null }, total) {
  slot = Number(slot);
  const occ = occupancy(circuits);
  if (half === 'A' || half === 'B') {
    const o = occ.get(slot);
    if (o && o.full) return { ok: false, reason: `Space ${slot} has a full-size breaker, so a tandem can't share it.` };
    if (o && o[half]) return { ok: false, reason: `Space ${slot}${half} already has a tandem.` };
    return { ok: true };
  }
  for (let k = 0; k < (Number(poles) || 1); k++) {
    const s = slot + 2 * k;
    if (s > total) return { ok: false, reason: `A ${poles}-pole breaker at space ${slot} needs space ${s}, past the end of the panel.` };
    const o = occ.get(s);
    if (spaceTaken(o)) return { ok: false, reason: `A ${poles}-pole breaker at space ${slot} needs space ${s}, which is taken.` };
  }
  return { ok: true };
}

function withPhases(circuits, system) {
  return circuits.map((c) => ({ ...c, phase: S.circuitPhases(c.slot, halfOf(c) ? 1 : c.poles, system) }));
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
    const cell = a?.closest?.('[data-slot]');
    const slot = cell?.dataset.slot;
    const half = cell?.dataset.half || '';
    const name = a?.getAttribute?.('name');
    redraw();
    if (slot && name) {
      const sel = half
        ? `[data-slot="${slot}"][data-half="${half}"] [name="${name}"]`
        : `[data-slot="${slot}"]:not([data-half]) [name="${name}"]`;
      gridEl.querySelector(sel)?.focus();
    }
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
    const tooFar = (panel.circuits || []).some((c) => spanTo(c) > slots);
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

  /** True if the current system allows tandems (single-pole half breakers need a neutral). */
  const tandemsAllowed = () => S.minPoles(panel.voltage) === 1;

  function addCircuit(slot) {
    const circuits = panel.circuits || [];
    const poles = S.minPoles(panel.voltage);
    if (!fits(slot, poles)) return;
    circuits.push({ slot, description: '', amps: 20, poles, loadVA: 0, phase: '' });
    setCircuits(circuits);
    setTimeout(() => gridEl.querySelector(`[data-slot="${slot}"] input[name=description]`)?.focus(), 0);
  }

  /** Add a tandem (half-space, single-pole) breaker to space `slot`; picks the first free half if `half` is omitted. */
  function addTandem(slot, half) {
    if (!tandemsAllowed()) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: tandems are single-pole and can't be used.`, 'error', 3600); return; }
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    const occ = occupancy(circuits);
    const o = occ.get(slot);
    const letter = half || (o && o.A ? 'B' : 'A');
    const r = placement(circuits, { slot, half: letter }, slotCount(panel));
    if (!r.ok) { ui.toast(r.reason, 'error'); return; }
    circuits.push({ slot, half: letter, description: '', amps: 20, poles: 1, loadVA: 0, breakerType: 'tandem', phase: '' });
    setCircuits(circuits);
    setTimeout(() => gridEl.querySelector(`[data-slot="${slot}"][data-half="${letter}"] input[name=description]`)?.focus(), 0);
  }

  /** Turn a full single-pole breaker into a half tandem in place; returns true on success, else toasts. */
  function makeTandem(cur, circuits) {
    if (halfOf(cur)) { cur.breakerType = 'tandem'; return true; } // already a half
    if ((Number(cur.poles) || 1) > 1) { ui.toast("Multi-pole breakers fill a full space and can't be tandems.", 'error'); return false; }
    if (!tandemsAllowed()) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: tandems are single-pole and can't be used.`, 'error'); return false; }
    const occ = occupancy(circuits.filter((x) => x !== cur));
    const o = occ.get(Number(cur.slot));
    const letter = !(o && o.A) ? 'A' : (!o.B ? 'B' : null);
    if (!letter) { ui.toast(`Space ${cur.slot} already has two tandems.`, 'error'); return false; }
    cur.half = letter; cur.poles = 1; cur.breakerType = 'tandem';
    return true;
  }

  /** True if a full breaker of `poles` poles can sit at `slot` (room below, not past the end, pole rules). Toasts why not. */
  function fits(slot, poles) {
    const three = S.systemOf(panel.voltage).three;
    if (poles === 3 && !three) { ui.toast('3-pole breakers need a three-phase panel.', 'error'); return false; }
    if (poles < S.minPoles(panel.voltage)) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: use a 2- or 3-pole breaker.`, 'error'); return false; }
    const r = placement(panel.circuits || [], { slot, poles }, slotCount(panel));
    if (!r.ok) { ui.toast(r.reason, 'error'); return false; }
    return true;
  }

  /** Place a breaker template at a slot, filling poles/amps/loadVA/description/type in one tap. A tandem
   * template (breakerType 'tandem') lands in a half space, taking `preferHalf` or the first free half. */
  function placeTemplate(slot, tpl, preferHalf) {
    const circuits = (panel.circuits || []).map((x) => ({ ...x }));
    if (tpl.breakerType === 'tandem' || tpl.half) {
      if (!tandemsAllowed()) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: tandems are single-pole and can't be used.`, 'error', 3600); return; }
      const o = occupancy(circuits).get(slot);
      const letter = preferHalf && !(o && o[preferHalf]) ? preferHalf : (!(o && o.A) ? 'A' : (!o.B ? 'B' : null));
      if (!letter) { ui.toast(`Space ${slot} already has two tandems.`, 'error'); return; }
      const r = placement(circuits, { slot, half: letter }, slotCount(panel));
      if (!r.ok) { ui.toast(r.reason, 'error'); return; }
      const base = PT.applyBreakerTemplate(tpl, { slot, poles: 1, amps: 20, loadVA: 0 });
      circuits.push({ ...base, slot, half: letter, poles: 1, breakerType: 'tandem', phase: '' });
      setCircuits(circuits);
      return;
    }
    let poles = Number(tpl.poles) || S.minPoles(panel.voltage);
    if (poles < S.minPoles(panel.voltage)) poles = S.minPoles(panel.voltage); // honour a no-neutral system
    if (!fits(slot, poles)) return;
    const base = PT.applyBreakerTemplate(tpl, { slot, poles, amps: 20, loadVA: 0 });
    circuits.push({ ...base, slot, poles, phase: '' });
    setCircuits(circuits);
  }

  function openTemplatePicker(slot, preferHalf) {
    const templates = PT.listBreakerTemplates(store.settings());
    const groups = [...new Set(templates.map((t) => t.group || 'Other'))];
    const sheet = ui.openSheet({
      title: `Breaker template · space ${slot}${preferHalf ? ' ' + preferHalf : ''}`,
      body: h('div', { class: 'tpl-groups' }, groups.map((g) => h('div', { class: 'tpl-group' },
        h('div', { class: 'tpl-group-head' }, g),
        templates.filter((t) => (t.group || 'Other') === g).map((t) => h('div', { class: 'tpl-row' },
          h('button', { class: 'tpl-item', type: 'button', onClick: () => { sheet.close(); placeTemplate(slot, t, preferHalf); } },
            h('strong', null, t.label),
            h('span', { class: 'muted' }, `${t.breakerType === 'tandem' ? 'half · 1P' : t.poles + 'P'} · ${t.amps == null ? '—' : t.amps + ' A'} · ${PT.breakerTypeLabel(t.breakerType)}${t.loadVA == null ? '' : ' · ' + ui.fmtNum(t.loadVA) + ' VA'}`)),
          t.custom ? ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'trash', title: 'Delete template', onClick: () => { PT.removeBreakerTemplate(store, t.id); sheet.close(); openTemplatePicker(slot, preferHalf); } }) : null))))),
    });
  }

  /** Per-circuit options sheet: save as template, sub-feed, breaker type, colour override. */
  function openCircuitOptions(c) {
    const colours = coloursNow();
    const phaseKeys = (c.phase || S.circuitPhases(c.slot, halfOf(c) ? 1 : c.poles, panel.voltage)).split('-');
    const typeOptions = PT.BREAKER_TYPE_KEYS.map((k) => ({ value: k, label: PT.BREAKER_TYPES[k] }));
    const colourOptions = [{ value: '', label: 'By phase (default)' }, ...Object.keys(colours.phases).map((p) => ({ value: p, label: `Phase ${p} · ${colours.phases[p].name}` }))];
    const sheet = ui.formSheet({
      title: `Breaker ${c.slot}${halfOf(c) || ''}${c.description ? ' · ' + c.description : ''}`,
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
        const cur = circuits.find((x) => sameCircuit(x, c));
        if (!cur) return;
        const bt = v.breakerType || 'standard';
        if (bt === 'tandem') { if (!makeTandem(cur, circuits)) return; }
        else cur.breakerType = bt;
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
    const keys = c.colorOverride ? [c.colorOverride] : (c.phase || S.circuitPhases(c.slot, halfOf(c) ? 1 : c.poles, panel.voltage)).split('-');
    return keys.map((p) => {
      const col = colours.phases[p];
      return col ? h('span', { class: 'wire-swatch', style: { background: col.hex }, title: `Phase ${p} · ${col.name}` }) : null;
    }).filter(Boolean);
  }

  function changeCircuit(c, field, value) {
    const circuits = panel.circuits.map((x) => ({ ...x }));
    const cur = circuits.find((x) => sameCircuit(x, c));
    if (!cur) return;
    if (field === 'poles') {
      // Halves are always single-pole and don't show this control; full breakers resize here.
      const poles = Number(value);
      if (poles === 3 && !S.systemOf(panel.voltage).three) { ui.toast('3-pole breakers need a three-phase panel.', 'error'); redraw(); return; }
      if (poles < S.minPoles(panel.voltage)) { ui.toast(`${S.systemOf(panel.voltage).label} has no neutral: use a 2- or 3-pole breaker.`, 'error'); redraw(); return; }
      const r = placement(circuits.filter((x) => x !== cur), { slot: cur.slot, poles }, slotCount(panel));
      if (!r.ok) { ui.toast(r.reason, 'error'); redraw(); return; }
      cur.poles = poles;
    } else if (field === 'breakerType') {
      if ((value || 'standard') === 'tandem') { if (!makeTandem(cur, circuits)) { redraw(); return; } }
      else cur.breakerType = value || 'standard';
    } else if (field === 'amps' || field === 'loadVA') {
      cur[field] = Number(value) || 0;
    } else {
      cur[field] = value;
    }
    setCircuits(circuits);
  }

  async function removeCircuit(c) {
    if (!(await ui.confirmDialog(`Remove breaker ${c.slot}${halfOf(c) || ''}${c.description ? ` (${c.description})` : ''}?`, { okLabel: 'Remove' }))) return;
    setCircuits(panel.circuits.filter((x) => !sameCircuit(x, c)));
  }

  /** Editable fields for one breaker (full or half). Returns { over, node }. A half shows a locked 1P and no pole select. */
  function breakerFields(c, slot, colours) {
    const amps = circuitAmps(c, panel.voltage);
    const over = c.amps && amps > 0.8 * Number(c.amps);
    const onChange = (field) => (e) => changeCircuit(c, field, e.target.value);
    const bType = c.breakerType || 'standard';
    const half = halfOf(c);
    const label = `Space ${slot}${half || ''}`;
    const polesCtl = half
      ? h('span', { class: 'slot-poles-fixed', title: 'A tandem is a single-pole half-space breaker' }, '1P')
      : h('select', { class: 'input', name: 'poles', 'aria-label': `${label} poles`, onChange: onChange('poles') },
          [1, 2, 3].filter((p) => p >= S.minPoles(panel.voltage) && (p < 3 || S.systemOf(panel.voltage).three)).map((p) => h('option', { value: p, selected: Number(c.poles) === p }, `${p}P`)));
    const node = h('div', { class: 'slot-fields' },
      h('input', { class: 'input slot-desc', name: 'description', value: c.description || '', placeholder: 'Circuit description', 'aria-label': `${label} description`, onChange: onChange('description') }),
      h('div', { class: 'slot-row' },
        h('select', { class: 'input', name: 'amps', 'aria-label': `${label} breaker amps`, onChange: onChange('amps') },
          BREAKERS.map((a) => h('option', { value: a, selected: Number(c.amps) === a }, `${a} A`))),
        polesCtl,
        h('select', { class: 'input slot-type', name: 'breakerType', 'aria-label': `${label} breaker type`, onChange: onChange('breakerType') },
          PT.BREAKER_TYPE_KEYS.map((k) => h('option', { value: k, selected: bType === k }, PT.BREAKER_TYPES[k]))),
        h('label', { class: 'slot-va' }, h('input', { class: 'input', name: 'loadVA', type: 'number', min: 0, step: 'any', inputmode: 'decimal', value: c.loadVA || '', placeholder: '0', 'aria-label': `${label} load VA`, onChange: onChange('loadVA') }), h('span', null, 'VA')),
        ui.button('', { variant: 'ghost', size: 'sm', icon: 'sliders', title: `Options for breaker ${slot}${half || ''}`, onClick: () => openCircuitOptions(c) }),
        ui.button('', { variant: 'ghost', size: 'sm', icon: 'trash', title: `Remove breaker ${slot}${half || ''}`, onClick: () => removeCircuit(c) })),
      h('div', { class: ['slot-meta', over ? 'warn' : null] },
        h('span', { class: 'wire-swatches' }, circuitSwatches(c, colours)),
        ` ${c.phase || S.circuitPhases(c.slot, half ? 1 : c.poles, panel.voltage)} · ${ui.fmtNum(amps, 1)} A`,
        c.subFeed ? h('span', { class: 'subfeed-tag' }, 'sub-feed') : null,
        over ? ` · over 80% of ${c.amps} A` : ''));
    return { over, node };
  }

  function slotCell(slot, occ, side, colours) {
    const phase = S.slotPhase(slot, panel.voltage);
    const o = occ.get(slot);
    const num = h('span', { class: 'slot-num num' }, slot);
    const ph = h('span', { class: ['slot-phase', 'ph-' + phase] }, phase);
    if (!spaceTaken(o)) {
      return h('div', { class: ['slot', 'empty', side], dataset: { slot } }, num, ph,
        h('div', { class: 'slot-empty-actions' },
          h('button', { class: 'slot-add', type: 'button', onClick: () => addCircuit(slot), 'aria-label': `Add breaker at space ${slot}` }, ui.icon('plus', 16), 'Add breaker'),
          tandemsAllowed() ? h('button', { class: 'slot-add tandem', type: 'button', onClick: () => addTandem(slot), 'aria-label': `Add a tandem (half-space) breaker at space ${slot}` }, ui.icon('plus', 16), 'Tandem') : null,
          h('button', { class: 'slot-add tpl', type: 'button', onClick: () => openTemplatePicker(slot), 'aria-label': `Add breaker from a template at space ${slot}` }, ui.icon('copy', 16), 'Template')));
    }
    if (o.full && !o.start) {
      return h('div', { class: ['slot', 'cont', side], dataset: { slot } }, num, ph, h('span', { class: 'slot-cont muted' }, `↳ ${o.full.poles}-pole from ${o.full.slot}`));
    }
    if (o.full) {
      const f = breakerFields(o.full, slot, colours);
      return h('div', { class: ['slot', 'used', side, f.over ? 'over' : null, o.full.subFeed ? 'subfeed' : null], dataset: { slot } }, num, ph, f.node);
    }
    // Tandem space: an A row over a B row; an empty half offers to add one.
    const halfBlock = (letter) => {
      const hc = o[letter];
      if (!hc) {
        return h('div', { class: ['slot-half', 'empty'], dataset: { slot, half: letter } },
          h('button', { class: 'slot-add tandem', type: 'button', onClick: () => addTandem(slot, letter), 'aria-label': `Add tandem ${letter} at space ${slot}` }, ui.icon('plus', 16), `Tandem ${letter}`),
          h('button', { class: 'slot-add tpl', type: 'button', onClick: () => openTemplatePicker(slot, letter), 'aria-label': `Add tandem ${letter} from a template at space ${slot}` }, ui.icon('copy', 16), 'Template'));
      }
      const f = breakerFields(hc, slot, colours);
      return h('div', { class: ['slot-half', f.over ? 'over' : null, hc.subFeed ? 'subfeed' : null], dataset: { slot, half: letter } },
        h('span', { class: 'slot-half-tag', title: `Half ${letter}` }, letter), f.node);
    };
    return h('div', { class: ['slot', 'used', 'tandem', side] }, num, ph,
      h('div', { class: 'slot-halves' }, halfBlock('A'), halfBlock('B')));
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
    const typeTag = (c) => (c.breakerType && c.breakerType !== 'standard' ? ' ' + PT.breakerTypeLabel(c.breakerType) : '');
    const descCell = (c) => h('td', null, h('span', { class: 'print-swatches' }, circuitSwatches(c, colours)),
      ` ${c.description || '—'}${c.subFeed ? ' (sub-feed)' : ''}`);
    // A half line inside a tandem space: the letter, its swatch, description and rating, each on its own line.
    const halfDescLine = (c, letter) => c
      ? h('div', { class: 'print-half' }, h('strong', null, letter + ': '), h('span', { class: 'print-swatches' }, circuitSwatches(c, colours)), ` ${c.description || '—'}${c.subFeed ? ' (sub-feed)' : ''}`)
      : h('div', { class: 'print-half muted' }, `${letter}: —`);
    const halfRateLine = (c) => c ? h('div', { class: 'print-half' }, `${c.amps}A 1P${typeTag(c)}`) : h('div', { class: 'print-half' }, '');
    const cell = (slot) => {
      const o = occ.get(slot);
      if (!spaceTaken(o)) return [h('td', { class: 'num' }, slot), h('td', null, 'Spare / space'), h('td', null, '')];
      if (o.full && !o.start) return [h('td', { class: 'num' }, slot), h('td', null, `↳ ${o.full.slot}`), h('td', null, '')];
      if (o.full) {
        const c = o.full;
        return [h('td', { class: 'num' }, slot), descCell(c), h('td', { class: 'num' }, `${c.amps}A ${c.poles}P${typeTag(c)}`)];
      }
      // tandem space: both halves, each its own line with its phase colour.
      return [h('td', { class: 'num' }, slot),
        h('td', null, halfDescLine(o.A, 'A'), halfDescLine(o.B, 'B')),
        h('td', { class: 'num' }, halfRateLine(o.A), halfRateLine(o.B))];
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
