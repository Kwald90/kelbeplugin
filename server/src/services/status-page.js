// Public service status (status.fishtapehq.com / site/status.html): the worker's probes, the
// 90-day uptime maths, incident and maintenance notices, and the public JSON. Pure pieces are
// exported for tests; routes/status-page.js (public), routes/hq-status.js (HQ) and the
// `status_probe` worker job wire them up. docs/runbooks/status-page.md explains it all.
//
// Settings come from the environment (tests pass config.status):
//   STATUS_PROBES      off | a list like "app=https://…/,api=https://…/api/readyz" that replaces
//                      the default URL of those components (the rest keep theirs)
//   HOST_STATUS_FILE   host-status.json written by deploy/*/host-status.sh (default
//                      /run/fishtape/status/host-status.json when it exists; "off" ignores it)
//   STATUS_PUBLIC_URL  the public status page, for links in emails (default PUBLIC_ORIGIN/site/status.html)
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { enqueue } from './queue.js';
import { billingSettings } from './hq-common.js';
import { mailSettings } from '../email/config.js';

const MIN = 60_000;
const DAY = 86_400_000;
export const PROBE_EVERY_MS = 5 * MIN;
/** A component whose last check is older than this shows `unknown`: stale data must not show green. */
export const STALE_MS = 20 * MIN;
/** host-status.json older than this is ignored (the timer writes it every 15 minutes). */
export const HOST_STATUS_MAX_AGE_MS = 20 * MIN;
export const UPTIME_DAYS = 90;
export const RETENTION_DAYS = 120;
export const RECENT_DAYS = 30;
export const RECENT_MAX = 20;
export const NOTIFY_CAP = 5000;
export const DEFAULT_HOST_STATUS_FILE = '/run/fishtape/status/host-status.json';

/** Fixed ids: the public site codes against them. */
export const COMPONENTS = Object.freeze([
  { id: 'app', name: 'Web app' },
  { id: 'api', name: 'API and sync' },
  { id: 'hq', name: 'HQ console' },
  { id: 'signin', name: 'Sign-in' },
  { id: 'email', name: 'Email' },
  { id: 'payments', name: 'Payments' },
]);
export const COMPONENT_IDS = COMPONENTS.map((c) => c.id);
export const HTTP_COMPONENTS = ['app', 'api', 'hq', 'signin'];
export const STATUSES = ['operational', 'degraded', 'outage', 'unknown'];

export const NOTICE_KINDS = ['incident', 'maintenance'];
export const IMPACTS = ['none', 'minor', 'major', 'maintenance'];
export const NOTICE_STATUSES = {
  incident: ['investigating', 'identified', 'monitoring', 'resolved'],
  maintenance: ['scheduled', 'in_progress', 'completed'],
};
export const ALL_NOTICE_STATUSES = [...NOTICE_STATUSES.incident, ...NOTICE_STATUSES.maintenance];
const CLOSED = new Set(['resolved', 'completed']);
export const isClosed = (status) => CLOSED.has(status);
export const STATUS_LABEL = {
  investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed',
};
export const LIMITS = { titleMax: 120, bodyMax: 2000 };

const iso = (d) => (d ? new Date(d).toISOString() : null);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

// ---- settings ------------------------------------------------------------------------------

const ORIGIN_OK = /^(https:\/\/[^\s/?#]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const URL_OK = /^(https:\/\/[^\s/?#]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^\s#]*)?$/;

/** Where the probes look by default, from PUBLIC_ORIGIN and HQ_PUBLIC_URL. */
export function defaultProbeUrls(config, env = process.env) {
  const origin = config.publicOrigin;
  let hqOrigin = origin;
  const rawHq = String(env.HQ_PUBLIC_URL || '').trim();
  if (URL_OK.test(rawHq)) {
    // Production: hq.fishtapehq.com proxies /api/healthz to hq-api. Staging and local serve HQ
    // at PUBLIC_ORIGIN/hq/, from the same API, so PUBLIC_ORIGIN/api/healthz it is.
    try { const u = new URL(rawHq); if (ORIGIN_OK.test(u.origin)) hqOrigin = u.origin; } catch { /* keep PUBLIC_ORIGIN */ }
  }
  return {
    app: `${origin}/`,
    api: `${origin}/api/readyz`,
    hq: `${hqOrigin}/api/healthz`,
    signin: `${origin}/api/v1/auth/providers`,
  };
}

/** "app=https://a/,api=https://a/api/readyz" -> { app, api }. Unknown ids and odd URLs are dropped. */
export function parseProbeList(v) {
  const out = {};
  for (const pair of String(v || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const id = pair.slice(0, i).trim();
    const url = pair.slice(i + 1).trim();
    if (HTTP_COMPONENTS.includes(id) && URL_OK.test(url)) out[id] = url;
  }
  return out;
}

/** The public status page, for links in emails (fragment links are added to it). */
export function statusPublicUrl(config, env = process.env) {
  const raw = String(env.STATUS_PUBLIC_URL || '').trim().replace(/#.*$/, '');
  return URL_OK.test(raw) ? raw : `${config.publicOrigin}/site/status.html`;
}

/** @param {{ publicOrigin: string, status?: object }} config */
export function statusSettings(config, env = process.env) {
  const raw = String(env.STATUS_PROBES || '').trim();
  const hostFile = env.HOST_STATUS_FILE !== undefined ? (env.HOST_STATUS_FILE === 'off' ? '' : env.HOST_STATUS_FILE)
    : (existsSync(DEFAULT_HOST_STATUS_FILE) ? DEFAULT_HOST_STATUS_FILE : '');
  return {
    probes: raw.toLowerCase() === 'off' ? null : { ...defaultProbeUrls(config, env), ...parseProbeList(raw) },
    timeoutMs: 5000,
    hostStatusFile: hostFile,
    publicUrl: statusPublicUrl(config, env),
    cacheSeconds: 30,
    ...(config.status || {}),
  };
}

// ---- probes --------------------------------------------------------------------------------

/**
 * An HTTP result -> a status. 2xx operational; 503 (not ready) and 429 degraded; anything
 * else, a timeout or no answer at all, outage.
 * @param {{ code?: number|null }} r
 */
export function classifyHttp(r) {
  const code = Number(r?.code) || 0;
  if (code >= 200 && code < 300) return 'operational';
  if (code === 503 || code === 429) return 'degraded';
  return 'outage';
}

/** GET one URL with a timeout. Never throws: { code } or { code: 0, error }. */
export async function probeHttp(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      method: 'GET', redirect: 'follow', cache: 'no-store',
      headers: { 'user-agent': 'Fishtape-status-probe/1', accept: 'application/json, text/html;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    try { await res.body?.cancel?.(); } catch { /* nothing to read */ }
    return { code: res.status };
  } catch (e) {
    return { code: 0, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
}

/**
 * Fishtape's own email from email_outbox counts (platform mail only, the last hour).
 * Not configured -> unknown. Many failures -> outage; some failures or stuck mail -> degraded.
 * @param {{ configured: boolean, sent: number, failed: number, stuck: number }} s
 */
export function classifyEmail({ configured, sent = 0, failed = 0, stuck = 0 }) {
  if (!configured) return 'unknown';
  const total = sent + failed;
  if (failed >= 3 && failed >= sent) return 'outage';
  if (stuck > 0 || (failed > 0 && failed / total >= 0.1)) return 'degraded';
  return 'operational';
}

const RANK = { operational: 1, degraded: 2, outage: 3 };
/** The worse of two statuses; `unknown` gives way to anything known. */
export function worse(a, b) {
  if (!RANK[a]) return RANK[b] ? b : 'unknown';
  if (!RANK[b]) return a;
  return RANK[b] > RANK[a] ? b : a;
}

/**
 * Fold the host's own probes (host-status.json `probes`: { app: 200, api: 503, hq: 0, … }, 0 =
 * no answer) into this run's results when the file is under 20 minutes old. A failing host
 * probe makes that component worse for this run, never better; unknown worker results take
 * the host's answer.
 * @param {Record<string, string>} workerResults component id -> status
 * @param {{ generatedAt?: string, probes?: Record<string, number> }|null} hostStatus
 * @param {Date} now
 */
export function mergeProbes(workerResults, hostStatus, now = new Date()) {
  const out = { ...workerResults };
  const at = Date.parse(hostStatus?.generatedAt || '');
  if (!Number.isFinite(at) || now.getTime() - at > HOST_STATUS_MAX_AGE_MS || at - now.getTime() > 5 * MIN) return out;
  const probes = hostStatus.probes;
  if (!probes || typeof probes !== 'object') return out;
  for (const id of HTTP_COMPONENTS) {
    const code = probes[id];
    if (code === undefined || code === null || !Number.isFinite(Number(code))) continue;
    out[id] = worse(out[id] || 'unknown', classifyHttp({ code: Number(code) }));
  }
  return out;
}

/** host-status.json, or null when missing or unreadable. */
export function readHostStatus(file) {
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); })])
    .finally(() => clearTimeout(timer));
}

let cachedStripe = null;
/** Fishtape's own Stripe client (STRIPE_SECRET_KEY), or null when not configured. */
function platformStripe(config) {
  const s = billingSettings(config);
  if (s.stripe) return s.stripe;
  if (!s.secretKey) return null;
  if (!cachedStripe || cachedStripe.key !== s.secretKey) {
    cachedStripe = { key: s.secretKey, client: new Stripe(s.secretKey, { maxNetworkRetries: 0, timeout: 5000, appInfo: { name: 'Fishtape status' } }) };
  }
  return cachedStripe.client;
}

/** One cheap authenticated, read-only Stripe call. */
export async function probeStripe(stripe, timeoutMs = 5000) {
  if (!stripe) return 'unknown';
  try {
    await withTimeout(stripe.accounts.retrieve(), timeoutMs);
    return 'operational';
  } catch {
    return 'outage';
  }
}

/** Platform mail (tenant_id IS NULL) in the last hour, and mail stuck over 15 minutes. */
export async function emailCounts(q) {
  const { rows } = await q.query(
    `SELECT count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 hour')::int AS sent,
            count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '1 hour')::int AS failed,
            count(*) FILTER (WHERE status IN ('queued', 'sending') AND created_at < now() - interval '15 minutes')::int AS stuck
       FROM email_outbox WHERE tenant_id IS NULL`);
  return rows[0];
}

/**
 * One probe run: measure every component, merge the host's probes, then record it
 * (status_daily +1 check per known component, status_latest) and prune old rows.
 * @param {{ query: Function, tx: Function }} db the app pool (worker)
 * @param {{ config: object, env?: object, fetchImpl?: Function, stripe?: object|null, emailConfigured?: boolean, hostStatus?: object|null, now?: Date }} deps
 */
export async function runStatusProbes(db, deps) {
  const { config, env = process.env } = deps;
  const now = deps.now || new Date();
  const s = statusSettings(config, env);
  const results = {};

  await Promise.all(HTTP_COMPONENTS.map(async (id) => {
    if (!s.probes?.[id]) { results[id] = 'unknown'; return; }
    results[id] = classifyHttp(await probeHttp(s.probes[id], { fetchImpl: deps.fetchImpl, timeoutMs: s.timeoutMs }));
  }));

  const mail = mailSettings(config, env);
  const emailConfigured = deps.emailConfigured ?? Boolean((mail.provider === 'sendgrid' ? mail.sendgridApiKey : mail.resendApiKey) && mail.from);
  results.email = classifyEmail({ configured: emailConfigured, ...(await emailCounts(db)) });
  results.payments = await probeStripe(deps.stripe !== undefined ? deps.stripe : platformStripe(config), s.timeoutMs);

  const hostStatus = deps.hostStatus !== undefined ? deps.hostStatus : readHostStatus(s.hostStatusFile);
  const merged = mergeProbes(results, hostStatus, now);
  await recordProbeRun(db, merged, now);
  return merged;
}

/** Write one run's results. Exported for tests. */
export async function recordProbeRun(db, results, now = new Date()) {
  const day = ymd(now);
  await db.tx(async (c) => {
    for (const id of COMPONENT_IDS) {
      const status = STATUSES.includes(results[id]) ? results[id] : 'unknown';
      if (status !== 'unknown') {
        await c.query(
          `INSERT INTO status_daily AS d (day, component, checks, outages, degraded) VALUES ($1, $2, 1, $3, $4)
           ON CONFLICT (day, component) DO UPDATE SET checks = d.checks + 1, outages = d.outages + EXCLUDED.outages, degraded = d.degraded + EXCLUDED.degraded`,
          [day, id, status === 'outage' ? 1 : 0, status === 'degraded' ? 1 : 0]);
      }
      await c.query(
        `INSERT INTO status_latest AS l (component, status, checked_at, changed_at) VALUES ($1, $2, $3, $3)
         ON CONFLICT (component) DO UPDATE SET status = EXCLUDED.status, checked_at = EXCLUDED.checked_at,
                changed_at = CASE WHEN l.status = EXCLUDED.status THEN l.changed_at ELSE EXCLUDED.checked_at END`,
        [id, status, now]);
    }
    await c.query('DELETE FROM status_daily WHERE day < $1::date - $2::int', [day, RETENTION_DAYS]);
    await c.query("DELETE FROM status_subscribers WHERE confirmed_at IS NULL AND COALESCE(confirm_sent_at, created_at) < now() - interval '7 days'");
  });
}

// ---- worker job ----------------------------------------------------------------------------

/** The 5-minute bucket a time falls in (epoch minutes / 5). */
export const bucketOf = (d) => Math.floor(new Date(d).getTime() / PROBE_EVERY_MS);

export function createStatusHandlers(deps = {}) {
  return {
    async status_probe({ db, job }) {
      const at = deps.now ? deps.now() : new Date();
      try {
        const config = deps.config || (await import('../config.js')).readConfig();
        return await runStatusProbes(db, { ...deps, config, now: at });
      } finally {
        if (!job?.payload?.once) {
          // Next 5-minute bucket after both this job's own and the current one, so a late run
          // never doubles up the bucket it ran in.
          const next = Math.max(bucketOf(at), Number(job?.payload?.bucket) || 0) + 1;
          await enqueue(db, { kind: 'status_probe', payload: { bucket: next }, runAt: new Date(next * PROBE_EVERY_MS), dedupeKey: `status_probe:${next}`, maxAttempts: 1 });
        }
      }
    },
  };
}

export const STATUS_HANDLERS = createStatusHandlers();

/** Hourly from housekeeping: (re)start the chain at the next bucket. A no-op while it runs. */
export function scheduleStatusProbes(db, at = new Date()) {
  const next = bucketOf(at) + 1;
  return enqueue(db, { kind: 'status_probe', payload: { bucket: next }, runAt: new Date(next * PROBE_EVERY_MS), dedupeKey: `status_probe:${next}`, maxAttempts: 1 });
}

// ---- public view ---------------------------------------------------------------------------

/** Current status per component; missing or stale rows are `unknown`. */
export function componentStatuses(latestRows, now = new Date()) {
  const by = Object.fromEntries((latestRows || []).map((r) => [r.component, r]));
  return COMPONENTS.map(({ id, name }) => {
    const r = by[id];
    const at = r ? new Date(r.checked_at).getTime() : NaN;
    const fresh = Number.isFinite(at) && now.getTime() - at <= STALE_MS;
    return { id, name, status: fresh && STATUSES.includes(r.status) ? r.status : 'unknown', checkedAt: Number.isFinite(at) ? new Date(at).toISOString() : null };
  });
}

/** Floor to two decimals, so any outage shows below 100. */
const pct2 = (up, total) => (total > 0 ? Math.floor(((total - up) / total) * 10000) / 100 : null);

/**
 * 90 days per component, oldest first, UTC dates; days without checks have pct null.
 * @param {{ day: string, component: string, checks: number, outages: number, degraded: number }[]} rows day as YYYY-MM-DD
 */
export function buildUptime(rows, now = new Date(), days = UPTIME_DAYS) {
  const today = Date.parse(`${ymd(now)}T00:00:00Z`);
  const dates = Array.from({ length: days }, (_, i) => ymd(today - (days - 1 - i) * DAY));
  const by = new Map((rows || []).map((r) => [`${typeof r.day === 'string' ? r.day.slice(0, 10) : ymd(r.day)}|${r.component}`, r]));
  const byComponent = {};
  const pct = {};
  for (const id of COMPONENT_IDS) {
    let checks = 0, outages = 0;
    byComponent[id] = dates.map((date) => {
      const r = by.get(`${date}|${id}`);
      const c = Number(r?.checks) || 0, o = Number(r?.outages) || 0, d = Number(r?.degraded) || 0;
      checks += c; outages += o;
      return { date, pct: pct2(o, c), checks: c, outages: o, degraded: d };
    });
    pct[id] = pct2(outages, checks);
  }
  return { days, from: dates[0], to: dates.at(-1), byComponent, pct };
}

/** A notice as the public sees it; updates newest first. */
export function publicNotice(n, updates = []) {
  return {
    id: n.id, kind: n.kind, title: n.title, impact: n.impact, status: n.status, components: [...(n.components || [])],
    startsAt: iso(n.starts_at), endsAt: iso(n.ends_at), resolvedAt: iso(n.resolved_at), createdAt: iso(n.created_at), updatedAt: iso(n.updated_at),
    updates: updates.filter((u) => u.notice_id === n.id)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((u) => ({ status: u.status, body: u.body, at: iso(u.created_at) })),
  };
}

/**
 * active: open incidents, and open maintenance whose window has started (or is marked in
 * progress). upcoming: scheduled maintenance that hasn't started. recent: closed in the last
 * 30 days, newest first, at most 20. Callers pass published notices only.
 */
export function bucketNotices(notices, now = new Date()) {
  const t = now.getTime();
  const active = [], upcoming = [], recent = [];
  for (const n of notices) {
    const startsAt = n.starts_at ? new Date(n.starts_at).getTime() : null;
    if (isClosed(n.status)) {
      const closedAt = new Date(n.resolved_at || n.updated_at).getTime();
      if (t - closedAt <= RECENT_DAYS * DAY) recent.push(n);
    } else if (n.kind === 'incident' || n.status === 'in_progress' || (startsAt !== null && startsAt <= t)) {
      active.push(n);
    } else {
      upcoming.push(n);
    }
  }
  const time = (d) => (d ? new Date(d).getTime() : 0);
  active.sort((a, b) => time(b.created_at) - time(a.created_at));
  upcoming.sort((a, b) => (time(a.starts_at) || Infinity) - (time(b.starts_at) || Infinity));
  recent.sort((a, b) => time(b.resolved_at || b.updated_at) - time(a.resolved_at || a.updated_at));
  return { active, upcoming, recent: recent.slice(0, RECENT_MAX) };
}

/**
 * outage: a component is down or an active incident is major. degraded: a component is
 * degraded or an active incident is minor. maintenance: maintenance under way. operational:
 * every known component is operational. unknown: nothing is known.
 */
export function overallStatus(components, activeNotices = []) {
  const s = components.map((c) => c.status);
  const incidents = activeNotices.filter((n) => n.kind === 'incident');
  if (s.includes('outage') || incidents.some((n) => n.impact === 'major')) return 'outage';
  if (s.includes('degraded') || incidents.some((n) => n.impact === 'minor')) return 'degraded';
  if (activeNotices.some((n) => n.kind === 'maintenance')) return 'maintenance';
  if (s.includes('operational')) return 'operational';
  return 'unknown';
}

/** Everything GET /api/v1/public/status returns. */
export function buildPublicStatus({ latest, daily, notices, updates, subscribeEnabled = false, now = new Date() }) {
  const components = componentStatuses(latest, now);
  const b = bucketNotices(notices || [], now);
  const view = (list) => list.map((n) => publicNotice(n, updates || []));
  return {
    generatedAt: now.toISOString(),
    overall: overallStatus(components, b.active),
    components,
    uptime: buildUptime(daily, now),
    notices: { active: view(b.active), upcoming: view(b.upcoming), recent: view(b.recent) },
    subscribe: { enabled: Boolean(subscribeEnabled) },
  };
}

/** The 'status' platform setting; defaults when the row is missing. */
export async function readStatusSetting(q) {
  const { rows } = await q.query("SELECT value FROM platform_settings WHERE key = 'status'");
  return { subscribeEnabled: rows[0]?.value?.subscribeEnabled === true };
}

/** Load and build the public status through the app role (views only). */
export async function loadPublicStatus(q, now = new Date()) {
  const latest = (await q.query('SELECT component, status, checked_at FROM status_latest')).rows;
  const daily = (await q.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, component, checks, outages, degraded FROM status_daily WHERE day > $1::date - $2::int`,
    [ymd(now), UPTIME_DAYS])).rows;
  const notices = (await q.query(
    `SELECT * FROM status_notices_public
      WHERE status NOT IN ('resolved', 'completed') OR COALESCE(resolved_at, updated_at) > now() - make_interval(days => $1)
      ORDER BY created_at DESC LIMIT 200`, [RECENT_DAYS])).rows;
  const updates = notices.length ? (await q.query(
    'SELECT notice_id, status, body, created_at FROM status_notice_updates_public WHERE notice_id = ANY($1::uuid[]) ORDER BY created_at DESC',
    [notices.map((n) => n.id)])).rows : [];
  const setting = await readStatusSetting(q);
  return buildPublicStatus({ latest, daily, notices, updates, subscribeEnabled: setting.subscribeEnabled, now });
}

// ---- notices: validation -------------------------------------------------------------------

/**
 * Plain text only: control characters removed (newlines and tabs kept in bodies), \r\n
 * normalised, trimmed. The site renders with textContent, so no markup is interpreted.
 */
export function cleanText(v, { multiline = false } = {}) {
  let s = String(v ?? '').replace(/\r\n?/g, '\n');
  // Bidi overrides and line/paragraph separators too: they can disguise text.
  s = multiline
    ? s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, '')
    : s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]+/g, ' ');
  return (multiline ? s : s.replace(/ {2,}/g, ' ')).trim();
}

/**
 * Check a whole notice (after merging a patch over the stored row). Returns problems as
 * [{ path, message }]; empty when fine.
 * @param {{ kind: string, title: string, impact: string, components: string[], status: string, startsAt?: string|null, endsAt?: string|null }} n
 */
export function noticeProblems(n) {
  const out = [];
  if (!NOTICE_KINDS.includes(n.kind)) out.push({ path: '/kind', message: 'must be incident or maintenance' });
  if (!n.title || n.title.length > LIMITS.titleMax) out.push({ path: '/title', message: `must be 1-${LIMITS.titleMax} characters of plain text` });
  if (!IMPACTS.includes(n.impact)) out.push({ path: '/impact', message: 'must be none, minor, major or maintenance' });
  else if (n.kind === 'incident' && n.impact === 'maintenance') out.push({ path: '/impact', message: 'an incident is none, minor or major' });
  if (!Array.isArray(n.components) || n.components.some((c) => !COMPONENT_IDS.includes(c))) out.push({ path: '/components', message: `must be some of ${COMPONENT_IDS.join(', ')}` });
  if (NOTICE_KINDS.includes(n.kind) && !NOTICE_STATUSES[n.kind].includes(n.status)) out.push({ path: '/status', message: `a ${n.kind} is ${NOTICE_STATUSES[n.kind].join(', ')}` });
  const s = n.startsAt ? Date.parse(n.startsAt) : null;
  const e = n.endsAt ? Date.parse(n.endsAt) : null;
  if (n.startsAt && !Number.isFinite(s)) out.push({ path: '/startsAt', message: 'must be a date-time' });
  if (n.endsAt && !Number.isFinite(e)) out.push({ path: '/endsAt', message: 'must be a date-time' });
  if (Number.isFinite(s) && Number.isFinite(e) && e <= s) out.push({ path: '/endsAt', message: 'must be after the start' });
  return out;
}

export const defaultStatus = (kind) => (kind === 'maintenance' ? 'scheduled' : 'investigating');
export const defaultImpact = (kind) => (kind === 'maintenance' ? 'maintenance' : 'minor');

// ---- subscriptions -------------------------------------------------------------------------

export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

const componentNames = (ids) => COMPONENTS.filter((c) => (ids || []).includes(c.id)).map((c) => c.name);

/**
 * One notice email. CASL: says who sent it and why, with a one-click unsubscribe link (the
 * token is in the URL fragment, so it never reaches a server log).
 */
export function noticeEmail({ brand, publicUrl, supportEmail, notice, update, to, unsubscribeToken }) {
  const status = STATUS_LABEL[update?.status || notice.status] || notice.status;
  const affects = componentNames(notice.components);
  const lines = [
    `${notice.kind === 'maintenance' ? 'Maintenance' : 'Incident'}: ${notice.title}`,
    `Status: ${status}`,
    affects.length ? `Affects: ${affects.join(', ')}` : null,
    notice.kind === 'maintenance' && notice.starts_at ? `Window: ${iso(notice.starts_at)}${notice.ends_at ? ` to ${iso(notice.ends_at)}` : ''} (UTC)` : null,
    '',
    update?.body || null,
    update?.body ? '' : null,
    `Live status: ${publicUrl}`,
    '',
    '--',
    `You get this email because you subscribed to ${brand} service status updates at ${publicUrl}.`,
    `Sent by ${brand}${supportEmail ? ` (${supportEmail})` : ''}.`,
    `Unsubscribe with one click: ${publicUrl}#unsubscribe=${unsubscribeToken}`,
  ].filter((l) => l !== null);
  return { to, template: 'status-notice', subject: `[${brand} status] ${notice.title} (${status})`.slice(0, 200), text: lines.join('\n') };
}

export function confirmEmail({ brand, publicUrl, supportEmail, to, token }) {
  return {
    to, template: 'status-confirm', subject: `Confirm ${brand} status updates`,
    text: [
      `Someone (hopefully you) asked to get ${brand} service status updates by email at this address.`,
      '',
      `Confirm here (the link works for 7 days): ${publicUrl}#confirm=${token}`,
      '',
      'If it wasn\'t you, ignore this email: nothing is sent unless you confirm.',
      '',
      '--',
      `Sent by ${brand}${supportEmail ? ` (${supportEmail})` : ''}.`,
    ].join('\n'),
  };
}
