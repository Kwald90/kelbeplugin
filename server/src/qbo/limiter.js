// Per-tenant rate limits for QuickBooks calls (docs/integrations/quickbooks.md 5.8). Intuit allows
// 10 requests a second, 500 a minute and 10 in flight per realm; Fishtape stays under that with
// 8 a second, 400 a minute, 1 in flight from the worker and 2 from each API process. In-process
// only: one lease holder per tenant (the worker) plus a few look-ups.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A sliding-window limit: at most `limit` starts in any `windowMs`. Pure maths, so it is
 * unit-tested with a fake clock.
 */
export class WindowLimit {
  /** @param {number} limit @param {number} windowMs */
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    /** @type {number[]} start times, oldest first */
    this.starts = [];
  }

  /** Milliseconds to wait before another start is allowed at `now` (0 = now). */
  waitMs(now) {
    while (this.starts.length && this.starts[0] <= now - this.windowMs) this.starts.shift();
    if (this.starts.length < this.limit) return 0;
    return this.starts[0] + this.windowMs - now;
  }

  record(now) {
    this.starts.push(now);
  }
}

/**
 * @param {{ perSecond?: number, perMinute?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [o]
 */
export function createLimiter(o = {}) {
  const perSecond = o.perSecond ?? 8;
  const perMinute = o.perMinute ?? 400;
  const now = o.now || Date.now;
  const wait = o.sleep || sleep;
  /** @type {Map<string, { second: WindowLimit, minute: WindowLimit, inFlight: number, queue: Function[] }>} */
  const tenants = new Map();

  const stateOf = (tenantId) => {
    let s = tenants.get(tenantId);
    if (!s) {
      s = { second: new WindowLimit(perSecond, 1000), minute: new WindowLimit(perMinute, 60_000), inFlight: 0, queue: [] };
      tenants.set(tenantId, s);
    }
    return s;
  };

  /** Milliseconds until the next call for the tenant may start (rate only, not concurrency). */
  function delayFor(tenantId, at = now()) {
    const s = stateOf(tenantId);
    return Math.max(s.second.waitMs(at), s.minute.waitMs(at));
  }

  /**
   * Wait for a slot, then return release(). Concurrency is capped at `maxInFlight`.
   * @param {string} tenantId
   * @param {{ maxInFlight?: number }} [opts]
   */
  async function acquire(tenantId, { maxInFlight = 1 } = {}) {
    const s = stateOf(tenantId);
    while (s.inFlight >= maxInFlight) await new Promise((resolve) => s.queue.push(resolve));
    s.inFlight++;
    try {
      for (;;) {
        const d = delayFor(tenantId);
        if (d <= 0) break;
        await wait(d);
      }
      const at = now();
      s.second.record(at);
      s.minute.record(at);
    } catch (e) {
      release(s);
      throw e;
    }
    let done = false;
    return () => { if (!done) { done = true; release(s); } };
  }

  function release(s) {
    s.inFlight--;
    const next = s.queue.shift();
    if (next) next();
  }

  return { acquire, delayFor, _tenants: tenants };
}

/** The process-wide limiter the QuickBooks client uses. */
export const limiter = createLimiter();
