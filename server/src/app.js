// Builds the Fastify app. index.js starts it; tests call buildApp() and use inject().
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { ApiError } from './errors.js';
import { BRAND } from './brand.js';
import { COLLECTIONS, MAX_RECORD_BYTES } from './collections.js';
import { loggerOptions } from './logger.js';
import { createSealer, sha256 } from './lib/crypto.js';
import { createEmail } from './lib/email.js';
import { createValidator } from './schemas.js';
import { createRecords } from './services/records.js';
import { createOidcProviders } from './auth/oidc.js';
import { installAuth } from './auth/guard.js';
import { looksLikeApiKey } from './auth/apikeys.js';
import healthRoutes from './routes/health.js';
import hqRoutes from './routes/hq.js';
import authRoutes from './routes/v1/auth.js';
import recordRoutes from './routes/v1/records.js';
import syncRoutes from './routes/v1/sync.js';
import adminRoutes from './routes/v1/admin.js';
import meRoutes from './routes/v1/me.js';

const MB = 1024 * 1024;
/** Sync pushes may carry one maximum-size record plus a normal batch. */
export const SYNC_BODY_LIMIT = MAX_RECORD_BYTES + 8 * MB;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * @param {object} o
 * @param {import('./config.js').Config} o.config
 * @param {import('./db.js').Db} o.db
 * @param {ReturnType<typeof createEmail>} [o.email]
 * @param {Record<string, import('./auth/oidc.js').OidcProvider>} [o.oidcProviders]
 * @param {ReturnType<typeof createValidator>} [o.validator]
 * @param {NodeJS.WritableStream} [o.logStream] capture logs (tests)
 */
export async function buildApp({ config, db, email = createEmail(), oidcProviders, validator = createValidator(), logStream }) {
  const app = Fastify({
    logger: loggerOptions(config, logStream),
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID();
    },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * MB,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', useDefaults: true, allErrors: false } },
  });

  const providers = oidcProviders ?? createOidcProviders(config);
  const records = createRecords({ validator });
  const stats = { since: new Date().toISOString(), total5xx: 0, total4xx: 0, byRoute: new Map() };
  app.decorate('sealer', createSealer(config.secretsMasterKey));
  app.decorate('db', db);

  // Response schemas document the API; bodies are always plain JSON.stringify so
  // extra record fields are never dropped by a schema-driven serializer.
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  // Error bodies never echo what was sent, SQL or stack traces: ApiError messages are
  // written to be safe, validation details name fields (not values), and everything
  // else gets a fixed message. APP_ENV=local adds the raw message for debugging.
  app.setErrorHandler((err, req, reply) => {
    let status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    let code = err instanceof ApiError ? err.code : null;
    let message = err instanceof ApiError ? err.message : null;
    let details = err instanceof ApiError ? err.details : undefined;
    if (err.validation) {
      status = 400; code = 'validation_failed'; message = 'The request is not valid.';
      details = { errors: err.validation.slice(0, 20).map((v) => ({ path: v.instancePath || `/${v.params?.missingProperty || ''}`, message: v.message })) };
    } else if (!code && status === 429) {
      code = 'rate_limited'; message = 'Too many requests. Try again shortly.';
    } else if (!code && status === 413) {
      code = 'too_large'; message = 'The request body is too large.';
    } else if (!code && status === 415) {
      code = 'unsupported_media_type'; message = 'Send JSON (Content-Type: application/json).';
    } else if (!code && status === 400 && /JSON|FST_ERR_CTP/.test(`${err.code} ${err.name}`)) {
      code = 'bad_json'; message = 'The request body is not valid JSON.';
    } else if (!code && status < 500) {
      code = 'bad_request'; message = 'The request could not be processed.';
    } else if (!code && ['ECONNREFUSED', '57P01', '57P03', '53300'].includes(err.code)) {
      status = 503; code = 'unavailable'; message = 'The service is unavailable. Try again shortly.';
    } else if (!code) {
      status = 500; code = 'internal'; message = 'Something went wrong. It has been logged.';
    }
    if (status >= 500) req.log.error({ err }, 'request failed');
    else if (!(err instanceof ApiError) && !err.validation) req.log.info({ err: { message: err.message, code: err.code } }, 'request refused');
    if (config.appEnv === 'local' && !(err instanceof ApiError)) details = { ...(details || {}), debug: String(err.message).slice(0, 500) };
    reply.code(status).send({ error: { code, message, requestId: req.id, ...(details ? { details } : {}) } });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: { code: 'not_found', message: 'No such endpoint.', requestId: req.id } });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 500) {
      stats.total5xx++;
      const k = `${req.method} ${req.routeOptions?.url || 'unknown'}`;
      stats.byRoute.set(k, (stats.byRoute.get(k) || 0) + 1);
    } else if (reply.statusCode >= 400) stats.total4xx++;
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, Boolean(origin) && config.corsOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Fishtape', 'X-Fishtape-Device', 'X-Request-Id', 'If-Match'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: config.rateLimit.enabled,
    max: (req) => {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
      return m && looksLikeApiKey(m[1]) ? config.rateLimit.apiKeyPerMinute : config.rateLimit.globalPerMinute;
    },
    timeWindow: '1 minute',
    // Per API key / bearer token when present (hashed), otherwise per client IP.
    keyGenerator: (req) => (req.headers.authorization ? `b:${sha256(req.headers.authorization).toString('hex').slice(0, 32)}` : `ip:${req.ip}`),
    errorResponseBuilder: (req, ctx) => new ApiError(429, 'rate_limited', `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)} seconds.`),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: `${BRAND.name} API`, version: config.version,
        description: 'Multi-tenant API for electrical contractors. Errors are { error: { code, message, requestId } }. Browser writes need X-Fishtape: 1.',
      },
      servers: [{ url: config.publicOrigin }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'ft_session' },
          bearer: { type: 'http', scheme: 'bearer', description: 'Session token (iOS app) or API key ft_live_… / ft_test_…' },
        },
      },
      security: [{ session: [] }, { bearer: [] }],
    },
    refResolver: { buildLocalReference: (json, baseUri, fragment, i) => json.$id || `def-${i}` },
  });

  app.addSchema({
    $id: 'error', type: 'object',
    properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object' } } } },
  });
  for (const c of COLLECTIONS) {
    const { $schema, $id, ...rest } = validator.schemas[c];
    app.addSchema({ ...rest, $id: `record.${c}` });
  }

  installAuth(app, { db, config });

  const deps = { config, db, records, email, oidcProviders: providers, stats, bodyLimit: SYNC_BODY_LIMIT };
  await app.register(healthRoutes, deps);
  await app.register(authRoutes, deps);
  await app.register(meRoutes, deps);
  await app.register(adminRoutes, deps);
  await app.register(recordRoutes, deps);
  await app.register(syncRoutes, deps);
  await app.register(hqRoutes, deps);

  app.get('/api/v1/openapi.json', { config: { auth: 'public' }, schema: { hide: true } }, async () => app.swagger());

  return app;
}
