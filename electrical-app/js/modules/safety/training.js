// Training (certifications with expiry alerts, using the shared `certifications` records)
// and site orientations for new workers on a job.
import { TRAINING, trainingMatrix, expiringTraining, ORIENTATION_TOPICS } from '../../lib/safety.js';
import { signaturePad, signatureOf } from '../../lib/safety-capture.js';
import { me, jobOptions, jobLabel, nameOf, employeeOptions, signatureView } from './common.js';

const CELL_TONE = { valid: 'success', expiring: 'warning', expired: 'danger', missing: 'neutral' };

export function trainingTab(el, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const t = ui.today();
  const province = store.settings().company?.province;
  const canCert = auth.can('compliance') || auth.can('employees');
  const certs = store.list('certifications');
  const matrix = trainingMatrix(store.list('employees'), certs, t, province);
  const kinds = matrix[0]?.kinds || TRAINING.filter((k) => !k.provinces || k.provinces.includes(province));
  const soon = expiringTraining(certs.filter((c) => c.employeeId), t, 30);

  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'grow' }), canCert ? ui.button('Add training record', { variant: 'primary', icon: 'plus', onClick: () => addCert(ctx) }) : null));
  if (soon.length) {
    el.append(h('div', { class: 'card sf-alert stack' }, h('strong', null, `${soon.length} training record${soon.length === 1 ? '' : 's'} expired or expiring within 30 days`),
      h('div', { class: 'list' }, soon.map((c) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, `${nameOf(store, c.employeeId)}: ${c.name}`), h('div', { class: 'meta' }, c.issuer || '')),
        ui.badge(c.daysLeft < 0 ? `expired ${ui.fmtDate(c.expiry)}` : `${c.daysLeft}d · ${ui.fmtDate(c.expiry)}`, c.daysLeft < 0 ? 'danger' : 'warning'))))));
  }
  el.append(...ui.section('Training matrix', matrix.length ? ui.table({
    columns: [
      { key: 'name', label: 'Worker', render: (r) => h('strong', null, r.employee.name), sort: (r) => r.employee.name },
      ...kinds.map((k) => ({ key: k.id, label: k.label, render: (r) => { const c = r.cells[k.id]; return ui.badge(c.state === 'valid' && c.cert?.expiry ? ui.fmtDate(c.cert.expiry) : c.state, CELL_TONE[c.state]); } })),
    ],
    rows: matrix, onRowClick: canCert ? (r) => addCert(ctx, { employeeId: r.employee.id }) : null,
  }) : h('p', { class: 'muted' }, 'Add employees first.'),
  h('p', { class: 'muted sf-small' }, 'Matched by the certificate name (for example "WHMIS 2015", "Working at Heights", "CSA Z462 arc flash"). Records are shared with Compliance and Employees.')));
  orientations(el, ctx);
}

function addCert(ctx, preset = {}) {
  const { store, ui } = ctx;
  ui.formSheet({
    title: 'Add training record',
    fields: [
      { label: 'Worker', name: 'employeeId', type: 'select', value: preset.employeeId || '', options: employeeOptions(ctx, '— pick —'), required: true },
      { label: 'Training', name: 'name', type: 'select', value: 'WHMIS 2015', options: [...TRAINING.map((k) => k.label), 'Other'] },
      { label: 'Other name', name: 'other', placeholder: 'Only for "Other"' },
      { label: 'Provider / issuer', name: 'issuer' },
      { label: 'Certificate no.', name: 'number' },
      { label: 'Expires', name: 'expiry', type: 'date', hint: 'Ontario Working at Heights: 3 years from completion' },
    ],
    onSubmit(v) {
      if (!v.employeeId) { ui.toast('Pick a worker', 'error'); return false; }
      const name = v.name === 'Other' ? v.other.trim() : v.name;
      if (!name) { ui.toast('Name the training', 'error'); return false; }
      store.add('certifications', { employeeId: v.employeeId, name, issuer: v.issuer, number: v.number, expiry: v.expiry || null });
      ui.toast('Training recorded', 'success');
    },
  });
}

function orientations(el, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const rows = store.list('siteOrientations').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  el.append(...ui.section('Site orientations',
    auth.isManager() ? h('div', { class: 'row sf-pad-bottom' }, ui.button('New orientation', { icon: 'plus', onClick: () => newOrientation(ctx) })) : null,
    rows.length ? h('div', { class: 'list' }, rows.map((o) => h('div', { class: 'list-row click', tabindex: 0, onClick: () => showOrientation(ctx, o) },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, o.workerName || nameOf(store, o.employeeId)), h('div', { class: 'meta' }, [ui.fmtDate(o.date), jobLabel(store.get('jobs', o.jobId)), `by ${nameOf(store, o.by)}`].filter(Boolean).join(' · '))),
      ui.badge(`${(o.topics || []).filter((x) => x.done).length}/${ORIENTATION_TOPICS.length}`, 'neutral'))))
      : h('p', { class: 'muted' }, 'Orient every new worker to each site: emergency plan, hazards, PPE rules, reporting.')));
}

function newOrientation(ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const done = new Set();
  const form = h('form', { class: 'stack' }, ui.formGrid([
    { label: 'Job', name: 'jobId', type: 'select', options: jobOptions(ctx), required: true },
    { label: 'Worker', name: 'employeeId', type: 'select', options: employeeOptions(ctx, 'New worker or subcontractor') },
    { label: 'Name (if not an employee)', name: 'workerName' },
    { label: 'Company', name: 'company' },
  ]));
  const list = h('div', { class: 'sf-flags' }, ORIENTATION_TOPICS.map(([id, label]) => h('label', { class: 'field check' }, h('input', { type: 'checkbox', onChange: (e) => { if (e.target.checked) done.add(id); else done.delete(id); } }), h('span', null, label))));
  const pad = signaturePad({ label: 'Worker signature' });
  const s = ui.openSheet({
    title: 'Site orientation', wide: true,
    body: h('div', { class: 'stack' }, form, h('strong', null, 'Covered'), list, pad.el),
    actions: [ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }), ui.button('Save', { variant: 'primary', icon: 'check', onClick: () => {
      const v = ui.readForm(form);
      if (!v.jobId) { ui.toast('Pick the job', 'error'); return; }
      const name = v.employeeId ? nameOf(store, v.employeeId) : v.workerName.trim();
      if (!name) { ui.toast('Pick or name the worker', 'error'); return; }
      const sig = signatureOf(pad, { name, employeeId: v.employeeId || null });
      if (!sig) { ui.toast('The worker signs first', 'error'); return; }
      store.add('siteOrientations', { jobId: v.jobId, employeeId: v.employeeId || null, workerName: v.employeeId ? '' : name, company: v.company, date: ui.today(), by: person.id,
        topics: ORIENTATION_TOPICS.map(([id]) => ({ id, done: done.has(id) })), signature: sig, notes: '' });
      ui.toast('Orientation recorded', 'success'); s.close();
    } })],
  });
}

function showOrientation(ctx, o) {
  const { store, ui } = ctx;
  const { h } = ui;
  const s = ui.openSheet({
    title: `Orientation: ${o.workerName || nameOf(store, o.employeeId)}`,
    body: h('div', { class: 'stack' }, h('div', { class: 'muted' }, [ui.fmtDate(o.date), jobLabel(store.get('jobs', o.jobId)), o.company].filter(Boolean).join(' · ')),
      h('ul', null, ORIENTATION_TOPICS.map(([id, label]) => h('li', null, (o.topics || []).find((x) => x.id === id)?.done ? '✓ ' : '✗ ', label))),
      signatureView(ui, o.signature)),
    actions: [ui.button('Close', { onClick: () => s.close() })],
  });
}
