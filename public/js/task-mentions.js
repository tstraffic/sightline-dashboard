// task-mentions.js — @mention picker for the task comment textarea.
// Mirrors the chat dropdown but loads users from /tasks/api/mention-search
// instead of pre-loading thread members. The picked user IDs go in hidden
// inputs named "mentioned_user_ids" so the POST handler can read them as
// req.body.mentioned_user_ids[].
//
// Markup expected (rendered by views/tasks/form.ejs):
//   <form id="taskCommentForm" ...>
//     <div class="tm-wrap" style="position:relative">
//       <textarea id="taskCommentInput" name="comment" ...></textarea>
//       <div id="taskMentionDropdown" class="tm-dropdown hidden"></div>
//     </div>
//     <div id="taskMentionPills" class="tm-pills"></div>
//   </form>
(function () {
  'use strict';

  const form = document.getElementById('taskCommentForm');
  if (!form) return;
  const input = document.getElementById('taskCommentInput');
  const dropdown = document.getElementById('taskMentionDropdown');
  const pillsEl = document.getElementById('taskMentionPills');
  if (!input || !dropdown || !pillsEl) return;

  let mentionedUserIds = [];
  let mentionedUserNames = new Map(); // id -> name (for pill display)
  let mentionStartPos = -1;
  let activeIndex = 0;
  let suggestions = [];
  let fetchSeq = 0;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function syncHiddenInputs() {
    // Remove any prior hidden inputs, then re-add one per mentioned id.
    form.querySelectorAll('input[type="hidden"][name="mentioned_user_ids"]').forEach(el => el.remove());
    for (const id of mentionedUserIds) {
      const inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = 'mentioned_user_ids';
      inp.value = String(id);
      form.appendChild(inp);
    }
  }

  function renderPills() {
    if (!mentionedUserIds.length) { pillsEl.innerHTML = ''; pillsEl.classList.add('hidden'); return; }
    pillsEl.classList.remove('hidden');
    pillsEl.innerHTML = mentionedUserIds.map(id =>
      `<span class="tm-pill" data-uid="${id}">@${escapeHtml(mentionedUserNames.get(id) || 'user')}<button type="button" class="tm-pill-x" aria-label="remove">×</button></span>`
    ).join('');
    pillsEl.querySelectorAll('.tm-pill-x').forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const id = mentionedUserIds[i];
        mentionedUserIds.splice(i, 1);
        mentionedUserNames.delete(id);
        renderPills();
        syncHiddenInputs();
      });
    });
  }

  function closeDropdown() {
    dropdown.classList.add('hidden');
    suggestions = [];
    activeIndex = 0;
    mentionStartPos = -1;
  }

  function renderDropdown() {
    if (!suggestions.length) { closeDropdown(); return; }
    dropdown.classList.remove('hidden');
    dropdown.innerHTML = suggestions.map((u, i) =>
      `<div class="tm-item ${i === activeIndex ? 'active' : ''}" data-uid="${u.id}" data-name="${escapeHtml(u.full_name)}">
        <span class="tm-name">${escapeHtml(u.full_name)}</span>
        <span class="tm-role">${escapeHtml(u.role || '')}</span>
      </div>`
    ).join('');
    dropdown.querySelectorAll('.tm-item').forEach((el, i) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        activeIndex = i;
        commitSelection();
      });
    });
  }

  async function searchUsers(q) {
    const seq = ++fetchSeq;
    try {
      const resp = await fetch('/tasks/api/mention-search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
      if (!resp.ok) return;
      const data = await resp.json();
      // Ignore stale responses if the user kept typing.
      if (seq !== fetchSeq) return;
      suggestions = (data.users || []).filter(u => !mentionedUserIds.includes(u.id));
      activeIndex = 0;
      renderDropdown();
    } catch (e) { /* swallow */ }
  }

  function handleInput() {
    const val = input.value;
    const caret = input.selectionStart;
    const before = val.substring(0, caret);
    const atIdx = before.lastIndexOf('@');
    // Only fire when the @ has a space/start before it AND no whitespace between @ and caret.
    if (atIdx < 0) { closeDropdown(); return; }
    const charBefore = atIdx === 0 ? ' ' : val[atIdx - 1];
    if (!/\s/.test(charBefore)) { closeDropdown(); return; }
    const query = before.substring(atIdx + 1);
    if (/\s/.test(query)) { closeDropdown(); return; }
    mentionStartPos = atIdx;
    searchUsers(query);
  }

  function commitSelection() {
    const pick = suggestions[activeIndex];
    if (!pick) return;
    const val = input.value;
    const caret = input.selectionStart;
    const before = val.substring(0, mentionStartPos);
    const after = val.substring(caret);
    const insert = '@' + pick.full_name + ' ';
    input.value = before + insert + after;
    const newCaret = (before + insert).length;
    input.selectionStart = input.selectionEnd = newCaret;
    if (!mentionedUserIds.includes(pick.id)) {
      mentionedUserIds.push(pick.id);
      mentionedUserNames.set(pick.id, pick.full_name);
    }
    renderPills();
    syncHiddenInputs();
    closeDropdown();
    input.focus();
  }

  function handleKeydown(e) {
    if (dropdown.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + suggestions.length) % suggestions.length;
      renderDropdown();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (suggestions.length) {
        e.preventDefault();
        commitSelection();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeDropdown();
    }
  }

  input.addEventListener('input', handleInput);
  input.addEventListener('keydown', handleKeydown);
  input.addEventListener('blur', () => setTimeout(closeDropdown, 120));

  // Reset the textarea after submit so the next comment starts fresh.
  form.addEventListener('submit', () => {
    // Let the form submit; hidden inputs are already in the DOM.
    setTimeout(() => {
      mentionedUserIds = [];
      mentionedUserNames.clear();
      renderPills();
    }, 50);
  });
})();
