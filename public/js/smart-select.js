// Smart Select — progressive enhancement for big <select> dropdowns.
//
// Native selects with lots of rows (job pickers, client pickers…) are painful
// to scan and impossible to search. This upgrades any single-select with
// SS_MIN_OPTIONS+ options into a searchable panel: search box, All/Recent
// chips, and card-style options with a primary line + muted meta line
// (parsed from data-primary/data-meta attributes, else from the option text).
//
// The real <select> stays in the DOM (visually hidden) and keeps receiving
// the value + a bubbling `change` event, so forms, inline onchange handlers
// and required-validation keep working untouched.
//
// Opt-out per select:  <select data-smart-select="off">
// Force-on small ones: <select data-smart-select="on">
(function () {
  'use strict';
  var SS_MIN_OPTIONS = 8;
  var RECENT_MAX = 6;

  function recentKey(sel) {
    return 'ss-recent:' + (sel.name || sel.id || 'select');
  }
  function getRecents(sel) {
    try { return JSON.parse(localStorage.getItem(recentKey(sel)) || '[]'); } catch (e) { return []; }
  }
  function pushRecent(sel, value) {
    if (!value) return;
    try {
      var list = getRecents(sel).filter(function (v) { return v !== value; });
      list.unshift(value);
      localStorage.setItem(recentKey(sel), JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch (e) { /* private mode */ }
  }

  // Split noisy option text ("J-0030 — Abergeldie | Westmead | 2026-05-05")
  // into a bold primary line + a muted meta line.
  function parseOption(opt) {
    if (opt.dataset.primary) return { primary: opt.dataset.primary, meta: opt.dataset.meta || '' };
    var text = (opt.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.indexOf('|') !== -1) {
      var parts = text.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
      return { primary: parts[0], meta: parts.slice(1).join(' · ') };
    }
    var mdash = text.split(' — ');
    if (mdash.length > 1) return { primary: mdash[0].trim(), meta: mdash.slice(1).join(' — ').trim() };
    return { primary: text, meta: '' };
  }

  function enhance(sel) {
    if (sel.dataset.ssEnhanced) return;
    if (sel.multiple || sel.size > 1) return;
    if (sel.dataset.smartSelect === 'off') return;
    if (sel.closest('[data-smart-select-scope="off"]')) return;
    var realOptions = Array.prototype.filter.call(sel.options, function (o) { return o.value !== ''; });
    if (sel.dataset.smartSelect !== 'on' && realOptions.length < SS_MIN_OPTIONS) return;
    sel.dataset.ssEnhanced = '1';

    var placeholderOpt = Array.prototype.find.call(sel.options, function (o) { return o.value === ''; });
    var placeholder = placeholderOpt ? placeholderOpt.textContent.replace(/^[—\-\s]+|[—\-\s]+$/g, '') : 'Select…';

    // Wrapper + trigger + panel
    var wrap = document.createElement('div');
    wrap.className = 'ss-wrap';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('ss-native');

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'ss-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    wrap.appendChild(trigger);

    var panel = document.createElement('div');
    panel.className = 'ss-panel';
    panel.hidden = true;
    panel.innerHTML =
      '<div class="ss-search-row"><input type="text" class="ss-search" placeholder="Type to search…" autocomplete="off"></div>' +
      '<div class="ss-chips"></div>' +
      '<div class="ss-list" role="listbox"></div>';
    wrap.appendChild(panel);

    var search = panel.querySelector('.ss-search');
    var chipsRow = panel.querySelector('.ss-chips');
    var list = panel.querySelector('.ss-list');
    var mode = 'all'; // all | recent
    var activeIdx = -1;

    function syncDisabled() {
      trigger.disabled = sel.disabled;
      trigger.classList.toggle('ss-disabled', sel.disabled);
    }
    new MutationObserver(syncDisabled).observe(sel, { attributes: true, attributeFilter: ['disabled'] });
    syncDisabled();

    function renderTrigger() {
      var opt = sel.options[sel.selectedIndex];
      if (opt && opt.value !== '') {
        var p = parseOption(opt);
        trigger.innerHTML = '<span class="ss-trigger-label">' +
          '<span class="ss-trigger-primary"></span>' +
          (p.meta ? '<span class="ss-trigger-meta"></span>' : '') +
          '</span><span class="ss-caret" aria-hidden="true">▾</span>';
        trigger.querySelector('.ss-trigger-primary').textContent = p.primary;
        if (p.meta) trigger.querySelector('.ss-trigger-meta').textContent = p.meta;
      } else {
        trigger.innerHTML = '<span class="ss-trigger-label"><span class="ss-trigger-placeholder"></span></span><span class="ss-caret" aria-hidden="true">▾</span>';
        trigger.querySelector('.ss-trigger-placeholder').textContent = placeholder;
      }
    }

    function renderChips() {
      var recents = getRecents(sel);
      chipsRow.innerHTML = '';
      if (!recents.length) { chipsRow.hidden = true; return; }
      chipsRow.hidden = false;
      [['all', 'All'], ['recent', 'Recent']].forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ss-chip' + (mode === c[0] ? ' ss-chip-active' : '');
        b.textContent = c[1];
        b.addEventListener('click', function () { mode = c[0]; renderChips(); renderList(); search.focus(); });
        chipsRow.appendChild(b);
      });
    }

    function visibleOptions() {
      var q = search.value.trim().toLowerCase();
      var recents = getRecents(sel);
      var opts = Array.prototype.filter.call(sel.options, function (o) { return o.value !== ''; });
      if (mode === 'recent') {
        opts = opts.filter(function (o) { return recents.indexOf(o.value) !== -1; });
        opts.sort(function (a, b) { return recents.indexOf(a.value) - recents.indexOf(b.value); });
      }
      if (q) {
        opts = opts.filter(function (o) { return (o.textContent || '').toLowerCase().indexOf(q) !== -1; });
      }
      return opts;
    }

    function renderList() {
      var opts = visibleOptions();
      activeIdx = -1;
      list.innerHTML = '';
      if (!opts.length) {
        var empty = document.createElement('div');
        empty.className = 'ss-empty';
        empty.textContent = search.value ? 'No matches for “' + search.value.trim() + '”' : 'Nothing here yet';
        list.appendChild(empty);
        return;
      }
      opts.forEach(function (o) {
        var p = parseOption(o);
        var card = document.createElement('div');
        card.className = 'ss-card' + (o.selected && o.value !== '' ? ' ss-card-selected' : '');
        card.setAttribute('role', 'option');
        card.dataset.value = o.value;
        var pr = document.createElement('div');
        pr.className = 'ss-card-primary';
        pr.textContent = p.primary;
        card.appendChild(pr);
        if (p.meta) {
          var mt = document.createElement('div');
          mt.className = 'ss-card-meta';
          mt.textContent = p.meta;
          card.appendChild(mt);
        }
        card.addEventListener('click', function () { pick(o.value); });
        list.appendChild(card);
      });
    }

    function pick(value) {
      sel.value = value;
      pushRecent(sel, value);
      renderTrigger();
      close();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Position the panel as a fixed, body-portaled overlay anchored to the
    // trigger. Rendering it in <body> (not inside .ss-wrap) is the only
    // reliable way to escape ancestor stacking contexts + overflow clipping
    // — cards with transform/backdrop-filter were trapping the old absolutely
    // -positioned panel behind their neighbours regardless of z-index.
    function position() {
      var r = trigger.getBoundingClientRect();
      var vh = window.innerHeight;
      panel.style.position = 'fixed';
      panel.style.left = r.left + 'px';
      panel.style.right = 'auto';
      panel.style.width = r.width + 'px';
      var below = vh - r.bottom;
      var above = r.top;
      var openUp = below < 300 && above > below;
      var avail = (openUp ? above : below) - 14;
      if (openUp) {
        panel.style.top = 'auto';
        panel.style.bottom = (vh - r.top + 6) + 'px';
      } else {
        panel.style.bottom = 'auto';
        panel.style.top = (r.bottom + 6) + 'px';
      }
      // Let the results list (the scroll area) shrink to fit the gap so the
      // panel never runs off-screen; ~64px covers the search row.
      list.style.maxHeight = Math.max(140, avail - 64) + 'px';
    }

    var repositionBound = function () { if (!panel.hidden) position(); };

    function open() {
      if (sel.disabled) return;
      // close any other open panel
      document.querySelectorAll('.ss-panel:not([hidden])').forEach(function (pn) { pn.hidden = true; });
      mode = 'all';
      search.value = '';
      renderChips();
      renderList();
      // Portal into <body> so nothing can paint over it, then anchor it.
      panel.classList.remove('ss-panel-up');
      if (panel.parentNode !== document.body) document.body.appendChild(panel);
      panel.hidden = false;
      position();
      window.addEventListener('scroll', repositionBound, true);
      window.addEventListener('resize', repositionBound);
      setTimeout(function () { search.focus(); position(); }, 0);
    }
    function close() {
      panel.hidden = true;
      window.removeEventListener('scroll', repositionBound, true);
      window.removeEventListener('resize', repositionBound);
    }

    trigger.addEventListener('click', function () { panel.hidden ? open() : close(); });
    trigger.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
    search.addEventListener('input', renderList);
    panel.addEventListener('keydown', function (e) {
      var cards = list.querySelectorAll('.ss-card');
      if (e.key === 'Escape') { e.preventDefault(); close(); trigger.focus(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!cards.length) return;
        activeIdx = e.key === 'ArrowDown' ? Math.min(activeIdx + 1, cards.length - 1) : Math.max(activeIdx - 1, 0);
        cards.forEach(function (c, i) { c.classList.toggle('ss-card-active', i === activeIdx); });
        cards[activeIdx].scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        var target = activeIdx >= 0 ? cards[activeIdx] : cards[0];
        if (target) pick(target.dataset.value);
      }
    });
    document.addEventListener('click', function (e) {
      // Panel now lives in <body>, so check it explicitly alongside the wrap.
      if (!panel.hidden && !wrap.contains(e.target) && !panel.contains(e.target)) close();
    });

    // External value changes (form reset, other scripts setting .value)
    if (sel.form) sel.form.addEventListener('reset', function () { setTimeout(renderTrigger, 0); });
    sel.addEventListener('change', renderTrigger);
    // Required-but-empty validation: reveal the panel instead of the hidden native control
    sel.addEventListener('invalid', function (e) { e.preventDefault(); open(); });

    renderTrigger();
  }

  function enhanceAll(root) {
    (root || document).querySelectorAll('select').forEach(enhance);
  }

  document.addEventListener('DOMContentLoaded', function () {
    enhanceAll();
    // Late-added selects (slide-overs, AJAX-injected forms)
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'SELECT') enhance(n);
          else if (n.querySelectorAll) n.querySelectorAll('select').forEach(enhance);
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  });

  window.SmartSelect = { enhance: enhance, enhanceAll: enhanceAll };
})();
