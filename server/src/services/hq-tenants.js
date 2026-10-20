// HQ view of companies: list, detail, export, support reads. Every function takes an HQ
// client (db.withHq, BYPASSRLS); callers audit reads of a company's own data into its chain.
import { TABLE_COLLECTIONS, collectionDef } from '../collections.js';
import { PLANS } from '../../../electrical-app/js/plans.js';
import { effectivePlan, onTrial, tenantEntitlements } from './entitlements.js';
import { extraSeats } from './billing.js';
import { clipDeep, iso } from './hq-common.js';
import { ENTRY_COORDS } from '../auth/access.js';
import { qboBudgets, tenantBudget, usageMonth } from '../qbo/alerts.js';

const TENANT_COLS = `t.id, t.slug, t.name, t.status, t.status_reason, t.status_changed_at, t.province, t.plan, t.plan_overrides,
  t.trial_ends_at, t.grace_ends_at, t.past_due_since, t.billing_status, t.billing_plan, t.billed_seats, t.current_period_end,
  t.cancel_at_period_end, t.stripe_customer_id IS NOT NULL AS has_customer, t.stripe_subscription_id IS NOT NULL AS has_subscription,
  t.last_export_at, t.delete_requested_at, t.delete_after, t.created_at, t.updated_at,
  (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'active') AS members,
  (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status IN ('active', 'invited')) AS seats,
  (SELECT max(s.last_seen_at) FROM sessions s WHERE s.tenant_id = t.id) AS last_active_at,
  (SELECT json_build_object('plan', su.plan, 'users', su.user_count, 'depositPaid', su.deposit_paid_at IS NOT NULL,
          'depositCents', su.deposit_paid_cents, 'depositCredited', su.credited_at IS NOT NULL, 'creditError', su.credit_error,
          'emailVerified', su.welcome_used_at IS NOT NULL, 'at', su.completed_at)
     FROM signups su WHERE su.tenant_id = t.id ORDER BY su.completed_at DESC NULLS LAST LIMIT 1) AS signup`;

/** Company row as HQ shows it. Never includes Stripe ids or secrets. */
export function tenantView(t) {
  const plan = effectivePlan(t);
  const included = PLANS[plan]?.includedUsers ?? null;
  return {
    id: t.id, slug: t.slug, name: t.name, status: t.status, statusReason: t.status_reason, statusChangedAt: iso(t.status_changed_at),
    province: t.province, plan: t.plan, effectivePlan: plan, overrides: t.plan_overrides || {}, trialEndsAt: iso(t.trial_ends_at),
    onTrial: onTrial(t),
    // Self-serve sign-up (services/signup.js): deposit paid and credited; null for HQ-created companies.
    signup: t.signup ? { ...t.signup, at: iso(t.signup.at) } : null,
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
    `SELECT seq, at, actor_label, action, summary FROM audit_events
      WHERE tenant_id = $1 AND (actor_type = 'hq' OR action LIKE 'billing.%' OR action LIKE 'tenant.%')
      ORDER BY seq DESC LIMIT 30`, [id])).rows;
  const counts = await recordCounts(c, id);
  const devices = (await c.query('SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS n FROM devices WHERE tenant_id = $1', [id])).rows[0].n;
  const keys = (await c.query('SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS n FROM api_keys WHERE tenant_id = $1', [id])).rows[0].n;
  const quickbooks = await qboHealth(c, t);
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
    quickbooks,
  };
}

/** Are the QuickBooks tables there (migration 0150)? HQ pages work on a server without them. */
export async function hasQboTables(c) {
  return (await c.query("SELECT to_regclass('public.qbo_connections') IS NOT NULL AS ok")).rows[0].ok;
}

const LINK_STATES = ['synced', 'pending', 'error', 'blocked', 'conflict', 'needs_review'];

/**
 * A company's QuickBooks health for HQ (docs/integrations/quickbooks.md section 9): states, times
 * and counts from the columns HQ is granted (migration 0150), plus the last errors' codes and
 * Intuit transaction ids for Intuit support. Never the QuickBooks company name, record ids,
 * labels, messages or the realm. null when the server has no QuickBooks tables.
 */
export async function qboHealth(c, t, env = process.env) {
  if (!(await hasQboTables(c))) return null;
  const conn = (await c.query(
    `SELECT environment, state, pause_reason, paused_since, reconnect_reason, features->>'edition' AS edition, connected_at,
            refresh_expires_at, refresh_hard_expires_at, last_pull_at, last_push_at, last_webhook_at, last_check_at, throttled_until, disconnected_at
       FROM qbo_connections WHERE tenant_id = $1`, [t.id])).rows[0];
  if (!conn) return { connected: false, state: 'not_connected' };
  const links = Object.fromEntries(LINK_STATES.map((s) => [s, 0]));
  for (const r of (await c.query('SELECT state, count(*)::int AS n FROM qbo_links WHERE tenant_id = $1 GROUP BY state', [t.id])).rows) links[r.state] = r.n;
  const one = async (sql, params = [t.id]) => (await c.query(sql, params)).rows[0];
  const errors = await one("SELECT count(*)::int AS n FROM qbo_sync_log WHERE tenant_id = $1 AND outcome = 'error' AND at > now() - interval '24 hours'");
  // For Intuit support: what failed and Intuit's transaction id (it names a request, not a customer).
  const recent = (await c.query(
    `SELECT at, direction, action, collection, error_code, intuit_tid FROM qbo_sync_log
      WHERE tenant_id = $1 AND outcome = 'error' ORDER BY at DESC LIMIT 10`, [t.id])).rows;
  const conflicts = await one("SELECT count(*)::int AS n FROM qbo_conflicts WHERE tenant_id = $1 AND status = 'open'");
  const inbox = await one('SELECT count(*) FILTER (WHERE processed_at IS NULL)::int AS n FROM qbo_inbox WHERE tenant_id = $1');
  const outbox = await one('SELECT count(*)::int AS n, min(enqueued_at) AS oldest FROM qbo_outbox WHERE tenant_id = $1');
  const usage = await one(
    `SELECT COALESCE(sum(core_calls), 0)::int AS core, COALESCE(sum(coreplus_calls), 0)::int AS coreplus
       FROM qbo_api_usage WHERE tenant_id = $1 AND month = $2 AND environment = $3`, [t.id, usageMonth(), conn.environment]);
  return {
    connected: conn.state !== 'disconnected', state: conn.state, pauseReason: conn.pause_reason, reconnectReason: conn.reconnect_reason,
    environment: conn.environment, edition: conn.edition || null,
    connectedAt: iso(conn.connected_at), lastPullAt: iso(conn.last_pull_at), lastPushAt: iso(conn.last_push_at), lastWebhookAt: iso(conn.last_webhook_at),
    refreshExpiresAt: iso(conn.refresh_expires_at), hardExpiresAt: iso(conn.refresh_hard_expires_at),
    links, errors24h: errors.n, conflictsOpen: conflicts.n, inboxBacklog: inbox.n, outboxWaiting: outbox.n, outboxOldestAt: iso(outbox.oldest),
    pausedSince: iso(conn.paused_since), lastCheckAt: iso(conn.last_check_at), throttledUntil: iso(conn.throttled_until), disconnectedAt: iso(conn.disconnected_at),
    usageThisMonth: { core: usage.core, coreplus: usage.coreplus, budget: tenantBudget(t, qboBudgets(env)) },
    recentErrors: recent.map((r) => ({ at: iso(r.at), direction: r.direction, action: r.action, collection: r.collection, errorCode: r.error_code, intuitTid: r.intuit_tid })),
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
/**
 * Can support staff read this collection? Never a person's own location data (raw points and
 * consent answers: the RLS policy that keeps them per person does not bind the BYPASSRLS HQ role,
 * threat model TM-LOC-01), the same collections API keys never reach.
 */
export function supportReadable(coll) {
  const def = collectionDef(coll);
  return coll === 'auditLog' || Boolean(def && def.rls !== 'employee' && !def.noApiKeys);
}

export async function supportRecords(c, tenantId, coll, limit) {
  if (!supportReadable(coll)) throw new Error(`support view refuses ${coll}`);
  if (coll === 'auditLog') {
    const { rows } = await c.query(
      `SELECT seq, at, actor_type, actor_label, action, collection, record_id, summary FROM audit_events WHERE tenant_id = $1 ORDER BY seq DESC LIMIT $2`,
      [tenantId, limit]);
    return rows.map((a) => ({ id: String(a.seq), at: iso(a.at), actorType: a.actor_type, actor: a.actor_label, action: a.action, collection: a.collection, recordId: a.record_id, summary: a.summary }));
  }
  const { rows } = await c.query(
    `SELECT id, data, version, updated_at FROM ${collectionDef(coll).table} WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, id LIMIT $2`,
    [tenantId, limit]);
  return rows.map((r) => {
    const data = { ...r.data, id: r.id, version: r.version };
    // Clock-in/out coordinates stay with the company (API keys don't get them either).
    if (coll === 'timeEntries') for (const k of ENTRY_COORDS) delete data[k];
    return clipDeep(data);
  });
}
