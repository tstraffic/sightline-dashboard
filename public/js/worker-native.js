// Worker Portal — native app shell integration (Capacitor iOS).
//
// The iOS app is a Capacitor shell whose WKWebView loads this site directly
// (server.url in capacitor.config). Capacitor injects its JS bridge into the
// page, so `window.Capacitor` exists ONLY inside the native app — every hook
// here no-ops in normal browsers/PWA, where web-push (worker.js) handles push.
//
// Responsibilities:
//   1. Native push: request permission, register with APNs, POST the device
//      token to /w/notifications/push/device-token (session + CSRF).
//   2. Notification taps: navigate the webview to the notification's url.
//   3. Biometric lock: Face ID / Touch ID gate on cold start and when the
//      app returns to foreground after >5 minutes in the background.
(function () {
  'use strict';

  function isNative() {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }
  if (!isNative()) return;

  var plugins = window.Capacitor.Plugins || {};

  function csrfToken() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return m ? m.content : '';
  }

  var onLoginPage = location.pathname.indexOf('/w/login') === 0;

  // ---------------------------------------------------------------------
  // 1. Native push registration (APNs)
  // ---------------------------------------------------------------------
  function setupNativePush() {
    var Push = plugins.PushNotifications;
    if (!Push || onLoginPage) return; // needs an authed session to save the token

    Push.addListener('registration', function (tokenData) {
      fetch('/w/notifications/push/device-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': csrfToken() },
        credentials: 'same-origin',
        body: JSON.stringify({ token: tokenData.value, platform: window.Capacitor.getPlatform() }),
      }).catch(function () { /* retried next launch */ });
    });

    Push.addListener('registrationError', function (err) {
      console.log('[NativePush] registration error:', err && JSON.stringify(err));
    });

    // Tap on a notification (app closed or backgrounded) → deep-link.
    Push.addListener('pushNotificationActionPerformed', function (action) {
      try {
        var data = action.notification && action.notification.data;
        var url = data && data.url;
        if (url && url.indexOf('/') === 0) window.location.href = url;
      } catch (e) { /* ignore malformed payloads */ }
    });

    Push.requestPermissions().then(function (result) {
      if (result.receive === 'granted') Push.register();
    }).catch(function () { /* user said no — web-push prefs page still works */ });
  }

  // ---------------------------------------------------------------------
  // 2. Biometric lock (Face ID / Touch ID)
  // ---------------------------------------------------------------------
  var LOCK_AFTER_MS = 5 * 60 * 1000; // re-lock after 5 min backgrounded
  var overlay = null;

  function showLockOverlay() {
    if (overlay || onLoginPage) return;
    overlay = document.createElement('div');
    overlay.id = 'native-bio-lock';
    overlay.setAttribute('style',
      'position:fixed;inset:0;z-index:99999;background:#0f172a;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:16px;padding-top:env(safe-area-inset-top);');
    overlay.innerHTML =
      '<div style="width:64px;height:64px;border-radius:16px;background:#2B7FFF;display:flex;align-items:center;justify-content:center;">' +
      '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round">' +
      '<path d="M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M7 21H5a2 2 0 0 1-2-2v-2M17 21h2a2 2 0 0 0 2-2v-2"/>' +
      '<path d="M9 10v-.5a3 3 0 0 1 6 0V10M8 14c1.5 2 6.5 2 8 0"/><circle cx="9" cy="10" r=".5" fill="#fff"/><circle cx="15" cy="10" r=".5" fill="#fff"/>' +
      '</svg></div>' +
      '<p style="color:#e2e8f0;font-size:15px;margin:0;">Atomis Crew is locked</p>' +
      '<button id="native-bio-unlock" style="background:#2B7FFF;color:#fff;border:0;border-radius:10px;padding:12px 28px;font-size:15px;font-weight:600;">Unlock</button>';
    document.documentElement.appendChild(overlay);
    document.getElementById('native-bio-unlock').addEventListener('click', tryUnlock);
  }

  function hideLockOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function authenticateBiometric() {
    // Support either common biometric plugin; resolve(true) = unlocked.
    // If neither plugin is installed or biometry isn't set up, don't lock the
    // worker out — the session PIN login is still the real auth boundary.
    var Bio = plugins.BiometricAuthNative || plugins.BiometricAuth;
    if (Bio && Bio.authenticate) {
      return Bio.authenticate({
        reason: 'Unlock Atomis Crew',
        cancelTitle: 'Cancel',
        allowDeviceCredential: true,
        iosFallbackTitle: 'Use passcode',
      }).then(function () { return true; }, function () { return false; });
    }
    var NB = plugins.NativeBiometric;
    if (NB && NB.verifyIdentity) {
      return NB.verifyIdentity({ reason: 'Unlock Atomis Crew', title: 'Atomis Crew' })
        .then(function () { return true; }, function () { return false; });
    }
    return Promise.resolve(true); // no biometric plugin — skip the gate
  }

  var unlocking = false;
  function tryUnlock() {
    if (unlocking) return;
    unlocking = true;
    authenticateBiometric().then(function (ok) {
      unlocking = false;
      if (ok) hideLockOverlay();
    });
  }

  function setupBiometricLock() {
    if (onLoginPage) return;
    showLockOverlay();
    tryUnlock(); // prompt immediately on launch

    var App = plugins.App;
    if (!App) return;
    var backgroundedAt = 0;
    App.addListener('appStateChange', function (state) {
      if (!state.isActive) {
        backgroundedAt = Date.now();
      } else if (backgroundedAt && Date.now() - backgroundedAt > LOCK_AFTER_MS) {
        showLockOverlay();
        tryUnlock();
      }
    });
  }

  // ---------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setupBiometricLock();
      setupNativePush();
    });
  } else {
    setupBiometricLock();
    setupNativePush();
  }
})();
