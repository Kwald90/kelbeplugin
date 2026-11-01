// Leads & funnels (S13): kanban pipeline, conversion funnel, list, lead sheet.
import { openClientSheet } from './clients.js';
import { processSequences } from './sequences.js';
import { pipelineStages, stageById, funnelOrder, reachedCounts, leadIsOpen } from '../lib/pipeline.js';

const OPEN = (l) => leadIsOpen(l.stage);
const SOURCES = ['Website', 'Referral', 'Repeat', 'Google', 'Yard sign', 'Cold call', 'Social', 'Other'];

/** The company's pipeline stages (editable in Settings → Sales pipeline). */
const stagesOf = (store) => pipelineStages(store.settings());

/** A badge coloured by stage kind — Won green, Lost red, open stages by their shared status tone. */
function stageBadge(ui, stage) {
  const tone = stage.kind === 'won' ? 'success' : stage.kind === 'lost' ? 'danger' : (ui.STATUS_TONE?.[stage.id] || 'info');
  return ui.badge(stage.label, tone);
}

/** The stage label (and a matching badge) for a lead's stage id, for screens outside this module. */
export function stageLabel(store, id) {
  return stageById(stagesOf(store), id)?.label || String(id || '—').replace(/-/g, ' ');
}
export function leadStageBadge(ui, store, id) {
  const stages = stagesOf(store);
  const st = stageById(stages, id) || { id, label: String(id || '—').replace(/-/g, ' '), kind: 'open' };
  return stageBadge(ui, st);
}

/** 'overdue' | 'today' | null for an open lead's next action. */
export function leadDue(l, today) {
  if (!OPEN(l) || !l.nextActionAt) return null;
  const d = String(l.nextActionAt).slice(0, 10);
  return d < today ? 'overdue' : d === today ? 'today' : null;
}

function clientName(store, l) {
  return (l.clientId && store.get('clients', l.clientId)?.name) || l.contactName || '—';
}

/** Create a job for a won lead (creating its client first if needed), then open it. */
function createJobFromLead(ctx, lead) {
  const { store, ui, nav } = ctx;
  let clientId = lead.clientId;
  if (!clientId || !store.get('clients', clientId)) {
    const c = store.add('clients', { name: lead.contactName || lead.title, type: 'residential', email: lead.email || '', phone: lead.phone || '', address: '', notes: `Created from lead "${lead.title}"`, tags: [] });
    clientId = c.id;
    store.update('leads', lead.id, { clientId });
  }
  const client = store.get('clients', clientId);
  const estimate = store.list('estimates', (e) => e.clientId === clientId && e.status === 'accepted' && !e.jobId)[0];
  const job = store.add('jobs', {
    number: store.nextNumber('job'), title: lead.title, clientId, address: client?.address || '', status: 'scheduled',
    startDate: ui.today(), endDate: '', crewIds: [], estimateId: estimate?.id || null, description: lead.notes || '', changeOrders: [],
  });
  ui.toast(`Job ${job.number} created`, 'success');
  nav('#/jobs/' + job.id);
}

/** Change a lead's stage; moving to won offers to create a job, and a stage can start a sequence. */
export async function setStage(ctx, lead, stage) {
  const { store, ui } = ctx;
  if (lead.stage === stage) return;
  const stages = stagesOf(store);
  const target = stageById(stages, stage);
  const fromLabel = stageById(stages, lead.stage)?.label || lead.stage;
  store.update('leads', lead.id, { stage }, { summary: `${lead.title}: ${fromLabel} → ${target?.label || stage}` });
  if (stage === 'won' || stage === 'lost') processSequences(store);
  else if (target?.sequenceId && store.get('sequences', target.sequenceId)) {
    // The stage triggers a follow-up: enrol the lead unless it is already active in that sequence.
    const already = store.list('enrolments', (e) => e.leadId === lead.id && e.sequenceId === target.sequenceId && e.status === 'active').length;
    if (!already) {
      store.add('enrolments', { sequenceId: target.sequenceId, leadId: lead.id, startedAt: new Date().toISOString(), stepIndex: 0, status: 'active' });
      const n = processSequences(store);
      ui.toast(`Moved to ${target.label} · started ${store.get('sequences', target.sequenceId).name}${n ? ` · ${n} queued` : ''}`, 'success');
    }
  }
  if (stage === 'won') {
    ui.toast('Lead won', 'success');
    if (await ui.confirmDialog(`Create a job for "${lead.title}" now?`, { title: 'Lead won', okLabel: 'Create job', danger: false })) {
      createJobFromLead(ctx, store.get('leads', lead.id));
    }
  }
}

export function openLeadSheet(ctx, lead = null, { prefill = {} } = {}) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const l = lead || { stage: 'new', nextActionAt: ui.today(), ...prefill };
  const clients = store.list('clients').sort((a, b) => a.name.localeCompare(b.name));
  const sources = [...new Set([...SOURCES, ...store.list('leads').map((x) => x.source).filter(Boolean)])];

  let extra = null;
  if (lead) {
    const sequences = store.list('sequences', (s) => s.active);
    const enrols = store.list('enrolments', (e) => e.leadId === lead.id);
    const seqSelect = h('select', { class: 'input', 'aria-label': 'Sequence' },
      h('option', { value: '' }, sequences.length ? 'Choose a sequence…' : 'No active sequences'),
      sequences.map((s) => h('option', { value: s.id }, s.name)));
    extra = h('div', { class: 'stack crm-lead-extra' },
      h('hr', { class: 'hr' }),
      h('div', { class: 'field' }, h('span', null, 'Follow-up sequence'),
        h('div', { class: 'row' }, seqSelect, ui.button('Enrol', {
          icon: 'send', onClick: () => {
            if (!seqSelect.value) return ui.toast('Pick a sequence first', 'error');
            if (enrols.some((e) => e.sequenceId === seqSelect.value && e.status === 'active')) return ui.toast('Already enrolled in that sequence', 'error');
            store.add('enrolments', { sequenceId: seqSelect.value, leadId: lead.id, startedAt: new Date().toISOString(), stepIndex: 0, status: 'active' });
            const n = processSequences(store);
            ui.toast(`Enrolled${n ? ` · ${n} message${n > 1 ? 's' : ''} queued` : ''}`, 'success');
            sheet.close();
          },
        })),
        enrols.length ? h('div', { class: 'crm-enrols' }, enrols.map((e) => {
          const s = store.get('sequences', e.sequenceId);
          return h('div', { class: 'row' }, ui.statusBadge(e.status), h('span', null, s?.name || 'Deleted sequence'),
            h('span', { class: 'muted crm-sub' }, `step ${Math.min(e.stepIndex + 1, s?.steps?.length || 0)} of ${s?.steps?.length || 0}`));
        })) : null),
      h('div', { class: 'row' },
        ui.button('Create estimate', { icon: 'file-text', onClick: () => { sheet.close(); nav(`#/estimates/new?leadId=${lead.id}${lead.clientId ? `&clientId=${lead.clientId}` : ''}`); } }),
        !lead.clientId ? ui.button('Create client from lead', {
          icon: 'user', onClick: () => {
            sheet.close();
            openClientSheet(ctx, null, { prefill: { name: lead.contactName || lead.title, email: lead.email, phone: lead.phone, notes: `From lead "${lead.title}"` },
              onSaved: (c) => store.update('leads', lead.id, { clientId: c.id }) });
          },
        }) : ui.button('Open client', { icon: 'users', onClick: () => { sheet.close(); nav('#/clients/' + lead.clientId); } }),
        lead.stage === 'won' ? ui.button('Create job', { icon: 'briefcase', onClick: () => { sheet.close(); createJobFromLead(ctx, store.get('leads', lead.id)); } }) : null));
  }

  const sheet = ui.formSheet({
    title: lead ? lead.title : 'New lead',
    submitLabel: lead ? 'Save' : 'Add lead',
    fields: [
      { label: 'What is the work?', name: 'title', value: l.title, required: true, span: true, placeholder: 'e.g. Panel upgrade 100A → 200A' },
      { label: 'Contact name', name: 'contactName', value: l.contactName },
      { label: 'Client', name: 'clientId', type: 'select', value: l.clientId || '', options: ui.recordOptions(clients, 'name', '— not a client yet —') },
      { label: 'Email', name: 'email', type: 'email', value: l.email },
      { label: 'Phone', name: 'phone', type: 'tel', value: l.phone },
      { label: 'Source', name: 'source', type: 'select', value: l.source || 'Website', options: sources },
      { label: 'Stage', name: 'stage', type: 'select', value: l.stage, options: stagesOf(store).map((s) => ({ value: s.id, label: s.label })) },
      { label: 'Estimated value', name: 'valueCents', type: 'money', value: l.valueCents ?? 0 },
      { label: 'Next action', name: 'nextActionAt', type: 'date', value: l.nextActionAt ? String(l.nextActionAt).slice(0, 10) : '' },
      { label: 'Notes', name: 'notes', type: 'textarea', value: l.notes, span: true },
    ],
    extra,
    danger: lead ? { label: 'Delete', onClick: async () => {
      if (!(await ui.confirmDialog(`Delete lead "${lead.title}"?`, { okLabel: 'Delete' }))) return;
      for (const e of store.list('enrolments', (x) => x.leadId === lead.id)) store.update('enrolments', e.id, { status: 'stopped' });
      store.remove('leads', lead.id);
      ui.toast('Lead deleted');
    } } : null,
    onSubmit(v) {
      v.clientId = v.clientId || null;
      if (lead) {
        const { stage, ...rest } = v;
        store.update('leads', lead.id, rest);
        if (stage !== lead.stage) setStage(ctx, store.get('leads', lead.id), stage);
        else ui.toast('Lead saved', 'success');
      } else {
        store.add('leads', v);
        ui.toast('Lead added', 'success');
      }
    },
  });
  return sheet;
}

function card(ctx, l, today, stages) {
  const { store, ui } = ctx;
  const { h } = ui;
  const due = leadDue(l, today);
  const select = h('select', {
    class: 'crm-stage-select', 'aria-label': `Stage for ${l.title}`,
    onClick: (e) => e.stopPropagation(), onKeydown: (e) => e.stopPropagation(),
    onChange: (e) => setStage(ctx, l, e.target.value),
  }, stages.map((s) => h('option', { value: s.id, selected: s.id === l.stage }, s.label)));
  return h('article', {
    class: ['kanban-card', 'crm-card', due === 'overdue' ? 'crm-due' : due === 'today' ? 'crm-due-today' : null], draggable: 'true', tabindex: 0,
    'aria-label': l.title,
    onDragstart: (e) => { e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('crm-dragging'); },
    onDragend: (e) => e.currentTarget.classList.remove('crm-dragging'),
    onClick: () => openLeadSheet(ctx, store.get('leads', l.id)),
    onKeydown: (e) => { if (e.key === 'Enter') openLeadSheet(ctx, store.get('leads', l.id)); },
  },
  h('div', { class: 'crm-card-title' }, l.title),
  h('div', { class: 'muted crm-sub' }, clientName(store, l), l.source ? ` · ${l.source}` : ''),
  h('div', { class: 'row crm-card-foot' },
    h('strong', { class: 'num' }, ui.fmtMoney(l.valueCents, { whole: true })),
    due ? ui.badge(due === 'overdue' ? 'Overdue' : 'Due today', due === 'overdue' ? 'danger' : 'warning')
      : (OPEN(l) && l.nextActionAt ? h('span', { class: 'muted crm-sub' }, ui.fmtDate(l.nextActionAt, { month: 'short', day: 'numeric' })) : null),
    h('span', { class: 'grow' }), select));
}

function kanban(ctx, leads, today, stages) {
  const { store, ui } = ctx;
  const { h } = ui;
  return h('div', { class: 'kanban crm-kanban' }, stages.map((s) => {
    const rows = leads.filter((l) => l.stage === s.id)
      .sort((a, b) => String(a.nextActionAt || '9').localeCompare(String(b.nextActionAt || '9')));
    const total = rows.reduce((sum, l) => sum + (Number(l.valueCents) || 0), 0);
    const col = h('section', {
      class: ['kanban-col', `crm-col-${s.kind}`], 'aria-label': s.label,
      onDragover: (e) => { e.preventDefault(); col.classList.add('drag-over'); },
      onDragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); },
      onDrop: (e) => {
        e.preventDefault(); col.classList.remove('drag-over');
        const lead = store.get('leads', e.dataTransfer.getData('text/plain'));
        if (lead) setStage(ctx, lead, s.id);
      },
    },
    h('header', null, stageBadge(ui, s), h('span', { class: 'muted crm-sub' }, String(rows.length)), h('span', { class: 'grow' }), h('span', { class: 'num crm-sub' }, ui.fmtMoney(total, { whole: true }))),
    rows.length ? rows.map((l) => card(ctx, l, today, stages)) : h('div', { class: 'crm-col-empty' }, 'Drop leads here'));
    return col;
  }));
}

function funnel(ctx, leads, stages) {
  const { ui } = ctx;
  const { h } = ui;
  if (!leads.length) return ui.empty({ icon: 'funnel', title: 'No leads yet', text: 'The funnel fills in as leads move through stages.' });
  // Open stages plus Won, in the company's order. A lead has "reached" every stage up to its
  // current one; lost leads (and leads on a removed stage) count only at the top.
  const order = funnelOrder(stages);
  const reached = reachedCounts(leads, order);
  const top = reached[0] || 1;
  const won = leads.filter((l) => l.stage === 'won').length;
  const lost = leads.filter((l) => l.stage === 'lost').length;
  const closed = won + lost;
  const wonIdx = order.findIndex((s) => s.kind === 'won');
  const quoteIdx = wonIdx > 0 ? wonIdx - 1 : -1; // the last open stage before Won, whatever it is called
  const quoteStage = quoteIdx >= 0 ? order[quoteIdx] : null;

  const steps = h('div', { class: 'crm-funnel' }, order.map((st, i) => {
    const pct = (reached[i] / top) * 100;
    const conv = i > 0 && reached[i - 1] ? Math.round((reached[i] / reached[i - 1]) * 100) : null;
    return h('div', { class: 'crm-funnel-row' },
      h('div', { class: 'crm-funnel-label' }, st.label),
      h('div', { class: 'crm-funnel-track' }, h('div', { class: ['crm-funnel-bar', st.kind === 'won' ? 'won' : null], style: { width: `${Math.max(pct, 2)}%` } },
        h('span', { class: 'num' }, String(reached[i])))),
      h('div', { class: 'crm-funnel-conv num muted' }, conv == null ? '' : `${conv}%`));
  }));

  const bySource = {};
  for (const l of leads) {
    const k = l.source || 'Unknown';
    bySource[k] ??= { value: 0, count: 0, won: 0 };
    bySource[k].value += Number(l.valueCents) || 0;
    bySource[k].count++;
    if (l.stage === 'won') bySource[k].won++;
  }
  const sources = Object.entries(bySource).sort((a, b) => b[1].value - a[1].value);
  const maxVal = Math.max(1, ...sources.map(([, v]) => v.value));
  const srcEl = h('div', { class: 'crm-sources' }, sources.map(([name, v]) => h('div', { class: 'crm-funnel-row' },
    h('div', { class: 'crm-funnel-label' }, name),
    h('div', { class: 'crm-funnel-track' }, h('div', { class: 'crm-funnel-bar source', style: { width: `${Math.max((v.value / maxVal) * 100, 2)}%` } })),
    h('div', { class: 'crm-funnel-conv num' }, ui.fmtMoney(v.value, { whole: true }), h('span', { class: 'muted crm-sub' }, ` · ${v.count} lead${v.count > 1 ? 's' : ''}${v.won ? `, ${v.won} won` : ''}`)))));

  return h('div', { class: 'stack' },
    h('div', { class: 'grid' },
      ui.stat({ label: 'Win rate', value: closed ? `${Math.round((won / closed) * 100)}%` : '—', hint: `${won} won · ${lost} lost`, tone: 'success' }),
      ui.stat({ label: quoteStage ? `Lead → ${quoteStage.label.toLowerCase()}` : 'Lead → quote',
        value: quoteStage && top ? `${Math.round((reached[quoteIdx] / top) * 100)}%` : '—',
        hint: quoteStage ? `${reached[quoteIdx]} of ${reached[0]} reached ${quoteStage.label.toLowerCase()}` : '' }),
      ui.stat({ label: 'Avg lead value', value: ui.fmtMoney(leads.reduce((s, l) => s + (Number(l.valueCents) || 0), 0) / leads.length, { whole: true }) })),
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('h3', null, 'Conversion by stage'), h('p', { class: 'muted crm-sub crm-caption' }, 'Bar: leads that reached the stage. Right: % carried over from the stage above.'), steps),
      h('div', { class: 'card' }, h('h3', null, 'Pipeline value by source'), srcEl)));
}

function list(ctx, leads, today, stages) {
  const { store, ui } = ctx;
  const { h } = ui;
  return ui.table({
    columns: [
      { key: 'title', label: 'Lead', sort: (r) => r.title.toLowerCase(), render: (r) => h('div', null, h('div', { style: { fontWeight: 600 } }, r.title), h('div', { class: 'muted crm-sub' }, clientName(store, r))) },
      { key: 'stage', label: 'Stage', sort: (r) => { const i = stages.findIndex((s) => s.id === r.stage); return i < 0 ? stages.length : i; }, render: (r) => leadStageBadge(ui, store, r.stage) },
      { key: 'source', label: 'Source', sort: (r) => r.source || '' },
      { key: 'valueCents', label: 'Value', align: 'right', sort: (r) => r.valueCents || 0, render: (r) => ui.fmtMoney(r.valueCents, { whole: true }) },
      { key: 'nextActionAt', label: 'Next action', sort: (r) => r.nextActionAt || '9', render: (r) => {
        const due = leadDue(r, today);
        return due ? ui.badge(due === 'overdue' ? `Overdue · ${ui.fmtDate(r.nextActionAt, { month: 'short', day: 'numeric' })}` : 'Today', due === 'overdue' ? 'danger' : 'warning') : ui.fmtDate(r.nextActionAt);
      } },
    ],
    rows: leads,
    onRowClick: (r) => openLeadSheet(ctx, store.get('leads', r.id)),
    empty: ui.empty({ icon: 'funnel', title: 'No leads match', action: ui.button('Add lead', { variant: 'primary', icon: 'plus', onClick: () => openLeadSheet(ctx) }) }),
  });
}

export default {
  id: 'leads',
  title: 'Leads & funnels',
  icon: 'funnel',
  group: 'sales',
  perm: 'leads',
  render(root, ctx) {
    const { store, ui } = ctx;
    const { h } = ui;
    let view = ctx.query.view || 'board', q = '';
    const statsEl = h('div', { class: 'grid crm-stats' });
    const tabsHolder = h('div');
    const searchEl = ui.searchBox('Search leads', (v) => { q = v; draw(); });
    const tabsEl = h('div', { class: 'row crm-filters' }, tabsHolder, h('span', { class: 'grow' }), searchEl);
    const body = h('div');

    const draw = () => {
      const today = ui.today();
      const stages = stagesOf(store);
      const all = store.list('leads');
      const term = q.trim().toLowerCase();
      const leads = term ? all.filter((l) => [l.title, l.contactName, l.source, l.email, l.phone, clientName(store, l)].join(' ').toLowerCase().includes(term)) : all;
      const open = all.filter(OPEN);
      const due = open.filter((l) => leadDue(l, today));
      ui.clear(statsEl).append(
        ui.stat({ label: 'Open pipeline', value: ui.fmtMoney(open.reduce((s, l) => s + (Number(l.valueCents) || 0), 0), { whole: true }), hint: `${open.length} open lead${open.length === 1 ? '' : 's'}`, tone: 'accent' }),
        ui.stat({ label: 'Won', value: ui.fmtMoney(all.filter((l) => l.stage === 'won').reduce((s, l) => s + (Number(l.valueCents) || 0), 0), { whole: true }), tone: 'success' }),
        ui.stat({ label: 'Follow-ups due', value: String(due.length), hint: due.length ? `${due.filter((l) => leadDue(l, today) === 'overdue').length} overdue` : 'All caught up', tone: due.length ? 'danger' : null }));
      ui.clear(tabsHolder).append(
        ui.tabs([{ id: 'board', label: 'Pipeline' }, { id: 'funnel', label: 'Funnel' }, { id: 'list', label: 'List' }], view, (v) => { view = v; draw(); }));
      ui.clear(body);
      if (!all.length) body.append(ui.empty({ icon: 'funnel', title: 'No leads yet', text: 'Every enquiry starts here. Add one and drag it through the pipeline.', action: ui.button('Add lead', { variant: 'primary', icon: 'plus', onClick: () => openLeadSheet(ctx) }) }));
      else if (view === 'funnel') body.append(funnel(ctx, leads, stages));
      else if (view === 'list') body.append(list(ctx, leads, today, stages));
      else body.append(kanban(ctx, leads, today, stages));
    };
    root.append(ui.page({
      title: 'Leads & funnels',
      subtitle: 'Every enquiry from first call to won job',
      actions: [ui.button('Sequences', { icon: 'send', href: '#/sequences' }), ui.button('Add lead', { variant: 'primary', icon: 'plus', onClick: () => openLeadSheet(ctx) })],
    }, h('div', { class: 'stack' }, statsEl, tabsEl, body)));
    draw();
    if (ctx.query.new) openLeadSheet(ctx, null, { prefill: { clientId: ctx.query.clientId || null } });
    return store.on('*', (e) => { if (['leads', 'clients', 'enrolments', 'settings'].includes(e.coll)) draw(); });
  },
};
