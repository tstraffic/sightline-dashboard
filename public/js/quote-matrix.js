// Site Matrix cell autosave.
// On input within a .quote-cell, debounce 400 ms then POST the (site,
// item) pair to /quotes/:id/cells. Server returns authoritative
// line_revenue + site subtotal + column total + quote totals; we patch
// the DOM in place. Saving / saved / error state is shown as a small
// transient class on the input itself — no toast soup.

(function () {
  const QUOTE_ID = window.__QUOTE_ID__;
  if (!QUOTE_ID) return;

  const csrfToken = document.querySelector('input[name="_csrf"]')?.value || '';

  function fmtMoney(n) {
    if (n === null || n === undefined) return '—';
    return '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

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

      flashState(siteId, itemId, 'saved');
    } catch (err) {
      console.error('Cell save error:', err);
      flashState(siteId, itemId, 'error');
    }
  }

  // Event delegation — one listener handles every cell, including any
  // sites added later via the inline form (after a page reload).
  document.addEventListener('input', (e) => {
    if (!e.target.classList?.contains('quote-cell')) return;
    const siteId = e.target.dataset.cellSite;
    const itemId = e.target.dataset.cellItem;
    if (!siteId || !itemId) return;
    debounceSave(siteId, itemId);
  });
})();
