// An in-memory stand-in for the parts of the Stripe client Fishtape billing uses, so
// billing tests never touch the network. Signatures are NOT faked: tests sign webhook
// payloads with the real Stripe.webhooks helpers.

const missing = (what) => Object.assign(new Error(`No such ${what}`), { statusCode: 404, code: 'resource_missing' });

export function fakeStripe() {
  let n = 0;
  const next = () => String(++n).padStart(6, '0');
  const state = {
    customers: new Map(), products: new Map(), prices: [], subscriptions: new Map(), checkoutSessions: [], portalSessions: [],
    calls: [], idempotency: new Map(),
  };
  const log = (name, args) => state.calls.push({ name, args });
  const priceById = (id) => state.prices.find((p) => p.id === id);

  function item(sub, price, quantity) {
    return { id: `si_test${next()}`, object: 'subscription_item', subscription: sub.id, price: { ...price }, quantity, current_period_end: sub.current_period_end };
  }

  const stripe = {
    state,
    customers: {
      async create(params, opts = {}) {
        log('customers.create', params);
        if (opts.idempotencyKey && state.idempotency.has(opts.idempotencyKey)) return state.idempotency.get(opts.idempotencyKey);
        const c = { id: `cus_test${next()}`, object: 'customer', balance: 0, ...params };
        state.customers.set(c.id, c);
        if (opts.idempotencyKey) state.idempotency.set(opts.idempotencyKey, c);
        return c;
      },
      /** Negative amount = credit; applies to the customer's next invoice. */
      async createBalanceTransaction(customerId, params, opts = {}) {
        log('customers.createBalanceTransaction', { customer: customerId, ...params, idempotencyKey: opts.idempotencyKey });
        if (state.failBalance) throw state.failBalance;
        if (opts.idempotencyKey && state.idempotency.has(opts.idempotencyKey)) return state.idempotency.get(opts.idempotencyKey);
        const c = state.customers.get(customerId);
        if (!c) throw missing('customer');
        const txn = { id: `cbtxn_test${next()}`, object: 'customer_balance_transaction', customer: customerId, type: 'adjustment', ...params };
        c.balance = (c.balance || 0) + params.amount;
        if (opts.idempotencyKey) state.idempotency.set(opts.idempotencyKey, txn);
        return txn;
      },
    },
    products: {
      async retrieve(id) { log('products.retrieve', id); if (!state.products.has(id)) throw missing('product'); return state.products.get(id); },
      async create(params) { log('products.create', params); const p = { object: 'product', active: true, ...params }; state.products.set(p.id, p); return p; },
      async update(id, params) { log('products.update', { id, ...params }); const p = { ...state.products.get(id), ...params }; state.products.set(id, p); return p; },
    },
    prices: {
      async list({ lookup_keys: keys = [], active } = {}) {
        log('prices.list', keys);
        return { data: state.prices.filter((p) => keys.includes(p.lookup_key) && (active === undefined || p.active === active)) };
      },
      async create(params) {
        log('prices.create', params);
        if (params.transfer_lookup_key) for (const p of state.prices) if (p.lookup_key === params.lookup_key) p.lookup_key = null;
        const { transfer_lookup_key: _t, ...rest } = params;
        const p = { id: `price_test${next()}`, object: 'price', active: true, ...rest };
        state.prices.push(p);
        return p;
      },
      async update(id, params) { log('prices.update', { id, ...params }); Object.assign(priceById(id), params); return priceById(id); },
    },
    checkout: {
      sessions: {
        async create(params, opts = {}) {
          log('checkout.sessions.create', params);
          if (opts.idempotencyKey && state.idempotency.has(opts.idempotencyKey)) return state.idempotency.get(opts.idempotencyKey);
          const s = { id: `cs_test_${next()}`, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/cs_test_${n}`, status: 'open', payment_status: 'unpaid', ...params };
          state.checkoutSessions.push(s);
          if (opts.idempotencyKey) state.idempotency.set(opts.idempotencyKey, s);
          return s;
        },
        async retrieve(id) {
          log('checkout.sessions.retrieve', id);
          const s = state.checkoutSessions.find((x) => x.id === id);
          if (!s) throw missing('checkout session');
          return structuredClone(s);
        },
        async expire(id) {
          log('checkout.sessions.expire', id);
          const s = state.checkoutSessions.find((x) => x.id === id);
          if (!s) throw missing('checkout session');
          if (s.status !== 'open') throw Object.assign(new Error(`Only open sessions can be expired (this one is ${s.status})`), { statusCode: 400, code: 'checkout_session_not_open' });
          s.status = 'expired';
          return structuredClone(s);
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) { log('billingPortal.sessions.create', params); const s = { id: `bps_test${next()}`, url: `https://billing.stripe.test/p/session/${n}`, ...params }; state.portalSessions.push(s); return s; },
      },
    },
    subscriptions: {
      async cancel(id) {
        log('subscriptions.cancel', id);
        const sub = state.subscriptions.get(id);
        if (!sub) throw missing('subscription');
        sub.status = 'canceled';
        return structuredClone(sub);
      },
      async retrieve(id) { log('subscriptions.retrieve', id); if (!state.subscriptions.has(id)) throw missing('subscription'); return structuredClone(state.subscriptions.get(id)); },
      async update(id, params) {
        log('subscriptions.update', { id, ...params });
        const sub = state.subscriptions.get(id);
        if (!sub) throw missing('subscription');
        for (const it of params.items || []) {
          if (it.deleted) { sub.items.data = sub.items.data.filter((x) => x.id !== it.id); continue; }
          const existing = it.id && sub.items.data.find((x) => x.id === it.id);
          if (existing) {
            if (it.price) existing.price = { ...priceById(it.price) };
            if (it.quantity != null) existing.quantity = it.quantity;
          } else {
            sub.items.data.push(item(sub, priceById(it.price), it.quantity ?? 1));
          }
        }
        if (params.metadata) sub.metadata = { ...sub.metadata, ...params.metadata };
        return structuredClone(sub);
      },
    },
    subscriptionItems: {
      async create(params) { log('subscriptionItems.create', params); const sub = state.subscriptions.get(params.subscription); const it = item(sub, priceById(params.price), params.quantity); sub.items.data.push(it); return it; },
      async update(id, params) {
        log('subscriptionItems.update', { id, ...params });
        for (const sub of state.subscriptions.values()) { const it = sub.items.data.find((x) => x.id === id); if (it) { Object.assign(it, params); return it; } }
        throw missing('subscription item');
      },
      async del(id) {
        log('subscriptionItems.del', id);
        for (const sub of state.subscriptions.values()) sub.items.data = sub.items.data.filter((x) => x.id !== id);
        return { id, deleted: true };
      },
    },

    /**
     * Test helper: the customer pays a subscription-mode Checkout Session the way Stripe
     * would: a customer from customer_email, a subscription from the recurring line items
     * (trialing when subscription_data.trial_period_days is set), the one-time items charged
     * now. Returns the session object a checkout.session.completed event carries.
     */
    completeCheckout(sessionId) {
      const s = state.checkoutSessions.find((x) => x.id === sessionId);
      if (!s || s.status !== 'open') throw new Error(`session ${sessionId} is not open`);
      const customer = { id: `cus_test${next()}`, object: 'customer', email: s.customer_email, balance: 0 };
      state.customers.set(customer.id, customer);
      const now = Math.floor(Date.now() / 1000);
      const trialDays = s.subscription_data?.trial_period_days || 0;
      const sub = {
        id: `sub_test${next()}`, object: 'subscription', customer: customer.id, status: trialDays ? 'trialing' : 'active', cancel_at_period_end: false,
        trial_start: trialDays ? now : null, trial_end: trialDays ? now + trialDays * 86400 : null,
        current_period_end: now + (trialDays || 30) * 86400, metadata: { ...(s.subscription_data?.metadata || {}) }, items: { data: [] },
      };
      let oneTime = 0;
      for (const li of s.line_items) {
        const price = priceById(li.price);
        if (!price) throw new Error(`no price ${li.price}`);
        if (price.recurring) sub.items.data.push(item(sub, price, li.quantity));
        else oneTime += price.unit_amount * li.quantity;
      }
      state.subscriptions.set(sub.id, sub);
      Object.assign(s, { status: 'complete', payment_status: 'paid', customer: customer.id, subscription: sub.id, amount_total: oneTime, currency: 'cad' });
      return structuredClone(s);
    },

    /** Test helper: a subscription as Stripe would hold it after Checkout. */
    addSubscription({ customer, tenantId, plan, extra = 0, status = 'active' }) {
      const tierPrice = state.prices.find((p) => p.lookup_key === `fishtape_${plan}_monthly_cad`);
      const extraPrice = state.prices.find((p) => p.lookup_key === 'fishtape_extra_user_monthly_cad');
      const sub = {
        id: `sub_test${next()}`, object: 'subscription', customer, status, cancel_at_period_end: false,
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, metadata: { tenant_id: tenantId, plan }, items: { data: [] },
      };
      sub.items.data.push(item(sub, tierPrice, 1));
      if (extra > 0) sub.items.data.push(item(sub, extraPrice, extra));
      state.subscriptions.set(sub.id, sub);
      return structuredClone(sub);
    },
  };
  return stripe;
}
