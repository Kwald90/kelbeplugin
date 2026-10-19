// A small in-process metrics collector for HQ developer health: requests, 4xx, 5xx and
// latency per minute for the last 24 hours, and 5xx counts by route. Per process (with
// several API processes each reports its own). Holds no request data beyond the route
// pattern (e.g. "GET /api/v1/:collection"), so nothing customer-specific is kept.

const MINUTE = 60_000;
const KEEP_MINUTES = 24 * 60;
/** Latency histogram bucket upper bounds (ms); the last bucket is "slower". */
export const LATENCY_BOUNDS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function emptyBucket(t) {
  return { t, requests: 0, c4xx: 0, c5xx: 0, totalMs: 0, maxMs: 0, hist: new Array(LATENCY_BOUNDS.length + 1).fill(0) };
}

/** Approximate percentile from a histogram: the upper bound of the bucket it falls in. */
export function percentile(hist, p) {
  const n = hist.reduce((a, b) => a + b, 0);
  if (!n) return null;
  let seen = 0;
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i];
    if (seen >= p * n) return i < LATENCY_BOUNDS.length ? LATENCY_BOUNDS[i] : LATENCY_BOUNDS[LATENCY_BOUNDS.length - 1] * 2;
  }
  return null;
}

export function createMetrics({ now = () => Date.now() } = {}) {
  const started = now();
  /** minute index -> bucket */
  const buckets = new Map();
  const errorRoutes = new Map();
  let lastRouteReset = started;

  function bucketFor(t) {
    const k = Math.floor(t / MINUTE);
    let b = buckets.get(k);
    if (!b) {
      b = emptyBucket(k * MINUTE);
      buckets.set(k, b);
      const oldest = k - KEEP_MINUTES;
      for (const key of buckets.keys()) if (key <= oldest) buckets.delete(key);
    }
    return b;
  }

  return {
    /** @param {number} status @param {number} ms @param {string} route e.g. "GET /api/v1/:collection" */
    record(status, ms, route) {
      const t = now();
      const b = bucketFor(t);
      b.requests++;
      if (status >= 500) b.c5xx++;
      else if (status >= 400) b.c4xx++;
      const d = Number.isFinite(ms) && ms >= 0 ? ms : 0;
      b.totalMs += d;
      if (d > b.maxMs) b.maxMs = d;
      let i = LATENCY_BOUNDS.findIndex((x) => d <= x);
      if (i < 0) i = LATENCY_BOUNDS.length;
      b.hist[i]++;
      if (status >= 500) {
        // keep the last 24 h of route counts, roughly: reset daily
        if (t - lastRouteReset > 24 * 60 * MINUTE) { errorRoutes.clear(); lastRouteReset = t; }
        const key = String(route || 'unknown').slice(0, 200);
        errorRoutes.set(key, (errorRoutes.get(key) || 0) + 1);
      }
    },

    snapshot() {
      const t = now();
      const k = Math.floor(t / MINUTE);
      const sum = (fromK) => {
        const s = emptyBucket(fromK * MINUTE);
        for (const [key, b] of buckets) {
          if (key < fromK) continue;
          s.requests += b.requests; s.c4xx += b.c4xx; s.c5xx += b.c5xx; s.totalMs += b.totalMs;
          if (b.maxMs > s.maxMs) s.maxMs = b.maxMs;
          b.hist.forEach((v, i) => { s.hist[i] += v; });
        }
        return {
          requests: s.requests, errors4xx: s.c4xx, errors5xx: s.c5xx,
          errorRate: s.requests ? Math.round((s.c5xx / s.requests) * 10000) / 100 : 0,
          avgMs: s.requests ? Math.round((s.totalMs / s.requests) * 10) / 10 : null,
          p50Ms: percentile(s.hist, 0.5), p95Ms: percentile(s.hist, 0.95), maxMs: Math.round(s.maxMs),
        };
      };
      const perMinute = [];
      for (let i = 59; i >= 0; i--) {
        const b = buckets.get(k - i);
        perMinute.push({ t: new Date((k - i) * MINUTE).toISOString(), requests: b?.requests || 0, errors5xx: b?.c5xx || 0, errors4xx: b?.c4xx || 0 });
      }
      const perHour = [];
      const hourK = Math.floor(t / (60 * MINUTE));
      for (let i = 23; i >= 0; i--) {
        const from = (hourK - i) * 60;
        let requests = 0, e5 = 0, e4 = 0;
        for (let m = from; m < from + 60; m++) {
          const b = buckets.get(m);
          if (b) { requests += b.requests; e5 += b.c5xx; e4 += b.c4xx; }
        }
        perHour.push({ t: new Date(from * MINUTE).toISOString(), requests, errors5xx: e5, errors4xx: e4 });
      }
      return {
        since: new Date(started).toISOString(),
        last5m: sum(k - 4),
        lastHour: sum(k - 59),
        last24h: sum(k - KEEP_MINUTES + 1),
        perMinute,
        perHour,
        errorRoutes: [...errorRoutes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([route, count]) => ({ route, count })),
      };
    },
  };
}
