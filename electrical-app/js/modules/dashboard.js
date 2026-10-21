// S11 Dashboard: today at a glance, plus every alert the other modules raise.
import { invoiceShown, entryHours, moneyFormatter } from '../lib/money.js';
import { onboardingCard } from './onboarding.js';
import { workplanTiles } from './workplan.js';
import { weekHoursTile } from './time.js';
import { moduleOn, switchOn } from '../lib/modules.js';
import { unbilledAcrossJobs } from '../lib/tm.js';
import { tmSources } from './jobs.js';
import { dashboardActions, dashboardRouteAllowed } from '../lib/dashboard-actions.js';
import { readyToBill } from '../lib/receivables.js';

/**
 * Bills whose prices are above the PO or price book and not acknowledged (r1-get-paid.md 6.3, R1-E's
 * costing.js priceVariances). Null until that library is there.
 */
function varianceCount(costing, store) {
  if (typeof costing?.priceVariances !== 'function') return null;
  const purchaseOrders = store.list('purchaseOrders');
  const items = store.list('items');
  const tolerancePct = store.settings().costing?.priceVariancePct ?? 2;
  let n = 0;
  for (const bill of store.list('bills', (b) => ['open', 'paid'].includes(b.status) && !b.varianceAck)) {
    try { if ((costing.priceVariances(bill, { purchaseOrders, items, tolerancePct }) || []).length) n++; } catch { /* skip that bill */ }
  }
  return n;
}

export default {
  id: 'dashboard',
  title: 'Today',
  icon: 'home',
  group: 'home',
  perm: 'dashboard',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    let timer;
    const expanded = new Set();
    let costing = null;
    // Money roles only: the ready-to-bill and price-variance cards (4.7).
    const billing = () => auth.can('invoices') && (auth.seesMoney?.() ?? true) && moduleOn(store.settings(), 'invoices');
    if (billing() && store.count('bills') > 0) import('../lib/costing.js').then((m) => { costing = m; if (root.isConnected) draw(); }).catch(() => {});

    // Due sequence steps are queued whenever the office opens the app (not when follow-ups are off).
    if (auth.can('sequences') && moduleOn(store.settings(), 'sequences')) import('./sequences.js').then((m) => m.processSequences?.(store)).catch(() => {});

    const draw = () => {
      ui.clear(root);
      const me = auth.current();
      const settings = store.settings();
      const money = moneyFormatter(settings);
      // Tiles, alerts and buttons for turned-off modules are left out (Settings → Modules).
      const on = (m) => moduleOn(settings, m);
      const allowed = (href) => dashboardRouteAllowed(settings, (p) => auth.can(p), href);
      const moneyVisible = auth.seesMoney();
      const detail = (id, label, ...content) => h('details', { class: 'dash-details', open: expanded.has(id),
        onToggle: (e) => { if (e.currentTarget.open) expanded.add(id); else expanded.delete(id); } },
      h('summary', null, label), h('div', { class: 'dash-details-body' }, ...content));
      const day = ui.today();
      const hour = new Date().getHours();
      const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
      const jobs = store.list('jobs');
      const jobById = new Map(jobs.map((j) => [j.id, j]));
      const empById = new Map(store.list('employees').map((e) => [e.id, e]));

      // ---- numbers ----
      const openLeads = store.list('leads', (l) => !['won', 'lost'].includes(l.stage));
      const pipeline = openLeads.reduce((s, l) => s + (l.valueCents || 0), 0);
      const active = jobs.filter((j) => j.status === 'in-progress');
      const invoices = moneyVisible && allowed('#/invoices') ? store.list('invoices', (i) => !['void', 'draft'].includes(i.status)) : [];
      const shown = new Map(invoices.map((i) => [i.id, invoiceShown(store, i)]));
      const outstanding = invoices.reduce((s, i) => s + Math.max(0, shown.get(i.id).balanceCents), 0);
      const overdue = invoices.filter((i) => shown.get(i.id).status === 'overdue');
      const onClock = allowed('#/time') ? store.list('timeEntries', (e) => !e.clockOut && (auth.isManager() || e.employeeId === me.id)) : [];
      const myOpen = onClock.find((e) => e.employeeId === me.id);
      const unbilled = moneyVisible && allowed('#/invoices') && allowed('#/jobs') ? unbilledAcrossJobs(jobs.filter((j) => !['lead'].includes(j.status)), { settings, ...tmSources(store), dayOf: ui.localDay }) : null;
      const ready = billing() ? readyToBill({ jobs, invoices: store.list('invoices'), payments: store.list('payments'), ...tmSources(store), settings, dayOf: ui.localDay }, { asOf: day }) : null;
      const variances = billing() ? varianceCount(costing, store) : null;

      const stats = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } },
        moneyVisible && allowed('#/leads') ? ui.stat({ label: 'Open pipeline', value: money(pipeline, { whole: true }), hint: `${openLeads.length} open leads` }) : null,
        allowed('#/jobs') ? ui.stat({ label: 'Jobs in progress', value: String(active.length), hint: `${jobs.filter((j) => j.status === 'scheduled').length} scheduled` }) : null,
        moneyVisible && allowed('#/invoices') ? ui.stat({ label: 'Owed to you', value: money(outstanding, { whole: true }), hint: overdue.length ? `${overdue.length} overdue` : 'nothing overdue', tone: overdue.length ? 'danger' : null }) : null,
        unbilled ? h('a', { href: '#/jobs', class: 'dash-stat-link', style: { color: 'inherit', textDecoration: 'none' }, dataset: { unbilledTm: String(unbilled.cents) } },
          ui.stat({ label: 'Unbilled T&M', value: money(unbilled.cents, { whole: true }), hint: unbilled.count ? `${unbilled.count} time & material job${unbilled.count === 1 ? '' : 's'} · ${unbilled.hours} h` : 'all billed', tone: unbilled.cents ? 'accent' : null })) : null,
        ready ? h('a', { href: '#/invoices/ready', class: 'dash-stat-link', dataset: { readyToBill: String(ready.length) } },
          ui.stat({ label: 'Ready to bill', value: String(ready.length), hint: ready.length ? `oldest ${ready[0].ageDays} day${ready[0].ageDays === 1 ? '' : 's'}` : 'nothing waiting', tone: ready.length ? 'accent' : null })) : null,
        variances != null ? h('a', { href: '#/purchasing', class: 'dash-stat-link', dataset: { variances: String(variances) } },
          ui.stat({ label: 'Price variances', value: String(variances), hint: variances ? 'bills above the PO or price book' : 'none to check', tone: variances ? 'warning' : null })) : null,
        allowed('#/time') ? ui.stat({ label: 'On the clock', value: String(onClock.length), hint: onClock.map((e) => empById.get(e.employeeId)?.name.split(' ')[0]).filter(Boolean).join(', ') || 'nobody yet', tone: onClock.length ? 'success' : null }) : null,
      );

      // ---- my clock ----
      const clockCard = auth.can('time') && on('time') ? h('div', { class: 'card row', style: { justifyContent: 'space-between' } },
        h('div', { class: 'row' }, h('span', { class: 'avatar', style: { background: me.color || '#5f5a51', width: '40px', height: '40px' } }, ui.initials(me.name)),
          h('div', null, h('div', { style: { fontWeight: 650 } }, myOpen ? `${myOpen.kind === 'travel' ? 'Travelling' : 'On the clock'} · ${jobById.get(myOpen.jobId)?.title || 'no job'}` : 'Not clocked in'),
            h('div', { class: 'muted num', id: 'dash-clock' }, myOpen ? ui.fmtHours(entryHours(myOpen)) + ` since ${ui.fmtTime(myOpen.clockIn)}` : 'Clock in from the time clock'))),
        ui.button(myOpen ? 'Open time clock' : 'Clock in', { variant: myOpen ? 'secondary' : 'primary', icon: 'clock', href: '#/time' })) : null;

      // ---- today's crew board ----
      const todays = allowed('#/schedule') && allowed('#/jobs') ? store.list('schedule', (s) => s.date === day) : [];
      const byJob = new Map();
      for (const s of todays) { if (!byJob.has(s.jobId)) byJob.set(s.jobId, []); byJob.get(s.jobId).push(s); }
      const today = h('div', { class: 'list' }, byJob.size ? [...byJob].map(([jobId, rows]) => {
        const j = jobById.get(jobId);
        return h('a', { class: 'list-row click', href: `#/jobs/${jobId}`, style: { color: 'inherit', textDecoration: 'none' } },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, j ? `${j.number} · ${j.title}` : 'Job removed'), h('div', { class: 'meta' }, j?.address || '')),
          h('div', { class: 'dash-crew' }, [...new Set(rows.map((r) => r.employeeId))].map((employeeId) => {
            const e = empById.get(employeeId);
            return h('span', { class: 'dash-person' }, h('span', { class: 'avatar', 'aria-hidden': 'true', style: { background: e?.color || '#5f5a51', width: '28px', height: '28px', fontSize: '11px' } }, ui.initials(e?.name)), h('span', null, e?.name || 'Unassigned'));
          })),
          j ? ui.statusBadge(j.status) : null);
      }) : h('div', { class: 'list-row muted' }, 'Nobody is scheduled today.'));

      // ---- alerts ----
      const alerts = [];
      const add = (tone, iconName, text, href) => alerts.push({ tone, iconName, text, href });

      for (const e of store.list('employees', (x) => x.active !== false && x.licenceExpiry)) {
        const d = ui.daysUntil(e.licenceExpiry);
        if (d < 0) add('danger', 'id-card', `${e.name}'s licence expired ${-d} days ago`, `#/employees/${e.id}`);
        else if (d <= 30) add('warning', 'id-card', `${e.name}'s licence expires in ${d} days`, `#/employees/${e.id}`);
      }
      for (const c of store.list('certifications')) {
        const d = ui.daysUntil(c.expiry);
        const who = c.employeeId ? empById.get(c.employeeId)?.name + ': ' : '';
        if (d < 0) add('danger', 'shield-check', `${who}${c.name} expired`, '#/compliance');
        else if (d <= 30) add('warning', 'shield-check', `${who}${c.name} expires in ${d} days`, '#/compliance');
      }
      for (const ins of store.list('inspections', (x) => x.result === 'scheduled' && ui.daysUntil(x.date) >= 0 && ui.daysUntil(x.date) <= 7)) {
        const j = jobById.get(ins.jobId);
        add('info', 'calendar', `${ins.type} inspection ${ui.daysUntil(ins.date) === 0 ? 'today' : 'on ' + ui.fmtDate(ins.date)}${j ? ' · ' + j.title : ''}`, '#/compliance');
      }
      for (const l of openLeads.filter((x) => x.nextActionAt && ui.daysUntil(x.nextActionAt) <= 0)) {
        add('accent', 'funnel', `Follow up: ${l.title} (${l.contactName || 'lead'})`, '#/leads');
      }
      for (const it of switchOn(settings, 'inventory') ? store.list('items', (x) => x.reorderPoint > 0) : []) {
        const total = Object.values(it.stock || {}).reduce((s, q) => s + (Number(q) || 0), 0);
        if (total < it.reorderPoint) add('warning', 'box', `Low stock: ${it.name} (${total} ${it.unit})`, '#/inventory');
      }
      // Company set-up that invoices and the code book depend on.
      if (auth.can('settings')) {
        const co = settings.company || {};
        if (!co.province) add('warning', 'settings', 'Set your province: it picks the code amendments, permit authority and sales tax', '#/settings');
        else if (!co.gstHstNo && store.count('invoices') > 0) add('info', 'settings', 'Add your GST/HST number in Settings so it prints on invoices', '#/settings');
      }
      const queued = store.count('outbox', (o) => o.status === 'queued');
      if (queued) add('info', 'send', `${queued} follow-up message${queued > 1 ? 's' : ''} waiting in the outbox`, '#/sequences');
      // Material requests: what the office still has to order.
      if (auth.isManager()) {
        const waiting = store.count('materialRequests', (r) => (r.status || 'requested') === 'requested');
        const toOrder = store.count('materialRequests', (r) => r.status === 'sent');
        if (toOrder) add('accent', 'truck', `${toOrder} material request${toOrder === 1 ? '' : 's'} to order`, '#/materials');
        else if (waiting) add('info', 'truck', `${waiting} material request${waiting === 1 ? '' : 's'} going to the office at the next send`, '#/materials');
      }
      const toneOrder = { danger: 0, warning: 1, accent: 2, info: 3 };
      // Alerts about turned-off modules are left out (Settings → Modules).
      alerts.splice(0, alerts.length, ...alerts.filter((a) => allowed(a.href)));
      alerts.sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone]);
      const priorities = dashboardActions({ settings, can: (p) => auth.can(p), seesMoney: moneyVisible, day, jobs,
        estimates: allowed('#/estimates') ? store.list('estimates') : [],
        schedule: allowed('#/schedule') ? store.list('schedule') : [],
        tasks: allowed('#/workplan') ? store.list('workTasks', null, { omit: ['photos'] }) : [],
        overdue: overdue.map((i) => ({ ...i, balanceCents: shown.get(i.id).balanceCents })),
        tmSources: moneyVisible && allowed('#/invoices') ? { ...tmSources(store), dayOf: ui.localDay } : {}, money });
      const attentionRows = [...priorities, ...alerts.map((a) => ({ ...a, title: a.text, action: 'Review' }))]
        .sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone]);
      const actionRow = (a) => h('a', { class: 'dash-action', href: a.href },
        h('span', { class: ['dash-action-icon', a.tone], 'aria-hidden': 'true' }, ui.icon(a.iconName, 19)),
        h('span', { class: 'dash-action-copy' }, h('strong', null, a.title), a.detail ? h('span', null, a.detail) : null),
        h('span', { class: 'dash-action-label' }, a.action, ui.icon('chevron-right', 16)));
      const alertList = h('div', { class: 'dash-actions' }, attentionRows.length ? [
        attentionRows.slice(0, 5).map(actionRow),
        attentionRows.length > 5 ? detail('attention', `Show ${attentionRows.length - 5} more items`, attentionRows.slice(5).map(actionRow)) : null,
      ] : h('div', { class: 'dash-clear' }, ui.icon('check', 22), h('div', null,
        h('strong', null, "You're up to date"), h('p', null, 'No action items in the modules you can access.'))));

      // ---- recent drawings ----
      const drawings = store.list('drawings', null, { omit: ['underlay', 'strokes', 'texts', 'rooms'] }).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 4);
      const drawingCards = auth.can('drawings') && on('drawings') ? h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' } },
        drawings.map((d) => h('a', { class: 'card click', href: `#/drawings/${d.id}`, style: { padding: '8px', color: 'inherit', textDecoration: 'none' } },
          h('div', { class: 'dash-thumb', style: { aspectRatio: '4 / 3', borderRadius: '12px', background: 'var(--paper)', border: '1px solid var(--border)', backgroundSize: 'cover', backgroundPosition: 'center', backgroundImage: d.thumb ? `url(${d.thumb})` : 'none', display: 'grid', placeItems: 'center', color: 'var(--text-muted)' } }, d.thumb ? null : ui.icon('pen', 28)),
          h('div', { style: { padding: '8px 4px 2px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, d.name),
          h('div', { class: 'muted', style: { padding: '0 4px', fontSize: '12px' } }, jobById.get(d.jobId)?.number || 'No job'))),
        h('a', { class: 'card click', href: '#/drawings/new', style: { display: 'grid', placeItems: 'center', minHeight: '160px', borderStyle: 'dashed', color: 'var(--text-muted)', textDecoration: 'none' } },
          h('div', { class: 'stack', style: { alignItems: 'center', gap: '6px' } }, ui.icon('plus', 28), 'New drawing'))) : null;

      // ---- activity ----
      const log = allowed('#/security') ? store.list('auditLog').slice(0, 8) : [];
      const activity = log.length ? h('div', { class: 'list' }, log.map((a) => h('div', { class: 'list-row' },
        h('span', { class: 'avatar', style: { background: empById.get(a.userId)?.color || '#5f5a51', width: '28px', height: '28px', fontSize: '11px' } }, ui.initials(empById.get(a.userId)?.name || 'System')),
        h('div', { class: 'grow' }, h('div', null, h('strong', null, empById.get(a.userId)?.name || 'System'), ` ${a.action} ${a.collection === 'app' ? '' : a.collection.replace(/s$/, '')} `, h('span', { class: 'muted' }, a.summary)),
          h('div', { class: 'meta' }, ui.fmtDateTime(a.at)))))) : null;

      const wp = allowed('#/workplan') && allowed('#/today') && auth.can('kpis') ? workplanTiles(ctx) : null;
      const hours = allowed('#/time') ? weekHoursTile(ctx) : null;
      root.append(ui.page({
        title: 'Today',
        subtitle: [`${hello}, ${me.name.split(' ')[0]}`, new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }), settings.company?.name].filter(Boolean).join(' · '),
        actions: [
          allowed('#/leads') ? ui.button('New lead', { icon: 'funnel', href: '#/leads?new=1' }) : null,
          allowed('#/estimates') ? ui.button('New quote', { icon: 'file-text', variant: 'primary', href: '#/estimates/new' }) : null,
        ].filter(Boolean),
      },
      h('div', { class: 'dash-layout' },
        h('section', { class: 'dash-focus', 'aria-labelledby': 'dash-attention-title' },
          h('div', { class: 'dash-section-head' }, h('h2', { id: 'dash-attention-title' }, 'Needs attention'),
            attentionRows.length ? h('span', { class: 'dash-count', 'aria-label': `${attentionRows.length} action items` }, attentionRows.length) : null),
          h('p', { class: 'dash-section-intro' }, 'Keep work moving. Review a blocker, plan the next visit, or follow up.'), alertList),
        allowed('#/schedule') && allowed('#/jobs') ? h('section', { class: 'dash-sites', 'aria-labelledby': 'dash-sites-title' },
          h('div', { class: 'dash-section-head' }, h('h2', { id: 'dash-sites-title' }, 'Today on site'),
            ui.button('Schedule', { href: '#/schedule', variant: 'ghost', icon: 'calendar' })), today) : null),
      clockCard ? h('div', { class: 'dash-clock-wrap' }, clockCard) : null,
      onboardingCard(ctx),
      detail('overview', 'Business overview', stats),
      wp || hours ? detail('crew', 'Crew progress & hours', wp, hours) : null,
      drawingCards ? detail('drawings', 'Recent plans & drawings', drawingCards) : null,
      activity ? detail('activity', 'Recent activity', activity) : null));
    };

    draw();
    // keep the clock line ticking without redrawing everything
    timer = setInterval(() => {
      const el = root.querySelector('#dash-clock');
      const open = store.list('timeEntries', (e) => !e.clockOut && e.employeeId === auth.current().id)[0];
      if (el && open) el.textContent = ui.fmtHours(entryHours(open)) + ` since ${ui.fmtTime(open.clockIn)}`;
    }, 30000);
    let pending = null;
    const off = store.on('*', () => { clearTimeout(pending); pending = setTimeout(draw, 50); });
    return () => { clearInterval(timer); clearTimeout(pending); off(); };
  },
};
