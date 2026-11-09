// PUBLIC, unauthenticated booking front door (resi service-shop). Treat it as hostile:
//   GET  /api/v1/public/book/:slug/embed    the self-contained, frameable booking page (HTML)
//   GET  /api/v1/public/book/:slug/config    what the form needs (service types, fields, message)
//   POST /api/v1/public/book/:slug           create ONE kind:'service' lead in the resolved tenant
// The slug resolves a tenant with no tenant context (services/booking.js resolveBookingTenant,
// the same pattern as resolveCampaign). Every POST is rate-limited per IP and overall
// (createLeadLimiter), has a honeypot, a strict body schema (enums + max lengths) and never echoes
// what was sent. An unknown or disabled slug is a generic 404 — it never reveals tenant existence.
import { randomBytes } from 'node:crypto';
import { ApiError } from '../errors.js';
import { requestFacts } from '../services/audit.js';
import { createLeadLimiter } from './hq-leads.js';
import {
  SERVICE_TYPE_IDS, URGENCY_IDS, validSlug, publicBookingConfig, createServiceLead, resolveBookingTenant, renderBookingPage,
} from '../services/booking.js';

const slugParam = { type: 'object', required: ['slug'], properties: { slug: { type: 'string', maxLength: 63, pattern: '^[a-z0-9][a-z0-9-]{1,62}$' } } };

/**
 * The booking page's own Content-Security-Policy: frameable on any site (frame-ancestors *),
 * but default-src 'none' and script/style allowed only by this response's nonce, so it cannot be
 * turned into anything else. connect-src 'self' lets it call /config and POST on the same origin.
 */
const pageCsp = (nonce) => [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src 'self' data:",
  `style-src 'nonce-${nonce}'`,
  `script-src 'nonce-${nonce}'`,
  "connect-src 'self'",
  'frame-ancestors *',
].join('; ');

/** @param {import('fastify').FastifyInstance} app */
export default async function publicBookingRoutes(app, { db }) {
  const tags = ['public'];
  // Per-IP and global sliding one-hour windows, always on (separate from RATE_LIMIT), like the
  // sign-up and enterprise-lead intakes.
  const allow = createLeadLimiter({ perKey: 20, global: 400 });

  // The frameable page itself. The shell is the same for every slug and carries no tenant data, so
  // it can be served for any well-formed slug; /config and POST are the real gates (404 otherwise).
  app.get('/api/v1/public/book/:slug/embed', {
    config: { auth: 'public' },
    schema: { hide: true, params: slugParam },
  }, async (req, reply) => {
    if (!validSlug(req.params.slug)) throw new ApiError(404, 'not_found', 'No such booking page.');
    const nonce = randomBytes(16).toString('base64');
    reply.header('content-type', 'text/html; charset=utf-8');
    reply.header('content-security-policy', pageCsp(nonce));
    reply.removeHeader('x-frame-options'); // frameable by the shop's own site; CSP frame-ancestors governs it
    reply.header('cache-control', 'no-store');
    return renderBookingPage({ slug: req.params.slug, nonce });
  });

  app.get('/api/v1/public/book/:slug/config', {
    config: { auth: 'public' },
    schema: { tags, summary: 'What a shop\'s public booking form needs (service types, fields, confirmation message)', params: slugParam },
  }, async (req) => {
    const resolved = await resolveBookingTenant(db, req.params.slug);
    if (!resolved) throw new ApiError(404, 'not_found', 'No such booking page.');
    const settings = await db.withTenant({ tenantId: resolved.tenantId, userId: null }, async (tx) => {
      const { rows } = await tx.query(
        "SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [resolved.tenantId]);
      return rows[0]?.data || {};
    });
    return publicBookingConfig(settings);
  });

  app.post('/api/v1/public/book/:slug', {
    // csrf:false — a public, cookie-less, unauthenticated intake has no session to abuse, and the
    // form is meant to be submitted from the shop's own (cross-origin) website; the honeypot and
    // the per-IP/global rate limit are the abuse controls.
    config: { auth: 'public', csrf: false },
    onRequest: async (req) => {
      // Counted before validation, so malformed floods are limited too.
      if (!allow(`ip:${req.ip}`)) throw new ApiError(429, 'rate_limited', 'Too many requests. Please try again later or call the shop.');
    },
    schema: {
      tags, summary: 'Submit a service request: creates one service-request lead in the shop\'s pipeline',
      params: slugParam,
      body: {
        type: 'object', additionalProperties: false, required: ['contactName', 'phone'],
        properties: {
          contactName: { type: 'string', minLength: 1, maxLength: 200 },
          phone: { type: 'string', minLength: 1, maxLength: 40 },
          email: { type: 'string', maxLength: 254 },
          serviceType: { type: 'string', enum: SERVICE_TYPE_IDS },
          urgency: { type: 'string', enum: URGENCY_IDS },
          address: { type: 'string', maxLength: 300 },
          preferredTimes: { type: 'string', maxLength: 300 },
          description: { type: 'string', maxLength: 20000 },
          // Honeypot: hidden from people, so anything in it came from a bot.
          website: { type: 'string', maxLength: 500 },
        },
      },
    },
  }, async (req, reply) => {
    // Resolve first: an unknown or disabled slug is a generic 404 whether or not the body is a bot's.
    const resolved = await resolveBookingTenant(db, req.params.slug);
    if (!resolved) throw new ApiError(404, 'not_found', 'No such booking page.');
    if (typeof req.body.website === 'string' && req.body.website.trim()) {
      // Looks accepted (the form shows the confirmation); nothing is stored.
      reply.code(201);
      return { ok: true };
    }
    await createServiceLead(db, resolved.tenantId, req.body, { request: requestFacts(req), source: 'booking' });
    reply.code(201);
    return { ok: true };
  });
}
