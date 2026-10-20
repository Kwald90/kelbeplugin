// Recompute QuickBooks realm hashes after SECRETS_MASTER_KEY changes (docs/integrations/quickbooks.md
// 2.3). realm_hash = HMAC(master-key subkey, environment:realmId), so a master-key rotation, or a
// move to a server with another key, must run this in the same maintenance window as the re-wrap,
// with the NEW key in place. One transaction per tenant: it decrypts qbo.realm_id and rewrites the
// hash in qbo_realms, qbo_connections and every table that carries it. Prints counts, never ids.
//
//   node scripts/qbo-rehash.js            (reads server/.env like the API; worker stopped first)
//
// A disconnected connection has no realm id left to hash: its links can only be purged, and a
// reconnect of that company will ask for the purge (the script counts these).
import { pathToFileURL } from 'node:url';
import { loadEnvFile, readConfig } from '../src/config.js';
import { createDb, createPool } from '../src/db.js';
import { createSealer } from '../src/lib/crypto.js';
import { getSecret } from '../src/services/secrets.js';
import { SECRET_NAMES, realmHashFor } from '../src/qbo/connection.js';

const TABLES = ['qbo_links', 'qbo_inbox', 'qbo_mappings', 'qbo_reference', 'qbo_candidates'];

/**
 * @param {import('../src/db.js').Db} db
 * @param {ReturnType<typeof createSealer>} sealer built with the key now in force
 * @returns {Promise<{ tenants: number, rehashed: number, unchanged: number, unreadable: number, disconnected: number }>}
 */
export async function rehashRealms(db, sealer) {
  const out = { tenants: 0, rehashed: 0, unchanged: 0, unreadable: 0, disconnected: 0 };
  const { rows: tenants } = await db.query('SELECT id FROM tenants ORDER BY id');
  for (const { id: tenantId } of tenants) {
    await db.withTenant({ tenantId }, async (tx) => {
      const { rows } = await tx.query('SELECT environment, realm_hash, state FROM qbo_connections WHERE tenant_id = $1', [tenantId]);
      const conn = rows[0];
      if (!conn) return;
      out.tenants++;
      const realmId = await getSecret(tx, sealer, SECRET_NAMES.realm, { internal: true });
      if (!realmId) {
        if (conn.state === 'disconnected') out.disconnected++; else out.unreadable++;
        return;
      }
      const old = Buffer.from(conn.realm_hash);
      const next = realmHashFor(sealer, conn.environment, realmId);
      if (old.equals(next)) { out.unchanged++; return; }
      await tx.query('DELETE FROM qbo_realms WHERE tenant_id = $1', [tenantId]);
      await tx.query('INSERT INTO qbo_realms (realm_hash, tenant_id, environment) VALUES ($1, $2, $3)', [next, tenantId, conn.environment]);
      await tx.query('UPDATE qbo_connections SET realm_hash = $2, updated_at = now() WHERE tenant_id = $1', [tenantId, next]);
      for (const t of TABLES) await tx.query(`UPDATE ${t} SET realm_hash = $3 WHERE tenant_id = $1 AND realm_hash = $2`, [tenantId, old, next]);
      out.rehashed++;
    }, { write: true });
  }
  // Takeover offers carry a hash too; they live 10 minutes, so they are simply dropped.
  await db.query("DELETE FROM qbo_oauth_states WHERE stage = 'takeover'");
  return out;
}

async function main() {
  loadEnvFile();
  const config = readConfig();
  const db = createDb({ app: createPool(config.databaseUrl, { max: 2, applicationName: 'fishtape-qbo-rehash' }) });
  try {
    const r = await rehashRealms(db, createSealer(config.secretsMasterKey));
    console.log(`QuickBooks connections: ${r.tenants}; re-hashed ${r.rehashed}, already current ${r.unchanged}.`);
    if (r.unreadable) console.log(`${r.unreadable} connection(s) have no readable company id: re-wrap tenant secrets with the new key first, then run this again.`);
    if (r.disconnected) console.log(`${r.disconnected} disconnected connection(s) keep their old hash; a reconnect of those companies will ask for a purge.`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
