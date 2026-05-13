// Worker Portal — Service Worker (PWA + push)
// v4: dropped the server-rendered PDF page cache (it didn't work on Railway).
// Workers now render PDFs in-browser via /js/worker-pdf-viewer.js loading
// the pdfjs-dist bundle from /vendor/pdfjs/. Those assets get their own
// cache so they're available offline once seen.
const CACHE_NAME = 'ts-worker-v4';
const PDFJS_CACHE = 'ts-worker-pdfjs-v1';

// /vendor/pdfjs/pdf.min.js and /pdf.worker.min.js
const PDFJS_RE = /^\/vendor\/pdfjs\//;

// Install — cache core assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll([
        '/css/worker.css',
        '/js/worker.js',
        '/js/worker-pdf-viewer.js',
        '/images/logo-colour.jpg',
      ]);
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches but keep the dedicated pdfjs cache so the
// viewer assets remain instant on next visit.
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names
          .filter(function(name) { return name !== CACHE_NAME && name !== PDFJS_CACHE; })
          .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — split strategies:
//   - /vendor/pdfjs/* : cache-first (immutable bundle from node_modules)
//   - everything else : network-first (fallback to cache when offline)
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  const url = new URL(event.request.url);

  if (PDFJS_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(PDFJS_CACHE).then(function (cache) {
        return cache.match(event.request).then(function (hit) {
          if (hit) return hit;
          return fetch(event.request).then(function (response) {
            if (response.ok) {
              const clone = response.clone();
              cache.put(event.request, clone);
            }
            return response;
          });
        });
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response.ok) {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, responseClone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});

// Push — show shift reminder / generic notifications
self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'T&S Notification', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'T&S Notification';
  const options = {
    body: data.body || '',
    icon: '/images/logo-colour.jpg',
    badge: '/images/logo-colour.jpg',
    tag: data.type || 'general',
    data: { url: data.url || '/w/home' },
    vibrate: [180, 80, 180],
    requireInteraction: data.type === 'shift_reminder_24h',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Notification click — open or focus the worker portal at the right URL
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/w/home';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          c.navigate(url); return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
