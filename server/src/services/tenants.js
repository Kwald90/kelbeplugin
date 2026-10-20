// Tenants (companies) and their first owner. Used by signup, the CLI and the seed.
import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { hashSecret } from '../auth/passwords.js';
import { appendAudit } from './audit.js';

export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
export const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

export function normaliseEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function slugify(name) {
  const s = String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return s.length >= 2 ? s : `co-${s || 'x'}`;
}

async function uniqueSlug(q, name) {
  const base = slugify(name);
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    const { rows } = await q.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
    if (!rows.length) return slug;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
}

/** Free trial length for new companies: env TRIAL_DAYS, default 14 (at most 730, Stripe's limit). */
export function trialDays(env = process.env) {
  const n = Number.parseInt(env.TRIAL_DAYS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 730) : 14;
}

export async function isSignupOpen(q) {
  const { rows } = await q.query("SELECT enabled FROM feature_flags WHERE key = 'signup_open' AND tenant_id IS NULL");
  return Boolean(rows[0]?.enabled);
}

/** Throws 400 validation_failed for a bad company name or province; returns the trimmed name. */
function checkCompany(name, province) {
  const tenantName = String(name || '').trim();
  if (!tenantName || tenantName.length > 200) throw new ApiError(400, 'validation_failed', 'Company name is required (max 200 characters).');
  if (province && !PROVINCES.includes(province)) throw new ApiError(400, 'validation_failed', 'Unknown province code.');
  return tenantName;
}

/**
 * Create a tenant and make a user its owner. Either pass an existing userId, or an
 * owner { email, password, displayName } to create the user too. Runs in one
 * withTenant transaction on the new tenant's id, so the audit event lands in its chain.
 * @param {import('../db.js').Db} db
 */
export async function createTenantWithOwner(db, { name, province = null, userId = null, owner = null, actor, request, platformRole = null }) {
  checkCompany(name, province);
  const tenantId = randomUUID();
  const passwordHash = owner?.password ? await hashSecret(owner.password) : null;
  return db.withTenant({ tenantId, userId },
    (tx) => insertTenantWithOwner(tx, { name, province, userId, owner: owner && { ...owner, passwordHash }, actor, request, platformRole }),
    { write: true });
}

/**
 * The inside of createTenantWithOwner, for a caller that already holds a withTenant
 * transaction (write: true) on the new company's id: self-serve sign-up does more in the
 * same transaction. owner.passwordHash is an argon2id hash (auth/passwords.js), or null for
 * an invite. trialEndsAt (a Date) overrides the TRIAL_DAYS default.
 * @param {import('../db.js').TenantTx} tx
 */
export async function insertTenantWithOwner(tx, { name, province = null, userId = null, owner = null, actor, request, platformRole = null, trialEndsAt = null }) {
  const tenantName = checkCompany(name, province);
  const tenantId = tx.tenantId;
  const slug = await uniqueSlug(tx, tenantName);
  // Every new company starts on a trial that ends (plan 'trial' with no end date never would).
  await tx.query(
    'INSERT INTO tenants (id, slug, name, province, trial_ends_at) VALUES ($1, $2, $3, $4, COALESCE($6::timestamptz, now() + make_interval(days => $5)))',
    [tenantId, slug, tenantName, province, trialDays(), trialEndsAt]);
  let uid = userId;
  if (!uid) {
    const email = normaliseEmail(owner.email);
    const exists = await tx.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rows.length) throw new ApiError(409, 'email_in_use', 'An account with this email already exists. Sign in instead.');
    const { rows } = await tx.query(
      `INSERT INTO users (email, display_name, password_hash, password_changed_at, platform_role)
       VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, $4) RETURNING id`,
      [email, String(owner.displayName || email).slice(0, 200), owner.passwordHash || null, platformRole]);
    uid = rows[0].id;
  }
  await tx.query("INSERT INTO memberships (tenant_id, user_id, role, last_used_at) VALUES ($1, $2, 'owner', now())", [tenantId, uid]);
  await appendAudit(tx, tenantId, {
    actor: actor || { type: 'user', id: uid }, action: 'tenant.create', collection: 'tenants', recordId: tenantId,
    summary: `Company ${tenantName} created`, request,
  });
  return { tenant: { id: tenantId, slug, name: tenantName, province }, userId: uid };
}

/** Active memberships of a user, newest use first. */
export async function userMemberships(q, userId) {
  const { rows } = await q.query(
    `SELECT m.id, m.tenant_id, m.role, m.status, m.employee_id, t.name AS tenant_name, t.status AS tenant_status
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 ORDER BY m.last_used_at DESC NULLS LAST, m.created_at`, [userId]);
  return rows;
}

/** The tenant a fresh session should open: the requested one, else the last used. */
export async function pickTenant(q, userId, requested) {
  const ms = (await userMemberships(q, userId)).filter((m) => m.status === 'active' && m.tenant_status === 'active');
  if (requested) return ms.find((m) => m.tenant_id === requested)?.tenant_id || null;
  return ms[0]?.tenant_id || null;
}
