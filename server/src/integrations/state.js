// Database helpers for integrations. Every function takes a TenantTx from db.withTenant(),
// so RLS keeps each company to its own rows; queries also filter tenant_id explicitly.
import { randomBytes } from 'node:crypto';
import { sha256 } from '../lib/crypto.js';
import { permsForRole } from '../auth/permissions.js';
import { getSecret } from '../services/secrets.js';
import { PROVIDERS } from './providers.js';

/** Settings row for a provider (defaults when there is none yet). */
export async function getSettings(tx, provider) {
  const { rows } = await tx.query('SELECT * FROM integration_settings WHERE tenant_id = $1 AND provider = $2', [tx.tenantId, provider]);
  return rows[0] || { provider, config: {}, status: 'unknown', status_message: null, tested_at: null, last_event_at: null };
}

export async function allSettings(tx) {
  const { rows } = await tx.query('SELECT * FROM integration_settings WHERE tenant_id = $1', [tx.tenantId]);
  return new Map(rows.map((r) => [r.provider, r]));
}

export async function saveConfig(tx, provider, config) {
  await tx.query(
    `INSERT INTO integration_settings (tenant_id, provider, config) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [tx.tenantId, provider, config]);
}

/** Record the outcome of a test or of a real call. `tested` marks it as a connection test. */
export async function setStatus(tx, provider, status, message, { tested = false } = {}) {
  await tx.query(
    `INSERT INTO integration_settings (tenant_id, provider, status, status_message, tested_at) VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET status = EXCLUDED.status, status_message = EXCLUDED.status_message,
       tested_at = CASE WHEN $5 THEN now() ELSE integration_settings.tested_at END, updated_at = now()`,
    [tx.tenantId, provider, status, message ? String(message).slice(0, 500) : null, tested]);
}

export async function touchEvent(tx, provider) {
  await tx.query(
    `INSERT INTO integration_settings (tenant_id, provider, last_event_at) VALUES ($1, $2, now())
     ON CONFLICT (tenant_id, provider) DO UPDATE SET last_event_at = now()`, [tx.tenantId, provider]);
}

export async function clearSettings(tx, provider) {
  await tx.query('DELETE FROM integration_settings WHERE tenant_id = $1 AND provider = $2', [tx.tenantId, provider]);
}

/** True the first time an event id is seen; false for a replay. */
export async function firstSeen(tx, provider, eventId, kind = null) {
  const { rowCount } = await tx.query(
    `INSERT INTO integration_events (tenant_id, provider, event_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [tx.tenantId, provider, String(eventId).slice(0, 200), kind ? String(kind).slice(0, 100) : null]);
  return rowCount === 1;
}

/** Plaintext of every secret a provider uses ({ name: value|null }). Integration code only. */
export async function providerSecrets(tx, sealer, provider) {
  const out = {};
  for (const s of PROVIDERS[provider].secrets) out[s.name] = await getSecret(tx, sealer, s.name);
  return out;
}

export function hasRequired(provider, secrets) {
  return PROVIDERS[provider].secrets.every((s) => !s.required || secrets[s.name]);
}

// ---- SMS opt-outs -----------------------------------------------------------

export async function isOptedOut(tx, phone) {
  const { rows } = await tx.query('SELECT 1 FROM sms_opt_outs WHERE tenant_id = $1 AND phone = $2', [tx.tenantId, phone]);
  return rows.length > 0;
}

export async function optOut(tx, phone, source) {
  await tx.query(
    `INSERT INTO sms_opt_outs (tenant_id, phone, source) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, phone) DO NOTHING`,
    [tx.tenantId, phone, source]);
}

export async function optIn(tx, phone) {
  await tx.query('DELETE FROM sms_opt_outs WHERE tenant_id = $1 AND phone = $2', [tx.tenantId, phone]);
}

// ---- pay links --------------------------------------------------------------

export const PAY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A new pay link for an invoice; any earlier link for it stops working. Returns the raw token. */
export async function newPayLink(tx, invoiceId, createdBy) {
  const token = randomBytes(32).toString('base64url');
  await tx.query('UPDATE pay_links SET revoked_at = now() WHERE tenant_id = $1 AND invoice_id = $2 AND revoked_at IS NULL', [tx.tenantId, invoiceId]);
  await tx.query('INSERT INTO pay_links (tenant_id, token_hash, invoice_id, created_by) VALUES ($1, $2, $3, $4)', [tx.tenantId, sha256(token), invoiceId, createdBy]);
  return token;
}

/** Is this link (the URL stored on the invoice) still the live one for the invoice? */
export async function isLivePayLink(tx, invoiceId, url) {
  const token = String(url || '').split('/').pop();
  if (!PAY_TOKEN_RE.test(token)) return false;
  const { rows } = await tx.query('SELECT 1 FROM pay_links WHERE tenant_id = $1 AND token_hash = $2 AND invoice_id = $3 AND revoked_at IS NULL', [tx.tenantId, sha256(token), invoiceId]);
  return rows.length > 0;
}

export async function findPayLink(tx, token) {
  if (!PAY_TOKEN_RE.test(String(token))) return null;
  const { rows } = await tx.query(
    `UPDATE pay_links SET last_used_at = now() WHERE tenant_id = $1 AND token_hash = $2 AND revoked_at IS NULL RETURNING invoice_id`,
    [tx.tenantId, sha256(token)]);
  return rows[0]?.invoice_id || null;
}

export const payUrl = (publicOrigin, tenantId, token) => `${publicOrigin}/api/v1/pay/${tenantId}/${token}`;

// ---- acting as the system ---------------------------------------------------

/**
 * A principal for writes the server makes on a company's behalf (a payment from a Stripe
 * webhook, a lead from Facebook, outbox status after sending). Owner permissions, so the
 * records service's access checks pass; the audit log shows actor type "system".
 */
export function systemPrincipal(tenantId, id, label) {
  return {
    kind: 'system', tenantId, userId: null, role: 'owner', perms: permsForRole('owner'), isManager: true,
    employeeId: null, scopes: null, crew: false, actor: { type: 'system', id, label },
  };
}

export const systemWho = (p, request = {}) => ({ actor: p.actor, request });
