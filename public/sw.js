'use strict';
/**
 * Service worker: just enough to make Rivaesa installable (a PWA manifest
 * alone isn't installable in most browsers without an active service
 * worker) and to keep the app shell -- not exam content -- available when
 * a page navigation happens to land with no connection.
 *
 * Deliberately conservative: every dynamic route (anything not under
 * /static/, plus the manifest/offline page themselves) is session- and
 * CSRF-bound, so it is never cached or served from cache here -- see
 * public/js/attempt.js for the app's actual offline handling during an
 * exam (auto-save retry/backoff), which this service worker does not
 * duplicate or interfere with.
 */

const CACHE_NAME = 'rivaesa-shell-v1';
const PRECACHE_URLS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/static/icons/icon-192.png',
  '/static/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never intercept POSTs (answer saves, form submits)

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Static assets: cache-first. Every URL already carries a per-deploy
  // ?v= (see src/config.js#assetVersion), so a cached entry is never
  // stale -- a new deploy is a new URL, not a cache-invalidation problem.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      }))
    );
    return;
  }

  // Page navigations: always prefer the network (this app is entirely
  // server-rendered and session-dependent), falling back to a static
  // offline page only when the network is genuinely unreachable.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  // Everything else (API calls, the manifest, etc.) -- just let it through.
});
