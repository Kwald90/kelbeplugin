// Customer-facing emails, wired into the records write pipeline (services/records.js afterWrite) so
// they fire on the real state transition, inside the same transaction as the change that triggers
// them. Two flows, both OFF by default and configured under settings.notifications:
//   ETA     -> afterTimeEntryWrite: a tech enters the time-clock TRAVEL state for a job with a
//              customer contact; the customer gets an "on the way" email naming the tech and job.
//   review  -> afterJobWrite: a job reaches a closed status (complete/invoiced); the customer gets a
//              short "how did we do?" email with the shop's review link.
// Each email is a queued `outbox` record (channel email), drained by the company's own SendGrid or
// Resend account like every other customer message (integrations/outbox.js). Dedupe is a deterministic
// outbox id (eta-<timeEntryId> / review-<jobId>): we never queue one that already exists, so a trigger
// never sends twice. The whole thing is best-effort: a failure here is swallowed and never rolls back
// the time entry or job that triggered it (the email is nested in its own savepoint, like notify()).
import { enqueue } from './queue.js';
import { appendAudit } from './audit.js';
import {
  commsSettings, shouldSendEta, shouldSendReview, etaEmail, reviewEmail,
} from '../../../electrical-app/js/lib/customer-comms.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const one = async (tx, sql, args) => (await tx.query(sql, [tx.tenantId, ...args])).rows[0] || null;
const record = (row) => (row ? { ...row.data, id: row.id } : null);
const load = (tx, table, id) => (id
  ? one(tx, `SELECT id, data FROM ${table} WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [String(id)]).then(record)
  : Promise.resolve(null));
const loadSettings = async (tx) => (await one(tx, "SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", []))?.data || {};
const outboxExists = async (tx, id) => Boolean(await one(tx, 'SELECT 1 FROM outbox WHERE tenant_id = $1 AND id = $2', [id]));

const clientEmail = (client) => {
  const e = String(client?.email || '').trim();
  return EMAIL_RE.test(e) ? e : '';
};

/** A company email provider (SendGrid or Resend) has its required secrets stored (not opened). */
async function emailConnected(tx) {
  const { rows } = await tx.query(
    'SELECT name FROM tenant_secrets WHERE tenant_id = $1 AND name = ANY($2)',
    [tx.tenantId, ['resend.api_key', 'resend.from', 'sendgrid.api_key', 'sendgrid.from']]);
  const have = new Set(rows.map((r) => r.name));
  return ['resend', 'sendgrid'].some((p) => have.has(`${p}.api_key`) && have.has(`${p}.from`));
}

/**
 * Queue one customer email as an outbox record and ask the worker to send it. Runs in its own
 * savepoint and swallows a duplicate (23505: the deterministic id already exists), so the caller's
 * write is never affected. Returns true when a new record was queued.
 */
async function queueEmail(tx, who, { id, kind, to, subject, body, relatedId, replyTo }) {
  const actor = `${who?.actor?.type || 'system'}:${who?.actor?.id ?? ''}`;
  const nowIso = new Date().toISOString();
  const data = {
    channel: 'email', kind, to, subject: String(subject).slice(0, 300), body: String(body).slice(0, 100000),
    relatedId: relatedId || null, status: 'queued', dueAt: nowIso, attempts: 0, source: 'customer-comms',
    ...(replyTo ? { replyTo } : {}), createdAt: nowIso, updatedAt: nowIso,
  };
  await tx.query('SAVEPOINT ccomm_one');
  try {
    await tx.query('INSERT INTO outbox (tenant_id, id, data, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)', [tx.tenantId, id, data, actor]);
    await enqueue(tx, { kind: 'integrations_send', tenantId: tx.tenantId, payload: { outboxId: id }, dedupeKey: `integrations_send:${tx.tenantId}:${id}`, maxAttempts: 1 });
    await tx.query('RELEASE SAVEPOINT ccomm_one');
    return true;
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT ccomm_one');
    if (e?.code !== '23505' && process.env.DEBUG_NOTIFY) console.error('customer-comms queueEmail failed', e);
    return false;
  }
}

/**
 * ETA / "on the way" email. Fires on the transition into the time-clock TRAVEL state.
 * @param {import('../db.js').TenantTx} tx
 * @param {{ id: string, before: object|null, after: object|null, who: object }} write
 */
export async function afterTimeEntryWrite(tx, { id, before, after, who }) {
  try {
    if (!shouldSendEta(before, after)) return;
    const settings = await loadSettings(tx);
    const cs = commsSettings(settings);
    if (!cs.eta.on) return;
    const outId = `eta-${id}`.slice(0, 128);
    if (await outboxExists(tx, outId)) return;
    if (!(await emailConnected(tx))) return;
    const job = await load(tx, 'jobs', after.jobId);
    if (!job) return;
    const client = await load(tx, 'clients', job.clientId);
    const to = clientEmail(client);
    if (!to) return;
    const tech = await load(tx, 'employees', after.employeeId);
    const { subject, body } = etaEmail({ company: settings.company || {}, tech: tech || {}, job, customerName: client?.name || '', message: cs.eta.message });
    const ok = await queueEmail(tx, who, { id: outId, kind: 'eta', to, subject, body, relatedId: job.id, replyTo: cs.replyTo });
    if (ok) {
      await appendAudit(tx, tx.tenantId, {
        actor: who.actor, action: 'customer.eta_sent', collection: 'jobs', recordId: job.id,
        summary: `On-the-way email queued to ${to}`, meta: { outboxId: outId, timeEntryId: id }, request: who.request,
      }).catch(() => {});
    }
  } catch (e) {
    if (process.env.DEBUG_NOTIFY) console.error('afterTimeEntryWrite failed', e);
  }
}

/**
 * Review / reputation ask. Fires on the transition into a closed job status (complete/invoiced).
 * @param {import('../db.js').TenantTx} tx
 * @param {{ id: string, before: object|null, after: object|null, who: object }} write
 */
export async function afterJobWrite(tx, { id, before, after, who }) {
  try {
    if (!shouldSendReview(before, after)) return;
    const settings = await loadSettings(tx);
    const cs = commsSettings(settings);
    if (!cs.review.on) return;
    const outId = `review-${id}`.slice(0, 128);
    if (await outboxExists(tx, outId)) return;
    if (!(await emailConnected(tx))) return;
    const job = { ...after, id };
    const client = await load(tx, 'clients', after.clientId);
    const to = clientEmail(client);
    if (!to) return;
    const { subject, body } = reviewEmail({ company: settings.company || {}, job, customerName: client?.name || '', reviewUrl: cs.review.url, message: cs.review.message });
    const ok = await queueEmail(tx, who, { id: outId, kind: 'review', to, subject, body, relatedId: job.id, replyTo: cs.replyTo });
    if (ok) {
      await appendAudit(tx, tx.tenantId, {
        actor: who.actor, action: 'customer.review_sent', collection: 'jobs', recordId: job.id,
        summary: `Review request queued to ${to}`, meta: { outboxId: outId }, request: who.request,
      }).catch(() => {});
    }
  } catch (e) {
    if (process.env.DEBUG_NOTIFY) console.error('afterJobWrite failed', e);
  }
}
