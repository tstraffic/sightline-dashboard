// Atomis Crew — Service Worker (PWA + push)
//
// v9: mirror the admin SW (public/admin-sw.js) — network-only for HTML so
// post-write GETs never return a stale render (the previous
// stale-while-revalidate strategy caused signed SOP/SWMS pages to still
// show "not acknowledged" after a successful POST). Static assets stay
// cache-first because they're versioned via ?v= in the link tags.
//
// On activate we also message all open clients so they reload — without
// this the user's current tab keeps running the prior bundle of JS even
// after the new SW takes over.

const CACHE_NAME = 'atomis-worker-v9';
const VENDOR_CACHE = 'atomis-worker-vendor-v1';

// PDF.js, docx-preview, jszip, Motion One — versioned bundles, safe to
// keep cache-first across SW upgrades.
const VENDOR_RE = /^\/vendor\/(pdfjs|docx-preview|jszip|motion)\//;

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
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

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name !== CACHE_NAME && name !== VENDOR_CACHE; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      // Tell every open client to reload so the new HTML / JS bundle is
      // loaded — otherwise the user keeps running the prior in-memory
      // bundle until they manually refresh.
      return self.clients.matchAll({ type: 'window' }).then(function (clients) {
        clients.forEach(function (c) {
          try { c.postMessage({ type: 'SW_UPDATED' }); } catch (e) {}
        });
      });
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (!req.url.startsWith(self.location.origin)) return;

  const url = new URL(req.url);

  // Vendor bundles — cache-first, immutable.
  if (VENDOR_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(VENDOR_CACHE).then(function (cache) {
        return cache.match(req).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res.ok) cache.put(req, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  // Static assets — cache-first. Bust by changing ?v= on the link tag.
  if (/\.(css|js|jpg|jpeg|png|svg|ico|woff2?)(\?.*)?$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(function (cached) {
        if (cached) return cached;
        return fetch(req).then(function (res) {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(function (cache) { cache.put(req, clone); });
          }
          return res;
        });
      })
    );
    return;
  }

  // HTML pages — network-only so writes are immediately visible. No
  // offline cache for HTML by design (we already have offline form queue
  // for writes; reads need to be fresh).
  const accept = req.headers.get('accept') || '';
  if (accept.indexOf('text/html') !== -1) {
    event.respondWith(fetch(req));
    return;
  }

  // Everything else — network passthrough.
  event.respondWith(fetch(req));
});

// BackgroundSync — Chrome/Edge call this when the device goes back online
// while the page is closed. We can't reach IndexedDB-via-FormData from
// inside the worker context easily, so we just notify any open clients
// to retry their queue (and the page's `online` event handler picks up
// the same job if no client is open).
self.addEventListener('sync', function (event) {
  if (event.tag !== 'wq-flush') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      list.forEach(function (c) { try { c.postMessage({ kind: 'wq-flush' }); } catch (e) {} });
    })
  );
});

// Push — show shift reminder / generic notifications
self.addEventListener('push', function (event) {
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
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/w/home';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const c of list) {
        if (c.url.indexOf(self.location.origin) === 0 && 'focus' in c) {
          c.navigate(url); return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
