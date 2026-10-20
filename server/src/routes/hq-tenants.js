// /api/hq/tenants*: companies for HQ. List and search, detail, create (+ owner invite),
// suspend/reactivate, plan/trial/overrides, export, delete in two steps (export first,
// then a grace period before the worker purges), audited, time-boxed, read-only support
// access, and QuickBooks pause/resume (HQ staff) and release (HQ admin). HQ admins change
// things; HQ staff look and support.
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { isCollection } from '../collections.js';
import { PLAN_IDS } from '../../../electrical-app/js/plans.js';
import { OVERRIDE_KEYS } from '../services/entitlements.js';
import { EMAIL_RE, PROVINCES, createTenantWithOwner, normaliseEmail } from '../services/tenants.js';
import { issuePasswordLink } from '../services/resets.js';
import { createBilling } from '../services/billing.js';
import { enqueuePurge } from '../services/hq-jobs.js';
import { hqActor, hqAudit, hqSettings, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';
import { activeGrant, exportTenant, hasQboTables, listTenants, loadTenant, qboHealth, searchTenants, supportReadable, supportRecords, tenantDetail, tenantView } from '../services/hq-tenants.js';
import { requestFacts } from '../services/audit.js';
import { enqueue } from '../services/queue.js';

const PLAN_VALUES = ['trial', ...PLAN_IDS];

/**
 * Run the QuickBooks housekeeping for one company now: for a closed or released company it
 * revokes the grant at Intuit and finishes the disconnect (qbo_token_housekeeping, W1).
 * Nothing when the company never connected QuickBooks.
 */
async function enqueueQboClose(c, tenantId) {
  if (!(await hasQboTables(c))) return null;
  if (!(await c.query('SELECT 1 FROM qbo_connections WHERE tenant_id = $1', [tenantId])).rows.length) return null;
  return enqueue(c, { kind: 'qbo_token_housekeeping', tenantId, payload: { tenantId }, maxAttempts: 5, dedupeKey: `qbo_token_housekeeping:${tenantId}` });
}

/** @param {import('fastify').FastifyInstance} app */
export default async function hqTenantRoutes(app, { config, db, email }) {
  const settings = hqSettings(config);
  const billing = createBilling({ config, db });
  const hq = { auth: 'hq' };
  const tags = ['hq'];

  async function mustExist(c, id) {
    const t = await loadTenant(c, id);
    if (!t) throw notFound('No such company.');
    return t;
  }

  app.get('/api/hq/tenants', { config: hq, schema: { tags, summary: 'Companies with plan, seats, billing and status' } }, async () => {
    return { data: await db.withHq((c) => listTenants(c)) };
  });

  app.post('/api/hq/tenants/search', {
    config: hq,
    schema: { tags, summary: 'Search companies by name, slug, id or a member\'s email (term in the body, never the URL)', body: { type: 'object', required: ['q'], additionalProperties: false, properties: { q: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (req) => ({ data: await db.withHq((c) => searchTenants(c, req.body.q)) }));

  app.get('/api/hq/tenants/:id', { config: hq, schema: { tags, summary: 'One company: plan, seats, members (with MFA), support access, HQ events', params: uuidParams('id') } }, async (req) => {
    return db.withHq(async (c) => {
      const d = await tenantDetail(c, req.params.id);
      if (!d) throw notFound('No such company.');
      // Member names and emails are account data, not the company's records: logged as HQ activity.
      await hqAudit(c, req, null, { action: 'hq.tenant_view', collection: 'tenants', recordId: req.params.id, summary: 'Viewed company detail' });
      return d;
    });
  });

  // ---- create ------------------------------------------------------------------

  app.post('/api/hq/tenants', {
    config: hq,
    schema: {
      tags, summary: 'Create a company and invite its owner (HQ admin)',
      body: {
        type: 'object', required: ['name', 'ownerEmail'], additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          province: { type: ['string', 'null'], enum: [...PROVINCES, null] },
          ownerEmail: { type: 'string', minLength: 3, maxLength: 254 },
          ownerName: { type: 'string', maxLength: 200 },
          plan: { type: 'string', enum: PLAN_VALUES, default: 'trial' },
          trialDays: { type: 'integer', minimum: 1, maximum: 365 },
        },
      },
    },
  }, async (req, reply) => {
    requireHqAdmin(req);
    const b = req.body;
    const ownerEmail = normaliseEmail(b.ownerEmail);
    if (!EMAIL_RE.test(ownerEmail)) throw new ApiError(400, 'validation_failed', 'Enter a valid owner email.');
    const existing = (await db.query('SELECT id FROM users WHERE email = $1', [ownerEmail])).rows[0];
    const { tenant, userId } = await createTenantWithOwner(db, {
      name: b.name, province: b.province || null,
      ...(existing ? { userId: existing.id } : { owner: { email: ownerEmail, displayName: (b.ownerName || '').trim() || ownerEmail } }),
      actor: hqActor(req), request: requestFacts(req),
    });
    const trialEnds = b.plan === 'trial' ? new Date(Date.now() + (b.trialDays || settings.trialDays) * 86_400_000) : null;
    await db.tx(async (c) => {
      await c.query('UPDATE tenants SET plan = $2, trial_ends_at = $3, updated_at = now() WHERE id = $1', [tenant.id, b.plan, trialEnds]);
      if (!existing) {
        // New account: the owner sets a password from the invite (7 days); until then the seat shows as invited.
        await c.query("UPDATE memberships SET status = 'invited' WHERE tenant_id = $1 AND user_id = $2", [tenant.id, userId]);
        await issuePasswordLink(c, { config, email }, { userId, to: ownerEmail, invite: true });
      }
    });
    reply.code(201);
    return { tenant: { ...tenant, plan: b.plan, trialEndsAt: iso(trialEnds) }, ownerInvited: !existing, existingUser: Boolean(existing) };
  });

  // ---- status ------------------------------------------------------------------

  app.post('/api/hq/tenants/:id/status', {
    config: hq,
    schema: {
      tags, summary: 'Suspend or reactivate a company (HQ admin; audited in the company\'s log)', params: uuidParams('id'),
      body: { type: 'object', required: ['status'], additionalProperties: false, properties: { status: { type: 'string', enum: ['active', 'suspended'] }, reason: { type: 'string', maxLength: 500 } } },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const { status } = req.body;
    const reason = (req.body.reason || '').trim();
    if (status === 'suspended' && reason.length < 5) throw badRequest('Give a reason for the suspension (at least 5 characters).');
    return db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      if (t.status === 'closed') throw conflict('This company is scheduled for deletion. Restore it first.');
      if (t.status === status) return tenantView(t);
      await c.query('UPDATE tenants SET status = $2, status_reason = $3, status_changed_at = now(), updated_at = now() WHERE id = $1', [t.id, status, status === 'suspended' ? reason : null]);
      await hqAudit(c, req, t.id, {
        action: status === 'suspended' ? 'hq.tenant_suspend' : 'hq.tenant_reactivate', collection: 'tenants', recordId: t.id,
        summary: status === 'suspended' ? `Fishtape suspended this company: ${reason}` : 'Fishtape reactivated this company',
      });
      return tenantView(await loadTenant(c, t.id));
    });
  });

  // ---- plan, trial, overrides ----------------------------------------------------

  app.patch('/api/hq/tenants/:id/plan', {
    config: hq,
    schema: {
      tags, summary: 'Change plan, trial end and feature overrides (HQ admin; audited in the company\'s log)', params: uuidParams('id'),
      body: {
        type: 'object', additionalProperties: false, minProperties: 1,
        properties: {
          plan: { type: 'string', enum: PLAN_VALUES },
          trialEndsAt: { type: ['string', 'null'], format: 'date-time' },
          overrides: { type: 'object', additionalProperties: { type: 'boolean' }, maxProperties: 64 },
        },
      },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const b = req.body;
    if (b.overrides) {
      const bad = Object.keys(b.overrides).filter((k) => !OVERRIDE_KEYS.includes(k));
      if (bad.length) throw new ApiError(400, 'validation_failed', 'Unknown feature in overrides.', { errors: bad.slice(0, 10).map((k) => ({ path: `/overrides/${k}`, message: 'unknown feature' })) });
    }
    return db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      const next = {
        plan: b.plan ?? t.plan,
        trialEndsAt: 'trialEndsAt' in b ? (b.trialEndsAt ? new Date(b.trialEndsAt) : null) : t.trial_ends_at,
        overrides: b.overrides ?? t.plan_overrides,
      };
      await c.query('UPDATE tenants SET plan = $2, trial_ends_at = $3, plan_overrides = $4, updated_at = now() WHERE id = $1',
        [t.id, next.plan, next.trialEndsAt, JSON.stringify(next.overrides)]);
      const changes = [];
      if (next.plan !== t.plan) changes.push(`plan ${t.plan} -> ${next.plan}`);
      if (iso(next.trialEndsAt) !== iso(t.trial_ends_at)) changes.push(`trial ends ${iso(next.trialEndsAt)?.slice(0, 10) || 'never'}`);
      if (JSON.stringify(next.overrides) !== JSON.stringify(t.plan_overrides || {})) {
        changes.push(`overrides ${Object.entries(next.overrides).map(([k, v]) => `${k}:${v ? 'on' : 'off'}`).join(', ') || 'cleared'}`);
      }
      await hqAudit(c, req, t.id, {
        action: 'hq.plan_change', collection: 'tenants', recordId: t.id, summary: `Fishtape changed the plan: ${changes.join('; ') || 'no change'}`.slice(0, 500),
        meta: { from: { plan: t.plan, trialEndsAt: iso(t.trial_ends_at), overrides: t.plan_overrides }, to: { plan: next.plan, trialEndsAt: iso(next.trialEndsAt), overrides: next.overrides } },
      });
      return tenantView(await loadTenant(c, t.id));
    });
  });

  app.post('/api/hq/tenants/:id/billing/sync-seats', { config: hq, schema: { tags, summary: 'Bill the extra users the company has now (HQ admin)', params: uuidParams('id') } }, async (req) => {
    requireHqAdmin(req);
    const r = await billing.syncSeats(req.params.id);
    await db.withHq((c) => hqAudit(c, req, null, { action: 'hq.billing_sync_seats', collection: 'tenants', recordId: req.params.id, summary: r.synced ? `Seats synced: ${r.seats} (${r.extra} extra)` : 'No subscription to sync' }));
    return r;
  });

  // ---- export and delete -----------------------------------------------------------

  app.get('/api/hq/tenants/:id/export', { config: hq, schema: { tags, summary: 'Export all of a company\'s data as JSON (HQ admin; audited in the company\'s log)', params: uuidParams('id') } }, async (req) => {
    requireHqAdmin(req);
    return db.withHq(async (c) => {
      const data = await exportTenant(c, req.params.id);
      if (!data) throw notFound('No such company.');
      await c.query('UPDATE tenants SET last_export_at = now() WHERE id = $1', [req.params.id]);
      const n = Object.values(data.collections).reduce((a, r) => a + r.length, 0);
      await hqAudit(c, req, req.params.id, { action: 'hq.tenant_export', collection: 'tenants', recordId: req.params.id, summary: `Fishtape exported this company's data (${n} records)` });
      return data;
    });
  });

  app.post('/api/hq/tenants/:id/delete', {
    config: hq,
    schema: {
      tags, summary: 'Step 2 of deletion: close the company and schedule the purge after the grace period. Needs a fresh export (step 1).', params: uuidParams('id'),
      body: { type: 'object', required: ['confirmSlug', 'reason'], additionalProperties: false, properties: { confirmSlug: { type: 'string', maxLength: 100 }, reason: { type: 'string', minLength: 5, maxLength: 500 } } },
    },
  }, async (req) => {
    requireHqAdmin(req);
    return db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      if (req.body.confirmSlug !== t.slug) throw badRequest('Type the company\'s slug exactly to confirm.');
      if (t.status === 'closed') throw conflict('This company is already scheduled for deletion.');
      const fresh = t.last_export_at && Date.now() - new Date(t.last_export_at).getTime() < settings.exportFreshHours * 3_600_000;
      if (!fresh) throw new ApiError(409, 'export_required', `Export the company's data first (within the last ${settings.exportFreshHours} hours).`);
      const { rows } = await c.query(
        `UPDATE tenants SET status = 'closed', status_reason = $2, status_changed_at = now(), delete_requested_at = now(), delete_requested_by = $3,
                delete_after = now() + make_interval(days => $4), updated_at = now()
          WHERE id = $1 RETURNING delete_after`, [t.id, req.body.reason.trim(), req.principal.userId, settings.deleteGraceDays]);
      await enqueuePurge(c, t.id, rows[0].delete_after);
      // End the company's QuickBooks grant now (revoke and disconnect), long before the purge.
      await enqueueQboClose(c, t.id);
      await hqAudit(c, req, t.id, {
        action: 'hq.tenant_delete_requested', collection: 'tenants', recordId: t.id,
        summary: `Fishtape closed this company; its data will be deleted after ${iso(rows[0].delete_after).slice(0, 10)}. Reason: ${req.body.reason.trim()}`.slice(0, 500),
      });
      return tenantView(await loadTenant(c, t.id));
    });
  });

  app.post('/api/hq/tenants/:id/restore', { config: hq, schema: { tags, summary: 'Cancel a scheduled deletion during the grace period (HQ admin)', params: uuidParams('id') } }, async (req) => {
    requireHqAdmin(req);
    return db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      if (t.status !== 'closed') throw conflict('This company is not scheduled for deletion.');
      await c.query(
        `UPDATE tenants SET status = 'active', status_reason = NULL, status_changed_at = now(), delete_requested_at = NULL, delete_requested_by = NULL,
                delete_after = NULL, updated_at = now() WHERE id = $1`, [t.id]);
      await hqAudit(c, req, t.id, { action: 'hq.tenant_restore', collection: 'tenants', recordId: t.id, summary: 'Fishtape cancelled the deletion and reopened this company' });
      return tenantView(await loadTenant(c, t.id));
    });
  });

  // ---- QuickBooks: pause / resume and release (docs/integrations/quickbooks.md 2.9) ------
  // HQ writes only the columns migration 0150 grants it. lease_epoch is bumped to a value no
  // worker holds (the time in ms, above any epoch counted up since the last bump), so a pass
  // still running stops before its next write without HQ reading the column.

  const reasonBody = (extra = {}) => ({
    type: 'object', required: ['reason', ...Object.keys(extra)], additionalProperties: false,
    properties: { ...extra, reason: { type: 'string', minLength: 1, maxLength: 500 } },
  });
  const needReason = (req) => {
    const reason = req.body.reason.trim();
    if (reason.length < 5) throw badRequest('Give a reason (at least 5 characters).');
    return reason;
  };
  async function qboConnection(c, tenantId) {
    if (!(await hasQboTables(c))) throw conflict('QuickBooks is not set up on this server.');
    const row = (await c.query('SELECT state, state_before, pause_reason FROM qbo_connections WHERE tenant_id = $1 FOR UPDATE', [tenantId])).rows[0];
    if (!row) throw notFound('This company has no QuickBooks connection.');
    return row;
  }
  const BUMP_EPOCH = "lease_epoch = (extract(epoch FROM clock_timestamp()) * 1000)::bigint, lease_until = NULL, updated_at = now()";

  app.post('/api/hq/tenants/:id/quickbooks/pause', {
    config: hq,
    schema: { tags, summary: 'Pause or resume a company\'s QuickBooks sync (HQ; reason required; audited in the company\'s log). Only HQ can resume an HQ pause.', params: uuidParams('id'), body: reasonBody({ paused: { type: 'boolean' } }) },
  }, async (req) => {
    const reason = needReason(req);
    return db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      const cur = await qboConnection(c, t.id);
      const from = { state: cur.state, pauseReason: cur.pause_reason };
      if (req.body.paused) {
        if (cur.pause_reason === 'hq') return qboHealth(c, t);
        if (!['setup', 'active', 'paused'].includes(cur.state)) throw conflict('Only a connected company can be paused. This one needs to reconnect or is disconnected.');
        await c.query(`UPDATE qbo_connections SET state = 'paused', state_before = $2, pause_reason = 'hq', paused_since = COALESCE(paused_since, now()), ${BUMP_EPOCH} WHERE tenant_id = $1`,
          [t.id, cur.state]);
      } else {
        if (cur.state !== 'paused' || cur.pause_reason !== 'hq') throw conflict('QuickBooks sync is not paused by Fishtape for this company.');
        const back = cur.state_before || 'active';
        // A company that was already paused (by itself, its plan or the brake) goes back to that pause.
        const prior = back === 'paused' ? await priorPauseReason(c, t.id) : null;
        await c.query(
          `UPDATE qbo_connections SET state = $2, state_before = NULL, pause_reason = $3, paused_since = CASE WHEN $2 = 'paused' THEN paused_since END, updated_at = now()
            WHERE tenant_id = $1`, [t.id, back, prior]);
        // The next pass runs the Fishtape-side sweep first (2.5); start it now rather than at the next dispatch.
        if (back === 'active') await enqueue(c, { kind: 'qbo_sync', tenantId: t.id, payload: { reason: 'hq_resume' }, dedupeKey: `qbo_sync:${t.id}` });
      }
      await hqAudit(c, req, t.id, {
        action: 'hq.qbo.pause', collection: 'qbo_connections', recordId: t.id,
        summary: `${req.body.paused ? 'Fishtape paused QuickBooks sync' : 'Fishtape resumed QuickBooks sync'}: ${reason}`.slice(0, 500),
        meta: { paused: req.body.paused, from },
      });
      return qboHealth(c, t);
    });
  });

  /** The pause an HQ pause covered, from that pause's own audit event (the connection keeps no second reason). */
  async function priorPauseReason(c, tenantId) {
    const { rows } = await c.query(
      `SELECT meta->'from'->>'pauseReason' AS reason FROM audit_events
        WHERE tenant_id = $1 AND action = 'hq.qbo.pause' AND meta->>'paused' = 'true' ORDER BY seq DESC LIMIT 1`, [tenantId]);
    const r = rows[0]?.reason;
    return ['user', 'plan', 'budget', 'tenant_budget', 'brake'].includes(r) ? r : 'user';
  }

  app.post('/api/hq/tenants/:id/quickbooks/release', {
    config: hq,
    schema: { tags, summary: 'Release a company\'s QuickBooks company so another Fishtape company can connect it (HQ admin; reason required; audited). The worker then revokes and deletes the tokens.', params: uuidParams('id'), body: reasonBody() },
  }, async (req) => {
    requireHqAdmin(req);
    const reason = needReason(req);
    return db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      const cur = await qboConnection(c, t.id);
      await c.query(`UPDATE qbo_connections SET state = 'disconnected', state_before = NULL, pause_reason = NULL, paused_since = NULL, ${BUMP_EPOCH} WHERE tenant_id = $1`, [t.id]);
      await c.query('DELETE FROM qbo_realms WHERE tenant_id = $1', [t.id]);
      await enqueueQboClose(c, t.id);
      await hqAudit(c, req, t.id, {
        action: 'hq.qbo.release', collection: 'qbo_connections', recordId: t.id,
        summary: `Fishtape released this company's QuickBooks connection: ${reason}`.slice(0, 500), meta: { from: { state: cur.state, pauseReason: cur.pause_reason } },
      });
      return qboHealth(c, t);
    });
  });

  // ---- support access --------------------------------------------------------------

  app.post('/api/hq/tenants/:id/support-access', {
    config: hq,
    schema: {
      tags, summary: 'Open time-boxed, read-only support access (audited in the company\'s log, which the owner sees)', params: uuidParams('id'),
      body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 10, maxLength: 500 }, minutes: { type: 'integer', minimum: 15, maximum: 480, default: 60 } } },
    },
  }, async (req, reply) => {
    const reason = req.body.reason.trim();
    if (reason.length < 10) throw badRequest('Say why you need access (at least 10 characters).');
    const grant = await db.withHq(async (c) => {
      const t = await mustExist(c, req.params.id);
      if (t.status === 'closed') throw conflict('This company is scheduled for deletion.');
      const { rows } = await c.query(
        `INSERT INTO support_grants (tenant_id, hq_user_id, reason, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))
         RETURNING id, created_at, expires_at`, [t.id, req.principal.userId, reason, req.body.minutes]);
      await hqAudit(c, req, t.id, {
        action: 'hq.support_access', collection: 'support_grants', recordId: rows[0].id,
        summary: `Fishtape support (${req.principal.actor.label}) opened read-only access for ${req.body.minutes} min: ${reason}`.slice(0, 500),
        meta: { expiresAt: iso(rows[0].expires_at) },
      });
      return rows[0];
    });
    reply.code(201);
    return { id: grant.id, tenantId: req.params.id, reason, createdAt: iso(grant.created_at), expiresAt: iso(grant.expires_at) };
  });

  app.delete('/api/hq/support-access/:grantId', { config: hq, schema: { tags, summary: 'End support access early', params: uuidParams('grantId') } }, async (req, reply) => {
    await db.withHq(async (c) => {
      const { rows } = await c.query('SELECT id, tenant_id, hq_user_id, revoked_at, expires_at FROM support_grants WHERE id = $1', [req.params.grantId]);
      const g = rows[0];
      if (!g) throw notFound('No such support access.');
      if (g.hq_user_id !== req.principal.userId && req.principal.platformRole !== 'hq_admin') throw forbidden('Only the person who opened it, or an HQ admin, can end it.');
      if (g.revoked_at || new Date(g.expires_at) <= new Date()) return;
      await c.query('UPDATE support_grants SET revoked_at = now() WHERE id = $1', [g.id]);
      await hqAudit(c, req, g.tenant_id, { action: 'hq.support_access_end', collection: 'support_grants', recordId: g.id, summary: 'Fishtape support access ended' });
    });
    reply.code(204);
  });

  app.get('/api/hq/tenants/:id/support/:collection', {
    config: hq,
    schema: {
      tags, summary: 'Read one collection under an active support grant (read-only; each read is audited in the company\'s log)',
      params: { type: 'object', required: ['id', 'collection'], properties: { id: { type: 'string', format: 'uuid' }, collection: { type: 'string', maxLength: 40 } } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } } },
    },
  }, async (req) => {
    const { id, collection } = req.params;
    if (!isCollection(collection)) throw notFound('Unknown collection.');
    if (!supportReadable(collection)) throw forbidden('Location data belongs to each worker; support access does not include it.');
    return db.withHq(async (c) => {
      await mustExist(c, id);
      const grant = await activeGrant(c, id, req.principal.userId);
      if (!grant) throw new ApiError(403, 'support_access_required', 'Open support access for this company first (it is time-boxed and logged).');
      const data = await supportRecords(c, id, collection, req.query.limit);
      await hqAudit(c, req, id, {
        action: 'hq.support_read', collection, recordId: grant.id,
        summary: `Fishtape support viewed ${collection} (${data.length} records)`,
      });
      return { collection, data, expiresAt: iso(grant.expires_at), readOnly: true };
    });
  });
}
