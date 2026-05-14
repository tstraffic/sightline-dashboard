// Worker Portal — Service Worker (PWA + push)
// v6: adds client-side docx renderer assets (docx-preview + jszip), served
// from /vendor/docx-preview/ and /vendor/jszip/. They share the dedicated
// vendor cache with pdfjs so the worker can render Word docs offline once
// they've been loaded once.
const CACHE_NAME = 'ts-worker-v18';
const VENDOR_CACHE = 'ts-worker-vendor-v1';

// All client-side renderer assets (pdfjs, docx-preview, jszip). All are
// immutable once shipped, so cache-first is safe.
const VENDOR_RE = /^\/vendor\/(pdfjs|docx-preview|jszip|motion)\//;

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

// Activate — clean up old caches (including the prior pdfjs cache version
// since the path layout shifted).
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names
          .filter(function(name) { return name !== CACHE_NAME && name !== VENDOR_CACHE; })
          .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — split strategies:
//   - /vendor/{pdfjs,docx-preview,jszip}/* : cache-first (immutable bundles)
//   - everything else : network-first (fallback to cache when offline)
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  const url = new URL(event.request.url);

  if (VENDOR_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then(function (cache) {
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

// BackgroundSync — Chrome/Edge call this when the device goes back online
// while the page is closed. We can't reach IndexedDB-via-FormData from
// inside the worker context easily, so we just notify any open clients
// to retry their queue (and the page's `online` event handler picks up
// the same job if no client is open).
self.addEventListener('sync', function(event) {
  if (event.tag !== 'wq-flush') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      list.forEach(function (c) { try { c.postMessage({ kind: 'wq-flush' }); } catch (e) {} });
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
