// POST /api/v1/webhooks/qbo: Intuit's webhooks (docs/integrations/quickbooks.md 5.9, 7.3). Public and
// signed: the HMAC is checked on the raw body before anything is parsed or stored (W1 receiveWebhook),
// CSRF is off (Intuit cannot send X-Fishtape), the body may be up to 4 MB, and the route logs at warn
// level so no request line is written. Events only mark tenants dirty or fill the inbox; the sync
// reads every change itself.
import { receiveWebhook } from '../../qbo/webhook.js';

const MB = 1024 * 1024;

/** @param {import('fastify').FastifyInstance} app */
export default async function qboWebhookRoutes(app, { config, db }) {
  // Raw bodies, only inside this plugin (the signature covers the exact bytes).
  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 4 * MB }, (req, body, done) => done(null, body));
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 4 * MB }, (req, body, done) => done(null, body));

  app.post('/api/v1/webhooks/qbo', {
    logLevel: 'warn',
    bodyLimit: 4 * MB,
    config: { auth: 'public', csrf: false },
    schema: { hide: true },
  }, async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');
    const sig = req.headers['intuit-signature'];
    const r = await receiveWebhook(db, app.sealer, config, raw, typeof sig === 'string' ? sig : undefined);
    reply.code(r.status);
    if (r.status >= 400 && r.body?.error) return { error: { ...r.body.error, requestId: req.id } };
    return r.body;
  });
}
