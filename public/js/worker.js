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
