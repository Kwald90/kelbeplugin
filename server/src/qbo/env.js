// QuickBooks Online platform settings (docs/integrations/quickbooks.md 2.1). Intuit's client id,
// client secret and webhook verifier are Fishtape's own credentials: they live in env vars, never
// in tenant_secrets. QBO_ENVIRONMENT unset or empty turns the whole integration off.

const ENVIRONMENTS = ['sandbox', 'production'];
const API_BASE = {
  production: 'https://quickbooks.api.intuit.com/v3/company',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
};
const OAUTH = {
  authorize: 'https://appcenter.intuit.com/connect/oauth2',
  token: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revoke: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
};

export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
export const QBO_MINOR_VERSION = 75;
export const QBO_CALLBACK_PATH = '/api/v1/qbo/oauth/callback';

const int = (v, d) => {
  if (v === undefined || v === '') return d;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a whole number, got ${v}`);
  return n;
};
const trimSlash = (s) => String(s).replace(/\/+$/, '');

/** Test-only base URLs (QBO_API_BASE, QBO_OAUTH_BASE): http(s) URLs, ignored outside test and local. */
function testBase(v, name) {
  const s = String(v || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw new Error(`${name} must be a URL`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`${name} must be an http(s) URL`);
  return trimSlash(s);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {QboConfig}
 */
export function readQboConfig(env = process.env) {
  const environment = String(env.QBO_ENVIRONMENT || '').trim();
  if (environment && !ENVIRONMENTS.includes(environment)) throw new Error(`QBO_ENVIRONMENT must be sandbox, production or empty (got ${environment})`);
  const writes = String(env.QBO_WRITES || 'on').trim().toLowerCase();
  if (!['on', 'off'].includes(writes)) throw new Error(`QBO_WRITES must be on or off (got ${env.QBO_WRITES})`);
  const clientId = String(env.QBO_CLIENT_ID || '').trim();
  const clientSecret = String(env.QBO_CLIENT_SECRET || '').trim();
  const webhookVerifiers = [env.QBO_WEBHOOK_VERIFIER, env.QBO_WEBHOOK_VERIFIER_PREVIOUS].map((v) => String(v || '').trim()).filter(Boolean);

  // Overrides point the client at the fake QuickBooks server; real deployments never honour them.
  const appEnv = env.APP_ENV || 'local';
  const overridable = appEnv === 'test' || appEnv === 'local';
  const apiOverride = overridable ? testBase(env.QBO_API_BASE, 'QBO_API_BASE') : null;
  const oauthOverride = overridable ? testBase(env.QBO_OAUTH_BASE, 'QBO_OAUTH_BASE') : null;

  const publicOrigin = trimSlash(env.PUBLIC_ORIGIN || 'http://localhost:8080');
  const apiEnv = environment || 'sandbox';
  return {
    // On only with an environment and both app credentials: a half-set server says "not available"
    // instead of failing at start-up (set-env.sh sets the values one at a time).
    enabled: Boolean(environment && clientId && clientSecret),
    environment: environment || null,
    clientId,
    clientSecret,
    webhookVerifiers,
    writesEnabled: writes === 'on',
    apiBase: apiOverride || API_BASE[apiEnv],
    oauth: oauthOverride
      ? { authorize: `${oauthOverride}/connect/oauth2`, token: `${oauthOverride}/oauth2/v1/tokens/bearer`, revoke: `${oauthOverride}/v2/oauth2/tokens/revoke` }
      : { ...OAUTH },
    scope: QBO_SCOPE,
    minorVersion: QBO_MINOR_VERSION,
    readBudget: int(env.QBO_READ_BUDGET, 450_000),
    tenantReadBudget: int(env.QBO_TENANT_READ_BUDGET, 20_000),
    trialReadBudget: int(env.QBO_TRIAL_READ_BUDGET, 5_000),
    requestTimeoutMs: 30_000,
    tokenTimeoutMs: 15_000,
    publicOrigin,
    redirectUri: (origin = publicOrigin) => `${trimSlash(origin)}${QBO_CALLBACK_PATH}`,
  };
}

/** The QBO settings from either the whole server config or config.qbo itself. */
export function qboCfg(cfg) {
  return cfg?.qbo && typeof cfg.qbo === 'object' && 'enabled' in cfg.qbo ? cfg.qbo : cfg;
}

/**
 * @typedef {object} QboConfig
 * @property {boolean} enabled
 * @property {'sandbox'|'production'|null} environment
 * @property {string} clientId
 * @property {string} clientSecret
 * @property {string[]} webhookVerifiers current first, then QBO_WEBHOOK_VERIFIER_PREVIOUS
 * @property {boolean} writesEnabled false when QBO_WRITES=off
 * @property {string} apiBase up to /v3/company (the realm id follows)
 * @property {{ authorize: string, token: string, revoke: string }} oauth
 * @property {string} scope
 * @property {number} minorVersion
 * @property {number} readBudget
 * @property {number} tenantReadBudget
 * @property {number} trialReadBudget
 * @property {number} requestTimeoutMs
 * @property {number} tokenTimeoutMs
 * @property {string} publicOrigin
 * @property {(publicOrigin?: string) => string} redirectUri
 */
