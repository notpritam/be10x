// ABOUTME: be10x service worker — makes the board installable (PWA) and gives the app shell an offline
// fallback. Deliberately conservative: it NEVER touches /api (auth + live data always hit the network),
// serves navigations network-first, and treats Vite's hashed /assets as immutable (cache-first).
const VERSION = 'be10x-v1';
const SHELL = ['/', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin requests alone
  if (url.pathname.startsWith('/api/')) return; // never cache API / auth — always the network

  // App navigations: network-first (fresh app), fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('/', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/', { ignoreSearch: true })),
    );
    return;
  }

  // Hashed, immutable build assets: cache-first (fast + offline), then backfill the cache.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
            return res;
          }),
      ),
    );
    return;
  }

  // Other same-origin GETs (icon, manifest, fonts): network, fall back to cache when offline.
  e.respondWith(fetch(request).catch(() => caches.match(request)));
});
