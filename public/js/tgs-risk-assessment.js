// Client-side dynamics for the standalone TGS Risk Assessment form.
// Mirrors the React component's behaviour but stays in vanilla JS so it
// fits the rest of this codebase (no build pipeline).
//
// Drives:
//   • Live 5×5 matrix rating computation for Section 1-3 + Section 4 + RM.
//   • Yes/No state toggling disabled state on description / L / C inputs.
//   • Section 4 / RM dynamic add + remove rows with reindex.
//   • "Pull No items into RM table" button (auto-populate from Sections 1-4).
//   • Residual-risk banner + One-Up Manager required hint + submit gating.
//   • Submit-time renumbering of dynamic row indices so server gets a clean
//     parallel-array payload.

(function () {
  'use strict';

  // ── 5×5 matrix — must match lib/raTemplates/tgsRiskOptions.js ──
  var MATRIX = {
    A: ['Medium', 'High',   'Extreme', 'Extreme', 'Extreme'],
    B: ['Medium', 'High',   'High',    'Extreme', 'Extreme'],
    C: ['Low',    'Medium', 'High',    'High',    'Extreme'],
    D: ['Low',    'Low',    'Medium',  'High',    'High'],
    E: ['Low',    'Low',    'Low',     'Medium',  'High'],
  };
  var RANK = { Low: 1, Medium: 2, High: 3, Extreme: 4 };
  var CLASSES = {
    Low:     'bg-green-500 text-white',
    Medium:  'bg-yellow-400 text-black',
    High:    'bg-orange-500 text-white',
    Extreme: 'bg-red-600 text-white',
  };
  var BAND_CLASSES = 'bg-green-500 bg-yellow-400 bg-orange-500 bg-red-600 text-white text-black hidden';

  function compute(l, c) {
    if (!l || !c) return null;
    var row = MATRIX[l];
    if (!row) return null;
    return row[parseInt(c, 10) - 1] || null;
  }

  function paintBadge(badge, rating, l, c) {
    if (!badge) return;
    badge.className = ('text-center font-bold text-xs py-1 rounded ' + (rating ? CLASSES[rating] : 'hidden')).trim();
    badge.textContent = rating ? (rating + ' (' + (c || '') + (l || '') + ')') : '';
  }

  // ── Section 1-3 question rows ──
  function bindQuestionRow(tr) {
    var yns = tr.querySelectorAll('[data-q-yn]');
    var desc = tr.querySelector('[data-q-desc]');
    var lSel = tr.querySelector('[data-q-l]');
    var cSel = tr.querySelector('[data-q-c]');
    var badge = tr.querySelector('[data-q-badge]');

    function syncDisabled() {
      var no = false;
      yns.forEach(function (i) { if (i.checked && i.value === 'no') no = true; });
      desc.disabled = !no;
      lSel.disabled = !no;
      cSel.disabled = !no;
      if (!no) {
        // Clearing values when toggling away from "no" mirrors how the
        // React component grays-out the row. Without this, stale L/C
        // ratings would persist invisibly behind the disabled state.
        desc.value = '';
        lSel.value = '';
        cSel.value = '';
        paintBadge(badge, null, '', '');
      } else {
        paintBadge(badge, compute(lSel.value, cSel.value), lSel.value, cSel.value);
      }
    }
    function recalc() { paintBadge(badge, compute(lSel.value, cSel.value), lSel.value, cSel.value); }
    yns.forEach(function (i) { i.addEventListener('change', syncDisabled); });
    lSel.addEventListener('change', recalc);
    cSel.addEventListener('change', recalc);
  }

  // ── Section 4 rows ──
  // Section 4 uses two visible radio inputs that aren't actually submitted
  // (one hidden field per row carries the yn value). This keeps each row's
  // radios scoped to that row rather than fighting for a shared name.
  function bindS4Row(tr) {
    var ynInputs = tr.querySelectorAll('[data-s4-yn]');
    var ynHidden = tr.querySelector('[data-s4-yn-hidden]');
    var desc = tr.querySelector('[data-s4-desc]');
    var lSel = tr.querySelector('[data-s4-l]');
    var cSel = tr.querySelector('[data-s4-c]');
    var badge = tr.querySelector('[data-s4-badge]');
    var removeBtn = tr.querySelector('[data-s4-remove]');

    function syncDisabled() {
      var no = false;
      ynInputs.forEach(function (i) {
        if (i.checked) { ynHidden.value = i.value; if (i.value === 'no') no = true; }
      });
      desc.disabled = !no;
      lSel.disabled = !no;
      cSel.disabled = !no;
      if (!no) {
        desc.value = '';
        lSel.value = '';
        cSel.value = '';
        paintBadge(badge, null, '', '');
      } else {
        paintBadge(badge, compute(lSel.value, cSel.value), lSel.value, cSel.value);
      }
    }
    function recalc() { paintBadge(badge, compute(lSel.value, cSel.value), lSel.value, cSel.value); }

    ynInputs.forEach(function (i) { i.addEventListener('change', syncDisabled); });
    lSel.addEventListener('change', recalc);
    cSel.addEventListener('change', recalc);
    removeBtn.addEventListener('click', function () {
      var tbody = document.getElementById('s4Tbody');
      if (tbody && tbody.querySelectorAll('[data-s4-row]').length > 1) {
        tr.remove();
        reindexS4();
      } else {
        // Last row — just clear it.
        tr.querySelectorAll('textarea, select, input[type=text]').forEach(function (i) { i.value = ''; });
        ynInputs.forEach(function (i) { i.checked = false; });
        if (ynHidden) ynHidden.value = '';
        syncDisabled();
      }
    });
    syncDisabled();
  }

  function reindexS4() {
    var rows = document.querySelectorAll('#s4Tbody [data-s4-row]');
    rows.forEach(function (tr, idx) {
      var n = tr.querySelector('.s4-index');
      if (n) n.textContent = '4.' + (idx + 1);
      // Scope each row's radio buttons to a unique name so checking "yes"
      // in row 2 doesn't uncheck row 1.
      tr.querySelectorAll('[data-s4-yn]').forEach(function (i) { i.name = 's4_yn_local_' + idx; });
    });
  }

  // ── Risk Management rows ──
  function bindRmRow(tr) {
    var lSel = tr.querySelector('[data-rm-l]');
    var cSel = tr.querySelector('[data-rm-c]');
    var badge = tr.querySelector('[data-rm-badge]');
    var removeBtn = tr.querySelector('[data-rm-remove]');
    function recalc() {
      paintBadge(badge, compute(lSel.value, cSel.value), lSel.value, cSel.value);
      updateResidual();
    }
    lSel.addEventListener('change', recalc);
    cSel.addEventListener('change', recalc);
    removeBtn.addEventListener('click', function () {
      var tbody = document.getElementById('rmTbody');
      if (tbody && tbody.querySelectorAll('[data-rm-row]').length > 1) {
        tr.remove();
        reindexRm();
        updateResidual();
      } else {
        tr.querySelectorAll('textarea, select, input[type=text]').forEach(function (i) { i.value = ''; });
        paintBadge(badge, null, '', '');
        updateResidual();
      }
    });
  }

  function reindexRm() {
    var rows = document.querySelectorAll('#rmTbody [data-rm-row]');
    rows.forEach(function (tr, idx) {
      // Auto-renumber the ref field only when blank — preserve any
      // explicitly-typed "4.2" style refs the planner pasted in.
      var ref = tr.querySelector('input[name="rm_ref"]');
      if (ref && !ref.value.trim()) ref.value = String(idx + 1);
    });
  }

  // ── Building new rows (Section 4 + RM) ──
  function buildS4Row() {
    var tbody = document.getElementById('s4Tbody');
    var existing = tbody.querySelector('[data-s4-row]');
    var clone = existing.cloneNode(true);
    clone.querySelectorAll('textarea').forEach(function (t) { t.value = ''; t.disabled = true; });
    clone.querySelectorAll('select').forEach(function (s) { s.value = ''; s.disabled = true; });
    clone.querySelectorAll('input[type=radio]').forEach(function (i) { i.checked = false; });
    var hidden = clone.querySelector('[data-s4-yn-hidden]');
    if (hidden) hidden.value = '';
    var badge = clone.querySelector('[data-s4-badge]');
    if (badge) { badge.textContent = ''; badge.className = 'text-center font-bold text-xs py-1 rounded hidden'; }
    tbody.appendChild(clone);
    bindS4Row(clone);
    reindexS4();
  }

  function buildRmRow(opts) {
    opts = opts || {};
    var tbody = document.getElementById('rmTbody');
    var existing = tbody.querySelector('[data-rm-row]');
    var clone = existing.cloneNode(true);
    clone.querySelectorAll('textarea').forEach(function (t) { t.value = ''; });
    clone.querySelectorAll('select').forEach(function (s) { s.value = ''; });
    var refInput = clone.querySelector('input[name="rm_ref"]');
    if (refInput) refInput.value = opts.ref || '';
    var hazardEl = clone.querySelector('textarea[name="rm_hazard"]');
    if (hazardEl) hazardEl.value = opts.hazard || '';
    var badge = clone.querySelector('[data-rm-badge]');
    if (badge) { badge.textContent = ''; badge.className = 'text-center font-bold text-xs py-1 rounded hidden'; }
    tbody.appendChild(clone);
    bindRmRow(clone);
    reindexRm();
    return clone;
  }

  // ── Pull "No" items into RM table ──
  function pullNoItems() {
    var existingRefs = {};
    document.querySelectorAll('#rmTbody [data-rm-row] input[name="rm_ref"]').forEach(function (i) {
      if (i.value) existingRefs[i.value.trim()] = true;
    });

    // Collect candidate hazards from Section 1-3 rows.
    var added = 0;
    document.querySelectorAll('[data-q-row]').forEach(function (tr) {
      var yn = tr.querySelector('[data-q-yn]:checked');
      if (!yn || yn.value !== 'no') return;
      var ref = tr.getAttribute('data-q-num');
      if (existingRefs[ref]) return;
      var desc = tr.querySelector('[data-q-desc]');
      var text = (desc && desc.value.trim()) || tr.getAttribute('data-q-text') || '';
      buildRmRow({ ref: ref, hazard: text });
      existingRefs[ref] = true;
      added++;
    });

    // Section 4 hazards — use the typed question text + s4 index as ref.
    document.querySelectorAll('#s4Tbody [data-s4-row]').forEach(function (tr, idx) {
      var hidden = tr.querySelector('[data-s4-yn-hidden]');
      if (!hidden || hidden.value !== 'no') return;
      var ref = '4.' + (idx + 1);
      if (existingRefs[ref]) return;
      var qEl = tr.querySelector('textarea[name="s4_question"]');
      var dEl = tr.querySelector('[data-s4-desc]');
      var text = (dEl && dEl.value.trim()) || (qEl && qEl.value.trim()) || '';
      if (!text) return;
      buildRmRow({ ref: ref, hazard: text });
      existingRefs[ref] = true;
      added++;
    });

    // If the table started with an empty placeholder row and we added new
    // content, remove the placeholder. (Detected by: ref empty, hazard
    // empty, controls empty, L empty, C empty.)
    if (added > 0) {
      var rows = document.querySelectorAll('#rmTbody [data-rm-row]');
      rows.forEach(function (tr) {
        var ref = tr.querySelector('input[name="rm_ref"]');
        var haz = tr.querySelector('textarea[name="rm_hazard"]');
        var ctrl = tr.querySelector('textarea[name="rm_controls"]');
        var l = tr.querySelector('[data-rm-l]');
        var c = tr.querySelector('[data-rm-c]');
        if (
          rows.length > 1 &&
          (!ref || !ref.value.trim() || ref.value.trim() === '1') &&
          (!haz || !haz.value.trim()) &&
          (!ctrl || !ctrl.value.trim()) &&
          (!l || !l.value) &&
          (!c || !c.value)
        ) {
          tr.remove();
        }
      });
      reindexRm();
      updateResidual();
    }
  }

  // ── Residual risk banner + One-Up gating ──
  function updateResidual() {
    var max = null;
    document.querySelectorAll('#rmTbody [data-rm-row]').forEach(function (tr) {
      var l = tr.querySelector('[data-rm-l]');
      var c = tr.querySelector('[data-rm-c]');
      var r = compute(l && l.value, c && c.value);
      if (!r) return;
      if (!max || RANK[r] > RANK[max]) max = r;
    });

    var banner = document.getElementById('residualBanner');
    var oneUpHint = document.getElementById('oneUpRequiredHint');
    var oneUpInput = document.getElementById('oneUpName');
    var saveBtn = document.getElementById('saveBtn');
    var requires = (max === 'High' || max === 'Extreme');

    if (banner) {
      if (max) {
        banner.innerHTML =
          'Highest residual risk: ' +
          '<span class="inline-flex items-center px-2 py-0.5 rounded font-bold ' + CLASSES[max] + '">' + max + '</span>' +
          (requires ? ' <span class="ml-3 text-red-600 font-semibold">One-Up Manager sign-off required</span>' : '');
      } else {
        banner.textContent = '';
      }
    }
    if (oneUpHint) oneUpHint.classList.toggle('hidden', !requires);
    if (oneUpInput) {
      if (requires && !oneUpInput.value.trim()) {
        oneUpInput.classList.add('border-red-500', 'bg-red-50');
        oneUpInput.classList.remove('border-gray-300');
      } else {
        oneUpInput.classList.remove('border-red-500', 'bg-red-50');
        oneUpInput.classList.add('border-gray-300');
      }
    }
    if (saveBtn) {
      // Save is always allowed (drafts can have unresolved One-Up). The
      // Finalize button has its own server-side guard; we only soft-warn
      // on save by toggling One-Up styling above.
      saveBtn.disabled = false;
    }
  }

  // ── Wire everything on load ──
  function init() {
    document.querySelectorAll('[data-q-row]').forEach(bindQuestionRow);
    document.querySelectorAll('#s4Tbody [data-s4-row]').forEach(bindS4Row);
    document.querySelectorAll('#rmTbody [data-rm-row]').forEach(bindRmRow);
    reindexS4();
    reindexRm();

    var s4Add = document.getElementById('s4AddRow');
    if (s4Add) s4Add.addEventListener('click', buildS4Row);
    var rmAdd = document.getElementById('rmAddRow');
    if (rmAdd) rmAdd.addEventListener('click', function () { buildRmRow(); });
    var pullBtn = document.getElementById('rmPullNo');
    if (pullBtn) pullBtn.addEventListener('click', pullNoItems);

    var oneUpInput = document.getElementById('oneUpName');
    if (oneUpInput) oneUpInput.addEventListener('input', updateResidual);

    updateResidual();

    // Submit-time: rewrite Section 4 radio names back to the canonical
    // parallel-array name 's4_yn' so the server sees one value per row.
    // (Per-row scoping during edit used 's4_yn_local_<i>' to keep radio
    // groups isolated.)
    var form = document.getElementById('tgsRaForm');
    if (form) {
      form.addEventListener('submit', function () {
        document.querySelectorAll('#s4Tbody [data-s4-row]').forEach(function (tr) {
          var hidden = tr.querySelector('[data-s4-yn-hidden]');
          var radios = tr.querySelectorAll('[data-s4-yn]');
          var picked = '';
          radios.forEach(function (i) { if (i.checked) picked = i.value; });
          if (hidden) hidden.value = picked;
          // The visible radios themselves are not part of the submit since
          // they no longer share the canonical name. The hidden input is.
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
