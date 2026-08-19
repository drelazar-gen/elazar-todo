const PREFERRED_SECTION_ORDER = [
  'NEEDS ACTION TODAY / THIS WEEK',
  'LEGAL / CASE FOLLOW-UPS',
  'EOB / BILLING DOCS — NEEDS FOLLOW-UP',
  'SUBSCRIPTIONS & MEMBERSHIPS — REVIEW',
  'RECURRING WEEKLY',
  'OPEN QUESTIONS / FYI',
  'UPCOMING DEADLINES',
  'FINANCIAL SNAPSHOT',
  'ADDED BY YOU',
];

// Heartbeats are anchored to :25 and :55 UTC each hour (~every 30 min combined).
const SYNC_CADENCE_MINUTES = 30;
const SYNC_GRACE_MINUTES = 5;
const BACKGROUND_REFRESH_MS = 45000;

let state = { items: [], showCompleted: false, status: {} };
let editingRecordId = null;
let lastSuccessfulSync = null;

const $ = (sel) => document.querySelector(sel);

async function api(path, opts) {
  const res = await fetch(path, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Not logged in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#app').classList.add('hidden');
}

function showApp() {
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function sectionRank(name) {
  const idx = PREFERRED_SECTION_ORDER.indexOf((name || '').toUpperCase());
  return idx === -1 ? PREFERRED_SECTION_ORDER.length : idx;
}

/* ---------------- Sync / status pills ---------------- */

function formatPillTime(date, includeDate) {
  const timePart = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (!includeDate) return timePart;
  const datePart = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${datePart}, ${timePart}`;
}

function sameDay(a, b) {
  return a.toDateString() === b.toDateString();
}

// Most recent :25 or :55 UTC mark that has already passed — the last time
// a heartbeat check-in was expected to have run.
function lastScheduledMark(now) {
  const mark = new Date(now.getTime());
  mark.setUTCSeconds(0, 0);
  const minutes = mark.getUTCMinutes();
  if (minutes >= 55) {
    mark.setUTCMinutes(55);
  } else if (minutes >= 25) {
    mark.setUTCMinutes(25);
  } else {
    mark.setUTCHours(mark.getUTCHours() - 1);
    mark.setUTCMinutes(55);
  }
  return mark;
}

function setSyncPill(healthy, detail) {
  const el = $('#sync-pill');
  if (!el) return;
  if (healthy) {
    el.className = 'pill pill-lg pill-green';
    el.textContent = 'Live sync connected — changes save instantly';
  } else {
    el.className = 'pill pill-lg pill-red';
    el.textContent = detail || 'Sync issue — retrying…';
  }
}

function updateChannelPill(el, label, iso) {
  if (!el) return;
  const now = new Date();

  if (!iso) {
    el.className = 'pill pill-sm pill-red';
    el.textContent = `${label} — no check-in yet`;
    return;
  }

  const last = new Date(iso);
  const scheduled = lastScheduledMark(now);
  const graceMs = SYNC_GRACE_MINUTES * 60 * 1000;
  const healthy = last.getTime() >= scheduled.getTime() - graceMs;

  if (healthy) {
    el.className = 'pill pill-sm pill-green';
    el.textContent = `${label} — synced ${formatPillTime(last, !sameDay(last, now))}`;
  } else {
    el.className = 'pill pill-sm pill-red';
    const lastStr = formatPillTime(last, !sameDay(last, now));
    const expStr = formatPillTime(scheduled, !sameDay(scheduled, now));
    el.textContent = `${label} — offline · last ${lastStr} · expected ${expStr}`;
  }
}

function refreshStatusPills() {
  updateChannelPill($('#whatsapp-pill'), 'WhatsApp', state.status.whatsapp);
  updateChannelPill($('#messages-pill'), 'Messages', state.status.messages);
}

/* ---------------- Rendering ---------------- */

function render() {
  const container = $('#sections-container');
  container.innerHTML = '';

  const bySection = {};
  state.items.forEach((item) => {
    if (!bySection[item.section]) bySection[item.section] = [];
    bySection[item.section].push(item);
  });

  const sectionNames = Object.keys(bySection).sort((a, b) => {
    const r = sectionRank(a) - sectionRank(b);
    if (r !== 0) return r;
    return a.localeCompare(b);
  });

  if (sectionNames.length === 0) {
    container.innerHTML = '<div class="empty-state">Nothing on the list right now.</div>';
  }

  sectionNames.forEach((section) => {
    let items = bySection[section].slice().sort((a, b) => a.order - b.order);
    if (!state.showCompleted) {
      items = items.filter((it) => !it.checked);
    } else {
      items.sort((a, b) => (a.checked === b.checked ? a.order - b.order : a.checked ? 1 : -1));
    }
    if (items.length === 0) return;

    const block = document.createElement('div');
    block.className = 'section-block';

    const title = document.createElement('div');
    title.className = 'section-title';
    title.textContent = section;
    block.appendChild(title);

    items.forEach((item) => block.appendChild(renderItem(item)));
    container.appendChild(block);
  });

  // Populate section datalist for the modal
  const datalist = $('#section-list');
  const allSections = Array.from(new Set([...PREFERRED_SECTION_ORDER, ...Object.keys(bySection)]));
  datalist.innerHTML = allSections.map((s) => `<option value="${escapeHtml(s)}"></option>`).join('');
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- Mention-aware notes (@context tagging) ---------------- */
// Wraps @word tokens in a highlighted <mark> — used both for the live-typing
// overlay field and for the read-only collapsed note display.
function highlightMentionsHtml(str) {
  // Negative lookbehind keeps this from matching the "@domain" part of an
  // email address (e.g. "esteek317@gmail.com") — only a genuine @tag not
  // glued to a preceding word character counts as a mention.
  return escapeHtml(str).replace(/(?<!\w)@(\w+)/g, '<mark class="mention">@$1</mark>');
}

// Builds a "mention-aware textarea": a real (invisible-text) <textarea> for
// native typing/caret/undo behavior, stacked over a backdrop <div> that
// mirrors the same text with @tags highlighted. Returns a small controller
// object so callers don't need to know about the DOM internals.
function createMentionField({ placeholder, rows } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'mention-field';

  const backdrop = document.createElement('div');
  backdrop.className = 'mention-backdrop';

  const textarea = document.createElement('textarea');
  textarea.className = 'mention-input';
  textarea.rows = rows || 2;
  if (placeholder) textarea.placeholder = placeholder;

  function sync() {
    const val = textarea.value;
    // Trailing newline(s) collapse in a plain div — pad so the backdrop's
    // height/scroll stays matched to the textarea.
    backdrop.innerHTML = highlightMentionsHtml(val) + (/\n$/.test(val) ? '&nbsp;' : '');
    backdrop.scrollTop = textarea.scrollTop;
  }

  textarea.addEventListener('input', sync);
  textarea.addEventListener('scroll', () => { backdrop.scrollTop = textarea.scrollTop; });

  wrap.appendChild(backdrop);
  wrap.appendChild(textarea);
  sync();

  return {
    el: wrap,
    getValue: () => textarea.value,
    setValue: (v) => { textarea.value = v || ''; sync(); },
    focus: () => textarea.focus(),
  };
}

// Single reusable mention field mounted into the add/edit modal.
const metaField = createMentionField({
  placeholder: 'Extra context, amounts, dates... Tag @context for something you want handled.',
  rows: 3,
});
$('#field-meta-mount').appendChild(metaField.el);

function renderItem(item) {
  const row = document.createElement('div');
  row.className = 'item-row' + (item.checked ? ' checked' : '') + (item.urgent && !item.checked ? ' urgent' : '');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'item-checkbox';
  checkbox.checked = item.checked;
  checkbox.addEventListener('click', (e) => e.stopPropagation());
  checkbox.addEventListener('change', () => toggleItem(item, checkbox.checked));

  const body = document.createElement('div');
  body.className = 'item-body';

  const text = document.createElement('div');
  text.className = 'item-text';
  if (item.urgent && !item.checked) {
    const flag = document.createElement('span');
    flag.className = 'urgent-flag';
    flag.textContent = 'URGENT';
    text.appendChild(flag);
  }
  text.appendChild(document.createTextNode(item.text));
  body.appendChild(text);

  const noteWrap = document.createElement('div');
  noteWrap.className = 'item-note-wrap';
  renderNoteWrap(item, noteWrap);
  body.appendChild(noteWrap);

  if (item.link) {
    const link = document.createElement('a');
    link.className = 'item-link';
    link.href = item.link;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Take me there →';
    link.addEventListener('click', (e) => e.stopPropagation());
    body.appendChild(link);
  }

  row.appendChild(checkbox);
  row.appendChild(body);
  row.addEventListener('click', () => openModal(item));

  return row;
}

// Renders either the existing note (with an "Edit note" affordance) or a
// "+ Add note / context" button — right on the card, no need to open the
// full editor first. Clicking either swaps in an inline textarea + Save/Cancel.
function renderNoteWrap(item, container) {
  container.innerHTML = '';

  if (item.meta) {
    const metaRow = document.createElement('div');
    metaRow.className = 'item-meta-row';

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.innerHTML = highlightMentionsHtml(item.meta);
    metaRow.appendChild(meta);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'note-edit-btn';
    editBtn.textContent = 'Edit note';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInlineNoteEditor(item, container);
    });
    metaRow.appendChild(editBtn);

    container.appendChild(metaRow);
  } else {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'add-note-btn';
    addBtn.textContent = '+ Add note / context';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInlineNoteEditor(item, container);
    });
    container.appendChild(addBtn);
  }
}

function openInlineNoteEditor(item, container) {
  container.innerHTML = '';
  container.addEventListener('click', (e) => e.stopPropagation());

  const field = createMentionField({ placeholder: 'Extra context, amounts, dates... Tag @context for something you want handled.', rows: 2 });
  field.setValue(item.meta || '');

  const actions = document.createElement('div');
  actions.className = 'inline-note-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'ghost-btn small-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => renderNoteWrap(item, container));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'primary-btn small-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', async () => {
    const val = field.getValue().trim();
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      const result = await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', recordId: item.recordId, meta: val }),
      });
      const idx = state.items.findIndex((it) => it.recordId === item.recordId);
      if (idx !== -1) state.items[idx] = result.item;
      // Full re-render so the row's other handlers (open-modal, checkbox)
      // pick up the fresh item instead of a stale closure.
      render();
    } catch (err) {
      alert('Could not save note: ' + err.message);
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  container.appendChild(field.el);
  container.appendChild(actions);
  field.focus();
}

async function toggleItem(item, checked) {
  item.checked = checked; // optimistic
  render();
  try {
    await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ action: 'toggle', recordId: item.recordId, checked }),
    });
  } catch (e) {
    item.checked = !checked; // revert
    render();
    alert('Could not update: ' + e.message);
  }
}

function resetDeleteConfirm() {
  $('#modal-delete-confirm').classList.add('hidden');
  $('#modal-delete').classList.remove('hidden');
}

function openModal(item) {
  editingRecordId = item ? item.recordId : null;
  $('#modal-title').textContent = item ? 'Edit item' : 'Add item';
  $('#field-section').value = item ? item.section : '';
  $('#field-text').value = item ? item.text : '';
  metaField.setValue(item ? item.meta : '');
  $('#field-link').value = item ? item.link : '';
  $('#field-urgent').checked = item ? item.urgent : false;
  $('#modal-delete').classList.toggle('hidden', !item);
  resetDeleteConfirm();
  if (!item) $('#modal-delete').classList.add('hidden');
  $('#modal-overlay').classList.remove('hidden');
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  editingRecordId = null;
  resetDeleteConfirm();
}

async function saveModal() {
  const text = $('#field-text').value.trim();
  if (!text) {
    alert('Title is required.');
    return;
  }
  const payload = {
    section: $('#field-section').value.trim() || 'ADDED BY YOU',
    text,
    meta: metaField.getValue().trim(),
    link: $('#field-link').value.trim(),
    urgent: $('#field-urgent').checked,
  };

  try {
    if (editingRecordId) {
      await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({ action: 'update', recordId: editingRecordId, ...payload }),
      });
    } else {
      await api('/api/items', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', ...payload }),
      });
    }
    closeModal();
    await loadItems();
  } catch (e) {
    alert('Could not save: ' + e.message);
  }
}

async function deleteModal() {
  if (!editingRecordId) return;
  try {
    await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', recordId: editingRecordId }),
    });
    closeModal();
    await loadItems();
  } catch (e) {
    alert('Could not delete: ' + e.message);
  }
}

async function loadItems() {
  const data = await api('/api/items');
  state.items = data.items;
  state.status = data.status || {};
  lastSuccessfulSync = new Date();

  $('#updated-label').textContent =
    `Live checklist — last refreshed ${lastSuccessfulSync.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} at ${formatPillTime(lastSuccessfulSync, false)} · ${state.items.length} item${state.items.length === 1 ? '' : 's'}`;

  setSyncPill(true);
  refreshStatusPills();
  render();
}

// Silent background poll so the "live sync" and channel pills reflect reality
// without the user needing to refresh the page.
async function backgroundRefresh() {
  try {
    await loadItems();
  } catch (err) {
    setSyncPill(
      false,
      lastSuccessfulSync
        ? `Sync issue — last connected ${formatPillTime(lastSuccessfulSync, !sameDay(lastSuccessfulSync, new Date()))}`
        : 'Sync issue — could not connect'
    );
  }
}

/* ---------------- Calendar (completion heatmap) ---------------- */

let calYear = null;
let calMonth = null; // 1-12
let calMonthData = {};

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDateISO(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function showCalGridView() {
  $('#cal-day-panel').classList.add('hidden');
  $('#cal-grid').classList.remove('hidden');
  document.querySelector('.cal-weekday-row').classList.remove('hidden');
  document.querySelector('.cal-legend').classList.remove('hidden');
}

function showCalDayView() {
  $('#cal-grid').classList.add('hidden');
  document.querySelector('.cal-weekday-row').classList.add('hidden');
  document.querySelector('.cal-legend').classList.add('hidden');
  $('#cal-day-panel').classList.remove('hidden');
}

function openCalendar() {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
  $('#calendar-overlay').classList.remove('hidden');
  showCalGridView();
  loadCalMonth();
}

function closeCalendar() {
  $('#calendar-overlay').classList.add('hidden');
}

async function loadCalMonth() {
  const ym = `${calYear}-${pad2(calMonth)}`;
  $('#cal-month-label').textContent = new Date(calYear, calMonth - 1, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  $('#cal-grid').innerHTML = '<div class="cal-loading">Loading…</div>';
  try {
    const data = await api(`/api/calendar?month=${ym}`);
    calMonthData = {};
    (data.days || []).forEach((d) => { calMonthData[d.date] = d; });
    renderCalGrid();
  } catch (err) {
    $('#cal-grid').innerHTML = `<div class="cal-loading">Could not load calendar: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCalGrid() {
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const firstDow = new Date(calYear, calMonth - 1, 1).getDay(); // 0 = Sun
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const todayStr = formatDateISO(new Date());

  for (let i = 0; i < firstDow; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell cal-cell-blank';
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calYear}-${pad2(calMonth)}-${pad2(d)}`;
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (dateStr === todayStr) cell.classList.add('cal-cell-today');

    const num = document.createElement('div');
    num.className = 'cal-cell-num';
    num.textContent = String(d);
    cell.appendChild(num);

    const info = calMonthData[dateStr];
    if (info) {
      const dot = document.createElement('span');
      dot.className = 'cal-dot ' + (info.pct >= 75 ? 'cal-dot-green' : info.pct >= 50 ? 'cal-dot-yellow' : 'cal-dot-red');
      cell.appendChild(dot);
      cell.classList.add('cal-cell-has-data');
      cell.addEventListener('click', () => openCalDay(dateStr));
    } else {
      cell.classList.add('cal-cell-empty');
    }

    grid.appendChild(cell);
  }
}

async function openCalDay(dateStr) {
  $('#cal-day-title').textContent = new Date(dateStr + 'T00:00:00')
    .toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#cal-day-items').innerHTML = '<div class="cal-loading">Loading…</div>';
  showCalDayView();

  try {
    const data = await api(`/api/calendar?date=${dateStr}`);
    renderCalDayItems(dateStr, data.items || []);
  } catch (err) {
    $('#cal-day-items').innerHTML = `<div class="cal-loading">Could not load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderCalDayItems(dateStr, items) {
  const container = $('#cal-day-items');
  container.innerHTML = '';
  if (items.length === 0) {
    container.innerHTML = '<div class="empty-state">No items recorded for this day.</div>';
    return;
  }

  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'cal-item-row' + (it.checked ? ' checked' : '');

    const check = document.createElement('span');
    check.className = 'cal-item-check';
    check.textContent = it.checked ? '✓' : '';
    row.appendChild(check);

    const body = document.createElement('div');
    body.className = 'cal-item-body';
    const text = document.createElement('div');
    text.className = 'cal-item-text';
    text.textContent = it.text;
    body.appendChild(text);
    if (it.meta) {
      const meta = document.createElement('div');
      meta.className = 'cal-item-meta';
      meta.innerHTML = highlightMentionsHtml(it.meta);
      body.appendChild(meta);
    }
    row.appendChild(body);

    // Uncheck / move back onto the current working list — for anything
    // that wasn't actually completed or needs another look.
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'ghost-btn small-btn';
    reopenBtn.textContent = 'Move to current list';
    reopenBtn.addEventListener('click', async () => {
      reopenBtn.disabled = true;
      reopenBtn.textContent = 'Moving…';
      try {
        await api('/api/calendar', {
          method: 'POST',
          body: JSON.stringify({ action: 'reopen', date: dateStr, itemId: it.itemId }),
        });
        await loadItems();
        reopenBtn.textContent = 'Done ✓';
      } catch (err) {
        alert('Could not move item: ' + err.message);
        reopenBtn.disabled = false;
        reopenBtn.textContent = 'Move to current list';
      }
    });
    row.appendChild(reopenBtn);

    container.appendChild(row);
  });
}

async function init() {
  try {
    await loadItems();
    showApp();
  } catch (e) {
    showLogin();
  }
  setInterval(backgroundRefresh, BACKGROUND_REFRESH_MS);
  // Keep the "offline / expected" pill wording fresh even between refreshes.
  setInterval(refreshStatusPills, 60000);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#password-input').value;
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    $('#password-input').value = '';
    await loadItems();
    showApp();
  } catch (err) {
    $('#login-error').textContent = 'Wrong password. Try again.';
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  showLogin();
});

$('#show-completed-toggle').addEventListener('click', () => {
  state.showCompleted = !state.showCompleted;
  $('#show-completed-toggle').textContent = state.showCompleted ? 'Hide completed' : 'Show completed';
  render();
});

$('#quick-add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#quick-add-input');
  const text = input.value.trim();
  if (!text) return;
  const submitBtn = e.target.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try {
    await api('/api/items', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', text, section: 'ADDED BY YOU' }),
    });
    input.value = '';
    await loadItems();
  } catch (err) {
    alert('Could not add: ' + err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

$('#add-fab').addEventListener('click', () => openModal(null));
$('#modal-cancel').addEventListener('click', closeModal);
$('#modal-save').addEventListener('click', saveModal);

// Two-step inline delete confirm — no native confirm() popup.
$('#modal-delete').addEventListener('click', () => {
  $('#modal-delete').classList.add('hidden');
  $('#modal-delete-confirm').classList.remove('hidden');
});
$('#modal-delete-no').addEventListener('click', resetDeleteConfirm);
$('#modal-delete-yes').addEventListener('click', deleteModal);

$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('#modal-overlay')) closeModal();
});

$('#calendar-btn').addEventListener('click', openCalendar);
$('#cal-close').addEventListener('click', closeCalendar);
$('#cal-back').addEventListener('click', showCalGridView);
$('#cal-prev').addEventListener('click', () => {
  calMonth -= 1;
  if (calMonth < 1) { calMonth = 12; calYear -= 1; }
  loadCalMonth();
});
$('#cal-next').addEventListener('click', () => {
  calMonth += 1;
  if (calMonth > 12) { calMonth = 1; calYear += 1; }
  loadCalMonth();
});
$('#calendar-overlay').addEventListener('click', (e) => {
  if (e.target === $('#calendar-overlay')) closeCalendar();
});

init();
