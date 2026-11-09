// Fire-alarm verification (#/faverification): the CAN/ULC S537 verification a tech records for a
// building — panel/system info, a device list with per-device checks, the standby-battery check, an
// overall result and a printable verification certificate. A documentation / checklist tool: it
// records what the tech observed, it does not compute S537 pass/fail thresholds.
//   #/faverification          the list
//   #/faverification/:id       one verification (device editor + certificate)
// Pure logic: js/lib/faverification.js.
import {
  newVerification, newDevice, deviceResult, summarizeDevices, resultFrom, verificationLabel, resultLabel,
  DEVICE_TYPES, DEVICE_CHECKS, deviceTypeLabel, CHECK_LABEL, RESULTS, MAX_DEVICES,
} from '../lib/faverification.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/faverification.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/faverification.css';
  document.head.append(link);
}

export default {
  id: 'faverification',
  title: 'Fire-alarm verification',
  icon: 'shield',
  group: 'field',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { const r = ctx.store.add('faVerifications', newVerification({ by: ctx.store.actorId, date: ctx.ui.today() })); ctx.nav(`#/faverification/${r.id}`); return; }
    if (sub) return detail(root, ctx, sub);
    return listView(root, ctx);
  },
};

const jobLabel = (j) => (j ? [j.number, j.title].filter(Boolean).join(' · ') : '—');
const resultTone = { pass: 'success', fail: 'danger', incomplete: 'warning' };
const deviceTone = { pass: 'success', fail: 'danger', pending: 'neutral' };

function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const all = store.list('faVerifications').sort((a, b) => String(b.date || b.createdAt).localeCompare(String(a.date || a.createdAt)));
    host.append(all.length ? ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (r) => ui.fmtDate(r.date || r.createdAt), sort: (r) => r.date || r.createdAt },
        { key: 'building', label: 'Building', render: (r) => (r.building || '—') },
        { key: 'job', label: 'Job', render: (r) => jobLabel(jobs.get(r.jobId)) },
        { key: 'n', label: 'Devices', align: 'right', render: (r) => (r.devices || []).length },
        { key: 'result', label: 'Result', render: (r) => ui.badge(resultLabel(r.overallResult), resultTone[r.overallResult] || 'neutral') },
      ],
      rows: all, onRowClick: (r) => nav(`faverification/${r.id}`),
    }) : ui.empty({ icon: 'shield', title: 'No verifications yet', text: 'Record a CAN/ULC S537 fire-alarm verification: every device, what the tech observed, the standby-battery check and a printable certificate for the AHJ and the owner.', action: ui.button('New verification', { variant: 'primary', icon: 'plus', href: '#/faverification/new' }) }));
  };
  root.append(ui.page({ title: 'Fire-alarm verification', subtitle: 'CAN/ULC S537 verification records and certificates', actions: [ui.button('New verification', { variant: 'primary', icon: 'plus', href: '#/faverification/new' })] }, host));
  draw();
  return store.on('faVerifications', () => { if (!document.querySelector('.sheet, .dialog')) draw(); });
}

function detail(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const r = store.get('faVerifications', id);
  if (!r) { ui.toast('That verification is gone.', 'error'); nav('#/faverification'); return; }
  r.devices = r.devices || [];
  r.battery = r.battery || {};
  const jobs = store.list('jobs').sort((a, b) => (b.number || '').localeCompare(a.number || ''));
  const save = (patch) => store.update('faVerifications', id, patch);
  const collect = () => ({
    jobId: r.jobId, clientId: r.clientId, building: r.building, address: r.address, stage: r.stage,
    panelMake: r.panelMake, panelModel: r.panelModel, panelType: r.panelType, zones: r.zones,
    date: r.date, verifierName: r.verifierName, verifierCert: r.verifierCert,
    overallResult: r.overallResult, notes: r.notes,
  });

  const resultBadge = h('span');
  const drawResult = () => { const sug = resultFrom(r); ui.clear(resultBadge).append(ui.badge(resultLabel(r.overallResult || sug), resultTone[r.overallResult || sug] || 'neutral')); };

  const fieldEl = (f, onVal, delay = 400) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); clearTimeout(el._t); el._t = setTimeout(() => save(collect()), delay); });
    return el;
  };

  const grid = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Job (optional)', name: 'jobId', type: 'select', value: r.jobId || '', options: [{ value: '', label: '—' }, ...ui.recordOptions(jobs, (j) => `${j.number} - ${j.title}`)] }, (v) => { r.jobId = v || null; const j = v && store.get('jobs', v); if (j) { r.clientId = j.clientId || r.clientId; if (!r.building) r.building = j.title || ''; if (!r.address) r.address = j.address || ''; } }, 0),
    fieldEl({ label: 'Building', name: 'building', value: r.building, placeholder: 'Building name' }, (v) => { r.building = v; }),
    fieldEl({ label: 'Address', name: 'address', value: r.address, placeholder: 'Street address', span: true }, (v) => { r.address = v; }),
    fieldEl({ label: 'Verification stage', name: 'stage', type: 'select', value: r.stage || 'initial', options: [{ value: 'initial', label: 'Initial verification' }, { value: 'reverification', label: 'Reverification' }, { value: 'annual', label: 'Annual / periodic' }] }, (v) => { r.stage = v; }, 0),
    fieldEl({ label: 'Date', name: 'date', type: 'date', value: r.date }, (v) => { r.date = v; }, 0),
    fieldEl({ label: 'Panel make', name: 'panelMake', value: r.panelMake, placeholder: 'e.g. Mircom' }, (v) => { r.panelMake = v; }),
    fieldEl({ label: 'Panel model', name: 'panelModel', value: r.panelModel, placeholder: 'e.g. FX-2000' }, (v) => { r.panelModel = v; }),
    fieldEl({ label: 'Panel type', name: 'panelType', type: 'select', value: r.panelType || '', options: [{ value: '', label: '—' }, { value: 'conventional', label: 'Conventional' }, { value: 'addressable', label: 'Addressable' }] }, (v) => { r.panelType = v; }, 0),
    fieldEl({ label: 'Zones / circuits', name: 'zones', type: 'number', value: r.zones ?? '', placeholder: 'Count' }, (v) => { r.zones = v === '' ? null : Number(v); }),
    fieldEl({ label: 'Verifier', name: 'verifierName', value: r.verifierName, placeholder: 'Who verified' }, (v) => { r.verifierName = v; }),
    fieldEl({ label: 'Verifier cert / licence', name: 'verifierCert', value: r.verifierCert, placeholder: 'Certification number' }, (v) => { r.verifierCert = v; }),
    fieldEl({ label: 'Overall result', name: 'overallResult', type: 'select', value: r.overallResult || 'incomplete', options: RESULTS.map((v) => ({ value: v, label: resultLabel(v) })) }, (v) => { r.overallResult = v; drawResult(); }, 0),
    fieldEl({ label: 'Notes', name: 'notes', type: 'textarea', value: r.notes, span: true }, (v) => { r.notes = v; }, 600));

  // ---- battery / standby ----
  const batField = (f, onVal, delay = 400) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); clearTimeout(el._t); el._t = setTimeout(() => { save({ battery: r.battery }); drawResult(); }, delay); });
    return el;
  };
  const okOpts = [{ value: '', label: '—' }, { value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Fail' }, { value: 'na', label: 'N/A' }];
  const batteryGrid = h('div', { class: 'form-grid' },
    batField({ label: 'Battery voltage (V)', name: 'voltageV', type: 'number', value: r.battery.voltageV ?? '' }, (v) => { r.battery.voltageV = v === '' ? null : Number(v); }),
    batField({ label: 'Alarm voltage (V)', name: 'alarmVoltageV', type: 'number', value: r.battery.alarmVoltageV ?? '' }, (v) => { r.battery.alarmVoltageV = v === '' ? null : Number(v); }),
    batField({ label: 'Battery rating (Ah)', name: 'batteryAh', type: 'number', value: r.battery.batteryAh ?? '' }, (v) => { r.battery.batteryAh = v === '' ? null : Number(v); }),
    batField({ label: 'Standby test', name: 'standbyOk', type: 'select', value: r.battery.standbyOk || '', options: okOpts }, (v) => { r.battery.standbyOk = v; }, 0),
    batField({ label: 'Alarm test', name: 'alarmOk', type: 'select', value: r.battery.alarmOk || '', options: okOpts }, (v) => { r.battery.alarmOk = v; }, 0),
    batField({ label: 'Battery notes', name: 'notes', value: r.battery.notes, span: true }, (v) => { r.battery.notes = v; }));

  // ---- devices ----
  const summaryEl = h('div', { class: 'fa-summary muted' });
  const drawSummary = () => { const s = summarizeDevices(r.devices); ui.clear(summaryEl).append(`${s.total} device${s.total === 1 ? '' : 's'} · ${s.pass} pass · ${s.fail} fail · ${s.pending} pending`); };

  const devHost = h('div', { class: 'fa-devices' });
  function drawDevices() {
    ui.clear(devHost);
    r.devices.forEach((d, i) => devHost.append(deviceCard(d, i)));
    if (r.devices.length < MAX_DEVICES) devHost.append(h('button', { type: 'button', class: 'fa-addrow', onClick: () => { r.devices.push(newDevice()); save({ devices: r.devices }); drawDevices(); drawSummary(); drawResult(); } }, ui.icon('plus', 16), 'Add device'));
    drawSummary();
  }
  function deviceCard(d, i) {
    d.checks = d.checks || {};
    const bump = () => { clearTimeout(d._t); d._t = setTimeout(() => { save({ devices: r.devices }); drawResult(); }, 350); };
    const resBadge = h('span', { class: 'fa-devres' });
    const drawDevRes = () => { const res = deviceResult(d); ui.clear(resBadge).append(ui.badge(res, deviceTone[res] || 'neutral')); };
    drawDevRes();
    const typeSel = h('select', { class: 'input', 'aria-label': 'Device type' }, DEVICE_TYPES.map((t) => h('option', { value: t.id, selected: (d.type || 'smoke') === t.id }, t.label)));
    typeSel.addEventListener('change', () => { d.type = typeSel.value; bump(); });
    const loc = h('input', { class: 'input', value: d.location || '', placeholder: 'Location', 'aria-label': 'Location' });
    loc.addEventListener('input', () => { d.location = loc.value.slice(0, 200); bump(); });
    const zone = h('input', { class: 'input', value: d.zone || '', placeholder: 'Zone', 'aria-label': 'Zone', style: { width: '90px' } });
    zone.addEventListener('input', () => { d.zone = zone.value.slice(0, 60); bump(); });
    const addr = h('input', { class: 'input', value: d.address || '', placeholder: 'Address', 'aria-label': 'Address', style: { width: '90px' } });
    addr.addEventListener('input', () => { d.address = addr.value.slice(0, 60); bump(); });
    const checks = h('div', { class: 'fa-checks' }, DEVICE_CHECKS.map((c) => {
      const sel = h('select', { class: 'input fa-check', 'aria-label': c.label },
        [['', '—'], ['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']].map(([v, l]) => h('option', { value: v, selected: (d.checks[c.id] || '') === v }, l)));
      sel.addEventListener('change', () => { d.checks[c.id] = sel.value; drawDevRes(); bump(); });
      return h('label', { class: 'fa-checkwrap' }, h('span', { class: 'fa-checklbl' }, c.label), sel);
    }));
    const notes = h('input', { class: 'input', value: d.notes || '', placeholder: 'Notes', 'aria-label': 'Device notes' });
    notes.addEventListener('input', () => { d.notes = notes.value.slice(0, 500); bump(); });
    const rm = ui.button('', { variant: 'ghost danger', size: 'sm', icon: 'x', title: 'Remove device', onClick: () => { r.devices.splice(i, 1); save({ devices: r.devices }); drawDevices(); drawResult(); } });
    return h('div', { class: 'fa-device' },
      h('div', { class: 'fa-device-top' }, h('span', { class: 'fa-devnum' }, `#${i + 1}`), typeSel, loc, zone, addr, resBadge, rm),
      checks,
      notes);
  }

  const remove = async () => { if (!(await ui.confirmDialog('Delete this verification?', { okLabel: 'Delete' }))) return; store.remove('faVerifications', id); ui.toast('Verification deleted'); nav('#/faverification'); };

  root.append(ui.page({
    title: verificationLabel(r),
    subtitle: h('span', null, ui.h('a', { href: '#/faverification' }, 'Fire-alarm verification'), ' / CAN/ULC S537'),
    actions: [resultBadge, ui.button('Print certificate', { icon: 'printer', onClick: () => printCertificate(ctx, r) }), ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete', onClick: remove })],
  },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'System'), grid),
      h('section', { class: 'card' }, h('h3', null, 'Standby / battery'),
        h('p', { class: 'muted fa-hint' }, 'Record what the standby-battery and alarm-load checks showed. CAN/ULC S537 and the panel’s listing govern the actual limits.'),
        batteryGrid),
      h('section', { class: 'card' }, h('div', { class: 'row fa-devhead' }, h('h3', null, 'Devices'), h('span', { class: 'grow' }), summaryEl),
        h('p', { class: 'muted fa-hint' }, 'For each device record what you observed: installed, correct type/location, alarm received at the panel, correct annunciation and audibility/visibility.'),
        devHost),
      h('div', { class: 'row' }, ui.button('Back to verifications', { variant: 'ghost', href: '#/faverification' })))));
  drawResult();
  drawDevices();
}

// ---------- print: CAN/ULC S537 verification certificate ----------
function printCertificate(ctx, r) {
  const { store, ui } = ctx;
  const { h } = ui;
  const co = store.settings().company || {};
  const job = r.jobId ? store.get('jobs', r.jobId) : null;
  const client = r.clientId ? store.get('clients', r.clientId) : null;
  const sum = summarizeDevices(r.devices || []);
  const bat = r.battery || {};
  const okText = (v) => CHECK_LABEL[v || ''] || '—';
  const stageLabel = { initial: 'Initial verification', reverification: 'Reverification', annual: 'Annual / periodic' }[r.stage] || 'Verification';

  const node = h('div', { class: 'fa-print' }, h('article', { class: 'fa-doc' },
    h('header', { class: 'fa-doc-top' },
      h('div', null, h('div', { class: 'fa-doc-brand' }, co.name || 'Company'), h('div', { class: 'fa-doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · '))),
      h('div', { class: 'fa-doc-right' }, h('div', { class: 'fa-doc-kind' }, 'Fire-alarm verification'), h('div', { class: 'fa-doc-small' }, 'CAN/ULC S537'), h('div', null, ui.fmtDate(r.date || new Date())))),
    h('h1', null, 'Fire-alarm system verification certificate'),
    h('p', { class: 'fa-doc-small' }, [r.building || 'Building', r.address, client?.name, job ? jobLabel(job) : null, stageLabel].filter(Boolean).join(' · ')),
    h('table', { class: 'fa-kv' }, h('tbody', null,
      h('tr', null, h('th', null, 'Panel'), h('td', null, [r.panelMake, r.panelModel].filter(Boolean).join(' ') || '—'), h('th', null, 'Type'), h('td', null, r.panelType || '—')),
      h('tr', null, h('th', null, 'Zones / circuits'), h('td', null, r.zones ?? '—'), h('th', null, 'Result'), h('td', null, resultLabel(r.overallResult))),
      h('tr', null, h('th', null, 'Devices'), h('td', null, `${sum.total} (${sum.pass} pass · ${sum.fail} fail · ${sum.pending} pending)`), h('th', null, 'Verifier'), h('td', null, [r.verifierName, r.verifierCert].filter(Boolean).join(' · ') || '—')))),
    h('h2', null, 'Standby / battery check'),
    h('p', { class: 'fa-doc-small' }, [
      bat.voltageV != null ? `Standby battery: ${bat.voltageV} V` : null,
      bat.alarmVoltageV != null ? `Alarm: ${bat.alarmVoltageV} V` : null,
      bat.batteryAh != null ? `${bat.batteryAh} Ah` : null,
      `Standby test: ${okText(bat.standbyOk)}`, `Alarm test: ${okText(bat.alarmOk)}`,
      bat.notes || null,
    ].filter(Boolean).join(' · ') || '—'),
    h('h2', null, `Device verification (${sum.total})`),
    (r.devices || []).length ? h('table', null,
      h('thead', null, h('tr', null, ['#', 'Type', 'Location', 'Zone', 'Addr', ...DEVICE_CHECKS.map((c) => c.label), 'Result'].map((x) => h('th', null, x)))),
      h('tbody', null, (r.devices || []).map((d, i) => h('tr', null,
        h('td', null, i + 1),
        h('td', null, deviceTypeLabel(d.type)),
        h('td', null, d.location || '—'),
        h('td', null, d.zone || '—'),
        h('td', null, d.address || '—'),
        ...DEVICE_CHECKS.map((c) => h('td', { class: 'fa-c' }, okText(d.checks?.[c.id]))),
        h('td', null, deviceResult(d)))))) : h('p', null, 'No devices recorded.'),
    r.notes ? [h('h2', null, 'Notes'), h('p', null, r.notes)] : null,
    h('div', { class: 'fa-sign' },
      h('div', null, h('div', { class: 'fa-sign-line' }), h('div', { class: 'fa-doc-small' }, `Verified by: ${r.verifierName || ''}`)),
      h('div', null, h('div', { class: 'fa-sign-line' }), h('div', { class: 'fa-doc-small' }, `Date: ${r.date ? ui.fmtDate(r.date) : ''}`))),
    h('p', { class: 'fa-doc-foot' }, 'This record documents the verification performed to CAN/ULC S537. It records observed conditions; it is not a substitute for the full S537 report where one is required by the authority having jurisdiction.')));

  document.body.append(node);
  document.body.classList.add('fa-printing');
  const done = () => { node.remove(); document.body.classList.remove('fa-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  setTimeout(() => { window.print(); setTimeout(done, 800); }, 60);
}
