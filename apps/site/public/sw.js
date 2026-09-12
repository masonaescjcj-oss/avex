/**
 * The service worker, and the argument for how little it does.
 *
 * Its job is to make the dashboard installable and to leave something on the screen when the
 * phone has no signal. It is not a cache layer, and the restraint is deliberate: this project
 * has already spent a day on "is the new build actually live", and a service worker is the
 * classic way to make that question permanently unanswerable — a merchant reloading a page
 * that a worker keeps serving from last week has no way to tell, and neither does anybody
 * helping them.
 *
 * So the rules are:
 *
 *   **Network first, always.** The cached copy is only ever reached when the network fails.
 *   An open dashboard is never a stale dashboard.
 *
 *   **Only this origin's own shell.** The API is another origin and is never touched — not
 *   cached, not intercepted, not even passed through. A payment that looks like it arrived
 *   because a worker replayed yesterday's answer is the worst bug this file could have.
 *
 *   **Nothing else is intercepted at all.** Requests we do not handle return without calling
 *   `respondWith`, so the browser fetches them itself with no worker in the path — which is
 *   both faster than proxying and impossible to get wrong.
 *
 *   **A new worker takes over at once.** `skipWaiting` and `clients.claim`, so a deploy is not
 *   waiting behind every tab the merchant has open.
 */

/**
 * Bumped by the build, so a deploy cannot reuse the last one's entries.
 *
 * The placeholder is replaced in `deploy/build-static.mjs`; if it somehow is not, the literal
 * string is still a perfectly good cache name — one that simply never changes, which degrades
 * to "the offline copy may be old" and not to anything worse, because of the network-first
 * rule above.
 */
const CACHE = 'avex-shell-__BUILD__';

/** The one document worth keeping, and the icons the installed app draws itself with. */
const SHELL = ['/dashboard', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Failure here is not fatal: without a warm cache the worker simply has no offline
      // fallback yet, and the next successful load fills it.
      await cache.addAll(SHELL).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isShell =
    request.mode === 'navigate'
      ? url.pathname === '/dashboard' || url.pathname === '/dashboard.html'
      : url.pathname.startsWith('/icons/');
  if (!isShell) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request);
        /**
         * Only a real answer is kept. Caching a 404 or a 500 would mean an outage that
         * outlives itself: the worker would go on serving the error after the server recovered.
         */
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          await cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
