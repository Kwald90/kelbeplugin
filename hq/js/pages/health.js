// Developer health: every environment's version, then this server's database, migrations,
// queue, backups, deploys, errors, TLS, disk and memory. Refreshes every 15 s while visible.
import { get } from '../api.js';
import { TONE, ago, bytes, duration, ms, pct, sha } from '../fmt.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) el.append(k);
  return el;
};

/** Requests per minute for the last hour, with the 5xx share stacked at the baseline. */
function minuteChart(ui, perMinute) {
  const W = 600, H = 80, n = perMinute.length, slot = W / n, barW = slot - 2;
  const max = Math.max(1, ...perMinute.map((m) => m.requests));
  const chart = svg('svg', { class: 'hq-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Requests per minute, last hour. Peak ${max}.` });
  chart.append(svg('line', { class: 'base', x1: 0, x2: W, y1: H - 0.5, y2: H - 0.5 }));
  perMinute.forEach((m, i) => {
    const x = i * slot + 1;
    const errH = (m.errors5xx / max) * (H - 4);
    const okH = ((m.requests - m.errors5xx) / max) * (H - 4);
    const g = svg('g');
    const time = new Date(m.t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    g.append(svg('title', {}, `${time}: ${m.requests} requests, ${m.errors5xx} server errors, ${m.errors4xx} client errors`));
    g.append(svg('rect', { class: 'hit', x: i * slot, y: 0, width: slot, height: H }));
    if (okH > 0) g.append(svg('rect', { class: 'req', x, y: H - errH - okH - (errH > 0 ? 1 : 0), width: barW, height: Math.max(okH, 1), rx: 1 }));
    if (errH > 0) g.append(svg('rect', { class: 'err', x, y: H - errH, width: barW, height: Math.max(errH, 2), rx: 1 }));
    chart.append(g);
  });
  return ui.h('div', { class: 'stack', style: { gap: '6px' } },
    chart,
    ui.h('div', { class: 'hq-legend' }, ui.h('span', null, ui.h('i', { class: 'req' }), 'Requests'), ui.h('span', null, ui.h('i', { class: 'err' }), 'Server errors (5xx)'),
      ui.h('span', { class: 'grow' }), ui.h('span', null, `60 min · peak ${max}/min`)));
}

export default {
  render(root, { ui }) {
    const { h } = ui;
    let auto = true;
    let busy = false;
    const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
    const stamp = h('span', { class: 'muted hq-small' });
    const autoBox = h('label', { class: 'field check' }, h('input', { type: 'checkbox', checked: true, onChange: (e) => { auto = e.target.checked; } }), h('span', null, 'Auto-refresh'));
    root.append(ui.page({ title: 'Developer health', subtitle: 'This server and every environment', actions: [stamp, autoBox, ui.button('Refresh', { size: 'sm', onClick: () => load() })] }, body));

    const kv = (pairs) => h('dl', { class: 'hq-kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v ?? '—')]));
    const card = (title, icon, ...kids) => h('div', { class: 'card' }, h('h3', null, ui.icon(icon, 18), title), ...kids);
    const yes = (b, good = 'OK', bad = 'Problem') => ui.badge(b ? good : bad, b ? 'success' : 'danger');
    const bar = (label, value, max = 100) => {
      const v = Math.max(0, Math.min(100, Number(value) || 0));
      return h('div', { class: 'hq-bar' }, h('span', null, label), h('div', { class: ['progress', v > 90 ? 'bad' : v > 75 ? 'warn' : ''] }, h('i', { style: { width: `${(v / max) * 100}%` } })), h('span', { class: 'right num' }, pct(value)));
    };

    function draw(d) {
      ui.clear(body);
      const s = d.summary;
      body.append(h('div', { class: ['hq-banner', s.level] }, ui.icon(s.level === 'ok' ? 'check' : 'alert', 20),
        h('div', null, h('strong', null, s.level === 'ok' ? 'Healthy' : s.level === 'down' ? 'Down' : 'Degraded'),
          s.problems.length ? h('ul', null, s.problems.map((p) => h('li', null, p))) : h('span', { class: 'hq-small' }, 'No problems found.'))));

      // environments
      const envRows = [{ name: `${d.environment} (this server)`, url: d.publicOrigin, ok: d.database.ok, status: s.level, version: d.version, gitSha: d.gitSha, ms: d.database.latencyMs, self: true }, ...d.environments];
      body.append(...ui.section('Environments', ui.table({
        columns: [
          { key: 'name', label: 'Environment', render: (e) => h('strong', null, e.name) },
          { key: 'url', label: 'URL', render: (e) => h('span', { class: 'mono hq-small' }, e.url || '—') },
          { key: 'status', label: 'Status', render: (e) => ui.badge(e.status || (e.ok ? 'ok' : 'unreachable'), TONE[e.status] || (e.ok ? 'success' : 'danger')) },
          { key: 'version', label: 'Version', render: (e) => (e.version ? `v${e.version}` : '—') },
          { key: 'sha', label: 'Git SHA', render: (e) => h('span', { class: 'mono' }, sha(e.gitSha)) },
          { key: 'ms', label: 'Response', align: 'right', render: (e) => (e.self ? `DB ${ms(e.ms)}` : ms(e.ms)) },
        ],
        rows: envRows,
      }), d.environments.length ? null : h('p', { class: 'muted hq-small' }, 'Set HQ_ENVIRONMENTS (name=https://origin, comma separated) to see the other environments here.')));

      const q = d.queue;
      const e = d.errors;
      body.append(h('div', { class: 'hq-cards', style: { marginTop: '16px' } },
        card('Server', 'zap', kv([
          ['Environment', d.environment], ['Version', `v${d.version}`], ['Git SHA', h('span', { class: 'mono' }, d.gitSha)], ['Uptime', duration(d.uptimeSeconds)],
          ['Node', d.node], ['Host', `${d.host} (pid ${d.pid})`],
        ])),
        card('Database', 'box', kv([
          ['Status', yes(d.database.ok)], ['Latency', ms(d.database.latencyMs)], ['Postgres', d.database.version], ['Size', bytes(d.database.sizeBytes)],
          ['App pool', `${d.database.pool.total} open · ${d.database.pool.idle} idle · ${d.database.pool.waiting} waiting · max ${d.database.pool.max ?? '—'}`],
          d.database.hqPool ? ['HQ pool', `${d.database.hqPool.total} open · ${d.database.hqPool.idle} idle · ${d.database.hqPool.waiting} waiting`] : null,
        ])),
        card('Migrations', 'layers', d.migrations ? kv([
          ['Applied', d.migrations.current], ['Latest', d.migrations.latest],
          ['Pending', d.migrations.pending.length ? ui.badge(`${d.migrations.pending.length} pending`, 'danger') : ui.badge('none', 'success')],
        ]) : h('p', { class: 'muted' }, 'Database unreachable.')),
        card('Queue', 'list', q ? kv([
          ['Queued', `${q.queued} (${q.due} due)`], ['Running', q.running], ['Lag', duration(q.lagSeconds)],
          ['Failed', h('span', null, q.failed24h ? ui.badge(`${q.failed24h} in 24 h`, 'danger') : ui.badge('none in 24 h', 'success'), ` · ${q.failedTotal} kept`)],
        ]) : h('p', { class: 'muted' }, 'Database unreachable.')),
        card('Last backup', 'save', d.backup.configured ? (d.backup.error ? h('p', { class: 'muted' }, `BACKUP_STATUS_FILE is ${d.backup.error}.`) : kv([
          ['When', d.backup.at ? `${ui.fmtDateTime(d.backup.at)} (${ago(d.backup.at)})` : '—'],
          ['Result', d.backup.ok == null ? '—' : yes(d.backup.ok, 'OK', 'Failed')],
          ['Fresh', d.backup.stale ? ui.badge('Stale (over 26 h)', 'danger') : ui.badge('Yes', 'success')],
          ['Size', bytes(d.backup.sizeBytes)], ['Target', d.backup.target], d.backup.message ? ['Message', d.backup.message] : null,
        ])) : h('p', { class: 'muted' }, 'Set BACKUP_STATUS_FILE to the JSON the backup script writes.')),
        card('TLS certificate', 'lock', d.tls.checked ? kv([
          ['Host', d.tls.host || d.tls.source], ['Expires', `${ui.fmtDate(d.tls.validTo)} (${d.tls.daysLeft} days)`],
          ['Issuer', d.tls.issuer], d.tls.authorized === false ? ['Trust', ui.badge(d.tls.authorizationError || 'not trusted', 'danger')] : null,
        ]) : h('p', { class: 'muted' }, `Not checked: ${d.tls.reason}.`)),
        card('Disk', 'box', ...d.disk.map((x) => (x.error ? h('p', { class: 'muted' }, `${x.path}: ${x.error}`) : h('div', { class: 'stack', style: { gap: '4px' } },
          bar(x.path.length > 16 ? `…${x.path.slice(-15)}` : x.path, x.usedPct), h('span', { class: 'muted hq-small' }, `${bytes(x.freeBytes)} free of ${bytes(x.totalBytes)}`))))),
        card('Memory', 'activity', kv([
          ['Process', `${bytes(d.memory.rssBytes)} RSS · heap ${bytes(d.memory.heapUsedBytes)} / ${bytes(d.memory.heapTotalBytes)}`],
          ['System', bar('used', d.memory.systemUsedPct)], ['Load', `${d.memory.loadAvg.join(' · ')} (${d.memory.cpus} CPUs)`],
        ]))));

      // errors
      const row = (label, w) => [label, w.requests, w.errors4xx, w.errors5xx, pct(w.errorRate), ms(w.p50Ms), ms(w.p95Ms), ms(w.maxMs)];
      body.append(...ui.section('Requests and errors', h('div', { class: 'card stack' },
        minuteChart(ui, e.perMinute),
        h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
          h('thead', null, h('tr', null, ['Window', 'Requests', '4xx', '5xx', '5xx rate', 'p50', 'p95', 'Slowest'].map((x, i) => h('th', { class: i ? 'right' : null }, x)))),
          h('tbody', null, [row('Last 5 min', e.last5m), row('Last hour', e.lastHour), row('Last 24 h', e.last24h)].map((r) => h('tr', null, r.map((c, i) => h('td', { class: i ? 'right num' : null }, String(c)))))))),
        h('span', { class: 'muted hq-small' }, `Counted in this API process since ${ui.fmtDateTime(e.since)}. Latency percentiles are bucketed.`))));
      if (e.errorRoutes.length) {
        body.append(...ui.section('Server errors by route', ui.table({ columns: [{ key: 'route', label: 'Route', render: (r) => h('span', { class: 'mono hq-small' }, r.route) }, { key: 'count', label: '5xx', align: 'right' }], rows: e.errorRoutes })));
      }

      if (q?.byKind.length) {
        body.append(...ui.section('Jobs by kind', ui.table({
          columns: [{ key: 'kind', label: 'Kind', render: (k) => h('span', { class: 'mono' }, k.kind) }, { key: 'queued', label: 'Queued', align: 'right' }, { key: 'running', label: 'Running', align: 'right' }, { key: 'failed7d', label: 'Failed (7 d)', align: 'right' }],
          rows: q.byKind,
        })));
      }
      if (q?.failed.length) {
        body.append(...ui.section('Failed jobs', ui.table({
          columns: [
            { key: 'id', label: '#', render: (j) => String(j.id) }, { key: 'kind', label: 'Kind', render: (j) => h('span', { class: 'mono' }, j.kind) },
            { key: 'attempts', label: 'Attempts', render: (j) => `${j.attempts}/${j.maxAttempts}` }, { key: 'at', label: 'Failed', render: (j) => ago(j.finishedAt) },
            { key: 'err', label: 'Last error', render: (j) => h('span', { class: 'hq-small' }, j.lastError || '—') },
          ],
          rows: q.failed,
        })));
      }

      body.append(...ui.section('Recent deploys', d.deploys.configured
        ? (d.deploys.error ? h('div', { class: 'card flat muted' }, `DEPLOY_LOG_FILE is ${d.deploys.error}.`) : ui.table({
          columns: [
            { key: 'at', label: 'When', render: (x) => (x.at && !Number.isNaN(Date.parse(x.at)) ? `${ui.fmtDateTime(x.at)} (${ago(x.at)})` : x.at || '—') },
            { key: 'env', label: 'Env', render: (x) => x.environment || '—' }, { key: 'sha', label: 'SHA', render: (x) => h('span', { class: 'mono' }, sha(x.sha)) },
            { key: 'ok', label: 'Result', render: (x) => (x.ok == null ? '—' : yes(x.ok, 'OK', 'Failed')) }, { key: 'msg', label: 'Note', render: (x) => x.message || x.ref || '—' },
          ],
          rows: d.deploys.items,
          empty: h('div', { class: 'card flat muted' }, 'No deploys logged yet.'),
        }))
        : h('div', { class: 'card flat muted' }, 'Set DEPLOY_LOG_FILE to the log the deploy script appends to (JSON lines).')));

      body.append(...ui.section('Last 24 hours by hour', ui.table({
        columns: [
          { key: 't', label: 'Hour', render: (x) => new Date(x.t).toLocaleString([], { weekday: 'short', hour: 'numeric' }) },
          { key: 'requests', label: 'Requests', align: 'right' }, { key: 'errors4xx', label: '4xx', align: 'right' }, { key: 'errors5xx', label: '5xx', align: 'right' },
        ],
        rows: [...e.perHour].reverse().filter((x) => x.requests),
        empty: h('div', { class: 'card flat muted' }, 'No requests counted yet.'),
      })));
    }

    async function load() {
      if (busy) return;
      busy = true;
      try {
        const d = await get('/api/hq/dev-health');
        draw(d);
        stamp.textContent = `Checked ${new Date(d.checkedAt).toLocaleTimeString()}`;
      } catch (e) {
        stamp.textContent = `Check failed: ${e.message}`;
      } finally { busy = false; }
    }

    load();
    const timer = setInterval(() => { if (auto && !document.hidden) load(); }, 15_000);
    return () => clearInterval(timer);
  },
};
