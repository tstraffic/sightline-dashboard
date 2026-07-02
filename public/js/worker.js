// Worker Portal — Client-side JavaScript

// Auto-dismiss flash messages after 5 seconds
document.addEventListener('DOMContentLoaded', function() {
  const flashMessages = document.querySelectorAll('[class*="bg-emerald-50"], [class*="bg-red-50"]');
  flashMessages.forEach(function(msg) {
    // Only auto-dismiss if it has a close button (flash messages)
    if (msg.querySelector('button')) {
      setTimeout(function() {
        msg.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        msg.style.opacity = '0';
        msg.style.transform = 'translateY(-10px)';
        setTimeout(function() { msg.remove(); }, 300);
      }, 5000);
    }
  });
});

// Confirm prompts for destructive actions
function confirmAction(message) {
  return confirm(message || 'Are you sure?');
}

// Register service worker for PWA + subscribe to push for shift reminders.
// Workers get a 24-hour heads-up push for every upcoming shift.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    // The SW used to live at /js/worker-sw.js (scope /js/), which meant it
    // never controlled /w/* pages — navigator.serviceWorker.ready hung
    // forever on the notifications page. Moved to /worker-sw.js so it
    // matches admin-sw's root scope. Unregister the legacy registration
    // so devices that already cached it don't end up with both.
    navigator.serviceWorker.getRegistrations().then(function(regs) {
      regs.forEach(function(r) {
        if (r.active && r.active.scriptURL.indexOf('/js/worker-sw.js') !== -1) {
          r.unregister();
        }
      });
    }).catch(function(){});

    navigator.serviceWorker.register('/worker-sw.js', { updateViaCache: 'none' })
      .then(function(registration) {
        registration.update();
        console.log('SW registered:', registration.scope);
        if ('PushManager' in window && 'Notification' in window) {
          setTimeout(function() { setupWorkerPush(registration); }, 1500);
        }
      })
      .catch(function(error) {
        console.log('SW registration failed:', error);
      });

    // When the SW activates a new version it posts SW_UPDATED. Reload so
    // the in-memory JS bundle matches the new HTML — otherwise the tab
    // keeps running the prior bundle until the user manually refreshes,
    // which was the root cause of the "ack doesn't show after signing"
    // report (old worker-offline-form.js w/o cache invalidation).
    // Guard: at most two SW-triggered reloads per 2 minutes per tab. During
    // a rolling deploy the old + new server instances briefly alternate
    // serving different SW bytes — each flip looks like an "update", and an
    // unguarded reload-on-update loops the page until the old instance
    // drains. sessionStorage survives reloads (per-tab), so it can count.
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (!e.data || e.data.type !== 'SW_UPDATED') return;
      try {
        var now = Date.now();
        var log = (sessionStorage.getItem('__sw_reloads') || '').split(',')
          .filter(Boolean).map(Number).filter(function (t) { return now - t < 120000; });
        if (log.length >= 2) return; // reload loop — stay on the current bundle
        log.push(now);
        sessionStorage.setItem('__sw_reloads', log.join(','));
        window.location.reload();
      } catch (err) { /* storage blocked — never risk a loop */ }
    });
  });
}

function urlBase64ToUint8Array(base64String) {
  var padding = '='.repeat((4 - base64String.length % 4) % 4);
  var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  var raw = atob(base64);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
  return out;
}

async function setupWorkerPush(registration) {
  // Inside the native iOS app (Capacitor shell) push goes via APNs —
  // worker-native.js handles it. WKWebView has no service-worker push, so
  // subscribing here would just throw.
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) return;
  // CSRF token from the layout's <meta name="csrf-token"> — every
  // state-changing POST to /w/notifications/push/* must include it or
  // the global CSRF middleware silently 403s the request.
  function csrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  }
  try {
    var existing = await registration.pushManager.getSubscription();
    if (existing) {
      await fetch('/w/notifications/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
        credentials: 'same-origin',
        body: JSON.stringify(existing),
      });
      return;
    }
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      if (location.pathname !== '/w/home') return;
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    var keyRes = await fetch('/w/notifications/push/vapid-key', { credentials: 'same-origin' });
    if (!keyRes.ok) return;
    var keyData = await keyRes.json();
    if (!keyData.publicKey) return;
    var sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
    });
    await fetch('/w/notifications/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
      credentials: 'same-origin',
      body: JSON.stringify(sub),
    });
    console.log('[WorkerPush] subscribed for shift reminders');
  } catch (e) {
    console.log('[WorkerPush] setup failed (silent):', e && e.message);
  }
}
