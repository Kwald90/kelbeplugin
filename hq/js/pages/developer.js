// Developer: environment and version, the OpenAPI explorer (read-only, by tag), API usage
// per company and per API key, webhook deliveries, recent server errors, and links to
// developer health and feature flags. #/developer/<tab>.
import { get } from '../api.js';
import { ago, duration, sha } from '../fmt.js';
import { card, kv, loader } from '../kit.js';

const TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'api', label: 'API explorer' }, { id: 'usage', label: 'API usage' },
  { id: 'webhooks', label: 'Webhooks' }, { id: 'errors', label: 'Server errors' },
];
const METHOD_TONE = { get: 'info', post: 'success', put: 'warning', patch: 'warning', delete: 'danger' };

export default {
  render(root, { ui, params, nav }) {
    const { h } = ui;
    const tab = TABS.some((t) => t.id === params[0]) ? params[0] : 'overview';
    const body = h('div', { class: 'stack' });
    root.append(ui.page({ title: 'Developer', subtitle: 'API, usage, webhooks and errors', actions: [ui.button('Developer health', { size: 'sm', icon: 'activity', href: '#/health' }), ui.button('Feature flags', { size: 'sm', icon: 'sliders', href: '#/flags' })] },
      h('div', { class: 'hq-toolbar' }, ui.tabs(TABS, tab, (id) => nav(`developer/${id}`))), body));

    const views = {
      async overview() {
        const d = await get('/api/hq/developer');
        ui.clear(body);
        body.append(h('div', { class: 'hq-cards' },
          card(ui, 'This server', 'zap', kv(ui, [
            ['Environment', d.environment], ['Version', `v${d.version}`], ['Git SHA', h('span', { class: 'mono' }, sha(d.gitSha))],
            ['Node', d.node], ['Host', `${d.host} (pid ${d.pid})`], ['Up', `${duration(d.uptimeSeconds)} (since ${ui.fmtDateTime(d.startedAt)})`],
          ])),
          card(ui, 'Addresses', 'link', kv(ui, [
            ['App', h('span', { class: 'mono hq-small' }, d.publicOrigin)], ['HQ links in emails', h('span', { class: 'mono hq-small' }, d.hqUrl)],
            ['OpenAPI', h('a', { href: d.links.openapi, target: '_blank', rel: 'noopener' }, d.links.openapi)],
            ['Public status', h('a', { href: d.links.status, target: '_blank', rel: 'noopener' }, d.links.status)],
          ])),
          card(ui, 'Migrations', 'layers', kv(ui, [
            ['Applied', d.migrations.current], ['Latest', d.migrations.latest],
            ['Pending', d.migrations.pending.length ? ui.badge(`${d.migrations.pending.length} pending`, 'danger') : ui.badge('none', 'success')],
          ])),
          card(ui, 'Errors', 'alert', kv(ui, [
            ['Last hour', d.errors.lastHour ? `${d.errors.lastHour.errors5xx} server errors in ${d.errors.lastHour.requests} requests` : '—'],
            ['Kept here', `${d.errors.recent.length} recent`], ['Counted since', ui.fmtDateTime(d.errors.since)],
          ]), h('div', { class: 'row' }, ui.button('See server errors', { size: 'sm', onClick: () => nav('developer/errors') })))));
      },

      async api() {
        const spec = await get('/api/hq/openapi.json');
        const ops = [];
        for (const [path, item] of Object.entries(spec.paths || {})) {
          for (const [method, op] of Object.entries(item)) {
            if (!METHOD_TONE[method]) continue;
            ops.push({ path, method, op, tag: op.tags?.[0] || 'other' });
          }
        }
        const tags = [...new Set(ops.map((o) => o.tag))].sort();
        let filter = '';
        const list = h('div', { class: 'stack' });
        const draw = () => {
          ui.clear(list);
          const f = filter.toLowerCase();
          for (const tag of tags) {
            const mine = ops.filter((o) => o.tag === tag && (!f || `${o.method} ${o.path} ${o.op.summary || ''}`.toLowerCase().includes(f)));
            if (!mine.length) continue;
            const details = h('details', { class: 'card hq-api-tag', open: Boolean(f) || tags.length < 4 },
              h('summary', null, h('strong', null, tag), ' ', ui.badge(String(mine.length))),
              h('div', { class: 'list' }, mine.map((o) => {
                const more = h('div', { class: 'hq-api-more', hidden: true },
                  o.op.description ? h('p', { class: 'hq-small' }, o.op.description) : null,
                  o.op.parameters?.length ? kv(ui, o.op.parameters.map((p) => [`${p.in} ${p.name}${p.required ? ' *' : ''}`, h('span', { class: 'mono hq-small' }, JSON.stringify(p.schema || {}))])) : null,
                  o.op.requestBody ? h('pre', { class: 'hq-json' }, JSON.stringify(o.op.requestBody.content?.['application/json']?.schema || o.op.requestBody, null, 2)) : null);
                return h('div', { class: 'list-row click hq-api-op', tabindex: 0, onClick: () => { more.hidden = !more.hidden; }, onKeydown: (e) => { if (e.key === 'Enter') more.hidden = !more.hidden; } },
                  h('div', { class: 'row' }, ui.badge(o.method.toUpperCase(), METHOD_TONE[o.method]), h('span', { class: 'mono hq-small grow' }, o.path), h('span', { class: 'muted hq-small' }, o.op.summary || '')),
                  more);
              })));
            list.append(details);
          }
          if (!list.children.length) list.append(h('p', { class: 'muted' }, 'Nothing matches.'));
        };
        ui.clear(body);
        body.append(h('div', { class: 'hq-toolbar' }, ui.searchBox('Filter paths and summaries', (v) => { filter = v; draw(); }), h('span', { class: 'grow' }),
          h('span', { class: 'muted hq-small' }, `${spec.info?.title || 'API'} v${spec.info?.version || ''} · ${ops.length} operations · read-only`)), list);
        draw();
      },

      async usage() {
        const u = await get('/api/hq/developer/usage?days=30');
        ui.clear(body);
        const total = u.daily.reduce((a, d) => a + d.requests, 0);
        body.append(h('div', { class: 'grid hq-stats' },
          ui.stat({ label: 'Requests (30 d)', value: ui.fmtNum(total), hint: 'Signed-in requests with a company' }),
          ui.stat({ label: 'With API keys', value: ui.fmtNum(u.daily.reduce((a, d) => a + d.apiKeyRequests, 0)) }),
          ui.stat({ label: 'Companies calling', value: u.companies.length }),
          ui.stat({ label: 'API keys used', value: u.keys.length })));
        body.append(...ui.section('By company', ui.table({
          columns: [
            { key: 'co', label: 'Company', render: (c) => h('a', { href: `#/tenants/${c.tenantId}` }, c.tenantName), sort: (c) => c.tenantName },
            { key: 'req', label: 'Requests', align: 'right', render: (c) => ui.fmtNum(c.requests), sort: (c) => c.requests },
            { key: 'key', label: 'Via API keys', align: 'right', render: (c) => ui.fmtNum(c.apiKeyRequests), sort: (c) => c.apiKeyRequests },
            { key: 'e4', label: '4xx', align: 'right', render: (c) => ui.fmtNum(c.errors4xx) },
            { key: 'e5', label: '5xx', align: 'right', render: (c) => (c.errors5xx ? ui.badge(String(c.errors5xx), 'danger') : '0') },
          ],
          rows: u.companies,
          empty: h('div', { class: 'card flat muted' }, 'No requests counted yet. Counts are written every 30 seconds.'),
        })));
        body.append(...ui.section('By API key', ui.table({
          columns: [
            { key: 'name', label: 'Key', render: (k) => h('div', null, h('strong', null, k.name), h('div', { class: 'muted hq-small mono' }, k.prefix ? `${k.prefix}…` : '')) },
            { key: 'co', label: 'Company', render: (k) => k.tenantName },
            { key: 'state', label: 'State', render: (k) => (k.revoked ? ui.badge('revoked', 'neutral') : ui.badge('active', 'success')) },
            { key: 'req', label: 'Requests', align: 'right', render: (k) => ui.fmtNum(k.requests), sort: (k) => k.requests },
            { key: 'err', label: 'Errors', align: 'right', render: (k) => `${k.errors4xx} / ${k.errors5xx}` },
            { key: 'last', label: 'Last used', render: (k) => (k.lastUsedAt ? ago(k.lastUsedAt) : '—') },
          ],
          rows: u.keys,
          empty: h('div', { class: 'card flat muted' }, 'No API key has been used in 30 days.'),
        })));
      },

      async webhooks() {
        const w = await get('/api/hq/developer/webhooks');
        ui.clear(body);
        body.append(h('div', { class: 'grid hq-stats' }, ['stripe', 'twilio', 'facebook'].map((p) => {
          const r = w.byProvider.find((x) => x.provider === p);
          return ui.stat({ label: `${p[0].toUpperCase()}${p.slice(1)} (companies, 7 d)`, value: r ? r.last7Days : 0, hint: r?.lastAt ? `last ${ago(r.lastAt)}` : 'none' });
        }), ui.stat({ label: 'Fishtape Stripe events', value: w.platform.length, hint: w.platform[0] ? `last ${ago(w.platform[0].at)}` : 'none yet' })));
        body.append(...ui.section("Fishtape's own Stripe (subscriptions)", ui.table({
          columns: [
            { key: 'at', label: 'Received', render: (e) => ui.fmtDateTime(e.at) },
            { key: 'type', label: 'Event', render: (e) => h('span', { class: 'mono hq-small' }, e.type) },
            { key: 'co', label: 'Company', render: (e) => e.tenantName || '—' },
            { key: 'outcome', label: 'Outcome', render: (e) => ui.badge(e.outcome.replace(/_/g, ' '), e.outcome === 'applied' ? 'success' : e.outcome === 'unknown_customer' ? 'warning' : 'neutral') },
            { key: 'id', label: 'Id', render: (e) => h('span', { class: 'mono hq-small muted' }, e.id) },
          ],
          rows: w.platform,
          empty: h('div', { class: 'card flat muted' }, 'No events yet.'),
        })));
        body.append(...ui.section("Companies' integrations (Stripe payments, Twilio, Facebook)", ui.table({
          columns: [
            { key: 'at', label: 'Received', render: (e) => ui.fmtDateTime(e.at) },
            { key: 'co', label: 'Company', render: (e) => h('a', { href: `#/tenants/${e.tenantId}` }, e.tenantName) },
            { key: 'p', label: 'Provider', render: (e) => e.provider },
            { key: 'kind', label: 'Kind', render: (e) => h('span', { class: 'mono hq-small' }, e.kind || '—') },
            { key: 'id', label: 'Event id', render: (e) => h('span', { class: 'mono hq-small muted' }, e.eventId) },
          ],
          rows: w.company,
          empty: h('div', { class: 'card flat muted' }, 'No webhook deliveries in the last 90 days.'),
        })), h('p', { class: 'muted hq-small' }, 'Each delivery is kept by id for 90 days so a retry is applied once. Payloads are not stored.'));
      },

      async errors() {
        const d = await get('/api/hq/developer');
        ui.clear(body);
        body.append(...ui.section('Recent server errors (this process)', ui.table({
          columns: [
            { key: 'at', label: 'When', render: (e) => `${ui.fmtDateTime(e.at)} (${ago(e.at)})` },
            { key: 'route', label: 'Route', render: (e) => h('span', { class: 'mono hq-small' }, `${e.method} ${e.route}`) },
            { key: 'status', label: 'Status', render: (e) => ui.badge(String(e.status), 'danger') },
            { key: 'code', label: 'Code', render: (e) => h('span', { class: 'mono hq-small' }, e.code || '—') },
            { key: 'ms', label: 'Time', align: 'right', render: (e) => `${e.ms} ms` },
            { key: 'id', label: 'Request id (find it in the logs)', render: (e) => h('span', { class: 'mono hq-small muted' }, e.requestId) },
          ],
          rows: d.errors.recent,
          empty: h('div', { class: 'card flat muted' }, `No server errors since ${ui.fmtDateTime(d.errors.since)}.`),
        })));
        if (d.errors.byRoute.length) {
          body.append(...ui.section('Server errors by route (24 h)', ui.table({ columns: [{ key: 'route', label: 'Route', render: (r) => h('span', { class: 'mono hq-small' }, r.route) }, { key: 'count', label: '5xx', align: 'right' }], rows: d.errors.byRoute })));
        }
        body.append(h('p', { class: 'muted hq-small' }, 'Kept in memory by each API process: time, route pattern, status, error code and request id only.'));
      },
    };

    loader(ui, body, views[tab]);
    return () => {};
  },
};
