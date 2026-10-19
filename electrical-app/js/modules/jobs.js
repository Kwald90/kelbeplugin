// Jobs (S15): list by status, job detail with money, drawings, change orders, crew, compliance.
import { docTotals, invoiceBalanceCents, invoicePaidCents, entryHours } from '../lib/money.js';

const STATUSES = ['lead', 'scheduled', 'in-progress', 'on-hold', 'complete', 'invoiced'];
const ACTIVE = new Set(['scheduled', 'in-progress', 'on-hold']);
const JOB_COLORS = ['#f5b301', '#1f5fb8', '#1d7044', '#7a3fb0', '#b42318', '#0f7b8a', '#c25e00', '#5f5a51'];

export function jobColor(id = '') {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return JOB_COLORS[h % JOB_COLORS.length];
}

function avatars(ui, store, ids = [], max = 4) {
  const { h } = ui;
  const people = ids.map((id) => store.get('employees', id)).filter(Boolean);
  if (!people.length) return h('span', { class: 'muted' }, '—');
  return h('span', { class: 'ops-avatars', title: people.map((p) => p.name).join(', ') },
    people.slice(0, max).map((p) => h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name))),
    people.length > max ? h('span', { class: 'avatar ops-more' }, '+' + (people.length - max)) : null);
}

function jobForm(ctx, job, onSaved) {
  const { store, ui } = ctx;
  const { h } = ui;
  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const people = store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const crew = new Set(job?.crewIds || []);
  const crewPick = h('div', { class: 'field span-2' }, h('span', null, 'Crew'),
    h('div', { class: 'ops-crew-pick' }, people.map((p) => h('label', { class: 'ops-chip-check' },
      h('input', { type: 'checkbox', checked: crew.has(p.id), onChange: (e) => (e.target.checked ? crew.add(p.id) : crew.delete(p.id)) }),
      h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)), p.name))));
  const presetClient = job?.clientId ?? ctx.query.clientId ?? '';
  return ui.formSheet({
    title: job ? `Edit ${job.number}` : 'New job',
    submitLabel: job ? 'Save' : 'Create job',
    fields: [
      { label: 'Title', name: 'title', value: job?.title, required: true, span: true, placeholder: 'e.g. Panel upgrade 200A' },
      { label: 'Client', name: 'clientId', type: 'select', value: presetClient, options: ui.recordOptions(clients) },
      { label: 'Status', name: 'status', type: 'select', value: job?.status || 'scheduled', options: STATUSES.map((s) => ({ value: s, label: s.replace(/-/g, ' ') })) },
      { label: 'Site address', name: 'address', value: job?.address, span: true },
      { label: 'Start date', name: 'startDate', type: 'date', value: job?.startDate || ui.today() },
      { label: 'End date', name: 'endDate', type: 'date', value: job?.endDate || '' },
      crewPick,
      { label: 'Scope / description', name: 'description', type: 'textarea', value: job?.description, span: true },
    ],
    onSubmit(v) {
      if (v.endDate && v.startDate && v.endDate < v.startDate) { ui.toast('End date is before start date', 'error'); return false; }
      if (!v.address && v.clientId) v.address = store.get('clients', v.clientId)?.address || '';
      const data = { ...v, clientId: v.clientId || null, crewIds: [...crew] };
      let saved;
      if (job) saved = store.update('jobs', job.id, data);
      else saved = store.add('jobs', { ...data, number: store.nextNumber('job'), estimateId: null, changeOrders: [] });
      ui.toast(job ? 'Job saved' : `Job ${saved.number} created`, 'success');
      onSaved?.(saved);
    },
  });
}

function listView(root, ctx) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const canEdit = auth.isManager();
  let filter = ctx.query.status || 'active', q = '';
  const body = h('div');
  const counts = () => {
    const all = store.list('jobs');
    return { all: all.length, active: all.filter((j) => ACTIVE.has(j.status)).length, ...Object.fromEntries(STATUSES.map((s) => [s, all.filter((j) => j.status === s).length])) };
  };
  const tabItems = () => {
    const c = counts();
    return [{ id: 'active', label: `Active ${c.active}` }, { id: 'all', label: `All ${c.all}` },
      ...STATUSES.map((s) => ({ id: s, label: `${s.replace(/-/g, ' ')} ${c[s]}` }))];
  };
  const tabHost = h('div');
  const draw = () => {
    ui.clear(tabHost).append(ui.tabs(tabItems(), filter, (id) => { filter = id; draw(); }));
    const needle = q.trim().toLowerCase();
    const rows = store.list('jobs', (j) => (filter === 'all' || (filter === 'active' ? ACTIVE.has(j.status) : j.status === filter)))
      .filter((j) => !needle || [j.number, j.title, j.address, store.get('clients', j.clientId)?.name].join(' ').toLowerCase().includes(needle))
      .sort((a, b) => (a.startDate || '9').localeCompare(b.startDate || '9'));
    const cards = rows.length ? h('div', { class: 'list ops-joblist' }, rows.map((j) => h('a', { class: 'list-row click', href: '#/jobs/' + j.id, style: { color: 'inherit', textDecoration: 'none' } },
      h('i', { class: 'ops-dot', style: { background: jobColor(j.id) } }),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'title' }, `${j.number} · ${j.title}`),
        h('div', { class: 'meta' }, [store.get('clients', j.clientId)?.name, `${ui.fmtDate(j.startDate, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(j.endDate, { month: 'short', day: 'numeric' })}`].filter(Boolean).join(' · '))),
      ui.statusBadge(j.status)))) : null;
    ui.clear(body).append(cards || '', ui.table({
      columns: [
        { key: 'number', label: 'Job', render: (j) => h('span', { class: 'ops-jobnum' }, h('i', { class: 'ops-dot', style: { background: jobColor(j.id) } }), j.number), sort: (j) => j.number },
        { key: 'title', label: 'Title', render: (j) => h('div', null, h('div', { class: 'title', style: { fontWeight: 600 } }, j.title), h('div', { class: 'muted ops-small' }, j.address || '')), sort: (j) => j.title },
        { key: 'client', label: 'Client', render: (j) => store.get('clients', j.clientId)?.name || h('span', { class: 'muted' }, '—'), sort: (j) => store.get('clients', j.clientId)?.name || '' },
        { key: 'dates', label: 'Dates', render: (j) => `${ui.fmtDate(j.startDate, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(j.endDate, { month: 'short', day: 'numeric' })}`, sort: (j) => j.startDate || '' },
        { key: 'crew', label: 'Crew', render: (j) => avatars(ui, store, j.crewIds) },
        { key: 'status', label: 'Status', render: (j) => ui.statusBadge(j.status), sort: (j) => STATUSES.indexOf(j.status) },
      ],
      rows,
      onRowClick: (j) => nav('#/jobs/' + j.id),
      empty: ui.empty({ icon: 'briefcase', title: needle ? 'No jobs match' : 'No jobs here yet', text: needle ? 'Try a different search.' : 'Create a job to schedule crew, mark up plans and bill it.',
        action: canEdit ? ui.button('New job', { variant: 'primary', icon: 'plus', onClick: () => jobForm(ctx, null, (j) => nav('#/jobs/' + j.id)) }) : null }),
    }));
  };
  root.append(ui.page({
    title: 'Jobs', subtitle: 'Every job from first visit to final invoice',
    actions: canEdit ? [ui.button('New job', { variant: 'primary', icon: 'plus', onClick: () => jobForm(ctx, null, (j) => nav('#/jobs/' + j.id)) })] : [],
  },
  h('div', { class: 'row ops-toolbar' }, tabHost, h('span', { class: 'grow' }), ui.searchBox('Search jobs', (v) => { q = v; draw(); })),
  body));
  draw();
  if (ctx.query.new && canEdit) jobForm(ctx, null, (j) => nav('#/jobs/' + j.id));
  const off = store.on('jobs', draw);
  return off;
}

function moneyFor(store, job) {
  const estimates = store.list('estimates', (e) => e.jobId === job.id || e.id === job.estimateId);
  const accepted = estimates.filter((e) => e.status === 'accepted');
  const estCents = (accepted.length ? accepted : estimates).reduce((s, e) => s + docTotals(e).totalCents, 0);
  const invoices = store.list('invoices', (i) => i.jobId === job.id && i.status !== 'void');
  const invoicedCents = invoices.reduce((s, i) => s + docTotals(i).totalCents, 0);
  const paidCents = invoices.reduce((s, i) => s + invoicePaidCents(store, i.id), 0);
  const balanceCents = invoices.reduce((s, i) => s + Math.max(0, invoiceBalanceCents(store, i)), 0);
  const entries = store.list('timeEntries', (t) => t.jobId === job.id);
  let hours = 0, labourCents = 0;
  for (const t of entries) {
    const hrs = entryHours(t);
    hours += hrs;
    labourCents += Math.round(hrs * (store.get('employees', t.employeeId)?.rateCents || 0));
  }
  const moves = store.list('stockMoves', (m) => m.jobId === job.id);
  const materialCents = moves.reduce((s, m) => s + Math.round((Number(m.qty) || 0) * (store.get('items', m.itemId)?.costCents || 0)), 0);
  const coCents = (job.changeOrders || []).filter((c) => c.status === 'approved').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
  const revenueCents = invoicedCents || estCents + coCents;
  const costCents = labourCents + materialCents;
  return { estimates, invoices, estCents, invoicedCents, paidCents, balanceCents, hours, labourCents, materialCents, coCents, revenueCents, costCents, marginCents: revenueCents - costCents };
}

function detailView(root, ctx, id) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const canEdit = auth.isManager();
  let tab = ctx.query.tab || 'overview';
  const host = h('div');

  const draw = () => {
    const job = store.get('jobs', id);
    ui.clear(host);
    if (!job) {
      host.append(ui.page({ title: 'Job not found' }, ui.empty({ icon: 'briefcase', title: 'This job no longer exists', action: ui.button('Back to jobs', { href: '#/jobs' }) })));
      return;
    }
    const client = store.get('clients', job.clientId);
    const m = moneyFor(store, job);
    const statusSel = h('select', { class: 'input ops-status-select', 'aria-label': 'Job status', disabled: !canEdit,
      onChange: (e) => { store.update('jobs', job.id, { status: e.target.value }); ui.toast('Status updated', 'success'); } },
    STATUSES.map((s) => h('option', { value: s, selected: s === job.status }, s.replace(/-/g, ' '))));

    const actions = [
      ui.button('', { icon: 'chevron-left', title: 'All jobs', href: '#/jobs' }),
      canEdit ? ui.button('Edit', { icon: 'edit', onClick: () => jobForm(ctx, job) }) : null,
      canEdit ? ui.button('', { icon: 'trash', variant: 'ghost danger', title: 'Delete job', onClick: async () => {
        if (!(await ui.confirmDialog(`Delete ${job.number} "${job.title}"? Drawings, estimates and invoices stay but lose the link.`, { okLabel: 'Delete job' }))) return;
        for (const s of store.list('schedule', (x) => x.jobId === job.id)) store.remove('schedule', s.id);
        store.remove('jobs', job.id);
        ui.toast('Job deleted'); nav('#/jobs');
      } }) : null,
    ].filter(Boolean);

    const meta = h('div', { class: 'ops-meta' },
      h('span', { class: 'ops-meta-item' }, ui.icon('users', 16), client ? h('a', { href: '#/clients/' + client.id }, client.name) : h('span', { class: 'muted' }, 'No client')),
      job.address ? h('span', { class: 'ops-meta-item' }, ui.icon('map-pin', 16), h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(job.address), target: '_blank', rel: 'noopener' }, job.address)) : null,
      h('span', { class: 'ops-meta-item' }, ui.icon('calendar', 16), `${ui.fmtDate(job.startDate)} – ${ui.fmtDate(job.endDate)}`),
      h('span', { class: 'ops-meta-item' }, statusSel),
      h('span', { class: 'ops-meta-item' }, avatars(ui, store, job.crewIds, 6)));

    const tabsList = [
      { id: 'overview', label: 'Overview' }, { id: 'drawings', label: 'Drawings' }, { id: 'money', label: 'Estimates & invoices' },
      { id: 'changes', label: `Change orders${job.changeOrders?.length ? ' ' + job.changeOrders.length : ''}` },
      { id: 'schedule', label: 'Schedule' }, { id: 'time', label: 'Time' }, { id: 'compliance', label: 'Compliance' }, { id: 'panels', label: 'Panels' },
    ];
    const panel = h('div', { class: 'ops-tabpanel' });
    const renderers = { overview, drawings, money, changes, schedule, time, compliance, panels };
    (renderers[tab] || overview)(panel, job, m);

    host.append(ui.page({ title: `${job.number} · ${job.title}`, actions }, meta,
      h('div', { class: 'ops-tabs-row' }, ui.tabs(tabsList, tab, (t) => { tab = t; draw(); })), panel));
  };

  function overview(el, job, m) {
    const pct = m.revenueCents ? Math.round((m.marginCents / m.revenueCents) * 100) : null;
    el.append(
      h('div', { class: 'grid ops-stats' },
        ui.stat({ label: 'Estimate', value: ui.fmtMoney(m.estCents, { whole: true }), hint: m.coCents ? `+ ${ui.fmtMoney(m.coCents, { whole: true })} approved changes` : `${m.estimates.length} estimate(s)` }),
        ui.stat({ label: 'Invoiced', value: ui.fmtMoney(m.invoicedCents, { whole: true }), hint: `${ui.fmtMoney(m.paidCents, { whole: true })} paid · ${ui.fmtMoney(m.balanceCents, { whole: true })} due`, tone: m.balanceCents > 0 ? 'accent' : null }),
        ui.stat({ label: 'Labour', value: ui.fmtHours(m.hours), hint: `${ui.fmtMoney(m.labourCents, { whole: true })} cost` }),
        ui.stat({ label: 'Materials used', value: ui.fmtMoney(m.materialCents, { whole: true }), hint: 'at cost, from stock moves' }),
        ui.stat({ label: 'Margin', value: ui.fmtMoney(m.marginCents, { whole: true }), hint: pct == null ? 'no revenue yet' : `${pct}% of ${m.invoicedCents ? 'invoiced' : 'estimate'}`, tone: m.marginCents < 0 ? 'danger' : 'success' })),
      h('h2', { class: 'section' }, 'Scope'),
      h('div', { class: 'card flat ops-scope' }, job.description ? job.description : h('span', { class: 'muted' }, 'No description yet.')),
    );
  }

  function drawings(el, job) {
    const rows = store.list('drawings', (d) => d.jobId === job.id);
    el.append(h('div', { class: 'row ops-sub-actions' }, ui.button('New drawing', { variant: 'primary', icon: 'pen', href: `#/drawings/new?jobId=${job.id}` })));
    if (!rows.length) return el.append(ui.empty({ icon: 'pen', title: 'No drawings for this job', text: 'Import a plan and mark it up with symbols and wiring.' }));
    el.append(h('div', { class: 'grid' }, rows.map((d) => h('a', { class: 'card click ops-drawing', href: '#/drawings/' + d.id },
      h('div', { class: 'ops-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: '' }) : ui.icon('pen', 28)),
      h('div', { style: { fontWeight: 600 } }, d.name),
      h('div', { class: 'muted ops-small' }, `${(d.objects || []).length} symbols · updated ${ui.fmtDate(d.updatedAt)}`)))));
  }

  function money(el, job, m) {
    el.append(h('div', { class: 'row ops-sub-actions' },
      ui.button('New estimate', { variant: 'primary', icon: 'file-text', href: `#/estimates/new?jobId=${job.id}${job.clientId ? '&clientId=' + job.clientId : ''}` }),
      ui.button('New invoice', { icon: 'receipt', href: `#/invoices/new?jobId=${job.id}` })));
    el.append(h('h2', { class: 'section' }, 'Estimates'));
    el.append(ui.table({
      columns: [
        { key: 'number', label: 'No.' }, { key: 'title', label: 'Title' },
        { key: 'status', label: 'Status', render: (e) => ui.statusBadge(e.status) },
        { key: 'total', label: 'Total', align: 'right', render: (e) => ui.fmtMoney(docTotals(e).totalCents) },
      ],
      rows: m.estimates, onRowClick: (e) => nav('#/estimates/' + e.id),
      empty: h('p', { class: 'muted' }, 'No estimates yet.'),
    }));
    el.append(h('h2', { class: 'section' }, 'Invoices'));
    el.append(ui.table({
      columns: [
        { key: 'number', label: 'No.' }, { key: 'issueDate', label: 'Issued', render: (i) => ui.fmtDate(i.issueDate) },
        { key: 'status', label: 'Status', render: (i) => ui.statusBadge(i.status) },
        { key: 'total', label: 'Total', align: 'right', render: (i) => ui.fmtMoney(docTotals(i).totalCents) },
        { key: 'bal', label: 'Balance', align: 'right', render: (i) => ui.fmtMoney(invoiceBalanceCents(store, i)) },
      ],
      rows: m.invoices, onRowClick: (i) => nav('#/invoices/' + i.id),
      empty: h('p', { class: 'muted' }, 'No invoices yet.'),
    }));
  }

  function changes(el, job) {
    const cos = job.changeOrders || [];
    const save = (list) => store.update('jobs', job.id, { changeOrders: list });
    const edit = (co) => ui.formSheet({
      title: co ? 'Edit change order' : 'New change order',
      fields: [
        { label: 'Description', name: 'title', value: co?.title, required: true, span: true },
        { label: 'Amount', name: 'amountCents', type: 'money', value: co?.amountCents ?? 0, required: true },
        { label: 'Date', name: 'date', type: 'date', value: co?.date || ui.today() },
        { label: 'Status', name: 'status', type: 'select', value: co?.status || 'pending', options: ['pending', 'approved', 'rejected'] },
      ],
      danger: co ? { label: 'Delete', onClick: () => save(cos.filter((c) => c.id !== co.id)) } : null,
      onSubmit(v) {
        if (co) save(cos.map((c) => (c.id === co.id ? { ...c, ...v } : c)));
        else save([...cos, { id: 'co-' + Date.now().toString(36), ...v }]);
      },
    });
    const approved = cos.filter((c) => c.status === 'approved').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
    const pending = cos.filter((c) => c.status === 'pending').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
    el.append(h('div', { class: 'row ops-sub-actions' },
      canEdit ? ui.button('Add change order', { variant: 'primary', icon: 'plus', onClick: () => edit(null) }) : null,
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, 'Approved '), h('strong', { class: 'num' }, ui.fmtMoney(approved)),
      h('span', { class: 'muted' }, ' · Pending '), h('strong', { class: 'num' }, ui.fmtMoney(pending))));
    el.append(ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (c) => ui.fmtDate(c.date) },
        { key: 'title', label: 'Change' },
        { key: 'amount', label: 'Amount', align: 'right', render: (c) => ui.fmtMoney(c.amountCents) },
        { key: 'status', label: 'Status', render: (c) => ui.statusBadge(c.status) },
        { key: 'act', label: '', render: (c) => (canEdit && c.status === 'pending' ? h('span', { class: 'row', onClick: (e) => e.stopPropagation() },
          ui.button('Approve', { size: 'sm', icon: 'check', onClick: () => save(cos.map((x) => (x.id === c.id ? { ...x, status: 'approved' } : x))) }),
          ui.button('Reject', { size: 'sm', variant: 'ghost danger', onClick: () => save(cos.map((x) => (x.id === c.id ? { ...x, status: 'rejected' } : x))) })) : '') },
      ],
      rows: cos, onRowClick: canEdit ? edit : null,
      empty: ui.empty({ icon: 'edit', title: 'No change orders', text: 'Record scope changes and get them approved before the work.' }),
    }));
  }

  function schedule(el, job) {
    const rows = store.list('schedule', (s) => s.jobId === job.id).sort((a, b) => a.date.localeCompare(b.date));
    el.append(h('div', { class: 'row ops-sub-actions' }, ui.button('Open schedule board', { icon: 'calendar', href: '#/schedule' })));
    el.append(ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (s) => ui.fmtDate(s.date, { weekday: 'short', month: 'short', day: 'numeric' }), sort: (s) => s.date },
        { key: 'emp', label: 'Who', render: (s) => store.get('employees', s.employeeId)?.name || '—' },
        { key: 'hours', label: 'Hours', align: 'right', render: (s) => ui.fmtHours(s.hours) },
        { key: 'note', label: 'Note', render: (s) => s.note || '' },
      ],
      rows, empty: ui.empty({ icon: 'calendar', title: 'Nobody scheduled', text: 'Assign crew on the schedule board.' }),
    }));
  }

  function time(el, job) {
    const rows = store.list('timeEntries', (t) => t.jobId === job.id).sort((a, b) => b.clockIn.localeCompare(a.clockIn));
    el.append(ui.table({
      columns: [
        { key: 'day', label: 'Day', render: (t) => ui.fmtDate(t.clockIn) },
        { key: 'emp', label: 'Who', render: (t) => store.get('employees', t.employeeId)?.name || '—' },
        { key: 'in', label: 'In – out', render: (t) => `${ui.fmtTime(t.clockIn)} – ${t.clockOut ? ui.fmtTime(t.clockOut) : 'on the clock'}` },
        { key: 'hrs', label: 'Hours', align: 'right', render: (t) => ui.fmtHours(entryHours(t)) },
        { key: 'ok', label: 'Approved', render: (t) => (t.approved ? ui.badge('approved', 'success') : ui.badge('pending', 'warning')) },
      ],
      rows, empty: ui.empty({ icon: 'clock', title: 'No time logged', text: 'Crew clock in against this job from the Time clock.' }),
    }));
  }

  function compliance(el, job) {
    const permits = store.list('permits', (p) => p.jobId === job.id);
    const insp = store.list('inspections', (i) => i.jobId === job.id).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    el.append(h('div', { class: 'row ops-sub-actions' }, ui.button('Open compliance', { icon: 'shield-check', href: '#/compliance' })));
    el.append(h('h2', { class: 'section' }, 'Permits'), ui.table({
      columns: [
        { key: 'number', label: 'Permit' }, { key: 'type', label: 'Type' }, { key: 'authority', label: 'Authority' },
        { key: 'status', label: 'Status', render: (p) => ui.statusBadge(p.status) },
        { key: 'exp', label: 'Expires', render: (p) => ui.fmtDate(p.expiryDate) },
      ], rows: permits, empty: h('p', { class: 'muted' }, 'No permits recorded.'),
    }));
    el.append(h('h2', { class: 'section' }, 'Inspections'), ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (i) => ui.fmtDate(i.date) }, { key: 'type', label: 'Type' },
        { key: 'inspector', label: 'Inspector' }, { key: 'result', label: 'Result', render: (i) => ui.statusBadge(i.result) },
      ], rows: insp, empty: h('p', { class: 'muted' }, 'No inspections recorded.'),
    }));
  }

  function panels(el, job) {
    const rows = store.list('panels', (p) => p.jobId === job.id);
    el.append(h('div', { class: 'row ops-sub-actions' }, ui.button('Panel schedules', { icon: 'panel', href: `#/panels?jobId=${job.id}` })));
    el.append(rows.length ? h('div', { class: 'list' }, rows.map((p) => h('a', { class: 'list-row click', href: `#/panels/${p.id}`, style: { color: 'inherit', textDecoration: 'none' } },
      ui.icon('panel', 20), h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'meta' }, `${p.voltage} · ${p.mainAmps}A main · ${(p.circuits || []).length} circuits`)))))
      : ui.empty({ icon: 'panel', title: 'No panel schedules', text: 'Build the panel schedule for this job.' }));
  }

  root.append(host);
  draw();
  const offs = ['jobs', 'estimates', 'invoices', 'payments', 'timeEntries', 'schedule', 'drawings', 'permits', 'inspections', 'stockMoves'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

export default {
  id: 'jobs',
  title: 'Jobs',
  icon: 'briefcase',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    if (ctx.params[0]) return detailView(root, ctx, ctx.params[0]);
    return listView(root, ctx);
  },
};
