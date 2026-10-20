// Outbound HTTP to providers (Stripe, Resend, Twilio, Graph API, Anthropic). One place, so
// tests can swap in a fake fetch (setFetch) and no test ever reaches the network, and so
// provider errors are turned into short, safe messages: response bodies, keys and
// customer details never reach logs or API responses.

let impl = null;

/** Replace fetch for every provider call (tests). Pass null to restore the real one. */
export function setFetch(fn) {
  impl = fn;
}

const TIMEOUT_MS = 15_000;

/** A provider call that failed. `message` is safe to show the company; `retry` says whether trying later may help. */
export class ProviderError extends Error {
  /**
   * @param {string} provider
   * @param {string} message safe, short, no customer data
   * @param {{ status?: number, code?: string|number|null, retry?: boolean, kind?: 'auth'|'invalid'|'quota'|'unavailable'|'optout'|'other' }} [o]
   */
  constructor(provider, message, o = {}) {
    super(message);
    this.provider = provider;
    this.status = o.status ?? null;
    this.providerCode = o.code ?? null;
    this.retry = Boolean(o.retry);
    this.kind = o.kind || 'other';
  }
}

/** Keep provider text short and free of anything that looks like an address, number or key. */
export function scrub(text, max = 200) {
  return String(text ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[number]')
    .replace(/\b(sk|rk|pk|whsec|re|AC|SK|EAA)[_A-Za-z0-9-]{8,}/g, '[key]')
    .replace(/\bSG\.[A-Za-z0-9_.-]{8,}/g, '[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Call a provider and parse JSON. Network errors and timeouts become a retryable ProviderError.
 * @param {string} provider
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, json: any, text: string }>}
 */
export async function request(provider, url, opts = {}) {
  const f = impl || globalThis.fetch;
  let res;
  try {
    res = await f(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs || TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new ProviderError(provider, timedOut ? `${label(provider)} did not answer in time.` : `Could not reach ${label(provider)}.`, { retry: true, kind: 'unavailable' });
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

const LABELS = { stripe: 'Stripe', resend: 'Resend', sendgrid: 'SendGrid', twilio: 'Twilio', facebook: 'Facebook', anthropic: 'Anthropic' };
export const label = (p) => LABELS[p] || p;

/** Default classification of an HTTP failure. Providers refine it with their own codes. */
export function httpFailure(provider, status, detail, code = null) {
  const d = detail ? ` ${scrub(detail)}` : '';
  if (status === 401 || status === 403) return new ProviderError(provider, `${label(provider)} refused the key.${d}`, { status, code, kind: 'auth' });
  if (status === 429) return new ProviderError(provider, `${label(provider)} is rate limiting or over quota.${d}`, { status, code, retry: true, kind: 'quota' });
  if (status >= 500) return new ProviderError(provider, `${label(provider)} had a problem (${status}). We'll try again.`, { status, code, retry: true, kind: 'unavailable' });
  return new ProviderError(provider, `${label(provider)} rejected the request.${d}`, { status, code, kind: 'invalid' });
}

/** application/x-www-form-urlencoded with Stripe-style nesting: { a: { b: [ { c: 1 } ] } } -> a[b][0][c]=1 */
export function formEncode(obj) {
  const out = [];
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  walk('', obj);
  return out.join('&');
}
