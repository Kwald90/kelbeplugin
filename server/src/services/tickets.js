// Field tickets on the server (docs/releases/r1-get-paid.md 4.1, 10.1; docs/field/tickets.md).
//
// The tickets_sweep job runs every 15 minutes for each company with the tickets module on. For each
// ticket that arrived signed or refused it does, once (keyed by the ticket id):
//   - tells the office (kind ticket_signed, no amounts);
//   - emails the signer a copy when an address was given (outbox tcopy-<ticketId>, kind ticket_copy);
//   - on a refusal, with settings.tickets.noticeOnRefusal on, queues the written notice of extra work
//     to the general contractor (outbox tnotice-<ticketId>) and stores ticket.notice;
//   - on a service job, drafts the invoice from the ticket (svc-<ticketId>, numbered here the way the
//     QuickBooks renumber does) and tells the office "Price within the hour" (kind service_draft).
// Drafts are never sent on their own; the office taps "Send as written notice"
// (POST /api/v1/tickets/:id/send, routes/v1/tickets.js). Without email on the plan the office prints.
// Writes go through the records service as the system actor `tickets`.
import { ApiError, conflict, notFound } from '../errors.js';
import { enqueue } from './queue.js';
import { notify } from './notify.js';
import { appendAudit } from './audit.js';
import { loadTenantPlan, tenantHas } from './entitlements.js';
import { createValidator } from '../schemas.js';
import { createRecords } from './records.js';
import { systemPrincipal, systemWho } from '../integrations/state.js';
import { switchOn } from '../../../electrical-app/js/lib/modules.js';
import { newDocTax } from '../../../electrical-app/js/lib/tax.js';
import { dayIn, zoneFor } from '../../../electrical-app/js/lib/closing.js';
import { ticketLabel, ticketToInvoiceLines, noticeText, ticketBodyLines } from '../../../electrical-app/js/lib/tickets.js';

export const SWEEP_KIND = 'tickets_sweep';
const SLOT_MS = 15 * 60 * 1000;
const ACTOR_ID = 'tickets';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const slotKey = (d) => new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS).toISOString().slice(0, 16);

const one = async (tx, sql, args) => (await tx.query(sql, [tx.tenantId, ...args])).rows[0] || null;
const record = (row) => (row ? { ...row.data, id: row.id } : null);
const loadSettings = async (tx) => (await one(tx, "SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", []))?.data || {};
const load = async (tx, table, id) => (id ? record(await one(tx, `SELECT id, data FROM ${table} WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [String(id)])) : null);
const exists = async (tx, table, id) => Boolean(await one(tx, `SELECT 1 FROM ${table} WHERE tenant_id = $1 AND id = $2`, [id]));

/** Email is on the plan and a provider is connected (else the office prints). */
async function emailReady(db, tx, tenantId) {
  const plan = await loadTenantPlan(db, tenantId);
  if (!plan || !tenantHas(plan, 'integrations.email')) return false;
  return emailConnected(tx);
}

/** A company email provider (SendGrid or Resend) has its required secrets stored (checked without opening them). */
export async function emailConnected(tx) {
  const { rows } = await tx.query('SELECT name FROM tenant_secrets WHERE tenant_id = $1 AND name = ANY($2)', [tx.tenantId, ['resend.api_key', 'resend.from', 'sendgrid.api_key', 'sendgrid.from']]);
  const have = new Set(rows.map((r) => r.name));
  return ['resend', 'sendgrid'].some((p) => have.has(`${p}.api_key`) && have.has(`${p}.from`));
}

/** Who gets a written notice: the general contractor's email (contract.gcClientId), else the job's client. */
export async function noticeRecipient(tx, job) {
  for (const id of [job?.contract?.gcClientId, job?.clientId]) {
    const c = await load(tx, 'clients', id);
    const to = String(c?.credit?.statementEmail || c?.email || '').trim();
    if (EMAIL_RE.test(to)) return { to, client: c };
  }
  return null;
}

async function queueEmail(tx, records, p, { id, kind, to, subject, body, relatedId }) {
  await records.createRecord(tx, p, 'outbox', { id, channel: 'email', kind, to, subject: subject.slice(0, 300), body, relatedId, status: 'queued', dueAt: new Date().toISOString() }, systemWho(p));
  await enqueue(tx, { kind: 'integrations_send', tenantId: tx.tenantId, payload: { outboxId: id }, dedupeKey: `integrations_send:${tx.tenantId}:${id}`, maxAttempts: 1 });
}

/** The next invoice number on the server: settings.nextNumbers.invoice, never below an existing INV-n. */
async function nextInvoiceNumber(tx, records, p, settings) {
  let top = Number(settings.nextNumbers?.invoice) || 3001;
  const { rows } = await tx.query("SELECT number FROM invoices WHERE tenant_id = $1 AND number ~ '^INV-[0-9]+$'", [tx.tenantId]);
  for (const r of rows) top = Math.max(top, Number(r.number.slice(4)) + 1);
  await records.patchRecord(tx, p, 'settings', 'settings', { nextNumbers: { ...(settings.nextNumbers || {}), invoice: top + 1 } }, {}, systemWho(p));
  settings.nextNumbers = { ...(settings.nextNumbers || {}), invoice: top + 1 };
  return `INV-${top}`;
}

/**
 * One company's sweep. Each step is keyed by the ticket id, so a second run changes nothing.
 * @returns {Promise<{ seen: number, copies: number, notices: number, drafts: number }>}
 */
export async function runTicketsSweep(db, tenantId, { records, now = new Date() } = {}) {
  const plan = await loadTenantPlan(db, tenantId);
  if (!plan || !tenantHas(plan, 'tickets', now)) return { skipped: 'not in plan' };
  return db.withTenant({ tenantId }, async (tx) => {
    const settings = await loadSettings(tx);
    if (!switchOn(settings, 'tickets')) return { skipped: 'tickets turned off' };
    const p = systemPrincipal(tenantId, ACTOR_ID, 'Field tickets');
    const zone = zoneFor(settings.company?.province);
    const email = await emailReady(db, tx, tenantId);
    const { rows } = await tx.query(
      `SELECT id, data FROM field_tickets WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'status' IN ('signed', 'refused', 'priced', 'billed')
         AND updated_at > now() - interval '45 days' ORDER BY updated_at LIMIT 500`, [tenantId]);
    const out = { seen: rows.length, copies: 0, notices: 0, drafts: 0 };
    for (const t of rows.map(record)) {
      const job = await load(tx, 'jobs', t.jobId);
      const label = ticketLabel(t);
      const where = job ? ` on ${job.number || ''} ${job.title || ''}`.replace(/\s+$/, '') : '';
      await notify(tx, {
        perm: 'invoices', kind: 'ticket_signed', ref: `ticket_signed:${t.id}`, link: `#/tickets/${t.id}`,
        title: t.refusal && !t.signatureId ? `${label}${where} was refused by ${t.refusal.by || 'the customer'}` : `${label}${where} was signed by ${t.signerName || 'the customer'}`,
      });
      // A copy for the signer.
      if (email && t.signatureId && !(await exists(tx, 'outbox', `tcopy-${t.id}`))) {
        const sig = await load(tx, 'signatures', t.signatureId);
        if (sig?.signerEmail && EMAIL_RE.test(sig.signerEmail)) {
          await queueEmail(tx, records, p, {
            id: `tcopy-${t.id}`.slice(0, 128), kind: 'ticket_copy', to: sig.signerEmail, relatedId: t.id,
            subject: `Your copy of ${label}${job ? ` (${job.number || job.title || ''})` : ''} from ${settings.company?.name || 'your contractor'}`,
            body: [`Hi ${String(sig.signerName || '').split(/\s+/)[0] || 'there'},`, '', `Here is the ticket you signed on ${t.date}.`, '', ...ticketBodyLines(t), '', `Signed by ${sig.signerName || ''} at ${sig.signedAt || ''}.`, '', settings.company?.name || ''].join('\n'),
          });
          out.copies++;
        }
      }
      // The written notice on a refusal.
      if (t.status === 'refused' && settings.tickets?.noticeOnRefusal !== false && !t.notice && job) {
        const who = await noticeRecipient(tx, job);
        if (email && who) {
          const id = `tnotice-${t.id}`.slice(0, 128);
          if (!(await exists(tx, 'outbox', id))) {
            await queueEmail(tx, records, p, { id, kind: 'ticket_notice', to: who.to, relatedId: t.id,
              subject: `Written notice of extra work: ${label} on ${job.number || job.title || 'your job'}`,
              body: noticeText(t, { job, company: settings.company, kind: 'refusal', zoneTime: (iso) => (iso ? new Date(iso).toLocaleString('en-CA', { timeZone: zone }) : '') }) });
          }
          await records.patchRecord(tx, p, 'fieldTickets', t.id, { notice: { outboxId: id, queuedAt: new Date().toISOString(), to: who.to, kind: 'refusal' } }, {}, systemWho(p));
          out.notices++;
        }
      }
      // A service call: the draft invoice for the office to price.
      if (job?.kind === 'service' && t.status === 'signed' && !t.invoiceId) {
        const id = `svc-${t.id}`.slice(0, 128);
        if (!(await exists(tx, 'invoices', id))) {
          const client = await load(tx, 'clients', job.clientId);
          const items = (await tx.query('SELECT id, data FROM items WHERE tenant_id = $1 AND deleted_at IS NULL', [tenantId])).rows.map(record);
          const equipment = (await tx.query('SELECT id, data FROM equipment WHERE tenant_id = $1 AND deleted_at IS NULL', [tenantId])).rows.map(record);
          const employees = (await tx.query('SELECT id, data FROM employees WHERE tenant_id = $1 AND deleted_at IS NULL', [tenantId])).rows.map(record);
          const today = dayIn(now.toISOString(), zone);
          const terms = Number(client?.credit?.termsDays) >= 0 && client?.credit?.termsDays != null ? Number(client.credit.termsDays) : 14;
          const due = new Date(Date.parse(`${today}T12:00:00Z`) + terms * 86400000).toISOString().slice(0, 10);
          await records.createRecord(tx, p, 'invoices', {
            id, number: await nextInvoiceNumber(tx, records, p, settings), status: 'draft', clientId: job.clientId || null, jobId: job.id, estimateId: null,
            title: `Service call ${label}: ${t.title || ''}`.trim().slice(0, 200), issueDate: today, dueDate: due,
            ...newDocTax(settings, today, { job, client }),
            lines: ticketToInvoiceLines(t, { job, items, equipment, employees, settings }), ticketIds: [t.id], notes: '',
          }, systemWho(p));
          await records.patchRecord(tx, p, 'fieldTickets', t.id, { invoiceId: id }, {}, systemWho(p));
          out.drafts++;
        }
        await notify(tx, { perm: 'invoices', kind: 'service_draft', ref: `service_draft:${t.id}`, link: `#/invoices/${id}`, title: `Price within the hour: service call ${label} signed` });
      }
    }
    return out;
  }, { write: true });
}

/**
 * "Send copy now" (kind copy: to the signer) and "Send as written notice" (kind notice: to the general
 * contractor; an unsigned draft becomes an 'unsigned' notice, a refused ticket a 'refusal' one).
 * Runs in the caller's transaction; needs email on the plan and a connected provider.
 */
export async function sendTicket(db, tx, records, p, who, ticketId, kind) {
  const t = await load(tx, 'field_tickets', ticketId);
  if (!t) throw notFound();
  if (!(await emailReady(db, tx, tx.tenantId))) throw new ApiError(409, 'not_connected', 'Email is not connected on this plan. Print the ticket and hand it over instead.');
  const settings = await loadSettings(tx);
  const job = await load(tx, 'jobs', t.jobId);
  const label = ticketLabel(t);
  const sys = systemPrincipal(tx.tenantId, ACTOR_ID, 'Field tickets');
  const stamp = Date.now().toString(36);
  if (kind === 'copy') {
    const sig = await load(tx, 'signatures', t.signatureId);
    const to = String(sig?.signerEmail || '').trim();
    if (!EMAIL_RE.test(to)) throw new ApiError(422, 'no_address', 'The signer gave no email address. Print the ticket instead.');
    const id = `tcopy-${t.id}-${stamp}`.slice(0, 128);
    await queueEmail(tx, records, sys, { id, kind: 'ticket_copy', to, relatedId: t.id, subject: `Your copy of ${label} from ${settings.company?.name || 'your contractor'}`, body: [...ticketBodyLines(t), '', settings.company?.name || ''].join('\n') });
    await appendAudit(tx, tx.tenantId, { actor: who.actor, action: 'ticket.send_copy', collection: 'fieldTickets', recordId: t.id, summary: label, request: who.request });
    return { outboxId: id, to };
  }
  if (!['draft', 'refused'].includes(t.status)) throw conflict('A written notice is for a refused ticket or one that was never signed.');
  if (!job) throw notFound('The ticket\'s job no longer exists.');
  const rec = await noticeRecipient(tx, job);
  if (!rec) throw new ApiError(422, 'no_address', 'The general contractor has no email address on file. Add it on the client, or print the notice.');
  const noticeKind = t.status === 'refused' ? 'refusal' : 'unsigned';
  const zone = zoneFor(settings.company?.province);
  const id = `tnotice-${t.id}${t.notice ? `-${stamp}` : ''}`.slice(0, 128);
  await queueEmail(tx, records, sys, { id, kind: 'ticket_notice', to: rec.to, relatedId: t.id,
    subject: `Written notice of extra work: ${label} on ${job.number || job.title || 'your job'}`,
    body: noticeText(t, { job, company: settings.company, kind: noticeKind, zoneTime: (iso) => (iso ? new Date(iso).toLocaleString('en-CA', { timeZone: zone }) : '') }) });
  await records.patchRecord(tx, sys, 'fieldTickets', t.id, { notice: { outboxId: id, queuedAt: new Date().toISOString(), to: rec.to, kind: noticeKind } }, {}, systemWho(sys));
  await appendAudit(tx, tx.tenantId, { actor: who.actor, action: 'ticket.send_notice', collection: 'fieldTickets', recordId: t.id, summary: `${label} (${noticeKind})`, request: who.request });
  return { outboxId: id, to: rec.to, kind: noticeKind };
}

// ---- schedule --------------------------------------------------------------------------------------

/** Queue each company's next 15-minute sweep (dedupe tickets_sweep:<tenant>:<slot>). */
export async function scheduleTicketsSweep(db, now = new Date(), { tenantId = null } = {}) {
  const tenants = tenantId
    ? (await db.query("SELECT id FROM tenants WHERE status = 'active' AND id = $1", [tenantId])).rows
    : (await db.query("SELECT id FROM tenants WHERE status = 'active'")).rows;
  const at = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS + SLOT_MS);
  let queued = 0;
  for (const t of tenants) {
    const settings = await db.withTenant({ tenantId: t.id }, (tx) => loadSettings(tx));
    if (!switchOn(settings, 'tickets')) continue;
    const id = await enqueue(db, { kind: SWEEP_KIND, tenantId: t.id, runAt: at, maxAttempts: 2, payload: { tenantId: t.id }, dedupeKey: `${SWEEP_KIND}:${t.id}:${slotKey(at)}` });
    if (id) queued++;
  }
  return { queued };
}

/** Worker handlers (the Lead adds them to src/worker.js). */
export function createTicketHandlers({ config = null, records = null } = {}) {
  const recs = records || createRecords({ validator: createValidator(), config });
  return {
    async [SWEEP_KIND]({ db, job }) {
      const tenantId = job.payload?.tenantId || job.tenant_id;
      try {
        const t = (await db.query('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0];
        if (!t || t.status !== 'active') return { skipped: 'company not active' };
        return await runTicketsSweep(db, tenantId, { records: recs });
      } finally {
        if (tenantId) await scheduleTicketsSweep(db, new Date(), { tenantId }).catch(() => {});
      }
    },
  };
}
