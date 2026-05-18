// T&S Dashboard — Step Wizard + Conditional Fields
// Provides multi-step form navigation and field visibility logic

(function() {
  'use strict';

  // ========== StepWizard ==========
  class StepWizard {
    constructor(formEl) {
      this.form = formEl;
      this.steps = Array.from(formEl.querySelectorAll('[data-wizard-step]'));
      if (this.steps.length < 2) return; // not enough steps to wizard-ify

      this.currentStep = 0;
      this.totalSteps = this.steps.length;
      this.storageKey = 'wizard_' + (formEl.action || location.pathname);

      this._buildIndicator();
      this._buildNavButtons();
      this._showStep(0);
      this._restoreDraft();
      this._setupAutoSave();

      // Intercept form submit to clear draft
      this.form.addEventListener('submit', () => {
        try { sessionStorage.removeItem(this.storageKey); } catch(e) {}
      });
    }

    _buildIndicator() {
      // Create step indicator bar above the form steps
      this.indicator = document.createElement('div');
      this.indicator.className = 'flex items-center gap-2 mb-5 overflow-x-auto pb-1';
      this.indicator.setAttribute('role', 'tablist');

      this.pills = this.steps.map((step, i) => {
        const title = step.getAttribute('data-wizard-title') || ('Step ' + (i + 1));
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'wizard-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition whitespace-nowrap';
        pill.innerHTML = '<span class="wizard-pill-num w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold">' + (i + 1) + '</span>' + title;
        pill.setAttribute('role', 'tab');
        pill.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
        pill.addEventListener('click', () => this._goToStep(i));
        this.indicator.appendChild(pill);
        return pill;
      });

      // Insert indicator before the first step
      this.steps[0].parentNode.insertBefore(this.indicator, this.steps[0]);
    }

    _buildNavButtons() {
      this.steps.forEach((step, i) => {
        const nav = document.createElement('div');
        nav.className = 'flex items-center justify-between mt-5 pt-4 border-t border-gray-100';

        const left = document.createElement('div');
        const right = document.createElement('div');
        right.className = 'flex items-center gap-2';

        if (i > 0) {
          const back = document.createElement('button');
          back.type = 'button';
          back.className = 'px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition';
          back.textContent = 'Back';
          back.addEventListener('click', () => this._goToStep(i - 1));
          left.appendChild(back);
        }

        if (i < this.totalSteps - 1) {
          const next = document.createElement('button');
          next.type = 'button';
          next.className = 'px-5 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition';
          next.textContent = 'Next';
          next.addEventListener('click', () => this._tryNext(i));
          right.appendChild(next);
        } else {
          // Last step — show submit (use button type to bypass native validation, validate all steps first)
          const submit = document.createElement('button');
          submit.type = 'button';
          submit.className = 'px-5 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-lg transition inline-flex items-center gap-2';
          submit.innerHTML = 'Save <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>';
          submit.addEventListener('click', () => this._trySubmit());
          right.appendChild(submit);
        }

        nav.appendChild(left);
        nav.appendChild(right);
        step.appendChild(nav);
      });

      // Hide any existing standalone submit button at form level
      const existingSubmit = this.form.querySelector(':scope > .flex > button[type="submit"], :scope > button[type="submit"], :scope > div:last-child > button[type="submit"]');
      if (existingSubmit) {
        const wrapper = existingSubmit.closest('.flex, .mt-5, div');
        if (wrapper && wrapper !== this.form) wrapper.style.display = 'none';
      }
    }

    _tryNext(fromStep) {
      if (this._validateStep(fromStep)) {
        this._goToStep(fromStep + 1);
      }
    }

    _trySubmit() {
      // Validate all steps before submitting
      for (let i = 0; i < this.totalSteps; i++) {
        if (!this._validateStep(i)) {
          this._showStep(i);
          return;
        }
      }
      // All steps valid — submit directly (bypass native validation since we already checked)
      this.form.submit();
    }

    _validateStep(stepIndex) {
      const step = this.steps[stepIndex];
      const fields = step.querySelectorAll('input[required], select[required], textarea[required]');
      let valid = true;

      fields.forEach(field => {
        // Skip hidden/invisible fields (conditional fields that are hidden)
        if (field.offsetParent === null && field.closest('[data-show-when]')) return;

        if (!field.checkValidity()) {
          valid = false;
          field.classList.add('ring-2', 'ring-red-400');
          field.addEventListener('input', function handler() {
            field.classList.remove('ring-2', 'ring-red-400');
            field.removeEventListener('input', handler);
          }, { once: true });
        }
      });

      if (!valid) {
        // Find first invalid field and focus it
        const firstInvalid = step.querySelector(':invalid');
        if (firstInvalid) {
          firstInvalid.focus();
          firstInvalid.reportValidity();
        }
      }
      return valid;
    }

    _goToStep(index) {
      if (index < 0 || index >= this.totalSteps) return;
      // Allow going back freely, validate when going forward
      if (index > this.currentStep) {
        for (let i = this.currentStep; i < index; i++) {
          if (!this._validateStep(i)) return;
        }
      }
      this._showStep(index);
    }

    _showStep(index) {
      this.currentStep = index;

      this.steps.forEach((step, i) => {
        step.classList.toggle('hidden', i !== index);
      });

      this.pills.forEach((pill, i) => {
        const isActive = i === index;
        const isCompleted = i < index;
        pill.setAttribute('aria-selected', isActive ? 'true' : 'false');

        // Reset classes
        pill.className = 'wizard-pill inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition whitespace-nowrap';
        const num = pill.querySelector('.wizard-pill-num');

        if (isActive) {
          pill.classList.add('border-brand-500', 'bg-brand-50', 'text-brand-700');
          num.className = 'wizard-pill-num w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-brand-600 text-white';
        } else if (isCompleted) {
          pill.classList.add('border-emerald-300', 'bg-emerald-50', 'text-emerald-700');
          num.className = 'wizard-pill-num w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-emerald-500 text-white';
          num.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>';
        } else {
          pill.classList.add('border-gray-200', 'bg-white', 'text-gray-400');
          num.className = 'wizard-pill-num w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-400';
          num.textContent = i + 1;
        }
      });

      // Scroll indicator pill into view
      this.pills[index].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });

      // Dispatch event
      this.form.dispatchEvent(new CustomEvent('wizard:step-change', { detail: { step: index, total: this.totalSteps } }));
    }

    _setupAutoSave() {
      let timer;
      this.form.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => this._saveDraft(), 500);
      });
      this.form.addEventListener('change', () => this._saveDraft());
    }

    _saveDraft() {
      try {
        const data = new FormData(this.form);
        const obj = {};
        data.forEach((v, k) => { obj[k] = v; });
        obj._wizardStep = this.currentStep;
        sessionStorage.setItem(this.storageKey, JSON.stringify(obj));
      } catch(e) {}
    }

    _restoreDraft() {
      try {
        const saved = sessionStorage.getItem(this.storageKey);
        if (!saved) return;
        const obj = JSON.parse(saved);

        // Only restore if this is a "new" form (not edit)
        if (this.form.querySelector('input[name="_method"]')) return;

        Object.keys(obj).forEach(key => {
          if (key === '_wizardStep') return;
          const field = this.form.querySelector('[name="' + key + '"]');
          if (!field) return;
          if (field.type === 'checkbox') {
            field.checked = obj[key] === 'on' || obj[key] === '1' || obj[key] === 'true';
          } else {
            field.value = obj[key];
          }
        });

        if (typeof obj._wizardStep === 'number') {
          this._showStep(Math.min(obj._wizardStep, this.totalSteps - 1));
        }
      } catch(e) {}
    }
  }

  // ========== ConditionalFields ==========
  class ConditionalFields {
    constructor(formEl) {
      this.form = formEl;
      this.conditionals = Array.from(formEl.querySelectorAll('[data-show-when]'));
      if (this.conditionals.length === 0) return;

      this._parse();
      this._evaluate();

      formEl.addEventListener('change', () => this._evaluate());
      formEl.addEventListener('input', () => this._evaluate());
    }

    _parse() {
      this.rules = this.conditionals.map(el => {
        const expr = el.getAttribute('data-show-when');
        // Format: "fieldName=value1,value2" or "fieldName=!value" (negation) or "fieldName" (truthy)
        const eqIndex = expr.indexOf('=');
        let fieldName, values, negate = false;

        if (eqIndex === -1) {
          fieldName = expr;
          values = null; // truthy check
        } else {
          fieldName = expr.substring(0, eqIndex);
          let valStr = expr.substring(eqIndex + 1);
          if (valStr.startsWith('!')) {
            negate = true;
            valStr = valStr.substring(1);
          }
          values = valStr.split(',').map(v => v.trim());
        }

        return { el, fieldName, values, negate };
      });
    }

    _evaluate() {
      this.rules.forEach(rule => {
        const field = this.form.querySelector('[name="' + rule.fieldName + '"]');
        if (!field) return;

        let currentValue;
        if (field.type === 'checkbox') {
          currentValue = field.checked ? '1' : '0';
        } else if (field.type === 'radio') {
          const checked = this.form.querySelector('[name="' + rule.fieldName + '"]:checked');
          currentValue = checked ? checked.value : '';
        } else {
          currentValue = field.value;
        }

        let show;
        if (rule.values === null) {
          // Truthy check
          show = currentValue && currentValue !== '0' && currentValue !== '';
        } else {
          show = rule.values.includes(currentValue);
          if (rule.negate) show = !show;
        }

        rule.el.classList.toggle('hidden', !show);

        // Disable required on hidden fields so form validation doesn't block
        const requiredFields = rule.el.querySelectorAll('[required]');
        requiredFields.forEach(f => {
          if (!show) {
            f.dataset.wasRequired = 'true';
            f.removeAttribute('required');
          } else if (f.dataset.wasRequired === 'true') {
            f.setAttribute('required', '');
          }
        });
      });
    }
  }

  // ========== Auto-init ==========
  document.addEventListener('DOMContentLoaded', function() {
    // Init wizards
    document.querySelectorAll('form[data-wizard]').forEach(form => {
      new StepWizard(form);
    });

    // Init conditional fields on ALL forms (not just wizard forms)
    document.querySelectorAll('form').forEach(form => {
      if (form.querySelector('[data-show-when]')) {
        new ConditionalFields(form);
      }
    });
  });

  // ========== Submit Spinner ==========
  // Disables the submit button while saving so users can't double-submit,
  // but is careful to re-enable it on every path the page can come back:
  //   - Server returns an error redirect → fresh page load → pageshow fires
  //   - User hits Back after a successful POST → BFCache restore → pageshow
  //     fires with event.persisted === true, restoring the old disabled
  //     state visually; we always re-enable to recover from that.
  //   - Hard timeout as a final safety net (shortened from 8s to 2.5s; on
  //     traditional EJS form posts the page navigates away well before that
  //     fires, but on AJAX forms that fail without a navigation we don't
  //     want to lock the user out for 8 seconds).
  function resetSubmitButton(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('opacity-75', 'cursor-wait');
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }

  function resetAllSubmitButtons() {
    document.querySelectorAll('button[type="submit"]').forEach(resetSubmitButton);
    document.querySelectorAll('form.form-submitting').forEach(f => f.classList.remove('form-submitting'));
  }

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('form').forEach(form => {
      form.addEventListener('submit', function() {
        const btn = form.querySelector('button[type="submit"]:not([data-no-spinner])');
        if (!btn || btn.disabled) return;
        btn.disabled = true;
        btn.classList.add('opacity-75', 'cursor-wait');
        btn.dataset.originalHtml = btn.innerHTML;
        btn.innerHTML = '<svg class="animate-spin w-4 h-4 mr-2 inline-block" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Saving...';
        // Safety net for AJAX forms that error without navigating away.
        // For normal EJS form posts the page navigates well before 2.5s
        // and the timer is discarded; for AJAX failures the button is
        // usable again quickly instead of being locked for 8 seconds.
        setTimeout(() => resetSubmitButton(btn), 2500);
      });
    });
  });

  // pageshow fires on initial load AND on BFCache restore. Resetting on
  // every pageshow means: server-error redirect → fresh form is clickable;
  // Back-button after submit → restored form is clickable. Cheap insurance.
  window.addEventListener('pageshow', resetAllSubmitButtons);
})();
