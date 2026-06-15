// Atomis Dashboard - Client-side JavaScript

// ===== CSRF Token Helper =====
var csrfMeta = document.querySelector('meta[name="csrf-token"]');
var csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';
function csrfHeaders(extra) {
  var h = { 'x-csrf-token': csrfToken };
  if (extra) { for (var k in extra) h[k] = extra[k]; }
  return h;
}

// ===== Chart.js dark theme defaults =====
if (typeof Chart !== 'undefined') {
  Chart.defaults.color = 'rgba(255,255,255,0.55)';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.08)';
}

// ===== Auto-submit filter forms on change =====
(function() {
  // Auto-submit GET forms when selects, checkboxes, or date inputs change
  document.querySelectorAll('form[method="GET"] select, form[method="GET"] input[type="checkbox"], form[method="GET"] input[type="date"]').forEach(function(el) {
    el.addEventListener('change', function() { this.form.submit(); });
  });
  // For text search inputs in GET forms, submit on Enter (default) and after typing stops (500ms debounce)
  var debounceTimer;
  document.querySelectorAll('form[method="GET"] input[type="text"]').forEach(function(el) {
    el.addEventListener('input', function() {
      var form = this.form;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function() { form.submit(); }, 600);
    });
  });
})();

// ===== Sidebar Scroll Persistence =====
// The RESTORE half of this lives inline in views/partials/sidebar.ejs so it
// runs synchronously before the browser paints (eliminating the "jump to top
// then snap back" flash). This block is the SAVE half — runs when app.js
// loads at end-of-body.
(function() {
  var nav = document.querySelector('.sidebar-nav');
  if (!nav) return;

  // Save scroll position before navigating away
  window.addEventListener('beforeunload', function() {
    sessionStorage.setItem('sidebar-scroll', nav.scrollTop);
  });

  // Also save on every scroll (debounced) for instant accuracy
  var scrollTimer;
  nav.addEventListener('scroll', function() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(function() {
      sessionStorage.setItem('sidebar-scroll', nav.scrollTop);
    }, 100);
  }, { passive: true });
})();

// ===== Mobile Sidebar Toggle =====
(function() {
  const toggle = document.getElementById('sidebar-toggle');
  const closeBtn = document.getElementById('sidebar-close');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  if (sidebar && backdrop) {
    function openSidebar() {
      sidebar.classList.add('sidebar-open');
      backdrop.classList.add('backdrop-visible');
      document.body.style.overflow = 'hidden';
    }

    function closeSidebar() {
      sidebar.classList.remove('sidebar-open');
      backdrop.classList.remove('backdrop-visible');
      document.body.style.overflow = '';
    }

    if (toggle) {
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        if (sidebar.classList.contains('sidebar-open')) {
          closeSidebar();
        } else {
          openSidebar();
        }
      });
    }

    // Close button inside sidebar
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeSidebar();
      });
    }

    // Close on backdrop tap
    backdrop.addEventListener('click', closeSidebar);

    // Close on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeSidebar();
    });

    // Close sidebar when a nav link is tapped (mobile)
    sidebar.querySelectorAll('nav a').forEach(function(link) {
      link.addEventListener('click', function() {
        if (window.innerWidth < 1024) {
          closeSidebar();
        }
      });
    });

    // Close sidebar on window resize to desktop
    window.addEventListener('resize', function() {
      if (window.innerWidth >= 1024) {
        closeSidebar();
      }
    });

    // Handle swipe-to-close on mobile
    var touchStartX = 0;
    sidebar.addEventListener('touchstart', function(e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    sidebar.addEventListener('touchend', function(e) {
      var touchEndX = e.changedTouches[0].clientX;
      var diff = touchStartX - touchEndX;
      // Swipe left to close (>80px threshold)
      if (diff > 80 && window.innerWidth < 1024) {
        closeSidebar();
      }
    }, { passive: true });
  }
})();

// ===== Auto-dismiss flash messages after 5 seconds =====
document.querySelectorAll('[data-auto-dismiss]').forEach(el => {
  setTimeout(() => el.remove(), 5000);
});

// ===== Confirm before delete actions =====
document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', (e) => {
    if (!confirm(form.dataset.confirm || 'Are you sure?')) {
      e.preventDefault();
    }
  });
});

// ===== Form Submit Spinner (prevent double-submit) =====
document.addEventListener('submit', function(e) {
  var form = e.target;
  if (form.tagName !== 'FORM') return;
  // Skip filter/search forms (GET) and inline status selects
  if (form.method && form.method.toUpperCase() === 'GET') return;
  if (form.classList.contains('no-spinner')) return;
  // If an inline onsubmit (e.g. confirm dialog cancel) already cancelled the
  // submit, do NOT show the spinner — otherwise the button stays in
  // "Saving…" state forever because no navigation happens.
  if (e.defaultPrevented) return;
  if (form.classList.contains('form-submitting')) { e.preventDefault(); return; }
  form.classList.add('form-submitting');
  // Safety net: if for any reason the page doesn't navigate within 15s
  // (e.g. an XHR-style handler quietly took over), drop the class so the
  // button isn't stuck spinning.
  setTimeout(function () { form.classList.remove('form-submitting'); }, 15000);
});

// ===== Tab navigation (for job detail page) =====
function initTabs() {
  const tabLinks = document.querySelectorAll('[data-tab]');
  const tabPanels = document.querySelectorAll('[data-tab-panel]');

  if (tabLinks.length === 0) return;

  function activateTab(tabName, animate) {
    tabLinks.forEach(link => {
      const isActive = link.dataset.tab === tabName;
      link.classList.toggle('border-brand-600', isActive);
      link.classList.toggle('text-brand-700', isActive);
      link.classList.toggle('border-transparent', !isActive);
      link.classList.toggle('text-gray-500', !isActive);
    });
    tabPanels.forEach(panel => {
      const isTarget = panel.dataset.tabPanel === tabName;
      if (isTarget) {
        panel.classList.remove('hidden');
        if (animate) {
          // Re-trigger the CSS animation by removing/re-adding the element briefly
          panel.style.animation = 'none';
          panel.offsetHeight; // force reflow
          panel.style.animation = '';
        }
      } else {
        panel.classList.add('hidden');
      }
    });
  }

  tabLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = link.dataset.tab;
      activateTab(tabName, true);
      history.replaceState(null, '', '#' + tabName);
    });
  });

  // Activate from hash or default to first tab
  const hash = window.location.hash.slice(1);
  const validTab = [...tabLinks].find(l => l.dataset.tab === hash);
  activateTab(validTab ? hash : tabLinks[0].dataset.tab, false);
}

document.addEventListener('DOMContentLoaded', initTabs);

// ===== Animated KPI Counter =====
function initCountUp() {
  const counters = document.querySelectorAll('.kpi-number[data-count]');
  if (counters.length === 0) return;

  const observer = new IntersectionObserver(function(entries) {
    entries.forEach(function(entry) {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      if (el.dataset.counted) return;
      el.dataset.counted = '1';

      const target = parseInt(el.dataset.count, 10);
      if (isNaN(target) || target === 0) {
        el.textContent = '0';
        return;
      }

      const duration = Math.min(1200, Math.max(400, target * 40));
      const startTime = performance.now();

      function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out cubic
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(eased * target);
        el.textContent = current.toLocaleString();

        if (progress < 1) {
          requestAnimationFrame(update);
        } else {
          el.textContent = target.toLocaleString();
          el.classList.add('counted');
        }
      }
      requestAnimationFrame(update);
    });
  }, { threshold: 0.2 });

  counters.forEach(function(el) { observer.observe(el); });
}

document.addEventListener('DOMContentLoaded', initCountUp);

// ===== Notification Bell Ring Animation on New Notifications =====
(function() {
  var badge = document.getElementById('notif-badge');
  var bell = document.getElementById('notif-bell');
  if (badge && bell && !badge.classList.contains('hidden')) {
    // Slight delay so it plays after page loads
    setTimeout(function() {
      bell.classList.add('bell-animate');
      setTimeout(function() { bell.classList.remove('bell-animate'); }, 1100);
    }, 800);
  }
})();

// ===== Saved Views =====
(function() {
  var form = document.querySelector('[data-module]');
  if (!form) return;

  var module = form.dataset.module;
  var container = document.createElement('div');
  container.className = 'inline-flex items-center gap-2 ml-2';
  container.innerHTML =
    '<div class="relative" id="saved-views-wrap">' +
    '<button type="button" id="sv-toggle" class="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition">' +
    '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"/></svg>' +
    'Views</button>' +
    '<div id="sv-dropdown" class="hidden absolute right-0 top-full mt-1 w-56 bg-white border border-gray-200 rounded-xl shadow-lg z-30 py-1">' +
    '<div id="sv-list" class="max-h-40 overflow-y-auto"></div>' +
    '<div class="border-t border-gray-100 p-2">' +
    '<button type="button" id="sv-save" class="w-full text-left px-3 py-1.5 text-xs text-brand-600 hover:bg-brand-50 rounded-lg transition">Save current filters...</button>' +
    '</div></div></div>';

  // Insert after the form or filter bar
  var filterBar = form.querySelector('.flex') || form;
  if (filterBar.parentElement) filterBar.parentElement.insertBefore(container, filterBar.nextSibling);

  var dropdown = document.getElementById('sv-dropdown');
  var listEl = document.getElementById('sv-list');

  document.getElementById('sv-toggle').addEventListener('click', function() {
    dropdown.classList.toggle('hidden');
    if (!dropdown.classList.contains('hidden')) loadViews();
  });

  document.addEventListener('click', function(e) {
    if (!container.contains(e.target)) dropdown.classList.add('hidden');
  });

  function loadViews() {
    fetch('/api/views?module=' + module).then(function(r) { return r.json(); }).then(function(views) {
      if (views.length === 0) {
        listEl.innerHTML = '<p class="px-3 py-2 text-xs text-gray-400">No saved views yet</p>';
        return;
      }
      listEl.innerHTML = views.map(function(v) {
        return '<div class="flex items-center justify-between px-3 py-1.5 hover:bg-gray-50 group">' +
          '<a href="?' + v.query_params + '" class="text-xs text-gray-700 flex-1 truncate">' + v.name + '</a>' +
          '<button data-delete-view="' + v.id + '" class="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 ml-2">' +
          '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg></button></div>';
      }).join('');

      listEl.querySelectorAll('[data-delete-view]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.preventDefault();
          fetch('/api/views/' + btn.dataset.deleteView, { method: 'DELETE', headers: csrfHeaders() }).then(function() { loadViews(); });
        });
      });
    });
  }

  document.getElementById('sv-save').addEventListener('click', function() {
    var name = prompt('View name:');
    if (!name) return;
    var params = window.location.search.substring(1);
    fetch('/api/views', {
      method: 'POST',
      headers: csrfHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ module: module, name: name, query_params: params })
    }).then(function(r) { return r.json(); }).then(function() { loadViews(); });
  });
})();

// ===== Bulk Actions =====
(function() {
  var table = document.querySelector('[data-bulk-module]');
  if (!table) return;

  var module = table.dataset.bulkModule;
  var checkboxes = table.querySelectorAll('input[data-bulk-id]');
  var headerCheck = table.querySelector('input[data-bulk-all]');
  if (checkboxes.length === 0) return;

  // Create action bar
  var bar = document.createElement('div');
  bar.className = 'bulk-action-bar hidden';
  bar.innerHTML =
    '<div class="flex items-center gap-3">' +
    '<span class="text-sm font-medium text-gray-700"><span id="bulk-count">0</span> selected</span>' +
    '<button type="button" data-bulk-action="export" class="px-3 py-1.5 bg-white border border-gray-300 rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50">Export Selected</button>' +
    '<button type="button" data-bulk-action="clear" class="px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700">Clear</button>' +
    '</div>';
  document.body.appendChild(bar);

  var countEl = bar.querySelector('#bulk-count');

  function updateBar() {
    var checked = table.querySelectorAll('input[data-bulk-id]:checked');
    var count = checked.length;
    countEl.textContent = count;
    bar.classList.toggle('hidden', count === 0);
    if (headerCheck) headerCheck.checked = count === checkboxes.length && count > 0;
  }

  checkboxes.forEach(function(cb) { cb.addEventListener('change', updateBar); });

  if (headerCheck) {
    headerCheck.addEventListener('change', function() {
      checkboxes.forEach(function(cb) { cb.checked = headerCheck.checked; });
      updateBar();
    });
  }

  bar.querySelector('[data-bulk-action="clear"]').addEventListener('click', function() {
    checkboxes.forEach(function(cb) { cb.checked = false; });
    if (headerCheck) headerCheck.checked = false;
    updateBar();
  });

  bar.querySelector('[data-bulk-action="export"]').addEventListener('click', function() {
    var ids = [];
    table.querySelectorAll('input[data-bulk-id]:checked').forEach(function(cb) { ids.push(cb.dataset.bulkId); });
    if (ids.length === 0) return;
    window.location.href = '/exports/' + module + '?ids=' + ids.join(',');
  });
})();

// ===== Push Notification Subscription =====
(function() {
  // Only run for logged-in users (notification bell exists) and browsers that support push
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Push] Browser does not support push notifications');
    return;
  }
  if (!document.getElementById('notif-bell')) {
    console.log('[Push] No notif-bell found — user not logged in');
    return;
  }

  console.log('[Push] Initializing push subscription flow...');

  // Wait for service worker to be ready, then check/request push permission
  navigator.serviceWorker.ready.then(function(registration) {
    console.log('[Push] Service worker ready:', registration.scope);

    // Check existing subscription
    registration.pushManager.getSubscription().then(function(subscription) {
      if (subscription) {
        console.log('[Push] Already subscribed, syncing with server...');
        sendSubscriptionToServer(subscription);
        // Update any push status indicator
        updatePushStatus(true);
        return;
      }

      console.log('[Push] Not subscribed yet. Permission:', Notification.permission);

      // Not subscribed yet — show a prompt after a short delay (non-intrusive)
      if (Notification.permission === 'granted') {
        subscribeToPush(registration);
      } else if (Notification.permission !== 'denied') {
        // Ask after 3 seconds so it's not immediate on page load
        setTimeout(function() { showPushPrompt(registration); }, 3000);
      } else {
        console.log('[Push] Permission denied by user');
      }
    }).catch(function(err) {
      console.error('[Push] Error checking subscription:', err);
    });
  }).catch(function(err) {
    console.error('[Push] Service worker not ready:', err);
  });

  function showPushPrompt(registration) {
    // Don't show if already dismissed this session
    if (sessionStorage.getItem('push-dismissed')) {
      console.log('[Push] Prompt dismissed this session, skipping');
      return;
    }

    // Create a subtle in-app banner instead of relying solely on browser prompt
    var banner = document.createElement('div');
    banner.id = 'push-prompt';
    banner.className = 'fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-96 bg-white border border-gray-200 rounded-xl shadow-xl p-4 z-50 flex items-start gap-3';
    banner.innerHTML = '<div class="flex-shrink-0 w-10 h-10 bg-brand-50 rounded-full flex items-center justify-center">' +
      '<svg class="w-5 h-5 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>' +
      '</div>' +
      '<div class="flex-1">' +
      '<p class="text-sm font-semibold text-gray-900">Enable notifications?</p>' +
      '<p class="text-xs text-gray-500 mt-0.5">Get alerts for task assignments, deadlines, and updates on your phone.</p>' +
      '<div class="flex gap-2 mt-2">' +
      '<button id="push-enable" class="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold rounded-lg">Enable</button>' +
      '<button id="push-dismiss" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg">Not now</button>' +
      '</div></div>';
    document.body.appendChild(banner);

    document.getElementById('push-enable').addEventListener('click', function() {
      banner.remove();
      subscribeToPush(registration);
    });
    document.getElementById('push-dismiss').addEventListener('click', function() {
      banner.remove();
      sessionStorage.setItem('push-dismissed', '1');
    });
  }

  function subscribeToPush(registration) {
    console.log('[Push] Fetching VAPID key...');
    // Fetch VAPID public key from server
    fetch('/notifications/push/vapid-key')
      .then(function(res) {
        if (!res.ok) {
          throw new Error('VAPID key request failed: ' + res.status);
        }
        return res.json();
      })
      .then(function(data) {
        if (!data.publicKey) {
          console.error('[Push] No public key returned from server');
          return;
        }
        console.log('[Push] Got VAPID key, subscribing to push manager...');

        var key = urlBase64ToUint8Array(data.publicKey);
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key
        });
      })
      .then(function(subscription) {
        if (subscription) {
          console.log('[Push] Subscribed! Sending to server...');
          sendSubscriptionToServer(subscription);
          updatePushStatus(true);
        }
      })
      .catch(function(err) {
        console.error('[Push] Subscribe error:', err);
      });
  }

  function sendSubscriptionToServer(subscription) {
    fetch('/notifications/push/subscribe', {
      method: 'POST',
      headers: csrfHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(subscription)
    })
    .then(function(res) {
      if (!res.ok) {
        console.error('[Push] Server rejected subscription:', res.status);
      } else {
        console.log('[Push] Subscription saved to server');
      }
    })
    .catch(function(err) {
      console.error('[Push] Failed to send subscription to server:', err);
    });
  }

  // Update push status indicator on profile page (if present)
  function updatePushStatus(subscribed) {
    var statusEl = document.getElementById('push-status');
    if (statusEl) {
      statusEl.textContent = subscribed ? 'Enabled' : 'Disabled';
      statusEl.className = subscribed
        ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20'
        : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500';
    }
  }

  // Expose for test button on profile page
  window.sendTestPush = function() {
    fetch('/notifications/push/test', { method: 'POST', headers: csrfHeaders() })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          alert('Test notification sent! You should receive it in a few seconds.');
        } else {
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      })
      .catch(function(err) {
        alert('Error: ' + err.message);
      });
  };

  // Keep the "Notify specific people" picker summary in sync with the
  // checked boxes (e.g. "2 people tagged"). Delegated so it works for every
  // picker on the page, including dynamically-rendered sub-plan cards.
  document.addEventListener('change', function (e) {
    var cb = e.target;
    if (!cb || cb.name !== 'notify_user_ids') return;
    var picker = cb.closest('.notify-picker');
    if (!picker) return;
    var label = picker.querySelector('.notify-picker-label');
    if (!label) return;
    var checked = picker.querySelectorAll('input[name="notify_user_ids"]:checked');
    if (checked.length === 0) {
      label.textContent = 'No-one tagged';
      label.classList.add('text-gray-500');
      label.classList.remove('text-brand-700', 'font-medium');
    } else {
      label.textContent = checked.length + (checked.length === 1 ? ' person tagged' : ' people tagged');
      label.classList.remove('text-gray-500');
      label.classList.add('text-brand-700', 'font-medium');
    }
  });

  // Convert base64 VAPID key to Uint8Array for the Push API
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
})();
