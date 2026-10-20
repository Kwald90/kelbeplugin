#!/usr/bin/env node
// Local preview of the public site with production routing (deploy/production/nginx/fishtape.conf):
// clean URLs (/about, /features/wire-runs, /for/ontario), /site/ files, the app assets the pages
// import (/js/, /css/, /icons/), /sitemap.xml, /robots.txt and security.txt, sent with the
// production security headers (CSP included), so a CSP problem shows up here first.
//
//   node tools/site/serve.mjs [--port 8090] [--api http://localhost:3410] [--mock-api]
//
// --api proxies /api/ to a running API. --mock-api answers the public endpoints the pages call
// with fixed sample data (tools/site/crawl.mjs uses it); without either, /api/ answers 404 and
// the pages fall back to their built-in defaults.
import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileForPath } from '../../site/site-lib.js';
import { FALLBACK_PROMOTION } from '../../site/hero.js';

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SITE = join(ROOT, 'site');
const APP = join(ROOT, 'electrical-app');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/** The production headers (deploy/production/nginx/security-headers.conf), parsed. */
export function productionHeaders() {
  const text = readFileSync(join(ROOT, 'deploy/production/nginx/security-headers.conf'), 'utf8');
  const out = {};
  for (const m of text.matchAll(/^add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;$/gm)) out[m[1]] = m[2];
  delete out['Strict-Transport-Security'];
  // Local http: upgrade-insecure-requests would turn every request into https.
  if (out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace(/;\s*upgrade-insecure-requests/, '');
  return out;
}

const SECURITY_TXT = 'Contact: https://github.com/Kwald90/kelbeplugin/security/advisories/new\nExpires: 2027-10-19T00:00:00Z\nPolicy: https://github.com/Kwald90/kelbeplugin/security/policy\nPreferred-Languages: en, fr\nCanonical: https://fishtapehq.com/.well-known/security.txt\n';

/** Sample answer for GET /api/v1/public/status (the shape server/src/services/status-page.js returns). */
export function sampleStatus(now = new Date('2026-10-19T15:00:00Z')) {
  const ids = [['app', 'Web app'], ['api', 'API and sync'], ['hq', 'HQ console'], ['signin', 'Sign-in'], ['email', 'Email'], ['payments', 'Payments']];
  const day = (i) => new Date(now.getTime() - (89 - i) * 86_400_000).toISOString().slice(0, 10);
  const series = (id) => Array.from({ length: 90 }, (_, i) => {
    if (i < 30) return { date: day(i), pct: null, checks: 0, outages: 0, degraded: 0 };
    const outages = id === 'api' && i === 70 ? 6 : 0;
    const degraded = id === 'email' && i === 80 ? 3 : 0;
    return { date: day(i), pct: Math.round(((288 - outages) / 288) * 10000) / 100, checks: 288, outages, degraded };
  });
  const byComponent = Object.fromEntries(ids.map(([id]) => [id, series(id)]));
  const pct = Object.fromEntries(ids.map(([id]) => [id, id === 'api' ? 99.97 : 100]));
  return {
    generatedAt: now.toISOString(), overall: 'operational',
    components: ids.map(([id, name]) => ({ id, name, status: id === 'payments' ? 'unknown' : 'operational', checkedAt: now.toISOString() })),
    uptime: { days: 90, from: day(0), to: day(89), byComponent, pct },
    notices: {
      active: [],
      upcoming: [{ id: '00000000-0000-4000-8000-000000000001', kind: 'maintenance', title: 'Database upgrade', impact: 'maintenance', status: 'scheduled', components: ['api', 'signin'], startsAt: '2026-10-25T07:00:00Z', endsAt: '2026-10-25T07:30:00Z', resolvedAt: null, createdAt: '2026-10-18T15:00:00Z', updatedAt: '2026-10-18T15:00:00Z', updates: [{ status: 'scheduled', body: 'Sample notice: sign-in and sync may pause for up to 30 minutes.', at: '2026-10-18T15:00:00Z' }] }],
      recent: [{ id: '00000000-0000-4000-8000-000000000002', kind: 'incident', title: 'Slow sync', impact: 'minor', status: 'resolved', components: ['api'], startsAt: '2026-09-29T14:00:00Z', endsAt: null, resolvedAt: '2026-09-29T14:40:00Z', createdAt: '2026-09-29T14:05:00Z', updatedAt: '2026-09-29T14:40:00Z', updates: [{ status: 'resolved', body: 'Sample notice: sync is back to normal.', at: '2026-09-29T14:40:00Z' }, { status: 'investigating', body: 'Sample notice: changes are taking longer than usual to sync.', at: '2026-09-29T14:05:00Z' }] }],
    },
    subscribe: { enabled: false },
  };
}

function mockApi(req, res, path) {
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  if (req.method === 'GET' && path === '/api/v1/status') return json(200, { status: 'ok', version: '0.4.0', environment: 'local', gitSha: '000000000000', time: new Date().toISOString() });
  if (req.method === 'GET' && path === '/api/healthz') return json(200, { status: 'ok' });
  if (req.method === 'GET' && path === '/api/readyz') return json(200, { status: 'ready', checks: { database: { ok: true, ms: 1 } } });
  if (req.method === 'GET' && path === '/api/v1/public/status') return json(200, sampleStatus());
  if (req.method === 'GET' && path === '/api/v1/public/promotions/active') return json(200, { promotion: FALLBACK_PROMOTION });
  if (req.method === 'POST' && path === '/api/v1/public/enterprise-leads') return json(202, { ok: true });
  if (req.method === 'GET' && path === '/api/v1/public/signup') return json(200, { open: true, trialDays: 14, depositCents: 100 });
  return json(404, { error: { code: 'not_found', message: 'Not found' } });
}

function sendFile(res, file, headers) {
  const type = TYPES[extname(file).toLowerCase()];
  if (!type || !existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, { ...headers, 'Content-Type': type, 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'max-age=60' });
  res.end(readFileSync(file));
  return true;
}

/** A file inside `base` for a URL path, or null (no traversal, no dotfiles). */
function inside(base, rel) {
  if (/(^|\/)\./.test(rel)) return null;
  const p = normalize(join(base, rel));
  return p.startsWith(base + sep) ? p : null;
}

export function createSiteServer({ api = '', mock = false } = {}) {
  const headers = productionHeaders();
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://local');
    const path = decodeURIComponent(url.pathname);
    const notFound = () => { res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' }); res.end('Not found'); };
    if (path.startsWith('/api/')) {
      if (mock) return mockApi(req, res, path);
      if (!api) return notFound();
      const target = new URL(req.url, api);
      const fwd = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      fwd.on('error', () => { res.writeHead(502); res.end(); });
      return req.pipe(fwd);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (path === '/.well-known/security.txt') { res.writeHead(200, { ...headers, 'Content-Type': 'text/plain' }); return res.end(SECURITY_TXT); }
    if (path === '/sitemap.xml' || path === '/robots.txt') return sendFile(res, join(SITE, path.slice(1)), headers) || notFound();
    // Page URLs: /, /about, /features/wire-runs ...
    const page = fileForPath(path);
    if (page) return sendFile(res, join(SITE, page), headers) || notFound();
    if (path.startsWith('/site/')) { const f = inside(SITE, path.slice(6)); return (f && sendFile(res, f, headers)) || notFound(); }
    if (/^\/(js|css|icons|vendor)\//.test(path)) { const f = inside(APP, path.slice(1)); return (f && sendFile(res, f, headers)) || notFound(); }
    return notFound();
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
  const port = Number(arg('--port', 8090));
  const server = createSiteServer({ api: arg('--api', ''), mock: process.argv.includes('--mock-api') });
  server.listen(port, '127.0.0.1', () => console.log(`Fishtape site: http://localhost:${port}/  (clean URLs as on fishtapehq.com; /site/*.html as on staging)`));
}
