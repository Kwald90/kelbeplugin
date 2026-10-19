// Public status page: reads /api/v1/status (status, version, environment, commit) and
// /api/readyz (database, migrations, queue). Both are public and carry no tenant data.
import { BRAND } from '/js/brand.js';

const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';
for (const n of document.querySelectorAll('[data-brand]')) n.textContent = BRAND.name;
document.getElementById('year').textContent = String(new Date().getFullYear());
document.title = `Status · ${BRAND.name}`;

const COMPONENTS = { api: 'API', database: 'Database', migrations: 'Schema up to date', queue: 'Background jobs' };

async function fetchJson(path) {
  const res = await fetch(API + path, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

function setText(id, text) { document.getElementById(id).textContent = text; }

function render({ status, ready }) {
  const overall = document.getElementById('overall');
  const up = status?.ok && status.body?.status === 'ok';
  const readyOk = ready?.body?.status === 'ready';
  const level = !status ? 'down' : up && readyOk ? 'ok' : up || readyOk ? 'degraded' : 'down';
  overall.className = `site-overall ${level}`;
  setText('overall-title', level === 'ok' ? 'All systems operational' : level === 'degraded' ? 'Degraded performance' : 'Service unavailable');
  setText('overall-sub', `Last checked ${new Date().toLocaleTimeString()}`);

  const checks = ready?.body?.checks || {};
  const items = [['api', Boolean(up)], ...['database', 'migrations', 'queue'].map((k) => [k, checks[k] ? Boolean(checks[k].ok) : null])];
  document.getElementById('components').replaceChildren(...items.map(([k, ok]) => {
    const li = document.createElement('li');
    li.className = ok == null ? 'unknown' : ok ? 'ok' : 'bad';
    const name = document.createElement('span');
    name.textContent = COMPONENTS[k];
    const state = document.createElement('strong');
    state.textContent = ok == null ? 'Unknown' : ok ? 'Operational' : 'Problem';
    li.append(name, state);
    return li;
  }));

  const b = status?.body || {};
  const pairs = [['Environment', b.environment], ['Version', b.version ? `v${b.version}` : null], ['Commit', b.gitSha], ['Server time', b.time ? new Date(b.time).toLocaleString() : null],
    ['Database response', checks.database?.ms != null ? `${checks.database.ms} ms` : null]];
  document.getElementById('details').replaceChildren(...pairs.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v ?? '—';
    return [dt, dd];
  }));
}

async function check() {
  const [status, ready] = await Promise.all([fetchJson('/api/v1/status').catch(() => null), fetchJson('/api/readyz').catch(() => null)]);
  render({ status, ready });
}

check();
setInterval(() => { if (!document.hidden) check(); }, 30_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
