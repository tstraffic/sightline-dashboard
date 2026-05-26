// Site Matrix cell autosave + cost / margin layer.
// On input within a .quote-cell, debounce 400 ms then POST the (site,
// item) pair to /quotes/:id/cells. Server returns authoritative
// line_revenue + site subtotal + column total + quote totals; we patch
// the DOM in place. Saving / saved / error state is shown as a small
// transient class on the input itself — no toast soup.
//
// PR #6 additions:
//   - "Show margin" toggle reveals the .matrix-cost-block elements that
//     server-rendered with hidden by default.
//   - Cell `$` icon opens a shared popover showing the cost derivation
//     and (when not locked) an override input that POSTs to
//     /quotes/:id/lines/override and recomputes margin chips in place.
//   - After every cell save the response carries margin updates which
//     we patch into the DOM the same way as revenue.

(function () {
  const QUOTE_ID = window.__QUOTE_ID__;
  if (!QUOTE_ID) return;

  const LOCKED = !!window.__QUOTE_LOCKED__;
  const CAN_SEE_COST = !!window.__QUOTE_CAN_SEE_COST__;
  const HEALTHY = Number(window.__QUOTE_MARGIN_HEALTHY__) || 25;
  const WATCH = Number(window.__QUOTE_MARGIN_WATCH__) || 15;

  const csrfToken = document.querySelector('input[name="_csrf"]')?.value || '';

  function fmtMoney(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (n === null || n === undefined) return '—';
    return Number(n).toFixed(1) + '%';
  }

  // Same threshold logic as the server-side template helper. Returned
  // as a single class string for swapping via classList.
  function marginChipClasses(pct, hasRevenue) {
    if (!hasRevenue) return ['bg-gray-100', 'text-gray-500', 'ring-gray-200'];
    if (pct >= HEALTHY) return ['bg-emerald-50', 'text-emerald-700', 'ring-emerald-200'];
    if (pct >= WATCH)   return ['bg-amber-50', 'text-amber-800', 'ring-amber-200'];
    return ['bg-red-50', 'text-red-700', 'ring-red-200'];
  }
  const ALL_CHIP_CLASSES = [
    'bg-gray-100','text-gray-500','ring-gray-200',
    'bg-emerald-50','text-emerald-700','ring-emerald-200',
    'bg-amber-50','text-amber-800','ring-amber-200',
    'bg-red-50','text-red-700','ring-red-200',
  ];
  function applyChipClass(el, pct, hasRevenue) {
    if (!el) return;
    ALL_CHIP_CLASSES.forEach(c => el.classList.remove(c));
    marginChipClasses(pct, hasRevenue).forEach(c => el.classList.add(c));
  }

  // ────────────────────────────────────────────────────────────────
  // Cell autosave
  // ────────────────────────────────────────────────────────────────

  // Map: cellKey ('siteId-itemId') -> timeout handle. Independent
  // debouncers per cell so two cells edited near-simultaneously don't
  // stomp each other.
  const timers = new Map();

  function debounceSave(siteId, itemId) {
    const key = `${siteId}-${itemId}`;
    if (timers.has(key)) clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      save(siteId, itemId);
    }, 400));
  }

  function flashState(siteId, itemId, state) {
    document.querySelectorAll(`[data-cell-site="${siteId}"][data-cell-item="${itemId}"]`).forEach(el => {
      el.classList.remove('ring-amber-300', 'ring-emerald-300', 'ring-red-400', 'ring-2');
      if (state === 'saving') el.classList.add('ring-2', 'ring-amber-300');
      else if (state === 'saved') el.classList.add('ring-2', 'ring-emerald-300');
      else if (state === 'error') el.classList.add('ring-2', 'ring-red-400');
    });
    if (state === 'saved') {
      setTimeout(() => {
        document.querySelectorAll(`[data-cell-site="${siteId}"][data-cell-item="${itemId}"]`).forEach(el => {
          el.classList.remove('ring-2', 'ring-emerald-300');
        });
      }, 600);
    }
  }

  // Patch all margin-related DOM nodes from a server "cost" payload.
  // Used both by cell-save and by override-save responses.
  function applyCostPatch(siteId, itemId, cost) {
    if (!CAN_SEE_COST || !cost) return;

    // Cell margin %
    if (cost.line) {
      const cellMarginEl = document.querySelector(`[data-cell-margin-pct="${siteId}-${itemId}"]`);
      if (cellMarginEl) {
        const lr = cost.line.line_revenue ?? null;
        // line.line_revenue isn't always sent (override response omits it).
        // Fall back to assuming has revenue if line_cost / margin tells us.
        const hasRev = lr != null ? Number(lr) > 0
          : (Number(cost.line.line_margin) !== 0 || Number(cost.line.line_cost) > 0);
        cellMarginEl.textContent = hasRev ? fmtPct(cost.line.line_margin_pct) : '—';
        applyChipClass(cellMarginEl, cost.line.line_margin_pct, hasRev);
      }
      // Override badge — change cost-trigger color if override is set.
      const trigger = document.querySelector(`[data-cell-cost-trigger="${siteId}-${itemId}"]`);
      if (trigger) {
        const hasOverride = cost.line.unit_cost_override != null;
        trigger.classList.toggle('bg-amber-100', hasOverride);
        trigger.classList.toggle('text-amber-800', hasOverride);
        trigger.classList.toggle('hover:bg-amber-200', hasOverride);
        trigger.classList.toggle('bg-gray-100', !hasOverride);
        trigger.classList.toggle('text-gray-500', !hasOverride);
        trigger.classList.toggle('hover:bg-gray-200', !hasOverride);
        trigger.dataset.override = hasOverride ? String(cost.line.unit_cost_override) : '';
        trigger.dataset.lineId = String(cost.line.id || '');
      }
    }

    // Site cost + margin
    if (cost.site) {
      const siteSubEl = document.querySelector(`[data-site-subtotal="${siteId}"]`);
      const siteCostEl = document.querySelector(`[data-site-cost="${siteId}"]`);
      const siteMarginPctEl = document.querySelector(`[data-site-margin-pct="${siteId}"]`);
      if (siteCostEl) siteCostEl.textContent = fmtMoney(cost.site.cost);
      if (siteMarginPctEl) {
        const subtotalText = siteSubEl?.textContent || '';
        const hasRev = !subtotalText.includes('$0.00');
        siteMarginPctEl.textContent = hasRev ? fmtPct(cost.site.margin_pct) : '—';
        applyChipClass(siteMarginPctEl, cost.site.margin_pct, hasRev);
      }
    }

    // Column cost
    if (cost.column) {
      const colCostEl = document.querySelector(`[data-column-cost="${itemId}"]`);
      if (colCostEl) colCostEl.textContent = 'cost ' + fmtMoney(cost.column.cost);
    }

    // Quote-level cost + margin
    if (cost.quote) {
      document.querySelectorAll('[data-quote-cost]').forEach(el => el.textContent = fmtMoney(cost.quote.cost));
      const qCostFoot = document.querySelector('[data-quote-cost-foot]');
      const qMarginFoot = document.querySelector('[data-quote-margin-foot]');
      if (qCostFoot)   qCostFoot.textContent   = fmtMoney(cost.quote.cost);
      if (qMarginFoot) qMarginFoot.textContent = fmtMoney(cost.quote.margin);
      const hasRev = Number(cost.quote.cost) !== 0 || Number(cost.quote.margin) !== 0;
      document.querySelectorAll('[data-quote-margin-pct], [data-quote-margin-pct-foot]').forEach(el => {
        el.textContent = hasRev ? fmtPct(cost.quote.margin_pct) : '—';
        applyChipClass(el, cost.quote.margin_pct, hasRev);
      });
    }
  }

  async function save(siteId, itemId) {
    const qtyEl   = document.querySelector(`input[data-cell-site="${siteId}"][data-cell-item="${itemId}"][data-cell-field="qty"]`);
    const hoursEl = document.querySelector(`input[data-cell-site="${siteId}"][data-cell-item="${itemId}"][data-cell-field="hours"]`);
    if (!qtyEl) return;

    flashState(siteId, itemId, 'saving');

    try {
      const resp = await fetch(`/quotes/${QUOTE_ID}/cells`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          _csrf: csrfToken,
          site_id: siteId,
          rate_card_item_id: itemId,
          qty: qtyEl.value === '' ? 0 : Number(qtyEl.value),
          hours: hoursEl ? (hoursEl.value === '' ? null : Number(hoursEl.value)) : null,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.error('Cell save failed:', resp.status, err);
        flashState(siteId, itemId, 'error');
        return;
      }
      const data = await resp.json();

      // Patch the line revenue label under this cell
      const revLabel = document.querySelector(`[data-cell-revenue-site="${siteId}"][data-cell-revenue-item="${itemId}"]`);
      if (revLabel) {
        const lr = data.line?.line_revenue;
        revLabel.textContent = (lr && lr !== 0) ? fmtMoney(lr) : '';
      }

      // Patch the site subtotal cell
      const siteSub = document.querySelector(`[data-site-subtotal="${siteId}"]`);
      if (siteSub) siteSub.textContent = fmtMoney(data.site_subtotal);

      // Patch the column total
      const colTotal = document.querySelector(`[data-column-total="${itemId}"]`);
      if (colTotal) colTotal.textContent = fmtMoney(data.column_total);

      // Patch the three quote-level totals
      document.querySelectorAll('[data-quote-subtotal], [data-quote-subtotal-foot]').forEach(el => {
        el.textContent = fmtMoney(data.quote_subtotal);
      });
      const gstEl   = document.querySelector('[data-quote-gst]');
      const totalEl = document.querySelector('[data-quote-total]');
      if (gstEl)   gstEl.textContent   = fmtMoney(data.quote_gst);
      if (totalEl) totalEl.textContent = fmtMoney(data.quote_total);

      // Cost / margin block (only present when canSeeCost)
      applyCostPatch(siteId, itemId, data.cost);

      flashState(siteId, itemId, 'saved');
    } catch (err) {
      console.error('Cell save error:', err);
      flashState(siteId, itemId, 'error');
    }
  }

  // Event delegation — one listener handles every cell, including any
  // sites added later via the inline form (after a page reload).
  if (!LOCKED) {
    document.addEventListener('input', (e) => {
      if (!e.target.classList?.contains('quote-cell')) return;
      const siteId = e.target.dataset.cellSite;
      const itemId = e.target.dataset.cellItem;
      if (!siteId || !itemId) return;
      debounceSave(siteId, itemId);
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Show margin toggle
  //   Persists state in localStorage so reloads keep the chosen view.
  // ────────────────────────────────────────────────────────────────
  if (CAN_SEE_COST) {
    const toggle = document.getElementById('matrix-margin-toggle');
    const STORAGE_KEY = 'quote-matrix-show-margin';
    const initialOn = localStorage.getItem(STORAGE_KEY) === '1';
    function applyToggle(on) {
      document.querySelectorAll('.matrix-cost-block').forEach(el => {
        el.classList.toggle('hidden', !on);
      });
    }
    if (toggle) {
      toggle.checked = initialOn;
      applyToggle(initialOn);
      toggle.addEventListener('change', () => {
        localStorage.setItem(STORAGE_KEY, toggle.checked ? '1' : '0');
        applyToggle(toggle.checked);
      });
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Cost-derivation popover
  //   Single shared popover element repositioned next to the clicked
  //   trigger. Override save POSTs to /quotes/:id/lines/override and
  //   funnels the response through applyCostPatch so the UI stays in
  //   sync without a reload.
  // ────────────────────────────────────────────────────────────────
  if (CAN_SEE_COST) {
    const popover = document.getElementById('cost-popover');
    const closeBtn = document.getElementById('cost-popover-close');
    const derivEl = document.getElementById('cost-popover-derivation');
    const input = document.getElementById('cost-popover-input');
    const saveBtn = document.getElementById('cost-popover-save');
    const clearBtn = document.getElementById('cost-popover-clear');
    const statusEl = document.getElementById('cost-popover-status');
    let activeTrigger = null;

    function positionNear(trigger) {
      const rect = trigger.getBoundingClientRect();
      // Try below-right; flip up if it'd overflow.
      let top = rect.bottom + 6;
      let left = rect.right - 280;
      if (left < 8) left = 8;
      if (top + 180 > window.innerHeight) {
        top = rect.top - 180;
      }
      popover.style.top = `${top}px`;
      popover.style.left = `${left}px`;
    }

    function open(trigger) {
      activeTrigger = trigger;
      const derivation = trigger.dataset.derivation || '(no cost data)';
      derivEl.textContent = derivation;
      if (input) {
        const ov = trigger.dataset.override;
        input.value = (ov === '' || ov == null) ? '' : ov;
      }
      if (statusEl) statusEl.textContent = '';
      popover.classList.remove('hidden');
      positionNear(trigger);
      if (input && trigger.dataset.canEdit === '1') input.focus();
    }
    function close() {
      popover.classList.add('hidden');
      activeTrigger = null;
    }

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('[data-cell-cost-trigger]');
      if (trigger) {
        e.preventDefault();
        if (activeTrigger === trigger) { close(); return; }
        open(trigger);
        return;
      }
      // Click outside closes
      if (!popover.classList.contains('hidden') && !popover.contains(e.target)) {
        close();
      }
    });
    if (closeBtn) closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !popover.classList.contains('hidden')) close();
    });
    window.addEventListener('resize', () => {
      if (activeTrigger && !popover.classList.contains('hidden')) positionNear(activeTrigger);
    });

    async function submitOverride(value) {
      if (!activeTrigger) return;
      const siteId = activeTrigger.dataset.siteId;
      const itemId = activeTrigger.dataset.itemId;
      const lineId = activeTrigger.dataset.lineId;
      if (!lineId) {
        if (statusEl) statusEl.textContent = 'Enter a qty in this cell first, then override.';
        return;
      }
      if (statusEl) statusEl.textContent = 'Saving…';
      try {
        const resp = await fetch(`/quotes/${QUOTE_ID}/lines/override`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CSRF-Token': csrfToken },
          body: JSON.stringify({
            _csrf: csrfToken,
            site_id: Number(siteId),
            rate_card_item_id: Number(itemId),
            unit_cost_override: value,
          }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          if (statusEl) statusEl.textContent = err.error || `Error ${resp.status}`;
          return;
        }
        const data = await resp.json();
        applyCostPatch(siteId, itemId, data.cost);
        if (statusEl) statusEl.textContent = value == null ? 'Override cleared.' : 'Override saved.';
        setTimeout(close, 700);
      } catch (err) {
        console.error('Override save error:', err);
        if (statusEl) statusEl.textContent = 'Network error.';
      }
    }

    if (saveBtn) saveBtn.addEventListener('click', () => {
      const raw = input.value.trim();
      if (raw === '') return submitOverride(null);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        if (statusEl) statusEl.textContent = 'Enter a non-negative number, or leave blank to clear.';
        return;
      }
      submitOverride(n);
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (input) input.value = '';
      submitOverride(null);
    });
  }
})();
