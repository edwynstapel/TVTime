/**
 * TV Time Service Worker
 * Caches core app files for offline use and fast loading.
 */

var CACHE_NAME = 'tvtime-v5';
var CORE_FILES = [
    'index.html',
    'css/style.css',
    'js/store.js',
    'js/shows-data.js',
    'js/tmdb.js',
    'js/anthropic.js',
    'js/app.js',
    'manifest.json',
    'icon-192.png',
    'icon-512.png'
];

// Install: cache core files
self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            console.log('[SW] Caching core files');
            return cache.addAll(CORE_FILES).catch(function(err) {
                console.warn('[SW] Cache addAll error (some files may be missing):', err);
            });
        })
    );
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
    event.waitUntil(
        caches.keys().then(function(keys) {
            return Promise.all(
                keys.filter(function(k) { return k !== CACHE_NAME; })
                    .map(function(k) { return caches.delete(k); })
            );
        })
    );
    self.clients.claim();
});

// Fetch: network-first with cache fallback
self.addEventListener('fetch', function(event) {
    // Only handle GET requests
    if (event.request.method !== 'GET') return;

    // Don't intercept TMDB API or DeepSeek API calls — let them go to network
    var url = event.request.url;
    if (url.indexOf('api.themoviedb.org') !== -1 ||
        url.indexOf('api.deepseek.com') !== -1 ||
        url.indexOf('image.tmdb.org') !== -1) {
        return;
    }

    event.respondWith(
        fetch(event.request).then(function(response) {
            // Cache successful responses
            if (response.status === 200) {
                var responseClone = response.clone();
                caches.open(CACHE_NAME).then(function(cache) {
                    cache.put(event.request, responseClone);
                });
            }
            return response;
        }).catch(function() {
            // Offline: serve from cache
            return caches.match(event.request).then(function(cached) {
                return cached || new Response('Offline — page not cached', { status: 503 });
            });
        })
    );
});
