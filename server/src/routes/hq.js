// /api/hq/*: Fishtape HQ (staff only, MFA verified). Uses the fishtape_hq role (BYPASSRLS);
// every read of a company's own data writes an audit event into that company's chain, and
// every HQ change is audited (platform chain, or the company's chain when it is about one).
// This file: who am I, overview, feature flags, HQ activity and audit-chain checks.
// Companies are in hq-tenants.js, health in hq-health.js, compliance in hq-compliance.js,
// billing in hq-billing.js and sales leads in hq-leads.js.
import { appendFileSync, chmodSync } from 'node:fs';
import { ApiError, notFound } from '../errors.js';
import { appendAudit, requestFacts } from '../services/audit.js';
import { estimateMrrCents } from '../services/billing.js';
import { RESTORE_LINE_MAX, devHealth, healthLevel, normalizeRestoreResult, parseRestoreTests, tailFile } from '../services/hq-health.js';
import { createMetrics } from '../services/hq-metrics.js';
import { hqAudit, hqSettings, iso, requireHqAdmin, uuidParams } from '../services/hq-common.js';

/** Flags the code reads, with what they do. Other keys can be set for experiments. */
export const KNOWN_FLAGS = {
  signup_open: 'Anyone can create a company from the sign-in screen (otherwise HQ creates companies).',
};

/** @param {import('fastify').FastifyInstance} app */
export default async function hqRoutes(app, { config, db }) {
  const settings = hqSettings(config);
  const fallbackMetrics = createMetrics();

  app.get('/api/hq/me', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'The signed-in HQ staff member' } }, async (req) => {
    const { rows } = await db.query('SELECT id, display_name, email, platform_role FROM users WHERE id = $1', [req.principal.userId]);
    const u = rows[0];
    return { user: { id: u.id, name: u.display_name, email: u.email, role: u.platform_role } };
  });

  app.get('/api/hq/overview', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'Companies, users, MRR, trials, incidents and health at a glance' } }, async (req) => {
    const data = await db.withHq(async (c) => {
      const tenants = (await c.query(
        `SELECT t.id, t.name, t.status, t.plan, t.trial_ends_at, t.grace_ends_at, t.billing_status, t.billing_plan, t.billed_seats,
                (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status IN ('active', 'invited')) AS seats
           FROM tenants t`)).rows;
      const users = (await c.query(
        `SELECT count(DISTINCT user_id) FILTER (WHERE last_seen_at > now() - interval '30 days')::int AS d30,
                count(DISTINCT user_id) FILTER (WHERE last_seen_at > now() - interval '7 days')::int AS d7,
                count(DISTINCT user_id) FILTER (WHERE last_seen_at > now() - interval '1 day')::int AS d1
           FROM sessions`)).rows[0];
      const incidents = (await c.query(
        `SELECT id, number, title, severity, status, opened_at FROM hq_incidents WHERE status IN ('open', 'monitoring') ORDER BY severity, opened_at`)).rows;
      const leads = (await c.query("SELECT count(*) FILTER (WHERE stage = 'new')::int AS fresh, count(*) FILTER (WHERE stage NOT IN ('won', 'lost'))::int AS open FROM hq_leads")).rows[0];
      const failed = (await c.query("SELECT count(*)::int AS n FROM billing_events WHERE type = 'invoice.payment_failed' AND received_at > now() - interval '30 days'")).rows[0].n;
      const signup = (await c.query("SELECT enabled FROM feature_flags WHERE key = 'signup_open' AND tenant_id IS NULL")).rows[0];
      return { tenants, users, incidents, leads, failed, signupOpen: Boolean(signup?.enabled) };
    });
    const now = Date.now();
    const byStatus = { active: 0, suspended: 0, closed: 0 };
    for (const t of data.tenants) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const trials = data.tenants.filter((t) => t.plan === 'trial' && t.status === 'active');
    const trialsEnding = trials
      .filter((t) => t.trial_ends_at && new Date(t.trial_ends_at).getTime() > now && new Date(t.trial_ends_at).getTime() < now + 14 * 86_400_000)
      .sort((a, b) => new Date(a.trial_ends_at) - new Date(b.trial_ends_at))
      .map((t) => ({ id: t.id, name: t.name, trialEndsAt: iso(t.trial_ends_at) }));
    const h = await devHealth({ config, db, settings, metrics: req.server.hqMetrics || fallbackMetrics });
    return {
      tenants: { total: data.tenants.length, ...byStatus, onTrial: trials.length, paying: data.tenants.filter((t) => ['active', 'past_due'].includes(t.billing_status)).length },
      activeUsers: { day: data.users.d1, week: data.users.d7, month: data.users.d30 },
      mrrCents: estimateMrrCents(data.tenants),
      pastDue: data.tenants.filter((t) => t.billing_status === 'past_due' || t.grace_ends_at).length,
      failedPayments30d: data.failed,
      trialsEnding,
      incidents: data.incidents.map((i) => ({ id: i.id, number: i.number, title: i.title, severity: i.severity, status: i.status, openedAt: iso(i.opened_at) })),
      leads: { new: data.leads.fresh, open: data.leads.open },
      signupOpen: data.signupOpen,
      health: {
        ...healthLevel(h), environment: h.environment, version: h.version, gitSha: h.gitSha, uptimeSeconds: h.uptimeSeconds,
        dbLatencyMs: h.database.latencyMs ?? null, queueFailed24h: h.queue?.failed24h ?? null, errors5xxLastHour: h.errors.lastHour.errors5xx,
      },
    };
  });

  // ---- feature flags ---------------------------------------------------------

  app.get('/api/hq/flags', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'Feature flags (platform-wide and per company)' } }, async () => {
    const rows = await db.withHq(async (c) => (await c.query(
      `SELECT f.key, f.tenant_id, t.name AS tenant_name, f.enabled, f.value, f.updated_at
         FROM feature_flags f LEFT JOIN tenants t ON t.id = f.tenant_id ORDER BY f.key, t.name NULLS FIRST`)).rows);
    const out = rows.map((f) => ({ key: f.key, tenantId: f.tenant_id, tenantName: f.tenant_name, enabled: f.enabled, value: f.value, updatedAt: iso(f.updated_at), description: KNOWN_FLAGS[f.key] || null }));
    for (const [key, description] of Object.entries(KNOWN_FLAGS)) {
      if (!out.some((f) => f.key === key && !f.tenantId)) out.push({ key, tenantId: null, tenantName: null, enabled: false, value: null, updatedAt: null, description });
    }
    return { data: out, known: KNOWN_FLAGS };
  });

  app.put('/api/hq/flags/:key', {
    config: { auth: 'hq' },
    schema: {
      tags: ['hq'], summary: 'Turn a flag on or off (HQ admin; audited)',
      params: { type: 'object', required: ['key'], properties: { key: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' } } },
      body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, tenantId: { type: ['string', 'null'], format: 'uuid' } } },
    },
  }, async (req) => {
    requireHqAdmin(req);
    const { key } = req.params;
    const tenantId = req.body.tenantId || null;
    return db.withHq(async (c) => {
      if (tenantId && !(await c.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId])).rows.length) throw notFound('No such company.');
      const before = (await c.query('SELECT enabled FROM feature_flags WHERE key = $1 AND tenant_id IS NOT DISTINCT FROM $2', [key, tenantId])).rows[0];
      await c.query(
        `INSERT INTO feature_flags (key, tenant_id, enabled, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key, COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`, [key, tenantId, req.body.enabled]);
      await hqAudit(c, req, tenantId, {
        action: 'hq.flag_set', collection: 'feature_flags', recordId: key,
        summary: `Flag ${key} ${req.body.enabled ? 'on' : 'off'}${tenantId ? ' for this company' : ' platform-wide'}`, meta: { from: before?.enabled ?? null, to: req.body.enabled },
      });
      return { key, tenantId, enabled: req.body.enabled };
    });
  });

  // ---- restore drills ------------------------------------------------------------

  // The offsite drill runs on Kelvin's PC (deploy/<env>/offsite-drill.sh), never on the server, so
  // its JSON line reaches the server here and is appended to RESTORE_TESTS_FILE, where HQ health
  // and the hourly backup alerts read it (docs/runbooks/offsite-backups.md).
  app.post('/api/hq/restore-tests', {
    config: { auth: 'hq' },
    schema: {
      tags: ['hq'], summary: 'Record a restore-drill result (the JSON line offsite-drill.sh wrote; audited)',
      body: { type: 'object', required: ['line'], additionalProperties: false, properties: { line: { type: 'string', minLength: 2, maxLength: RESTORE_LINE_MAX } } },
    },
  }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!config.restoreTestsFile) throw new ApiError(409, 'not_configured', 'RESTORE_TESTS_FILE is not set on this server, so drill results cannot be kept.');
    // The last non-empty line, so a whole restore-tests.jsonl can be pasted.
    const text = req.body.line.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) || '';
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new ApiError(400, 'validation_failed', 'That is not a JSON line from the drill.'); }
    const result = normalizeRestoreResult(parsed);
    if (!result) throw new ApiError(400, 'validation_failed', 'The line needs at least "ts" (a time) and "ok" (true or false).');
    const ts = Date.parse(result.ts);
    if (ts > Date.now() + 86_400_000 || ts < Date.now() - 400 * 86_400_000) throw new ApiError(400, 'validation_failed', 'The drill time is in the future or more than 400 days ago.');
    if (result.environment && result.environment !== config.appEnv) {
      throw new ApiError(422, 'wrong_environment', `This drill was for ${result.environment}; record it on that environment's HQ (this is ${config.appEnv}).`);
    }
    let existing = [];
    try { existing = parseRestoreTests(tailFile(config.restoreTestsFile, 256 * 1024)); } catch (e) {
      if (e?.code !== 'ENOENT') throw new ApiError(500, 'internal', 'Could not read RESTORE_TESTS_FILE.');
    }
    if (existing.some((r) => r.ts === result.ts && r.source === result.source && r.file === result.file && r.ok === result.ok)) {
      return { recorded: false, duplicate: true, result };
    }
    const line = { ...result, recordedBy: String(req.principal.actor?.label || 'HQ').slice(0, 200), recordedAt: new Date().toISOString() };
    try {
      appendFileSync(config.restoreTestsFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      chmodSync(config.restoreTestsFile, 0o600);
    } catch {
      throw new ApiError(500, 'internal', 'Could not write RESTORE_TESTS_FILE (check the drills mount is writable by the HQ API).');
    }
    await db.withHq((c) => hqAudit(c, req, null, {
      action: 'hq.restore_test_recorded', collection: 'restore_tests', recordId: result.file || result.ts,
      summary: `Restore ${result.source === 'offsite' ? 'drill (offsite)' : 'test'} ${result.ok ? 'passed' : 'FAILED'} on ${result.ts.slice(0, 10)}${result.secretsChecked ? ', secrets checked' : ''}`,
      meta: { ok: result.ok, source: result.source, host: result.host, environment: result.environment, file: result.file, secretsChecked: result.secretsChecked, secretsOk: result.secretsOk },
    }));
    return { recorded: true, result: line };
  });

  // ---- HQ activity and audit chains -------------------------------------------

  app.get('/api/hq/activity', {
    config: { auth: 'hq' },
    schema: {
      tags: ['hq'], summary: 'What HQ staff did, newest first (from every audit chain)',
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }, cursor: { type: 'string', pattern: '^\\d{1,18}$' } } },
    },
  }, async (req) => {
    const rows = await db.withHq(async (c) => (await c.query(
      `SELECT e.seq, e.at, e.tenant_id, t.name AS tenant_name, e.actor_label, e.action, e.collection, e.record_id, e.summary
         FROM audit_events e LEFT JOIN tenants t ON t.id = e.tenant_id
        WHERE (e.actor_type = 'hq' OR (e.tenant_id IS NULL AND e.action IN ('tenant.purged', 'lead.create')))
          AND ($2::bigint IS NULL OR e.seq < $2::bigint)
        ORDER BY e.seq DESC LIMIT $1`, [req.query.limit + 1, req.query.cursor || null])).rows);
    const more = rows.length > req.query.limit;
    const page = rows.slice(0, req.query.limit);
    return {
      data: page.map((e) => ({ seq: e.seq, at: iso(e.at), tenantId: e.tenant_id, tenantName: e.tenant_name, actor: e.actor_label, action: e.action, collection: e.collection, recordId: e.record_id, summary: e.summary })),
      cursor: more ? String(page[page.length - 1].seq) : null,
      more,
    };
  });

  app.get('/api/hq/tenants/:id/audit/verify', {
    config: { auth: 'hq' },
    schema: { tags: ['hq'], summary: 'Verify a company\'s audit hash chain (audited)', params: uuidParams('id') },
  }, async (req) => {
    return db.withHq(async (c) => {
      const t = await c.query('SELECT id, name FROM tenants WHERE id = $1', [req.params.id]);
      if (!t.rows[0]) throw notFound('No such company.');
      const { rows } = await c.query('SELECT * FROM audit_verify_chain($1)', [req.params.id]);
      // Reading a tenant's audit log is a read of tenant data: record it in their chain.
      await appendAudit(c, req.params.id, {
        actor: req.principal.actor, action: 'hq.audit_verify', collection: 'audit_events', summary: `HQ verified the audit chain (${rows[0].checked} events)`, request: requestFacts(req),
      });
      return { tenantId: req.params.id, ok: rows[0].ok, checked: rows[0].checked, firstBadSeq: rows[0].first_bad_seq };
    });
  });

  app.get('/api/hq/audit/verify-platform', { config: { auth: 'hq' }, schema: { tags: ['hq'], summary: 'Verify the platform audit chain' } }, async () => {
    const { rows } = await db.withHq((c) => c.query('SELECT * FROM audit_verify_chain(NULL)'));
    if (!rows[0]) throw new ApiError(500, 'internal', 'Could not verify.');
    return { ok: rows[0].ok, checked: rows[0].checked, firstBadSeq: rows[0].first_bad_seq };
  });
}
