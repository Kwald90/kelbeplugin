// HQ overview: companies, active users, MRR, trials ending, open incidents, health.
import { get } from '../api.js';
import { TONE, ago, duration, sha } from '../fmt.js';

export default {
  render(root, { ui, nav }) {
    const { h } = ui;
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    const stamp = h('span', { class: 'muted hq-small' });
    root.append(ui.page({ title: 'Overview', subtitle: 'Fishtape at a glance', actions: [stamp, ui.button('Refresh', { size: 'sm', onClick: () => load() })] }, body));

    async function load() {
      let o;
      try { o = await get('/api/hq/overview'); } catch (e) { ui.clear(body); body.append(ui.empty({ icon: 'alert', title: 'Could not load', text: e.message })); return; }
      stamp.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      ui.clear(body);
      const hl = o.health;
      body.append(h('a', { class: ['hq-banner', hl.level], href: '#/health', style: { textDecoration: 'none' } },
        ui.icon(hl.level === 'ok' ? 'check' : 'alert', 20),
        h('div', null,
          h('strong', null, hl.level === 'ok' ? 'All systems normal' : hl.level === 'down' ? 'Service down' : 'Needs attention'),
          h('span', { class: 'hq-small' }, `${hl.environment} · v${hl.version} · ${sha(hl.gitSha)} · up ${duration(hl.uptimeSeconds)} · DB ${hl.dbLatencyMs ?? '—'} ms`),
          hl.problems.length ? h('ul', null, hl.problems.map((p) => h('li', null, p))) : null)));

      body.append(h('div', { class: 'grid hq-stats' },
        ui.stat({ label: 'Companies', value: o.tenants.active, hint: `${o.tenants.total} total · ${o.tenants.suspended} suspended · ${o.tenants.closed} closing` }),
        ui.stat({ label: 'Active users', value: o.activeUsers.week, hint: `7 days · ${o.activeUsers.day} today · ${o.activeUsers.month} in 30 days` }),
        ui.stat({ label: 'MRR (estimate)', value: ui.fmtMoney(o.mrrCents, { whole: true }), hint: `${o.tenants.paying} paying · CAD`, tone: 'success' }),
        ui.stat({ label: 'On trial', value: o.tenants.onTrial, hint: `${o.trialsEnding.length} ending in 14 days` }),
        ui.stat({ label: 'Past due', value: o.pastDue, hint: `${o.failedPayments30d} failed payments in 30 days`, tone: o.pastDue ? 'danger' : null }),
        ui.stat({ label: 'Open incidents', value: o.incidents.length, tone: o.incidents.length ? 'danger' : null }),
        ui.stat({ label: 'Enterprise leads', value: o.leads.new, hint: `new · ${o.leads.open} open` }),
        ui.stat({ label: 'Self-service sign-up', value: o.signupOpen ? 'Open' : 'Closed', hint: 'Feature flag signup_open' })));

      body.append(h('div', { class: 'grid-2' },
        h('div', null, ...ui.section('Trials ending soon', o.trialsEnding.length
          ? h('div', { class: 'list' }, o.trialsEnding.map((t) => h('div', { class: 'list-row click', tabindex: 0, onClick: () => nav(`tenants/${t.id}`) },
            h('div', { class: 'grow' }, h('div', { class: 'title' }, t.name), h('div', { class: 'meta' }, `Trial ends ${ui.fmtDate(t.trialEndsAt)}`)),
            ui.badge(ago(t.trialEndsAt), 'warning'))))
          : h('div', { class: 'card flat muted' }, 'No trials end in the next 14 days.'))),
        h('div', null, ...ui.section('Open incidents', o.incidents.length
          ? h('div', { class: 'list' }, o.incidents.map((i) => h('div', { class: 'list-row click', tabindex: 0, onClick: () => nav('compliance/incidents') },
            ui.badge(i.severity.toUpperCase(), TONE[i.severity]), h('div', { class: 'grow' }, h('div', { class: 'title' }, `INC-${i.number} ${i.title}`), h('div', { class: 'meta' }, `Opened ${ago(i.openedAt)}`)),
            ui.badge(i.status, TONE[i.status]))))
          : h('div', { class: 'card flat muted' }, 'No open incidents.')))));
    }

    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    return () => clearInterval(timer);
  },
};
