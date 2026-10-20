// Platform settings for HQ (#/settings): the editable ones live in platform_settings
// (support address, sender name, legal document versions); everything that comes from the
// environment is shown read-only with where to change it. Plus three checks: which Stripe
// account STRIPE_SECRET_KEY belongs to (it is Kelvin's existing True Collar Built account),
// whether the fishtape_* prices exist and the platform webhook is healthy, and whether
// Fishtape's own email (Resend) is set up. Nothing here ever returns a key or secret.
import { BRAND } from '../brand.js';
import { CURRENCY, PLANS, EXTRA_USER_CENTS } from '../../../electrical-app/js/plans.js';
import { readAiConfig } from '../ai/config.js';
import { testResend } from '../integrations/resend.js';
import { PRICE_KEYS, SELF_SERVE_PLANS } from './billing.js';
import { DEPOSIT_CENTS, DEPOSIT_LOOKUP_KEY, TERMS_VERSION } from './signup.js';
import { trialDays } from './tenants.js';
import { billingSettings, hqUrl, iso } from './hq-common.js';

export const LEGAL_DOCS = ['terms', 'privacy'];

/** "Fishtape <noreply@x>" -> { name: 'Fishtape', address: 'noreply@x' }. */
export function parseFrom(from) {
  const s = String(from || '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), address: m[2] };
  return { name: '', address: /^[^\s<>"]+@[^\s<>"]+$/.test(s) ? s : '' };
}

/** EMAIL_FROM with HQ's sender name in front of the same address (the address never changes). */
export function withSenderName(from, name) {
  const { address } = parseFrom(from);
  const clean = String(name || '').replace(/[\r\n"<>\\]/g, '').trim().slice(0, 80);
  if (!address || !clean) return from;
  return /^[A-Za-z0-9 .'-]+$/.test(clean) ? `${clean} <${address}>` : `"${clean}" <${address}>`;
}

/** The sender name HQ saved in Settings, or null while the EMAIL_FROM name is used as is. */
export async function savedSenderName(q) {
  const { rows } = await q.query("SELECT value->>'senderName' AS name FROM platform_settings WHERE key = 'support'");
  return rows[0]?.name || null;
}

/** Defaults until HQ saves a value. */
export function settingDefaults(env = process.env) {
  return {
    support: { email: env.SUPPORT_EMAIL || 'support@fishtapehq.com', senderName: parseFrom(env.EMAIL_FROM).name || BRAND.name },
    legal: {
      terms: { version: TERMS_VERSION, url: '/site/terms.html', requireReacceptance: false, updatedAt: null },
      privacy: { version: TERMS_VERSION, url: '/site/privacy.html', requireReacceptance: false, updatedAt: null },
    },
  };
}

/** Every platform setting, defaults filled in. `q` is any client (app or HQ). */
export async function readPlatformSettings(q, env = process.env) {
  const d = settingDefaults(env);
  const { rows } = await q.query("SELECT key, value, updated_at FROM platform_settings WHERE key IN ('support', 'legal')");
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  const legal = by.legal?.value || {};
  return {
    support: { ...d.support, ...(by.support?.value || {}) },
    legal: Object.fromEntries(LEGAL_DOCS.map((doc) => [doc, { ...d.legal[doc], ...(legal[doc] || {}) }])),
    updatedAt: { support: iso(by.support?.updated_at), legal: iso(by.legal?.updated_at) },
  };
}

export const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,253}\.[a-z]{2,63}$/i;
const VERSION = /^[A-Za-z0-9._-]{1,40}$/;
const URL_OK = /^(https:\/\/[^\s<>"']{1,480}|\/[A-Za-z0-9/_.-]{1,200})$/;

/** Check a PUT body; returns a list of { path, message } problems (empty when fine). */
export function settingsProblems(b) {
  const out = [];
  if (b.support) {
    if (b.support.email !== undefined && !EMAIL.test(String(b.support.email))) out.push({ path: '/support/email', message: 'must be an email address' });
    if (b.support.senderName !== undefined && !/^[^<>"\r\n]{1,80}$/.test(String(b.support.senderName))) out.push({ path: '/support/senderName', message: 'must be 1-80 characters, no < > or quotes' });
  }
  for (const doc of LEGAL_DOCS) {
    const v = b.legal?.[doc];
    if (!v) continue;
    if (v.version !== undefined && !VERSION.test(String(v.version))) out.push({ path: `/legal/${doc}/version`, message: 'letters, digits, dot, dash and underscore, up to 40' });
    if (v.url !== undefined && !URL_OK.test(String(v.url))) out.push({ path: `/legal/${doc}/url`, message: 'must be https://… or a path starting with /' });
  }
  return out;
}

/**
 * Settings that come from the environment: shown, never edited in HQ. Secrets show only
 * whether they are set. `where` says how to change them.
 */
export function envSettings(config, env = process.env) {
  const ai = readAiConfig(env);
  const set = (v) => (v ? 'set' : 'not set');
  const envFile = config.deployed ? `the ${config.appEnv} .env on the server (deploy/${config.appEnv}/.env.example lists it), then restart the API and worker` : 'server/.env, then restart the API';
  const stripeKey = env.STRIPE_SECRET_KEY || '';
  return [
    { key: 'BRAND', label: 'Brand name', value: BRAND.name, where: 'electrical-app/js/brand.js (one place in the code; deploy to change it)' },
    { key: 'APP_ENV', label: 'Environment', value: config.appEnv, where: envFile },
    { key: 'PUBLIC_ORIGIN', label: 'App address', value: config.publicOrigin, where: envFile },
    { key: 'HQ_PUBLIC_URL', label: 'HQ address (links in emails)', value: hqUrl(config, env), where: envFile },
    { key: 'TRIAL_DAYS', label: 'Trial length', value: `${trialDays(env)} days`, where: envFile },
    { key: 'BILLING_GRACE_DAYS', label: 'Grace after a failed payment', value: `${billingSettings(config, env).graceDays} days`, where: envFile },
    { key: 'TENANT_DELETE_GRACE_DAYS', label: 'Deleted-company grace', value: `${Number.parseInt(env.TENANT_DELETE_GRACE_DAYS || '30', 10)} days`, where: envFile },
    { key: 'HQ_NOTIFY_EMAIL', label: 'HQ alerts go to', value: env.HQ_NOTIFY_EMAIL || 'not set', where: envFile },
    { key: 'EMAIL_FROM', label: 'System email sender', value: env.EMAIL_FROM || 'not set', where: envFile },
    { key: 'RESEND_API_KEY', label: 'Resend key (system email)', value: set(env.RESEND_API_KEY), secret: true, where: envFile },
    { key: 'STRIPE_SECRET_KEY', label: 'Stripe key (subscriptions)', value: stripeKey ? `set (${stripeMode(stripeKey)} mode)` : 'not set', secret: true, where: envFile },
    { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe webhook signing secret', value: set(env.STRIPE_WEBHOOK_SECRET), secret: true, where: envFile },
    { key: 'AI_MODEL', label: 'AI model', value: ai.model, where: envFile },
    { key: 'AI_EFFORT', label: 'AI effort', value: ai.effort, where: envFile },
    { key: 'AI_DEFAULT_MONTHLY_CAP_CENTS', label: 'Default AI cap per company', value: `US$${(ai.defaultMonthlyCapCents / 100).toFixed(2)} a month`, where: envFile },
    { key: 'GIT_SHA', label: 'Build', value: config.gitSha, where: 'set by the deploy script' },
  ];
}

export function stripeMode(key) {
  if (/^(sk|rk)_live_/.test(key)) return 'live';
  if (/^(sk|rk)_test_/.test(key)) return 'test';
  return 'unknown';
}

/** Events the platform webhook endpoint must send (server/scripts/stripe-setup.js). */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed', 'invoice.upcoming',
];
export const WEBHOOK_PATH = '/api/v1/webhooks/platform-stripe';

const short = (e) => String(e?.message || e || 'failed').replace(/(sk|rk|whsec|pk)_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 200);

/**
 * Which Stripe account the key belongs to, whether the fishtape_* prices exist and match
 * plans.js, and whether the platform webhook endpoint is there and receiving events.
 * @param {{ stripe: object|null, secretKey: string, webhookSecret: string, q: { query: Function } }} o
 */
export async function stripeCheck({ stripe, secretKey, webhookSecret, q }) {
  const out = {
    configured: Boolean(stripe), mode: secretKey ? stripeMode(secretKey) : (stripe ? 'injected' : null), account: null, prices: [], webhook: null, problems: [],
  };
  const events = (await q.query(
    `SELECT max(received_at) AS last_at, count(*) FILTER (WHERE received_at > now() - interval '7 days')::int AS week,
            count(*) FILTER (WHERE outcome = 'unknown_customer' AND received_at > now() - interval '7 days')::int AS unknown
       FROM billing_events`)).rows[0];
  out.webhook = {
    secretSet: Boolean(webhookSecret), endpoint: null,
    lastEventAt: iso(events.last_at), eventsLast7Days: events.week, unknownCustomerLast7Days: events.unknown,
  };
  if (!webhookSecret) out.problems.push('STRIPE_WEBHOOK_SECRET is not set: Stripe events are refused.');
  if (!stripe) { out.problems.push('STRIPE_SECRET_KEY is not set: no checkout, invoices or finance data.'); return out; }

  try {
    const a = await stripe.accounts.retrieve();
    out.account = {
      id: a.id, name: a.settings?.dashboard?.display_name || a.business_profile?.name || null,
      country: a.country || null, defaultCurrency: a.default_currency || null,
      chargesEnabled: a.charges_enabled ?? null, payoutsEnabled: a.payouts_enabled ?? null,
    };
  } catch (e) {
    out.problems.push(`Could not read the Stripe account: ${short(e)}`);
  }

  const want = [
    ...SELF_SERVE_PLANS.map((id) => ({ key: PRICE_KEYS[id], label: `${PLANS[id].name} monthly`, amount: PLANS[id].priceCents, recurring: true })),
    { key: PRICE_KEYS.extra_user, label: 'Extra user monthly', amount: EXTRA_USER_CENTS, recurring: true },
    { key: DEPOSIT_LOOKUP_KEY, label: 'Sign-up deposit', amount: DEPOSIT_CENTS, recurring: false },
  ];
  try {
    const res = await stripe.prices.list({ lookup_keys: want.map((w) => w.key), limit: 20 });
    const by = Object.fromEntries((res.data || []).map((p) => [p.lookup_key, p]));
    out.prices = want.map((w) => {
      const p = by[w.key];
      const ok = Boolean(p) && p.active !== false && p.unit_amount === w.amount && String(p.currency).toUpperCase() === CURRENCY && Boolean(p.recurring) === w.recurring;
      return { key: w.key, label: w.label, found: Boolean(p), active: p ? p.active !== false : false, amountCents: p?.unit_amount ?? null, expectedCents: w.amount, ok };
    });
    const bad = out.prices.filter((p) => !p.ok);
    if (bad.length) out.problems.push(`${bad.length} fishtape_* price${bad.length === 1 ? ' is' : 's are'} missing or different from plans.js: run server/scripts/stripe-setup.js.`);
  } catch (e) {
    out.problems.push(`Could not list prices: ${short(e)}`);
  }

  try {
    const list = await stripe.webhookEndpoints.list({ limit: 100 });
    const ep = (list.data || []).find((w) => String(w.url || '').endsWith(WEBHOOK_PATH));
    if (ep) {
      const enabled = new Set(ep.enabled_events || []);
      const missing = enabled.has('*') ? [] : WEBHOOK_EVENTS.filter((e) => !enabled.has(e));
      out.webhook.endpoint = { url: ep.url, status: ep.status, missingEvents: missing };
      if (ep.status !== 'enabled') out.problems.push('The platform webhook endpoint is disabled in Stripe.');
      if (missing.length) out.problems.push(`The webhook endpoint does not send: ${missing.join(', ')}.`);
    } else {
      out.problems.push(`No webhook endpoint on this account points at ${WEBHOOK_PATH}.`);
    }
  } catch (e) {
    out.problems.push(`Could not list webhook endpoints: ${short(e)}`);
  }
  return out;
}

/**
 * Fishtape's own email: env set, the outbox draining, and (when asked) a read-only call to
 * Resend that checks the key and the sender domain.
 */
export async function emailCheck({ q, env = process.env, live = false, test = testResend }) {
  const apiKey = env.RESEND_API_KEY || '';
  const from = env.EMAIL_FROM || '';
  const s = (await q.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS failed,
            max(sent_at) AS last_sent, min(created_at) FILTER (WHERE status = 'queued') AS oldest_queued
       FROM email_outbox`)).rows[0];
  const out = {
    provider: 'Resend', keySet: Boolean(apiKey), from: from || null,
    outbox: { queued: s.queued, failedLast7Days: s.failed, lastSentAt: iso(s.last_sent), oldestQueuedAt: iso(s.oldest_queued) },
    live: null, problems: [],
  };
  if (!apiKey || !from) out.problems.push('RESEND_API_KEY and EMAIL_FROM must both be set; until then system email waits in the outbox.');
  if (s.oldest_queued && Date.now() - new Date(s.oldest_queued).getTime() > 15 * 60_000) out.problems.push('Email has been waiting over 15 minutes: is the worker running?');
  if (live && apiKey && from) {
    try { out.live = await test({ apiKey, from }); } catch (e) { out.live = { status: 'error', message: short(e) }; }
  }
  return out;
}

/** Documents this person still has to accept (versions HQ marked "require re-acceptance"). */
export async function legalStatus(q, userId, env = process.env) {
  const s = await readPlatformSettings(q, env);
  const { rows } = await q.query('SELECT doc, version FROM legal_acceptances WHERE user_id = $1', [userId]);
  const have = new Set(rows.map((r) => `${r.doc}:${r.version}`));
  const docs = LEGAL_DOCS.map((doc) => ({ doc, ...s.legal[doc] }));
  return {
    docs: docs.map(({ doc, version, url }) => ({ doc, version, url, accepted: have.has(`${doc}:${version}`) })),
    needsAcceptance: docs.filter((d) => d.requireReacceptance && !have.has(`${d.doc}:${d.version}`)).map(({ doc, version, url }) => ({ doc, version, url })),
  };
}
