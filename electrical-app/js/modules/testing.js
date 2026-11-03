// Test & commissioning (#/testing): the readings that prove an install — megger, bonding, GFCI
// trip, torque — with pass/fail against a limit and the instrument used.
//   #/testing          the list
//   #/testing/:id       one report (readings editor)
// Pure logic: js/lib/testing.js.
import { newTestReport, newReading, readingPasses, resultFrom, calibrationStale, reportLabel, TEST_TYPES, typeOf, MAX_READINGS } from '../lib/testing.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/testing.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/testing.css';
  document.head.append(link);
}

export default {
  id: 'testing',
  title: 'Testing',
  icon: 'activity',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { const r = ctx.store.add('commissioningTests', newTestReport({ by: ctx.store.actorId, date: ctx.ui.today() })); ctx.nav(`#/testing/${r.id}`); return; }
    if (sub) return detail(root, ctx, sub);
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? `${j.number || ''}${j.number ? ' · ' : ''}${j.title || 'Job'}`.trim() : '—');
const resultTone = { pass: 'success', fail: 'danger', conditional: 'warning' };

function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const all = store.list('commissioningTests').sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    host.append(all.length ? ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (r) => ui.fmtDate(r.date || r.createdAt), sort: (r) => r.date || r.createdAt },
        { key: 'type', label: 'Test', render: (r) => typeOf(r.type).label },
        { key: 'job', label: 'Job', render: (r) => jobLabel(jobs.get(r.jobId)) },
        { key: 'n', label: 'Readings', align: 'right', render: (r) => (r.readings || []).length },
        { key: 'result', label: 'Result', render: (r) => ui.badge(r.result || 'pass', resultTone[r.result] || 'neutral') },
      ],
      rows: all, onRowClick: (r) => nav(`testing/${r.id}`),
    }) : ui.empty({ icon: 'activity', title: 'No test reports yet', text: 'Record insulation resistance, bonding, GFCI trip times and torque with pass/fail against the limit — a commissioning record for inspectors and clients.', action: ui.button('New report', { variant: 'primary', icon: 'plus', href: '#/testing/new' }) }));
  };
  root.append(ui.page({ title: 'Test & commissioning', subtitle: 'Readings that prove the install is safe and works', actions: [ui.button('New report', { variant: 'primary', icon: 'plus', href: '#/testing/new' })] }, host));
  draw();
  return store.on('commissioningTests', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function detail(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const r = store.get('commissioningTests', id);
  if (!r) { ui.toast('That report is gone.', 'error'); nav('#/testing'); return; }
  r.readings = r.readings || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const save = (patch) => store.update('commissioningTests', id, patch);
  const collect = () => ({ jobId: r.jobId, clientId: r.clientId, assetId: r.assetId, title: r.title, type: r.type, date: r.date, technician: r.technician, instrument: r.instrument, instrumentCalDate: r.instrumentCalDate, result: r.result, notes: r.notes });

  const assetsFor = () => store.list('assets', (x) => !r.clientId || x.clientId === r.clientId);
  const resultBadge = h('span');
  const drawResult = () => { const sug = resultFrom(r); ui.clear(resultBadge).append(ui.badge(r.result || sug, resultTone[r.result || sug] || 'neutral')); };

  const fieldEl = (f, onVal, delay = 400) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); clearTimeout(el._t); el._t = setTimeout(() => save(collect()), delay); });
    return el;
  };

  const rowsHost = h('div', { class: 'tc-rows' });
  function drawRows() {
    ui.clear(rowsHost);
    if (r.readings.length) rowsHost.append(h('div', { class: 'tc-rowhead muted' }, h('span', null, 'Point / circuit'), h('span', { class: 'num' }, 'Reading'), h('span', null, 'Unit'), h('span', { class: 'num' }, 'Limit'), h('span', null, 'Dir'), h('span', null, 'Pass'), h('span', null, '')));
    r.readings.forEach((rd, i) => rowsHost.append(readingRow(rd, i)));
    if (r.readings.length < MAX_READINGS) rowsHost.append(h('button', { type: 'button', class: 'tc-addrow', onClick: () => { r.readings.push(newReading(r.type)); save({ readings: r.readings }); drawRows(); drawResult(); } }, ui.icon('plus', 16), 'Add reading'));
  }
  function readingRow(rd, i) {
    const bump = () => { clearTimeout(rd._t); rd._t = setTimeout(() => { save({ readings: r.readings }); drawPass(); drawResult(); }, 350); };
    const point = h('input', { class: 'input', value: rd.point || '', placeholder: 'e.g. Ckt 3 L-G', 'aria-label': 'Point' });
    point.addEventListener('input', () => { rd.point = point.value.slice(0, 200); bump(); });
    const val = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: 'any', value: rd.value ?? '', 'aria-label': 'Reading' });
    val.addEventListener('input', () => { rd.value = val.value === '' ? null : Number(val.value); bump(); });
    const unit = h('input', { class: 'input', value: rd.unit || '', 'aria-label': 'Unit', style: { width: '64px' } });
    unit.addEventListener('input', () => { rd.unit = unit.value.slice(0, 20); bump(); });
    const limit = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: 'any', value: rd.limit ?? '', 'aria-label': 'Limit' });
    limit.addEventListener('input', () => { rd.limit = limit.value === '' ? null : Number(limit.value); bump(); });
    const dir = h('select', { class: 'input', 'aria-label': 'Direction' }, [['', '—'], ['min', '≥'], ['max', '≤']].map(([v, l]) => h('option', { value: v, selected: (rd.direction || '') === v }, l)));
    dir.addEventListener('change', () => { rd.direction = dir.value || null; bump(); });
    const pass = h('span', { class: 'tc-pass' });
    const drawPass = () => { const p = readingPasses(rd); ui.clear(pass).append(p === true ? ui.badge('pass', 'success') : p === false ? ui.badge('fail', 'danger') : ui.badge('—', 'neutral')); };
    drawPass();
    const rm = ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove', onClick: () => { r.readings.splice(i, 1); save({ readings: r.readings }); drawRows(); drawResult(); } });
    return h('div', { class: 'tc-row' }, point, val, unit, limit, dir, pass, rm);
  }

  const typeField = fieldEl({ label: 'Test type', name: 'type', type: 'select', value: r.type, options: TEST_TYPES.map((t) => ({ value: t.id, label: t.label })) }, (v) => { r.type = v; r.title = typeOf(v).label; }, 0);

  const grid = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Job', name: 'jobId', type: 'select', value: r.jobId || '', options: [{ value: '', label: '—' }, ...ui.recordOptions(jobs, (j) => `${j.number} - ${j.title}`)] }, (v) => { r.jobId = v || null; const j = v && store.get('jobs', v); if (j) r.clientId = j.clientId || r.clientId; }, 0),
    typeField,
    fieldEl({ label: 'Asset (optional)', name: 'assetId', type: 'select', value: r.assetId || '', options: [{ value: '', label: '—' }, ...assetsFor().map((x) => ({ value: x.id, label: x.name || x.model || 'Asset' }))] }, (v) => { r.assetId = v || null; }, 0),
    fieldEl({ label: 'Date', name: 'date', type: 'date', value: r.date }, (v) => { r.date = v; }, 0),
    fieldEl({ label: 'Technician', name: 'technician', value: r.technician, placeholder: 'Who tested' }, (v) => { r.technician = v; }),
    fieldEl({ label: 'Test instrument', name: 'instrument', value: r.instrument, placeholder: 'e.g. Fluke 1587' }, (v) => { r.instrument = v; }),
    fieldEl({ label: 'Instrument calibrated', name: 'instrumentCalDate', type: 'date', value: r.instrumentCalDate, hint: 'Calibration date on the certificate' }, (v) => { r.instrumentCalDate = v || null; }, 0),
    fieldEl({ label: 'Result', name: 'result', type: 'select', value: r.result || 'pass', options: [{ value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Fail' }, { value: 'conditional', label: 'Conditional' }] }, (v) => { r.result = v; drawResult(); }, 0),
    fieldEl({ label: 'Notes', name: 'notes', type: 'textarea', value: r.notes, span: true }, (v) => { r.notes = v; }, 600));

  const calWarn = calibrationStale(r, ui.today()) ? h('div', { class: 'tc-warn' }, ui.icon('alert', 16), ' The test instrument looks overdue for calibration — check its certificate.') : null;

  const remove = async () => { if (!(await ui.confirmDialog('Delete this test report?', { okLabel: 'Delete' }))) return; store.remove('commissioningTests', id); ui.toast('Report deleted'); nav('#/testing'); };

  root.append(ui.page({
    title: reportLabel(r),
    subtitle: h('span', null, ui.h('a', { href: '#/testing' }, 'Testing'), ' / ', typeOf(r.type).label),
    actions: [resultBadge, ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete report', onClick: remove })],
  },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Report'), grid, calWarn),
      h('section', { class: 'card' }, h('h3', null, 'Readings'),
        h('p', { class: 'muted tc-hint' }, 'Enter each reading and its limit; pass/fail is worked out from the limit and direction (≥ for insulation resistance, ≤ for continuity and trip time).'),
        rowsHost),
      h('div', { class: 'row' }, ui.button('Back to testing', { variant: 'ghost', href: '#/testing' })))));
  drawResult();
  drawRows();
}
