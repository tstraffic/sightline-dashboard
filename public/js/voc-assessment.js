// VOC assessment form dynamics. Mirrors the patterns in
// public/js/tgs-risk-assessment.js:
//   - Theory rows use per-row scoped radio groups (theory_correct_<i>) and
//     a hidden parallel-array `theory_correct` for the server. Submit
//     handler synchronises hidden inputs from the visible radios.
//   - Practical rows are likewise scoped per row.
//   - Theory pass = >=80% correct, computed live as the assessor ticks Y/N.
//   - Practical pass = every row is C, no NYC.
//   - Outcome auto-recommends NYC if either theory or practical fails.
//     Manager block becomes required (red border + warning) when outcome
//     is NYC; submit button stays clickable (server-side validates).

(function () {
  'use strict';

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // ── Theory ──────────────────────────────────────────────
  function recomputeTheory() {
    const rows = $$('[data-theory-row]');
    if (rows.length === 0) return { pass: false, total: 0, correct: 0 };
    let correct = 0;
    rows.forEach((row) => {
      const yesRadio = row.querySelector('[data-theory-correct][value="yes"]');
      if (yesRadio && yesRadio.checked) correct++;
    });
    const total = rows.length;
    const pct = total === 0 ? 0 : Math.round((correct / total) * 100);
    const pass = total > 0 && (correct / total) >= 0.8;

    const badge = $('#theoryBadge');
    if (badge) {
      badge.textContent = `${correct}/${total} · ${pct}% · ${pass ? 'Pass' : (total > 0 ? 'Fail' : '-')}`;
      badge.className =
        'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold ' +
        (total === 0
          ? 'bg-gray-100 text-gray-600'
          : pass
            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20'
            : 'bg-red-50 text-red-700 ring-1 ring-red-600/20');
    }
    return { pass, total, correct };
  }

  // ── Practical ───────────────────────────────────────────
  function recomputePractical() {
    const rows = $$('[data-prac-row]');
    if (rows.length === 0) return { pass: false, total: 0, c: 0, nyc: 0 };
    let c = 0, nyc = 0;
    rows.forEach((row) => {
      const result = row.querySelector('[data-prac-result]:checked');
      if (result && result.value === 'C') c++;
      else if (result && result.value === 'NYC') nyc++;
    });
    return { pass: nyc === 0 && c === rows.length, total: rows.length, c, nyc };
  }

  // ── Outcome banner + manager gating ─────────────────────
  function refreshOutcome() {
    const theory = recomputeTheory();
    const prac = recomputePractical();
    const wantsCompetent = $('input[name="outcome_select"][value="competent"]')?.checked;
    const wantsNYC = $('input[name="outcome_select"][value="nyc"]')?.checked;
    const auto = (theory.pass && prac.pass);

    // Banner
    const banner = $('#outcomeBanner');
    if (banner) {
      const bits = [];
      bits.push(`Theory ${theory.correct}/${theory.total}`);
      bits.push(`Practical ${prac.c}/${prac.total}${prac.nyc ? ' (' + prac.nyc + ' NYC)' : ''}`);
      if (wantsCompetent && auto) bits.push('<span class="ml-2 inline-flex items-center px-2 py-0.5 rounded font-bold bg-emerald-50 text-emerald-700">COMPETENT</span>');
      else if (wantsNYC || !auto) bits.push('<span class="ml-2 inline-flex items-center px-2 py-0.5 rounded font-bold bg-orange-50 text-orange-700">NOT YET COMPETENT</span>');
      banner.innerHTML = bits.join(' · ');
    }

    // Manager required when outcome would be NYC
    const isNYC = wantsNYC || !auto;
    const hint = $('#managerRequiredHint');
    const nameInput = $('#managerName');
    const dateInput = $('#managerDate');
    if (hint) hint.classList.toggle('hidden', !isNYC);
    [nameInput, dateInput].forEach((el) => {
      if (!el) return;
      const missing = isNYC && !el.value.trim();
      if (missing) {
        el.classList.add('border-red-500', 'bg-red-50');
        el.classList.remove('border-gray-300');
      } else {
        el.classList.remove('border-red-500', 'bg-red-50');
        el.classList.add('border-gray-300');
      }
    });
  }

  // Sync per-row theory_correct radios into the parallel `theory_correct`
  // hidden inputs so the server gets one value per question, in order.
  function syncTheoryHiddens() {
    $$('[data-theory-row]').forEach((row) => {
      const checked = row.querySelector('[data-theory-correct]:checked');
      const hidden = row.querySelector('[data-theory-correct-hidden]');
      if (hidden) hidden.value = checked ? checked.value : '';
    });
  }

  // ── Wiring ──────────────────────────────────────────────
  function init() {
    // Default valid-from to today when blank, then auto-compute valid-until
    // based on the assessment date (server uses template months on submit).
    const validFrom = document.querySelector('input[name="valid_from"]');
    const assessmentDate = document.querySelector('input[name="assessment_date"]');
    if (validFrom && !validFrom.value && assessmentDate) {
      validFrom.value = assessmentDate.value || new Date().toISOString().slice(0, 10);
    }

    document.addEventListener('change', (e) => {
      const target = e.target;
      if (!target) return;
      if (target.matches('[data-theory-correct]')) {
        syncTheoryHiddens();
        refreshOutcome();
      } else if (target.matches('[data-prac-result]')) {
        refreshOutcome();
      } else if (target.matches('input[name="outcome_select"]')) {
        refreshOutcome();
      } else if (target.matches('#managerName, #managerDate')) {
        refreshOutcome();
      }
    });

    // On submit, ensure hiddens are up to date.
    const form = document.getElementById('vocForm');
    if (form) {
      form.addEventListener('submit', syncTheoryHiddens);
    }

    syncTheoryHiddens();
    refreshOutcome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
