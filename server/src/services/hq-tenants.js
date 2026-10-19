// HQ view of companies: list, detail, export, support reads. Every function takes an HQ
// client (db.withHq, BYPASSRLS); callers audit reads of a company's own data into its chain.
import { TABLE_COLLECTIONS, collectionDef } from '../collections.js';
import { PLANS } from '../../../electrical-app/js/plans.js';
import { effectivePlan, tenantEntitlements } from './entitlements.js';
import { extraSeats } from './billing.js';
import { clipDeep, iso } from './hq-common.js';

const TENANT_COLS = `t.id, t.slug, t.name, t.status, t.status_reason, t.status_changed_at, t.province, t.plan, t.plan_overrides,
  t.trial_ends_at, t.grace_ends_at, t.past_due_since, t.billing_status, t.billing_plan, t.billed_seats, t.current_period_end,
  t.cancel_at_period_end, t.stripe_customer_id IS NOT NULL AS has_customer, t.stripe_subscription_id IS NOT NULL AS has_subscription,
  t.last_export_at, t.delete_requested_at, t.delete_after, t.created_at, t.updated_at,
  (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS members,
  (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status IN ('active', 'invited')) AS seats,
  (SELECT max(s.last_seen_at) FROM sessions s WHERE s.tenant_id = t.id) AS last_active_at`;

/** Company row as HQ shows it. Never includes Stripe ids or secrets. */
export function tenantView(t) {
  const plan = effectivePlan(t);
  const included = PLANS[plan]?.includedUsers ?? null;
  return {
    id: t.id, slug: t.slug, name: t.name, status: t.status, statusReason: t.status_reason, statusChangedAt: iso(t.status_changed_at),
    province: t.province, plan: t.plan, effectivePlan: plan, overrides: t.plan_overrides || {}, trialEndsAt: iso(t.trial_ends_at),
    members: t.members, seats: { used: t.seats, included, extra: extraSeats(plan, t.seats), billed: t.billed_seats },
    billing: {
      status: t.billing_status, plan: t.billing_plan, pastDueSince: iso(t.past_due_since), graceEndsAt: iso(t.grace_ends_at),
      currentPeriodEnd: iso(t.current_period_end), cancelAtPeriodEnd: t.cancel_at_period_end, hasCustomer: t.has_customer, hasSubscription: t.has_subscription,
    },
    lastExportAt: iso(t.last_export_at), deleteRequestedAt: iso(t.delete_requested_at), deleteAfter: iso(t.delete_after),
    createdAt: iso(t.created_at), lastActiveAt: iso(t.last_active_at),
  };
}

export async function listTenants(c) {
  const { rows } = await c.query(`SELECT ${TENANT_COLS} FROM tenants t ORDER BY t.created_at`);
  return rows.map(tenantView);
}

/** Search by company name, slug or a member's email (the term travels in a POST body). */
export async function searchTenants(c, term) {
  const q = `%${String(term).trim().toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { rows } = await c.query(
    `SELECT ${TENANT_COLS} FROM tenants t
      WHERE lower(t.name) LIKE $1 OR t.slug LIKE $1 OR t.id::text = $2
         OR EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = t.id AND u.email LIKE $1)
      ORDER BY t.name LIMIT 100`, [q, String(term).trim()]);
  return rows.map(tenantView);
}

export async function loadTenant(c, id) {
  const { rows } = await c.query(`SELECT ${TENANT_COLS} FROM tenants t WHERE t.id = $1`, [id]);
  return rows[0] || null;
}

/** Live (not deleted) record counts per collection. */
export async function recordCounts(c, tenantId) {
  const parts = TABLE_COLLECTIONS.map((coll) => `SELECT '${coll}' AS collection, count(*)::int AS n FROM ${collectionDef(coll).table} WHERE tenant_id = $1 AND deleted_at IS NULL`);
  const { rows } = await c.query(parts.join(' UNION ALL '), [tenantId]);
  return Object.fromEntries(rows.map((r) => [r.collection, r.n]));
}

export async function tenantDetail(c, id) {
  const t = await loadTenant(c, id);
  if (!t) return null;
  const members = (await c.query(
    `SELECT m.id, m.role, m.status, m.employee_id, m.created_at, m.pin_hash IS NOT NULL AS has_pin,
            u.id AS user_id, u.display_name, u.email, u.last_login_at, u.status AS user_status,
            EXISTS (SELECT 1 FROM mfa_factors f WHERE f.user_id = u.id AND f.confirmed_at IS NOT NULL) AS mfa
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.display_name`, [id])).rows;
  const grants = (await c.query(
    `SELECT g.id, g.reason, g.created_at, g.expires_at, g.revoked_at, g.hq_user_id, u.display_name AS staff
       FROM support_grants g JOIN users u ON u.id = g.hq_user_id WHERE g.tenant_id = $1 ORDER BY g.created_at DESC LIMIT 20`, [id])).rows;
  const hqEvents = (await c.query(
    `SELECT seq, at, actor_label, action, summary FROM audit_events WHERE tenant_id = $1 AND actor_type IN ('hq', 'system')
      ORDER BY seq DESC LIMIT 30`, [id])).rows;
  const counts = await recordCounts(c, id);
  const devices = (await c.query('SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS n FROM devices WHERE tenant_id = $1', [id])).rows[0].n;
  const keys = (await c.query('SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS n FROM api_keys WHERE tenant_id = $1', [id])).rows[0].n;
  const now = Date.now();
  return {
    ...tenantView(t),
    entitlements: tenantEntitlements(t),
    members: members.map((m) => ({
      id: m.id, userId: m.user_id, name: m.display_name, email: m.email, role: m.role, status: m.status, userStatus: m.user_status,
      mfaEnrolled: m.mfa, hasPin: m.has_pin, lastLoginAt: iso(m.last_login_at), createdAt: iso(m.created_at),
    })),
    supportGrants: grants.map((g) => ({
      id: g.id, reason: g.reason, staff: g.staff, staffId: g.hq_user_id, createdAt: iso(g.created_at), expiresAt: iso(g.expires_at), revokedAt: iso(g.revoked_at),
      active: !g.revoked_at && new Date(g.expires_at).getTime() > now,
    })),
    hqEvents: hqEvents.map((e) => ({ seq: e.seq, at: iso(e.at), actor: e.actor_label, action: e.action, summary: e.summary })),
    recordCounts: counts,
    devices,
    apiKeys: keys,
  };
}

/** The active support grant this HQ user holds for the company, or null. */
export async function activeGrant(c, tenantId, hqUserId) {
  const { rows } = await c.query(
    `SELECT id, expires_at FROM support_grants WHERE tenant_id = $1 AND hq_user_id = $2 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1`, [tenantId, hqUserId]);
  return rows[0] || null;
}

/**
 * Everything the company has, for a data export: the company, members (no password,
 * MFA or PIN hashes), every collection including deleted records, devices and API keys
 * (names only), and its audit log. Tenant secrets are never read (HQ has no grant).
 */
export async function exportTenant(c, tenantId) {
  const t = await loadTenant(c, tenantId);
  if (!t) return null;
  const members = (await c.query(
    `SELECT m.id, m.role, m.status, m.employee_id, m.created_at, u.id AS user_id, u.display_name, u.email, u.last_login_at
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = $1 ORDER BY m.created_at`, [tenantId])).rows;
  const collections = {};
  for (const coll of TABLE_COLLECTIONS) {
    const { rows } = await c.query(
      `SELECT id, data, version, created_at, updated_at, deleted_at FROM ${collectionDef(coll).table} WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId]);
    collections[coll] = rows.map((r) => (r.deleted_at
      ? { id: r.id, version: r.version, deleted: true, deletedAt: iso(r.deleted_at) }
      : { ...r.data, id: r.id, version: r.version }));
  }
  const devices = (await c.query('SELECT id, name, created_at, last_seen_at, revoked_at FROM devices WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows;
  const apiKeys = (await c.query('SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows;
  const audit = (await c.query(
    `SELECT seq, at, actor_type, actor_label, action, collection, record_id, summary, hash FROM audit_events WHERE tenant_id = $1 ORDER BY seq`, [tenantId])).rows;
  return {
    format: 'fishtape-export',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    company: { id: t.id, slug: t.slug, name: t.name, province: t.province, status: t.status, plan: t.plan, createdAt: iso(t.created_at) },
    members: members.map((m) => ({ id: m.id, userId: m.user_id, name: m.display_name, email: m.email, role: m.role, status: m.status, employeeId: m.employee_id, createdAt: iso(m.created_at), lastLoginAt: iso(m.last_login_at) })),
    collections,
    devices: devices.map((d) => ({ id: d.id, name: d.name, createdAt: iso(d.created_at), lastSeenAt: iso(d.last_seen_at), revokedAt: iso(d.revoked_at) })),
    apiKeys: apiKeys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, createdAt: iso(k.created_at), lastUsedAt: iso(k.last_used_at), expiresAt: iso(k.expires_at), revokedAt: iso(k.revoked_at) })),
    auditLog: audit.map((a) => ({ seq: a.seq, at: iso(a.at), actorType: a.actor_type, actor: a.actor_label, action: a.action, collection: a.collection, recordId: a.record_id, summary: a.summary, hash: a.hash })),
  };
}

/** Read-only support view of one collection: newest first, long strings shortened. */
export async function supportRecords(c, tenantId, coll, limit) {
  if (coll === 'auditLog') {
    const { rows } = await c.query(
      `SELECT seq, at, actor_type, actor_label, action, collection, record_id, summary FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT $2`,
      [tenantId, limit]);
    return rows.map((a) => ({ id: String(a.seq), at: iso(a.at), actorType: a.actor_type, actor: a.actor_label, action: a.action, collection: a.collection, recordId: a.record_id, summary: a.summary }));
  }
  const { rows } = await c.query(
    `SELECT id, data, version, updated_at FROM ${collectionDef(coll).table} WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT $2`,
    [tenantId, limit]);
  return rows.map((r) => clipDeep({ ...r.data, id: r.id, version: r.version }));
}
