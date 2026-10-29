// HydroDiag AI — Service Worker with Automatic Stale Workbox Cache Purge (Preserves PDF Binary Vault)
const SW_VERSION = 'hydrodiag-sw-v4.2-network-first';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter((name) => !name.includes('pdf_binary_cache'))
            .map((name) => caches.delete(name))
        );
      } catch {
        // ignore cache deletion errors
      }
      await self.clients.claim();
      try {
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        for (const client of windowClients) {
          client.postMessage({ type: 'HYDRODIAG_SW_UPDATED', version: SW_VERSION });
          if ('navigate' in client) {
            client.navigate(client.url).catch(() => {});
          }
        }
      } catch {
        // ignore navigation errors
      }
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname === 'hydrodiag.local') return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || Response.error();
    })
  );
});
