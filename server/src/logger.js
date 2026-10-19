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
  '*.pin', '*.code', '*.recoveryCode', '*.secret', '*.apiKey', '*.key',
  '*.password_hash', '*.pin_hash', '*.secret_enc', '*.value',
];

const SECRET_QUERY = /([?&](?:code|state|token|key|password|pin|id_token|access_token)=)[^&#]*/gi;

/** Strip secret-looking query values from a URL before it is logged. */
export function redactUrl(url) {
  return String(url || '').replace(SECRET_QUERY, '$1[REDACTED]');
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
    },
  };
  if (stream) opts.stream = stream;
  return opts;
}
