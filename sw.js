// Bump this on every deploy so the browser detects a byte-diff and installs a new SW
const CACHE_NAME = 'my-app-cache-v-1.00';

const urlsToCache = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
  // Don't auto-activate; wait for the page to say "go" via SKIP_WAITING
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
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