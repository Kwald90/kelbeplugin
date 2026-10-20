// In-memory Stripe for the HQ finance, invoicing and settings tests: list endpoints with
// paging and the filters Fishtape uses, invoice actions, credit notes and refunds. No network.
// The account mixes Fishtape customers with another business's (True Collar Built), like
// the real shared account.

const missing = (what) => Object.assign(new Error(`No such ${what}`), { statusCode: 404, code: 'resource_missing' });
const cid = (x) => (typeof x === 'string' ? x : x?.id);

function page(all, p = {}) {
  let rows = all.filter((x) => {
    if (p.customer && cid(x.customer) !== p.customer) return false;
    if (p.status && p.status !== 'all' && x.status !== p.status) return false;
    if (p.payment_intent && cid(x.payment_intent) !== p.payment_intent) return false;
    if (p.created?.gte && x.created < p.created.gte) return false;
    if (p.created?.lte && x.created > p.created.lte) return false;
    return true;
  }).sort((a, b) => b.created - a.created);
  if (p.starting_after) rows = rows.slice(rows.findIndex((x) => x.id === p.starting_after) + 1);
  const limit = p.limit || 10;
  return { object: 'list', data: structuredClone(rows.slice(0, limit)), has_more: rows.length > limit };
}

export function financeStripe({ subscriptions = [], invoices = [], refunds = [], account = null, prices = [], webhookEndpoints = [], invoicePayments = [] } = {}) {
  let n = 0;
  const calls = [];
  const log = (name, args) => calls.push({ name, args });
  const state = { subscriptions, invoices, refunds, creditNotes: [], prices, webhookEndpoints, invoicePayments, idem: new Map() };
  const inv = (id) => { const i = state.invoices.find((x) => x.id === id); if (!i) throw missing('invoice'); return i; };
  const idem = (opts, make) => {
    if (opts?.idempotencyKey && state.idem.has(opts.idempotencyKey)) return state.idem.get(opts.idempotencyKey);
    const v = make();
    if (opts?.idempotencyKey) state.idem.set(opts.idempotencyKey, v);
    return v;
  };
  return {
    calls, state,
    accounts: { async retrieve() { log('accounts.retrieve'); if (!account) throw missing('account'); return structuredClone(account); } },
    prices: { async list({ lookup_keys: keys = [] } = {}) { log('prices.list', keys); return { data: state.prices.filter((p) => keys.includes(p.lookup_key)) }; } },
    webhookEndpoints: { async list() { log('webhookEndpoints.list'); return { data: structuredClone(state.webhookEndpoints) }; } },
    subscriptions: { async list(p) { log('subscriptions.list', p); return page(state.subscriptions, p); } },
    invoices: {
      async list(p) { log('invoices.list', p); return page(state.invoices, p); },
      async retrieve(id) { log('invoices.retrieve', id); return structuredClone(inv(id)); },
      async sendInvoice(id) { log('invoices.sendInvoice', id); return structuredClone(inv(id)); },
      async markUncollectible(id) { log('invoices.markUncollectible', id); const i = inv(id); i.status = 'uncollectible'; return structuredClone(i); },
    },
    invoicePayments: { async list({ invoice }) { log('invoicePayments.list', invoice); return { data: state.invoicePayments.filter((p) => p.invoice === invoice) }; } },
    refunds: {
      async list(p) { log('refunds.list', p); return page(state.refunds, p); },
      async create(params, opts) {
        log('refunds.create', { ...params, idempotencyKey: opts?.idempotencyKey });
        return idem(opts, () => {
          const r = { id: `re_test${++n}`, object: 'refund', status: 'succeeded', created: Math.floor(Date.now() / 1000), ...params };
          state.refunds.push(r);
          return r;
        });
      },
    },
    creditNotes: {
      async create(params, opts) {
        log('creditNotes.create', { ...params, idempotencyKey: opts?.idempotencyKey });
        return idem(opts, () => {
          const c = { id: `cn_test${++n}`, object: 'credit_note', number: `CN-${n}`, status: 'issued', ...params };
          state.creditNotes.push(c);
          const i = inv(params.invoice);
          if (i.status === 'open') { i.amount_remaining -= params.amount; i.pre_payment_credit_notes_amount = (i.pre_payment_credit_notes_amount || 0) + params.amount; } else i.post_payment_credit_notes_amount = (i.post_payment_credit_notes_amount || 0) + params.amount;
          return c;
        });
      },
    },
  };
}

const sec = (ms) => Math.floor(ms / 1000);
const DAY = 86_400_000;

/** A subscription item with a Fishtape (or other) price. */
export function subItem(lookupKey, unitAmount, quantity = 1, interval = 'month') {
  return { id: `si_${lookupKey}_${quantity}`, quantity, price: { id: `price_${lookupKey}`, lookup_key: lookupKey, unit_amount: unitAmount, currency: 'cad', recurring: { interval, interval_count: 1 } } };
}

export function sub(id, customer, status, items, { createdDaysAgo = 60, periodEndInDays = 20, canceledDaysAgo = null, trialEndDaysAgo = null, now = Date.now() } = {}) {
  return {
    id, object: 'subscription', customer, status, currency: 'cad', created: sec(now - createdDaysAgo * DAY), cancel_at_period_end: false,
    current_period_end: sec(now + periodEndInDays * DAY), canceled_at: canceledDaysAgo == null ? null : sec(now - canceledDaysAgo * DAY),
    trial_end: trialEndDaysAgo == null ? null : sec(now - trialEndDaysAgo * DAY), metadata: {}, items: { data: items },
  };
}

export function invoice(id, customer, status, { amountPaid = 0, amountDue = 0, amountRemaining = 0, daysAgo = 5, tax = null, attempts = 0, paymentIntent = null, number = null, now = Date.now() } = {}) {
  const created = sec(now - daysAgo * DAY);
  return {
    id, object: 'invoice', number: number || id.toUpperCase(), customer, status, created, currency: 'cad',
    total: Math.max(amountPaid, amountDue), amount_paid: amountPaid, amount_due: amountDue, amount_remaining: amountRemaining,
    attempt_count: attempts, next_payment_attempt: status === 'open' && attempts ? created + 3 * 86400 : null,
    status_transitions: { paid_at: status === 'paid' ? created : null },
    ...(tax != null ? { total_taxes: [{ amount: tax }], automatic_tax: { enabled: true } } : {}),
    payment_intent: paymentIntent, hosted_invoice_url: `https://invoice.stripe.test/i/${id}`, invoice_pdf: `https://pay.stripe.test/${id}.pdf`,
    lines: { data: [] },
  };
}
