// Clients (S12): list, detail with related records, add/edit/delete.
import { invoiceBalanceCents, invoiceStatus, docTotals } from '../lib/money.js';
import { openLeadSheet } from './leads.js';

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
    .reduce((s, i) => s + Math.max(0, invoiceBalanceCents(store, i)), 0);
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
      { label: 'Notes', name: 'notes', type: 'textarea', value: c.notes, span: true },
    ],
    danger: client ? { label: 'Delete', onClick: () => deleteClient({ store, ui, nav }, client) } : null,
    onSubmit(v) {
      v.tags = String(v.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
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
        { key: 'balance', label: 'Owed', align: 'right', sort: (r) => r.balance, render: (r) => (r.balance > 0 ? h('span', { class: 'crm-owed' }, ui.fmtMoney(r.balance)) : ui.fmtMoney(0)) },
      ],
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
  const { store, ui, nav } = ctx;
  const { h, icon } = ui;
  let tab = ctx.query.tab || 'jobs';

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
    const drawings = store.list('drawings', (d) => d.jobId && jobIds.has(d.jobId));
    const owed = clientBalanceCents(store, id);
    const lifetime = invoices.filter((i) => i.status !== 'void').reduce((s, i) => s + docTotals(i).totalCents, 0);

    const contact = h('div', { class: 'card crm-contact' },
      h('div', { class: 'row' }, h('span', { class: 'avatar crm-avatar' }, ui.initials(c.name)),
        h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, c.name), ui.badge(c.type || '—', TYPE_TONE[c.type]))),
      h('div', { class: 'crm-contact-lines' },
        c.phone ? h('a', { href: 'tel:' + c.phone.replace(/[^0-9+]/g, ''), class: 'crm-line' }, icon('phone', 16), c.phone) : null,
        c.email ? h('a', { href: 'mailto:' + c.email, class: 'crm-line' }, icon('mail', 16), c.email) : null,
        c.address ? h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(c.address), target: '_blank', rel: 'noopener', class: 'crm-line' }, icon('map-pin', 16), c.address) : null,
        !c.phone && !c.email && !c.address ? h('span', { class: 'muted' }, 'No contact details yet.') : null),
      (c.tags || []).length ? h('div', { class: 'row' }, c.tags.map((t) => ui.badge(t))) : null,
      c.notes ? h('p', { class: 'crm-notes' }, c.notes) : null);

    const stats = h('div', { class: 'grid crm-stats' },
      ui.stat({ label: 'Open jobs', value: String(jobs.filter((j) => !CLOSED_JOB.has(j.status)).length) }),
      ui.stat({ label: 'Owed', value: ui.fmtMoney(owed), tone: owed > 0 ? 'danger' : null }),
      ui.stat({ label: 'Invoiced to date', value: ui.fmtMoney(lifetime, { whole: true }) }));

    const tabItems = [
      { id: 'jobs', label: `Jobs (${jobs.length})` },
      { id: 'estimates', label: `Estimates (${estimates.length})` },
      { id: 'invoices', label: `Invoices (${invoices.length})` },
      { id: 'leads', label: `Leads (${leads.length})` },
      { id: 'drawings', label: `Drawings (${drawings.length})` },
    ];
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
          { key: 'status', label: 'Status', render: (r) => ui.statusBadge(invoiceStatus(store, r)) },
          { key: 'dueDate', label: 'Due', sort: (r) => r.dueDate || '', render: (r) => ui.fmtDate(r.dueDate) },
          { key: 'total', label: 'Total', align: 'right', render: (r) => ui.fmtMoney(docTotals(r).totalCents) },
          { key: 'bal', label: 'Balance', align: 'right', sort: (r) => invoiceBalanceCents(store, r), render: (r) => ui.fmtMoney(Math.max(0, invoiceBalanceCents(store, r))) },
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
      if (tab === 'drawings') tabBody.append(drawings.length
        ? h('div', { class: 'grid' }, drawings.map((d) => h('a', { class: 'card click crm-drawing', href: '#/drawings/' + d.id },
          d.thumb ? h('img', { src: d.thumb, alt: '' }) : h('div', { class: 'crm-drawing-ph' }, icon('pen', 28)),
          h('div', { style: { fontWeight: 600 } }, d.name), h('div', { class: 'muted crm-sub' }, jobTitle(d.jobId)))))
        : ui.empty({ icon: 'pen', title: 'No drawings yet', text: 'Drawings attached to this client\'s jobs show up here.' }));
    };
    drawTab();

    root.append(ui.page({
      title: c.name,
      subtitle: h('a', { href: '#/clients' }, '← All clients'),
      actions: [
        ui.button('Edit', { icon: 'edit', onClick: () => openClientSheet(ctx, c) }),
        ui.button('New lead', { icon: 'funnel', onClick: () => openLeadSheet(ctx, null, { prefill: { clientId: id, contactName: c.name, email: c.email, phone: c.phone } }) }),
        ui.button('New estimate', { icon: 'file-text', href: `#/estimates/new?clientId=${id}` }),
        ui.button('New job', { variant: 'primary', icon: 'plus', href: `#/jobs?new=1&clientId=${id}` }),
      ],
    }, h('div', { class: 'crm-detail' }, contact, h('div', { class: 'stack' }, stats, tabsEl, tabBody))));
  };
  draw();
  return store.on('*', (e) => { if (['clients', 'jobs', 'estimates', 'invoices', 'payments', 'leads', 'drawings'].includes(e.coll)) draw(); });
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
