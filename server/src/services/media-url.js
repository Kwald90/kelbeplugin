// Signed, short-lived URLs for job-site media (walkthrough and wire-run videos and their posters).
// These files are private company records, so they are never served from disk by nginx: the API
// streams them at /api/v1/media/:id/:kind, and only for a URL it signed itself.
//
// A URL is   /api/v1/media/<media id>/<video|poster>?c=<company id>&e=<expiry, unix s>&s=<signature>
// signature  base64url HMAC-SHA256 over "v1|<media id>|<company id>|<kind>|<expiry>", keyed by a
//            subkey of SECRETS_MASTER_KEY (lib/crypto.js sealer.mac, purpose 'media-url'), so no new
//            secret is needed and changing the master key voids every outstanding URL.
//
// <video src> and <img src> can't send an Authorization header, so the token rides in the query
// string. It is only ever handed out by an authenticated, company-scoped call (the walkthrough and
// wire-run media GET routes); it names one file of one company and expires. Expiry is rounded up
// to a 5-minute step, so the same URL is reused for a few minutes (the browser can cache it, AVPlayer
// keeps one URL) and a URL lives between TTL and TTL + 5 minutes.
import { timingSafeEqual } from 'node:crypto';

export const MEDIA_URL_TTL_S = 15 * 60;
const STEP_S = 5 * 60;
export const MEDIA_KINDS = ['video', 'poster'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/**
 * @param {{ mac: (purpose: string, value: string) => Buffer }} sealer
 * @param {{ ttlS?: number, now?: () => number }} [opts]
 */
export function createMediaSigner(sealer, { ttlS = MEDIA_URL_TTL_S, now = () => Date.now() } = {}) {
  const sig = (mediaId, tenantId, kind, exp) => b64u(sealer.mac('media-url', `v1|${mediaId}|${tenantId}|${kind}|${exp}`));
  return {
    /** A signed path for one file of one company. -> { url, expiresAt (ISO) } */
    sign({ mediaId, tenantId, kind }) {
      if (!MEDIA_KINDS.includes(kind)) throw new Error(`unknown media kind ${kind}`);
      const exp = Math.ceil((Math.floor(now() / 1000) + ttlS) / STEP_S) * STEP_S;
      const q = new URLSearchParams({ c: tenantId, e: String(exp), s: sig(mediaId, tenantId, kind, exp) });
      return { url: `/api/v1/media/${encodeURIComponent(mediaId)}/${kind}?${q}`, expiresAt: new Date(exp * 1000).toISOString() };
    },
    /**
     * Check a request's id, kind and query. -> { ok: true, tenantId, expiresAt (s) } or
     * { ok: false, reason: 'invalid' | 'expired' }. A bad signature is 'invalid' whatever the expiry,
     * so an attacker learns nothing from the answer.
     */
    verify({ mediaId, kind, c, e, s }) {
      if (!UUID_RE.test(String(mediaId)) || !MEDIA_KINDS.includes(kind) || !UUID_RE.test(String(c))) return { ok: false, reason: 'invalid' };
      const exp = Number(e);
      if (!Number.isSafeInteger(exp) || exp <= 0 || String(exp) !== String(e)) return { ok: false, reason: 'invalid' };
      const want = Buffer.from(sig(mediaId, c, kind, exp));
      const got = Buffer.from(String(s || ''));
      if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'invalid' };
      if (exp * 1000 <= now()) return { ok: false, reason: 'expired' };
      return { ok: true, tenantId: c, expiresAt: exp };
    },
  };
}

/**
 * One byte range from a Range header against a file of `size` bytes.
 * -> null (no usable Range: send the whole file), { start, end } (inclusive), or 'unsatisfiable'.
 * Several ranges, or a unit other than bytes, are answered with the whole file (RFC 9110 allows it).
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start, end;
  if (a === '') { // the last b bytes
    const n = Number(b);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
    if (b !== '' && Number(b) < start) return null; // malformed: ignore it
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

const TYPES = { mp4: 'video/mp4', webm: 'video/webm', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
/** Content-Type for a media file name. */
export function mediaContentType(name) {
  return TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
}

/**
 * Which file of a walkthrough_media row a kind means: the optimised MP4 once ready, else the
 * uploaded original (still being optimised), or the poster. null when there is none (yet).
 */
export function mediaFileFor(row, kind) {
  if (!row) return null;
  if (kind === 'poster') return row.poster_file || null;
  if (row.status === 'ready' && row.output_file) return row.output_file;
  if (row.status === 'processing' && row.original_file) return row.original_file;
  return null;
}
