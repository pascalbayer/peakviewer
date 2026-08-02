/**
 * Service worker.
 *
 * Only the app shell lives in the Cache API. Elevation tiles and summit
 * records are managed by the app in IndexedDB, where it can report sizes,
 * evict by region and let the user decide what to keep — none of which the
 * Cache API offers. Duplicating them here would double the storage for no gain.
 */

const SHELL = 'peakviewer-shell-1479605';
const FILES = [
  './',
  './index.html',
  './app.js',
  './app.css',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Shell: cache first, then refresh in the background. A peak finder is used
  // in places with no signal; waiting on the network to draw the UI is wrong.
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const live = fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || live;
    }),
  );
});
