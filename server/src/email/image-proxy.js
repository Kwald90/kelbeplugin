// Remote images for HQ Mail, fetched by the server after "Show images". The HQ page CSP only
// allows images from 'self', and fetching them here also keeps HQ staff IP addresses and
// browsers away from senders' trackers. It is not an open proxy: the route looks the URL up
// by index in the stored message, never takes one from the browser.
//
// SSRF guards: http(s) on ports 80/443 only; every DNS answer is checked at connect time
// (no private, loopback, link-local, CGNAT, multicast or reserved addresses, IPv4 or IPv6,
// including IPv4-mapped forms), so DNS rebinding cannot slip through; at most 3 redirects,
// each checked again; 10 s; 5 MB; and the bytes must really be PNG, JPEG, GIF or WebP
// (no SVG, which can carry script).
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';

const MAX_BYTES = 5 * 1024 * 1024;

function v4Public(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

/** True for addresses on the public internet only. */
export function isPublicAddress(ip) {
  const s = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const kind = isIP(s);
  if (kind === 4) return v4Public(s);
  if (kind !== 6) return false;
  const mapped = /^(?:0{0,4}:){0,5}ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(s) || /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return v4Public(mapped[1]);
  // Expand to check the leading groups.
  const [head, tail = ''] = s.split('::');
  const groups = [...head.split(':').filter(Boolean), ...Array(Math.max(0, 8 - head.split(':').filter(Boolean).length - tail.split(':').filter(Boolean).length)).fill('0'), ...tail.split(':').filter(Boolean)];
  const g = groups.map((x) => Number.parseInt(x, 16));
  if (g.length !== 8 || g.some((n) => !Number.isFinite(n))) return false;
  if (g.every((n) => n === 0)) return false;                 // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return false; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false;              // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false;              // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return false;              // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false;      // documentation
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard
  if (g[0] === 0x2002) return false;                         // 6to4 (embeds any IPv4)
  if (g[0] === 0x2001 && g[1] === 0) return false;           // Teredo
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false;      // NAT64 not caught above
  return (g[0] & 0xe000) === 0x2000;                          // global unicast 2000::/3 only
}

/** dns.lookup that refuses non-public answers (used by the socket at connect time). */
export function safeLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'object' && options ? options : {};
  dnsLookup(hostname, { all: true, family: opts.family || 0 }, (err, addresses) => {
    if (err) return cb(err);
    const list = (addresses || []).filter((a) => isPublicAddress(a.address));
    if (!list.length || list.length !== addresses.length) {
      return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    }
    if (opts.all) return cb(null, list);
    return cb(null, list[0].address, list[0].family);
  });
}

/** The image type from its first bytes, or null. */
export function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function getOnce(url, { lookup, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || (u.port && !['80', '443'].includes(u.port)) || u.username || u.password) {
      reject(new Error('blocked url')); return;
    }
    if (isIP(u.hostname.replace(/^\[|\]$/g, '')) && !isPublicAddress(u.hostname)) { reject(new Error('blocked address')); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, {
      lookup, timeout: timeoutMs, agent: false,
      headers: { 'user-agent': 'Fishtape-Mail-Image-Proxy/1', accept: 'image/png,image/jpeg,image/gif,image/webp', 'accept-encoding': 'identity' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        resolve({ redirect: res.headers.location ? new URL(res.headers.location, u).href : null });
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`status ${res.statusCode}`)); return; }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_BYTES) { res.destroy(); reject(new Error('too large')); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BYTES) { res.destroy(); reject(new Error('too large')); return; }
        chunks.push(d);
      });
      res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * @param {string} url
 * @returns {Promise<{ contentType: string, body: Buffer }>} throws when refused or not an image
 */
export async function fetchImage(url, { lookup = safeLookup, timeoutMs = 10_000 } = {}) {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    const r = await getOnce(current, { lookup, timeoutMs });
    if (r.redirect) { current = r.redirect; continue; }
    const type = sniffImage(r.body);
    if (!type) throw new Error('not an image');
    return { contentType: type, body: r.body };
  }
  throw new Error('too many redirects');
}
