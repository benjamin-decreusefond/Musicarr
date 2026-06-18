/* Self-destructing service worker.
 *
 * Musicarr used to ship an offline service worker, but a server you can only
 * reach over the network has no meaningful offline mode — and the worker caused
 * cover-art and stale-asset issues. This replacement exists only to cleanly
 * remove any previously-installed worker from browsers that still have it:
 * it deletes all caches, unregisters itself, and reloads open tabs so they
 * fetch fresh assets directly from the network. The browser fetches this file
 * on its normal update check, so existing clients self-heal on next load.
 */
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch { /* ignore */ }
    try { await self.registration.unregister(); } catch { /* ignore */ }
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      try { client.navigate(client.url); } catch { /* ignore */ }
    }
  })());
});

// Don't intercept anything — let every request hit the network normally.
