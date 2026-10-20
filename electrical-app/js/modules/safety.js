// Safety: field level hazard assessments, toolbox talks, incidents and near misses,
// inspections, training and orientation, emergency info per job, and the manager dashboard.
// Every role files and signs; managers investigate, assign and see medical details.
// Background, rules and sources: docs/safety/README.md. Pure logic: js/lib/safety*.js.
import { hasFlhaToday, flhaFor, lastFlha, isSigned, flhaRequired, openActions } from '../lib/safety.js';
import { emergencyCard, jobSafetyOf } from '../lib/safety-emergency.js';
import { inspectionSchedule } from '../lib/safety-inspections.js';
import { ICON_HARDHAT, ICON_STOP, me, todaysJobs, jobLabel, emptyNoEmployee } from './safety/common.js';
import { flhaView } from './safety/flha.js';
import { talksList, talkView } from './safety/talks.js';
import { incidentsList, incidentForm, incidentView } from './safety/incidents.js';
import { inspectionsList, inspectionView, startInspection } from './safety/inspections.js';
import { actionsTab, actionList } from './safety/actions.js';
import { trainingTab } from './safety/training.js';
import { dashboardTab } from './safety/dashboard.js';
import { jobInfoView } from './safety/jobinfo.js';

const TABS = [
  { id: 'today', label: 'Today' }, { id: 'flhas', label: 'FLHAs' }, { id: 'talks', label: 'Toolbox talks' },
  { id: 'incidents', label: 'Incidents' }, { id: 'actions', label: 'Actions' }, { id: 'inspections', label: 'Inspections' },
  { id: 'training', label: 'Training' }, { id: 'dashboard', label: 'Dashboard', manager: true },
];

export default {
  id: 'safety',
  title: 'Safety',
  icon: ICON_HARDHAT,
  group: 'field',
  perm: 'safety',
  render(root, ctx) {
    const [sub, id] = ctx.params;
    if (sub === 'flha') return flhaView(root, ctx, id || 'new');
    if (sub === 'talks' && id) return talkView(root, ctx, id);
    if (sub === 'incidents' && id === 'new') return incidentForm(root, ctx);
    if (sub === 'incidents' && id) return incidentView(root, ctx, id);
    if (sub === 'inspections' && id) return inspectionView(root, ctx, id);
    if (sub === 'job' && id) return jobInfoView(root, ctx, id);
    return home(root, ctx);
  },
};

function home(root, ctx) {
  const { store, ui, auth, query } = ctx;
  const { h } = ui;
  const manager = auth.isManager();
  const tabs = TABS.filter((t) => !t.manager || manager);
  let tab = tabs.some((t) => t.id === query.tab) ? query.tab : 'today';
  const tabHost = h('div', { class: 'sf-tabs' });
  const body = h('div', { class: 'sf-body' });
  const draw = () => {
    ui.clear(tabHost).append(ui.tabs(tabs, tab, (t) => { tab = t; history.replaceState(null, '', `#/safety?tab=${t}`); draw(); }));
    ui.clear(body);
    const render = { today, flhas: flhaTab, talks: talksList, incidents: incidentsList, actions: actionsTab, inspections: inspectionsList, training: trainingTab, dashboard: dashboardTab }[tab];
    try { render(body, ctx); } catch (e) { console.error(e); body.append(ui.empty({ icon: 'alert', title: 'Something went wrong', text: e.message })); }
  };
  root.append(ui.page({ title: 'Safety', subtitle: 'Hazard assessments, toolbox talks, incidents, inspections and training' }, tabHost, body));
  draw();
  // Redraw when records change, but not while someone is typing or signing in a sheet.
  let pending = false;
  const redraw = () => { if (pending) return; pending = true; setTimeout(() => { pending = false; if (!document.querySelector('.sheet, .dialog')) draw(); }, 50); };
  const offs = ['flhas', 'toolboxTalks', 'incidents', 'correctiveActions', 'safetyInspections', 'siteOrientations', 'jobSafety', 'certifications'].map((c) => store.on(c, redraw));
  return () => offs.forEach((f) => f());
}

/** My day in safety: FLHAs per job, talks to sign, my actions, emergency info, quick reports. */
function today(el, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const t = ui.today();
  const flhas = store.list('flhas');
  el.append(h('div', { class: 'sf-quick' },
    h('a', { class: 'sf-quick-btn warn', href: '#/safety/incidents/new?kind=near-miss' }, ui.icon('alert', 22), h('span', null, 'Near miss')),
    h('a', { class: 'sf-quick-btn danger', href: '#/safety/incidents/new?kind=incident' }, ui.icon(ICON_STOP, 22), h('span', null, 'Incident')),
    h('button', { type: 'button', class: 'sf-quick-btn', onClick: () => startInspection(ctx) }, ui.icon('check', 22), h('span', null, 'Inspect')),
    h('a', { class: 'sf-quick-btn', href: '#/safety/flha/new' }, ui.icon(ICON_HARDHAT, 22), h('span', null, 'FLHA'))));
  if (!person.id) { el.append(emptyNoEmployee(ui)); return; }

  const jobs = todaysJobs(store, person.id, t);
  for (const j of jobs) {
    const card = emergencyCard(ctx, j.id, { compact: true, editHref: auth.isManager() ? `#/safety/job/${j.id}` : null });
    if (card) el.append(card);
  }
  el.append(...ui.section('Your hazard assessments today', jobs.length ? h('div', { class: 'list' }, jobs.map((j) => {
    const f = flhaFor(person.id, j.id, t, flhas);
    const prev = !f ? lastFlha(person.id, j.id, t, flhas) : null;
    const required = flhaRequired(jobSafetyOf(store, j.id), store.settings());
    const ok = hasFlhaToday(person.id, j.id, t, flhas);
    return h('div', { class: 'list-row sf-flha-row' },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, jobLabel(j)), h('div', { class: 'meta' }, required ? 'FLHA required before work' : 'FLHA')),
      f?.stopWork ? ui.badge('stop work', 'danger') : ok ? ui.badge('signed', 'success') : f ? ui.badge('draft', 'warning') : ui.badge('not done', required ? 'danger' : 'neutral'),
      f ? ui.button(isSigned(f) ? 'View' : 'Finish', { size: 'sm', href: `#/safety/flha/${f.id}` }) : [
        prev ? ui.button('Same as last time, re-checked', { size: 'sm', icon: 'copy', href: `#/safety/flha/new?jobId=${j.id}&copy=${prev.id}` }) : null,
        ui.button('Start FLHA', { size: 'sm', variant: 'primary', href: `#/safety/flha/new?jobId=${j.id}` })]);
  })) : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'You are not scheduled on a job today.'), ui.button('Start an FLHA anyway', { size: 'sm', href: '#/safety/flha/new' }))));

  const talks = store.list('toolboxTalks', (x) => x.status !== 'cancelled' && x.date === t && !(x.attendees || []).some((a) => a.employeeId === person.id));
  if (talks.length) el.append(...ui.section('Toolbox talks to sign', h('div', { class: 'list' }, talks.map((x) => h('a', { class: 'list-row click', href: `#/safety/talks/${x.id}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, x.title), h('div', { class: 'meta' }, [x.time, x.location].filter(Boolean).join(' · '))), ui.badge('sign', 'accent'))))));

  const mine = openActions(store.list('correctiveActions', (a) => a.ownerId === person.id), t);
  if (mine.open) el.append(...ui.section(`Your corrective actions (${mine.open})`, actionList(ctx, mine.list)));

  if (auth.isManager()) {
    const due = inspectionSchedule(store.list('safetyInspections'), t).filter((s) => s.state === 'overdue');
    const reports = store.list('incidents', (r) => (r.status || 'reported') === 'reported');
    const stops = flhas.filter((f) => f.date === t && f.stopWork);
    const toReview = flhas.filter((f) => f.date === t && isSigned(f) && !f.review);
    el.append(...ui.section('Needs a manager', h('div', { class: 'grid stat-grid' },
      ui.stat({ label: 'Stop work today', value: stops.length, tone: stops.length ? 'danger' : 'success' }),
      ui.stat({ label: 'New reports', value: reports.length, tone: reports.length ? 'accent' : null }),
      ui.stat({ label: 'FLHAs to review', value: toReview.length }),
      ui.stat({ label: 'Inspections overdue', value: due.length, tone: due.length ? 'danger' : 'success' }))));
    if (stops.length || toReview.length) {
      el.append(h('div', { class: 'list' }, [...stops, ...toReview].map((f) => h('a', { class: 'list-row click', href: `#/safety/flha/${f.id}` },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, store.get('employees', f.employeeId)?.name || '—'), h('div', { class: 'meta' }, jobLabel(store.get('jobs', f.jobId)))),
        f.stopWork ? ui.badge('stop work', 'danger') : ui.badge('review', 'info')))));
    }
  }
}

function flhaTab(el, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  const person = me(ctx);
  const rows = store.list('flhas', (f) => auth.isManager() || f.employeeId === person.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 200);
  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'grow' }), ui.button('New FLHA', { variant: 'primary', icon: 'plus', href: '#/safety/flha/new' })));
  el.append(rows.length ? ui.table({
    columns: [
      { key: 'date', label: 'Date', render: (f) => ui.fmtDate(f.date), sort: (f) => f.date },
      { key: 'who', label: 'Worker', render: (f) => store.get('employees', f.employeeId)?.name || '—' },
      { key: 'job', label: 'Job', render: (f) => jobLabel(store.get('jobs', f.jobId)) || '—' },
      { key: 'hz', label: 'Hazards', align: 'right', render: (f) => (f.hazards || []).filter((x) => x.present).length },
      { key: 'state', label: 'Status', render: (f) => (f.stopWork ? ui.badge('stop work', 'danger') : isSigned(f) ? ui.badge(f.review ? 'reviewed' : 'signed', f.review ? 'success' : 'info') : ui.badge('draft', 'warning')) },
    ],
    rows, onRowClick: (f) => ctx.nav(`safety/flha/${f.id}`),
  }) : ui.empty({ icon: 'check', title: 'No hazard assessments yet', text: 'Each worker fills one in before starting work on a job each day.' }));
}
