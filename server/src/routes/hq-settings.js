// Platform settings for HQ and the legal documents people accept:
//   GET  /api/hq/settings                 editable settings + env settings (read-only, where to change)
//   PUT  /api/hq/settings                 support address, sender name, legal versions (HQ admin; audited)
//   GET  /api/hq/settings/stripe          which Stripe account, fishtape_* prices, webhook health
//   GET  /api/hq/settings/email           system email (Resend) set-up, outbox; ?live=1 asks Resend
//   GET  /api/v1/legal                    public: current terms and privacy versions and links
//   GET  /api/v1/legal/status             signed in: what this person still has to accept
//   POST /api/v1/legal/accept             signed in: accept the current version of a document
import { ApiError } from '../errors.js';
import { appendAudit, requestFacts } from '../services/audit.js';
import { createBilling } from '../services/billing.js';
import { hqAudit, requireHqAdmin } from '../services/hq-common.js';
import {
  LEGAL_DOCS, emailCheck, envSettings, legalStatus, readPlatformSettings, settingsProblems, stripeCheck,
} from '../services/hq-settings.js';

const legalDocSchema = {
  type: 'object', additionalProperties: false,
  properties: { version: { type: 'string', maxLength: 40 }, url: { type: 'string', maxLength: 500 }, requireReacceptance: { type: 'boolean' } },
};

/** @param {import('fastify').FastifyInstance} app */
export default async function hqSettingsRoutes(app, { config, db }) {
  const billing = createBilling({ config, db });
  const hq = { auth: 'hq' };
  const tags = ['hq'];
  const testResend = config.hq?.testResend; // tests inject a fake; otherwise the real Resend check

  app.get('/api/hq/settings', { config: hq, schema: { tags, summary: 'Platform settings: editable ones and env vars (read-only)' } }, async () => {
    const settings = await db.withHq((c) => readPlatformSettings(c));
    return { settings, env: envSettings(config) };
  });

  app.put('/api/hq/settings', {
    config: hq,
    schema: {
      tags, summary: 'Change the support address, sender name or legal document versions (HQ admin; audited)',
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          support: { type: 'object', additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 }, senderName: { type: 'string', maxLength: 80 } } },
          legal: { type: 'object', additionalProperties: false, properties: { terms: legalDocSchema, privacy: legalDocSchema } },
        },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const problems = settingsProblems(req.body);
    if (problems.length) throw new ApiError(400, 'validation_failed', 'Check the highlighted settings.', { errors: problems });
    return db.withHq(async (c) => {
      const before = await readPlatformSettings(c);
      const changes = [];
      if (req.body.support) {
        const next = { email: before.support.email, senderName: before.support.senderName, ...req.body.support };
        if (next.email) next.email = next.email.trim().toLowerCase();
        for (const k of ['email', 'senderName']) if (next[k] !== before.support[k]) changes.push(`support ${k}: ${before.support[k]} -> ${next[k]}`);
        await upsert(c, 'support', next, req);
      }
      if (req.body.legal) {
        const next = {};
        for (const doc of LEGAL_DOCS) {
          const prev = before.legal[doc];
          const patch = req.body.legal[doc] || {};
          const cur = { version: prev.version, url: prev.url, requireReacceptance: prev.requireReacceptance, updatedAt: prev.updatedAt, ...patch };
          if (cur.version !== prev.version || cur.url !== prev.url || cur.requireReacceptance !== prev.requireReacceptance) {
            cur.updatedAt = new Date().toISOString();
            changes.push(`${doc} ${prev.version} -> ${cur.version}${cur.requireReacceptance ? ' (everyone must accept again)' : ''}`);
          }
          next[doc] = cur;
        }
        await upsert(c, 'legal', next, req);
      }
      if (changes.length) {
        await hqAudit(c, req, null, { action: 'hq.settings_update', collection: 'platform_settings', summary: `Settings changed: ${changes.join('; ')}`.slice(0, 500), meta: { keys: Object.keys(req.body) } });
      }
      return { settings: await readPlatformSettings(c), changed: changes.length };
    });
  });

  async function upsert(c, key, value, req) {
    await c.query(
      `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [key, JSON.stringify(value), req.principal.userId]);
  }

  app.get('/api/hq/settings/stripe', { config: hq, schema: { tags, summary: 'Stripe account, fishtape_* prices and webhook health (no keys)' } }, async () => {
    return db.withHq((c) => stripeCheck({ stripe: billing.stripe, secretKey: billing.settings.secretKey, webhookSecret: billing.settings.webhookSecret, q: c }));
  });

  app.get('/api/hq/settings/email', {
    config: hq,
    schema: { tags, summary: 'System email set-up and outbox; live=1 checks the key and domain with Resend', querystring: { type: 'object', additionalProperties: false, properties: { live: { type: 'boolean', default: false } } } },
  }, async (req) => db.withHq((c) => emailCheck({ q: c, live: req.query.live, ...(testResend ? { test: testResend } : {}) })));

  // ---- legal documents (everyone) ------------------------------------------------

  app.get('/api/v1/legal', { config: { auth: 'public' }, schema: { tags: ['legal'], summary: 'Current terms and privacy policy versions and links' } }, async () => {
    const s = await readPlatformSettings(db);
    return Object.fromEntries(LEGAL_DOCS.map((doc) => [doc, { version: s.legal[doc].version, url: s.legal[doc].url, updatedAt: s.legal[doc].updatedAt }]));
  });

  app.get('/api/v1/legal/status', { config: { auth: 'user' }, schema: { tags: ['legal'], summary: 'Documents you have accepted and any you still need to accept' } }, async (req) => {
    return legalStatus(db, req.auth.session.user_id);
  });

  app.post('/api/v1/legal/accept', {
    config: { auth: 'user' },
    schema: {
      tags: ['legal'], summary: 'Accept the current version of the terms or the privacy policy',
      body: { type: 'object', required: ['doc', 'version'], additionalProperties: false, properties: { doc: { type: 'string', enum: LEGAL_DOCS }, version: { type: 'string', maxLength: 40 } } },
    },
  }, async (req) => {
    const s = req.auth.session;
    const current = (await readPlatformSettings(db)).legal[req.body.doc];
    if (req.body.version !== current.version) throw new ApiError(409, 'version_changed', 'This document changed again. Reload to read the latest version.');
    await db.tx(async (c) => {
      const r = await c.query(
        'INSERT INTO legal_acceptances (user_id, doc, version, ip) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [s.user_id, req.body.doc, current.version, req.ip?.slice(0, 100) || null]);
      if (r.rowCount) {
        await appendAudit(c, null, {
          actor: { type: 'user', id: s.user_id, label: s.display_name }, action: 'legal.accept', collection: 'legal_acceptances', recordId: `${req.body.doc}:${current.version}`,
          summary: `Accepted the ${req.body.doc === 'terms' ? 'terms' : 'privacy policy'} version ${current.version}`, request: requestFacts(req),
        });
      }
    });
    return legalStatus(db, s.user_id);
  });
}
