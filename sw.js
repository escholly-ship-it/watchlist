/* ============================================
   WATCHLIST — Service Worker (Offline App Shell + Runtime Cache)
   ============================================ */

// v3 (WL-33): /sync nicht mehr aus dem Cache; alter Laufzeit-Cache faellt weg
const CACHE_VERSION = 'v3';
const SHELL_CACHE = `watchlist-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `watchlist-runtime-${CACHE_VERSION}`;

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './sync-merge.js',
  './app.js',
  './manifest.json',
  './favicon-16.png',
  './favicon-32.png',
  './icon-192.png',
  './icon-512.png',
  './icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL_ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Navigation requests (e.g. / or /?key=...) -> Network-first, fallback to cached index.html
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put('./index.html', copy));
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(SHELL_CACHE);
          return (
            (await cache.match('./index.html', { ignoreSearch: true })) ||
            (await cache.match('./', { ignoreSearch: true }))
          );
        })
    );
    return;
  }

  // 2. Same-origin static assets (CSS, JS, Icons, Manifest) -> Network-first, fallback to cache
  //    (so a new index.html never runs with an old app.js; cache: 'no-cache' umgeht den 10-Minuten-HTTP-Cache von Pages)
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        try {
          const response = await fetch(request, { cache: 'no-cache' });
          if (response && response.ok) {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        } catch (_) {
          return (await cache.match(request, { ignoreSearch: true })) || new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  // 3. Google Fonts & TMDB Poster/Logo images -> Cache-First (with background populate)
  if (
    url.hostname === 'fonts.googleapis.com' ||
    url.hostname === 'fonts.gstatic.com' ||
    url.hostname === 'image.tmdb.org'
  ) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response && (response.ok || response.type === 'opaque')) {
            cache.put(request, response.clone()).catch(() => {});
          }
          return response;
        } catch (_) {
          return new Response('', { status: 504 });
        }
      })
    );
    return;
  }

  // 4. Worker GET requests (/magazine) -> Network-First with runtime cache fallback for offline reading.
  //    WL-33: /sync nie aus dem Cache — ein alter Server-Stand offline darf
  //    nicht als aktuell gelten. Ohne respondWith geht die Anfrage ans Netz.
  if (url.hostname.endsWith('.workers.dev') && url.pathname === '/sync') return;
  if (url.hostname.endsWith('.workers.dev')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.open(RUNTIME_CACHE).then((c) => c.match(request));
          return (
            cached ||
            new Response(JSON.stringify({ error: 'Offline' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        })
    );
  }
});
