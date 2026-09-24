// Bump this on every deploy so the browser detects a byte-diff and installs a new SW
const CACHE_NAME = 'my-app-cache-v-1.19';

// Paths are relative to sw.js so precaching also works from a sub-folder (e.g. /my-notepad-v2/)
const urlsToCache = [
  './',
  './index.html',
  './terms.html',
  './bootstrap.min.css',
  './bootstrap.bundle.min.js',
  './jquery-4.0.0.min.js',
  './popper.min.js',
  './pwa-update.js',
  './google-sync.js',
  './app.js',
  './manifest.json',
  './favicon.svg',
  './icon192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Cache files one by one: a single missing/404 file must not abort the
      // whole install, otherwise the new SW never activates and the update
      // button in the page never appears
      Promise.all(
        urlsToCache.map((url) =>
          cache.add(url).catch((err) => console.warn('Precache failed:', url, err))
        )
      )
    )
  );
  // Don't auto-activate; wait for the page to say "go" via SKIP_WAITING
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      // Take control of already-open pages only after old caches are cleaned up
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

// Listen for the page telling this waiting worker to take over now
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
