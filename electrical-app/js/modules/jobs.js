// Jobs (S15): list by status, job detail with money, drawings, change orders, crew, compliance.
import { docTotals, invoiceShown, invoicePaidCents, entryHours } from '../lib/money.js';
import { emergencyCard } from '../lib/safety-emergency.js';
import { siteCard } from '../lib/location-ui.js';
import { jobOverview } from '../lib/job-overview.js';
import { STATUS_LABEL as MATERIAL_STATUS } from '../lib/materials.js';
import { entryMinutes, kindOf, fmtH } from '../lib/timesheet.js';
import { locationSettings } from '../lib/location-policy.js';
import { BILLING_MODES, billingLabel, jobBillingMode, defaultBillingMode, jobRates, unbilledTm, buildTmInvoice, jobCosting } from '../lib/tm.js';
import { moduleOn } from '../lib/modules.js';
import { exemptionEditor, printNode } from '../lib/doc-view.js';
import { newDocTax } from '../lib/tax.js';
import { closeoutChecklist, closeoutRecord, closeoutBlocks, OVERRIDE_MIN, releaseDue } from '../lib/closeout.js';
import { holdbackLedger, depositsAvailable } from '../lib/receivables.js';
import { ticketToChangeOrder, ticketLabel, ticketReconciliation, billableTickets, batchCandidates, ticketSummary } from '../lib/tickets.js';
import { buildSignature, signatureSheet, emailAcceptanceSheet, queueSignatureFirst } from '../lib/esign.js';
import { filterStandards, visibleRequirements, applyStandard } from '../lib/job-standards.js';

/** Can this person see money (prices, costs, margins)? Office and owners; crew never. */
const seesMoney = (auth) => auth.seesMoney?.() ?? (auth.can('invoices') || auth.can('estimates'));

/**
 * "Apply a standard": pick a region-specific job standard (a SOP with the job-standard fields) and seed
 * its materials, tasks, SOP link, optional panel and office-only draft estimate onto the job. Idempotent
 * per job+sop (lib/job-standards.js applyStandard). Managers/office only.
 */
export function applyStandardSheet(ctx, job) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const money = seesMoney(auth);
  const settings = store.settings();
  const authority = store.list('permits', (p) => p.jobId === job.id).map((p) => p.authority).find(Boolean) || null;
  let province = settings.company?.province || 'ON';
  let selectedId = null;
  let createPanel = false;
  let buildEstimate = false;

  const listHost = h('div', { class: 'list' });
  const previewHost = h('div', { class: 'stack' });

  const drawPreview = () => {
    ui.clear(previewHost);
    const sop = selectedId ? store.get('sops', selectedId) : null;
    if (!sop) { previewHost.append(h('p', { class: 'muted' }, 'Pick a standard to see what it will add.')); applyBtn.disabled = true; return; }
    applyBtn.disabled = false;
    const reqs = visibleRequirements(sop, { province: province === 'all' ? null : province, authority });
    const counts = `${(sop.materials || []).length} materials · ${(sop.tasks || []).length} tasks · ${(sop.breakers || []).length} breakers`;
    const panelBox = h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: createPanel, disabled: !(sop.breakers || []).length, onChange: (e) => { createPanel = e.target.checked; } }), h('span', null, 'Create a panel schedule from the breakers'));
    const estBox = h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: buildEstimate, onChange: (e) => { buildEstimate = e.target.checked; } }), h('span', null, 'Build a draft estimate (office only)'));
    previewHost.append(
      h('h3', { style: { margin: '0' } }, sop.jobType || sop.title),
      h('p', { class: 'muted', style: { margin: 0 } }, counts),
      reqs.length ? h('div', { class: 'card flat' }, h('strong', null, 'Region requirements'), h('ul', { class: 'sop-reqs' }, reqs.map((r) => h('li', null, [r.province, r.authority].filter(Boolean).length ? h('strong', null, [r.province, r.authority].filter(Boolean).join(' · ') + ': ') : null, r.text)))) : null,
      panelBox,
      money ? estBox : h('p', { class: 'muted', style: { margin: 0 } }, 'Draft estimate is office-only.'));
  };

  const drawList = () => {
    ui.clear(listHost);
    const rows = filterStandards(store.list('sops'), { province: province === 'all' ? null : province, authority });
    if (!rows.length) { listHost.append(h('div', { class: 'list-row muted' }, 'No job standards for this region. Create one in SOPs → Job standards.')); return; }
    for (const s of rows) {
      const row = h('label', { class: 'list-row click' },
        h('input', { type: 'radio', name: 'apply-standard', value: s.id, checked: s.id === selectedId, onChange: () => { selectedId = s.id; drawList(); drawPreview(); } }),
        h('div', { class: 'grow' }, h('div', { class: 'title' }, s.jobType || s.title),
          h('div', { class: 'meta muted' }, `${(s.region?.provinces || []).join(', ') || 'Anywhere'}${s.region?.authority ? ' · ' + s.region.authority : ''}`)),
        s.scale ? ui.badge(s.scale, 'accent') : null);
      listHost.append(row);
    }
  };

  const provincesInUse = [...new Set(store.list('sops').flatMap((s) => s.region?.provinces || []))].filter(Boolean).sort();
  const regionOpts = [{ value: settings.company?.province || 'ON', label: 'Your province' }, { value: 'all', label: 'All regions' },
    ...provincesInUse.filter((p) => p !== (settings.company?.province || 'ON')).map((p) => ({ value: p, label: p }))];
  const regionSel = h('select', { class: 'input', 'aria-label': 'Region', onChange: (e) => { province = e.target.value; selectedId = null; drawList(); drawPreview(); } },
    regionOpts.map((o) => h('option', { value: o.value, selected: o.value === province }, o.label)));

  const applyBtn = ui.button('Apply standard', { variant: 'primary', icon: 'check', disabled: true, onClick: () => {
    const sop = selectedId && store.get('sops', selectedId);
    if (!sop) return;
    const res = applyStandard({ store, auth, ui }, store.get('jobs', job.id), sop, { createPanel, buildEstimate, province: province === 'all' ? null : province, authority });
    const parts = [`${res.addedTasks} task${res.addedTasks === 1 ? '' : 's'}`, `${res.addedMaterials} material${res.addedMaterials === 1 ? '' : 's'}`];
    if (res.panel === 'added') parts.push('a panel');
    if (res.estimate === 'added') parts.push('a draft estimate');
    const skipped = res.skippedTasks + res.skippedMaterials;
    ui.toast(`Applied ${sop.jobType || sop.title}: added ${parts.join(', ')}${skipped ? `; skipped ${skipped} already applied` : ''}${res.estimate === 'blocked' ? '. Estimate needs money access.' : ''}`, 'success', 5000);
    sheet.close();
    nav('#/jobs/' + job.id + '?tab=materials');
  } });

  drawList();
  drawPreview();
  const sheet = ui.openSheet({
    title: `Apply a standard · ${job.number || ''}`, wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'A job standard is a work-type playbook. Applying it seeds the material list, a task list and the SOP onto this job; the office can also build a panel and a draft estimate.'),
      h('div', { class: 'row', style: { alignItems: 'center', gap: '8px' } }, h('span', { class: 'muted' }, 'Region'), regionSel),
      listHost, h('hr'), previewHost),
    actions: [h('span', { class: 'grow' }), ui.button('Cancel', { variant: 'ghost', onClick: () => sheet.close() }), applyBtn],
  });
  return sheet;
}

/** Everything the T&M and job-costing maths read, from the store. */
export function tmSources(store) {
  return {
    timeEntries: store.list('timeEntries'), stockMoves: store.list('stockMoves'), materialRequests: store.list('materialRequests'),
    items: store.list('items'), employees: store.list('employees'), invoices: store.list('invoices'), estimates: store.list('estimates'),
    fieldTickets: store.list('fieldTickets'),
  };
}

/** Everything the final-billing checklist reads (lib/closeout.js). */
export function closeoutSources(store, ui) {
  return {
    ...tmSources(store), payments: store.list('payments'), purchaseOrders: store.list('purchaseOrders'), bills: store.list('bills'),
    permits: store.list('permits'), inspections: store.list('inspections'), settings: store.settings(), dayOf: ui.localDay,
  };
}

/**
 * Change a job's status. `complete` shows the final-billing checklist as warnings and saves it; `invoiced`
 * blocks on its block items until they are cleared or the office records why (at least 10 characters).
 * The server refuses `invoiced` without a checked closeout (r1-get-paid.md 4.8).
 */
export async function setJobStatus(ctx, job, status) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const by = auth.who().name;
  if (status === 'complete' && job.status !== 'complete') {
    const list = closeoutChecklist(job, closeoutSources(store, ui), { at: 'complete', asOf: ui.today() });
    store.update('jobs', job.id, { status, closeout: closeoutRecord(list, { by, stage: 'complete' }), contract: { ...(job.contract || {}), completedOn: job.contract?.completedOn || ui.today() } });
    if (list.length) checklistSheet(ctx, job, list, { title: `${job.number} is complete: still open`, info: 'Clear these before the job is marked invoiced.' });
    else ui.toast('Status updated', 'success');
    return true;
  }
  if (status === 'invoiced' && job.status !== 'invoiced') {
    const list = closeoutChecklist(job, closeoutSources(store, ui), { at: 'invoiced', asOf: ui.today() });
    const blocks = closeoutBlocks(list);
    if (!blocks.length) {
      store.update('jobs', job.id, { status, closeout: closeoutRecord(list, { by }) });
      ui.toast(list.length ? `${job.number} invoiced. ${list.length} warning${list.length === 1 ? '' : 's'} noted.` : `${job.number} invoiced`, 'success');
      return true;
    }
    return new Promise((resolve) => {
      let done = false;
      const reason = h('textarea', { class: 'input', rows: 2, name: 'overrideReason', placeholder: 'Why the job can be called invoiced anyway' });
      const sheet = checklistSheet(ctx, job, list, {
        title: `${job.number} can't be marked invoiced yet`, info: 'Clear the items marked "must clear", or record why the job is invoiced anyway.',
        extra: h('label', { class: 'field' }, h('span', null, `Reason (at least ${OVERRIDE_MIN} characters)`), reason),
        actions: [ui.button('Mark invoiced anyway', { variant: 'danger solid', onClick: () => {
          if (reason.value.trim().length < OVERRIDE_MIN) { ui.toast(`Say why (at least ${OVERRIDE_MIN} characters)`, 'error'); return; }
          store.update('jobs', job.id, { status, closeout: closeoutRecord(list, { by, override: { by, reason: reason.value } }) });
          done = true; resolve(true); sheet.close(); ui.toast(`${job.number} invoiced with the reason recorded`, 'success');
        } })],
        onClose: () => { if (!done) resolve(false); },
      });
    });
  }
  store.update('jobs', job.id, { status });
  ui.toast('Status updated', 'success');
  return true;
}

function checklistSheet(ctx, job, list, { title, info, extra = null, actions = [], onClose } = {}) {
  const { ui } = ctx;
  const { h } = ui;
  const sheet = ui.openSheet({
    title, onClose,
    body: h('div', { class: 'stack', dataset: { closeout: job.id } }, h('p', { class: 'muted' }, info),
      h('div', { class: 'list' }, list.map((i) => h('a', { class: 'list-row click', href: i.link, onClick: () => sheet.close() },
        ui.badge(i.severity === 'block' ? 'must clear' : 'check', i.severity === 'block' ? 'danger' : 'warning'),
        h('span', { class: 'grow' }, i.label), h('strong', { class: 'num' }, String(i.count))))), extra),
    actions: [h('span', { class: 'grow' }), ui.button('Close', { variant: 'ghost', onClick: () => sheet.close() }), ...actions],
  });
  return sheet;
}
import { lastEdited } from './drawings.js';

const STATUSES = ['lead', 'scheduled', 'in-progress', 'on-hold', 'complete', 'invoiced', 'cancelled'];
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
      // Complete and invoiced go through the final-billing checklist (4.8).
      const gated = job && data.status !== job.status && ['complete', 'invoiced'].includes(data.status) ? data.status : null;
      if (gated) data.status = job.status;
      if (job) saved = store.update('jobs', job.id, data);
      else saved = store.add('jobs', { ...data, number: store.nextNumber('job'), estimateId: null, changeOrders: [] });
      if (gated) setJobStatus(ctx, store.get('jobs', job.id), gated);
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
  const canEdit = auth.isManager() && !ctx.readOnly;
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
  const balanceCents = invoices.reduce((s, i) => s + Math.max(0, invoiceShown(store, i).balanceCents), 0);
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
  const canEdit = auth.isManager() && !ctx.readOnly;
  // Crew never see prices or costs (the server strips them too): no money tab or totals.
  const showMoney = seesMoney(auth);
  const money$ = showMoney;
  const on = (m) => (ctx.on ? ctx.on(m) : moduleOn(store.settings(), m)) && auth.can(({ materials: 'jobs', tickets: 'jobs' })[m] || m);
  const expanded = new Set();
  const disclosure = (key, label, ...children) => h('details', { class: 'job-exp-details', open: expanded.has(key),
    onToggle: (e) => { if (!e.currentTarget.isConnected) return; if (e.currentTarget.open) expanded.add(key); else expanded.delete(key); } },
  h('summary', null, label), h('div', { class: 'job-exp-details-body' }, ...children));
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
      onChange: async (e) => { const ok = await setJobStatus(ctx, store.get('jobs', job.id), e.target.value); if (!ok) draw(); } },
    STATUSES.map((s) => h('option', { value: s, selected: s === job.status }, s.replace(/-/g, ' '))));
    const hold = client?.credit?.hold?.on ? h('span', { class: 'ops-meta-item' }, ui.badge('Past due: hold work', 'danger')) : null;

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
      h('span', { class: 'ops-meta-item' }, ui.icon('users', 16), client ? (on('clients') ? h('a', { href: '#/clients/' + client.id }, client.name) : h('span', null, client.name)) : h('span', { class: 'muted' }, 'No customer')),
      job.address ? h('span', { class: 'ops-meta-item' }, ui.icon('map-pin', 16), h('a', { href: 'https://maps.apple.com/?q=' + encodeURIComponent(job.address), target: '_blank', rel: 'noopener' }, job.address)) : null,
      h('span', { class: 'ops-meta-item' }, ui.icon('calendar', 16), `${ui.fmtDate(job.startDate)} – ${ui.fmtDate(job.endDate)}`),
      h('span', { class: 'ops-meta-item' }, statusSel), hold,
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
      on('tickets') ? { id: 'tickets', label: `Tickets${store.count('fieldTickets', (t) => t.jobId === job.id && t.status !== 'void') ? ' ' + store.count('fieldTickets', (t) => t.jobId === job.id && t.status !== 'void') : ''}` } : null,
      on('schedule') ? { id: 'schedule', label: 'Schedule' } : null,
      on('time') ? { id: 'time', label: 'Time' } : null,
      on('materials') ? { id: 'materials', label: `Material${nReq ? ' ' + nReq : ''}` } : null,
      on('compliance') ? { id: 'compliance', label: 'Compliance' } : null,
      on('panels') ? { id: 'panels', label: 'Panels' } : null,
    ].filter(Boolean);
    if (!tabsList.some((t) => t.id === tab)) tab = 'overview';
    const panel = h('div', { class: 'ops-tabpanel' });
    const renderers = { overview, drawings, money, changes, tickets, schedule, time, materials, compliance, panels };
    (renderers[tab] || overview)(panel, job, m);

    host.append(ui.page({ title: `${job.number} · ${job.title}`, actions }, meta,
      on('safety') ? (emergencyCard(ctx, job.id, { editHref: canEdit ? `#/safety/job/${job.id}` : null }) || (canEdit ? h('a', { class: 'sf-em-add', href: `#/safety/job/${job.id}` }, '+ Add emergency info for this site') : null)) : null,
      h('div', { class: 'ops-tabs-row' }, ui.tabs(tabsList, tab, (t) => { tab = t; draw(); })), panel));
  };

  function operationalOverview(el, job) {
    const manager = auth.isManager();
    const summary = jobOverview({ job, day: ui.today(), employeeId: auth.current().id, manager,
      readOnly: Boolean(ctx.readOnly), can: (p) => auth.can(p), on, seesMoney: showMoney,
      schedule: on('schedule') ? store.list('schedule', (s) => s.jobId === job.id) : [],
      tasks: on('workplan') || on('today') ? store.list('workTasks', (t) => t.jobId === job.id, { omit: ['photos'] }) : [],
      materials: on('materials') ? store.list('materialRequests', (r) => r.jobId === job.id) : [],
      hold: Boolean(store.get('clients', job.clientId)?.credit?.hold?.on),
    });
    const person = (id) => store.get('employees', id)?.name || 'Unassigned';
    const visit = summary.nextVisit;
    const nextTask = summary.upcomingTasks[0];
    const crewIds = visit?.crewIds.length ? visit.crewIds : job.crewIds || [];
    const crew = [...new Set(crewIds)].map(person);
    const next = summary.next;
    const panel = (title, ...children) => h('section', { class: 'job-exp-section', 'aria-label': title }, h('h2', null, title), ...children);
    const note = (text) => h('p', { class: 'job-exp-note' }, text);
    const row = (title, text, href, tone) => h(href ? 'a' : 'div', { class: ['job-exp-row', tone], href },
      h('span', { class: 'job-exp-row-copy' }, h('strong', null, title), h('span', null, text)),
      href ? ui.icon('chevron-right', 16) : null);
    el.append(h('div', { class: 'job-exp-overview', dataset: { jobOverview: job.id } },
      next ? h('section', { class: ['job-exp-next', next.tone], 'aria-label': 'Next step' },
        h('div', { class: 'job-exp-next-copy' }, h('span', { class: 'job-exp-eyebrow' }, 'Next step'),
          h('h2', null, next.title), h('p', null, next.detail)),
        next.href ? ui.button(next.label, { variant: next.tone ? 'secondary' : 'primary', href: next.href }) : null) : null,
      h('div', { class: 'job-exp-grid' },
        panel('Scope of work',
          h('div', { class: 'job-exp-scope' }, job.description || (job.kind === 'service'
            ? 'No service details recorded. Confirm the issue and agreed work with the office before starting.'
            : 'No scope recorded. Confirm the agreed work with the office before starting.')),
          h('div', { class: 'job-exp-shortcuts' },
            on('drawings') ? ui.button('Drawings', { icon: 'pen', href: `#/jobs/${job.id}?tab=drawings` }) : null,
            on('today') ? ui.button('My day', { icon: 'check', href: '#/today' }) : null,
            on('materials') && !ctx.readOnly ? ui.button('Request material', { icon: 'truck', href: `#/materials?new=1&jobId=${job.id}` }) : null,
            auth.isManager() && !ctx.readOnly ? ui.button('Apply a standard', { icon: 'book', onClick: () => applyStandardSheet(ctx, job) }) : null)),
        panel(visit ? 'Next crew visit' : nextTask ? 'Next assigned work' : 'Crew & timing',
          visit ? h('p', { class: 'job-exp-visit-date' }, ui.fmtDate(visit.date, { weekday: 'long', month: 'short', day: 'numeric' }))
            : nextTask ? h('p', { class: 'job-exp-visit-date' }, ui.fmtDate(nextTask.date, { weekday: 'long', month: 'short', day: 'numeric' }))
              : note(on('schedule') ? 'No upcoming crew visit recorded.' : 'Confirm visit timing with the office.'),
          nextTask && !visit ? note(nextTask.title) : null,
          crew.length ? h('div', null, note(visit?.crewIds.length ? 'Scheduled crew' : 'Assigned crew'),
            h('div', { class: 'job-exp-crew' }, crew.map((name) => h('span', null, ui.icon('user', 16), name))))
            : note('No crew assigned to this job yet.'),
          visit?.notes.length ? h('div', { class: 'job-exp-visit-notes' }, visit.notes.map((text) => h('p', null, text))) : null,
          job.endDate ? note(`Target finish: ${ui.fmtDate(job.endDate)}`) : null,
          on('schedule') ? ui.button('View schedule', { variant: 'ghost', icon: 'calendar', href: `#/jobs/${job.id}?tab=schedule` }) : null)),
      h('div', { class: 'job-exp-grid' },
        on('workplan') || on('today') ? panel(manager ? 'Work blockers' : 'Your work blockers',
          summary.blockers.length ? h('div', { class: 'job-exp-list' }, summary.blockers.map((b) => row(b.title, `${person(b.employeeId)}: ${b.reason}`, b.href, 'danger')))
            : note(manager ? 'No blocked tasks recorded for this job.' : 'None of your published tasks are blocked.')) : null,
        on('materials') ? panel('Material needs',
          summary.needs.length ? h('div', { class: 'job-exp-list' }, summary.needs.slice(0, 4).map((r) => row(
            `${r.qty ?? ''} ${r.unit || ''} ${r.itemId ? store.get('items', r.itemId)?.name || r.description : r.description}`.trim(),
            `${r.urgent ? 'Urgent · ' : ''}${MATERIAL_STATUS[r.status] || r.status}`, `#/jobs/${job.id}?tab=materials`, r.urgent ? 'warning' : null)),
          summary.needs.length > 4 ? ui.button(`View all ${summary.needs.length} requests`, { variant: 'ghost', href: `#/jobs/${job.id}?tab=materials` }) : null)
            : note('No open material requests for this job.')) : null)));
  }

  function overview(el, job, m) {
    operationalOverview(el, job);
    const detail = h('div');
    overviewDetails(detail, job, m);
    el.append(disclosure('financials', showMoney ? 'Billing, costs & contract' : 'Hours & job details', detail));
  }

  function overviewDetails(el, job, m) {
    const pct = m.revenueCents ? Math.round((m.marginCents / m.revenueCents) * 100) : null;
    const tm = jobBillingMode(job) === 'tm';
    // The job site for the time clock (location while clocked in), for every role that sees the job.
    const site = () => (on('time') && locationSettings(store.settings()).enabled ? [h('h2', { class: 'section' }, 'Site for the time clock'), siteCard(ctx, job, { canEdit })] : []);
    if (!showMoney) {
      el.append(h('div', { class: 'grid ops-stats' }, ui.stat({ label: 'Labour', value: ui.fmtHours(m.hours), hint: 'logged on this job' }),
        ui.stat({ label: 'Change orders', value: String((job.changeOrders || []).length), hint: `${(job.changeOrders || []).filter((c) => c.status === 'pending').length} pending` })),
      auth.isManager() ? (tm ? tmCard(job) : estimateVsActual(job)) : null,
      ...site());
      return;
    }
    el.append(
      h('div', { class: 'grid ops-stats' },
        money$ && on('estimates') ? ui.stat({ label: tm ? 'Estimate (guide)' : 'Estimate', value: ui.fmtMoney(m.estCents, { whole: true }), hint: m.coCents ? `+ ${ui.fmtMoney(m.coCents, { whole: true })} approved changes` : `${m.estimates.length} estimate(s)` }) : null,
        money$ && on('invoices') ? ui.stat({ label: 'Invoiced', value: ui.fmtMoney(m.invoicedCents, { whole: true }), hint: `${ui.fmtMoney(m.paidCents, { whole: true })} paid · ${ui.fmtMoney(m.balanceCents, { whole: true })} due`, tone: m.balanceCents > 0 ? 'accent' : null }) : null,
        ui.stat({ label: 'Labour', value: ui.fmtHours(m.hours), hint: money$ ? `${ui.fmtMoney(m.labourCents, { whole: true })} cost` : 'logged on this job' }),
        money$ ? ui.stat({ label: 'Materials used', value: ui.fmtMoney(m.materialCents, { whole: true }), hint: 'at cost, from stock moves' }) : null,
        money$ ? ui.stat({ label: 'Margin', value: ui.fmtMoney(m.marginCents, { whole: true }), hint: pct == null ? 'no revenue yet' : `${pct}% of ${m.invoicedCents ? 'invoiced' : 'estimate'}`, tone: m.marginCents < 0 ? 'danger' : 'success' }) : null),
      auth.isManager() ? (tm ? tmCard(job) : estimateVsActual(job)) : null,
      auth.isManager() ? contractCard(job) : null,
      ...site(),
    );
  }

  // ---- the contract and payment card (7.1, 3.2): prime or sub, dates, signers, holdback, exemption ----
  function suggestLastSupplied(job) {
    const days = [
      ...store.list('timeEntries', (t) => t.jobId === job.id && t.clockIn).map((t) => ui.localDay(t.clockIn)),
      ...store.list('stockMoves', (m) => m.jobId === job.id && m.date).map((m) => m.date),
      ...store.list('fieldTickets', (t) => t.jobId === job.id && t.date && t.status !== 'void').map((t) => t.date),
    ].filter(Boolean).sort();
    return days.at(-1) || null;
  }
  function contractCard(job) {
    const c = job.contract || {};
    const client = store.get('clients', job.clientId);
    const gc = c.gcClientId ? store.get('clients', c.gcClientId) : null;
    const missing = c.role === 'prime' && !c.signedOn ? 'Add the day the contract was signed: prompt payment dates need it.'
      : c.role === 'sub' && !c.primeSignedOn ? 'Add the day the prime contract (owner and general contractor) was signed: prompt payment needs it ("unknown" means no alarms).' : null;
    const row = (label, value) => (value || value === 0 ? h('div', { class: 'ops-kv' }, h('span', { class: 'muted' }, label), h('span', null, value)) : null);
    const fresh = JSON.parse(JSON.stringify(store.get('jobs', job.id) || job));
    const editable = canEdit && showMoney;
    const edit = () => {
      const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
      const suggested = suggestLastSupplied(job);
      ui.formSheet({
        title: `Contract and payment · ${job.number}`, wide: true,
        fields: [
          { label: 'Our role', name: 'role', type: 'select', value: c.role || '', options: [{ value: '', label: 'Not set' }, { value: 'prime', label: 'Prime contract with the owner' }, { value: 'sub', label: 'Subcontract to a general contractor' }] },
          { label: 'Job kind', name: 'kind', type: 'select', value: job.kind || 'standard', options: [{ value: 'standard', label: 'Standard' }, { value: 'service', label: 'Service call' }, { value: 'warranty', label: 'Warranty' }, { value: 'callback', label: 'Callback' }] },
          { label: 'Our contract signed on', name: 'signedOn', type: 'date', value: c.signedOn || '' },
          { label: 'Prime contract signed on (subs)', name: 'primeSignedOn', type: 'date', value: c.primeSignedOn || '', hint: 'Blank: unknown (no prompt payment alarms)' },
          { label: 'Owner', name: 'ownerName', value: c.ownerName || '' },
          { label: 'General contractor', name: 'gcClientId', type: 'select', value: c.gcClientId || '', options: ui.recordOptions(clients) },
          { label: 'Contract number', name: 'contractNo', value: c.contractNo || '' },
          { label: 'Contract value', name: 'valueCents', type: 'money', value: c.valueCents ?? null },
          { label: 'Holdback %', name: 'holdbackPct', type: 'number', step: '0.5', min: '0', max: '100', value: c.holdbackPct ?? '' },
          { label: 'Payment terms (days)', name: 'paymentTermsDays', type: 'number', step: '1', min: '0', value: c.paymentTermsDays ?? '' },
          { label: 'GC billing cutoff (day of month)', name: 'billingCutoffDay', type: 'number', step: '1', min: '1', max: '31', value: c.billingCutoffDay ?? '' },
          { label: 'Substantial performance on', name: 'substantialPerformanceOn', type: 'date', value: c.substantialPerformanceOn || '' },
          { label: 'Certificate of substantial performance on', name: 'substantialPerformanceCertOn', type: 'date', value: c.substantialPerformanceCertOn || '' },
          { label: 'Holdback release on', name: 'holdbackReleaseOn', type: 'date', value: c.holdbackReleaseOn || '', hint: 'Typed by the office while the release rule is unconfirmed' },
          { label: 'Last supplied on', name: 'lastSuppliedOn', type: 'date', value: c.lastSuppliedOn || suggested || '', hint: suggested ? `Suggested from the last time, material or ticket: ${suggested}` : 'For the lawyer and a later lien countdown' },
          { label: 'Proper invoices required (prompt payment)', name: 'properInvoiceRequired', type: 'checkbox', value: Boolean(c.properInvoiceRequired) },
          { label: 'Billable', name: 'billable', type: 'checkbox', value: job.billable !== false },
          { label: 'People who may sign for the customer (one per line: Name, Title)', name: 'signers', type: 'textarea', span: true, rows: 3, value: (c.authorizedSigners || []).map((s) => [s.name, s.title].filter(Boolean).join(', ')).join('\n') },
        ],
        onSubmit(v, sheetForm) {
          const num = (x) => (x === '' || x == null ? null : Number(x));
          const day = (x) => x || null;
          const signers = String(v.signers || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 10).map((l) => { const [name, ...t] = l.split(','); return { name: name.trim().slice(0, 120), title: t.join(',').trim().slice(0, 120) || null }; });
          const cutoff = num(v.billingCutoffDay);
          if (cutoff != null && !(cutoff >= 1 && cutoff <= 31)) { ui.toast('The cutoff day is 1 to 31', 'error'); return false; }
          const raw = (n) => sheetForm.querySelector(`[name=${n}]`)?.value.trim() ?? '';
          const contract = {
            ...c, role: v.role || null, signedOn: day(v.signedOn), primeSignedOn: day(v.primeSignedOn), ownerName: v.ownerName || null, gcClientId: v.gcClientId || null,
            contractNo: v.contractNo || null, valueCents: raw('valueCents') === '' ? null : v.valueCents, holdbackPct: num(v.holdbackPct), paymentTermsDays: num(v.paymentTermsDays),
            billingCutoffDay: cutoff, substantialPerformanceOn: day(v.substantialPerformanceOn), substantialPerformanceCertOn: day(v.substantialPerformanceCertOn),
            holdbackReleaseOn: day(v.holdbackReleaseOn), lastSuppliedOn: day(v.lastSuppliedOn), properInvoiceRequired: Boolean(v.properInvoiceRequired), authorizedSigners: signers,
          };
          const kind = ['standard', 'service', 'warranty', 'callback'].includes(v.kind) ? v.kind : 'standard';
          store.update('jobs', job.id, { contract, kind, billable: ['warranty', 'callback'].includes(kind) ? false : Boolean(v.billable) }, { summary: `${job.number}: contract` });
          ui.toast('Contract saved', 'success');
        },
      });
    };
    return h('section', { class: 'card ops-contract', dataset: { contractCard: job.id } },
      h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Contract and payment'), editable ? ui.button('Edit', { size: 'sm', icon: 'edit', onClick: edit }) : null),
      h('div', { class: 'ops-kvs' },
        row('Role', c.role === 'prime' ? 'Prime contract' : c.role === 'sub' ? `Subcontract${gc ? ` to ${gc.name}` : ''}` : 'Not set'),
        row('Signed', c.role === 'sub' ? [c.signedOn && `ours ${c.signedOn}`, `prime ${c.primeSignedOn || 'unknown'}`].filter(Boolean).join(' · ') : c.signedOn),
        row('Contract', [c.contractNo, c.valueCents != null && showMoney ? ui.fmtMoney(c.valueCents, { whole: true }) : null].filter(Boolean).join(' · ')),
        row('Holdback', c.holdbackPct != null ? `${c.holdbackPct}%${c.holdbackReleaseOn ? `, release ${ui.fmtDate(c.holdbackReleaseOn)}` : ''}` : null),
        row('Terms', c.paymentTermsDays != null ? `${c.paymentTermsDays} days${c.billingCutoffDay ? `, GC cutoff the ${c.billingCutoffDay}` : ''}` : c.billingCutoffDay ? `GC cutoff the ${c.billingCutoffDay}` : null),
        row('Signers', (c.authorizedSigners || []).map((s) => s.name).join(', ')),
        row('Substantial performance', c.substantialPerformanceOn),
        row('Last supplied', c.lastSuppliedOn || (suggestLastSupplied(job) ? `${suggestLastSupplied(job)} (suggested)` : null)),
        row('Kind', job.kind && job.kind !== 'standard' ? job.kind : null)),
      missing ? h('p', { class: 'money-warn' }, ui.icon('info', 14), ' ', missing) : null,
      h('h4', null, 'Tax exemption'),
      exemptionEditor({ doc: fresh, job: fresh, client, onChange: (taxExempt) => store.update('jobs', job.id, { taxExempt }, { summary: `${job.number}: tax exemption` }), readOnly: !editable, store }));
  }

  // ---- time & material: what is not billed yet, and the invoice builder ----
  function tmCard(job) {
    const src = tmSources(store);
    const u = unbilledTm({ job, settings: store.settings(), ...src, dayOf: ui.localDay });
    const canBill = !ctx.readOnly && money$ && auth.can('invoices') && on('invoices');
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

  /** Taxes for a new document on this job: exemption-aware (tax.js newDocTax with the job and client). */
  function newDocTaxFor(job, client) { return newDocTax(store.settings(), ui.today(), { job, client }); }

  function buildInvoiceSheet(job) {
    const settings = store.settings();
    // Start at the earliest record not billed yet: billedRefs already keeps billed ones out, so a
    // later start (the day after the last invoice) would only hide time approved late.
    let from = unbilledTm({ job, settings, ...tmSources(store), dayOf: ui.localDay }).firstDay || '';
    let to = ui.today();
    const preview = h('div', { class: 'stack' });
    // Signed and refused tickets on the job are billed with the time; where billed hours exceed signed
    // hours on a day, the office gives a reason before the invoice is saved (4.1).
    const reasons = new Map();
    const tmTickets = () => billableTickets(store.list('fieldTickets'), job.id, { from, to });
    const reconcile = (draft, u) => (Array.isArray(draft?.invoice?.ticketReconciliation)
      ? draft.invoice.ticketReconciliation.map((r) => ({ ...r, flagged: r.flagged ?? (r.billedMinutes > r.signedMinutes) }))
      : ticketReconciliation({ tickets: tmTickets(), labour: u.labour, from, to }));
    const reconNode = (rows) => (rows.length ? h('div', { class: 'card flat ops-recon', dataset: { recon: String(rows.filter((r) => r.flagged).length) } },
      h('strong', null, 'Signed tickets against billed hours'),
      ui.table({
        columns: [
          { key: 'day', label: 'Day', render: (r) => ui.fmtDate(r.day, { weekday: 'short', month: 'short', day: 'numeric' }) },
          { key: 'b', label: 'Billed', align: 'right', render: (r) => `${(r.billedMinutes / 60).toFixed(2)} h` },
          { key: 's', label: 'Signed', align: 'right', render: (r) => `${(r.signedMinutes / 60).toFixed(2)} h` },
          { key: 'why', label: 'Reason', render: (r) => (r.flagged ? h('input', { class: 'input', name: `reason-${r.day}`, value: reasons.get(r.day) || '', placeholder: 'Why more hours than signed', onInput: (e) => reasons.set(r.day, e.target.value) }) : ui.badge('matches', 'success')) },
        ],
        rows,
      })) : null);
    const drawPreview = () => {
      ui.clear(preview);
      const u = unbilledTm({ job, settings, ...tmSources(store), from, to, dayOf: ui.localDay });
      const all = unbilledTm({ job, settings, ...tmSources(store), dayOf: ui.localDay });
      const count = (x) => x.labour.length + x.materials.length + x.pendingApproval;
      const outside = count(all) - count(u);
      const outsideNote = outside > 0 ? h('p', { class: 'muted', style: { margin: 0 }, dataset: { tmOutside: String(outside) } }, `${outside} record${outside === 1 ? '' : 's'} not billed yet fall${outside === 1 ? 's' : ''} outside these dates.`) : null;
      if (u.empty) {
        preview.append(h('p', { class: 'muted', style: { margin: 0 } }, u.pendingApproval ? `Nothing approved in this range: ${u.pendingApproval} time entr${u.pendingApproval === 1 ? 'y is' : 'ies are'} waiting for approval.` : 'Nothing to bill in this range.'), ...[outsideNote].filter(Boolean));
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
        h('strong', { class: 'num' }, `${ui.fmtMoney(u.totalCents)} before tax`)), ...[outsideNote, reconNode(reconcile(draft, u))].filter(Boolean));
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
        const rows = reconcile(draft, draft.unbilled);
        const unexplained = rows.filter((r) => r.flagged && !String(reasons.get(r.day) || '').trim());
        if (unexplained.length) { ui.toast(`Give a reason for ${unexplained.length} day${unexplained.length === 1 ? '' : 's'} with more hours billed than signed`, 'error', 5000); return; }
        const ticketIds = draft.invoice.ticketIds || tmTickets().map((t) => t.id);
        const client = job.clientId ? store.get('clients', job.clientId) : null;
        const inv = store.add('invoices', {
          ...draft.invoice, ...newDocTaxFor(job, client), number: store.nextNumber('invoice'),
          ...(ticketIds.length ? { ticketIds } : {}),
          ...(rows.length ? { ticketReconciliation: rows.map((r) => ({ day: r.day, billedMinutes: r.billedMinutes, signedMinutes: r.signedMinutes, ...(r.flagged ? { reason: String(reasons.get(r.day)).trim().slice(0, 500) } : {}) })) } : {}),
        });
        for (const tid of ticketIds) {
          const t = store.get('fieldTickets', tid);
          if (t && ['signed', 'refused', 'priced'].includes(t.status)) store.update('fieldTickets', tid, { status: 'billed', invoiceId: inv.id }, { summary: `${t.number || 'Ticket'} billed on ${inv.number}` });
        }
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
    el.append(h('div', { class: 'row ops-sub-actions' }, !ctx.readOnly ? ui.button('Request material', { variant: 'primary', icon: 'truck', href: `#/materials?new=1&jobId=${job.id}` }) : null,
      canEdit ? ui.button('Apply a standard', { icon: 'book', onClick: () => applyStandardSheet(ctx, job) }) : null,
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
    const rows = store.list('drawings', (d) => d.jobId === job.id, { omit: ['underlay', 'strokes', 'texts', 'rooms', 'history', 'tombstones'] });
    const client = job.clientId && store.get('clients', job.clientId);
    // one drawing set per customer is the obvious default; separate drawings stay possible
    el.append(h('div', { class: 'row ops-sub-actions' },
      !ctx.readOnly ? ui.button(client ? `Open ${client.name}'s drawings` : 'Open drawings', { variant: 'primary', icon: 'pen', href: `#/drawings/customer?jobId=${encodeURIComponent(job.id)}` }) : null,
      !ctx.readOnly ? ui.button('New separate drawing', { icon: 'plus', href: `#/drawings/new?jobId=${job.id}` }) : null));
    if (!rows.length) return el.append(ui.empty({ icon: 'pen', title: 'No drawings for this job yet', text: `Open ${client ? `${client.name}'s` : 'the'} drawings to start the customer's plan set, then mark it up with symbols and wiring.` }));
    el.append(h('div', { class: 'grid' }, rows.map((d) => h('a', { class: 'card click ops-drawing', href: '#/drawings/' + d.id },
      h('div', { class: 'ops-thumb' }, d.thumb ? h('img', { src: d.thumb, alt: '' }) : ui.icon('pen', 28)),
      h('div', { style: { fontWeight: 600 } }, d.name),
      h('div', { class: 'muted ops-small' }, `${(d.objects || []).length} symbols · ${lastEdited(ui, d)}`)))));
  }

  function money(el, job, m) {
    const tm = jobBillingMode(job) === 'tm';
    el.append(h('div', { class: 'row ops-sub-actions' },
      !ctx.readOnly && on('estimates') ? ui.button('New estimate', { variant: tm ? 'secondary' : 'primary', icon: 'file-text', href: `#/estimates/new?jobId=${job.id}${job.clientId ? '&clientId=' + job.clientId : ''}` }) : null,
      !ctx.readOnly && on('invoices') && tm && auth.can('invoices') ? ui.button('Build invoice from time & material', { variant: 'primary', icon: 'receipt', onClick: () => buildInvoiceSheet(job) }) : null,
      !ctx.readOnly && on('invoices') ? ui.button('New invoice', { icon: 'receipt', href: `#/invoices/new?jobId=${job.id}` }) : null,
      !ctx.readOnly && on('invoices') && auth.can('invoices') ? ui.button('New deposit invoice', { icon: 'dollar', href: `#/invoices/new?kind=deposit&jobId=${job.id}` }) : null));
    if (on('invoices') && auth.can('invoices')) holdbackAndDeposits(el, job);
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

  // ---- holdback and deposits on the job (4.3, 7.3) ----
  function holdbackAndDeposits(el, job) {
    const invoices = store.list('invoices');
    const led = holdbackLedger(invoices, { jobId: job.id });
    const deps = depositsAvailable(invoices, store.list('payments'), { jobId: job.id }).filter((d) => d.jobId === job.id);
    const unapplied = deps.reduce((s, d) => s + d.availableCents, 0);
    if (!led.retainedCents && !led.retainedByCustomerCents && !deps.length) return;
    const due = releaseDue(job, ui.today());
    const letter = () => {
      const rows = led.byInvoice.filter((b) => b.retainedByCustomerCents > 0);
      const co = store.settings().company || {};
      const client = store.get('clients', job.contract?.gcClientId || job.clientId);
      printNode(h('div', { class: 'doc-sheet' },
        h('div', { class: 'doc-top' }, h('div', { class: 'doc-brand' }, co.name || ''), h('div', { class: 'doc-title' }, h('div', { class: 'doc-kind' }, 'Request for holdback release'), h('div', { class: 'doc-small' }, ui.today()))),
        h('p', null, `To ${client?.name || ''}: on ${job.number} ${job.title || ''}${job.contract?.contractNo ? ` (contract ${job.contract.contractNo})` : ''}, you retained the following holdback from our invoices. Please release it.`),
        h('table', { class: 'doc-lines' }, h('thead', null, h('tr', null, h('th', null, 'Invoice'), h('th', null, 'Date'), h('th', { class: 'right' }, 'Retained'))),
          h('tbody', null, rows.map((b) => h('tr', null, h('td', null, b.number), h('td', null, b.issueDate || ''), h('td', { class: 'right' }, ui.fmtMoney(b.retainedByCustomerCents)))))),
        h('p', { class: 'doc-strong' }, `Total retained: ${ui.fmtMoney(led.retainedByCustomerCents)}`)));
    };
    el.append(h('div', { class: 'card ops-holdback', dataset: { holdbackLedger: job.id } },
      h('h3', null, 'Holdback and deposits'),
      h('div', { class: 'ops-kvs' },
        led.retainedCents ? h('div', { class: 'ops-kv' }, h('span', { class: 'muted' }, 'Held back on our invoices'), h('span', { class: 'num' }, ui.fmtMoney(led.retainedCents))) : null,
        led.releasedCents ? h('div', { class: 'ops-kv' }, h('span', { class: 'muted' }, 'Released'), h('span', { class: 'num' }, ui.fmtMoney(led.releasedCents))) : null,
        led.outstandingCents ? h('div', { class: 'ops-kv' }, h('span', { class: 'muted' }, 'Still to release'), h('strong', { class: 'num' }, ui.fmtMoney(led.outstandingCents))) : null,
        led.retainedByCustomerCents ? h('div', { class: 'ops-kv' }, h('span', { class: 'muted' }, 'Kept by the customer on its own'), h('span', { class: 'num' }, ui.fmtMoney(led.retainedByCustomerCents))) : null,
        deps.length ? h('div', { class: 'ops-kv' }, h('span', { class: 'muted' }, 'Deposits paid, not applied'), h('span', { class: 'num' }, ui.fmtMoney(unapplied))) : null),
      h('div', { class: 'row ops-sub-actions' },
        led.outstandingCents > 0 ? (due && !ctx.readOnly ? ui.button('Invoice holdback release', { variant: 'primary', href: `#/invoices/new?kind=release&jobId=${job.id}` })
          : h('span', { class: 'muted' }, job.contract?.holdbackReleaseOn ? `Release invoice from ${ui.fmtDate(job.contract.holdbackReleaseOn)}.` : 'Set the holdback release date on the contract card.')) : null,
        led.retainedByCustomerCents ? ui.button('Request holdback release', { onClick: letter }) : null)));
  }

  function moneyInvoices(el, m) {
    el.append(h('h2', { class: 'section' }, 'Invoices'));
    el.append(ui.table({
      columns: [
        { key: 'number', label: 'No.' }, { key: 'issueDate', label: 'Issued', render: (i) => ui.fmtDate(i.issueDate) },
        { key: 'status', label: 'Status', render: (i) => ui.statusBadge(invoiceShown(store, i).status) },
        { key: 'total', label: 'Total', align: 'right', render: (i) => ui.fmtMoney(docTotals(i).totalCents) },
        { key: 'bal', label: 'Balance', align: 'right', render: (i) => ui.fmtMoney(invoiceShown(store, i).balanceCents) },
      ],
      rows: m.invoices, onRowClick: (i) => nav('#/invoices/' + i.id),
      empty: h('p', { class: 'muted' }, 'No invoices yet.'),
    }));
  }

  // ---- change orders: priced and signed by the office (money roles), merged by id on the server (4.2) ----
  function changes(el, job) {
    const cos = job.changeOrders || [];
    const fresh = () => store.get('jobs', job.id)?.changeOrders || [];
    const save = (list, summary) => store.update('jobs', job.id, { changeOrders: list }, summary ? { summary } : {});
    const patchCo = (id, patch, summary) => save(fresh().map((c) => (c.id === id ? { ...c, ...patch } : c)), summary);
    const signed = (co) => Boolean(co?.signatureId);
    const edit = (co) => {
      if (signed(co)) { ui.toast('This change order was signed. Void it and add a new one to change it.', 'info', 5000); return; }
      ui.formSheet({
        title: co ? 'Edit change order' : 'New change order',
        fields: [
          { label: 'Description', name: 'title', value: co?.title, required: true, span: true },
          { label: 'Amount', name: 'amountCents', type: 'money', value: co?.amountCents ?? 0, required: true },
          { label: 'Date', name: 'date', type: 'date', value: co?.date || ui.today() },
          { label: 'Status', name: 'status', type: 'select', value: co?.status || 'pending', options: ['pending', 'approved', 'rejected'] },
        ],
        danger: co ? { label: 'Delete', onClick: () => save(fresh().filter((c) => c.id !== co.id)) } : null,
        onSubmit(v) {
          const approvedOn = v.status === 'approved' ? (co?.approvedOn || ui.today()) : null;
          if (co) patchCo(co.id, { ...v, approvedOn });
          else save([...fresh(), { id: 'co-' + Date.now().toString(36), ...v, approvedOn }]);
        },
      });
    };
    const settings = store.settings();
    const signHere = (co) => signatureSheet(ui, {
      title: `Sign change order: ${co.title || ''}`, job,
      summary: h('div', { class: 'stack' }, h('div', { class: 'title' }, co.title || 'Change order'),
        (co.lines || []).length ? h('ul', { class: 'es-lines' }, co.lines.map((l) => h('li', null, `${l.qty ?? ''} ${l.description || ''}`.trim()))) : null,
        h('div', { class: 'es-total' }, `Price: ${ui.fmtMoney(co.amountCents || 0)}`)),
      agreementText: 'I approve this change to the contract at the price shown.',
      captureLocation: settings.tickets?.captureLocation !== false,
      onSigned: async (s) => {
        const sig = await buildSignature({ docType: 'changeOrder', doc: co, extra: { jobId: job.id }, jobId: job.id, clientId: job.clientId || null, ...s,
          capturedBy: { employeeId: auth.current().id || null, name: auth.who().name, userId: ctx.app?.session?.me?.user?.id || null }, device: navigator.userAgent.slice(0, 120) });
        // The signature first, the change order second, in the same tick: the queue pushes them in that order.
        store.add('signatures', sig);
        patchCo(co.id, { status: 'approved', approvedOn: ui.today(), signatureId: sig.id, signedAt: sig.signedAt, signedName: sig.signerName }, `${job.number}: change order signed`);
        queueSignatureFirst(store, sig.id, [{ coll: 'jobs', id: job.id }]);
        ui.toast(`Signed by ${sig.signerName}`, 'success');
      },
    });
    const byEmail = async (co) => {
      const r = await emailAcceptanceSheet(ui, { title: `Accepted by email: ${co.title || 'change order'}` });
      if (!r) return;
      const sig = await buildSignature({ docType: 'changeOrder', doc: co, extra: { jobId: job.id }, jobId: job.id, clientId: job.clientId || null, method: 'email-reply',
        signerName: r.signerName, signerEmail: r.signerEmail, evidence: r.evidence, capturedBy: { employeeId: auth.current().id || null, name: auth.who().name } });
      store.add('signatures', sig);
      patchCo(co.id, { status: 'approved', approvedOn: ui.today(), signatureId: sig.id, signedAt: sig.signedAt, signedName: sig.signerName }, `${job.number}: change order accepted by email`);
      queueSignatureFirst(store, sig.id, [{ coll: 'jobs', id: job.id }]);
    };
    const voidCo = async (co) => {
      const reason = await ui.promptDialog('Why is this signed change order void?', { title: 'Void change order', okLabel: 'Void' });
      if (!reason || reason.trim().length < 3) return;
      patchCo(co.id, { status: 'void', note: `Void: ${reason.trim()}`.slice(0, 500) }, `${job.number}: change order void`);
    };
    const approved = cos.filter((c) => c.status === 'approved').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
    const pending = cos.filter((c) => c.status === 'pending').reduce((s, c) => s + (Number(c.amountCents) || 0), 0);
    el.append(h('div', { class: 'row ops-sub-actions' },
      canEdit && showMoney ? ui.button('Add change order', { variant: 'primary', icon: 'plus', onClick: () => edit(null) }) : null,
      h('span', { class: 'grow' }),
      showMoney ? [h('span', { class: 'muted' }, 'Approved '), h('strong', { class: 'num' }, ui.fmtMoney(approved)),
        h('span', { class: 'muted' }, ' · Pending '), h('strong', { class: 'num' }, ui.fmtMoney(pending))] : null));
    const office = canEdit && showMoney;
    el.append(ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (c) => ui.fmtDate(c.approvedOn || c.date) },
        { key: 'title', label: 'Change', render: (c) => h('div', null, h('div', null, c.title || '—'),
          c.source === 'drawing' ? h('div', { class: 'muted ops-small' }, ui.badge('From drawings', 'accent'), ' ', c.note || '', c.createdBy ? ` · raised by ${c.createdBy.name}` : '') : null,
          c.source === 'ticket' ? h('div', { class: 'muted ops-small' }, ui.badge('From a field ticket', 'accent'), c.note ? ` ${c.note}` : '') : null,
          c.signedName ? h('div', { class: 'muted ops-small', dataset: { signedBy: c.signedName } }, `Signed by ${c.signedName} ${ui.fmtDateTime(c.signedAt)}`) : null) },
        showMoney ? { key: 'amount', label: 'Amount', align: 'right', render: (c) => ui.fmtMoney(c.amountCents) } : null,
        { key: 'status', label: 'Status', render: (c) => ui.statusBadge(c.status) },
        { key: 'act', label: '', render: (c) => (office ? h('span', { class: 'row', onClick: (e) => e.stopPropagation() },
          c.status === 'pending' ? [
            ui.button('Sign', { size: 'sm', icon: 'pen', onClick: () => signHere(c) }),
            ui.button('Accepted by email', { size: 'sm', variant: 'ghost', onClick: () => byEmail(c) }),
            ui.button('Approve', { size: 'sm', icon: 'check', onClick: () => patchCo(c.id, { status: 'approved', approvedOn: ui.today() }) }),
            ui.button('Reject', { size: 'sm', variant: 'ghost danger', onClick: () => patchCo(c.id, { status: 'rejected' }) })] : null,
          signed(c) && c.status !== 'void' ? ui.button('Void', { size: 'sm', variant: 'ghost danger', onClick: () => voidCo(c) }) : null) : '') },
      ].filter(Boolean),
      rows: cos, onRowClick: office ? edit : null,
      empty: ui.empty({ icon: 'edit', title: 'No change orders', text: 'Record scope changes and get them signed before the work.' }),
    }));
  }

  // ---- field tickets on the job (4.1) ----
  function tickets(el, job) {
    const list = store.list('fieldTickets', (t) => t.jobId === job.id).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const office = !ctx.readOnly && auth.can('invoices') && showMoney;
    const tm = jobBillingMode(job) === 'tm';
    const drafts = batchCandidates(list, job.id);
    const priceAsCo = (t) => {
      let co;
      try { co = ticketToChangeOrder(t, { job, items: store.list('items'), equipment: store.list('equipment'), employees: store.list('employees'), settings: store.settings(), today: ui.today(), id: `co-${Date.now().toString(36)}` }); } catch (e) { ui.toast(e.message, 'error', 5000); return; }
      ui.formSheet({
        title: `Price ${ticketLabel(t)} as a change order`, wide: true, submitLabel: 'Save change order',
        fields: [
          { label: 'Description', name: 'title', value: co.title, required: true, span: true },
          { label: 'Amount', name: 'amountCents', type: 'money', value: co.amountCents, required: true, hint: co.lines.map((l) => `${l.qty} × ${l.description} at ${ui.fmtMoney(l.unitCents)}`).join(' · ') },
          { label: 'Note', name: 'note', value: co.note || '', span: true },
        ],
        onSubmit(v) {
          const cur = store.get('jobs', job.id);
          store.update('jobs', job.id, { changeOrders: [...(cur.changeOrders || []), { ...co, ...v, note: v.note || null }] }, { summary: `${job.number}: ${ticketLabel(t)} priced` });
          store.update('fieldTickets', t.id, { status: 'priced', changeOrderId: co.id, office: { pricedAt: new Date().toISOString(), pricedBy: auth.who().name, note: null } }, { summary: `${ticketLabel(t)} priced` });
          ui.toast(`${ticketLabel(t)} priced as a change order. Get it signed on the Change orders tab.`, 'success', 5000);
        },
      });
    };
    el.append(h('div', { class: 'row ops-sub-actions' },
      !ctx.readOnly ? ui.button('New ticket', { variant: 'primary', icon: 'plus', href: `#/tickets/new?jobId=${job.id}` }) : null,
      !ctx.readOnly && drafts.length > 1 && (auth.isManager() || office) ? ui.button(`Sign several tickets (${drafts.length})`, { icon: 'pen', href: `#/tickets/batch?jobId=${job.id}` }) : null,
      ui.button('All tickets', { variant: 'ghost', icon: 'list', href: '#/tickets' })));
    el.append(ui.table({
      columns: [
        { key: 'n', label: 'Ticket', render: (t) => h('span', { class: 'mono' }, ticketLabel(t)) },
        { key: 'd', label: 'Day', render: (t) => ui.fmtDate(t.date) },
        { key: 'w', label: 'Work', render: (t) => ticketSummary(t) },
        { key: 's', label: 'Status', render: (t) => ui.statusBadge(t.status) },
        { key: 'a', label: '', render: (t) => h('span', { class: 'row', onClick: (e) => e.stopPropagation() },
          office && !tm && job.kind !== 'service' && ['signed', 'refused'].includes(t.status) ? ui.button('Price as change order', { size: 'sm', onClick: () => priceAsCo(t) }) : null) },
      ],
      rows: list, onRowClick: (t) => nav(`#/tickets/${t.id}`),
      empty: ui.empty({ icon: 'pen', title: 'No field tickets', text: tm ? 'T&M tickets signed on site are billed with the time on this job.' : 'Extra work signed on site is priced into a change order.' }),
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
    const sum = (k) => rows.filter((t) => kindOf(t) === k).reduce((n, t) => n + entryMinutes(t), 0);
    if (rows.length) el.append(h('p', { class: 'muted' }, `Work ${fmtH(sum('work'))} h · travel to this job ${fmtH(sum('travel'))} h`));
    el.append(ui.table({
      columns: [
        { key: 'day', label: 'Day', render: (t) => ui.fmtDate(t.clockIn) },
        { key: 'emp', label: 'Who', render: (t) => store.get('employees', t.employeeId)?.name || '—' },
        { key: 'kind', label: 'Type', render: (t) => (kindOf(t) === 'travel' ? ui.badge('travel', 'info') : ui.badge('work', 'neutral')) },
        { key: 'in', label: 'In – out', render: (t) => `${ui.fmtTime(t.clockIn)} – ${t.clockOut ? ui.fmtTime(t.clockOut) : 'on the clock'}` },
        { key: 'hrs', label: 'Hours', align: 'right', render: (t) => `${fmtH(entryMinutes(t))} h` },
        { key: 'loc', label: 'Location', render: (t) => (t.flag ? ui.badge(t.flag.reviewedAt ? `${t.flag.text} · reviewed` : t.flag.text, t.flag.reviewedAt ? 'neutral' : 'danger') : t.siteCheck?.inside ? ui.badge('at the site', 'success') : '') },
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
  const offs = ['jobs', 'estimates', 'invoices', 'payments', 'timeEntries', 'schedule', 'drawings', 'permits', 'inspections', 'stockMoves', 'jobSafety', 'materialRequests', 'fieldTickets', 'clients', 'workTasks', 'employees', 'items'].map((c) => store.on(c, draw));
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
