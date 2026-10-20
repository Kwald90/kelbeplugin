// Fishtape's finances for HQ, from Fishtape's subscriptions on the Stripe account in
// STRIPE_SECRET_KEY (Kelvin's existing True Collar Built account) plus the database.
//
// The account is shared with True Collar Built's own business, so only Fishtape objects
// count: customers that belong to a company (tenants.stripe_customer_id, or a sign-up), and
// subscriptions whose prices carry a fishtape_* lookup key or our metadata. Invoice actions
// (resend, mark uncollectible, credit note, refund) refuse any invoice that is not a
// Fishtape company's.
//
// The summary (MRR, plans, trials, churn, deposits, revenue by month, refunds, renewals,
// failed payments, tax) is computed by computeFinance(), a pure function, and cached in
// finance_snapshots by the worker (hq_finance_refresh, hourly) so the HQ page opens fast.
// The Stripe client is injected (config.billing.stripe) so tests never touch the network.
import { ApiError, conflict, notFound } from '../errors.js';
import { PLANS } from '../../../electrical-app/js/plans.js';
import { planFromSubscription, createBilling } from './billing.js';
import { DEPOSIT_LOOKUP_KEY } from './signup.js';
import { enqueue } from './queue.js';

const DAY = 86_400_000;
export const SNAPSHOT_KEY = 'summary';
export const STALE_AFTER_MS = 2 * 3600_000;
const LIVE = ['active', 'past_due'];

const cid = (x) => (typeof x === 'string' ? x : x?.id || null);
const toMs = (secs) => (Number.isFinite(secs) ? secs * 1000 : null);
const isoS = (secs) => (Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : null);
const month = (ms) => new Date(ms).toISOString().slice(0, 7);

/** Page through any Stripe list call (works with the real SDK and simple fakes). */
export async function listAll(list, params = {}, max = 5000) {
  const out = [];
  let after = null;
  for (;;) {
    const page = await list({ ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
    const data = page?.data || [];
    out.push(...data);
    if (!page?.has_more || !data.length || out.length >= max) break;
    after = data[data.length - 1].id;
  }
  return out;
}

/** Lookup key of a subscription item or invoice line, whichever API shape Stripe sent. */
const lookupOf = (x) => x?.price?.lookup_key || x?.pricing?.price_details?.price?.lookup_key || null;
const isFishtapeKey = (k) => typeof k === 'string' && k.startsWith('fishtape_');

export function isFishtapeSubscription(sub, customers) {
  if (customers.has(cid(sub.customer))) return true;
  if (sub.metadata?.tenant_id || sub.metadata?.fishtape_signup_id) return true;
  return (sub.items?.data || []).some((it) => isFishtapeKey(lookupOf(it)));
}

export function isFishtapeInvoice(inv, customers) {
  if (customers.has(cid(inv.customer))) return true;
  return (inv.lines?.data || []).some((l) => isFishtapeKey(lookupOf(l)));
}

/** Monthly amount of one subscription in cents (list prices; discounts and credits not taken off). */
export function subscriptionMonthlyCents(sub) {
  let total = 0;
  for (const it of sub.items?.data || []) {
    const p = it.price || {};
    const r = p.recurring;
    if (!r || !Number.isFinite(p.unit_amount)) continue;
    const n = Math.max(1, r.interval_count || 1);
    const perMonth = { month: 1 / n, year: 1 / (12 * n), week: 52 / (12 * n), day: 365 / (12 * n) }[r.interval] ?? 0;
    total += p.unit_amount * (it.quantity ?? 1) * perMonth;
  }
  return Math.round(total);
}

const periodEnd = (sub) => sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null;
export const invoiceSubscription = (inv) => cid(inv.subscription) || cid(inv.parent?.subscription_details?.subscription) || null;

/** Tax on an invoice, from whichever field Stripe filled; null when there is no tax data. */
export function invoiceTax(inv) {
  if (Array.isArray(inv.total_taxes)) return inv.total_taxes.reduce((a, t) => a + (t.amount || 0), 0);
  if (Number.isFinite(inv.tax)) return inv.tax;
  if (Array.isArray(inv.total_tax_amounts)) return inv.total_tax_amounts.reduce((a, t) => a + (t.amount || 0), 0);
  return null;
}

/**
 * Everything the finance page shows, from Stripe objects and database rows.
 * @param {{ subscriptions: object[], invoices: object[], refunds: object[], tenants: object[], signups: object[], failedEvents30d: number, now?: Date }} d
 *   tenants: { id, stripe_customer_id, plan, trial_ends_at, billing_status, created_at }
 *   signups: { status, deposit_paid_cents, deposit_paid_at, credited_at, tenant_id }
 */
export function computeFinance(d) {
  const now = (d.now || new Date()).getTime();
  const tenantOf = new Map(d.tenants.filter((t) => t.stripe_customer_id).map((t) => [t.stripe_customer_id, t.id]));
  const tenantFor = (x) => tenantOf.get(cid(x.customer)) || x.metadata?.tenant_id || null;
  const subs = d.subscriptions;

  // MRR and plans
  const byPlan = {};
  let mrr = 0;
  let otherCurrency = 0;
  for (const s of subs) {
    const plan = planFromSubscription(s) || 'unknown';
    const row = (byPlan[plan] ||= { plan, name: PLANS[plan]?.name || plan, active: 0, trialing: 0, pastDue: 0, mrrCents: 0 });
    const cents = subscriptionMonthlyCents(s);
    if (s.currency && s.currency !== 'cad' && LIVE.includes(s.status)) { otherCurrency++; continue; }
    if (s.status === 'active') row.active++;
    if (s.status === 'past_due') row.pastDue++;
    if (s.status === 'trialing') row.trialing++;
    if (LIVE.includes(s.status)) { row.mrrCents += cents; mrr += cents; }
  }

  // trials (Stripe trialing subscriptions and HQ-made trials without a card)
  const paying = new Set(subs.filter((s) => LIVE.includes(s.status)).map(tenantFor).filter(Boolean));
  for (const t of d.tenants) if (LIVE.includes(t.billing_status)) paying.add(t.id);
  const onTrial = d.tenants.filter((t) => (t.plan === 'trial' && (!t.trial_ends_at || new Date(t.trial_ends_at).getTime() > now)) || t.billing_status === 'trialing');
  const endingSoon = onTrial.filter((t) => t.trial_ends_at && new Date(t.trial_ends_at).getTime() - now < 7 * DAY && new Date(t.trial_ends_at).getTime() > now);
  const cohort = d.tenants.filter((t) => t.trial_ends_at && new Date(t.trial_ends_at).getTime() <= now && new Date(t.trial_ends_at).getTime() > now - 90 * DAY);
  const converted = cohort.filter((t) => paying.has(t.id));

  // churn (last 30 days): cancellations over subscriptions live 30 days ago
  const since = now - 30 * DAY;
  const endedAt = (s) => toMs(s.canceled_at ?? s.ended_at);
  const churned = subs.filter((s) => s.status === 'canceled' && endedAt(s) && endedAt(s) >= since);
  const base = subs.filter((s) => !['incomplete', 'incomplete_expired'].includes(s.status) && toMs(s.created) < since
    && !(endedAt(s) && endedAt(s) < since) && !(toMs(s.trial_end) && toMs(s.trial_end) > since));
  const lostMrr = churned.reduce((a, s) => a + subscriptionMonthlyCents(s), 0);

  // revenue, refunds and tax by month (last 12 months, oldest first)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const dt = new Date(now);
    months.push(new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  }
  const rev = Object.fromEntries(months.map((m) => [m, { month: m, grossCents: 0, refundsCents: 0, netCents: 0, taxCents: 0, invoices: 0, depositsCents: 0 }]));
  let taxSeen = false;
  for (const inv of d.invoices) {
    if (inv.status !== 'paid' || !(inv.amount_paid > 0)) continue;
    const r = rev[month(toMs(inv.status_transitions?.paid_at) ?? toMs(inv.created))];
    if (!r) continue;
    r.grossCents += inv.amount_paid;
    r.invoices++;
    const tax = invoiceTax(inv);
    if (tax != null && (tax > 0 || inv.automatic_tax?.enabled)) taxSeen = true;
    if (tax) r.taxCents += tax;
  }
  if (d.invoices.some((i) => i.automatic_tax?.enabled)) taxSeen = true;
  const refunds = d.refunds.filter((r) => r.status !== 'failed' && r.status !== 'canceled');
  for (const rf of refunds) {
    const r = rev[month(toMs(rf.created))];
    if (r) r.refundsCents += rf.amount || 0;
  }
  for (const s of d.signups) {
    if (!s.deposit_paid_at || !s.deposit_paid_cents) continue;
    const r = rev[month(new Date(s.deposit_paid_at).getTime())];
    if (r) r.depositsCents += s.deposit_paid_cents;
  }
  for (const r of Object.values(rev)) r.netCents = r.grossCents - r.refundsCents;

  // $1 deposits (sign-ups)
  const deps = d.signups.filter((s) => s.deposit_paid_at);
  const deposits = {
    count: deps.length,
    totalCents: deps.reduce((a, s) => a + (s.deposit_paid_cents || 0), 0),
    last30Days: deps.filter((s) => new Date(s.deposit_paid_at).getTime() >= since).length,
    credited: deps.filter((s) => s.credited_at).length,
    toRefund: deps.filter((s) => s.status === 'failed').length,
    becamePaying: deps.filter((s) => s.tenant_id && paying.has(s.tenant_id)).length,
  };

  // renewals in the next 14 days, failed payments
  const renewals = subs
    .filter((s) => ['active', 'trialing', 'past_due'].includes(s.status) && !s.cancel_at_period_end && periodEnd(s) && toMs(periodEnd(s)) > now && toMs(periodEnd(s)) - now < 14 * DAY)
    .sort((a, b) => periodEnd(a) - periodEnd(b))
    .map((s) => ({ tenantId: tenantFor(s), plan: planFromSubscription(s), status: s.status, amountCents: subscriptionMonthlyCents(s), at: isoS(periodEnd(s)), firstCharge: s.status === 'trialing' }));
  const failing = d.invoices
    .filter((i) => i.status === 'open' && (i.attempt_count || 0) > 0 && i.amount_remaining > 0)
    .map((i) => ({ invoiceId: i.id, number: i.number || null, tenantId: tenantFor(i), amountCents: i.amount_remaining, attempts: i.attempt_count, nextAttemptAt: isoS(i.next_payment_attempt), createdAt: isoS(i.created) }))
    .sort((a, b) => b.amountCents - a.amountCents);

  const recentRefunds = refunds.sort((a, b) => b.created - a.created).slice(0, 20)
    .map((r) => ({ id: r.id, amountCents: r.amount, at: isoS(r.created), tenantId: tenantOf.get(cid(r.charge?.customer)) || r.metadata?.fishtape_tenant || null, reason: r.reason || null, status: r.status }));

  const revenue = months.map((m) => rev[m]);
  const last = revenue[revenue.length - 1];
  return {
    currency: 'CAD',
    mrrCents: mrr,
    arrCents: mrr * 12,
    otherCurrencySubscriptions: otherCurrency,
    subscriptions: { active: subs.filter((s) => s.status === 'active').length, pastDue: subs.filter((s) => s.status === 'past_due').length, trialing: subs.filter((s) => s.status === 'trialing').length, byPlan: Object.values(byPlan).sort((a, b) => b.mrrCents - a.mrrCents) },
    trials: { active: onTrial.length, endingIn7Days: endingSoon.length, endedLast90Days: cohort.length, converted: converted.length, conversionPct: cohort.length ? Math.round((converted.length / cohort.length) * 1000) / 10 : null },
    churn: { canceledLast30Days: churned.length, baseSubscriptions: base.length, ratePct: base.length ? Math.round((churned.length / base.length) * 1000) / 10 : null, lostMrrCents: lostMrr },
    deposits,
    revenue,
    thisMonth: { grossCents: last.grossCents, refundsCents: last.refundsCents, netCents: last.netCents },
    refunds: { last30DaysCents: refunds.filter((r) => toMs(r.created) >= since).reduce((a, r) => a + (r.amount || 0), 0), count: refunds.length, recent: recentRefunds },
    renewals,
    failedPayments: { open: failing, eventsLast30Days: d.failedEvents30d ?? 0 },
    tax: {
      present: taxSeen,
      collectedLast12MonthsCents: revenue.reduce((a, r) => a + r.taxCents, 0),
      note: taxSeen ? 'GST/HST from Stripe Tax on Fishtape invoices.' : 'No tax on Fishtape invoices: Stripe Tax is not turned on for these prices, so no GST/HST is being collected. Fishtape needs its own GST/HST registration first (see BACKLOG).',
    },
  };
}

// ---- CSV ---------------------------------------------------------------------------

/** One CSV cell: quoted when needed, and a leading = + - @ neutralised (spreadsheet formulas). */
export function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));

export function financeCsv(kind, data, names = new Map()) {
  const name = (id) => (id ? names.get(id) || id : '');
  switch (kind) {
    case 'revenue':
      return toCsv(['month', 'gross_cad', 'refunds_cad', 'net_cad', 'tax_cad', 'deposits_cad', 'paid_invoices'],
        data.revenue.map((r) => [r.month, dollars(r.grossCents), dollars(r.refundsCents), dollars(r.netCents), dollars(r.taxCents), dollars(r.depositsCents), r.invoices]));
    case 'plans':
      return toCsv(['plan', 'active', 'past_due', 'trialing', 'mrr_cad'], data.subscriptions.byPlan.map((p) => [p.name, p.active, p.pastDue, p.trialing, dollars(p.mrrCents)]));
    case 'renewals':
      return toCsv(['company', 'plan', 'status', 'amount_cad', 'renews_at'], data.renewals.map((r) => [name(r.tenantId), r.plan || '', r.status, dollars(r.amountCents), r.at]));
    case 'failed':
      return toCsv(['company', 'invoice', 'amount_due_cad', 'attempts', 'next_attempt_at'], data.failedPayments.open.map((f) => [name(f.tenantId), f.number || f.invoiceId, dollars(f.amountCents), f.attempts, f.nextAttemptAt || '']));
    default:
      throw new ApiError(400, 'bad_request', 'Unknown export.');
  }
}

// ---- service ------------------------------------------------------------------------

export function invoiceView(inv, tenantId, tenantName) {
  const credited = (inv.pre_payment_credit_notes_amount || 0) + (inv.post_payment_credit_notes_amount || 0);
  return {
    id: inv.id, number: inv.number || null, tenantId, tenantName: tenantName || null, status: inv.status,
    createdAt: isoS(inv.created), dueAt: isoS(inv.due_date), paidAt: isoS(inv.status_transitions?.paid_at),
    totalCents: inv.total ?? null, amountDueCents: inv.amount_due ?? null, amountPaidCents: inv.amount_paid ?? null, amountRemainingCents: inv.amount_remaining ?? null,
    taxCents: invoiceTax(inv), creditedCents: credited, currency: String(inv.currency || 'cad').toUpperCase(), attempts: inv.attempt_count || 0,
    billingReason: inv.billing_reason || null, hostedInvoiceUrl: inv.hosted_invoice_url || null, pdfUrl: inv.invoice_pdf || null,
    deposit: (inv.lines?.data || []).some((l) => lookupOf(l) === DEPOSIT_LOOKUP_KEY),
  };
}

/**
 * @param {{ config: object, db: import('../db.js').Db, stripe?: object|null }} deps
 */
export function createFinance({ config, db, stripe }) {
  const client = stripe !== undefined ? stripe : createBilling({ config, db }).stripe;
  const need = () => {
    if (!client) throw new ApiError(503, 'billing_unavailable', 'STRIPE_SECRET_KEY is not set, so there is no Stripe data.');
    return client;
  };

  /** Company rows and their Stripe customers (app role: platform tables only). */
  async function companies(q = db) {
    const tenants = (await q.query('SELECT id, name, stripe_customer_id, plan, trial_ends_at, billing_status, created_at FROM tenants')).rows;
    return { tenants, customers: new Set(tenants.map((t) => t.stripe_customer_id).filter(Boolean)), names: new Map(tenants.map((t) => [t.id, t.name])) };
  }

  /** Pull from Stripe, compute, store. Runs as the app role (worker or HQ "Refresh"). */
  async function refresh({ now = new Date() } = {}) {
    const s = need();
    const started = Date.now();
    const { tenants, customers } = await companies();
    const signups = (await db.query(
      "SELECT status, deposit_paid_cents, deposit_paid_at, credited_at, tenant_id, stripe_customer_id FROM signups WHERE deposit_paid_at IS NOT NULL")).rows;
    for (const su of signups) if (su.stripe_customer_id) customers.add(su.stripe_customer_id);
    const since = Math.floor((now.getTime() - 400 * DAY) / 1000);
    try {
      const [allSubs, allInvoices, allRefunds] = await Promise.all([
        listAll((p) => s.subscriptions.list(p), { status: 'all', expand: ['data.items.data.price'] }),
        listAll((p) => s.invoices.list(p), { created: { gte: since } }),
        listAll((p) => s.refunds.list(p), { created: { gte: since }, expand: ['data.charge'] }),
      ]);
      const subscriptions = allSubs.filter((x) => isFishtapeSubscription(x, customers));
      const invoices = allInvoices.filter((x) => isFishtapeInvoice(x, customers));
      const refunds = allRefunds.filter((r) => customers.has(cid(r.charge?.customer)) || r.metadata?.fishtape_invoice);
      const failed = (await db.query("SELECT count(*)::int AS n FROM billing_events WHERE type = 'invoice.payment_failed' AND received_at > now() - interval '30 days'")).rows[0].n;
      const data = computeFinance({ subscriptions, invoices, refunds, tenants, signups, failedEvents30d: failed, now });
      data.scanned = { subscriptions: allSubs.length, invoices: allInvoices.length, refunds: allRefunds.length, fishtapeInvoices: invoices.length };
      await save(data, Date.now() - started, null);
      return data;
    } catch (e) {
      const msg = String(e?.message || 'refresh failed').replace(/(sk|rk)_[A-Za-z0-9_]+/g, '[redacted]').slice(0, 300);
      await save(null, Date.now() - started, msg);
      throw new ApiError(502, 'stripe_error', `Stripe did not answer: ${msg}`);
    }
  }

  async function save(data, ms, error) {
    await db.query(
      `INSERT INTO finance_snapshots (key, data, refreshed_at, duration_ms, error) VALUES ($1, COALESCE($2::jsonb, '{}'::jsonb), now(), $3, $4)
       ON CONFLICT (key) DO UPDATE SET data = CASE WHEN $2::jsonb IS NULL THEN finance_snapshots.data ELSE EXCLUDED.data END,
         refreshed_at = CASE WHEN $2::jsonb IS NULL THEN finance_snapshots.refreshed_at ELSE now() END, duration_ms = EXCLUDED.duration_ms, error = EXCLUDED.error`,
      [SNAPSHOT_KEY, data ? JSON.stringify(data) : null, ms, error]);
  }

  async function snapshot(q = db) {
    const r = (await q.query('SELECT data, refreshed_at, duration_ms, error FROM finance_snapshots WHERE key = $1', [SNAPSHOT_KEY])).rows[0];
    if (!r || !r.data?.revenue) return { data: null, refreshedAt: null, error: r?.error || null, stale: true };
    return { data: r.data, refreshedAt: new Date(r.refreshed_at).toISOString(), durationMs: r.duration_ms, error: r.error, stale: Date.now() - new Date(r.refreshed_at).getTime() > STALE_AFTER_MS };
  }

  // ---- invoices ------------------------------------------------------------------

  /**
   * Live list from Stripe. tenantId narrows to one company; otherwise recent invoices of
   * every Fishtape customer (True Collar Built's own invoices are skipped).
   */
  async function listInvoices({ tenantId = null, status = null, from = null, to = null, limit = 50 } = {}) {
    const s = need();
    const { tenants, customers, names } = await companies();
    const created = {};
    if (from) created.gte = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
    if (to) created.lte = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);
    const params = { ...(status ? { status } : {}), ...(Object.keys(created).length ? { created } : {}) };
    let rows;
    if (tenantId) {
      const t = tenants.find((x) => x.id === tenantId);
      if (!t?.stripe_customer_id) return { data: [], scanned: 0 };
      rows = await listAll((p) => s.invoices.list(p), { ...params, customer: t.stripe_customer_id }, limit);
    } else {
      const all = await listAll((p) => s.invoices.list(p), params, 1000);
      rows = all.filter((i) => customers.has(cid(i.customer)));
      rows.scanned = all.length;
    }
    const byCustomer = new Map(tenants.filter((t) => t.stripe_customer_id).map((t) => [t.stripe_customer_id, t.id]));
    return {
      data: rows.slice(0, limit).map((i) => { const tid = byCustomer.get(cid(i.customer)) || null; return invoiceView(i, tid, names.get(tid)); }),
      scanned: rows.scanned ?? rows.length,
    };
  }

  /** A Fishtape company's invoice, or 404 (never another business's invoice on the account). */
  async function fishtapeInvoice(id) {
    const s = need();
    let inv;
    try { inv = await s.invoices.retrieve(id); } catch (e) {
      if (e?.statusCode === 404 || e?.code === 'resource_missing') throw notFound('No such invoice.');
      throw e;
    }
    const t = (await db.query('SELECT id, name FROM tenants WHERE stripe_customer_id = $1', [cid(inv.customer)])).rows[0];
    if (!t) throw notFound('No such Fishtape invoice. Only invoices of Fishtape companies can be changed here.');
    return { inv, tenant: t };
  }

  async function resend(id) {
    const { inv, tenant } = await fishtapeInvoice(id);
    if (!['open', 'paid'].includes(inv.status)) throw conflict(`A ${inv.status} invoice cannot be sent.`);
    await need().invoices.sendInvoice(inv.id);
    return { inv, tenant };
  }

  async function markUncollectible(id) {
    const { inv, tenant } = await fishtapeInvoice(id);
    if (inv.status !== 'open') throw conflict('Only an open (unpaid) invoice can be marked uncollectible.');
    const out = await need().invoices.markUncollectible(inv.id);
    return { inv: out, tenant };
  }

  /** Most that can still be credited. */
  function creditable(inv) {
    if (inv.status === 'open') return Math.max(0, inv.amount_remaining ?? 0);
    if (inv.status === 'paid') return Math.max(0, (inv.amount_paid ?? 0) - (inv.post_payment_credit_notes_amount || 0));
    return 0;
  }

  async function creditNote(id, { amountCents, reason, stripeReason, requestKey }) {
    const { inv, tenant } = await fishtapeInvoice(id);
    if (!['open', 'paid'].includes(inv.status)) throw conflict(`A ${inv.status} invoice cannot be credited.`);
    const max = creditable(inv);
    if (amountCents > max) throw new ApiError(400, 'amount_too_large', `At most ${(max / 100).toFixed(2)} can be credited on this invoice.`, { maxCents: max });
    const params = {
      invoice: inv.id, amount: amountCents, memo: reason.slice(0, 500), ...(stripeReason ? { reason: stripeReason } : {}),
      // Paid: the credit goes on the customer's balance and comes off the next invoice.
      ...(inv.status === 'paid' ? { credit_amount: amountCents } : {}),
      metadata: { fishtape_tenant: tenant.id },
    };
    const note = await need().creditNotes.create(params, { idempotencyKey: `fishtape-hq-cn-${inv.id}-${requestKey}` });
    return { inv, tenant, note: { id: note.id, number: note.number || null, amountCents: note.amount ?? amountCents, status: note.status || null } };
  }

  /** The PaymentIntent that paid the invoice (old and new Stripe API shapes). */
  async function paymentIntentOf(inv) {
    const direct = cid(inv.payment_intent);
    if (direct) return direct;
    const s = need();
    if (s.invoicePayments?.list) {
      const list = await s.invoicePayments.list({ invoice: inv.id, limit: 10 });
      const paid = (list.data || []).find((p) => p.status === 'paid' && cid(p.payment?.payment_intent)) || (list.data || []).find((p) => cid(p.payment?.payment_intent));
      if (paid) return cid(paid.payment.payment_intent);
    }
    return null;
  }

  async function refund(id, { amountCents, reason, requestKey, hqUserId }) {
    const { inv, tenant } = await fishtapeInvoice(id);
    if (inv.status !== 'paid' || !(inv.amount_paid > 0)) throw conflict('Only a paid invoice can be refunded.');
    const pi = await paymentIntentOf(inv);
    if (!pi) throw conflict('Stripe has no card payment on this invoice to refund (it may have been paid from the customer balance).');
    const s = need();
    const done = (await listAll((p) => s.refunds.list(p), { payment_intent: pi }, 100)).filter((r) => !['failed', 'canceled'].includes(r.status)).reduce((a, r) => a + (r.amount || 0), 0);
    const max = Math.max(0, inv.amount_paid - done);
    if (amountCents > max) throw new ApiError(400, 'amount_too_large', `At most ${(max / 100).toFixed(2)} can be refunded on this invoice.`, { maxCents: max });
    const r = await s.refunds.create({
      payment_intent: pi, amount: amountCents, reason: 'requested_by_customer',
      metadata: { fishtape_invoice: inv.id, fishtape_tenant: tenant.id, hq_user: hqUserId, hq_reason: reason.slice(0, 200) },
    }, { idempotencyKey: `fishtape-hq-refund-${inv.id}-${requestKey}` });
    return { inv, tenant, refund: { id: r.id, amountCents: r.amount ?? amountCents, status: r.status || null } };
  }

  return { configured: () => Boolean(client), refresh, snapshot, companies, listInvoices, fishtapeInvoice, resend, markUncollectible, creditNote, refund, creditable };
}

// ---- worker ---------------------------------------------------------------------------

export function createFinanceHandlers(deps = {}) {
  return {
    async hq_finance_refresh({ db }) {
      const config = deps.config || (await import('../config.js')).readConfig();
      const f = createFinance({ config, db, ...(deps.stripe !== undefined ? { stripe: deps.stripe } : {}) });
      if (!f.configured()) return { skipped: 'not_configured' };
      const d = await f.refresh();
      return { mrrCents: d.mrrCents, subscriptions: d.subscriptions.active };
    },
  };
}

export const FINANCE_HANDLERS = createFinanceHandlers();

/** Hourly, with the worker's housekeeping (deduplicated). */
export function scheduleFinanceJobs(db) {
  return enqueue(db, { kind: 'hq_finance_refresh', dedupeKey: 'hq_finance_refresh', maxAttempts: 2 });
}
