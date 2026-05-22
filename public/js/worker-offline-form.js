// Wraps any <form data-offline-form> in the worker portal so it tolerates
// flaky network. On submit:
//   1. Try fetch(POST, formData) with a 6s timeout (long enough to cover
//      a typical mobile-network handshake but short enough that the
//      worker isn't staring at a spinner forever).
//   2. If the response is OK or a redirect, follow the original form's
//      success path (data-success-url, or the redirect's Location, or
//      a sensible default).
//   3. If it fails (offline / DNS / timeout / 5xx), enqueue via
//      WorkerOfflineQueue.enqueue(...) and show a toast + redirect to
//      the success URL so the worker isn't blocked.
//
// Markup contract:
//   <form data-offline-form
//         data-offline-scope="prestart"        (label for the queue banner)
//         data-success-url="/w/forms?ok=1"     (where to go after success)
//         action="/w/forms/prestart" method="POST" ...>
//
// Forms without data-offline-form behave exactly as before.

(function () {
  'use strict';

  var TIMEOUT_MS = 6000;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error('timeout after ' + ms + 'ms'));
      }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); },
                   function (e) { clearTimeout(t); reject(e); });
    });
  }

  // Show a transient toast at the bottom of the screen.
  function toast(text, kind) {
    var el = document.createElement('div');
    el.className = 'wq-toast wq-toast-' + (kind || 'info');
    el.textContent = text;
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { try { el.remove(); } catch (e) {} }, 250);
    }, 3500);
  }

  function injectCss() {
    if (document.getElementById('wq-toast-css')) return;
    var s = document.createElement('style');
    s.id = 'wq-toast-css';
    s.textContent = [
      '.wq-toast {',
      '  position: fixed; left: 12px; right: 12px; bottom: calc(80px + env(safe-area-inset-bottom, 0px));',
      '  z-index: 1000; padding: 12px 14px; border-radius: 12px;',
      '  background: rgba(10,22,40,0.96); color: #fff; font-size: 0.85rem; font-weight: 600;',
      '  border: 1px solid rgba(255,255,255,0.1);',
      '  box-shadow: 0 10px 30px rgba(0,0,0,0.4);',
      '  opacity: 0; transform: translateY(8px); transition: opacity 0.2s, transform 0.2s;',
      '  max-width: 520px; margin: 0 auto;',
      '}',
      '.wq-toast.show { opacity: 1; transform: translateY(0); }',
      '.wq-toast-success { border-color: rgba(16,185,129,0.35); color: #6EE7B7; }',
      '.wq-toast-info    { border-color: rgba(43,127,255,0.35); color: #93C5FD; }',
      '.wq-toast-warn    { border-color: rgba(245,158,11,0.35); color: #FCD34D; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  // Delete every cached response for `url` across all CacheStorage caches.
  // Used after a successful POST so the post-redirect GET fetches fresh
  // rather than getting the stale-while-revalidate hit from worker-sw.js.
  function invalidateCache(url) {
    if (typeof caches === 'undefined' || !caches || !caches.keys) {
      return Promise.resolve();
    }
    return caches.keys().then(function (names) {
      return Promise.all(names.map(function (name) {
        return caches.open(name).then(function (cache) {
          return cache.delete(url, { ignoreSearch: false, ignoreVary: true })
            .catch(function () {});
        });
      }));
    }).catch(function () {});
  }

  function adopt(form) {
    if (form._wqAdopted) return;
    form._wqAdopted = true;

    form.addEventListener('submit', function (ev) {
      // Allow forms to bypass when ?nooff=1 is in the URL (debugging) and
      // when an existing submitter has data-no-offline on it.
      if (location.search.indexOf('nooff=1') !== -1) return;
      if (ev.submitter && ev.submitter.hasAttribute('data-no-offline')) return;

      ev.preventDefault();
      injectCss();

      var url = form.getAttribute('action') || location.pathname;
      var method = (form.getAttribute('method') || 'POST').toUpperCase();
      var scope = form.getAttribute('data-offline-scope') || 'form';
      var successUrl = form.getAttribute('data-success-url') || form.dataset.successUrl || '/w/home';

      var fd = new FormData(form);

      // The server's global body parser is express.urlencoded() + express.json()
      // — multipart is only handled per-route by multer. If we POST FormData
      // here, fetch sends multipart/form-data and the server sees req.body = {}
      // (silently dropping signature_data, CSRF, everything). Convert to
      // URLSearchParams so the request is application/x-www-form-urlencoded,
      // matching what a native form submit would send. Forms that actually
      // upload files keep FormData so multer can parse them.
      var hasFile = form.querySelector('input[type="file"]');
      var body;
      var headers;
      if (hasFile) {
        body = fd;
        headers = undefined;
      } else {
        var params = new URLSearchParams();
        fd.forEach(function (value, key) {
          // Skip File entries entirely (shouldn't happen here, but defensive).
          if (typeof value === 'string') params.append(key, value);
        });
        body = params;
        headers = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
      }

      // Disable the submit button briefly so we don't double-fire.
      var submitter = ev.submitter || form.querySelector('button[type="submit"], input[type="submit"]');
      var prevDisabled = false;
      if (submitter) { prevDisabled = submitter.disabled; submitter.disabled = true; }

      withTimeout(fetch(url, {
        method: method,
        body: body,
        headers: headers,
        credentials: 'same-origin',
        redirect: 'follow',
      }), TIMEOUT_MS).then(function (res) {
        if (res.ok || res.redirected || res.status === 302 || res.status === 303) {
          var dest = res.redirected ? res.url : successUrl;
          // The worker SW uses stale-while-revalidate, so a navigation to
          // `dest` right after a write would re-render the pre-write page
          // (e.g. SOP detail still showing "not acknowledged" after a
          // successful sign). Drop the cached entry for dest first so the
          // landing render reflects the new server state.
          var bust = invalidateCache(dest);
          var go = function () {
            if (window.WorkerSubmitSuccess) {
              window.WorkerSubmitSuccess.show({ redirect: dest });
            } else {
              if (window.WorkerHaptics) window.WorkerHaptics.success();
              window.location.assign(dest);
            }
          };
          // Don't block the user UI on cache cleanup. The bust resolves
          // fast in practice (<50ms); race it with a short timeout.
          var raced = Promise.race([bust, new Promise(function (r) { setTimeout(r, 250); })]);
          raced.then(go);
          return;
        }
        // Server-side rejection — surface the response normally so the
        // worker sees the validation error. Replace the page body with
        // the response (HTML).
        if (window.WorkerHaptics) window.WorkerHaptics.error();
        return res.text().then(function (html) {
          document.open(); document.write(html); document.close();
        });
      }).catch(function (err) {
        // Network / timeout / offline — queue it.
        if (!window.WorkerOfflineQueue) {
          if (submitter) submitter.disabled = prevDisabled;
          // Last resort: fall back to native form submit so we don't lose data.
          form.submit();
          return;
        }
        window.WorkerOfflineQueue.enqueue({ url: url, method: method, formData: fd, scope: scope })
          .then(function () {
            if (window.WorkerHaptics) window.WorkerHaptics.warning();
            toast("Saved offline — we'll submit it when you're back online.", 'success');
            // Don't show the success overlay for the queued path —
            // the worker hasn't actually submitted yet. Toast + redirect.
            setTimeout(function () { window.location.assign(successUrl); }, 800);
          })
          .catch(function (e) {
            console.error('[wq] enqueue failed:', e);
            if (window.WorkerHaptics) window.WorkerHaptics.error();
            toast("Couldn't save offline. Check your signal and try again.", 'warn');
            if (submitter) submitter.disabled = prevDisabled;
          });
      });
    });
  }

  function init() {
    var forms = document.querySelectorAll('form[data-offline-form]');
    for (var i = 0; i < forms.length; i++) adopt(forms[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.WorkerOfflineForm = { init: init, adopt: adopt };
})();
