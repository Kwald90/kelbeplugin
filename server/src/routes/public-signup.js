// Self-serve sign-up (services/signup.js has the flow and the Stripe facts it relies on).
//   GET  /api/v1/public/signup           what the form needs: open?, trial days, deposit
//   POST /api/v1/public/signup           the form -> pending sign-up + Stripe Checkout ({ url })
//   POST /api/v1/public/signup/welcome   the welcome email's one-time link -> session, then MFA set-up
//   GET  /api/hq/signups                 HQ: recent sign-ups, deposit paid and credited, trial end
// The Checkout -> company step happens in the signed platform webhook (routes/hq-billing.js).
//
// Like the Enterprise form: rate-limited per IP and overall (always on, separate from
// RATE_LIMIT), a honeypot field, validation that names fields but never echoes values, and
// nothing the visitor typed in the logs or the audit log.
import { ApiError } from '../errors.js';
import { BRAND } from '../brand.js';
import { requestFacts, appendAudit } from '../services/audit.js';
import { createSession, lookupSession, mfaState } from '../auth/sessions.js';
import { PROVINCES } from '../services/tenants.js';
import { SELF_SERVE_PLANS } from '../services/billing.js';
import { MAX_USERS, SIGNUP_STATUSES, createSignups, listSignups } from '../services/signup.js';
import { createLeadLimiter } from './hq-leads.js';
import { authLimit, setSessionCookie } from './util.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function publicSignupRoutes(app, { config, db, email }) {
  const signups = createSignups({ config, db, email });
  const allow = createLeadLimiter({ perKey: signups.settings.perHour, global: signups.settings.globalPerHour });
  const tags = ['public'];

  app.get('/api/v1/public/signup', { config: { auth: 'public' }, schema: { tags, summary: 'Sign-up options: open, trial length, deposit, plans' } },
    async () => signups.options());

  app.post('/api/v1/public/signup', {
    config: { auth: 'public' },
    onRequest: async (req) => {
      // Counted before validation, so malformed floods are limited too.
      if (!allow(`ip:${req.ip}`)) throw new ApiError(429, 'rate_limited', 'Too many sign-up attempts. Try again in an hour, or contact us.');
    },
    schema: {
      tags, summary: `Start a ${BRAND.name} trial: stores a pending sign-up and returns a Stripe Checkout URL (trial + $1 deposit)`,
      body: {
        type: 'object', additionalProperties: false,
        required: ['companyName', 'province', 'name', 'email', 'password', 'plan', 'users', 'acceptTerms'],
        properties: {
          companyName: { type: 'string', minLength: 1, maxLength: 200 },
          province: { type: 'string', enum: PROVINCES },
          name: { type: 'string', minLength: 1, maxLength: 200 },
          email: { type: 'string', minLength: 3, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 256 },
          plan: { type: 'string', enum: SELF_SERVE_PLANS },
          users: { type: 'integer', minimum: 1, maximum: MAX_USERS },
          acceptTerms: { type: 'boolean' },
          // Honeypot: hidden from people, so anything in it came from a bot.
          website: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    if (typeof req.body.website === 'string' && req.body.website.trim()) {
      // Looks accepted (the page shows "check your email"); nothing is stored or charged.
      reply.code(201);
      return { url: `${signups.settings.pageUrl}?done=1` };
    }
    const out = await signups.start(req.body, { request: requestFacts(req) });
    reply.code(201);
    return { url: out.url };
  });

  app.post('/api/v1/public/signup/welcome', {
    config: { auth: 'public', rateLimit: authLimit(config) },
    schema: {
      tags, summary: 'Use the welcome link once: verifies the email and signs in (two-step sign-in set-up comes next)',
      body: {
        type: 'object', required: ['token'], additionalProperties: false,
        properties: { token: { type: 'string', minLength: 1, maxLength: 200 }, mode: { type: 'string', enum: ['cookie', 'bearer'] } },
      },
    },
  }, async (req, reply) => {
    const { userId, tenantId } = await signups.useWelcomeToken(req.body.token);
    const kind = req.body.mode === 'bearer' ? 'bearer' : 'web';
    const s = await createSession(db, {
      userId, tenantId, kind, authMethod: 'welcome', ttlS: config.session.webTtlS, idleS: config.session.webIdleS, request: requestFacts(req),
    });
    if (kind === 'web') setSessionCookie(reply, config, s.token, config.session.webTtlS);
    await db.query('UPDATE memberships SET last_used_at = now() WHERE user_id = $1 AND tenant_id = $2', [userId, tenantId]);
    await db.withTenant({ tenantId, userId }, (tx) => appendAudit(tx, tenantId, {
      actor: { type: 'user', id: userId }, action: 'auth.welcome_link', request: requestFacts(req), summary: 'Confirmed the email from the welcome link and signed in',
    }), { write: true });
    const { row } = await lookupSession(db, s.token);
    const state = row ? mfaState(row) : 'enrol';
    return { mfa: state === 'ok' ? null : state, expiresAt: s.expiresAt, ...(kind === 'bearer' ? { token: s.token } : {}) };
  });

  app.get('/api/hq/signups', {
    config: { auth: 'hq' },
    schema: {
      tags: ['hq'], summary: 'Self-serve sign-ups, newest first: status, deposit paid and credited, trial end',
      querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: SIGNUP_STATUSES } } },
    },
  }, async (req) => {
    const data = await db.withHq((c) => listSignups(c, { status: req.query.status || null }));
    const byStatus = Object.fromEntries(SIGNUP_STATUSES.map((s) => [s, 0]));
    for (const s of data) byStatus[s.status]++;
    return { data, byStatus, stripeConfigured: signups.configured() };
  });
}
