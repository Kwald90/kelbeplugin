// Health: /api/healthz (process up), /api/readyz (ready for traffic), /api/v1/status
// (public, no secrets), /api/hq/health (HQ staff only: the developer health view).
import { readFileSync, statfsSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { migrationStatus } from '../migrate.js';

async function timed(fn) {
  const t = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

async function queueStats(db) {
  const { rows } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed_24h,
            COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())), 0)::int AS lag_s
       FROM jobs_queue`);
  return rows[0];
}

/** @param {import('fastify').FastifyInstance} app */
export default async function healthRoutes(app, { config, db, stats }) {
  const hide = { hide: true };

  app.get('/api/healthz', { config: { auth: 'public', rateLimit: false }, schema: { ...hide, tags: ['health'] } }, async () => ({ status: 'ok' }));

  app.get('/api/readyz', { config: { auth: 'public', rateLimit: false }, schema: { ...hide, tags: ['health'] } }, async (req, reply) => {
    const checks = {};
    let ready = true;
    try {
      const { ms } = await timed(() => withTimeout(db.query('SELECT 1'), 2000));
      checks.database = { ok: true, ms: Math.round(ms) };
    } catch {
      checks.database = { ok: false };
      ready = false;
    }
    if (checks.database.ok) {
      const m = await migrationStatus(db);
      checks.migrations = { ok: m.pending.length === 0, current: m.current, latest: m.latest };
      if (!checks.migrations.ok) ready = false;
      try {
        const q = await queueStats(db);
        const ok = !config.readiness.maxQueueLagS || q.lag_s <= config.readiness.maxQueueLagS;
        checks.queue = { ok, lagSeconds: q.lag_s };
        if (!ok) ready = false;
      } catch {
        checks.queue = { ok: false };
        ready = false;
      }
    }
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks };
  });

  app.get('/api/v1/status', {
    config: { auth: 'public' },
    schema: {
      tags: ['health'], summary: 'Public service status (no secrets)',
      response: { 200: { type: 'object', properties: { status: { type: 'string' }, version: { type: 'string' }, environment: { type: 'string' }, gitSha: { type: 'string' }, time: { type: 'string' } } } },
    },
  }, async () => {
    let status = 'ok';
    try { await withTimeout(db.query('SELECT 1'), 2000); } catch { status = 'degraded'; }
    return { status, version: config.version, environment: config.appEnv, gitSha: config.gitSha.slice(0, 12), time: new Date().toISOString() };
  });

  app.get('/api/hq/health', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'Developer health for HQ staff' } }, async () => {
    const pool = db.pools.app;
    const latency = await timed(() => db.query('SELECT 1'));
    const m = await migrationStatus(db);
    const q = await queueStats(db);
    let lastBackup = null;
    if (config.backupStatusFile) {
      try { lastBackup = JSON.parse(readFileSync(config.backupStatusFile, 'utf8')); } catch { lastBackup = { error: 'unreadable' }; }
    }
    let certExpiry = null;
    if (config.tlsCertFile) {
      try { certExpiry = new Date(new X509Certificate(readFileSync(config.tlsCertFile)).validTo).toISOString(); } catch { certExpiry = 'unreadable'; }
    }
    let disk = null;
    try {
      const s = statfsSync(process.cwd());
      disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch { /* not supported */ }
    const mem = process.memoryUsage();
    return {
      environment: config.appEnv,
      version: config.version,
      gitSha: config.gitSha,
      uptimeSeconds: Math.round(process.uptime()),
      database: { latencyMs: Math.round(latency.ms * 10) / 10, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } },
      migrations: { current: m.current, latest: m.latest, pending: m.pending },
      queue: { queued: q.queued, running: q.running, failed24h: q.failed_24h, lagSeconds: q.lag_s },
      errors: { since: stats.since, total5xx: stats.total5xx, total4xx: stats.total4xx, byRoute: Object.fromEntries(stats.byRoute) },
      memory: { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed },
      lastBackup,
      certExpiry,
      disk,
    };
  });
}
