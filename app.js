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

let state = { items: [], showCompleted: false, status: {} };
let editingRecordId = null;

function formatCheckTime(iso) {
  if (!iso) return 'not yet checked';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'not yet checked';
  const datePart = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${datePart}, ${timePart}`;
}

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

  if (item.meta) {
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = item.meta;
    body.appendChild(meta);
  }

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
  const now = new Date();
  $('#updated-label').textContent =
    `Live checklist — last refreshed ${now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })} at ${now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} · ${state.items.length} item${state.items.length === 1 ? '' : 's'}`;
  $('#status-bar').textContent =
    `WhatsApp check: ${formatCheckTime(state.status.whatsapp)}  ·  Messages check: ${formatCheckTime(state.status.messages)}`;
  render();
}

async function init() {
  try {
    await loadItems();
    showApp();
  } catch (e) {
    showLogin();
  }
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
