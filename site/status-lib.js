// Pure helpers for the status page (site/status.js); tested in electrical-app/tests/site-pages.test.mjs.
// Input is GET /api/v1/public/status (server/src/services/status-page.js builds it; routes in server/src/routes/hq-status.js), or,
// while that isn't deployed, the older /api/v1/status + /api/readyz pair.

export const COMPONENTS = Object.freeze([
  ['app', 'Web app'], ['api', 'API and sync'], ['hq', 'HQ console'], ['signin', 'Sign-in'], ['email', 'Email'], ['payments', 'Payments'],
]);
const NAMES = Object.fromEntries(COMPONENTS);

export const STATE_TEXT = Object.freeze({ operational: 'Operational', degraded: 'Degraded', outage: 'Outage', unknown: 'No data' });
export const STATE_CLASS = Object.freeze({ operational: 'ok', degraded: 'degraded', outage: 'bad', unknown: 'unknown' });

export const OVERALL = Object.freeze({
  operational: { cls: 'ok', title: 'All systems operational' },
  degraded: { cls: 'degraded', title: 'Some systems degraded' },
  outage: { cls: 'down', title: 'Service disruption' },
  maintenance: { cls: 'maintenance', title: 'Maintenance in progress' },
  unknown: { cls: 'checking', title: 'Status unknown' },
});

export const NOTICE_STATUS = Object.freeze({
  investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed',
});
export const IMPACT = Object.freeze({ none: 'No impact', minor: 'Minor', major: 'Major', maintenance: 'Maintenance' });

/** Bar colour for one day: '' (no data), 'up', 'minor' (some failed checks) or 'down' (< 99 %). */
export function dayClass(day) {
  if (!day || day.pct == null || !day.checks) return '';
  if (day.pct < 99) return 'down';
  if (day.outages > 0 || day.degraded > 0) return 'minor';
  return 'up';
}

/** "99.98 %" or "No data". */
export function fmtPct(p) {
  if (p == null || !Number.isFinite(Number(p))) return 'No data';
  const n = Number(p);
  return `${n >= 100 ? '100' : n.toFixed(2)} %`;
}

/** Hover text for one day of the bar. */
export function dayTitle(day, locale = 'en-CA') {
  const date = new Date(`${day.date}T12:00:00Z`).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (!day.checks) return `${date}: no data`;
  const bad = (day.outages || 0) + (day.degraded || 0);
  return `${date}: ${fmtPct(day.pct)} up${bad ? `, ${day.outages || 0} failed and ${day.degraded || 0} slow checks` : ''}`;
}

/**
 * The page model from the new endpoint's body:
 * { overall, components: [{ id, name, status, pct, days }], notices: { active, upcoming, recent }, subscribe }
 */
export function fromPublicStatus(body) {
  const byId = Object.fromEntries((body?.components || []).map((c) => [c.id, c]));
  const uptime = body?.uptime || {};
  const components = COMPONENTS.map(([id, name]) => {
    const c = byId[id] || {};
    const status = STATE_TEXT[c.status] ? c.status : 'unknown';
    return { id, name: c.name || name, status, checkedAt: c.checkedAt || null, pct: uptime.pct?.[id] ?? null, days: uptime.byComponent?.[id] || [] };
  });
  return {
    overall: OVERALL[body?.overall] ? body.overall : 'unknown',
    components,
    notices: { active: body?.notices?.active || [], upcoming: body?.notices?.upcoming || [], recent: body?.notices?.recent || [] },
    subscribe: Boolean(body?.subscribe?.enabled),
    generatedAt: body?.generatedAt || null,
  };
}

/**
 * The page model from the older pair (no uptime, no notices, no HQ/email/payments signal):
 * the API from /api/v1/status, sign-in and the app follow the API, the rest is "No data".
 */
export function fromLegacy({ status, ready }) {
  const up = Boolean(status?.ok && status.body?.status === 'ok');
  const readyOk = ready?.body?.status === 'ready';
  const api = !status ? 'outage' : up && readyOk ? 'operational' : up || readyOk ? 'degraded' : 'outage';
  const known = { app: status ? 'operational' : 'unknown', api, signin: api };
  const components = COMPONENTS.map(([id, name]) => ({ id, name, status: known[id] || 'unknown', checkedAt: null, pct: null, days: [] }));
  return { overall: api === 'operational' ? 'operational' : api, components, notices: { active: [], upcoming: [], recent: [] }, subscribe: false, generatedAt: null };
}

/** Names for a notice's components: "API and sync, Sign-in". */
export const componentNames = (ids) => (ids || []).map((id) => NAMES[id] || id).join(', ');

/** #confirm=<token> or #unsubscribe=<token> from an email link, else null. Tokens: base64url, 16-200 chars. */
export function parseFragment(hash) {
  const m = /^#(confirm|unsubscribe)=([A-Za-z0-9_-]{16,200})$/.exec(String(hash || ''));
  return m ? { action: m[1], token: m[2] } : null;
}
