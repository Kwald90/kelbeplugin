// Material requests to the office: one combined list, grouped by job, once a day at the time the
// company sets (default 3:00 pm in the company's time zone, from its province) or when someone
// taps "Send now". Each send:
//   - marks every waiting request (status 'requested') sent, with the batch id (they sync to every
//     device like any other change);
//   - records the batch (material_request_batches; at most one scheduled send per local day);
//   - puts it in the office's notification bell (owner, admin, office);
//   - emails the list through the platform email outbox to settings.materialRequests.emailTo
//     (else the company email), when there is one;
//   - writes one audit event.
// The list never carries prices or costs. The schedule logic is shared with the PWA
// (electrical-app/js/lib/materials.js) so both show the same "next send".
import { randomUUID } from 'node:crypto';
import { combinedText, groupByJob, localDayIn, nextSendAt, requestSettings } from '../../../electrical-app/js/lib/materials.js';
import { switchOn } from '../../../electrical-app/js/lib/modules.js';
import { createEmail } from '../lib/email.js';
import { appendAudit } from './audit.js';
import { enqueue } from './queue.js';
import { notify } from './notify.js';
import { loadTenantPlan, tenantHas } from './entitlements.js';
import { EMAIL_RE } from '../integrations/providers.js';

export const SEND_KIND = 'material_requests_send';
/** The office: who gets the bell notification. */
export const OFFICE_ROLES = ['owner', 'admin', 'office'];
const MAX_PER_BATCH = 500;
const MAX_RECIPIENTS = 5;

/** The company's settings record (data), or {} when it has none. */
export async function loadSettings(tx) {
  const { rows } = await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  return rows[0]?.data || {};
}

/** Up to five valid addresses from "a@x.ca, b@y.ca". */
export function recipients(emailTo) {
  return String(emailTo || '').split(/[,;\s]+/).map((s) => s.trim()).filter((s) => EMAIL_RE.test(s)).slice(0, MAX_RECIPIENTS);
}

/**
 * Send every waiting request now, inside the caller's tenant transaction.
 * @param {import('../db.js').TenantTx} tx
 * @param {{ kind: 'scheduled'|'now', actor: { type: string, id: string|null }, request?: object, email?: ReturnType<typeof createEmail>, config?: object, now?: Date, day?: string }} o
 * @returns {Promise<{ batchId: string|null, count: number, jobs: number, emailed: boolean, skipped?: string }>}
 */
export async function sendMaterialRequests(tx, { kind, actor, request, email = createEmail(), config, now = new Date(), day = null }) {
  const settings = await loadSettings(tx);
  const rs = requestSettings(settings);
  const localDate = day || localDayIn(now, rs.timeZone);
  const batchId = randomUUID();
  if (kind === 'scheduled') {
    // At most once per company per local day, whatever retries or extra workers do.
    const ins = await tx.query(
      `INSERT INTO material_request_batches (tenant_id, id, kind, local_date, time_zone, actor) VALUES ($1, $2, 'scheduled', $3, $4, $5)
       ON CONFLICT (tenant_id, local_date) WHERE kind = 'scheduled' DO NOTHING RETURNING id`,
      [tx.tenantId, batchId, localDate, rs.timeZone, `${actor.type}:${actor.id ?? ''}`]);
    if (!ins.rows[0]) return { batchId: null, count: 0, jobs: 0, emailed: false, skipped: 'already sent today' };
  }
  const { rows } = await tx.query(
    `SELECT id, data FROM material_requests WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'requested'
      ORDER BY created_at, id LIMIT $2 FOR UPDATE`, [tx.tenantId, MAX_PER_BATCH]);
  if (!rows.length) return { batchId: kind === 'scheduled' ? batchId : null, count: 0, jobs: 0, emailed: false };

  const requests = rows.map((r) => ({ ...r.data, id: r.id }));
  const jobIds = [...new Set(requests.map((r) => r.jobId).filter(Boolean))];
  const itemIds = [...new Set(requests.map((r) => r.itemId).filter(Boolean))];
  const empIds = [...new Set(requests.map((r) => r.employeeId).filter(Boolean))];
  const jobs = jobIds.length ? (await tx.query(
    "SELECT id, data->>'number' AS number, data->>'title' AS title, data->>'address' AS address FROM jobs WHERE tenant_id = $1 AND id = ANY($2)", [tx.tenantId, jobIds])).rows : [];
  const items = new Map(itemIds.length ? (await tx.query(
    "SELECT id, data->>'name' AS name, data->>'unit' AS unit FROM items WHERE tenant_id = $1 AND id = ANY($2)", [tx.tenantId, itemIds])).rows.map((r) => [r.id, r]) : []);
  const employees = new Map(empIds.length ? (await tx.query(
    "SELECT id, data->>'name' AS name FROM employees WHERE tenant_id = $1 AND id = ANY($2)", [tx.tenantId, empIds])).rows.map((r) => [r.id, r]) : []);
  const groups = groupByJob(requests, jobs);

  const at = now.toISOString();
  await tx.query(
    `UPDATE material_requests SET data = data || jsonb_build_object('status', 'sent', 'sentAt', $3::text, 'batchId', $4::text, 'updatedAt', $3::text), updated_by = $5
      WHERE tenant_id = $1 AND id = ANY($2)`,
    [tx.tenantId, requests.map((r) => r.id), at, batchId, `${actor.type}:${actor.id ?? ''}`]);

  const company = settings.company?.name || '';
  const dayLabel = new Date(`${localDate}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const link = `${config?.publicOrigin || ''}/#/materials`;
  const text = combinedText({ company, dayLabel, groups, items, employees, link });
  const to = recipients(rs.emailTo);
  const n = requests.length;
  const urgent = requests.filter((r) => r.urgent).length;
  const title = `${n} material request${n === 1 ? '' : 's'} for ${groups.length} job${groups.length === 1 ? '' : 's'}${urgent ? ` (${urgent} urgent)` : ''}`;
  for (const addr of to) {
    await email.send(tx, { tenantId: tx.tenantId, to: addr, template: 'material-requests', subject: `${title}${company ? ` · ${company}` : ''}`.slice(0, 200), text });
  }
  await notify(tx, {
    role: OFFICE_ROLES, kind: 'materials', title, link: `#/materials?batch=${batchId}`, ref: `materials:${batchId}`,
    body: groups.map((g) => `${g.job?.number || g.label} (${g.requests.length})`).join(', ').slice(0, 500),
  });

  if (kind === 'scheduled') {
    await tx.query('UPDATE material_request_batches SET request_count = $3, job_count = $4, emailed = $5 WHERE tenant_id = $1 AND id = $2',
      [tx.tenantId, batchId, n, groups.length, to.length > 0]);
  } else {
    await tx.query(
      `INSERT INTO material_request_batches (tenant_id, id, kind, local_date, time_zone, request_count, job_count, emailed, actor)
       VALUES ($1, $2, 'now', $3, $4, $5, $6, $7, $8)`,
      [tx.tenantId, batchId, localDate, rs.timeZone, n, groups.length, to.length > 0, `${actor.type}:${actor.id ?? ''}`]);
  }
  await appendAudit(tx, tx.tenantId, {
    actor, request, action: 'material_requests.send', collection: 'materialRequests', recordId: batchId,
    summary: `${kind === 'now' ? 'Sent now' : 'Daily send'}: ${title}`, meta: { kind, count: n, jobs: groups.length, emailed: to.length },
  });
  return { batchId, count: n, jobs: groups.length, emailed: to.length > 0 };
}

/** Pending count, the schedule and the last batch, for the Material requests page. */
export async function scheduleInfo(tx, { now = new Date(), employeeId } = {}) {
  const settings = await loadSettings(tx);
  const rs = requestSettings(settings);
  const next = nextSendAt(now, rs);
  // Crew count only their own waiting requests (the same own-rows rule as reading them).
  const pending = (await tx.query(
    "SELECT count(*)::int AS n FROM material_requests WHERE tenant_id = $1 AND deleted_at IS NULL AND status = 'requested' AND ($2::text IS NULL OR employee_id = $2)",
    [tx.tenantId, employeeId === undefined ? null : employeeId])).rows[0].n;
  const last = (await tx.query('SELECT id, kind, request_count, job_count, emailed, created_at FROM material_request_batches WHERE tenant_id = $1 AND request_count > 0 ORDER BY created_at DESC LIMIT 1', [tx.tenantId])).rows[0];
  return {
    sendAt: rs.sendAt, timeZone: rs.timeZone, nextSendAt: next.at.toISOString(), nextSendDay: next.day, pending,
    emailConfigured: recipients(rs.emailTo).length > 0, on: switchOn(settings, 'materials'),
    lastBatch: last ? { id: last.id, kind: last.kind, count: last.request_count, jobs: last.job_count, emailed: last.emailed, at: last.created_at.toISOString() } : null,
  };
}

// ---- the daily schedule (worker) ---------------------------------------------------

/**
 * Queue each active company's next daily send at its own local time. Deduplicated by company,
 * local day and time, so the hourly call queues it once; a changed time queues a new job and
 * the old one finds the time changed and stands down.
 */
export async function scheduleMaterialRequestSends(db, now = new Date(), { tenantId = null } = {}) {
  const tenants = tenantId
    ? (await db.query("SELECT id FROM tenants WHERE status = 'active' AND id = $1", [tenantId])).rows
    : (await db.query("SELECT id FROM tenants WHERE status = 'active'")).rows;
  let queued = 0;
  for (const t of tenants) {
    const settings = await db.withTenant({ tenantId: t.id }, (tx) => loadSettings(tx));
    if (!switchOn(settings, 'materials')) continue;
    const rs = requestSettings(settings);
    const next = nextSendAt(now, rs);
    const id = await enqueue(db, {
      kind: SEND_KIND, tenantId: t.id, runAt: next.at, maxAttempts: 5,
      payload: { tenantId: t.id, day: next.day, sendAt: rs.sendAt, timeZone: rs.timeZone },
      dedupeKey: `${SEND_KIND}:${t.id}:${next.day}:${rs.sendAt}:${rs.timeZone}`,
    });
    if (id) queued++;
  }
  return { queued };
}

/** Run one company's scheduled send (a queued job's payload). */
export async function runScheduledSend(db, payload, { email, config, now = new Date() } = {}) {
  const { tenantId, day, sendAt, timeZone } = payload || {};
  const t = (await db.query('SELECT id, status FROM tenants WHERE id = $1', [tenantId])).rows[0];
  if (!t || t.status !== 'active') return { skipped: 'company not active' };
  const plan = await loadTenantPlan(db, tenantId);
  if (!plan || !tenantHas(plan, 'materials')) return { skipped: 'not in plan' };
  return db.withTenant({ tenantId }, async (tx) => {
    const settings = await loadSettings(tx);
    if (!switchOn(settings, 'materials')) return { skipped: 'module turned off' };
    const rs = requestSettings(settings);
    if (rs.sendAt !== sendAt || rs.timeZone !== timeZone) return { skipped: 'send time changed' };
    return sendMaterialRequests(tx, { kind: 'scheduled', actor: { type: 'system', id: 'material-requests' }, email, config, now, day });
  }, { write: true });
}

/** Worker handlers (src/worker.js). */
export function createMaterialHandlers({ config, email } = {}) {
  return {
    async [SEND_KIND]({ db, job }) {
      try { return await runScheduledSend(db, job.payload, { config, email }); } finally {
        // Queue the next day straight away rather than waiting for the hourly scheduler.
        if (job.payload?.tenantId) await scheduleMaterialRequestSends(db, new Date(), { tenantId: job.payload.tenantId }).catch(() => {});
      }
    },
  };
}
