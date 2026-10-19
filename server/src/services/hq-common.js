// Shared pieces for the HQ console (/api/hq/*), billing and the public lead form:
// settings from the environment, the HQ admin check, and HQ audit events.
import { fileURLToPath } from 'node:url';
import { forbidden } from '../errors.js';
import { appendAudit, requestFacts } from './audit.js';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

/**
 * "staging=https://a.example,production=https://b.example" -> [{ name, url }].
 * Only https (or http://localhost) origins are kept.
 */
export function parseEnvironments(v) {
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean).map((pair) => {
    const i = pair.indexOf('=');
    const name = (i > 0 ? pair.slice(0, i) : pair).trim();
    const url = (i > 0 ? pair.slice(i + 1) : '').trim().replace(/\/$/, '');
    return { name, url };
  }).filter((e) => /^[a-z0-9-]{1,32}$/i.test(e.name) && /^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/.test(e.url));
}

const DEFAULT_CONTROLS = fileURLToPath(new URL('../../../compliance/controls.yaml', import.meta.url));

/**
 * HQ settings. config.js does not read these yet, so they come from the environment;
 * tests (and later config.js) can pass overrides as config.hq.
 * @param {import('../config.js').Config & { hq?: object }} config
 */
export function hqSettings(config, env = process.env) {
  return {
    notifyEmail: env.HQ_NOTIFY_EMAIL || '',
    deployLogFile: env.DEPLOY_LOG_FILE || '',
    controlsFile: env.COMPLIANCE_CONTROLS_FILE || DEFAULT_CONTROLS,
    environments: parseEnvironments(env.HQ_ENVIRONMENTS),
    // Look up the TLS certificate of PUBLIC_ORIGIN (one handshake, cached). On by default
    // where there is a real certificate to check.
    tlsCheck: env.TLS_CHECK ? env.TLS_CHECK !== 'off' : Boolean(config.deployed),
    deleteGraceDays: int(env.TENANT_DELETE_GRACE_DAYS, 30),
    exportFreshHours: int(env.TENANT_EXPORT_FRESH_HOURS, 24),
    trialDays: int(env.TRIAL_DAYS, 30),
    leadsPerHour: int(env.LEAD_RATE_LIMIT_PER_HOUR, 5),
    leadsGlobalPerHour: int(env.LEAD_RATE_LIMIT_GLOBAL_PER_HOUR, 200),
    ...(config.hq || {}),
  };
}

/**
 * Fishtape's own Stripe account (subscriptions). Never a company's key.
 * config.billing may carry { stripe } (an injected client, for tests) and overrides.
 */
export function billingSettings(config, env = process.env) {
  return {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    graceDays: int(env.BILLING_GRACE_DAYS, 7),
    stripe: null,
    ...(config.billing || {}),
  };
}

/** HQ admins (hq_admin) change things; HQ staff (hq_staff) look and support. */
export function requireHqAdmin(req) {
  if (req.principal?.platformRole !== 'hq_admin') throw forbidden('An HQ admin has to do this.');
}

export const hqActor = (req) => req.principal.actor;

/**
 * Audit an HQ action. tenantId null writes to the platform chain (HQ's own activity);
 * a tenant id writes into that company's chain, where its owner can read it.
 * @param {{ query: Function }} c HQ client (BYPASSRLS) or a TenantTx for the same tenant
 */
export function hqAudit(c, req, tenantId, { action, summary, collection = null, recordId = null, meta = null }) {
  return appendAudit(c, tenantId, { actor: hqActor(req), action, summary, collection, recordId, meta, request: requestFacts(req) });
}

export const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Shorten long strings (data URLs, big notes) for support and export previews. */
export function clipDeep(v, max = 2000) {
  if (typeof v === 'string') return v.length > max ? `[${v.length} characters hidden]` : v;
  if (Array.isArray(v)) return v.map((x) => clipDeep(x, max));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clipDeep(x, max)]));
  return v;
}

export const uuidParams = (...names) => ({
  type: 'object', required: names, properties: Object.fromEntries(names.map((n) => [n, { type: 'string', format: 'uuid' }])),
});
