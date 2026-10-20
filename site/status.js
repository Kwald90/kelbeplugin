// Public status page (fishtapehq.com/status and status.fishtapehq.com). Reads public endpoints
// only: GET /api/v1/public/status (components, 90-day uptime, the notices HQ admins post in
// HQ > Status notices), and /api/v1/status for the version line. Falls back to /api/v1/status +
// /api/readyz while the new endpoint isn't there. Everything is rendered with textContent.
import {
  IMPACT, NOTICE_STATUS, OVERALL, STATE_CLASS, STATE_TEXT,
  componentNames, dayClass, dayTitle, fmtPct, fromLegacy, fromPublicStatus, parseFragment,
} from '/site/status-lib.js';

const API = document.querySelector('meta[name="fishtape-api"]')?.content.replace(/\/$/, '') || '';
const $ = (id) => document.getElementById(id);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function fetchJson(path, init = {}) {
  const res = await fetch(API + path, { cache: 'no-store', credentials: 'omit', headers: { Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(8000), ...init });
  const body = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, body };
}

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' }) : '');

function renderOverall(model) {
  const o = OVERALL[model.overall] || OVERALL.unknown;
  $('overall').className = `site-overall ${o.cls}`;
  $('overall-title').textContent = o.title;
  $('overall-sub').textContent = `Last checked ${new Date().toLocaleTimeString('en-CA')}`;
}

function renderComponents(model) {
  const items = model.components.map((c) => {
    const li = el('li', STATE_CLASS[c.status]);
    const row = el('div', 'st-row');
    const name = el('span', null, c.name);
    const state = el('strong', 'st-state', STATE_TEXT[c.status]);
    row.append(name, state);
    li.append(row);
    if (c.days.length) {
      const bar = el('div', 'st-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', `${c.name}: ${fmtPct(c.pct)} uptime over the last ${c.days.length} days`);
      for (const d of c.days) {
        const day = el('span', `st-day ${dayClass(d)}`.trim());
        day.title = dayTitle(d);
        bar.append(day);
      }
      const axis = el('div', 'st-axis');
      axis.append(el('span', null, `${c.days.length} days ago`), el('span', null, `${fmtPct(c.pct)} uptime`), el('span', null, 'Today'));
      li.append(bar, axis);
    }
    return li;
  });
  $('components').replaceChildren(...items);
}

function noticeCard(n, closed = false) {
  const card = el('article', `st-notice ${n.kind === 'maintenance' ? 'maintenance' : 'incident'} ${n.impact === 'minor' ? 'minor' : ''} ${closed ? 'closed' : ''}`.replace(/\s+/g, ' ').trim());
  card.append(el('h3', null, n.title));
  const when = n.kind === 'maintenance' && n.startsAt
    ? `${fmtTime(n.startsAt)}${n.endsAt ? ` to ${fmtTime(n.endsAt)}` : ''}`
    : `Started ${fmtTime(n.startsAt || n.createdAt)}`;
  const meta = [NOTICE_STATUS[n.status] || n.status, n.kind === 'incident' ? IMPACT[n.impact] : null, componentNames(n.components) || null, when,
    n.resolvedAt ? `${n.kind === 'maintenance' ? 'Completed' : 'Resolved'} ${fmtTime(n.resolvedAt)}` : null].filter(Boolean).join(' · ');
  card.append(el('p', 'st-meta', meta));
  if (n.updates?.length) {
    const list = el('ol', 'st-updates');
    for (const u of n.updates) {
      const li = el('li');
      li.append(el('strong', null, NOTICE_STATUS[u.status] || u.status), document.createTextNode(u.body));
      const t = el('time', null, fmtTime(u.at));
      t.dateTime = u.at;
      li.append(t);
      list.append(li);
    }
    card.append(list);
  }
  return card;
}

function renderNotices(model) {
  const { active, upcoming, recent } = model.notices;
  $('active-section').hidden = !active.length;
  $('notices-active').replaceChildren(...active.map((n) => noticeCard(n)));
  $('upcoming-section').hidden = !upcoming.length;
  $('notices-upcoming').replaceChildren(...upcoming.map((n) => noticeCard(n)));
  $('notices-recent').replaceChildren(...(recent.length ? recent.map((n) => noticeCard(n, true)) : [el('p', 'st-empty', 'No incidents or maintenance in the past 30 days.')]));
  $('subscribe').hidden = !model.subscribe;
}

function renderDetails(statusBody) {
  const b = statusBody || {};
  const pairs = [['Environment', b.environment], ['Version', b.version ? `v${b.version}` : null], ['Server time', b.time ? new Date(b.time).toLocaleString('en-CA') : null]];
  $('details').replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v ?? '—')]));
}

let firstLoad = true;
async function check() {
  const [pub, status] = await Promise.all([
    fetchJson('/api/v1/public/status').catch(() => null),
    fetchJson('/api/v1/status').catch(() => null),
  ]);
  let model;
  if (pub?.ok && Array.isArray(pub.body?.components)) {
    model = fromPublicStatus(pub.body);
  } else {
    const ready = await fetchJson('/api/readyz').catch(() => null);
    model = fromLegacy({ status, ready });
  }
  renderOverall(model);
  if (firstLoad || model.components.some((c) => c.days.length)) renderComponents(model);
  renderNotices(model);
  renderDetails(status?.body);
  firstLoad = false;
  $('status-body').classList.remove('st-loading');
}

// Subscribe by email (shown only when HQ has turned it on).
$('subscribe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (!form.reportValidity()) return;
  const msg = $('subscribe-msg');
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const r = await fetchJson('/api/v1/public/status/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fishtape': '1' }, body: JSON.stringify(data) });
    msg.textContent = r.status === 202 ? 'Check your email: we sent a link to confirm.' : r.status === 429 ? 'Too many requests from here. Try again later.' : 'Email notices are not available right now.';
  } catch {
    msg.textContent = 'We could not reach Fishtape. Try again in a moment.';
  }
  msg.hidden = false;
});

// Links from status emails: #confirm=<token> or #unsubscribe=<token>. The token stays in the
// fragment (never sent in a URL) and is posted once, then cleared from the address bar.
const frag = parseFragment(location.hash);
if (frag) {
  history.replaceState(null, '', location.pathname + location.search);
  const msg = $('fragment-msg');
  fetchJson(`/api/v1/public/status/${frag.action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fishtape': '1' }, body: JSON.stringify({ token: frag.token }) })
    .then((r) => {
      msg.textContent = frag.action === 'confirm'
        ? (r.ok ? 'You\'re subscribed. We\'ll email you about incidents and planned maintenance.' : 'That confirmation link has expired or was already used.')
        : 'You\'re unsubscribed. You won\'t get status emails from us.';
    })
    .catch(() => { msg.textContent = 'We could not reach Fishtape. Try the link again in a moment.'; })
    .finally(() => { msg.hidden = false; });
}

check();
setInterval(() => { if (!document.hidden) check(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
