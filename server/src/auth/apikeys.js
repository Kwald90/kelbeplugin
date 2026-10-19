// API keys: `ft_live_…` in production, `ft_test_…` everywhere else. Only the sha-256 of
// the key is stored; the key is shown once at creation. Scoped per collection.
import { randomToken, sha256 } from '../lib/crypto.js';

export const keyPrefix = (config) => (config.isProduction ? 'ft_live_' : 'ft_test_');

/** Does this look like an API key (either environment)? */
export const looksLikeApiKey = (token) => typeof token === 'string' && /^ft_(live|test)_[A-Za-z0-9_-]{20,100}$/.test(token);

export async function createApiKey(q, config, { tenantId, name, scopes, createdBy, expiresAt }) {
  const key = randomToken(keyPrefix(config));
  const prefix = key.slice(0, 16);
  const { rows } = await q.query(
    `INSERT INTO api_keys (tenant_id, name, prefix, key_hash, scopes, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, name, prefix, scopes, created_at, expires_at`,
    [tenantId, name, prefix, sha256(key), scopes, createdBy, expiresAt || null]);
  return { key, apiKey: publicKey(rows[0]) };
}

export function publicKey(r) {
  return {
    id: r.id, name: r.name, prefix: r.prefix, scopes: r.scopes, createdAt: r.created_at, expiresAt: r.expires_at ?? null,
    lastUsedAt: r.last_used_at ?? null, revokedAt: r.revoked_at ?? null,
  };
}

/**
 * @returns {Promise<object|null>} the key row when valid for this environment, else null
 */
export async function lookupApiKey(q, config, token) {
  if (!looksLikeApiKey(token) || !token.startsWith(keyPrefix(config))) return null;
  const { rows } = await q.query(
    `SELECT k.*, t.status AS tenant_status,
            (k.last_used_at IS NULL OR k.last_used_at < now() - interval '60 seconds') AS stale_used
       FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`, [sha256(token)]);
  const k = rows[0];
  if (!k || k.tenant_status !== 'active') return null;
  if (k.stale_used) await q.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [k.id]);
  return k;
}
