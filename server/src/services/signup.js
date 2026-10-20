// Self-serve sign-up on Fishtape's own Stripe account (STRIPE_SECRET_KEY, the same account
// as billing.js): a 14-day free trial (TRIAL_DAYS) and a $1.00 CAD deposit charged at sign-up
// to prove the card is real, then credited to the first invoice.
//
//   1. POST /api/v1/public/signup (routes/public-signup.js) validates the form, refuses an email
//      that already has an account, stores a *pending* sign-up (not a company yet) with the
//      password already hashed, and opens a Stripe Checkout Session in subscription mode:
//      the plan's monthly price (+ extra users), subscription_data.trial_period_days, and the
//      one-time deposit price (lookup key fishtape_signup_deposit_cad) charged now.
//   2. The signed platform webhook (/api/v1/webhooks/platform-stripe, routes/hq-billing.js)
//      hands checkout.session.* events that carry metadata.fishtape_signup_id to handleEvent():
//      completed -> company + owner + subscription mirrored in one transaction, welcome email
//      queued, then a -$1.00 customer balance transaction so the deposit comes off the first
//      invoice. expired -> the pending sign-up is closed and its personal details wiped.
//   3. The welcome email's one-time link (#/welcome?token=..., the token stays in the URL
//      fragment) verifies the email and opens a session that goes straight to setting up
//      two-step sign-in (owners must have it).
//
// Stripe behaviour this relies on, checked against docs.stripe.com on 2026-10-19:
// - Checkout subscription mode takes up to 20 one-time line items; "Line items with one-time
//   Prices will be on the initial invoice only" (API reference, Create a Checkout Session).
// - Trials combine with one-time prices: "Stripe automatically generates an invoice for the
//   one-time charge, even though the trial hasn't ended yet. The customer pays the one-time
//   amount upfront" (Billing > Subscriptions > Trials > "Combining trials with
//   add_invoice_items"). So the $1 is charged at Checkout and the plan starts after the trial.
// - Checkout always collects a payment method in subscription mode unless
//   payment_method_collection=if_required; we leave the default (always) and allow cards only.
// - expires_at must be 30 minutes to 24 hours after creation.
// - A customer balance credit (negative amount) "automatically applies to the next invoice
//   finalized for the customer", up to the invoice total, in the same currency. The initial
//   (deposit) invoice is already paid when checkout.session.completed arrives, so the credit
//   lands on the first invoice after the trial.
// - Stripe now calls trial_period_days "legacy" free trials and recommends Trial Offers, which
//   need API version 2026-09-30.endive, flexible billing mode and, for Checkout, an invite-only
//   preview. trial_period_days is still supported in Checkout, so we use it.
//
// Fishtape's Stripe is Kelvin's existing account: we only ever create or change products and
// prices with fishtape_* ids and lookup keys (see ensureDepositPrice), never anything else.
// The Stripe client is injected (config.billing.stripe) so tests never touch the network.
import { randomUUID } from 'node:crypto';
import { PLANS, CURRENCY, monthlyCents } from '../../../electrical-app/js/plans.js';
import { ApiError } from '../errors.js';
import { BRAND } from '../brand.js';
import { isUuid } from '../db.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { hashSecret, passwordProblem } from '../auth/passwords.js';
import { appendAudit } from './audit.js';
import { PRICE_KEYS, SELF_SERVE_PLANS, createBilling, extraSeats } from './billing.js';
import { hqSettings, hqUrl } from './hq-common.js';
import { enqueue } from './queue.js';
import { EMAIL_RE, PROVINCES, insertTenantWithOwner, normaliseEmail, trialDays } from './tenants.js';

export const DEPOSIT_CENTS = 100;
export const DEPOSIT_LOOKUP_KEY = 'fishtape_signup_deposit_cad';
export const DEPOSIT_PRODUCT_ID = 'fishtape_signup_deposit';
/** Bump when the terms or privacy text changes; stored with each sign-up. */
export const TERMS_VERSION = '2026-10-19-draft';
export const WELCOME_TTL_S = 7 * 24 * 3600;
export const MAX_USERS = 500;
const WELCOME_PREFIX = 'ftw_';
const ACTOR = { type: 'system', id: 'signup', label: 'Self-serve sign-up' };
const currency = CURRENCY.toLowerCase();
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const toDate = (secs) => (Number.isFinite(secs) ? new Date(secs * 1000) : null);
const day = (d) => new Date(d).toISOString().slice(0, 10);
const money = (cents) => `CA$${(cents / 100).toFixed(2)}`;

/**
 * Sign-up settings from the environment; tests (and later config.js) pass overrides as
 * config.signup.
 * SIGNUP_PAGE_URL: where the form lives (Stripe sends people back there). Default
 * PUBLIC_ORIGIN/site/signup.html; production can point it at https://fishtapehq.com/signup.
 */
export function signupSettings(config, env = process.env) {
  const page = String(env.SIGNUP_PAGE_URL || `${config.publicOrigin}/site/signup.html`).replace(/[?#].*$/, '');
  if (!/^(https:\/\/[^/\s]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)(\/[^\s]*)?$/.test(page)) throw new Error('SIGNUP_PAGE_URL must be an https URL');
  return {
    pageUrl: page,
    checkoutMinutes: Math.min(1439, Math.max(31, int(env.SIGNUP_CHECKOUT_MINUTES, 60) || 60)),
    perHour: int(env.SIGNUP_RATE_LIMIT_PER_HOUR, 10),
    globalPerHour: int(env.SIGNUP_RATE_LIMIT_GLOBAL_PER_HOUR, 100),
    ...(config.signup || {}),
  };
}

/** A checkout.session.* event that belongs to a self-serve sign-up. */
export function isSignupEvent(event) {
  return /^checkout\.session\./.test(String(event?.type || '')) && Boolean(event?.data?.object?.metadata?.fishtape_signup_id);
}

const isMissing = (e) => e?.statusCode === 404 || e?.code === 'resource_missing';
const productOf = (price) => (typeof price.product === 'string' ? price.product : price.product?.id);

/**
 * Create or refresh the one-time $1.00 CAD deposit price (product fishtape_signup_deposit,
 * lookup key fishtape_signup_deposit_cad). Idempotent like ensureStripeCatalog: a changed
 * amount gets a new price that takes over the lookup key, and the old one is archived.
 * Touches nothing but its own fishtape_* product and price.
 */
export async function ensureDepositPrice(stripe, { dryRun = false, log = () => {} } = {}) {
  const item = {
    productId: DEPOSIT_PRODUCT_ID, name: 'Fishtape sign-up deposit',
    description: 'Charged at sign-up to confirm the card; credited to the first invoice',
  };
  let product = null;
  try { product = await stripe.products.retrieve(item.productId); } catch (e) { if (!isMissing(e)) throw e; }
  if (!product) {
    log(`create product ${item.productId}`);
    if (!dryRun) product = await stripe.products.create({ id: item.productId, name: item.name, description: item.description, metadata: { fishtape_key: 'signup_deposit' } });
  } else if (product.name !== item.name || product.active === false) {
    log(`update product ${item.productId}`);
    if (!dryRun) await stripe.products.update(item.productId, { name: item.name, description: item.description, active: true });
  }
  const existing = (await stripe.prices.list({ lookup_keys: [DEPOSIT_LOOKUP_KEY], limit: 1 })).data[0] || null;
  const matches = existing && existing.active !== false && existing.unit_amount === DEPOSIT_CENTS && existing.currency === currency
    && !existing.recurring && productOf(existing) === item.productId;
  if (matches) {
    log(`ok ${DEPOSIT_LOOKUP_KEY} (${existing.id})`);
    return { key: 'signup_deposit', action: 'unchanged', priceId: existing.id };
  }
  log(`${existing ? 'replace' : 'create'} price ${DEPOSIT_LOOKUP_KEY} ${DEPOSIT_CENTS} ${currency} one-time`);
  if (dryRun) return { key: 'signup_deposit', action: existing ? 'would-replace' : 'would-create' };
  const price = await stripe.prices.create({
    product: item.productId, currency, unit_amount: DEPOSIT_CENTS, lookup_key: DEPOSIT_LOOKUP_KEY, transfer_lookup_key: true,
    tax_behavior: 'exclusive', metadata: { fishtape_key: 'signup_deposit' },
  });
  if (existing && existing.active !== false) await stripe.prices.update(existing.id, { active: false });
  return { key: 'signup_deposit', action: existing ? 'replaced' : 'created', priceId: price.id };
}

const fieldError = (path, message, text = 'Check the highlighted fields.') => new ApiError(400, 'validation_failed', text, { errors: [{ path, message }] });

/**
 * Validate and normalise the form (after the route's JSON schema). Never echoes values.
 * @returns {{ companyName: string, province: string, name: string, email: string, password: string, plan: string, users: number }}
 */
export function checkSignupForm(b) {
  const s = (v) => (typeof v === 'string' ? v.trim() : '');
  const out = {
    companyName: s(b.companyName), province: b.province, name: s(b.name), email: normaliseEmail(b.email),
    password: typeof b.password === 'string' ? b.password : '', plan: b.plan, users: Number(b.users),
  };
  if (!out.companyName) throw fieldError('/companyName', 'is required');
  if (!PROVINCES.includes(out.province)) throw fieldError('/province', 'must be a province or territory code');
  if (!out.name) throw fieldError('/name', 'is required');
  if (!EMAIL_RE.test(out.email)) throw fieldError('/email', 'must be a valid email address', 'That email address does not look right.');
  if (!SELF_SERVE_PLANS.includes(out.plan)) throw fieldError('/plan', 'must be starter, pro or business');
  if (!Number.isInteger(out.users) || out.users < 1 || out.users > MAX_USERS) throw fieldError('/users', `must be 1 to ${MAX_USERS}`);
  if (b.acceptTerms !== true) throw fieldError('/acceptTerms', 'must be accepted', 'Please accept the terms and privacy policy.');
  const problem = passwordProblem(out.password, out.email);
  if (problem) throw new ApiError(400, 'weak_password', problem, { errors: [{ path: '/password', message: problem }] });
  return out;
}

export function welcomeEmail({ to, name, link, planName, trialEndsAt, depositCents, monthly }) {
  const first = String(name || '').split(/\s+/)[0] || 'there';
  const after = monthly != null ? ` Then ${money(monthly)}/month plus tax, less the ${money(depositCents)} deposit on your first invoice.` : '';
  return {
    to, template: 'signup-welcome',
    subject: `Welcome to ${BRAND.name}: confirm your email`,
    text: `Hi ${first},\n\nYour ${BRAND.name} ${planName} trial is on until ${day(trialEndsAt)}.${after}\n\n`
      + `Confirm your email and set up two-step sign-in (a code from your phone) here. The link works once, for 7 days:\n\n${link}\n\n`
      + `You can also sign in any time with your email and password; you will be asked to set up two-step sign-in then.\n\n`
      + `If you did not sign up for ${BRAND.name}, reply to this email and we will cancel it and refund the deposit.\n`,
  };
}

/**
 * @param {{ config: import('../config.js').Config, db: import('../db.js').Db, email: ReturnType<import('../lib/email.js').createEmail>, billing?: ReturnType<typeof createBilling>, settings?: ReturnType<typeof signupSettings> }} deps
 */
export function createSignups({ config, db, email, billing = createBilling({ config, db }), settings = signupSettings(config) }) {
  const stripe = billing.stripe;
  const hq = hqSettings(config);
  let priceCache = { at: 0, ids: null };

  const unavailable = () => new ApiError(503, 'signup_unavailable', 'Online sign-up is not open yet. Contact Fishtape to get started.');
  function needStripe() {
    if (!stripe) throw unavailable();
    return stripe;
  }

  async function priceIds() {
    if (priceCache.ids && Date.now() - priceCache.at < 10 * 60_000) return priceCache.ids;
    const keys = [...Object.values(PRICE_KEYS), DEPOSIT_LOOKUP_KEY];
    const res = await needStripe().prices.list({ lookup_keys: keys, active: true, limit: 10 });
    const ids = Object.fromEntries(res.data.map((p) => [p.lookup_key, p.id]));
    for (const k of keys) if (!ids[k]) throw unavailable();
    priceCache = { at: Date.now(), ids };
    return ids;
  }

  /**
   * The terms and privacy versions people accept now: what HQ set in Settings (platform_settings),
   * else TERMS_VERSION. Loaded lazily: hq-settings.js imports constants from this file.
   */
  async function legalVersions(q = db) {
    try {
      const { readPlatformSettings } = await import('./hq-settings.js');
      const { legal } = await readPlatformSettings(q);
      return { terms: legal.terms.version || TERMS_VERSION, privacy: legal.privacy.version || TERMS_VERSION };
    } catch {
      return { terms: TERMS_VERSION, privacy: TERMS_VERSION };
    }
  }

  /** What the form needs to know: open or not, trial length, deposit, the terms version. */
  async function options() {
    return {
      open: Boolean(stripe), trialDays: trialDays(), depositCents: DEPOSIT_CENTS, currency: CURRENCY,
      plans: SELF_SERVE_PLANS, maxUsers: MAX_USERS, termsVersion: (await legalVersions()).terms,
    };
  }

  /** Close open sign-ups for this email (a second try replaces the first) or refuse if one is paying. */
  async function releasePending(addr) {
    const { rows } = await db.query("SELECT id, stripe_checkout_session_id FROM signups WHERE email = $1 AND status = 'pending'", [addr]);
    for (const r of rows) {
      if (r.stripe_checkout_session_id) {
        try {
          await needStripe().checkout.sessions.expire(r.stripe_checkout_session_id);
        } catch {
          // Already expired is fine; complete (or unknown) means it is being paid right now.
          let s = null;
          try { s = await needStripe().checkout.sessions.retrieve(r.stripe_checkout_session_id); } catch { /* treat as busy */ }
          if (s?.status !== 'expired') {
            throw new ApiError(409, 'signup_pending', 'A sign-up with this email is already being paid. Check your email in a minute, or try again later.');
          }
        }
      }
      await closeSignup(db, r.id, 'abandoned');
    }
  }

  /**
   * Start a sign-up: pending row + Stripe Checkout Session.
   * @returns {Promise<{ url: string, id: string }>}
   */
  async function start(body, { request } = {}) {
    const f = checkSignupForm(body);
    const s = needStripe();
    if ((await db.query('SELECT 1 FROM users WHERE email = $1', [f.email])).rows.length) {
      throw new ApiError(409, 'email_in_use', 'An account with this email already exists. Sign in instead.');
    }
    const prices = await priceIds();
    await cleanupSignups(db).catch(() => {});
    await releasePending(f.email);
    const id = randomUUID();
    const days = trialDays();
    const expiresAt = new Date(Date.now() + settings.checkoutMinutes * 60_000);
    const passwordHash = await hashSecret(f.password);
    const legal = await legalVersions();
    try {
      await db.query(
        `INSERT INTO signups (id, email, display_name, password_hash, company_name, province, plan, user_count, trial_days,
                              terms_version, terms_accepted_at, deposit_cents, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12)`,
        [id, f.email, f.name.slice(0, 200), passwordHash, f.companyName.slice(0, 200), f.province, f.plan, f.users, days, legal.terms, DEPOSIT_CENTS, expiresAt]);
    } catch (e) {
      if (e.code === '23505') throw new ApiError(409, 'signup_pending', 'A sign-up with this email is already in progress. Try again in a minute.');
      throw e;
    }
    const extra = extraSeats(f.plan, f.users);
    const back = (q) => `${settings.pageUrl}?${q}`;
    let session;
    try {
      session = await s.checkout.sessions.create({
        mode: 'subscription',
        line_items: [
          { price: prices[PRICE_KEYS[f.plan]], quantity: 1 },
          ...(extra > 0 ? [{ price: prices[PRICE_KEYS.extra_user], quantity: extra }] : []),
          { price: prices[DEPOSIT_LOOKUP_KEY], quantity: 1 },
        ],
        subscription_data: { trial_period_days: days, metadata: { fishtape_signup_id: id, plan: f.plan } },
        payment_method_types: ['card'],
        customer_email: f.email,
        client_reference_id: `signup_${id}`,
        metadata: { fishtape_signup_id: id, plan: f.plan },
        expires_at: Math.floor(expiresAt.getTime() / 1000),
        custom_text: { submit: { message: `${money(DEPOSIT_CENTS)} today confirms your card. It comes off your first invoice when the ${days}-day free trial ends. Cancel any time before then and you won't be charged for the plan.` } },
        success_url: back('done=1'),
        cancel_url: back(`plan=${f.plan}&cancelled=1`),
      }, { idempotencyKey: `fishtape-signup-${id}` });
    } catch (e) {
      await db.query('DELETE FROM signups WHERE id = $1', [id]);
      if (e instanceof ApiError) throw e;
      throw new ApiError(503, 'signup_unavailable', 'We could not reach our payment provider. Try again in a minute.');
    }
    await db.query('UPDATE signups SET stripe_checkout_session_id = $2, updated_at = now() WHERE id = $1', [id, session.id]);
    await db.tx((c) => appendAudit(c, null, {
      actor: ACTOR, action: 'signup.started', collection: 'signups', recordId: id, summary: `Self-serve sign-up started (${PLANS[f.plan].name})`, request,
    }));
    return { id, url: session.url };
  }

  // ---- webhook -------------------------------------------------------------------------

  async function recordEvent(q, event, tenantId, outcome, summary, { amount = null, cur = null } = {}) {
    await q.query(
      `INSERT INTO billing_events (id, type, tenant_id, amount_cents, currency, outcome, summary, stripe_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
      [event.id, String(event.type).slice(0, 100), tenantId, amount, cur, outcome, String(summary).slice(0, 500), toDate(event.created)]);
  }

  const loadSignup = async (id) => (isUuid(id) ? (await db.query('SELECT * FROM signups WHERE id = $1', [id])).rows[0] || null : null);

  async function notifyHq(q, subject, text, tenantId = null) {
    if (!hq.notifyEmail) return;
    await email.send(q, { to: hq.notifyEmail, template: 'hq-signup', subject: subject.slice(0, 150), text, tenantId });
  }

  /** Company, owner and subscription in one transaction; welcome email queued with it. */
  async function createCompany(row, obj, sub) {
    const tenantId = randomUUID();
    return db.withTenant({ tenantId }, async (tx) => {
      const cur = (await tx.query('SELECT * FROM signups WHERE id = $1 FOR UPDATE', [row.id])).rows[0];
      if (!cur || cur.status !== 'pending' || cur.tenant_id) return false; // done by a concurrent delivery
      const trialEndsAt = toDate(sub.trial_end) || new Date(Date.now() + cur.trial_days * 86_400_000);
      const { userId } = await insertTenantWithOwner(tx, {
        name: cur.company_name, province: cur.province, actor: ACTOR, trialEndsAt,
        owner: { email: cur.email, displayName: cur.display_name || cur.email, passwordHash: cur.password_hash },
      });
      await tx.query('UPDATE tenants SET stripe_customer_id = $2, updated_at = now() WHERE id = $1', [tenantId, obj.customer]);
      // The form's checkbox covered the terms (the version stored on the sign-up) and the privacy
      // policy in force then: record both so the app does not ask again.
      const legal = await legalVersions(tx);
      await tx.query(
        `INSERT INTO legal_acceptances (user_id, doc, version, accepted_at) VALUES ($1, 'terms', $2, $4), ($1, 'privacy', $3, $4) ON CONFLICT DO NOTHING`,
        [userId, cur.terms_version, legal.privacy, cur.terms_accepted_at]);
      await billing.applySubscription(tenantId, sub, { reason: 'sign-up', q: tx });
      const token = randomToken(WELCOME_PREFIX);
      const paid = Number.isInteger(obj.amount_total) ? obj.amount_total : cur.deposit_cents;
      await tx.query(
        `UPDATE signups SET status = 'completed', tenant_id = $2, user_id = $3, password_hash = NULL, stripe_customer_id = $4,
                stripe_subscription_id = $5, deposit_paid_cents = $6, deposit_paid_at = now(), trial_ends_at = $7,
                welcome_token_hash = $8, welcome_expires_at = now() + make_interval(secs => $9), completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [cur.id, tenantId, userId, obj.customer, sub.id, paid, trialEndsAt, sha256(token), WELCOME_TTL_S]);
      const planName = PLANS[cur.plan].name;
      await appendAudit(tx, tenantId, {
        actor: ACTOR, action: 'signup.completed', collection: 'tenants', recordId: tenantId,
        summary: `Self-serve sign-up: ${planName} trial until ${day(trialEndsAt)}; ${money(paid)} deposit paid`,
        meta: { plan: cur.plan, users: cur.user_count, trialEndsAt: trialEndsAt.toISOString(), depositCents: paid },
      });
      const link = `${config.publicOrigin}/#/welcome?token=${encodeURIComponent(token)}`;
      await email.send(tx, {
        ...welcomeEmail({ to: cur.email, name: cur.display_name, link, planName, trialEndsAt, depositCents: paid, monthly: monthlyCents(cur.plan, cur.user_count) }),
        tenantId,
      });
      await notifyHq(tx, `New sign-up: ${cur.company_name.slice(0, 80)} (${planName} trial)`,
        `${cur.company_name} signed up for a ${planName} trial (${cur.user_count} user${cur.user_count === 1 ? '' : 's'}${cur.province ? `, ${cur.province}` : ''}). `
        + `Deposit ${money(paid)} paid; the trial ends ${day(trialEndsAt)}.\n\nDetails in HQ: ${hqUrl(config)}#/tenants/${tenantId}\n`, tenantId);
      return true;
    }, { write: true });
  }

  /** The account could not be created (the email got an account meanwhile): stop billing, tell HQ. */
  async function failSignup(row, obj, sub, failure) {
    const paid = Number.isInteger(obj.amount_total) ? obj.amount_total : row.deposit_cents;
    await db.query(
      `UPDATE signups SET status = 'failed', failure = $2, password_hash = NULL, stripe_customer_id = $3, stripe_subscription_id = $4,
              deposit_paid_cents = $5, deposit_paid_at = now(), updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'expired', 'abandoned')`,
      [row.id, failure, obj.customer || null, sub?.id || null, paid]);
    if (sub?.id) { try { await needStripe().subscriptions.cancel(sub.id); } catch { /* HQ follows up */ } }
    await db.tx((c) => notifyHq(c, `Sign-up could not finish: ${row.company_name.slice(0, 80)}`,
      `A paid sign-up could not become a company (${failure.replace(/_/g, ' ')}). Its subscription was cancelled; refund the ${money(paid)} deposit in Stripe `
      + `and contact them.\n\nHQ: ${hqUrl(config)}#/tenants\n`));
  }

  /** -$1.00 on the Stripe customer balance: it comes off the first invoice after the trial. */
  async function creditDeposit(row) {
    const amount = row.deposit_paid_cents ?? row.deposit_cents;
    if (!amount || !row.stripe_customer_id) return;
    let txn;
    try {
      txn = await needStripe().customers.createBalanceTransaction(row.stripe_customer_id, {
        amount: -amount, currency, description: `${BRAND.name} sign-up deposit, credited to your first invoice`,
        metadata: { fishtape_signup_id: row.id, tenant_id: row.tenant_id },
      }, { idempotencyKey: `fishtape-signup-credit-${row.id}` });
    } catch (e) {
      // A refusal (4xx) will not fix itself: note it for HQ and stop Stripe retrying the event.
      if (e?.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) {
        await db.query('UPDATE signups SET credit_error = $2, updated_at = now() WHERE id = $1', [row.id, String(e.code || 'stripe_error').slice(0, 100)]);
        return;
      }
      throw e; // network or Stripe outage: the webhook fails and Stripe delivers it again
    }
    await db.withTenant({ tenantId: row.tenant_id }, async (tx) => {
      await tx.query('UPDATE signups SET credit_txn_id = $2, credited_at = now(), credit_error = NULL, updated_at = now() WHERE id = $1', [row.id, txn.id]);
      await appendAudit(tx, row.tenant_id, {
        actor: ACTOR, action: 'billing.deposit_credited', collection: 'tenants', recordId: row.tenant_id,
        summary: `${money(amount)} sign-up deposit credited to the first invoice`,
      });
    }, { write: true });
  }

  async function complete(event, row, obj) {
    if (row.status === 'pending' && obj.payment_status !== 'paid') {
      await recordEvent(db, event, null, 'ignored', 'Sign-up checkout finished; waiting for the payment');
      return { outcome: 'ignored' };
    }
    const alreadyDone = row.status === 'completed' && (row.credited_at || row.credit_error);
    if (alreadyDone) {
      await recordEvent(db, event, row.tenant_id, 'ignored', 'Sign-up already completed');
      return { outcome: 'ignored', duplicate: true };
    }
    if (row.status !== 'completed') {
      const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
      const sub = subId ? await needStripe().subscriptions.retrieve(subId, { expand: ['items.data.price'] }) : null;
      if (row.status !== 'pending' || !row.email || !row.password_hash || !sub) {
        await failSignup(row, obj, sub, row.status === 'pending' ? 'no_subscription' : 'late_payment');
        await recordEvent(db, event, null, 'applied', 'Sign-up could not finish: refund the deposit', { amount: obj.amount_total ?? null, cur: obj.currency || null });
        return { outcome: 'failed' };
      }
      try {
        await createCompany(row, obj, sub);
      } catch (e) {
        if (e?.code === 'email_in_use' || (e?.code === '23505' && /users_email/.test(e.constraint || ''))) {
          await failSignup(row, obj, sub, 'email_in_use');
          await recordEvent(db, event, null, 'applied', 'Sign-up could not finish: the email already has an account', { amount: obj.amount_total ?? null, cur: obj.currency || null });
          return { outcome: 'failed' };
        }
        throw e;
      }
      row = await loadSignup(row.id);
      if (row.status !== 'completed') {
        await recordEvent(db, event, null, 'ignored', `Sign-up is ${row.status}`);
        return { outcome: 'ignored' };
      }
    }
    if (!row.credited_at && !row.credit_error) await creditDeposit(row);
    await recordEvent(db, event, row.tenant_id, 'applied', 'Sign-up completed: company created, deposit credited',
      { amount: obj.amount_total ?? null, cur: obj.currency || null });
    return { outcome: 'applied' };
  }

  /**
   * One verified checkout.session.* event of a sign-up. Idempotent per event (billing_events)
   * and per session (the sign-up's status, a row lock, Stripe idempotency keys).
   * @returns {Promise<{ outcome: string, duplicate?: boolean }>}
   */
  async function handleEvent(event) {
    if (!event?.id || !event.type) throw new ApiError(400, 'bad_request', 'Not a Stripe event.');
    if ((await db.query('SELECT 1 FROM billing_events WHERE id = $1', [event.id])).rows.length) return { outcome: 'duplicate', duplicate: true };
    const obj = event.data?.object || {};
    const row = await loadSignup(obj.metadata?.fishtape_signup_id);
    if (!row || row.stripe_checkout_session_id !== obj.id) {
      await recordEvent(db, event, null, 'ignored', 'Sign-up event for an unknown checkout session');
      return { outcome: 'ignored' };
    }
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        return complete(event, row, obj);
      case 'checkout.session.expired': {
        const closed = row.status === 'pending' ? await closeSignup(db, row.id, 'expired') : false;
        await recordEvent(db, event, null, closed ? 'applied' : 'ignored', closed ? 'Sign-up checkout expired; details removed' : `Sign-up is ${row.status}`);
        return { outcome: closed ? 'applied' : 'ignored' };
      }
      case 'checkout.session.async_payment_failed': {
        const closed = row.status === 'pending' ? await closeSignup(db, row.id, 'failed', 'payment_failed') : false;
        await recordEvent(db, event, null, closed ? 'applied' : 'ignored', 'Sign-up payment failed');
        return { outcome: closed ? 'applied' : 'ignored' };
      }
      default:
        await recordEvent(db, event, null, 'ignored', 'Sign-up event not used');
        return { outcome: 'ignored' };
    }
  }

  // ---- welcome link -----------------------------------------------------------------------

  /**
   * Use a welcome link once: marks the email verified. The route then opens a session.
   * @returns {Promise<{ userId: string, tenantId: string }>}
   */
  async function useWelcomeToken(token) {
    const invalid = () => new ApiError(400, 'invalid_token', 'This link has expired or was already used. Sign in with your email and password instead.');
    if (typeof token !== 'string' || !token.startsWith(WELCOME_PREFIX) || token.length > 200) throw invalid();
    return db.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, user_id, tenant_id FROM signups
          WHERE welcome_token_hash = $1 AND welcome_used_at IS NULL AND welcome_expires_at > now() AND status = 'completed'
          FOR UPDATE`, [sha256(token)]);
      const s = rows[0];
      if (!s?.user_id || !s.tenant_id) throw invalid();
      await c.query('UPDATE signups SET welcome_used_at = now(), updated_at = now() WHERE id = $1', [s.id]);
      const u = await c.query("UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1 AND status = 'active' RETURNING id", [s.user_id]);
      if (!u.rows.length) throw invalid();
      return { userId: s.user_id, tenantId: s.tenant_id };
    });
  }

  return { stripe, configured: () => Boolean(stripe), settings, options, start, handleEvent, useWelcomeToken, priceIds };
}

/**
 * End a sign-up that never became a company and remove the person's details from it
 * (the company name, plan and dates stay for the funnel until the row is deleted).
 * @returns {Promise<boolean>} whether this call closed it
 */
export async function closeSignup(q, id, status, failure = null) {
  const { rowCount } = await q.query(
    `UPDATE signups SET status = $2, failure = $3, email = NULL, display_name = NULL, password_hash = NULL, updated_at = now()
      WHERE id = $1 AND status = 'pending'`, [id, status, failure]);
  return rowCount > 0;
}

/**
 * Housekeeping: pending sign-ups whose Checkout expired more than an hour ago (the expired
 * webhook never came) are abandoned and wiped; ended sign-ups go after 30 days.
 */
export async function cleanupSignups(db) {
  const abandoned = (await db.query(
    `UPDATE signups SET status = 'abandoned', email = NULL, display_name = NULL, password_hash = NULL, updated_at = now()
      WHERE status = 'pending' AND expires_at < now() - interval '1 hour'`)).rowCount;
  const deleted = (await db.query(
    "DELETE FROM signups WHERE status IN ('expired', 'abandoned', 'failed') AND updated_at < now() - interval '30 days'")).rowCount;
  const tokens = (await db.query(
    'UPDATE signups SET welcome_token_hash = NULL WHERE welcome_token_hash IS NOT NULL AND welcome_expires_at < now()')).rowCount;
  return { abandoned, deleted, tokens };
}

export const SIGNUP_HANDLERS = {
  async signup_cleanup({ db }) { return cleanupSignups(db); },
};

/** Hourly, deduplicated so many workers enqueue it once (worker.js housekeeping). */
export function scheduleSignupCleanup(db) {
  return enqueue(db, { kind: 'signup_cleanup', dedupeKey: 'signup_cleanup', maxAttempts: 3 });
}

/** HQ: recent sign-ups (all states), newest first. Never the password or link hashes. */
export async function listSignups(c, { status = null, limit = 200 } = {}) {
  const { rows } = await c.query(
    `SELECT s.id, s.status, s.email, s.display_name, s.company_name, s.province, s.plan, s.user_count, s.trial_days,
            s.deposit_cents, s.deposit_paid_cents, s.deposit_paid_at, s.credited_at, s.credit_error, s.tenant_id, s.trial_ends_at,
            s.welcome_used_at, s.failure, s.expires_at, s.created_at, s.completed_at, t.billing_status
       FROM signups s LEFT JOIN tenants t ON t.id = s.tenant_id
      WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.created_at DESC LIMIT $2`, [status, limit]);
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return rows.map((s) => ({
    id: s.id, status: s.status, companyName: s.company_name, name: s.display_name, email: s.email, province: s.province, plan: s.plan,
    users: s.user_count, trialDays: s.trial_days, depositCents: s.deposit_cents, depositPaid: Boolean(s.deposit_paid_at),
    depositPaidCents: s.deposit_paid_cents, depositCredited: Boolean(s.credited_at), creditError: s.credit_error,
    tenantId: s.tenant_id, billingStatus: s.billing_status || null, trialEndsAt: iso(s.trial_ends_at), emailVerified: Boolean(s.welcome_used_at),
    failure: s.failure, expiresAt: iso(s.expires_at), createdAt: iso(s.created_at), completedAt: iso(s.completed_at),
  }));
}

export const SIGNUP_STATUSES = ['pending', 'completed', 'expired', 'abandoned', 'failed'];
