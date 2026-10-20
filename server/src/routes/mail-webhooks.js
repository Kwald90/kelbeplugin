// Public mail endpoints on the tenant API (fishtape_app; docs/email/README.md):
//   POST /api/v1/webhooks/sendgrid/events           SendGrid Signed Event Webhook -> email_outbox
//   POST /api/v1/webhooks/sendgrid/inbound/:token   SendGrid Inbound Parse (raw MIME) -> mail_inbound
//   POST /api/v1/support/requests                   in-app support request -> mail_inbound + confirmation
// The app role can only INSERT into the drop boxes; hq-api files the mail (src/email/inbox.js).
// Bodies, addresses and the inbound token are never logged: the webhook routes log at warn
// level (no request lines) and the logger redacts the token segment of the URL.
import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, notFound } from '../errors.js';
import { BRAND } from '../brand.js';
import { appendAudit, requestFacts } from '../services/audit.js';
import { enqueue } from '../services/queue.js';
import { mailSettings } from '../email/config.js';
import { createMailStore } from '../email/storage.js';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, recordEvents, verifySignedRequest } from '../email/events.js';
import { MultipartError, parseMultipart, textField } from '../email/multipart.js';
import { parseMime } from '../email/mime.js';
import { CATEGORIES, confirmationEmail, decodeScreenshot, supportPayload, supportReference } from '../email/support.js';

const MiB = 1024 * 1024;
const MAX_MIME_BYTES = 30 * MiB;
const refused = () => new ApiError(403, 'invalid_signature', 'The webhook signature is not valid.');

const digest = (s) => createHash('sha256').update(String(s)).digest();
/** Constant-time comparison of the URL token with SENDGRID_INBOUND_TOKEN (hashes are equal length). */
export function tokenMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** Per user: at most `perHour` in an hour and `perDay` in a day (in memory, per process). */
export function createSupportLimiter({ perHour, perDay, now = () => Date.now() }) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const mine = (hits.get(key) || []).filter((x) => t - x < 86_400_000);
    const lastHour = mine.filter((x) => t - x < 3_600_000).length;
    if (lastHour >= perHour || mine.length >= perDay) { hits.set(key, mine); return false; }
    mine.push(t);
    hits.set(key, mine);
    if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((x) => t - x < 86_400_000)) hits.delete(k);
    return true;
  };
}

/** @param {import('fastify').FastifyInstance} app */
export default async function mailWebhookRoutes(app, { config, db }) {
  const settings = mailSettings(config);
  const store = createMailStore(settings);

  // ---- SendGrid webhooks: raw bodies, because the signatures cover the exact bytes ----------------
  await app.register(async (hooks) => {
    hooks.removeContentTypeParser(['application/json']);
    hooks.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
    hooks.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (req, body, done) => done(null, body));
    const opts = { logLevel: 'warn', config: { auth: 'public', csrf: false }, schema: { hide: true } };

    hooks.post('/api/v1/webhooks/sendgrid/events', { ...opts, bodyLimit: 10 * MiB }, async (req) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const v = verifySignedRequest(settings.eventPublicKey, body, req.headers[SIGNATURE_HEADER], req.headers[TIMESTAMP_HEADER], { maxAgeS: settings.eventMaxAgeS });
      if (!v.ok) {
        req.log.warn({ reason: v.reason }, 'sendgrid event webhook refused');
        throw refused();
      }
      let events;
      try { events = JSON.parse(body.toString('utf8')); } catch { throw new ApiError(400, 'bad_json', 'The request body is not valid JSON.'); }
      if (!Array.isArray(events)) throw new ApiError(400, 'bad_request', 'Expected a JSON array of events.');
      const r = await recordEvents(db, events, { appEnv: settings.appEnv });
      return { received: events.length, applied: r.applied, duplicates: r.duplicates };
    });

    hooks.post('/api/v1/webhooks/sendgrid/inbound/:token', {
      ...opts,
      bodyLimit: settings.inboundMaxBytes,
      schema: { hide: true, params: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 200 } } } },
      // Checked before the body is read, so a wrong URL never buffers 30 MB.
      onRequest: async (req) => {
        if (!tokenMatches(req.params?.token, settings.inboundToken)) throw notFound('No such endpoint.');
      },
    }, async (req) => {
      const body = Buffer.isBuffer(req.body) ? req.body : null;
      if (!body) throw new ApiError(415, 'unsupported_media_type', 'Send multipart/form-data (SendGrid Inbound Parse).');
      if (settings.inboundPublicKey) {
        const v = verifySignedRequest(settings.inboundPublicKey, body, req.headers[SIGNATURE_HEADER], req.headers[TIMESTAMP_HEADER], { maxAgeS: settings.eventMaxAgeS });
        if (!v.ok) { req.log.warn({ reason: v.reason }, 'sendgrid inbound refused'); throw refused(); }
      }
      let fields;
      try { fields = parseMultipart(body, req.headers['content-type']); } catch (e) {
        if (e instanceof MultipartError) throw new ApiError(400, 'bad_request', 'The form data could not be read.');
        throw e;
      }
      const raw = fields.get('email')?.value;
      if (!raw || !raw.length) {
        req.log.warn('sendgrid inbound without raw MIME: turn on "POST the raw, full MIME message"');
        throw new ApiError(400, 'raw_mime_required', 'Turn on "POST the raw, full MIME message" for this Inbound Parse host.');
      }
      if (raw.length > MAX_MIME_BYTES) throw new ApiError(413, 'too_large', 'The message is larger than 30 MB.');
      // 503 makes SendGrid retry (for up to 3 days), so nothing is lost while MAIL_DIR is fixed.
      if (!store) throw new ApiError(503, 'mail_storage_unavailable', 'Mail storage is not configured.');

      let message;
      try {
        message = await parseMime(raw);
      } catch {
        message = { messageId: null, inReplyTo: null, references: [], subject: '(this message could not be read)', from: null, to: [], cc: [], replyTo: [], date: null,
          text: 'Fishtape could not read this message. Download the original (.eml) to see it.', html: '', truncated: false, autoSubmitted: false, attachments: [] };
      }
      let envelope = {};
      try { envelope = JSON.parse(textField(fields, 'envelope', 64 * 1024)) || {}; } catch { envelope = {}; }
      const spam = Number.parseFloat(textField(fields, 'spam_score', 32));
      const saved = [];
      try {
        const rawFile = await store.save(raw);
        saved.push(rawFile.key);
        const attachments = [];
        for (const a of message.attachments) {
          const f = await store.save(a.bytes);
          saved.push(f.key);
          attachments.push({ key: f.key, filename: a.filename, contentType: a.contentType, size: f.size, sha256: f.sha256, contentId: a.contentId, inline: a.inline });
        }
        const { attachments: _bytes, ...msg } = message;
        const payload = {
          message: msg,
          envelope: { to: (Array.isArray(envelope.to) ? envelope.to : []).map((x) => String(x).toLowerCase().slice(0, 320)).slice(0, 100), from: typeof envelope.from === 'string' ? envelope.from.toLowerCase().slice(0, 320) : null },
          spamScore: Number.isFinite(spam) ? spam : null,
          auth: { spf: textField(fields, 'SPF', 100) || null, dkim: textField(fields, 'dkim', 1000) || null },
          attachments,
          rawKey: rawFile.key,
          size: raw.length,
        };
        await db.query('INSERT INTO mail_inbound (source, payload) VALUES ($1, $2)', ['parse', payload]);
      } catch (e) {
        for (const k of saved) await store.remove(k).catch(() => {});
        throw e;
      }
      return { received: true };
    });
  });

  // ---- support requests from inside the app ---------------------------------------------------------
  const allow = createSupportLimiter({ perHour: settings.supportPerHour, perDay: settings.supportPerDay });
  app.post('/api/v1/support/requests', {
    config: { auth: 'tenant', apiKey: false, rateLimit: config.rateLimit.enabled ? { max: 10, timeWindow: '1 minute' } : false },
    bodyLimit: 8 * MiB,
    schema: {
      tags: ['support'], summary: 'Send a message to Fishtape support (files it in HQ, emails the user a confirmation)',
      body: {
        type: 'object', required: ['subject', 'message'], additionalProperties: false,
        properties: {
          subject: { type: 'string', minLength: 1, maxLength: 200 },
          message: { type: 'string', minLength: 1, maxLength: 10000 },
          category: { type: 'string', enum: CATEGORIES },
          appVersion: { type: 'string', maxLength: 40, pattern: '^[A-Za-z0-9._+-]*$' },
          page: { type: 'string', maxLength: 200 },
          screenshot: { type: 'string', maxLength: 7_000_000 },
        },
      },
    },
  }, async (req, reply) => {
    const p = req.principal;
    if (!p.userId) throw new ApiError(403, 'forbidden', 'Sign in to contact support.');
    if (!String(req.body.subject).trim() || !String(req.body.message).trim()) throw new ApiError(400, 'validation_failed', 'Write a subject and a message.');
    if (!allow(`u:${p.userId}`)) throw new ApiError(429, 'rate_limited', 'You have sent several requests recently. Please wait a while, or email us.');
    let shot;
    try { shot = decodeScreenshot(req.body.screenshot); } catch (e) { throw new ApiError(400, e.code || 'bad_request', e.message); }
    if (shot && !store) throw new ApiError(503, 'mail_storage_unavailable', 'Screenshots cannot be stored right now. Send the request without one.');

    const user = (await db.query('SELECT id, display_name, email FROM users WHERE id = $1', [p.userId])).rows[0];
    const tenant = (await db.query('SELECT id, name, plan FROM tenants WHERE id = $1', [p.tenantId])).rows[0];
    if (!user || !tenant) throw new ApiError(403, 'forbidden', 'Sign in to contact support.');
    const reference = supportReference();
    let saved = null;
    if (shot) {
      const f = await store.save(shot.bytes);
      saved = { key: f.key, size: f.size, sha256: f.sha256, contentType: shot.contentType, filename: shot.filename };
    }
    const now = new Date();
    const u = { id: user.id, name: user.display_name, email: user.email || null };
    try {
      await db.tx(async (c) => {
        const payload = supportPayload({ reference, user: u, tenant, role: p.role, body: req.body, userAgent: req.headers['user-agent'], screenshot: saved, domain: settings.domain, now });
        await c.query('INSERT INTO mail_inbound (source, payload) VALUES ($1, $2)', ['support', payload]);
        if (u.email) {
          const m = confirmationEmail({ reference, user: u, subject: req.body.subject, appName: BRAND.name, domain: settings.domain, replyTo: settings.supportAddress });
          await c.query(
            `INSERT INTO email_outbox (tenant_id, to_address, subject, text_body, template, reply_to, headers) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [tenant.id, m.to, m.subject, m.text, m.template, m.replyTo, JSON.stringify(m.headers)]);
          await enqueue(c, { kind: 'platform_email', payload: { once: true }, dedupeKey: 'platform_email:now', maxAttempts: 1 });
        }
      });
    } catch (e) {
      if (saved) await store.remove(saved.key).catch(() => {});
      throw e;
    }
    await db.withTenant({ tenantId: p.tenantId, userId: p.userId }, (tx) => appendAudit(tx, tx.tenantId, {
      actor: p.actor, request: requestFacts(req), action: 'support.request', collection: null, recordId: reference, summary: `Support request ${reference} sent to ${BRAND.name}`,
    }), { write: true });
    reply.code(201);
    return { reference, received: true, confirmationEmailed: Boolean(u.email) };
  });
}
