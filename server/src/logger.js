// pino options for Fastify. Credentials never reach the logs: auth headers, cookies,
// passwords, tokens, PINs, MFA codes and query-string secrets are redacted.

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-fishtape-device"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.password', '*.currentPassword', '*.newPassword',
  '*.token', '*.accessToken', '*.refreshToken', '*.idToken',
  '*.pin', '*.recoveryCode', '*.totp', '*.secret', '*.apiKey', '*.key',
  '*.password_hash', '*.pin_hash', '*.secret_enc', '*.value',
];

const SECRET_QUERY = /([?&](?:code|state|token|key|password|pin|id_token|access_token|hub\.verify_token|verify_token|secret|signature)=)[^&#]*/gi;

// The SendGrid Inbound Parse URL carries its secret as the last path segment.
const SECRET_PATH = /(\/webhooks\/sendgrid\/inbound\/)[^/?#]+/gi;

/** Strip secret-looking query values (and secret path segments) from a URL before it is logged. */
export function redactUrl(url) {
  return String(url || '').replace(SECRET_QUERY, '$1[REDACTED]').replace(SECRET_PATH, '$1[REDACTED]');
}

/**
 * @param {{ logLevel: string }} config
 * @param {NodeJS.WritableStream} [stream] for tests
 */
export function loggerOptions(config, stream) {
  const opts = {
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers: {
      req(req) {
        return { method: req.method, url: redactUrl(req.url), remoteAddress: req.ip, reqId: req.id };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
      err(e) {
        if (!e || typeof e !== 'object') return e;
        return { type: e.constructor?.name, message: e.message, code: e.code, statusCode: e.statusCode, stack: e.stack };
      },
    },
  };
  if (stream) opts.stream = stream;
  return opts;
}
