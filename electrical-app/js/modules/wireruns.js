// Wire runs: named, saved runs measured with an AR tape, traced on a drawing or
// typed in, with drops and box allowances, totals per conductor, suggested rolls,
// a PDF report and "add to estimate". The maths lives in js/lib/wireruns.js.
import { getUnits, fmtLength, parseLength, M_PER_FT } from '../lib/units.js';
import * as W from '../lib/wireruns.js';
import { getArSupport, measurePath, isCancelled, AR_TIPS } from '../lib/ar-measure.js';
import { BRAND } from '../brand.js';

// Icons drawn for this screen (24px grid, stroke), passed to ui.icon() as markup.
const ICON_AR = '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M12 8.5v7M8.5 12h7"/><circle cx="12" cy="12" r="1"/>';
const ICON_SHARE = '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/>';
const ICON_TABLE = '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>';

const MAX_PHOTOS = 12;
const PHOTO_MAX_SIDE = 1600;
const PHOTO_MAX_BYTES = 400 * 1024;
const TIPS_KEY = 'ft.wireruns.arTipsSeen';
const LIGHT_PAPER = '#f7f6f2';

export default {
  id: 'wireruns',
  title: 'Wire runs',
  icon: 'ruler',
  group: 'work',
  perm: 'drawings',
  render(root, ctx) {
    const [sub] = ctx.params;
    if (sub === 'new') return createRun(ctx);
    if (sub) return renderEditor(root, ctx, sub);
    return renderList(root, ctx);
  },
};

const unitsFor = (store) => getUnits(store.settings()?.units);
const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '');

function debounce(fn, ms) {
  let t = null;
  const d = () => { clearTimeout(t); t = setTimeout(() => { t = null; fn(); }, ms); };
  d.flush = () => { if (t) { clearTimeout(t); t = null; fn(); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}

function pick(run) {
  const { id, createdAt, updatedAt, ...rest } = run;
  void id; void createdAt; void updatedAt;
  return rest;
}

// ---------- create ----------
function createRun({ store, query }) {
  const job = query.jobId ? store.get('jobs', query.jobId) : null;
  const n = store.count('wireRuns', (r) => (job ? r.jobId === job.id : true)) + 1;
  const rec = store.add('wireRuns', W.newRun({ name: `Run ${n}`, jobId: job?.id || null }));
  location.replace(`#/wireruns/${rec.id}?fresh=1`);
}

// ---------- list ----------
function renderList(root, ctx) {
  const { store, ui, nav, query } = ctx;
  const { h } = ui;
  const units = unitsFor(store);
  let q = '';
  let jobId = query.jobId || '';
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const host = h('div', { class: 'stack' });
  const tableHost = h('div');

  const jobSelect = h('select', {
    class: 'input wr-job-filter', 'aria-label': 'Filter by job',
    onChange: (e) => { jobId = e.target.value; history.replaceState(null, '', '#/wireruns' + (jobId ? '?jobId=' + jobId : '')); draw(); },
  },
  h('option', { value: '' }, 'All jobs'),
  h('option', { value: '__none', selected: jobId === '__none' }, 'Not linked to a job'),
  jobs.map((j) => h('option', { value: j.id, selected: j.id === jobId }, jobLabel(j))));

  const newHref = () => '#/wireruns/new' + (jobId && jobId !== '__none' ? '?jobId=' + jobId : '');

  const menu = (r) => {
    const s = ui.openSheet({
      title: r.name || 'Wire run', dialog: true,
      body: h('div', { class: 'list' },
        h('button', { type: 'button', class: 'list-row click wr-menu-row', onClick: () => { s.close(); renameRun(ctx, r); } }, ui.icon('edit', 18), 'Rename'),
        h('button', { type: 'button', class: 'list-row click wr-menu-row', onClick: () => { s.close(); const c = store.add('wireRuns', W.duplicateRun(r)); ui.toast(`Duplicated as ${c.name}`, 'success'); } }, ui.icon('copy', 18), 'Duplicate'),
        h('button', { type: 'button', class: 'list-row click wr-menu-row danger', onClick: () => { s.close(); deleteRun(ctx, r); } }, ui.icon('trash', 18), 'Delete')),
    });
  };

  function draw() {
    ui.clear(host);
    const all = store.list('wireRuns');
    const rows = W.filterRuns(all, { jobId, jobs }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const totals = new Map(rows.map((r) => [r.id, W.runTotals(r)]));
    const sumOf = (k) => rows.reduce((s, r) => s + totals.get(r.id)[k], 0);
    h(host, null,
      h('div', { class: 'grid wr-stats' },
        ui.stat({ label: 'Runs', value: String(rows.length), hint: jobId && jobId !== '__none' ? jobLabel(jobById.get(jobId)) : 'All jobs' }),
        ui.stat({ label: 'Measured', value: W.fmtTotal(sumOf('runM'), units), hint: 'Sum of segments' }),
        ui.stat({ label: 'Wire to pull', value: W.fmtTotal(sumOf('conductorM'), units), hint: 'All conductors, with allowances', tone: 'accent' })),
      h('div', { class: 'row' }, ui.searchBox('Search runs', (v) => { q = v; drawTable(); }, q), jobSelect),
      tableHost);
    drawTable();

    function drawTable() {
      const list = W.filterRuns(rows, { q, jobs });
      ui.clear(tableHost);
      tableHost.append(ui.table({
        columns: [
          { key: 'name', label: 'Run', render: (r) => h('div', null, h('div', { class: 'wr-name' }, r.name || 'Untitled run'), r.location ? h('div', { class: 'muted wr-sub' }, r.location) : null), sort: (r) => (r.name || '').toLowerCase() },
          { key: 'job', label: 'Job', render: (r) => (jobById.get(r.jobId) ? jobLabel(jobById.get(r.jobId)) : '—'), sort: (r) => jobById.get(r.jobId)?.number || '' },
          { key: 'method', label: 'Method', render: (r) => W.methodLabel(W.normalizeRun(r)) },
          { key: 'run', label: 'Run length', align: 'right', render: (r) => W.fmtTotal(totals.get(r.id).runM, units), sort: (r) => totals.get(r.id).runM },
          { key: 'wire', label: 'Wire', align: 'right', render: (r) => W.fmtTotal(totals.get(r.id).conductorM, units), sort: (r) => totals.get(r.id).conductorM },
          { key: 'updated', label: 'Updated', render: (r) => ui.fmtDate(r.updatedAt), sort: (r) => r.updatedAt || '' },
          { key: 'more', label: '', render: (r) => {
            const b = ui.button('', { variant: 'ghost', size: 'sm', icon: 'more', title: `More for ${r.name || 'run'}`, onClick: (e) => { e.stopPropagation(); menu(r); } });
            b.addEventListener('keydown', (e) => e.stopPropagation()); // Enter opens the menu, not the row
            return b;
          } },
        ],
        rows: list,
        onRowClick: (r) => nav('#/wireruns/' + r.id),
        empty: ui.empty({
          icon: 'ruler', title: all.length ? 'No runs match' : 'No wire runs yet',
          text: all.length ? 'Try another search or job.' : 'Measure a run with the AR tape, trace it on a plan, or type the lengths in. Then get totals per conductor, rolls to buy and a PDF.',
          action: all.length ? null : ui.button('New run', { variant: 'primary', icon: 'plus', href: newHref() }),
        }),
      }));
    }
  }

  root.append(ui.page({
    title: 'Wire runs',
    subtitle: 'Measure runs along walls and conduit, add allowances, and see how much wire to pull and buy.',
    actions: [ui.button('New run', { variant: 'primary', icon: 'plus', onClick: () => nav(newHref()) })],
  }, host));
  draw();
  return store.on('wireRuns', draw);
}

async function renameRun({ store, ui }, r) {
  const name = await ui.promptDialog('Name', { title: 'Rename run', value: r.name || '', okLabel: 'Rename' });
  if (name == null || !name.trim()) return null;
  store.update('wireRuns', r.id, { name: name.trim() });
  return name.trim();
}

async function deleteRun({ store, ui }, r) {
  if (!(await ui.confirmDialog(`Delete "${r.name || 'this run'}"? Its segments and photos go too. This can't be undone.`, { okLabel: 'Delete' }))) return false;
  store.remove('wireRuns', r.id);
  ui.toast('Run deleted');
  return true;
}

// ---------- editor ----------
function renderEditor(root, ctx, id) {
  const { store, ui, nav, auth, query } = ctx;
  const { h } = ui;
  const rec = store.get('wireRuns', id);
  if (!rec) {
    root.append(ui.page({ title: 'Run not found' }, ui.empty({ icon: 'ruler', title: 'This wire run no longer exists', action: ui.button('All wire runs', { href: '#/wireruns' }) })));
    return;
  }
  const run = W.normalizeRun(rec);
  const units = unitsFor(store);
  const imperial = units === 'imperial';
  const BARE = imperial ? 'ft' : 'm';
  const BARE_SMALL = imperial ? 'in' : 'mm';
  let removed = false;

  const save = debounce(() => {
    if (removed) return;
    store.update('wireRuns', id, { ...pick(run), totalM: W.runTotals(run).totalM });
  }, 450);
  const changed = () => { refreshTotals(); save(); };

  // ----- small form helpers -----
  const fmtInput = (m) => {
    if (!m) return '';
    if (imperial) return fmtLength(m, { units, denom: 16 });
    return m < 1 ? `${Math.round(m * 1000)} mm` : `${Number(m.toFixed(3))} m`;
  };
  function lengthInput({ value, bare = BARE, label, placeholder, onChange }) {
    const read = () => (input.value.trim() === '' ? 0 : parseLength(input.value, { units, bare }));
    const input = h('input', {
      class: 'input wr-len num', type: 'text', inputmode: imperial ? 'text' : 'decimal', autocomplete: 'off', enterkeyhint: 'done',
      value: fmtInput(value), placeholder: placeholder || (imperial ? (bare === 'in' ? '12"' : `12' 6"`) : (bare === 'mm' ? '300 mm' : '3.5 m')), 'aria-label': label,
      onInput: () => {
        const v = read();
        const bad = v == null || v < 0;
        input.classList.toggle('invalid', bad);
        input.setAttribute('aria-invalid', String(bad));
        if (!bad) onChange(v);
      },
      onBlur: () => { const v = read(); if (v != null && v >= 0 && input.value.trim()) input.value = fmtInput(v); },
    });
    return input;
  }
  const labeled = (label, control, hint) => h('label', { class: 'field' }, h('span', null, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  const textInput = (value, placeholder, onInput, extra = {}) => h('input', { class: 'input', value: value ?? '', placeholder, onInput: (e) => onInput(e.target.value), ...extra });
  const numInput = (value, onInput, extra = {}) => h('input', {
    class: 'input num', type: 'number', inputmode: 'decimal', min: '0', step: '1', value: value ?? '',
    onInput: (e) => onInput(e.target.value === '' ? 0 : Number(e.target.value)), ...extra,
  });
  const iconBtn = (icon, title, onClick, opts = {}) => ui.button('', { variant: opts.danger ? 'ghost danger' : 'ghost', size: 'sm', icon, title, onClick, disabled: opts.disabled });
  const move = (arr, i, d, redraw) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; redraw(); changed(); };

  // ----- details -----
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const detailsHost = h('div', { class: 'form-grid' });
  const nameInput = textInput(run.name, 'e.g. Kitchen feed', (v) => { run.name = v; titleEl.textContent = v || 'Untitled run'; crumbName.textContent = v || 'Untitled run'; save(); }, { required: true, 'aria-label': 'Run name' });
  function drawDetails() {
    ui.clear(detailsHost);
    const method = h('div', { class: 'wr-toggle', role: 'radiogroup', 'aria-label': 'Wiring method' },
      W.METHODS.map((m) => h('button', {
        type: 'button', role: 'radio', class: 'wr-toggle-btn', 'aria-checked': String(run.wiringMethod === m.id),
        onClick: () => {
          if (run.wiringMethod === m.id) return;
          run.wiringMethod = m.id;
          run.conduit = m.id === 'conduit' ? (run.conduit || { type: 'EMT', tradeSize: '21' }) : null;
          drawDetails(); drawConductors(); changed();
        },
      }, m.label)));
    h(detailsHost, null,
      h('label', { class: 'field span-2' }, h('span', null, 'Name *'), nameInput),
      labeled('Job', h('select', { class: 'input', onChange: (e) => { run.jobId = e.target.value || null; save(); } },
        h('option', { value: '' }, '— none —'), jobs.map((j) => h('option', { value: j.id, selected: j.id === run.jobId }, jobLabel(j))))),
      labeled('Location', textInput(run.location, 'e.g. Kitchen, north wall', (v) => { run.location = v; save(); })),
      h('div', { class: 'field' }, h('span', null, 'Wiring method'), method),
      run.wiringMethod === 'conduit' ? labeled('Conduit', h('select', { class: 'input', onChange: (e) => { run.conduit.type = e.target.value; changed(); } },
        W.CONDUIT_TYPES.map((t) => h('option', { value: t.id, selected: t.id === run.conduit.type }, t.label)))) : null,
      run.wiringMethod === 'conduit' ? labeled('Trade size', h('select', { class: 'input', onChange: (e) => { run.conduit.tradeSize = e.target.value; changed(); } },
        W.TRADE_SIZES.map((t) => h('option', { value: t.id, selected: t.id === String(run.conduit.tradeSize) }, t.label)))) : null);
  }

  // ----- segments -----
  const segHost = h('div', { class: 'wr-rows' });
  function drawSegs() {
    ui.clear(segHost);
    if (!run.segments.length) segHost.append(h('div', { class: 'wr-empty muted' }, 'No segments yet. Measure with the AR tape, trace a plan, or type a length.'));
    run.segments.forEach((s, i) => {
      const tone = s.source === 'ar' ? 'info' : s.source === 'plan' ? 'accent' : 'neutral';
      segHost.append(h('div', { class: 'wr-seg' },
        h('span', { class: 'wr-seg-n num', 'aria-hidden': 'true' }, i + 1),
        h('div', { class: 'wr-seg-main' },
          textInput(s.label, 'Label, e.g. Panel to kitchen', (v) => { s.label = v; save(); }, { 'aria-label': `Segment ${i + 1} label` }),
          textInput(s.note, 'Note', (v) => { s.note = v; save(); }, { 'aria-label': `Segment ${i + 1} note`, class: 'input wr-note' })),
        h('div', { class: 'wr-seg-len' },
          lengthInput({ value: s.lengthM, label: `Segment ${i + 1} length`, onChange: (v) => { s.lengthM = v; changed(); } }),
          ui.badge(W.SOURCES[s.source], tone)),
        h('div', { class: 'wr-actions' },
          iconBtn('<path d="M12 19V5M5 12l7-7 7 7"/>', 'Move up', () => move(run.segments, i, -1, drawSegs), { disabled: i === 0 }),
          iconBtn('<path d="M12 5v14M5 12l7 7 7-7"/>', 'Move down', () => move(run.segments, i, 1, drawSegs), { disabled: i === run.segments.length - 1 }),
          iconBtn('trash', 'Delete segment', () => { run.segments.splice(i, 1); drawSegs(); changed(); }, { danger: true }))));
    });
  }
  const addManual = () => {
    run.segments.push(W.newSegment({ label: `Segment ${run.segments.length + 1}`, source: 'manual' }));
    drawSegs(); changed();
    segHost.querySelector('.wr-seg:last-child .wr-len')?.focus();
  };

  // ----- AR -----
  let arSupport = null;
  const arNote = h('span', { class: 'wr-ar-note muted' }, 'Checking for AR…');
  getArSupport().then((s) => {
    arSupport = s;
    arNote.textContent = s.mode === 'native' ? 'AR ready (ARKit)' : s.mode === 'webxr' ? 'AR ready (WebXR)' : 'No AR on this device';
  });
  const addFromAr = () => {
    if (!arSupport) { ui.toast('Still checking for AR, try again in a moment'); return; }
    if (arSupport.mode === 'none') { noArSheet(arSupport.reason); return; }
    let seen = false;
    try { seen = localStorage.getItem(TIPS_KEY) === '1'; } catch { /* storage blocked */ }
    if (seen) startAr(); else arTipsSheet();
  };
  function startAr() {
    // measurePath must start inside the tap handler: WebXR needs the user's gesture.
    measurePath({ units }).then((path) => confirmPath(path, { source: 'ar' })).catch((e) => {
      if (isCancelled(e)) return;
      console.error(e);
      ui.toast(e?.message || 'AR measuring stopped', 'error', 4500);
    });
  }
  function arTipsSheet() {
    const dont = h('input', { type: 'checkbox' });
    const s = ui.openSheet({
      title: 'AR tape', dialog: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'wr-p' }, 'Aim the dot at the wall or conduit. Tap to drop a point at each end and at every bend. Undo removes the last point. Done adds the run.'),
        h('ul', { class: 'wr-tips' }, AR_TIPS.map((t) => h('li', null, t))),
        h('label', { class: 'field check' }, dont, h('span', null, "Don't show this again"))),
      actions: [
        ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Start', { variant: 'primary', icon: ICON_AR, onClick: () => {
          if (dont.checked) { try { localStorage.setItem(TIPS_KEY, '1'); } catch { /* ignore */ } }
          s.close();
          startAr();
        } }),
      ],
    });
  }
  function noArSheet(reason) {
    const s = ui.openSheet({
      title: 'AR measuring is not available here', dialog: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'wr-p' }, reason || 'This device has no AR support.'),
        h('p', { class: 'wr-p muted' }, 'The AR tape works in Chrome on Android phones that support ARCore, and in the Fishtape iOS app. You can still trace the run on a plan or type the length.')),
      actions: [
        ui.button('Close', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Type a length', { icon: 'edit', onClick: () => { s.close(); addManual(); } }),
        ui.button('Trace on a plan', { variant: 'primary', icon: 'pen', onClick: () => { s.close(); addFromPlan(); } }),
      ],
    });
  }

  // ----- plan trace -----
  function addFromPlan() {
    const drawings = store.list('drawings').sort((a, b) =>
      (Number(b.jobId === run.jobId && !!run.jobId) - Number(a.jobId === run.jobId && !!run.jobId)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const s = ui.openSheet({
      title: 'Trace on a plan',
      body: drawings.length ? h('div', { class: 'stack' },
        h('p', { class: 'wr-p muted' }, 'Pick a drawing, then tap points along the route. Lengths come from the drawing scale.'),
        h('div', { class: 'list' }, drawings.map((d) => h('button', {
          type: 'button', class: 'list-row click wr-dw-row',
          onClick: () => { s.close(); traceOn(d); },
        },
        h('span', { class: 'wr-dw-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: '' }) : ui.icon('pen', 20)),
        h('span', { class: 'grow' },
          h('span', { class: 'title' }, d.name || 'Untitled drawing'),
          h('span', { class: 'meta' }, [jobById.get(d.jobId)?.number, d.scale > 0 ? `Scale ${d.scale} px = 1 ft` : 'No scale: you will set one', d.underlay ? 'Plan underlay' : null].filter(Boolean).join(' · '))),
        ui.icon('chevron-right', 18)))))
        : ui.empty({ icon: 'pen', title: 'No drawings yet', text: 'Import a floor plan or sketch one in Plans & drawings, then trace runs on it.', action: ui.button('Plans & drawings', { href: '#/drawings' }) }),
    });
  }
  async function traceOn(d) {
    const res = await traceSheet(ui, d, units);
    if (!res) return;
    const scaleNote = res.calibrated ? `scale set while tracing (${Math.round(res.scale * 10) / 10} px per ft)` : `drawing scale ${res.scale} px per ft`;
    confirmPath(res.path, { source: 'plan', label: `Trace on ${d.name || 'plan'}`, note: `Traced on "${d.name || 'plan'}", ${scaleNote}`, drawingId: d.id });
  }

  // ----- confirm a measured path -----
  function confirmPath(path, { source, label = '', note = '', drawingId = null }) {
    const legs = path.segments || [];
    const labelIn = h('input', { class: 'input', value: label || (source === 'ar' ? `AR path ${run.segments.length + 1}` : 'Plan trace') });
    const split = h('input', { type: 'checkbox' });
    const keepSnap = h('input', { type: 'checkbox', checked: true });
    const s = ui.openSheet({
      title: source === 'ar' ? 'Add AR measurement' : 'Add plan trace', dialog: true,
      body: h('div', { class: 'stack' },
        h('div', { class: 'wr-big num' }, W.fmtSeg(path.totalM, units)),
        legs.length > 1 ? h('ol', { class: 'wr-legs muted' }, legs.map((l) => h('li', { class: 'num' }, W.fmtSeg(l.lengthM, units)))) : null,
        source === 'ar' ? h('p', { class: 'wr-p muted' }, `AR lengths are estimates, typically within about ${W.AR_TYPICAL_ERROR_PCT}% in good conditions.`) : null,
        labeled('Label', labelIn),
        legs.length > 1 ? h('label', { class: 'field check' }, split, h('span', null, `Add each leg as its own segment (${legs.length})`)) : null,
        path.snapshot ? h('img', { class: 'wr-snap', src: path.snapshot, alt: 'AR snapshot' }) : null,
        path.snapshot ? h('label', { class: 'field check' }, keepSnap, h('span', null, 'Save the snapshot with the photos')) : null),
      actions: [
        ui.button('Discard', { variant: 'ghost', onClick: () => s.close() }),
        ui.button('Add', { variant: 'primary', icon: 'check', onClick: () => {
          const segs = W.segmentsFromPath(path, { source, label: labelIn.value.trim(), note, split: split.checked });
          run.segments.push(...segs);
          if (drawingId) run.drawingId = drawingId;
          if (path.snapshot && keepSnap.checked && run.photos.length < MAX_PHOTOS) {
            run.photos.push({ id: W.newId(), dataUrl: path.snapshot, caption: labelIn.value.trim(), takenAt: new Date().toISOString() });
            drawPhotos();
          }
          s.close();
          drawSegs(); changed();
          ui.toast(`Added ${W.fmtSeg(path.totalM, units)}`, 'success');
        } }),
      ],
    });
  }

  // ----- allowances -----
  const allowHost = h('div', { class: 'stack' });
  const liveDrop = [];
  function drawAllowances() {
    ui.clear(allowHost);
    liveDrop.length = 0;
    const a = run.allowances;
    const drops = h('div', { class: 'wr-rows' });
    a.drops.forEach((d, i) => {
      const sub = h('span', { class: 'wr-sub-total num' });
      liveDrop.push(() => { sub.textContent = `= ${W.fmtTotal(d.count * d.lengthM, units)}`; });
      drops.append(h('div', { class: 'wr-drop' },
        textInput(d.label, 'e.g. Receptacles', (v) => { d.label = v; save(); }, { 'aria-label': `Drop ${i + 1} label` }),
        h('span', { class: 'wr-x' }, numInput(d.count, (v) => { d.count = Math.max(0, v || 0); changed(); }, { 'aria-label': `Drop ${i + 1} count` }), '×'),
        lengthInput({ value: d.lengthM, label: `Drop ${i + 1} length each`, onChange: (v) => { d.lengthM = v; changed(); } }),
        sub,
        iconBtn('trash', 'Delete drop', () => { a.drops.splice(i, 1); drawAllowances(); changed(); }, { danger: true })));
    });
    const freeMm = Math.round(W.CEC_FREE_CONDUCTOR_M * 1000);
    h(allowHost, null,
      h('div', null,
        h('div', { class: 'wr-sub-head' }, h('strong', null, 'Drops'), h('span', { class: 'muted' }, 'Down the wall from the ceiling (or up from the floor) to each box')),
        drops,
        ui.button('Add drop', { size: 'sm', icon: 'plus', onClick: () => { a.drops.push({ label: '', count: 1, lengthM: imperial ? 4 * M_PER_FT : 1.2 }); drawAllowances(); changed(); } })),
      h('div', { class: 'form-grid' },
        labeled('Boxes', numInput(a.boxCount, (v) => { a.boxCount = Math.max(0, v || 0); changed(); }, { 'aria-label': 'Number of boxes' })),
        labeled('Makeup per box', lengthInput({ value: a.boxMakeupM, bare: BARE_SMALL, label: 'Makeup per box', onChange: (v) => { a.boxMakeupM = v; changed(); } }),
          `Default ${W.fmtSeg(W.DEFAULT_BOX_MAKEUP_M, units)}: two cable ends × ${freeMm} mm free conductor (${W.CEC_FREE_CONDUCTOR_REF}; 2024 value not yet verified).`),
        labeled('Panel makeup', lengthInput({ value: a.panelMakeupM, label: 'Panel makeup', onChange: (v) => { a.panelMakeupM = v; changed(); } }),
          `To the breaker and neutral bar. About ${W.fmtSeg(W.DEFAULT_PANEL_MAKEUP_M, units)} is usual; 0 if the run doesn't end at a panel.`),
        labeled('Waste %', numInput(a.wastePct, (v) => { a.wastePct = Math.max(0, v || 0); changed(); }, { step: '1', max: '100', 'aria-label': 'Waste percent' }),
          'Covers offsets, bends around framing and measuring error.')));
    liveDrop.forEach((f) => f());
  }

  // ----- conductors -----
  const condHost = h('div', { class: 'wr-rows' });
  const liveCond = new Map();
  const items = store.list('items');
  const pricedItems = W.wireItems(items).sort((a, b) => a.name.localeCompare(b.name));
  const sizeList = h('datalist', { id: `wr-sizes-${id}` });
  const typeList = h('datalist', { id: `wr-types-${id}` });
  function drawConductors() {
    ui.clear(condHost);
    liveCond.clear();
    const cable = run.wiringMethod === 'cable';
    ui.clear(sizeList).append(...(cable ? W.CABLE_SIZES : W.WIRE_SIZES).map((s) => h('option', { value: s })));
    ui.clear(typeList).append(...(cable ? W.CABLE_TYPES : W.WIRE_TYPES).map((s) => h('option', { value: s })));
    if (!run.conductors.length) condHost.append(h('div', { class: 'wr-empty muted' }, 'No conductors. Add the cable or the wires that go in the conduit.'));
    run.conductors.forEach((c, i) => {
      const total = h('strong', { class: 'num' });
      const rolls = h('span', { class: 'muted wr-rolls' });
      liveCond.set(c.id, { total, rolls });
      const desc = textInput(c.description, 'Description', (v) => { c.description = v; changed(); }, { 'aria-label': `Conductor ${i + 1} description` });
      // keep the description in step with type/size/material while it is still the automatic one
      const part = (key) => (v) => {
        const auto = !c.description || c.description === W.autoDescription(c);
        c[key] = v;
        if (auto) { c.description = W.autoDescription(c); desc.value = c.description; }
        changed();
      };
      const itemOpts = [...pricedItems];
      if (c.itemId && !itemOpts.some((it) => it.id === c.itemId)) {
        const it = items.find((x) => x.id === c.itemId);
        itemOpts.push({ id: c.itemId, name: it ? `${it.name} (priced per ${it.unit || '?'}, not a length)` : '(item deleted)', priceCents: it?.priceCents, unit: it?.unit });
      }
      condHost.append(h('div', { class: 'wr-cond' },
        h('div', { class: 'wr-cond-grid' },
          h('label', { class: 'field wr-cond-desc' }, h('span', null, 'Description'), desc),
          labeled('Type', textInput(c.type, cable ? 'NMD90' : 'T90 Nylon', part('type'), { list: typeList.id })),
          labeled('Size', textInput(c.size, cable ? '14/2' : '12', part('size'), { list: sizeList.id })),
          labeled('Material', h('select', { class: 'input', onChange: (e) => part('material')(e.target.value) },
            h('option', { value: 'cu', selected: c.material !== 'al' }, 'Copper'), h('option', { value: 'al', selected: c.material === 'al' }, 'Aluminum'))),
          labeled(cable ? 'Cables per run' : 'Conductors', numInput(c.count, (v) => { c.count = Math.max(0, v || 0); changed(); })),
          h('label', { class: 'field wr-cond-item' }, h('span', null, 'Price book'), h('select', { class: 'input', onChange: (e) => { c.itemId = e.target.value || null; save(); } },
            h('option', { value: '' }, '— none (custom line) —'),
            itemOpts.map((it) => h('option', { value: it.id, selected: it.id === c.itemId }, `${it.name}${it.priceCents != null ? ` · ${ui.fmtMoney(it.priceCents)}/${it.unit}` : ''}`))))),
        h('div', { class: 'wr-cond-foot' },
          h('div', { class: 'wr-cond-out' }, total, rolls),
          iconBtn('trash', 'Delete conductor', () => { run.conductors.splice(i, 1); drawConductors(); changed(); }, { danger: true }))));
    });
    refreshTotals();
  }

  // ----- photos -----
  const photoHost = h('div', { class: 'wr-photos' });
  function drawPhotos() {
    ui.clear(photoHost);
    if (!run.photos.length) photoHost.append(h('div', { class: 'wr-empty muted' }, 'No photos. Add the route, the boxes or the panel for whoever pulls the wire.'));
    run.photos.forEach((p, i) => photoHost.append(h('figure', { class: 'wr-photo' },
      h('img', { src: p.dataUrl, alt: p.caption || `Photo ${i + 1}`, loading: 'lazy' }),
      h('figcaption', null,
        textInput(p.caption, 'Caption', (v) => { p.caption = v; save(); }, { 'aria-label': `Photo ${i + 1} caption` }),
        iconBtn('trash', 'Delete photo', () => { run.photos.splice(i, 1); drawPhotos(); changed(); }, { danger: true })))));
  }
  async function addPhotos() {
    const room = MAX_PHOTOS - run.photos.length;
    if (room <= 0) { ui.toast(`Up to ${MAX_PHOTOS} photos per run`, 'error'); return; }
    const files = (await pickImages()).slice(0, room);
    let added = 0;
    for (const f of files) {
      try {
        const p = await downscaleImage(f);
        run.photos.push({ id: W.newId(), dataUrl: p.dataUrl, caption: '', takenAt: new Date().toISOString(), width: p.width, height: p.height });
        added++;
      } catch (e) { console.error(e); ui.toast(`Couldn't read ${f.name}`, 'error'); }
    }
    if (added) { drawPhotos(); changed(); ui.toast(`Added ${added} photo${added === 1 ? '' : 's'}`, 'success'); }
  }

  // ----- totals -----
  const totalsHost = h('div', { class: 'wr-totals' });
  function refreshTotals() {
    const t = W.runTotals(run);
    const row = (label, v, cls, hint) => h('div', { class: ['wr-trow', cls] }, h('span', null, label, hint ? h('span', { class: 'wr-thint' }, hint) : null), h('span', { class: 'num' }, v));
    ui.clear(totalsHost);
    h(totalsHost, null,
      row('Run length', W.fmtTotal(t.runM, units), null, `${t.segmentCount} segment${t.segmentCount === 1 ? '' : 's'}`),
      t.dropsM ? row('Drops', W.fmtTotal(t.dropsM, units), null, `${t.dropCount} drop${t.dropCount === 1 ? '' : 's'}`) : null,
      t.boxesM ? row('Box makeup', W.fmtTotal(t.boxesM, units), null, `${t.boxCount} × ${W.fmtSeg(t.boxMakeupM, units)}`) : null,
      t.panelM ? row('Panel makeup', W.fmtTotal(t.panelM, units)) : null,
      t.wasteM ? row(`Waste ${t.wastePct}%`, W.fmtTotal(t.wasteM, units)) : null,
      row('Per conductor', W.fmtTotal(t.totalM, units), 'grand'),
      h('div', { class: 'wr-tother muted num' }, W.fmtTotal(t.totalM, imperial ? 'metric' : 'imperial')),
      t.conductors.length ? h('div', { class: 'wr-tconds' }, t.conductors.map((c) => h('div', { class: 'wr-tcond' },
        h('div', { class: 'wr-trow' }, h('span', null, `${c.label}${c.count !== 1 ? ` × ${c.count}` : ''}`), h('strong', { class: 'num' }, W.fmtTotal(c.lengthM, units))),
        h('div', { class: 'muted wr-rolls' }, c.rolls ? [W.rollsLabel(c.rolls, units), W.leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length')))) : null,
      run.wiringMethod === 'conduit' && t.conduitM ? h('div', { class: 'wr-tcond' },
        h('div', { class: 'wr-trow' }, h('span', null, `Conduit ${W.conduitLabel(run)}`), h('strong', { class: 'num' }, W.fmtTotal(t.conduitM, units))),
        h('div', { class: 'muted wr-rolls' }, `About ${t.conduitSticks} sticks of ${W.STICK_M} m (10 ft)`)) : null,
      t.bySource.ar ? h('p', { class: 'wr-caution' }, `${W.fmtTotal(t.bySource.ar, units)} was measured with the AR tape (typically within about ${W.AR_TYPICAL_ERROR_PCT}%). Check critical lengths with a tape.`) : null);
    for (const c of t.conductors) {
      const live = liveCond.get(c.id);
      if (!live) continue;
      live.total.textContent = `${W.fmtTotal(c.lengthM, units)} total`;
      live.rolls.textContent = c.rolls ? [W.rollsLabel(c.rolls, units), W.leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length (8 AWG and up)';
    }
    liveDrop.forEach((f) => f());
  }

  // ----- export -----
  const job = () => (run.jobId ? store.get('jobs', run.jobId) : null);
  const pdfBytes = () => {
    save.flush();
    const s = store.settings();
    const j = job();
    return W.buildRunPdf(run, {
      company: s.company || {}, job: j, client: j?.clientId ? store.get('clients', j.clientId) : null,
      dateLabel: ui.fmtDate(new Date()), units, brand: BRAND.name,
      drawingName: run.drawingId ? store.get('drawings', run.drawingId)?.name || '' : '',
    });
  };
  const downloadPdf = () => {
    try {
      const name = W.runFileName(run, job());
      ui.download(name, new Blob([pdfBytes()], { type: 'application/pdf' }));
      store.log('export', `PDF: ${run.name}`, 'wireRuns', id);
    } catch (e) { console.error(e); ui.toast(`Couldn't make the PDF: ${e.message}`, 'error', 4500); }
  };
  let canShare = false;
  try { canShare = !!navigator.canShare?.({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] }); } catch { canShare = false; }
  const sharePdf = async () => {
    try {
      const file = new File([pdfBytes()], W.runFileName(run, job()), { type: 'application/pdf' });
      await navigator.share({ files: [file], title: run.name || 'Wire run' });
      store.log('export', `PDF shared: ${run.name}`, 'wireRuns', id);
    } catch (e) { if (e?.name !== 'AbortError') ui.toast(`Couldn't share: ${e.message}`, 'error'); }
  };
  const downloadCsv = () => {
    save.flush();
    ui.download(W.runFileName(run, job(), 'csv'), W.runToCsv(run, { units, jobLabel: jobLabel(job()) }), 'text/csv');
    store.log('export', `CSV: ${run.name}`, 'wireRuns', id);
  };
  const print = () => { save.flush(); printRun(ui, run, { store, units, job: job() }); };

  // ----- add to estimate -----
  function addToEstimate() {
    save.flush();
    const j = job();
    const drafts = store.list('estimates', (e) => e.status === 'draft' && (j ? e.jobId === j.id : true))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    let target = drafts[0]?.id || '__new';
    let includeConduit = true;
    let conduitItemId = W.matchConduitItem(run, items)?.id || '';
    const preview = h('div', { class: 'stack' });
    const drawPreview = () => {
      ui.clear(preview);
      const { lines, warnings } = W.estimateLines(run, items, { units, includeConduit, conduitItemId });
      const total = lines.reduce((s, l) => s + Math.round(l.qty * l.unitCents), 0);
      h(preview, null,
        lines.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table wr-est-table' },
          h('thead', null, h('tr', null, h('th', null, 'Line'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Unit'), h('th', { class: 'right' }, 'Amount'))),
          h('tbody', null, lines.map((l) => h('tr', null,
            h('td', null, l.description, l.itemId ? null : h('div', { class: 'muted wr-sub' }, 'Custom line, price it on the estimate')),
            h('td', { class: 'right num' }, ui.fmtNum(l.qty, Number.isInteger(l.qty) ? 0 : 2)),
            h('td', { class: 'right num' }, ui.fmtMoney(l.unitCents)),
            h('td', { class: 'right num' }, ui.fmtMoney(Math.round(l.qty * l.unitCents)))))),
          h('tfoot', null, h('tr', null, h('td', { colspan: '3' }, h('strong', null, 'Adds')), h('td', { class: 'right num' }, h('strong', null, ui.fmtMoney(total))))))) : null,
        warnings.length ? h('ul', { class: 'wr-warn' }, warnings.map((w) => h('li', null, w))) : null);
      addBtn.disabled = !lines.length;
    };
    const conduitOpts = W.conduitItems(items);
    const body = h('div', { class: 'stack' },
      labeled('Estimate', h('select', { class: 'input', onChange: (e) => { target = e.target.value; } },
        drafts.map((e) => h('option', { value: e.id, selected: e.id === target }, `${e.number} · ${e.title || 'Untitled'} (draft)`)),
        h('option', { value: '__new', selected: target === '__new' }, 'New draft estimate')),
      j ? `Draft estimates for ${jobLabel(j)}.` : 'This run is not linked to a job, so a new estimate will not be either.'),
      run.wiringMethod === 'conduit' ? h('div', { class: 'stack' },
        h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: includeConduit, onChange: (e) => { includeConduit = e.target.checked; drawPreview(); } }), h('span', null, `Include the conduit (${W.conduitLabel(run)})`)),
        labeled('Conduit from the price book', h('select', { class: 'input', onChange: (e) => { conduitItemId = e.target.value; drawPreview(); } },
          h('option', { value: '' }, '— none (custom line) —'),
          conduitOpts.map((it) => h('option', { value: it.id, selected: it.id === conduitItemId }, `${it.name} · ${ui.fmtMoney(it.priceCents)}/${it.unit}`))))) : null,
      h('p', { class: 'wr-p muted' }, 'Quantities are the conductor totals with allowances, in each price-book item\'s unit, rounded up.'),
      preview);
    const addBtn = ui.button('Add lines', { variant: 'primary', icon: 'plus', onClick: () => {
      const { lines } = W.estimateLines(run, items, { units, includeConduit, conduitItemId });
      if (!lines.length) return;
      let est;
      if (target === '__new') {
        const s = store.settings();
        est = store.add('estimates', { ...W.newEstimateRecord({ number: store.nextNumber('estimate'), settings: s, job: j, run, validUntil: ui.today(30) }), lines });
      } else {
        const e = store.get('estimates', target);
        if (!e) { ui.toast('That estimate no longer exists', 'error'); return; }
        est = store.update('estimates', e.id, { lines: [...(e.lines || []), ...lines] }, { summary: `${e.number}: wire from ${run.name}` });
      }
      ui.clear(sheet.body).append(h('div', { class: 'stack' },
        h('p', { class: 'wr-p' }, `Added ${lines.length} line${lines.length === 1 ? '' : 's'} to ${est.number}.`)));
      ui.clear(sheet.el.querySelector('.sheet-foot')).append(
        ui.button('Back to the run', { variant: 'ghost', onClick: () => sheet.close() }),
        ui.button(`Open ${est.number}`, { variant: 'primary', icon: 'file-text', onClick: () => { sheet.close(); nav('#/estimates/' + est.id); } }));
    } });
    const sheet = ui.openSheet({ title: 'Add to estimate', body, actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), addBtn] });
    drawPreview();
  }

  // ----- page -----
  const duplicate = () => {
    save.flush();
    const c = store.add('wireRuns', W.duplicateRun(run));
    ui.toast(`Duplicated as ${c.name}`, 'success');
    nav('#/wireruns/' + c.id);
  };
  const remove = async () => {
    save.flush();
    if (await deleteRun(ctx, run)) { removed = true; save.cancel(); nav('#/wireruns'); }
  };

  const crumbName = h('span', null, run.name || 'Untitled run');
  const page = ui.page({
    title: run.name || 'Untitled run',
    subtitle: h('span', null, h('a', { href: '#/wireruns' }, 'Wire runs'), ' / ', crumbName),
    actions: [
      ui.button('PDF', { icon: 'download', variant: 'primary', onClick: downloadPdf }),
      ui.button('Duplicate', { icon: 'copy', onClick: duplicate }),
      ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete run', onClick: remove }),
    ],
  },
  sizeList, typeList,
  h('div', { class: 'wr-layout' },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Details'), detailsHost),
      h('section', { class: 'card' },
        h('div', { class: 'wr-card-head' }, h('h3', null, 'Segments'), arNote),
        segHost,
        h('div', { class: 'row wr-add' },
          ui.button('AR tape', { variant: 'primary', icon: ICON_AR, onClick: addFromAr }),
          ui.button('Trace on a plan', { icon: 'pen', onClick: addFromPlan }),
          ui.button('Type a length', { icon: 'edit', onClick: addManual }))),
      h('section', { class: 'card' }, h('h3', null, 'Allowances'), allowHost),
      h('section', { class: 'card' },
        h('h3', null, run.wiringMethod === 'conduit' ? 'Conductors' : 'Cable and conductors'),
        condHost,
        h('div', { class: 'row wr-add' }, ui.button('Add conductor', { size: 'sm', icon: 'plus', onClick: () => { run.conductors.push(W.newConductor(run.wiringMethod)); drawConductors(); changed(); } }))),
      h('section', { class: 'card' },
        h('div', { class: 'wr-card-head' }, h('h3', null, 'Photos'), h('span', { class: 'muted' }, `${MAX_PHOTOS} max, resized to save space`)),
        photoHost,
        h('div', { class: 'row wr-add' }, ui.button('Add photos', { size: 'sm', icon: 'image', onClick: addPhotos }))),
      h('section', { class: 'card' }, labeled('Notes', h('textarea', { rows: 4, placeholder: 'Route details, obstacles, who pulls it…', onInput: (e) => { run.notes = e.target.value; save(); } }, run.notes)))),
    h('aside', { class: 'wr-side stack' },
      h('section', { class: 'card' }, h('h3', null, 'Totals'), totalsHost),
      h('section', { class: 'card stack' },
        h('h3', null, 'Export'),
        h('div', { class: 'wr-export' },
          ui.button('Download PDF', { icon: 'download', onClick: downloadPdf }),
          canShare ? ui.button('Share PDF', { icon: ICON_SHARE, onClick: sharePdf }) : null,
          ui.button('Print', { icon: 'printer', onClick: print }),
          ui.button('CSV', { icon: ICON_TABLE, onClick: downloadCsv }))),
      auth.can('estimates') ? h('section', { class: 'card stack' },
        h('h3', null, 'Estimate'),
        h('p', { class: 'wr-p muted' }, 'Add the wire for this run to a draft estimate, priced from the price book.'),
        ui.button('Add to estimate', { icon: 'file-text', onClick: addToEstimate })) : null)));
  root.append(page);
  const titleEl = page.querySelector('.page-head h1');

  drawDetails();
  drawSegs();
  drawAllowances();
  drawConductors();
  drawPhotos();
  refreshTotals();
  if (query.fresh) { nameInput.focus(); nameInput.select(); history.replaceState(null, '', '#/wireruns/' + id); }

  return () => { if (!removed) save.flush(); };
}

// ---------- photos ----------
function pickImages() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.style.display = 'none';
    const done = (files) => { input.remove(); resolve(files); };
    input.addEventListener('change', () => done([...(input.files || [])]));
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

const approxBytes = (dataUrl) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Downscale a picked image to a JPEG data URL under PHOTO_MAX_BYTES. */
async function downscaleImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let side = PHOTO_MAX_SIDE, q = 0.72, out = null, w = 0, hgt = 0;
    for (let i = 0; i < 8; i++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      w = Math.max(1, Math.round(img.naturalWidth * k));
      hgt = Math.max(1, Math.round(img.naturalHeight * k));
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      const g = c.getContext('2d');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, hgt);
      g.drawImage(img, 0, 0, w, hgt);
      out = c.toDataURL('image/jpeg', q);
      if (approxBytes(out) <= PHOTO_MAX_BYTES) break;
      if (q > 0.5) q -= 0.1; else side = Math.round(side * 0.8);
    }
    return { dataUrl: out, width: w, height: hgt };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- print ----------
function printRun(ui, run, { store, units, job }) {
  const { h } = ui;
  const t = W.runTotals(run);
  const co = store.settings().company || {};
  const client = job?.clientId ? store.get('clients', job.clientId) : null;
  const tr = (cells, cls) => h('tr', { class: cls }, cells.map((c, i) => h('td', { class: i ? 'right' : null }, c)));
  const node = h('div', { class: 'wr-print' }, h('article', { class: 'wr-doc' },
    h('header', { class: 'wr-doc-top' },
      h('div', null, h('div', { class: 'wr-doc-brand' }, co.name || 'Company'), h('div', { class: 'wr-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'wr-doc-right' }, h('div', { class: 'wr-doc-kind' }, 'Wire run'), h('div', null, ui.fmtDate(new Date())))),
    h('h1', null, run.name || 'Untitled run'),
    h('p', { class: 'wr-doc-small' }, [jobLabel(job), client?.name, job?.address, run.location, W.methodLabel(run)].filter(Boolean).join(' · ')),
    h('h2', null, 'Segments'),
    h('table', null, h('thead', null, h('tr', null, ['#', 'Segment', 'Source', 'Length', 'Note'].map((x) => h('th', null, x)))),
      h('tbody', null, run.segments.map((s, i) => h('tr', null, h('td', null, i + 1), h('td', null, s.label || '—'), h('td', null, W.SOURCES[s.source]), h('td', { class: 'right' }, W.fmtSeg(s.lengthM, units)), h('td', null, s.note || '')))),
      h('tfoot', null, h('tr', null, h('td'), h('td', null, 'Run length'), h('td'), h('td', { class: 'right' }, W.fmtTotal(t.runM, units)), h('td')))),
    h('h2', null, 'Allowances'),
    h('table', null, h('tbody', null,
      t.drops.map((d) => tr([`Drop: ${d.label || 'drop'} (${d.count} × ${W.fmtSeg(d.lengthM, units)})`, W.fmtTotal(d.totalM, units)])),
      tr([`Box makeup (${t.boxCount} × ${W.fmtSeg(t.boxMakeupM, units)}, ${W.CEC_FREE_CONDUCTOR_REF})`, W.fmtTotal(t.boxesM, units)]),
      tr(['Panel makeup', W.fmtTotal(t.panelM, units)]),
      tr([`Waste ${t.wastePct}%`, W.fmtTotal(t.wasteM, units)]),
      tr(['Total per conductor', W.fmtTotal(t.totalM, units)], 'strong'))),
    h('h2', null, 'Conductors'),
    h('table', null, h('thead', null, h('tr', null, ['Conductor', 'Count', 'Total', 'Rolls'].map((x) => h('th', null, x)))),
      h('tbody', null, t.conductors.map((c) => h('tr', null, h('td', null, c.label), h('td', { class: 'right' }, c.count), h('td', { class: 'right' }, W.fmtTotal(c.lengthM, units)),
        h('td', null, c.rolls ? [W.rollsLabel(c.rolls, units), W.leftoverLabel(c.rolls, units)].filter(Boolean).join(', ') : 'Cut to length'))))),
    run.wiringMethod === 'conduit' ? h('p', null, `Conduit ${W.conduitLabel(run)}: ${W.fmtTotal(t.conduitM, units)} with waste, about ${t.conduitSticks} sticks.`) : null,
    run.notes ? [h('h2', null, 'Notes'), h('p', { class: 'wr-doc-notes' }, run.notes)] : null,
    run.photos.length ? [h('h2', null, 'Photos'), h('div', { class: 'wr-doc-photos' }, run.photos.map((p) => h('figure', null, h('img', { src: p.dataUrl, alt: '' }), p.caption ? h('figcaption', null, p.caption) : null)))] : null));
  document.body.append(node);
  document.body.classList.add('wr-printing');
  const done = () => { node.remove(); document.body.classList.remove('wr-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}

// ---------- trace on a drawing ----------
/**
 * Full-screen sheet over a drawing: tap points along the route, live length from the
 * drawing scale (px per foot). Resolves { path, scale, calibrated } or null.
 * Draws the drawing itself (underlay, strokes, symbols as dots) so the canvas module stays untouched.
 */
function traceSheet(ui, drawing, units) {
  const { h } = ui;
  return new Promise((resolve) => {
    let scale = drawing.scale > 0 ? Number(drawing.scale) : null;
    let calibrated = false;
    let mode = scale ? 'trace' : 'calibrate';
    const pts = [];
    let cal = [];
    let straight = false;
    let hover = null;
    const view = { x: 0, y: 0, zoom: 1 };
    let dpr = 1, cw = 0, ch = 0;

    const canvas = h('canvas', { class: 'wr-trace-canvas', 'aria-label': 'Drawing. Tap to add points.' });
    const totalEl = h('strong', { class: 'num' });
    const scaleEl = h('span', { class: 'muted wr-trace-scale' });
    const hint = h('div', { class: 'wr-trace-hint', role: 'status' });
    const undoBtn = ui.button('Undo', { size: 'sm', icon: 'undo', onClick: () => { if (mode === 'calibrate') cal.pop(); else pts.pop(); update(); } });
    const straightBtn = h('button', { type: 'button', class: 'btn sm wr-straight', 'aria-pressed': 'false', title: 'Snap each leg to horizontal or vertical',
      onClick: () => { straight = !straight; straightBtn.setAttribute('aria-pressed', String(straight)); } }, 'Straight');
    const calBtn = ui.button('Set scale', { size: 'sm', icon: 'ruler', onClick: () => { mode = 'calibrate'; cal = []; update(); } });
    const doneBtn = ui.button('Done', { variant: 'primary', icon: 'check', onClick: () => finish(true) });
    const closeBtn = ui.button('', { variant: 'ghost', icon: 'x', title: 'Cancel', onClick: () => finish(false) });
    const el = h('div', { class: 'wr-trace', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Trace on ${drawing.name || 'drawing'}` },
      h('header', { class: 'wr-trace-head' },
        h('div', { class: 'wr-trace-title' }, h('strong', null, drawing.name || 'Drawing'), scaleEl),
        h('div', { class: 'wr-trace-total' }, totalEl),
        h('div', { class: 'wr-trace-tools' }, undoBtn, straightBtn, calBtn, doneBtn, closeBtn)),
      h('div', { class: 'wr-trace-stage' }, canvas, hint));
    document.body.append(el);

    let img = null;
    if (drawing.underlay) { img = new Image(); img.onload = () => draw(); img.src = drawing.underlay; }
    const toM = (px) => W.pxToM(px, scale);
    const fmt = (m) => W.fmtSeg(m, units);
    const lenPx = () => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
    const toWorld = (sx, sy) => [(sx - view.x) / view.zoom, (sy - view.y) / view.zoom];

    function bounds() {
      let b = null;
      const grow = (x0, y0, x1, y1) => { b = b ? [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)] : [x0, y0, x1, y1]; };
      if (drawing.underlay && drawing.underlayW) grow(drawing.underlayX || 0, drawing.underlayY || 0, (drawing.underlayX || 0) + drawing.underlayW, (drawing.underlayY || 0) + drawing.underlayH);
      for (const s of drawing.strokes || []) for (const p of s.points || []) grow(p[0], p[1], p[0], p[1]);
      for (const o of drawing.objects || []) grow(o.x - 15, o.y - 15, o.x + 15, o.y + 15);
      for (const t of drawing.texts || []) grow(t.x, t.y, t.x + 120, t.y + 24);
      return b || [0, 0, 800, 600];
    }
    function fit() {
      const [x0, y0, x1, y1] = bounds();
      const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
      view.zoom = Math.min(cw / bw, ch / bh) * 0.9 || 1;
      view.x = cw / 2 - ((x0 + x1) / 2) * view.zoom;
      view.y = ch / 2 - ((y0 + y1) / 2) * view.zoom;
    }
    function resize() {
      const r = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      cw = r.width; ch = r.height;
      canvas.width = Math.max(1, Math.round(cw * dpr));
      canvas.height = Math.max(1, Math.round(ch * dpr));
      draw();
    }

    function draw() {
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = LIGHT_PAPER;
      g.fillRect(0, 0, cw, ch);
      // one-foot grid when it is big enough to help
      if (scale) {
        let step = scale * view.zoom;
        while (step > 0 && step < 8) step *= 5;
        if (step >= 8) {
          g.strokeStyle = 'rgba(28,27,25,0.08)';
          g.lineWidth = 1;
          g.beginPath();
          for (let x = ((view.x % step) + step) % step; x < cw; x += step) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, ch); }
          for (let y = ((view.y % step) + step) % step; y < ch; y += step) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(cw, Math.round(y) + 0.5); }
          g.stroke();
        }
      }
      g.save();
      g.translate(view.x, view.y);
      g.scale(view.zoom, view.zoom);
      if (img?.complete && img.naturalWidth) {
        g.globalAlpha = drawing.underlayOpacity ?? 1;
        g.drawImage(img, drawing.underlayX || 0, drawing.underlayY || 0, drawing.underlayW || img.naturalWidth, drawing.underlayH || img.naturalHeight);
        g.globalAlpha = 1;
      }
      const hidden = new Set((drawing.layers || []).filter((l) => l.visible === false).map((l) => l.id));
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const s of drawing.strokes || []) {
        if (hidden.has(s.layer) || !s.points?.length) continue;
        const p = s.points;
        g.strokeStyle = s.color || '#1c1b19';
        g.globalAlpha = (s.opacity ?? 1) * (s.tool === 'highlighter' ? 0.38 : 1);
        g.lineWidth = s.size || 2;
        g.beginPath();
        if (s.tool === 'rect') { const [a, c] = [p[0], p[p.length - 1]]; g.rect(a[0], a[1], c[0] - a[0], c[1] - a[1]); }
        else if (s.tool === 'line' || s.tool === 'measure') { g.moveTo(p[0][0], p[0][1]); g.lineTo(p[p.length - 1][0], p[p.length - 1][1]); }
        else { g.moveTo(p[0][0], p[0][1]); for (const q of p) g.lineTo(q[0], q[1]); }
        g.stroke();
      }
      g.globalAlpha = 1;
      g.lineWidth = 1.5;
      for (const o of drawing.objects || []) {
        if (hidden.has(o.layer)) continue;
        g.strokeStyle = o.color || '#1c1b19';
        g.beginPath(); g.arc(o.x, o.y, 9 * (o.scale || 1), 0, Math.PI * 2); g.stroke();
      }
      g.fillStyle = '#1c1b19';
      for (const t of drawing.texts || []) {
        if (hidden.has(t.layer)) continue;
        g.font = `${t.size || 18}px Inter, system-ui, sans-serif`;
        g.textBaseline = 'top';
        String(t.text || '').split('\n').forEach((line, i) => g.fillText(line, t.x, t.y + i * (t.size || 18) * 1.25));
      }
      g.restore();

      // the route, in screen space so it stays crisp
      const sp = (w) => [w[0] * view.zoom + view.x, w[1] * view.zoom + view.y];
      const path = (list, color, width) => {
        if (list.length < 2) return;
        g.strokeStyle = color; g.lineWidth = width;
        g.beginPath();
        list.forEach((w, i) => { const [x, y] = sp(w); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
        g.stroke();
      };
      const route = mode === 'calibrate' ? cal : pts;
      const lineColor = mode === 'calibrate' ? '#1f5fb8' : '#f5b301';
      path(route, 'rgba(28,27,25,0.55)', 7);
      path(route, lineColor, 4);
      if (hover && route.length && (mode === 'trace' || cal.length === 1)) {
        g.setLineDash([6, 6]);
        path([route[route.length - 1], snap(hover)], lineColor, 2);
        g.setLineDash([]);
      }
      for (const w of route) {
        const [x, y] = sp(w);
        g.fillStyle = '#ffffff'; g.strokeStyle = '#1c1b19'; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 5.5, 0, Math.PI * 2); g.fill(); g.stroke();
      }
      if (mode === 'trace' && scale) {
        g.font = '600 12px Inter, system-ui, sans-serif';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        for (let i = 1; i < pts.length; i++) {
          const [ax, ay] = sp(pts[i - 1]), [bx, by] = sp(pts[i]);
          if (Math.hypot(bx - ax, by - ay) < 40) continue;
          const label = fmt(toM(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])));
          const tw = g.measureText(label).width + 12;
          const mx = (ax + bx) / 2, my = (ay + by) / 2;
          g.fillStyle = '#1c1b19';
          g.beginPath(); g.roundRect ? g.roundRect(mx - tw / 2, my - 10, tw, 20, 10) : g.rect(mx - tw / 2, my - 10, tw, 20); g.fill();
          g.fillStyle = '#f5b301';
          g.fillText(label, mx, my + 0.5);
        }
      }
    }

    function snap(w) {
      if (!straight || mode !== 'trace' || !pts.length) return w;
      const last = pts[pts.length - 1];
      return Math.abs(w[0] - last[0]) >= Math.abs(w[1] - last[1]) ? [w[0], last[1]] : [last[0], w[1]];
    }

    function update() {
      if (mode === 'calibrate') {
        totalEl.textContent = 'Set the scale';
        hint.textContent = cal.length ? 'Tap the other end of the known length.' : 'Tap both ends of something you know the length of (a dimension line, a door, a wall).';
      } else {
        totalEl.textContent = pts.length > 1 ? fmt(toM(lenPx())) : '—';
        hint.textContent = pts.length ? 'Tap the next point. Drag to pan, pinch or scroll to zoom.' : 'Tap the start of the run, then each bend and the end. Drag to pan, pinch or scroll to zoom.';
      }
      scaleEl.textContent = scale ? (calibrated ? `Scale set here: ${Math.round(scale * 10) / 10} px = 1 ft` : `Drawing scale: ${scale} px = 1 ft`) : 'No scale on this drawing';
      undoBtn.disabled = mode === 'calibrate' ? !cal.length : !pts.length;
      doneBtn.disabled = mode !== 'trace' || pts.length < 2 || !scale;
      draw();
    }

    async function tapAt(sx, sy) {
      const w = toWorld(sx, sy);
      if (mode === 'calibrate') {
        cal.push(w);
        update();
        if (cal.length < 2) return;
        const px = Math.hypot(cal[1][0] - cal[0][0], cal[1][1] - cal[0][1]);
        const typed = await ui.promptDialog(units === 'imperial' ? 'Real length between the two points (e.g. 12\' 6")' : 'Real length between the two points (e.g. 3.8 m)', { title: 'Set the scale', okLabel: 'Set scale' });
        const m = typed == null ? null : parseLength(typed, { units, bare: units === 'imperial' ? 'ft' : 'm' });
        if (m > 0 && px > 2) { scale = px / (m / M_PER_FT); calibrated = true; mode = 'trace'; }
        else if (typed != null) ui.toast('Could not read that length', 'error');
        cal = [];
        if (!scale) mode = 'calibrate';
        update();
        return;
      }
      pts.push(snap(w));
      update();
    }

    // pointer input: tap adds a point, one finger drags, two fingers pinch, wheel zooms
    const pointers = new Map();
    let gesture = null;
    const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    const pinch = () => {
      const [a, b] = [...pointers.values()];
      return { d: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      const [x, y] = local(e);
      pointers.set(e.pointerId, { x, y });
      if (pointers.size === 1) gesture = { kind: 'tap', sx: x, sy: y, t: performance.now() };
      else if (pointers.size === 2) gesture = { kind: 'pinch', ...pinch(), zoom: view.zoom, vx: view.x, vy: view.y };
    });
    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = local(e);
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') { hover = toWorld(x, y); draw(); }
        return;
      }
      const prev = pointers.get(e.pointerId);
      pointers.set(e.pointerId, { x, y });
      if (!gesture) return;
      if (gesture.kind === 'pinch' && pointers.size === 2) {
        const p = pinch();
        const z = Math.min(40, Math.max(0.02, gesture.zoom * (p.d / Math.max(1, gesture.d))));
        // keep the world point under the first midpoint under the current midpoint
        const wx = (gesture.mx - gesture.vx) / gesture.zoom, wy = (gesture.my - gesture.vy) / gesture.zoom;
        view.zoom = z; view.x = p.mx - wx * z; view.y = p.my - wy * z;
        draw();
      } else if (pointers.size === 1) {
        if (gesture.kind === 'tap' && Math.hypot(x - gesture.sx, y - gesture.sy) > 6) gesture.kind = 'pan';
        if (gesture.kind === 'pan') { view.x += x - prev.x; view.y += y - prev.y; draw(); }
      }
    });
    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      const [x, y] = local(e);
      const g = gesture;
      pointers.delete(e.pointerId);
      if (g?.kind === 'tap' && e.type === 'pointerup' && performance.now() - g.t < 700) tapAt(x, y);
      gesture = pointers.size ? { kind: 'pan' } : null; // a finger left after a pinch only pans
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hover = null; draw(); } });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const z = Math.min(40, Math.max(0.02, view.zoom * k));
      view.x = x - ((x - view.x) / view.zoom) * z;
      view.y = y - ((y - view.y) / view.zoom) * z;
      view.zoom = z;
      draw();
    }, { passive: false });
    const onKey = (e) => {
      if (document.querySelector('.scrim')) return; // a dialog on top handles its own keys
      if (e.key === 'Escape') finish(false);
      else if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') { e.preventDefault(); undoBtn.click(); }
      else if (e.key === 'Enter' && !doneBtn.disabled) finish(true);
    };
    document.addEventListener('keydown', onKey);
    const ro = new ResizeObserver(() => resize());
    ro.observe(canvas);

    let closed = false;
    function finish(ok) {
      if (closed) return;
      closed = true;
      ro.disconnect();
      document.removeEventListener('keydown', onKey);
      el.remove();
      if (!ok || pts.length < 2 || !scale) return resolve(null);
      const points = pts.map(([x, y]) => ({ x: toM(x), y: toM(y), z: 0 }));
      const legs = W.legLengths(points);
      resolve({ path: { totalM: legs.reduce((a, b) => a + b, 0), segments: legs.map((lengthM) => ({ lengthM })), points }, scale, calibrated });
    }

    requestAnimationFrame(() => { resize(); fit(); update(); doneBtn.focus?.(); });
  });
}
