// Receivables on the server (docs/releases/r1-get-paid.md 4.5, 4.7, 4.8, 7.5, 7.6, 10.1;
// docs/office/getting-paid.md). Two worker jobs:
//
//   receivables_daily   once per company per local day at 07:00 in its zone: reminder outbox items
//                       (deterministic ids rem-<invoiceId>-<step>, so a second run never doubles),
//                       credit holds (patched as the system actor `receivables` only when they
//                       change), prompt-payment alarms (ref pp:<invoiceId>:<step>), the substantial-
//                       completion GST notice, billing-cutoff, closeout-due and holdback-due notices.
//   receivables_client  recompute one client's hold: queued after a server-side payment (Stripe, the
//                       QuickBooks pull) and by POST /api/v1/receivables/recheck/:clientId.
//
// Statements are built here from the same library the PWA uses (electrical-app/js/lib/receivables.js).
// Notifications carry no amounts (they go to the invoices permission anyway). Every rule that comes
// from law is read from the rules table (platform rows plus the company's overrides).
import { enqueue } from './queue.js';
import { notify } from './notify.js';
import { loadTenantPlan, tenantHas } from './entitlements.js';
import { createValidator } from '../schemas.js';
import { createRecords } from './records.js';
import { systemPrincipal, systemWho } from '../integrations/state.js';
import { resolveRules } from '../../../electrical-app/js/lib/rules.js';
import { dayIn, zoneFor } from '../../../electrical-app/js/lib/closing.js';
import { formatMoney, docTotals } from '../../../electrical-app/js/lib/money.js';
import { switchOn } from '../../../electrical-app/js/lib/modules.js';
import { jobBillingMode, unbilledTm } from '../../../electrical-app/js/lib/tm.js';
import {
  statement, reminderPlan, reminderText, creditHold, creditExposure, readyToBill, holdbackLedger, plusDays, daysBetween,
} from '../../../electrical-app/js/lib/receivables.js';
import { promptPaymentAlarms } from '../../../electrical-app/js/lib/prompt-payment.js';
import { unbilledContractCents } from '../../../electrical-app/js/lib/closeout.js';

export const DAILY_KIND = 'receivables_daily';
export const CLIENT_KIND = 'receivables_client';
export const DAILY_HOUR = 7;
const ACTOR_ID = 'receivables';

// ---- loading -------------------------------------------------------------------------------------

async function rows(tx, table, where = '', params = []) {
  const { rows: r } = await tx.query(`SELECT id, data FROM ${table} WHERE tenant_id = $1 AND deleted_at IS NULL${where}`, [tx.tenantId, ...params]);
  return r.map((x) => ({ ...x.data, id: x.id }));
}

export async function loadSettings(tx) {
  const { rows: r } = await tx.query("SELECT data FROM settings WHERE tenant_id = $1 AND id = 'settings' AND deleted_at IS NULL", [tx.tenantId]);
  return r[0]?.data || {};
}

/** The rules in force for the company's province today: Fishtape's rows with the company's overrides. */
export async function loadRules(tx, { province, on }) {
  const { rows: platform } = await tx.query(
    "SELECT key, province, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, value, status, source, source_url, note, confirmed_by, confirmed_at FROM platform_rules WHERE province IN ('', $1)", [province || '']);
  const company = await rows(tx, 'rules');
  return resolveRules(platform, company, { province, on });
}

/** Everything the receivables maths reads, in one tenant transaction. */
export async function loadSources(tx) {
  const out = {};
  const tables = { invoices: 'invoices', payments: 'payments', clients: 'clients', jobs: 'jobs', fieldTickets: 'field_tickets', timeEntries: 'time_entries',
    stockMoves: 'stock_moves', materialRequests: 'material_requests', items: 'items', employees: 'employees' };
  for (const [k, table] of Object.entries(tables)) out[k] = await rows(tx, table);
  return out;
}

/** The day each invoice was emailed through Fishtape (the default delivery day, 7.5). */
async function emailedDays(tx, zone) {
  const { rows: r } = await tx.query(
    `SELECT data->>'relatedId' AS id, min(coalesce(data->>'sentAt', data->>'updatedAt')) AS at FROM outbox
      WHERE tenant_id = $1 AND deleted_at IS NULL AND data->>'kind' = 'invoice' AND data->>'status' = 'sent' GROUP BY 1`, [tx.tenantId]);
  return Object.fromEntries(r.filter((x) => x.id && x.at).map((x) => [x.id, dayIn(x.at, zone)]));
}

const companyZone = (settings) => zoneFor(settings?.company?.province);

// ---- the daily run -------------------------------------------------------------------------------

/** Unbilled T&M at sell for a client's jobs (credit exposure). */
function unbilledFor(clientId, s, settings, zone) {
  let cents = 0;
  for (const job of s.jobs) {
    if (job.clientId !== clientId || jobBillingMode(job) !== 'tm' || ['invoiced', 'cancelled'].includes(job.status)) continue;
    cents += unbilledTm({ job, settings, ...s, dayOf: (iso) => dayIn(iso, zone) }).totalCents;
  }
  return cents;
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
export const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;

/** The cutoff day this month, clamped to the month's length. */
function cutoffDay(today, day) {
  const [y, m] = today.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${today.slice(0, 7)}-${String(Math.min(last, Number(day))).padStart(2, '0')}`;
}

/** Recompute holds; patch clients.credit.hold as system:receivables only when it changes. */
async function applyHolds(tx, records, s, settings, today, zone, { clientId = null } = {}) {
  const p = systemPrincipal(tx.tenantId, ACTOR_ID, 'Collections');
  let changed = 0;
  for (const client of s.clients) {
    if (clientId && client.id !== clientId) continue;
    const exposureCents = creditExposure(client, { invoices: s.invoices, payments: s.payments, unbilledTmCents: client.credit?.limitCents != null ? unbilledFor(client.id, s, settings, zone) : 0 });
    const h = creditHold(client, s.invoices, s.payments, settings, today, { exposureCents });
    const cur = client.credit?.hold || null;
    if (Boolean(cur?.on) === h.on && (cur?.reason || null) === (h.on ? h.reason : null)) continue;
    if (!cur && !h.on) continue;
    const hold = h.on
      ? { on: true, reason: h.reason, since: cur?.on ? cur.since || today : today, overdueDays: h.overdueDays, setAt: new Date().toISOString() }
      : { on: false, reason: null, since: null, overdueDays: h.overdueDays, setAt: new Date().toISOString() };
    await records.patchRecord(tx, p, 'clients', client.id, { credit: { ...(client.credit || {}), hold } }, {}, systemWho(p));
    client.credit = { ...(client.credit || {}), hold };
    changed++;
    await notify(tx, {
      perm: 'invoices', kind: 'credit_hold', link: `#/clients/${client.id}`, ref: `credit_hold:${client.id}:${h.on ? 'on' : 'off'}:${today}`,
      title: h.on ? `${client.name || 'A client'} is on hold: ${h.reason === 'over_limit' ? 'over the credit limit' : `past due ${h.overdueDays} days`}` : `${client.name || 'A client'} is off hold`,
      body: h.on ? 'Dispatching their jobs asks for "Dispatch anyway".' : null,
    });
  }
  return changed;
}

/** Which company channels are connected (their required secrets are stored; never opened here). */
export async function channelsReady(tx) {
  const { rows: r } = await tx.query('SELECT name FROM tenant_secrets WHERE tenant_id = $1 AND name = ANY($2)', [tx.tenantId,
    ['resend.api_key', 'resend.from', 'sendgrid.api_key', 'sendgrid.from', 'twilio.account_sid', 'twilio.auth_token', 'twilio.from']]);
  const have = new Set(r.map((x) => x.name));
  return {
    email: ['resend', 'sendgrid'].some((p) => have.has(`${p}.api_key`) && have.has(`${p}.from`)),
    sms: ['twilio.account_sid', 'twilio.auth_token', 'twilio.from'].every((k) => have.has(k)),
  };
}

/** Queue today's reminders (outbox) once each. */
async function queueReminders(tx, records, s, settings, today, plan) {
  const ready = await channelsReady(tx);
  const allowed = { email: tenantHas(plan, 'integrations.email') && ready.email, sms: tenantHas(plan, 'integrations.sms') && ready.sms };
  if (!allowed.email && !allowed.sms) return 0;
  const due = reminderPlan(s.invoices, s.payments, s.clients, settings, today).filter((r) => allowed[r.channel]);
  if (!due.length) return 0;
  const { rows: have } = await tx.query('SELECT id FROM outbox WHERE tenant_id = $1 AND id = ANY($2)', [tx.tenantId, due.map((d) => d.id)]);
  const exists = new Set(have.map((r) => r.id));
  const p = systemPrincipal(tx.tenantId, ACTOR_ID, 'Collections');
  const invById = new Map(s.invoices.map((i) => [i.id, i]));
  const clientById = new Map(s.clients.map((c) => [c.id, c]));
  const money = (c) => formatMoney(c, { currency: settings.currency || 'CAD' });
  let n = 0;
  for (const r of due) {
    if (exists.has(r.id)) continue;
    const invoice = invById.get(r.invoiceId);
    const text = reminderText(r.step, { client: clientById.get(r.clientId), invoice, balanceCents: r.amountCents, company: settings.company, payLink: invoice?.payLink?.url || '', money });
    await records.createRecord(tx, p, 'outbox', {
      id: r.id, channel: r.channel, kind: 'invoice_reminder', to: r.to, subject: text.subject, body: text.body,
      relatedId: r.invoiceId, status: 'queued', dueAt: new Date().toISOString(), step: r.stepKey,
    }, systemWho(p));
    await enqueue(tx, { kind: 'integrations_send', tenantId: tx.tenantId, payload: { outboxId: r.id }, dedupeKey: `integrations_send:${tx.tenantId}:${r.id}`, maxAttempts: 1 });
    n++;
  }
  return n;
}

/**
 * One company's daily run. Safe to run twice: outbox ids and notification refs are deterministic,
 * and a hold is written only when it changes.
 * @returns {Promise<{ reminders: number, holds: number, alarms: number, notices: number }>}
 */
export async function runReceivablesDaily(db, tenantId, { records, now = new Date() } = {}) {
  const plan = await loadTenantPlan(db, tenantId);
  if (!plan || !tenantHas(plan, 'invoices', now)) return { skipped: 'not in plan' };
  return db.withTenant({ tenantId }, async (tx) => {
    const settings = await loadSettings(tx);
    if (!switchOn(settings, 'invoices')) return { skipped: 'invoices turned off' };
    const zone = companyZone(settings);
    const today = dayIn(now.toISOString(), zone);
    const province = settings.company?.province || null;
    const s = await loadSources(tx);
    const out = { reminders: 0, holds: 0, alarms: 0, notices: 0 };
    out.reminders = await queueReminders(tx, records, s, settings, today, plan);
    out.holds = await applyHolds(tx, records, s, settings, today, zone);
    if (settings.promptPayment?.enabled !== false) {
      const rules = await loadRules(tx, { province: province || 'MB', on: today });
      const alarms = promptPaymentAlarms(s.invoices, s.jobs, s.payments, rules, today, { companyProvince: province, emailedOn: await emailedDays(tx, zone) });
      for (const a of alarms) {
        out.alarms += await notify(tx, { perm: 'invoices', kind: 'prompt_payment', title: a.title, link: `#/invoices/${a.invoiceId}`, ref: a.ref }) ? 1 : 0;
      }
    }
    out.notices += await jobNotices(tx, s, settings, today, zone);
    return out;
  }, { write: true });
}

/** GST at substantial completion, billing cutoff, closeout due and holdback due (each once by ref). */
async function jobNotices(tx, s, settings, today, zone) {
  let n = 0;
  const ready = readyToBill({ ...s, settings, dayOf: (iso) => dayIn(iso, zone) }, { asOf: today });
  const remind = Number(settings.closeout?.remindAfterDays) > 0 ? Number(settings.closeout.remindAfterDays) : 14;
  const noticeDays = Number.isFinite(Number(settings.collections?.cutoffNoticeDays)) && settings.collections?.cutoffNoticeDays !== null ? Number(settings.collections.cutoffNoticeDays) : 3;
  for (const job of s.jobs) {
    if (['cancelled', 'lead'].includes(job.status)) continue;
    const c = job.contract || {};
    const label = `${job.number || 'A job'}${job.title ? ` ${job.title}` : ''}`;
    if (c.substantialPerformanceOn && c.substantialPerformanceOn <= today) {
      const left = unbilledContractCents(job, s.invoices);
      if (left != null && left > 0) n += await notify(tx, { perm: 'invoices', kind: 'gst_due', ref: `gst:${job.id}`, link: `#/jobs/${job.id}?tab=money`, title: `${label}: substantial performance is recorded and contract value is unbilled`, body: 'GST may be due now (Excise Tax Act s.168(3)(c)). Ask your accountant.' }) ? 1 : 0;
    }
    if (Number.isInteger(c.billingCutoffDay) && job.status !== 'invoiced') {
      const cut = cutoffDay(today, c.billingCutoffDay);
      const d = daysBetween(today, cut);
      if (d >= 0 && d <= noticeDays) {
        const items = ready.filter((r) => r.jobId === job.id).length;
        n += await notify(tx, { perm: 'invoices', kind: 'billing_cutoff', ref: `cutoff:${job.id}:${today.slice(0, 7)}`, link: '#/invoices/ready',
          title: `${job.number || 'A job'}: GC billing cutoff on the ${ordinal(Number(cut.slice(8)))}; ${items} item${items === 1 ? '' : 's'} ready to bill` }) ? 1 : 0;
      }
    }
    if (job.status === 'complete') {
      const done = c.completedOn || String(job.updatedAt || '').slice(0, 10);
      if (done && daysBetween(done, today) >= remind) {
        n += await notify(tx, { perm: 'invoices', kind: 'closeout_due', ref: `closeout:${job.id}`, link: `#/jobs/${job.id}`, title: `${job.number || 'A job'} complete ${daysBetween(done, today)} days, not closed out` }) ? 1 : 0;
      }
    }
    if (c.holdbackReleaseOn && c.holdbackReleaseOn <= today && holdbackLedger(s.invoices, { jobId: job.id }).outstandingCents > 0) {
      n += await notify(tx, { perm: 'invoices', kind: 'holdback_due', ref: `holdback_due:${job.id}`, link: `#/jobs/${job.id}?tab=money`, title: `${label}: the holdback release date is here. Invoice the holdback release.` }) ? 1 : 0;
    }
  }
  return n;
}

/** Recompute one client's hold (after a payment). */
export async function recheckClient(db, tenantId, clientId, { records, now = new Date() } = {}) {
  return db.withTenant({ tenantId }, async (tx) => {
    const settings = await loadSettings(tx);
    const zone = companyZone(settings);
    const s = await loadSources(tx);
    if (!s.clients.some((c) => c.id === clientId)) return { skipped: 'no such client' };
    return { changed: await applyHolds(tx, records, s, settings, dayIn(now.toISOString(), zone), zone, { clientId }) };
  }, { write: true });
}

/**
 * After a payment the server recorded (Stripe, the QuickBooks pull): recompute the client's hold
 * (deduplicated per client while one is waiting). Call it inside the payment's transaction.
 */
export async function queueClientRecheck(tx, clientId) {
  if (!clientId) return null;
  // A payment only ever lifts a hold, never raises one, so only a client on hold needs the recheck.
  const { rows } = await tx.query(
    "SELECT 1 FROM clients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND (data->'credit'->'hold'->>'on') = 'true'", [tx.tenantId, clientId]);
  if (!rows[0]) return null;
  return enqueue(tx, { kind: CLIENT_KIND, tenantId: tx.tenantId, payload: { clientId }, dedupeKey: `${CLIENT_KIND}:${tx.tenantId}:${clientId}`, maxAttempts: 3 });
}

/** The client of an invoice (for callers that only have the invoice id). */
export async function invoiceClientId(tx, invoiceId) {
  const { rows: r } = await tx.query('SELECT data->>\'clientId\' AS c FROM invoices WHERE tenant_id = $1 AND id = $2', [tx.tenantId, invoiceId]);
  return r[0]?.c || null;
}

// ---- schedule --------------------------------------------------------------------------------------

/** The instant a local wall-clock time happens in a zone (two passes over the zone's offset). */
export function zonedInstant(day, hour, zone) {
  const [y, m, d] = day.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d, hour);
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    t += Date.UTC(y, m - 1, d, hour) - asUtc;
  }
  return new Date(t);
}

/** The next 07:00 in the zone strictly after now: { day, at }. */
export function nextDailyRun(now, zone, hour = DAILY_HOUR) {
  const today = dayIn(now.toISOString(), zone);
  const at = zonedInstant(today, hour, zone);
  if (at > now) return { day: today, at };
  const tomorrow = plusDays(today, 1);
  return { day: tomorrow, at: zonedInstant(tomorrow, hour, zone) };
}

/**
 * Queue each active company's next daily run at 07:00 in its zone (dedupe receivables_daily:<tenant>:<day>).
 * The worker calls it hourly and after each run.
 */
export async function scheduleReceivablesDaily(db, now = new Date(), { tenantId = null } = {}) {
  const tenants = tenantId
    ? (await db.query("SELECT id FROM tenants WHERE status = 'active' AND id = $1", [tenantId])).rows
    : (await db.query("SELECT id FROM tenants WHERE status = 'active'")).rows;
  let queued = 0;
  for (const t of tenants) {
    const settings = await db.withTenant({ tenantId: t.id }, (tx) => loadSettings(tx));
    const next = nextDailyRun(now, companyZone(settings));
    const id = await enqueue(db, { kind: DAILY_KIND, tenantId: t.id, runAt: next.at, maxAttempts: 3, payload: { tenantId: t.id, day: next.day }, dedupeKey: `${DAILY_KIND}:${t.id}:${next.day}` });
    if (id) queued++;
  }
  return { queued };
}

/** Worker handlers (the Lead adds them to src/worker.js). */
export function createReceivablesHandlers({ config = null, records = null } = {}) {
  const recs = records || createRecords({ validator: createValidator(), config });
  return {
    async [DAILY_KIND]({ db, job }) {
      const tenantId = job.payload?.tenantId || job.tenant_id;
      try {
        const t = (await db.query('SELECT status FROM tenants WHERE id = $1', [tenantId])).rows[0];
        if (!t || t.status !== 'active') return { skipped: 'company not active' };
        return await runReceivablesDaily(db, tenantId, { records: recs });
      } finally {
        if (tenantId) await scheduleReceivablesDaily(db, new Date(Date.now() + 60_000), { tenantId }).catch(() => {});
      }
    },
    async [CLIENT_KIND]({ db, job }) {
      const tenantId = job.tenant_id || job.payload?.tenantId;
      const clientId = job.payload?.clientId;
      if (!tenantId || typeof clientId !== 'string') return { skipped: true };
      return recheckClient(db, tenantId, clientId, { records: recs });
    },
  };
}

// ---- statements ------------------------------------------------------------------------------------

/** A client's statement (lib/receivables.js statement) with names and the company, no tenant-external data. */
export async function statementFor(tx, clientId, { from, to }) {
  const settings = await loadSettings(tx);
  const zone = companyZone(settings);
  const asOf = to || dayIn(new Date().toISOString(), zone);
  const start = from || plusDays(asOf, -90);
  const { rows: c } = await tx.query('SELECT id, data FROM clients WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [tx.tenantId, clientId]);
  if (!c[0]) return null;
  const client = { ...c[0].data, id: c[0].id };
  const invoices = await rows(tx, 'invoices', " AND data->>'clientId' = $2", [clientId]);
  const invIds = invoices.map((i) => i.id);
  const { rows: pr } = await tx.query(
    `SELECT id, data FROM payments WHERE tenant_id = $1 AND deleted_at IS NULL AND (data->>'clientId' = $2 OR data->>'invoiceId' = ANY($3))`, [tx.tenantId, clientId, invIds]);
  const payments = pr.map((x) => ({ ...x.data, id: x.id }));
  const st = statement(clientId, { from: start, to: asOf, invoices, payments, asOf });
  return { client, company: settings.company || {}, currency: settings.currency || 'CAD', statement: st };
}

/** The statement as plain text (the email body; the outbox sends it as simple HTML). */
export function statementText({ client, company, currency, statement: st }) {
  const m = (c) => formatMoney(c, { currency });
  const lines = [
    `Statement for ${client.name || 'your account'}`, `${st.from} to ${st.to}`, '',
    `Opening balance: ${m(st.openingCents)}`, '',
    ...st.rows.map((r) => `${r.date || ''}  ${r.type.replace('-', ' ')} ${r.number || ''}  ${r.chargeCents ? m(r.chargeCents) : ''}${r.creditCents ? `-${m(r.creditCents)}` : ''}  balance ${m(r.balanceCents)}`.replace(/\s+/g, ' ')),
    '', `Balance: ${m(st.closingCents)}`, '',
    `Current ${m(st.aging.current)} · 1-30 days ${m(st.aging.d30)} · 31-60 ${m(st.aging.d60)} · 61-90 ${m(st.aging.d90)} · over 90 ${m(st.aging.d90p)}`,
    st.holdbackRetainedCents ? `Holdback you retained (owed at release): ${m(st.holdbackRetainedCents)}` : null,
    st.disputedCents ? `Amounts in dispute: ${m(st.disputedCents)}` : null,
    st.onAccountCents ? `On account (unapplied): ${m(st.onAccountCents)}` : null,
    st.creditsCents ? `Credit notes not yet applied: ${m(st.creditsCents)}` : null,
    st.depositsUnappliedCents ? `Deposits held: ${m(st.depositsUnappliedCents)}` : null,
    '', company?.phone ? `Questions? Reply to this email or call ${company.phone}.` : 'Questions? Reply to this email.', company?.name || '',
  ];
  return lines.filter((x) => x !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The statement as an HTML page (GET /api/v1/statements/:clientId?format=html; printing). */
export function statementHtml(data) {
  const { client, company, currency, statement: st } = data;
  const m = (c) => esc(formatMoney(c, { currency }));
  const rowsHtml = st.rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.type.replace('-', ' '))}</td><td>${esc(r.number)}</td><td class="n">${r.chargeCents ? m(r.chargeCents) : ''}</td><td class="n">${r.creditCents ? m(r.creditCents) : ''}</td><td class="n">${m(r.balanceCents)}</td></tr>`).join('');
  const extra = [['Holdback you retained', st.holdbackRetainedCents], ['In dispute', st.disputedCents], ['On account', st.onAccountCents], ['Credit notes not applied', st.creditsCents], ['Deposits held', st.depositsUnappliedCents]]
    .filter(([, v]) => v).map(([k, v]) => `<p>${esc(k)}: ${m(v)}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Statement ${esc(client.name)}</title></head><body>
<h1>${esc(company?.name || '')}</h1><h2>Statement for ${esc(client.name)}</h2><p>${esc(st.from)} to ${esc(st.to)}</p>
<p>Opening balance: ${m(st.openingCents)}</p>
<table><thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Charges</th><th>Credits</th><th>Balance</th></tr></thead><tbody>${rowsHtml}</tbody></table>
<p><strong>Balance: ${m(st.closingCents)}</strong></p>
<p>Current ${m(st.aging.current)} · 1-30 ${m(st.aging.d30)} · 31-60 ${m(st.aging.d60)} · 61-90 ${m(st.aging.d90)} · over 90 ${m(st.aging.d90p)}</p>${extra}
</body></html>`;
}

/** Totals for a list of invoices (used by the routes' summaries). */
export const totalCentsOf = (invoices) => invoices.reduce((s, i) => s + docTotals(i).totalCents, 0);
