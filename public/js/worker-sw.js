// Worker Portal — Service Worker (PWA + push)
// v3: PDF page PNGs get their own cache-first bucket so they survive the
// next install/activate cycle and don't churn the main HTML cache.
const CACHE_NAME = 'ts-worker-v3';
const PDF_CACHE = 'ts-worker-pdf-pages-v1';
// Cap the PDF cache so a worker who views lots of SWMS doesn't blow out
// browser storage.
const PDF_CACHE_MAX = 200;
const PDF_CACHE_TRIM = 50;

// PNG pages served by the safety-pdf-cache flow. URL pattern:
//   /w/safety/(swms|sop-register|updates|toolboxes)/<id>/pages/<n>.png?v=...
//   /w/hr/tfn/<id>/pages/<n>.png?v=...
// Each URL is immutable per cacheKey (the ?v= query) so cache-first is safe.
const PDF_PAGE_RE = /\/w\/(?:safety\/(?:swms|sop-register|updates|toolboxes)\/\d+|hr\/tfn\/\d+)\/pages\/\d+\.png(?:\?|$)/;

// Install — cache core assets
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll([
        '/css/worker.css',
        '/js/worker.js',
        '/images/logo-colour.jpg',
      ]);
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches but keep the dedicated PDF page cache so
// previously rendered docs are still instant on next visit.
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names
          .filter(function(name) { return name !== CACHE_NAME && name !== PDF_CACHE; })
          .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// LRU-ish trim: when the page cache crosses the cap, drop the oldest N
// entries (the order returned by cache.keys() is insertion order).
function trimPdfCache(cache) {
  cache.keys().then(function (keys) {
    if (keys.length <= PDF_CACHE_MAX) return;
    const overflow = keys.length - (PDF_CACHE_MAX - PDF_CACHE_TRIM);
    for (let i = 0; i < overflow; i++) {
      try { cache.delete(keys[i]); } catch (e) { /* best effort */ }
    }
  }).catch(function () { /* ignore */ });
}

// Fetch — split strategies:
//   - PDF page PNGs:   cache-first (immutable per ?v=cacheKey)
//   - everything else: network-first (always try network, fallback to cache)
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  const url = new URL(event.request.url);

  if (PDF_PAGE_RE.test(url.pathname + url.search) || PDF_PAGE_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(PDF_CACHE).then(function (cache) {
        return cache.match(event.request).then(function (hit) {
          if (hit) return hit;
          return fetch(event.request).then(function (response) {
            if (response.ok) {
              const clone = response.clone();
              cache.put(event.request, clone);
              trimPdfCache(cache);
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
