// /api/v1/webhooks/{stripe|facebook|twilio}/:tenantId — calls from providers into one company.
// Every POST is verified with that company's own secret before anything is read, so one
// company's secret can never post into another. Unknown companies and bad signatures get
// the same answer. Event ids are remembered, so provider retries are acknowledged once.
// Bodies are kept as raw strings here (signatures cover the exact bytes) and are never logged:
// these routes log at warn level, which skips the request/response lines.
import { ApiError } from '../../errors.js';
import { isUuid } from '../../db.js';
import { safeEqual } from '../../lib/crypto.js';
import { appendAudit, requestFacts } from '../../services/audit.js';
import { loadTenantPlan, tenantHas } from '../../services/entitlements.js';
import { getSecret } from '../../services/secrets.js';
import { ProviderError } from '../../integrations/http.js';
import { verifyStripeEvent } from '../../integrations/stripe.js';
import { fetchLead, mapLead, verifyFacebook } from '../../integrations/facebook.js';
import { optKeyword, toE164, verifyTwilio } from '../../integrations/twilio.js';
import { recordStripePayment } from '../../integrations/payments.js';
import { createFacebookLead } from '../../integrations/leads.js';
import { firstSeen, getSettings, optIn, optOut, providerSecrets, setStatus, systemPrincipal, systemWho, touchEvent } from '../../integrations/state.js';

const invalidSignature = () => new ApiError(400, 'invalid_signature', 'The webhook signature is not valid.');
const tenantParam = { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string', maxLength: 64 } } };

/** @param {import('fastify').FastifyInstance} app */
export default async function webhookRoutes(app, { config, db, records }) {
  const sealer = app.sealer;

  // Raw bodies, only inside this plugin.
  app.removeContentTypeParser(['application/json']);
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => done(null, body));
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => done(null, body));

  // csrf: false — providers cannot send X-Fishtape; the signature check replaces the CSRF guard.
  const opts = { logLevel: 'warn', config: { auth: 'public', csrf: false }, schema: { hide: true, params: tenantParam } };
  const raw = (req) => (typeof req.body === 'string' ? req.body : '');
  const secretOf = (tenantId, name) => db.withTenant({ tenantId }, (tx) => getSecret(tx, sealer, name));

  // ---- Stripe: checkout.session.completed / async_payment_succeeded -> payments record ----
  app.post('/api/v1/webhooks/stripe/:tenantId', opts, async (req) => {
    const { tenantId } = req.params;
    if (!isUuid(tenantId)) throw invalidSignature();
    const secret = await secretOf(tenantId, 'stripe.webhook_secret');
    const event = verifyStripeEvent(raw(req), req.headers['stripe-signature'], secret);
    if (!event || typeof event.id !== 'string') throw invalidSignature();
    const session = event.data?.object || {};
    const p = systemPrincipal(tenantId, 'stripe', 'Stripe');
    const w = systemWho(p, requestFacts(req));
    const out = await db.withTenant({ tenantId }, async (tx) => {
      if (!(await firstSeen(tx, 'stripe', event.id, event.type))) return { duplicate: true };
      await touchEvent(tx, 'stripe');
      // Only sessions Fishtape created for this company; the account may use Checkout for other things.
      if (session.object !== 'checkout.session' || session.metadata?.fishtape_tenant !== tenantId) return { ignored: true };
      const paid = (event.type === 'checkout.session.completed' && session.payment_status === 'paid') || event.type === 'checkout.session.async_payment_succeeded';
      if (!paid) return { ignored: true };
      return recordStripePayment(tx, records, p, w, session, event.id);
    }, { write: true });
    return { received: true, ...(out.duplicate ? { duplicate: true } : {}) };
  });

  // ---- Facebook Lead Ads ------------------------------------------------------------
  app.get('/api/v1/webhooks/facebook/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params;
    const q = req.query || {};
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];
    const refused = new ApiError(403, 'forbidden', 'Verification failed.');
    if (!isUuid(tenantId) || mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) throw refused;
    const expected = await secretOf(tenantId, 'facebook.verify_token');
    if (!expected || !safeEqual(expected, token)) throw refused;
    reply.type('text/plain; charset=utf-8');
    return challenge;
  });

  app.post('/api/v1/webhooks/facebook/:tenantId', opts, async (req) => {
    const { tenantId } = req.params;
    if (!isUuid(tenantId)) throw invalidSignature();
    const body = raw(req);
    const { secrets, cfg } = await db.withTenant({ tenantId }, async (tx) => ({
      secrets: await providerSecrets(tx, sealer, 'facebook'), cfg: (await getSettings(tx, 'facebook')).config || {},
    }));
    if (!verifyFacebook(body, req.headers['x-hub-signature-256'], secrets['facebook.app_secret'])) throw invalidSignature();
    const tenant = await loadTenantPlan(db, tenantId);
    if (!tenant || !tenantHas(tenant, 'integrations.facebook')) {
      await db.withTenant({ tenantId }, (tx) => setStatus(tx, 'facebook', 'error', 'A lead arrived, but your plan does not include Facebook Lead Ads, so it was not imported.'), { write: true });
      throw new ApiError(403, 'feature_not_in_plan', 'Your plan does not include this.');
    }
    let payload;
    try { payload = JSON.parse(body); } catch { throw new ApiError(400, 'bad_json', 'The request body is not valid JSON.'); }
    if (payload?.object !== 'page') return { received: true };
    const changes = (Array.isArray(payload.entry) ? payload.entry : [])
      .flatMap((e) => (Array.isArray(e?.changes) ? e.changes : []))
      .filter((c) => c?.field === 'leadgen' && c.value?.leadgen_id != null)
      .map((c) => c.value);
    const p = systemPrincipal(tenantId, 'facebook', 'Facebook Lead Ads');
    const w = systemWho(p, requestFacts(req));
    let created = 0;
    let failed = 0;
    for (const v of changes) {
      const leadgenId = String(v.leadgen_id);
      if (cfg.pageId && v.page_id != null && String(v.page_id) !== String(cfg.pageId)) continue;
      const known = await db.withTenant({ tenantId }, async (tx) => (await tx.query(
        'SELECT 1 FROM integration_events WHERE tenant_id = $1 AND provider = $2 AND event_id = $3', [tx.tenantId, 'facebook', leadgenId])).rows.length > 0);
      if (known) continue;
      let mapped;
      try {
        const lead = await fetchLead({ leadgenId, pageToken: secrets['facebook.page_token'], appSecret: secrets['facebook.app_secret'] });
        mapped = mapLead({ ...lead, id: lead.id || leadgenId });
      } catch (e) {
        if (!(e instanceof ProviderError)) throw e;
        failed++;
        await db.withTenant({ tenantId }, (tx) => setStatus(tx, 'facebook', 'error', `A lead could not be fetched: ${e.message}`), { write: true });
        continue;
      }
      await db.withTenant({ tenantId }, async (tx) => {
        if (!(await firstSeen(tx, 'facebook', leadgenId, 'leadgen'))) return;
        await touchEvent(tx, 'facebook');
        const r = await createFacebookLead(tx, records, p, w, mapped, { sequenceId: cfg.sequenceId || null });
        if (r.created) created++;
      }, { write: true });
    }
    // A failed fetch makes Facebook retry (for up to 36 hours), so fixing the token recovers the lead.
    if (failed) throw new ApiError(502, 'provider_error', 'Some leads could not be fetched; Facebook will retry.');
    return { received: true, created };
  });

  // ---- Twilio inbound SMS: STOP / START ------------------------------------------------
  app.post('/api/v1/webhooks/twilio/:tenantId', opts, async (req, reply) => {
    const { tenantId } = req.params;
    if (!isUuid(tenantId)) throw invalidSignature();
    const params = Object.fromEntries(new URLSearchParams(raw(req)));
    const authToken = await secretOf(tenantId, 'twilio.auth_token');
    // Twilio signs the exact public URL it called.
    if (!verifyTwilio(authToken, `${config.publicOrigin}${req.url}`, params, req.headers['x-twilio-signature'])) throw invalidSignature();
    const kw = optKeyword(params.Body);
    const phone = toE164(params.From);
    const eventId = typeof params.MessageSid === 'string' && params.MessageSid ? params.MessageSid : null;
    await db.withTenant({ tenantId }, async (tx) => {
      if (eventId && !(await firstSeen(tx, 'twilio', eventId, kw ? `opt-${kw}` : 'inbound'))) return;
      await touchEvent(tx, 'twilio');
      if (!kw || !phone) return;
      if (kw === 'out') await optOut(tx, phone, 'reply'); else await optIn(tx, phone);
      await appendAudit(tx, tx.tenantId, {
        actor: { type: 'system', id: 'twilio', label: 'Twilio' }, request: requestFacts(req),
        action: kw === 'out' ? 'integration.sms_opt_out' : 'integration.sms_opt_in', collection: 'sms_opt_outs', recordId: null,
        summary: kw === 'out' ? 'A contact replied STOP: no more texts to that number' : 'A contact replied START: texts allowed again',
      });
    }, { write: true });
    reply.type('text/xml; charset=utf-8');
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  });
}
