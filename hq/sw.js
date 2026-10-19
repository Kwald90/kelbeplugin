// HQ's own service worker, scoped to /hq/. It exists so the app's offline worker (scope /)
// never controls HQ pages: that one caches every GET, and HQ responses carry data about
// every company. This worker has no fetch handler, so HQ requests always go to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // Drop anything the app worker cached from /hq/ or /api/hq/ before this one took over.
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const path = new URL(req.url).pathname;
        if (path.startsWith('/hq/') || path.startsWith('/api/hq/') || path.startsWith('/api/v1/auth/')) await cache.delete(req);
      }
    }
    await self.clients.claim();
  })());
});
