// Clients (S12): list, detail with related records, add/edit/delete.
// Release 1 (docs/releases/r1-get-paid.md 3.2, 4.6): the tax-exemption evidence card (evidence
// only: the exemption is marked on each job it applies to), the credit card (application, limit,
// terms, statement email, reminders, hold override) and a printable blank credit application.
import { invoiceShown, docTotals } from '../lib/money.js';
import { EXEMPT_BASES } from '../lib/exemption.js';
import { PROVINCES, provincialTaxId, exemptNumberProblem } from '../lib/tax.js';
import { printNode } from '../lib/doc-view.js';
import { openLeadSheet } from './leads.js';
import { moduleOn } from '../lib/modules.js';
import { BILLING_MODES } from '../lib/tm.js';
import { lastEdited } from './drawings.js';
import { qboBadge, lookupAction } from '../lib/qbo-ui.js';

const TYPES = ['residential', 'commercial', 'industrial'];
const TYPE_TONE = { residential: 'info', commercial: 'accent', industrial: 'neutral' };
const CLOSED_JOB = new Set(['complete', 'invoiced']);

/** The client an invoice belongs to: its own clientId, else its job's. */
export function invoiceClientId(store, inv) {
  if (inv.clientId) return inv.clientId;
  return inv.jobId ? store.get('jobs', inv.jobId)?.clientId || null : null;
}

export function clientBalanceCents(store, clientId) {
  return store.list('invoices', (i) => i.status !== 'void' && i.status !== 'draft' && invoiceClientId(store, i) === clientId)
    .reduce((s, i) => s + Math.max(0, invoiceShown(store, i).balanceCents), 0);
}

export function openClientSheet({ store, ui, nav }, client = null, { onSaved, prefill = {} } = {}) {
  const c = client || prefill;
  return ui.formSheet({
    title: client ? 'Edit client' : 'New client',
    submitLabel: client ? 'Save' : 'Add client',
    fields: [
      { label: 'Name', name: 'name', value: c.name, required: true, span: true },
      { label: 'Type', name: 'type', type: 'select', value: c.type || 'residential', options: TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })) },
      { label: 'Phone', name: 'phone', type: 'tel', value: c.phone },
      { label: 'Email', name: 'email', type: 'email', value: c.email },
      { label: 'Address', name: 'address', value: c.address, span: true },
      { label: 'Tags', name: 'tags', value: (c.tags || []).join(', '), hint: 'Comma separated, e.g. repeat, referral', span: true },
      { label: 'Billing for new jobs', name: 'billingMode', type: 'select', value: c.billingMode || '', hint: 'e.g. this customer is always time & material',
        options: [{ value: '', label: 'Company default' }, ...BILLING_MODES.map((m) => ({ value: m.value, label: `Always ${m.label.toLowerCase()}` }))] },
      { label: 'Notes', name: 'notes', type: 'textarea', value: c.notes, span: true },
    ],
    danger: client ? { label: 'Delete', onClick: () => deleteClient({ store, ui, nav }, client) } : null,
    onSubmit(v) {
      v.tags = String(v.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      v.billingMode = v.billingMode === 'tm' || v.billingMode === 'fixed' ? v.billingMode : null;
      const saved = client ? store.update('clients', client.id, v) : store.add('clients', v);
      ui.toast(client ? 'Client saved' : 'Client added', 'success');
      onSaved?.(saved);
    },
  });
}

async function deleteClient({ store, ui, nav }, client) {
  const jobs = store.count('jobs', (j) => j.clientId === client.id);
  const msg = jobs ? `${client.name} has ${jobs} job(s). They will keep their history but lose the client link.` : `Delete ${client.name}?`;
  if (!(await ui.confirmDialog(msg, { title: 'Delete client', okLabel: 'Delete' }))) return;
  store.remove('clients', client.id);
  ui.toast('Client deleted');
  nav('#/clients');
}

function listView(root, ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  let q = '', type = 'all';
  const body = h('div', { class: 'stack' });

  const draw = () => {
    ui.clear(body);
    const term = q.trim().toLowerCase();
    const rows = store.list('clients', (c) => (type === 'all' || c.type === type) &&
      (!term || [c.name, c.email, c.phone, c.address, ...(c.tags || [])].join(' ').toLowerCase().includes(term)))
      .map((c) => ({
        ...c,
        openJobs: store.count('jobs', (j) => j.clientId === c.id && !CLOSED_JOB.has(j.status)),
        balance: clientBalanceCents(store, c.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    body.append(h('div', { class: 'crm-clients-table' }, ui.table({
      columns: [
        { key: 'name', label: 'Name', sort: (r) => r.name.toLowerCase(), render: (r) => h('div', null, h('div', { style: { fontWeight: 600 } }, r.name), r.address ? h('div', { class: 'muted crm-sub' }, r.address) : null) },
        { key: 'type', label: 'Type', sort: (r) => r.type, render: (r) => ui.badge(r.type || '—', TYPE_TONE[r.type]) },
        { key: 'phone', label: 'Phone', render: (r) => r.phone || '—' },
        { key: 'email', label: 'Email', render: (r) => r.email || '—' },
        { key: 'openJobs', label: 'Open jobs', align: 'right', sort: (r) => r.openJobs, render: (r) => String(r.openJobs) },
        moduleOn(store.settings(), 'invoices') ? { key: 'balance', label: 'Owed', align: 'right', sort: (r) => r.balance, render: (r) => (r.balance > 0 ? h('span', { class: 'crm-owed' }, ui.fmtMoney(r.balance)) : ui.fmtMoney(0)) } : null,
      ].filter(Boolean),
      rows,
      onRowClick: (r) => nav('#/clients/' + r.id),
      empty: ui.empty({ icon: 'users', title: term || type !== 'all' ? 'No matching clients' : 'No clients yet', text: term ? 'Try a different search.' : 'Add the people and companies you work for.',
        action: term ? null : ui.button('Add client', { variant: 'primary', icon: 'plus', onClick: () => openClientSheet(ctx) }) }),
    })));
  };

  const filters = h('div', { class: 'row crm-filters' },
    ui.searchBox('Search clients', (v) => { q = v; draw(); }),
    ui.tabs([{ id: 'all', label: 'All' }, ...TYPES.map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) }))], type, function onChange(id) {
      type = id; filters.replaceChild(ui.tabs([{ id: 'all', label: 'All' }, ...TYPES.map((t) => ({ id: t, label: t[0].toUpperCase() + t.slice(1) }))], type, onChange), filters.lastChild); draw();
    }));

  root.append(ui.page({
    title: 'Clients',
    subtitle: `${store.count('clients')} clients`,
    actions: [ui.button('Add client', { variant: 'primary', icon: 'plus', onClick: () => openClientSheet(ctx) })],
  }, filters, body));
  draw();
  return store.on('*', (e) => { if (['clients', 'jobs', 'invoices', 'payments'].includes(e.coll)) draw(); });
}

function detailView(root, ctx, id) {
  const { store, ui, nav, auth } = ctx;
  const { h, icon } = ui;
  let tab = ctx.query.tab || 'jobs';
  const on = (m) => (ctx.on ? ctx.on(m) : moduleOn(store.settings(), m));
  const money = !auth || auth.can('invoices') || auth.can('estimates');

  const draw = () => {
    ui.clear(root);
    const c = store.get('clients', id);
    if (!c) {
      root.append(ui.page({ title: 'Client not found' }, ui.empty({ icon: 'users', title: 'This client no longer exists', action: ui.button('Back to clients', { href: '#/clients' }) })));
      return;
    }
    const jobs = store.list('jobs', (j) => j.clientId === id);
    const jobIds = new Set(jobs.map((j) => j.id));
    const estimates = store.list('estimates', (e) => e.clientId === id || (e.jobId && jobIds.has(e.jobId)));
    const invoices = store.list('invoices', (i) => invoiceClientId(store, i) === id);
    const leads = store.list('leads', (l) => l.clientId === id);
    const drawings = store.list('drawings', (d) => d.clientId === id || (d.jobId && jobIds.has(d.jobId)), { omit: ['underlay', 'strokes', 'texts', 'rooms', 'history', 'tombstones'] });
    const owed = clientBalanceCents(store, id);
    const lifetime = invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + docTotals(i).totalCents, 0);

    const contact = h('div', { class: 'card crm-contact' },
      h('div', { class: 'row' }, h('span', { class: 'avatar crm-avatar' }, ui.initials(c.name)),
        h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, c.name), ui.badge(c.type || '—', TYPE_TONE[c.type]), qboBadge(ctx, 'clients', id, { record: c }))),
      h('div', { class: 'crm-contact-lines' },
        c.phone ? h('a', { href: 'tel:' + c.phone.replace(/[^0-9+]/g, ''), class: 'crm-line' }, icon('phone', 16), c.phone) : null,
        c.email ? h('a', { href: 'mailto:' + c.email, class: 'crm-line' }, icon('mail', 16), c.email) : null,
        c.address ? h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(c.address), target: '_blank', rel: 'noopener', class: 'crm-line' }, icon('map-pin', 16), c.address) : null,
        !c.phone && !c.email && !c.address ? h('span', { class: 'muted' }, 'No contact details yet.') : null),
      (c.tags || []).length ? h('div', { class: 'row' }, c.tags.map((t) => ui.badge(t))) : null,
      c.notes ? h('p', { class: 'crm-notes' }, c.notes) : null);

    const side = h('div', { class: 'stack crm-side' }, contact,
      exemptionCard(ctx, c),
      creditCard(ctx, c, { money: !auth || auth.can('invoices') }));

    const stats = h('div', { class: 'grid crm-stats' },
      ui.stat({ label: 'Open jobs', value: String(jobs.filter((j) => !CLOSED_JOB.has(j.status)).length) }),
      on('invoices') && money ? ui.stat({ label: 'Owed', value: ui.fmtMoney(owed), tone: owed > 0 ? 'danger' : null }) : null,
      on('invoices') && money ? ui.stat({ label: 'Invoiced to date', value: ui.fmtMoney(lifetime, { whole: true }) }) : null);

    // Tabs for turned-off modules are left out; their records are kept.
    const tabItems = [
      { id: 'jobs', label: `Jobs (${jobs.length})` },
      on('estimates') ? { id: 'estimates', label: `Estimates (${estimates.length})` } : null,
      on('invoices') ? { id: 'invoices', label: `Invoices (${invoices.length})` } : null,
      on('leads') ? { id: 'leads', label: `Leads (${leads.length})` } : null,
      on('drawings') ? { id: 'drawings', label: `Drawings (${drawings.length})` } : null,
    ].filter(Boolean);
    if (!tabItems.some((t) => t.id === tab)) tab = 'jobs';
    const tabBody = h('div');
    const tabsEl = h('div');
    const drawTab = () => {
      ui.clear(tabsEl).append(ui.tabs(tabItems, tab, (t) => { tab = t; drawTab(); }));
      ui.clear(tabBody);
      const jobTitle = (jid) => store.get('jobs', jid)?.number || '—';
      if (tab === 'jobs') tabBody.append(ui.table({
        columns: [
          { key: 'number', label: '#', render: (r) => h('span', { class: 'mono' }, r.number) },
          { key: 'title', label: 'Job' },
          { key: 'status', label: 'Status', render: (r) => ui.statusBadge(r.status) },
          { key: 'startDate', label: 'Start', sort: (r) => r.startDate || '', render: (r) => ui.fmtDate(r.startDate) },
        ],
        rows: jobs, onRowClick: (r) => nav('#/jobs/' + r.id),
        empty: ui.empty({ icon: 'briefcase', title: 'No jobs yet', action: ui.button('New job', { icon: 'plus', href: `#/jobs?new=1&clientId=${id}` }) }),
      }));
      if (tab === 'estimates') tabBody.append(ui.table({
        columns: [
          { key: 'number', label: '#', render: (r) => h('span', { class: 'mono' }, r.number) },
          { key: 'title', label: 'Title' },
          { key: 'status', label: 'Status', render: (r) => ui.statusBadge(r.status) },
          { key: 'total', label: 'Total', align: 'right', sort: (r) => docTotals(r).totalCents, render: (r) => ui.fmtMoney(docTotals(r).totalCents) },
        ],
        rows: estimates, onRowClick: (r) => nav('#/estimates/' + r.id),
        empty: ui.empty({ icon: 'file-text', title: 'No estimates yet', action: ui.button('New estimate', { icon: 'plus', href: `#/estimates/new?clientId=${id}` }) }),
      }));
      if (tab === 'invoices') tabBody.append(ui.table({
        columns: [
          { key: 'number', label: '#', render: (r) => h('span', { class: 'mono' }, r.number) },
          { key: 'job', label: 'Job', render: (r) => (r.jobId ? jobTitle(r.jobId) : '—') },
          { key: 'status', label: 'Status', render: (r) => ui.statusBadge(invoiceShown(store, r).status) },
          { key: 'dueDate', label: 'Due', sort: (r) => r.dueDate || '', render: (r) => ui.fmtDate(r.dueDate) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => ui.fmtMoney(docTotals(r).totalCents) },
          { key: 'bal', label: 'Balance', align: 'right', sort: (r) => invoiceShown(store, r).balanceCents, render: (r) => ui.fmtMoney(Math.max(0, invoiceShown(store, r).balanceCents)) },
        ],
        rows: invoices, onRowClick: (r) => nav('#/invoices/' + r.id),
        empty: ui.empty({ icon: 'receipt', title: 'No invoices yet' }),
      }));
      if (tab === 'leads') tabBody.append(ui.table({
        columns: [
          { key: 'title', label: 'Lead' },
          { key: 'stage', label: 'Stage', render: (r) => ui.statusBadge(r.stage) },
          { key: 'value', label: 'Value', align: 'right', render: (r) => ui.fmtMoney(r.valueCents, { whole: true }) },
          { key: 'next', label: 'Next action', render: (r) => ui.fmtDate(r.nextActionAt) },
        ],
        rows: leads, onRowClick: (r) => openLeadSheet(ctx, r),
        empty: ui.empty({ icon: 'funnel', title: 'No leads for this client', action: ui.button('New lead', { icon: 'plus', onClick: () => openLeadSheet(ctx, null, { prefill: { clientId: id, contactName: c.name, email: c.email, phone: c.phone } }) }) }),
      }));
      // one drawing set per customer: "Open drawings" opens it, or starts it
      if (tab === 'drawings') tabBody.append(h('div', { class: 'row', style: { marginBottom: '12px' } },
        ui.button(`Open ${c.name}'s drawings`, { variant: 'primary', icon: 'pen', href: `#/drawings/customer?clientId=${encodeURIComponent(id)}` }),
        drawings.length ? ui.button('All their drawings', { icon: 'layers', href: `#/drawings?clientId=${encodeURIComponent(id)}` }) : null), drawings.length
        ? h('div', { class: 'grid' }, drawings.map((d) => h('a', { class: 'card click crm-drawing', href: '#/drawings/' + d.id },
          d.thumb ? h('img', { src: d.thumb, alt: '' }) : h('div', { class: 'crm-drawing-ph' }, icon('pen', 28)),
          h('div', { style: { fontWeight: 600 } }, d.name), h('div', { class: 'muted crm-sub' }, [d.jobId ? jobTitle(d.jobId) : null, lastEdited(ui, d)].filter(Boolean).join(' · ')))))
        : ui.empty({ icon: 'pen', title: 'No drawings yet', text: 'Open the customer\'s drawings to start their plan set. Drawings on their jobs show up here too.' }));
    };
    drawTab();

    root.append(ui.page({
      title: c.name,
      subtitle: h('a', { href: '#/clients' }, '← All clients'),
      actions: [
        ui.button('Edit', { icon: 'edit', onClick: () => openClientSheet(ctx, c) }),
        on('leads') ? ui.button('New lead', { icon: 'funnel', onClick: () => openLeadSheet(ctx, null, { prefill: { clientId: id, contactName: c.name, email: c.email, phone: c.phone } }) }) : null,
        on('estimates') ? ui.button('New estimate', { icon: 'file-text', href: `#/estimates/new?clientId=${id}` }) : null,
        lookupAction(ctx, { entity: 'customers', clientId: id }),
        ui.button('New job', { variant: 'primary', icon: 'plus', href: `#/jobs?new=1&clientId=${id}` }),
      ].filter(Boolean),
    }, h('div', { class: 'crm-detail' }, side, h('div', { class: 'stack' }, stats, tabsEl, tabBody))));
  };
  draw();
  return store.on('*', (e) => { if (['clients', 'jobs', 'estimates', 'invoices', 'payments', 'leads', 'drawings'].includes(e.coll)) draw(); });
}

// ---- tax exemption evidence (r1-get-paid.md 2.9, 3.2) ------------------------------------

const BASIS_LABEL = Object.fromEntries(EXEMPT_BASES.map((b) => [b.id, b.label]));
const DETAIL_LABEL = { name: 'Name', registryNo: 'Status registry no.', band: 'Band', reserve: 'Reserve', farmCertNo: 'Farm certificate no.', department: 'Federal department', endCustomer: 'End customer', note: 'Note' };
const filled = (v) => v != null && String(v).trim() !== '';

/** The evidence on file for a client, as [label, value] rows. */
export function exemptionRows(c) {
  const d = c.taxExemptDetails || {};
  const tax = provincialTaxId(c.taxExemptProvince) || 'RST/PST';
  return [
    c.taxExemptBasis ? ['Basis', BASIS_LABEL[c.taxExemptBasis] || c.taxExemptBasis] : null,
    filled(c.taxExemptNumber) ? [`${tax} number`, c.taxExemptNumber] : null,
    c.taxExemptProvince ? ['Province', PROVINCES.find((x) => x.code === c.taxExemptProvince)?.name || c.taxExemptProvince] : null,
    ...Object.keys(DETAIL_LABEL).filter((k) => filled(d[k])).map((k) => [DETAIL_LABEL[k], d[k]]),
  ].filter(Boolean);
}

function exemptionCard(ctx, c) {
  const { ui, auth } = ctx;
  const { h } = ui;
  const canEdit = !auth || auth.can('clients');
  const rows = exemptionRows(c);
  const warn = exemptNumberProblem({ province: c.taxExemptProvince, basis: c.taxExemptBasis, number: c.taxExemptNumber });
  return h('section', { class: 'card crm-side-card crm-tax', dataset: { exemptionCard: '1' } },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Tax exemption'),
      canEdit ? ui.button(rows.length ? 'Edit' : 'Add', { size: 'sm', variant: 'ghost', icon: rows.length ? 'edit' : 'plus', title: 'Tax exemption evidence', onClick: () => openExemptionSheet(ctx, c) }) : null),
    rows.length
      ? h('dl', { class: 'crm-dl' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
      : h('p', { class: 'muted crm-sub' }, 'No exemption evidence on file.'),
    c.taxExemptCheckedAt ? h('div', { class: 'muted crm-sub' }, `Evidence checked ${ui.fmtDate(c.taxExemptCheckedAt)}`) : null,
    warn ? h('div', { class: 'crm-warn crm-sub' }, ui.icon('info', 14), h('span', null, warn)) : null,
    h('p', { class: 'muted crm-sub crm-tax-note' }, 'This is evidence on file. Mark the exemption on each job it applies to.'));
}

function openExemptionSheet({ store, ui }, c) {
  const d = c.taxExemptDetails || {};
  const province = c.taxExemptProvince || store.settings().company?.province || '';
  ui.formSheet({
    title: `Tax exemption · ${c.name}`,
    submitLabel: 'Save',
    fields: [
      { label: 'Why the customer may be exempt', name: 'taxExemptBasis', type: 'select', value: c.taxExemptBasis || '', span: true,
        options: [{ value: '', label: 'No exemption on file' }, ...EXEMPT_BASES.map((b) => ({ value: b.id, label: b.label }))] },
      { label: 'RST or PST number', name: 'taxExemptNumber', value: c.taxExemptNumber || '', hint: 'Manitoba: 7 digits (Bulletin 004). The format is only checked as a warning.' },
      { label: 'Province', name: 'taxExemptProvince', type: 'select', value: ['MB', 'SK', 'BC'].includes(province) ? province : '',
        options: [{ value: '', label: '—' }, ...PROVINCES.filter((p) => ['MB', 'SK', 'BC'].includes(p.code)).map((p) => ({ value: p.code, label: p.name }))] },
      { label: 'Name (person or band)', name: 'd.name', value: d.name || '', hint: 'First Nations' },
      { label: 'Status registry number', name: 'd.registryNo', value: d.registryNo || '', hint: 'First Nations' },
      { label: 'Band', name: 'd.band', value: d.band || '', hint: 'First Nations' },
      { label: 'Reserve', name: 'd.reserve', value: d.reserve || '', hint: 'First Nations' },
      { label: 'Farm-use certificate number', name: 'd.farmCertNo', value: d.farmCertNo || '' },
      { label: 'Federal department', name: 'd.department', value: d.department || '' },
      { label: 'Evidence checked on', name: 'taxExemptCheckedAt', type: 'date', value: c.taxExemptCheckedAt || ui.today(), hint: 'When you last saw their certificate or licence' },
      { label: 'Note', name: 'd.note', type: 'textarea', rows: 2, value: d.note || '', span: true },
    ],
    extra: ui.h('p', { class: 'muted crm-sub' }, 'Evidence only. An exemption applies per contract: mark it on each job (Job → Contract and payment) before invoicing without RST.'),
    onSubmit(v) {
      const details = {};
      for (const k of ['name', 'registryNo', 'band', 'reserve', 'farmCertNo', 'department', 'note']) { const x = String(v[`d.${k}`] || '').trim(); if (x) details[k] = x; }
      const basis = v.taxExemptBasis || null;
      const number = String(v.taxExemptNumber || '').trim() || null;
      const patch = basis || number || Object.keys(details).length
        ? { taxExemptBasis: basis, taxExemptNumber: number, taxExemptProvince: v.taxExemptProvince || null, taxExemptDetails: details, taxExemptCheckedAt: v.taxExemptCheckedAt || null }
        : { taxExemptBasis: null, taxExemptNumber: null, taxExemptProvince: null, taxExemptDetails: null, taxExemptCheckedAt: null };
      store.update('clients', c.id, patch, { summary: 'Tax exemption evidence' });
      const warn = exemptNumberProblem({ province: patch.taxExemptProvince, basis, number });
      ui.toast(warn ? `Saved. ${warn}` : 'Exemption evidence saved', warn ? 'info' : 'success', warn ? 6000 : 2600);
    },
  });
}

// ---- credit (r1-get-paid.md 4.6) ------------------------------------------------------

const APPLICATION_STATUS = [
  { value: 'none', label: 'No application' }, { value: 'sent', label: 'Application sent' }, { value: 'received', label: 'Application received' },
  { value: 'approved', label: 'Approved' }, { value: 'declined', label: 'Declined' },
];
const HOLD_MODES = [
  { value: 'auto', label: 'Automatic (past due or over the limit)' }, { value: 'hold', label: 'Hold work (forced)' }, { value: 'release', label: 'Don’t hold (forced)' },
];
const HOLD_REASON = { past_due: 'Past due: hold work', over_limit: 'Over the credit limit: hold work' };

function creditCard(ctx, c, { money }) {
  const { ui, auth } = ctx;
  const { h } = ui;
  const cr = c.credit || {};
  const canEdit = !auth || auth.can('invoices');
  const hold = cr.hold?.on ? h('div', { class: 'crm-hold', dataset: { creditHold: '1' } }, ui.icon('alert', 16),
    h('span', null, HOLD_REASON[cr.hold.reason] || 'Hold work', cr.hold.since ? ` since ${ui.fmtDate(cr.hold.since)}` : '')) : null;
  const ov = cr.holdOverride?.mode && cr.holdOverride.mode !== 'auto' ? h('div', { class: 'muted crm-sub' },
    `${cr.holdOverride.mode === 'hold' ? 'Held' : 'Not held'} by ${cr.holdOverride.by || 'the office'}${cr.holdOverride.until ? ` until ${ui.fmtDate(cr.holdOverride.until)}` : ''}${cr.holdOverride.reason ? `: ${cr.holdOverride.reason}` : ''}`) : null;
  const status = APPLICATION_STATUS.find((x) => x.value === (cr.applicationStatus || 'none'))?.label;
  const rows = [
    ['Application', [status, cr.applicationSentAt ? `sent ${ui.fmtDate(cr.applicationSentAt)}` : null, cr.applicationReceivedAt ? `received ${ui.fmtDate(cr.applicationReceivedAt)}` : null].filter(Boolean).join(', ')],
    cr.approvedAt || cr.approvedBy ? ['Approved', [cr.approvedBy, cr.approvedAt ? ui.fmtDate(cr.approvedAt) : null].filter(Boolean).join(', ')] : null,
    money ? ['Credit limit', Number.isInteger(cr.limitCents) ? ui.fmtMoney(cr.limitCents, { whole: true }) : 'No limit'] : null,
    ['Terms', cr.termsDays ? `Net ${cr.termsDays} days` : 'From the invoice'],
    cr.statementEmail ? ['Statements to', cr.statementEmail] : null,
    cr.remindersPaused ? ['Reminders', 'Paused'] : null,
  ].filter(Boolean);
  return h('section', { class: 'card crm-side-card crm-credit', dataset: { creditCard: '1' } },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Credit'),
      canEdit ? ui.button('Edit', { size: 'sm', variant: 'ghost', icon: 'edit', title: 'Credit details', onClick: () => openCreditSheet(ctx, c, { money }) }) : null),
    hold, ov,
    h('dl', { class: 'crm-dl' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    cr.note ? h('p', { class: 'crm-notes crm-sub' }, cr.note) : null,
    h('div', { class: 'row' }, ui.button('Print credit application', { size: 'sm', icon: 'printer', onClick: () => printNode(creditApplicationNode(ctx, c)) })));
}

function openCreditSheet({ store, ui, auth }, c, { money }) {
  const cr = c.credit || {};
  const ho = cr.holdOverride || {};
  ui.formSheet({
    title: `Credit · ${c.name}`,
    submitLabel: 'Save',
    fields: [
      { label: 'Credit application', name: 'applicationStatus', type: 'select', value: cr.applicationStatus || 'none', options: APPLICATION_STATUS },
      { label: 'Sent on', name: 'applicationSentAt', type: 'date', value: cr.applicationSentAt || '' },
      { label: 'Received on', name: 'applicationReceivedAt', type: 'date', value: cr.applicationReceivedAt || '' },
      { label: 'Approved on', name: 'approvedAt', type: 'date', value: cr.approvedAt || '' },
      { label: 'Approved by', name: 'approvedBy', value: cr.approvedBy || '' },
      money ? { label: 'Credit limit', name: 'limitCents', type: 'money', value: Number.isInteger(cr.limitCents) ? cr.limitCents : null, hint: 'Blank for no limit' } : null,
      { label: 'Payment terms (days)', name: 'termsDays', type: 'number', min: '0', step: '1', value: cr.termsDays ?? '', hint: 'Blank: the terms on each invoice' },
      { label: 'Statements and reminders to', name: 'statementEmail', type: 'email', value: cr.statementEmail || '', hint: 'Accounts payable. Blank uses the client’s email.' },
      { label: 'Pause payment reminders', name: 'remindersPaused', type: 'checkbox', value: Boolean(cr.remindersPaused) },
      { label: 'Hold work for this client', name: 'holdMode', type: 'select', value: ho.mode || 'auto', options: HOLD_MODES },
      { label: 'Until', name: 'holdUntil', type: 'date', value: ho.until || '', hint: 'Blank: until changed' },
      { label: 'Why', name: 'holdReason', value: ho.reason || '', span: true },
      { label: 'Note', name: 'note', type: 'textarea', rows: 2, value: cr.note || '', span: true },
    ].filter(Boolean),
    onSubmit(v) {
      const mode = v.holdMode || 'auto';
      const reason = String(v.holdReason || '').trim();
      if (mode !== 'auto' && reason.length < 3) { ui.toast('Say why the hold is forced', 'error'); return false; }
      const termsDays = v.termsDays == null || v.termsDays === '' ? null : Math.max(0, Math.round(Number(v.termsDays)));
      const overrideChanged = mode !== (ho.mode || 'auto') || (v.holdUntil || '') !== (ho.until || '') || reason !== (ho.reason || '');
      const credit = {
        ...cr,
        applicationStatus: v.applicationStatus || 'none',
        applicationSentAt: v.applicationSentAt || null,
        applicationReceivedAt: v.applicationReceivedAt || null,
        approvedAt: v.approvedAt || null,
        approvedBy: String(v.approvedBy || '').trim() || null,
        termsDays,
        statementEmail: String(v.statementEmail || '').trim() || null,
        remindersPaused: Boolean(v.remindersPaused),
        holdOverride: overrideChanged
          ? { mode, until: v.holdUntil || null, reason: reason || null, by: auth?.who?.().name || null, at: new Date().toISOString() }
          : (cr.holdOverride || { mode: 'auto' }),
        note: String(v.note || '').trim() || null,
      };
      if (money) credit.limitCents = v.limitCents > 0 ? v.limitCents : null;
      store.update('clients', c.id, { credit }, { summary: 'Credit details' });
      ui.toast('Credit details saved', 'success');
    },
  });
}

/** A blank credit application to print and hand to a general contractor or customer. */
export function creditApplicationNode({ store, ui }, client = null) {
  const { h } = ui;
  const s = store.settings();
  const co = s.company || {};
  const terms = client?.credit?.termsDays ? `Net ${client.credit.termsDays} days from the invoice date` : 'as stated on each invoice';
  const blank = (label, wide = false) => h('div', { class: ['crm-app-field', wide ? 'wide' : null] }, h('div', { class: 'doc-label' }, label), h('div', { class: 'crm-app-line' }));
  const section = (title, ...kids) => h('section', { class: 'crm-app-section' }, h('h4', null, title), h('div', { class: 'crm-app-grid' }, kids));
  return h('article', { class: 'doc-sheet crm-app', dataset: { creditApplication: '1' } },
    h('header', { class: 'doc-top' },
      h('div', null,
        h('div', { class: 'doc-brand' }, co.name || 'Company'),
        h('div', { class: 'doc-small' }, [co.address, co.phone, co.email].filter(Boolean).join(' · ')),
        co.gstHstNo ? h('div', { class: 'doc-small' }, `GST/HST No. ${co.gstHstNo}`) : null),
      h('div', { class: 'doc-title' }, h('div', { class: 'doc-kind' }, 'Credit application'),
        client ? h('div', { class: 'doc-small' }, `For ${client.name}`) : null)),
    section('Business',
      blank('Legal name', true), blank('Operating name (if different)', true),
      blank('Business address', true), blank('Mailing address (if different)', true),
      blank('Phone'), blank('Email for invoices and statements'),
      blank('Type of business (corporation, partnership, sole proprietor)'), blank('Years in business'),
      blank('GST/HST number'), blank('RST/PST number (attach your certificate if our work is exempt)')),
    section('Accounts payable contact',
      blank('Name'), blank('Title'), blank('Phone'), blank('Email')),
    section('Bank reference',
      blank('Bank and branch'), blank('Contact and phone'), blank('Account in the name of', true)),
    section('Trade references',
      blank('1. Company'), blank('Contact and phone'), blank('2. Company'), blank('Contact and phone'), blank('3. Company'), blank('Contact and phone')),
    section('Terms',
      h('p', { class: 'doc-small wide' }, `Payment terms: ${terms}.`),
      s.collections?.termsText ? h('p', { class: 'doc-small wide' }, s.collections.termsText) : null,
      blank('Credit limit requested')),
    section('Authorized signature',
      h('p', { class: 'doc-small wide' }, `I confirm the information above is true, and I authorize ${co.name || 'the company'} to contact the bank and trade references listed to assess this application. The information is used only to assess and manage credit.`),
      blank('Signature'), blank('Date'), blank('Name'), blank('Title')),
    h('footer', { class: 'doc-foot doc-small' }, `Please return it to ${co.name || 'us'}${co.email ? ` at ${co.email}` : ''}.`));
}

export default {
  id: 'clients',
  title: 'Clients',
  icon: 'users',
  group: 'sales',
  perm: 'clients',
  render(root, ctx) {
    if (ctx.params[0]) return detailView(root, ctx, ctx.params[0]);
    const off = listView(root, ctx);
    if (ctx.query.new) openClientSheet(ctx, null, { onSaved: (c) => ctx.nav('#/clients/' + c.id) });
    return off;
  },
};
