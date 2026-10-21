// Developer health for HQ: everything about this API process and its environment, plus
// the public status of the other environments. Read-only; no tenant data.
import { closeSync, openSync, readFileSync, readSync, statSync, statfsSync } from 'node:fs';
import { connect as tlsConnect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import { dirname } from 'node:path';
import { migrationStatus } from '../migrate.js';

const DAY = 86_400_000;

async function timed(fn) {
  const t = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

/** Last `bytes` of a file as text (deploy logs grow forever). */
export function tailFile(file, bytes = 64 * 1024) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

const clip = (v, n = 200) => (v == null ? null : String(v).slice(0, n));

/**
 * Recent deploys from DEPLOY_LOG_FILE: JSON lines ({ at, sha, env, ref, by, ok, message })
 * or plain text lines "<ISO time> <sha> <message>". Newest first.
 */
export function parseDeployLog(text, limit = 10) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines.slice(-200)) {
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        out.push({
          at: clip(j.at || j.time || j.finishedAt || j.date, 40), sha: clip(j.sha || j.gitSha || j.commit, 40), environment: clip(j.env || j.environment, 20),
          ref: clip(j.ref || j.branch || j.tag, 80), by: clip(j.by || j.actor, 80), ok: j.ok ?? (j.status ? j.status === 'ok' || j.status === 'success' : null),
          message: clip(j.message || j.msg, 200),
        });
        continue;
      } catch { /* fall through to text */ }
    }
    const m = /^(\S+)\s+([0-9a-f]{7,40})?\s*(.*)$/i.exec(line);
    out.push({ at: clip(m?.[1], 40), sha: m?.[2] || null, environment: null, ref: null, by: null, ok: null, message: clip(m?.[3] || line, 200) });
  }
  return out.reverse().slice(0, limit);
}

/** A backup (or its offsite copy) older than this many hours is stale: one nightly run plus slack. */
export const BACKUP_STALE_HOURS = 26;
/** A restore drill older than this many days is overdue (quarterly, plus two days). */
export const DRILL_STALE_DAYS = 92;

/** Hours since a time in ms, one decimal, or null. */
const hoursSince = (t, now) => (Number.isFinite(t) ? Math.round(((now - t) / 3_600_000) * 10) / 10 : null);
const isoOrNull = (v) => {
  const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * BACKUP_STATUS_FILE: JSON from the backup script. Adds its age and a staleness flag, and the
 * offsite copy: { status ('ok'|'failed'|'skipped'|null), configured, lastOkAt, ageHours, stale, target }.
 * `target` is what backup.sh records: the provider kind and a host or region, never keys or full URLs.
 */
export function readBackupStatus(file, now = Date.now()) {
  if (!file) return { configured: false };
  let j;
  try { j = JSON.parse(readFileSync(file, 'utf8')); } catch { return { configured: true, error: 'unreadable' }; }
  const at = j.at || j.finishedAt || j.finished_at || j.time || j.timestamp || null;
  const t = at ? Date.parse(at) : NaN;
  const ageHours = hoursSince(t, now);
  const size = j.sizeBytes ?? j.size_bytes ?? j.size ?? j.bytes;
  const offsiteStatus = ['ok', 'failed', 'skipped'].includes(j.offsite) ? j.offsite : null;
  const offsiteTarget = clip(j.offsiteTarget || null, 120);
  const lastOffsiteOkAt = isoOrNull(j.lastOffsiteOkAt);
  const offsiteAge = hoursSince(lastOffsiteOkAt ? Date.parse(lastOffsiteOkAt) : NaN, now);
  return {
    configured: true,
    environment: clip(j.environment, 20),
    at: Number.isFinite(t) ? new Date(t).toISOString() : null,
    ok: j.ok ?? (j.status ? ['ok', 'success'].includes(j.status) : null),
    status: clip(j.status, 20),
    ageHours,
    stale: ageHours == null || ageHours > BACKUP_STALE_HOURS,
    sizeBytes: Number.isFinite(size) ? Number(size) : null,
    target: clip(offsiteTarget || j.target || j.destination || j.location, 120),
    message: clip(j.message || j.error, 200),
    offsite: {
      // A status file from before offsite tracking says nothing either way (null).
      status: offsiteStatus,
      configured: offsiteStatus === 'ok' || offsiteStatus === 'failed' || Boolean(offsiteTarget) || Boolean(lastOffsiteOkAt),
      lastOkAt: lastOffsiteOkAt,
      ageHours: offsiteAge,
      stale: offsiteAge == null || offsiteAge > BACKUP_STALE_HOURS,
      target: offsiteTarget,
    },
  };
}

/** The longest restore-test line accepted (the drill's lines are well under 2 KB). */
export const RESTORE_LINE_MAX = 16 * 1024;

/**
 * One restore-test result: a line from restore-test.sh (on a server or a PC), from
 * offsite-drill.sh, or an HQ upload. Only the fields HQ shows are kept, each type-checked and
 * clipped; anything else in the line is dropped. null for something that is not a result.
 */
export function normalizeRestoreResult(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const ts = isoOrNull(j.ts || j.at);
  if (!ts || typeof j.ok !== 'boolean') return null;
  const int = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const str = (v, n, re) => (typeof v === 'string' && v && v.length <= n && (!re || re.test(v)) ? v : null);
  return {
    ts,
    ok: j.ok,
    source: j.source === 'offsite' ? 'offsite' : 'local',
    host: str(j.host, 64, /^[A-Za-z0-9._-]+$/),
    environment: str(j.environment, 20, /^[a-z][a-z0-9-]*$/),
    file: str(j.file, 120, /^[A-Za-z0-9._-]+$/),
    sha256: str(j.sha256, 64, /^[0-9a-f]{64}$/),
    secretsChecked: j.secretsChecked === true,
    secretsOk: typeof j.secretsOk === 'boolean' ? j.secretsOk : null,
    migrations: int(j.migrations),
    migration: str(j.migration, 12, /^[0-9]{1,12}$/),
    tenants: int(j.tenants),
    durationSeconds: int(j.durationSeconds),
    failures: typeof j.failures === 'string' && j.failures ? j.failures.slice(0, 500) : null,
    recordedBy: str(j.recordedBy, 200),
    recordedAt: isoOrNull(j.recordedAt),
  };
}

/** restore-tests.jsonl text -> normalized results, oldest first. Lines that are not results are skipped. */
export function parseRestoreTests(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{') || l.length > RESTORE_LINE_MAX) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    const r = normalizeRestoreResult(j);
    if (r) out.push(r);
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/**
 * RESTORE_TESTS_FILE: restore tests and offsite drills (JSON lines). The newest passing test, its age
 * and a staleness flag (over DRILL_STALE_DAYS), the newest passing offsite drill and the newest run.
 */
export function readRestoreTests(file, now = Date.now()) {
  if (!file) return { configured: false };
  let items;
  try {
    items = parseRestoreTests(tailFile(file, 256 * 1024));
  } catch (e) {
    // No file yet means no test recorded yet, not a broken setup.
    if (e?.code !== 'ENOENT') return { configured: true, error: 'unreadable' };
    items = [];
  }
  const passes = items.filter((r) => r.ok);
  const last = passes.at(-1) || null;
  const lastRun = items.at(-1) || null;
  const lastOffsite = passes.filter((r) => r.source === 'offsite').at(-1) || null;
  const ageDays = last ? Math.floor((now - Date.parse(last.ts)) / DAY) : null;
  return {
    configured: true,
    count: items.length,
    lastPassAt: last?.ts ?? null,
    lastSource: last?.source ?? null,
    lastHost: last?.host ?? null,
    lastEnvironment: last?.environment ?? null,
    secretsChecked: Boolean(last?.secretsChecked && last.secretsOk === true),
    ageDays,
    stale: ageDays == null || ageDays > DRILL_STALE_DAYS,
    lastOffsitePassAt: lastOffsite?.ts ?? null,
    lastOffsiteSecretsChecked: Boolean(lastOffsite?.secretsChecked && lastOffsite.secretsOk === true),
    lastRun: lastRun ? { at: lastRun.ts, ok: lastRun.ok, source: lastRun.source, host: lastRun.host, failures: lastRun.failures } : null,
    recent: items.slice(-10).reverse(),
  };
}

/**
 * Backup and restore-drill problems, each with a stable code (the HQ alert key) and the text the
 * health page shows. `h` needs { environment, backup, restoreTest } (devHealth's shape).
 * @returns {{ code: string, text: string }[]}
 */
export function backupProblems(h) {
  const out = [];
  const b = h.backup;
  const production = h.environment === 'production';
  if (b?.configured && b.error) {
    if (production) out.push({ code: 'backup_unreadable', text: 'backup status unreadable' });
  } else if (b?.configured) {
    if (b.stale) out.push({ code: 'backup_stale', text: 'backup is stale' });
    else if (b.status === 'failed') out.push({ code: 'backup_failed', text: 'last backup failed' });
    const o = b.offsite;
    if (o?.status === 'failed') out.push({ code: 'offsite_failed', text: 'offsite backup failed' });
    else if (o?.configured && o.stale) out.push({ code: 'offsite_stale', text: 'offsite backup stale' });
    else if (o && !o.configured && production) out.push({ code: 'offsite_missing', text: 'offsite backup not configured' });
  }
  const r = h.restoreTest;
  if (r?.configured && !r.error) {
    if (r.stale) out.push({ code: 'drill_overdue', text: r.lastPassAt ? 'restore drill overdue' : 'restore drill overdue (none recorded yet)' });
    // Offsite is required in production; elsewhere a drill is expected once an offsite copy exists.
    if (!r.lastOffsitePassAt && (production || b?.offsite?.configured)) out.push({ code: 'no_offsite_drill', text: 'no offsite restore drill yet' });
  } else if (r?.configured && r.error && production) {
    out.push({ code: 'drill_unreadable', text: 'restore test log unreadable' });
  }
  return out;
}

let tlsCache = { at: 0, key: '', value: null };

/** Certificate expiry of an https origin (one TLS handshake, cached for 6 hours). */
export async function checkTls(origin, { timeoutMs = 4000, now = Date.now() } = {}) {
  let u;
  try { u = new URL(origin); } catch { return { checked: false, reason: 'bad origin' }; }
  if (u.protocol !== 'https:') return { checked: false, reason: 'not https' };
  if (tlsCache.key === origin && now - tlsCache.at < 6 * 3_600_000) return tlsCache.value;
  const value = await new Promise((resolve) => {
    const socket = tlsConnect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      resolve({
        checked: true, host: u.hostname, authorized: socket.authorized, authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        validTo: validTo ? validTo.toISOString() : null, daysLeft: validTo ? Math.floor((validTo - now) / DAY) : null,
        issuer: clip(cert?.issuer?.O || cert?.issuer?.CN, 120),
      });
      socket.end();
    });
    socket.on('timeout', () => { socket.destroy(); resolve({ checked: false, host: u.hostname, reason: 'timeout' }); });
    socket.on('error', (e) => resolve({ checked: false, host: u.hostname, reason: clip(e.code || e.message, 60) }));
  });
  tlsCache = { at: now, key: origin, value };
  return value;
}

/** Certificate expiry from a PEM file (TLS_CERT_FILE), the older way. */
export function certFileExpiry(file, now = Date.now()) {
  try {
    const validTo = new Date(new X509Certificate(readFileSync(file)).validTo);
    return { checked: true, source: 'file', validTo: validTo.toISOString(), daysLeft: Math.floor((validTo - now) / DAY) };
  } catch {
    return { checked: false, source: 'file', reason: 'unreadable' };
  }
}

let envCache = { at: 0, value: null };

/** Public status of every environment in HQ_ENVIRONMENTS (server-side fetch, cached 60 s). */
export async function environmentStatuses(envs, { timeoutMs = 3000, fetchImpl = globalThis.fetch } = {}) {
  if (!envs.length) return [];
  if (envCache.value && Date.now() - envCache.at < 60_000 && envCache.key === JSON.stringify(envs)) return envCache.value;
  const value = await Promise.all(envs.map(async (e) => {
    const t0 = Date.now();
    try {
      const res = await fetchImpl(`${e.url}/api/v1/status`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      const j = res.ok ? await res.json() : null;
      return {
        name: e.name, url: e.url, ok: res.ok && j?.status === 'ok', httpStatus: res.status, status: clip(j?.status, 20),
        version: clip(j?.version, 40), gitSha: clip(j?.gitSha, 40), environment: clip(j?.environment, 20), ms: Date.now() - t0,
      };
    } catch (err) {
      return { name: e.name, url: e.url, ok: false, status: 'unreachable', error: clip(err?.name === 'TimeoutError' ? 'timeout' : err?.message, 80), ms: Date.now() - t0 };
    }
  }));
  envCache = { at: Date.now(), value, key: JSON.stringify(envs) };
  return value;
}

async function queueDetail(db) {
  const { rows: [q] } = await db.query(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'queued' AND run_at <= now())::int AS due,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int AS failed_24h,
            count(*) FILTER (WHERE status = 'failed')::int AS failed_total,
            COALESCE(EXTRACT(EPOCH FROM now() - min(run_at) FILTER (WHERE status = 'queued' AND run_at <= now())), 0)::int AS lag_s
       FROM jobs_queue`);
  const byKind = (await db.query(
    `SELECT kind, count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '7 days')::int AS failed_7d
       FROM jobs_queue GROUP BY kind ORDER BY kind`)).rows;
  // Job errors are written by our own handlers; still clipped, and payloads are never shown.
  const failed = (await db.query(
    `SELECT id, kind, attempts, max_attempts, finished_at, left(last_error, 200) AS last_error
       FROM jobs_queue WHERE status = 'failed' ORDER BY finished_at DESC NULLS LAST LIMIT 20`)).rows;
  return {
    queued: q.queued, due: q.due, running: q.running, failed24h: q.failed_24h, failedTotal: q.failed_total, lagSeconds: q.lag_s,
    byKind: byKind.map((k) => ({ kind: k.kind, queued: k.queued, running: k.running, failed7d: k.failed_7d })),
    failed: failed.map((f) => ({ id: f.id, kind: f.kind, attempts: f.attempts, maxAttempts: f.max_attempts, finishedAt: f.finished_at, lastError: f.last_error })),
  };
}

function diskUsage(path) {
  try {
    const s = statfsSync(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { path, totalBytes: total, freeBytes: free, usedPct: total ? Math.round(((total - free) / total) * 1000) / 10 : null };
  } catch {
    return { path, error: 'unavailable' };
  }
}

/**
 * Everything on the developer health page.
 * @param {{ config: object, db: import('../db.js').Db, settings: ReturnType<typeof import('./hq-common.js').hqSettings>, metrics: ReturnType<typeof import('./hq-metrics.js').createMetrics>, stats?: object }} deps
 */
export async function devHealth({ config, db, settings, metrics }) {
  const pool = db.pools.app;
  const hqPool = db.pools.hq;
  let database;
  try {
    const latency = await timed(() => withTimeout(db.query('SELECT 1'), 3000));
    const { rows: [v] } = await db.query("SELECT current_setting('server_version') AS version, pg_database_size(current_database())::bigint AS size");
    database = { ok: true, latencyMs: Math.round(latency.ms * 10) / 10, version: v.version, sizeBytes: Number(v.size) };
  } catch (e) {
    database = { ok: false, error: clip(e.message, 80) };
  }
  database.pool = { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount, max: pool.options?.max ?? null };
  if (hqPool) database.hqPool = { total: hqPool.totalCount, idle: hqPool.idleCount, waiting: hqPool.waitingCount, max: hqPool.options?.max ?? null };

  const [migrations, queue] = database.ok ? await Promise.all([migrationStatus(db), queueDetail(db)]) : [null, null];

  let deploys = { configured: Boolean(settings.deployLogFile), items: [] };
  if (settings.deployLogFile) {
    try { deploys.items = parseDeployLog(tailFile(settings.deployLogFile)); } catch { deploys.error = 'unreadable'; }
  }

  let tls;
  if (config.tlsCertFile) tls = certFileExpiry(config.tlsCertFile);
  else if (settings.tlsCheck) tls = await checkTls(config.publicOrigin);
  else tls = { checked: false, reason: 'off in this environment (TLS_CHECK=on to enable)' };

  const mem = process.memoryUsage();
  const sysTotal = totalmem();
  const sysFree = freemem();

  return {
    checkedAt: new Date().toISOString(),
    environment: config.appEnv,
    version: config.version,
    gitSha: config.gitSha,
    node: process.version,
    host: hostname(),
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    publicOrigin: config.publicOrigin,
    database,
    migrations,
    queue,
    backup: readBackupStatus(config.backupStatusFile),
    restoreTest: readRestoreTests(config.restoreTestsFile),
    deploys,
    errors: metrics.snapshot(),
    tls,
    // The app's own disk, and the backup's when it reports from another mount.
    disk: [...new Set([process.cwd(), ...(config.backupStatusFile ? [dirname(config.backupStatusFile)] : [])])].map(diskUsage),
    memory: {
      rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, heapTotalBytes: mem.heapTotal,
      systemTotalBytes: sysTotal, systemFreeBytes: sysFree, systemUsedPct: Math.round(((sysTotal - sysFree) / sysTotal) * 1000) / 10,
      loadAvg: loadavg().map((x) => Math.round(x * 100) / 100), cpus: cpus().length,
    },
    environments: await environmentStatuses(settings.environments),
  };
}

/** One line for the HQ overview. */
export function healthLevel(h) {
  const problems = [];
  if (!h.database?.ok) problems.push('database down');
  if (h.migrations?.pending?.length) problems.push('migrations pending');
  if (h.queue?.failed24h) problems.push(`${h.queue.failed24h} failed job(s) in 24 h`);
  if (h.queue?.lagSeconds > 900) problems.push('queue lagging');
  if (h.errors?.lastHour?.errors5xx) problems.push(`${h.errors.lastHour.errors5xx} server error(s) in the last hour`);
  for (const p of backupProblems(h)) problems.push(p.text);
  if (h.tls?.checked && h.tls.daysLeft != null && h.tls.daysLeft < 14) problems.push(`TLS certificate expires in ${h.tls.daysLeft} days`);
  for (const d of h.disk || []) if (d.usedPct > 90) problems.push(`disk ${d.usedPct}% full`);
  return { level: !h.database?.ok ? 'down' : problems.length ? 'degraded' : 'ok', problems };
}
