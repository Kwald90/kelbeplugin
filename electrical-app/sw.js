// Offline cache: app shell is cached on install, everything else on first use.
const CACHE = 'fishtape-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest', './css/tokens.css', './css/app.css', './css/canvas.css', './icons/icon.svg', './js/app.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so updates land straight away; fall back to the cache offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  // Never cache the API: responses are per user and company (no-store), and offline must
  // look offline rather than replay an old /me or sync page.
  if (new URL(req.url).pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (new URL(req.url).origin === location.origin || req.url.includes('cdnjs.cloudflare.com'))) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
});
