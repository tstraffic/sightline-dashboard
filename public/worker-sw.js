// Atomis Crew — Service Worker (PWA + push)
// v8: switch HTML fetch from network-first to stale-while-revalidate so
// cached pages return instantly on tap and refresh in the background. Bump
// CACHE_NAME so existing installs flush the old network-first cache.
const CACHE_NAME = 'atomis-worker-v5';
const VENDOR_CACHE = 'atomis-worker-vendor-v1';

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
        '/images/atomis-mark.svg',
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
//   - everything else : stale-while-revalidate (cached response returns
//     instantly; a network refresh runs in the background and updates the
//     cache for the next visit). Trade: first nav after a server-side data
//     change shows stale data once, then auto-refreshes on the next tap.
//     Pull-to-refresh remains for users who want fresh data right now.
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
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.match(event.request).then(function(cached) {
        const networkFetch = fetch(event.request).then(function(response) {
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        }).catch(function() {
          return cached;
        });
        return cached || networkFetch;
      });
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
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'Atomis Crew', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Atomis Crew';
  const options = {
    body: data.body || '',
    icon: '/images/atomis-icon-light-192.png',
    badge: '/images/atomis-icon-light-192.png',
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
