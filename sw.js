const CACHE_NAME = 'my-notepad';
const ASSETS = [
    './',
    './index.html',
    './app.js',
    './manifest.json',
    './bootstrap.min.css',
    './bootstrap.bundle.min.js',
    './jquery-4.0.0.min.js',
    './popper.min.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then((response) => {
            return response || fetch(e.request);
        })
    );
});
