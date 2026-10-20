// QuickBooks alerts for HQ (docs/integrations/quickbooks.md section 9). The hq_qbo_alerts job runs
// every 10 minutes in the worker's general pool (never the QuickBooks pool it watches: a stuck or
// empty QuickBooks pool must still be reported), checks the rules below and emails HQ_NOTIFY_EMAIL through the
// platform email outbox, at most once per alert kind per hour (budget alerts once per threshold
// per month). The email row is the record that an alert went out, so several workers never
// send the same alert twice.
//
// Sources hold no customer data: qbo_platform_events (kinds, times, tenant ids), jobs_queue
// (failed qbo_* jobs), qbo_api_usage (counts) and, for the inbox backlog, a per-tenant read of
// qbo_connections like the dispatcher's. Emails name the companies (HQ sees those anyway),
// never their customers, records or QuickBooks ids. First steps for each alert are in
// docs/runbooks/quickbooks-support.md and docs/compliance/logging-monitoring.md.
import { readConfig } from '../config.js';
import { createEmail } from '../lib/email.js';
import { enqueue } from '../services/queue.js';
import { onTrial } from '../services/entitlements.js';
import { hqSettings } from '../services/hq-common.js';

const EVERY_MS = 10 * 60_000;
const slotKey = (d) => new Date(Math.floor(d.getTime() / EVERY_MS) * EVERY_MS).toISOString().slice(0, 16);
const RUNBOOK = 'docs/runbooks/quickbooks-support.md';

/** Intuit's free Builder tier: CorePlus reads a month for the whole workspace (hard cap). */
export const INTUIT_READ_CAP = 500_000;

/** QuickBooks is on for this server when QBO_ENVIRONMENT is sandbox or production (2.1). */
export const qboEnabled = (env = process.env) => ['sandbox', 'production'].includes(String(env.QBO_ENVIRONMENT || '').trim());

/** The CorePlus budgets (QBO_READ_BUDGET, QBO_TENANT_READ_BUDGET, QBO_TRIAL_READ_BUDGET) with the contract's defaults. */
export function qboBudgets(env = process.env) {
  const n = (v, d) => { const x = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(x) && x > 0 ? x : d; };
  return { workspace: n(env.QBO_READ_BUDGET, 450_000), tenant: n(env.QBO_TENANT_READ_BUDGET, 20_000), trial: n(env.QBO_TRIAL_READ_BUDGET, 5000) };
}

/** A company's monthly CorePlus budget: the trial one while it is on a free trial. */
export const tenantBudget = (t, budgets) => (onTrial(t) ? budgets.trial : budgets.tenant);

/** The first day of this month (UTC), as qbo_api_usage.month stores it. */
export const usageMonth = (d = new Date()) => `${d.toISOString().slice(0, 7)}-01`;

// ---- the rules ----------------------------------------------------------------------

async function eventCount(db, kind, minutes) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS tenants FROM qbo_platform_events
      WHERE kind = $1 AND at > now() - make_interval(mins => $2)`, [kind, minutes]);
  return rows[0];
}

/** The most events of a kind inside any `minutes`-long window that ended in the last 20 minutes (the job runs every 10). */
async function burst(db, kind, minutes) {
  const { rows } = await db.query(
    `SELECT COALESCE(max(n), 0)::int AS n FROM (
       SELECT at, count(*) OVER (ORDER BY at RANGE BETWEEN make_interval(mins => $2) PRECEDING AND CURRENT ROW) AS n
         FROM qbo_platform_events WHERE kind = $1 AND at > now() - make_interval(mins => $2 + 20)) w
      WHERE at > now() - interval '20 minutes'`, [kind, minutes]);
  return rows[0].n;
}

async function tenantNames(db, kind, minutes) {
  const { rows } = await db.query(
    `SELECT DISTINCT t.name FROM qbo_platform_events e JOIN tenants t ON t.id = e.tenant_id
      WHERE e.kind = $1 AND e.at > now() - make_interval(mins => $2) ORDER BY t.name LIMIT 10`, [kind, minutes]);
  return rows.map((r) => r.name);
}

/** "Any event of this kind in the last hour" rules. */
const anyInHour = (kind, event, title, text, steps) => ({
  kind, title, steps,
  async check(db) {
    const c = await eventCount(db, event, 60);
    if (c.n < 1) return [];
    return [{ count: c.n, text: text(c), companies: await tenantNames(db, event, 60) }];
  },
});

export const RULES = [
  anyInHour('qbo_platform_credentials', 'platform_credentials', 'Intuit refused Fishtape\'s own app credentials',
    (c) => `The token endpoint refused QBO_CLIENT_ID / QBO_CLIENT_SECRET ${c.n} time(s) in the last hour. The token breaker stops every refresh for 10 minutes at a time; no company was marked "reconnect".`,
    ['Check QBO_CLIENT_ID and QBO_CLIENT_SECRET on the server (a rotation typo, or production keys with sandbox tokens).', 'Compare QBO_ENVIRONMENT with the keys in the Intuit developer portal.', 'Fix the env value, restart the API and worker, and watch for this alert to stop.']),
  {
    kind: 'qbo_mass_revoke',
    title: 'Many QuickBooks connections were refused at once',
    steps: ['Do not ask companies to reconnect yet: this is more likely a platform problem than many disconnects.', 'Check Intuit\'s status page and the app\'s keys; set QBO_WRITES=off if writes look wrong.', 'Once the cause is fixed, the affected companies retry on their own.'],
    async check(db) {
      const n = await burst(db, 'invalid_grant', 15);
      return n >= 5 ? [{ count: n, text: `${n} refresh tokens were refused (invalid_grant) within 15 minutes. After 5, further companies are not marked "reconnect needed" so a person can look first.`, companies: await tenantNames(db, 'invalid_grant', 35) }] : [];
    },
  },
  {
    kind: 'qbo_reconnect_spike',
    title: 'Several companies need to reconnect QuickBooks',
    steps: ['Look for a common cause (Intuit outage, an app setting changed in the developer portal, a key rotation).', 'If it is one company at a time, it is usual: they reconnect from the QuickBooks screen.'],
    async check(db) {
      const c = await eventCount(db, 'reconnect_needed', 60);
      return c.tenants >= 3 ? [{ count: c.tenants, text: `${c.tenants} companies entered "reconnect needed" in the last hour.`, companies: await tenantNames(db, 'reconnect_needed', 60) }] : [];
    },
  },
  anyInHour('qbo_webhook_signature', 'webhook_signature', 'QuickBooks webhooks with a bad signature',
    (c) => `${c.n} webhook call(s) to /api/v1/webhooks/qbo failed the signature check in the last hour. Nothing from them was stored.`,
    ['If the webhook verifier was just rotated, set QBO_WEBHOOK_VERIFIER_PREVIOUS to the old value until Intuit shows only the new one.', 'Otherwise someone may be probing the endpoint: check the nginx access log for the source and rate.']),
  {
    kind: 'qbo_jobs_failing',
    title: 'QuickBooks jobs are failing',
    steps: ['Open HQ > Health > Queue and read the qbo_* jobs\' errors (fixed messages, no customer data).', 'Check the worker is running and Intuit is up; pause the companies concerned from HQ if their syncs keep failing.'],
    async check(db) {
      const { rows } = await db.query(
        "SELECT count(*)::int AS n FROM jobs_queue WHERE kind LIKE $1 AND status = 'failed' AND finished_at > now() - interval '1 hour'", ['qbo\\_%']);
      return rows[0].n >= 5 ? [{ count: rows[0].n, text: `${rows[0].n} qbo_* jobs failed for good in the last hour.`, companies: [] }] : [];
    },
  },
  {
    kind: 'qbo_inbox_backlog',
    title: 'QuickBooks changes are not being pulled',
    steps: ['Check the worker\'s QuickBooks pool is running (WORKER_QBO_CONCURRENCY) and qbo_dispatch jobs are completing.', 'Open the company in HQ: a throttle, the read budget or an error may be holding its pass.'],
    async check(db) {
      const { rows } = await db.query("SELECT r.tenant_id, t.name FROM qbo_realms r JOIN tenants t ON t.id = r.tenant_id WHERE t.status = 'active' ORDER BY t.name");
      const late = [];
      for (const r of rows) {
        const stuck = await db.withTenant({ tenantId: r.tenant_id }, async (tx) => (await tx.query(
          "SELECT 1 FROM qbo_connections WHERE tenant_id = $1 AND state = 'active' AND dirty_at < now() - interval '2 hours'", [tx.tenantId])).rows.length > 0);
        if (stuck) late.push(r.name);
      }
      return late.length ? [{ count: late.length, text: `${late.length} active compan${late.length === 1 ? 'y has' : 'ies have'} had QuickBooks changes waiting for more than 2 hours.`, companies: late.slice(0, 10) }] : [];
    },
  },
  {
    kind: 'qbo_pool_stalled',
    title: 'The QuickBooks worker pool is not running',
    steps: ['Check the worker is up and WORKER_QBO_CONCURRENCY is 1 or more (docker compose logs worker).', 'In HQ > Health > Queue, look for qbo_* jobs that stay "running": the dispatcher puts one back after 3 minutes without a heartbeat, the hourly housekeeping after 15.'],
    async check(db) {
      const { rows } = await db.query(
        `SELECT (SELECT count(*)::int FROM qbo_realms) AS realms,
                EXTRACT(EPOCH FROM now() - (SELECT max(finished_at) FROM jobs_queue WHERE kind = 'qbo_dispatch' AND status = 'done'))::int AS since_dispatch,
                EXTRACT(EPOCH FROM now() - (SELECT min(run_at) FROM jobs_queue WHERE kind LIKE $1 AND status = 'queued' AND run_at <= now()))::int AS oldest`, ['qbo\\_%']);
      const r = rows[0];
      if (!r.realms) return [];
      const text = [];
      if (r.since_dispatch == null || r.since_dispatch > 300) text.push(r.since_dispatch == null ? 'No QuickBooks dispatch has finished yet.' : `The QuickBooks dispatcher last finished ${Math.round(r.since_dispatch / 60)} minutes ago (it runs every minute).`);
      if (r.oldest != null && r.oldest > 900) text.push(`The oldest QuickBooks job has waited ${Math.round(r.oldest / 60)} minutes for the pool.`);
      return text.length ? [{ count: 1, text: text.join(' '), companies: [] }] : [];
    },
  },
  {
    kind: 'qbo_intuit_5xx',
    title: 'Intuit is answering with server errors',
    steps: ['Check https://status.developer.intuit.com. Syncs retry on their own with backoff.', 'If it lasts, tell affected companies that QuickBooks is slow on Intuit\'s side.'],
    async check(db) {
      const n = await burst(db, 'intuit_5xx', 10);
      return n > 20 ? [{ count: n, text: `${n} Intuit 5xx answers within 10 minutes.`, companies: [] }] : [];
    },
  },
  {
    kind: 'qbo_budget',
    title: 'QuickBooks read allowance',
    steps: ['Open HQ > Developer > QuickBooks for the month\'s totals and the companies using the most.', 'Workspace at 70%: decide whether to buy Intuit\'s Silver tier before the 90% stop (look-ups and the 6-hourly catch-up stop for everyone).', 'A company at 50% or 80% of its own budget (look-ups stop for it at 80%): look for a loop or heavy look-ups before it is paused at 150%.'],
    async check(db, { env }) {
      const budgets = qboBudgets(env);
      const month = usageMonth();
      const out = [];
      const ws = (await db.query("SELECT COALESCE(sum(coreplus_calls), 0)::bigint AS n FROM qbo_api_usage WHERE month = $1 AND environment = 'production'", [month])).rows[0];
      const used = Number(ws.n);
      const pct = Math.floor((used / budgets.workspace) * 100);
      const step = pct >= 90 ? 90 : pct >= 70 ? 70 : null;
      if (step) {
        out.push({ key: `workspace:${step}:${month.slice(0, 7)}`, since: 'month', count: used, companies: [],
          text: `The workspace has used ${used.toLocaleString('en-CA')} CorePlus reads this month: ${pct}% of QBO_READ_BUDGET (${budgets.workspace.toLocaleString('en-CA')}); Intuit's cap is ${INTUIT_READ_CAP.toLocaleString('en-CA')}.` });
      }
      const { rows } = await db.query(
        `SELECT u.tenant_id, t.name, t.plan, t.billing_status, sum(u.coreplus_calls)::bigint AS n
           FROM qbo_api_usage u JOIN tenants t ON t.id = u.tenant_id
          WHERE u.month = $1 AND u.environment = 'production' GROUP BY 1, 2, 3, 4 ORDER BY n DESC`, [month]);
      for (const r of rows) {
        const budget = tenantBudget(r, budgets);
        const n = Number(r.n);
        // 50% and 80% (contract 5.11): one email per step per month.
        const tStep = n * 10 >= budget * 8 ? 80 : n * 2 >= budget ? 50 : null;
        if (!tStep) continue;
        out.push({ key: `tenant:${r.tenant_id}:${tStep}:${month.slice(0, 7)}`, since: 'month', count: n, companies: [r.name],
          text: `${r.name} has used ${n.toLocaleString('en-CA')} of its ${budget.toLocaleString('en-CA')} CorePlus reads this month (${Math.floor((n / budget) * 100)}%).${tStep === 80 ? ' Its look-ups have stopped until the 1st.' : ''}` });
      }
      return out;
    },
  },
  anyInHour('qbo_safety_brake', 'safety_brake', 'A company\'s QuickBooks sync hit the safety brake',
    (c) => `${c.n} safety brake(s) in the last hour: more than 500 writes in an hour, so the sync stopped before writing and the company was paused.`,
    ['Read the company\'s sync log counts in HQ and ask them what changed (a mapping, a bulk edit, an import).', 'If it looks like a bug, keep the company paused from HQ (Pause QuickBooks sync) until it is understood.']),
  anyInHour('qbo_realm_mismatch', 'realm_mismatch', 'QuickBooks rows for the wrong company were refused',
    (c) => `${c.n} time(s) in the last hour the sync found rows written for another QuickBooks company than the one connected, and refused to act on them.`,
    ['This should never happen: treat it as a bug. Pause the company from HQ and read docs/runbooks/quickbooks-support.md ("Purging").']),
  anyInHour('qbo_revoke_gave_up', 'revoke_gave_up', 'A QuickBooks token could not be revoked',
    (c) => `${c.n} refresh token(s) still failed to revoke after 14 days and were deleted. The grant may still be live at Intuit.`,
    ['Ask the company (or its QuickBooks admin) to disconnect Fishtape in QuickBooks: Apps > My apps > Fishtape > Disconnect.']),
];

// ---- sending ---------------------------------------------------------------------------

const email = createEmail();

/** Has this alert key been emailed within its window? The email outbox row is the record. */
async function sentRecently(db, template, since) {
  const sql = since === 'month'
    ? "SELECT 1 FROM email_outbox WHERE template = $1 AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' LIMIT 1"
    : "SELECT 1 FROM email_outbox WHERE template = $1 AND created_at > now() - interval '1 hour' LIMIT 1";
  return (await db.query(sql, [template])).rows.length > 0;
}

function body(rule, f, hqLink) {
  return [
    f.text,
    f.companies.length ? `\nCompanies: ${f.companies.join(', ')}` : '',
    '\nFirst steps:',
    ...rule.steps.map((s) => `- ${s}`),
    '',
    `Runbook: ${RUNBOOK}`,
    `HQ: ${hqLink}`,
    '',
    'At most one email per alert an hour. Counts only; no customer data.',
  ].join('\n');
}

/**
 * Check every rule once and email what fired.
 * @param {{ db: object, notifyEmail?: string, hqLink?: string, env?: object, rules?: object[] }} o
 * @returns {Promise<{ fired: string[], emailed: number, broken: string[] }>}
 */
export async function runQboAlerts({ db, notifyEmail = '', hqLink = '', env = process.env, rules = RULES }) {
  const fired = [];
  const broken = [];
  let emailed = 0;
  for (const rule of rules) {
    let findings;
    // One broken rule must not stop the others; the job result names it.
    try { findings = await rule.check(db, { env }); } catch { broken.push(rule.kind); findings = []; }
    for (const f of findings) {
      fired.push(rule.kind);
      if (!notifyEmail) continue;
      const template = `hq-qbo-alert:${rule.kind}${f.key ? `:${f.key}` : ''}`.slice(0, 200);
      if (await sentRecently(db, template, f.since)) continue;
      await email.send(db, { to: notifyEmail, template, subject: `QuickBooks alert: ${rule.title}`.slice(0, 150), text: body(rule, f, hqLink) });
      emailed++;
    }
  }
  return { fired, emailed, broken };
}

/**
 * @param {{ config?: object, env?: object, now?: () => Date, rules?: object[] }} [deps] tests pass their own
 */
export function createQboAlertHandlers(deps = {}) {
  const now = deps.now || (() => new Date());
  return {
    async hq_qbo_alerts({ db, job }) {
      const env = deps.env || process.env;
      if (!qboEnabled(env)) return { skipped: 'QuickBooks is off on this server' };
      const at = now();
      try {
        const config = deps.config || readConfig(env);
        const hq = hqSettings(config, env);
        return await runQboAlerts({ db, notifyEmail: hq.notifyEmail, hqLink: `${hq.publicUrl}#/developer/quickbooks`, env, rules: deps.rules });
      } finally {
        if (!job?.payload?.once) {
          const next = new Date(at.getTime() + EVERY_MS);
          await enqueue(db, { kind: 'hq_qbo_alerts', runAt: next, dedupeKey: `hq_qbo_alerts:${slotKey(next)}`, maxAttempts: 1 });
        }
      }
    },
  };
}

export const QBO_ALERT_HANDLERS = createQboAlertHandlers();

/**
 * Start the 10-minute alert chain (idempotent; the worker calls it at start and hourly), with the next
 * slot's link too: a killed worker's row may still hold this slot's key. Nothing when QuickBooks is off.
 */
export async function scheduleQboAlerts(db, at = new Date(), env = process.env) {
  if (!qboEnabled(env)) return;
  await enqueue(db, { kind: 'hq_qbo_alerts', dedupeKey: `hq_qbo_alerts:${slotKey(at)}`, maxAttempts: 1 });
  const next = new Date(Math.floor(at.getTime() / EVERY_MS) * EVERY_MS + EVERY_MS);
  await enqueue(db, { kind: 'hq_qbo_alerts', runAt: next, dedupeKey: `hq_qbo_alerts:${slotKey(next)}`, maxAttempts: 1 });
}
