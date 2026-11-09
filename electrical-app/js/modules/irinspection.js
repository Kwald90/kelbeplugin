// Thermal / IR inspection report (#/irinspection): a thermographic survey of electrical gear, good
// for service-agreement PM. Header (target, job/asset, date, camera, emissivity), a list of findings
// (location, measured/reference °C, ΔT, a severity band, a recommended action, a thermal + a visible
// photo), an overall summary and a printable report.
//   #/irinspection          the list
//   #/irinspection/:id       one report (findings editor)
// Pure logic: js/lib/irinspection.js.
import {
  newInspection, newFinding, computeDelta, findingSeverity, summarize, sortFindings, severityLabel,
  inspectionLabel, SEVERITY_BANDS, severityOf, MAX_FINDINGS,
} from '../lib/irinspection.js';
import { photoStrip } from '../lib/safety-capture.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/irinspection.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/irinspection.css';
  document.head.append(link);
}

export default {
  id: 'irinspection',
  title: 'Thermal / IR inspection',
  icon: 'activity',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { const r = ctx.store.add('irInspections', newInspection({ by: ctx.store.actorId, date: ctx.ui.today() })); ctx.nav(`#/irinspection/${r.id}`); return; }
    if (sub) return detail(root, ctx, sub);
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');
const sevTone = { none: 'success', investigate: 'info', 'repair-scheduled': 'warning', 'repair-immediate': 'danger' };

function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const all = store.list('irInspections').sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    host.append(all.length ? ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (r) => ui.fmtDate(r.date || r.createdAt), sort: (r) => r.date || r.createdAt },
        { key: 'target', label: 'Target', render: (r) => (r.target || '—') },
        { key: 'job', label: 'Job', render: (r) => jobLabel(jobs.get(r.jobId)) },
        { key: 'n', label: 'Findings', align: 'right', render: (r) => (r.findings || []).length },
        { key: 'worst', label: 'Worst', render: (r) => { const s = summarize(r.findings); return ui.badge(severityLabel(s.worst), sevTone[s.worst] || 'neutral'); } },
      ],
      rows: all, onRowClick: (r) => nav(`irinspection/${r.id}`),
    }) : ui.empty({ icon: 'activity', title: 'No IR inspections yet', text: 'Record a thermographic survey of panels and gear: each hot spot with its temperature, ΔT, severity and a thermal + visible photo — a report for the client and the service file.', action: ui.button('New inspection', { variant: 'primary', icon: 'plus', href: '#/irinspection/new' }) }));
  };
  root.append(ui.page({ title: 'Thermal / IR inspection', subtitle: 'Infrared surveys of electrical equipment, with severity and a printable report', actions: [ui.button('New inspection', { variant: 'primary', icon: 'plus', href: '#/irinspection/new' })] }, host));
  draw();
  return store.on('irInspections', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function detail(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const r = store.get('irInspections', id);
  if (!r) { ui.toast('That inspection is gone.', 'error'); nav('#/irinspection'); return; }
  r.findings = r.findings || [];
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const save = (patch) => store.update('irInspections', id, patch);
  const assetsFor = () => store.list('assets', (x) => !r.clientId || x.clientId === r.clientId);
  const collect = () => ({
    jobId: r.jobId, clientId: r.clientId, assetId: r.assetId, target: r.target, date: r.date,
    inspector: r.inspector, instrument: r.instrument, emissivity: r.emissivity, ambientC: r.ambientC,
    summary: r.summary, notes: r.notes,
  });

  const worstBadge = h('span');
  const drawWorst = () => { const s = summarize(r.findings); ui.clear(worstBadge).append(ui.badge(severityLabel(s.worst), sevTone[s.worst] || 'neutral')); };

  const fieldEl = (f, onVal, delay = 400) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); clearTimeout(el._t); el._t = setTimeout(() => save(collect()), delay); });
    return el;
  };

  const grid = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Job (optional)', name: 'jobId', type: 'select', value: r.jobId || '', options: [{ value: '', label: '—' }, ...ui.recordOptions(jobs, (j) => `${j.number} - ${j.title}`)] }, (v) => { r.jobId = v || null; const j = v && store.get('jobs', v); if (j) { r.clientId = j.clientId || r.clientId; if (!r.target) r.target = j.title || ''; } }, 0),
    fieldEl({ label: 'Asset (optional)', name: 'assetId', type: 'select', value: r.assetId || '', options: [{ value: '', label: '—' }, ...assetsFor().map((x) => ({ value: x.id, label: x.name || x.model || 'Asset' }))] }, (v) => { r.assetId = v || null; const a = v && store.get('assets', v); if (a && !r.target) r.target = a.name || ''; }, 0),
    fieldEl({ label: 'Target', name: 'target', value: r.target, placeholder: 'Panel / equipment surveyed', span: true }, (v) => { r.target = v; }),
    fieldEl({ label: 'Survey date', name: 'date', type: 'date', value: r.date }, (v) => { r.date = v; }, 0),
    fieldEl({ label: 'Inspector', name: 'inspector', value: r.inspector, placeholder: 'Who surveyed' }, (v) => { r.inspector = v; }),
    fieldEl({ label: 'Camera / instrument', name: 'instrument', value: r.instrument, placeholder: 'e.g. FLIR E8' }, (v) => { r.instrument = v; }),
    fieldEl({ label: 'Emissivity', name: 'emissivity', type: 'number', value: r.emissivity ?? '', placeholder: 'e.g. 0.95' }, (v) => { r.emissivity = v === '' ? null : Number(v); }),
    fieldEl({ label: 'Ambient (°C)', name: 'ambientC', type: 'number', value: r.ambientC ?? '' }, (v) => { r.ambientC = v === '' ? null : Number(v); }),
    fieldEl({ label: 'Overall summary', name: 'summary', type: 'textarea', value: r.summary, span: true, placeholder: 'Condition of the equipment surveyed' }, (v) => { r.summary = v; }, 600),
    fieldEl({ label: 'Notes', name: 'notes', type: 'textarea', value: r.notes, span: true }, (v) => { r.notes = v; }, 600));

  // ---- findings ----
  const summaryEl = h('div', { class: 'ir-summary muted' });
  const drawSummary = () => { const s = summarize(r.findings); ui.clear(summaryEl).append(`${s.total} finding${s.total === 1 ? '' : 's'} · ${s['repair-immediate']} immediate · ${s['repair-scheduled']} scheduled · ${s.investigate} investigate`); };

  const findHost = h('div', { class: 'ir-findings' });
  function drawFindings() {
    ui.clear(findHost);
    r.findings.forEach((f, i) => findHost.append(findingCard(f, i)));
    if (r.findings.length < MAX_FINDINGS) findHost.append(h('button', { type: 'button', class: 'ir-addrow', onClick: () => { r.findings.push(newFinding()); save({ findings: r.findings }); drawFindings(); drawWorst(); } }, ui.icon('plus', 16), 'Add finding'));
    drawSummary();
  }
  function findingCard(f, i) {
    f.thermalPhotos = f.thermalPhotos || [];
    f.visiblePhotos = f.visiblePhotos || [];
    const bump = () => { clearTimeout(f._t); f._t = setTimeout(() => { save({ findings: r.findings }); }, 350); };
    const sevBadge = h('span', { class: 'ir-sevbadge' });
    const deltaOut = h('span', { class: 'ir-delta' });
    const sevSel = h('select', { class: 'input', 'aria-label': 'Severity' },
      [{ id: '', label: 'Auto from ΔT' }, ...SEVERITY_BANDS.map((b) => ({ id: b.id, label: b.label }))].map((o) => h('option', { value: o.id, selected: (f.severity || '') === o.id }, o.label)));
    const refresh = () => {
      const d = computeDelta(f);
      f.deltaC = d;
      ui.clear(deltaOut).append(d == null ? 'ΔT —' : `ΔT ${d > 0 ? '+' : ''}${d} °C`);
      const sv = findingSeverity(f);
      ui.clear(sevBadge).append(ui.badge(severityLabel(sv), sevTone[sv] || 'neutral'));
      if (!f.action) { const suggested = severityOf(sv).action; if (actionInput.value === '') actionInput.placeholder = suggested; }
    };
    const loc = h('input', { class: 'input', value: f.location || '', placeholder: 'Location (e.g. Panel A, breaker 12)', 'aria-label': 'Location' });
    loc.addEventListener('input', () => { f.location = loc.value.slice(0, 200); bump(); });
    const comp = h('input', { class: 'input', value: f.component || '', placeholder: 'Component', 'aria-label': 'Component' });
    comp.addEventListener('input', () => { f.component = comp.value.slice(0, 200); bump(); });
    const load = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: 'any', value: f.loadAmps ?? '', placeholder: 'A', 'aria-label': 'Load (A)' });
    load.addEventListener('input', () => { f.loadAmps = load.value === '' ? null : Number(load.value); bump(); });
    const meas = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: 'any', value: f.measuredC ?? '', placeholder: '°C', 'aria-label': 'Measured °C' });
    meas.addEventListener('input', () => { f.measuredC = meas.value === '' ? null : Number(meas.value); refresh(); bump(); });
    const ref = h('input', { class: 'input num', type: 'number', inputmode: 'decimal', step: 'any', value: f.referenceC ?? '', placeholder: '°C', 'aria-label': 'Reference / ambient °C' });
    ref.addEventListener('input', () => { f.referenceC = ref.value === '' ? null : Number(ref.value); refresh(); bump(); });
    sevSel.addEventListener('change', () => { f.severity = sevSel.value; refresh(); bump(); });
    const actionInput = h('input', { class: 'input', value: f.action || '', placeholder: 'Recommended action', 'aria-label': 'Recommended action' });
    actionInput.addEventListener('input', () => { f.action = actionInput.value.slice(0, 500); bump(); });
    const notes = h('input', { class: 'input', value: f.notes || '', placeholder: 'Notes', 'aria-label': 'Finding notes' });
    notes.addEventListener('input', () => { f.notes = notes.value.slice(0, 1000); bump(); });
    const rm = ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove finding', onClick: () => { r.findings.splice(i, 1); save({ findings: r.findings }); drawFindings(); drawWorst(); } });

    const photos = h('div', { class: 'ir-photos' },
      h('div', { class: 'ir-photoblock' }, h('span', { class: 'ir-photolbl muted' }, 'Thermal'), photoStrip({ photos: f.thermalPhotos, max: 1, label: 'Thermal', toast: ui.toast, onChange: () => save({ findings: r.findings }) })),
      h('div', { class: 'ir-photoblock' }, h('span', { class: 'ir-photolbl muted' }, 'Visible'), photoStrip({ photos: f.visiblePhotos, max: 1, label: 'Visible', toast: ui.toast, onChange: () => save({ findings: r.findings }) })));

    const card = h('div', { class: 'ir-finding' },
      h('div', { class: 'ir-finding-top' }, h('span', { class: 'ir-fnum' }, `#${i + 1}`), loc, deltaOut, sevBadge, rm),
      h('div', { class: 'ir-grid' },
        labeled('Component', comp), labeled('Load (A)', load), labeled('Measured °C', meas), labeled('Reference °C', ref),
        labeled('Severity', sevSel), labeled('Recommended action', actionInput)),
      labeled('Notes', notes),
      photos);
    refresh();
    return card;
    function labeled(lbl, el) { return h('label', { class: 'ir-f' }, h('span', { class: 'ir-flbl' }, lbl), el); }
  }

  const remove = async () => { if (!(await ui.confirmDialog('Delete this IR inspection?', { okLabel: 'Delete' }))) return; store.remove('irInspections', id); ui.toast('Inspection deleted'); nav('#/irinspection'); };

  root.append(ui.page({
    title: inspectionLabel(r),
    subtitle: h('span', null, ui.h('a', { href: '#/irinspection' }, 'Thermal / IR inspection'), ' / survey'),
    actions: [worstBadge, ui.button('Print report', { icon: 'printer', onClick: () => printReport(ctx, r) }), ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete', onClick: remove })],
  },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Survey'), grid),
      h('section', { class: 'card' }, h('div', { class: 'row ir-findhead' }, h('h3', null, 'Findings'), h('span', { class: 'grow' }), summaryEl),
        h('p', { class: 'muted ir-hint' }, 'Severity is suggested from ΔT using common NETA thermographic bands; the governing standard and the AHJ decide the real thresholds, so override any finding as needed.'),
        findHost),
      h('div', { class: 'row' }, ui.button('Back to inspections', { variant: 'ghost', href: '#/irinspection' })))));
  drawWorst();
  drawFindings();
}

// ---------- print: IR inspection report ----------
function printReport(ctx, r) {
  const { store, ui } = ctx;
  const { h } = ui;
  const co = store.settings().company || {};
  const job = r.jobId ? store.get('jobs', r.jobId) : null;
  const client = r.clientId ? store.get('clients', r.clientId) : null;
  const asset = r.assetId ? store.get('assets', r.assetId) : null;
  const sum = summarize(r.findings || []);
  const findings = sortFindings(r.findings || []);

  const node = h('div', { class: 'ir-print' }, h('article', { class: 'ir-doc' },
    h('header', { class: 'ir-doc-top' },
      h('div', null, h('div', { class: 'ir-doc-brand' }, co.name || 'Company'), h('div', { class: 'ir-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'ir-doc-right' }, h('div', { class: 'ir-doc-kind' }, 'Thermographic inspection'), h('div', null, ui.fmtDate(r.date || new Date())))),
    h('h1', null, 'Infrared (IR) inspection report'),
    h('p', { class: 'ir-doc-small' }, [r.target || 'Equipment', asset?.name, client?.name, job ? jobLabel(job) : null].filter(Boolean).join(' · ')),
    h('table', { class: 'ir-kv' }, h('tbody', null,
      h('tr', null, h('th', null, 'Inspector'), h('td', null, r.inspector || '—'), h('th', null, 'Camera'), h('td', null, r.instrument || '—')),
      h('tr', null, h('th', null, 'Emissivity'), h('td', null, r.emissivity ?? '—'), h('th', null, 'Ambient'), h('td', null, r.ambientC != null ? `${r.ambientC} °C` : '—')),
      h('tr', null, h('th', null, 'Findings'), h('td', null, String(sum.total)), h('th', null, 'Immediate / scheduled'), h('td', null, `${sum['repair-immediate']} / ${sum['repair-scheduled']}`)))),
    r.summary ? [h('h2', null, 'Summary'), h('p', null, r.summary)] : null,
    h('h2', null, `Findings (${sum.total})`),
    findings.length ? findings.map((f, i) => {
      const sv = findingSeverity(f);
      const d = computeDelta(f);
      const thermal = (f.thermalPhotos || [])[0];
      const visible = (f.visiblePhotos || [])[0];
      return h('div', { class: 'ir-doc-finding' },
        h('div', { class: 'ir-doc-fhead' }, h('strong', null, `${i + 1}. ${f.location || 'Finding'}`), h('span', { class: `ir-doc-sev ir-sev-${sv}` }, severityLabel(sv))),
        h('p', { class: 'ir-doc-small' }, [
          f.component ? `Component: ${f.component}` : null,
          f.loadAmps != null ? `Load: ${f.loadAmps} A` : null,
          f.measuredC != null ? `Measured: ${f.measuredC} °C` : null,
          f.referenceC != null ? `Reference: ${f.referenceC} °C` : null,
          d != null ? `ΔT: ${d > 0 ? '+' : ''}${d} °C` : null,
        ].filter(Boolean).join(' · ') || '—'),
        f.action ? h('p', null, h('strong', null, 'Action: '), f.action) : (sv !== 'none' ? h('p', null, h('strong', null, 'Action: '), severityOf(sv).action) : null),
        f.notes ? h('p', { class: 'ir-doc-small' }, f.notes) : null,
        (thermal || visible) ? h('div', { class: 'ir-doc-imgs' },
          thermal ? h('figure', null, h('img', { src: thermal.dataUrl, alt: 'Thermal' }), h('figcaption', null, 'Thermal')) : null,
          visible ? h('figure', null, h('img', { src: visible.dataUrl, alt: 'Visible' }), h('figcaption', null, 'Visible')) : null) : null);
    }) : h('p', null, 'No findings recorded.'),
    r.notes ? [h('h2', null, 'Notes'), h('p', null, r.notes)] : null,
    h('p', { class: 'ir-doc-foot' }, 'Severity bands are NETA-style ΔT guidance; the governing standard and the authority having jurisdiction determine the required action.')));

  document.body.append(node);
  document.body.classList.add('ir-printing');
  const done = () => { node.remove(); document.body.classList.remove('ir-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
