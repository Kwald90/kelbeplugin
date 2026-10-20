// Equipment and site inspections: checklist templates, pass/fail with photos, failed items
// raise corrective actions, recurring due dates.
import { TEMPLATES, templateById, newInspection, inspectionResult, inspectionSchedule, nextDueDate, failedItems } from '../../lib/safety-inspections.js';
import { signaturePad, signatureOf, photoStrip } from '../../lib/safety-capture.js';
import { me, jobOptions, jobLabel, nameOf, seg, signatureView, backBtn } from './common.js';

const RESULT_TONE = { pass: 'success', fail: 'danger', 'in-progress': 'warning' };
const STATE_TONE = { overdue: 'danger', due: 'warning', ok: 'success' };

export function inspectionsList(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const t = ui.today();
  const all = store.list('safetyInspections');
  const sched = inspectionSchedule(all, t);
  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'grow' }), ui.button('New inspection', { variant: 'primary', icon: 'plus', onClick: () => startInspection(ctx) })));
  el.append(...ui.section('Recurring', sched.length ? ui.table({
    columns: [
      { key: 'what', label: 'Equipment / area', render: (s) => h('span', null, h('strong', null, templateById(s.templateId)?.title || s.templateId), s.assetTag ? ` · ${s.assetTag}` : '') },
      { key: 'job', label: 'Job', render: (s) => jobLabel(store.get('jobs', s.jobId)) || '—' },
      { key: 'last', label: 'Last', render: (s) => h('span', null, ui.fmtDate(s.lastDate), ' ', ui.badge(s.lastResult, RESULT_TONE[s.lastResult] || 'neutral')) },
      { key: 'due', label: 'Next due', sort: (s) => s.nextDue, render: (s) => ui.badge(`${s.state === 'overdue' ? 'overdue · ' : ''}${ui.fmtDate(s.nextDue)}`, STATE_TONE[s.state]) },
      { key: 'go', label: '', render: (s) => ui.button('Inspect', { size: 'sm', onClick: (e) => { e.stopPropagation(); startInspection(ctx, { templateId: s.templateId, assetTag: s.assetTag, jobId: s.jobId }); } }) },
    ],
    rows: sched, onRowClick: (s) => ctx.nav(`safety/inspections/${s.inspection.id}`),
  }) : h('p', { class: 'muted' }, 'Completed inspections with a frequency show up here with their next due date.')));
  const recent = all.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 60);
  el.append(...ui.section('Recent', recent.length ? h('div', { class: 'list' }, recent.map((i) => h('a', { class: 'list-row click', href: `#/safety/inspections/${i.id}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, i.title, i.assetTag ? ` · ${i.assetTag}` : ''),
      h('div', { class: 'meta' }, [ui.fmtDate(i.date), nameOf(store, i.inspectorId, ''), jobLabel(store.get('jobs', i.jobId))].filter(Boolean).join(' · '))),
    failedItems(i).length ? ui.badge(`${failedItems(i).length} failed`, 'danger') : null,
    ui.badge(i.result || 'in-progress', RESULT_TONE[i.result] || 'neutral'))))
    : ui.empty({ icon: 'check', title: 'No inspections yet', text: 'Ladders, lifts, cords, temporary power, PPE, first-aid kits, extinguishers and the site.' })));
}

export function startInspection(ctx, preset = {}) {
  const { store, ui, nav } = ctx;
  const person = me(ctx);
  if (!person.id) { ui.toast('Link your account to an employee record first', 'error'); return; }
  ui.formSheet({
    title: 'New inspection',
    submitLabel: 'Start',
    fields: [
      { label: 'What', name: 'templateId', type: 'select', value: preset.templateId || 'ladder', options: TEMPLATES.map((t) => ({ value: t.id, label: t.title })), span: true },
      { label: 'Equipment no. / area', name: 'assetTag', value: preset.assetTag || '', placeholder: 'e.g. L-03, 8 ft fibreglass' },
      { label: 'Job', name: 'jobId', type: 'select', value: preset.jobId || ctx.query?.jobId || '', options: jobOptions(ctx) },
    ],
    onSubmit(v) {
      const t = templateById(v.templateId);
      const rec = store.add('safetyInspections', newInspection(t, { jobId: v.jobId || null, assetTag: v.assetTag.trim(), date: ui.today(), inspectorId: person.id }));
      setTimeout(() => nav(`safety/inspections/${rec.id}`), 0);
    },
  });
}

/** #/safety/inspections/<id> */
export function inspectionView(root, ctx, id) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const rec = store.get('safetyInspections', id);
  if (!rec) { root.append(ui.page({ title: 'Inspection' }, ui.empty({ icon: 'check', title: 'Not found', action: ui.button('Safety', { href: '#/safety?tab=inspections' }) }))); return; }
  const person = me(ctx);
  const canEdit = (auth.isManager() || rec.inspectorId === person.id) && !rec.completedAt;
  const d = structuredClone(rec);
  const job = d.jobId && store.get('jobs', d.jobId);
  const summary = h('div', { class: 'row' });
  const drawSummary = () => {
    ui.clear(summary);
    const res = inspectionResult(d.items);
    const f = d.items.filter((i) => i.result === 'fail').length, open = d.items.filter((i) => i.result === 'open').length;
    summary.append(ui.badge(res, RESULT_TONE[res]), h('span', { class: 'muted' }, `${d.items.length - open} of ${d.items.length} checked`), f ? ui.badge(`${f} failed`, 'danger') : null);
  };
  const items = h('div', { class: 'sf-items' }, d.items.map((it) => {
    it.photos ||= [];
    const extra = h('div', { class: 'sf-item-extra', hidden: it.result !== 'fail' && !it.note && !it.photos.length });
    const note = h('input', { class: 'input', placeholder: 'What is wrong', 'aria-label': `Note: ${it.text}`, value: it.note || '', disabled: !canEdit, onInput: (e) => { it.note = e.target.value; } });
    extra.append(note, photoStrip({ photos: it.photos, max: 3, readOnly: !canEdit, label: 'Photo', toast: ui.toast }));
    const row = h('div', { class: ['sf-item', `is-${it.result}`] },
      h('div', { class: 'sf-item-text' }, h('div', null, it.text), it.ref ? h('div', { class: 'meta muted mono' }, it.ref) : null),
      canEdit ? seg(ui, [['pass', 'Pass'], ['fail', 'Fail'], ['na', 'N/A']], it.result, (v) => {
        it.result = v; row.className = `sf-item is-${v}`; extra.hidden = v !== 'fail' && !it.note && !it.photos.length; drawSummary();
      }, { label: it.text }) : ui.badge(it.result, it.result === 'pass' ? 'success' : it.result === 'fail' ? 'danger' : 'neutral'),
      extra);
    return row;
  }));
  drawSummary();
  const freq = h('input', { class: 'input', type: 'number', min: 0, step: 1, value: d.frequencyDays ?? '', disabled: !canEdit, 'aria-label': 'Inspect again every (days)' });
  const pad = canEdit ? signaturePad({ label: `Inspector: ${person.name}` }) : null;

  function save(complete) {
    const patch = { items: d.items, frequencyDays: freq.value === '' ? null : Math.max(0, Math.round(Number(freq.value))), result: inspectionResult(d.items) };
    if (complete) {
      if (d.items.some((i) => i.result === 'open')) { ui.toast('Check every item first', 'error'); return; }
      const sig = signatureOf(pad, { name: person.name, employeeId: person.id });
      if (!sig) { ui.toast('Sign in the box first', 'error'); return; }
      patch.signature = sig;
      patch.completedAt = new Date().toISOString();
      patch.nextDue = nextDueDate({ ...d, ...patch });
    }
    store.update('safetyInspections', id, patch, { summary: `${d.title}${complete ? ` ${patch.result}` : ''}` });
    if (complete) {
      // Every failed item becomes a corrective action (workers raise it, a manager assigns it).
      const failed = d.items.filter((i) => i.result === 'fail');
      for (const it of failed) {
        store.add('correctiveActions', {
          title: `${d.title}${d.assetTag ? ` ${d.assetTag}` : ''}: ${it.text}`, description: it.note || '', priority: 'high',
          sourceType: 'inspection', sourceId: id, sourceItemId: it.id, jobId: d.jobId || null,
          ownerId: null, dueDate: auth.isManager() ? ui.today(1) : null,
          status: 'open', evidence: [], createdBy: person.id,
        });
      }
      ui.toast(failed.length ? `Failed: ${failed.length} corrective action${failed.length === 1 ? '' : 's'} raised. Tag the equipment out of service.` : 'Inspection passed', failed.length ? 'error' : 'success', 4500);
      nav('safety?tab=inspections');
    } else ui.toast('Saved', 'success');
  }

  const actions = store.list('correctiveActions', (a) => a.sourceType === 'inspection' && a.sourceId === id);
  root.append(ui.page({
    title: `${d.title}${d.assetTag ? ` · ${d.assetTag}` : ''}`,
    subtitle: [ui.fmtDate(d.date), nameOf(store, d.inspectorId, ''), jobLabel(job)].filter(Boolean).join(' · '),
    actions: [backBtn(ui, '#/safety?tab=inspections'), ui.button('Print', { icon: 'printer', onClick: () => print() })],
  },
  h('div', { class: 'card stack' }, summary, h('label', { class: 'field sf-freq' }, h('span', null, 'Inspect again every (days)'), freq)),
  ...ui.section('Checklist', h('div', { class: 'card' }, items)),
  !canEdit && !rec.completedAt ? h('p', { class: 'muted' }, 'In progress. Only the inspector or a manager can change it.') : null,
  rec.completedAt ? ui.section('Signed', signatureView(ui, rec.signature, 'Inspected')) : null,
  actions.length ? ui.section('Corrective actions', h('ul', null, actions.map((a) => h('li', null, a.title, ' · ', a.status)))) : null,
  canEdit ? ui.section('Sign', h('div', { class: 'card stack' }, pad.el, h('div', { class: 'row sf-actions' },
    ui.button('Save', { variant: 'ghost', onClick: () => save(false) }), h('span', { class: 'grow' }),
    ui.button('Complete inspection', { variant: 'primary', icon: 'check', onClick: () => save(true) })))) : null));
}
