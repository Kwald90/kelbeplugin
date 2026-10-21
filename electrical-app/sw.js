// Offline cache: app shell is cached on install, everything else on first use.
const CACHE = 'fishtape-v4-ux1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './css/tokens.css', './css/app.css', './css/canvas.css',
  './css/dashboard.css', './css/estimate-experience.css', './icons/icon.svg', './js/app.js',
  './js/lib/navigation.js', './js/lib/dashboard-actions.js'];

// put() one by one rather than addAll(): addAll fails the whole install ("Entry already
// exists") when the previous worker is writing the same file to this cache at that moment.
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: 'no-cache' }).then((res) => (res.ok ? c.put(u, res) : null)))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so updates land straight away; fall back to the cache offline.
// API traffic is never cached: it carries company data and the sync queue handles offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
});
