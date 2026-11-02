// Fishtape's own platform keys (its SendGrid/Resend and Stripe), set by an HQ admin instead of only
// in the server .env. A set value overrides the matching env var (services/platform-secrets.js).
//   GET    /api/hq/platform-keys          every key: whether it's set, a hint, env fallback (no secrets)
//   PUT    /api/hq/platform-keys/:name    set or replace one key (HQ admin; audited; value never logged)
//   DELETE /api/hq/platform-keys/:name    remove one key, so the env value (if any) takes over (HQ admin)
import { ApiError } from '../errors.js';
import { hqAudit, requireHqAdmin } from '../services/hq-common.js';
import {
  PLATFORM_PROVIDERS, deletePlatformSecret, isPlatformSecret, listPlatformSecrets, setPlatformSecret,
} from '../services/platform-secrets.js';

/** @param {import('fastify').FastifyInstance} app */
export default async function hqPlatformKeysRoutes(app, { db }) {
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  app.get('/api/hq/platform-keys', { config: hq, schema: { tags, summary: 'Platform keys: which are set, hints and env fallback (no secret values)' } }, async () => {
    return { providers: PLATFORM_PROVIDERS, keys: await listPlatformSecrets(db) };
  });

  app.put('/api/hq/platform-keys/:name', {
    config: hq,
    schema: {
      tags, summary: 'Set or replace a platform key (HQ admin; audited; the value is never logged)',
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 64 } } },
      body: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string', minLength: 1, maxLength: 8192 } } },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const { name } = req.params;
    if (!isPlatformSecret(name)) throw new ApiError(404, 'not_found', 'Unknown platform key.');
    const { hint } = await setPlatformSecret(db, app.sealer, name, req.body.value, req.principal.userId);
    await db.withHq((c) => hqAudit(c, req, null, { action: 'hq.platform_key_set', collection: 'platform_secrets', recordId: name, summary: `Platform key set: ${name} (${hint})` }));
    return { keys: await listPlatformSecrets(db) };
  });

  app.delete('/api/hq/platform-keys/:name', {
    config: hq,
    schema: {
      tags, summary: 'Remove a platform key so the env value (if any) takes over (HQ admin; audited)',
      params: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 64 } } },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const { name } = req.params;
    if (!isPlatformSecret(name)) throw new ApiError(404, 'not_found', 'Unknown platform key.');
    const { removed } = await deletePlatformSecret(db, name);
    if (removed) await db.withHq((c) => hqAudit(c, req, null, { action: 'hq.platform_key_remove', collection: 'platform_secrets', recordId: name, summary: `Platform key removed: ${name}` }));
    return { keys: await listPlatformSecrets(db) };
  });
}
