// Configuration from the environment. server/.env is read if it exists (values
// already in the environment win). Never commit real values: see .env.example.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const APP_VERSION = PKG.version;

/** Load server/.env into process.env without overriding values already set. */
export function loadEnvFile(file = ENV_FILE) {
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

/** The origin of an https URL (or http on localhost), else null. */
function originOf(v) {
  try {
    const u = new URL(String(v || '').trim());
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return u.origin;
  } catch { /* not a URL */ }
  return null;
}

/** A fixed, public development key: fine on a laptop, refused anywhere else. */
const LOCAL_DEV_MASTER_KEY = createHash('sha256').update('fishtape-local-development-only').digest('base64');

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function readConfig(env = process.env) {
  const appEnv = env.APP_ENV || 'local';
  if (!['local', 'test', 'staging', 'production'].includes(appEnv)) throw new Error(`APP_ENV must be local, test, staging or production (got ${appEnv})`);
  const deployed = appEnv === 'staging' || appEnv === 'production';
  const port = int(env.PORT, 3410);
  const publicOrigin = (env.PUBLIC_ORIGIN || `http://localhost:8080`).replace(/\/$/, '');

  let masterKey = env.SECRETS_MASTER_KEY || '';
  if (!masterKey) {
    if (deployed) throw new Error('SECRETS_MASTER_KEY is required in staging and production (base64 of 32 random bytes)');
    masterKey = LOCAL_DEV_MASTER_KEY;
  }
  if (Buffer.from(masterKey, 'base64').length !== 32) throw new Error('SECRETS_MASTER_KEY must be base64 of exactly 32 bytes');
  if (deployed && masterKey === LOCAL_DEV_MASTER_KEY) throw new Error('SECRETS_MASTER_KEY is the public development key; generate a real one');

  if (deployed && !env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  // The public status page (STATUS_PUBLIC_URL, e.g. status.fishtapehq.com) posts subscribe,
  // confirm and unsubscribe from its own host, so its origin passes the CSRF Origin check too.
  const statusOrigin = originOf(env.STATUS_PUBLIC_URL);
  const corsOrigins = [...new Set([publicOrigin, ...list(env.CORS_ORIGINS), ...(statusOrigin ? [statusOrigin] : []), 'capacitor://localhost'])];

  return {
    appEnv,
    isProduction: appEnv === 'production',
    deployed,
    version: APP_VERSION,
    gitSha: env.GIT_SHA || 'dev',
    port,
    host: env.HOST || '127.0.0.1',
    publicOrigin,
    corsOrigins,
    trustProxy: env.TRUST_PROXY || 'loopback,uniquelocal',
    logLevel: env.LOG_LEVEL || (appEnv === 'test' ? 'silent' : 'info'),
    databaseUrl: env.DATABASE_URL || 'postgres://fishtape_app@127.0.0.1:5433/fishtape',
    migrateDatabaseUrl: env.MIGRATE_DATABASE_URL || '',
    hqDatabaseUrl: env.HQ_DATABASE_URL || '',
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    secretsMasterKey: masterKey,
    // Cookies are Secure everywhere except plain-http local development.
    secureCookies: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : publicOrigin.startsWith('https://'),
    oidc: {
      google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, issuer: 'https://accounts.google.com' } : null,
      microsoft: env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
        ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET, issuer: `https://login.microsoftonline.com/${env.MICROSOFT_TENANT || 'common'}/v2.0` } : null,
    },
    session: {
      webTtlS: int(env.SESSION_TTL_S, 30 * 24 * 3600),
      webIdleS: int(env.SESSION_IDLE_S, 7 * 24 * 3600),
      crewTtlS: int(env.CREW_SESSION_TTL_S, 12 * 3600),
      crewIdleS: int(env.CREW_SESSION_IDLE_S, 2 * 3600),
    },
    lockout: {
      maxFailedLogins: int(env.LOGIN_MAX_FAILURES, 5),
      lockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
      maxFailedPins: int(env.PIN_MAX_FAILURES, 5),
      pinLockMinutes: int(env.PIN_LOCK_MINUTES, 15),
      maxDevicePinFailures: int(env.DEVICE_PIN_MAX_FAILURES, 20),
      maxMfaFailures: int(env.MFA_MAX_FAILURES, 5),
    },
    rateLimit: {
      enabled: env.RATE_LIMIT !== 'off',
      globalPerMinute: int(env.RATE_LIMIT_GLOBAL, 600),
      authPerMinute: int(env.RATE_LIMIT_AUTH, 10),
      apiKeyPerMinute: int(env.RATE_LIMIT_API_KEY, 300),
    },
    readiness: {
      maxQueueLagS: int(env.READY_MAX_QUEUE_LAG_S, 900),
    },
    backupStatusFile: env.BACKUP_STATUS_FILE || '',
    tlsCertFile: env.TLS_CERT_FILE || '',
    worker: {
      pollMs: int(env.WORKER_POLL_MS, 2000),
      concurrency: int(env.WORKER_CONCURRENCY, 2),
    },
  };
}

/** @typedef {ReturnType<typeof readConfig>} Config */
