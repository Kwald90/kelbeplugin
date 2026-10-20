// S11 Dashboard: today at a glance, plus every alert the other modules raise.
import { invoiceShown, entryHours, moneyFormatter } from '../lib/money.js';
import { provinceName } from '../lib/tax.js';
import { onboardingCard } from './onboarding.js';
import { workplanTiles } from './workplan.js';
import { weekHoursTile } from './time.js';
import { moduleOn, switchOn, linkOn } from '../lib/modules.js';
import { unbilledAcrossJobs } from '../lib/tm.js';
import { tmSources } from './jobs.js';

export default {
  id: 'dashboard',
  title: 'Dashboard',
  icon: 'home',
  group: 'home',
  perm: 'dashboard',
  render(root, ctx) {
    const { store, ui, auth } = ctx;
    const { h } = ui;
    let timer;

    // Due sequence steps are queued whenever the office opens the app (not when follow-ups are off).
    if (moduleOn(store.settings(), 'sequences')) import('./sequences.js').then((m) => m.processSequences?.(store)).catch(() => {});

    const draw = () => {
      ui.clear(root);
      const me = auth.current();
      const settings = store.settings();
      const money = moneyFormatter(settings);
      // Tiles, alerts and buttons for turned-off modules are left out (Settings → Modules).
      const on = (m) => moduleOn(settings, m);
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
      const invoices = store.list('invoices', (i) => !['void', 'draft'].includes(i.status));
      const shown = new Map(invoices.map((i) => [i.id, invoiceShown(store, i)]));
      const outstanding = invoices.reduce((s, i) => s + Math.max(0, shown.get(i.id).balanceCents), 0);
      const overdue = invoices.filter((i) => shown.get(i.id).status === 'overdue');
      const onClock = store.list('timeEntries', (e) => !e.clockOut);
      const myOpen = onClock.find((e) => e.employeeId === me.id);
      const unbilled = auth.can('invoices') && on('invoices') ? unbilledAcrossJobs(jobs.filter((j) => !['lead'].includes(j.status)), { settings, ...tmSources(store), dayOf: ui.localDay }) : null;

      const stats = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' } },
        auth.can('leads') && on('leads') ? ui.stat({ label: 'Open pipeline', value: money(pipeline, { whole: true }), hint: `${openLeads.length} open leads` }) : null,
        ui.stat({ label: 'Jobs in progress', value: String(active.length), hint: `${jobs.filter((j) => j.status === 'scheduled').length} scheduled` }),
        auth.can('invoices') && on('invoices') ? ui.stat({ label: 'Owed to you', value: money(outstanding, { whole: true }), hint: overdue.length ? `${overdue.length} overdue` : 'nothing overdue', tone: overdue.length ? 'danger' : null }) : null,
        unbilled ? h('a', { href: '#/jobs', class: 'dash-stat-link', style: { color: 'inherit', textDecoration: 'none' }, dataset: { unbilledTm: String(unbilled.cents) } },
          ui.stat({ label: 'Unbilled T&M', value: money(unbilled.cents, { whole: true }), hint: unbilled.count ? `${unbilled.count} time & material job${unbilled.count === 1 ? '' : 's'} · ${unbilled.hours} h` : 'all billed', tone: unbilled.cents ? 'accent' : null })) : null,
        on('time') ? ui.stat({ label: 'On the clock', value: String(onClock.length), hint: onClock.map((e) => empById.get(e.employeeId)?.name.split(' ')[0]).filter(Boolean).join(', ') || 'nobody yet', tone: onClock.length ? 'success' : null }) : null,
      );

      // ---- my clock ----
      const clockCard = auth.can('time') && on('time') ? h('div', { class: 'card row', style: { justifyContent: 'space-between' } },
        h('div', { class: 'row' }, h('span', { class: 'avatar', style: { background: me.color || '#5f5a51', width: '40px', height: '40px' } }, ui.initials(me.name)),
          h('div', null, h('div', { style: { fontWeight: 650 } }, myOpen ? `${myOpen.kind === 'travel' ? 'Travelling' : 'On the clock'} · ${jobById.get(myOpen.jobId)?.title || 'no job'}` : 'Not clocked in'),
            h('div', { class: 'muted num', id: 'dash-clock' }, myOpen ? ui.fmtHours(entryHours(myOpen)) + ` since ${ui.fmtTime(myOpen.clockIn)}` : 'Clock in from the time clock'))),
        ui.button(myOpen ? 'Open time clock' : 'Clock in', { variant: myOpen ? 'secondary' : 'primary', icon: 'clock', href: '#/time' })) : null;

      // ---- today's crew board ----
      const todays = store.list('schedule', (s) => s.date === day);
      const byJob = new Map();
      for (const s of todays) { if (!byJob.has(s.jobId)) byJob.set(s.jobId, []); byJob.get(s.jobId).push(s); }
      const today = h('div', { class: 'list' }, byJob.size ? [...byJob].map(([jobId, rows]) => {
        const j = jobById.get(jobId);
        return h('a', { class: 'list-row click', href: `#/jobs/${jobId}`, style: { color: 'inherit', textDecoration: 'none' } },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, j ? `${j.number} · ${j.title}` : 'Job removed'), h('div', { class: 'meta' }, j?.address || '')),
          h('div', { class: 'row', style: { gap: '4px' } }, rows.map((r) => {
            const e = empById.get(r.employeeId);
            return h('span', { class: 'avatar', title: e?.name, style: { background: e?.color || '#5f5a51', width: '28px', height: '28px', fontSize: '11px' } }, ui.initials(e?.name));
          })),
          j ? ui.statusBadge(j.status) : null);
      }) : h('div', { class: 'list-row muted' }, 'Nobody is scheduled today.'));

      // ---- alerts ----
      const alerts = [];
      const add = (tone, iconName, text, href) => alerts.push({ tone, iconName, text, href });
      for (const i of overdue) add('danger', 'receipt', `${i.number} is overdue: ${money(shown.get(i.id).balanceCents)}`, `#/invoices/${i.id}`);
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
      alerts.splice(0, alerts.length, ...alerts.filter((a) => linkOn(settings, a.href)));
      alerts.sort((a, b) => toneOrder[a.tone] - toneOrder[b.tone]);
      const alertList = h('div', { class: 'list' }, alerts.length ? alerts.slice(0, 10).map((a) =>
        h('a', { class: 'list-row click', href: a.href, style: { color: 'inherit', textDecoration: 'none' } },
          h('span', { class: ['badge', a.tone], style: { width: '30px', height: '30px', padding: 0, justifyContent: 'center', borderRadius: '50%' } }, ui.icon(a.iconName, 16)),
          h('span', { class: 'grow' }, a.text), ui.icon('chevron-right', 16))) : h('div', { class: 'list-row muted' }, 'All clear. Nothing needs you right now.'));

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
      const log = auth.can('security') ? store.list('auditLog').slice(0, 8) : [];
      const activity = log.length ? h('div', { class: 'list' }, log.map((a) => h('div', { class: 'list-row' },
        h('span', { class: 'avatar', style: { background: empById.get(a.userId)?.color || '#5f5a51', width: '28px', height: '28px', fontSize: '11px' } }, ui.initials(empById.get(a.userId)?.name || 'System')),
        h('div', { class: 'grow' }, h('div', null, h('strong', null, empById.get(a.userId)?.name || 'System'), ` ${a.action} ${a.collection === 'app' ? '' : a.collection.replace(/s$/, '')} `, h('span', { class: 'muted' }, a.summary)),
          h('div', { class: 'meta' }, ui.fmtDateTime(a.at)))))) : null;

      root.append(ui.page({
        title: `${hello}, ${me.name.split(' ')[0]}`,
        subtitle: [new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'long', day: 'numeric' }), settings.company?.name,
          settings.company?.province ? `${provinceName(settings.company.province)} · ${settings.codeBook === 'NEC-2023' ? 'NEC 2023' : 'CEC 2024'}` : null].filter(Boolean).join(' · '),
        actions: [
          auth.can('leads') && on('leads') ? ui.button('New lead', { icon: 'funnel', href: '#/leads?new=1' }) : null,
          auth.can('estimates') && on('estimates') ? ui.button('New quote', { icon: 'file-text', variant: 'primary', href: '#/estimates/new' }) : null,
        ].filter(Boolean),
      },
      onboardingCard(ctx),
      stats,
      clockCard ? h('div', { style: { marginTop: 'var(--s4)' } }, clockCard) : null,
      (() => { const t = on('time') ? weekHoursTile(ctx) : null; return t ? h('div', { style: { marginTop: 'var(--s4)' } }, t) : null; })(),
      (() => { const wp = on('workplan') ? workplanTiles(ctx) : null; return wp ? [...ui.section('Crew tasks'), wp] : null; })(),
      h('div', { class: 'grid-2', style: { marginTop: 'var(--s2)' } },
        h('div', null, ...ui.section('Needs attention'), alertList),
        on('schedule') ? h('div', null, ...ui.section('Today on site'), today) : null),
      drawingCards ? [...ui.section('Recent plans & drawings'), drawingCards] : null,
      activity ? [...ui.section('Recent activity'), activity] : null));
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
