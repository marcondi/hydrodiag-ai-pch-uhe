// HydroDiag AI — Dev Service Worker Replacement (Purges stale dev-sw.js?dev-sw CacheFirst cache)
const SW_VERSION = 'hydrodiag-dev-sw-v4.2-purge';

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
        // ignore
      }
      await self.clients.claim();
      try {
        const windowClients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true,
        });
        await self.registration.unregister();
        for (const client of windowClients) {
          client.postMessage({ type: 'HYDRODIAG_SW_UPDATED', version: SW_VERSION });
          if ('navigate' in client) {
            client.navigate(client.url).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
    })()
  );
});
