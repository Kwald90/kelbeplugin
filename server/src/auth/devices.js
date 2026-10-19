// Shared-iPad crew mode. A manager registers the device (long-lived, revocable token);
// crew members then sign in on it with their PIN and get a short crew session that only
// works together with that device.
import { randomToken, sha256 } from '../lib/crypto.js';
import { DEVICE_PREFIX } from './sessions.js';

export async function registerDevice(q, { tenantId, name, createdBy }) {
  const token = randomToken(DEVICE_PREFIX);
  const { rows } = await q.query(
    'INSERT INTO devices (tenant_id, name, token_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id, name, created_at',
    [tenantId, name, sha256(token), createdBy]);
  return { token, device: { id: rows[0].id, name: rows[0].name, createdAt: rows[0].created_at } };
}

/** @returns {Promise<object|null>} active device row */
export async function lookupDevice(q, token) {
  if (typeof token !== 'string' || !token.startsWith(DEVICE_PREFIX) || token.length > 200) return null;
  const { rows } = await q.query(
    `SELECT d.*, t.status AS tenant_status, t.name AS tenant_name,
            (d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '60 seconds') AS stale_seen,
            (d.locked_until IS NOT NULL AND d.locked_until > now()) AS locked
       FROM devices d JOIN tenants t ON t.id = d.tenant_id
      WHERE d.token_hash = $1 AND d.revoked_at IS NULL`, [sha256(token)]);
  const d = rows[0];
  if (!d || d.tenant_status !== 'active') return null;
  if (d.stale_seen) await q.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [d.id]);
  return d;
}

export async function revokeDevice(q, tenantId, deviceId) {
  const { rowCount } = await q.query(
    'UPDATE devices SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL', [deviceId, tenantId]);
  if (rowCount) await q.query('UPDATE sessions SET revoked_at = now() WHERE device_id = $1 AND revoked_at IS NULL', [deviceId]);
  return rowCount === 1;
}
