// Sequences (S14): automated follow-up steps for leads, enrolments, and the outbox.
// Sending providers aren't connected yet, so due steps land in the outbox for
// someone to send by hand (mailto:/sms: links) and mark as sent.

const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'Text (SMS)' },
  { value: 'task', label: 'Task' },
];
const CHANNEL_ICON = { email: 'mail', sms: 'phone', task: 'check' };
const DAY = 86400000;

function mergeFields(text, lead, store) {
  const client = lead.clientId ? store.get('clients', lead.clientId) : null;
  const name = (lead.contactName || client?.name || 'there').split(/\s+/)[0];
  const company = store.settings().company?.name || '';
  return String(text || '').replace(/\{\{\s*name\s*\}\}/gi, name).replace(/\{\{\s*fullname\s*\}\}/gi, lead.contactName || client?.name || '')
    .replace(/\{\{\s*company\s*\}\}/gi, company).replace(/\{\{\s*job\s*\}\}/gi, lead.title || '');
}

/** When step i of an enrolment is due. */
export function stepDueAt(enrolment, step) {
  return new Date(new Date(enrolment.startedAt).getTime() + (Number(step?.dayOffset) || 0) * DAY);
}

/**
 * Queue every due step of every active enrolment into the outbox.
 * Stops enrolments whose lead is won, lost or deleted. Paused (inactive)
 * sequences are skipped without advancing. Returns the number of messages queued.
 */
export function processSequences(store, now = new Date()) {
  let queued = 0;
  for (const e of store.list('enrolments', (x) => x.status === 'active')) {
    const lead = store.get('leads', e.leadId);
    const seq = store.get('sequences', e.sequenceId);
    if (!lead || !seq || lead.stage === 'won' || lead.stage === 'lost') {
      store.update('enrolments', e.id, { status: 'stopped' }, { summary: `Sequence stopped: ${lead ? `lead ${lead.stage}` : 'lead removed'}` });
      continue;
    }
    if (!seq.active) continue;
    const steps = seq.steps || [];
    const client = lead.clientId ? store.get('clients', lead.clientId) : null;
    let i = e.stepIndex || 0;
    while (i < steps.length && stepDueAt(e, steps[i]) <= now) {
      const step = steps[i];
      const to = step.channel === 'email' ? (lead.email || client?.email || '')
        : step.channel === 'sms' ? (lead.phone || client?.phone || '') : '';
      store.add('outbox', {
        channel: step.channel, to, subject: mergeFields(step.subject, lead, store), body: mergeFields(step.body, lead, store),
        relatedId: lead.id, status: 'queued', dueAt: stepDueAt(e, step).toISOString(),
      });
      queued++;
      i++;
    }
    if (i !== (e.stepIndex || 0)) {
      store.update('enrolments', e.id, { stepIndex: i, status: i >= steps.length ? 'done' : 'active' });
    } else if (i >= steps.length) {
      store.update('enrolments', e.id, { status: 'done' });
    }
  }
  return queued;
}

function nextDue(store, e) {
  if (e.status !== 'active') return null;
  const seq = store.get('sequences', e.sequenceId);
  const step = seq?.steps?.[e.stepIndex];
  return step ? stepDueAt(e, step) : null;
}

function newSequence({ store, nav, ui }) {
  const s = store.add('sequences', {
    name: 'New sequence', active: false,
    steps: [{ dayOffset: 0, channel: 'email', subject: 'Thanks for getting in touch', body: 'Hi {{name}}, ' }],
  });
  ui.toast('Sequence created. It stays paused until you turn it on.');
  nav('#/sequences/' + s.id);
}

function sequencesTab(ctx) {
  const { store, ui, nav } = ctx;
  const { h, icon } = ui;
  const seqs = store.list('sequences').sort((a, b) => a.name.localeCompare(b.name));
  if (!seqs.length) return ui.empty({ icon: 'send', title: 'No sequences yet', text: 'A sequence sends a lead a set of follow-ups on a schedule so nobody falls through the cracks.', action: ui.button('New sequence', { variant: 'primary', icon: 'plus', onClick: () => newSequence(ctx) }) });
  return h('div', { class: 'grid' }, seqs.map((s) => {
    const enrols = store.list('enrolments', (e) => e.sequenceId === s.id);
    const active = enrols.filter((e) => e.status === 'active').length;
    const lastDay = Math.max(0, ...(s.steps || []).map((st) => Number(st.dayOffset) || 0));
    return h('article', { class: 'card click crm-seq-card', tabindex: 0, onClick: () => nav('#/sequences/' + s.id), onKeydown: (e) => { if (e.key === 'Enter') nav('#/sequences/' + s.id); } },
      h('div', { class: 'row' }, h('h3', { class: 'grow', style: { margin: 0 } }, s.name),
        h('label', { class: 'crm-switch', onClick: (e) => e.stopPropagation(), title: s.active ? 'Pause' : 'Turn on' },
          h('input', { type: 'checkbox', checked: !!s.active, 'aria-label': `${s.name} active`, onChange: (e) => { store.update('sequences', s.id, { active: e.target.checked }); if (e.target.checked) processSequences(store); } }),
          h('span', { class: 'crm-switch-track' }))),
      h('div', { class: 'crm-seq-steps' }, (s.steps || []).map((st) => h('span', { class: 'crm-step-dot', title: `Day ${st.dayOffset}: ${st.channel}` }, icon(CHANNEL_ICON[st.channel], 14), `D${st.dayOffset}`))),
      h('div', { class: 'row muted crm-sub' }, `${(s.steps || []).length} steps over ${lastDay} day${lastDay === 1 ? '' : 's'}`, h('span', { class: 'grow' }),
        ui.badge(`${active} active`, active ? 'success' : 'neutral'), ui.badge(s.active ? 'On' : 'Paused', s.active ? 'success' : 'neutral')));
  }));
}

function enrolmentsTable(ctx, rows) {
  const { store, ui } = ctx;
  const { h } = ui;
  return ui.table({
    columns: [
      { key: 'lead', label: 'Lead', sort: (r) => store.get('leads', r.leadId)?.title || '', render: (r) => {
        const l = store.get('leads', r.leadId);
        return l ? h('div', null, h('div', { style: { fontWeight: 600 } }, l.title), h('div', { class: 'muted crm-sub' }, l.contactName || '')) : h('span', { class: 'muted' }, 'Deleted lead');
      } },
      { key: 'seq', label: 'Sequence', render: (r) => store.get('sequences', r.sequenceId)?.name || '—' },
      { key: 'step', label: 'Step', render: (r) => { const n = store.get('sequences', r.sequenceId)?.steps?.length || 0; return `${Math.min(r.stepIndex, n)} of ${n} sent`; } },
      { key: 'next', label: 'Next due', sort: (r) => nextDue(store, r)?.getTime() || Infinity, render: (r) => { const d = nextDue(store, r); return d ? ui.fmtDateTime(d) : '—'; } },
      { key: 'status', label: 'Status', render: (r) => ui.statusBadge(r.status) },
      { key: 'act', label: '', align: 'right', render: (r) => (r.status === 'active' ? ui.button('Stop', { size: 'sm', variant: 'ghost danger', onClick: (e) => { e.stopPropagation(); store.update('enrolments', r.id, { status: 'stopped' }); ui.toast('Enrolment stopped'); } }) : null) },
    ],
    rows,
    empty: ui.empty({ icon: 'users', title: 'Nobody enrolled', text: 'Enrol a lead from its card on the Leads board, or below.' }),
  });
}

function outboxTab(ctx, showSent) {
  const { store, ui } = ctx;
  const { h, icon } = ui;
  const rows = store.list('outbox', (o) => showSent || o.status === 'queued').sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
  const note = h('div', { class: 'card flat crm-note' }, icon('info', 18),
    h('span', null, 'Email and text providers aren’t connected yet. Due messages wait here: open each one in your mail or messages app, send it, then mark it sent.'));
  if (!rows.length) return [note, ui.empty({ icon: 'send', title: showSent ? 'Outbox is empty' : 'Nothing waiting to send', text: 'Due sequence steps show up here.' })];
  return [note, h('div', { class: 'list' }, rows.map((o) => {
    const lead = store.get('leads', o.relatedId);
    const href = o.channel === 'email' && o.to ? `mailto:${encodeURIComponent(o.to)}?subject=${encodeURIComponent(o.subject || '')}&body=${encodeURIComponent(o.body || '')}`
      : o.channel === 'sms' && o.to ? `sms:${o.to.replace(/[^0-9+]/g, '')}&body=${encodeURIComponent(o.body || '')}` : null;
    return h('div', { class: 'list-row crm-outbox-row' },
      h('span', { class: 'crm-chan' }, icon(CHANNEL_ICON[o.channel] || 'send', 18)),
      h('div', { class: 'grow', style: { minWidth: 0 } },
        h('div', { class: 'title' }, o.subject || (o.channel === 'sms' ? 'Text message' : 'Task'), ' ', o.status === 'sent' ? ui.statusBadge('sent') : null),
        h('div', { class: 'meta' }, [o.channel.toUpperCase(), o.to || (o.channel === 'task' ? 'for the office' : 'no address on file'), lead ? lead.title : null, `due ${ui.fmtDateTime(o.dueAt)}`].filter(Boolean).join(' · ')),
        h('div', { class: 'crm-outbox-body' }, o.body)),
      h('div', { class: 'row crm-outbox-actions' },
        ui.button('', { size: 'sm', icon: 'copy', title: 'Copy message', onClick: async () => {
          try { await navigator.clipboard.writeText([o.subject, o.body].filter(Boolean).join('\n\n')); ui.toast('Copied', 'success'); } catch { ui.toast('Copy blocked by the browser', 'error'); }
        } }),
        href ? ui.button(o.channel === 'email' ? 'Email' : 'Text', { size: 'sm', icon: 'send', href }) : null,
        o.status === 'queued' ? ui.button('Mark sent', { size: 'sm', variant: 'primary', icon: 'check', onClick: () => { store.update('outbox', o.id, { status: 'sent' }); ui.toast('Marked sent', 'success'); } }) : null));
  }))];
}

function listView(root, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  let tab = ctx.query.tab || 'sequences', showSent = false;
  const tabsEl = h('div', { class: 'row crm-filters' });
  const body = h('div', { class: 'stack' });
  const draw = () => {
    const queued = store.count('outbox', (o) => o.status === 'queued');
    const activeEnrols = store.count('enrolments', (e) => e.status === 'active');
    ui.clear(tabsEl).append(ui.tabs([
      { id: 'sequences', label: 'Sequences' },
      { id: 'enrolments', label: `Enrolments (${activeEnrols})` },
      { id: 'outbox', label: `Outbox (${queued})` },
    ], tab, (t) => { tab = t; draw(); }),
    tab === 'outbox' ? h('label', { class: 'field check crm-show-sent' }, h('input', { type: 'checkbox', checked: showSent, onChange: (e) => { showSent = e.target.checked; draw(); } }), h('span', null, 'Show sent')) : null);
    ui.clear(body);
    if (tab === 'sequences') body.append(sequencesTab(ctx));
    else if (tab === 'enrolments') body.append(enrolmentsTable(ctx, store.list('enrolments').sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1))));
    else body.append(...outboxTab(ctx, showSent));
  };
  const n = processSequences(store);
  root.append(ui.page({
    title: 'Sequences',
    subtitle: 'Follow-ups that run themselves',
    actions: [
      ui.button('Run now', { icon: 'play', onClick: () => { const k = processSequences(store); ui.toast(k ? `${k} message${k > 1 ? 's' : ''} queued` : 'Nothing due yet'); } }),
      ui.button('New sequence', { variant: 'primary', icon: 'plus', onClick: () => newSequence(ctx) }),
    ],
  }, h('div', { class: 'stack' }, tabsEl, body)));
  draw();
  if (n) ui.toast(`${n} follow-up${n > 1 ? 's' : ''} queued in the outbox`);
  return store.on('*', (e) => { if (['sequences', 'enrolments', 'outbox', 'leads'].includes(e.coll)) draw(); });
}

function editorView(root, ctx, id) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const seq = store.get('sequences', id);
  if (!seq) {
    root.append(ui.page({ title: 'Sequence not found' }, ui.empty({ icon: 'send', title: 'This sequence no longer exists', action: ui.button('All sequences', { href: '#/sequences' }) })));
    return;
  }
  const draft = { name: seq.name, active: !!seq.active, steps: (seq.steps || []).map((s) => ({ ...s })) };
  let dirty = false;
  const markDirty = () => { dirty = true; saveBtn.disabled = false; };

  const stepsEl = h('ol', { class: 'crm-steps' });
  const drawSteps = () => {
    ui.clear(stepsEl);
    if (!draft.steps.length) stepsEl.append(h('li', { class: 'muted' }, 'No steps yet. Add one below.'));
    draft.steps.forEach((st, i) => {
      const set = (k) => (e) => { st[k] = k === 'dayOffset' ? Math.max(0, Number(e.target.value) || 0) : e.target.value; markDirty(); if (k === 'channel') drawSteps(); };
      stepsEl.append(h('li', { class: 'card flat crm-step' },
        h('div', { class: 'row' },
          h('strong', null, `Step ${i + 1}`), h('span', { class: 'grow' }),
          ui.button('', { size: 'sm', variant: 'ghost', icon: '<path d="M12 19V5M6 11l6-6 6 6"/>', title: 'Move up', disabled: i === 0, onClick: () => { [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]]; markDirty(); drawSteps(); } }),
          ui.button('', { size: 'sm', variant: 'ghost', icon: '<path d="M12 5v14M6 13l6 6 6-6"/>', title: 'Move down', disabled: i === draft.steps.length - 1, onClick: () => { [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]]; markDirty(); drawSteps(); } }),
          ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Remove step', onClick: () => { draft.steps.splice(i, 1); markDirty(); drawSteps(); } })),
        h('div', { class: 'form-grid' },
          h('label', { class: 'field' }, h('span', null, 'Day'), h('input', { type: 'number', min: 0, step: 1, value: st.dayOffset ?? 0, onInput: set('dayOffset') }), h('span', { class: 'hint' }, 'Days after enrolment')),
          h('label', { class: 'field' }, h('span', null, 'Channel'), h('select', { onChange: set('channel') }, CHANNELS.map((c) => h('option', { value: c.value, selected: c.value === st.channel }, c.label)))),
          st.channel !== 'sms' ? h('label', { class: 'field span-2' }, h('span', null, st.channel === 'task' ? 'Task' : 'Subject'), h('input', { value: st.subject || '', onInput: set('subject') })) : null,
          h('label', { class: 'field span-2' }, h('span', null, st.channel === 'task' ? 'Details' : 'Message'), h('textarea', { rows: 3, onInput: set('body') }, st.body || '')))));
    });
  };

  const saveBtn = ui.button('Save', { variant: 'primary', icon: 'save', disabled: true, onClick: save });
  function save() {
    const steps = draft.steps.map((s) => ({ dayOffset: Number(s.dayOffset) || 0, channel: s.channel || 'email', subject: s.subject || '', body: s.body || '' }))
      .sort((a, b) => a.dayOffset - b.dayOffset);
    draft.steps = steps;
    store.update('sequences', id, { name: draft.name.trim() || 'Untitled sequence', active: draft.active, steps });
    dirty = false; saveBtn.disabled = true;
    drawSteps();
    const n = draft.active ? processSequences(store) : 0;
    ui.toast(n ? `Saved · ${n} message${n > 1 ? 's' : ''} queued` : 'Sequence saved', 'success');
  }

  const enrolEl = h('div', { class: 'stack' });
  const drawEnrols = () => {
    ui.clear(enrolEl);
    const enrolled = new Set(store.list('enrolments', (e) => e.sequenceId === id && e.status === 'active').map((e) => e.leadId));
    const candidates = store.list('leads', (l) => l.stage !== 'won' && l.stage !== 'lost' && !enrolled.has(l.id)).sort((a, b) => a.title.localeCompare(b.title));
    const pick = h('select', { class: 'input', 'aria-label': 'Lead to enrol' }, h('option', { value: '' }, candidates.length ? 'Choose an open lead…' : 'No open leads to enrol'), candidates.map((l) => h('option', { value: l.id }, l.title)));
    enrolEl.append(
      h('div', { class: 'row' }, h('div', { class: 'grow', style: { minWidth: '200px' } }, pick), ui.button('Enrol lead', { icon: 'plus', onClick: () => {
        if (!pick.value) return ui.toast('Pick a lead first', 'error');
        if (dirty) save();
        store.add('enrolments', { sequenceId: id, leadId: pick.value, startedAt: new Date().toISOString(), stepIndex: 0, status: 'active' });
        const n = processSequences(store);
        ui.toast(store.get('sequences', id)?.active ? `Enrolled${n ? ` · ${n} queued` : ''}` : 'Enrolled. Turn the sequence on to start sending.', 'success');
      } })),
      enrolmentsTable(ctx, store.list('enrolments', (e) => e.sequenceId === id)));
  };

  const header = h('div', { class: 'card stack' },
    h('div', { class: 'form-grid' },
      h('label', { class: 'field span-2' }, h('span', null, 'Name'), h('input', { value: draft.name, onInput: (e) => { draft.name = e.target.value; markDirty(); } })),
      h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: draft.active, onChange: (e) => { draft.active = e.target.checked; markDirty(); } }), h('span', null, 'Active (sends due steps)'))),
    h('p', { class: 'muted crm-sub', style: { margin: 0 } }, 'Merge fields: {{name}} first name, {{fullname}}, {{company}} your company, {{job}} the lead title.'));

  root.append(ui.page({
    title: seq.name,
    subtitle: h('a', { href: '#/sequences' }, '← All sequences'),
    actions: [
      ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: async () => {
        if (!(await ui.confirmDialog(`Delete "${seq.name}"? Active enrolments will stop.`, { okLabel: 'Delete' }))) return;
        for (const e of store.list('enrolments', (x) => x.sequenceId === id && x.status === 'active')) store.update('enrolments', e.id, { status: 'stopped' });
        store.remove('sequences', id); dirty = false; ui.toast('Sequence deleted'); nav('#/sequences');
      } }),
      saveBtn,
    ],
  }, h('div', { class: 'stack' }, header,
    ...ui.section('Steps', stepsEl, h('div', null, ui.button('Add step', { icon: 'plus', onClick: () => {
      const last = draft.steps[draft.steps.length - 1];
      draft.steps.push({ dayOffset: (Number(last?.dayOffset) || 0) + 2, channel: 'email', subject: '', body: 'Hi {{name}}, ' });
      markDirty(); drawSteps();
    } }))),
    ...ui.section('Enrolled leads', enrolEl))));
  drawSteps();
  drawEnrols();
  const off = store.on('*', (e) => { if (['enrolments', 'leads'].includes(e.coll)) drawEnrols(); });
  const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  addEventListener('beforeunload', warn);
  return () => {
    off(); removeEventListener('beforeunload', warn);
    if (dirty && store.get('sequences', id)) { save(); }
  };
}

export default {
  id: 'sequences',
  title: 'Sequences',
  icon: 'send',
  group: 'sales',
  perm: 'sequences',
  render(root, ctx) {
    return ctx.params[0] ? editorView(root, ctx, ctx.params[0]) : listView(root, ctx);
  },
};
