// Jobs (S15): list by status, job detail with money, drawings, change orders, crew, compliance.
import { docTotals, invoiceBalanceCents, invoicePaidCents, entryHours } from '../lib/money.js';
import { emergencyCard } from '../lib/safety-emergency.js';
import { BILLING_MODES, billingLabel, jobBillingMode, defaultBillingMode, jobRates, unbilledTm, buildTmInvoice, jobCosting } from '../lib/tm.js';
import { moduleOn } from '../lib/modules.js';

/** Can this person see money (prices, costs, margins)? Office and owners; crew never. */
const seesMoney = (auth) => auth.can('invoices') || auth.can('estimates');

/** Everything the T&M and job-costing maths read, from the store. */
export function tmSources(store) {
  return {
    timeEntries: store.list('timeEntries'), stockMoves: store.list('stockMoves'), materialRequests: store.list('materialRequests'),
    items: store.list('items'), employees: store.list('employees'), invoices: store.list('invoices'), estimates: store.list('estimates'),
  };
}

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
  // Billing mode: picked when the job is created, changeable later by managers. A new job starts
  // with the client's default ("this customer is always T&M"), else the company's.
  let mode = job ? jobBillingMode(job) : defaultBillingMode(store.settings(), store.get('clients', presetClient));
  let modeTouched = Boolean(job);
  const modeHost = h('div', { class: 'field span-2' }, h('span', null, 'Billing'));
  const drawMode = () => {
    modeHost.querySelector('.bill-choice')?.remove();
    modeHost.append(h('div', { class: 'bill-choice', role: 'radiogroup', 'aria-label': 'Billing' }, BILLING_MODES.map((m) => h('label', null,
      h('input', { type: 'radio', name: 'billingModeChoice', value: m.value, checked: mode === m.value, onChange: () => { mode = m.value; modeTouched = true; } }),
      h('span', null, h('strong', null, m.label), h('div', { class: 'meta' }, m.hint))))));
  };
  drawMode();
  const rates = jobRates(job || {}, store.settings());
  const sheet = ui.formSheet({
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
      modeHost,
      { label: 'Labour rate for this job', name: 'labourRateCents', type: 'money', value: job?.labourRateCents ?? null, placeholder: ui.centsToInput(rates.labourRateCents), hint: 'Time & material only. Blank: the company rate' },
      { label: 'Scope / description', name: 'description', type: 'textarea', value: job?.description, span: true },
    ],
    onSubmit(v, form) {
      if (v.endDate && v.startDate && v.endDate < v.startDate) { ui.toast('End date is before start date', 'error'); return false; }
      if (!v.address && v.clientId) v.address = store.get('clients', v.clientId)?.address || '';
      delete v.billingModeChoice;
      const rateRaw = form.querySelector('[name=labourRateCents]').value.trim();
      const data = { ...v, clientId: v.clientId || null, crewIds: [...crew], billingMode: mode, labourRateCents: rateRaw === '' ? null : v.labourRateCents };
      let saved;
      if (job) saved = store.update('jobs', job.id, data);
      else saved = store.add('jobs', { ...data, number: store.nextNumber('job'), estimateId: null, changeOrders: [] });
      ui.toast(job ? 'Job saved' : `Job ${saved.number} created`, 'success');
      onSaved?.(saved);
    },
  });
  // A new job follows the client's default until someone picks a mode by hand.
  if (!job) {
    sheet.el.querySelector('[name=clientId]')?.addEventListener('change', (e) => {
      if (modeTouched) return;
      mode = defaultBillingMode(store.settings(), store.get('clients', e.target.value));
      drawMode();
    });
  }
  return sheet;
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
  const money$ = seesMoney(auth);
  const on = (m) => (ctx.on ? ctx.on(m) : moduleOn(store.settings(), m));
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
        if (on('schedule')) for (const s of store.list('schedule', (x) => x.jobId === job.id)) store.remove('schedule', s.id);
        store.remove('jobs', job.id);
        ui.toast('Job deleted'); nav('#/jobs');
      } }) : null,
    ].filter(Boolean);

    const meta = h('div', { class: 'ops-meta' },
      h('span', { class: 'ops-meta-item' }, ui.icon('users', 16), client ? h('a', { href: '#/clients/' + client.id }, client.name) : h('span', { class: 'muted' }, 'No client')),
      job.address ? h('span', { class: 'ops-meta-item' }, ui.icon('map-pin', 16), h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(job.address), target: '_blank', rel: 'noopener' }, job.address)) : null,
      h('span', { class: 'ops-meta-item' }, ui.icon('calendar', 16), `${ui.fmtDate(job.startDate)} – ${ui.fmtDate(job.endDate)}`),
      h('span', { class: 'ops-meta-item' }, statusSel),
      h('span', { class: 'ops-meta-item' }, ui.badge(billingLabel(jobBillingMode(job)), jobBillingMode(job) === 'tm' ? 'accent' : 'neutral')),
      h('span', { class: 'ops-meta-item' }, avatars(ui, store, job.crewIds, 6)));

    // Tabs for turned-off modules are left out (their records stay).
    const moneyLabel = on('estimates') && on('invoices') ? 'Estimates & invoices' : on('invoices') ? 'Invoices' : 'Estimates';
    const nReq = store.count('materialRequests', (r) => r.jobId === job.id && !['fulfilled', 'cancelled'].includes(r.status));
    const tabsList = [
      { id: 'overview', label: 'Overview' },
      on('drawings') ? { id: 'drawings', label: 'Drawings' } : null,
      (on('estimates') || on('invoices')) && money$ ? { id: 'money', label: moneyLabel } : null,
      { id: 'changes', label: `Change orders${job.changeOrders?.length ? ' ' + job.changeOrders.length : ''}` },
      on('schedule') ? { id: 'schedule', label: 'Schedule' } : null,
      on('time') ? { id: 'time', label: 'Time' } : null,
      on('materials') ? { id: 'materials', label: `Material${nReq ? ' ' + nReq : ''}` } : null,
      on('compliance') ? { id: 'compliance', label: 'Compliance' } : null,
      on('panels') ? { id: 'panels', label: 'Panels' } : null,
    ].filter(Boolean);
    if (!tabsList.some((t) => t.id === tab)) tab = 'overview';
    const panel = h('div', { class: 'ops-tabpanel' });
    const renderers = { overview, drawings, money, changes, schedule, time, materials, compliance, panels };
    (renderers[tab] || overview)(panel, job, m);

    host.append(ui.page({ title: `${job.number} · ${job.title}`, actions }, meta,
      emergencyCard(ctx, job.id, { editHref: canEdit ? `#/safety/job/${job.id}` : null }) || (canEdit ? h('a', { class: 'sf-em-add', href: `#/safety/job/${job.id}` }, '+ Add emergency info for this site') : null),
      h('div', { class: 'ops-tabs-row' }, ui.tabs(tabsList, tab, (t) => { tab = t; draw(); })), panel));
  };

  function overview(el, job, m) {
    const pct = m.revenueCents ? Math.round((m.marginCents / m.revenueCents) * 100) : null;
    const tm = jobBillingMode(job) === 'tm';
    el.append(
      h('div', { class: 'grid ops-stats' },
        money$ && on('estimates') ? ui.stat({ label: tm ? 'Estimate (guide)' : 'Estimate', value: ui.fmtMoney(m.estCents, { whole: true }), hint: m.coCents ? `+ ${ui.fmtMoney(m.coCents, { whole: true })} approved changes` : `${m.estimates.length} estimate(s)` }) : null,
        money$ && on('invoices') ? ui.stat({ label: 'Invoiced', value: ui.fmtMoney(m.invoicedCents, { whole: true }), hint: `${ui.fmtMoney(m.paidCents, { whole: true })} paid · ${ui.fmtMoney(m.balanceCents, { whole: true })} due`, tone: m.balanceCents > 0 ? 'accent' : null }) : null,
        ui.stat({ label: 'Labour', value: ui.fmtHours(m.hours), hint: money$ ? `${ui.fmtMoney(m.labourCents, { whole: true })} cost` : 'logged on this job' }),
        money$ ? ui.stat({ label: 'Materials used', value: ui.fmtMoney(m.materialCents, { whole: true }), hint: 'at cost, from stock moves' }) : null,
        money$ ? ui.stat({ label: 'Margin', value: ui.fmtMoney(m.marginCents, { whole: true }), hint: pct == null ? 'no revenue yet' : `${pct}% of ${m.invoicedCents ? 'invoiced' : 'estimate'}`, tone: m.marginCents < 0 ? 'danger' : 'success' }) : null),
      canEdit ? (tm ? tmCard(job) : estimateVsActual(job)) : null,
      h('h2', { class: 'section' }, 'Scope'),
      h('div', { class: 'card flat ops-scope' }, job.description ? job.description : h('span', { class: 'muted' }, 'No description yet.')),
    );
  }

  // ---- time & material: what is not billed yet, and the invoice builder ----
  function tmCard(job) {
    const src = tmSources(store);
    const u = unbilledTm({ job, settings: store.settings(), ...src, dayOf: ui.localDay });
    const canBill = money$ && auth.can('invoices') && on('invoices');
    const parts = [
      `${ui.fmtHours(u.hours)} labour`, u.travelHours ? `${ui.fmtHours(u.travelHours)} travel` : null,
      `${u.materials.length} material line${u.materials.length === 1 ? '' : 's'}`,
    ].filter(Boolean).join(' · ');
    return h('section', { class: 'card tm-card', dataset: { tm: job.id } },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, 'Time & material not billed yet'),
          h('div', { class: 'muted' }, parts, u.pendingApproval ? ` · ${u.pendingApproval} entr${u.pendingApproval === 1 ? 'y' : 'ies'} waiting for approval` : '')),
        money$ ? h('strong', { class: 'num', style: { fontSize: 'var(--fs-xl)' }, dataset: { unbilled: String(u.totalCents) } }, ui.fmtMoney(u.totalCents)) : null),
      money$ ? h('div', { class: 'muted' }, `At ${ui.fmtMoney(u.rates.labourRateCents)}/h${u.rates.travelRateCents !== u.rates.labourRateCents ? `, travel ${ui.fmtMoney(u.rates.travelRateCents)}/h` : ''}; material at cost + ${u.rates.markupPct}%. Before tax.`) : null,
      canBill ? h('div', { class: 'row' }, ui.button('Build invoice from time & material', { variant: 'primary', icon: 'receipt', onClick: () => buildInvoiceSheet(job) })) : null);
  }

  function buildInvoiceSheet(job) {
    const last = store.list('invoices', (i) => i.jobId === job.id && i.tm?.to && i.status !== 'void').map((i) => i.tm.to).sort().at(-1);
    const dayAfter = (d) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + 1); return ui.localDay(x); };
    let from = last ? dayAfter(last) : (job.startDate || '');
    let to = ui.today();
    const preview = h('div', { class: 'stack' });
    const settings = store.settings();
    const drawPreview = () => {
      ui.clear(preview);
      const u = unbilledTm({ job, settings, ...tmSources(store), from, to, dayOf: ui.localDay });
      if (u.empty) {
        preview.append(h('p', { class: 'muted', style: { margin: 0 } }, u.pendingApproval ? `Nothing approved in this range: ${u.pendingApproval} time entr${u.pendingApproval === 1 ? 'y is' : 'ies are'} waiting for approval.` : 'Nothing to bill in this range.'));
        return;
      }
      const draft = buildTmInvoice({ job, settings, issueDate: ui.today(), dueDate: ui.today(14), from, to, fmtDay: (d) => ui.fmtDate(d, { month: 'short', day: 'numeric' }), ...tmSources(store), dayOf: ui.localDay });
      preview.append(ui.table({
        columns: [
          { key: 'd', label: 'Line', render: (l) => l.description },
          { key: 'q', label: 'Qty', align: 'right', render: (l) => ui.fmtNum(l.qty, Number.isInteger(l.qty) ? 0 : 2) },
          { key: 'u', label: 'Rate', align: 'right', render: (l) => ui.fmtMoney(l.unitCents) },
          { key: 't', label: 'Amount', align: 'right', render: (l) => ui.fmtMoney(Math.round(l.qty * l.unitCents)) },
        ],
        rows: draft.invoice.lines,
      }), h('div', { class: 'row' }, h('span', { class: 'grow muted' }, `Taxes from ${settings.company?.province || 'your province'} are added on the invoice.${u.missingCost ? ` ${u.missingCost} material line${u.missingCost === 1 ? ' has' : 's have'} no cost yet: set the price on the invoice.` : ''}`),
        h('strong', { class: 'num' }, `${ui.fmtMoney(u.totalCents)} before tax`)));
    };
    const range = h('div', { class: 'form-grid' },
      ui.field({ label: 'From', name: 'from', type: 'date', value: from }),
      ui.field({ label: 'To', name: 'to', type: 'date', value: to }));
    range.addEventListener('change', (e) => { if (e.target.name === 'from') from = e.target.value; if (e.target.name === 'to') to = e.target.value; drawPreview(); });
    drawPreview();
    const sheet = ui.openSheet({
      title: `Bill ${job.number}: time & material`, wide: true,
      body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Approved time (travel included) at your rates, and material used at cost + markup. Each entry is billed once; voiding the invoice frees it again.'), range, preview),
      actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), ui.button('Create invoice', { variant: 'primary', icon: 'receipt', onClick: () => {
        let draft;
        try { draft = buildTmInvoice({ job, settings: store.settings(), issueDate: ui.today(), dueDate: ui.today(14), from, to, fmtDay: (d) => ui.fmtDate(d, { month: 'short', day: 'numeric' }), ...tmSources(store), dayOf: ui.localDay }); } catch (e) { ui.toast(e.message, 'error', 4000); return; }
        const inv = store.add('invoices', { ...draft.invoice, number: store.nextNumber('invoice') });
        sheet.close();
        ui.toast(`${inv.number} created from ${draft.unbilled.labour.length} time entr${draft.unbilled.labour.length === 1 ? 'y' : 'ies'} and ${draft.unbilled.materials.length} material line${draft.unbilled.materials.length === 1 ? '' : 's'}`, 'success', 4000);
        nav('#/invoices/' + inv.id);
      } })],
    });
  }

  // ---- fixed price: estimate against actual ----
  function estimateVsActual(job) {
    const c = jobCosting({ job, ...tmSources(store) });
    const bar = (pct) => h('div', { class: ['eva-bar', pct > 100 ? 'over' : pct > 85 ? 'near' : null] }, h('i', { style: { width: `${Math.min(100, Math.max(0, pct || 0))}%` } }));
    const row = (label, est, act, pct, fmt) => h('div', { class: 'eva-row' }, h('span', { class: 'label' }, label), bar(pct),
      h('span', { class: 'num' }, `${fmt(act)} of ${fmt(est)}${pct != null ? ` · ${pct}%` : ''}`));
    const hoursPct = c.hoursUsedPct;
    return h('section', { class: 'card tm-card', dataset: { eva: job.id } },
      h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h3', { style: { margin: 0 } }, 'Estimate vs actual'),
        h('div', { class: 'muted' }, c.estimates ? 'Fixed price: time is for payroll and job costing; it is never billed.' : 'No estimate on this job yet: add one to compare.'))),
      h('div', { class: 'eva' },
        row('Hours', c.estHours, Math.round((c.hours + c.travelHours) * 100) / 100, hoursPct, (n) => `${ui.fmtNum(n, 1)} h`),
        money$ ? row('Cost', c.estCostCents, c.costCents, c.costUsedPct, (n) => ui.fmtMoney(n, { whole: true })) : null,
        money$ ? h('div', { class: 'eva-row' }, h('span', { class: 'label' }, 'Margin'), h('span', { class: 'muted' }, `Contract ${ui.fmtMoney(c.contractCents, { whole: true })}, planned margin ${ui.fmtMoney(c.estMarginCents, { whole: true })}`),
          h('strong', { class: ['num', c.marginCents < 0 ? 'danger' : null], dataset: { margin: String(c.marginCents) } }, `${ui.fmtMoney(c.marginCents, { whole: true })}${c.marginPct != null ? ` · ${c.marginPct}%` : ''}`)) : null));
  }

  function materials(el, job) {
    const rows = store.list('materialRequests', (r) => r.jobId === job.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const items = new Map(store.list('items').map((i) => [i.id, i]));
    el.append(h('div', { class: 'row ops-sub-actions' }, ui.button('Request material', { variant: 'primary', icon: 'truck', href: `#/materials?new=1&jobId=${job.id}` }),
      canEdit ? ui.button('All requests', { icon: 'list', href: '#/materials' }) : null));
    el.append(ui.table({
      columns: [
        { key: 'when', label: 'Asked', render: (r) => ui.fmtDate(r.createdAt, { month: 'short', day: 'numeric' }) },
        { key: 'what', label: 'Material', render: (r) => h('span', null, `${r.qty ?? ''} ${r.unit || ''} `, h('strong', null, (r.itemId && items.get(r.itemId)?.name) || r.description || 'Material'), r.urgent ? h('span', { class: 'mr-urgent' }, ' urgent') : null) },
        { key: 'who', label: 'Who', render: (r) => store.get('employees', r.employeeId)?.name || '—' },
        { key: 'status', label: 'Status', render: (r) => ui.statusBadge(r.status || 'requested') },
      ],
      rows, empty: ui.empty({ icon: 'truck', title: 'No material requests', text: 'The crew ask for material from the job or the quick wheel; the office gets one list a day.' }),
    }));
  }

  function drawings(el, job) {
    const rows = store.list('drawings', (d) => d.jobId === job.id, { omit: ['underlay', 'strokes', 'texts', 'rooms'] });
    el.append(h('div', { class: 'row ops-sub-actions' }, ui.button('New drawing', { variant: 'primary', icon: 'pen', href: `#/drawings/new?jobId=${job.id}` })));
    if (!rows.length) return el.append(ui.empty({ icon: 'pen', title: 'No drawings for this job', text: 'Import a plan and mark it up with symbols and wiring.' }));
    el.append(h('div', { class: 'grid' }, rows.map((d) => h('a', { class: 'card click ops-drawing', href: '#/drawings/' + d.id },
      h('div', { class: 'ops-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: '' }) : ui.icon('pen', 28)),
      h('div', { style: { fontWeight: 600 } }, d.name),
      h('div', { class: 'muted ops-small' }, `${(d.objects || []).length} symbols · updated ${ui.fmtDate(d.updatedAt)}`)))));
  }

  function money(el, job, m) {
    const tm = jobBillingMode(job) === 'tm';
    el.append(h('div', { class: 'row ops-sub-actions' },
      on('estimates') ? ui.button('New estimate', { variant: tm ? 'secondary' : 'primary', icon: 'file-text', href: `#/estimates/new?jobId=${job.id}${job.clientId ? '&clientId=' + job.clientId : ''}` }) : null,
      on('invoices') && tm && auth.can('invoices') ? ui.button('Build invoice from time & material', { variant: 'primary', icon: 'receipt', onClick: () => buildInvoiceSheet(job) }) : null,
      on('invoices') ? ui.button('New invoice', { icon: 'receipt', href: `#/invoices/new?jobId=${job.id}` }) : null));
    if (!on('estimates')) return moneyInvoices(el, m);
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
    if (on('invoices')) moneyInvoices(el, m);
  }

  function moneyInvoices(el, m) {
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
  const offs = ['jobs', 'estimates', 'invoices', 'payments', 'timeEntries', 'schedule', 'drawings', 'permits', 'inspections', 'stockMoves', 'jobSafety', 'materialRequests'].map((c) => store.on(c, draw));
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
