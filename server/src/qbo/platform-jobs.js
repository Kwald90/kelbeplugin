// QuickBooks platform jobs (docs/integrations/quickbooks.md 2.4, 2.7, 10.4), registered in worker.js:
//   qbo_token_housekeeping  daily (and at once for one tenant when HQ closes it): rolling refresh so
//                           the 100-day window never lapses, hard-expiry notices, plan-lapse pause,
//                           auto-disconnect of closed, long-suspended and long plan-paused tenants,
//                           finishing an HQ release, and retries of qbo_revoke_pending
//   qbo_purge               hourly: the 30-day disconnect purge and every retention rule of 10.4
// Errors that leave a tenant carry only fixed-table messages; one tenant's failure never stops the rest.
import { readConfig } from '../config.js';
import { createSealer } from '../lib/crypto.js';
import { createEmail } from '../lib/email.js';
import { appendAudit } from '../services/audit.js';
import { loadTenantPlan, tenantHas } from '../services/entitlements.js';
import { notify } from '../services/notify.js';
import { enqueue } from '../services/queue.js';
import { qboCfg } from './env.js';
import { revokeToken } from './oauth.js';
import { QBO_ACTOR } from './roles.js';
import { SECRET_NAMES, disconnect, loadConnection, platformEvent, purgeQboData, qboRealmOwner, setPaused, withAccessToken } from './connection.js';

const DAY = 86_400_000;
const dayKey = (d) => d.toISOString().slice(0, 10);
const hourKey = (d) => d.toISOString().slice(0, 13);
const ageDays = (d, now) => (d ? (now.getTime() - new Date(d).getTime()) / DAY : 0);

const AUTO_REASON = {
  closed: 'the company account was closed',
  suspended: 'the company account has been suspended for more than 60 days',
  plan: "the company's plan has not included QuickBooks for more than 60 days",
};

/** The 30-day disconnect purge (2.7 step 5), inside the tenant's transaction. Returns whether it ran. */
async function purgeIfDue(tx, now) {
  const conn = await loadConnection(tx);
  if (!conn || conn.state !== 'disconnected' || !conn.purge_after || new Date(conn.purge_after) > now) return false;
  await purgeQboData(tx);
  await appendAudit(tx, tx.tenantId, { actor: QBO_ACTOR, action: 'qbo.purge', collection: 'qbo_connections', summary: 'QuickBooks links and data deleted 30 days after the disconnect' });
  return true;
}

async function emailOwners(db, tenantId, subject, text) {
  const { rows } = await db.query(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = 'owner' AND m.status = 'active' AND u.status = 'active' AND u.email IS NOT NULL`, [tenantId]);
  const email = createEmail();
  for (const r of rows) await email.send(db, { to: r.email, tenantId, subject, text, template: 'qbo-auto-disconnect' });
}

/**
 * One tenant's housekeeping. Returns what was done (for logs and tests).
 * @returns {Promise<'none'|'disconnected'|'finished'|'purged'|'refreshed'|'paused'|'notified'|'error'>}
 */
export async function housekeepTenant(db, sealer, config, tenant, now = new Date()) {
  const q = qboCfg(config);
  const facts = await db.withTenant({ tenantId: tenant.id }, async (tx) => {
    const conn = await loadConnection(tx);
    if (!conn) return null;
    const { rows } = await tx.query('SELECT 1 FROM tenant_secrets WHERE tenant_id = $1 AND name = $2', [tx.tenantId, SECRET_NAMES.refresh]);
    return { conn, hasToken: rows.length > 0 };
  });
  if (!facts) return 'none';
  const { conn, hasToken } = facts;

  let why = null;
  if (tenant.status === 'closed') why = 'closed';
  else if (tenant.status === 'suspended' && ageDays(tenant.status_changed_at, now) > 60) why = 'suspended';
  else if (conn.state === 'paused' && conn.pause_reason === 'plan' && ageDays(conn.paused_since, now) > 60) why = 'plan';

  if (why && (conn.state !== 'disconnected' || hasToken)) {
    await disconnect(db, sealer, q, tenant.id, {
      actor: QBO_ACTOR, purge: true, revoke: true, action: 'qbo.auto_disconnect',
      summary: `QuickBooks disconnected automatically: ${AUTO_REASON[why]}; links deleted`,
    });
    await emailOwners(db, tenant.id, 'Fishtape disconnected QuickBooks',
      `Fishtape disconnected QuickBooks from ${tenant.name || 'your company'} because ${AUTO_REASON[why]}. Your Fishtape records stay. To use QuickBooks sync again, connect it from the QuickBooks screen.`);
    return 'disconnected';
  }
  // An HQ release leaves a disconnected connection that still has tokens: finish 2.7 (revoke, delete).
  // disconnect() skips the revoke when another tenant holds the realm by now. A disconnected tenant
  // has no realm row, so the hourly purge may never visit it: its 30-day purge is due here too.
  if (conn.state === 'disconnected') {
    if (!hasToken) return (await db.withTenant({ tenantId: tenant.id }, (tx) => purgeIfDue(tx, now), { write: true })) ? 'purged' : 'none';
    await disconnect(db, sealer, q, tenant.id, { actor: QBO_ACTOR, purge: false, revoke: true, summary: 'QuickBooks disconnect finished after a release by Fishtape support' });
    return 'finished';
  }
  if (tenant.status !== 'active') return 'none';

  const plan = await loadTenantPlan(db, tenant.id);
  if (['setup', 'active'].includes(conn.state) && !(plan && tenantHas(plan, 'quickbooks', now))) {
    await setPaused(db, tenant.id, true, 'plan');
    return 'paused';
  }

  let did = 'none';
  // Rolling expiry: refresh a quiet connection so the 100-day refresh window never lapses.
  if (q.enabled && conn.state !== 'reconnect_needed' && conn.environment === q.environment && hasToken
      && (!conn.last_refresh_at || ageDays(conn.last_refresh_at, now) > 30)) {
    try {
      await withAccessToken(db, sealer, q, tenant.id, { force: true });
      did = 'refreshed';
    } catch {
      did = 'error'; // reconnect_needed and the breaker are handled inside withAccessToken
    }
  }

  // Hard expiry (5 years): remind office roles 30, 7 and 1 days before. A refresh above may have
  // brought a new limit, so read it again.
  const latest = did === 'refreshed' ? await db.withTenant({ tenantId: tenant.id }, loadConnection) : conn;
  if (latest?.refresh_hard_expires_at && latest.state !== 'reconnect_needed') {
    const hard = new Date(latest.refresh_hard_expires_at);
    const left = (hard.getTime() - now.getTime()) / DAY;
    const step = [1, 7, 30].find((d) => left > 0 && left <= d);
    if (step) {
      await db.withTenant({ tenantId: tenant.id }, (tx) => notify(tx, {
        role: ['owner', 'admin', 'office'], kind: 'quickbooks', link: '#/quickbooks', ref: `qbo:hard-expiry:${dayKey(hard)}:${step}`,
        title: `Reconnect to QuickBooks before ${dayKey(hard)}`,
        body: 'QuickBooks connections must be renewed every five years. An owner or admin presses Reconnect on the QuickBooks screen.',
      }));
      if (did === 'none') did = 'notified';
    }
  }
  return did;
}

/** Retry revokes that failed (2.7 step 2), daily for 14 days. */
export async function retryRevokes(db, sealer, config) {
  const q = qboCfg(config);
  const out = { revoked: 0, retrying: 0, gaveUp: 0, held: 0 };
  const { rows } = await db.query(
    `SELECT id, environment, token_sealed, realm_hash, created_at < now() - interval '14 days' AS expired
       FROM qbo_revoke_pending WHERE next_try_at <= now() ORDER BY created_at LIMIT 500`);
  for (const r of rows) {
    // A tenant holds the realm again (the same company reconnected, or the rightful one after an HQ
    // release): the grant is theirs now, and a revoke may end it (2.2). Forget the old token.
    if (r.realm_hash && (await qboRealmOwner(db, r.realm_hash)) != null) {
      await db.query('DELETE FROM qbo_revoke_pending WHERE id = $1', [r.id]);
      out.held++;
      continue;
    }
    const token = sealer.open('qbo-revoke', r.token_sealed, `qbo-revoke:${r.id}`);
    if (r.expired || !token) {
      await db.query('DELETE FROM qbo_revoke_pending WHERE id = $1', [r.id]);
      await platformEvent(db, 'revoke_gave_up', r.environment);
      out.gaveUp++;
      continue;
    }
    if (!q.enabled || r.environment !== q.environment) continue; // only a server with that environment's keys can revoke it
    try {
      await revokeToken(q, token);
      await db.query('DELETE FROM qbo_revoke_pending WHERE id = $1', [r.id]);
      out.revoked++;
    } catch {
      await db.query("UPDATE qbo_revoke_pending SET attempts = attempts + 1, next_try_at = now() + interval '1 day' WHERE id = $1", [r.id]);
      out.retrying++;
    }
  }
  return out;
}

/** The hourly purge: disconnect purges past purge_after, then the retention rules of 10.4. */
export async function purgeQbo(db, now = new Date()) {
  const out = { oauthStates: 0, events: 0, purgedTenants: 0, rows: 0 };
  out.oauthStates = (await db.query('DELETE FROM qbo_oauth_states WHERE expires_at < now()')).rowCount;
  out.events = (await db.query("DELETE FROM qbo_platform_events WHERE at < now() - interval '30 days'")).rowCount;
  // Connected tenants have a realm row; recent ones a usage row. A disconnected tenant with neither is
  // purged by the daily housekeeping, which visits every tenant.
  const { rows: tenants } = await db.query('SELECT tenant_id FROM qbo_realms UNION SELECT DISTINCT tenant_id FROM qbo_api_usage');
  for (const { tenant_id: tenantId } of tenants) {
    try {
      await db.withTenant({ tenantId }, async (tx) => {
        out.rows += (await tx.query("DELETE FROM qbo_api_usage WHERE tenant_id = $1 AND month < (date_trunc('month', now()) - interval '13 months')::date", [tenantId])).rowCount;
        if (await purgeIfDue(tx, now)) { out.purgedTenants++; return; }
        const del = async (sql) => { out.rows += (await tx.query(sql, [tenantId])).rowCount; };
        await del("DELETE FROM qbo_sync_log WHERE tenant_id = $1 AND at < now() - interval '90 days'");
        await del("DELETE FROM qbo_inbox WHERE tenant_id = $1 AND processed_at < now() - interval '30 days'");
        await del("DELETE FROM qbo_conflicts WHERE tenant_id = $1 AND status IN ('resolved', 'dismissed') AND COALESCE(resolved_at, created_at) < now() - interval '90 days'");
        await del("DELETE FROM qbo_candidates WHERE tenant_id = $1 AND scanned_at < now() - interval '30 days'");
      }, { write: true });
    } catch {
      // next hour
    }
  }
  return out;
}

/**
 * @param {{ sealer?: object, config?: object, now?: () => Date }} [deps] tests pass their own
 */
export function createQboPlatformHandlers(deps = {}) {
  let { sealer, config } = deps;
  const now = deps.now || (() => new Date());
  const ready = () => {
    config ??= readConfig();
    sealer ??= createSealer(config.secretsMasterKey);
    return { sealer, config };
  };
  return {
    async qbo_token_housekeeping({ db, job }) {
      const { sealer: s, config: c } = ready();
      const at = now();
      const only = job?.payload?.tenantId || job?.tenant_id || null;
      const { rows } = await db.query(
        `SELECT id, name, status, status_changed_at FROM tenants WHERE ($1::uuid IS NULL OR id = $1) ORDER BY id`, [only]);
      const totals = { tenants: 0, refreshed: 0, disconnected: 0, finished: 0, purged: 0, paused: 0, notified: 0, errors: 0 };
      for (const t of rows) {
        try {
          const r = await housekeepTenant(db, s, c, t, at);
          if (r !== 'none') totals.tenants++;
          if (r === 'error') totals.errors++; else if (r !== 'none') totals[r]++;
        } catch {
          totals.errors++;
        }
      }
      if (!only) Object.assign(totals, await retryRevokes(db, s, c));
      return totals;
    },
    async qbo_purge({ db }) {
      return purgeQbo(db, now());
    },
  };
}

export const QBO_PLATFORM_HANDLERS = createQboPlatformHandlers();

/** Daily housekeeping (09:00 UTC) and the hourly purge, deduplicated so many workers schedule each once. */
export async function scheduleQboPlatformJobs(db, now = new Date()) {
  const daily = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9));
  if (daily <= now) daily.setUTCDate(daily.getUTCDate() + 1);
  await enqueue(db, { kind: 'qbo_token_housekeeping', runAt: daily, dedupeKey: `qbo_token_housekeeping:${dayKey(daily)}`, maxAttempts: 3 });
  const hourly = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  await enqueue(db, { kind: 'qbo_purge', runAt: hourly, dedupeKey: `qbo_purge:${hourKey(hourly)}`, maxAttempts: 2 });
}
