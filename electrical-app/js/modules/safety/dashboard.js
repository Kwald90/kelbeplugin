// Safety dashboard for managers: FLHA completion, near misses and incidents with a 6-month
// trend, open corrective actions, overdue inspections, expiring training. CSV export.
import { dashboardStats, dashboardCsv, flhaCompletion, addDays } from '../../lib/safety.js';
import { inspectionSchedule, templateById } from '../../lib/safety-inspections.js';
import { nameOf, jobLabel } from './common.js';
import { actionList } from './actions.js';

export function dashboardTab(el, ctx) {
  const { store, ui } = ctx;
  const { h } = ui;
  const today = ui.today();
  const sched = inspectionSchedule(store.list('safetyInspections'), today);
  const stats = dashboardStats({
    today, days: 30,
    flhas: store.list('flhas'), schedule: store.list('schedule'), timeEntries: store.list('timeEntries'),
    incidents: store.list('incidents'), actions: store.list('correctiveActions'), inspectionStatus: sched,
    certs: store.list('certifications', (c) => c.employeeId),
  });
  const csv = () => {
    ui.download(`safety-dashboard-${today}.csv`, dashboardCsv(stats, store.settings().company?.name || ''), 'text/csv');
    store.log('export', 'Safety dashboard CSV', 'safety');
  };
  el.append(h('div', { class: 'row sf-toolbar' }, h('span', { class: 'muted' }, `Last 30 days: ${ui.fmtDate(stats.from)} – ${ui.fmtDate(stats.to)}`), h('span', { class: 'grow' }),
    ui.button('Export CSV', { icon: 'download', onClick: csv })));
  el.append(h('div', { class: 'grid stat-grid sf-stats' },
    ui.stat({ label: 'FLHA completion', value: stats.flhaPct == null ? '—' : `${stats.flhaPct}%`, hint: `${stats.flhaDone} of ${stats.flhaExpected} worker-days`, tone: stats.flhaPct == null ? null : stats.flhaPct >= 90 ? 'success' : 'danger' }),
    ui.stat({ label: 'Near misses', value: stats.nearMisses, hint: 'reported, 30 days' }),
    ui.stat({ label: 'Incidents', value: stats.incidents, hint: '30 days', tone: stats.incidents ? 'danger' : 'success' }),
    ui.stat({ label: 'Open corrective actions', value: stats.openActions, hint: `${stats.overdueActions} overdue`, tone: stats.overdueActions ? 'danger' : null }),
    ui.stat({ label: 'Overdue inspections', value: stats.overdueInspections, tone: stats.overdueInspections ? 'danger' : 'success' }),
    ui.stat({ label: 'Training expiring', value: stats.expiringTraining, hint: `${stats.expiredTraining} expired`, tone: stats.expiredTraining ? 'danger' : stats.expiringTraining ? 'accent' : null })));

  // Trend: two bars per month, near misses and incidents, with the numbers written out.
  const max = Math.max(1, ...stats.trend.series.map((s) => Math.max(s.nearMiss, s.incident)));
  const monthName = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' });
  el.append(...ui.section('Reports by month',
    h('div', { class: 'card sf-trend', role: 'img', 'aria-label': `Near misses and incidents per month: ${stats.trend.series.map((s) => `${monthName(s.month)} ${s.nearMiss} near misses, ${s.incident} incidents`).join('; ')}` },
      h('div', { class: 'sf-legend' }, h('span', { class: 'sf-key nm' }), 'Near misses', h('span', { class: 'sf-key inc' }), 'Incidents',
        stats.trend.ratio != null ? h('span', { class: 'muted' }, ` · ${stats.trend.ratio} near misses per incident`) : null),
      h('div', { class: 'sf-bars' }, stats.trend.series.map((s) => h('div', { class: 'sf-bar-col' },
        h('div', { class: 'sf-bar-pair' },
          h('div', { class: 'sf-bar nm', style: { height: `${(s.nearMiss / max) * 100}%` } }, h('span', null, s.nearMiss || '')),
          h('div', { class: 'sf-bar inc', style: { height: `${(s.incident / max) * 100}%` } }, h('span', null, s.incident || ''))),
        h('div', { class: 'sf-bar-label' }, monthName(s.month))))))));

  // Who hasn't filed today.
  const todayGap = flhaCompletion({ flhas: store.list('flhas'), schedule: store.list('schedule'), timeEntries: store.list('timeEntries'), from: today, to: today });
  el.append(...ui.section(`FLHAs today (${todayGap.done}/${todayGap.expected})`, todayGap.missing.length
    ? h('div', { class: 'list' }, todayGap.missing.map((m) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('div', { class: 'title' }, nameOf(store, m.employeeId)), h('div', { class: 'meta' }, jobLabel(store.get('jobs', m.jobId)))), ui.badge('missing', 'warning'))))
    : h('p', { class: 'muted' }, todayGap.expected ? 'Everyone scheduled today has filed.' : 'Nobody is scheduled or clocked in today.')));

  const overdue = sched.filter((s) => s.state !== 'ok');
  el.append(...ui.section('Inspections due', overdue.length ? h('div', { class: 'list' }, overdue.map((s) => h('a', { class: 'list-row click', href: `#/safety/inspections/${s.inspection.id}` },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, templateById(s.templateId)?.title || s.templateId, s.assetTag ? ` · ${s.assetTag}` : ''), h('div', { class: 'meta' }, `last ${ui.fmtDate(s.lastDate)}`)),
    ui.badge(`${s.state} · ${ui.fmtDate(s.nextDue)}`, s.state === 'overdue' ? 'danger' : 'warning')))) : h('p', { class: 'muted' }, 'Nothing due.')));

  const open = store.list('correctiveActions', (a) => a.status !== 'done' && a.status !== 'verified').sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
  el.append(...ui.section('Open corrective actions', actionList(ctx, open.slice(0, 20), 'None open.')));
  el.append(h('p', { class: 'muted sf-small' }, `Window ${stats.from} to ${stats.to}. FLHA completion counts every worker scheduled or clocked in on a job that day (${addDays(today, -29)} onward).`));
}
