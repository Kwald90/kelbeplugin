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
        const c = { id: `cus_test${next()}`, object: 'customer', ...params };
        state.customers.set(c.id, c);
        if (opts.idempotencyKey) state.idempotency.set(opts.idempotencyKey, c);
        return c;
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
        async create(params) {
          log('checkout.sessions.create', params);
          const s = { id: `cs_test_${next()}`, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/cs_test_${n}`, ...params };
          state.checkoutSessions.push(s);
          return s;
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) { log('billingPortal.sessions.create', params); const s = { id: `bps_test${next()}`, url: `https://billing.stripe.test/p/session/${n}`, ...params }; state.portalSessions.push(s); return s; },
      },
    },
    subscriptions: {
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
