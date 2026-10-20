// Work plans (#/workplan), for foremen and managers: break a job into phases over its working
// days, split the work into tasks for each person, publish a day's lists (the evening before
// or in the morning), run the morning meeting, and read the crew's KPIs.
//
// Routes: #/workplan                 plans
//         #/workplan/kpis            KPIs across every plan
//         #/workplan/<id>?tab=board|tasks|kpis|setup
//         #/workplan/<id>/meeting    daily meeting mode (full screen)
// Records: workPlans, workTasks (one per worker per day), taskTemplates, huddles. The rules
// (spreading, capacity, publishing, moving) are in js/lib/workplan.js, the numbers in
// js/lib/kpis.js; both are shared with the API.
import * as W from '../lib/workplan.js';
import * as K from '../lib/kpis.js';
import { ICON_TODAY, linkButton, photoStrip, quickTaskSheet } from './today.js';

const ICON_PLAN = '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2.5v3M16 2.5v3"/><path d="M7 13h4M7 17h7M14 13h3"/>';
const ICON_SPREAD = '<path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 4v4M12 10v4M16 16v4"/>';
const ICON_CAMERA = '<path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>';
const ICON_MOVE = '<path d="M5 9l-3 3 3 3M19 9l3 3-3 3M9 5l3-3 3 3M9 19l3 3 3-3M2 12h20M12 2v20"/>';
const PHASE_COLORS = ['#1f5fb8', '#1d7044', '#c25e00', '#7a3fb0', '#0f7b8a', '#b42318', '#8a5a00', '#5f5a51'];
export const KPI_NOTE = 'These numbers show what was recorded, not how good anyone is. Read them with context: weather, deliveries, other trades, the mix of tasks and changes to the plan all move them.';

const newId = () => globalThis.crypto?.randomUUID?.() || `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const isPhone = () => globalThis.matchMedia?.('(max-width: 760px)').matches;
const sum = (list, f) => list.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const r2 = (v) => Math.round(v * 100) / 100;
/** Set a CSS custom property (Object.assign on style can't). */
const cssVar = (el, name, value) => { el.style.setProperty(name, value); return el; };

export default {
  id: 'workplan',
  title: 'Work plans',
  icon: ICON_PLAN,
  group: 'work',
  perm: 'workplan',
  render(root, ctx) {
    const [sub, sub2] = ctx.params;
    if (sub === 'kpis') return renderKpiPage(root, ctx);
    if (sub && sub !== 'new') {
      const plan = ctx.store.get('workPlans', sub);
      if (!plan) { root.append(ctx.ui.page({ title: 'Work plan' }, ctx.ui.empty({ icon: ICON_PLAN, title: 'Plan not found', text: 'It may have been removed, or it has not synced to this device yet.', action: ctx.ui.button('All plans', { href: '#/workplan' }) }))); return undefined; }
      if (sub2 === 'meeting') return renderMeeting(root, ctx, plan);
      return renderPlan(root, ctx, plan);
    }
    const cleanup = renderList(root, ctx);
    if (sub === 'new') newPlanSheet(ctx);
    return cleanup;
  },
};

// ---------- helpers shared by the screens ----------

const people = (store) => store.list('employees', (e) => e.active !== false).sort((a, b) => a.name.localeCompare(b.name));
const jobLabel = (j) => (j ? `${j.number} · ${j.title}` : 'No job');
const phaseColor = (plan, phaseId) => {
  const i = (plan?.phases || []).findIndex((p) => p.id === phaseId);
  return i < 0 ? 'var(--border-input)' : PHASE_COLORS[i % PHASE_COLORS.length];
};
const me = (auth) => auth.current().id || null;
const today = (ui) => ui.today();

/** Plan crew first, then anyone else with tasks on the plan. */
function planPeople(store, plan, tasks) {
  const ids = [...new Set([...(plan.crewIds || []), ...tasks.map((t) => t.employeeId).filter(Boolean)])];
  return ids.map((id) => store.get('employees', id) || { id, name: 'Former employee', color: '#5f5a51' });
}

function planTitle(store, plan) {
  const job = store.get('jobs', plan.jobId);
  return plan.name || job?.title || 'Work plan';
}

/** Apply W.publishDay for one day: tasks go out, the day is marked published. */
function publishDayNow(ctx, plan, date) {
  const { store, ui, auth } = ctx;
  const tasks = store.list('workTasks', (t) => t.planId === plan.id && t.date === date);
  const nowIso = new Date().toISOString();
  const r = W.publishDay(tasks, date, { now: nowIso, by: me(auth), today: today(ui) });
  if (r.error) { ui.toast(r.error, 'error', 4000); return false; }
  for (const { id, patch } of r.patches) store.update('workTasks', id, patch, { silent: true });
  const cur = store.get('workPlans', plan.id);
  store.update('workPlans', plan.id, { published: { ...(cur.published || {}), [date]: { at: nowIso, by: me(auth) } } }, { summary: `published ${date}` });
  const who = new Set(r.patches.map((p) => tasks.find((t) => t.id === p.id)?.employeeId)).size;
  store.log('publish', `Published ${date} of ${planTitle(store, plan)}: ${r.patches.length} tasks to ${who} people`, 'workPlans', plan.id);
  const skipped = r.skipped.length ? ` ${r.skipped.length} unassigned task${r.skipped.length === 1 ? '' : 's'} stayed in draft.` : '';
  ui.toast(`Published ${ui.fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${r.patches.length} task${r.patches.length === 1 ? '' : 's'} to ${who} ${who === 1 ? 'person' : 'people'}. They see it on their next sync.${skipped}`, r.skipped.length ? 'info' : 'success', 4500);
  return true;
}

/** Move a task to another day and/or person (drag, "Move…", meeting). Returns true when it moved. */
function moveTo(ctx, plan, task, date, employeeId) {
  const { store, ui, auth } = ctx;
  let t = store.get('workTasks', task.id) || task;
  const nowIso = new Date().toISOString();
  const by = me(auth);
  if (t.date === date && (t.employeeId || null) === (employeeId || null)) return false;
  if (!employeeId && W.isPublished(t)) { ui.toast('A published task needs someone. Remove it instead.', 'error', 3500); return false; }
  let patch = {};
  if (t.date !== date) {
    const m = W.moveTask(t, date, plan, { now: nowIso, by });
    if (m.error) { ui.toast(m.error, 'error', 3500); return false; }
    patch = m.patch;
  }
  if ((t.employeeId || null) !== (employeeId || null)) {
    const r = W.reassign({ ...t, ...patch }, employeeId || null, { newId: newId(), now: nowIso, by });
    if (r.error) { ui.toast(r.error, 'error', 4000); return false; }
    if (r.replace) {
      store.remove('workTasks', r.replace.removeId, { silent: true });
      t = store.add('workTasks', r.replace.add, { silent: true });
      store.log('update', `moved "${t.title}" to ${store.get('employees', employeeId)?.name || 'someone else'}`, 'workTasks', t.id);
      warnCapacity(ctx, plan, t.date, t.employeeId);
      return true;
    }
    Object.assign(patch, r.patch);
  }
  store.update('workTasks', t.id, patch, { summary: `moved "${t.title}"` });
  warnCapacity(ctx, plan, date, employeeId);
  return true;
}

function warnCapacity(ctx, plan, date, employeeId) {
  if (!employeeId || !date) return;
  const { store, ui } = ctx;
  const cap = Number(plan?.dayHours) || W.DEFAULT_DAY_HOURS;
  const w = W.capacityWarnings(store.list('workTasks', (t) => t.employeeId === employeeId && t.date === date), () => cap)[0];
  if (w) ui.toast(`${store.get('employees', employeeId)?.name || 'They'} now has ${w.hours} h on ${ui.fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${w.overBy} h over a ${cap} h day.`, 'info', 4000);
}

/** "Move…": the accessible, non-drag way to change a task's day or person. */
function moveSheet(ctx, plan, task, onDone) {
  const { store, ui } = ctx;
  const days = W.planDays(plan);
  if (task.date && !days.includes(task.date)) days.unshift(task.date);
  const crew = planPeople(store, plan, store.list('workTasks', (t) => t.planId === plan.id));
  ui.formSheet({
    title: `Move: ${task.title}`,
    submitLabel: 'Move',
    fields: [
      { label: 'Day', name: 'date', type: 'select', value: task.date, options: days.map((d) => ({ value: d, label: `${ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}${W.isDayPublished(plan, d) ? ' · published' : ''}` })) },
      { label: 'Person', name: 'employeeId', type: 'select', value: task.employeeId || '', options: [{ value: '', label: 'Not assigned' }, ...crew.map((p) => ({ value: p.id, label: p.name }))] },
    ],
    onSubmit(v) {
      if (moveTo(ctx, plan, task, v.date, v.employeeId || null)) { ui.toast('Task moved', 'success'); onDone?.(); }
    },
  });
}

/** The value of the "Link" select for a task's link. */
const linkValue = (l) => (!l?.kind ? '' : l.kind === 'url' ? 'url' : `${l.kind}:${l.id}`);

/** Add or edit a task on a plan. `preset` fills a new one (date, employeeId, phaseId). */
function taskSheet(ctx, plan, task = null, preset = {}) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const days = W.planDays(plan);
  const all = store.list('workTasks', (t) => t.planId === plan.id);
  const crew = planPeople(store, plan, all);
  const drawings = store.list('drawings', (d) => !plan.jobId || d.jobId === plan.jobId, { omit: ['underlay', 'strokes', 'objects', 'texts', 'rooms', 'thumb'] });
  const runs = store.list('wireRuns', (r) => !plan.jobId || r.jobId === plan.jobId, { omit: ['photos', 'segments'] });
  const templates = store.list('taskTemplates').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const depOptions = [];
  const seenGroups = new Set();
  for (const t of W.sortTasks(all)) {
    if (task && (t.id === task.id || (task.groupId && t.groupId === task.groupId))) continue;
    const key = t.groupId || t.id;
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    depOptions.push({ value: key, label: `${t.date ? ui.fmtDate(t.date, { month: 'short', day: 'numeric' }) : ''} · ${t.title}${t.groupId ? ' (all crew)' : ` (${store.get('employees', t.employeeId)?.name || 'unassigned'})`}` });
  }
  const d = task || W.newTask({ planId: plan.id, jobId: plan.jobId, date: preset.date || days.find((x) => x >= today(ui)) || days[0], employeeId: preset.employeeId || null, phaseId: preset.phaseId || plan.phases?.[0]?.id || null });
  const assignees = new Set(task ? [] : (preset.employeeId ? [preset.employeeId] : []));
  const pick = task ? null : h('div', { class: 'field span-2' }, h('span', null, 'Who (one task each)'),
    h('div', { class: 'ops-crew-pick' }, crew.map((p) => h('label', { class: 'ops-chip-check' },
      h('input', { type: 'checkbox', checked: assignees.has(p.id), onChange: (e) => (e.target.checked ? assignees.add(p.id) : assignees.delete(p.id)) }),
      h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)), p.name))));

  // Progress, photos and the foreman's actions on an existing task.
  const nowIso = () => new Date().toISOString();
  const info = task ? h('div', { class: 'stack wp-taskinfo' },
    h('div', { class: 'row' }, ui.statusBadge(task.status), task.lateAdd ? ui.badge('added after publishing', 'accent') : null,
      task.ackAt ? ui.badge(`got it ${ui.fmtTime(task.ackAt)}`, 'success') : null,
      task.completedAt ? h('span', { class: 'muted wp-small' }, `done ${ui.fmtDateTime(task.completedAt)}${task.actualHours != null ? ` · ${task.actualHours} h` : ''}${task.qtyDone != null ? ` · ${task.qtyDone} ${task.unit || ''}` : ''}`) : null),
    (task.blocks || []).length ? h('ul', { class: 'wp-blocklist' }, task.blocks.map((b) => h('li', null, `${ui.fmtDateTime(b.at)}: ${b.reason}${b.note ? ` (${b.note})` : ''}${b.resolvedAt ? ` · resolved ${ui.fmtTime(b.resolvedAt)}` : ' · still blocked'}`))) : null,
    task.note ? h('p', { class: 'wp-note' }, h('strong', null, 'Worker note: '), task.note) : null,
    (task.photos || []).length ? photoStrip(ui, task.photos) : null,
    task.evidenceWaived ? h('div', { class: 'muted wp-small' }, `Photo waived: ${task.evidenceWaived.reason || 'no reason given'}`) : null,
    h('div', { class: 'row' },
      task.status === 'draft' && task.employeeId ? ui.button('Publish this task now', { size: 'sm', icon: 'send', onClick: () => {
        store.update('workTasks', task.id, { status: 'todo', publishedAt: nowIso(), publishedBy: me(auth), baselineDate: task.baselineDate || task.date, lateAdd: true });
        ui.toast('Sent to their list', 'success'); sheet.close();
      } }) : null,
      ui.button('Move…', { size: 'sm', icon: ICON_MOVE, onClick: () => { sheet.close(); moveSheet(ctx, plan, task); } }),
      task.status === 'done' ? ui.button('Reopen (rework)', { size: 'sm', icon: 'undo', onClick: async () => {
        const why = await ui.promptDialog('What needs redoing?', { title: 'Reopen task', okLabel: 'Reopen' });
        if (why == null) return;
        store.update('workTasks', task.id, W.reopenTask(store.get('workTasks', task.id), why, { now: nowIso(), by: me(auth) }), { summary: `reopened ${task.title}` });
        ui.toast('Reopened. It is back on their list.', 'success'); sheet.close();
      } }) : null,
      task.requiresPhoto && !task.evidenceWaived && W.evidenceProblem(task) ? ui.button('Waive the photo', { size: 'sm', variant: 'ghost', icon: ICON_CAMERA, onClick: async () => {
        const why = await ui.promptDialog('Why is no photo needed this time? (kept with the task and counted in the KPIs)', { title: 'Waive photo evidence', okLabel: 'Waive' });
        if (!why) return;
        store.update('workTasks', task.id, { evidenceWaived: { by: me(auth), at: nowIso(), reason: why.slice(0, 500) } }, { summary: `waived photo for ${task.title}` });
        ui.toast('Photo waived for this task', 'success'); sheet.close();
      } }) : null)) : null;

  const linkOptions = [{ value: '', label: 'No link' },
    ...drawings.map((x) => ({ value: `drawing:${x.id}`, label: `Drawing: ${x.name || 'Untitled'}` })),
    ...runs.map((x) => ({ value: `wireRun:${x.id}`, label: `Wire run: ${x.name || 'Untitled'}` })),
    { value: 'url', label: 'Web link (below)' }];
  const sheet = ui.formSheet({
    title: task ? 'Edit task' : 'Add task',
    submitLabel: task ? 'Save' : 'Add task',
    wide: true,
    fields: [
      !task && templates.length ? { label: 'From a template', name: 'templateId', type: 'select', value: '', span: true, options: [{ value: '', label: '— none —' }, ...templates.map((t) => ({ value: t.id, label: t.name || t.title }))] } : null,
      { label: 'Task', name: 'title', value: d.title, required: !templates.length || Boolean(task), span: true, placeholder: 'e.g. Mount device boxes, level 2 east' },
      { label: 'Phase / area', name: 'phaseId', type: 'select', value: d.phaseId || '', options: [{ value: '', label: 'No phase' }, ...(plan.phases || []).map((p) => ({ value: p.id, label: p.name }))] },
      { label: 'Day', name: 'date', type: 'select', value: d.date, options: (days.includes(d.date) || !d.date ? days : [d.date, ...days]).map((x) => ({ value: x, label: `${ui.fmtDate(x, { weekday: 'short', month: 'short', day: 'numeric' })}${W.isDayPublished(plan, x) ? ' · published' : ''}` })) },
      task ? { label: 'Person', name: 'employeeId', type: 'select', value: d.employeeId || '', options: [{ value: '', label: 'Not assigned' }, ...crew.map((p) => ({ value: p.id, label: p.name }))] } : pick,
      { label: 'Estimated hours', name: 'estHours', type: 'number', step: '0.25', min: '0', max: '24', value: d.estHours ?? '' },
      { label: 'Quantity', name: 'qty', type: 'number', step: 'any', min: '0', value: d.qty ?? '' },
      { label: 'Unit', name: 'unit', value: d.unit || '', placeholder: 'boxes, m, runs' },
      { label: 'Task type (for KPIs)', name: 'taskType', value: d.taskType || '', placeholder: 'Boxes, Home runs, Terminations' },
      { label: 'Priority', name: 'priority', type: 'select', value: d.priority || 'normal', options: W.PRIORITIES.map((p) => ({ value: p, label: p })) },
      { label: 'Waits on (optional)', name: 'dependsOn', type: 'select', value: d.dependsOn?.[0] || '', options: [{ value: '', label: 'Nothing' }, ...depOptions] },
      { label: 'Needs photo evidence to finish', name: 'requiresPhoto', type: 'checkbox', value: d.requiresPhoto },
      { label: 'Photos needed', name: 'minPhotos', type: 'number', min: '1', max: String(W.MAX_PHOTOS), step: '1', value: d.minPhotos || 1 },
      { label: 'Link to a drawing, wire run or page', name: 'link', type: 'select', value: linkValue(d.link), options: linkOptions },
      { label: 'Web link', name: 'linkUrl', type: 'url', value: d.link?.kind === 'url' ? d.link.url : '', placeholder: 'https://' },
      { label: 'Details for the crew', name: 'description', type: 'textarea', rows: 3, value: d.description || '', span: true },
      !task ? { label: 'Save as a template too', name: 'saveTemplate', type: 'checkbox', value: false, span: true } : null,
    ].filter(Boolean),
    extra: info,
    danger: task ? { label: 'Remove task', onClick: () => { store.remove('workTasks', task.id); ui.toast('Task removed', 'success'); } } : null,
    onSubmit(v) {
      const tpl = v.templateId ? store.get('taskTemplates', v.templateId) : null;
      const title = String(v.title || tpl?.title || tpl?.name || '').trim();
      if (!title) { ui.toast('Give the task a name', 'error'); return false; }
      if (v.link === 'url' && !/^https?:\/\/\S+$/.test(v.linkUrl || '')) { ui.toast('Web links start with https://', 'error'); return false; }
      const [kind, id] = (v.link || '').split(':');
      const link = !v.link ? null : kind === 'url' ? { kind: 'url', id: null, label: 'Open link', url: v.linkUrl } : { kind, id, label: (kind === 'drawing' ? drawings : runs).find((x) => x.id === id)?.name || null, url: '' };
      const phase = (plan.phases || []).find((p) => p.id === v.phaseId);
      const fields = {
        title, phaseId: phase?.id || null, phaseName: phase?.name || '', estHours: Number(v.estHours ?? tpl?.estHours) || 0,
        qty: v.qty == null ? (tpl?.qty ?? null) : Number(v.qty), unit: v.unit || tpl?.unit || '', taskType: v.taskType || tpl?.taskType || '', priority: v.priority || 'normal',
        dependsOn: v.dependsOn ? [v.dependsOn] : [], requiresPhoto: Boolean(v.requiresPhoto || tpl?.requiresPhoto), minPhotos: Math.min(W.MAX_PHOTOS, Math.max(1, Number(v.minPhotos) || 1)),
        link, description: v.description || tpl?.description || '',
      };
      if (task) {
        store.update('workTasks', task.id, fields, { summary: `edited ${title}` });
        const cur = store.get('workTasks', task.id);
        if (cur.date !== v.date || (cur.employeeId || null) !== (v.employeeId || null)) moveTo(ctx, plan, cur, v.date, v.employeeId || null);
        ui.toast('Task saved', 'success');
        return undefined;
      }
      const who = assignees.size ? [...assignees] : [null];
      const groupId = who.length > 1 ? newId() : null;
      const nowIso2 = new Date().toISOString();
      const base = store.count('workTasks', (t) => t.planId === plan.id && t.date === v.date);
      who.forEach((employeeId, i) => {
        store.add('workTasks', W.newTask({ ...(tpl ? W.fromTemplate(tpl) : {}), ...fields, planId: plan.id, jobId: plan.jobId, groupId, date: v.date, employeeId, order: base + i + 1, templateId: tpl?.id || null, createdBy: me(auth),
          ...(employeeId ? W.placement(plan, v.date, { now: nowIso2, by: me(auth) }) : { status: 'draft' }) }));
      });
      if (v.saveTemplate) store.add('taskTemplates', { name: title, title, description: fields.description, phaseName: fields.phaseName, taskType: fields.taskType, unit: fields.unit, qty: fields.qty, estHours: fields.estHours, requiresPhoto: fields.requiresPhoto, minPhotos: fields.minPhotos, priority: fields.priority, uses: 0 });
      const published = W.isDayPublished(plan, v.date) && who[0];
      ui.toast(`${who.length === 1 ? 'Task' : `${who.length} tasks`} added${published ? ' and sent (the day is published)' : ' as draft'}`, 'success');
      for (const e of who) warnCapacity(ctx, plan, v.date, e);
      return undefined;
    },
  });
  return sheet;
}

/** "Spread across days": one quantity over days x people (400 boxes over 10 days by 4). */
function spreadSheet(ctx, plan, preset = {}) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const days = W.planDays(plan);
  const startIdx = Math.max(0, days.findIndex((d) => d >= (preset.date || today(ui))));
  const crew = planPeople(store, plan, store.list('workTasks', (t) => t.planId === plan.id));
  const chosen = new Set(plan.crewIds?.length ? plan.crewIds : crew.map((p) => p.id));
  const templates = store.list('taskTemplates').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const preview = h('div', { class: 'wp-preview-line', role: 'status' });
  let form = null;
  const read = () => (form ? ui.readForm(form) : {});
  const calc = () => {
    const v = read();
    const i = days.indexOf(v.from);
    const span = days.slice(i < 0 ? 0 : i, (i < 0 ? 0 : i) + Math.max(1, Number(v.days) || 1));
    const tasks = W.spreadTask({ days: span, workers: [...chosen], totalQty: v.totalQty, totalHours: Number(v.totalHours) || 0, ratePerHour: Number(v.ratePerHour) || 0, integer: v.integer !== false });
    return { v, span, tasks };
  };
  const paint = () => {
    const { v, span, tasks } = calc();
    if (!tasks.length) { ui.clear(preview).append('Enter a quantity or hours, the days and who.'); return; }
    const q = tasks.map((t) => t.qty).filter((x) => x != null);
    const hrs = tasks.map((t) => t.estHours);
    const range = (a) => (Math.min(...a) === Math.max(...a) ? `${Math.min(...a)}` : `${Math.min(...a)}–${Math.max(...a)}`);
    const over = W.capacityWarnings([...store.list('workTasks', (t) => span.includes(t.date) && chosen.has(t.employeeId)), ...tasks], () => Number(plan.dayHours) || W.DEFAULT_DAY_HOURS);
    h(ui.clear(preview), null,
      h('strong', null, `${tasks.length} task${tasks.length === 1 ? '' : 's'}`),
      ` over ${span.length} day${span.length === 1 ? '' : 's'} (${ui.fmtDate(span[0], { month: 'short', day: 'numeric' })} – ${ui.fmtDate(span.at(-1), { month: 'short', day: 'numeric' })}) for ${chosen.size || 1} ${chosen.size === 1 ? 'person' : 'people'}: `,
      q.length ? `${range(q)} ${v.unit || ''} and ` : '', `${range(hrs)} h each.`,
      over.length ? h('div', { class: 'wp-warn' }, `Over capacity on ${over.length} person-day${over.length === 1 ? '' : 's'} (planned hours above a ${plan.dayHours || 8} h day).`) : null);
  };
  const pick = h('div', { class: 'field span-2' }, h('span', null, 'Who'),
    h('div', { class: 'ops-crew-pick' }, crew.map((p) => h('label', { class: 'ops-chip-check' },
      h('input', { type: 'checkbox', checked: chosen.has(p.id), onChange: (e) => { if (e.target.checked) chosen.add(p.id); else chosen.delete(p.id); paint(); } }),
      h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)), p.name))));
  const sheet = ui.formSheet({
    title: 'Spread a task across days',
    submitLabel: 'Create tasks',
    wide: true,
    fields: [
      templates.length ? { label: 'From a template', name: 'templateId', type: 'select', value: '', span: true, options: [{ value: '', label: '— none —' }, ...templates.map((t) => ({ value: t.id, label: t.name || t.title }))] } : null,
      { label: 'Task', name: 'title', value: preset.title || '', span: true, placeholder: 'e.g. Mount device boxes' },
      { label: 'Phase / area', name: 'phaseId', type: 'select', value: preset.phaseId || plan.phases?.[0]?.id || '', options: [{ value: '', label: 'No phase' }, ...(plan.phases || []).map((p) => ({ value: p.id, label: p.name }))] },
      { label: 'Task type (for KPIs)', name: 'taskType', value: '', placeholder: 'Boxes' },
      { label: 'Total quantity', name: 'totalQty', type: 'number', min: '0', step: 'any', value: 400 },
      { label: 'Unit', name: 'unit', value: 'boxes' },
      { label: 'Rate (quantity per hour)', name: 'ratePerHour', type: 'number', min: '0', step: 'any', value: 8, hint: 'Sets each task\'s hours. Leave empty to split total hours instead.' },
      { label: 'Total hours (if no rate)', name: 'totalHours', type: 'number', min: '0', step: '0.25', value: '' },
      { label: 'Starting', name: 'from', type: 'select', value: days[startIdx], options: days.map((d) => ({ value: d, label: ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' }) })) },
      { label: 'Working days', name: 'days', type: 'number', min: '1', max: String(days.length || 1), step: '1', value: Math.min(10, days.length - startIdx) || 1 },
      pick,
      { label: 'Whole numbers only', name: 'integer', type: 'checkbox', value: true },
      { label: 'Needs photo evidence to finish', name: 'requiresPhoto', type: 'checkbox', value: false },
      { label: 'Details for the crew', name: 'description', type: 'textarea', rows: 2, value: '', span: true },
    ].filter(Boolean),
    extra: preview,
    onSubmit() {
      const { v, tasks } = calc();
      const tpl = v.templateId ? store.get('taskTemplates', v.templateId) : null;
      const title = String(v.title || tpl?.title || tpl?.name || '').trim();
      if (!title) { ui.toast('Give the task a name', 'error'); return false; }
      if (!tasks.length) { ui.toast('Nothing to spread: enter a quantity or hours', 'error'); return false; }
      const phase = (plan.phases || []).find((p) => p.id === v.phaseId);
      const groupId = newId();
      const nowIso = new Date().toISOString();
      const order = new Map();
      for (const t of tasks) {
        const k = `${t.date}|${t.employeeId}`;
        if (!order.has(k)) order.set(k, store.count('workTasks', (x) => x.date === t.date && x.employeeId === t.employeeId) + 1);
        store.add('workTasks', {
          ...(tpl ? W.fromTemplate(tpl) : {}), ...t, title, planId: plan.id, jobId: plan.jobId, groupId, phaseId: phase?.id || null, phaseName: phase?.name || '',
          taskType: v.taskType || tpl?.taskType || '', unit: v.unit || tpl?.unit || '', requiresPhoto: Boolean(v.requiresPhoto || tpl?.requiresPhoto), minPhotos: tpl?.minPhotos || 1,
          description: v.description || tpl?.description || '', order: order.get(k), templateId: tpl?.id || null, createdBy: me(auth),
          ...(t.employeeId ? W.placement(plan, t.date, { now: nowIso, by: me(auth) }) : { status: 'draft' }),
        }, { silent: true });
      }
      store.log('create', `Spread "${title}" into ${tasks.length} tasks`, 'workTasks');
      ui.toast(`Created ${tasks.length} tasks`, 'success');
      return undefined;
    },
  });
  form = sheet.body.querySelector('form');
  form.addEventListener('input', paint);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'templateId' && e.target.value) {
      const tpl = store.get('taskTemplates', e.target.value);
      for (const [k, val] of [['title', tpl?.title || tpl?.name], ['unit', tpl?.unit], ['taskType', tpl?.taskType], ['ratePerHour', tpl?.ratePerHour]]) {
        const el = form.querySelector(`[name="${k}"]`);
        if (el && val != null && val !== '') el.value = val;
      }
      const ph = form.querySelector('[name="requiresPhoto"]');
      if (ph) ph.checked = Boolean(tpl?.requiresPhoto);
    }
    paint();
  });
  paint();
  return sheet;
}

/** Copy one day's tasks to another day as drafts. */
function copyDaySheet(ctx, plan, from) {
  const { store, ui } = ctx;
  const days = W.planDays(plan).filter((d) => d !== from);
  ui.formSheet({
    title: `Copy ${ui.fmtDate(from, { weekday: 'short', month: 'short', day: 'numeric' })}`,
    submitLabel: 'Copy',
    fields: [
      { label: 'To', name: 'to', type: 'select', value: days.find((d) => d > from) || days[0], options: days.map((d) => ({ value: d, label: `${ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}${W.isDayPublished(plan, d) ? ' · published' : ''}` })) },
      { label: 'Keep the same people', name: 'keep', type: 'checkbox', value: true },
    ],
    onSubmit(v) {
      const src = store.list('workTasks', (t) => t.planId === plan.id && t.date === from);
      const copies = W.copyDay(src, from, v.to, { keepAssignees: v.keep });
      const nowIso = new Date().toISOString();
      for (const c of copies) store.add('workTasks', { ...c, ...(c.employeeId ? W.placement(plan, v.to, { now: nowIso, by: me(ctx.auth) }) : { status: 'draft' }) }, { silent: true });
      store.log('create', `Copied ${copies.length} tasks from ${from} to ${v.to}`, 'workTasks');
      ui.toast(`Copied ${copies.length} task${copies.length === 1 ? '' : 's'}`, 'success');
    },
  });
}

/** Publish: the days that have drafts, tomorrow first. */
function publishSheet(ctx, plan) {
  const { store, ui } = ctx;
  const { h } = ui;
  const t0 = today(ui);
  const tasks = store.list('workTasks', (t) => t.planId === plan.id);
  const days = [...new Set(tasks.filter((t) => t.status === 'draft' && t.date >= t0).map((t) => t.date))].sort().slice(0, 10);
  const cap = Number(plan.dayHours) || W.DEFAULT_DAY_HOURS;
  const s = ui.openSheet({
    title: 'Publish lists',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted', style: { margin: 0 } }, 'Publishing sends each person their tasks for that day. Publish tomorrow\'s list the day before, or today\'s in the morning. Tasks added to a published day go out straight away.'),
      days.length ? h('div', { class: 'list' }, days.map((d) => {
        const dayTasks = tasks.filter((t) => t.date === d);
        const drafts = dayTasks.filter((t) => t.status === 'draft');
        const unassigned = drafts.filter((t) => !t.employeeId).length;
        const over = W.capacityWarnings(dayTasks, () => cap).length;
        return h('div', { class: 'list-row' },
          h('div', { class: 'grow' },
            h('div', { class: 'title' }, `${d === t0 ? 'Today' : d === W.nextWorkDay(t0, { skipWeekends: plan.skipWeekends !== false, holidays: plan.holidays || [] }) ? 'Tomorrow' : ui.fmtDate(d, { weekday: 'long' })} · ${ui.fmtDate(d, { month: 'short', day: 'numeric' })}`),
            h('div', { class: 'meta' }, `${drafts.length - unassigned} to send · ${new Set(drafts.map((t) => t.employeeId).filter(Boolean)).size} people`, unassigned ? ` · ${unassigned} not assigned (stay draft)` : '', over ? ` · ${over} over capacity` : '')),
          ui.button('Publish', { variant: 'primary', icon: 'send', onClick: () => { if (publishDayNow(ctx, plan, d)) s.close(); } }));
      })) : ui.empty({ icon: 'check', title: 'Nothing waiting', text: 'Every upcoming day with tasks is published.' })),
    actions: [ui.button('Close', { variant: 'ghost', onClick: () => s.close() })],
  });
}

// ---------- plan list ----------

function renderList(root, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const host = h('div');
  const draw = () => {
    const plans = store.list('workPlans', (p) => p.status !== 'archived').sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    const t0 = today(ui);
    const allTasks = store.list('workTasks', null, { omit: ['photos'] });
    const cards = plans.map((p) => {
      const tasks = allTasks.filter((t) => t.planId === p.id);
      const job = store.get('jobs', p.jobId);
      const prog = K.jobProgress(p, tasks, { today: t0 });
      const blocked = tasks.filter((t) => t.status === 'blocked').length;
      const days = W.planDays(p);
      const pubDays = Object.keys(p.published || {}).length;
      return h('a', { class: 'card click wp-plan-card', href: `#/workplan/${p.id}` },
        h('div', { class: 'row' }, h('strong', { class: 'grow' }, planTitle(store, p)), blocked ? ui.badge(`${blocked} blocked`, 'danger') : null, ui.statusBadge(p.status === 'active' ? 'active' : p.status)),
        h('div', { class: 'muted wp-small' }, [job ? job.number : null, `${ui.fmtDate(p.startDate, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(p.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}`, `${days.length} working days`].filter(Boolean).join(' · ')),
        h('div', { class: 'wp-bar big', role: 'progressbar', 'aria-valuenow': prog.pct ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Complete' }, h('span', { style: { width: `${prog.pct || 0}%` } })),
        h('div', { class: 'row wp-small' }, h('span', { class: 'grow' }, `${prog.pct ?? 0}% complete · ${prog.done}/${prog.taskCount} tasks`), h('span', { class: 'muted' }, `${pubDays} day${pubDays === 1 ? '' : 's'} published`)),
        prog.forecastFinish && p.endDate && prog.forecastFinish > p.endDate ? h('div', { class: 'wp-warn wp-small' }, `At this pace: done ${ui.fmtDate(prog.forecastFinish, { month: 'short', day: 'numeric' })} (${prog.lateBy} working day${prog.lateBy === 1 ? '' : 's'} after plan)`) : null);
    });
    ui.clear(host).append(ui.page({
      title: 'Work plans',
      subtitle: 'Break a job into days, give each person their list, see how it is going',
      actions: [
        auth.can('kpis') ? ui.button('KPIs', { icon: 'activity', href: '#/workplan/kpis' }) : null,
        ui.button('My day', { icon: ICON_TODAY, href: '#/today' }),
        ui.button('New plan', { variant: 'primary', icon: 'plus', onClick: () => newPlanSheet(ctx) }),
      ].filter(Boolean),
    }, plans.length ? h('div', { class: 'grid' }, cards)
      : ui.empty({ icon: ICON_PLAN, title: 'No work plans yet', text: 'Pick a job, set its working days, split the work into tasks and publish each day\'s list to the crew.', action: ui.button('New plan', { variant: 'primary', icon: 'plus', onClick: () => newPlanSheet(ctx) }) })));
  };
  root.append(host);
  draw();
  let pending = null;
  const later = () => { clearTimeout(pending); pending = setTimeout(draw, 60); };
  const offs = ['workPlans', 'workTasks', 'jobs'].map((c) => store.on(c, later));
  return () => { clearTimeout(pending); offs.forEach((f) => f()); };
}

function newPlanSheet(ctx) {
  const { store, ui, nav } = ctx;
  const { h } = ui;
  const jobs = store.list('jobs', (j) => !['complete', 'invoiced'].includes(j.status)).sort((a, b) => String(a.number).localeCompare(String(b.number)));
  if (!jobs.length) { ui.toast('Create the job first, then plan it', 'error'); return; }
  const crewAll = people(store);
  const firstJob = jobs.find((j) => j.id === ctx.query.jobId) || jobs[0];
  const crew = new Set(firstJob.crewIds || []);
  const province = store.settings().company?.province || 'ON';
  const startDefault = (() => { let d = today(ui); while (W.isWeekend(d)) d = W.addDays(d, 1); return d; })();
  const pick = h('div', { class: 'field span-2' }, h('span', null, 'Crew'),
    h('div', { class: 'ops-crew-pick' }, crewAll.map((p) => h('label', { class: 'ops-chip-check' },
      h('input', { type: 'checkbox', checked: crew.has(p.id), dataset: { crew: p.id }, onChange: (e) => (e.target.checked ? crew.add(p.id) : crew.delete(p.id)) }),
      h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)), p.name))));
  const endHint = h('div', { class: 'wp-preview-line', role: 'status' });
  const sheet = ui.formSheet({
    title: 'New work plan',
    submitLabel: 'Create plan',
    wide: true,
    fields: [
      { label: 'Job', name: 'jobId', type: 'select', value: firstJob.id, required: true, span: true, options: jobs.map((j) => ({ value: j.id, label: jobLabel(j) })) },
      { label: 'Plan name', name: 'name', value: '', placeholder: 'e.g. Main build', span: true },
      { label: 'First day', name: 'startDate', type: 'date', value: startDefault, required: true },
      { label: 'Working days', name: 'workingDays', type: 'number', min: '1', max: '400', step: '1', value: 35, hint: 'Or set a last day instead' },
      { label: 'Last day (optional)', name: 'endDate', type: 'date', value: '' },
      { label: 'Hours in a working day', name: 'dayHours', type: 'number', min: '1', max: '24', step: '0.5', value: 8 },
      { label: 'Skip weekends', name: 'skipWeekends', type: 'checkbox', value: true },
      { label: `Skip statutory holidays (${province})`, name: 'skipHolidays', type: 'checkbox', value: true },
      pick,
      { label: 'Phases or areas, one per line', name: 'phases', type: 'textarea', rows: 5, value: W.DEFAULT_PHASES.join('\n'), span: true },
    ],
    extra: endHint,
    onSubmit(v) {
      const opts = planOpts(v, province);
      if (!opts) { ui.toast('Set a first day and the number of working days (or a last day)', 'error'); return false; }
      const job = store.get('jobs', v.jobId);
      const phases = String(v.phases || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 100);
      const plan = W.newPlan({ ...opts, jobId: v.jobId, name: v.name || job?.title || 'Work plan', dayHours: Number(v.dayHours) || 8, crewIds: [...crew], phases: phases.length ? phases : W.DEFAULT_PHASES, newId: () => newId() });
      const saved = store.add('workPlans', { ...plan, province });
      ui.toast(`Plan created: ${W.planDays(saved).length} working days`, 'success');
      nav(`#/workplan/${saved.id}`);
    },
  });
  const form = sheet.body.querySelector('form');
  const paint = () => {
    const v = ui.readForm(form);
    const opts = planOpts(v, province);
    ui.clear(endHint);
    if (!opts) return;
    const days = W.workDays(opts);
    const off = opts.holidays.filter((d) => d >= opts.startDate && d <= opts.endDate);
    endHint.append(`${days.length} working days: ${ui.fmtDate(opts.startDate, { weekday: 'short', month: 'short', day: 'numeric' })} to ${ui.fmtDate(opts.endDate, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}`,
      off.length ? `, skipping ${off.map((d) => ui.fmtDate(d, { month: 'short', day: 'numeric' })).join(', ')}` : '', '.');
  };
  form.addEventListener('input', paint);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'jobId') {
      const j = store.get('jobs', e.target.value);
      crew.clear();
      for (const id of j?.crewIds || []) crew.add(id);
      for (const box of form.querySelectorAll('[data-crew]')) box.checked = crew.has(box.dataset.crew);
    }
    paint();
  });
  paint();
}

/** Dates and days off from the new-plan form, or null. */
function planOpts(v, province) {
  if (!W.isDay(v.startDate)) return null;
  const skipWeekends = v.skipWeekends !== false;
  const horizon = W.addDays(v.startDate, 800);
  const holidays = v.skipHolidays ? W.holidaysBetween(v.startDate, horizon, province).map((x) => x.date) : [];
  let endDate = W.isDay(v.endDate) && v.endDate >= v.startDate ? v.endDate : null;
  if (!endDate) {
    const n = Math.round(Number(v.workingDays) || 0);
    if (!(n >= 1)) return null;
    endDate = W.endAfterWorkDays(v.startDate, Math.min(n, 400), { skipWeekends, holidays });
  }
  return { startDate: v.startDate, endDate, skipWeekends, holidays: holidays.filter((d) => d <= endDate) };
}

// ---------- one plan ----------

function renderPlan(root, ctx, plan0) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  let tab = ['board', 'tasks', 'kpis', 'setup'].includes(ctx.query.tab) ? ctx.query.tab : 'board';
  if (tab === 'kpis' && !auth.can('kpis')) tab = 'board';
  let offset = null; // index of the first day shown on the board
  let phaseFilter = '';
  let listFilter = { who: '', status: '' };
  const host = h('div');
  let kpiCleanup = null;
  let justDragged = false;

  const draw = () => {
    const plan = store.get('workPlans', plan0.id);
    if (!plan) { ui.clear(host).append(ui.empty({ icon: ICON_PLAN, title: 'This plan was removed', action: ui.button('All plans', { href: '#/workplan' }) })); return; }
    kpiCleanup?.(); kpiCleanup = null;
    const job = store.get('jobs', plan.jobId);
    const days = W.planDays(plan);
    const tasks = store.list('workTasks', (t) => t.planId === plan.id, { omit: ['photos'] });
    const t0 = today(ui);
    const tomorrow = W.nextWorkDay(t0, { skipWeekends: plan.skipWeekends !== false, holidays: plan.holidays || [] });
    const draftsFor = (d) => tasks.filter((t) => t.date === d && t.status === 'draft' && t.employeeId).length;
    const nextPub = draftsFor(tomorrow) ? tomorrow : draftsFor(t0) ? t0 : null;
    const blocked = tasks.filter((t) => t.status === 'blocked');

    const head = ui.page({
      title: planTitle(store, plan),
      subtitle: [job ? jobLabel(job) : null, `${ui.fmtDate(plan.startDate, { month: 'short', day: 'numeric' })} – ${ui.fmtDate(plan.endDate, { month: 'short', day: 'numeric', year: 'numeric' })}`, `${days.length} working days`, `${(plan.crewIds || []).length} crew`].filter(Boolean).join(' · '),
      actions: [
        ui.button('Meeting', { icon: 'users', onClick: () => nav(`#/workplan/${plan.id}/meeting`) }),
        ui.button('Spread', { icon: ICON_SPREAD, onClick: () => spreadSheet(ctx, plan) }),
        ui.button('Add task', { icon: 'plus', onClick: () => taskSheet(ctx, plan) }),
        nextPub
          ? ui.button(`Publish ${nextPub === t0 ? 'today' : 'tomorrow'}`, { variant: 'primary', icon: 'send', onClick: () => publishDayNow(ctx, plan, nextPub) })
          : ui.button('Publish…', { variant: 'primary', icon: 'send', onClick: () => publishSheet(ctx, plan) }),
      ],
    },
    h('div', { class: 'row wp-tabsrow' },
      ui.tabs([{ id: 'board', label: 'Board' }, { id: 'tasks', label: 'Tasks' }, auth.can('kpis') ? { id: 'kpis', label: 'Progress & KPIs' } : null, { id: 'setup', label: 'Setup' }].filter(Boolean), tab, (id) => { tab = id; draw(); }),
      h('span', { class: 'grow' }),
      nextPub ? ui.button('Other days…', { size: 'sm', variant: 'ghost', onClick: () => publishSheet(ctx, plan) }) : null),
    blocked.length ? h('div', { class: 'wp-alert', role: 'status' }, ui.icon('alert', 16),
      h('span', null, `${blocked.length} task${blocked.length === 1 ? ' is' : 's are'} blocked: `,
        blocked.slice(0, 4).map((t, i) => [i ? '; ' : '', h('a', { href: '#', onClick: (e) => { e.preventDefault(); taskSheet(ctx, plan, store.get('workTasks', t.id)); } }, `${store.get('employees', t.employeeId)?.name || 'someone'}: ${t.title}`), ` (${(t.blocks || []).filter((b) => !b.resolvedAt).at(-1)?.reason || 'no reason'})`]),
        blocked.length > 4 ? ' …' : '')) : null,
    tab === 'board' ? board(plan, days, tasks) : null,
    tab === 'tasks' ? taskList(plan, days, tasks) : null,
    tab === 'setup' ? setup(plan) : null,
    tab === 'kpis' ? h('div', { class: 'wp-kpi-host' }) : null);
    // Keep the board's own scroll position across redraws (sync and edits redraw often).
    const prev = host.querySelector('.wp-board');
    const keep = prev ? { top: prev.scrollTop, left: prev.scrollLeft } : null;
    ui.clear(host).append(head);
    const next = host.querySelector('.wp-board');
    if (keep && next) { next.scrollTop = keep.top; next.scrollLeft = keep.left; }
    if (tab === 'kpis') kpiCleanup = renderKpis(host.querySelector('.wp-kpi-host'), ctx, { plan });
  };

  // ----- board: days x people -----
  function board(plan, days, tasks) {
    const t0 = today(ui);
    const n = isPhone() ? 1 : 5;
    if (offset == null) {
      const i = days.findIndex((d) => d >= t0);
      offset = Math.max(0, Math.min(i < 0 ? days.length - n : i, Math.max(0, days.length - n)));
    }
    offset = Math.max(0, Math.min(offset, Math.max(0, days.length - n)));
    const shown = days.slice(offset, offset + n);
    const crew = planPeople(store, plan, tasks);
    const cap = Number(plan.dayHours) || W.DEFAULT_DAY_HOURS;
    const everyone = store.list('workTasks', (t) => shown.includes(t.date), { omit: ['photos'] });
    const visible = tasks.filter((t) => !phaseFilter || t.phaseId === phaseFilter);
    const warnings = W.capacityWarnings(store.list('workTasks', (t) => days.includes(t.date) && crew.some((p) => p.id === t.employeeId), { omit: ['photos'] }), () => cap);

    const chip = (t) => {
      const need = W.photosNeeded(t);
      const el = h('button', {
        type: 'button', class: ['wp-chip', `is-${t.status}`], dataset: { task: t.id },
        title: `${t.title}${t.phaseName ? ` · ${t.phaseName}` : ''} (${t.status})`, 'aria-label': `${t.title}, ${t.status}. Open to edit or move.`,
        onClick: () => { if (justDragged) return; taskSheet(ctx, plan, store.get('workTasks', t.id)); },
      },
      h('span', { class: 'wp-chip-title' }, t.title),
      h('span', { class: 'wp-chip-meta' }, [t.qty != null ? `${t.qty} ${t.unit || ''}`.trim() : null, t.estHours ? `${t.estHours} h` : null].filter(Boolean).join(' · '),
        need ? ui.icon(ICON_CAMERA, 12) : null, t.lateAdd && !t.seenAt ? h('span', { class: 'wp-chip-new' }, 'new') : null));
      cssVar(el, '--ph', phaseColor(plan, t.phaseId));
      dragSource(el, t, plan);
      return el;
    };
    const cell = (d, p) => {
      const mine = W.sortTasks(visible.filter((t) => t.date === d && (t.employeeId || null) === (p?.id || null)));
      const load = p ? sum(everyone.filter((t) => t.employeeId === p.id && t.date === d), (t) => t.estHours) : 0;
      const over = p && load > cap + 1e-9;
      return h('div', {
        class: ['wp-cell', d === t0 ? 'today' : null, over ? 'over' : null], role: 'gridcell', dataset: { drop: '1', date: d, emp: p?.id || '' },
        'aria-label': `${p ? p.name : 'Not assigned'}, ${ui.fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })}: ${mine.length} task${mine.length === 1 ? '' : 's'}${p ? `, ${r2(load)} of ${cap} hours` : ''}`,
      },
      mine.map(chip),
      h('div', { class: 'wp-cell-foot' },
        h('button', { type: 'button', class: 'wp-cell-add', title: `Add a task${p ? ` for ${p.name}` : ''}`, 'aria-label': `Add a task${p ? ` for ${p.name}` : ''} on ${ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}`, onClick: () => taskSheet(ctx, plan, null, { date: d, employeeId: p?.id }) }, ui.icon('plus', 14)),
        p ? h('span', { class: ['wp-load', over ? 'over' : null] }, `${r2(load)}/${cap} h`) : null));
    };
    const dayHead = (d) => {
      const pub = W.isDayPublished(plan, d);
      const drafts = tasks.filter((t) => t.date === d && t.status === 'draft' && t.employeeId).length;
      return h('div', { class: ['wp-dayhead-cell', d === t0 ? 'today' : null], role: 'columnheader' },
        h('div', { class: 'row', style: { gap: '4px' } }, h('strong', null, ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })), h('span', { class: 'grow' }),
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'copy', title: `Copy ${ui.fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })} to another day`, onClick: () => copyDaySheet(ctx, plan, d) })),
        h('div', { class: 'row', style: { gap: '4px' } },
          pub ? ui.badge('published', 'success') : tasks.some((t) => t.date === d) ? ui.badge('draft', 'neutral') : h('span', { class: 'muted wp-small' }, 'nothing yet'),
          drafts && d >= t0 ? ui.button(pub ? `Send ${drafts}` : 'Publish', { size: 'sm', variant: pub ? 'secondary' : 'primary', onClick: () => publishDayNow(ctx, plan, d) }) : null));
    };

    const nav2 = h('div', { class: 'row wp-boardnav' },
      ui.button('', { icon: 'chevron-left', title: 'Earlier days', onClick: () => { offset = Math.max(0, offset - n); draw(); } }),
      ui.button('Today', { onClick: () => { offset = null; draw(); } }),
      ui.button('', { icon: 'chevron-right', title: 'Later days', onClick: () => { offset += n; draw(); } }),
      h('span', { class: 'muted wp-small' }, !shown.length ? 'No working days in this plan' : shown.length === 1 ? `Day ${offset + 1} of ${days.length}` : `Day ${offset + 1}–${offset + shown.length} of ${days.length}`),
      h('span', { class: 'grow' }),
      h('select', { class: 'input wp-select', 'aria-label': 'Phase', onChange: (e) => { phaseFilter = e.target.value; draw(); } },
        h('option', { value: '' }, 'All phases'), (plan.phases || []).map((p) => h('option', { value: p.id, selected: p.id === phaseFilter }, p.name))));

    const grid = h('div', { class: 'wp-board', role: 'grid', 'aria-label': 'Plan board: days across, people down' },
      h('div', { class: 'wp-board-row wp-board-head', role: 'row' }, h('div', { class: 'wp-corner' }, 'Crew'), shown.map(dayHead)),
      crew.map((p) => h('div', { class: 'wp-board-row', role: 'row' },
        h('div', { class: 'wp-person', role: 'rowheader' }, h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)), h('div', null, h('div', { class: 'wp-person-name' }, p.name), h('div', { class: 'muted wp-small' }, p.role || ''))),
        shown.map((d) => cell(d, p)))),
      h('div', { class: 'wp-board-row wp-unassigned', role: 'row' }, h('div', { class: 'wp-person', role: 'rowheader' }, h('div', { class: 'wp-person-name muted' }, 'Not assigned')), shown.map((d) => cell(d, null))));
    cssVar(grid, '--days', String(Math.max(1, shown.length)));

    return [
      nav2,
      warnings.length ? h('div', { class: 'wp-warn', role: 'status' }, `Over capacity on ${warnings.length} person-day${warnings.length === 1 ? '' : 's'}: `,
        warnings.slice(0, 3).map((w) => `${store.get('employees', w.employeeId)?.name || '?'} ${ui.fmtDate(w.date, { month: 'short', day: 'numeric' })} (${w.hours} h)`).join(', '), warnings.length > 3 ? ' …' : '') : null,
      crew.length ? grid : ui.empty({ icon: 'users', title: 'No crew on this plan', text: 'Add people in Setup, then add or spread tasks.', action: ui.button('Setup', { onClick: () => { tab = 'setup'; draw(); } }) }),
      h('p', { class: 'muted wp-small' }, 'Drag a task to another day or person, or tap it and choose Move. Dashed tasks are drafts the crew can\'t see yet.'),
    ];
  }

  /** Pointer drag (mouse, pen, touch) from a chip onto a board cell. */
  function dragSource(el, task, plan) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || task.status === 'done') return;
      const sx = e.clientX, sy = e.clientY, pid = e.pointerId;
      let ghost = null, over = null, dragging = false;
      const move = (ev) => {
        if (ev.pointerId !== pid) return;
        if (!dragging) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
          dragging = true;
          try { el.setPointerCapture(pid); } catch { /* already released */ }
          ghost = el.cloneNode(true);
          ghost.classList.add('wp-ghost');
          ghost.removeAttribute('data-task');
          document.body.append(ghost);
          el.classList.add('wp-dragging');
        }
        ev.preventDefault();
        ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY + 8}px)`;
        const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-drop]');
        if (target !== over) { over?.classList.remove('wp-over'); over = target; over?.classList.add('wp-over'); }
      };
      const end = (ev) => {
        if (ev.pointerId !== pid) return;
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', end);
        el.removeEventListener('pointercancel', end);
        ghost?.remove();
        el.classList.remove('wp-dragging');
        over?.classList.remove('wp-over');
        if (!dragging) return;
        justDragged = true;
        setTimeout(() => { justDragged = false; }, 50);
        if (ev.type === 'pointerup' && over) {
          if (moveTo(ctx, plan, store.get('workTasks', task.id) || task, over.dataset.date, over.dataset.emp || null)) ui.toast('Task moved', 'success', 1500);
        }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }

  // ----- task list (accessible, filterable) -----
  function taskList(plan, days, tasks) {
    const crew = planPeople(store, plan, tasks);
    const rows = W.sortTasks(tasks.filter((t) => (!listFilter.who || (listFilter.who === '-' ? !t.employeeId : t.employeeId === listFilter.who)) && (!listFilter.status || t.status === listFilter.status) && (!phaseFilter || t.phaseId === phaseFilter)));
    const byDay = new Map();
    for (const t of rows) { if (!byDay.has(t.date)) byDay.set(t.date, []); byDay.get(t.date).push(t); }
    const name = (id) => store.get('employees', id)?.name || 'Not assigned';
    return [
      h('div', { class: 'row', style: { marginBottom: 'var(--s3)' } },
        h('select', { class: 'input wp-select', 'aria-label': 'Person', onChange: (e) => { listFilter.who = e.target.value; draw(); } },
          h('option', { value: '' }, 'Everyone'), h('option', { value: '-', selected: listFilter.who === '-' }, 'Not assigned'), crew.map((p) => h('option', { value: p.id, selected: listFilter.who === p.id }, p.name))),
        h('select', { class: 'input wp-select', 'aria-label': 'Status', onChange: (e) => { listFilter.status = e.target.value; draw(); } },
          h('option', { value: '' }, 'Any status'), W.TASK_STATUSES.map((s) => h('option', { value: s, selected: listFilter.status === s }, s))),
        h('select', { class: 'input wp-select', 'aria-label': 'Phase', onChange: (e) => { phaseFilter = e.target.value; draw(); } },
          h('option', { value: '' }, 'All phases'), (plan.phases || []).map((p) => h('option', { value: p.id, selected: p.id === phaseFilter }, p.name))),
        h('span', { class: 'grow' }),
        ui.button('CSV', { icon: 'download', size: 'sm', onClick: () => {
          ui.download(`tasks-${planTitle(store, plan).replace(/[^\w-]+/g, '-').toLowerCase()}.csv`, K.tasksCsv(W.sortTasks(store.list('workTasks', (t) => t.planId === plan.id)), { name, job: (id) => store.get('jobs', id)?.number || '' }), 'text/csv');
          store.log('export', `Tasks CSV for ${planTitle(store, plan)}`, 'workTasks');
        } })),
      rows.length ? [...byDay].map(([d, list]) => h('section', { class: 'wp-daygroup' },
        h('h2', { class: 'section row' }, `${ui.fmtDate(d, { weekday: 'long', month: 'short', day: 'numeric' })}`, W.isDayPublished(plan, d) ? ui.badge('published', 'success') : ui.badge('draft', 'neutral'),
          h('span', { class: 'muted wp-small' }, `${list.length} task${list.length === 1 ? '' : 's'} · ${r2(sum(list, (t) => t.estHours))} h`)),
        h('div', { class: 'list' }, list.map((t) => h('div', { class: 'list-row click', tabindex: 0, role: 'button', dataset: { task: t.id }, onClick: () => taskSheet(ctx, plan, store.get('workTasks', t.id)), onKeydown: (e) => { if (e.key === 'Enter') taskSheet(ctx, plan, store.get('workTasks', t.id)); } },
          h('span', { class: 'wp-dot', style: { background: phaseColor(plan, t.phaseId) }, 'aria-hidden': 'true' }),
          h('div', { class: 'grow' }, h('div', { class: 'title' }, t.title), h('div', { class: 'meta' }, [name(t.employeeId), t.phaseName, t.qty != null ? `${t.qty} ${t.unit || ''}`.trim() : null, `${t.estHours || 0} h`].filter(Boolean).join(' · '))),
          W.photosNeeded(t) ? h('span', { title: 'Photo evidence required', class: 'muted' }, ui.icon(ICON_CAMERA, 16)) : null,
          ui.statusBadge(t.status),
          ui.button('', { size: 'sm', variant: 'ghost', icon: ICON_MOVE, title: `Move ${t.title}`, onClick: (e) => { e.stopPropagation(); moveSheet(ctx, plan, store.get('workTasks', t.id)); } })))))) : ui.empty({ icon: 'list', title: 'No tasks match', text: 'Add tasks, spread a quantity across days, or clear the filters.' }),
    ];
  }

  // ----- setup: plan details, crew, phases, holidays, templates -----
  function setup(plan) {
    const crewAll = people(store);
    const crew = new Set(plan.crewIds || []);
    const templates = store.list('taskTemplates').sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const days = W.planDays(plan);
    const off = (plan.holidays || []).filter((d) => d >= plan.startDate && d <= plan.endDate);
    const savePlan = (patch, msg = 'Plan saved') => { store.update('workPlans', plan.id, patch); ui.toast(msg, 'success'); };
    return h('div', { class: 'grid-2' },
      h('div', { class: 'card stack' },
        h('h3', null, 'Plan'),
        h('div', { class: 'muted wp-small' }, `${days.length} working days, ${plan.skipWeekends !== false ? 'weekends off' : 'weekends worked'}${off.length ? `, ${off.length} holiday${off.length === 1 ? '' : 's'} off` : ''}. ${plan.dayHours || 8} h days.`),
        ui.button('Edit dates and details', { icon: 'edit', onClick: () => ui.formSheet({
          title: 'Plan details',
          fields: [
            { label: 'Name', name: 'name', value: plan.name || '', span: true },
            { label: 'First day', name: 'startDate', type: 'date', value: plan.startDate, required: true },
            { label: 'Last day', name: 'endDate', type: 'date', value: plan.endDate, required: true },
            { label: 'Hours in a working day', name: 'dayHours', type: 'number', min: '1', max: '24', step: '0.5', value: plan.dayHours || 8 },
            { label: 'Status', name: 'status', type: 'select', value: plan.status || 'active', options: ['active', 'paused', 'complete', 'archived'] },
            { label: 'Skip weekends', name: 'skipWeekends', type: 'checkbox', value: plan.skipWeekends !== false },
            { label: 'Days off (YYYY-MM-DD, one per line)', name: 'holidays', type: 'textarea', rows: 4, value: (plan.holidays || []).join('\n'), span: true },
            { label: 'Notes', name: 'notes', type: 'textarea', rows: 2, value: plan.notes || '', span: true },
          ],
          onSubmit(v) {
            if (v.endDate < v.startDate) { ui.toast('The last day is before the first', 'error'); return false; }
            const holidays = String(v.holidays || '').split(/\s+/).filter(W.isDay).sort();
            savePlan({ name: v.name, startDate: v.startDate, endDate: v.endDate, dayHours: Number(v.dayHours) || 8, status: v.status, skipWeekends: v.skipWeekends, holidays, notes: v.notes });
            return undefined;
          },
        }) }),
        h('h3', null, 'Crew'),
        h('div', { class: 'ops-crew-pick' }, crewAll.map((p) => h('label', { class: 'ops-chip-check' },
          h('input', { type: 'checkbox', checked: crew.has(p.id), onChange: (e) => { if (e.target.checked) crew.add(p.id); else crew.delete(p.id); store.update('workPlans', plan.id, { crewIds: [...crew] }); } }),
          h('span', { class: 'avatar', style: { background: p.color || '#5f5a51' } }, ui.initials(p.name)), p.name))),
        h('h3', null, 'Phases and areas'),
        h('div', { class: 'list' }, (plan.phases || []).map((ph, i) => h('div', { class: 'list-row' },
          h('span', { class: 'wp-dot', style: { background: PHASE_COLORS[i % PHASE_COLORS.length] }, 'aria-hidden': 'true' }),
          h('span', { class: 'grow' }, ph.name),
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: `Rename ${ph.name}`, onClick: async () => {
            const name = await ui.promptDialog('Phase name', { title: 'Rename phase', value: ph.name, okLabel: 'Save' });
            if (!name) return;
            store.update('workPlans', plan.id, { phases: plan.phases.map((x) => (x.id === ph.id ? { ...x, name } : x)) });
            for (const t of store.list('workTasks', (x) => x.planId === plan.id && x.phaseId === ph.id && x.status !== 'done')) store.update('workTasks', t.id, { phaseName: name }, { silent: true });
          } }),
          ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: `Remove ${ph.name}`, onClick: async () => {
            if (store.count('workTasks', (x) => x.planId === plan.id && x.phaseId === ph.id)) return ui.toast('Move or remove its tasks first', 'error');
            if (await ui.confirmDialog(`Remove the phase "${ph.name}"?`, { okLabel: 'Remove' })) store.update('workPlans', plan.id, { phases: plan.phases.filter((x) => x.id !== ph.id) });
          } })))),
        h('div', { class: 'row' }, ui.button('Add phase', { size: 'sm', icon: 'plus', onClick: async () => {
          const name = await ui.promptDialog('Phase or area', { title: 'Add phase', okLabel: 'Add' });
          if (name) store.update('workPlans', plan.id, { phases: [...(plan.phases || []), { id: newId(), name, order: (plan.phases || []).length }] });
        } })),
        h('div', { class: 'row', style: { marginTop: 'var(--s4)' } }, ui.button('Delete plan', { variant: 'ghost danger', icon: 'trash', onClick: async () => {
          const n = store.count('workTasks', (t) => t.planId === plan.id);
          const started = store.count('workTasks', (t) => t.planId === plan.id && t.status !== 'draft' && t.status !== 'todo');
          if (started) return ui.toast(`${started} task${started === 1 ? ' has' : 's have'} progress recorded. Archive the plan instead (Edit details → Status).`, 'error', 5000);
          if (!(await ui.confirmDialog(`Delete this plan and its ${n} task${n === 1 ? '' : 's'}?`, { okLabel: 'Delete' }))) return;
          for (const t of store.list('workTasks', (x) => x.planId === plan.id)) store.remove('workTasks', t.id, { silent: true });
          store.remove('workPlans', plan.id);
          nav('#/workplan');
        } }))),
      h('div', { class: 'card stack' },
        h('h3', null, 'Task templates'),
        h('p', { class: 'muted wp-small', style: { margin: 0 } }, 'Save tasks you plan often (with their unit, rate and photo rule) and pick them when adding or spreading.'),
        templates.length ? h('div', { class: 'list' }, templates.map((t) => h('div', { class: 'list-row' },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name || t.title), h('div', { class: 'meta' }, [t.unit, t.ratePerHour ? `${t.ratePerHour} ${t.unit || ''}/h` : null, t.estHours ? `${t.estHours} h` : null, t.requiresPhoto ? 'photo required' : null].filter(Boolean).join(' · '))),
          ui.button('', { size: 'sm', variant: 'ghost', icon: 'edit', title: `Edit ${t.name}`, onClick: () => templateSheet(ctx, t) }),
          ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: `Delete ${t.name}`, onClick: () => store.remove('taskTemplates', t.id) })))) : h('p', { class: 'muted' }, 'No templates yet.'),
        h('div', { class: 'row' }, ui.button('New template', { size: 'sm', icon: 'plus', onClick: () => templateSheet(ctx, null) }))));
  }

  root.append(host);
  draw();
  let pending = null;
  const later = () => { clearTimeout(pending); pending = setTimeout(draw, 60); };
  const offs = ['workPlans', 'workTasks', 'taskTemplates', 'employees', 'jobs'].map((c) => store.on(c, later));
  const onResize = () => later();
  addEventListener('resize', onResize);
  return () => { clearTimeout(pending); offs.forEach((f) => f()); removeEventListener('resize', onResize); kpiCleanup?.(); };
}

function templateSheet(ctx, tpl) {
  const { store, ui } = ctx;
  ui.formSheet({
    title: tpl ? 'Edit template' : 'New template',
    fields: [
      { label: 'Name', name: 'name', value: tpl?.name || '', required: true, span: true },
      { label: 'Task title', name: 'title', value: tpl?.title || '', span: true, placeholder: 'Defaults to the name' },
      { label: 'Task type (for KPIs)', name: 'taskType', value: tpl?.taskType || '' },
      { label: 'Unit', name: 'unit', value: tpl?.unit || '' },
      { label: 'Rate (quantity per hour)', name: 'ratePerHour', type: 'number', min: '0', step: 'any', value: tpl?.ratePerHour ?? '' },
      { label: 'Estimated hours', name: 'estHours', type: 'number', min: '0', step: '0.25', value: tpl?.estHours ?? '' },
      { label: 'Needs photo evidence', name: 'requiresPhoto', type: 'checkbox', value: Boolean(tpl?.requiresPhoto) },
      { label: 'Photos needed', name: 'minPhotos', type: 'number', min: '1', max: String(W.MAX_PHOTOS), value: tpl?.minPhotos || 1 },
      { label: 'Details', name: 'description', type: 'textarea', rows: 3, value: tpl?.description || '', span: true },
    ],
    onSubmit(v) {
      const data = { ...v, title: v.title || v.name, minPhotos: Math.max(1, Math.min(W.MAX_PHOTOS, Number(v.minPhotos) || 1)) };
      if (tpl) store.update('taskTemplates', tpl.id, data); else store.add('taskTemplates', { ...data, uses: 0 });
      ui.toast('Template saved', 'success');
    },
  });
}

// ---------- daily meeting mode ----------

function renderMeeting(root, ctx, plan0) {
  const { store, ui, auth, nav } = ctx;
  const { h } = ui;
  const t0 = today(ui);
  const plan = store.get('workPlans', plan0.id);
  const opts = { skipWeekends: plan.skipWeekends !== false, holidays: plan.holidays || [] };
  let day = ctx.query.date && W.isDay(ctx.query.date) ? ctx.query.date : (W.isWeekend(t0) && plan.skipWeekends !== false ? W.nextWorkDay(t0, opts) : t0);
  const overlay = h('div', { class: 'wp-meeting', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Daily meeting' });
  const huddleFor = (d) => store.list('huddles', (x) => x.date === d && (x.planIds || []).includes(plan.id))[0] || null;
  const ensureHuddle = () => huddleFor(day) || store.add('huddles', { date: day, planIds: [plan.id], jobIds: plan.jobId ? [plan.jobId] : [], startedAt: new Date().toISOString(), endedAt: null, ledBy: me(auth), attendees: [], notes: '' });

  const ack = (p, list) => {
    const hud = ensureHuddle();
    const at = new Date().toISOString();
    for (const t of list) if (!t.ackAt) store.update('workTasks', t.id, { ackAt: at, ackVia: 'meeting', seenAt: t.seenAt || at }, { silent: true });
    const cur = store.get('huddles', hud.id);
    store.update('huddles', hud.id, { attendees: [...(cur.attendees || []).filter((a) => a.employeeId !== p.id), { employeeId: p.id, ackAt: at, by: me(auth) }] }, { summary: `${p.name}: got it` });
    ui.toast(`${p.name}: got it`, 'success', 1500);
  };
  const close = () => {
    const hud = huddleFor(day);
    if (hud && !hud.endedAt) store.update('huddles', hud.id, { endedAt: new Date().toISOString() }, { silent: true });
    nav(`#/workplan/${plan.id}`);
  };

  const draw = () => {
    const p = store.get('workPlans', plan.id) || plan;
    const planTasks = store.list('workTasks', (t) => t.planId === p.id, { omit: ['photos'] });
    const dayTasks = store.list('workTasks', (t) => t.date === day, { omit: ['photos'] });
    const crew = planPeople(store, p, planTasks.filter((t) => t.date === day));
    const cap = Number(p.dayHours) || W.DEFAULT_DAY_HOURS;
    const hud = huddleFor(day);
    const acked = new Map((hud?.attendees || []).map((a) => [a.employeeId, a.ackAt]));
    const drafts = planTasks.filter((t) => t.date === day && t.status === 'draft' && t.employeeId).length;
    const unassigned = planTasks.filter((t) => t.date === day && !t.employeeId);
    const jobById = new Map(store.list('jobs').map((j) => [j.id, j]));
    const days = W.planDays(p);
    const prevDay = [...days].reverse().find((d) => d < day);
    const nextDay = days.find((d) => d > day);
    const row = (t) => cssVar(h('li', { class: ['wp-mtask', `is-${t.status}`] },
      h('div', { class: 'grow' },
        h('div', { class: 'wp-mtask-title' }, t.title, t.status === 'draft' ? h('span', { class: 'wp-chip-new' }, 'draft') : null, t.lateAdd && !t.seenAt && t.status !== 'draft' ? h('span', { class: 'wp-chip-new' }, 'new') : null),
        h('div', { class: 'muted wp-small' }, [t.planId !== p.id ? jobById.get(t.jobId)?.number || 'other job' : t.phaseName, t.qty != null ? `${t.qty} ${t.unit || ''}`.trim() : null, t.estHours ? `${t.estHours} h` : null].filter(Boolean).join(' · '),
          W.photosNeeded(t) ? [' · ', ui.icon(ICON_CAMERA, 12), ' photo'] : null)),
      t.planId === p.id ? ui.button('Move…', { size: 'sm', variant: 'ghost', onClick: () => moveSheet(ctx, p, store.get('workTasks', t.id)) }) : null), '--ph', phaseColor(p, t.phaseId));
    const cards = crew.map((person) => {
      const list = W.sortTasks(dayTasks.filter((t) => t.employeeId === person.id && t.status !== 'draft').concat(planTasks.filter((t) => t.date === day && t.employeeId === person.id && t.status === 'draft')));
      const hours = sum(list, (t) => t.estHours);
      const gotAt = acked.get(person.id) || (list.length && list.filter((t) => t.status !== 'draft').every((t) => t.ackAt) ? list.find((t) => t.ackAt)?.ackAt : null);
      return h('section', { class: ['wp-mcard', gotAt ? 'acked' : null], dataset: { emp: person.id } },
        h('header', { class: 'row' },
          h('span', { class: 'avatar big', style: { background: person.color || '#5f5a51' } }, ui.initials(person.name)),
          h('div', { class: 'grow' }, h('h2', null, person.name), h('div', { class: ['wp-small', hours > cap ? 'wp-over-text' : 'muted'] }, `${list.length} task${list.length === 1 ? '' : 's'} · ${r2(hours)}/${cap} h`))),
        list.length ? h('ul', { class: 'wp-mlist' }, list.map(row)) : h('p', { class: 'muted' }, 'Nothing planned.'),
        h('footer', { class: 'row' },
          ui.button('Add task', { icon: 'plus', onClick: () => quickTaskSheet(ctx, { day, employeeId: person.id, planId: p.id, jobId: p.jobId }) }),
          h('span', { class: 'grow' }),
          gotAt ? h('span', { class: 'wp-gotit' }, ui.icon('check', 18), ` Got it ${ui.fmtTime(gotAt)}`)
            : ui.button('Got it', { variant: 'primary', size: 'lg', icon: 'check', disabled: !list.some((t) => t.status !== 'draft'), title: list.some((t) => t.status !== 'draft') ? null : 'Publish the day first', onClick: () => ack(person, list.filter((t) => t.status !== 'draft')) })));
    });
    h(ui.clear(overlay), null,
      h('header', { class: 'wp-mhead' },
        h('div', { class: 'grow' },
          h('div', { class: 'muted wp-small' }, `Morning meeting · ${planTitle(store, p)}`),
          h('h1', null, ui.fmtDate(day, { weekday: 'long', month: 'long', day: 'numeric' }), day === t0 ? h('span', { class: 'muted' }, ' · today') : null)),
        ui.button('', { icon: 'chevron-left', title: 'Previous day', disabled: !prevDay, onClick: () => { day = prevDay; draw(); } }),
        ui.button('', { icon: 'chevron-right', title: 'Next day', disabled: !nextDay, onClick: () => { day = nextDay; draw(); } }),
        drafts ? ui.button(`Publish ${drafts} draft${drafts === 1 ? '' : 's'}`, { variant: 'primary', icon: 'send', onClick: () => publishDayNow(ctx, p, day) }) : null,
        ui.button('End meeting', { variant: 'dark', icon: 'x', onClick: close })),
      h('div', { class: 'wp-mgrid' }, cards,
        unassigned.length ? h('section', { class: 'wp-mcard' }, h('header', null, h('h2', null, 'Not assigned')), h('ul', { class: 'wp-mlist' }, unassigned.map(row))) : null),
      h('p', { class: 'muted wp-small wp-mfoot' }, 'Each person taps "Got it" once they have heard their list; the time is logged. Add or move tasks here and they go out on the next sync.'));
  };
  document.body.append(overlay);
  draw();
  setTimeout(() => overlay.querySelector('button')?.focus(), 30);
  let pending = null;
  const later = () => { clearTimeout(pending); pending = setTimeout(draw, 40); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('.sheet, .dialog')) close(); };
  document.addEventListener('keydown', onKey);
  const offs = ['workTasks', 'workPlans', 'huddles', 'employees'].map((c) => store.on(c, later));
  root.append(ui.page({ title: 'Morning meeting' }, h('p', { class: 'muted' }, 'The meeting is open full screen.')));
  return () => { clearTimeout(pending); offs.forEach((f) => f()); document.removeEventListener('keydown', onKey); overlay.remove(); };
}

// ---------- KPIs ----------

function renderKpiPage(root, ctx) {
  const { ui, auth } = ctx;
  const { h } = ui;
  if (!auth.can('kpis')) { root.append(ui.page({ title: 'KPIs' }, ui.empty({ icon: 'lock', title: 'No access', text: 'KPIs are for owners, admins, the office and foremen.' }))); return undefined; }
  const host = h('div');
  root.append(ui.page({ title: 'Crew KPIs', subtitle: 'Across every work plan', actions: [ui.button('Work plans', { icon: ICON_PLAN, href: '#/workplan' })] }, host));
  return renderKpis(host, ctx, {});
}

/**
 * KPI panel: per worker and crew over a date range, job progress for a plan, CSV export.
 * @returns {() => void} cleanup
 */
export function renderKpis(host, ctx, { plan = null } = {}) {
  const { store, ui } = ctx;
  const { h } = ui;
  const t0 = today(ui);
  const monday = (() => { let d = t0; while (W.dayOfWeek(d) !== 1) d = W.addDays(d, -1); return d; })();
  const presets = [
    { id: 'week', label: 'This week', from: monday, to: W.addDays(monday, 6) },
    { id: '2w', label: 'Last 2 weeks', from: W.addDays(t0, -13), to: t0 },
    { id: '30', label: 'Last 30 days', from: W.addDays(t0, -29), to: t0 },
    plan ? { id: 'plan', label: 'Plan to date', from: plan.startDate, to: t0 < plan.endDate ? t0 : plan.endDate } : null,
  ].filter(Boolean);
  let range = { ...(plan ? presets.at(-1) : presets[1]) };
  let crewOnly = Boolean(plan);
  const body = h('div');

  const draw = () => {
    const p = plan ? store.get('workPlans', plan.id) || plan : null;
    // Only the range carries photos (evidence counts need them); the plan's progress doesn't.
    const all = store.list('workTasks', (t) => (!p || t.planId === p.id) && t.date && t.date >= range.from && t.date <= range.to);
    const ids = p && crewOnly ? [...new Set([...(p.crewIds || []), ...all.map((t) => t.employeeId).filter(Boolean)])] : null;
    const k = K.crewKpis(all, { from: range.from, to: range.to, employeeIds: ids });
    const name = (id) => store.get('employees', id)?.name || 'Former employee';
    k.workers.sort((a, b) => name(a.employeeId).localeCompare(name(b.employeeId)));
    const prog = p ? K.jobProgress(p, store.list('workTasks', (t) => t.planId === p.id, { omit: ['photos'] }), { today: t0 }) : null;
    const v = (x, suffix = '') => (x == null ? '—' : `${x}${suffix}`);
    const typeCell = (s) => (s.byType.length ? h('div', { class: 'wp-types' }, s.byType.map((b) => h('div', null, h('span', { class: 'num' }, v(b.perHour)), ` ${b.unit || b.type}/h`, h('span', { class: 'muted' }, ` · ${b.type}`)))) : h('span', { class: 'muted' }, '—'));
    const columns = [
      { key: 'who', label: 'Worker', render: (w) => (w.employeeId ? name(w.employeeId) : h('strong', null, 'Crew total')), sort: (w) => (w.employeeId ? name(w.employeeId) : '~') },
      { key: 'done', label: 'Done', align: 'right', render: (w) => `${w.completed}/${w.assigned}`, sort: (w) => w.completed },
      { key: 'ontime', label: 'On time', align: 'right', render: (w) => v(w.onTimePct, '%'), sort: (w) => w.onTimePct ?? -1 },
      { key: 'hours', label: 'Planned / actual h', align: 'right', render: (w) => `${w.plannedHoursDone} / ${w.actualHours}`, sort: (w) => w.hoursRatio ?? 0 },
      { key: 'rate', label: 'Qty per hour', render: typeCell },
      { key: 'blocked', label: 'Blocked', align: 'right', render: (w) => (w.blockedTasks ? `${w.blockedHours} h · ${w.blockedTasks} task${w.blockedTasks === 1 ? '' : 's'}` : '—'), sort: (w) => w.blockedHours },
      { key: 'evidence', label: 'Photo evidence', align: 'right', render: (w) => (w.evidenceRequired ? `${v(w.evidencePct, '%')} of ${w.evidenceRequired}${w.evidenceWaived ? ` · ${w.evidenceWaived} waived` : ''}` : '—'), sort: (w) => w.evidencePct ?? -1 },
      { key: 'rework', label: 'Reopened', align: 'right', render: (w) => (w.reopened ? `${w.reopened} (${v(w.reworkPct, '%')})` : '0'), sort: (w) => w.reopened },
    ];
    const exportKpis = () => {
      ui.download(`kpis-${range.from}-to-${range.to}.csv`, K.kpiCsv(k, { name, from: range.from, to: range.to }), 'text/csv');
      store.log('export', `KPI CSV ${range.from} to ${range.to}`, 'workTasks');
    };
    const exportTasks = () => {
      ui.download(`tasks-${range.from}-to-${range.to}.csv`, K.tasksCsv(W.sortTasks(K.inRange(all, range.from, range.to)), { name, job: (id) => store.get('jobs', id)?.number || '' }), 'text/csv');
      store.log('export', `Task CSV ${range.from} to ${range.to}`, 'workTasks');
    };
    h(ui.clear(body), null,
      h('div', { class: 'wp-note-card', role: 'note' }, ui.icon('info', 16), h('span', null, KPI_NOTE)),
      prog ? jobPanel(ui, p, prog) : null,
      h('h2', { class: 'section' }, 'Crew'),
      h('div', { class: 'row wp-kpi-controls' },
        ui.tabs(presets.map((x) => ({ id: x.id, label: x.label })), range.id, (id) => { range = { ...presets.find((x) => x.id === id) }; draw(); }),
        h('label', { class: 'field wp-inline' }, h('span', null, 'From'), h('input', { type: 'date', value: range.from, onChange: (e) => { if (W.isDay(e.target.value)) { range = { id: 'custom', from: e.target.value, to: range.to }; draw(); } } })),
        h('label', { class: 'field wp-inline' }, h('span', null, 'To'), h('input', { type: 'date', value: range.to, onChange: (e) => { if (W.isDay(e.target.value)) { range = { id: 'custom', from: range.from, to: e.target.value }; draw(); } } })),
        p ? h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: crewOnly, onChange: (e) => { crewOnly = e.target.checked; draw(); } }), h('span', null, 'Plan crew only')) : null,
        h('span', { class: 'grow' }),
        ui.button('KPIs CSV', { size: 'sm', icon: 'download', onClick: exportKpis }),
        ui.button('Tasks CSV', { size: 'sm', icon: 'download', onClick: exportTasks })),
      k.workers.length ? ui.table({ columns, rows: [...k.workers, { ...k.crew, employeeId: null }] }) : ui.empty({ icon: 'activity', title: 'No published tasks in this range', text: 'KPIs appear once tasks are published and worked.' }),
      k.crew.blockReasons.length ? [h('h2', { class: 'section' }, 'Why work was blocked'), h('div', { class: 'list' }, k.crew.blockReasons.map((r) => h('div', { class: 'list-row' }, h('span', { class: 'grow' }, r.reason), h('span', { class: 'muted' }, `${r.count} time${r.count === 1 ? '' : 's'} · ${r.hours} h`))))] : null);
  };
  host.append(body);
  draw();
  let pending = null;
  const off = store.on('workTasks', () => { clearTimeout(pending); pending = setTimeout(draw, 80); });
  return () => { clearTimeout(pending); off(); };
}

function jobPanel(ui, plan, prog) {
  const { h } = ui;
  const ahead = prog.aheadBy;
  return h('div', { class: 'stack' },
    h('h2', { class: 'section' }, 'Job progress'),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))' } },
      ui.stat({ label: 'Complete', value: `${prog.pct ?? 0}%`, hint: `${prog.earnedHours} of ${prog.totalHours} planned hours` }),
      ui.stat({ label: 'Against plan', value: `${ahead >= 0 ? '+' : ''}${ahead} h`, hint: `${prog.plannedToDate} h planned to date`, tone: ahead < 0 ? 'danger' : 'success' }),
      ui.stat({ label: 'Forecast finish', value: prog.forecastFinish ? ui.fmtDate(prog.forecastFinish, { month: 'short', day: 'numeric' }) : '—', hint: prog.forecastFinish ? (prog.lateBy ? `${prog.lateBy} working day${prog.lateBy === 1 ? '' : 's'} after plan` : 'on or before plan') : 'not enough done yet', tone: prog.lateBy ? 'danger' : null }),
      ui.stat({ label: 'Planned finish', value: ui.fmtDate(prog.plannedFinish, { month: 'short', day: 'numeric' }), hint: `${prog.elapsedDays} of ${prog.workingDays} working days gone` })),
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' }, h('h3', null, 'By phase'),
        h('div', { class: 'stack' }, prog.phases.map((ph) => h('div', { class: 'wp-phase' },
          h('div', { class: 'row' }, h('span', { class: 'wp-dot', style: { background: ph.id ? PHASE_COLORS[(plan.phases || []).findIndex((x) => x.id === ph.id) % PHASE_COLORS.length] || 'var(--border-input)' : 'var(--border-input)' }, 'aria-hidden': 'true' }), h('span', { class: 'grow' }, ph.name), h('span', { class: 'num' }, `${ph.pct ?? 0}%`)),
          h('div', { class: 'wp-bar', role: 'progressbar', 'aria-valuenow': ph.pct ?? 0, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': `${ph.name} complete` }, h('span', { style: { width: `${ph.pct || 0}%` } })),
          h('div', { class: 'muted wp-small' }, `${ph.done}/${ph.taskCount} tasks · ${ph.earnedHours}/${ph.totalHours} h`))))),
      h('div', { class: 'card' }, h('h3', null, 'Burn-up: planned vs done (hours)'), burnupChart(ui, prog.burnup))));
}

/** Cumulative planned vs earned hours per working day, as an inline SVG. */
function burnupChart(ui, points) {
  const { h } = ui;
  const NS = 'http://www.w3.org/2000/svg';
  const W_ = 560, H_ = 220, L = 44, R = 12, T = 12, B = 28;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W_} ${H_}`);
  svg.setAttribute('class', 'wp-burnup');
  svg.setAttribute('role', 'img');
  const last = points.filter((p) => p.actual != null).at(-1);
  svg.setAttribute('aria-label', `Burn-up chart. Planned ${points.at(-1)?.planned ?? 0} hours in total; ${last ? `${last.actual} hours done by ${last.date}` : 'nothing done yet'}.`);
  if (!points.length) return h('p', { class: 'muted' }, 'No working days in this plan.');
  const max = Math.max(1, ...points.map((p) => Math.max(p.planned, p.actual || 0)));
  const x = (i) => L + (points.length === 1 ? 0 : (i * (W_ - L - R)) / (points.length - 1));
  const y = (v) => T + (H_ - T - B) * (1 - v / max);
  const el = (name, attrs) => { const e = document.createElementNS(NS, name); for (const [k, val] of Object.entries(attrs)) e.setAttribute(k, val); svg.append(e); return e; };
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    el('line', { x1: L, x2: W_ - R, y1: y(v), y2: y(v), class: 'grid' });
    el('text', { x: L - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }).textContent = String(Math.round(v));
  }
  const step = Math.max(1, Math.ceil(points.length / 7));
  points.forEach((p, i) => {
    const lastTick = i === points.length - 1;
    if (i % step === 0 || lastTick) el('text', { x: x(i), y: H_ - 8, class: 'tick', 'text-anchor': lastTick ? 'end' : i === 0 ? 'start' : 'middle' }).textContent = p.date.slice(5);
  });
  const line = (vals, cls) => el('polyline', { points: vals.map(([i, v]) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' '), class: cls });
  line(points.map((p, i) => [i, p.planned]), 'planned');
  const done = points.map((p, i) => [i, p.actual]).filter(([, v]) => v != null);
  if (done.length) {
    line(done, 'actual');
    const [i, v] = done.at(-1);
    el('circle', { cx: x(i), cy: y(v), r: 4, class: 'actual-dot' });
  }
  return h('figure', { class: 'wp-chart' }, svg,
    h('figcaption', { class: 'row wp-small' }, h('span', { class: 'wp-key planned' }), 'Planned', h('span', { class: 'wp-key actual' }), 'Done (earned hours)'));
}

// ---------- dashboard tiles (managers) ----------

/**
 * Work-plan tiles for the dashboard: today's tasks done, blocked now (with reasons), photos
 * missing on finished work this week, and plans running late. Null when there is nothing
 * to show or the person can't plan.
 */
export function workplanTiles(ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  if (!auth.can('kpis') && !auth.can('workplan')) return null;
  if (!store.count('workPlans') && !store.count('workTasks')) return null;
  const t0 = today(ui);
  const tasks = store.list('workTasks', null, { omit: ['photos'] });
  const todays = tasks.filter((t) => t.date === t0 && W.isPublished(t));
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const weekAgo = W.addDays(t0, -6);
  const withPhotos = store.list('workTasks', (t) => t.status === 'done' && t.requiresPhoto && t.date >= weekAgo && t.date <= t0);
  const missing = withPhotos.filter((t) => W.evidenceProblem(t)).length;
  const late = store.list('workPlans', (p) => p.status === 'active').filter((p) => {
    const pr = K.jobProgress(p, tasks.filter((t) => t.planId === p.id), { today: t0 });
    return pr.lateBy > 0;
  });
  const name = (id) => store.get('employees', id)?.name || 'Someone';
  return h('div', { class: 'stack wp-dash' },
    h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } },
      h('a', { class: 'wp-tile', href: '#/today?view=crew' }, ui.stat({ label: 'Tasks done today', value: `${todays.filter((t) => t.status === 'done').length}/${todays.length}`, hint: `${new Set(todays.map((t) => t.employeeId)).size} people on lists` })),
      h('a', { class: 'wp-tile', href: '#/workplan' }, ui.stat({ label: 'Blocked now', value: String(blocked.length), hint: blocked.length ? 'needs a foreman' : 'nothing blocked', tone: blocked.length ? 'danger' : null })),
      h('a', { class: 'wp-tile', href: '#/workplan/kpis' }, ui.stat({ label: 'Photos missing', value: String(missing), hint: `on ${withPhotos.length} finished photo task${withPhotos.length === 1 ? '' : 's'} this week`, tone: missing ? 'danger' : null })),
      h('a', { class: 'wp-tile', href: '#/workplan' }, ui.stat({ label: 'Plans behind', value: String(late.length), hint: late.length ? late.map((p) => planTitle(store, p)).slice(0, 2).join(', ') : 'all on pace', tone: late.length ? 'danger' : null }))),
    blocked.length ? h('div', { class: 'list' }, blocked.slice(0, 5).map((t) => {
      const b = (t.blocks || []).filter((x) => !x.resolvedAt).at(-1);
      return h('a', { class: 'list-row click', href: t.planId ? `#/workplan/${t.planId}` : '#/today?view=crew', style: { color: 'inherit', textDecoration: 'none' } },
        h('span', { class: 'badge danger' }, 'blocked'),
        h('span', { class: 'grow' }, `${name(t.employeeId)}: ${t.title}`, h('span', { class: 'muted' }, ` · ${b?.reason || 'no reason'}${b?.at ? ` since ${ui.fmtTime(b.at)}` : ''}`)),
        ui.icon('chevron-right', 16));
    })) : null);
}
