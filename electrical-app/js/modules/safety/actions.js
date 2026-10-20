// Corrective actions: assigned with an owner and due date (managers), closed with an
// evidence photo by the owner, verified by a manager.
import { actionState } from '../../lib/safety.js';
import { photoStrip } from '../../lib/safety-capture.js';
import { me, jobLabel, nameOf, employeeOptions, jobOptions } from './common.js';

const STATE_TONE = { open: 'info', overdue: 'danger', done: 'warning', verified: 'success' };
const STATE_LABEL = { open: 'open', overdue: 'overdue', done: 'done · to verify', verified: 'verified' };

export const actionBadge = (ui, a) => { const s = actionState(a, ui.today()); return ui.badge(STATE_LABEL[s], STATE_TONE[s]); };

/** New action from a source (incident, inspection item...). Workers raise it unassigned. */
export function newAction(ctx, src = {}, onSaved) {
  const { store, ui, auth } = ctx;
  const manager = auth.isManager();
  const person = me(ctx);
  ui.formSheet({
    title: 'New corrective action',
    submitLabel: 'Add action',
    fields: [
      { label: 'What needs to be fixed', name: 'title', value: src.title || '', required: true, span: true },
      { label: 'Details', name: 'description', type: 'textarea', rows: 2, value: src.description || '', span: true },
      manager ? { label: 'Owner', name: 'ownerId', type: 'select', value: src.ownerId || '', options: employeeOptions(ctx, '— unassigned —') } : null,
      manager ? { label: 'Due', name: 'dueDate', type: 'date', value: src.dueDate || ui.today(7) } : null,
      { label: 'Priority', name: 'priority', type: 'select', value: src.priority || 'medium', options: ['low', 'medium', 'high'] },
      src.jobId === undefined ? { label: 'Job', name: 'jobId', type: 'select', value: '', options: jobOptions(ctx) } : null,
    ].filter(Boolean),
    onSubmit(v) {
      const rec = store.add('correctiveActions', {
        title: v.title.trim(), description: v.description || '', priority: v.priority,
        sourceType: src.sourceType || 'other', sourceId: src.sourceId || null, sourceItemId: src.sourceItemId || null,
        jobId: v.jobId !== undefined ? (v.jobId || null) : (src.jobId || null),
        ownerId: manager ? (v.ownerId || null) : null, dueDate: manager ? (v.dueDate || null) : null,
        status: 'open', evidence: [], createdBy: person.id,
      });
      ui.toast(manager ? 'Action assigned' : 'Action raised: a manager will assign it', 'success');
      onSaved?.(rec);
    },
  });
}

/** The action sheet: details, close with evidence (owner or manager), verify (manager). */
export function openAction(ctx, id) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const a = store.get('correctiveActions', id);
  if (!a) return;
  const manager = auth.isManager();
  const person = me(ctx);
  const owner = person.id && a.ownerId === person.id;
  const evidence = structuredClone(a.evidence || []);
  const canClose = (owner || manager) && a.status !== 'verified';
  const note = h('textarea', { class: 'input', rows: 2, 'aria-label': 'What was done', placeholder: 'What was done', disabled: !canClose }, a.doneNote || '');
  const src = a.sourceType === 'incident' ? `#/safety/incidents/${a.sourceId}` : a.sourceType === 'inspection' ? `#/safety/inspections/${a.sourceId}` : null;
  let edit = null;
  if (manager) {
    edit = h('form', { class: 'stack' }, ui.formGrid([
      { label: 'Owner', name: 'ownerId', type: 'select', value: a.ownerId || '', options: employeeOptions(ctx, '— unassigned —') },
      { label: 'Due', name: 'dueDate', type: 'date', value: a.dueDate || '' },
      { label: 'Priority', name: 'priority', type: 'select', value: a.priority || 'medium', options: ['low', 'medium', 'high'] },
    ]));
  }
  const s = ui.openSheet({
    title: a.title || 'Corrective action', wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'row' }, actionBadge(ui, a), h('span', { class: 'muted' }, [a.ownerId ? `Owner: ${nameOf(store, a.ownerId)}` : 'Unassigned', a.dueDate ? `due ${ui.fmtDate(a.dueDate)}` : null, jobLabel(store.get('jobs', a.jobId))].filter(Boolean).join(' · '))),
      a.description ? h('p', { class: 'sf-pre' }, a.description) : null,
      src ? h('a', { href: src, onClick: () => s.close() }, a.sourceType === 'incident' ? 'Open the incident' : 'Open the inspection') : null,
      edit,
      h('h3', null, 'Evidence'),
      photoStrip({ photos: evidence, max: 4, readOnly: !canClose, label: 'Evidence photo', toast: ui.toast }),
      note,
      a.doneAt ? h('div', { class: 'muted' }, `Done ${ui.fmtDateTime(a.doneAt)} by ${nameOf(store, a.doneBy)}`) : null,
      a.verifiedAt ? h('div', { class: 'muted' }, `Verified ${ui.fmtDateTime(a.verifiedAt)} by ${nameOf(store, a.verifiedBy)}`) : null),
    actions: [
      manager ? ui.button('Delete', { variant: 'ghost danger', icon: 'trash', onClick: async () => { if (await ui.confirmDialog('Delete this corrective action?', { okLabel: 'Delete' })) { store.remove('correctiveActions', id); s.close(); } } }) : null,
      h('span', { class: 'grow' }),
      manager && edit ? ui.button('Save', { onClick: () => { const v = ui.readForm(edit); store.update('correctiveActions', id, { ownerId: v.ownerId || null, dueDate: v.dueDate || null, priority: v.priority }); ui.toast('Saved', 'success'); s.close(); } }) : null,
      canClose && a.status !== 'done' ? ui.button('Mark done', { variant: 'primary', icon: 'check', onClick: () => {
        if (!evidence.length) { ui.toast('Add an evidence photo first', 'error'); return; }
        store.update('correctiveActions', id, { status: 'done', doneAt: new Date().toISOString(), doneBy: person.id, doneNote: note.value.trim(), evidence }, { summary: `Action done: ${a.title}` });
        ui.toast('Marked done', 'success'); s.close();
      } }) : null,
      manager && a.status === 'done' ? ui.button('Verify and close', { variant: 'primary', icon: 'check', onClick: () => {
        store.update('correctiveActions', id, { status: 'verified', verifiedAt: new Date().toISOString(), verifiedBy: person.id }); ui.toast('Verified', 'success'); s.close();
      } }) : null,
      manager && a.status === 'done' ? ui.button('Reopen', { variant: 'ghost', onClick: () => { store.update('correctiveActions', id, { status: 'open', doneAt: null, doneBy: null }); s.close(); } }) : null,
    ].filter(Boolean),
  });
}

/** A list of actions (rows open the sheet). */
export function actionList(ctx, rows, emptyText = 'No corrective actions.') {
  const { store, ui } = ctx;
  const { h } = ui;
  if (!rows.length) return h('p', { class: 'muted' }, emptyText);
  return h('div', { class: 'list' }, rows.map((a) => h('div', { class: 'list-row click', tabindex: 0, onClick: () => openAction(ctx, a.id), onKeydown: (e) => { if (e.key === 'Enter') openAction(ctx, a.id); } },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, a.title || 'Action'),
      h('div', { class: 'meta' }, [a.ownerId ? nameOf(store, a.ownerId) : 'Unassigned', a.dueDate ? `due ${ui.fmtDate(a.dueDate)}` : null, a.priority].filter(Boolean).join(' · '))),
    actionBadge(ui, a))));
}

export function actionsTab(el, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const manager = auth.isManager();
  const order = (a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999'));
  const all = store.list('correctiveActions');
  const mine = all.filter((a) => a.ownerId && a.ownerId === person.id && a.status !== 'verified').sort(order);
  const open = all.filter((a) => a.status !== 'verified' && a.status !== 'done').sort(order);
  const toVerify = all.filter((a) => a.status === 'done');
  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'grow' }), ui.button('New action', { variant: 'primary', icon: 'plus', onClick: () => newAction(ctx) })));
  el.append(...ui.section('Assigned to me', actionList(ctx, mine, 'Nothing assigned to you.')));
  if (manager) {
    el.append(...ui.section(`Open (${open.length})`, actionList(ctx, open)));
    el.append(...ui.section(`Done, waiting for verification (${toVerify.length})`, actionList(ctx, toVerify, 'Nothing to verify.')));
  }
}
