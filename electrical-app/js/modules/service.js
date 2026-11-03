// Service management (#/service): recurring maintenance agreements and the per-site asset registry.
//   #/service?tab=due          agreements due for a visit (office)
//   #/service?tab=agreements   the agreement list (office)
//   #/service?tab=assets       equipment installed at customer sites (everyone)
//   #/service/asset/:id        one asset
// Pure logic: js/lib/service.js. Recurring visits are logged by hand (local-first, no scheduler):
// "Log a visit" records it, moves the due date on, and can spin up a job for the crew.
import { newAgreement, newAsset, isDue, logVisitPatch, FREQUENCIES, AGREEMENT_STATUSES, ASSET_TYPES, intervalMonths, warrantyState, agreementLabel, assetLabel } from '../lib/service.js';
import { photoStrip } from '../lib/safety-capture.js';
import { moneyFormatter } from '../lib/money.js';

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/service.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/service.css';
  document.head.append(link);
}

export default {
  id: 'service',
  title: 'Service',
  icon: 'wrench',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub, id] = ctx.params;
    if (sub === 'asset' && id) return assetView(root, ctx, id);
    return home(root, ctx);
  },
};

const clientName = (store, id) => (id ? store.get('clients', id)?.name || '—' : '—');

function home(root, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const office = auth.can('clients');
  const tabs = [
    office ? { id: 'due', label: 'Due' } : null,
    office ? { id: 'agreements', label: 'Agreements' } : null,
    { id: 'assets', label: 'Site assets' },
  ].filter(Boolean);
  let tab = tabs.some((t) => t.id === ctx.query.tab) ? ctx.query.tab : tabs[0].id;
  const tabHost = h('div', { class: 'sv-tabs' });
  const body = h('div', { class: 'sv-body' });
  const draw = () => {
    ui.clear(tabHost).append(ui.tabs(tabs, tab, (t) => { tab = t; history.replaceState(null, '', `#/service?tab=${t}`); draw(); }));
    ui.clear(body);
    try { ({ due: dueTab, agreements: agreementsTab, assets: assetsTab }[tab])(body, ctx); }
    catch (e) { console.error(e); body.append(ui.empty({ icon: 'alert', title: 'Something went wrong', text: e.message })); }
  };
  root.append(ui.page({ title: 'Service', subtitle: 'Recurring maintenance agreements and the gear you look after' }, tabHost, body));
  draw();
  const offs = ['serviceAgreements', 'assets'].map((c) => store.on(c, () => { if (!document.querySelector('.sheet, .dialog')) draw(); }));
  return () => offs.forEach((f) => f());
}

// ---------- agreements ----------
function agreementsTab(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const money = moneyFormatter(store.settings());
  const rows = store.list('serviceAgreements').sort((a, b) => String(a.nextDueDate || '').localeCompare(String(b.nextDueDate || '')));
  el.append(h('div', { class: 'row sv-toolbar' }, h('span', { class: 'grow' }), ui.button('New agreement', { variant: 'primary', icon: 'plus', onClick: () => editAgreement(ctx) })));
  el.append(rows.length ? ui.table({
    columns: [
      { key: 'client', label: 'Client', render: (a) => clientName(store, a.clientId), sort: (a) => clientName(store, a.clientId) },
      { key: 'title', label: 'Agreement', render: (a) => a.title || '—' },
      { key: 'freq', label: 'Every', render: (a) => `${intervalMonths(a)} mo` },
      { key: 'next', label: 'Next due', render: (a) => (a.nextDueDate ? ui.fmtDate(a.nextDueDate) : '—'), sort: (a) => a.nextDueDate || '' },
      { key: 'price', label: 'Price', align: 'right', render: (a) => (a.priceCents == null ? '—' : money(a.priceCents)) },
      { key: 'status', label: 'Status', render: (a) => ui.badge(a.status || 'active', a.status === 'active' ? 'success' : a.status === 'paused' ? 'warning' : 'neutral') },
    ],
    rows, onRowClick: (a) => editAgreement(ctx, a.id),
  }) : ui.empty({ icon: 'refresh', title: 'No service agreements', text: 'Set up recurring maintenance — quarterly generator checks, annual thermal scans — and never miss a renewal.', action: ui.button('New agreement', { variant: 'primary', icon: 'plus', onClick: () => editAgreement(ctx) }) }));
}

function editAgreement(ctx, id = null) {
  const { store, ui } = ctx;
  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const a = id ? store.get('serviceAgreements', id) : newAgreement({ by: store.actorId, startDate: ui.today() });
  if (!a) { ui.toast('That agreement is gone.', 'error'); return; }
  ui.formSheet({
    title: id ? 'Edit agreement' : 'New agreement',
    fields: [
      { label: 'Client', name: 'clientId', type: 'select', required: true, value: a.clientId || '', options: [{ value: '', label: '— choose —' }, ...ui.recordOptions(clients)] },
      { label: 'Title', name: 'title', value: a.title, span: true, placeholder: 'Quarterly generator maintenance' },
      { label: 'Frequency', name: 'frequency', type: 'select', value: a.frequency || 'quarterly', options: FREQUENCIES.map((f) => ({ value: f.id, label: f.label })) },
      { label: 'Custom interval (months)', name: 'intervalMonths', type: 'number', min: '1', max: '120', value: a.intervalMonths ?? 3, hint: 'Used when frequency is Custom' },
      { label: 'Price per visit', name: 'priceCents', type: 'money', value: a.priceCents },
      { label: 'Billing', name: 'billing', type: 'select', value: a.billing || 'per-visit', options: [{ value: 'per-visit', label: 'Per visit' }, { value: 'monthly', label: 'Monthly' }, { value: 'annual', label: 'Yearly' }] },
      { label: 'Start / next due', name: 'nextDueDate', type: 'date', value: a.nextDueDate || a.startDate || ui.today() },
      { label: 'Status', name: 'status', type: 'select', value: a.status || 'active', options: AGREEMENT_STATUSES.map((s) => ({ value: s, label: s })) },
      { label: 'Notes', name: 'notes', type: 'textarea', value: a.notes, span: true },
    ],
    submitLabel: id ? 'Save' : 'Create',
    danger: id ? { label: 'Delete', onClick: () => { store.remove('serviceAgreements', id); ui.toast('Agreement deleted'); } } : null,
    onSubmit: (v) => {
      if (!v.clientId) { ui.toast('Pick a client', 'error'); return false; }
      const patch = {
        clientId: v.clientId, title: v.title || 'Maintenance agreement', frequency: v.frequency,
        intervalMonths: Math.max(1, Number(v.intervalMonths) || 3), priceCents: v.priceCents ?? null, billing: v.billing,
        status: v.status, startDate: a.startDate || v.nextDueDate, nextDueDate: v.nextDueDate, notes: v.notes || '',
      };
      if (id) store.update('serviceAgreements', id, patch);
      else store.add('serviceAgreements', { ...a, ...patch });
    },
  });
}

// ---------- due ----------
function dueTab(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const today = ui.today();
  const all = store.list('serviceAgreements', (a) => a.status === 'active');
  const due = all.filter((a) => isDue(a, today)).sort((a, b) => String(a.nextDueDate).localeCompare(String(b.nextDueDate)));
  const soon = all.filter((a) => !isDue(a, today) && a.nextDueDate && a.nextDueDate <= ui.today(14));
  if (!due.length && !soon.length) { el.append(ui.empty({ icon: 'check', title: 'Nothing due', text: 'No maintenance visits are due in the next two weeks.' })); return; }
  if (due.length) el.append(...ui.section(`Due now (${due.length})`, h('div', { class: 'list' }, due.map((a) => dueRow(ctx, a, true)))));
  if (soon.length) el.append(...ui.section('Coming up', h('div', { class: 'list' }, soon.map((a) => dueRow(ctx, a, false)))));
}

function dueRow(ctx, a, overdue) {
  const { store, ui } = ctx;
  const { h } = ui;
  return h('div', { class: 'list-row' },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, agreementLabel(a)),
      h('div', { class: 'meta' }, `${clientName(store, a.clientId)} · due ${ui.fmtDate(a.nextDueDate)}`)),
    overdue ? ui.badge('due', 'danger') : ui.badge(ui.fmtDate(a.nextDueDate), 'warning'),
    ui.button('Log visit', { size: 'sm', variant: 'primary', onClick: () => logVisit(ctx, a) }));
}

function logVisit(ctx, a) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const note = h('textarea', { class: 'input', rows: 3, placeholder: 'What was done (optional)' });
  const makeJob = h('input', { type: 'checkbox', class: 'switch', role: 'switch', checked: false });
  const s = ui.openSheet({
    title: `Log visit · ${agreementLabel(a)}`,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, `Records today's visit and moves the next due date to ${ui.fmtDate(require_next(a))}.`),
      note,
      auth.can('jobs') ? h('label', { class: 'sv-makejob' }, makeJob, h('span', null, 'Also create a job for this visit')) : null),
    actions: [
      ui.button('Cancel', { variant: 'ghost', onClick: () => s.close() }),
      ui.button('Log visit', { variant: 'primary', icon: 'check', onClick: () => {
        let jobId = null;
        if (makeJob.checked && auth.can('jobs')) {
          const job = store.add('jobs', { number: store.nextNumber('job'), title: `${agreementLabel(a)} — service visit`, clientId: a.clientId || null,
            status: 'scheduled', startDate: ui.today(), endDate: '', crewIds: [], changeOrders: [], description: note.value.slice(0, 500) });
          jobId = job.id;
        }
        store.update('serviceAgreements', a.id, logVisitPatch(a, { jobId, note: note.value }));
        s.close();
        ui.toast(jobId ? 'Visit logged and job created.' : 'Visit logged.', 'success');
        if (jobId) nav(`#/jobs/${jobId}`);
      } }),
    ],
  });
}
const require_next = (a) => { const p = logVisitPatch(a); return p.nextDueDate; };

// ---------- assets ----------
function assetsTab(el, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const today = ui.today();
  const clients = new Map(store.list('clients').map((c) => [c.id, c.name]));
  const rows = store.list('assets').sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  el.append(h('div', { class: 'row sv-toolbar' }, h('span', { class: 'grow' }), ui.button('New asset', { variant: 'primary', icon: 'plus', onClick: () => createAsset(ctx) })));
  el.append(rows.length ? ui.table({
    columns: [
      { key: 'name', label: 'Asset', render: (x) => assetLabel(x), sort: (x) => assetLabel(x) },
      { key: 'type', label: 'Type', render: (x) => (x.type || 'other').replace(/-/g, ' ') },
      { key: 'client', label: 'Client / site', render: (x) => clients.get(x.clientId) || '—' },
      { key: 'loc', label: 'Location', render: (x) => x.location || '—' },
      { key: 'warranty', label: 'Warranty', render: (x) => {
        const w = warrantyState(x, today);
        if (!w) return '—';
        return w === 'expired' ? ui.badge('expired', 'danger') : w === 'expiring' ? ui.badge(`to ${ui.fmtDate(x.warrantyUntil)}`, 'warning') : ui.badge(ui.fmtDate(x.warrantyUntil), 'success');
      } },
    ],
    rows, onRowClick: (x) => nav(`service/asset/${x.id}`),
  }) : ui.empty({ icon: 'box', title: 'No site assets yet', text: 'Log the panels, generators, EV chargers and gear you install or maintain, with make, model, serial and warranty — the start of a service history per site.', action: ui.button('New asset', { variant: 'primary', icon: 'plus', onClick: () => createAsset(ctx) }) }));
}

function createAsset(ctx) {
  const { store, nav } = ctx;
  const a = store.add('assets', newAsset({ by: store.actorId }));
  nav(`#/service/asset/${a.id}`);
}

function assetView(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const a = store.get('assets', id);
  if (!a) { ui.toast('That asset is gone.', 'error'); nav('#/service?tab=assets'); return; }
  a.photos = a.photos || [];
  const clients = store.list('clients').sort((x, y) => x.name.localeCompare(y.name));
  const jobs = store.list('jobs').sort((x, y) => (y.number || '').localeCompare(x.number || ''));
  const save = (patch) => store.update('assets', id, patch);

  const fieldEl = (f, onVal, delay = 500) => {
    const el = ui.field(f);
    const c = el.querySelector('[name]');
    c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => { onVal(ui.readForm(el)[f.name]); clearTimeout(el._t); el._t = setTimeout(() => save(collect()), delay); });
    return el;
  };
  const collect = () => ({ name: a.name, type: a.type, clientId: a.clientId, jobId: a.jobId, location: a.location, make: a.make, model: a.model, serial: a.serial, specs: a.specs, installedAt: a.installedAt, warrantyUntil: a.warrantyUntil, status: a.status, notes: a.notes });

  const grid = h('div', { class: 'form-grid' },
    fieldEl({ label: 'Name', name: 'name', value: a.name, placeholder: 'Main panel' }, (v) => { a.name = v; }),
    fieldEl({ label: 'Type', name: 'type', type: 'select', value: a.type || 'panel', options: ASSET_TYPES.map((t) => ({ value: t, label: t.replace(/-/g, ' ') })) }, (v) => { a.type = v; }, 0),
    fieldEl({ label: 'Client / site', name: 'clientId', type: 'select', value: a.clientId || '', options: [{ value: '', label: '—' }, ...ui.recordOptions(clients)] }, (v) => { a.clientId = v || null; }, 0),
    fieldEl({ label: 'Linked job', name: 'jobId', type: 'select', value: a.jobId || '', options: [{ value: '', label: '—' }, ...ui.recordOptions(jobs, (j) => `${j.number} - ${j.title}`)] }, (v) => { a.jobId = v || null; }, 0),
    fieldEl({ label: 'Location on site', name: 'location', value: a.location, placeholder: 'Basement mechanical room' }, (v) => { a.location = v; }),
    fieldEl({ label: 'Status', name: 'status', type: 'select', value: a.status || 'in-service', options: [{ value: 'in-service', label: 'in service' }, { value: 'needs-attention', label: 'needs attention' }, { value: 'retired', label: 'retired' }] }, (v) => { a.status = v; }, 0),
    fieldEl({ label: 'Make', name: 'make', value: a.make }, (v) => { a.make = v; }),
    fieldEl({ label: 'Model', name: 'model', value: a.model }, (v) => { a.model = v; }),
    fieldEl({ label: 'Serial', name: 'serial', value: a.serial }, (v) => { a.serial = v; }),
    fieldEl({ label: 'Installed', name: 'installedAt', type: 'date', value: a.installedAt }, (v) => { a.installedAt = v || null; }, 0),
    fieldEl({ label: 'Warranty until', name: 'warrantyUntil', type: 'date', value: a.warrantyUntil }, (v) => { a.warrantyUntil = v || null; }, 0),
    fieldEl({ label: 'Ratings / specs', name: 'specs', value: a.specs, span: true, placeholder: '200 A, 120/240 V, 42 circuits' }, (v) => { a.specs = v; }),
    fieldEl({ label: 'Notes', name: 'notes', type: 'textarea', value: a.notes, span: true }, (v) => { a.notes = v; }));

  const photos = photoStrip({ photos: a.photos, max: 4, label: 'Add nameplate photo', toast: ui.toast, onChange: () => save({ photos: a.photos }) });

  const remove = async () => {
    if (!(await ui.confirmDialog(`Delete the asset "${assetLabel(a)}"?`, { okLabel: 'Delete' }))) return;
    store.remove('assets', id); ui.toast('Asset deleted'); nav('#/service?tab=assets');
  };

  root.append(ui.page({
    title: assetLabel(a) || 'Asset',
    subtitle: h('span', null, ui.h('a', { href: '#/service?tab=assets' }, 'Site assets'), ' / ', assetLabel(a)),
    actions: [ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete asset', onClick: remove })],
  },
    h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('h3', null, 'Equipment'), grid),
      h('section', { class: 'card' }, h('h3', null, 'Nameplate photos'), photos),
      h('div', { class: 'row' }, ui.button('Back to assets', { variant: 'ghost', href: '#/service?tab=assets' })))));
}
