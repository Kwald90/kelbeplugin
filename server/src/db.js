// Postgres access. Tenant data is reachable through exactly one function,
// withTenant(ctx, fn): one transaction that first sets app.tenant_id / app.user_id /
// app.portal_client_id (transaction-local), then runs fn. RLS does the rest: with no
// tenant set, every tenant table reads as empty and refuses writes.
import pg from 'pg';

// int8 (bigint) as JS numbers: versions, change_seq and counts stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID.test(v);

/**
 * @param {string} connectionString
 * @param {{ max?: number, role?: string, applicationName?: string }} [opts]
 *   role: SET ROLE on every new connection (tests connect as a superuser and act as a role).
 */
export function createPool(connectionString, opts = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: opts.applicationName || 'fishtape-api',
  });
  if (opts.role) {
    if (!/^[a-z_][a-z0-9_]*$/.test(opts.role)) throw new Error('bad role name');
    pool.on('connect', (client) => { client.query(`SET ROLE ${opts.role}`).catch(() => {}); });
  }
  pool.on('error', () => { /* idle client errors are reported on next use */ });
  return pool;
}

/**
 * A transaction bound to one tenant. Repository code receives this, never a raw client.
 */
export class TenantTx {
  /** @param {pg.PoolClient} client @param {{ tenantId: string, userId?: string|null, portalClientId?: string|null }} ctx */
  constructor(client, ctx) {
    this.client = client;
    this.tenantId = ctx.tenantId;
    this.userId = ctx.userId ?? null;
    this.portalClientId = ctx.portalClientId ?? null;
  }
  /** @param {string} text @param {unknown[]} [params] */
  query(text, params) { return this.client.query(text, params); }
  /** Run fn inside a savepoint; on error roll back to it and rethrow. */
  async savepoint(fn) {
    await this.client.query('SAVEPOINT sp');
    try {
      const r = await fn();
      await this.client.query('RELEASE SAVEPOINT sp');
      return r;
    } catch (e) {
      await this.client.query('ROLLBACK TO SAVEPOINT sp');
      throw e;
    }
  }
}

async function inTransaction(pool, begin, fn) {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connection is gone */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * @param {{ app: pg.Pool, hq?: pg.Pool|null }} pools
 */
export function createDb(pools) {
  const { app } = pools;
  return {
    pools,

    /**
     * The only way to tenant data.
     * @template T
     * @param {{ tenantId: string, userId?: string|null, portalClientId?: string|null }} ctx
     * @param {(tx: TenantTx) => Promise<T>} fn
     * @param {{ write?: boolean, isolation?: 'REPEATABLE READ'|'SERIALIZABLE' }} [opts]
     *   write: take the tenant write lock up front (avoids lock-order deadlocks with row locks).
     * @returns {Promise<T>}
     */
    async withTenant(ctx, fn, opts = {}) {
      if (!isUuid(ctx?.tenantId)) throw new Error('withTenant: a tenant id (uuid) is required');
      const begin = opts.isolation ? `BEGIN ISOLATION LEVEL ${opts.isolation === 'SERIALIZABLE' ? 'SERIALIZABLE' : 'REPEATABLE READ'}` : 'BEGIN';
      return inTransaction(app, begin, async (client) => {
        await client.query(
          `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.portal_client_id', $3, true)`,
          [ctx.tenantId, ctx.userId || '', ctx.portalClientId || ''],
        );
        if (opts.write) await client.query('SELECT pg_advisory_xact_lock(tenant_lock_key($1))', [ctx.tenantId]);
        return fn(new TenantTx(client, ctx));
      });
    },

    /** Platform transaction (identity, sessions, queue). No tenant is set, so tenant tables read empty. */
    tx(fn) {
      return inTransaction(app, 'BEGIN', fn);
    },

    /** One platform statement outside an explicit transaction. */
    query(text, params) {
      return app.query(text, params);
    },

    /**
     * HQ access (BYPASSRLS). Callers must audit every read of tenant data; see routes/hq.js.
     * @template T @param {(client: pg.PoolClient) => Promise<T>} fn
     */
    withHq(fn) {
      if (!pools.hq) throw Object.assign(new Error('HQ_DATABASE_URL is not configured'), { statusCode: 503, code: 'hq_unavailable' });
      return inTransaction(pools.hq, 'BEGIN READ WRITE', fn);
    },

    async close() {
      await Promise.all([app.end(), pools.hq?.end()].filter(Boolean));
    },
  };
}

/** @typedef {ReturnType<typeof createDb>} Db */
