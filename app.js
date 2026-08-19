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
    meta.textContent = item.meta;
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

  const textarea = document.createElement('textarea');
  textarea.className = 'inline-note-input';
  textarea.rows = 2;
  textarea.placeholder = 'Extra context, amounts, dates...';
  textarea.value = item.meta || '';

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
    const val = textarea.value.trim();
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
  container.appendChild(textarea);
  container.appendChild(actions);
  textarea.focus();
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

function openModal(item) {
  editingRecordId = item ? item.recordId : null;
  $('#modal-title').textContent = item ? 'Edit item' : 'Add item';
  $('#field-section').value = item ? item.section : '';
  $('#field-text').value = item ? item.text : '';
  $('#field-meta').value = item ? item.meta : '';
  $('#field-link').value = item ? item.link : '';
  $('#field-urgent').checked = item ? item.urgent : false;
  $('#modal-delete').classList.toggle('hidden', !item);
  $('#modal-overlay').classList.remove('hidden');
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  editingRecordId = null;
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
    meta: $('#field-meta').value.trim(),
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
  if (!confirm('Delete this item?')) return;
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
$('#modal-delete').addEventListener('click', deleteModal);
$('#modal-overlay').addEventListener('click', (e) => {
  if (e.target === $('#modal-overlay')) closeModal();
});

init();
