// Landing-page promotions (the video hero on site/index.html) and the media HQ uploads for
// them. Pure pieces (validation, URL rules, active-window selection, public view, magic-byte
// sniffing) are exported for tests; routes/promotions.js wires them to HTTP.
//
// Settings come from the environment (tests pass config.promotions / config.media):
//   MEDIA_DIR                 where uploads are written (outside the code checkout; nginx serves it at /media/)
//   MEDIA_MAX_VIDEO_MB        per video, default 150
//   MEDIA_MAX_IMAGE_MB        per poster image, default 15
//   PROMOTION_MEDIA_ORIGINS   extra https origins allowed for video/poster URLs (a CDN); the CSP must allow them too
//   PROMOTION_LINK_ORIGINS    extra https origins allowed for button links (PUBLIC_ORIGIN always is)
//   PROMOTIONS_CACHE_S        how long the public endpoint caches the live list, default 30
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink, chmod } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, validationFailed } from '../errors.js';

const MB = 1024 * 1024;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));
const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const httpsOrigin = (o) => /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(o);

/** The code checkout (repo root). MEDIA_DIR may never be inside it. */
export const CODE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const LIMITS = { minSlides: 3, maxSlides: 5, nameMax: 120, notesMax: 2000, urlMax: 500 };

/** Player timing. handoverAtMs: how long before a clip ends the next one starts fading in. */
export const DEFAULT_SETTINGS = Object.freeze({ transition: 'fade', transitionMs: 800, handoverAtMs: 1000, posterHoldMs: 6000 });

/**
 * Built in: what the page shows when no promotion is live (or the database is unreachable).
 * Poster-only slides until videos are uploaded. site/hero.js has the same object as
 * FALLBACK_PROMOTION for when the API can't be reached; a server test keeps them identical.
 */
export const DEFAULT_PROMOTION = Object.freeze({
  id: 'default',
  overlay: {
    eyebrow: 'CEC 2024 built in',
    headline: 'Built for Canadian electricians',
    subline: 'Quotes, jobs, drawings, crew time and invoices in one app, checked against the Canadian Electrical Code.',
    primaryCta: { label: 'Start your 14-day free trial', href: '/site/signup.html?plan=pro' },
    secondaryCta: { label: 'See pricing', href: '/site/pricing.html' },
    note: '$1 deposit, credited to your first month.',
  },
  slides: [
    { poster: '/site/img/hero/default-1.svg' },
    { poster: '/site/img/hero/default-2.svg', overlay: { eyebrow: 'Field tools', subline: 'Measure wire runs with AR, get marks for every conduit bend, and keep working offline on site.' } },
    { poster: '/site/img/hero/default-3.svg', overlay: { eyebrow: 'Estimate to invoice', subline: 'Quote it, schedule the crew, track time and get paid. AI drafts it, you approve it.' } },
  ],
  settings: { ...DEFAULT_SETTINGS },
});

// ---- settings ------------------------------------------------------------------------------

/** @param {object} config @param {NodeJS.ProcessEnv} [env] */
export function promotionSettings(config, env = process.env) {
  return {
    publicOrigin: config.publicOrigin,
    mediaOrigins: list(env.PROMOTION_MEDIA_ORIGINS).filter(httpsOrigin),
    linkOrigins: list(env.PROMOTION_LINK_ORIGINS).filter(httpsOrigin),
    cacheSeconds: Math.max(0, int(env.PROMOTIONS_CACHE_S, 30)),
    ...(config.promotions || {}),
  };
}

/** @param {object} config @param {NodeJS.ProcessEnv} [env] */
export function mediaSettings(config, env = process.env) {
  const s = {
    dir: env.MEDIA_DIR || '',
    maxVideoBytes: int(env.MEDIA_MAX_VIDEO_MB, 150) * MB,
    maxImageBytes: int(env.MEDIA_MAX_IMAGE_MB, 15) * MB,
    ...(config.media || {}),
  };
  s.problem = mediaDirProblem(s.dir);
  return s;
}

/** Why a MEDIA_DIR can't be used, or null. */
export function mediaDirProblem(dir, codeRoot = CODE_ROOT) {
  if (!dir) return 'MEDIA_DIR is not set, so uploads are off.';
  if (!isAbsolute(dir)) return 'MEDIA_DIR must be an absolute path.';
  const rel = relative(resolve(codeRoot), resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return 'MEDIA_DIR must be outside the code checkout.';
  return null;
}

// ---- URL rules -------------------------------------------------------------------------------

const VIDEO_EXT = new Set(['mp4', 'webm']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp']);
const SITE_IMAGE_EXT = new Set([...IMAGE_EXT, 'svg', 'avif']);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const extOf = (p) => (/\.([a-z0-9]{2,5})$/i.exec(p)?.[1] || '').toLowerCase();

/**
 * Is `url` an allowed source for a video ('video' = mp4 or webm, 'webm') or an image?
 * Allowed: /media/<file> (uploads), /site/img/... (images shipped with the site), or https
 * URLs on PROMOTION_MEDIA_ORIGINS. No query strings, fragments, dot segments or encodings.
 * @returns {string|null} the problem, or null when allowed
 */
export function mediaUrlProblem(url, kind, { mediaOrigins = [] } = {}) {
  if (typeof url !== 'string' || !url) return 'is empty';
  if (url.length > LIMITS.urlMax) return 'is too long';
  if (/[\s\\"'<>`%?#]/.test(url)) return 'has characters that are not allowed';
  const extOk = (ext, site) => (kind === 'image' ? (site ? SITE_IMAGE_EXT : IMAGE_EXT).has(ext) : kind === 'webm' ? ext === 'webm' : VIDEO_EXT.has(ext));
  const pathOk = (segments) => segments.length > 0 && segments.every((s) => SEGMENT.test(s) && !/^\.+$/.test(s) && !s.includes('..'));
  if (url.startsWith('/media/')) {
    const segs = url.slice(7).split('/');
    if (segs.length !== 1 || !pathOk(segs)) return 'must name one uploaded file (/media/<file>)';
    return extOk(extOf(url), false) ? null : `must be ${kind === 'image' ? 'a JPG, PNG or WebP image' : kind === 'webm' ? 'a WebM video' : 'an MP4 or WebM video'}`;
  }
  if (url.startsWith('/site/img/')) {
    if (kind !== 'image') return 'must be an uploaded video (/media/...)';
    if (!pathOk(url.slice(10).split('/'))) return 'is not a valid site image path';
    return extOk(extOf(url), true) ? null : 'must be an image';
  }
  if (url.startsWith('https://')) {
    let u;
    try { u = new URL(url); } catch { return 'is not a valid URL'; }
    if (u.username || u.password || u.search || u.hash) return 'must not carry credentials, a query or a fragment';
    if (!mediaOrigins.includes(u.origin)) return 'is not on an allowed media origin (PROMOTION_MEDIA_ORIGINS)';
    if (!pathOk(u.pathname.split('/').filter(Boolean))) return 'is not a valid path';
    return extOk(extOf(u.pathname), false) ? null : 'has the wrong file type';
  }
  return 'must be /media/..., /site/img/... or an allowed https URL';
}

/**
 * Button links: a same-origin path (/site/signup.html?plan=pro), an in-page #anchor,
 * mailto:, or https on PUBLIC_ORIGIN / PROMOTION_LINK_ORIGINS.
 * @returns {string|null}
 */
export function linkProblem(href, { publicOrigin = '', linkOrigins = [] } = {}) {
  if (typeof href !== 'string' || !href) return 'is empty';
  if (href.length > LIMITS.urlMax) return 'is too long';
  if (/[\s\\"'<>`]/.test(href)) return 'has characters that are not allowed';
  if (/^#[A-Za-z][\w-]{0,63}$/.test(href)) return null;
  if (/^\/(?!\/)[A-Za-z0-9\-._~!$&()*+,;=:@%/?#]*$/.test(href)) return href.split(/[?#]/)[0].split('/').includes('..') ? 'has a dot segment' : null;
  if (/^mailto:[^\s@/]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(href)) return null;
  if (href.startsWith('https://')) {
    let u;
    try { u = new URL(href); } catch { return 'is not a valid URL'; }
    if (u.username || u.password) return 'must not carry credentials';
    if (u.origin === publicOrigin || linkOrigins.includes(u.origin)) return null;
    return 'goes to a site that is not allowed (PROMOTION_LINK_ORIGINS)';
  }
  return 'must be a /path, #anchor, mailto: or an allowed https link';
}

// ---- body schema (structure) and validation (meaning) -------------------------------------

const str = (max, min = 0) => ({ type: 'string', minLength: min, maxLength: max });
const cta = { type: 'object', additionalProperties: false, required: ['label', 'href'], properties: { label: str(40, 1), href: str(LIMITS.urlMax, 1) } };
const overlayProps = { eyebrow: str(60), headline: str(120), subline: str(240), note: str(160), primaryCta: cta, secondaryCta: { ...cta, type: ['object', 'null'] } };
const url = str(LIMITS.urlMax);
const AUDIENCE = '^[a-z][a-z0-9_]{0,31}=[A-Za-z0-9_-]{1,64}$';

export const PROMOTION_BODY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'overlay', 'slides'],
  properties: {
    name: str(LIMITS.nameMax, 1),
    status: { type: 'string', enum: ['draft', 'active', 'inactive'] },
    startsAt: { type: ['string', 'null'], format: 'date-time' },
    endsAt: { type: ['string', 'null'], format: 'date-time' },
    priority: { type: 'integer', minimum: -1000, maximum: 1000 },
    audience: { type: ['string', 'null'], maxLength: 97 },
    overlay: { type: 'object', additionalProperties: false, required: ['headline', 'primaryCta'], properties: { ...overlayProps, headline: str(120, 1) } },
    slides: {
      type: 'array', minItems: LIMITS.minSlides, maxItems: LIMITS.maxSlides,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          videoDesktop: url, videoMobile: url, webmDesktop: url, webmMobile: url, poster: url, posterMobile: url,
          overlay: { type: 'object', additionalProperties: false, properties: overlayProps },
        },
      },
    },
    settings: {
      type: 'object', additionalProperties: false,
      properties: {
        transition: { type: 'string', enum: ['fade', 'slide'] },
        transitionMs: { type: 'integer', minimum: 200, maximum: 3000 },
        handoverAtMs: { type: 'integer', minimum: 300, maximum: 4000 },
        posterHoldMs: { type: 'integer', minimum: 2000, maximum: 20000 },
      },
    },
    notes: str(LIMITS.notesMax),
    version: { type: 'integer', minimum: 1 },
  },
};

const SLIDE_URLS = [['videoDesktop', 'video'], ['videoMobile', 'video'], ['webmDesktop', 'webm'], ['webmMobile', 'webm'], ['poster', 'image'], ['posterMobile', 'image']];
const TEXT_KEYS = ['eyebrow', 'headline', 'subline', 'note'];

function cleanOverlay(o, path, settings, errors, { partial }) {
  const out = {};
  for (const k of TEXT_KEYS) {
    const v = typeof o?.[k] === 'string' ? o[k].trim() : '';
    if (v) out[k] = v;
  }
  for (const k of ['primaryCta', 'secondaryCta']) {
    if (!o || !(k in o)) continue;
    const c = o[k];
    if (c === null) { if (k === 'secondaryCta') out[k] = null; continue; }
    const label = String(c.label || '').trim();
    if (!label) { errors.push({ path: `${path}/${k}/label`, message: 'is empty' }); continue; }
    const p = linkProblem(c.href, settings);
    if (p) errors.push({ path: `${path}/${k}/href`, message: p });
    out[k] = { label, href: c.href };
  }
  if (!partial) {
    if (!out.headline) errors.push({ path: `${path}/headline`, message: 'is required' });
    if (!out.primaryCta) errors.push({ path: `${path}/primaryCta`, message: 'is required' });
    if (!('secondaryCta' in out)) out.secondaryCta = null;
  }
  return out;
}

/**
 * Check the meaning of a promotion body (the route schema has already checked its shape) and
 * return it normalised: trimmed text, blanks dropped, timing filled in. Throws 400 with the
 * failing fields (never their values).
 */
export function validatePromotion(body, settings) {
  const errors = [];
  const overlay = cleanOverlay(body.overlay, '/overlay', settings, errors, { partial: false });
  const slides = (body.slides || []).map((s, i) => {
    const out = {};
    for (const [k, kind] of SLIDE_URLS) {
      if (!s[k]) continue;
      const p = mediaUrlProblem(s[k], kind, settings);
      if (p) errors.push({ path: `/slides/${i}/${k}`, message: p });
      out[k] = s[k];
    }
    if (!out.poster && !out.videoDesktop && !out.videoMobile) errors.push({ path: `/slides/${i}`, message: 'needs a poster or a video' });
    if (s.overlay) {
      const o = cleanOverlay(s.overlay, `/slides/${i}/overlay`, settings, errors, { partial: true });
      if (Object.keys(o).length) out.overlay = o;
    }
    return out;
  });
  if (slides.length < LIMITS.minSlides || slides.length > LIMITS.maxSlides) errors.push({ path: '/slides', message: `must have ${LIMITS.minSlides} to ${LIMITS.maxSlides} slides` });
  const timing = { ...DEFAULT_SETTINGS, ...(body.settings || {}) };
  if (timing.handoverAtMs < timing.transitionMs + 100) errors.push({ path: '/settings/handoverAtMs', message: 'must be at least the transition time plus 100 ms, so the fade ends before the clip does' });
  const startsAt = body.startsAt ? new Date(body.startsAt) : null;
  const endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (startsAt && endsAt && endsAt <= startsAt) errors.push({ path: '/endsAt', message: 'must be after the start' });
  const audience = typeof body.audience === 'string' && body.audience.trim() ? body.audience.trim() : null;
  if (audience && !new RegExp(AUDIENCE).test(audience)) errors.push({ path: '/audience', message: 'must look like province=ON (a-z key, then =, then letters, digits, _ or -)' });
  const name = String(body.name || '').trim();
  if (!name) errors.push({ path: '/name', message: 'is required' });
  if (errors.length) throw validationFailed('The promotion is not valid.', { errors: errors.slice(0, 30) });
  return {
    name, status: body.status || 'draft', startsAt, endsAt, priority: body.priority ?? 0, audience,
    overlay, slides, settings: timing, notes: String(body.notes || '').trim(),
  };
}

// ---- selection and views -------------------------------------------------------------------

const t = (d) => (d == null ? null : new Date(d).getTime());

/** draft | inactive | scheduled | live | ended */
export function promotionState(p, now = new Date()) {
  if (p.status !== 'active') return p.status;
  const n = now.getTime();
  if (p.starts_at && t(p.starts_at) > n) return 'scheduled';
  if (p.ends_at && t(p.ends_at) <= n) return 'ended';
  return 'live';
}

/** "province=ON,campaign=spring" (or several audience params) -> ['province=ON', 'campaign=spring']; junk is dropped. */
export function parseAudienceTags(raw) {
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v ?? '').split(','));
  const re = new RegExp(AUDIENCE);
  return [...new Set(parts.map((s) => s.trim().replace(':', '=')).filter((s) => re.test(s)))].slice(0, 8);
}

/**
 * The one promotion to show now: active, inside its window, for everyone or for one of the
 * visitor's tags. Highest priority wins; then a targeted one over a general one, the latest
 * start, the latest edit, and finally the id (so the answer never flickers).
 * @param {Array<{ id, status?, starts_at, ends_at, priority, audience, updated_at }>} rows
 */
export function selectActive(rows, { now = new Date(), tags = [] } = {}) {
  const n = now.getTime();
  const live = rows.filter((p) => (p.status ?? 'active') === 'active'
    && (!p.starts_at || t(p.starts_at) <= n) && (!p.ends_at || t(p.ends_at) > n)
    && (!p.audience || tags.includes(p.audience)));
  live.sort((a, b) => (b.priority - a.priority)
    || ((b.audience ? 1 : 0) - (a.audience ? 1 : 0))
    || ((t(b.starts_at) ?? 0) - (t(a.starts_at) ?? 0))
    || ((t(b.updated_at) ?? 0) - (t(a.updated_at) ?? 0))
    || String(a.id).localeCompare(String(b.id)));
  return live[0] || null;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] != null && o[k] !== '').map((k) => [k, o[k]]));
const ctaView = (c) => (c ? { label: c.label, href: c.href } : c);
function overlayView(o) {
  const out = pick(o, TEXT_KEYS);
  for (const k of ['primaryCta', 'secondaryCta']) if (o && k in o) out[k] = ctaView(o[k]);
  return out;
}

/** What the public endpoint returns: the overlay, the slides' media and timing. Nothing internal. */
export function publicView(p) {
  return {
    id: String(p.id),
    overlay: overlayView(p.overlay),
    slides: (p.slides || []).map((s) => {
      const out = pick(s, SLIDE_URLS.map(([k]) => k));
      if (s.overlay && Object.keys(s.overlay).length) out.overlay = overlayView(s.overlay);
      return out;
    }),
    settings: { ...DEFAULT_SETTINGS, ...pick(p.settings, Object.keys(DEFAULT_SETTINGS)) },
  };
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** HQ's view of a row. */
export function hqView(p, now = new Date()) {
  return {
    id: p.id, name: p.name, status: p.status, state: promotionState(p, now),
    startsAt: iso(p.starts_at), endsAt: iso(p.ends_at), priority: p.priority, audience: p.audience,
    overlay: p.overlay, slides: p.slides, settings: { ...DEFAULT_SETTINGS, ...p.settings }, notes: p.notes, version: p.version,
    createdAt: iso(p.created_at), updatedAt: iso(p.updated_at), createdByName: p.created_by_name || null, updatedByName: p.updated_by_name || null,
  };
}

/**
 * Short-lived cache of the live list (one query serves every visitor and every audience).
 * HQ writes in the same process call invalidate(); other processes see changes within ttl.
 */
export function createLiveCache({ ttlMs, load, now = () => Date.now() }) {
  let rows = null, at = 0, pending = null;
  return {
    async get() {
      if (rows && now() - at < ttlMs) return rows;
      if (!pending) {
        pending = load().then((r) => { rows = r; at = now(); return r; }).finally(() => { pending = null; });
      }
      return pending;
    },
    invalidate() { rows = null; },
  };
}

// ---- media: magic bytes and storage -----------------------------------------------------------

export const MEDIA_TYPES = {
  'video/mp4': { kind: 'video', ext: 'mp4' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/png': { kind: 'image', ext: 'png' },
  'image/webp': { kind: 'image', ext: 'webp' },
};
/** Content-Types the upload route accepts; the bytes decide, these only have to agree. */
export const UPLOAD_CONTENT_TYPES = [...Object.keys(MEDIA_TYPES), 'application/octet-stream'];

// ISO BMFF brands that are MP4 video (not QuickTime 'qt  ', HEIF/AVIF images or 3GP).
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'dash', 'mmp4', 'MSNV', 'cmfc', 'cmf2', 'f4v ']);

/**
 * What the first bytes say a file is, from the allowed five, or null.
 * @param {Buffer} b at least the first 64 bytes when the file is that long
 */
export function sniffMedia(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.toString('latin1', 4, 8) === 'ftyp' && MP4_BRANDS.has(b.toString('latin1', 8, 12))) return 'video/mp4';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML header: the DocType element (0x42 0x82, size, text) must say webm, not matroska.
    const head = b.subarray(0, Math.min(b.length, 64));
    const i = head.indexOf(Buffer.from([0x42, 0x82]));
    if (i > 0 && i + 3 < head.length) {
      const len = head[i + 2] & 0x7f;
      if (head.toString('latin1', i + 3, i + 3 + len) === 'webm') return 'video/webm';
    }
  }
  return null;
}

/** Original file name -> a short, harmless label for HQ. */
export function cleanLabel(raw) {
  let s = '';
  try { s = decodeURIComponent(String(raw || '')); } catch { s = String(raw || ''); }
  return s.replace(/[^\w .()-]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** /media/<name> -> absolute path inside dir, or null for anything else (traversal included). */
export function mediaPath(dir, name) {
  if (typeof name !== 'string' || !/^[a-f0-9]{32}\.(mp4|webm|jpg|png|webp)$/.test(name)) return null;
  const root = resolve(dir);
  const p = resolve(root, name);
  return p.startsWith(root + sep) ? p : null;
}

const SNIFF_BYTES = 64;

/**
 * Stream an upload into dir under a random name. The type comes from the bytes; the declared
 * Content-Type must agree unless it is application/octet-stream. Over the cap for its kind,
 * the upload stops with 413 and nothing is left behind. Files are 0644: readable by nginx,
 * never executable.
 * @param {import('node:stream').Readable} stream
 * @param {{ dir: string, declaredType: string, contentLength?: number|null, maxVideoBytes: number, maxImageBytes: number }} o
 * @returns {Promise<{ fileName: string, mime: string, kind: string, bytes: number, sha256: string, path: string }>}
 */
export async function receiveUpload(stream, { dir, declaredType, contentLength = null, maxVideoBytes, maxImageBytes }) {
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_CONTENT_TYPES.includes(declared)) throw new ApiError(415, 'unsupported_media', 'Upload an MP4 or WebM video, or a JPG, PNG or WebP image.');
  const declaredKind = MEDIA_TYPES[declared]?.kind;
  const cap = (kind) => (kind === 'image' ? maxImageBytes : maxVideoBytes);
  if (contentLength != null && contentLength > cap(declaredKind || 'video')) throw new ApiError(413, 'too_large', `That file is too large (limit ${Math.round(cap(declaredKind || 'video') / MB)} MB).`);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const tmp = join(dir, `.upload-${randomBytes(8).toString('hex')}.part`);
  const fh = await open(tmp, 'wx', 0o644);
  const hash = createHash('sha256');
  let bytes = 0, head = Buffer.alloc(0), mime = null, done = false;

  const result = await new Promise((resolveP, rejectP) => {
    let writing = Promise.resolve();
    const fail = (e) => {
      if (done) return;
      done = true;
      stream.removeListener('data', onData);
      stream.pause();
      writing.finally(() => rejectP(e));
    };
    const write = (chunk) => {
      hash.update(chunk);
      writing = writing.then(() => fh.write(chunk));
      writing.catch(fail);
    };
    function onData(chunk) {
      if (done) return;
      bytes += chunk.length;
      if (!mime) {
        head = Buffer.concat([head, chunk]);
        if (head.length < SNIFF_BYTES) return;
        if (!decide()) return;
        write(head);
      } else write(chunk);
      if (bytes > cap(MEDIA_TYPES[mime].kind)) fail(new ApiError(413, 'too_large', `That file is too large (limit ${Math.round(cap(MEDIA_TYPES[mime].kind) / MB)} MB).`));
    }
    function decide() {
      mime = sniffMedia(head);
      if (!mime) { fail(new ApiError(415, 'unsupported_media', 'That file is not an MP4, WebM, JPG, PNG or WebP (checked by its contents, not its name).')); return false; }
      if (declared !== 'application/octet-stream' && declared !== mime) { fail(new ApiError(415, 'unsupported_media', 'The file contents do not match its type.')); return false; }
      return true;
    }
    stream.on('data', onData);
    stream.once('error', () => fail(new ApiError(400, 'upload_failed', 'The upload was interrupted.')));
    stream.once('aborted', () => fail(new ApiError(400, 'upload_failed', 'The upload was interrupted.')));
    stream.once('end', () => {
      if (done) return;
      if (!mime) {
        if (!decide()) return;
        write(head);
        if (bytes > cap(MEDIA_TYPES[mime].kind)) { fail(new ApiError(413, 'too_large', 'That file is too large.')); return; }
      }
      done = true;
      writing.then(() => resolveP({ mime, bytes }), rejectP);
    });
  }).catch(async (e) => {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw e;
  });

  await fh.close();
  await chmod(tmp, 0o644).catch(() => {}); // umask may have narrowed it; never executable either way
  const fileName = `${randomBytes(16).toString('hex')}.${MEDIA_TYPES[result.mime].ext}`;
  const path = join(dir, fileName);
  await rename(tmp, path);
  return { fileName, mime: result.mime, kind: MEDIA_TYPES[result.mime].kind, bytes: result.bytes, sha256: hash.digest('hex'), path };
}
